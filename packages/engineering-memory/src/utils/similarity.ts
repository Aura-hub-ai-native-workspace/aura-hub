/**
 * Similarity Utility
 * ==================================================================
 * Provides deterministic and AI-assisted similarity calculations for
 * the Engineering Memory Platform.
 */

import type { MemoryId } from '../types';

/**
 * Tokenize text into words
 */
export function tokenize(text: string): Set<string> {
  const stopWords = new Set([
    'the', 'a', 'an', 'is', 'are', 'to', 'of', 'in', 'on', 'and', 'or', 'for',
    'how', 'what', 'where', 'does', 'do', 'this', 'that', 'with', 'it', 'be',
    'as', 'by', 'at', 'from', 'into', 'was', 'were', 'been', 'have', 'has',
    'had', 'will', 'would', 'could', 'should', 'may', 'might', 'can',
  ]);
  
  return new Set(
    text
      .toLowerCase()
      .match(/[a-z0-9]+/g)
      ?.filter(w => w.length > 2 && !stopWords.has(w)) ?? []
  );
}

/**
 * Calculate Jaccard similarity between two sets
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1.0;
  if (a.size === 0 || b.size === 0) return 0.0;
  
  let intersection = 0;
  for (const item of a) {
    if (b.has(item)) intersection++;
  }
  
  const union = a.size + b.size - intersection;
  return intersection / union;
}

/**
 * Calculate text similarity using Jaccard
 */
export function textSimilarity(text1: string, text2: string): number {
  const tokens1 = tokenize(text1);
  const tokens2 = tokenize(text2);
  return jaccardSimilarity(tokens1, tokens2);
}

/**
 * Create a text vector (term frequency)
 */
export function createTextVector(text: string): Map<string, number> {
  const tokens = tokenize(text);
  const vector = new Map<string, number>();
  
  for (const token of tokens) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  
  return vector;
}

/**
 * Calculate similarity between two memory records
 */
export function memorySimilarity(
  record1: { summary: string; detailedRecord: string; tags: string[] },
  record2: { summary: string; detailedRecord: string; tags: string[] }
): number {
  const text1 = `${record1.summary} ${record1.detailedRecord} ${record1.tags.join(' ')}`;
  const text2 = `${record2.summary} ${record2.detailedRecord} ${record2.tags.join(' ')}`;
  
  return textSimilarity(text1, text2);
}

/**
 * Find most similar items to a query
 */
export function findSimilarItems<T extends { id: MemoryId; summary: string; detailedRecord: string; tags: string[] }>(
  query: string,
  items: T[],
  limit: number = 10
): { item: T; score: number }[] {
  const queryTokens = tokenize(query);
  
  return items
    .map(item => {
      const itemText = `${item.summary} ${item.detailedRecord} ${item.tags.join(' ')}`;
      const itemTokens = tokenize(itemText);
      const similarity = jaccardSimilarity(queryTokens, itemTokens);
      return { item, score: similarity };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

/**
 * Calculate weighted similarity with multiple factors
 */
export function weightedSimilarity(
  factors: {
    text?: number;
    tags?: number;
    category?: number;
    importance?: number;
    recency?: number;
  },
  record1: {
    summary: string;
    detailedRecord: string;
    tags: string[];
    category: string;
    importance: string;
    timestamp: string;
  },
  record2: {
    summary: string;
    detailedRecord: string;
    tags: string[];
    category: string;
    importance: string;
    timestamp: string;
  }
): number {
  let totalWeight = 0;
  let weightedSum = 0;
  
  if (factors.text) {
    const textSim = textSimilarity(
      `${record1.summary} ${record1.detailedRecord}`,
      `${record2.summary} ${record2.detailedRecord}`
    );
    weightedSum += textSim * factors.text;
    totalWeight += factors.text;
  }
  
  if (factors.tags) {
    const tags1 = new Set(record1.tags);
    const tags2 = new Set(record2.tags);
    const tagSim = jaccardSimilarity(tags1, tags2);
    weightedSum += tagSim * factors.tags;
    totalWeight += factors.tags;
  }
  
  if (factors.category) {
    const categorySim = record1.category === record2.category ? 1 : 0;
    weightedSum += categorySim * factors.category;
    totalWeight += factors.category;
  }
  
  if (factors.importance) {
    const importanceOrder = ['critical', 'high', 'medium', 'low', 'info'];
    const imp1 = importanceOrder.indexOf(record1.importance as string);
    const imp2 = importanceOrder.indexOf(record2.importance as string);
    const importanceSim = 1 - Math.abs(imp1 - imp2) / importanceOrder.length;
    weightedSum += importanceSim * factors.importance;
    totalWeight += factors.importance;
  }
  
  if (factors.recency) {
    const date1 = new Date(record1.timestamp).getTime();
    const date2 = new Date(record2.timestamp).getTime();
    const maxAge = Math.max(
      Date.now() - Math.min(date1, date2),
      1000 * 60 * 60 * 24 * 30 // 30 days
    );
    const recencySim = 1 - Math.abs(date1 - date2) / maxAge;
    weightedSum += recencySim * factors.recency;
    totalWeight += factors.recency;
  }
  
  return totalWeight > 0 ? weightedSum / totalWeight : 0;
}
