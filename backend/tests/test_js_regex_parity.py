"""JavaScript regex semantics, differentially against Node.

Not a test of the translator's internals — a test that for a corpus of
patterns and subjects, Python and Node produce the SAME match sets. The
patterns are the ones the intelligence generators actually use, plus the
constructs where the two engines are known to disagree.
"""

from __future__ import annotations

import json
import shutil
import subprocess

import pytest

from aura_backend.core import js_regex

PROBE = """
const cases = JSON.parse(process.argv[1]);
const out = cases.map(([src, flags, subject]) => {
  const re = new RegExp(src, flags.replace(/[gy]/g, '') + 'g');
  const found = [];
  let m;
  while ((m = re.exec(subject)) !== null) {
    found.push([m.index, m[0]]);
    if (m[0] === '') re.lastIndex++;
  }
  return found;
});
process.stdout.write(JSON.stringify(out));
"""

# (pattern, flags, subject)
CASES: list[tuple[str, str, str]] = [
    # ── the constructs where the engines genuinely differ ────────────
    (r"\b参数|接口|方法签名\b", "", "接口 and 参数 here"),
    (r"\bcafé\b", "", "a café here"),
    (r"\w+", "", "naïve café 42"),
    (r"\d+", "", "١٢٣ and 123"),
    (r"foo$", "", "foo\n"),
    (r"foo$", "m", "foo\nbar\nfoo\n"),
    (r"^bar", "m", "foo\nbar"),
    (r"[\w/.-]+\.[a-z]{1,4}\b", "", "see src/naïve.ts and a/b.py"),
    (r"\s+", "", "a b﻿c d"),
    (r"\B\w", "", "ab cd"),
    # ── patterns lifted from the reference generators ────────────────
    (r"\b[A-Z][a-z]+(?:[A-Z][a-z]+)+\b", "", "class FooBar extends BazQux {}"),
    (r"\b[A-Z]{2,5}\b", "", "HTTP API and VFS IRQ x"),
    (r"\b[A-Z]{2,}_[A-Z_]+\b", "", "MAX_SIZE and Ab_Cd and API_KEY_NAME"),
    (r"export\s+(?:async\s+)?(?:function|class|const|let|var)\s+(\w+)", "",
     "export async function doThing() {}\nexport const X = 1;"),
    (r"(?:import|from|require)\s+.*?['\"](.+?)['\"]", "",
     "import x from './a';\nconst y = require(\"pkg/b\");"),
    (r"^#\s+(.+)$", "m", "intro\n# Title Here\nmore"),
    (r"\.(test|spec)\.[jt]sx?$", "", "thing.test.tsx"),
    (r"\.(test|spec)\.[jt]sx?$", "", "thing.test.tsx\n"),
    (r"^(main|index|kmain|kernel|boot|start|_start|entry|app|linker|link)\b", "i",
     "Main.c"),
    (r"\bkmain\s*\(|\b_start\b|multiboot|kernel_main\s*\(", "i",
     "void kernel_main(void) {}"),
    (r"(?:\.global|global)\s+_start|^_start\s*:", "im", "_start:\n  nop"),
    (r"\b(x86[_-]?64|amd64|x64)\b", "", "arch/x86_64/boot"),
    (r"^\s*(?:int|void)\s+main\s*\(", "m", "\nint main(void)\n"),
    (r"(^|[\s(])_([^_]+)_(?=[\s).,]|$)", "", "an _emphasised_ word, x86_64 kept"),
    (r"process\.env\.([A-Z0-9_]+)", "", "process.env.API_KEY and process.env.X"),
    (r"^\s*([A-Z][A-Z0-9_]*)\s*=", "m", "FOO=1\n  BAR=2\nbaz=3"),
    (r"\b([A-Z][A-Za-z0-9]*(?:Service|Repository|Repo|Model|Store|Dao))\b", "",
     "UserService uses OrderRepo and Thing"),
    (r"<([A-Z][A-Za-z0-9]*)[\s/>]", "", "<Foo /><Bar>x</Bar>"),
    (r"\b(use[A-Z][A-Za-z0-9]*)\s*\(", "", "useState() and useMyHook( )"),
    (r"^ {2}([A-Za-z0-9_.\-]+):\s*$", "m", "services:\n  web:\n    image: x\n  db:\n"),
    (r"CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?[\"'`]?([A-Za-z0-9_.]+)[\"'`]?\s*\(",
     "gi", "create table if not exists public.users ("),
    (r"^\s*([A-Za-z0-9_]+)\s+([A-Za-z0-9_\[\]?]+)", "gm", "  id Int\n  name String?\n"),
    (r"\/(v\d+)\b", "i", "/api/V2/users"),
    (r"[`'\"]((?:\/api|\/v\d+)\/[A-Za-z0-9_\-\/:${}.]+)[`'\"]", "", "'/api/users/:id'"),
]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_every_pattern_matches_identically() -> None:
    payload = json.dumps([list(c) for c in CASES])
    proc = subprocess.run(
        ["node", "-e", PROBE, payload],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference = json.loads(proc.stdout)
    assert len(reference) == len(CASES)

    differences = []
    for (pattern, flags, subject), expected in zip(CASES, reference, strict=True):
        got = [[m.start(), m.group(0)] for m in js_regex.compile(pattern, flags).finditer(subject)]
        if got != expected:
            differences.append(f"{pattern!r} /{flags} on {subject!r}\n"
                               f"    node:   {expected}\n    python: {got}")
    assert not differences, "\n".join(differences)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_untranslated_patterns_really_do_differ() -> None:
    """The translation is load-bearing, not decorative.

    If plain `re.compile` ever agreed with Node on all of these, this
    module would be dead weight — and this test says so rather than
    letting it quietly become decoration.
    """
    import re

    payload = json.dumps([list(c) for c in CASES])
    proc = subprocess.run(
        ["node", "-e", PROBE, payload],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference = json.loads(proc.stdout)

    naive_differs = 0
    for (pattern, flags, subject), expected in zip(CASES, reference, strict=True):
        py_flags = 0
        if "i" in flags:
            py_flags |= re.IGNORECASE
        if "m" in flags:
            py_flags |= re.MULTILINE
        try:
            got = [[m.start(), m.group(0)]
                   for m in re.compile(pattern, py_flags).finditer(subject)]
        except re.error:
            naive_differs += 1
            continue
        if got != expected:
            naive_differs += 1
    assert naive_differs >= 5, (
        f"only {naive_differs} of {len(CASES)} patterns differ untranslated — "
        "the hazard this module guards may be gone"
    )


VALIDITY_PROBE = """
const out = JSON.parse(process.argv[1]).map((src) => {
  try { new RegExp(src); return true; } catch { return false; }
});
process.stdout.write(JSON.stringify(out));
"""

# Patterns whose VALIDITY differs between the engines, plus enough valid
# ones that an over-eager validator fails here rather than in production.
VALIDITY_CASES = [
    "c++", "a*+", "a?+", "x{2,3}+", "(?>a)", "*a", "+a", "?a", "{2}a",
    "a.b", r"\bc\+\+\b", "a+?b", "a??b", "x{2,3}", "a{,3}", "foo|bar+",
    "^a+$", "(a)+", "(?:a|b)*", "(?=a)b", "(?<=a)b", "(?<!a)b",
    r"[\w/.-]+\.[a-z]{1,4}\b", r"\b[A-Z]{2,5}\b", r"[+*?]+", r"\\+",
    r"(?:import|from)\s+.*?['\"](\.[^'\"]+)['\"]", "[]a", "[^]a", "a[b-]c",
]


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_validity_matches_node() -> None:
    """A pattern Node rejects must be rejected here, and vice versa.

    `glossary.ts` builds patterns by interpolating extracted term names
    into `new RegExp` unescaped, so which sources are legal is not an
    academic question — it decides whether the generator returns a
    glossary or throws.
    """
    proc = subprocess.run(
        ["node", "-e", VALIDITY_PROBE, json.dumps(VALIDITY_CASES)],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference: list[bool] = json.loads(proc.stdout)

    disagreements = []
    for pattern, node_ok in zip(VALIDITY_CASES, reference, strict=True):
        try:
            js_regex.compile(pattern)
            python_ok = True
        except Exception:  # noqa: BLE001 — any rejection counts
            python_ok = False
        if python_ok != node_ok:
            disagreements.append(
                f"{pattern!r}: node={'valid' if node_ok else 'invalid'}, "
                f"python={'valid' if python_ok else 'invalid'}"
            )
    assert not disagreements, "\n".join(disagreements)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")
def test_python_alone_would_accept_what_node_rejects() -> None:
    """The validator earns its place.

    Python 3.11 added possessive quantifiers and atomic groups, so a
    plain `re.compile` accepts several of these. If that ever stopped
    being true the validator would be dead weight, and this says so.
    """
    import re

    proc = subprocess.run(
        ["node", "-e", VALIDITY_PROBE, json.dumps(VALIDITY_CASES)],
        capture_output=True, text=True, timeout=120, check=True,
    )
    reference: list[bool] = json.loads(proc.stdout)

    accepted_anyway = 0
    for pattern, node_ok in zip(VALIDITY_CASES, reference, strict=True):
        if node_ok:
            continue
        try:
            re.compile(pattern)
            accepted_anyway += 1
        except re.error:
            pass
    assert accepted_anyway > 0, (
        "plain re.compile rejected every pattern Node rejects — the "
        "divergence this validator guards may be gone"
    )
