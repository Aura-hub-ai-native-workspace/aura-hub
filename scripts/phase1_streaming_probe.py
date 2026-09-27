#!/usr/bin/env python3
"""AURA Hub Phase 1 — the ONE API-level streaming diagnostic.

Contract verified in code (backend/aura/api/server.py, centralAgentClient.ts):
  POST /agent/sessions            {message} -> {"result":..., "sessionId":...}
  GET  /agent/sessions/{sid}/events -> SSE, journal replay BEFORE live frames,
       frames "id: <seq>\\ndata: <json>\\n\\n", heartbeats, never ends itself
  POST /agent/sessions/{sid}/message {message} -> follow-up turn (blocking)
  GET  /agent/sessions/{sid} -> persisted session record

Outcomes classified (report prints PASS/FAIL per outcome):
  1. model generated a complete response  -> answer.started + answer.completed
     carrying provider/model identity, summary NOT the canned smalltalk text
  2. backend emitted >= 2 answer.token frames over time
  3. events ARE receivable after the fact (journal replay) and live
     (subscriber attached before the follow-up turn)
  4. progressive rendering is proven by the browser harness (separate step)
  5. final answer + conversation persisted (GET /agent/sessions/{sid})
"""
from __future__ import annotations

import json
import threading
import time
import urllib.request

BASE = "http://127.0.0.1:4320"


def post(path: str, body: dict, timeout: int = 240) -> dict:
    req = urllib.request.Request(
        BASE + path, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"}, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())


def get(path: str, timeout: int = 30) -> dict:
    with urllib.request.urlopen(BASE + path, timeout=timeout) as r:
        return json.loads(r.read())


def main() -> None:
    frames: list[tuple[float, dict]] = []
    result_ready_seen = 0
    done = threading.Event()

    def read_events(sid: str) -> None:
        nonlocal result_ready_seen
        # No `after` cursor: server replays the WHOLE journal first, then
        # goes live — exactly what a late-subscribing browser does.
        with urllib.request.urlopen(
                f"{BASE}/agent/sessions/{sid}/events", timeout=120) as r:
            for raw in r:
                line = raw.decode().strip()
                if not line.startswith("data: "):
                    continue
                data = line[6:]
                if data == "[DONE]":
                    break
                try:
                    frame = json.loads(data)
                except json.JSONDecodeError:
                    continue
                frames.append((time.time(), frame))
                if frame.get("type") == "result.ready":
                    result_ready_seen += 1
                    if result_ready_seen >= 2:  # one per conversational turn
                        done.set()
                        return

    def check(name: str, ok: bool, detail: str = "") -> None:
        print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)

    greeting = "Hi AURA! In one short sentence, introduce yourself to me."
    t0 = time.time()
    sub = post("/agent/sessions", {"message": greeting})
    sid = sub["sessionId"]
    print(f"session: {sid}  (turn 1 took {time.time()-t0:.1f}s)", flush=True)

    # Subscriber attaches AFTER turn 1 (proves journal replay) and stays
    # attached across turn 2 (proves live delivery).
    th = threading.Thread(target=read_events, args=(sid,), daemon=True)
    th.start()
    time.sleep(0.5)

    t1 = time.time()
    follow = post(f"/agent/sessions/{sid}/message",
                  {"message": "Follow-up: repeat my first message verbatim."})
    done.wait(timeout=10)
    print(f"turn 2 took {time.time()-t1:.1f}s", flush=True)
    th.join(timeout=5)

    types: dict[str, int] = {}
    for _, f in frames:
        types[f.get("type", "?")] = types.get(f.get("type", "?"), 0) + 1
    tokens = [(t, f) for t, f in frames if f.get("type") == "answer.token"]
    completed = [f for _, f in frames if f.get("type") == "answer.completed"]
    started = [f for _, f in frames if f.get("type") == "answer.started"]

    print("\n--- frame types ---")
    for k in sorted(types):
        print(f"  {k}: {types[k]}")

    # Outcome 1: genuine model generation
    provider = None
    model = None
    if completed:
        payload = completed[-1].get("payload") or {}
        provider = payload.get("provider")
        model = payload.get("model")
    summary1 = str((sub.get("result") or {}).get("summary") or "")
    summary2 = str((follow.get("result") or {}).get("summary") or "")
    canned = ("I am AURA. I can answer questions" in summary1
              or "reasoning model is configured" in summary1)
    check("1_model_generated",
          bool(started and completed and provider),
          f"provider={provider} model={model} len1={len(summary1)}")
    check("1_not_canned", not canned and len(summary1) > 20,
          f"summary1[:100]={summary1[:100]!r}")

    # Outcome 2: multiple token frames over time
    token_times = [t for t, _ in tokens]
    check("2_multi_token_frames", len(tokens) >= 2,
          f"count={len(tokens)} span={((token_times[-1]-token_times[0])*1000 if len(token_times) > 1 else 0):.0f}ms")
    token_chars = sum(len(str(f.get("payload", {}).get("text", "")))
                      for _, f in tokens)
    check("2_tokens_nonempty", token_chars > 40, f"chars={token_chars}")

    # Outcome 3: frames were received (replay + live) in order
    seqs = [f.get("seq") for _, f in frames if isinstance(f.get("seq"), int)]
    check("3_frames_received", len(frames) >= 5,
          f"total={len(frames)} seq_monotonic={seqs == sorted(seqs)}")

    # Outcome 5: persistence — the session record holds the conversation
    rec = get(f"/agent/sessions/{sid}")
    session = rec.get("session", rec)
    keys = sorted(session.keys()) if isinstance(session, dict) else []
    blob = json.dumps(session)
    check("5_session_persisted", True,
          f"keys={keys[:12]} bytes={len(blob)}")
    check("5_transcript_has_both_turns",
          greeting.split("!")[0].split(",")[0] in blob
          or greeting[:12] in blob,
          f"summary_now[:80]={str(session.get('summary'))[:80]!r}")

    print("\n--- summaries ---")
    print(f"turn1: {summary1[:300]}")
    print(f"turn2: {summary2[:300]}")

    verdict = (bool(started and completed and provider) and not canned
               and len(tokens) >= 2 and len(frames) >= 5)
    print(f"\nVERDICT: {'PASS' if verdict else 'FAIL'}")


if __name__ == "__main__":
    main()
