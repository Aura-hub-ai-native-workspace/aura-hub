"""Where did this executable come from, and did a human deliberately install it?

Discovery finds files. Provenance decides which of them AURA may *run*.

The rule is that AURA will execute an unknown binary only when it can point
at the package a person installed to put it there. A file that merely happens
to sit in a bin directory has no such story and is reported as discovered and
unverified — never executed. This is what keeps a scan from running the
operator's ``aura-uninstall`` wrapper, a ``postinstall`` dropping, or anything
else nobody asked for, including binaries that do not exist yet.

Ownership is established by reading the filesystem and the package managers'
own inventories. Nothing here executes a candidate to find out what it is.

Sources, strongest first:

``npm-global``
    The bin is a symlink into ``<prefix>/lib/node_modules/<package>``. npm
    creates these links itself, so the target names the owning package
    exactly — which also tells us ``wrangler`` and ``wrangler2`` are one tool.
``pipx``
    The target lives under a pipx venv, or pipx's own JSON claims the path.
``cargo``
    ``cargo install --list`` names the binaries each crate installed.
``venv``
    The target sits in the ``bin``/``Scripts`` directory of a Python virtual
    environment (identified by its ``pyvenv.cfg``).
``os-package``
    The target lives under a prefix owned by the OS package manager, or under
    a Homebrew Cellar.
"""
from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any

from .pathsec import effective_path, home_dir, real_target, resolve_executable
from .procexec import ExecStatus, run_argv

IS_WINDOWS = sys.platform == "win32"

#: Package-manager inventory commands are bounded like any other probe.
INVENTORY_TIMEOUT_MS = 8000


class Origin(str, Enum):
    """How an executable came to be on this machine."""

    NPM_GLOBAL = "npm-global"
    PIPX = "pipx"
    CARGO = "cargo"
    VENV = "venv"
    OS_PACKAGE = "os-package"
    CATALOG = "catalog"
    UNKNOWN = "unknown"


#: Origins that justify running a binary to ask it for its version.
TRUSTED_ORIGINS = frozenset(
    {
        Origin.NPM_GLOBAL,
        Origin.PIPX,
        Origin.CARGO,
        Origin.VENV,
        Origin.OS_PACKAGE,
        Origin.CATALOG,
    }
)


@dataclass(frozen=True)
class Provenance:
    origin: Origin
    package: str | None = None
    manager: str | None = None
    detail: str = ""

    @property
    def trusted(self) -> bool:
        return self.origin in TRUSTED_ORIGINS


UNKNOWN_PROVENANCE = Provenance(
    origin=Origin.UNKNOWN,
    detail="no package manager claims this file, so AURA did not run it",
)


@dataclass
class PackageRecord:
    manager: str
    package: str
    version: str | None = None
    #: Absolute paths this package is known to have installed.
    app_paths: list[str] = field(default_factory=list)
    #: Bare command names this package is known to provide.
    app_names: list[str] = field(default_factory=list)


@dataclass
class InventoryLayer:
    """One package manager's answer, including how complete that answer is."""

    manager: str
    records: list[PackageRecord] = field(default_factory=list)
    total: int = 0
    truncated: bool = False
    available: bool = True
    error: str = ""


def _os_package_prefixes() -> tuple[Path, ...]:
    """Directories whose contents are placed there by the OS package manager."""
    if IS_WINDOWS:
        prefixes = []
        for var in ("ProgramFiles", "ProgramFiles(x86)", "ProgramW6432"):
            base = os.environ.get(var)
            if base:
                prefixes.append(Path(base))
        return tuple(prefixes)
    posix = [
        Path("/usr/bin"),
        Path("/usr/sbin"),
        Path("/usr/lib"),
        Path("/usr/libexec"),
        Path("/usr/share"),
        Path("/bin"),
        Path("/sbin"),
        Path("/lib"),
        Path("/snap"),
        Path("/var/lib/flatpak"),
    ]
    if sys.platform == "darwin":
        posix.extend(
            [
                Path("/opt/homebrew/Cellar"),
                Path("/usr/local/Cellar"),
                Path("/opt/homebrew/opt"),
                Path("/System/Library"),
                Path("/Library/Apple"),
            ]
        )
    return tuple(posix)


def _under(child: Path, parent: Path) -> bool:
    try:
        child.relative_to(parent)
        return True
    except ValueError:
        return False


def _is_venv_bin(target: Path) -> bool:
    """True when ``target`` sits in the bin dir of a Python virtual env."""
    parent = target.parent
    if parent.name not in ("bin", "Scripts"):
        return False
    return (parent.parent / "pyvenv.cfg").is_file()


def _npmrc_prefix(rc: Path) -> str | None:
    """The ``prefix=`` setting in one npmrc file, if it has one."""
    try:
        text = rc.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith((";", "#")) or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        if key.strip().lower() != "prefix":
            continue
        value = value.strip().strip('"').strip("'")
        if value:
            return os.path.expandvars(os.path.expanduser(value))
    return None


def npm_global_prefix() -> Path | None:
    """npm's *global prefix* — where it installs ``-g`` packages.

    This is not the same thing as where ``npm`` itself lives: a user npmrc
    routinely redirects the prefix elsewhere, and reading it back from npm's
    own install path silently indexes the wrong tree. npm's documented
    precedence is followed here (env, then project, user and builtin npmrc),
    with ``npm config get prefix`` as the fallback for unusual setups.
    """
    override = os.environ.get("npm_config_prefix") or os.environ.get("NPM_CONFIG_PREFIX")
    if override and os.path.isdir(override):
        return Path(override)

    npm = resolve_executable("npm")

    candidates: list[Path] = [Path.cwd() / ".npmrc", home_dir() / ".npmrc"]
    if npm:
        # <install>/lib/node_modules/npm/bin/npm-cli.js → <install>/etc/npmrc
        target = Path(real_target(npm))
        for ancestor in target.parents:
            if ancestor.name == "node_modules":
                base = ancestor.parent.parent if ancestor.parent.name == "lib" else ancestor.parent
                candidates.append(base / "etc" / "npmrc")
                break
    for rc in candidates:
        value = _npmrc_prefix(rc)
        if value and os.path.isdir(value):
            return Path(value)

    if npm:
        outcome = run_argv(
            [npm, "config", "get", "prefix"],
            timeout_ms=INVENTORY_TIMEOUT_MS,
            cwd=str(home_dir()),
            path=effective_path(),
        )
        prefix = outcome.stdout.strip()
        if prefix and prefix != "undefined" and os.path.isdir(prefix):
            return Path(prefix)

        # Last resort: npm's own installation tree.
        target = Path(real_target(npm))
        for ancestor in target.parents:
            if ancestor.name == "node_modules":
                return ancestor.parent.parent if ancestor.parent.name == "lib" else ancestor.parent
    return None


def _npm_root(prefix: Path) -> Path:
    """The ``node_modules`` directory global packages are installed into."""
    unix = prefix / "lib" / "node_modules"
    if unix.is_dir():
        return unix
    return prefix / "node_modules"


def _package_from_node_modules(target: Path, root: Path) -> str | None:
    """Extract ``@scope/name`` or ``name`` from a path inside ``node_modules``."""
    try:
        rel = target.relative_to(root)
    except ValueError:
        return None
    parts = rel.parts
    if not parts:
        return None
    if parts[0].startswith("@"):
        return "/".join(parts[:2]) if len(parts) >= 2 else None
    return parts[0]


def _read_npm_layer(limit: int) -> InventoryLayer:
    """npm's global inventory, read from the filesystem.

    ``npm list -g --json`` exits non-zero for perfectly ordinary conditions
    (``ELSPROBLEMS`` from an unmet peer dependency), and the previous
    implementation threw the whole inventory away when it did. Reading
    ``node_modules`` directly cannot fail that way and is considerably faster.
    """
    layer = InventoryLayer(manager="npm")
    prefix = npm_global_prefix()
    if prefix is None:
        layer.available = False
        layer.error = "npm is not installed"
        return layer

    root = _npm_root(prefix)
    if not root.is_dir():
        layer.available = False
        layer.error = f"npm global root {root} does not exist"
        return layer

    package_dirs: list[Path] = []
    try:
        for entry in sorted(root.iterdir()):
            if not entry.is_dir():
                continue
            if entry.name.startswith("."):
                continue
            if entry.name.startswith("@"):
                try:
                    package_dirs.extend(sorted(p for p in entry.iterdir() if p.is_dir()))
                except OSError:
                    continue
            else:
                package_dirs.append(entry)
    except OSError as exc:
        layer.available = False
        layer.error = str(exc)
        return layer

    layer.total = len(package_dirs)
    for pkg_dir in package_dirs[:limit]:
        name = _package_from_node_modules(pkg_dir / "x", root) or pkg_dir.name
        version: str | None = None
        app_names: list[str] = []
        try:
            manifest = json.loads((pkg_dir / "package.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            manifest = {}
        if isinstance(manifest, dict):
            raw_version = manifest.get("version")
            if isinstance(raw_version, str):
                # A manifest is attacker-controlled data; treat its fields as
                # untrusted input rather than as facts about the world.
                version = raw_version[:64]
            bins = manifest.get("bin")
            if isinstance(bins, str):
                app_names.append(name.split("/")[-1])
            elif isinstance(bins, dict):
                app_names.extend(str(k)[:128] for k in list(bins)[:64])
        layer.records.append(
            PackageRecord(
                manager="npm",
                package=name,
                version=version,
                app_paths=[str(pkg_dir)],
                app_names=app_names,
            )
        )
    layer.truncated = layer.total > len(layer.records)
    return layer


def _read_pipx_layer(limit: int) -> InventoryLayer:
    layer = InventoryLayer(manager="pipx")
    pipx = resolve_executable("pipx")
    if pipx is None:
        layer.available = False
        layer.error = "pipx is not installed"
        return layer

    outcome = run_argv(
        [pipx, "list", "--json"],
        timeout_ms=INVENTORY_TIMEOUT_MS,
        cwd=str(home_dir()),
        path=effective_path(),
    )
    # pipx prints warnings to stderr and can exit non-zero while still
    # emitting complete JSON on stdout. Parse whatever we got.
    try:
        data = json.loads(outcome.stdout)
    except ValueError:
        layer.available = outcome.status is ExecStatus.OK
        layer.error = outcome.error or "pipx did not return usable JSON"
        return layer

    venvs = data.get("venvs") if isinstance(data, dict) else None
    if not isinstance(venvs, dict):
        layer.error = "pipx returned an unfamiliar shape"
        return layer

    layer.total = len(venvs)
    for package, info in list(venvs.items())[:limit]:
        meta = info.get("metadata") if isinstance(info, dict) else {}
        main = meta.get("main_package") if isinstance(meta, dict) else {}
        version = main.get("package_version") if isinstance(main, dict) else None
        app_paths: list[str] = []
        app_names: list[str] = []
        if isinstance(main, dict):
            for raw in main.get("app_paths") or []:
                path = raw.get("__Path__") if isinstance(raw, dict) else raw
                if isinstance(path, str):
                    app_paths.append(path)
                    app_names.append(os.path.basename(path))
            for app in main.get("apps") or []:
                if isinstance(app, str):
                    app_names.append(app)
        layer.records.append(
            PackageRecord(
                manager="pipx",
                package=str(package),
                version=version if isinstance(version, str) else None,
                app_paths=app_paths,
                app_names=app_names,
            )
        )
    layer.truncated = layer.total > len(layer.records)
    return layer


def _read_cargo_layer(limit: int) -> InventoryLayer:
    layer = InventoryLayer(manager="cargo")
    cargo = resolve_executable("cargo")
    if cargo is None:
        layer.available = False
        layer.error = "cargo is not installed"
        return layer

    outcome = run_argv(
        [cargo, "install", "--list"],
        timeout_ms=INVENTORY_TIMEOUT_MS,
        cwd=str(home_dir()),
        path=effective_path(),
    )
    if not outcome.stdout.strip():
        # An empty list is a legitimate answer, not a failure.
        if outcome.status is not ExecStatus.OK:
            layer.available = False
            layer.error = outcome.error or f"cargo exited {outcome.exit_code}"
        return layer

    records: list[PackageRecord] = []
    current: PackageRecord | None = None
    for line in outcome.stdout.splitlines():
        if not line.strip():
            continue
        if line[0].isspace():
            # Indented lines are the binaries the crate installed — exactly
            # the bin-name-to-package mapping provenance needs.
            if current is not None:
                current.app_names.append(line.strip())
            continue
        head = line.strip().rstrip(":")
        parts = head.split()
        if not parts:
            continue
        current = PackageRecord(
            manager="cargo",
            package=parts[0],
            version=parts[1].lstrip("v") if len(parts) > 1 else None,
        )
        records.append(current)
    layer.total = len(records)
    layer.records = records[:limit]
    layer.truncated = layer.total > len(layer.records)
    return layer


_MANAGER_ORIGINS = {
    "npm": Origin.NPM_GLOBAL,
    "pipx": Origin.PIPX,
    "cargo": Origin.CARGO,
}


def _manager_roots(npm_root: Path | None) -> dict[str, set[Path]]:
    """Each manager's install tree — where the files it owns actually live."""
    home = home_dir()
    roots: dict[str, set[Path]] = {"npm": set(), "pipx": set(), "cargo": set()}
    if npm_root is not None:
        roots["npm"].add(npm_root)
    pipx_home = os.environ.get("PIPX_HOME")
    roots["pipx"].add(Path(pipx_home) if pipx_home else home / ".local" / "share" / "pipx")
    cargo_home = os.environ.get("CARGO_HOME")
    roots["cargo"].add(Path(cargo_home) if cargo_home else home / ".cargo")
    return roots


def _manager_bin_dirs(npm_prefix: Path | None) -> dict[str, set[str]]:
    """Each manager's own bin directory — the only place its names count.

    Matching a bare command name against a package inventory is not, by
    itself, evidence of anything: any file called ``npx`` would inherit npm's
    trust. Scoping the match to the directory the manager installs into
    restores the link, because putting a file there is itself a deliberate
    act by the person who owns it.
    """
    dirs: dict[str, set[str]] = {"npm": set(), "pipx": set(), "cargo": set()}
    home = home_dir()

    if npm_prefix is not None:
        dirs["npm"].add(str(npm_prefix if IS_WINDOWS else npm_prefix / "bin"))

    pipx_bin = os.environ.get("PIPX_BIN_DIR")
    dirs["pipx"].add(str(Path(pipx_bin)) if pipx_bin else str(home / ".local" / "bin"))

    cargo_home = os.environ.get("CARGO_HOME")
    dirs["cargo"].add(str(Path(cargo_home) / "bin") if cargo_home else str(home / ".cargo" / "bin"))

    return {k: {os.path.normcase(os.path.normpath(d)) for d in v} for k, v in dirs.items()}


class ProvenanceIndex:
    """Answers "who installed this?" for any path, without executing it."""

    def __init__(
        self,
        layers: dict[str, InventoryLayer],
        npm_root: Path | None,
        npm_prefix: Path | None = None,
    ) -> None:
        self.layers = layers
        self._npm_root = npm_root
        self._os_prefixes = _os_package_prefixes()
        self._bin_dirs = _manager_bin_dirs(npm_prefix)
        self._roots = _manager_roots(npm_root)

        # Absolute paths a manager explicitly claims. Trusted wherever they are.
        self._by_path: dict[str, tuple[Origin, str, str]] = {}
        # Command names a manager provides, only honoured inside its own bin
        # directory (see _manager_bin_dirs).
        self._by_name: dict[str, dict[str, tuple[Origin, str, str]]] = {
            "npm": {},
            "pipx": {},
            "cargo": {},
        }
        for layer in layers.values():
            origin = _MANAGER_ORIGINS.get(layer.manager, Origin.UNKNOWN)
            if origin is Origin.UNKNOWN:
                continue
            for record in layer.records:
                for path in record.app_paths:
                    self._by_path[os.path.normcase(path)] = (origin, record.package, layer.manager)
                for name in record.app_names:
                    self._by_name[layer.manager].setdefault(
                        name.lower(), (origin, record.package, layer.manager)
                    )

    @property
    def npm_root(self) -> Path | None:
        return self._npm_root

    def package_version(self, manager: str, package: str) -> str | None:
        layer = self.layers.get(manager)
        if layer is None:
            return None
        for record in layer.records:
            if record.package == package:
                return record.version
        return None

    def classify(self, executable: str | os.PathLike[str]) -> Provenance:
        """Provenance of ``executable``, following symlinks to the real file."""
        source = Path(executable)
        target = Path(real_target(source))

        # npm links its bins straight into the owning package directory, so
        # the target alone identifies the package — no inventory needed.
        if self._npm_root is not None:
            package = _package_from_node_modules(target, self._npm_root)
            if package:
                return Provenance(
                    origin=Origin.NPM_GLOBAL,
                    package=package,
                    manager="npm",
                    detail=f"installed globally by npm as {package}",
                )

        exact = self._by_path.get(os.path.normcase(str(target))) or self._by_path.get(
            os.path.normcase(str(source))
        )
        if exact:
            origin, package, manager = exact
            return Provenance(
                origin=origin,
                package=package,
                manager=manager,
                detail=f"installed by {manager} as {package}",
            )

        # A pipx venv, or any other Python virtual environment, is something
        # a person built on purpose.
        if _is_venv_bin(target):
            venv = target.parent.parent
            pipx_venvs = home_dir() / ".local" / "share" / "pipx" / "venvs"
            if _under(target, pipx_venvs):
                return Provenance(
                    origin=Origin.PIPX,
                    package=venv.name,
                    manager="pipx",
                    detail=f"installed by pipx into the {venv.name} environment",
                )
            return Provenance(
                origin=Origin.VENV,
                package=venv.name,
                manager="venv",
                detail=f"provided by the Python environment at {venv}",
            )

        # Name match, but only for a file sitting in the manager's own bin
        # directory *and* still pointing inside that manager's tree.
        #
        # The directory alone is not enough. A symlink dropped into npm's bin
        # directory under a name some package declares would otherwise
        # inherit that package's trust while resolving to anything at all —
        # a full bypass of the execution rule.
        holder = os.path.normcase(os.path.normpath(str(source.parent)))
        for manager, bin_dirs in self._bin_dirs.items():
            if holder not in bin_dirs:
                continue
            hit = self._by_name[manager].get(source.name.lower())
            if not hit:
                continue
            try:
                is_link = source.is_symlink()
            except OSError:
                is_link = True
            # Either the file genuinely lives in that bin directory, or it
            # links into the manager's own tree. A link pointing anywhere
            # else is not that manager's file, whatever it is named.
            stays_home = not is_link or any(
                _under(target, root) for root in self._roots[manager]
            )
            if not stays_home:
                continue
            origin, package, mgr = hit
            return Provenance(
                origin=origin,
                package=package,
                manager=mgr,
                detail=f"installed by {mgr} as {package}",
            )

        for prefix in self._os_prefixes:
            if _under(target, prefix):
                return Provenance(
                    origin=Origin.OS_PACKAGE,
                    manager="os",
                    detail=f"shipped by the operating system under {prefix}",
                )

        return UNKNOWN_PROVENANCE


def build_index(*, npm_limit: int = 400, pipx_limit: int = 200, cargo_limit: int = 200) -> ProvenanceIndex:
    """Read every package-manager inventory once, for one scan."""
    layers: dict[str, InventoryLayer] = {}
    npm_root: Path | None = None
    npm_prefix: Path | None = None

    for manager, reader, limit in (
        ("npm", _read_npm_layer, npm_limit),
        ("pipx", _read_pipx_layer, pipx_limit),
        ("cargo", _read_cargo_layer, cargo_limit),
    ):
        try:
            layers[manager] = reader(limit)
        except Exception as exc:  # one manager must never sink the scan
            layers[manager] = InventoryLayer(
                manager=manager, available=False, error=f"{manager} inventory failed: {exc}"
            )

    try:
        npm_prefix = npm_global_prefix()
        if npm_prefix is not None:
            root = _npm_root(npm_prefix)
            if root.is_dir():
                npm_root = root
    except Exception:
        npm_root = None
        npm_prefix = None

    return ProvenanceIndex(layers, npm_root, npm_prefix)


def layers_to_packages(index: ProvenanceIndex) -> list[dict[str, Any]]:
    """The package inventory as the API reports it."""
    out: list[dict[str, Any]] = []
    for layer in index.layers.values():
        for record in layer.records:
            out.append(
                {
                    "manager": record.manager,
                    "package": record.package,
                    "version": record.version,
                    "executable": record.app_paths[0] if record.app_paths else None,
                }
            )
    out.sort(key=lambda item: (item["manager"], item["package"]))
    return out


def layers_to_meta(index: ProvenanceIndex) -> list[dict[str, Any]]:
    """Honest metadata about how complete each inventory is."""
    return [
        {
            "manager": layer.manager,
            "available": layer.available,
            "returned": len(layer.records),
            "total": layer.total,
            "truncated": layer.truncated,
            "error": layer.error or None,
        }
        for layer in sorted(index.layers.values(), key=lambda item: item.manager)
    ]
