/**
 * CodingRetrievalEngine
 * Indexes: source code, APIs, documentation, git history, errors,
 * architecture, dependencies. High priority, hybrid ranking, generous
 * budget — code context is dense and load-bearing.
 */

import type { EngineBudgetConfig } from '../budget/tokenBudget';
import { BaseRetrievalEngine, type EngineDeps } from './retrievalEngine';
import type { IndexCategory, RetrievalDomain } from '../types';

export const CODING_DEFAULT_CONFIG: EngineBudgetConfig = {
  maxContext: 3000,
  priority: 0.9,
  compression: 'truncate',
  ranking: 'hybrid',
};

export class CodingRetrievalEngine extends BaseRetrievalEngine {
  readonly domain: RetrievalDomain = 'coding';
  readonly indexes: IndexCategory[] = [
    'source-code', 'apis', 'documentation', 'git-history', 'errors', 'architecture', 'dependencies',
  ];
  constructor(deps: EngineDeps, config: EngineBudgetConfig = CODING_DEFAULT_CONFIG) {
    super(deps, config);
  }
}
