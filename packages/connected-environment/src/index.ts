/**
 * @aura/connected-environment — what this machine can do, and through what.
 * ==================================================================
 * The registry half of the Connected Environment. It knows systems,
 * capabilities, health and permissions; it does not plan, schedule or
 * execute.
 *
 *   Mission Control v3  ── owns missions, the DAG, task states, gates
 *           │
 *           ▼
 *   Capability Fabric   ── owns policy, approval, execution, verification
 *           │
 *           ▼
 *   THIS PACKAGE        ── owns node identity, capability, health
 *           │
 *           ▼
 *   External systems
 *
 * Pure domain logic. No React, no Node, no fetch — every side effect
 * arrives through the `NodeTransport` interface the host supplies.
 */

export * from './types';
export * from './capabilities';
export * from './catalog';
export * from './registry';
export * from './resolver';
export * from './agents';
export * from './language';
