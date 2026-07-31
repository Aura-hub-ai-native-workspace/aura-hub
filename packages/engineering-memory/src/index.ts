/**
 * Engineering Memory Platform
 * ==================================================================
 * The Engineering Memory Platform provides persistent memory, pattern recognition,
 * experience tracking, and decision history for AURA's engineering intelligence.
 */

// Core types
export * from './types';

// Utilities
export * from './utils/idGenerator';
export * from './utils/similarity';
export * from './utils/validation';
export * from './utils/persist';

// Main classes
export { MemoryStore } from './memory/MemoryStore';
export { PatternStore } from './pattern/PatternStore';
export { ExperienceStore } from './experience/ExperienceStore';
export { DecisionMemory } from './decision/DecisionMemory';
export { BugMemory } from './bug/BugMemory';
export { MissionMemory } from './mission/MissionMemory';
export { ProjectTimeline } from './timeline/ProjectTimeline';
export { EngineeringSearch } from './search/EngineeringSearch';
export { PredictionFoundation } from './prediction/PredictionFoundation';
export { MemoryGraphBuilder as MemoryGraph } from './graph/MemoryGraph';
export { EngineeringInsights } from './insights/EngineeringInsights';
export { EngineeringMemoryApi } from './api/EngineeringMemoryApi';

// Main API
export { EngineeringMemory } from './memory/EngineeringMemory';

// Singleton instances
export { engineeringMemory } from './memory/EngineeringMemory';
export { patternEngine } from './pattern/PatternEngine';
export { experienceEngine } from './experience/ExperienceEngine';
export { decisionMemory } from './decision/DecisionMemory';
export { bugMemory } from './bug/BugMemory';
export { missionMemory } from './mission/MissionMemory';
export { projectTimeline } from './timeline/ProjectTimeline';
export { engineeringSearch } from './search/EngineeringSearch';
export { predictionFoundation } from './prediction/PredictionFoundation';
export { memoryGraph } from './graph/MemoryGraph';
export { engineeringInsights } from './insights/EngineeringInsights';
export { engineeringMemoryApi } from './api/EngineeringMemoryApi';
