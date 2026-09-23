export interface AiSettings {
  streaming: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
  /**
   * APPLICATION ENFORCED SOVEREIGN MODE.
   * When true: cloud AI inference endpoints are blocked at the routing layer.
   * AURA will only use local/private model endpoints (Ollama, private GPU servers).
   * If no private model is available, AURA reports the gap honestly rather than
   * falling back to cloud silently.
   *
   * This is software-level enforcement, NOT a physical air-gap guarantee.
   * Physical isolation requires separate infrastructure controls.
   */
  sovereignMode: boolean;
}

export const DEFAULT_SETTINGS: AiSettings = {
  streaming: true,
  temperature: 0.4,
  maxTokens: 4096,
  timeoutMs: 30_000,
  maxRetries: 2,
  sovereignMode: false,
};

const CODE_HINT = /\b(code|function|class|file|implement|implementation|bug|error|refactor|component|hook|module|import|type|interface|variable|method|test|snippet|how does|where is)\b/i;
const SYSTEM_HINT = /\b(endpoint|route|controller|service|repository|database|table|schema|migration|dependency|dependencies|architecture|deploy|docker|compose|env|environment|system|which .*(call|store|use)|where is|related to|connected|pipeline|auth|authentication)\b/i;

export function selectEngines(intentType: string, text: string): { coding: boolean; fullstack: boolean } {
  return {
    coding: ['generate', 'edit', 'transform'].includes(intentType) || CODE_HINT.test(text),
    fullstack: intentType === 'search' || SYSTEM_HINT.test(text),
  };
}
