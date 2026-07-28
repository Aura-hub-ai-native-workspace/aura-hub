/**
 * ChatRetrievalEngine
 * Indexes: conversations, user preferences, notes, tasks, workspace
 * memory. Recency-weighted (the latest turns matter most), modest budget.
 */

import type { EngineBudgetConfig } from '../budget/tokenBudget';
import { BaseRetrievalEngine, type EngineDeps } from './retrievalEngine';
import type { IndexCategory, RetrievalDomain } from '../types';

export const CHAT_DEFAULT_CONFIG: EngineBudgetConfig = {
  maxContext: 1500,
  priority: 0.7,
  compression: 'truncate',
  ranking: 'recency-weighted',
};

export class ChatRetrievalEngine extends BaseRetrievalEngine {
  readonly domain: RetrievalDomain = 'chat';
  readonly indexes: IndexCategory[] = [
    'conversations', 'preferences', 'notes', 'tasks', 'workspace-memory',
  ];
  constructor(deps: EngineDeps, config: EngineBudgetConfig = CHAT_DEFAULT_CONFIG) {
    super(deps, config);
  }
}
