"""Runtime verification — the ported Fabric driving REAL persisted state.

Proves, on disk, in one story:
  1. a gated invocation persists a PENDING approval the moment it is asked;
  2. no execution record exists for something that has not run;
  3. a human decision is audited immediately;
  4. a fresh process restores pending state + audit tail and can spend;
  5. single-use spend leaves the approvals file empty afterwards.
"""

from __future__ import annotations

import asyncio
import json

from aura.fabric import CapabilityFabric
from aura.jsonutil import read_json_file, read_jsonl


class Host:
    def permissions_for(self, _cap, _ctx):
        return {"read": True, "write": True, "execute": True, "autonomous": True}

    def node_available(self, _cap):
        return True

    async def request_approval(self, _request, _ctx):
        return False  # always park; decisions come from decide_approval()


class WriteExecutor:
    capabilityId = "filesystem.write"

    async def run(self, _inv):
        return {"ok": True, "detail": "wrote", "output": {"bytes": 2}}

    async def verify(self, _inv, _last):
        return {"passed": True, "kind": "read-back", "detail": "matches"}

def _build(home, events):
    f = CapabilityFabric(Host())
    # The person's own policy: medium-risk steps ask (AURA's defaults never
    # do). It is what makes the write park, so the persisted-approval story
    # across a restart is exercised.
    f.set_policy({"byRisk": {"medium": "ask-user"}})
    f.listen(events.append)
    f.register(WriteExecutor())

    ap_file = home / "fabric-approvals.json"
    au_file = home / "fabric-audit.jsonl"

    def a_load():
        raw = read_json_file(ap_file, [])
        return [r for r in raw if isinstance(r, dict) and r.get("state") == "pending"
                and r.get("items") and isinstance(r["items"][0].get("capabilityId"), str)]

    def a_save(reqs):
        import os
        ap_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = f"{ap_file}.{os.getpid()}.tmp"
        tmp_path = __import__("pathlib").Path(tmp)
        tmp_path.write_text(json.dumps(reqs, indent=2), encoding="utf-8")
        os.replace(tmp_path, ap_file)

    def au_load():
        return read_jsonl(au_file)

    def au_append(rec):
        au_file.parent.mkdir(parents=True, exist_ok=True)
        with open(au_file, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(rec) + "\n")

    f.attach_audit_store(au_load, au_append)
    return f


CTX = {"actor": {"kind": "agent", "id": "agent:workflow"}, "projectId": "p",
       "missionId": "m", "taskId": "t"}

