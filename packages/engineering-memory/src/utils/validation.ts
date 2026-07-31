/**
 * Validation Utility
 * ==================================================================
 * Provides validation functions for Engineering Memory Platform data.
 */

import type {
  MemoryCategory,
  ImportanceLevel,
  ConfidenceLevel,
  EngineeringDomain,
  BugType,
  ArchitectureLayer,
  MemoryReference,
} from '../types';

// ============================================================================
// VALIDATION FUNCTIONS
// ============================================================================

/** All valid memory categories */
const VALID_MEMORY_CATEGORIES: MemoryCategory[] = [
  'mission-created',
  'mission-completed',
  'mission-failed',
  'diagnosis-created',
  'diagnosis-accepted',
  'diagnosis-rejected',
  'patch-accepted',
  'patch-rejected',
  'architecture-decision',
  'review-decision',
  'knowledge-update',
  'documentation-update',
  'code-change',
];

/** All valid importance levels */
const VALID_IMPORTANCE_LEVELS: ImportanceLevel[] = [
  'critical',
  'high',
  'medium',
  'low',
  'info',
];

/** All valid confidence levels */
const VALID_CONFIDENCE_LEVELS: ConfidenceLevel[] = [
  'certain',
  'high',
  'medium',
  'low',
  'unknown',
];

/** All valid engineering domains */
const VALID_ENGINEERING_DOMAINS: EngineeringDomain[] = [
  'authentication',
  'authorization',
  'backend',
  'frontend',
  'networking',
  'database',
  'security',
  'performance',
  'testing',
  'documentation',
  'architecture',
  'devops',
  'build',
  'monitoring',
  'api-design',
  'data-modeling',
];

/** All valid bug types */
const VALID_BUG_TYPES: BugType[] = [
  'null-pointer',
  'type-error',
  'logic-error',
  'race-condition',
  'memory-leak',
  'performance',
  'security',
  'build-error',
  'test-failure',
  'integration-issue',
  'configuration-error',
  'api-contract',
  'data-corruption',
  'unknown',
];

/** All valid architecture layers */
const VALID_ARCHITECTURE_LAYERS: ArchitectureLayer[] = [
  'presentation',
  'application',
  'domain',
  'infrastructure',
  'database',
  'external',
  'build',
  'test',
];

/** All valid reference types */
const VALID_REFERENCE_TYPES: MemoryReference['type'][] = [
  'memory',
  'document',
  'issue',
  'commit',
  'pr',
  'url',
];

// ============================================================================
// VALIDATOR FUNCTIONS
// ============================================================================

/**
 * Validate a memory category
 */
export function isValidMemoryCategory(value: string): value is MemoryCategory {
  return VALID_MEMORY_CATEGORIES.includes(value as MemoryCategory);
}

/**
 * Validate an importance level
 */
export function isValidImportanceLevel(value: string): value is ImportanceLevel {
  return VALID_IMPORTANCE_LEVELS.includes(value as ImportanceLevel);
}

/**
 * Validate a confidence level
 */
export function isValidConfidenceLevel(value: string): value is ConfidenceLevel {
  return VALID_CONFIDENCE_LEVELS.includes(value as ConfidenceLevel);
}

/**
 * Validate an engineering domain
 */
export function isValidEngineeringDomain(value: string): value is EngineeringDomain {
  return VALID_ENGINEERING_DOMAINS.includes(value as EngineeringDomain);
}

/**
 * Validate a bug type
 */
export function isValidBugType(value: string): value is BugType {
  return VALID_BUG_TYPES.includes(value as BugType);
}

/**
 * Validate an architecture layer
 */
export function isValidArchitectureLayer(value: string): value is ArchitectureLayer {
  return VALID_ARCHITECTURE_LAYERS.includes(value as ArchitectureLayer);
}

/**
 * Validate a reference type
 */
export function isValidReferenceType(value: string): value is MemoryReference['type'] {
  return VALID_REFERENCE_TYPES.includes(value as MemoryReference['type']);
}

// ============================================================================
// COMPLEX VALIDATIONS
// ============================================================================

/**
 * Validate a memory reference
 */
export function isValidMemoryReference(ref: MemoryReference): boolean {
  return (
    isValidReferenceType(ref.type) &&
    typeof ref.id === 'string' &&
    ref.id.length > 0 &&
    (ref.description === undefined || typeof ref.description === 'string')
  );
}

/**
 * Validate a string length
 */
export function validateStringLength(
  value: string,
  fieldName: string,
  minLength: number = 0,
  maxLength: number = 10000
): string | null {
  if (typeof value !== 'string') {
    return `${fieldName} must be a string`;
  }
  if (value.length < minLength) {
    return `${fieldName} must be at least ${minLength} characters`;
  }
  if (value.length > maxLength) {
    return `${fieldName} must be at most ${maxLength} characters`;
  }
  return null;
}

/**
 * Validate a non-empty array
 */
export function validateNonEmptyArray<T>(
  value: T[],
  fieldName: string,
  minLength: number = 1
): string | null {
  if (!Array.isArray(value)) {
    return `${fieldName} must be an array`;
  }
  if (value.length < minLength) {
    return `${fieldName} must have at least ${minLength} items`;
  }
  return null;
}

/**
 * Validate an ISO 8601 timestamp
 */
export function isValidTimestamp(value: string): boolean {
  const date = new Date(value);
  return !isNaN(date.getTime()) && value === date.toISOString();
}

/**
 * Validate a project ID
 */
export function isValidProjectId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 100;
}

/**
 * Validate a memory ID
 */
export function isValidMemoryId(value: string): boolean {
  return typeof value === 'string' && value.length > 0 && value.length <= 200;
}

/**
 * Validate file paths
 */
export function areValidFilePaths(paths: string[]): boolean {
  return paths.every(p => typeof p === 'string' && p.length > 0 && p.length <= 500);
}

/**
 * Validate symbol IDs
 */
export function areValidSymbolIds(ids: string[]): boolean {
  return ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 200);
}

/**
 * Validate tags
 */
export function areValidTags(tags: string[]): boolean {
  return tags.every(tag => 
    typeof tag === 'string' && 
    tag.length > 0 && 
    tag.length <= 50 &&
    /^[a-zA-Z0-9_-]+$/.test(tag)
  );
}

// ============================================================================
// VALIDATION ERROR COLLECTION
// ============================================================================

/** Validation error */
export interface ValidationError {
  field: string;
  message: string;
  value: unknown;
}

/** Validation result */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/**
 * Collect validation errors
 */
export class ValidationCollector {
  private errors: ValidationError[] = [];

  /**
   * Add an error
   */
  add(field: string, message: string, value: unknown): void {
    this.errors.push({ field, message, value });
  }

  /**
   * Add error if condition is false
   */
  addIf(field: string, message: string, value: unknown, condition: boolean): void {
    if (!condition) {
      this.add(field, message, value);
    }
  }

  /**
   * Check if valid
   */
  isValid(): boolean {
    return this.errors.length === 0;
  }

  /**
   * Get result
   */
  getResult(): ValidationResult {
    return {
      valid: this.isValid(),
      errors: this.errors,
    };
  }

  /**
   * Get error messages as strings
   */
  getErrorMessages(): string[] {
    return this.errors.map(e => `${e.field}: ${e.message}`);
  }

  /**
   * Throw if invalid
   */
  throwIfInvalid(context: string = 'Validation'): void {
    if (!this.isValid()) {
      throw new Error(
        `${context} failed: ${this.getErrorMessages().join('; ')}`
      );
    }
  }
}

// ============================================================================
// TYPE GUARDS
// ============================================================================

/**
 * Type guard for string arrays
 */
export function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}

/**
 * Type guard for number
 */
export function isNumber(value: unknown): value is number {
  return typeof value === 'number' && !isNaN(value);
}

/**
 * Type guard for boolean
 */
export function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

/**
 * Type guard for object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
