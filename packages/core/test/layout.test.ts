import { describe, expect, test } from 'bun:test';
import type { Commit } from '@gitcolony/schema';
import { rankAll } from '../src/ranker.js';
import {
  buildProximityGraph,
  chooseTopology,
  layoutDistricts,
} from '../src/layout.js';
import { createRng } from '../src/seed.js';
import { districtBBox } from '../src/grid.js';

const GRID = { w: 48, h: 48 };
const DSIZE = { w: 10, h: 10 };

function commit(
  sha: string,
  changedFiles: string[],
  extra: Partial<Commit> = {},
): Commit {
  return {
    sha,
    message: extra.message ?? 'feat: work',
    authorLogin: extra.authorLogin ?? 'alice',
    authoredAt: extra.authoredAt ?? '2024-01-01T00:00:00Z',
    additions: extra.additions ?? 100,
    deletions: extra.deletions ?? 20,
    changedFiles,
  };
}

// ============================================================================
// Proximity graph
// ============================================================================

describe('buildProximityGraph', () => {
  test('counts per-dir commits', () => {
    const ranked = rankAll([
      commit('a', ['src/a.ts']),
      commit('b', ['src/b.ts', 'docs/readme.md']),
      commit('c', ['docs/readme.md']),
    ]);
    const g = buildProximityGraph(ranked);
    expect(g.weight.get('src')).toBe(2);
    expect(g.weight.get('docs')).toBe(2);
  });

  test('adds symmetric edge when two dirs co-touched', () => {
    const ranked = rankAll([commit('a', ['src/a.ts', 'tests/a.test.ts'])]);
    const g = buildProximityGraph(ranked);
    expect(g.edges.get('src')?.get('tests')).toBe(1);
    expect(g.edges.get('tests')?.get('src')).toBe(1);
  });

  test('edge weight equals number of co-touching commits', () => {
    const ranked = rankAll([
      commit('a', ['src/a.ts', 'tests/a.test.ts']),
      commit('b', ['src/b.ts', 'tests/b.test.ts']),
      commit('c', ['src/c.ts', 'tests/c.test.ts']),
    ]);
    const g = buildProximityGraph(ranked);
    expect(g.edges.get('src')?.get('tests')).toBe(3);
  });

  test('single-dir commit creates no edge', () => {
    const ranked = rankAll([commit('a', ['src/a.ts'])]);
    const g = buildProximityGraph(ranked);
    expect(g.edges.get('src')).toBeUndefined();
  });

  test('three-dir commit yields three edges', () => {
    const ranked = rankAll([commit('a', ['src/a.ts', 'docs/a.md', 'tests/a.test.ts'])]);
    const g = buildProximityGraph(ranked);
    expect(g.edges.get('src')?.get('docs')).toBe(1);
    expect(g.edges.get('src')?.get('tests')).toBe(1);
    expect(g.edges.get('docs')?.get('tests')).toBe(1);
  });

  test('files at root (no top-level dir) are ignored', () => {
    const ranked = rankAll([commit('a', ['README.md', 'src/a.ts'])]);
    const g = buildProximityGraph(ranked);
    expect(g.weight.get('src')).toBe(1);
    // README.md has no top-level dir — no node, no edge.
    expect(g.edges.get('src')).toBeUndefined();
  });
});

// ============================================================================
// Topology choice
// ============================================================================

describe('chooseTopology', () => {
  test('maps district counts to topologies', () => {
    expect(chooseTopology(0)).toBe('single');
    expect(chooseTopology(1)).toBe('single');
    expect(chooseTopology(2)).toBe('line');
    expect(chooseTopology(3)).toBe('line');
    expect(chooseTopology(4)).toBe('ring');
    expect(chooseTopology(6)).toBe('ring');
    expect(chooseTopology(7)).toBe('cluster');
    expect(chooseTopology(20)).toBe('cluster');
  });
});

// ============================================================================
// layoutDistricts — integration
// ============================================================================

function ringCommits(): Commit[] {
  // 5 dirs, each touching itself alone — no edges. Forces ring topology.
  return [
    commit('a', ['alpha/x.ts']),
    commit('b', ['bravo/x.ts']),
    commit('c', ['charlie/x.ts']),
    commit('d', ['delta/x.ts']),
    commit('e', ['echo/x.ts']),
  ];
}

describe('layoutDistricts', () => {
  test('always includes outskirts', () => {
    const out = layoutDistricts({
      ranked: rankAll([]),
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('t'),
    });
    expect(out.find((d) => d.isOutskirts)).toBeDefined();
  });

  test('produces N+1 districts (N dirs + outskirts)', () => {
    const ranked = rankAll(ringCommits());
    const out = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('t'),
    });
    expect(out.length).toBe(6);
    expect(out[0]!.isOutskirts).toBe(true);
  });

  test('district bboxes all fit inside grid', () => {
    const ranked = rankAll(ringCommits());
    const out = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('fit'),
    });
    for (const d of out) {
      const b = districtBBox(d, GRID);
      expect(b.x0).toBeGreaterThanOrEqual(0);
      expect(b.y0).toBeGreaterThanOrEqual(0);
      expect(b.x1).toBeLessThan(GRID.w);
      expect(b.y1).toBeLessThan(GRID.h);
    }
  });

  test('non-outskirts district bboxes do not overlap pairwise', () => {
    const ranked = rankAll(ringCommits());
    const out = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('sep'),
    });
    const nonOut = out.filter((d) => !d.isOutskirts);
    for (let i = 0; i < nonOut.length; i++) {
      for (let j = i + 1; j < nonOut.length; j++) {
        const a = districtBBox(nonOut[i]!, GRID);
        const b = districtBBox(nonOut[j]!, GRID);
        const overlap = !(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0);
        expect(overlap).toBe(false);
      }
    }
  });

  test('deterministic for same rng seed', () => {
    const ranked = rankAll(ringCommits());
    const a = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('same'),
    });
    const b = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('same'),
    });
    expect(a).toEqual(b);
  });

  test('strongly connected dirs land closer than unrelated ones', () => {
    // src<->tests tightly coupled (20 co-touches); docs off on its own.
    const commits: Commit[] = [];
    for (let i = 0; i < 20; i++) {
      commits.push(commit(`c${i}`, [`src/f${i}.ts`, `tests/f${i}.test.ts`]));
    }
    commits.push(commit('d1', ['docs/a.md']));
    commits.push(commit('d2', ['docs/b.md']));
    commits.push(commit('d3', ['docs/c.md']));
    commits.push(commit('d4', ['docs/d.md']));
    const ranked = rankAll(commits);

    const out = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('close'),
    });

    const byName = new Map(out.map((d) => [d.name, d]));
    const src = byName.get('src')!;
    const tests = byName.get('tests')!;
    const docs = byName.get('docs')!;

    const dist = (a: typeof src, b: typeof src) =>
      Math.hypot(a.center.x - b.center.x, a.center.y - b.center.y);

    // src-tests are edge-connected 20 times -> should beat src-docs.
    expect(dist(src, tests)).toBeLessThan(dist(src, docs));
  });

  test('topology=line for 2 districts places both centers roughly horizontal', () => {
    const ranked = rankAll([
      commit('a', ['alpha/x.ts']),
      commit('b', ['bravo/x.ts']),
    ]);
    const out = layoutDistricts({
      ranked,
      grid: GRID,
      districtSize: DSIZE,
      rng: createRng('line'),
    });
    const nonOut = out.filter((d) => !d.isOutskirts);
    expect(nonOut.length).toBe(2);
    // Initial y is equal in line topology; force sim can nudge, but with
    // 2 nodes and no edge the attractive term is zero and repulsion pushes
    // along x primarily. Still, be forgiving: |dy| should be modest vs |dx|.
    const dx = Math.abs(nonOut[0]!.center.x - nonOut[1]!.center.x);
    const dy = Math.abs(nonOut[0]!.center.y - nonOut[1]!.center.y);
    expect(dx).toBeGreaterThan(dy);
  });
});
