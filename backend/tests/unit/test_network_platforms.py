"""Platform adapters for network enforcement.

**These are MOCK VERIFIED, not NATIVE VERIFIED.** No Windows or macOS
machine ran them. What they verify is real but narrow: every network
enforcement DECISION now routes through a platform adapter selected by
`hostplatform.current()`, so `simulate()` puts that decision on another
operating system for the length of a test.

What simulation cannot reach is the whole point of this subsystem. A
network boundary is enforced by a kernel, and the kernel here is Linux.
So these tests assert on decisions — which adapter answers, what it
claims, and that it refuses rather than launches — and never on whether
a packet was stopped. The Linux enforcement proof lives in
test_network_governance.py and test_network_allowlist.py, where real
clients really fail to connect.
"""

from __future__ import annotations

import pytest

from aura.environment.hostplatform import Platform, simulate
from aura.governance import network as netgov
from aura.governance.enforcement import (
    LinuxNetworkEnforcement,
    MacOSNetworkEnforcement,
    WindowsNetworkEnforcement,
    adapter_for,
)

UNVERIFIED = (Platform.WINDOWS, Platform.MACOS)


class TestAdapterSelection:
    def test_each_platform_answers_for_itself(self):
        assert isinstance(adapter_for(Platform.LINUX), LinuxNetworkEnforcement)
        assert isinstance(adapter_for(Platform.WINDOWS),
                          WindowsNetworkEnforcement)
        assert isinstance(adapter_for(Platform.MACOS), MacOSNetworkEnforcement)

    def test_the_running_host_is_the_default(self):
        for platform in Platform:
            with simulate(platform):
                assert adapter_for().platform is platform

    def test_capability_follows_the_simulated_host(self):
        """The capability report is computed by the adapter, not looked
        up in a table that can drift away from it."""
        for platform in Platform:
            with simulate(platform):
                assert netgov.capability()["platform"] == platform.value


class TestUnverifiedPlatformsClaimNothing:
    """The rule this phase turns on: a platform that has never run the
    mechanism does not get to say it enforces it."""

    @pytest.mark.parametrize("platform", UNVERIFIED)
    def test_no_mode_is_claimed_as_enforced(self, platform):
        modes = adapter_for(platform).modes()
        assert modes[netgov.DENY] == netgov.UNSUPPORTED
        assert modes[netgov.ALLOWLIST] == netgov.UNSUPPORTED
        assert modes[netgov.UNRESTRICTED] == netgov.NOT_CONFIGURED

    @pytest.mark.parametrize("platform", UNVERIFIED)
    def test_the_report_names_a_mechanism_and_a_blocker(self, platform):
        """An honest UNSUPPORTED is not a shrug: it says what the
        mechanism would be and what is actually in the way, so the next
        engineer starts from a design rather than a blank page."""
        described = adapter_for(platform).describe()
        assert described["blocker"]
        assert described["planned"]["deny"]
        assert described["planned"]["allowlist"]
        assert described["method"] == "", (
            "an unverified platform must not advertise a method as if it "
            "were in use")

    @pytest.mark.parametrize("platform", UNVERIFIED)
    @pytest.mark.parametrize("mode", [netgov.DENY, netgov.ALLOWLIST])
    def test_a_governed_task_is_refused_not_launched(self, platform, mode,
                                                     tmp_path):
        policy = netgov.NetworkPolicy(
            mode=mode, domains=("example.com",) if mode == netgov.ALLOWLIST
            else ())
        with simulate(platform):
            result = netgov.establish(policy, str(tmp_path))
        assert result.ok is False
        assert result.state == netgov.UNSUPPORTED
        assert result.verified is False
        assert result.argv_prefix == []
        assert result.refusal == f"network-{mode}-unsupported"

    @pytest.mark.parametrize("platform", UNVERIFIED)
    def test_it_never_silently_becomes_unrestricted(self, platform, tmp_path):
        """The failure everyone fears: an unsupported platform quietly
        letting the worker run with full network."""
        with simulate(platform):
            result = netgov.establish(
                netgov.NetworkPolicy(mode=netgov.DENY), str(tmp_path))
        assert result.mode == netgov.DENY
        assert result.state != netgov.NOT_CONFIGURED

    @pytest.mark.parametrize("platform", list(Platform))
    def test_a_task_with_no_policy_stays_ungoverned_everywhere(
            self, platform, tmp_path):
        """Ungoverned is a legitimate answer on every platform, and it
        says so rather than claiming protection."""
        with simulate(platform):
            result = netgov.establish(None, str(tmp_path))
        assert result.ok is True
        assert result.state == netgov.NOT_CONFIGURED
        assert result.verified is False


class TestMacOSProfileArtefact:
    """The sandbox-exec profile AURA would apply. NEVER EXECUTED — there
    is no Mac here — so these check the shape of an artefact, not that
    macOS honoured it."""

    def test_denial_comes_before_anything_is_reopened(self):
        profile = MacOSNetworkEnforcement.sandbox_profile()
        assert "(deny network*)" in profile
        assert "network-outbound" not in profile

    def test_an_allowlist_reopens_only_the_gateway(self):
        profile = MacOSNetworkEnforcement.sandbox_profile(gateway_port=3128)
        deny_at = profile.index("(deny network*)")
        allow_at = profile.index("network-outbound")
        assert deny_at < allow_at, (
            "a rule that precedes the denial would not fail closed")
        assert 'remote ip "localhost:3128"' in profile
        # Exactly one door, as on Linux.
        assert profile.count("allow network-outbound") == 1


class TestLinuxIsUnchanged:
    """The verified implementation must survive being put behind a seam."""

    def test_linux_still_reports_both_modes_enforced(self):
        import shutil
        import sys

        if not (sys.platform.startswith("linux") and shutil.which("bwrap")):
            pytest.skip("no bwrap on this host")
        modes = adapter_for(Platform.LINUX).modes()
        assert modes[netgov.DENY] == netgov.SUPPORTED_AND_ENFORCED
        assert modes[netgov.ALLOWLIST] == netgov.SUPPORTED_AND_ENFORCED

    def test_linux_reports_honestly_when_the_primitive_is_missing(self,
                                                                  monkeypatch):
        """The claim tracks the mechanism: no bwrap, no enforcement."""
        monkeypatch.setattr(netgov.shutil, "which", lambda _name: None)
        modes = netgov.linux_modes()
        assert modes[netgov.DENY] == netgov.UNSUPPORTED
        assert modes[netgov.ALLOWLIST] == netgov.UNSUPPORTED
        assert netgov.linux_description()["blocker"]


class TestRefusalsAreUniform:
    def test_a_refusal_is_never_an_allow_with_a_sad_message(self):
        policy = netgov.NetworkPolicy(mode=netgov.DENY)
        result = netgov.refuse(policy, state=netgov.UNSUPPORTED, method="",
                               refusal="network-deny-unsupported",
                               detail="nope")
        assert result.ok is False
        assert result.argv_prefix == []
        assert result.verified is False
