/**
 * @aura/workflow — AURA Workflow: orchestration domain + persistence.
 * ==================================================================
 *
 *   AURA Workflow is ORCHESTRATION.         (this package)
 *   AURA Fabric is EXECUTION GOVERNANCE.    (@aura/capability-fabric)
 *   AURA Context is KNOWLEDGE.              (ai-service, workspace)
 *   AURA Mission is the WORK TRACK.         (ai-service, mission)
 *   AURA Agents are INTELLIGENCE WORKERS.   (connected-environment)
 *
 * This package defines WHAT a workflow is (a versioned graph of trigger,
 * AI, capability-tool, control, mission and output nodes with typed
 * ports and constrained expressions) and WHAT happened when it ran
 * (WorkflowRun records). It decides nothing and executes nothing — the
 * runtime phases route every executable node through the existing
 * Fabric invoke path (validate → resolveNode → policy → approval →
 * execute → verify → audit).
 *
 * Nothing here duplicates an authority: no policy engine, no execution
 * engine, no process primitive, no environment scanner, no node
 * catalogue, no approval store, no provider registry. Capability ids
 * come from the Fabric manifest; node availability comes from the
 * Connected Environment; governance shapes come from the Fabric types.
 */

export * from './types';
export * from './expression';
export * from './schemas';
export * from './validate';
export * from './definitionStore';
export * from './runStore';
export * from './runtime';