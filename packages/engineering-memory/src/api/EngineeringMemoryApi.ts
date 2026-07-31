/**
 * Engineering Memory Platform - Public APIs
 * ==================================================================
 * Provides clean, modular APIs for the Engineering Memory Platform.
 */

import { engineeringMemory } from '../memory/EngineeringMemory';
import { patternEngine } from '../pattern/PatternEngine';
import { experienceEngine } from '../experience/ExperienceEngine';
import { decisionMemory } from '../decision/DecisionMemory';
import { bugMemory } from '../bug/BugMemory';
import { missionMemory } from '../mission/MissionMemory';
import { projectTimeline } from '../timeline/ProjectTimeline';
import { engineeringSearch } from '../search/EngineeringSearch';
import { predictionFoundation } from '../prediction/PredictionFoundation';
import { memoryGraph } from '../graph/MemoryGraph';
import { engineeringInsights } from '../insights/EngineeringInsights';
import type { ProjectId, MissionId, DiagnosisId, FilePath } from '../types';

/** Engineering Memory API */
export class EngineeringMemoryApi {
  // Memory APIs
  createMemory(record: any): any {
    return engineeringMemory.create(record);
  }

  queryMemories(query: any): any[] {
    if (query.projectIds && query.projectIds.length > 0) {
      return query.projectIds.flatMap((p: ProjectId) => engineeringMemory.queryProject(p));
    }
    return [];
  }

  getMemoriesByMission(missionId: MissionId): any[] {
    return engineeringMemory.getByMission(missionId);
  }

  getMemoriesByDiagnosis(diagnosisId: DiagnosisId): any[] {
    return engineeringMemory.getByDiagnosis(diagnosisId);
  }

  // Pattern APIs
  detectPatternsInCode(projectId: ProjectId, filePath: FilePath, content: string, language: string): any[] {
    return patternEngine.detectInCode(projectId, filePath, content, language);
  }

  getPatternRecords(projectId: ProjectId): any[] {
    return patternEngine.getPatterns(projectId);
  }

  // Experience APIs
  getDomainExperience(projectId: ProjectId, domain: any): any {
    return experienceEngine.getDomainExperience(projectId, domain);
  }

  getProjectExperience(projectId: ProjectId): any {
    return experienceEngine.getProjectExperience(projectId);
  }

  // Decision APIs
  createDecision(record: any): any {
    return decisionMemory.createDecision(record.projectId, record);
  }

  searchDecisions(projectId: ProjectId, problem: string, _limit?: number): any[] {
    const decision = decisionMemory.getDecision(projectId, problem);
    return decision ? [decision] : [];
  }

  // Bug APIs
  createBug(record: any): any {
    return bugMemory.createBug(record.projectId, record);
  }

  searchBugs(projectId: ProjectId, rootCause: string, limit?: number): any[] {
    return bugMemory.listBugs(projectId).filter(b => b.rootCause.includes(rootCause)).slice(0, limit);
  }

  // Mission APIs
  createMissionMemory(record: any): any {
    return missionMemory.createMission(record.projectId, record);
  }

  searchMissions(projectId: ProjectId, intent: string, limit?: number): any[] {
    return missionMemory.listMissions(projectId).filter(m => m.intent.includes(intent)).slice(0, limit);
  }

  // Timeline APIs
  getTimeline(projectId: ProjectId): any[] {
    return projectTimeline.getTimeline(projectId);
  }

  // Search APIs
  searchEngineeringMemory(query: any): any[] {
    return engineeringSearch.search(query);
  }

  // Prediction APIs
  findSimilarBugsApi(projectId: ProjectId, bugId: string, limit?: number): any {
    return predictionFoundation.findSimilarBugs(projectId, bugId, limit);
  }

  findSimilarMissionsApi(projectId: ProjectId, missionId: MissionId, limit?: number): any {
    return predictionFoundation.findSimilarMissions(projectId, missionId, limit);
  }

  // Graph APIs
  getMemoryGraph(projectId: ProjectId): any {
    return memoryGraph.getGraph(projectId);
  }

  // Insights APIs
  generateInsights(projectId: ProjectId): any[] {
    return engineeringInsights.generateProjectInsights(projectId);
  }

  getAllProjectIds(): ProjectId[] {
    return [];
  }

  getMemoryStats(projectId: ProjectId): any {
    return engineeringMemory.getProjectStats(projectId);
  }

  getOverallMemoryStats(): any {
    return engineeringMemory.getOverallStats();
  }
}

export const engineeringMemoryApi = new EngineeringMemoryApi();
