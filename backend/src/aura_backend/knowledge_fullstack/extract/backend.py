"""BackendExtractor.

A port of packages/knowledge-fullstack/src/extract/backend.ts — endpoints,
controllers, services, repositories, middleware and auth guards, from
Express/Koa/Fastify routers, NestJS decorators and Flask/FastAPI
decorators in real sources.
"""

from __future__ import annotations

from typing import Any

from ...core import js_regex
from ..types import Entity, SourceFile
from .extractor import LineMap, import_specifiers, make_entity, snippet_around

_TEST_FILE = js_regex.compile(r"\.(test|spec)\.[jt]s$")
BACKEND_LANGUAGES = ("typescript", "javascript", "python")

_REFERENCED = js_regex.compile(
    r"\b([A-Z][A-Za-z0-9]*(?:Service|Repository|Repo|Model|Store|Dao))\b", "g"
)
_VERSION = js_regex.compile(r"/(v\d+)\b", "i")
_SECURED = js_regex.compile(
    r"@UseGuards|passport|jwt|authenticate|requireAuth|isAuthenticated|ensureAuth", "i"
)
_CLASS = js_regex.compile(
    r"(?:@(Controller|Injectable|Guard)\s*\(([^)]*)\)\s*)?"
    r"\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)",
    "g",
)
_DECORATOR_ARG = js_regex.compile(r"['\"]([^'\"]+)['\"]")
_IS_CONTROLLER = js_regex.compile(r"Controller$")
_IS_CONTROLLER_FILE = js_regex.compile(r"\.controller\.")
_IS_REPO = js_regex.compile(r"Repository$|Repo$")
_IS_REPO_FILE = js_regex.compile(r"\.repository\.")
_IS_GUARD = js_regex.compile(r"Guard$")
_IS_GUARD_FILE = js_regex.compile(r"\.guard\.")
_IS_SERVICE = js_regex.compile(r"Service$")
_IS_SERVICE_FILE = js_regex.compile(r"\.service\.")
_NEST = js_regex.compile(
    r"@(Get|Post|Put|Delete|Patch|Options|Head)\s*\(\s*(?:[`'\"]([^`'\"]*)[`'\"])?\s*\)"
    r"\s*(?:@[\w()'\"/,\s.-]*)?\s*(?:public\s+|async\s+)*([A-Za-z_$][\w$]*)?",
    "g",
)
_SLASHES = js_regex.compile(r"/+", "g")
_TRAILING_SLASH = js_regex.compile(r"/$")
_EXPRESS = js_regex.compile(
    r"\b(?:app|router|route|api|server|fastify)"
    r"\.(get|post|put|delete|patch|options|head|all)\s*\(\s*[`'\"]([^`'\"]+)[`'\"]",
    "gi",
)
_EXPRESS_HANDLER = js_regex.compile(r",\s*([A-Za-z_$][\w$.]*)\s*\)?\s*$")
_EXPRESS_AUTH = js_regex.compile(r"auth|guard|passport", "i")
_PY_ROUTE = js_regex.compile(
    r"@(?:app|router|blueprint|bp)\.(get|post|put|delete|patch|route)"
    r"\s*\(\s*[`'\"]([^`'\"]+)[`'\"]([^)]*)\)",
    "gi",
)
_PY_METHODS = js_regex.compile(r"methods\s*=\s*\[\s*['\"](\w+)", "i")
_MIDDLEWARE = js_regex.compile(
    r"\bapp\.use\s*\(\s*([A-Za-z_$][\w$.]*)\s*(?:\([^)]*\))?\s*\)", "g"
)
_BUILTIN_MW = js_regex.compile(r"^(express|cors|json|urlencoded|static)$", "i")


def referenced_classes(text: str) -> list[str]:
    return list(dict.fromkeys(m.group(1) for m in _REFERENCED.finditer(text)))


def version_of(path: str) -> str | None:
    match = _VERSION.search(path)
    return match.group(1).lower() if match and match.group(1) else None


class BackendExtractor:
    id = "backend"

    def applies_to(self, file: SourceFile) -> bool:
        return (file.language in BACKEND_LANGUAGES
                and not _TEST_FILE.search(file.name))

    def _endpoint(
        self, file: SourceFile, line: int, method: str, path: str,
        extra: dict[str, Any],
    ) -> Entity:
        name = f"{method} {path}"
        return make_entity(
            "endpoint", "backend", name, file, line, f"Endpoint {name}",
            snippet_around(file, line),
            {"method": method, "path": path, "version": version_of(path), **extra},
        )

    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        text = file.text
        entities: list[Entity] = []
        external = import_specifiers(text)["external"]
        refs = referenced_classes(text)
        secured = bool(_SECURED.search(text))

        nest_base = ""
        for match in _CLASS.finditer(text):
            decorator = match.group(1)
            arg_match = _DECORATOR_ARG.search(match.group(2) or "")
            decorator_arg = arg_match.group(1) if arg_match else ""
            cname = match.group(3)
            line = lines.line_at(match.start())
            is_controller = (decorator == "Controller" or bool(_IS_CONTROLLER.search(cname))
                             or bool(_IS_CONTROLLER_FILE.search(file.name)))
            is_repo = (bool(_IS_REPO.search(cname))
                       or bool(_IS_REPO_FILE.search(file.name)))
            is_guard = (decorator == "Guard" or bool(_IS_GUARD.search(cname))
                        or bool(_IS_GUARD_FILE.search(file.name)))
            is_service = (not is_controller and not is_repo and not is_guard
                          and (bool(_IS_SERVICE.search(cname))
                               or decorator == "Injectable"
                               or bool(_IS_SERVICE_FILE.search(file.name))))

            meta = {"className": cname, "refs": [r for r in refs if r != cname],
                    "externalImports": external}
            if is_controller:
                nest_base = decorator_arg
                entities.append(make_entity(
                    "controller", "backend", cname, file, line,
                    f"Controller {cname}", snippet_around(file, line),
                    {**meta, "basePath": decorator_arg},
                ))
            elif is_repo:
                entities.append(make_entity(
                    "repository", "backend", cname, file, line,
                    f"Repository {cname}", snippet_around(file, line), meta,
                ))
            elif is_guard:
                entities.append(make_entity(
                    "auth-guard", "backend", cname, file, line,
                    f"Auth guard {cname}", snippet_around(file, line), meta,
                ))
            elif is_service:
                entities.append(make_entity(
                    "service", "backend", cname, file, line,
                    f"Service {cname}", snippet_around(file, line), meta,
                ))

        for match in _NEST.finditer(text):
            method = match.group(1).upper()
            sub = match.group(2) or ""
            joined = "/".join(p for p in (nest_base, sub) if p)
            path = _TRAILING_SLASH.sub("", _SLASHES.sub("/", "/" + joined)) or "/"
            line = lines.line_at(match.start())
            entities.append(self._endpoint(file, line, method, path, {
                "controller": nest_base, "handler": match.group(3), "secured": secured,
            }))

        for match in _EXPRESS.finditer(text):
            method = match.group(1).upper()
            path = match.group(2)
            line = lines.line_at(match.start())
            window = text[match.start():match.start() + 200]
            handler_match = _EXPRESS_HANDLER.search(window)
            entities.append(self._endpoint(file, line, method, path, {
                "handler": handler_match.group(1) if handler_match else None,
                "secured": secured or bool(_EXPRESS_AUTH.search(window)),
            }))

        for match in _PY_ROUTE.finditer(text):
            path = match.group(2)
            line = lines.line_at(match.start())
            if match.group(1).lower() == "route":
                methods = _PY_METHODS.search(match.group(3))
                method = (methods.group(1).upper()
                          if methods and methods.group(1) else "GET")
            else:
                method = match.group(1).upper()
            entities.append(self._endpoint(file, line, method, path,
                                           {"secured": secured}))

        for match in _MIDDLEWARE.finditer(text):
            name = match.group(1)
            if _BUILTIN_MW.search(name):
                continue
            entities.append(make_entity(
                "middleware", "backend", name, file, lines.line_at(match.start()),
                f"Middleware {name}", None, {},
            ))

        return entities
