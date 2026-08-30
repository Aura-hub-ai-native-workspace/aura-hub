/**
 * @aura/automation — Automation Engine
 * ==================================================================
 * Event-driven engineering workflows. Rules react to real platform
 * moments (mission completed / accepted, diagnosis completed / accepted,
 * file / README / dependency changes, PR merged) by running ordered
 * chains of real actions — with deterministic conditions, per-action
 * retries, a persisted timeline, run history and explicit statuses.
 *
 * The engine is a pure state machine: every side effect (diagnosis,
 * governance audits, knowledge update, memory writes) is injected by the
 * host through the `actions` registry, so this package never touches a
 * project's filesystem and never fabricates a metric.
 */

export {
  AutomationEngine,
  evaluateCondition,
  evaluateConditions,
  type AutomationEngineOptions,
} from './engine';

export {
  AutomationStore,
} from './store';

export {
  configHome,
  homePath,
  readJsonFile,
  writeJsonFile,
} from './persist';

export {
  AUTOMATION_TEMPLATES,
  instantiateAutomationTemplate,
  type AutomationTemplate,
} from './templates';

export {
  buildEvent,
  createTriggerScanner,
  dependencyChangeEvent,
  detectChangedFiles,
  detectMergedPrs,
  fileChangeEvent,
  persistDependencySnapshot,
  prMergedEvent,
  readDependencySnapshot,
} from './triggers';

export type {
  ActionResult,
  ActionCtx,
  ActionHandler,
  ActionRunState,
  AutomationEvent,
  AutomationRule,
  AutomationRuleSummary,
  AutomationRun,
  AutomationRunEvent,
  AutomationRunSummary,
  AutomationTriggerType,
  AutomationActionType,
  Condition,
  ConditionEvaluation,
  ConditionOp,
  RetryPolicy,
  RuleAction,
  RunActionStatus,
  RunStatus,
  RunTimelineEntry,
  TimelineType,
} from './types';
export * from './schedule';
export * from './scheduler';
