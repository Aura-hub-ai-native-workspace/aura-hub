# Reconciliation Matrix — Frontend Contracts → Canonical Python Routes

> Author: Agent 1 (backend/API closure). Target: `migration/python-backend`.
> Sources: `docs/FRONTEND_PYTHON_API_RECONCILIATION.md` (Agent 3), the actual
> frontend clients (`aiClient.ts`, `automationClient.ts`, `fabricClient.ts`,
> `centralAgentClient.ts`), and the canonical Python domain services.

Legend: EXISTS = route present and shape-compatible · FIX = route present,
shape/behavior corrected · NEW = route added, delegating to an existing
canonical service (thin transport only) · MISSING-CONTRACT = no legitimate
canonical backend implementation exists; reported, not faked.

## 1. centralAgentClient.ts (:4320 / `/agent-api` proxy)

| Request | Expected response | Python route before | Fix |
|---|---|---|---|
| GET /health | `{ok:true, service}` | rich object, no `ok` | FIX — add top-level `ok`, `service` |
| POST /agent/sessions `{message, projectId?, projectPath?}` | `{result: AgentResult, sessionId}` | absent | NEW — CentralAgent.submit |
| GET /agent/sessions/{id} | persisted AgentSession | absent | NEW — AgentSessionStore.load |
| POST …/message `{message, projectPath?}` | `{result}` | absent | NEW — CentralAgent.message |
| POST …/approve `{approvalId, granted, reason?}` | `{approval, result}`, 409 replay | absent | NEW — THE ledger decide + resume |
| POST …/resume | `{result}`, 400 not-parked, 403 grant | absent | NEW — CentralAgent.resume |
| POST …/cancel | `{cancelled}` | absent | NEW — CentralAgent.cancel |
| GET …/plan | reasoning-free PlanReview | absent | NEW — CentralAgent.review_plan |
| GET …/evidence | bundle flat or `{evidence:null}` | absent | NEW — session.lastResult.evidence |
| GET …/events | SSE tail-replay + live AgentEvents | absent | NEW — EventBus.subscribe_stream |

Domain owner: the already-implemented `aura.central_agent.CentralAgent`
service (committed on `feature/central-agent-canonical-integration` @
b4b42a8) is used VERBATIM; it is adapted to THIS branch's verified spine via
compat seams owned by this branch (`FabricConfig`/`invoke_fabric`/
`describe_authority` views over `CapabilityFabric`; a `WorkflowEngine`
facade over `WorkflowRunner`). No second fabric, runner, policy engine or
ledger is created. Agent intelligence itself is NOT modified.

## 2. fabricClient.ts (+ useFabric polling)

| Request | Expected response | Before | Fix |
|---|---|---|---|
| GET /fabric/approvals | `{approvals: ApprovalRequest[]}` | absent | NEW — ApprovalLedger.pending() |
| POST /fabric/approvals/{id}/decide `{granted, reason}` | `{approval}`, 409 replay | absent | NEW — ledger.decide (single-use, audited) |
| POST /fabric/invoke `{capabilityId, input, context}` | InvocationResultView | absent | NEW — CapabilityFabric.invoke (THE path) |
| GET /fabric/capabilities | CapabilityCatalogue `{capabilities(+supported), supportedCount, providedNodeCapabilities, policy}` | bare list | FIX — full catalogue shape |
| GET /fabric/policy | `{policy}` wrapper | raw file object | FIX — wrap |
| POST /fabric/policy patch | `{policy, file}` | absent | NEW — persists through canonical policy file |
| GET /fabric/audit | `{audit: [...]}` | absent | NEW — AuditStore.load() |
| GET /fabric/mission/{pid}/{mid} | MissionCapabilityAnnotation | absent | **MISSING-CONTRACT** (see §8) |

## 3. aiClient.ts — workflow/editor surface

| Request | Before | Fix |
|---|---|---|
| GET /workflows | bare list | FIX — `{workflows:[…]}` |
| PATCH /workflows/{id} | absent | NEW — partial save (name/favorite/category/description) |
| POST /workflows/{id}/duplicate | absent | NEW — store copy under new id |
| POST /workflows/import `{def}` | absent | NEW — validated store.create |
| POST /workflows/generate `{text}` | absent | honest 501 `{error}` — needs live LLM provider; no fake authoring |
| GET /workflows/specs | absent | NEW — specs from THIS backend's node registry (metadata only) |
| GET /workflows/templates | absent | NEW — templates composed ONLY of node types this backend executes |
| GET /workflows/{id}/envelope | absent | NEW — envelope port + diff vs previous version |
| GET /workflows/{id}/validate | absent | NEW — schema/graph/secrets findings + envelope |
| GET /workflows/{id}/versions | bare list | FIX — `{versions:[…]}` |
| GET /workflows/{id}/versions/{vid} | absent | NEW |
| POST /workflows/{id}/versions `{note}` | absent | NEW — publish current as new version |
| POST …/versions/{vid}/restore | absent | NEW — restoring publishes a new version |
| POST /workflows/{id}/run | JSON (wrong) | FIX — SSE stream (start/node/log/output/agent/done frames) |
| POST /workflows/{id}/runs/{rid}/resume | absent | NEW — same stream shape |
| GET /workflows/{id}/runs | absent | NEW — `{runs:[summaries]}` |
| GET /workflows/{id}/runs/{rid} | absent | NEW — full run record |
| POST …/runs/{rid}/cancel | absent | NEW — runner.cancel_workflow_run |
| GET …/runs/{rid}/chain | absent | NEW — resume chain old→new |
| POST /workflows/{id}/webhook-token | absent | NEW — token persisted per workflow |
| GET /workflow-runs?page… | absent | NEW — paged index `{runs,total,offset,limit}` |
| GET /workflow-runs/stats | absent | NEW — counts by state |
| GET /workflow-runs/awaiting | absent | NEW — excludes superseded legs |
| GET /workflow-runs/{rid} | absent | NEW — find across workflows |
| GET /agent/bounds | absent | NEW — AGENT_DEFAULTS/AGENT_CEILINGS |
| GET /agent/tools?workflowId&requested | absent | NEW — resolve_tools against envelope |

Legacy ai-service surfaces deliberately NOT required by the reconciliation
(conversations, memory, graph, providers, retrieve, settings, missions CRUD,
code-action): out of scope for this closure; several belong to the diagnosis
sidecar decision. Not implemented, not faked.

## 4. automationClient.ts

| Request | Before | Fix |
|---|---|---|
| GET /automation/rules | bare list | FIX — `{rules:[…]}` |
| GET /automation/rules/{id} | absent | NEW |
| POST /automation/rules | absent | NEW — store.create_rule (sanitized) |
| PUT/PATCH /automation/rules/{id} | absent | NEW — store.save_rule |
| DELETE /automation/rules/{id} | absent | NEW |
| POST /automation/validate | absent | NEW — same sanitizer, issues list |
| POST /automation/rules/{id}/run | absent | NEW — engine handle_event (conditions still gate) |
| POST …/pause, …/resume | absent | NEW — AutomationEngine.pause/resume_rule |
| GET /automation/rules/{id}/runs | absent | NEW |
| GET /automation/rules/{rid}/runs/{runId} | absent | NEW |
| POST …/runs/{runId}/cancel | absent | NEW — engine.cancel_run |
| POST /automation/rules/{id}/dry-run | absent | NEW — zero-side-effect report |
| GET /automation/runs?query | exists, wrong shape | FIX — `{runs,total,offset,limit}` paging |
| GET /automation/schedules | absent | NEW — scheduler state per rule |
| GET /automation/templates | absent | NEW — static template infos |
| GET /automation/events/stream | absent | NEW — SSE of engine events |
| stats/reindex | absent | NEW — index counts / rebuild |

Every execution converges: automation → WorkflowService(runner facade) →
WorkflowRunner → Fabric → policy → approval → executor → verification → audit.

## 5. CORS (verified defect)

`allow_origins=["http://localhost:*",…]` is literal-matched by Starlette →
OPTIONS from http://localhost:1420 returned 400 "Disallowed CORS origin".
FIX: `allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1)(:\d+)?$"` plus
exact `tauri://localhost` and `https?://tauri.localhost` entries.

## 6. Real workflow SSE (§2f)

`GET /events/workflow` was a placeholder frame. FIX: in-memory ring buffer
per run fed by the runner's emit callback; stream replays the tail and
follows live; `Last-Event-ID` resumes after the buffered point.

## 7. Engine seam closed

`engine.py` refused `type:"agent"` nodes ("lands in Phase 8"). The Phase-8/9
runtime exists and is differential-tested; the governed branch now delegates
to the injected `AgentRunner` (same object `WorkflowRunner._agent_runner`
already builds). One execution path; no new runtime.

## 8. MISSING CANONICAL BACKEND CONTRACT (reported, not faked)

`GET /fabric/mission/{projectId}/{missionId}` — requires a stored MissionRecord +
plan (mission subsystem). No canonical Python mission store exists in this
tree; porting one is not part of the frozen migration scope and is not owned
by the API layer. Route returns 501 with exactly this explanation until a
domain owner lands the mission subsystem.
