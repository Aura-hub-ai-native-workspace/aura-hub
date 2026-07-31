/**
 * ID Generator Utility
 * ==================================================================
 * Generates unique identifiers for all entities in the Engineering Memory Platform.
 */

let counter = 0;

/**
 * Generate a unique ID with a prefix
 */
export function generateId(prefix: string): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  const seq = (++counter).toString(36);
  return `${prefix}_${timestamp}_${random}_${seq}`;
}

/**
 * Generate a short unique ID
 */
export function generateShortId(): string {
  return generateId('id');
}

/**
 * Generate a memory-specific ID
 */
export function generateMemoryId(): string {
  return generateId('mem');
}

/**
 * Generate a pattern-specific ID
 */
export function generatePatternId(): string {
  return generateId('pat');
}

/**
 * Generate a decision-specific ID
 */
export function generateDecisionId(): string {
  return generateId('dec');
}

/**
 * Generate a bug-specific ID
 */
export function generateBugId(): string {
  return generateId('bug');
}

/**
 * Generate a timeline-specific ID
 */
export function generateTimelineId(): string {
  return generateId('tl');
}

/**
 * Generate a graph node ID
 */
export function generateGraphNodeId(): string {
  return generateId('node');
}

/**
 * Generate a graph edge ID
 */
export function generateGraphEdgeId(): string {
  return generateId('edge');
}
