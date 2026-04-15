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

function buildTickerPrompt(input: TickerInput): string {
  const commits = input.commits
    .slice(0, 20)
    .map(
      (c) =>
        `- sha=${c.sha} | author=${c.author ?? 'anon'} | district=${c.districtName ?? 'unknown'} | type=${c.semanticType} | "${truncate(c.message, 140)}"`,
    );

  // Cap roster sizes so the prompt stays small. Pick agents that have a
  // displayName first — they make better scene actors than anonymous ones.
  const agents = [...input.agents]
    .sort((a, b) => Number(!!b.displayName) - Number(!!a.displayName))
    .slice(0, 30)
    .map(
      (a) =>
        `- id=${a.id} | name=${a.displayName ?? '(anon)'} | district=${a.districtName} | personality="${truncate(a.personality ?? '', 100)}"`,
    );

  const objects = [...input.objects]
    .filter((o) => o.displayName)
    .slice(0, 30)
    .map(
      (o) =>
        `- id=${o.id} | name=${o.displayName} | district=${o.districtName}`,
    );

  return [
    'You are the city ticker for a software-repository-as-city visualisation.',
    'Compose 5-10 short, present-tense scenes from the most recent commits and the roster below.',
    '',
    'Rules:',
    '- text: one sentence per event, English, max 110 chars, no trailing period, no emoji.',
    '- Reference inhabitants by displayName when you know one; otherwise mention the author handle as @handle.',
    '- When an event clearly involves a roster agent or building, set agentId / objectId to its id from the roster.',
    '- commitSha and author should match the source commit when applicable.',
    '- Mix moods: a couple of construction events, a couple of social events, the rest commit-derived news.',
    '',
    'Recent commits:',
    ...commits,
    '',
    'Inhabitants on file:',
    ...(agents.length > 0 ? agents : ['(none)']),
    '',
    'Named buildings:',
    ...(objects.length > 0 ? objects : ['(none)']),
  ].join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
