// ============================================================================
// Agent profile phase — generates displayName + personality for tier-A agents
// (the "inhabitants"). Personality is a single line that is later fed back
// into the ticker phase so generated scenes feel consistent with each
// inhabitant's character.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import { getModel, type LLMConfig } from './gemini.js';
import { buildPersonalityPrompt } from './prompts.js';

export interface AgentProfileInput {
  id: string;
  authorLogin: string | null;
  commitMessage: string;
  semanticType: string;
  districtName: string;
}

export interface AgentProfileOutput {
  displayName: string;
  personality: string;
}

const ResponseSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      displayName: z.string().min(1).max(40),
      personality: z.string().min(1).max(120),
    }),
  ),
});

const CHUNK_SIZE = 50;

export async function generateAgentProfiles(
  inputs: readonly AgentProfileInput[],
  config: LLMConfig | null,
): Promise<Map<string, AgentProfileOutput> | null> {
  if (!config) return null;
  if (inputs.length === 0) return new Map();

  const out = new Map<string, AgentProfileOutput>();
  for (let i = 0; i < inputs.length; i += CHUNK_SIZE) {
    const chunk = inputs.slice(i, i + CHUNK_SIZE);
    try {
      const { object } = await generateObject({
        model: getModel(config),
        schema: ResponseSchema,
        maxRetries: 2,
        prompt: buildPersonalityPrompt(chunk),
      });
      for (const item of object.items) {
        out.set(item.id, {
          displayName: item.displayName,
          personality: item.personality,
        });
      }
    } catch (err) {
      log.warn('llm personality chunk failed', {
        from: i,
        to: i + chunk.length,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}
