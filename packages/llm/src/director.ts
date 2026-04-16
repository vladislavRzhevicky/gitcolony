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
import { buildDirectorPrompt } from './prompts.js';

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

// External contract — discriminated union over the four actions the sim
// knows how to execute. Keep the set small; every new case is renderer +
// sim work.
export type AgentIntent =
  | { kind: 'goto_poi'; districtId: string; reason?: string }
  | { kind: 'follow_agent'; agentId: string; reason?: string }
  | { kind: 'idle'; ticks: number; reason?: string }
  | { kind: 'wander'; reason?: string };

// Flat schema actually handed to Gemini. Gemini 2.5 Flash-Lite is flaky
// with `anyOf` (what `z.discriminatedUnion` compiles to) and routinely
// generates objects that fail validation. Flat-plus-optionals is robust,
// and we coerce back to the union in `coerceIntent`.
const FlatIntentSchema = z.object({
  kind: z.enum(['goto_poi', 'follow_agent', 'idle', 'wander']),
  districtId: z.string().max(80).optional(),
  agentId: z.string().max(80).optional(),
  // Gemini sometimes returns floats; round + clamp in coerceIntent.
  ticks: z.number().optional(),
  reason: z.string().max(80).optional(),
});

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
      schema: FlatIntentSchema,
      maxRetries: 2,
      prompt: buildDirectorPrompt(input),
    });
    const intent = coerceIntent(object);
    if (!intent) return null;
    return validateReferences(intent, input);
  } catch (err) {
    log.warn('llm director failed', {
      agent: input.subject.label,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Collapse Gemini's flat output onto the discriminated union. Missing or
 * out-of-range fields for the declared `kind` degrade to `wander` rather
 * than dropping the response — the LLM picked a direction, we honour the
 * spirit of it.
 */
function coerceIntent(o: z.infer<typeof FlatIntentSchema>): AgentIntent | null {
  const reason = o.reason;
  switch (o.kind) {
    case 'goto_poi':
      if (o.districtId && o.districtId.length > 0) {
        return { kind: 'goto_poi', districtId: o.districtId, reason };
      }
      return { kind: 'wander', reason };
    case 'follow_agent':
      if (o.agentId && o.agentId.length > 0) {
        return { kind: 'follow_agent', agentId: o.agentId, reason };
      }
      return { kind: 'wander', reason };
    case 'idle': {
      const ticks = Math.max(1, Math.min(40, Math.round(o.ticks ?? 6)));
      return { kind: 'idle', ticks, reason };
    }
    case 'wander':
      return { kind: 'wander', reason };
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

