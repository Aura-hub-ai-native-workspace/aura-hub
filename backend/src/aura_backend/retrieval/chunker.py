"""Split a document into contiguous semantic chunks.

A port of packages/knowledge-coding/src/chunker.ts.

Line-window chunking that prefers to break on blank lines — natural
boundaries between functions and blocks — tracking precise 1-based line
ranges AND byte ranges, estimating tokens, and extracting light symbols
for search boosting.

**No overlap.** Adjacent context is supplied by neighbour-chunk retrieval
instead, which is why a chunk's byte range can be trusted as exact.
"""

from __future__ import annotations

import re

from .types import CodeChunk, CodeDocument, estimate_tokens

MAX_LINES = 60
MAX_CHARS = 1600
# How far back to look for a blank-line boundary before force-cutting.
LOOKBACK = 10
MAX_SYMBOLS = 12

_DECL = re.compile(
    r"\b(function|class|interface|type|enum|struct|impl|trait|module|namespace"
    r"|const|let|var|def|fn|func|public|private|export)\s+([A-Za-z_$][\w$]*)"
)
_HEADING = re.compile(r"^#{1,6}\s+(.+?)\s*$")


def extract_symbols(text: str) -> list[str]:
    out: dict[str, None] = {}
    for match in _DECL.finditer(text):
        if len(out) >= MAX_SYMBOLS:
            break
        name = match.group(2)
        if name and len(name) > 1:
            out[name] = None
    for line in text.split("\n"):
        if len(out) >= MAX_SYMBOLS:
            break
        heading = _HEADING.match(line)
        if heading:
            out[heading.group(1).strip()] = None
    return list(out)


def chunk_document(
    doc: CodeDocument,
    text: str,
    max_lines: int = MAX_LINES,
    max_chars: int = MAX_CHARS,
    lookback: int = LOOKBACK,
) -> list[CodeChunk]:
    lines = text.split("\n")
    n = len(lines)

    # Byte offset at the start of each line. Line i occupies
    # [byte_start[i], byte_start[i+1]-1] including its newline.
    byte_start = [0] * (n + 1)
    for i in range(n):
        byte_start[i + 1] = (
            byte_start[i] + len(lines[i].encode("utf-8")) + (1 if i < n - 1 else 0)
        )

    chunks: list[CodeChunk] = []
    start = 0
    ordinal = 0

    while start < n:
        chars = 0
        i = start
        while i < n:
            chars += len(lines[i]) + 1
            if i - start + 1 >= max_lines or chars >= max_chars:
                break
            i += 1
        end = min(i, n - 1)

        # Prefer a nearby blank line as the boundary.
        if end < n - 1:
            floor = max(start + max_lines // 3, end - lookback)
            for j in range(end, floor - 1, -1):
                if lines[j].strip() == "":
                    end = j
                    break
        end = max(end, start)

        body = "\n".join(lines[start:end + 1])
        if body.strip():
            chunks.append(
                CodeChunk(
                    id=f"{doc.id}#{ordinal}",
                    document_id=doc.id,
                    ordinal=ordinal,
                    text=body,
                    start_line=start + 1,
                    end_line=end + 1,
                    start_byte=byte_start[start],
                    end_byte=byte_start[end + 1],
                    token_estimate=estimate_tokens(body),
                    language=doc.language,
                    rel_path=doc.rel_path,
                    symbols=extract_symbols(body),
                )
            )
            ordinal += 1
        start = end + 1

    return chunks
