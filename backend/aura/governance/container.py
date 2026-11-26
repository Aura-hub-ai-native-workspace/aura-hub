"""Run isolation — a worker inside a throwaway container, or an honest no.

The network boundary in network.py decides what a worker can REACH. This
module decides what it can SEE and TOUCH. A worker launched on the host
runs as the user, with the user's whole home directory, every project on
the machine and every process in reach; a governed run only narrows what
its runtime's own tools ask for. Inside a container it sees one project
(mounted at the same absolute path, so paths in logs and diffs stay
true), its own sign-in folders, and nothing else of the machine.

WHAT THE CONTAINER IS

    docker run --rm --init --name aura-run-<id>
        --user <uid>:<gid>             files it writes stay the user's
        --read-only --tmpfs /tmp       the image itself cannot be changed
        --tmpfs $HOME                  an empty home, gone when it exits
        -v <project>:<project>         the one project, read-write
        -v <worker install>:…:ro       the user's own worker binary
        -v <worker sign-in dirs>:…     so the worker is still signed in
        -v <governance dir>:…          the action log AURA drains
        --cap-drop ALL --security-opt no-new-privileges --pids-limit …
        --network none | bridge        from the task's network policy
        aura-sandbox:<hash>

The worker binaries are NOT baked into the image. The image carries the
tools a worker shells out to (git, node, python3, a compiler); the
worker itself is the one the user installed and signed in to, mounted
read-only, so the version AURA reports is the version that runs.

WHERE IT IS CLAIMED

Linux only, and computed: Docker installed, its daemon answering, the
image built. On macOS and Windows the user's worker binaries are not
Linux executables, so mounting them into a Linux container cannot work;
that would need workers installed inside the image instead, which is a
different design that has not been run. Those platforms report the
blocker and keep today's behaviour.

Nothing here trusts the worker. Nothing here reads its output.
"""

from __future__ import annotations

import hashlib
import os
import shutil
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field

# ── the setting ─────────────────────────────────────────────────────────

#: Use a container when this machine can run one, otherwise run as today.
AUTO = "auto"
#: Always use a container. A run that cannot get one is not started.
CONTAINER = "container"
#: Never use a container. Today's behaviour.
HOST = "host"
SETTINGS = (AUTO, CONTAINER, HOST)

_SETTING_FILE = ("settings", "isolation.json")


def read_setting(home: str) -> str:
    """The configured isolation mode. Anything unreadable is AUTO.

    ``AURA_ISOLATION`` overrides the stored setting when it names a valid
    mode: a headless deployment or a CI job can fix the behaviour without
    writing a settings file.
    """
    forced = (os.environ.get("AURA_ISOLATION") or "").strip().lower()
    if forced in SETTINGS:
        return forced
    from ..jsonutil import read_json_file

    data = read_json_file(os.path.join(home, *_SETTING_FILE), {})
    mode = str((data or {}).get("mode") or "").strip().lower() \
        if isinstance(data, dict) else ""
    return mode if mode in SETTINGS else AUTO


def write_setting(home: str, mode: str) -> str:
    mode = (mode or "").strip().lower()
    if mode not in SETTINGS:
        raise ValueError(f"unknown isolation mode {mode!r}; expected one of "
                         f"{', '.join(SETTINGS)}")
    from ..jsonutil import write_json_atomic

    path = os.path.join(home, *_SETTING_FILE)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    write_json_atomic(path, {"mode": mode})
    return mode


# ── the image ───────────────────────────────────────────────────────────

#: The sandbox image. Built locally from this text; the tag is its hash,
#: so changing a line here builds a new image instead of reusing a stale
#: one. Kept small on purpose: what a worker shells out to, nothing else.
SANDBOX_DOCKERFILE = """\
FROM node:22-bookworm-slim
RUN apt-get update \\
 && apt-get install -y --no-install-recommends \\
      python3 git ripgrep ca-certificates curl procps less \\
      build-essential openssh-client \\
 && rm -rf /var/lib/apt/lists/*
LABEL aura.sandbox=image
"""

IMAGE_REPO = "aura-sandbox"
#: The worker's temp directory inside the container (TMPDIR).
SANDBOX_TMP = "/var/tmp/aura"
#: Every container and image AURA creates carries this label, so cleanup
#: can find exactly AURA's and never touch anything else on the machine.
LABEL = "aura.sandbox"
NAME_PREFIX = "aura-run-"

#: Binaries `sandbox.execute` may run that the image provides. The rest
#: of the allow-list (cargo, go) are host toolchains the image does not
#: carry; those commands are not containerized, and the result says so.
IMAGE_BINARIES = frozenset({"git", "ls", "pwd", "node", "npm", "npx", "wc",
                            "du", "grep", "find", "python3"})

#: How long building the image may take, start to finish.
BUILD_TIMEOUT_S = 20 * 60
#: How long a single docker query may take before it counts as no answer.
QUERY_TIMEOUT_S = 15
#: How long a docker status answer is trusted before asking again.
STATUS_TTL_S = 30.0


def image_tag() -> str:
    digest = hashlib.sha256(SANDBOX_DOCKERFILE.encode()).hexdigest()[:12]
    return f"{IMAGE_REPO}:{digest}"


def _docker(argv: list[str], timeout_s: int = QUERY_TIMEOUT_S,
            cwd: str | None = None):
    """Run the docker CLI through AURA's one execution boundary."""
    from ..environment.procexec import run_argv

    extra = {k: v for k in ("DOCKER_HOST", "DOCKER_CONTEXT",
                            "DOCKER_CONFIG", "XDG_RUNTIME_DIR")
             if (v := os.environ.get(k))}
    return run_argv(["docker", *argv], timeout_ms=timeout_s * 1000,
                    cwd=cwd, env_extra=extra or None)


@dataclass
class DockerStatus:
    available: bool
    platform_supported: bool
    version: str = ""
    reason: str = ""

    def to_dict(self) -> dict:
        return {"available": self.available,
                "platformSupported": self.platform_supported,
                "version": self.version, "reason": self.reason}


_status_lock = threading.Lock()
_status_cache: tuple[float, DockerStatus] | None = None


def docker_status(refresh: bool = False, query=None) -> DockerStatus:
    """Can THIS machine run a sandbox container right now? Computed."""
    global _status_cache
    if not sys.platform.startswith("linux"):
        return DockerStatus(
            available=False, platform_supported=False,
            reason=("Container isolation is available on Linux only. On "
                    "this system the coding agents are not Linux programs, "
                    "so they cannot run inside a Linux container."))
    with _status_lock:
        now = time.monotonic()
        if (not refresh and query is None and _status_cache
                and now - _status_cache[0] < STATUS_TTL_S):
            return _status_cache[1]
        status = _probe_docker(query or _docker)
        if query is None:
            _status_cache = (now, status)
        return status


def _probe_docker(query) -> DockerStatus:
    if query is _docker and not shutil.which("docker"):
        return DockerStatus(False, True, reason="Docker is not installed.")
    try:
        outcome = query(["version", "--format", "{{.Server.Version}}"])
    except Exception as exc:  # noqa: BLE001 — no answer is the finding
        return DockerStatus(False, True,
                            reason=f"Docker could not be queried: {exc}")
    version = (outcome.stdout or "").strip()
    if outcome.exit_code == 0 and version:
        return DockerStatus(True, True, version=version)
    err = (outcome.stderr or outcome.error or "").strip().splitlines()
    detail = err[-1][:240] if err else "no answer"
    return DockerStatus(
        False, True,
        reason=("Docker is installed, but its service is not running or "
                f"this user is not allowed to use it ({detail})."))


class _ImageState:
    """Build progress for the sandbox image, shared across requests."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        self.state = "unknown"      # unknown | missing | building | ready | failed
        self.detail = ""
        self.thread: threading.Thread | None = None


_image = _ImageState()


def image_present(query=None) -> bool:
    outcome = (query or _docker)(["image", "inspect", "--format", "{{.Id}}",
                                  image_tag()])
    return outcome.exit_code == 0


def build_image(query=None) -> tuple[bool, str]:
    """Build the sandbox image from SANDBOX_DOCKERFILE. Blocking."""
    import tempfile

    query = query or _docker
    with tempfile.TemporaryDirectory(prefix="aura-sandbox-") as ctx:
        with open(os.path.join(ctx, "Dockerfile"), "w", encoding="utf-8") as fh:
            fh.write(SANDBOX_DOCKERFILE)
        outcome = query(["build", "--quiet", "--label", f"{LABEL}=image",
                         "-t", image_tag(), ctx], timeout_s=BUILD_TIMEOUT_S)
    if outcome.exit_code == 0:
        return True, f"built {image_tag()}"
    err = (outcome.stderr or outcome.error or outcome.stdout or "").strip()
    return False, f"the sandbox image could not be built: {err[-400:] or outcome.status}"


def image_status(query=None) -> dict:
    with _image.lock:
        if _image.state in ("unknown", "missing", "ready") \
                and not (_image.thread and _image.thread.is_alive()):
            try:
                present = image_present(query)
            except Exception:  # noqa: BLE001
                present = False
            _image.state = "ready" if present else "missing"
            if present:
                _image.detail = ""
        return {"tag": image_tag(), "state": _image.state,
                "detail": _image.detail}


def ensure_image(block: bool, query=None) -> tuple[bool, str]:
    """Make sure the image exists. Non-blocking calls start a background
    build and return (False, why) until it is done."""
    with _image.lock:
        if _image.thread and _image.thread.is_alive():
            if not block:
                return False, "the sandbox image is being built"
            thread = _image.thread
        else:
            thread = None
    if thread is not None:
        thread.join(BUILD_TIMEOUT_S)
        with _image.lock:
            return _image.state == "ready", _image.detail
    if image_present(query):
        with _image.lock:
            _image.state, _image.detail = "ready", ""
        return True, ""

    def work() -> None:
        ok, detail = build_image(query)
        with _image.lock:
            _image.state = "ready" if ok else "failed"
            _image.detail = "" if ok else detail

    if block:
        with _image.lock:
            _image.state, _image.detail = "building", ""
        work()
        with _image.lock:
            return _image.state == "ready", _image.detail
    with _image.lock:
        _image.state, _image.detail = "building", ""
        _image.thread = threading.Thread(target=work, name="aura-sandbox-build",
                                         daemon=True)
        _image.thread.start()
    return False, "the sandbox image is being built"


# ── the decision ────────────────────────────────────────────────────────

@dataclass
class Decision:
    """Where a run will happen, and why."""

    use_container: bool
    setting: str
    reason: str = ""
    #: Set when the setting demands a container this machine cannot give.
    refusal: str = ""

    def to_dict(self) -> dict:
        return {"mode": "container" if self.use_container else "host",
                "setting": self.setting, "reason": self.reason}


def decide(home: str, status=None, ensure=None) -> Decision:
    """Container or host for the next run, from the setting and the
    machine. AUTO never blocks a run on Docker; CONTAINER never quietly
    runs one without it."""
    setting = read_setting(home)
    if setting == HOST:
        return Decision(False, setting,
                        reason="Run isolation is set to This computer in Settings.")
    status = status or docker_status()
    if not status.available:
        if setting == CONTAINER:
            return Decision(False, setting, refusal="isolation-unavailable",
                            reason=("Run isolation is set to Container, and "
                                    "this machine cannot run one. "
                                    f"{status.reason}"))
        return Decision(False, setting, reason=status.reason)
    ok, why = (ensure or ensure_image)(setting == CONTAINER)
    if not ok:
        if setting == CONTAINER:
            return Decision(False, setting, refusal="isolation-unavailable",
                            reason=("Run isolation is set to Container, but "
                                    f"{why or 'the sandbox image is not ready'}."))
        return Decision(False, setting,
                        reason=(f"{why[:1].upper()}{why[1:]}; this run uses "
                                "the host until it is ready."
                                if why else "The sandbox image is not ready."))
    return Decision(True, setting)


# ── what one run sees ───────────────────────────────────────────────────

#: Each worker's own sign-in and state folders, relative to $HOME. Mounted
#: read-write: sign-in tokens refresh, and sessions are written there.
#: A path that does not exist on this machine is simply not mounted.
WORKER_STATE: dict[str, tuple[str, ...]] = {
    "opencode": (".config/opencode", ".local/share/opencode",
                 ".local/state/opencode", ".cache/opencode"),
    "kilo": (".config/kilo", ".local/share/kilo", ".local/state/kilo",
             ".cache/kilo", ".kilocode"),
    "claude": (".claude", ".claude.json"),
    "codex": (".codex",),
    "gemini": (".gemini",),
    "qwen": (".qwen",),
    "cursor-agent": (".cursor", ".config/cursor",
                     ".local/share/cursor-agent"),
}

#: Read-only conveniences every worker benefits from when present.
SHARED_READONLY = (".gitconfig",)

#: Environment variables a worker may receive. Passed BY NAME (`-e NAME`),
#: so the docker CLI copies the value from its own environment and no
#: secret ever appears on a command line or in a process listing.
ENV_EXACT = frozenset({"LANG", "LC_ALL", "LC_CTYPE", "TZ", "TERM", "PWD",
                       "NO_COLOR", "FORCE_COLOR", "CI", "AURA_ACTION_LOG"})
ENV_PREFIXES = ("OPENCODE", "KILO", "CLAUDE", "ANTHROPIC", "OPENAI", "CODEX",
                "GEMINI", "GOOGLE_API", "GOOGLE_GENAI", "QWEN", "DASHSCOPE",
                "CURSOR", "OPENROUTER", "GROQ", "MISTRAL", "DEEPSEEK",
                "XAI", "TOGETHER", "FIREWORKS", "OLLAMA", "AZURE_OPENAI",
                "AWS_BEDROCK", "VERTEX", "GIT_AUTHOR", "GIT_COMMITTER")
ENV_SUFFIXES = ("_API_KEY", "_API_TOKEN", "_BASE_URL")


def env_names(extra: dict | None = None,
              environ: dict | None = None) -> list[str]:
    """Which variable NAMES travel into the container."""
    environ = os.environ if environ is None else environ
    names = set(extra or {})
    for name in environ:
        upper = name.upper()
        if (name in ENV_EXACT or upper.startswith(ENV_PREFIXES)
                or upper.endswith(ENV_SUFFIXES)):
            names.add(name)
    # Network variables belong to the boundary, never to the parent: a
    # proxy set on the host must not become a route out of a sandbox.
    for blocked in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
                    "http_proxy", "https_proxy", "all_proxy", "no_proxy"):
        names.discard(blocked)
    return sorted(names)


def install_root(real: str, home: str | None = None) -> str:
    """The directory a worker's real executable needs alongside it.

    npm packages need their whole package (the nearest package.json);
    standalone installs keep siblings next to a bin/ directory. Never the
    home directory itself — that would mount everything.
    """
    home = os.path.realpath(home or os.path.expanduser("~"))
    folder = os.path.dirname(real)
    cur = folder
    while cur != home:
        if os.path.isfile(os.path.join(cur, "package.json")):
            return cur
        parent = os.path.dirname(cur)
        if parent == cur:
            # The filesystem root ("/", or "C:\\" on Windows, whose parent
            # is itself): nothing above it to look at.
            break
        cur = parent
    if os.path.basename(folder) == "bin" and os.path.dirname(folder) != home:
        return os.path.dirname(folder)
    return folder


@dataclass
class Mount:
    source: str
    target: str
    readonly: bool = False

    def flag(self) -> str:
        spec = f"type=bind,source={self.source},target={self.target}"
        return spec + (",readonly" if self.readonly else "")


@dataclass
class SandboxRun:
    """Everything one container needs, decided before it starts."""

    name: str
    workdir: str
    mounts: list[Mount] = field(default_factory=list)
    #: Directories prepended to PATH inside the container.
    path_dirs: list[str] = field(default_factory=list)
    #: A per-run scratch directory on the host, removed with the run.
    scratch: str = ""
    home: str = ""

    def add(self, source: str, target: str | None = None,
            readonly: bool = False) -> None:
        source = os.path.abspath(source)
        if not os.path.exists(source):
            return
        target = target or source
        if any(m.target == target for m in self.mounts):
            return
        self.mounts.append(Mount(source, target, readonly))


def new_name(hint: str = "") -> str:
    safe = "".join(c if c.isalnum() else "-" for c in hint.lower())[:24]
    safe = safe.strip("-")
    return f"{NAME_PREFIX}{safe + '-' if safe else ''}{uuid.uuid4().hex[:8]}"


def _uses_claude_hook(bin_name: str) -> bool:
    try:
        from ..workers.adapters import GOV_CLAUDE_HOOK, adapter_for_binary
    except Exception:  # noqa: BLE001 — unknown means not
        return False
    adapter = adapter_for_binary(bin_name)
    return adapter is not None and adapter.governance == GOV_CLAUDE_HOOK


def plan_worker(bin_name: str, cwd: str, aura_home: str, *,
                invocation: str = "", user_home: str | None = None,
                which=shutil.which) -> SandboxRun:
    """The mounts for one worker run. Raises when the worker is missing."""
    user_home = os.path.realpath(user_home or os.path.expanduser("~"))
    found = which(bin_name)
    if not found:
        raise FileNotFoundError(f"{bin_name} is not installed")
    real = os.path.realpath(found)
    run = SandboxRun(name=new_name(invocation or bin_name),
                     workdir=os.path.realpath(cwd), home=user_home)
    run.add(run.workdir)
    run.add(install_root(real, user_home), readonly=True)
    for rel in WORKER_STATE.get(bin_name, ()):
        run.add(os.path.join(user_home, rel))
    for rel in SHARED_READONLY:
        run.add(os.path.join(user_home, rel), readonly=True)
    # Governance: the per-invocation config, plugin and action log live
    # here, and the claude hook imports AURA's own package, read-only.
    gov = os.path.join(aura_home, "gov")
    os.makedirs(gov, exist_ok=True)
    run.add(gov)
    if _uses_claude_hook(bin_name):
        # The hook runs `python3` on a copy of claude_hook.py, which
        # imports AURA's own governance package from here. Only workers
        # governed by that hook see it.
        backend_root = os.path.dirname(os.path.dirname(os.path.dirname(
            os.path.abspath(__file__))))
        run.add(backend_root, readonly=True)
    # The worker is reached by NAME through a one-entry bin directory, so
    # the allow-list check in run_agent still runs on the bare name and
    # the container resolves it to the real, mounted executable.
    scratch = os.path.join(aura_home, "sandbox", run.name)
    os.makedirs(os.path.join(scratch, "bin"), exist_ok=True)
    link = os.path.join(scratch, "bin", bin_name)
    if not os.path.lexists(link):
        os.symlink(real, link)
    run.scratch = scratch
    run.add(os.path.join(scratch, "bin"), readonly=True)
    run.path_dirs.append(os.path.join(scratch, "bin"))
    return run


def plan_command(cwd: str, aura_home: str, *, hint: str = "cmd",
                 user_home: str | None = None) -> SandboxRun:
    """The mounts for one sandboxed command: the project and nothing else."""
    user_home = os.path.realpath(user_home or os.path.expanduser("~"))
    run = SandboxRun(name=new_name(hint), workdir=os.path.realpath(cwd),
                     home=user_home)
    run.add(run.workdir)
    run.add(os.path.join(user_home, ".gitconfig"), readonly=True)
    return run


def _limits() -> list[str]:
    cpus = max(1, os.cpu_count() or 1)
    flags = ["--cpus", str(cpus), "--pids-limit", "4096"]
    try:
        pages = os.sysconf("SC_PHYS_PAGES")
        size = os.sysconf("SC_PAGE_SIZE")
        total = pages * size
        if total > 0:
            # Three quarters of the machine: a runaway build is stopped
            # before it can take the desktop down with it.
            flags += ["--memory", str(int(total * 0.75))]
    except (ValueError, OSError, AttributeError):
        pass
    return flags


def run_prefix(run: SandboxRun, *, network: str,
               env: dict | None = None) -> list[str]:
    """The argv prefix that starts `run` and then the command after it."""
    uid, gid = os.getuid(), os.getgid()
    # Issue #112: the owning instance (whose OS lock proves it is alive) and
    # the AURA home, so cleanup can tell a crashed owner from a live one and
    # never touches another home's or another live instance's container.
    from ..config import aura_home
    from ..lifecycle import instance as _instance

    home = aura_home()
    owner = _instance.acquire(home)
    argv = [
        "docker", "run", "--rm", "--init",
        "--name", run.name,
        "--label", f"{LABEL}=run",
        "--label", f"{LABEL}.owner={os.getpid()}",
        "--label", f"{_instance.LABEL_INSTANCE}={owner.id}",
        "--label", f"{_instance.LABEL_HOME}={_instance.home_tag(home)}",
        "--user", f"{uid}:{gid}",
        "--read-only",
        "--tmpfs", "/tmp:rw,exec,mode=1777",
        # The worker's own temp directory, owned by the user. /tmp itself
        # can hold root-owned folders: Docker creates the parents of any
        # mount below it (a project under /tmp/...) as root, and tools
        # that check their temp folder's owner (Claude Code) refuse those.
        "--tmpfs", f"{SANDBOX_TMP}:rw,exec,mode=0700,uid={uid},gid={gid}",
        "--tmpfs", f"{run.home}:rw,exec,mode=0700,uid={uid},gid={gid}",
        "--cap-drop", "ALL",
        "--security-opt", "no-new-privileges",
        *_limits(),
        "--network", network,
        "--workdir", run.workdir,
        "-e", f"HOME={run.home}",
        "-e", f"TMPDIR={SANDBOX_TMP}",
        "-e", "PATH=" + ":".join([*run.path_dirs, "/usr/local/sbin",
                                  "/usr/local/bin", "/usr/sbin",
                                  "/usr/bin", "/sbin", "/bin"]),
    ]
    for name in env_names(env):
        if name in ("HOME", "PATH", "TMPDIR"):
            continue
        argv += ["-e", name]
    for mount in run.mounts:
        argv += ["--mount", mount.flag()]
    argv.append(image_tag())
    return argv


# ── network, inside the container ───────────────────────────────────────

def establish(policy, aura_home: str, run: SandboxRun, *, env=None,
              verify=None, verify_allow=None, stage=None):
    """The container prefix for `run`, with the task's network policy.

    Same contract as network.establish: the result's `ok` is False when
    the worker must not start, and a boundary is proven before it is
    trusted. `deny` is the container with no network at all; `allowlist`
    adds AURA's egress gateway, reached over its unix socket exactly as
    it is from the bwrap boundary.
    """
    from . import network as netgov

    method = "docker container"
    if policy is None or policy.mode == netgov.UNRESTRICTED:
        return netgov.EnforcementResult(
            state=netgov.NOT_CONFIGURED, mode=netgov.UNRESTRICTED,
            method=method,
            argv_prefix=run_prefix(run, network="bridge", env=env),
            detail=("The worker runs in a container, isolated from the rest "
                    "of this machine. No network policy applies to this "
                    "task, so its network access is ungoverned."))
    if policy.mode == netgov.DENY:
        prefix = run_prefix(run, network="none", env=env)
        ok, why = (verify or verify_denial)(run, env)
        if not ok:
            return netgov.EnforcementResult(
                state=netgov.INITIALIZATION_FAILED, mode=policy.mode,
                method=method, refusal="network-initialization-failed",
                detail=f"Network governance could not be established: {why}")
        return netgov.EnforcementResult(
            state=netgov.SUPPORTED_AND_ENFORCED, mode=policy.mode,
            method=method + " --network none", argv_prefix=prefix,
            verified=True, detail=why)
    # ── allowlist ────────────────────────────────────────────────────
    try:
        staged = (stage or netgov.stage_allowlist)(policy, aura_home)
    except Exception as exc:  # noqa: BLE001 — a door that will not open
        return netgov.EnforcementResult(
            state=netgov.INITIALIZATION_FAILED, mode=policy.mode,
            method=method, refusal="network-initialization-failed",
            detail=f"The egress gateway could not be started: {exc}")
    run.add(staged.launcher_path, readonly=True)
    run.add(os.path.dirname(staged.socket_path))
    prefix = [*run_prefix(run, network="none", env=env), "python3",
              staged.launcher_path, staged.socket_path, str(staged.port)]
    ok, why = (verify_allow or verify_allowlist)(run, staged, env)
    if not ok:
        staged.close()
        return netgov.EnforcementResult(
            state=netgov.INITIALIZATION_FAILED, mode=policy.mode,
            method=method, refusal="network-initialization-failed",
            detail=f"Network governance could not be established: {why}")
    return netgov.EnforcementResult(
        state=netgov.SUPPORTED_AND_ENFORCED, mode=policy.mode,
        method=method + " --network none + AURA egress gateway",
        argv_prefix=prefix, verified=True, detail=why,
        domains=list(policy.domains), staged=staged)


def _probe_run(run: SandboxRun) -> SandboxRun:
    """A sibling of `run` for a self-check: same mounts, its own name."""
    return SandboxRun(name=run.name + "-check", workdir=run.workdir,
                      mounts=list(run.mounts), path_dirs=list(run.path_dirs),
                      home=run.home)


def verify_denial(run: SandboxRun, env=None,
                  timeout_s: int = 60) -> tuple[bool, str]:
    """From INSIDE an identical container: no TCP to an IP literal, no
    name resolution. Both must fail, or the run is not called governed."""
    from . import network as netgov

    probe = _probe_run(run)
    argv = [*run_prefix(probe, network="none", env=env)[1:],
            "python3", "-c", netgov._PROBE]
    try:
        outcome = _docker(argv, timeout_s=timeout_s)
    except Exception as exc:  # noqa: BLE001
        return False, f"the container self-check could not run: {exc}"
    finally:
        remove(probe.name)
    if outcome.exit_code == 0:
        return True, (f"verified: inside the container, TCP to "
                      f"{netgov.PROBE_HOST}:{netgov.PROBE_PORT} and name "
                      "resolution both fail.")
    if outcome.exit_code == 1:
        return False, ("the container was created but traffic still escaped "
                       "it; refusing to call this governed.")
    err = (outcome.stderr or outcome.error or "").strip()[-200:]
    return False, f"the container could not be started: {err or outcome.exit_code}"


def verify_allowlist(run: SandboxRun, staged, env=None,
                     timeout_s: int = 60) -> tuple[bool, str]:
    """The same three properties network.verify_allowlist proves, from
    inside an identical container: the door is reachable, it refuses an
    unnamed destination, and there is no route around it."""
    from . import network as netgov

    probe = _probe_run(run)
    script = netgov._ALLOWLIST_PROBE.format(port=staged.port)
    argv = [*run_prefix(probe, network="none", env=env)[1:],
            "python3", staged.launcher_path, staged.socket_path,
            str(staged.port), "python3", "-c", script]
    try:
        outcome = _docker(argv, timeout_s=timeout_s)
    except Exception as exc:  # noqa: BLE001
        return False, f"the egress gateway self-check could not run: {exc}"
    finally:
        remove(probe.name)
    reasons = {
        2: "the worker could not reach AURA's egress gateway.",
        3: ("the gateway did not refuse a destination outside the "
            "allowlist; refusing to call this governed."),
        4: ("traffic escaped the container without passing the gateway; "
            "refusing to call this governed."),
        5: "name resolution escaped the container.",
    }
    if outcome.exit_code == 0:
        return True, ("verified: the gateway is reachable from inside the "
                      "container, a destination outside the allowlist is "
                      "refused, and no route exists around it.")
    if outcome.exit_code in reasons:
        return False, reasons[outcome.exit_code]
    err = (outcome.stderr or outcome.error or "").strip()[-200:]
    return False, f"the egress gateway could not be created: {err or outcome.exit_code}"


# ── cleanup ─────────────────────────────────────────────────────────────

def remove(name: str) -> None:
    """Remove one run's container if it is still there. Never raises.

    `--rm` removes a container that exits on its own. This is for the
    ones that do not: a stopped run kills the docker CLI, and the
    container it started does not die with it.
    """
    if not name.startswith(NAME_PREFIX):
        return
    try:
        _docker(["rm", "--force", name])
    except Exception:  # noqa: BLE001
        pass


def finish(run: SandboxRun | None) -> None:
    """Everything a run leaves behind, removed."""
    if run is None:
        return
    remove(run.name)
    if run.scratch:
        shutil.rmtree(run.scratch, ignore_errors=True)


_swept = False


def sweep(force: bool = False) -> int:
    """Remove sandbox containers left by an AURA process that is gone.

    Issue #112: a container is removed only when its owner is proven dead —
    its owner instance's OS lock is free (or, for a legacy container without
    an instance label, its owner pid is confirmed dead). The previous rule
    ("any owner other than this pid") removed the running workers of any
    OTHER live AURA process on the machine. Another home's containers, live
    owners and ambiguous cases are left alone (aura.lifecycle.reaper).

    Runs once per process unless forced; if Docker cannot be queried it is
    retried on the next call. Returns the number of containers removed.
    """
    global _swept
    if _swept and not force:
        return 0
    from ..config import aura_home
    from ..lifecycle import reap_now

    report = reap_now(aura_home(), workers=False)
    if not report.get("deferred") and not report.get("error"):
        _swept = True
    return len(report.get("removedContainers") or [])


def status(home: str) -> dict:
    """Everything Settings shows: the setting, the machine, the image,
    and what the next run would actually do."""
    st = docker_status()
    image = image_status() if st.available else {
        "tag": image_tag(), "state": "unavailable", "detail": ""}
    setting = read_setting(home)
    if setting == HOST:
        active, reason = "host", "Run isolation is set to This computer."
    elif st.available and image["state"] == "ready":
        active, reason = "container", ""
    elif setting == CONTAINER:
        active = "refused"
        reason = (st.reason if not st.available else
                  "The sandbox image is not built yet; it is built the "
                  "first time a run needs it.")
    else:
        active = "host"
        reason = (st.reason if not st.available else
                  "The sandbox image is not built yet. Runs use the host "
                  "until it is ready.")
    return {"setting": setting, "settings": list(SETTINGS),
            "docker": st.to_dict(), "image": image,
            "active": active, "reason": reason}


__all__ = [
    "AUTO", "CONTAINER", "HOST", "SETTINGS", "Decision", "DockerStatus",
    "IMAGE_BINARIES", "LABEL", "Mount", "NAME_PREFIX", "SANDBOX_DOCKERFILE",
    "SandboxRun", "WORKER_STATE", "build_image", "decide", "docker_status",
    "ensure_image", "env_names", "establish", "finish", "image_status",
    "image_tag", "install_root", "plan_command", "plan_worker",
    "read_setting", "remove", "run_prefix", "status", "sweep",
    "verify_allowlist", "verify_denial", "write_setting",
]
