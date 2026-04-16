// ============================================================================
// Director phase — picks a single next-action intent for one AI citizen.
//
// The web sim calls this periodically (staggered per agent) to ask the LLM
// "what should this inhabitant do next?". The reply is a small discriminated
// union the sim knows how to execute — goto a district, follow another
// agent, loiter for a bit, or just keep wandering. The deterministic core
// stays untouched; intents are a client-side layer on top.
//
// Pure: no DB, no caching. The caller (apps/api route) owns rate-limit
// accounting; the web client owns scheduling and fallback.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import { getModel, type LLMConfig } from './gemini.js';

export interface DirectorAgent {
  id: string;
  label: string;
  personality: string | null;
  homeDistrictName: string | null;
  currentDistrictName: string | null;
  commitSubject: string | null;
}

export interface DirectorDistrict {
  id: string;
  name: string;
  /** Inhabitants whose commit landed in this district. For "popular" hints. */
  population: number;
  isHome: boolean;
  isCurrent: boolean;
}

export interface DirectorPeer {
  id: string;
  label: string;
  districtName: string | null;
}

export interface DirectorInput {
  subject: DirectorAgent;
  districts: DirectorDistrict[];
  // Nearby AI peers (small list, label + district). The LLM may pick one as
  // a `follow_agent` target.
  peers: DirectorPeer[];
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
}

// Discriminated union over the four actions the sim knows how to execute.
// Keep the set small — every new case is renderer + sim work.
export const AgentIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('goto_poi'),
    districtId: z.string().min(1).max(80),
    reason: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('follow_agent'),
    agentId: z.string().min(1).max(80),
    reason: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('idle'),
    // How many sim ticks to loiter. 1 tick ≈ 0.9s in the web client; the
    // server clamps to a reasonable range so a stuck LLM can't freeze an
    // agent for minutes.
    ticks: z.number().int().min(1).max(40),
    reason: z.string().max(80).optional(),
  }),
  z.object({
    kind: z.literal('wander'),
    reason: z.string().max(80).optional(),
  }),
]);

export type AgentIntent = z.infer<typeof AgentIntentSchema>;

/**
 * Asks the LLM to pick one next action for the subject agent. Returns null
 * on any failure; the client falls back to `wander`, which matches the
 * default deterministic POI rotation.
 */
export async function pickAgentIntent(
  input: DirectorInput,
  config: LLMConfig,
): Promise<AgentIntent | null> {
  try {
    const { object } = await generateObject({
      model: getModel(config),
      schema: AgentIntentSchema,
      maxRetries: 1,
      prompt: buildPrompt(input),
    });
    return validateReferences(object, input);
  } catch (err) {
    log.warn('llm director failed', {
      agent: input.subject.label,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Drops intents that reference unknown districts / agents — hallucinated
 * ids would cause a silent no-op downstream, so we fall back to wander and
 * let the caller apply the safe default.
 */
function validateReferences(
  intent: AgentIntent,
  input: DirectorInput,
): AgentIntent {
  if (intent.kind === 'goto_poi') {
    const known = input.districts.some((d) => d.id === intent.districtId);
    if (!known) return { kind: 'wander', reason: intent.reason };
  }
  if (intent.kind === 'follow_agent') {
    const known = input.peers.some((p) => p.id === intent.agentId);
    if (!known) return { kind: 'wander', reason: intent.reason };
  }
  return intent;
}

function buildPrompt(input: DirectorInput): string {
  const { subject, districts, peers, timeOfDay } = input;
  const districtLines = districts
    .map((d) => {
      const tags = [
        d.isHome ? 'home' : '',
        d.isCurrent ? 'here' : '',
      ]
        .filter(Boolean)
        .join(',');
      const suffix = tags ? ` [${tags}]` : '';
      return `  - id=${d.id} | name=${d.name} | pop=${d.population}${suffix}`;
    })
    .join('\n');
  const peerLines = peers.length
    ? peers
        .map((p) => `  - id=${p.id} | label=${p.label} | in=${p.districtName ?? 'unknown'}`)
        .join('\n')
    : '  (no peers nearby)';

  return [
    'You direct one inhabitant of a small stylized city built from a code repository.',
    'Pick exactly one next action from the available tools. Stay in character.',
    '',
    'Subject:',
    `  label=${subject.label} | home=${subject.homeDistrictName ?? 'unknown'} | current=${subject.currentDistrictName ?? 'unknown'}`,
    `  vibe=${subject.personality ?? 'steady citizen'}`,
    `  from commit="${truncate(subject.commitSubject ?? '', 80)}"`,
    '',
    'Districts (id, name, population):',
    districtLines || '  (none)',
    '',
    'AI peers in the colony:',
    peerLines,
    timeOfDay ? `\nTime of day: ${timeOfDay}` : '',
    '',
    'Rules:',
    '- Prefer variety over repetition. Do not always `goto_poi`.',
    '- `goto_poi.districtId` MUST be one of the district ids listed above.',
    '- `follow_agent.agentId` MUST be one of the AI peer ids listed above.',
    '- `idle.ticks` is 1..40. Reasonable loiter is 4..12.',
    '- `reason` is optional, under 80 chars, in-character third-person.',
  ]
    .filter(Boolean)
    .join('\n');
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
