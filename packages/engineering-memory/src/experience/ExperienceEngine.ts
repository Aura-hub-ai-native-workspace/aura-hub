/**
 * Experience Engine
 * ==================================================================
 * Tracks engineering experience by domain.
 */

import type { ProjectId, EngineeringDomain, MissionId } from '../types';
import { ExperienceStore } from './ExperienceStore';

/** Experience Engine */
export class ExperienceEngine {
  private store: ExperienceStore;

  constructor() {
    this.store = new ExperienceStore();
  }

  recordMissionCompletion(
    projectId: ProjectId,
    domain: EngineeringDomain,
    missionId: MissionId,
    durationMinutes: number,
    confidence: number,
    reviewScore: number,
    risk: number
  ): any {
    return this.store.recordMissionCompletion(projectId, domain, missionId, durationMinutes, confidence, reviewScore, risk);
  }

  getDomainExperience(projectId: ProjectId, domain: EngineeringDomain): any {
    return this.store.getDomainExperience(projectId, domain);
  }

  getProjectExperience(projectId: ProjectId): any {
    return this.store.getProjectExperience(projectId);
  }

  getOverallMetrics(): any {
    return this.store.getOverallMetrics();
  }
}

export const experienceEngine = new ExperienceEngine();
