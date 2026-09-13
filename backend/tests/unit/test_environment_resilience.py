"""Cache correctness, concurrency, observability and API resilience.

The scan is a shared, expensive, partly-failing operation. These tests are
about the properties that matter when many callers hit it at once, when part
of it breaks, and when someone later has to explain from a log why a machine
was reported the way it was.
"""

from __future__ import annotations

import json
import logging
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest

import aura.environment.probe as probe_module
from aura.environment import scan_environment, scan_result_to_dict
from aura.environment.observability import LOGGER_NAME, redact, redact_mapping
from aura.environment.probe import _clear_cache

POSIX_ONLY = pytest.mark.skipif(sys.platform == "win32", reason="POSIX fixtures")


@pytest.fixture(autouse=True)
def _isolate():
    _clear_cache()
    yield
    _clear_cache()


# ── cache correctness ───────────────────────────────────────────────────


class TestCacheCorrectness:
    def test_a_cold_scan_populates_and_a_cached_scan_reuses(self):
        _clear_cache()
        cold_started = time.monotonic()
        scan_environment(refresh=True)
        cold = time.monotonic() - cold_started

        cached_started = time.monotonic()
        scan_environment(refresh=False)
        cached = time.monotonic() - cached_started

        assert cached < max(cold / 2, 0.5), f"cache saved nothing: {cold:.2f}s then {cached:.2f}s"

    def test_a_failed_refresh_does_not_replace_a_true_answer_with_an_empty_one(
        self, monkeypatch
    ):
        """Reporting "no tools found" because a manager hung is a lie.

        The last answer that was actually true is shown instead, flagged so
        the caller knows this scan did not measure it.
        """
        good = scan_environment(refresh=True)
        assert good.discovery is not None and good.discovery.tools, "need a populated baseline"
        baseline = len(good.discovery.tools)

        def explode(*_args, **_kwargs):
            raise RuntimeError("package manager wedged")

        monkeypatch.setattr(probe_module, "_run_discovery", explode)
        degraded = scan_environment(refresh=True)

        assert degraded.discovery is not None
        assert len(degraded.discovery.tools) == baseline, "a failed refresh emptied the inventory"
        assert degraded.discovery_degraded is True

        payload = scan_result_to_dict(degraded)
        assert payload["discovery"]["degraded"] is True

    def test_a_failed_refresh_with_no_history_reports_nothing_rather_than_guessing(
        self, monkeypatch
    ):
        _clear_cache()

        def explode(*_args, **_kwargs):
            raise RuntimeError("wedged")

        monkeypatch.setattr(probe_module, "_run_discovery", explode)
        result = scan_environment(refresh=True)

        assert result.discovery is not None
        assert result.discovery.tools == []
        assert result.discovery_degraded is True

    def test_cached_data_does_not_outlive_its_ttl(self, monkeypatch):
        scan_environment(refresh=True)
        with probe_module._cache_lock:
            assert probe_module._discovery_cache is not None
            at, layer = probe_module._discovery_cache
            # Pretend the cache was filled longer ago than its lifetime.
            probe_module._discovery_cache = (
                at - (probe_module.DISCOVERY_CACHE_TTL_MS / 1000) - 1,
                layer,
            )

        rebuilt: list[int] = []
        real = probe_module._run_discovery
        monkeypatch.setattr(
            probe_module,
            "_run_discovery",
            lambda *a, **k: (rebuilt.append(1), real(*a, **k))[1],
        )
        scan_environment(refresh=False)
        assert rebuilt, "an expired cache was reused"

    def test_a_probe_cache_entry_does_not_outlive_its_ttl(self, monkeypatch):
        from aura.environment import probe_node

        probe_node("git", refresh=True)
        with probe_module._cache_lock:
            key = probe_module._cache_key("git")
            at, result = probe_module._probe_cache[key]
            probe_module._probe_cache[key] = (
                at - (probe_module.PROBE_CACHE_TTL_MS / 1000) - 1,
                result,
            )
        assert probe_module._get_cached("git") is None

    def test_a_path_change_invalidates_cached_probes(self, tmp_path, monkeypatch):
        from aura.environment import probe_node

        probe_node("git", refresh=True)
        assert probe_module._get_cached("git") is not None
        monkeypatch.setenv("PATH", str(tmp_path))
        assert probe_module._get_cached("git") is None, "a stale answer survived a PATH change"


# ── single-flight under real pressure ───────────────────────────────────


class TestSingleFlight:
    @pytest.mark.parametrize("callers", [5, 20, 50])
    def test_concurrent_identical_scans_collapse(self, callers, monkeypatch):
        runs = {"n": 0}
        real = probe_module._scan_uncached
        lock = threading.Lock()

        def counting(node_ids, refresh):
            with lock:
                runs["n"] += 1
            time.sleep(0.3)
            return real(node_ids, refresh)

        monkeypatch.setattr(probe_module, "_scan_uncached", counting)
        _clear_cache()

        ids = ["git", "node", "npm"]
        with ThreadPoolExecutor(max_workers=callers) as pool:
            results = list(
                pool.map(lambda _: scan_environment(node_ids=ids, refresh=False), range(callers))
            )

        assert len(results) == callers
        baseline = {k: v.present for k, v in results[0].results.items()}
        for other in results[1:]:
            assert {k: v.present for k, v in other.results.items()} == baseline
        assert runs["n"] < callers, f"{runs['n']} scans ran for {callers} callers"

    def test_a_failing_scan_does_not_strand_its_followers(self, monkeypatch):
        """The leader raising must not leave waiters blocked forever."""
        attempts = {"n": 0}

        def sometimes_explodes(node_ids, refresh):
            attempts["n"] += 1
            time.sleep(0.2)
            raise RuntimeError("scan blew up")

        monkeypatch.setattr(probe_module, "_scan_uncached", sometimes_explodes)
        _clear_cache()

        errors: list[BaseException] = []

        def call():
            try:
                scan_environment(node_ids=["git"], refresh=False)
            except BaseException as exc:  # noqa: BLE001 - recording it is the point
                errors.append(exc)

        threads = [threading.Thread(target=call) for _ in range(6)]
        started = time.monotonic()
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)
        elapsed = time.monotonic() - started

        assert not any(t.is_alive() for t in threads), "a caller was left blocked"
        assert len(errors) == 6, "every caller should have been told it failed"
        assert elapsed < 25

    def test_the_inflight_registry_does_not_leak(self, monkeypatch):
        _clear_cache()
        for _ in range(3):
            scan_environment(node_ids=["git"], refresh=False)
        with probe_module._scan_lock:
            assert probe_module._scan_inflight == {}

    def test_different_scans_are_not_collapsed_into_each_other(self):
        """A filtered scan must not be served another scan's answer."""
        one = scan_environment(node_ids=["git"], refresh=False)
        two = scan_environment(node_ids=["node"], refresh=False)
        assert set(one.results) == {"git"}
        assert set(two.results) == {"node"}


# ── observability ───────────────────────────────────────────────────────


class TestObservability:
    def test_a_scan_emits_one_structured_non_secret_event(self, caplog, monkeypatch):
        monkeypatch.setenv("MY_API_KEY", "shhh-do-not-log-this-value")
        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            scan_environment(refresh=True)

        events = [r for r in caplog.records if getattr(r, "aura_event", "") == "environment.scan"]
        assert len(events) == 1
        event = events[0]
        for field in ("duration_ms", "catalog_probed", "found", "discovered", "verified", "executed"):
            assert isinstance(getattr(event, field), int)
        assert "shhh-do-not-log-this-value" not in caplog.text

    @POSIX_ONLY
    def test_a_refusal_is_logged_with_its_reason(self, tmp_path, caplog):
        from aura.environment.discovery import discover_tools

        wide_open = tmp_path / "open"
        wide_open.mkdir()
        script = wide_open / "tool"
        script.write_text("#!/bin/sh\necho 1.0.0\n")
        script.chmod(0o755)
        wide_open.chmod(0o777)

        with caplog.at_level(logging.INFO, logger=LOGGER_NAME):
            discover_tools(path=str(wide_open))

        refusals = [
            r for r in caplog.records if getattr(r, "aura_event", "") == "environment.refused"
        ]
        assert refusals, "a refusal to execute must be explainable from the log"
        assert refusals[0].reason

    def test_nothing_logged_carries_a_credential(self, caplog, monkeypatch):
        monkeypatch.setenv("DEPLOY_TOKEN", "tok-abcdefghijklmnopqrstuvwxyz")
        monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-secretsecretsecret")
        with caplog.at_level(logging.DEBUG, logger=LOGGER_NAME):
            scan_environment(refresh=True)
        assert "tok-abcdefghijklmnopqrstuvwxyz" not in caplog.text
        assert "sk-ant-secretsecretsecret" not in caplog.text


class TestRedaction:
    @pytest.mark.parametrize(
        "text",
        [
            "Authorization: Bearer ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "key=sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "AKIAIOSFODNN7EXAMPLE",
            "xoxb-1234567890-abcdefghij",
            "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
        ],
    )
    def test_credential_shapes_are_removed(self, text):
        assert "[redacted]" in redact(text)

    def test_environment_values_are_removed_even_with_unfamiliar_names(self, monkeypatch):
        monkeypatch.setenv("SOMETHING_NOBODY_ANTICIPATED_TOKEN", "value-worth-hiding-1234")
        assert "value-worth-hiding-1234" not in redact("saw value-worth-hiding-1234 here")

    def test_ordinary_text_is_untouched(self):
        text = "Found Git 2.45.1 at /usr/bin/git."
        assert redact(text) == text

    def test_short_values_are_not_blindly_substituted(self, monkeypatch):
        """A two-character 'secret' would otherwise mangle every message."""
        monkeypatch.setenv("MY_KEY", "ab")
        assert redact("a stable build") == "a stable build"

    def test_nested_payloads_are_redacted(self, monkeypatch):
        monkeypatch.setenv("NESTED_SECRET", "deep-value-abcdefgh")
        payload = {"a": ["deep-value-abcdefgh"], "b": {"c": "deep-value-abcdefgh"}, "n": 1}
        cleaned = redact_mapping(payload)
        assert cleaned["a"] == ["[redacted]"]
        assert cleaned["b"]["c"] == "[redacted]"
        assert cleaned["n"] == 1


class TestApiResponseSafety:
    def test_no_secret_reaches_the_serialised_payload(self, monkeypatch):
        monkeypatch.setenv("AURA_TEST_LEAK", "leak-me-abcdefghijklmnop")
        payload = json.dumps(scan_result_to_dict(scan_environment(refresh=True)))
        assert "leak-me-abcdefghijklmnop" not in payload

    def test_raw_process_output_is_never_returned(self):
        """Only parsed values leave the backend, never captured output."""
        payload = scan_result_to_dict(scan_environment(refresh=True))
        for result in payload["results"].values():
            assert "stdout" not in result
            assert "stderr" not in result
        for tool in payload.get("discovered", []):
            assert "stdout" not in tool
            assert "stderr" not in tool

    def test_the_payload_stays_a_reasonable_size(self):
        payload = json.dumps(scan_result_to_dict(scan_environment(refresh=True)))
        assert len(payload) < 1_000_000, f"{len(payload)} bytes"


# ── API surface ─────────────────────────────────────────────────────────


@pytest.fixture()
def client(tmp_path, monkeypatch):
    monkeypatch.setenv("AURA_HOME", str(tmp_path / "aura-home"))
    from starlette.testclient import TestClient

    from aura.api.server import create_app

    with TestClient(create_app()) as test_client:
        yield test_client


class TestApiResilience:
    @pytest.mark.parametrize(
        "body",
        [
            {"ids": ["git"]},
            {"ids": []},
            {"ids": ["../../etc/passwd"]},
            {"ids": ["x" * 5000]},
            {"ids": ["git", "git", "git"]},
            {"refresh": "yes"},
            {"refresh": None},
            {"unknown": "field"},
            {},
        ],
    )
    def test_scan_answers_every_shape_of_request(self, client, body):
        response = client.post("/environment/scan", json=body)
        assert response.status_code == 200
        assert "results" in response.json()

    @pytest.mark.parametrize(
        "raw",
        [b"", b"not json", b"[]", b"null", b"123", b'{"ids": {"a": 1}}', b"\x00\x01\x02"],
    )
    def test_scan_survives_malformed_bodies(self, client, raw):
        response = client.post(
            "/environment/scan", content=raw, headers={"content-type": "application/json"}
        )
        assert response.status_code == 200

    def test_an_unknown_id_is_answered_not_executed(self, client):
        payload = client.post("/environment/probe", json={"id": "; rm -rf /"}).json()
        assert payload["result"]["present"] is False
        assert payload["result"]["status"] == "unsupported"

    def test_an_extremely_long_id_is_rejected_calmly(self, client):
        payload = client.post("/environment/probe", json={"id": "a" * 100_000}).json()
        assert payload["result"]["present"] is False

    def test_concurrent_requests_all_answer(self, client):
        results: list[int] = []

        def call():
            results.append(client.post("/environment/scan", json={"ids": ["git"]}).status_code)

        threads = [threading.Thread(target=call) for _ in range(12)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=90)
        assert results.count(200) == 12

    @pytest.mark.parametrize(
        "body",
        [
            {"limit": -5},
            {"offset": "x"},
            {"limit": 10**9},
            {"offset": -1},
            {"offset": 10**12},
            # `value or []` leaves a non-list in place, and iterating it
            # turned a malformed request into a 500.
            {"kinds": 5},
            {"kinds": "application"},
            {"kinds": [1, 2]},
            {"kinds": {"a": 1}},
            {"query": 123},
            {"query": ["x"]},
            {"limit": None},
            {"refresh": "yes"},
            {"verify": 0},
            {},
        ],
    )
    def test_inventory_answers_every_shape_of_request(self, client, body):
        response = client.post("/environment/inventory", json={**body, "verify": False})
        assert response.status_code == 200
        payload = response.json()
        assert payload["returned"] <= payload["total"]

    @pytest.mark.parametrize(
        "raw", [b"", b"not json", b"[]", b"null", b"123", b'{"kinds":{"x":1}}', b"\x00\x01"]
    )
    def test_inventory_survives_malformed_bodies(self, client, raw):
        response = client.post(
            "/environment/inventory", content=raw, headers={"content-type": "application/json"}
        )
        assert response.status_code == 200

    def test_inventory_pagination_is_lossless_over_the_api(self, client):
        """Paging must reach every item exactly once."""
        seen: list[str] = []
        offset = 0
        while True:
            payload = client.post(
                "/environment/inventory",
                json={"offset": offset, "limit": 500, "verify": False},
            ).json()
            seen.extend(item["id"] for item in payload["items"])
            if not payload["truncated"]:
                assert len(seen) == payload["total"]
                break
            offset += payload["returned"]
        assert len(seen) == len(set(seen)), "an item was returned on two pages"

    def test_inventory_never_reports_something_it_did_not_run_as_verified(self, client):
        payload = client.post("/environment/inventory", json={"limit": 1000}).json()
        for entry in payload["items"]:
            assert entry["installed"] is True
            if entry["verified"]:
                assert entry["executionPerformed"] is True
                assert entry["executionAllowed"] is True

    def test_install_never_builds_a_command_from_the_request(self, client):
        """The body carries an id; the command comes from the catalog."""
        for hostile in ("git; rm -rf /", "$(whoami)", "../../bin/sh", "`id`"):
            response = client.post("/environment/install", json={"id": hostile})
            assert response.status_code == 400
            assert "catalog" in response.json()["detail"].lower()
