/**
 * Request helpers — construct a well-formed IntelligenceRequest.
 */

import type { IntelligenceRequest } from './types';

let counter = 0;
const genId = () => `req_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** Build an IntelligenceRequest, filling in id + createdAt. */
export function createRequest(
  input: string,
  partial: Partial<Omit<IntelligenceRequest, 'input' | 'createdAt'>> = {},
): IntelligenceRequest {
  return {
    id: partial.id ?? genId(),
    input,
    createdAt: Date.now(),
    ...partial,
  };
}
