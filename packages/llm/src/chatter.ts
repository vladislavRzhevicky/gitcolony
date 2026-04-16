// ============================================================================
// Chatter phase — generates an opener + reply pair for a single AI-agent
// meeting event. Runs per-meeting on the client's behalf (HTTP endpoint in
// apps/api), not as a batch worker phase, so the interface is a single
// request/response instead of a chunked map.
//
// Pure: takes two agent personas + a bit of city context and returns two
// short lines. No DB, no caching — the caller (apps/api route) owns
// rate-limit accounting and fallback.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import { getModel, type LLMConfig } from './gemini.js';
import { buildChatterPrompt } from './prompts.js';

export interface MeetingAgent {
  label: string;               // displayName || login || id
  personality: string | null;  // LLM-authored one-liner from the naming phase
  districtName: string | null; // where they spawned
  commitSubject: string | null;// short commit message that birthed them
}

export interface MeetingContext {
  districtName: string | null; // district of the tile where they meet
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
}

export interface MeetingLines {
  opener: string;
  reply: string;
}

const ResponseSchema = z.object({
  opener: z.string().min(1).max(140),
  reply: z.string().min(1).max(140),
});

/**
 * Generates the two lines for a meeting between `first` (opener) and
 * `second` (reply). Returns null on any failure — the caller falls back to
 * the client-side canned phrases so the chat never goes silent.
 *
 * `first` is the lexicographically smaller id by convention, so the opener
 * attribution stays stable for a given pair across retries.
 */
export async function generateMeetingLines(
  first: MeetingAgent,
  second: MeetingAgent,
  context: MeetingContext,
  config: LLMConfig,
): Promise<MeetingLines | null> {
  try {
    const { object } = await generateObject({
      model: getModel(config),
      schema: ResponseSchema,
      maxRetries: 1,
      prompt: buildChatterPrompt(first, second, context),
    });
    return { opener: object.opener, reply: object.reply };
  } catch (err) {
    log.warn('llm meeting lines failed', {
      first: first.label,
      second: second.label,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

