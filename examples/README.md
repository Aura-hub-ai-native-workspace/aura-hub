# Examples

Real, runnable AURA Hub workflows — not illustrative snippets. Every
file in [`workflows/`](workflows/) is a direct JSON export of the
starter templates shipped in the product itself
(`packages/ai-service/src/workflow/templates.ts`), generated straight
from that source so they can never drift out of sync with what the app
actually ships.

These are the same templates that appear in the app's **Automation
Studio → Workflow Library** — this folder exists so you can read a real
workflow's shape without opening the app, and so you can import one
directly via the API.

## What a workflow is

A workflow is a directed graph of nodes. Each node is one of a fixed set
of real operations — pull real project context, run one of the frozen
Knowledge Engines, generate text/code/JSON through the active AI
provider, branch on a condition, or take a real action (save memory,
write a file, run a shell command, call an HTTP endpoint). Nothing is
simulated: instantiating any template below gives you a graph that
executes for real against whichever project is open.

## The catalog

| Template | Category | What it does |
|---|---|---|
| [`architecture-review`](workflows/architecture-review.json) | Review | Profiles the project, pulls the system graph and key code, writes a structured architecture review into memory. |
| [`code-review`](workflows/code-review.json) | Review | Reviews the real uncommitted diff with related code context. |
| [`security-audit`](workflows/security-audit.json) | Review | Audits auth, secrets, and input handling; critical findings are saved to memory. |
| [`bug-investigation`](workflows/bug-investigation.json) | Debug | Describe a bug; the engines gather suspect code and system paths, the AI proposes ranked root causes. |
| [`refactor-module`](workflows/refactor-module.json) | Engineering | Name a module; get a refactor plan with concrete code from its real source. |
| [`generate-unit-tests`](workflows/generate-unit-tests.json) | Engineering | Generates unit tests for a module from its real source code. |
| [`dependency-analysis`](workflows/dependency-analysis.json) | Engineering | Reads the real manifest and produces a structured JSON risk assessment per dependency. |
| [`generate-documentation`](workflows/generate-documentation.json) | Docs | Generates developer documentation from the project profile and code. |
| [`explain-project`](workflows/explain-project.json) | Docs | The canonical chain: Project → Memory → Coding Engine → FullStack Engine → AI → saved answer. |
| [`release-notes`](workflows/release-notes.json) | Docs | Turns real recent git history into human-readable release notes. |

## Using these with Qwen (or any provider)

Every template's AI node runs against whichever provider is currently
active in **AI Settings** — connect and activate Qwen there and every
template above becomes a Qwen-powered workflow with zero edits to the
JSON. (The AI node's internal type is historically named `groq`, from
when Groq was the first provider wired up — it is not Groq-specific; it
calls the shared `pipeline.generate()` seam like every other AI surface
in the app. See [`packages/ai-service/src/workflow/nodes.ts`](../packages/ai-service/src/workflow/nodes.ts).)

## Using an example

**In the app:** open **Automation Studio → Workflow Library** — every
template above is already there, one click to instantiate onto the
canvas.

**Via the API:** each JSON file is a valid `POST /workflows/import`
body (see `packages/ai-service/src/server.ts`):

```bash
curl -X POST http://127.0.0.1:4319/workflows/import \
  -H 'content-type: application/json' \
  -d @examples/workflows/architecture-review.json
```

## Reading the node graph

Every node has an `id`, a `type` (one of the real node types in
`packages/ai-service/src/workflow/types.ts`), a canvas position
(`x`/`y`), and a `config` object matching that node type's fields.
Edges connect a source node's output port (`fromPort`, usually `"out"`)
to a target node's input. See
[`docs/architecture/AUTOMATION_ENGINE.md`](../docs/architecture/AUTOMATION_ENGINE.md)
for the full node/execution model.
