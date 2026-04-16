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
      prompt: buildPrompt(first, second, context),
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

function buildPrompt(
  first: MeetingAgent,
  second: MeetingAgent,
  context: MeetingContext,
): string {
  return [
    'You voice two inhabitants of a stylized city built from a software repository.',
    'They just crossed paths on the street and exchange two short lines.',
    '',
    'Rules:',
    '- opener: comes from the first inhabitant. Greets or acknowledges the second by their label when natural.',
    '- reply: comes from the second inhabitant. Addresses the first or riffs on the opener.',
    '- Each line: 1 sentence, English, under 100 characters, no trailing period if you can help it.',
    '- Voice reflects the inhabitant\'s personality and their district. Keep it warm and grounded.',
    '- No emoji. Do not mention git, code, commits, or the word "AI".',
    '- Do not put quotes around the lines; return raw sentences.',
    '',
    `First inhabitant: label=${first.label} | district=${first.districtName ?? 'unknown'} | vibe=${first.personality ?? 'steady citizen'} | from commit="${truncate(first.commitSubject ?? '', 80)}"`,
    `Second inhabitant: label=${second.label} | district=${second.districtName ?? 'unknown'} | vibe=${second.personality ?? 'steady citizen'} | from commit="${truncate(second.commitSubject ?? '', 80)}"`,
    context.districtName
      ? `They meet on a street in: ${context.districtName}`
      : 'They meet on a city street.',
    context.timeOfDay ? `Time of day: ${context.timeOfDay}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
