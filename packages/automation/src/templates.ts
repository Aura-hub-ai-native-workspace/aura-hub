/**
 * Built-in automation templates — real, runnable engineering workflows.
 * ==================================================================
 * Each template maps a REAL platform trigger to a chain of REAL actions
 * using only the public seams this engine supports. Instantiating a
 * template produces a fully-configured rule; the host still binds the
 * action handlers, and every action keeps its human safety gates.
 */

import type { AutomationRule } from './types';

export interface AutomationTemplate {
  id: string;
  name: string;
  description: string;
  category: string;
  /** Builds a fresh rule definition (no id — assigned at creation). */
  build: () => Omit<AutomationRule, 'id' | 'createdAt' | 'updatedAt'>;
}

const T = (category: string, name: string, description: string, build: AutomationTemplate['build']): AutomationTemplate => ({ id: kebab(name), name, description, category, build });

function kebab(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

export const AUTOMATION_TEMPLATES: AutomationTemplate[] = [
  T(
    'Diagnosis',
    'Mission completed → run diagnosis',
    'When a mission execution completes, run the Engineering Diagnosis Engine on the project so any new findings are caught and recorded immediately.',
    () => ({
      name: 'Mission completed → run diagnosis',
      description: 'Runs a diagnosis on the project after every completed mission.',
      category: 'Diagnosis',
      enabled: true,
      trigger: { type: 'mission-completed', match: { mission: { status: 'completed' } } },
      conditions: [],
      chain: [
        {
          id: 'diag',
          action: 'run-diagnosis',
          label: 'Run diagnosis',
          config: { filePath: '', language: '', scope: 'mission' },
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),

  T(
    'Documentation',
    'File changes → update documentation',
    'When real file changes are detected, run the FullStack Knowledge Engine incremental update so the knowledge graph stays current.',
    () => ({
      name: 'File changes → update documentation',
      description: 'Keeps the knowledge graph fresh after any detected file change.',
      category: 'Documentation',
      enabled: true,
      trigger: { type: 'file-changed' },
      conditions: [],
      chain: [
        {
          id: 'upd',
          action: 'update-knowledge',
          label: 'Update knowledge graph',
          config: {},
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),

  T(
    'Documentation',
    'README changes → review docs',
    'When a README or changelog changes, run Documentation Governance to keep docs quality gated.',
    () => ({
      name: 'README changes → review docs',
      description: 'Reviews documentation health after README/changelog edits.',
      category: 'Documentation',
      enabled: true,
      trigger: { type: 'readme-changed' },
      conditions: [],
      chain: [
        {
          id: 'docs',
          action: 'run-docs-review',
          label: 'Review documentation',
          config: {},
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),

  T(
    'Governance',
    'PR merged → architecture audit',
    'When a merge commit lands, run the Engineering Audit (architecture scope) to catch structural drift early.',
    () => ({
      name: 'PR merged → architecture audit',
      description: 'Architecture audit on every merged PR.',
      category: 'Governance',
      enabled: true,
      trigger: { type: 'pr-merged' },
      conditions: [],
      chain: [
        {
          id: 'audit',
          action: 'run-governance-audit',
          label: 'Architecture audit',
          config: { scope: 'architecture' },
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),

  T(
    'Security',
    'New dependency → security review',
    'When the package manifest changes, run the Security Engine to review new/updated dependencies.',
    () => ({
      name: 'New dependency → security review',
      description: 'Security review whenever dependencies change.',
      category: 'Security',
      enabled: true,
      trigger: { type: 'dependency-changed' },
      conditions: [],
      chain: [
        {
          id: 'sec',
          action: 'run-security-review',
          label: 'Security review',
          config: {},
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),

  T(
    'Memory',
    'Mission accepted → generate engineering memory',
    'When a mission task proposal is accepted, record it as an engineering decision in project memory.',
    () => ({
      name: 'Mission accepted → generate engineering memory',
      description: 'Persists accepted mission work into engineering memory.',
      category: 'Memory',
      enabled: true,
      trigger: { type: 'mission-accepted' },
      conditions: [],
      chain: [
        {
          id: 'mem',
          action: 'save-memory',
          label: 'Save engineering memory',
          config: { kind: 'decision', title: 'Accepted: {{payload.task.title}}', body: 'Mission {{payload.mission.text}} — task accepted.' },
        },
      ],
      retry: { maxAttempts: 1, delayMs: 1000, backoffFactor: 2 },
    }),
  ),
];

export function instantiateAutomationTemplate(id: string): Omit<AutomationRule, 'id' | 'createdAt' | 'updatedAt'> | null {
  const t = AUTOMATION_TEMPLATES.find((x) => x.id === id);
  return t ? t.build() : null;
}
