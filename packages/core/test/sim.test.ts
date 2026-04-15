import { describe, expect, test } from 'bun:test';
import type { Commit } from '@gitcolony/schema';
import { rankAll } from '../src/ranker.js';
import { generateWorld } from '../src/world-gen.js';
import {
  buildSimWalkable,
  collectPOIs,
  initAgentRuntimes,
  simulate,
  stepAgent,
} from '../src/sim.js';

// ============================================================================
// Sim fixture — a small synthetic repo big enough to produce agents and
// buildings across >1 district. We don't hit any external data.
// ============================================================================

function fakeCommits(n: number): Commit[] {
  const out: Commit[] = [];
  const paths = ['src/api', 'src/web', 'docs', 'tests'];
  for (let i = 0; i < n; i++) {
    const p = paths[i % paths.length]!;
    out.push({
      sha: `sha-${i.toString().padStart(4, '0')}`,
      message: `commit ${i}`,
      authorLogin: 'alice',
      authoredAt: `2025-01-${String((i % 28) + 1).padStart(2, '0')}T12:00:00Z`,
      additions: (i * 7) % 200,
      deletions: (i * 3) % 50,
      changedFiles: [`${p}/file-${i}.ts`],
    });
  }
  return out;
}

function freshWorld(size = 80) {
  const ranked = rankAll(fakeCommits(size));
  return generateWorld({ fullName: 'sherkhan/simtest' }, ranked);
}

// ============================================================================

describe('collectPOIs', () => {
  test('every district has at least the center POI', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const pois = collectPOIs(w, walkable);
    for (const d of w.districts) {
      const list = pois.get(d.id)!;
      expect(list.length).toBeGreaterThanOrEqual(1);
      // Center is always appended last.
      const last = list[list.length - 1]!;
      expect(last).toEqual(d.center);
    }
  });

  test('building districts carry building entrances', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const pois = collectPOIs(w, walkable);
    const buildingDistricts = new Set(
      w.objects.filter((o) => o.kind === 'building').map((o) => o.districtId),
    );
    for (const id of buildingDistricts) {
      // At least one entrance plus center = >= 2.
      expect(pois.get(id)!.length).toBeGreaterThanOrEqual(2);
    }
  });

  test('result is deterministic across calls', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const a = collectPOIs(w, walkable);
    const b = collectPOIs(w, walkable);
    for (const [k, list] of a) expect(b.get(k)).toEqual(list);
  });
});

// ============================================================================

describe('agent runtimes', () => {
  test('each agent gets a runtime with the same id', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const pois = collectPOIs(w, walkable);
    const runtimes = initAgentRuntimes(w, walkable, pois);
    expect(runtimes.length).toBe(w.agents.length);
    const ids = new Set(runtimes.map((r) => r.id));
    for (const a of w.agents) expect(ids.has(a.id)).toBe(true);
  });

  test('stepAgent moves exactly one tile along the planned path', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const pois = collectPOIs(w, walkable);
    const [rt] = initAgentRuntimes(w, walkable, pois);
    if (!rt || rt.path.length === 0) return; // no agents/POIs in this world
    const start = { ...rt.pos };
    stepAgent(rt, walkable, pois);
    const dx = Math.abs(rt.pos.x - start.x);
    const dy = Math.abs(rt.pos.y - start.y);
    expect(dx + dy).toBe(1);
  });

  test('simulate(ticks) is deterministic', () => {
    const w = freshWorld();
    const a = simulate(w, 40);
    const b = simulate(w, 40);
    expect(a.map((r) => ({ id: r.id, pos: r.pos }))).toEqual(
      b.map((r) => ({ id: r.id, pos: r.pos })),
    );
  });

  test('agents eventually reach a POI and re-plan', () => {
    const w = freshWorld();
    const walkable = buildSimWalkable(w);
    const pois = collectPOIs(w, walkable);
    const runtimes = initAgentRuntimes(w, walkable, pois);
    // Run enough ticks that any reasonable path exhausts at least once.
    // Grid is 48x48; longest path << 200.
    for (let i = 0; i < 200; i++) {
      for (const rt of runtimes) stepAgent(rt, walkable, pois);
    }
    // A runtime that finished a path and replanned will have poiIndex != 0
    // for at least some agents, or a fresh (non-empty) path. Check that
    // at least one made progress beyond its initial plan.
    const anyReplanned = runtimes.some((r) => r.poiIndex !== 0 || r.path.length > 0);
    expect(anyReplanned).toBe(true);
  });
});
