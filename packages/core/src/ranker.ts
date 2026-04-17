import type { Commit, RankedCommit, SemanticType, Tier } from '@gitcolony/schema';

// ============================================================================
// MVP ranker — deterministic, local, no repo-wide signals.
//
// Per post-mvp.md: historical_score and novelty_score are deferred. This keeps
// the ranker pure per-commit and makes incremental sync trivially correct.
// ============================================================================

const CONVENTIONAL_RE = /^(feat|fix|refactor|docs|test|chore|build|ci|perf|style|revert)(\(.+?\))?!?:\s/i;

export function classifySemantic(message: string): SemanticType {
  const m = message.match(CONVENTIONAL_RE);
  if (!m) return guessFromFreeform(message);
  const t = m[1]!.toLowerCase();
  switch (t) {
    case 'feat':
    case 'perf':
      return 'feat';
    case 'fix':
      return 'fix';
    case 'refactor':
    case 'style':
      return 'refactor';
    case 'docs':
      return 'docs';
    case 'test':
      return 'test';
    case 'chore':
    case 'build':
    case 'ci':
    case 'revert':
      return 'chore';
    default:
      return 'unknown';
  }
}

function guessFromFreeform(msg: string): SemanticType {
  const s = msg.toLowerCase();
  if (/\bfix(ed|es)?\b|\bbug\b|\bcrash\b|\bhotfix\b/.test(s)) return 'fix';
  if (/\badd(ed)?\b|\bintroduce\b|\bimplement\b|\bsupport\b/.test(s)) return 'feat';
  if (/\brefactor|\brewrite|\bcleanup|\brestructure/.test(s)) return 'refactor';
  if (/\bdocs?\b|\breadme\b|\btypos?\b/.test(s)) return 'docs';
  if (/\btest(s|ing)?\b|\bspec\b/.test(s)) return 'test';
  return 'unknown';
}

// ----------------------------------------------------------------------------
// Scoring
// ----------------------------------------------------------------------------

// Saturating size score: 1-line commits ~ 3, 1000-line commits ~ 35.
// log-based so giant diffs never dominate.
function sizeScore(c: Commit): number {
  const churn = c.additions + c.deletions;
  if (churn <= 0) return 0;
  return Math.min(40, Math.log2(churn + 1) * 4);
}

function semanticScore(t: SemanticType): number {
  switch (t) {
    case 'feat':
      return 30;
    case 'fix':
      return 25;
    case 'refactor':
      return 20;
    // Repos without conventional-commit discipline ended up with almost all
    // commits as tier C/D (unknown + small churn never cleared the tier-B
    // threshold). Bumped so an average unknown commit can still become a
    // building when its churn is non-trivial.
    case 'unknown':
      return 15;
    case 'test':
      return 12;
    case 'docs':
      return 10;
    case 'chore':
      return 5;
  }
}

// ----------------------------------------------------------------------------
// Noise detection (override to Tier D regardless of raw score)
// ----------------------------------------------------------------------------

const LOCKFILE_RE = /(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lock|poetry\.lock|Gemfile\.lock|Cargo\.lock|go\.sum)$/i;
const FORMAT_MSG_RE = /^(chore|style)(\(.+?\))?!?:\s*(prettier|format(ting)?|lint(ing)?|eslint)/i;
const MERGE_RE = /^Merge (pull request|branch)/i;
const BOT_AUTHORS = new Set(['dependabot[bot]', 'renovate[bot]', 'github-actions[bot]']);

function isNoisy(c: Commit): boolean {
  if (FORMAT_MSG_RE.test(c.message)) return true;
  if (MERGE_RE.test(c.message) && c.additions + c.deletions < 20) return true;
  if (c.authorLogin && BOT_AUTHORS.has(c.authorLogin)) return true;
  if (c.changedFiles.length > 0 && c.changedFiles.every((f) => LOCKFILE_RE.test(f))) {
    return true;
  }
  return false;
}

// ----------------------------------------------------------------------------
// Primary path (district assignment hint)
// ----------------------------------------------------------------------------

export function topLevel(path: string, depth = 1): string | null {
  const clean = path.replace(/^\/+/, '');
  const parts = clean.split('/');
  // Need at least one directory segment AND a filename.
  if (parts.length <= 1) return null;
  // Never include the filename itself; cap depth at the number of dir segments.
  const take = Math.max(1, Math.min(depth, parts.length - 1));
  return parts.slice(0, take).join('/');
}

/**
 * Chooses the directory (at the requested depth) that most of this commit's
 * files touched. Returns null if we have no file info or only root-level
 * files — ranker consumers route such commits to the outskirts district.
 */
export function pickPrimaryPath(c: Commit, depth = 1): string | null {
  if (c.changedFiles.length === 0) return null;
  const counts = new Map<string, number>();
  for (const f of c.changedFiles) {
    const top = topLevel(f, depth);
    if (!top) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  if (counts.size === 0) return null;
  let best: string | null = null;
  let max = -1;
  for (const [k, v] of counts) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

// ----------------------------------------------------------------------------
// Tier mapping — percentile-based
//
// Absolute score thresholds turned every conventional-free repo into a city
// of tiny decor because mid-size commits rarely crossed the B line. With
// percentiles, tier-A/B counts track repo activity directly: the top 5 %
// always become agents, the next 35 % always become buildings, regardless
// of whether the project uses `feat:`-style messages.
//
//   top  5 %  -> A (agents)
//   next 35 % -> B (buildings)
//   next 35 % -> C (decor)
//   rest      -> D (decor, sparse)
//
// Noisy commits (lockfiles, bots, merges, formatting) are forced to D
// before the percentile pass so they don't push real work out of the top
// bands.
// ----------------------------------------------------------------------------

const PERCENTILE_A = 0.05;
const PERCENTILE_B = 0.40;
const PERCENTILE_C = 0.75;

function tierByRank(rank: number, total: number): Tier {
  if (total <= 0) return 'D';
  const p = rank / total;
  if (p < PERCENTILE_A) return 'A';
  if (p < PERCENTILE_B) return 'B';
  if (p < PERCENTILE_C) return 'C';
  return 'D';
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

// Intermediate shape used inside rankAll — tier is assigned by the
// percentile pass after all commits have been scored.
function scoreOne(c: Commit): RankedCommit {
  const semantic = classifySemantic(c.message);
  const rawScore = sizeScore(c) + semanticScore(semantic);
  return {
    ...c,
    tier: 'D',
    score: rawScore,
    semanticType: semantic,
    primaryPath: pickPrimaryPath(c),
  };
}

// Every colony should have a cast of characters, so even a tiny repo whose
// percentile math yields zero tier-A commits gets its top N promoted. Picked
// to read as "a family" at a glance in the scene.
const MIN_TIER_A = 3;

export function rankAll(commits: readonly Commit[]): RankedCommit[] {
  const out = commits.map(scoreOne);
  if (out.length === 0) return out;

  // Filter out noisy commits — they stay locked at the 'D' tier assigned in
  // scoreOne regardless of where their score would place them.
  const real = out.filter((c) => !isNoisy(c));

  // Rank the real commits by score (desc) and assign tiers by percentile
  // position. Ties break by sha so the ordering is deterministic.
  real.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.sha < b.sha ? -1 : a.sha > b.sha ? 1 : 0;
  });
  for (let i = 0; i < real.length; i++) {
    real[i]!.tier = tierByRank(i, real.length);
  }

  // Ceremony rule: the repo's oldest commit is always Tier A.
  const first = out.reduce((acc, cur) =>
    cur.authoredAt < acc.authoredAt ? cur : acc,
  );
  first.tier = 'A';

  // Population floor: promote highest-scoring non-A commits until the
  // colony has MIN_TIER_A residents (or the repo runs out of commits).
  let tierACount = out.reduce((n, c) => (c.tier === 'A' ? n + 1 : n), 0);
  if (tierACount < MIN_TIER_A && out.length > tierACount) {
    // Walk `real` in score order — it's already sorted; skip those already A.
    for (const c of real) {
      if (tierACount >= MIN_TIER_A) break;
      if (c.tier === 'A') continue;
      c.tier = 'A';
      tierACount++;
    }
  }
  return out;
}
