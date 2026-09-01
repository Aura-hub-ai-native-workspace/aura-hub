# Canonicalization spec — fingerprints and graph hashes, to the byte

Two digests are load-bearing across a language boundary. Both are `sha256` over an
exact string, truncated to the first **32 hex characters**. Any divergence breaks
approval binding (security) or versioning identity (correctness). This document pins
the algorithms exactly as TypeScript implements them at `141d101`.

---

## 1. `fingerprintInvocation`

Source: `packages/capability-fabric/src/fabric.ts:122–138` (verbatim semantics).

```ts
fingerprintInvocation(capabilityId, input, context) =
  sha256( JSON.stringify({
    capabilityId,
    input: Object.fromEntries(Object.entries(input).sort(([a],[b]) => a.localeCompare(b))),
    projectId:      context.projectId      ?? null,
    cwd:            context.cwd            ?? null,
    workflowId:     context.workflowId     ?? null,
    workflowNodeId: context.workflowNodeId ?? null,
  })).hex.slice(0, 32)
```

### Rules

1. **Object key order of the outer literal is fixed**: `capabilityId, input,
   projectId, cwd, workflowId, workflowNodeId`. JSON.stringify emits insertion
   order; Python must emit the same order.
2. **Only the TOP level of `input` is sorted.** Nested objects/arrays inside input
   values keep their original insertion order (`JSON.stringify` does not sort).
   A Python port that recursively sorts will produce different digests for inputs
   with nested objects.
3. **Undefined vs null**: absent context fields become JSON `null`
   (`context.projectId ?? null`). Absent input keys simply don't appear in `input`.
4. **No whitespace**: `JSON.stringify(x)` default — no spaces, `","`/`":"`
   separators. Python: `json.dumps(obj, separators=(',', ':'), ensure_ascii=False)`
   …with the escaping caveat in §3.
5. Truncate digest to 32 hex chars (128 bits). Comparisons are exact-string.

### 1.1 The collation trap (read this twice)

The comparator is JavaScript's `Array.prototype.sort` default augmented with
`a.localeCompare(b)` — **ICU root collation**, which is case-insensitive-ish at base
letter strength and NOT code-point order:

| Keys | Node `localeCompare` order | Python `sorted()` (code points) |
| --- | --- | --- |
| `"a"`, `"B"` | `a`, `B` (a before B) | `B`, `a` |
| `"filePath"`, `"Folder"` | case-merged then tie-broken by case | uppercase-first |

Python's built-in `sorted()` **will not match** for mixed-case key names. Required
behavior for the Python port, in order of preference:

1. Implement a JS-compatible comparator (ICU primary-strength comparison with
   deterministic case tie-break) and prove it against the vectors below.
2. If ICU parity is unavailable in the target runtime, restrict fingerprinted input
   keys to the existing capability field vocabulary (all lowerCamel, ASCII, lowercase
   first letter) AND add a differential test that fails loudly on any new mixed-case
   key entering a fingerprinted input.

Current manifest fields are all lowerCamel ASCII starting lowercase, so real traffic
is currently in the safe subset — but agent-delegate `input.context` nests arbitrary
objects, and nested keys do not participate in sorting (rule 2), which is what keeps
today's traffic safe.

### 1.2 Pinned parity vectors

Computed with the real TypeScript implementation (node, revision `141d101`) — never
regenerate from any other implementation:

```
V1:
  capabilityId = "filesystem.write"
  input        = {"path":"src/a.ts","content":"hi"}
  context      = {projectId:"p1", cwd:"/tmp/p", workflowId:null, workflowNodeId:"n1"}
→ SEE vectors.json (generated + verified during artifact validation)

V2 (key-order independence):
  same call, input presented as {"content":"hi","path":"src/a.ts"} → SAME digest as V1

V3 (nested order sensitivity):
  input = {"path":"x","opts":{"b":1,"a":2}}  vs  {"path":"x","opts":{"a":2,"b":1}}
  → DIFFERENT digests (nested objects are NOT canonicalized)

V4 (mixed-case top-level keys — the collation trap):
  input = {"Path":"x","alpha":"y"} → digest uses localeCompare order [alpha, Path]
```

[`canonicalization-vectors.json`](./canonicalization-vectors.json) holds the concrete
digests. They were produced by the TypeScript functions themselves; treat them as
read-only ground truth and assert against them in every parity harness.

## 2. `graphHash` (workflow versions)

Source: `packages/ai-service/src/workflow/versions.ts:95–113`.

```ts
hashGraph(nodes, edges) =
  sha256( JSON.stringify({
    nodes: [...nodes]
      .sort((a,b) => a.id.localeCompare(b.id))
      .map(n => ({ id: n.id, type: n.type,
                   config: Object.fromEntries(Object.entries(n.config ?? {}).sort(([a],[b]) => a.localeCompare(b))) })),
    edges: [...edges]
      .map(e => ({ from: e.from, fromPort: e.fromPort, to: e.to }))
      .sort((A,B) => `${A.from}${A.fromPort}${A.to}`.localeCompare(`${B.from}${B.fromPort}${B.to}`)),
  })).hex.slice(0, 32)
```

Rules:
- Included: node `id`, `type`, sorted `config` (top level only); edge endpoints +
  ports. Excluded on purpose: `x`, `y`, edge `id`, workflow name/description — moving
  a node on canvas is NOT a new version.
- Edge sort key is plain string concatenation without separator
  (`from+fromPort+to`) under `localeCompare` — reproduce exactly, including its
  ambiguity, rather than "improving" it.
- Same outer key order `{nodes, edges}`, same compact stringify, same 32-hex cut.

## 3. String serialization parity (applies to both digests)

`JSON.stringify` vs Python `json.dumps` differences that matter here:

| Concern | JS behavior | Python requirement |
| --- | --- | --- |
| Separators | `,` and `:` (compact mode) | `separators=(',', ':')` |
| Non-ASCII | emitted raw (UTF-8) | `ensure_ascii=False` |
| Line separators U+2028/U+2029 | emitted raw | raw too (ensure_ascii=False gives this) |
| `/` | never escaped | never escaped (default) |
| Numbers | shortest round-trip repr (ECMAScript Number::toString) | `repr(float)` matches for most values but differs for exponents like `1e21`; fingerprinted inputs today carry only strings/numbers-of-modest-range — keep it that way or pin a formatter |
| `undefined` input value | property DROPPED by JSON.stringify | use `None`→must be dropped explicitly before dumps |

Number formatting is the remaining long tail: if a fingerprinted input can ever
contain a float beyond simple ranges, add a pinned vector BEFORE relying on parity.

## 4. Identifier shapes (for fixture realism, not hashing)

- Invocation ids: `inv` + `Date.now().toString(36)` + monotonic counter
  (fabric.ts:140–144), e.g. `invmt6p764n1`.
- Workflow/run/rule ids: `<prefix>-<Date.now().toString(36)>-<6 random base36>`
  (workflow/types.ts:218 genId pattern), e.g. `wf-mt6p764n-yeej95`.
- Approval request ids: `apr-…` (observed on disk).

These are opaque strings to every consumer; Python may generate them differently so
long as uniqueness and format class hold — but golden fixtures reuse the observed
shape for byte-realism.
