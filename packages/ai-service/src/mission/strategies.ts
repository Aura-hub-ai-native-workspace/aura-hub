/**
 * strategies — Stage 4, Mission Strategy Selection. Deterministic
 * registry, zero model calls.
 * ==================================================================
 * This is the single most important reason two different missions
 * produce two different plans: before the Goal Graph's one LLM call
 * ever runs, the category picked in Stage 1 already selects a
 * structurally distinct scaffold of focus areas. "Prepare for a
 * presentation" and "prepare for production" hand the model two
 * completely different lists of things to plan around — the model is
 * never asked to invent structure, only to fill in a real, specific
 * scaffold with real, specific goals and tasks.
 *
 * Every category's focus areas are deliberately different in both
 * count and content — there is no shared "generic checklist" fallback
 * except for `'unknown'`, which honestly gets a general health-pass
 * scaffold because the mission's actual intent could not be
 * determined at all.
 */
import type { FocusArea, MissionCategory, MissionStrategy } from './types';

function fa(id: string, label: string, description: string): FocusArea {
  return { id, label, description };
}

const STRATEGIES: Record<MissionCategory, MissionStrategy> = {
  presentation: {
    category: 'presentation',
    guidance: 'Optimize for a convincing, stable, good-looking live demonstration — not for long-term production hardening. Cut scope aggressively toward whatever will actually be seen.',
    focusAreas: [
      fa('ui-polish', 'UI Polish', 'Visual rough edges, inconsistent spacing/copy, obviously unfinished screens in the demo path'),
      fa('demo-flow', 'Demo Flow', 'The exact sequence of screens/actions the presenter will walk through, end to end, without dead ends'),
      fa('stability', 'Stability', 'Crashes, exceptions, or error states specifically reachable from the demo flow'),
      fa('performance', 'Startup & Responsiveness', 'Cold-start time and perceived responsiveness during the demo — not general profiling'),
      fa('documentation', 'Presenter Notes', 'A short real script or notes so the presenter does not improvise around unfinished areas'),
      fa('screenshots', 'Screenshots / Visual Assets', 'Fallback screenshots or recordings in case a live demo step fails'),
    ],
  },
  deployment: {
    category: 'deployment',
    guidance: 'Optimize for shipping this specific build to a real environment safely and reproducibly.',
    focusAreas: [
      fa('environment-config', 'Environment Configuration', 'Real env vars, secrets handling, and config drift between local and target environment'),
      fa('ci-cd', 'CI/CD Pipeline', 'Whether a real build/deploy pipeline exists and what it actually checks'),
      fa('rollback-plan', 'Rollback Plan', 'A concrete way to revert if the deployed build fails'),
      fa('monitoring', 'Monitoring & Health Checks', 'Real signal that the deployed instance is alive and correct'),
      fa('deployment-checklist', 'Deployment Checklist', 'The literal, ordered steps to execute the deployment'),
    ],
  },
  release: {
    category: 'release',
    guidance: 'Optimize for a versioned, documented, verifiable release artifact — the release process itself, not the deployment mechanics.',
    focusAreas: [
      fa('testing', 'Pre-Release Testing', 'Real test coverage gaps that must close before this version ships'),
      fa('versioning', 'Versioning', 'Version bump correctness and semantic-versioning consistency'),
      fa('release-notes', 'Release Notes', 'A real, accurate changelog of what actually changed'),
      fa('ci-verification', 'CI Verification', 'Confirming the CI pipeline actually passed for the release commit'),
      fa('deployment-checklist', 'Deployment Checklist', 'The concrete steps to cut and publish this release'),
    ],
  },
  security: {
    category: 'security',
    guidance: 'Optimize for finding and closing real, concrete security exposure — never a fabricated compliance checklist.',
    focusAreas: [
      fa('threat-analysis', 'Threat Analysis', 'Where real user input, auth boundaries, or trust boundaries exist in this codebase'),
      fa('dependency-audit', 'Dependency Audit', 'Real dependency pinning/looseness and known-risky packages'),
      fa('secrets', 'Secrets', 'Real hardcoded secrets or credentials found by the pattern scan'),
      fa('permissions', 'Permissions & Access Control', 'Real authorization/permission checks around sensitive operations'),
      fa('owasp', 'OWASP-Style Review', 'Common real vulnerability classes (injection, broken auth, exposure) checked against this code, not a generic audit template'),
    ],
  },
  performance: {
    category: 'performance',
    guidance: 'Optimize for a measured performance problem — never optimize without first establishing a real baseline.',
    focusAreas: [
      fa('profiling', 'Profiling', 'Where real time/memory is actually being spent, before changing anything'),
      fa('benchmark', 'Benchmark', 'A real, repeatable measurement to compare before/after'),
      fa('optimization', 'Optimization', 'The concrete change(s) targeting the profiled bottleneck'),
      fa('regression-tests', 'Regression Tests', 'Tests that would catch this specific performance regression coming back'),
    ],
  },
  'bug-resolution': {
    category: 'bug-resolution',
    guidance: 'Optimize for a verified fix with a real reproduction and real regression coverage — never a guess-and-patch.',
    focusAreas: [
      fa('root-cause', 'Root Cause Analysis', 'Establishing the real, evidenced cause before proposing any fix'),
      fa('fix-verification', 'Fix Verification', 'Confirming the fix actually addresses the reproduced failure'),
      fa('regression-coverage', 'Regression Coverage', 'A real test that would have caught this bug'),
      fa('documentation', 'Documentation', 'Recording the real cause and fix for future reference'),
    ],
  },
  testing: {
    category: 'testing',
    guidance: 'Optimize for closing real, measured test-coverage gaps — never generate tests for the sake of a test count.',
    focusAreas: [
      fa('coverage-audit', 'Coverage Audit', 'Which real files/modules currently have zero test coverage'),
      fa('unit-tests', 'Unit Tests', 'Real, isolated logic worth testing directly'),
      fa('integration-tests', 'Integration Tests', 'Real cross-module/cross-layer paths worth testing end to end'),
      fa('regression-suite', 'Regression Suite', 'Coverage for real past bugs or fragile hotspots'),
      fa('ci', 'CI Integration', 'Whether these tests actually run automatically'),
    ],
  },
  documentation: {
    category: 'documentation',
    guidance: 'Optimize for real, currently-missing documentation — never restate what the code already makes obvious.',
    focusAreas: [
      fa('coverage-audit', 'Documentation Coverage Audit', 'Which real modules/files have no README, docstring, or explanation at all'),
      fa('api-docs', 'API Documentation', 'Real public interfaces that are undocumented'),
      fa('architecture-docs', 'Architecture Documentation', 'Whether the real structure of the system is written down anywhere'),
      fa('onboarding-docs', 'Onboarding Documentation', 'What a new contributor would need and does not currently have'),
      fa('examples', 'Usage Examples', 'Concrete, runnable examples for real entry points'),
    ],
  },
  'feature-development': {
    category: 'feature-development',
    guidance: 'Optimize for building the requested capability across every real layer it touches — never just the happy-path UI.',
    focusAreas: [
      fa('architecture', 'Architecture Fit', 'Where this feature real fits into the existing layer/module structure'),
      fa('backend', 'Backend', 'Real business logic and services this feature needs'),
      fa('database', 'Database', 'Real schema/data model changes this feature needs'),
      fa('api', 'API', 'Real endpoints/contracts this feature exposes or consumes'),
      fa('frontend', 'Frontend', 'Real UI surface for this feature'),
      fa('testing', 'Testing', 'Real coverage for the new logic paths this feature introduces'),
      fa('documentation', 'Documentation', 'Recording what this feature does and how to use it'),
    ],
  },
  architecture: {
    category: 'architecture',
    guidance: 'Optimize for real structural clarity — layering, boundaries, and dependency direction — never a cosmetic reorganization.',
    focusAreas: [
      fa('layering', 'Layering', 'Whether real layer boundaries (frontend/backend/database/etc) are actually respected'),
      fa('dependency-direction', 'Dependency Direction', 'Real cross-layer imports that violate the intended dependency direction'),
      fa('module-boundaries', 'Module Boundaries', 'Real modules whose responsibilities have blurred together'),
      fa('migration-path', 'Migration Path', 'A real, incremental path to the improved structure that does not require a rewrite'),
      fa('documentation', 'Documentation', 'Recording the real, current architecture so this doesn’t drift again'),
    ],
  },
  refactoring: {
    category: 'refactoring',
    guidance: 'Optimize for behavior-preserving simplification — every change must be verifiable as safe before and after.',
    focusAreas: [
      fa('scope-boundary', 'Scope Boundary', 'Exactly what real code is in and out of scope for this refactor'),
      fa('test-safety-net', 'Test Safety Net', 'Whether real test coverage exists to catch a behavior change'),
      fa('incremental-steps', 'Incremental Steps', 'Breaking the refactor into real, independently-revertible steps'),
      fa('verification', 'Verification', 'Confirming behavior is actually unchanged after each step'),
      fa('documentation', 'Documentation', 'Recording why the refactor happened, for the next person'),
    ],
  },
  migration: {
    category: 'migration',
    guidance: 'Optimize for a safe, reversible transition — never a one-way door without a rollback plan.',
    focusAreas: [
      fa('compatibility-audit', 'Compatibility Audit', 'Real breaking changes between the current and target state'),
      fa('data-migration', 'Data Migration', 'Real data that needs to move or transform safely'),
      fa('rollback-plan', 'Rollback Plan', 'A concrete way back if the migration fails partway'),
      fa('verification', 'Verification', 'Confirming the migrated state is actually correct'),
      fa('documentation', 'Documentation', 'Recording what changed and why'),
    ],
  },
  maintenance: {
    category: 'maintenance',
    guidance: 'Optimize for real housekeeping debt — outdated dependencies, dead code, stale docs — never a rewrite in disguise.',
    focusAreas: [
      fa('dependency-updates', 'Dependency Updates', 'Real outdated or loosely-pinned dependencies'),
      fa('dead-code', 'Dead Code Removal', 'Real unused exports/files found by the codebase’s own dead-code detection'),
      fa('technical-debt', 'Technical Debt', 'Real TODO/FIXME/HACK markers already left in the code'),
      fa('documentation-refresh', 'Documentation Refresh', 'Real docs that no longer match the current code'),
    ],
  },
  research: {
    category: 'research',
    guidance: 'Optimize for a real, evidenced answer to an open question — never a speculative recommendation with no investigation behind it.',
    focusAreas: [
      fa('landscape-survey', 'Landscape Survey', 'What real options or precedents exist for this question'),
      fa('feasibility', 'Feasibility', 'Whether the idea is realistically compatible with this real codebase'),
      fa('prototyping', 'Prototyping', 'A minimal real spike to test the riskiest assumption'),
      fa('findings-documentation', 'Findings Documentation', 'Writing down what was actually learned, with evidence'),
    ],
  },
  unknown: {
    category: 'unknown',
    guidance: 'The mission’s intent could not be determined from the text given. Fall back to a general, evidence-driven health pass across the project’s real, currently-weakest signals — do not guess at a narrower intent.',
    focusAreas: [
      fa('weakest-signals', 'Weakest Real Signals', 'Whichever real health/verification signals currently score lowest'),
      fa('clarification', 'Clarification Needed', 'What a more specific mission statement would need to say to get a sharper plan'),
    ],
  },
};

export function strategyFor(category: MissionCategory): MissionStrategy {
  return STRATEGIES[category];
}
