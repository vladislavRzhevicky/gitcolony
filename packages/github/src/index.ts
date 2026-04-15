import { graphql } from '@octokit/graphql';
import type { Commit, RepoData } from '@gitcolony/schema';

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

  // Resolve default branch + basic meta in one roundtrip
  const meta = await gql<{
    repository: {
      createdAt: string;
      defaultBranchRef: { name: string } | null;
      owner: { login: string };
      name: string;
    } | null;
  }>(
    `query($owner: String!, $name: String!) {
       repository(owner: $owner, name: $name) {
         createdAt
         defaultBranchRef { name }
         owner { login }
         name
       }
     }`,
    { owner: opts.owner, name: opts.name },
  );
  if (!meta.repository) throw new Error(`repository not found: ${opts.owner}/${opts.name}`);
  const branch = opts.branch ?? meta.repository.defaultBranchRef?.name;
  if (!branch) throw new Error('repository has no default branch');

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
    },
    commits,
  };
}
