/**
 * FullStackRetrievalEngine
 * Indexes: frontend, backend, database, API contracts, deployment,
 * architecture, project structure. Project-weighted ranking — this
 * engine is about one system's shape, so same-project context dominates.
 */

import type { EngineBudgetConfig } from '../budget/tokenBudget';
import { BaseRetrievalEngine, type EngineDeps } from './retrievalEngine';
import type { IndexCategory, RetrievalDomain } from '../types';

export const FULLSTACK_DEFAULT_CONFIG: EngineBudgetConfig = {
  maxContext: 3000,
  priority: 0.8,
  compression: 'truncate',
  ranking: 'project-weighted',
};

export class FullStackRetrievalEngine extends BaseRetrievalEngine {
  readonly domain: RetrievalDomain = 'fullstack';
  readonly indexes: IndexCategory[] = [
    'frontend', 'backend', 'database', 'api-contracts', 'deployment', 'architecture', 'project-structure',
  ];
  constructor(deps: EngineDeps, config: EngineBudgetConfig = FULLSTACK_DEFAULT_CONFIG) {
    super(deps, config);
  }
}
