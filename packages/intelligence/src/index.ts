/**
 * @aura/intelligence — request pre-processing contract.
 * ==================================================================
 * Provides the shared type vocabulary plus the two pre-processing stages
 * the AI pipeline uses before assembling context and calling a provider:
 * intent classification and prompt enhancement.
 *
 * (The former end-to-end kernel — specialized engines, provider adapters,
 * task router and response pipeline — was removed once ai-service began
 * driving the model runtime directly. Only the pieces still in the live
 * path remain.)
 */

// Shared contract vocabulary (types only).
export * from './types';

// Request builder.
export { createRequest } from './request';

// Stage 1 — Intent Classifier.
export { type IntentClassifier, KeywordIntentClassifier } from './pipeline/intentClassifier';

// Stage 2 — Prompt Enhancer.
export { type PromptEnhancer, TemplatePromptEnhancer } from './pipeline/promptEnhancer';
