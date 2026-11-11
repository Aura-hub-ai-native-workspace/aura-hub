"""ConfigExtractor.

A port of packages/knowledge-fullstack/src/extract/config.ts — environment,
dependencies, Docker, Compose, CI/CD and build configuration from real
manifest and config files.
"""

from __future__ import annotations

import json

from ...core import js_regex
from ..types import Entity, SourceFile
from .extractor import LineMap, make_entity

BUILD_CONFIG_NAMES = js_regex.compile(
    r"^(vite\.config|tsconfig|tailwind\.config|postcss\.config|rollup\.config|"
    r"webpack\.config|next\.config|svelte\.config|babel\.config|jest\.config|"
    r"esbuild\.config)\.",
    "i",
)
_WORKFLOW_PATH = js_regex.compile(r"(?:^|/)\.github/workflows/", "i")
_CARGO_DEPS = js_regex.compile(r"\[dependencies\]([\s\S]*?)(?:\n\[|$)")
_CARGO_LINE = js_regex.compile(r"^\s*([A-Za-z0-9_\-]+)\s*=\s*(.+)$", "gm")
_QUOTED = js_regex.compile(r"[\"']([^\"']+)[\"']")
_GO_LINE = js_regex.compile(r"^\s*([\w./\-]+)\s+v([\d][\w.\-]*)", "gm")
_PIP_LINE = js_regex.compile(
    r"^\s*([A-Za-z0-9_.\-]+)\s*(?:[=<>!~]=?\s*([\d][\w.\-]*))?", "gm"
)
_ENV_LINE = js_regex.compile(r"^\s*([A-Z][A-Z0-9_]*)\s*=", "gm")
_DOCKER_FROM = js_regex.compile(r"^\s*FROM\s+(\S+)", "gim")
_DOCKER_EXPOSE = js_regex.compile(r"^\s*EXPOSE\s+(\d+)", "gim")
_DOCKER_ENV = js_regex.compile(r"^\s*ENV\s+([A-Z0-9_]+)", "gim")
_SERVICES = js_regex.compile(r"^services:\s*$", "m")
_SERVICE_KEY = js_regex.compile(r"^ {2}([A-Za-z0-9_.\-]+):\s*$", "gm")
_IMAGE = js_regex.compile(r"^\s{4}image:\s*(\S+)", "m")
_PORTS = js_regex.compile(r"^\s{6,}-\s*[\"']?(\d+:\d+)", "gm")
_DEPENDS_ON = js_regex.compile(
    r"depends_on:\s*(?:\[([^\]]*)\]|((?:\s*\n\s{6,}-\s*\S+)+))", "g"
)
_SPLIT_LIST = js_regex.compile(r"[\n,]")
_STRIP_LIST = js_regex.compile(r"[-\s'\"]", "g")
_CI_JOB = js_regex.compile(r"^ {2}([A-Za-z0-9_\-]+):\s*$", "gm")
_CI_NAME = js_regex.compile(r"^name:\s*(.+)$", "m")
_NOT_A_JOB = ("on", "env", "jobs", "permissions", "concurrency")


class ConfigExtractor:
    id = "config"

    def applies_to(self, file: SourceFile) -> bool:
        name = file.name.lower()
        return (
            name in ("package.json", "cargo.toml", "go.mod", "requirements.txt",
                     "pyproject.toml")
            or name.startswith((".env", "docker-compose")) or name == "dockerfile"
            or name in ("compose.yml", "compose.yaml")
            or bool(_WORKFLOW_PATH.search(file.rel_path))
            or name in (".gitlab-ci.yml", "jenkinsfile")
            or bool(BUILD_CONFIG_NAMES.search(name))
        )

    def extract(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        name = file.name.lower()
        if name == "package.json":
            return self._package_json(file)
        if name == "cargo.toml":
            return self._cargo_toml(file, lines)
        if name == "go.mod":
            return self._go_mod(file, lines)
        if name == "requirements.txt":
            return self._requirements(file, lines)
        if name.startswith(".env"):
            return self._dotenv(file, lines)
        if name == "dockerfile":
            return self._dockerfile(file)
        if (name.startswith("docker-compose")
                or name in ("compose.yml", "compose.yaml")):
            return self._compose(file, lines)
        if (_WORKFLOW_PATH.search(file.rel_path)
                or name in (".gitlab-ci.yml", "jenkinsfile")):
            return self._ci(file)
        if BUILD_CONFIG_NAMES.search(name):
            return [make_entity("build-config", "config", file.name, file, 1,
                                f"Build config {file.name}", None, {})]
        return []

    def _package_json(self, file: SourceFile) -> list[Entity]:
        out: list[Entity] = []
        _FAILED = object()
        try:
            pkg = json.loads(file.text)
        except ValueError:
            pkg = _FAILED
        if pkg is _FAILED:
            return [make_entity("build-config", "config", file.name, file, 1,
                                f"Manifest {file.rel_path}", None,
                                {"parseError": True})]
        if pkg is None:
            # `JSON.parse("null")` SUCCEEDS in JavaScript, and the very
            # next line reads `pkg.scripts` off it — a TypeError that the
            # catch above does not cover, so it propagates. Reproduced.
            raise TypeError("Cannot read properties of null (reading 'scripts')")
        if not isinstance(pkg, dict):
            # A bare array, number or string parses too; property reads on
            # it are `undefined` rather than a throw, so the manifest
            # entity is produced with empty fields.
            pkg = {}
        scripts = list(pkg.get("scripts") or {})
        manifest_name = pkg.get("name") or file.rel_path
        out.append(make_entity(
            "build-config", "config", manifest_name, file, 1,
            f"Package manifest {manifest_name}", None,
            {"scripts": scripts, "private": pkg.get("private")},
        ))

        def add(deps: dict[str, str] | None, dev: bool) -> None:
            for dep_name, version in (deps or {}).items():
                out.append(make_entity(
                    "dependency", "config", dep_name, file, 1,
                    f"{'dev ' if dev else ''}dependency {dep_name}@{version}", None,
                    {"version": version, "dev": dev, "manifest": file.rel_path},
                ))

        add(pkg.get("dependencies"), False)
        add(pkg.get("devDependencies"), True)
        return out

    def _cargo_toml(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        out: list[Entity] = []
        block = _CARGO_DEPS.search(file.text)
        if block:
            for dep in _CARGO_LINE.finditer(block.group(1)):
                quoted = _QUOTED.search(dep.group(2))
                version = quoted.group(1) if quoted else dep.group(2).strip()
                out.append(make_entity(
                    "dependency", "config", dep.group(1), file,
                    lines.line_at(dep.start()), f"crate {dep.group(1)} {version}",
                    None,
                    {"version": version, "manifest": file.rel_path,
                     "ecosystem": "cargo"},
                ))
        return out

    def _go_mod(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        return [
            make_entity(
                "dependency", "config", dep.group(1), file,
                lines.line_at(dep.start()),
                f"go module {dep.group(1)} v{dep.group(2)}", None,
                {"version": dep.group(2), "manifest": file.rel_path,
                 "ecosystem": "go"},
            )
            for dep in _GO_LINE.finditer(file.text)
        ]

    def _requirements(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        out: list[Entity] = []
        for dep in _PIP_LINE.finditer(file.text):
            if not dep.group(1) or dep.group(1).startswith("#"):
                continue
            version = dep.group(2)
            out.append(make_entity(
                "dependency", "config", dep.group(1), file,
                lines.line_at(dep.start()),
                f"pip {dep.group(1)}" + (f" {version}" if version else ""), None,
                {"version": version, "manifest": file.rel_path, "ecosystem": "pip"},
            ))
        return out

    def _dotenv(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        return [
            make_entity("env-var", "config", d.group(1), file,
                        lines.line_at(d.start()), f"env {d.group(1)}", None,
                        {"declaredIn": file.rel_path})
            for d in _ENV_LINE.finditer(file.text)
        ]

    def _dockerfile(self, file: SourceFile) -> list[Entity]:
        from_images = [m.group(1) for m in _DOCKER_FROM.finditer(file.text)]
        expose = [m.group(1) for m in _DOCKER_EXPOSE.finditer(file.text)]
        env = [m.group(1) for m in _DOCKER_ENV.finditer(file.text)]
        return [make_entity(
            "dockerfile", "deployment", file.rel_path, file, 1,
            f"Dockerfile ({', '.join(from_images)})", None,
            {"from": from_images, "expose": expose, "env": env},
        )]

    def _compose(self, file: SourceFile, lines: LineMap) -> list[Entity]:
        out: list[Entity] = []
        text = file.text
        svc_match = _SERVICES.search(text)
        if not svc_match:
            return out
        # Top-level service keys are indented exactly two spaces.
        after = text[svc_match.start():]
        for match in _SERVICE_KEY.finditer(after):
            name = match.group(1)
            block = after[match.start():match.start() + 800]
            image_match = _IMAGE.search(block)
            image = image_match.group(1) if image_match else None
            ports = [p.group(1) for p in _PORTS.finditer(block)]
            depends_on: list[str] = []
            for dep in _DEPENDS_ON.finditer(block):
                raw = dep.group(1) or dep.group(2) or ""
                depends_on.extend(
                    s for s in (_STRIP_LIST.sub("", part)
                                for part in _SPLIT_LIST.split(raw)) if s
                )
            out.append(make_entity(
                "compose-service", "deployment", name, file,
                lines.line_at(svc_match.start() + match.start()),
                f"Compose service {name}" + (f" ({image})" if image else ""), None,
                {"image": image, "ports": ports, "dependsOn": depends_on},
            ))
        return out

    def _ci(self, file: SourceFile) -> list[Entity]:
        jobs = [m.group(1) for m in _CI_JOB.finditer(file.text)
                if m.group(1) not in _NOT_A_JOB]
        name_match = _CI_NAME.search(file.text)
        name = (name_match.group(1).strip()
                if name_match and name_match.group(1) else file.name)
        return [make_entity(
            "ci-pipeline", "deployment", name, file, 1, f"CI pipeline {name}", None,
            {"jobs": jobs, "file": file.rel_path},
        )]
