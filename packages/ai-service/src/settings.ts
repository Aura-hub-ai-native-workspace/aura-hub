import type { Sensitivity } from './provider/router';

export interface AiSettings {
  streaming: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /**
   * How sensitive this workspace's context is, and therefore where it may
   * be sent. See `provider/router.ts`.
   *
   * `internal` is the default rather than `secret` because `secret` means
   * "this may only ever run on a model on this machine", and defaulting
   * every user into that would silently disable AI for anyone without a
   * local model. Raising it is one setting; the router enforces it as a
   * hard gate, ahead of capability, cost and availability.
   */
  sensitivity: Sensitivity;
}

export const DEFAULT_SETTINGS: AiSettings = {
  streaming: true,
  temperature: 0.4,
  maxTokens: 4096,
  timeoutMs: 30_000,
  maxRetries: 2,
  sensitivity: 'internal',
};

const CODE_HINT = /\b(code|function|class|file|implement|implementation|bug|error|refactor|component|hook|module|import|type|interface|variable|method|test|snippet|how does|where is)\b/i;
const SYSTEM_HINT = /\b(endpoint|route|controller|service|repository|database|table|schema|migration|dependency|dependencies|architecture|deploy|docker|compose|env|environment|system|which .*(call|store|use)|where is|related to|connected|pipeline|auth|authentication)\b/i;

export function selectEngines(intentType: string, text: string): { coding: boolean; fullstack: boolean } {
  return {
    coding: ['generate', 'edit', 'transform'].includes(intentType) || CODE_HINT.test(text),
    fullstack: intentType === 'search' || SYSTEM_HINT.test(text),
  };
}
