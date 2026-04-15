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

function buildNamingPrompt(items: readonly NameInput[]): string {
  const lines = items.map(
    (it) =>
      `- id=${it.id} | district=${it.districtName} | type=${it.semanticType} | variant=${it.variant} | commit="${truncate(it.commitMessage, 140)}"`,
  );
  return [
    'You name buildings for a stylized city built from a software repository.',
    'Each building represents one git commit. Give it a short evocative name and a one-line tagline.',
    '',
    'Rules:',
    '- displayName: 1-3 words, English, Title Case, max 24 chars. Suggest the building type (workshop, hall, library, tower, clinic, archive, depot, etc.) without being literal.',
    '- tagline: one sentence, English, max 60 chars, no trailing period. Hint at what the commit changed but in city-flavor language. No emoji.',
    '- Do not echo the commit hash. Do not mention git, code, or commits explicitly.',
    '- Each input has a stable id; respond with the same id verbatim.',
    '',
    'Buildings:',
    ...lines,
  ].join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
