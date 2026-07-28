/**
 * ResearchRetrievalEngine
 * Indexes: PDFs, books, websites, papers, documentation, local
 * knowledge. Relevance-first ranking; uses the summarize compression
 * policy (placeholder) because research snippets are long-form.
 */

import type { EngineBudgetConfig } from '../budget/tokenBudget';
import { BaseRetrievalEngine, type EngineDeps } from './retrievalEngine';
import type { IndexCategory, RetrievalDomain } from '../types';

export const RESEARCH_DEFAULT_CONFIG: EngineBudgetConfig = {
  maxContext: 2500,
  priority: 0.6,
  compression: 'summarize',
  ranking: 'relevance',
};

export class ResearchRetrievalEngine extends BaseRetrievalEngine {
  readonly domain: RetrievalDomain = 'research';
  readonly indexes: IndexCategory[] = [
    'pdfs', 'books', 'websites', 'papers', 'documentation', 'local-knowledge',
  ];
  constructor(deps: EngineDeps, config: EngineBudgetConfig = RESEARCH_DEFAULT_CONFIG) {
    super(deps, config);
  }
}
