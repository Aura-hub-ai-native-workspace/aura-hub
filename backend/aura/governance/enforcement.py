"""Platform adapters for network enforcement — one contract, three hosts.

AURA decides the policy. A platform adapter is the only thing that knows
how to make an operating system obey it, and the only thing allowed to
say whether that operating system actually can.

    NetworkPolicy  →  adapter.prepare()  →  real OS enforcement
                                         →  or a refusal

The contract is deliberately small, because everything interesting stays
where it already is: the Central Agent owns the run, the policy engine
owns the decision, the ledger owns approval, the executor owns the
launch, and the audit trail owns the evidence. An adapter answers two
questions and nothing else — what can this host enforce, and can it be
established right now.

    modes()    what this host enforces, per policy mode
    describe() the mechanism and, when there is one, the blocker
    prepare()  establish it and PROVE it, or refuse the launch

WHY THE HONEST ANSWER IS DIFFERENT PER PLATFORM

Linux is implemented and verified: an unprivileged network namespace
removes every route, and an AURA-owned gateway reachable over a unix
socket adds one audited door. Windows and macOS both have mechanisms
that could carry the same semantics, and both are documented below with
the specific thing standing in the way. Neither is claimed, because
neither has been run: no Windows or macOS machine has executed a line of
this, and enforcement is exactly the property a simulated platform
cannot demonstrate. `hostplatform.simulate()` can put AURA's DECISIONS
on another operating system — it cannot put a kernel there.

So the states below are the truth as of this machine, and they are
computed rather than asserted: a platform reports SUPPORTED_AND_ENFORCED
only where AURA both implements the mechanism and verifies it at launch.
"""

from __future__ import annotations

from ..environment.hostplatform import Platform, current


class NetworkEnforcement:
    """What every platform adapter must answer."""

    platform: Platform = Platform.LINUX
    #: The mechanism, named precisely enough to be checked by a reader.
    mechanism: str = ""

    def modes(self) -> dict[str, str]:
        """Enforcement state per policy mode. Never a boolean: "enabled"
        and "enforced" are different words, and only this layer knows
        which one applies."""
        raise NotImplementedError

    def describe(self) -> dict:
        raise NotImplementedError

    def prepare(self, policy, home: str, **seams):
        """Establish the boundary and prove it, or refuse the launch.

        Returns an EnforcementResult whose `ok` is False when the worker
        must NOT be started. An adapter that cannot enforce a mode says
        so here; it never returns a weaker boundary under the name of a
        stronger one, and it never returns an unrestricted one.
        """
        raise NotImplementedError


class LinuxNetworkEnforcement(NetworkEnforcement):
    """Unprivileged network namespace, plus one AURA-owned door.

    Implemented and verified. `deny` is the namespace alone: no route, no
    interface but loopback, no resolver, so there is nothing to bypass.
    `allowlist` is that same namespace plus an egress gateway reachable
    only over a unix socket — which a network namespace does not isolate
    — deciding on the hostname the client puts in CONNECT.

    The verification is not optional: prepare() runs a probe INSIDE the
    boundary and refuses the launch if the boundary cannot be observed
    holding.
    """

    platform = Platform.LINUX
    mechanism = "bwrap --unshare-net + AURA egress gateway"

    def modes(self) -> dict[str, str]:
        from . import network as net

        return net.linux_modes()

    def describe(self) -> dict:
        from . import network as net

        return net.linux_description()

    def prepare(self, policy, home: str, **seams):
        from . import network as net

        return net.linux_establish(policy, home, **seams)


class WindowsNetworkEnforcement(NetworkEnforcement):
    """Researched, not implemented. AppContainer is the way in.

    THE MECHANISM. A process created with
    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES and a capability set that
    OMITS `internetClient` has no outbound network, enforced by the
    kernel, inherited by every child it spawns. That is the true Windows
    analogue of `--unshare-net`: it needs no administrator, and a worker
    cannot escape it by launching cmd.exe, powershell.exe or python.exe,
    because the restriction travels with the token rather than with the
    binary.

    WHY NOT WFP ALONE. The Windows Filtering Platform can filter at
    ALE_AUTH_CONNECT with FWPM_CONDITION_ALE_APP_ID, and dynamic-session
    filters clean themselves up when the engine handle closes, which
    would be a good fit for per-run lifetime. But ALE_APP_ID identifies a
    BINARY PATH, so scoping a worker's python.exe would filter every
    python.exe on the machine — the user's included. That is precisely
    the "do not globally block the user's computer" failure. Scoping by
    FWPM_CONDITION_ALE_PACKAGE_ID (an AppContainer SID) avoids it, which
    is another reason the AppContainer comes first: WFP is the refinement
    on top, not the foundation. Installing filters also requires
    administrator rights, which AURA should not assume it has.

    WHAT BLOCKS EACH MODE.
      deny       needs only the AppContainer, so it is unprivileged and
                 achievable. It is not claimed because no Windows machine
                 has run it.
      allowlist  needs the worker to reach AURA's gateway. AppContainers
                 block loopback by default, and lifting that
                 (CheckNetIsolation LoopbackExempt) requires
                 administrator. A named pipe crosses the boundary without
                 privilege, but HTTP clients cannot proxy over one. So an
                 allowlist needs either elevation or a WFP allow-filter
                 scoped to the package SID — both real designs, neither
                 verified.

    Until a Windows machine runs it, both modes are UNSUPPORTED and a
    task requiring them is refused rather than launched.
    """

    platform = Platform.WINDOWS
    mechanism = "AppContainer (planned); WFP ALE_PACKAGE_ID refinement"

    def modes(self) -> dict[str, str]:
        from . import network as net

        return {net.DENY: net.UNSUPPORTED,
                net.ALLOWLIST: net.UNSUPPORTED,
                net.UNRESTRICTED: net.NOT_CONFIGURED}

    def describe(self) -> dict:

        return {
            "platform": "windows",
            "method": "",
            "modes": self.modes(),
            "detail": (
                "AURA does not enforce network policy on Windows. The "
                "mechanism is identified — an AppContainer without the "
                "internetClient capability denies egress for a process "
                "and every child it spawns, without administrator rights "
                "— but no Windows machine has run it, so nothing is "
                "claimed. A task requiring a network policy is refused "
                "here rather than launched ungoverned."),
            "planned": {
                "deny": ("AppContainer without internetClient; "
                         "unprivileged, inherited by child processes"),
                "allowlist": ("the same container plus AURA's egress "
                              "gateway, which needs either a loopback "
                              "exemption (administrator) or a WFP filter "
                              "scoped to the container's package SID"),
            },
            "blocker": "no Windows host has executed or verified it",
        }

    def prepare(self, policy, home: str, **seams):
        from . import network as net

        return net.refuse(
            policy,
            state=net.UNSUPPORTED,
            method="",
            refusal=f"network-{policy.mode}-unsupported",
            detail=(f"This task requires network mode '{policy.mode}'. "
                    "AURA does not enforce network policy on Windows yet, "
                    "so the worker was not started. "
                    + self.describe()["detail"]))


class MacOSNetworkEnforcement(NetworkEnforcement):
    """Researched, not implemented. Two candidate mechanisms, one cheap.

    THE APPLE-BLESSED ROUTE is a Network Extension: an NEFilterDataProvider
    content filter sees every flow with a source application identity and
    returns allow or drop, and an NEAppProxyProvider mediates TCP/UDP for
    managed applications. Both need a system extension, the
    com.apple.developer.networking.networkextension entitlement (which
    Apple grants on request, not automatically), Developer ID signing and
    notarization, and explicit user approval in System Settings. They
    also identify traffic by APPLICATION, so a worker that shells out to
    /usr/bin/curl appears as curl — a binary shared with the rest of the
    system — which makes per-invocation scoping awkward in exactly the
    way ALE_APP_ID does on Windows.

    THE PRAGMATIC ROUTE is sandbox-exec, which is present on every macOS,
    needs no entitlement and no privilege, and is inherited by children.
    `(deny network*)` is a real denial; `(allow network-outbound (remote
    ip "localhost:PORT"))` re-opens exactly one destination, which is the
    shape AURA already uses on Linux — the namespace becomes a sandbox
    profile and the unix socket becomes a loopback port. Apple deprecated
    the command, and it prints a warning, but it is what several shipping
    toolchains still rely on.

    TWO HONEST CAVEATS on that route. A loopback gateway is reachable by
    any other process running as the same user, so it is a weaker
    boundary than the Linux namespace, which no other process can enter.
    And deprecation means it can be withdrawn by a macOS release.

    `sandbox_profile()` below generates the profile AURA would use. It is
    written and reviewable; it has never been executed, because there is
    no Mac here. Both modes therefore report UNSUPPORTED and a task
    requiring them is refused.
    """

    platform = Platform.MACOS
    mechanism = "sandbox-exec profile (planned); NEFilterDataProvider (option)"

    def modes(self) -> dict[str, str]:
        from . import network as net

        return {net.DENY: net.UNSUPPORTED,
                net.ALLOWLIST: net.UNSUPPORTED,
                net.UNRESTRICTED: net.NOT_CONFIGURED}

    def describe(self) -> dict:
        return {
            "platform": "macos",
            "method": "",
            "modes": self.modes(),
            "detail": (
                "AURA does not enforce network policy on macOS. Two "
                "mechanisms are identified — a Network Extension content "
                "filter, which needs an Apple-granted entitlement, a "
                "signed system extension and user approval; and "
                "sandbox-exec, which needs neither but is deprecated — "
                "and no Mac has run either, so nothing is claimed. A task "
                "requiring a network policy is refused here rather than "
                "launched ungoverned."),
            "planned": {
                "deny": "sandbox-exec profile denying network*",
                "allowlist": ("the same profile re-opening only AURA's "
                              "loopback gateway port"),
            },
            "entitlements": {
                "networkExtension": "com.apple.developer.networking.networkextension",
                "requires": ("Apple approval, Developer ID signing, "
                             "notarization, a system extension and "
                             "explicit user approval"),
            },
            "blocker": "no macOS host has executed or verified it",
        }

    def prepare(self, policy, home: str, **seams):
        from . import network as net

        return net.refuse(
            policy,
            state=net.UNSUPPORTED,
            method="",
            refusal=f"network-{policy.mode}-unsupported",
            detail=(f"This task requires network mode '{policy.mode}'. "
                    "AURA does not enforce network policy on macOS yet, "
                    "so the worker was not started. "
                    + self.describe()["detail"]))

    @staticmethod
    def sandbox_profile(gateway_port: int | None = None) -> str:
        """The sandbox-exec profile AURA would apply.

        NEVER EXECUTED. There is no Mac in this environment, so this is a
        reviewable artefact and a starting point, not a verified one. It
        is written out rather than left to a future reader because the
        shape matters: deny first, then re-open exactly one destination,
        which is the same argument the Linux boundary makes.

        `gateway_port` None gives a plain denial; a port re-opens only
        AURA's loopback gateway, so an allowlist decision still happens
        at the gateway, on the hostname, exactly as it does on Linux.
        """
        lines = [
            ";; AURA network policy — generated, do not edit.",
            "(version 1)",
            "(allow default)",
            ";; Egress is denied wholesale first; anything permitted is",
            ";; re-opened below, so a missing rule fails closed.",
            "(deny network*)",
        ]
        if gateway_port is not None:
            lines += [
                ";; The single door: AURA's egress gateway. The allowlist",
                ";; decision is made there, by hostname, not here.",
                f'(allow network-outbound (remote ip "localhost:{gateway_port}"))',
            ]
        return "\n".join(lines) + "\n"


#: One adapter per platform. Selected through hostplatform.current(), so
#: `simulate()` can put AURA's DECISIONS on another operating system for
#: the length of a test — which is how the unsupported paths are covered
#: from a Linux machine without ever claiming they were enforced there.
_ADAPTERS: dict[Platform, NetworkEnforcement] = {
    Platform.LINUX: LinuxNetworkEnforcement(),
    Platform.WINDOWS: WindowsNetworkEnforcement(),
    Platform.MACOS: MacOSNetworkEnforcement(),
}


def adapter_for(platform: Platform | None = None) -> NetworkEnforcement:
    return _ADAPTERS[platform or current()]


__all__ = ["LinuxNetworkEnforcement", "MacOSNetworkEnforcement",
           "NetworkEnforcement", "WindowsNetworkEnforcement", "adapter_for"]
