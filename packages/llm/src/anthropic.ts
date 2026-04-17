// ============================================================================
// Anthropic provider factory.
//
// Wraps the Vercel AI SDK's @ai-sdk/anthropic provider. Kept as the single
// place that imports any AI SDK module, so swapping providers (or routing
// through Vercel's AI Gateway later) is a one-file change.
//
// Config (apiKey, model) is passed in by the caller — this module never
// reads process.env. The worker resolves the user's active key from the
// DB at job time and threads the resolved config through the pipeline.
// ============================================================================

import { createAnthropic } from '@ai-sdk/anthropic';
import type { LanguageModelV1 } from 'ai';

export interface LLMConfig {
  apiKey: string;
  model: string; // e.g. 'claude-opus-4-7'
}

export function getModel(config: LLMConfig): LanguageModelV1 {
  const provider = createAnthropic({ apiKey: config.apiKey });
  return provider(config.model);
}

// ----------------------------------------------------------------------------
// Model discovery
//
// Hits Anthropic's `/v1/models` endpoint with a user-supplied key so the
// settings UI can show an accurate dropdown instead of hard-coding model
// ids. Returns ids as the same shape we feed back into `LLMConfig.model`.
// ----------------------------------------------------------------------------

export interface AnthropicModel {
  id: string; // e.g. 'claude-opus-4-7'
  displayName: string | null;
  description: string | null;
}

interface RawAnthropicModel {
  id?: string;
  display_name?: string;
  type?: string;
}

export async function listAnthropicModels(
  apiKey: string,
): Promise<AnthropicModel[]> {
  const url = 'https://api.anthropic.com/v1/models?limit=1000';
  const res = await fetch(url, {
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `anthropic models fetch failed: ${res.status} ${text.slice(0, 200)}`,
    );
  }
  const body = (await res.json()) as { data?: RawAnthropicModel[] };
  const models = body.data ?? [];
  return models
    .map((m) => ({
      id: m.id ?? '',
      displayName: m.display_name ?? null,
      description: null,
    }))
    .filter((m) => m.id.length > 0);
}
