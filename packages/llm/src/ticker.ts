// ============================================================================
// Ticker phase — composes the city news feed.
//
// Inputs: most recent commits + a roster of known inhabitants (with
// personality) + a sample of named buildings. Output: 5-10 short scenes,
// each optionally referencing an agentId and/or objectId so the renderer can
// later light up the referenced entity when its scene is on-screen.
//
// Re-emitted whole on every sync (does not accumulate). Returns null on
// failure / missing config.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import type { TickerEvent } from '@gitcolony/schema';
import { getModel, type LLMConfig } from './gemini.js';
import { buildTickerPrompt } from './prompts.js';

export interface TickerCommitInput {
  sha: string;
  message: string;
  author: string | null;
  semanticType: string;
  districtName: string | null;
}

export interface TickerAgentInput {
  id: string;
  displayName: string | null;
  personality: string | null;
  authorLogin: string | null;
  districtName: string;
}

export interface TickerObjectInput {
  id: string;
  displayName: string | null;
  districtName: string;
}

export interface TickerInput {
  commits: readonly TickerCommitInput[];
  agents: readonly TickerAgentInput[];
  objects: readonly TickerObjectInput[];
}

const ResponseSchema = z.object({
  events: z
    .array(
      z.object({
        text: z.string().min(4).max(160),
        author: z.string().nullable().optional(),
        commitSha: z.string().nullable().optional(),
        agentId: z.string().nullable().optional(),
        objectId: z.string().nullable().optional(),
      }),
    )
    .min(1)
    .max(12),
});

export async function generateTicker(
  input: TickerInput,
  config: LLMConfig | null,
): Promise<TickerEvent[] | null> {
  if (!config) return null;
  if (input.commits.length === 0) return [];

  try {
    const { object } = await generateObject({
      model: getModel(config),
      schema: ResponseSchema,
      maxRetries: 2,
      prompt: buildTickerPrompt(input),
    });
    const now = new Date().toISOString();
    return object.events.map((e, idx) => ({
      id: `tk-${e.commitSha ?? input.commits[0]?.sha ?? 'na'}-${idx}`,
      text: e.text,
      author: e.author ?? null,
      commitSha: e.commitSha ?? null,
      agentId: e.agentId ?? null,
      objectId: e.objectId ?? null,
      createdAt: now,
    }));
  } catch (err) {
    log.warn('llm ticker failed', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

