import { describe, expect, test } from 'bun:test';
import type { Commit, RankedCommit } from '@gitcolony/schema';
import { rankAll } from '../src/ranker.js';
import { extendWorld, generateWorld } from '../src/world-gen.js';
import { buildOccupiedMask, getBit } from '../src/grid.js';

// ============================================================================
// Test helpers: synthetic commits that exercise each tier + district fallback.
// ============================================================================

function commit(partial: Partial<Commit> & { sha: string }): Commit {
  return {
    sha: partial.sha,
    message: partial.message ?? `feat: ${partial.sha}`,
    authorLogin: partial.authorLogin ?? 'alice',
    authoredAt: partial.authoredAt ?? '2024-01-01T00:00:00Z',
    additions: partial.additions ?? 200,
    deletions: partial.deletions ?? 50,
    changedFiles: partial.changedFiles ?? ['src/index.ts'],
  };
}

function syntheticRepoCommits(count: number): Commit[] {
  const dirs = ['src', 'docs', 'tests', 'scripts'];
  const semantics = [
    { kind: 'feat', add: 800, del: 50 },   // Tier A-ish
    { kind: 'fix', add: 40, del: 5 },
    { kind: 'docs', add: 10, del: 1 },
    { kind: 'chore', add: 2, del: 2 },
    { kind: 'refactor', add: 300, del: 200 },
  ];
  const out: Commit[] = [];
  for (let i = 0; i < count; i++) {
    const d = dirs[i % dirs.length]!;
    const s = semantics[i % semantics.length]!;
    out.push({
      sha: `sha${i.toString().padStart(4, '0')}`,
      message: `${s.kind}: commit ${i}`,
      authorLogin: 'alice',
      authoredAt: new Date(2024, 0, 1 + i).toISOString(),
      additions: s.add,
      deletions: s.del,
      changedFiles: [`${d}/file${i}.ts`],
    });
  }
  return out;
}

// ============================================================================
// Determinism: invariant #1
// ============================================================================

describe('determinism', () => {
  test('same repo + commits produce byte-identical worlds', () => {
    const commits = syntheticRepoCommits(80);
    const ranked = rankAll(commits);
    const a = generateWorld({ fullName: 'alice/repo' }, ranked);
    const b = generateWorld({ fullName: 'alice/repo' }, ranked);
    // Strip the generation timestamp — everything else must match.
    const strip = (w: typeof a) => ({ ...w, generatedAt: '' });
    expect(strip(a)).toEqual(strip(b));
  });

  test('different repo names produce different seeds and layouts', () => {
    const ranked = rankAll(syntheticRepoCommits(20));
    const a = generateWorld({ fullName: 'alice/one' }, ranked);
    const b = generateWorld({ fullName: 'alice/two' }, ranked);
    expect(a.seed).not.toBe(b.seed);
  });
});

// ============================================================================
// Invariant #3: outskirts always present
// ============================================================================

describe('outskirts', () => {
  test('empty ranked list still produces outskirts', () => {
    const w = generateWorld({ fullName: 'alice/empty' }, []);
    expect(w.districts.find((d) => d.isOutskirts)).toBeDefined();
  });

  test('commits with no primaryPath route to outskirts', () => {
    const c = commit({ sha: 'root1', changedFiles: ['README.md'] });
    const ranked = rankAll([c]);
    const w = generateWorld({ fullName: 'alice/r' }, ranked);
    const placed = [
      ...w.objects.filter((o) => o.commitSha === 'root1'),
      ...w.agents.filter((a) => a.commitSha === 'root1'),
    ];
    for (const p of placed) expect(p.districtId).toBe('d-outskirts');
  });
});

// ============================================================================
// Invariant #4: stable ids, idempotent ingest
// ============================================================================

describe('id stability', () => {
  test('objects use obj-<sha> and agents use agent-<sha>', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w = generateWorld({ fullName: 'alice/r' }, ranked);
    for (const o of w.objects) expect(o.id).toBe(`obj-${o.commitSha}`);
    for (const a of w.agents) expect(a.id).toBe(`agent-${a.commitSha}`);
  });

  test('re-extending with overlapping commits does not duplicate', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w0 = generateWorld({ fullName: 'alice/r' }, ranked);
    const freshRanked = rankAll(syntheticRepoCommits(5).map((c) => ({ ...c, sha: `new${c.sha}` })));
    const w1 = extendWorld(w0, freshRanked as RankedCommit[]);
    // Feed the SAME fresh commits again — should be a no-op at object level.
    const w2 = extendWorld(w1, freshRanked as RankedCommit[]);
    expect(w2.objects.length).toBe(w1.objects.length);
    expect(w2.agents.length).toBe(w1.agents.length);
  });
});

// ============================================================================
// Collision resolution: the whole point of this round
// ============================================================================

describe('collision resolution', () => {
  test('no two objects share a tile after generation', () => {
    const ranked = rankAll(syntheticRepoCommits(200));
    const w = generateWorld({ fullName: 'alice/busy' }, ranked);
    const occupied = new Set<string>();
    for (const o of w.objects) {
      for (const t of o.footprint) {
        const k = `${t.x},${t.y}`;
        expect(occupied.has(k)).toBe(false);
        occupied.add(k);
      }
    }
  });

  test('agent spawn tiles do not overlap object footprints', () => {
    const ranked = rankAll(syntheticRepoCommits(150));
    const w = generateWorld({ fullName: 'alice/mix' }, ranked);
    const occ = buildOccupiedMask(w.grid, w.objects);
    for (const a of w.agents) {
      // spawn was marked before any later building/decor could take it,
      // but later placements must not have overlapped it. So occupancy of
      // spawn tile must be 0 from *objects alone*.
      expect(getBit(occ, a.spawn.x, a.spawn.y)).toBe(0);
    }
  });

  test('footprints stay inside the grid', () => {
    const ranked = rankAll(syntheticRepoCommits(200));
    const w = generateWorld({ fullName: 'alice/edge' }, ranked);
    for (const o of w.objects) {
      for (const t of o.footprint) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(w.grid.w);
        expect(t.y).toBeLessThan(w.grid.h);
      }
    }
  });

  test('extendWorld respects existing object footprints', () => {
    const base = rankAll(syntheticRepoCommits(60));
    const w0 = generateWorld({ fullName: 'alice/ext' }, base);
    const extra = rankAll(
      syntheticRepoCommits(40).map((c, i) => ({
        ...c,
        sha: `x${i}`,
        authoredAt: new Date(2025, 0, 1 + i).toISOString(),
      })),
    );
    const w1 = extendWorld(w0, extra);

    const occupied = new Set<string>();
    for (const o of w1.objects) {
      for (const t of o.footprint) {
        const k = `${t.x},${t.y}`;
        expect(occupied.has(k)).toBe(false);
        occupied.add(k);
      }
    }
  });
});

// ============================================================================
// Invariant #2: layout immutability on sync
// ============================================================================

describe('layout immutability on extend', () => {
  test('seed, grid, archetype, palette, districts unchanged by extend', () => {
    const base = rankAll(syntheticRepoCommits(50));
    const w0 = generateWorld({ fullName: 'alice/imm' }, base);
    const extra = rankAll(
      syntheticRepoCommits(30).map((c, i) => ({ ...c, sha: `ex${i}` })),
    );
    const w1 = extendWorld(w0, extra);

    expect(w1.seed).toBe(w0.seed);
    expect(w1.archetype).toBe(w0.archetype);
    expect(w1.palette).toBe(w0.palette);
    expect(w1.grid).toEqual(w0.grid);
    expect(w1.districts).toEqual(w0.districts);
  });

  test('existing objects/agents survive extend unchanged', () => {
    const base = rankAll(syntheticRepoCommits(40));
    const w0 = generateWorld({ fullName: 'alice/surv' }, base);
    const extra = rankAll(syntheticRepoCommits(10).map((c, i) => ({ ...c, sha: `e${i}` })));
    const w1 = extendWorld(w0, extra);

    for (const o of w0.objects) {
      const survived = w1.objects.find((x) => x.id === o.id);
      expect(survived).toEqual(o);
    }
  });
});
