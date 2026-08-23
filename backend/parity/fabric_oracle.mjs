/**
 * Fabric oracle — runs the REAL TypeScript Capability Fabric over a
 * scripted scenario file, so the Python port can be diffed against the
 * reference rather than against someone's reading of it.
 *
 * The fabric is pure domain with injected host ports, which is exactly
 * what makes this possible: the host and the executors are scripted from
 * JSON, so both implementations see identical inputs.
 *
 * Usage: node fabric_oracle.mjs <bundle.mjs> <scenarios.json>
 */
const [, , bundlePath, scenariosPath] = process.argv;
if (!bundlePath || !scenariosPath) {
  console.error('usage: fabric_oracle.mjs <bundle.mjs> <scenarios.json>');
  process.exit(1);
}

const { readFileSync } = await import('node:fs');
const m = await import(bundlePath);
const scenarios = JSON.parse(readFileSync(scenariosPath, 'utf8'));

/** An executor whose behaviour is entirely described by the scenario. */
function makeExecutor(spec) {
  let calls = 0;
  const executor = {
    capabilityId: spec.capabilityId,
    async run() {
      calls += 1;
      switch (spec.behavior) {
        case 'ok':
          return { ok: true, detail: spec.detail ?? 'done', output: spec.output };
        case 'fail':
          return { ok: false, detail: spec.detail ?? 'it did not work' };
        case 'throw':
          throw new Error(spec.detail ?? 'executor exploded');
        case 'throw-empty':
          throw new Error('');
        case 'transient':
          return { ok: false, detail: spec.detail ?? 'ETIMEDOUT while connecting' };
        case 'transient-then-ok':
          return calls >= (spec.succeedOnAttempt ?? 2)
            ? { ok: true, detail: 'recovered', output: spec.output }
            : { ok: false, detail: 'ECONNRESET' };
        default:
          return { ok: false, detail: `unknown behavior ${spec.behavior}` };
      }
    },
  };
  if (spec.supportsNodes !== undefined && spec.supportsNodes !== null) {
    executor.supportsNode = (node) => spec.supportsNodes.includes(node.id);
  }
  if (spec.verify) {
    executor.verify = async () => {
      if (spec.verify === 'throw') throw new Error('the check blew up');
      return {
        passed: spec.verify === 'pass',
        kind: 'read-back',
        detail: spec.verify === 'pass' ? 'confirmed' : 'not confirmed',
      };
    };
  }
  return executor;
}

const results = [];

for (const scenario of scenarios) {
  const events = [];
  const nodes = (scenario.nodes ?? []).map((n) => ({
    id: n.id, name: n.name, capabilities: n.capabilities ?? [], binary: n.binary,
  }));

  const host = {
    permissionsFor(_capability, context) {
      const override = scenario.grantsByRun?.[context.runId ?? ''];
      return override ?? scenario.grants ?? { read: true, write: true, execute: true, autonomous: false };
    },
    nodeAvailable(capability) {
      if (!capability.requiresNodeCapability) return null;
      if (capability.surface === 'aura-internal') return true;
      return nodes.some((n) => n.capabilities.includes(capability.requiresNodeCapability));
    },
    resolveNode: scenario.routing === false ? undefined : undefined,
    async requestApproval(request, context) {
      const approved = new Set(context.approvedCapabilities ?? []);
      return request.items.every((i) => approved.has(i.capabilityId));
    },
  };

  // Routing is supplied by the same rules the service uses. Reproduced
  // here rather than imported, because it lives in the ai-service wiring
  // file which pulls in the whole workspace manager.
  if (scenario.routing !== false) {
    host.resolveNode = (capability, context, canUse) => {
      const needed = capability.requiresNodeCapability;
      if (!needed) return { ok: true };
      if (capability.surface === 'aura-internal') return { ok: true };
      const usable = (n) => (canUse ? canUse(n) : true);
      const requested = context.nodeId?.trim();
      if (requested) {
        const node = nodes.find((n) => n.id === requested);
        if (!node) {
          return { ok: false, code: 'unknown-node', reason: `'${requested}' is not a connected node on this machine. Connect it, or omit the node to let AURA choose.` };
        }
        if (!node.capabilities.includes(needed)) {
          return { ok: false, code: 'node-lacks-capability', reason: `${node.name} does not provide ${needed}, which ${capability.name.toLowerCase()} needs.` };
        }
        if (!usable(node)) {
          return { ok: false, code: 'node-unsupported', reason: `${node.name} provides ${needed}, but AURA has no verified way to drive it yet, so nothing was run.` };
        }
        return { ok: true, node };
      }
      const node = nodes.find((n) => n.capabilities.includes(needed) && usable(n));
      if (!node) {
        const providers = nodes.filter((n) => n.capabilities.includes(needed));
        if (providers.length > 0) {
          return { ok: false, code: 'node-unsupported', reason: `${providers.map((p) => p.name).join(', ')} provide ${needed}, but AURA has no verified way to drive any of them yet.` };
        }
        return { ok: false, code: 'no-provider', reason: `Nothing connected provides ${needed} yet. Connect a node that does and this becomes available.` };
      }
      return { ok: true, node };
    };
  }

  const fabric = new m.CapabilityFabric(host);
  fabric.on((e) => events.push(e.type));
  if (scenario.policy) fabric.setPolicy(m.sanitizePolicy(scenario.policy));
  for (const spec of scenario.executors ?? []) fabric.register(makeExecutor(spec));

  const steps = [];
  for (const step of scenario.steps ?? []) {
    try {
      if (step.op === 'invoke') {
        const r = await fabric.invoke(step.capabilityId, step.input ?? {}, step.context ?? { actor: { kind: 'agent', id: 'a' }, projectId: null });
        steps.push({
          op: 'invoke',
          outcome: r.outcome,
          detail: r.detail,
          rule: r.policy.rule,
          decision: r.policy.decision,
          risk: r.policy.risk,
          reason: r.policy.reason,
          attempts: r.attempts,
          verification: r.verification,
          output: r.output ?? null,
          hasApprovalId: Boolean(r.approvalId),
        });
      } else if (step.op === 'evaluate') {
        const e = fabric.evaluate(step.capabilityId, step.context ?? { actor: { kind: 'agent', id: 'a' }, projectId: null });
        steps.push({ op: 'evaluate', value: e === null ? null : { decision: e.decision, rule: e.rule, risk: e.risk, reason: e.reason } });
      } else if (step.op === 'pending') {
        steps.push({
          op: 'pending',
          value: fabric.pendingApprovals().map((r) => ({
            state: r.state, summary: r.summary, rule: r.rule, target: r.target ?? null,
            onAccept: r.onAccept ?? null, onDecline: r.onDecline ?? null,
            items: r.items.map((i) => ({ capabilityId: i.capabilityId, title: i.title, detail: i.detail, risk: i.risk, irreversible: i.irreversible })),
            missionId: r.missionId ?? null, taskId: r.taskId ?? null,
            runId: r.runId ?? null, workflowNodeId: r.workflowNodeId ?? null,
          })),
        });
      } else if (step.op === 'decide') {
        const target = fabric.pendingApprovals()[step.index ?? 0];
        const decided = target ? fabric.decideApproval(target.id, step.granted, step.decidedBy ?? 'user', step.reason) : null;
        steps.push({ op: 'decide', value: decided === null ? null : { state: decided.state, decidedBy: decided.decidedBy } });
      } else if (step.op === 'decideById') {
        const decided = fabric.decideApproval(step.id, step.granted, step.decidedBy ?? 'user', step.reason);
        steps.push({ op: 'decideById', value: decided === null ? null : { state: decided.state } });
      } else if (step.op === 'decideAndDoubleSpend') {
        const target = fabric.pendingApprovals()[0];
        const decided = target ? fabric.decideApproval(target.id, true, 'user') : null;
        const first = decided ? fabric.consumeApproval(decided.id) : null;
        const second = decided ? fabric.consumeApproval(decided.id) : null;
        steps.push({ op: 'decideAndDoubleSpend', firstSpend: Boolean(first), secondSpend: Boolean(second) });
      } else if (step.op === 'consumeFirst') {
        const all = [...fabric.pendingApprovals()];
        const anyId = step.id ?? (all[0]?.id ?? 'nope');
        const c = fabric.consumeApproval(anyId);
        steps.push({ op: 'consumeFirst', value: c === null ? null : { consumed: Boolean(c.consumedAt) } });
      } else if (step.op === 'supported') {
        steps.push({ op: 'supported', value: fabric.supported() });
      } else if (step.op === 'manifest') {
        steps.push({
          op: 'manifest',
          value: m.CAPABILITY_MANIFEST.map((c) => ({
            id: c.id, name: c.name, category: c.category, surface: c.surface, risk: c.risk,
            permissions: c.permissions, output: c.output, verify: c.verify ?? null,
            requiresNodeCapability: c.requiresNodeCapability ?? null,
            irreversible: Boolean(c.irreversible),
            description: c.description,
            input: c.input.map((f) => ({ name: f.name, type: f.type, required: f.required, description: f.description })),
          })),
        });
      }
    } catch (e) {
      steps.push({ op: step.op, error: String(e && e.message ? e.message : e) });
    }
  }

  results.push({
    name: scenario.name,
    steps,
    events,
    audit: fabric.audit().map((r) => ({
      capabilityId: r.capabilityId,
      actor: r.actor,
      projectId: r.projectId ?? null,
      missionId: r.missionId ?? null,
      taskId: r.taskId ?? null,
      runId: r.runId ?? null,
      workflowNodeId: r.workflowNodeId ?? null,
      risk: r.risk,
      decision: r.decision,
      decisionRule: r.decisionRule,
      outcome: r.outcome,
      verified: r.verified ?? null,
      inputSummary: r.inputSummary,
      nodeId: r.nodeId ?? null,
      requestedNodeId: r.requestedNodeId ?? null,
      executedNodeId: r.executedNodeId ?? null,
      approvalDecision: r.approvalDecision ?? null,
      decidedBy: r.decidedBy ?? null,
      hasApprovalId: Boolean(r.approvalId),
    })),
  });
}

process.stdout.write(JSON.stringify(results, null, 2));
