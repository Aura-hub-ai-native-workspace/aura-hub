"""Turn real files into a searchable index.

A port of packages/knowledge-coding/src/indexer.ts.

Full and incremental indexing over the real filesystem. Per file: detect
language, read safely, build a document, chunk it, store it with its
checksum, mtime, path and language.

Incremental indexing diffs the persisted manifest against the filesystem
to find ADDED / MODIFIED / DELETED files and touches only what changed.
"""

from __future__ import annotations

import os
import time
from dataclasses import dataclass, field
from pathlib import Path
from threading import Event

from .chunker import chunk_document
from .ignore import IgnoreRules
from .languages import detect_kind, detect_language
from .reader import ReadResult, read_file_safe
from .scanner import ScanCancelled, WorkspaceScanner
from .store import JsonKnowledgeStore
from .types import CodeDocument, FileError, IndexDelta, IndexStats, ScanEntry


@dataclass
class _Accum:
    files: int = 0
    chunks: int = 0
    bytes: int = 0
    binaries: int = 0
    errors: list[FileError] = field(default_factory=list)
    by_language: dict[str, int] = field(default_factory=dict)


def _build_document(
    entry: ScanEntry, read: ReadResult, project_root: str, now: float
) -> CodeDocument:
    name = os.path.basename(entry.rel_path)
    ext = Path(name).suffix
    language = "binary" if read.binary else detect_language(name, ext)
    kind = "binary" if read.binary else detect_kind(name, language)
    return CodeDocument(
        id=entry.rel_path,
        abs_path=entry.abs_path,
        rel_path=entry.rel_path,
        project_root=project_root,
        name=name,
        ext=ext,
        language=language,
        kind=kind,
        size=entry.size,
        checksum=read.checksum,
        modified_ms=entry.modified_ms,
        indexed_ms=now,
        lines=read.lines,
        truncated=read.truncated,
        binary=read.binary,
        metadata={"bytesRead": read.bytes_read},
    )


class CodingIndexer:
    def __init__(self, store: JsonKnowledgeStore, now_ms=None) -> None:
        self._store = store
        self._now = now_ms or (lambda: time.time() * 1000)

    def _check(self, cancel: Event | None) -> None:
        if cancel is not None and cancel.is_set():
            raise ScanCancelled("Indexing cancelled")

    def _index_file(
        self, entry: ScanEntry, root: str, rules: IgnoreRules, acc: _Accum
    ) -> bool:
        read = read_file_safe(entry.abs_path, rules.max_file_bytes)
        if not read.ok:
            acc.errors.append(
                FileError(
                    rel_path=entry.rel_path,
                    code=(read.error or {}).get("code", "EREAD"),
                    message=(read.error or {}).get("message", "read failed"),
                )
            )
            return False
        doc = _build_document(entry, read, root, self._now())
        chunks = (
            chunk_document(doc, read.text)
            if not read.binary and read.text and read.text.strip()
            else []
        )
        self._store.upsert_document(doc, chunks)

        acc.files += 1
        acc.chunks += len(chunks)
        acc.bytes += read.bytes_read
        if read.binary:
            acc.binaries += 1
        acc.by_language[doc.language] = acc.by_language.get(doc.language, 0) + 1
        return True

    def full_index(
        self, root: str, rules: IgnoreRules, cancel: Event | None = None
    ) -> IndexStats:
        start = self._now()
        scan = WorkspaceScanner(rules).scan(root, cancel)
        acc = _Accum(errors=list(scan.errors))
        seen: set[str] = set()

        for entry in scan.entries:
            self._check(cancel)
            self._index_file(entry, root, rules, acc)
            seen.add(entry.rel_path)

        # Drop anything previously indexed that no longer exists.
        for rel in list(self._store.manifest().keys()):
            if rel not in seen:
                self._store.remove_document_by_path(rel)

        self._store.save()
        return IndexStats(
            files=acc.files, chunks=acc.chunks, bytes=acc.bytes,
            binaries=acc.binaries, errors=acc.errors, by_language=acc.by_language,
            skipped=scan.skipped, duration_ms=self._now() - start,
        )

    def incremental(
        self, root: str, rules: IgnoreRules, cancel: Event | None = None
    ) -> IndexDelta:
        start = self._now()
        scan = WorkspaceScanner(rules).scan(root, cancel)
        manifest = self._store.manifest()

        acc = _Accum(errors=list(scan.errors))
        added = modified = unchanged = 0
        seen: set[str] = set()

        for entry in scan.entries:
            self._check(cancel)
            seen.add(entry.rel_path)
            record = manifest.get(entry.rel_path)

            # Fast path: identical size AND mtime -> assume unchanged, and
            # skip the read entirely. This is what makes re-indexing cheap.
            if record and record.size == entry.size and record.modified_ms == entry.modified_ms:
                unchanged += 1
                continue

            read = read_file_safe(entry.abs_path, rules.max_file_bytes)
            if not read.ok:
                acc.errors.append(
                    FileError(
                        rel_path=entry.rel_path,
                        code=(read.error or {}).get("code", "EREAD"),
                        message=(read.error or {}).get("message", "read failed"),
                    )
                )
                continue

            # Content-identical (a touched file): refresh the mtime in the
            # manifest so the fast path works next time, and do not reindex.
            if record and record.checksum == read.checksum:
                record.modified_ms = entry.modified_ms
                unchanged += 1
                continue

            doc = _build_document(entry, read, root, self._now())
            chunks = (
                chunk_document(doc, read.text)
                if not read.binary and read.text and read.text.strip()
                else []
            )
            self._store.upsert_document(doc, chunks)
            acc.files += 1
            acc.chunks += len(chunks)
            acc.bytes += read.bytes_read
            if read.binary:
                acc.binaries += 1
            acc.by_language[doc.language] = acc.by_language.get(doc.language, 0) + 1
            if record:
                modified += 1
            else:
                added += 1

        deleted = 0
        for rel in list(manifest.keys()):
            if rel not in seen:
                self._store.remove_document_by_path(rel)
                deleted += 1

        self._store.save()
        return IndexDelta(
            added=added, modified=modified, deleted=deleted, unchanged=unchanged,
            stats=IndexStats(
                files=acc.files, chunks=acc.chunks, bytes=acc.bytes,
                binaries=acc.binaries, errors=acc.errors, by_language=acc.by_language,
                skipped=scan.skipped, duration_ms=self._now() - start,
            ),
        )
