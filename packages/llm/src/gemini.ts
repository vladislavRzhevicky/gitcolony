// ============================================================================
// Gemini provider factory.
//
// Wraps the Vercel AI SDK's @ai-sdk/google provider. Kept as the single
// place that imports any AI SDK module, so swapping providers (or routing
// through Vercel's AI Gateway later) is a one-file change.
//
// Config (apiKey, model) is passed in by the caller — this module never
// reads process.env. Worker reads env at startup and threads the resolved
// config through the pipeline.
// ============================================================================

import { createGoogleGenerativeAI } from '@ai-sdk/google';
import type { LanguageModelV1 } from 'ai';

export interface LLMConfig {
  apiKey: string;
  model: string; // e.g. 'gemini-2.5-flash-lite'
}

export function getModel(config: LLMConfig): LanguageModelV1 {
  const provider = createGoogleGenerativeAI({ apiKey: config.apiKey });
  return provider(config.model);
}
