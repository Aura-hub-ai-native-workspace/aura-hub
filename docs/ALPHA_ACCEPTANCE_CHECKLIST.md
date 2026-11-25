# AURA Hub — Alpha Acceptance Checklist

**Approved by the owner 2026-11-25** (six sections; evidence-based statuses;
untested items stay untested; security failures block alpha). Phase 1 exit gate of the Master
Execution Roadmap. AURA Hub is "alpha" only when every **required** item
below is marked PASS **with evidence** (a CI run link, a command log, a
screenshot or recording, or an issue number). An item without evidence is
not PASS, whatever the code suggests.

Status values: **PASS** · **FAIL** · **NOT RUN** · **BLOCKED** (needs
something outside the team's control) · **WAIVED** (owner decision,
recorded with a reason).

Target build: the first tagged release after PR #106 is resolved.

---

## A. Build and release integrity (required)

| # | Check | How to verify | Status | Evidence |
|---|---|---|---|---|
| A1 | `main` CI green on Linux, Windows, macOS | CI run on the release commit: typecheck + unit tests, backend pytest ×3 OS, desktop packaging ×4 targets | NOT RUN | |
| A2 | Merge gate enforces A1 | Branch protection on `main` requires Typecheck & Build, Backend tests ×3 OS and Desktop packaging ×4 targets | **PASS with limitation** — `enforce_admins` is off, so repository admins can still bypass the checks | 2026-11-25: protection API lists 8 required checks (app 15368); `gh pr checks 106 --required` lists all 8; PR #106 merge state `BLOCKED` |
| A3 | Release assets complete and signed for the updater | Linux AppImage/deb/tar.gz, macOS arm64+x64 dmg, Windows exe, each with `.sig`; `latest.json` valid (`scripts/release-verify.mjs`) | PASS for v0.1.27 (re-run for the alpha tag) | `gh release view v0.1.27` |
| A4 | No uncommitted or unreviewed product code on `main` | `git status` clean of source changes; all work arrived via PR | NOT RUN (PR #106 open) | |
| A5 | Full local suites pass on the release commit | `npm run typecheck`, `test:front`, `test:service`, `test:agents`, `pytest backend/tests` | PASS on PR #106 tip (Linux) | `docs/EXECUTION_LOG.md` 2026-11-25 |

## B. Install and first run — per OS (required, hands-on)

Run on a clean user account for each of: **Linux x64**, **Windows x64**, **macOS arm64** (macOS x64 desirable).

| # | Check | Linux | Windows | macOS |
|---|---|---|---|---|
| B1 | Installer runs; app launches without a terminal | NOT RUN | NOT RUN | NOT RUN |
| B2 | Bundled services start (AI service + Python API); failure shows a readable reason, not a blank window | NOT RUN | NOT RUN | NOT RUN |
| B3 | Sign-in stays inside the hub (Google may open the browser once) | NOT RUN | NOT RUN | NOT RUN |
| B4 | Connect one provider (BYOK or Ollama); model choice survives reconnect | NOT RUN | NOT RUN | NOT RUN |
| B5 | Quit the app: no orphan processes remain (`process-containment-verify` + manual check) | PASS (`PHASE1_HANDOFF.md`) | **NOT VERIFIED** | **NOT VERIFIED** |
| B6 | Updater detects and applies a newer build | NOT RUN | NOT RUN | NOT RUN |

## C. Workspace execution (required)

| # | Check | How to verify | Status |
|---|---|---|---|
| C1 | Read-only request runs and answers with real output ("Show me the git status", "List the files") | Workspace run; answer contains tool output, not advice to run it yourself | NOT RUN |
| C2 | Edit task completes and is verified (file change appears in the run observer and on disk) | Workspace run on a scratch repo | NOT RUN |
| C3 | Delegated coding-agent task (OpenCode or Kilo) runs and reports `contextMcp` honestly | Run observer + execution report | NOT RUN |
| C4 | Policy denial affects only the denied task; independent tasks still complete; summary says "partially completed" | Covered by unit tests in PR #106; needs one real run | NOT RUN |
| C5 | Failed task recovers on a permitted alternative, or says plainly that none exists | Run observer "recoveries" list | NOT RUN |
| C6 | STOP cancels a running mission within seconds; no worker keeps running | Manual + `process-containment-verify` | NOT RUN |
| C7 | `kill -9` of the service mid-mission: decisions and outcomes still on disk; tampering detectable | `audit-journal-verify` | PASS on Linux (`PHASE1_HANDOFF.md`) |
| C8 | A finished run never stays shown as "running" after restart | Restart during and after a run | NOT RUN |

## D. Agent sessions and coordination (required)

| # | Check | Status |
|---|---|---|
| D1 | Agent setup screen states only what was verified (configured vs verified vs executable) | Implemented in PR #106; NOT RUN on a real install |
| D2 | Shared context written by one agent is visible to the next in the same project | NOT RUN (`scripts/agents/cross-agent-context-acceptance.mjs`) |
| D3 | Specialists roster shows real runtime availability | Implemented in PR #106; NOT RUN |

## E. Security boundaries (required)

| # | Check | Status |
|---|---|---|
| E1 | Verified Relay Round 3.1 items C1–C8 fixed. **Blocks alpha** (owner decision 2026-11-25: security failures block alpha) | **FAIL** — audits NEEDS REVISION, not implemented (#107) |
| E2 | Prompt redaction, SSRF guard, approval binding suites pass (`prompt-redaction-verify`, `ssrf-guard-verify`, `approval-binding-verify`) | NOT RUN for this build |
| E3 | Data folder private; crash records scrubbed (v0.1.27 fix) | NOT RUN for this build |

## F. Desirable (not alpha-blocking)

- F1 Automated GUI journeys for C1–C3 (today manual; finding F-08).
- F2 One merged audit view across `~/.aura/audit/trail.jsonl` and `~/.aura/fabric-audit.jsonl` (finding F-05).
- F3 Repository hygiene: scratch files out of the repo root; `graphify-out/` no longer tracked (finding F-11).

---

## Sign-off

| Role | Name | Date | Decision |
|---|---|---|---|
| Owner | | | |
