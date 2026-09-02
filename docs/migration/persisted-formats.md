# Persisted formats — everything under `~/.aura` (`AURA_HOME`-overridable)

Verified against live disk state on 2026-08-24 and the sources cited. Layout below is
the real tree, annotated with which subsystem writes it and where its schema lives.

---

## 1. Store map

| Path | Writer (source) | Schema | Golden |
| --- | --- | --- | --- |
| `config.json` | settings.ts | deferred (Phase 1) | — |
| `projects.json` | projects.ts / persist.ts | deferred (Phase 2) | — |
| `providers.json` | provider/credentialStore.ts:8–24 | ✅ providers-store.schema.json | golden/providers-store.json |
| `sessions.json`, `memory.json`, `habits.json`, `actions.log` | conversations/memory/habit writers | deferred | — |
| `fabric-policy.json` | fabric/policyStore.ts:16–33 | ✅ policy-config.schema.json | golden/fabric-policy.json |
| `fabric-approvals.json` | fabric/approvalStore.ts:21–43 | ✅ approval-request.schema.json (array) | golden/fabric-approvals.json |
| `fabric-audit.jsonl` | fabric/auditStore.ts:20–96 | ✅ audit-record.schema.json (JSONL) | golden/fabric-audit.jsonl |
| `workflows/<wfId>.json` | workflow/store.ts:15–20 | ✅ workflow.schema.json | golden/workflows/wf-demo.json |
| `workflow-versions/<wfId>/<verId>.json` | workflow/versions.ts:38–40,157 | ✅ workflow-version.schema.json | golden/workflow-versions/… |
| `workflow-runs/<wfId>/<runId>.json` | workflow/run/store.ts:62–79,135 | ✅ workflow-run.schema.json | golden/workflow-runs/… |
| `workflow-runs/index.json` | workflow/run/store.ts:62,152 | summary entries, cap 5000 | (covered by run summaries) |
| `automation/rules/<ruleId>.json` | automation/persist.ts + store.ts | ✅ automation-rule.schema.json | golden/automation/rules/… |
| `automation/runs/<runId>.json` | automation store | ✅ automation-run.schema.json | golden/automation/runs/… |
| `automation/runs-index.json` | automation store | summaries index | — |
| `automation/schedule-state.json` | automation/scheduler.ts | ✅ schedule-state.schema.json | golden/automation/schedule-state.json |
| `identity/<pid>.json`, `missions/…`, `diagnosis/…`, `index/…`, `conversations/…`, memory/engineering-memory/glossary/personality/health/repo-profile/workspace dirs | intelligence + satellites | **deferred per D2/D1** (frozen when each port begins) | — |

## 2. Byte-level write semantics (all JSON stores)

From `packages/ai-service/src/persist.ts:40–46` (identical copy in
`packages/automation/src/persist.ts:30–36`):

```
write file `${path}.${pid}.tmp` with JSON.stringify(value, null, 2)   # pretty, 2-space
rename tmp → path                                                      # atomic on POSIX
```

- Pretty-printed, 2-space indent; **no trailing newline**.
- Reads tolerate missing/corrupt → fallback value (persist.ts:32–38).
- Audit JSONL is the exception: raw `JSON.stringify(record)` per line + `\n`,
  append-only (auditStore.ts:78).

Python round-trip requirement: emit `json.dumps(obj, indent=2)` with Node-compatible
spacing (Python's indent=2 matches), no trailing newline for JSON stores, `\n`
terminators for JSONL.

## 3. Crypto envelope — `providers.json`

Source: `packages/ai-service/src/provider/credentialStore.ts`.

```jsonc
{
  "secret": "<64 hex chars, random 32 bytes, generated once>",
  "credentials": {
    "<provider>": {
      "encryptedKey": "<hex ciphertext>",
      "iv":  "<hex, 16 random bytes>",
      "tag": "<hex GCM tag>",
      "fingerprint": "<display fingerprint>"
    }
  },
  "models": {}, "health": {},
  "active": null,
  "activeModel": ""
}
```

- Algorithm `aes-256-gcm`; key = `sha256(seed + ':aura-provider-v2')`.
- Seed resolution order (credentialStore.ts:24–34):
  1. env `AURA_PROVIDER_SECRET` (then `store.secret` unused),
  2. else stored `store.secret`, generated as 32 random bytes hex on first write.
- Python MUST read existing stores: `cryptography.hazmat AESGCM` with a zero AAD
  (Node cipheriv without AAD), 16-byte IV, appended-or-detached tag as stored.
  Getting this wrong forces every user to reconnect keys once.

## 4. Bounds constants that shape files

Already normative in invariants.md §5–6; repeated because they cap file growth:
`MAX_CHECKPOINT_TEXT=65536` · `MAX_TRANSITIONS=60` · `MAX_RUN_LOG=2000` ·
`MAX_BEATS=500` · `MAX_BEAT_TEXT=4000` · `MAX_TRANSCRIPT_ENTRIES=40` ·
runs-per-workflow `200` · audit `5000` records (trim at `6000`).

## 5. Validation of this directory

```bash
python3 - <<'EOF'
import json, pathlib
root = pathlib.Path('docs/migration')
for p in sorted(root.rglob('*.json')):
    json.loads(p.read_text())
print('all JSON parse OK')
EOF
```

Schema-vs-golden validation additionally requires `jsonschema` (not installed here);
the check runs in CI-style parity harnesses from Phase 1 onward.

## 6. Golden fixtures — provenance rules

All files under `golden/` are SYNTHETIC. They mirror real shapes observed on disk
(structure verified programmatically against live stores) but contain invented ids,
paths and content. No real user data, no real secrets; `providers-store.json` carries
obviously-fake hex. Never copy live `~/.aura` files into this directory.
