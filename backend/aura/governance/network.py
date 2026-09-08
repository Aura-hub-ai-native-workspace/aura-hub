"""Network governance — a real boundary, or an honest refusal.

Network access is externally actionable: a worker that can open a socket
can fetch code and can send whatever it has read. Phase J governs files
and commands inside the worker's runtime; that is the wrong layer for
this one. A runtime hook can only see the network calls the runtime
makes through its own tools, and a worker's `curl`, its `pip`, and the
child it forked go nowhere near them. So this module does not ask the
runtime anything. It puts the worker inside a boundary the kernel
enforces, and then it checks that the boundary is really there.

WHAT IS ENFORCED, AND WHAT IS NOT

`deny` is enforced by an unprivileged network namespace: the worker's
processes have no route, no interface but loopback, and no resolver, so
there is nothing to bypass — direct IPs, IPv6, alternate ports, proxy
variables, subprocesses and double-forked children all fail identically,
because the failure is the absence of a network rather than a rule about
one. Name resolution is closed too: a namespace does not isolate the
unix socket glibc uses to reach a system resolver, so the sandbox gets a
resolver-free /etc/resolv.conf and an nsswitch without `resolve`.

`allowlist` keeps that same namespace and adds exactly one door AURA
owns: an egress gateway (see netgate.py) reachable only over a unix
socket, which a network namespace does not isolate. The worker's proxy
variables point at it, but they are a convenience, not the boundary —
unsetting them does not open a path, it removes the only one. The
decision is made on the hostname the client asks for in CONNECT, so it
matches the domain the policy states rather than an IP address that
rotates underneath it.

Selective egress by IP filtering was the alternative, and it needs
slirp4netns or pasta plus a privileged firewall rule. It would also be
weaker for this job: an allowlist names DOMAINS, and resolving those to
addresses is stale the moment it is written.

Nothing here trusts the worker. Nothing here reads its output.
"""

from __future__ import annotations

import os
import shutil
from dataclasses import dataclass, field

# ── policy vocabulary ───────────────────────────────────────────────────

#: No egress at all. The only mode with kernel-enforced coverage today.
DENY = "deny"
#: Named destinations only. Enforceable for requests AURA makes itself;
#: NOT enforceable for a worker's own subprocesses on this platform.
ALLOWLIST = "allowlist"
#: Ungoverned. Reported as such — never described as "protected".
UNRESTRICTED = "unrestricted"

MODES = (DENY, ALLOWLIST, UNRESTRICTED)

# ── enforcement states (§16: "enabled" is not "enforced") ───────────────

SUPPORTED_AND_ENFORCED = "SUPPORTED_AND_ENFORCED"
SUPPORTED_BUT_RESTRICTED = "SUPPORTED_BUT_RESTRICTED"
NOT_CONFIGURED = "NOT_CONFIGURED"
INITIALIZATION_FAILED = "INITIALIZATION_FAILED"
UNSUPPORTED = "UNSUPPORTED"

#: How long the self-check may take. It runs once per governed dispatch.
VERIFY_TIMEOUT_S = 20

#: A destination the probe tries to reach. Chosen because it is an IP
#: literal: reaching it proves egress WITHOUT proving name resolution,
#: so a blocked resolver cannot be mistaken for a blocked network.
PROBE_HOST = "1.1.1.1"
PROBE_PORT = 443


@dataclass(frozen=True)
class NetworkPolicy:
    """What a task is allowed to reach. AURA-owned; never worker-stated."""

    mode: str = UNRESTRICTED
    domains: tuple[str, ...] = ()
    #: Ports an allowed destination may be reached on. A host reachable
    #: on every port is a wider grant than "https://pypi.org" reads as,
    #: so the default is the two the policy language implies.
    ports: tuple[int, ...] = (80, 443)

    @staticmethod
    def parse(raw: object) -> "NetworkPolicy | None":
        """Read a task's declared network policy, or None when it states
        none. Malformed input is a refusal, not a default: a policy that
        cannot be read is not a policy."""
        if raw is None:
            return None
        ports: tuple[int, ...] = (80, 443)
        if isinstance(raw, str):
            mode, domains = raw.strip().lower(), ()
        elif isinstance(raw, dict):
            mode = str(raw.get("mode") or "").strip().lower()
            raw_domains = raw.get("domains") or raw.get("allow") or []
            if not isinstance(raw_domains, list):
                raise ValueError("network domains must be a list")
            domains = tuple(
                d.strip().lower() for d in raw_domains
                if isinstance(d, str) and d.strip())
            raw_ports = raw.get("ports")
            if raw_ports is not None:
                if (not isinstance(raw_ports, list) or not raw_ports
                        or not all(isinstance(p, int) and not isinstance(p, bool)
                                   and 0 < p < 65536 for p in raw_ports)):
                    raise ValueError(
                        "network ports must be a non-empty list of port "
                        "numbers")
                ports = tuple(sorted(set(raw_ports)))
        else:
            raise ValueError("network policy must be a string or an object")
        if mode not in MODES:
            raise ValueError(
                f"unknown network mode {mode!r}; expected one of "
                f"{', '.join(MODES)}")
        if mode == ALLOWLIST and not domains:
            raise ValueError("an allowlist with no destinations denies "
                             "everything; state 'deny' if that is intended")
        return NetworkPolicy(mode=mode, domains=domains, ports=ports)

    def to_dict(self) -> dict:
        return {"mode": self.mode, "domains": list(self.domains),
                "ports": list(self.ports)}


@dataclass
class EnforcementResult:
    """What AURA actually established, and how it knows."""

    state: str = NOT_CONFIGURED
    mode: str = UNRESTRICTED
    method: str = ""
    argv_prefix: list[str] = field(default_factory=list)
    detail: str = ""
    verified: bool = False
    #: Set when a task asked for something this host cannot enforce.
    refusal: str = ""
    domains: list[str] = field(default_factory=list)
    #: The live gateway for an allowlist, or None. The CALLER must close
    #: it when the worker exits — it belongs to one invocation and must
    #: not outlive it.
    staged: object | None = None

    def close(self) -> None:
        if self.staged is not None:
            self.staged.close()
            self.staged = None

    def decisions(self) -> list[dict]:
        """What the door actually allowed and refused, as evidence."""
        gate = getattr(self.staged, "gateway", None)
        return [d.to_dict() for d in getattr(gate, "decisions", [])]

    @property
    def ok(self) -> bool:
        """May the worker be launched under this result?"""
        return not self.refusal

    def to_dict(self) -> dict:
        return {"state": self.state, "mode": self.mode, "method": self.method,
                "verified": self.verified, "detail": self.detail,
                "refusal": self.refusal, "domains": list(self.domains)}


# ── platform capability ─────────────────────────────────────────────────

def _userns_available() -> bool:
    """Can this kernel give an unprivileged process its own namespaces?"""
    try:
        with open("/proc/sys/kernel/unprivileged_userns_clone") as fh:
            if fh.read().strip() == "0":
                return False
    except OSError:
        pass  # absent on many kernels, where it is simply enabled
    try:
        with open("/proc/sys/user/max_user_namespaces") as fh:
            return int(fh.read().strip() or "0") > 0
    except (OSError, ValueError):
        return True


def capability() -> dict:
    """What this host can really enforce, stated per mode.

    Called by the worker matrix and the API, so the UI never has to guess
    and can never claim more than the kernel gives.
    """
    bwrap = shutil.which("bwrap")
    if os.name == "nt":
        return {"platform": "windows", "method": "", "modes": {
            DENY: UNSUPPORTED, ALLOWLIST: UNSUPPORTED,
            UNRESTRICTED: NOT_CONFIGURED},
            "detail": ("No process-scoped network boundary is implemented "
                       "for Windows. A Job Object bounds processes, not "
                       "sockets; enforcing egress would need a Windows "
                       "Filtering Platform provider, which AURA does not "
                       "ship.")}
    if os.uname().sysname == "Darwin":
        return {"platform": "macos", "method": "", "modes": {
            DENY: UNSUPPORTED, ALLOWLIST: UNSUPPORTED,
            UNRESTRICTED: NOT_CONFIGURED},
            "detail": ("macOS has no unprivileged per-process network "
                       "namespace. sandbox-exec is deprecated and a "
                       "Network Extension needs a signed system "
                       "extension, so AURA claims nothing here.")}
    if not bwrap:
        return {"platform": "linux", "method": "", "modes": {
            DENY: UNSUPPORTED, ALLOWLIST: UNSUPPORTED,
            UNRESTRICTED: NOT_CONFIGURED},
            "detail": ("bubblewrap (bwrap) is not installed, so AURA "
                       "cannot place a worker in a network namespace.")}
    if not _userns_available():
        return {"platform": "linux", "method": "", "modes": {
            DENY: UNSUPPORTED, ALLOWLIST: UNSUPPORTED,
            UNRESTRICTED: NOT_CONFIGURED},
            "detail": ("Unprivileged user namespaces are disabled on this "
                       "kernel, so bwrap cannot create a network "
                       "namespace without privilege AURA does not have.")}
    return {
        "platform": "linux",
        "method": "bwrap --unshare-net + AURA egress gateway",
        "modes": {
            DENY: SUPPORTED_AND_ENFORCED,
            ALLOWLIST: SUPPORTED_AND_ENFORCED,
            UNRESTRICTED: NOT_CONFIGURED},
        "detail": ("An unprivileged network namespace removes every route. "
                   "Denial is that namespace alone. An allowlist is that "
                   "same namespace plus one AURA-owned door: a CONNECT "
                   "gateway reachable only over a unix socket, deciding on "
                   "the hostname the client asks for. Only HTTP and HTTPS "
                   "can pass through it; everything else stays denied."),
        "protocols": {"http": "proxied and checked",
                      "https": "tunnelled after a checked CONNECT",
                      "other": "denied — no route exists"}}


# ── the boundary ────────────────────────────────────────────────────────

def _resolver_free_dir(home: str) -> str:
    """Files that close name resolution inside the namespace.

    A network namespace does not isolate the unix socket glibc uses to
    reach a system resolver, so without this a sandboxed worker still
    resolves names — and a resolver reachable from inside is a channel
    out, whatever it can or cannot connect to afterwards.
    """
    root = os.path.join(home, "netgov")
    os.makedirs(root, exist_ok=True)
    files = {
        "resolv.conf": "# AURA: name resolution is denied for this task\n",
        "nsswitch.conf": ("passwd: files\ngroup: files\nshadow: files\n"
                          "hosts: files\nnetworks: files\nservices: files\n"
                          "protocols: files\n"),
        "hosts": "127.0.0.1 localhost\n::1 localhost\n",
    }
    for name, body in files.items():
        path = os.path.join(root, name)
        if not os.path.exists(path) or open(path).read() != body:
            with open(path, "w", encoding="utf-8") as fh:
                fh.write(body)
    return root


def deny_prefix(home: str) -> list[str]:
    """The argv prefix that puts a command inside the denial boundary."""
    root = _resolver_free_dir(home)
    return [
        "bwrap", "--dev-bind", "/", "/",
        "--unshare-net",
        # The worker dies with AURA: a sandbox that outlives its
        # supervisor is an orphan with no one governing it.
        "--die-with-parent",
        "--tmpfs", "/run/systemd/resolve",
        "--ro-bind", os.path.join(root, "resolv.conf"), "/etc/resolv.conf",
        "--ro-bind", os.path.join(root, "nsswitch.conf"), "/etc/nsswitch.conf",
        "--ro-bind", os.path.join(root, "hosts"), "/etc/hosts",
        "--",
    ]


_PROBE = (
    "import socket,sys\n"
    "def blocked(fn):\n"
    "    try:\n"
    "        fn(); return False\n"
    "    except Exception:\n"
    "        return True\n"
    f"tcp = blocked(lambda: socket.create_connection(('{PROBE_HOST}',"
    f"{PROBE_PORT}), timeout=4))\n"
    "dns = blocked(lambda: socket.getaddrinfo('example.com', 443))\n"
    "sys.exit(0 if (tcp and dns) else 1)\n"
)


def verify_denial(home: str, timeout_s: int = VERIFY_TIMEOUT_S) -> tuple[bool, str]:
    """Prove the boundary before trusting it.

    Runs a probe INSIDE the boundary that tries to reach an IP literal
    and to resolve a name. Both must fail. An IP literal is used on
    purpose: a blocked resolver alone would make a leaking network look
    closed. If the probe cannot run at all, that is a failure too —
    AURA never launches a worker under a boundary it did not observe.
    """
    import sys as _sys

    # Through the ONE execution boundary, like everything else AURA
    # spawns: same secret isolation, same output bounds, same process
    # tree cleanup. A self-check that bypassed it would be the only
    # unsupervised process in the system.
    from ..environment.procexec import run_argv

    try:
        outcome = run_argv([*deny_prefix(home), _sys.executable, "-c", _PROBE],
                           timeout_ms=timeout_s * 1000)
    except Exception as exc:  # noqa: BLE001 — any failure is a refusal
        return False, f"the boundary self-check could not run: {exc}"
    if outcome.exit_code == 0:
        return True, (f"verified: inside the boundary, TCP to {PROBE_HOST}:"
                      f"{PROBE_PORT} and name resolution both fail.")
    if outcome.exit_code == 1:
        return False, ("the boundary was created but traffic still escaped "
                       "it; refusing to call this governed.")
    err = (outcome.stderr or outcome.error or "").strip()[:200]
    return False, f"the boundary could not be created: {err or 'unknown error'}"


def allowlist_prefix(home: str, staged) -> list[str]:
    """The argv prefix for a task with an allowlist.

    The SAME denial boundary, with two additions: the gateway's unix
    socket is bound in so the relay can reach it, and the command is the
    staged relay rather than the worker. The worker becomes the relay's
    child, which keeps it inside AURA's process group — so cancellation
    and process-tree termination behave exactly as they do without a
    network policy.
    """
    import sys as _sys

    prefix = deny_prefix(home)
    extra = [
        "--ro-bind", staged.launcher_path, staged.launcher_path,
        "--bind", staged.socket_path, staged.socket_path,
    ]
    # Slot the binds before bwrap's `--`, then make the relay the command.
    body = prefix[:-1] + extra + ["--"]
    return [*body, _sys.executable, staged.launcher_path,
            staged.socket_path, str(staged.port)]


def _socket_dir() -> str:
    """A directory short enough to hold an AF_UNIX path.

    AF_UNIX paths cap at ~108 bytes, and an AURA home is a normal
    user-chosen path that can easily exceed that on its own — a
    per-invocation socket under it then fails to bind. The runtime
    directory is the right home for a socket that lives as long as one
    process anyway; a short temp directory is the fallback.
    """
    import tempfile

    runtime = os.environ.get("XDG_RUNTIME_DIR")
    if runtime and os.path.isdir(runtime) and len(runtime) < 60:
        root = os.path.join(runtime, "aura")
        try:
            os.makedirs(root, mode=0o700, exist_ok=True)
            return root
        except OSError:
            pass
    return tempfile.gettempdir()


def stage_allowlist(policy: NetworkPolicy, home: str):
    """Start the gateway and write the relay for one invocation."""
    import tempfile
    import uuid

    from .netgate import (
        DEFAULT_PORTS,
        LAUNCHER_SOURCE,
        SANDBOX_PROXY_PORT,
        EgressGateway,
        StagedGateway,
    )

    root = os.path.join(home, "netgov", "gate-" + uuid.uuid4().hex[:12])
    os.makedirs(root, exist_ok=True)
    launcher = os.path.join(root, "aura-net-relay.py")
    with open(launcher, "w", encoding="utf-8") as fh:
        fh.write(LAUNCHER_SOURCE)
    os.chmod(launcher, 0o500)
    socket_dir = tempfile.mkdtemp(prefix="aura-eg-", dir=_socket_dir())
    os.chmod(socket_dir, 0o700)
    socket_path = os.path.join(socket_dir, "e.sock")
    if len(socket_path.encode()) > 100:
        raise OSError(
            f"no short enough path for the egress socket ({socket_path})")
    gateway = EgressGateway(socket_path, policy.domains,
                            policy.ports or DEFAULT_PORTS)
    gateway.start()
    return StagedGateway(gateway=gateway, launcher_path=launcher,
                         socket_path=socket_path, port=SANDBOX_PROXY_PORT,
                         socket_dir=socket_dir)


#: A destination no allowlist should ever contain, used to prove that the
#: door refuses what the policy did not name.
_DENIED_PROBE_HOST = "aura-must-never-reach-this.invalid"

_ALLOWLIST_PROBE = f"""
import socket, sys, urllib.error, urllib.request

def refused(fn):
    try:
        fn(); return False
    except Exception:
        return True

# 1. the door itself is reachable from inside the namespace
try:
    socket.create_connection(('127.0.0.1', {{port}}), timeout=4).close()
except OSError:
    sys.exit(2)

# 2. a destination the policy does not name is refused BY the door
opener = urllib.request.build_opener(urllib.request.ProxyHandler(
    {{{{'http': 'http://127.0.0.1:{{port}}',
        'https': 'http://127.0.0.1:{{port}}'}}}}))
def denied_call():
    opener.open('http://{_DENIED_PROBE_HOST}/', timeout=6)
if not refused(denied_call):
    sys.exit(3)

# 3. there is still no route around the door
if not refused(lambda: socket.create_connection(('{PROBE_HOST}',
                                                 {PROBE_PORT}), timeout=4)):
    sys.exit(4)
if not refused(lambda: socket.getaddrinfo('example.com', 443)):
    sys.exit(5)
sys.exit(0)
"""


def verify_allowlist(home: str, staged,
                     timeout_s: int = VERIFY_TIMEOUT_S) -> tuple[bool, str]:
    """Prove the door before trusting it.

    Three properties, all checked from INSIDE the boundary: the door is
    reachable, it refuses a destination the policy does not name, and no
    route exists around it. Reaching an ALLOWED destination is
    deliberately not required — that would make the check depend on the
    internet being up, and a door that cannot reach a permitted host is
    a broken task, not a broken boundary.
    """
    import sys as _sys

    from ..environment.procexec import run_argv

    probe = _ALLOWLIST_PROBE.format(port=staged.port)
    try:
        # The prefix ends at the relay; what follows is the command the
        # relay starts, exactly as a worker's argv would.
        outcome = run_argv(
            [*allowlist_prefix(home, staged), _sys.executable, "-c", probe],
            timeout_ms=timeout_s * 1000)
    except Exception as exc:  # noqa: BLE001 — any failure is a refusal
        return False, f"the egress gateway self-check could not run: {exc}"
    reasons = {
        0: "",
        2: "the worker could not reach AURA's egress gateway.",
        3: ("the gateway did not refuse a destination outside the "
            "allowlist; refusing to call this governed."),
        4: ("traffic escaped the boundary without passing the gateway; "
            "refusing to call this governed."),
        5: "name resolution escaped the boundary.",
    }
    code = outcome.exit_code
    if code == 0:
        return True, (
            "verified: the gateway is reachable, a destination outside the "
            "allowlist is refused, and no route exists around it.")
    detail = reasons.get(code)
    if detail:
        return False, detail
    err = (outcome.stderr or outcome.error or "").strip()[:200]
    return False, f"the egress gateway could not be created: {err or code}"


def establish(policy: NetworkPolicy | None, home: str,
              verify=None, verify_allow=None,
              stage=None) -> EnforcementResult:
    """Set up the boundary a task's policy requires, or refuse.

    Returns a result whose `ok` is False when the worker must NOT be
    launched. §19: initialization failure never becomes a launch under
    the claim of governance.

    The three seams resolve at CALL time rather than as default
    arguments. Defaults would capture these functions at import, so a
    caller replacing one — a test standing in a host that cannot open
    the door — would be silently ignored, and the check would pass
    while proving nothing.
    """
    verify = verify or verify_denial
    verify_allow = verify_allow or verify_allowlist
    stage = stage or stage_allowlist
    caps = capability()
    if policy is None or policy.mode == UNRESTRICTED:
        # Ungoverned is a legitimate answer for a task that needs the
        # network (a coding worker reaching its own model provider
        # cannot run inside a denial). It is reported, not hidden.
        return EnforcementResult(
            state=NOT_CONFIGURED, mode=UNRESTRICTED,
            detail=("No network policy applies to this task, so its "
                    "network access is ungoverned."))

    supported = caps["modes"].get(policy.mode, UNSUPPORTED)
    if supported == UNSUPPORTED:
        return EnforcementResult(
            state=UNSUPPORTED, mode=policy.mode, method=caps["method"],
            refusal=f"network-{policy.mode}-unsupported",
            detail=(f"This task requires network mode '{policy.mode}', "
                    f"which this host cannot enforce. {caps['detail']}"))

    if policy.mode == DENY:
        ok, why = verify(home)
        if not ok:
            return EnforcementResult(
                state=INITIALIZATION_FAILED, mode=policy.mode,
                method=caps["method"],
                refusal="network-initialization-failed",
                detail=f"Network governance could not be established: {why}")
        return EnforcementResult(
            state=SUPPORTED_AND_ENFORCED, mode=policy.mode,
            method=caps["method"], argv_prefix=deny_prefix(home),
            verified=True, detail=why)

    # ── allowlist ────────────────────────────────────────────────────
    try:
        staged = stage(policy, home)
    except Exception as exc:  # noqa: BLE001 — a door that will not open
        return EnforcementResult(                       # is a refusal
            state=INITIALIZATION_FAILED, mode=policy.mode,
            method=caps["method"], refusal="network-initialization-failed",
            detail=f"The egress gateway could not be started: {exc}")
    ok, why = verify_allow(home, staged)
    if not ok:
        staged.close()
        return EnforcementResult(
            state=INITIALIZATION_FAILED, mode=policy.mode,
            method=caps["method"], refusal="network-initialization-failed",
            detail=f"Network governance could not be established: {why}")
    return EnforcementResult(
        state=SUPPORTED_AND_ENFORCED, mode=policy.mode,
        method=caps["method"], argv_prefix=allowlist_prefix(home, staged),
        verified=True, detail=why, domains=list(policy.domains),
        staged=staged)


__all__ = [
    "ALLOWLIST", "DENY", "allowlist_prefix", "stage_allowlist",
    "verify_allowlist", "INITIALIZATION_FAILED", "MODES", "NOT_CONFIGURED",
    "SUPPORTED_AND_ENFORCED", "SUPPORTED_BUT_RESTRICTED", "UNRESTRICTED",
    "UNSUPPORTED", "EnforcementResult", "NetworkPolicy", "capability",
    "deny_prefix", "establish", "verify_denial",
]
