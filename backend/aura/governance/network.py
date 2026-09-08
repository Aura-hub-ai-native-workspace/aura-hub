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

`allowlist` is NOT enforced here, and this module will not pretend
otherwise. Selective egress needs a userspace network stack for the
namespace (slirp4netns / pasta) or a privileged firewall rule; without
one, the only honest states are "all" and "none". An allowlist request
on a host that cannot enforce it fails closed with that reason rather
than degrading into an environment variable a worker can unset.

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

    @staticmethod
    def parse(raw: object) -> "NetworkPolicy | None":
        """Read a task's declared network policy, or None when it states
        none. Malformed input is a refusal, not a default: a policy that
        cannot be read is not a policy."""
        if raw is None:
            return None
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
        else:
            raise ValueError("network policy must be a string or an object")
        if mode not in MODES:
            raise ValueError(
                f"unknown network mode {mode!r}; expected one of "
                f"{', '.join(MODES)}")
        if mode == ALLOWLIST and not domains:
            raise ValueError("an allowlist with no destinations denies "
                             "everything; state 'deny' if that is intended")
        return NetworkPolicy(mode=mode, domains=domains)

    def to_dict(self) -> dict:
        return {"mode": self.mode, "domains": list(self.domains)}


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

    @property
    def ok(self) -> bool:
        """May the worker be launched under this result?"""
        return not self.refusal

    def to_dict(self) -> dict:
        return {"state": self.state, "mode": self.mode, "method": self.method,
                "verified": self.verified, "detail": self.detail,
                "refusal": self.refusal}


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
    return {"platform": "linux", "method": "bwrap --unshare-net", "modes": {
        DENY: SUPPORTED_AND_ENFORCED,
        # Honest, and the reason is the point: the namespace is all-or-
        # nothing without a userspace network stack for it.
        ALLOWLIST: UNSUPPORTED,
        UNRESTRICTED: NOT_CONFIGURED},
        "detail": ("Egress denial is enforced by an unprivileged network "
                   "namespace. Selective egress would need slirp4netns or "
                   "pasta to give that namespace a stack AURA can filter; "
                   "neither is required by AURA today, so an allowlist is "
                   "refused rather than approximated.")}


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


def establish(policy: NetworkPolicy | None, home: str,
              verify=verify_denial) -> EnforcementResult:
    """Set up the boundary a task's policy requires, or refuse.

    Returns a result whose `ok` is False when the worker must NOT be
    launched. §19: initialization failure never becomes a launch under
    the claim of governance.
    """
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

    ok, why = verify(home)
    if not ok:
        return EnforcementResult(
            state=INITIALIZATION_FAILED, mode=policy.mode,
            method=caps["method"], refusal="network-initialization-failed",
            detail=f"Network governance could not be established: {why}")
    return EnforcementResult(
        state=SUPPORTED_AND_ENFORCED, mode=policy.mode,
        method=caps["method"], argv_prefix=deny_prefix(home),
        verified=True, detail=why)


__all__ = [
    "ALLOWLIST", "DENY", "INITIALIZATION_FAILED", "MODES", "NOT_CONFIGURED",
    "SUPPORTED_AND_ENFORCED", "SUPPORTED_BUT_RESTRICTED", "UNRESTRICTED",
    "UNSUPPORTED", "EnforcementResult", "NetworkPolicy", "capability",
    "deny_prefix", "establish", "verify_denial",
]
