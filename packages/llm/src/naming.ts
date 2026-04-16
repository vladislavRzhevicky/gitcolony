// ============================================================================
// Naming phase — generates displayName + tagline for tier-B buildings.
//
// Pure: takes a list of (id, message, semanticType, districtName) tuples and
// returns a Map keyed by id. Returns null on any failure or missing config —
// the worker treats null as "skip, the world is fine without names".
//
// Batched in chunks so a single request stays under the model's context
// budget while still letting Gemini see thematic neighbors.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import { getModel, type LLMConfig } from './gemini.js';
import { buildNamingPrompt } from './prompts.js';

export interface NameInput {
  id: string;
  commitMessage: string;
  semanticType: string;
  districtName: string;
  variant: string;
}

export interface NameOutput {
  displayName: string;
  tagline: string;
}

const ResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().min(1).max(40),
      tagline: z.string().min(1).max(80),
    }),
  ),
});

const CHUNK_SIZE = 60;

export async function generateNames(
  inputs: readonly NameInput[],
  config: LLMConfig | null,
): Promise<Map<string, NameOutput> | null> {
  if (!config) return null;
  if (inputs.length === 0) return new Map();

  const out = new Map<string, NameOutput>();
  for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
    const chunk = inputs.slice(i, i + CHUNK_SIZE);
    try {
      const { object } = await generateObject({
        model: getModel(config),
        schema: ResponseSchema,
        maxRetries: 2,
        prompt: buildNamingPrompt(chunk),
      });
      for (const item of object.items) {
        out.set(item.id, {
          displayName: item.displayName,
          tagline: item.tagline,
        });
      }
    } catch (err) {
      log.warn('llm naming chunk failed', {
        from: i,
        to: i + chunk.length,
        err: err instanceof Error ? err.message : String(err),
      });
      // continue with remaining chunks; partial naming is still useful
    }
  }
  return out;
}
