# Questions — Phase 3, governed agency

Five things I could not decide without you. Each names what is blocked, what
I did instead, and why I did not simply pick an answer.

---

## 1. Where do per-model token prices come from?

**Blocked:** the cost cap. `AgentLimits.maxCostUsd` is enforced against
`ModelCapabilities.inputCostPer1k` / `outputCostPer1k`
(`packages/ai-service/src/provider/types.ts:13-14`) — fields that are
**declared and populated by no adapter in the repository**. I checked all
thirteen.

**What I did instead:** a run that sets a cost cap when no rates are
available is **refused**, with the reason. It does not run uncapped and it
does not report an invented cost. `agent-loop-verify.mjs` D6b is the
negative control for exactly this.

**Why I did not pick:** every option is a product commitment with a
different failure mode, and the wrong one is worse than none.

- A hardcoded per-model table goes stale silently, and a stale price used
  to enforce a spend limit is a wrong number a person acts on.
- Provider pricing APIs exist for some providers and not others, so this
  would work for a subset and fail invisibly for the rest.
- Asking the user to enter their own rates is honest, but it is a settings
  surface nobody has designed and it would sit in the connect-a-provider
  flow.

**What I need:** which of those, or a fourth. If a table, who owns keeping
it current.

---

## 2. Autonomy level 3 cannot be expressed over the existing policy config.

**Blocked:** the roadmap's rung 3, "approved workflows".

The obvious encoding is `workflow.run` becoming `auto-execute` while medium
risk generally stays `ask-user`. **The `overrides` map cannot express
that.** Every configurable layer in `evaluatePolicy` is folded with
`stricter()` (`policy.ts`, the `apply()` helper), so an override can raise
a decision and can never lower one. Writing `auto-execute` there changes
nothing at all — I verified this against the real engine before concluding
it.

That property is not a bug. It is the reason a hostile or corrupt
`fabric-policy.json` cannot buy its way past a gate, and it is what makes
`sanitizePolicy` sufficient rather than merely careful.

**What I did instead:** level 3 is honestly the same `PolicyConfig` as
level 2, differing in *scope* — irreversible capabilities become offerable
to the model, and still park on a human. That is a real difference and it
is checked (`agent-loop-verify.mjs` E10). It is not what the roadmap
described.

**Why I did not pick:** the three ways forward are all yours to choose.

- **Relax medium risk generally.** That is already level 4, so level 3
  would stop being a distinct rung.
- **Teach the policy engine "this specific plan was already approved".**
  This is the faithful reading, and it is a genuinely new concept: a
  decision keyed to a mission or workflow rather than to a capability. It
  would need somewhere to live, and the obvious place — a store of
  standing approvals — is a **second approval authority** next to the
  Fabric's, which invariant 2 forbids without a deliberate decision. It
  might belong *inside* the existing approval store as a longer-lived
  `ApprovalRequest`, but that changes what single-use means.
- **Drop rung 3** and renumber the ladder to five levels.

**What I need:** which of those three.

---

## 3. What actually distinguishes level 0 (observe) from level 1 (suggest)?

**Blocked:** nothing is blocked; the two levels are currently identical in
both policy and scope, and I want to know whether that is right.

A proposal is not an action, so it needs no policy of its own — which is
why both levels produce the same config. But then "suggest" is a claim
about what the *caller* does with the loop's answer, and the loop returns
its answer either way.

**Two readings, and I do not know which you meant:**

- **Level 0 offers no tools at all.** AURA answers from context it was
  already given and cannot investigate. This makes the levels genuinely
  different and enforced, but it also makes level 0 a level at which the
  agent loop does not run.
- **Level 0 and 1 both read; level 1 additionally surfaces a proposal in
  the UI.** This is what is built. The difference is presentational and
  lives outside this module.

**What I need:** which reading, or a third.

---

## 4. Should a parked run resume when the human answers?

**Blocked:** a run that parks on approval ends. Nothing resumes it.

When a step returns `requires-approval`, the loop records the approval id
and — after two consecutive turns where every action parked — ends as
`blocked-on-approval` with the ids to answer. A person then approves
through the existing `/fabric/approvals/:id/decide` route. **What happens
next is undefined.**

**Why I did not pick:** resumption is the point at which AURA re-enters an
autonomous loop *without the user having initiated anything*. The
mechanism is straightforward — the journal already holds the exact
transcript, and `InvocationContext.resumeApprovalId` already exists to
spend the grant. The question is whether answering an approval should mean
"and carry on by yourself", or whether the person should have to say so.
That is a decision about what consent means here, not an implementation
detail, and choosing it silently would be choosing it for you.

**What I need:** does approving a parked step resume the run automatically,
resume it only on an explicit "continue", or never (the objective is
restated)?

---

## 5. Should the agent-loop flag ever be user-facing?

**Blocked:** nothing; I want the decision recorded.

`AURA_AGENT_LOOP=1` is an environment variable, deliberately not a setting.
The reasoning is in `packages/ai-service/src/agent/flag.ts`: while Phases 1
and 2 are unfinished, whether the safety story is complete is a
build-and-deployment judgement, not a user preference, and it should not be
reachable from a settings screen while that is true.

Once Phases 1 and 2 land that reasoning expires, and the flag should
probably become a setting alongside the autonomy level. **Where does the
autonomy level itself live?** It is currently not persisted anywhere — the
ladder produces a `PolicyConfig`, the policy is persisted through the
existing `policyStore`, but the *level* that produced it is not. That means
`GET /agent/status` reports the shipped default and checks whether the
installed policy still matches it, rather than reporting a level somebody
chose.

**What I need:** where the level is stored (`fabric-policy.json` alongside
the policy is the obvious answer), and whether changing it needs anything
beyond a click — confirmation, a re-auth, a typed acknowledgement for
levels 4 and 5.
