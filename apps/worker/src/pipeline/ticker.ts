// ============================================================================
// Ticker phase — composes World.ticker from the freshest commits + the
// current roster of agents and named buildings. Re-emitted whole on each
// run; the previous ticker is discarded.
//
// Fail-soft: if the LLM call returns null we keep the previous ticker
// (so a transient failure during sync doesn't blank out the feed).
// ============================================================================

import type { RankedCommit, World } from '@gitcolony/schema';
import {
  generateTicker,
  type LLMConfig,
  type TickerAgentInput,
  type TickerCommitInput,
  type TickerObjectInput,
} from '@gitcolony/llm';

const RECENT_COMMITS = 20;

export interface TickerContext {
  world: World;
  ranked: readonly RankedCommit[];
  config: LLMConfig | null;
}

export async function runTickerPhase(ctx: TickerContext): Promise<World> {
  const districtName = new Map(
    ctx.world.districts.map((d) => [d.id, d.name]),
  );
  const districtByCommit = new Map<string, string>();
  for (const o of ctx.world.objects) {
    districtByCommit.set(o.commitSha, districtName.get(o.districtId) ?? 'outskirts');
  }
  for (const a of ctx.world.agents) {
    districtByCommit.set(a.commitSha, districtName.get(a.districtId) ?? 'outskirts');
  }

  const recent = [...ctx.ranked]
    .sort((a, b) => b.authoredAt.localeCompare(a.authoredAt))
    .slice(0, RECENT_COMMITS);

  const commits: TickerCommitInput[] = recent.map((c) => ({
    sha: c.sha,
    message: c.message,
    author: c.authorLogin,
    semanticType: c.semanticType,
    districtName: districtByCommit.get(c.sha) ?? null,
  }));

  const agents: TickerAgentInput[] = ctx.world.agents.map((a) => ({
    id: a.id,
    displayName: a.displayName ?? null,
    personality: a.personality ?? null,
    authorLogin: a.authorLogin ?? null,
    districtName: districtName.get(a.districtId) ?? 'outskirts',
  }));

  const objects: TickerObjectInput[] = ctx.world.objects
    .filter((o) => o.kind === 'building')
    .map((o) => ({
      id: o.id,
      displayName: o.displayName ?? null,
      districtName: districtName.get(o.districtId) ?? 'outskirts',
    }));

  const events = await generateTicker({ commits, agents, objects }, ctx.config);

  // Keep previous ticker on transient failure; default to [] if the world
  // pre-dates the ticker field (older persisted worlds carry no `ticker`).
  if (events === null) return { ...ctx.world, ticker: ctx.world.ticker ?? [] };
  return { ...ctx.world, ticker: events };
}
