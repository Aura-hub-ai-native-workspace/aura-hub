/**
 * @aura/capability-fabric — the governed execution path.
 * ==================================================================
 *
 *   User / Chat
 *        │
 *   Mission Control v3      ← owns missions, DAG, checkpoints, timeline
 *        │
 *   ExecutionDag
 *        │
 *   ┌────▼─────────────────────────────────────────┐
 *   │  CAPABILITY FABRIC                            │
 *   │  resolve → policy → approval → execute →      │
 *   │  verify → recover → audit                     │
 *   └────┬─────────────────────────────────────────┘
 *        │
 *   Internal AURA capability  OR  External node
 *        │
 *   Executor / Transport
 *        │
 *   Verification → back onto the MissionRecord timeline
 *
 * The Fabric owns no missions, no task graph and no scheduling. Those
 * belong to Mission Control v3 and are referenced by id only. See
 * docs/CONSOLIDATION_MAP.md for the full mapping.
 */

export * from './types';
export * from './manifest';
export * from './policy';
export * from './fabric';
export * from './missionCapabilities';
