// ============================================================================
// Gemini provider factory.
//
// Wraps the Vercel AI SDK's @ai-sdk/google provider. Kept as the single
// place that imports any AI SDK module, so swapping providers (or routing
// through Vercel's AI Gateway later) is a one-file change.
//
// Config (apiKey, model) is passed in by the caller — this module never
// reads process.env. The worker resolves the user's active key from the
// DB at job time and threads the resolved config through the pipeline.
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

// ----------------------------------------------------------------------------
// Model discovery
//
// Hits Google's public `v1beta/models` endpoint with a user-supplied key so
// the settings UI can show an accurate dropdown instead of hard-coding model
// ids. Returns only models that advertise `generateContent` (the method the
// AI SDK uses under the hood), and strips the `models/` name prefix so the
// returned ids are the same shape we feed back into `LLMConfig.model`.
// ----------------------------------------------------------------------------

export interface GeminiModel {
  id: string; // e.g. 'gemini-2.5-flash-lite'
  displayName: string | null;
  description: string | null;
}

interface RawGeminiModel {
  name?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

export async function listGeminiModels(apiKey: string): Promise<GeminiModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `gemini models fetch failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { models?: RawGeminiModel[] };
  const models = body.models ?? [];
  return models
    .filter((m) =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes('generateContent'),
    )
    .map((m) => {
      const raw = m.name ?? '';
      const id = raw.startsWith('models/') ? raw.slice('models/'.length) : raw;
      return {
        id,
        displayName: m.displayName ?? null,
        description: m.description ?? null,
      };
    })
    .filter((m) => m.id.length > 0);
}
