/**
 * AURA's shared context store: the common-context store, built into the AI service.
 *
 * Append-only JSON file per project (common-context.json, mode 0600), with sessions,
 * checkpoints, failures, file claims and handoffs. Used directly, without the package's
 * installer, so no other AI tool's configuration is changed.
 */
export { ContextStore, StoreError, SCHEMA_VERSION } from "./store.js";
export type { ContextData, ContextEntry, SessionEntry, FailureEntry, ClaimEntry } from "./store.js";
export { loadConfig } from "./config.js";
export { ContextTools } from "./tools.js";
export type { SummaryInput } from "./tools.js";
