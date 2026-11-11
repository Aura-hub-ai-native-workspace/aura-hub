"""FrontendExtractor.

A port of packages/knowledge-fullstack/src/extract/frontend.ts —
pages, components, layouts, hooks, routes, API usage and assets from
real React/TS(X) sources.
"""

from __future__ import annotations

from ...core import js_regex
from ..types import Entity, SourceFile
from .extractor import LineMap, import_specifiers, make_entity, snippet_around

_TEST_FILE = js_regex.compile(r"\.(test|spec)\.[jt]sx?$")
PAGE_DIR = js_regex.compile(r"(?:^|/)(pages|screens|views|routes|app)/", "i")

_CLIENT_CALL = js_regex.compile(
    r"\b(?:axios|api|http|client|request|\$fetch)\.(get|post|put|delete|patch)"
    r"\s*(?:<[^>]*>)?\(\s*[`'\"]([^`'\"]+)[`'\"]",
    "gi",
)
_FETCH = js_regex.compile(r"\bfetch\s*\(\s*[`'\"]([^`'\"]+)[`'\"]([^)]*)\)", "g")
_FETCH_METHOD = js_regex.compile(r"method\s*:\s*[`'\"](\w+)[`'\"]", "i")
_BARE_PATH = js_regex.compile(
    r"[`'\"]((?:/api|/v\d+)/[A-Za-z0-9_\-/:${}.]+)[`'\"]", "g"
)
_HAS_JSX_TAG = js_regex.compile(r"<[A-Z][A-Za-z0-9]*[\s/>]")
_HAS_JSX_RETURN = js_regex.compile(r"\breturn\s*\(?\s*<")
_RENDERS = js_regex.compile(r"<([A-Z][A-Za-z0-9]*)[\s/>]", "g")
_HOOKS_USED = js_regex.compile(r"\b(use[A-Z][A-Za-z0-9]*)\s*\(", "g")
_DECL = js_regex.compile(
    r"\bexport\s+(?:default\s+)?(?:async\s+)?(?:function|const)\s+([A-Za-z_$][\w$]*)", "g"
)
_IS_HOOK = js_regex.compile(r"^use[A-Z]")
_IS_PASCAL = js_regex.compile(r"^[A-Z]")
_IS_LAYOUT_NAME = js_regex.compile(r"layout", "i")
_IS_LAYOUT_PATH = js_regex.compile(r"(?:^|/)layouts?/", "i")
_IS_PAGE_NAME = js_regex.compile(r"(?:Page|Screen|View|Route)$")
_ROUTE_DECL = js_regex.compile(
    r"(?:<Route\s[^>]*\bpath=|[{,]\s*path\s*:)\s*[`'\"]([^`'\"]+)[`'\"]", "g"
)
_ROUTE_ELEMENT = js_regex.compile(r"element=\{?\s*<([A-Z][A-Za-z0-9]*)")
_ROUTE_COMPONENT = js_regex.compile(r"component[=:]\s*\{?\s*([A-Z][A-Za-z0-9]*)")
_ASSET = js_regex.compile(
    r"\bfrom\s+['\"]([^'\"]+\.(?:png|jpe?g|svg|gif|webp|css|scss))['\"]", "g"
)

FRONTEND_LANGUAGES = ("tsx", "jsx", "typescript", "javascript")


def _is_frontend_file(file: SourceFile) -> bool:
    return (file.language in FRONTEND_LANGUAGES
            and not _TEST_FILE.search(file.name))


def api_calls(text: str) -> list[dict[str, str]]:
    """Method-qualified clients, `fetch` literals, then bare `/api` paths."""
    out: dict[str, dict[str, str]] = {}
    for match in _CLIENT_CALL.finditer(text):
        path = match.group(2)
        if path.startswith("/"):
            method = match.group(1).upper()
            out[f"{method} {path}"] = {"method": method, "path": path}
    for match in _FETCH.finditer(text):
        path = match.group(1)
        if not path.startswith("/"):
            continue
        found = _FETCH_METHOD.search(match.group(2))
        method = found.group(1).upper() if found and found.group(1) else "GET"
        out[f"{method} {path}"] = {"method": method, "path": path}
    for match in _BARE_PATH.finditer(text):
        path = match.group(1)
        if not any(c["path"] == path for c in out.values()):
            out[f"GET {path}"] = {"method": "GET", "path": path}
    return list(out.values())


class FrontendExtractor:
    id = "frontend"

    def applies_to(self, file: SourceFile) -> bool:
        return _is_frontend_file(file)

    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        text = file.text
        has_jsx = bool(_HAS_JSX_TAG.search(text)) or bool(_HAS_JSX_RETURN.search(text))
        entities: list[Entity] = []

        specifiers = import_specifiers(text)
        local, external = specifiers["local"], specifiers["external"]
        renders = list(dict.fromkeys(
            m.group(1) for m in _RENDERS.finditer(text)
        ))[:40]
        hooks_used = list(dict.fromkeys(
            m.group(1) for m in _HOOKS_USED.finditer(text)
        ))
        calls = api_calls(text)
        common_meta = {"imports": local, "externalImports": external,
                       "renders": renders, "hooks": hooks_used, "apiCalls": calls}

        declared: set[str] = set()
        for match in _DECL.finditer(text):
            name = match.group(1)
            if name in declared:
                continue
            declared.add(name)
            line = lines.line_at(match.start())

            if _IS_HOOK.search(name):
                entities.append(make_entity(
                    "hook", "frontend", name, file, line, f"React hook {name}",
                    snippet_around(file, line),
                    {"imports": local, "externalImports": external},
                ))
                continue
            if not _IS_PASCAL.search(name):
                continue  # components are PascalCase
            if not has_jsx:
                continue

            is_layout = bool(_IS_LAYOUT_NAME.search(name)) or bool(
                _IS_LAYOUT_PATH.search(file.rel_path)
            )
            is_page = bool(PAGE_DIR.search(file.rel_path)) or bool(
                _IS_PAGE_NAME.search(name)
            )
            kind = "layout" if is_layout else "page" if is_page else "component"
            entities.append(make_entity(
                kind, "frontend", name, file, line, f"{kind} {name}",
                snippet_around(file, line), common_meta,
            ))

        seen_routes: set[str] = set()
        for match in _ROUTE_DECL.finditer(text):
            route_path = match.group(1)
            if route_path in seen_routes:
                continue
            seen_routes.add(route_path)
            after = text[match.start():match.start() + 260]
            element = _ROUTE_ELEMENT.search(after)
            component = _ROUTE_COMPONENT.search(after)
            target = (element.group(1) if element
                      else component.group(1) if component else None)
            line = lines.line_at(match.start())
            entities.append(make_entity(
                "route", "frontend", route_path, file, line,
                f"Route {route_path}" + (f" → {target}" if target else ""),
                snippet_around(file, line),
                {"path": route_path, "target": target},
            ))

        for match in _ASSET.finditer(text):
            asset_path = match.group(1)
            entities.append(make_entity(
                "asset", "frontend", asset_path, file,
                lines.line_at(match.start()), f"Asset {asset_path}", None,
                {"assetPath": asset_path},
            ))

        return entities
