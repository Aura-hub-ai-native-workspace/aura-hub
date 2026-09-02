#!/usr/bin/env python3
"""Fixture OpenAI-compatible provider — a REAL HTTP server for E2E tests.

Speaks POST /chat/completions with scripted, per-prompt-substring replies.
This exercises the entire wire path of RoutedModelPort (real HTTP, real
JSON, real status codes) without pretending an external LLM was involved.
Failure modes are scriptable: 429 rate limit, 500, malformed body, timeout.
"""

from __future__ import annotations

import json
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# (substring, reply-content) — matched against the LAST user message.
REPLIES: list[tuple[str, str]] = []
FAILURES: dict[str, int] = {}  # substring → status code to return
REQUESTS: list[dict] = []


def content_for(user_text: str) -> str:
    for needle, content in REPLIES:
        if needle.lower() in user_text.lower():
            return content
    return json.dumps({"goal": user_text[:60], "expectedOutcome": "done",
                       "ambiguity": "clear", "confidence": 0.9})


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def do_POST(self):
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw)
        except json.JSONDecodeError:
            self.send_response(400)
            self.end_headers()
            return
        REQUESTS.append(payload)
        messages = payload.get("messages") or []
        user_text = next((m.get("content", "") for m in reversed(messages)
                          if m.get("role") == "user"), "")
        for needle, remaining in FAILURES.items():
            if needle.lower() in user_text.lower() and remaining > 0:
                # Contract: 'times' failures precede success — the final one
                # answers 429 (rate limit), earlier ones answer 500.
                FAILURES[needle] = remaining - 1
                code = 429 if remaining == 1 else 500
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.end_headers()
                self.wfile.write(
                    b'{"error":{"message":"provider failure","type":"fixture"}}')
                return
        content = content_for(user_text)
        body = json.dumps({
            "id": "chatcmpl-fixture",
            "object": "chat.completion",
            "choices": [{"index": 0,
                         "message": {"role": "assistant", "content": content},
                         "finish_reason": "stop"}],
        }).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    port = int(sys.argv[1])
    spec = Path_spec()
    global REPLIES, FAILURES
    REPLIES = [(r["match"], r["content"]) for r in spec.get("replies", [])]
    FAILURES = {f["match"]: f["times"] for f in spec.get("failures", [])}
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    ready = {"port": port}
    # parent watches for this line
    print("PROVIDER_READY " + json.dumps(ready), flush=True)
    server.serve_forever()
    return 0


def Path_spec():
    import os

    path = os.environ.get("FIXTURE_SPEC", "")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


if __name__ == "__main__":
    raise SystemExit(main())
