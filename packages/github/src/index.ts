import { graphql } from '@octokit/graphql';
import type { ClosedPullRequest, Commit, RepoData } from '@gitcolony/schema';

// ============================================================================
// Token handling
// ============================================================================

function client(token: string) {
  return graphql.defaults({
    headers: { authorization: `bearer ${token}` },
  });
}

export interface ViewerInfo {
  login: string;
  id: number;
  avatarUrl: string;
}

export async function resolveViewer(token: string): Promise<ViewerInfo> {
  const res = await client(token)<{
    viewer: { login: string; databaseId: number; avatarUrl: string };
  }>(`
    query { viewer { login databaseId avatarUrl } }
  `);
  return {
    login: res.viewer.login,
    id: res.viewer.databaseId,
    avatarUrl: res.viewer.avatarUrl,
  };
}

export interface OwnershipCheck {
  owned: boolean;
  viewerLogin: string;
  repoOwner: string;
  reason?: 'mismatch' | 'not_found' | 'private_inaccessible';
}

/**
 * Validates that the token-holder is the owner of the repo.
 * MVP: strict login match (case-insensitive).
 * Post-MVP: expand to org membership + collaborator check.
 */
export async function checkOwnership(
  token: string,
  owner: string,
  name: string,
): Promise<OwnershipCheck> {
  const viewer = await resolveViewer(token);
  try {
    const res = await client(token)<{
      repository: { owner: { login: string } } | null;
    }>(
      `query($owner: String!, $name: String!) {
         repository(owner: $owner, name: $name) { owner { login } }
       }`,
      { owner, name },
    );
    if (!res.repository) {
      return {
        owned: false,
        viewerLogin: viewer.login,
        repoOwner: owner,
        reason: 'not_found',
      };
    }
    const actualOwner = res.repository.owner.login;
    const owned = actualOwner.toLowerCase() === viewer.login.toLowerCase();
    return {
      owned,
      viewerLogin: viewer.login,
      repoOwner: actualOwner,
      reason: owned ? undefined : 'mismatch',
    };
  } catch (e) {
    // Any GraphQL error against a private inaccessible repo looks like 'not found'
    // from the outside. Surface that distinctly so UI can suggest PAT.
    return {
      owned: false,
      viewerLogin: viewer.login,
      repoOwner: owner,
      reason: 'private_inaccessible',
    };
  }
}

// Lightweight access check used on the explicit-token branch of POST /cities.
// We don't care who owns the repo — only whether the token can see it. One
// GraphQL call, no viewer lookup. `not_found` collapses "private repo the
// token can't reach" into the same bucket as "repo doesn't exist" on purpose:
// GitHub returns both indistinguishably for unauth'd access.
export interface RepoAccessCheck {
  canRead: boolean;
  reason?: 'not_found' | 'error';
}

export async function checkRepoAccess(
  token: string,
  owner: string,
  name: string,
): Promise<RepoAccessCheck> {
  try {
    const res = await client(token)<{
      repository: { owner: { login: string } } | null;
    }>(
      `query($owner: String!, $name: String!) {
         repository(owner: $owner, name: $name) { owner { login } }
       }`,
      { owner, name },
    );
    if (!res.repository) return { canRead: false, reason: 'not_found' };
    return { canRead: true };
  } catch {
    return { canRead: false, reason: 'error' };
  }
}

// ============================================================================
// Repo listing (for the Private tab)
// ============================================================================

export interface RepoSummary {
  fullName: string;
  name: string;
  owner: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
  stargazerCount: number;
  primaryLanguage: string | null;
}

export type RepoAffiliation = 'OWNER' | 'ORGANIZATION_MEMBER' | 'COLLABORATOR';

export interface ListReposOptions {
  /** Hard cap on how many summaries to return. */
  limit?: number;
  /** GraphQL `affiliations` filter; defaults to all three. */
  affiliations?: RepoAffiliation[];
}

/**
 * Lists repos accessible via the given token.
 * Paginates via GraphQL, capped for UI sanity. Affiliation defaults to the
 * full set; the "create colony" flow narrows it to OWNER so the result lines
 * up with the ownership invariant in apps/api.
 */
export async function listAccessibleRepos(
  token: string,
  { limit = 200, affiliations }: ListReposOptions = {},
): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  let cursor: string | null = null;
  const gql = client(token);
  const affs = affiliations ?? ['OWNER', 'ORGANIZATION_MEMBER', 'COLLABORATOR'];

  while (out.length < limit) {
    const res: {
      viewer: {
        repositories: {
          pageInfo: { hasNextPage: boolean; endCursor: string | null };
          nodes: Array<{
            nameWithOwner: string;
            name: string;
            owner: { login: string };
            isPrivate: boolean;
            isFork: boolean;
            isArchived: boolean;
            defaultBranchRef: { name: string } | null;
            description: string | null;
            pushedAt: string | null;
            stargazerCount: number;
            primaryLanguage: { name: string } | null;
          }>;
        };
      };
    } = await gql(
      `query($cursor: String, $affs: [RepositoryAffiliation]) {
        viewer {
          repositories(
            first: 100,
            after: $cursor,
            orderBy: { field: PUSHED_AT, direction: DESC },
            affiliations: $affs
          ) {
            pageInfo { hasNextPage endCursor }
            nodes {
              nameWithOwner name
              owner { login }
              isPrivate isFork isArchived
              defaultBranchRef { name }
              description pushedAt stargazerCount
              primaryLanguage { name }
            }
          }
        }
      }`,
      { cursor, affs },
    );
    for (const n of res.viewer.repositories.nodes) {
      if (!n.defaultBranchRef) continue; // empty repos
      out.push({
        fullName: n.nameWithOwner,
        name: n.name,
        owner: n.owner.login,
        isPrivate: n.isPrivate,
        isFork: n.isFork,
        isArchived: n.isArchived,
        defaultBranch: n.defaultBranchRef.name,
        description: n.description,
        pushedAt: n.pushedAt,
        stargazerCount: n.stargazerCount,
        primaryLanguage: n.primaryLanguage?.name ?? null,
      });
      if (out.length >= limit) break;
    }
    if (!res.viewer.repositories.pageInfo.hasNextPage) break;
    cursor = res.viewer.repositories.pageInfo.endCursor;
  }
  return out;
}

/**
 * REST-based repo listing. Used for PAT flows because GitHub's GraphQL
 * `viewer.repositories` has a long-standing bug with fine-grained PATs:
 * it omits org-owned repos even when the token has explicit access and
 * the org has approved the token. REST `/user/repos` is the documented
 * workaround — it returns the union of owner / collaborator / org-member
 * repos the token can read, including the ones GraphQL misses.
 *
 * Downside vs. GraphQL: no `defaultBranchRef` in the basic listing, so
 * we fill it from `default_branch` which is always present.
 */
export async function listReposViaRest(
  token: string,
  { limit = 200 }: { limit?: number } = {},
): Promise<RepoSummary[]> {
  const out: RepoSummary[] = [];
  let page = 1;
  const perPage = 100;
  while (out.length < limit) {
    const url =
      `https://api.github.com/user/repos` +
      `?per_page=${perPage}&page=${page}` +
      `&affiliation=owner,collaborator,organization_member` +
      `&sort=pushed`;
    const res = await fetch(url, {
      headers: {
        authorization: `bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`GitHub REST /user/repos ${res.status}: ${text.slice(0, 200)}`);
    }
    const rows = (await res.json()) as Array<{
      full_name: string;
      name: string;
      owner: { login: string };
      private: boolean;
      fork: boolean;
      archived: boolean;
      default_branch: string | null;
      description: string | null;
      pushed_at: string | null;
      stargazers_count: number;
      language: string | null;
    }>;
    if (rows.length === 0) break;
    for (const r of rows) {
      if (!r.default_branch) continue;
      out.push({
        fullName: r.full_name,
        name: r.name,
        owner: r.owner.login,
        isPrivate: r.private,
        isFork: r.fork,
        isArchived: r.archived,
        defaultBranch: r.default_branch,
        description: r.description,
        pushedAt: r.pushed_at,
        stargazerCount: r.stargazers_count,
        primaryLanguage: r.language,
      });
      if (out.length >= limit) break;
    }
    if (rows.length < perPage) break;
    page += 1;
  }
  return out;
}

// ============================================================================
// Commit history ingestion
// ============================================================================

export interface FetchCommitsOptions {
  owner: string;
  name: string;
  branch?: string; // defaults to repo's default branch
  maxCommits?: number; // hard cap; default INITIAL_COMMIT_LIMIT
  // For incremental sync: stop once we reach this sha (exclusive).
  // GraphQL paginates newest-first, so we cut the stream when we hit it.
  untilSha?: string;
  onProgress?: (fetched: number, expected: number | null) => void;
}

interface RawCommitNode {
  oid: string;
  message: string;
  committedDate: string;
  additions: number;
  deletions: number;
  changedFilesIfAvailable: number | null;
  author: { user: { login: string } | null } | null;
}

/**
 * Fetches commit history via GraphQL, newest-first, up to `maxCommits`.
 *
 * Note: GraphQL does NOT give us file paths per commit — we'd have to call
 * REST `/repos/:o/:n/commits/:sha` for each, which costs 1 REST call per commit.
 * The ranker-in-packages/core handles empty `changedFiles` by routing
 * such commits to the `outskirts` district (see WorldSchema invariants).
 *
 * Post-MVP: fetch REST files only for commits whose base score already hints
 * at Tier A/B, to cheaply enrich district assignment where it matters.
 */
export async function fetchCommits(
  token: string,
  opts: FetchCommitsOptions,
): Promise<{ repo: Omit<RepoData, 'commits' | 'fetchedAt'>; commits: Commit[] }> {
  const limit = opts.maxCommits ?? Number(process.env.INITIAL_COMMIT_LIMIT ?? 1000);
  const gql = client(token);

  // Resolve default branch + basic meta in one roundtrip. Also pulls
  // `history.totalCount` on the default branch so callers know the repo's
  // real commit volume even when we cap ingestion — world-gen uses this to
  // size cities to the repo's scale rather than the fetched window.
  const meta = await gql<{
    repository: {
      createdAt: string;
      defaultBranchRef: {
        name: string;
        target: { history: { totalCount: number } } | null;
      } | null;
      owner: { login: string };
      name: string;
    } | null;
  }>(
    `query($owner: String!, $name: String!) {
       repository(owner: $owner, name: $name) {
         createdAt
         defaultBranchRef {
           name
           target { ... on Commit { history(first: 0) { totalCount } } }
         }
         owner { login }
         name
       }
     }`,
    { owner: opts.owner, name: opts.name },
  );
  if (!meta.repository) throw new Error(`repository not found: ${opts.owner}/${opts.name}`);
  const branch = opts.branch ?? meta.repository.defaultBranchRef?.name;
  if (!branch) throw new Error('repository has no default branch');
  const totalCommits =
    meta.repository.defaultBranchRef?.target?.history.totalCount ?? undefined;

  const commits: Commit[] = [];
  let cursor: string | null = null;

  type HistoryPage = {
    repository: {
      ref: {
        target: {
          history: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: RawCommitNode[];
          };
        };
      } | null;
    };
  };

  outer: while (commits.length < limit) {
    const page: HistoryPage = await gql(
      `query($owner: String!, $name: String!, $branch: String!, $cursor: String) {
         repository(owner: $owner, name: $name) {
           ref(qualifiedName: $branch) {
             target {
               ... on Commit {
                 history(first: 100, after: $cursor) {
                   pageInfo { hasNextPage endCursor }
                   nodes {
                     oid message committedDate additions deletions
                     changedFilesIfAvailable
                     author { user { login } }
                   }
                 }
               }
             }
           }
         }
       }`,
      { owner: opts.owner, name: opts.name, branch, cursor },
    );
    const ref = page.repository.ref;
    if (!ref) break;
    const hist = ref.target.history;

    for (const n of hist.nodes) {
      if (opts.untilSha && n.oid === opts.untilSha) break outer;
      commits.push({
        sha: n.oid,
        message: n.message,
        authorLogin: n.author?.user?.login ?? null,
        authoredAt: n.committedDate,
        additions: n.additions,
        deletions: n.deletions,
        changedFiles: [], // populated lazily via REST in post-MVP
      });
      if (commits.length >= limit) break outer;
    }
    opts.onProgress?.(commits.length, limit);
    if (!hist.pageInfo.hasNextPage) break;
    cursor = hist.pageInfo.endCursor;
  }

  return {
    repo: {
      source: 'github',
      owner: meta.repository.owner.login,
      name: meta.repository.name,
      fullName: `${meta.repository.owner.login}/${meta.repository.name}`,
      defaultBranch: branch,
      repoCreatedAt: meta.repository.createdAt,
      totalCommits,
    },
    commits,
  };
}

// ============================================================================
// File enrichment
//
// GraphQL's `history.nodes` doesn't expose per-commit changed file paths —
// the only way to get them via GitHub's API is REST `/repos/:o/:n/commits/:sha`.
// World-gen relies on file paths to subdivide districts: without them the
// fallback (conventional-commit scope / semantic type) can only produce
// ~6–7 buckets regardless of repo size. For big monorepos that collapses
// the city to a handful of quartiers.
//
// We call REST with bounded concurrency after fetchCommits so the caller
// can feed file-aware commits into the ranker. Rate-limit budget: 5k/hour
// for a PAT — default cap of 800 enriched commits keeps a single sync at
// ~16 % of budget, leaving room for retries and other API calls.
// ============================================================================

export interface EnrichCommitFilesOptions {
  owner: string;
  name: string;
  shas: readonly string[];
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

export async function enrichCommitFiles(
  token: string,
  { owner, name, shas, concurrency = 8, onProgress }: EnrichCommitFilesOptions,
): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (shas.length === 0) return out;
  let idx = 0;
  let done = 0;
  const worker = async () => {
    while (true) {
      const i = idx++;
      if (i >= shas.length) break;
      const sha = shas[i]!;
      try {
        const res = await fetch(
          `https://api.github.com/repos/${owner}/${name}/commits/${sha}`,
          {
            headers: {
              authorization: `bearer ${token}`,
              accept: 'application/vnd.github+json',
              'x-github-api-version': '2022-11-28',
            },
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            files?: Array<{ filename: string }>;
          };
          out.set(sha, (data.files ?? []).map((f) => f.filename));
        } else {
          // Non-OK (rate limit, not found, etc.) — skip silently. The caller
          // falls back to the conventional-commit scope for those commits.
          out.set(sha, []);
        }
      } catch {
        out.set(sha, []);
      }
      done++;
      onProgress?.(done, shas.length);
    }
  };
  const n = Math.min(concurrency, shas.length);
  await Promise.all(Array.from({ length: n }, () => worker()));
  return out;
}

// ============================================================================
// Commit patches (per-commit unified diffs for the code-review phase)
//
// The LLM review feature needs real source snippets keyed by commit sha. REST
// `/repos/:o/:n/commits/:sha` already returns each file's unified-diff patch
// inline, so one request gives us everything we need for a single commit.
// Commits are immutable, so the caller caches the result by `owner/name@sha`.
// ============================================================================

export interface CommitFilePatch {
  filename: string;
  status: string;            // added|modified|removed|renamed|copied
  additions: number;
  deletions: number;
  patch: string | null;      // null for binaries / too-large files
}

export async function fetchCommitPatches(
  token: string,
  owner: string,
  name: string,
  sha: string,
): Promise<CommitFilePatch[] | null> {
  try {
    const res = await fetch(
      `https://api.github.com/repos/${owner}/${name}/commits/${sha}`,
      {
        headers: {
          authorization: `bearer ${token}`,
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
        },
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      files?: Array<{
        filename: string;
        status?: string;
        additions?: number;
        deletions?: number;
        patch?: string;
      }>;
    };
    return (data.files ?? []).map((f) => ({
      filename: f.filename,
      status: f.status ?? 'modified',
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      patch: f.patch ?? null,
    }));
  } catch {
    return null;
  }
}

// ============================================================================
// Closed pull requests
//
// We fetch PRs that were closed WITHOUT being merged — merged ones are
// already represented by their merge commits in fetchCommits above, so they
// don't need a separate grave. The `states: [CLOSED]` filter lumps both
// together, and we drop `mergedAt != null` client-side.
//
// Paginates newest-closed-first and stops at `untilClosedAt` for incremental
// sync (the worker passes the previous sync's high-water mark).
// ============================================================================

export interface FetchClosedPullRequestsOptions {
  owner: string;
  name: string;
  maxPrs?: number;
  // Stop once we see a PR that was closed at or before this timestamp.
  untilClosedAt?: string;
}

interface RawPrNode {
  number: number;
  title: string;
  closedAt: string | null;
  mergedAt: string | null;
  author: { login: string } | null;
  headRefOid: string | null;
}

export async function fetchClosedPullRequests(
  token: string,
  opts: FetchClosedPullRequestsOptions,
): Promise<ClosedPullRequest[]> {
  const limit = opts.maxPrs ?? Number(process.env.INITIAL_PR_LIMIT ?? 500);
  const gql = client(token);
  const out: ClosedPullRequest[] = [];
  let cursor: string | null = null;
  const stopAt = opts.untilClosedAt ? new Date(opts.untilClosedAt).getTime() : null;

  type Page = {
    repository: {
      pullRequests: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: RawPrNode[];
      };
    } | null;
  };

  outer: while (out.length < limit) {
    const page: Page = await gql(
      `query($owner: String!, $name: String!, $cursor: String) {
         repository(owner: $owner, name: $name) {
           pullRequests(
             first: 100,
             after: $cursor,
             states: [CLOSED],
             orderBy: { field: UPDATED_AT, direction: DESC }
           ) {
             pageInfo { hasNextPage endCursor }
             nodes {
               number title closedAt mergedAt
               author { login }
               headRefOid
             }
           }
         }
       }`,
      { owner: opts.owner, name: opts.name, cursor },
    );
    if (!page.repository) break;
    const pr = page.repository.pullRequests;
    for (const n of pr.nodes) {
      // Skip merged — their footprint is already the merge commit in world-gen.
      if (n.mergedAt) continue;
      // Defensive: CLOSED state should always carry closedAt, but the GraphQL
      // contract marks it nullable. No closedAt means we can't stably sort it.
      if (!n.closedAt) continue;
      if (stopAt !== null && new Date(n.closedAt).getTime() <= stopAt) break outer;
      out.push({
        prNumber: n.number,
        title: n.title,
        authorLogin: n.author?.login ?? null,
        closedAt: n.closedAt,
        headSha: n.headRefOid,
      });
      if (out.length >= limit) break outer;
    }
    if (!pr.pageInfo.hasNextPage) break;
    cursor = pr.pageInfo.endCursor;
  }
  return out;
}
