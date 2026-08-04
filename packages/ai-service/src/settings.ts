export interface AiSettings {
  streaming: boolean;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  maxRetries: number;
}

export const DEFAULT_SETTINGS: AiSettings = {
  streaming: true,
  temperature: 0.4,
  maxTokens: 4096,
  timeoutMs: 30_000,
  maxRetries: 2,
};

const CODE_HINT = /\b(code|function|class|file|implement|implementation|bug|error|refactor|component|hook|module|import|type|interface|variable|method|test|snippet|how does|where is)\b/i;
const SYSTEM_HINT = /\b(endpoint|route|controller|service|repository|database|table|schema|migration|dependency|dependencies|architecture|deploy|docker|compose|env|environment|system|which .*(call|store|use)|where is|related to|connected|pipeline|auth|authentication)\b/i;

export function selectEngines(intentType: string, text: string): { coding: boolean; fullstack: boolean } {
  return {
    coding: ['generate', 'edit', 'transform'].includes(intentType) || CODE_HINT.test(text),
    fullstack: intentType === 'search' || SYSTEM_HINT.test(text),
  };
}
