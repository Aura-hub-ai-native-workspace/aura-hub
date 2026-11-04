import { backendFetch } from '../backend/backendSession';
/**
 * governanceClient — fetch wrappers for the Engineering Governance
 * Platform, matching `missionClient.ts`'s style. The governance engines
 * live in the ai-service (Node) because they scan the filesystem; the
 * desktop only renders the reports it receives.
 */
import { aiClient } from './aiClient';
import type {
  EngineeringScorecard,
  EngineeringAuditReport,
  ProjectInsightsReport,
  ArchitectureCouncilReport,
} from '@aura/governance';

export type { EngineeringScorecard, EngineeringAuditReport, ProjectInsightsReport, ArchitectureCouncilReport };

const BASE = aiClient.base;

export const governanceClient = {
  scorecard: (projectPath: string): Promise<EngineeringScorecard> =>
    backendFetch(`${BASE}/governance/scorecard`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath }),
    }).then((r) => r.json()),

  audit: (projectPath: string, scope?: string): Promise<EngineeringAuditReport> =>
    backendFetch(`${BASE}/governance/audit`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath, scope }),
    }).then((r) => r.json()),

  insights: (projectPath: string): Promise<ProjectInsightsReport> =>
    backendFetch(`${BASE}/governance/insights`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath }),
    }).then((r) => r.json()),

  council: (projectPath: string): Promise<ArchitectureCouncilReport> =>
    backendFetch(`${BASE}/governance/council`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ projectPath }),
    }).then((r) => r.json()),
};
