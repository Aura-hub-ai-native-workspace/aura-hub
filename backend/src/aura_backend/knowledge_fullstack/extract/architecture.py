"""ArchitectureExtractor.

A port of packages/knowledge-fullstack/src/extract/architecture.ts —
turns architecture and design docs into structured metadata: modules,
their responsibilities, boundaries and dependencies, plus the doc itself.
"""

from __future__ import annotations

from ...core import js_regex
from ...core.js_string import slice_utf16
from ..types import Entity, SourceFile
from .extractor import LineMap, make_entity

ARCH_DOC = js_regex.compile(r"architecture|design|system|overview|adr", "i")
_MARKDOWN_EXT = js_regex.compile(r"\.mdx?$")
_ARCH_HEADING = js_regex.compile(
    r"##+\s+(architecture|modules?|services?|components?)", "i"
)
_TITLE = js_regex.compile(r"^#\s+(.+)$", "m")
_HEADINGS = js_regex.compile(r"^#{1,4}\s+(.+)$", "gm")
_SECTION = js_regex.compile(r"^#{2,4}\s+(.+)$", "gm")
_LOOKS_MODULE_NAME = js_regex.compile(
    r"\b(module|service|engine|layer|component|subsystem|package)\b", "i"
)
_LOOKS_MODULE_BODY = js_regex.compile(r"responsib|boundar|depend", "i")
_MODULE_NAME = js_regex.compile(
    r"\b([A-Z][A-Za-z0-9]+(?:Service|Engine|Module|Layer|Store|Kernel|Provider|"
    r"Manager|Controller))\b"
)
_NON_ALNUM = js_regex.compile(r"[^A-Za-z0-9 ]", "g")
_WHITESPACE = js_regex.compile(r"\s+")
_BULLET = js_regex.compile(r"^\s*[-*]\s+(.+)$", "gm")
_RESPONSIBILITY = js_regex.compile(r"responsib|handles?|manages?|owns?|provides?", "i")
_BOUNDARY = js_regex.compile(r"boundar|never|must not|only|isolat", "i")
_DEPENDENCY = js_regex.compile(
    r"\b([A-Z][A-Za-z0-9]+(?:Service|Engine|Store|Provider|Kernel))\b", "g"
)


def _is_markdown(file: SourceFile) -> bool:
    return file.language == "markdown" or bool(_MARKDOWN_EXT.search(file.name))


class ArchitectureExtractor:
    id = "architecture"

    def applies_to(self, file: SourceFile) -> bool:
        return _is_markdown(file) and (
            bool(ARCH_DOC.search(file.name))
            or bool(ARCH_DOC.search(file.rel_path))
            or bool(_ARCH_HEADING.search(file.text))
        )

    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        text = file.text
        entities: list[Entity] = []
        title_match = _TITLE.search(text)
        title = (title_match.group(1).strip()
                 if title_match and title_match.group(1) else file.name)
        headings = [m.group(1).strip() for m in _HEADINGS.finditer(text)]

        entities.append(make_entity(
            "doc", "architecture", title, file, 1, f"Architecture doc {title}",
            slice_utf16(text, 0, 400), {"headings": headings},
        ))

        sections = [{"name": m.group(1).strip(), "index": m.start()}
                    for m in _SECTION.finditer(text)]

        for i, section in enumerate(sections):
            end = sections[i + 1]["index"] if i + 1 < len(sections) else len(text)
            body = text[section["index"]:end]
            looks_module = (bool(_LOOKS_MODULE_NAME.search(section["name"]))
                            or bool(_LOOKS_MODULE_BODY.search(body)))
            name_match = _MODULE_NAME.search(section["name"] + " " + body)
            if not looks_module and not name_match:
                continue

            if name_match:
                mod_name = name_match.group(1)
            else:
                cleaned = _NON_ALNUM.sub("", section["name"]).strip()
                mod_name = " ".join(_WHITESPACE.split(cleaned)[:4]) if cleaned else ""
            if not mod_name:
                continue

            bullets = [b.group(1).strip() for b in _BULLET.finditer(body)]
            responsibilities = [b for b in bullets if _RESPONSIBILITY.search(b)][:6]
            boundaries = [b for b in bullets if _BOUNDARY.search(b)][:6]
            dependencies = [d.group(1) for d in _DEPENDENCY.finditer(body)
                            if d.group(1) != mod_name]

            entities.append(make_entity(
                "arch-module", "architecture", mod_name, file,
                lines.line_at(section["index"]), f"Architecture: {mod_name}",
                slice_utf16(body, 0, 400),
                {"section": section["name"], "responsibilities": responsibilities,
                 "boundaries": boundaries,
                 "dependencies": list(dict.fromkeys(dependencies)),
                 "sourceDoc": file.rel_path},
            ))

        return entities
