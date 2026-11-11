"""JavaScript regular-expression semantics, in Python.

The intelligence generators are built almost entirely out of regexes over
real source files. Python's `re` and JavaScript's `RegExp` agree on most
syntax and disagree on exactly the things this codebase relies on:

| construct | JavaScript | Python (`str` patterns) |
| --- | --- | --- |
| `\\w` `\\b` `\\d` | ASCII only | Unicode-aware |
| `\\s` | includes `U+FEFF` | does not |
| `$` without `/m` | end of input only | also before a trailing `\\n` |
| `[\\w-]` | ASCII class | Unicode class |

Every one of those differences is reachable here. `/\\b参数|接口\\b/` in the
intent classifier cannot match in JavaScript, because CJK characters are
not `\\w` there — but it can in Python. A `$`-anchored pattern over a file
that ends in a newline matches one more time in Python than in Node.

So patterns are TRANSLATED rather than copied: `\\b` becomes an explicit
ASCII boundary, the shorthand classes become their ASCII sets (expanded
in place inside character classes, where a nested class is not legal),
and a non-multiline `$` becomes `\\Z`.

What is NOT emulated, and does not need to be: `lastIndex` statefulness
(no ported call site depends on it), and named/lookbehind syntax
differences (none appear in the reference).
"""

from __future__ import annotations

import re
from typing import Final

# JavaScript's `\w`, `\d` and `\s`, spelled out.
_WORD: Final = "A-Za-z0-9_"
_DIGIT: Final = "0-9"
# `\s` per ECMA-262: whitespace + line terminators, including U+FEFF.
_SPACE: Final = (
    "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a"
    "\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff"
)

# An ASCII word boundary, written as lookarounds so it stays ASCII even
# though the pattern as a whole is Unicode.
_BOUNDARY: Final = (
    f"(?:(?<=[{_WORD}])(?![{_WORD}])|(?<![{_WORD}])(?=[{_WORD}]))"
)
_NON_BOUNDARY: Final = (
    f"(?:(?<=[{_WORD}])(?=[{_WORD}])|(?<![{_WORD}])(?![{_WORD}]))"
)

_CLASS_EXPANSION: Final = {
    "w": _WORD, "W": None, "d": _DIGIT, "D": None, "s": _SPACE, "S": None,
}


class JsRegexSyntaxError(re.error):
    """A pattern JavaScript rejects.

    Python's engine is strictly more permissive in one way that matters
    here: since 3.11 it accepts POSSESSIVE quantifiers (`c++`, `a*+`) and
    ATOMIC groups (`(?>…)`), which JavaScript has never had. A pattern
    containing one is a `SyntaxError` in `new RegExp` and must be an
    error here too.

    This is not hypothetical. `glossary.ts` interpolates extracted term
    names into `new RegExp` WITHOUT escaping them, so a project with a
    directory named `c++` makes the reference throw — and a port that
    silently compiled it would produce a glossary where the reference
    produces a stack trace.
    """


_QUANTIFIER_START = frozenset("*+?{")


def validate_js(pattern: str) -> None:
    """Raise if JavaScript's `RegExp` would reject this source.

    Only the one rule that separates the two engines in practice: a
    quantifier must follow something quantifiable. `c++` is "one or more
    c, one or more times" — a `SyntaxError` in JavaScript, and a
    POSSESSIVE quantifier in Python 3.11+. Atomic groups are rejected for
    the same reason.
    """
    i = 0
    length = len(pattern)
    # Whether a quantifier may legally appear at this position.
    quantifiable = False
    # Whether the previous token was a quantifier, so a following `?` is
    # its lazy marker rather than a new quantifier.
    just_quantified = False

    while i < length:
        char = pattern[i]

        if char == "\\":
            i += 2
            quantifiable, just_quantified = True, False
            continue

        if char == "[":
            depth = i + 1
            if depth < length and pattern[depth] == "^":
                depth += 1
            # In JavaScript `[]` is the EMPTY class and `[^]` matches
            # anything — the `]` closes it rather than being a literal,
            # which is the opposite of Python and POSIX.
            while depth < length and pattern[depth] != "]":
                depth += 2 if pattern[depth] == "\\" else 1
            i = depth + 1
            quantifiable, just_quantified = True, False
            continue

        if char in _QUANTIFIER_START:
            if char == "?" and just_quantified:
                # The lazy marker on the quantifier just consumed.
                just_quantified = False
                quantifiable = False
                i += 1
                continue
            if char == "{":
                closing = pattern.find("}", i)
                # A `{` that opens no valid quantifier is a literal under
                # Annex B, and quantifiable like any other character.
                if closing == -1 or not quantifiable:
                    i += 1
                    quantifiable, just_quantified = True, False
                    continue
                i = closing + 1
                quantifiable, just_quantified = False, True
                continue
            if not quantifiable:
                raise JsRegexSyntaxError(
                    f"Invalid regular expression: /{pattern}/: Nothing to repeat",
                    pattern, i,
                )
            i += 1
            quantifiable, just_quantified = False, True
            continue

        if pattern.startswith("(?>", i):
            raise JsRegexSyntaxError(
                "Invalid regular expression: atomic groups do not exist in "
                "JavaScript",
                pattern, i,
            )

        if char == "(":
            # Skip the whole group prefix so `(?:`, `(?=`, `(?<=` … do not
            # look like quantifiers.
            i += 1
            if pattern.startswith("?", i):
                i += 1
                if pattern.startswith(("<=", "<!"), i):
                    i += 2
                elif pattern.startswith(("<", ":", "=", "!"), i):
                    i += 1
                    if pattern[i - 1] == "<":
                        closing = pattern.find(">", i)
                        i = closing + 1 if closing != -1 else i
            quantifiable, just_quantified = False, False
            continue

        if char == ")":
            i += 1
            quantifiable, just_quantified = True, False
            continue

        if char in "|^$":
            i += 1
            quantifiable, just_quantified = False, False
            continue

        i += 1
        quantifiable, just_quantified = True, False


def translate(pattern: str, flags: str = "") -> str:
    """Rewrite a JavaScript pattern source into an equivalent Python one."""
    multiline = "m" in flags
    out: list[str] = []
    i = 0
    in_class = False
    length = len(pattern)

    while i < length:
        char = pattern[i]

        if char == "\\" and i + 1 < length:
            nxt = pattern[i + 1]
            if nxt in _CLASS_EXPANSION:
                expanded = _CLASS_EXPANSION[nxt]
                if in_class:
                    # A nested `[...]` is not legal, so the set is spliced
                    # in. A negated shorthand cannot be spliced and is left
                    # alone — no reference pattern does that inside a class.
                    out.append(expanded if expanded is not None else f"\\{nxt}")
                elif expanded is not None:
                    out.append(f"[{expanded}]")
                else:
                    out.append(f"[^{_CLASS_EXPANSION[nxt.lower()]}]")
            elif nxt == "b" and not in_class:
                out.append(_BOUNDARY)
            elif nxt == "B" and not in_class:
                out.append(_NON_BOUNDARY)
            else:
                # `\b` inside a class is a backspace in BOTH languages.
                out.append(char + nxt)
            i += 2
            continue

        if char == "[" and not in_class:
            # `[]` matches NOTHING in JavaScript and `[^]` matches
            # ANYTHING — in Python a `]` there is a literal instead, so
            # both are spelled out rather than passed through.
            if pattern.startswith("[]", i):
                out.append("(?!)")
                i += 2
                continue
            if pattern.startswith("[^]", i):
                out.append("[\\s\\S]")
                i += 3
                continue
            in_class = True
            out.append(char)
            i += 1
            if i < length and pattern[i] == "^":
                out.append("^")
                i += 1
            continue

        if char == "]" and in_class:
            in_class = False
            out.append(char)
            i += 1
            continue

        if char == "$" and not in_class and not multiline:
            # JavaScript's `$` is the end of input. Python's also matches
            # before a trailing newline, which is one extra match per file.
            out.append("\\Z")
            i += 1
            continue

        out.append(char)
        i += 1

    return "".join(out)


def compile(pattern: str, flags: str = "") -> re.Pattern[str]:
    """Compile a JavaScript pattern with JavaScript semantics.

    `flags` takes the JavaScript spelling — `i`, `m`, `s`, `g`, `u`, `y`.
    `g` and `y` are about iteration rather than matching and are ignored;
    call sites choose `search` / `finditer` explicitly.
    """
    validate_js(pattern)
    py_flags = 0
    if "i" in flags:
        py_flags |= re.IGNORECASE
    if "m" in flags:
        py_flags |= re.MULTILINE
    if "s" in flags:
        py_flags |= re.DOTALL
    return re.compile(translate(pattern, flags), py_flags)
