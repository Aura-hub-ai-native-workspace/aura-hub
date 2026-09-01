"""Real-provider harness — spawns the fixture OpenAI-compatible server and
wires RoutedModelPort to it over actual HTTP.

This is the honest form of "real model path" verification available here:
a genuine HTTP provider process, real wire failures, real JSON parsing.
No claim is made that an external LLM was consulted.
"""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[1] / "providers" / "fixture_openai.py"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class FixtureProvider:
    def __init__(self, replies: list[dict], failures: list[dict] | None = None):
        self.port = _free_port()
        self._tmp = tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8")
        json.dump({"replies": replies, "failures": failures or []}, self._tmp)
        self._tmp.close()
        self.proc: subprocess.Popen | None = None

    def start(self) -> str:
        env = dict(os.environ, FIXTURE_SPEC=self._tmp.name)
        self.proc = subprocess.Popen(
            [sys.executable, str(FIXTURE), str(self.port)], env=env,
            stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
        deadline = time.time() + 10
        while time.time() < deadline:
            line = self.proc.stdout.readline() if self.proc.stdout else ""
            if line.startswith("PROVIDER_READY"):
                break
            time.sleep(0.05)
        base = f"http://127.0.0.1:{self.port}/v1"
        # readiness probe over the real wire
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                urllib.request.urlopen(base + "/chat/completions", data=b"{}",
                                       timeout=1)
            except Exception:
                pass
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{self.port}/",
                                            timeout=1):
                    pass
                break
            except Exception:
                continue
        return base

    def stop(self) -> None:
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except Exception:
                self.proc.kill()
            Path(self._tmp.name).unlink(missing_ok=True)


def routed_port(replies: list[dict], failures: list[dict] | None = None,
                api_key_env: str = "AURA_TEST_PROVIDER_KEY"):
    from aura.central_agent.model_routing import ProviderSpec, RoutedModelPort

    harness = FixtureProvider(replies, failures)
    base = harness.start()
    os.environ.setdefault(api_key_env, "test-key-not-a-secret")
    spec = ProviderSpec(id="fixture", base_url=base, model="fixture-model",
                        api_key_env=api_key_env, max_retries=1,
                        timeout_s=10)
    port = RoutedModelPort([spec])
    return port, harness
