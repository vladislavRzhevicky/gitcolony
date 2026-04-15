// ============================================================================
// Naming phase — fills displayName/tagline on new tier-B buildings and
// displayName/personality on new tier-A agents. Layout immutability means
// only objects/agents that did NOT exist in the previous world get LLM-named;
// everything else passes through unchanged.
//
// Fail-soft: if the LLM call returns null (no key, error after retries) the
// world is returned as-is and the pipeline continues.
// ============================================================================

import type { Agent, World, WorldObject } from '@gitcolony/schema';
import {
  generateAgentProfiles,
  generateNames,
  type AgentProfileInput,
  type LLMConfig,
  type NameInput,
} from '@gitcolony/llm';

export interface NamingContext {
  world: World;
  // Set of ids present in the previous world; used to decide which objects
  // and agents are "new" and thus eligible for naming. On first generation
  // pass an empty Set.
  preExistingObjectIds: ReadonlySet<string>;
  preExistingAgentIds: ReadonlySet<string>;
  config: LLMConfig | null;
}

export async function runNamingPhase(ctx: NamingContext): Promise<World> {
  const districtName = new Map(
    ctx.world.districts.map((d) => [d.id, d.name]),
  );

  const newObjects = ctx.world.objects.filter(
    (o) => o.kind === 'building' && !ctx.preExistingObjectIds.has(o.id),
  );
  const newAgents = ctx.world.agents.filter(
    (a) => !ctx.preExistingAgentIds.has(a.id),
  );

  const objectInputs: NameInput[] = newObjects.map((o) => ({
    id: o.id,
    commitMessage: o.message ?? '',
    semanticType: variantToSemantic(o.variant),
    districtName: districtName.get(o.districtId) ?? 'outskirts',
    variant: o.variant,
  }));

  const agentInputs: AgentProfileInput[] = newAgents.map((a) => ({
    id: a.id,
    authorLogin: a.authorLogin ?? null,
    commitMessage: a.message ?? '',
    semanticType: 'agent',
    districtName: districtName.get(a.districtId) ?? 'outskirts',
  }));

  const [namesById, profilesById] = await Promise.all([
    generateNames(objectInputs, ctx.config),
    generateAgentProfiles(agentInputs, ctx.config),
  ]);

  const objects: WorldObject[] = namesById
    ? ctx.world.objects.map((o) => {
        const n = namesById.get(o.id);
        if (!n) return o;
        return { ...o, displayName: n.displayName, tagline: n.tagline };
      })
    : ctx.world.objects;

  const agents: Agent[] = profilesById
    ? ctx.world.agents.map((a) => {
        const p = profilesById.get(a.id);
        if (!p) return a;
        return { ...a, displayName: p.displayName, personality: p.personality };
      })
    : ctx.world.agents;

  return { ...ctx.world, objects, agents };
}

// Variant strings from world-gen carry their semantic prefix
// (workshop/clinic/hall/library/tower/storage/house). Map back to the same
// vocabulary the ranker uses so the LLM has a consistent hint.
function variantToSemantic(variant: string): string {
  const prefix = variant.split('-')[0] ?? 'unknown';
  switch (prefix) {
    case 'workshop':
      return 'feat';
    case 'clinic':
    case 'repair':
      return 'fix';
    case 'hall':
      return 'refactor';
    case 'library':
    case 'archive':
      return 'docs';
    case 'tower':
      return 'test';
    case 'storage':
      return 'chore';
    default:
      return 'unknown';
  }
}
