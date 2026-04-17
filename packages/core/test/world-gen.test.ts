import { describe, expect, test } from 'bun:test';
import type { Commit, RankedCommit } from '@gitcolony/schema';
import { rankAll } from '../src/ranker.js';
import { extendWorld, generateWorld } from '../src/world-gen.js';
import { computeHouseCounts, totalHouses } from '../src/houseCounts.js';
import { buildOccupiedMask, getBit } from '../src/grid.js';

// ============================================================================
// Test helpers: synthetic commits that exercise a range of commit counts so
// the aggregated-house pipeline produces meaningful district mixes.
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
    { kind: 'feat', add: 800, del: 50 },
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
    const a = generateWorld({ fullName: 'alice/repo', totalCommits: 6000 }, ranked);
    const b = generateWorld({ fullName: 'alice/repo', totalCommits: 6000 }, ranked);
    const strip = (w: typeof a) => ({ ...w, generatedAt: '' });
    expect(strip(a)).toEqual(strip(b));
  });

  test('different repo names produce different seeds', () => {
    const ranked = rankAll(syntheticRepoCommits(20));
    const a = generateWorld({ fullName: 'alice/one' }, ranked);
    const b = generateWorld({ fullName: 'alice/two' }, ranked);
    expect(a.seed).not.toBe(b.seed);
  });
});

// ============================================================================
// Invariant #3: outskirts district always present
// ============================================================================

describe('outskirts', () => {
  test('empty ranked list still produces outskirts', () => {
    const w = generateWorld({ fullName: 'alice/empty' }, []);
    expect(w.districts.find((d) => d.isOutskirts)).toBeDefined();
  });

  test('repos with any scale still carry outskirts', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w = generateWorld({ fullName: 'alice/r', totalCommits: 40 }, ranked);
    expect(w.districts.find((d) => d.isOutskirts)).toBeDefined();
  });
});

// ============================================================================
// Invariant #4: stable ids, idempotent sync
// ============================================================================

describe('id stability', () => {
  test('buildings use obj-h-<districtId>-<slotIdx>', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w = generateWorld({ fullName: 'alice/r', totalCommits: 5000 }, ranked);
    for (const o of w.objects) {
      expect(o.id.startsWith('obj-h-')).toBe(true);
      expect(o.id).toContain(o.districtId);
    }
  });

  test('agents use agent-<sha>', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w = generateWorld({ fullName: 'alice/r', totalCommits: 5000 }, ranked);
    for (const a of w.agents) expect(a.id).toBe(`agent-${a.commitSha}`);
  });

  test('re-extending with overlapping commits does not duplicate agents', () => {
    const ranked = rankAll(syntheticRepoCommits(40));
    const w0 = generateWorld({ fullName: 'alice/r', totalCommits: 5000 }, ranked);
    const freshRanked = rankAll(syntheticRepoCommits(5).map((c) => ({ ...c, sha: `new${c.sha}` })));
    const w1 = extendWorld(w0, freshRanked as RankedCommit[]);
    const w2 = extendWorld(w1, freshRanked as RankedCommit[]);
    expect(w2.objects.length).toBe(w1.objects.length);
    expect(w2.agents.length).toBe(w1.agents.length);
  });
});

// ============================================================================
// Collision resolution: no two objects share a tile, footprints stay in grid
// ============================================================================

describe('collision resolution', () => {
  test('no two objects share a tile after generation', () => {
    const ranked = rankAll(syntheticRepoCommits(200));
    const w = generateWorld({ fullName: 'alice/busy', totalCommits: 30000 }, ranked);
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
    const w = generateWorld({ fullName: 'alice/mix', totalCommits: 20000 }, ranked);
    const occ = buildOccupiedMask(w.grid, w.objects);
    for (const a of w.agents) {
      expect(getBit(occ, a.spawn.x, a.spawn.y)).toBe(0);
    }
  });

  test('footprints stay inside the grid', () => {
    const ranked = rankAll(syntheticRepoCommits(200));
    const w = generateWorld({ fullName: 'alice/edge', totalCommits: 50000 }, ranked);
    for (const o of w.objects) {
      for (const t of o.footprint) {
        expect(t.x).toBeGreaterThanOrEqual(0);
        expect(t.y).toBeGreaterThanOrEqual(0);
        expect(t.x).toBeLessThan(w.grid.w);
        expect(t.y).toBeLessThan(w.grid.h);
      }
    }
  });
});

// ============================================================================
// Invariant #2: layout immutability on extend
// ============================================================================

describe('layout immutability on extend', () => {
  test('seed, grid, archetype, palette, districts unchanged by extend', () => {
    const base = rankAll(syntheticRepoCommits(50));
    const w0 = generateWorld({ fullName: 'alice/imm', totalCommits: 50 }, base);
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

  test('existing objects survive extend unchanged', () => {
    const base = rankAll(syntheticRepoCommits(40));
    const w0 = generateWorld({ fullName: 'alice/surv', totalCommits: 500 }, base);
    const extra = rankAll(syntheticRepoCommits(10).map((c, i) => ({ ...c, sha: `e${i}` })));
    const w1 = extendWorld(w0, extra);

    for (const o of w0.objects) {
      const survived = w1.objects.find((x) => x.id === o.id);
      expect(survived).toEqual(o);
    }
  });
});

// ============================================================================
// House-count curves — spec checkpoints
// ============================================================================

describe('computeHouseCounts', () => {
  test('tiny repo still produces a populated village', () => {
    const counts = computeHouseCounts(100);
    expect(counts.skyscrapers).toBe(0);
    expect(totalHouses(counts)).toBeGreaterThanOrEqual(8);
  });

  test('skyscrapers gated behind C >= 6000', () => {
    expect(computeHouseCounts(999).skyscrapers).toBe(0);
    // LARGE_REPO_THRESHOLD (1500) turns on the skyscraper priority slot, but
    // floor(C / 6000) keeps the cap at zero until commit count reaches 6000.
    expect(computeHouseCounts(5999).skyscrapers).toBe(0);
    expect(computeHouseCounts(6000).skyscrapers).toBeGreaterThanOrEqual(1);
  });

  test('max building count is hard-capped at 46', () => {
    expect(totalHouses(computeHouseCounts(500_000))).toBeLessThanOrEqual(46);
    expect(totalHouses(computeHouseCounts(50_000))).toBeLessThanOrEqual(46);
  });

  test('explicit cap tightens the hard ceiling', () => {
    const counts = computeHouseCounts(500_000, 20);
    expect(totalHouses(counts)).toBeLessThanOrEqual(20);
  });

  test('50k commits yields ~8 skyscrapers', () => {
    const counts = computeHouseCounts(50_000);
    expect(counts.skyscrapers).toBeGreaterThanOrEqual(7);
    expect(counts.skyscrapers).toBeLessThanOrEqual(10);
  });

  test('small repos prioritise low-rise over towers', () => {
    const counts = computeHouseCounts(500);
    expect(counts.skyscrapers).toBe(0);
    expect(counts.oneFloor).toBeGreaterThan(0);
  });
});
