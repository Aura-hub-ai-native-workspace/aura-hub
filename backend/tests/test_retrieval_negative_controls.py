"""Negative controls for the retrieval engine.

The brief is explicit that this must stay lexical: "Do NOT replace
existing behavior with vector RAG." Several tests below exist purely to
make that structural rather than a matter of intent — if an embedding
store were ever swapped in, they would fail.

The rest assert the bounds: what is refused, what is skipped, what is
never invented.
"""

from __future__ import annotations

import itertools
import json

import pytest

from aura_backend.retrieval import (
    CodingKnowledgeEngine,
    IgnoreConfig,
    IgnoreRules,
    InvertedIndex,
    SearchQuery,
    chunk_document,
    detect_kind,
    detect_language,
    edit_distance,
    estimate_tokens,
    read_file_safe,
    tokenize,
)
from aura_backend.retrieval.inverted_index import K1, B
from aura_backend.retrieval.types import CodeDocument


def a_corpus(root):
    (root / "src").mkdir(parents=True)
    (root / "src" / "calc.ts").write_text(
        "export function addNumbers(a, b) { return a + b }\n", encoding="utf-8"
    )
    (root / "src" / "sub.ts").write_text(
        "export function subtractNumbers(a, b) { return a - b }\n", encoding="utf-8"
    )
    (root / "README.md").write_text("# Calc\n\nAdds numbers.\n", encoding="utf-8")
    return root


def engine_for(tmp_path):
    root = a_corpus(tmp_path / "proj")
    return CodingKnowledgeEngine(str(root), index_dir=str(tmp_path / "idx"),
                                 now_ms=lambda: 1_800_000_000_000.0)


# --------------------------------------------------------------------------
# It is lexical, and stays lexical.
# --------------------------------------------------------------------------


def test_the_bm25_constants_are_the_reference_values():
    """Changing either silently re-ranks every result the product returns."""
    assert K1 == 1.5
    assert B == 0.75


def test_retrieval_carries_no_embedding_machinery():
    """A structural guard, not a stylistic one: if a vector store is ever
    introduced here, this is what should fail first."""
    from aura_backend import retrieval

    exported = " ".join(dir(retrieval)).lower()
    for forbidden in ("embed", "vector", "cosine", "faiss", "hnsw"):
        assert forbidden not in exported

    from pathlib import Path

    source = Path(retrieval.__file__).parent
    text = " ".join(p.read_text(encoding="utf-8") for p in source.glob("*.py")).lower()
    for forbidden in ("import numpy", "sentence_transformers", "openai", "faiss"):
        assert forbidden not in text


def test_a_query_with_no_lexical_overlap_returns_nothing(tmp_path):
    """A vector store would return the "nearest" chunk regardless. A
    keyword index returns nothing, and that is the contract."""
    engine = engine_for(tmp_path)
    engine.index()
    assert engine.search(SearchQuery(text="photosynthesis chlorophyll")) == []


def test_an_empty_query_returns_nothing_rather_than_everything(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    for text in ("", "   ", "\n\t"):
        assert engine.search(SearchQuery(text=text)) == []


def test_searching_an_empty_index_returns_nothing(tmp_path):
    engine = CodingKnowledgeEngine(str(tmp_path), index_dir=str(tmp_path / "idx"))
    assert engine.search(SearchQuery(text="anything")) == []
    assert InvertedIndex().search(["anything"], {"exact"}, 2) == []


# --------------------------------------------------------------------------
# Tokenization.
# --------------------------------------------------------------------------


def test_identifiers_are_split_into_sub_tokens():
    tokens = tokenize("parseHTTPResponse")
    assert "parsehttpresponse" in tokens
    assert {"parse", "http", "response"} <= set(tokens)


def test_tokens_outside_the_length_bounds_are_dropped():
    assert tokenize("a") == []
    assert "ab" in tokenize("ab")
    assert tokenize("x" * 41) == []


def test_tokenization_is_case_insensitive():
    assert tokenize("FooBar") == tokenize("foobar") or set(tokenize("foobar")) <= set(
        tokenize("FooBar")
    )


def test_edit_distance_is_bounded_and_never_exceeds_the_cap():
    assert edit_distance("kitten", "sitting", 3) == 3
    # Beyond the cap it returns max+1 rather than the true distance.
    assert edit_distance("abcdefgh", "zzzzzzzz", 2) == 3
    assert edit_distance("same", "same", 2) == 0


# --------------------------------------------------------------------------
# What is never indexed.
# --------------------------------------------------------------------------


def test_dependency_directories_are_never_walked(tmp_path):
    root = a_corpus(tmp_path / "proj")
    noisy = root / "node_modules" / "pkg"
    noisy.mkdir(parents=True)
    (noisy / "secret.ts").write_text("export const leaked = 'SECRET'\n", encoding="utf-8")
    engine = CodingKnowledgeEngine(str(root), index_dir=str(tmp_path / "idx"))
    engine.index()
    assert not any("node_modules" in d.rel_path for d in engine.documents())
    assert engine.search(SearchQuery(text="leaked")) == []


def test_binary_content_is_detected_and_never_indexed_as_text(tmp_path):
    root = a_corpus(tmp_path / "proj")
    (root / "blob.dat").write_bytes(bytes(range(256)) * 8)
    engine = CodingKnowledgeEngine(str(root), index_dir=str(tmp_path / "idx"))
    stats = engine.index()
    blob = next(d for d in engine.documents() if d.name == "blob.dat")
    assert blob.binary is True
    assert blob.language == "binary"
    assert stats.binaries == 1


def test_an_oversized_file_is_truncated_and_flagged(tmp_path):
    big = tmp_path / "big.ts"
    big.write_text("x" * 5000, encoding="utf-8")
    result = read_file_safe(str(big), 1000)
    assert result.ok is True
    assert result.truncated is True
    assert result.bytes_read == 1000


def test_an_unreadable_file_is_an_error_not_an_exception(tmp_path):
    result = read_file_safe(str(tmp_path / "does-not-exist"), 1000)
    assert result.ok is False
    assert result.error is not None
    assert result.text is None


def test_hidden_files_are_skipped_unless_explicitly_meaningful():
    rules = IgnoreRules()
    assert rules.allow_file(".gitignore", ".gitignore") is True
    assert rules.allow_file(".env.example", ".env.example") is True
    assert rules.allow_file(".secret", ".secret") is False
    assert rules.allow_dir(".git") is False
    assert rules.allow_dir("src") is True


def test_asset_extensions_are_skipped():
    rules = IgnoreRules()
    for name in ("logo.png", "bundle.min.js", "yarn.lock", "data.sqlite3", "app.wasm"):
        assert rules.allow_file(name, name) is False


def test_ignore_rules_can_be_extended_without_losing_the_defaults():
    rules = IgnoreRules(IgnoreConfig(directories=["custom"]))
    assert rules.allow_dir("custom") is False
    assert rules.allow_dir("node_modules") is False


# --------------------------------------------------------------------------
# Chunking bounds.
# --------------------------------------------------------------------------


def a_doc(doc_id="a.ts"):
    return CodeDocument(
        id=doc_id, abs_path=f"/x/{doc_id}", rel_path=doc_id, project_root="/x",
        name=doc_id, ext=".ts", language="typescript", kind="code", size=0,
        checksum="", modified_ms=0, indexed_ms=0, lines=0, truncated=False,
        binary=False,
    )


def test_an_empty_document_produces_no_chunks():
    assert chunk_document(a_doc(), "") == []
    assert chunk_document(a_doc(), "   \n\n  \n") == []


def test_chunks_never_overlap_and_cover_the_document_in_order():
    text = "\n".join(f"line {i}" for i in range(300))
    chunks = chunk_document(a_doc(), text)
    assert len(chunks) > 1
    for previous, following in itertools.pairwise(chunks):
        assert previous.end_line < following.start_line, "chunks overlapped"
        assert following.ordinal == previous.ordinal + 1


def test_byte_offsets_are_exact_for_multibyte_text():
    """The byte range is used to locate a chunk in the file, so an
    off-by-one on a multi-byte character is a wrong citation."""
    text = "const s = 'héllo wörld — em dash';\n" * 40
    chunks = chunk_document(a_doc(), text)
    raw = text.encode("utf-8")
    for chunk in chunks:
        assert raw[chunk.start_byte:chunk.end_byte].decode("utf-8").strip() == chunk.text.strip()


def test_symbols_are_bounded():
    text = "\n".join(f"export const symbol{i} = {i}" for i in range(60))
    for chunk in chunk_document(a_doc(), text):
        assert len(chunk.symbols) <= 12


def test_the_token_estimate_is_the_products_one_estimator():
    assert estimate_tokens("") == 0
    assert estimate_tokens("abcd") == 1
    assert estimate_tokens("abcde") == 2


# --------------------------------------------------------------------------
# Search filters and boosts.
# --------------------------------------------------------------------------


def test_filters_exclude_rather_than_reorder(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    everything = engine.search(SearchQuery(text="numbers"))
    assert everything
    markdown_only = engine.search(SearchQuery(text="numbers", languages=["markdown"]))
    assert all(h.document.language == "markdown" for h in markdown_only)
    assert len(markdown_only) < len(everything)


def test_a_filter_that_matches_nothing_returns_nothing(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    assert engine.search(SearchQuery(text="numbers", languages=["cobol"])) == []
    assert engine.search(SearchQuery(text="numbers", kinds=["license"])) == []


def test_the_limit_is_respected(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    assert len(engine.search(SearchQuery(text="numbers", limit=1))) <= 1


def test_exact_mode_does_not_fuzzy_match(tmp_path):
    """A single misspelled token with no sub-tokens: exact finds nothing,
    fuzzy finds the real one. (A camelCase misspelling would still match
    on its correctly-spelled parts — see the sub-token test below.)"""
    engine = engine_for(tmp_path)
    engine.index()
    assert engine.search(SearchQuery(text="subtractnumbrs", mode="exact")) == []
    assert engine.search(SearchQuery(text="subtractnumbrs", mode="fuzzy")) != []
    assert engine.search(SearchQuery(text="subtractnumbers", mode="exact")) != []


def test_a_compound_identifier_also_matches_on_its_parts(tmp_path):
    """Sub-token indexing is why searching `subtractNumbers` also surfaces
    a README that merely says "numbers". That is the intended behaviour of
    a code-aware lexical index, not a bug — asserting it here so a future
    change to the tokenizer cannot pass unnoticed."""
    engine = engine_for(tmp_path)
    engine.index()
    paths = {h.document.rel_path for h in engine.search(SearchQuery(text="subtractNumbers"))}
    assert "src/sub.ts" in paths
    assert "README.md" in paths


def test_a_hit_explains_why_it_scored(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    hits = engine.search(SearchQuery(text="calc"))
    assert hits
    assert "bm25" in hits[0].reasons


# --------------------------------------------------------------------------
# Persistence and incremental indexing.
# --------------------------------------------------------------------------


def test_an_index_survives_a_reload_exactly(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    before = [(h.chunk.id, h.score) for h in engine.search(SearchQuery(text="numbers"))]

    reloaded = CodingKnowledgeEngine(
        str(tmp_path / "proj"), index_dir=str(tmp_path / "idx"),
        now_ms=lambda: 1_800_000_000_000.0,
    )
    assert reloaded.load() is True
    after = [(h.chunk.id, h.score) for h in reloaded.search(SearchQuery(text="numbers"))]
    assert before == after


def test_a_corrupt_index_fails_to_load_rather_than_half_loading(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    (tmp_path / "idx" / "index.json").write_text("{not json", encoding="utf-8")
    fresh = CodingKnowledgeEngine(str(tmp_path / "proj"), index_dir=str(tmp_path / "idx"))
    assert fresh.load() is False
    assert fresh.stats() == {"documents": 0, "chunks": 0}


def test_an_index_from_a_future_schema_is_refused(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    meta = json.loads((tmp_path / "idx" / "meta.json").read_text())
    meta["version"] = 999
    (tmp_path / "idx" / "meta.json").write_text(json.dumps(meta), encoding="utf-8")
    assert CodingKnowledgeEngine(
        str(tmp_path / "proj"), index_dir=str(tmp_path / "idx")
    ).load() is False


def test_an_unchanged_tree_reindexes_nothing(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    delta = engine.update()
    assert (delta.added, delta.modified, delta.deleted) == (0, 0, 0)
    assert delta.unchanged > 0


def test_a_changed_file_is_reindexed_and_a_deleted_one_is_dropped(tmp_path):
    root = tmp_path / "proj"
    engine = engine_for(tmp_path)
    engine.index()

    (root / "src" / "calc.ts").write_text(
        "export function multiplyNumbers(a, b) { return a * b }\n", encoding="utf-8"
    )
    (root / "src" / "sub.ts").unlink()
    (root / "src" / "new.ts").write_text("export const fresh = 1\n", encoding="utf-8")

    delta = engine.update()
    assert delta.modified == 1
    assert delta.deleted == 1
    assert delta.added == 1
    # The deleted file is gone from the index. Other documents may still
    # match on the shared sub-token `numbers`, so the assertion is about
    # the document, not about the result set being empty.
    hit_paths = {h.document.rel_path for h in engine.search(SearchQuery(text="subtractNumbers"))}
    assert "src/sub.ts" not in hit_paths
    assert "src/calc.ts" in {
        h.document.rel_path for h in engine.search(SearchQuery(text="multiplyNumbers"))
    }


def test_removing_a_document_removes_it_from_the_index_too(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    assert "src/sub.ts" in {
        h.document.rel_path for h in engine.search(SearchQuery(text="subtractNumbers"))
    }
    engine.store.remove_document_by_path("src/sub.ts")
    assert "src/sub.ts" not in {
        h.document.rel_path for h in engine.search(SearchQuery(text="subtractNumbers"))
    }
    # And the term it uniquely contributed is gone from the index entirely.
    assert engine.search(SearchQuery(text="subtractnumbers", mode="exact")) == []


def test_a_neighbour_lookup_never_wraps_around_the_file(tmp_path):
    """`ids[pos - d]` wraps in Python where it is undefined in JavaScript —
    the first chunk must not report the last as its neighbour."""
    root = tmp_path / "proj"
    root.mkdir()
    (root / "long.ts").write_text(
        "\n".join(f"const v{i} = {i};" for i in range(400)), encoding="utf-8"
    )
    engine = CodingKnowledgeEngine(str(root), index_dir=str(tmp_path / "idx"))
    engine.index()
    chunks = engine.store.document_chunks("long.ts")
    assert len(chunks) > 2
    neighbours = engine.store.neighbor_chunks(chunks[0].id, 1)
    assert chunks[-1].id not in {c.id for c in neighbours}
    assert {c.id for c in neighbours} == {chunks[1].id}


# --------------------------------------------------------------------------
# Context assembly.
# --------------------------------------------------------------------------


def test_the_context_respects_its_token_budget(tmp_path):
    root = tmp_path / "proj"
    root.mkdir()
    for i in range(6):
        (root / f"f{i}.ts").write_text(
            "\n".join(f"export const numbers{i}_{j} = {j};" for j in range(200)),
            encoding="utf-8",
        )
    engine = CodingKnowledgeEngine(str(root), index_dir=str(tmp_path / "idx"))
    engine.index()
    ctx = engine.get_context(SearchQuery(text="numbers"), max_tokens=300)
    assert ctx.total_tokens <= 300
    assert ctx.truncated is True


def test_a_context_with_no_hits_is_empty_rather_than_invented(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    ctx = engine.get_context(SearchQuery(text="photosynthesis"))
    assert ctx.entries == []
    assert ctx.total_tokens == 0


def test_context_sources_name_a_real_line_range(tmp_path):
    engine = engine_for(tmp_path)
    engine.index()
    ctx = engine.get_context(SearchQuery(text="addNumbers"))
    assert ctx.entries
    for entry in ctx.entries:
        path, _, span = entry.source.rpartition(":")
        start, _, end = span.partition("-")
        assert int(start) >= 1
        assert int(end) >= int(start)
        assert any(d.rel_path == path for d in engine.documents())


# --------------------------------------------------------------------------
# Language detection.
# --------------------------------------------------------------------------


@pytest.mark.parametrize(
    "name,ext,language,kind",
    [
        ("index.ts", ".ts", "typescript", "code"),
        ("README.md", ".md", "markdown", "doc"),
        ("readme", "", "markdown", "doc"),
        ("Dockerfile", "", "dockerfile", "manifest"),
        ("LICENSE", "", "license", "license"),
        (".gitignore", "", "gitignore", "ignore"),
        ("package.json", ".json", "json", "manifest"),
        ("mystery.xyz", ".xyz", "unknown", "unknown"),
    ],
)
def test_language_and_kind_detection(name, ext, language, kind):
    detected = detect_language(name, ext)
    assert detected == language
    assert detect_kind(name, detected) == kind
