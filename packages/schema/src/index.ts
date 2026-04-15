import { z } from 'zod';

// ============================================================================
// Input: normalized repo data from any source (GitHub GraphQL / CLI export)
// ============================================================================

export const CommitSchema = z.object({
  sha: z.string(),
  message: z.string(),
  authorLogin: z.string().nullable(),
  authoredAt: z.string().datetime(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  // full paths of files touched; used by ranker to pick primary directory
  changedFiles: z.array(z.string()),
});

export type Commit = z.infer<typeof CommitSchema>;

export const RepoDataSchema = z.object({
  source: z.enum(['github', 'cli']),
  owner: z.string(),
  name: z.string(),
  fullName: z.string(), // "owner/name"
  defaultBranch: z.string(),
  repoCreatedAt: z.string().datetime().optional(),
  // hard cap: 1000 on initial load, delta on subsequent syncs
  commits: z.array(CommitSchema),
  fetchedAt: z.string().datetime(),
});

export type RepoData = z.infer<typeof RepoDataSchema>;

// ============================================================================
// Ranker: commit classification
// ============================================================================

export const TierSchema = z.enum(['A', 'B', 'C', 'D']);
export type Tier = z.infer<typeof TierSchema>;

export const SemanticTypeSchema = z.enum([
  'feat',
  'fix',
  'refactor',
  'docs',
  'test',
  'chore',
  'unknown',
]);
export type SemanticType = z.infer<typeof SemanticTypeSchema>;

export const RankedCommitSchema = CommitSchema.extend({
  tier: TierSchema,
  score: z.number(),
  semanticType: SemanticTypeSchema,
  // top-level directory this commit mostly touched; determines district.
  // null -> falls into the 'outskirts' district.
  primaryPath: z.string().nullable(),
});

export type RankedCommit = z.infer<typeof RankedCommitSchema>;

// ============================================================================
// World: output of generator, stored as jsonb in city_worlds.world
//
// Invariant: seed, archetype, palette, grid, districts are set at first
// generation and never change on sync. objects/agents grow incrementally.
// ============================================================================

export const TilePosSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
});
export type TilePos = z.infer<typeof TilePosSchema>;

export const DistrictSchema = z.object({
  id: z.string(), // e.g. "d-frontend", "d-outskirts"
  name: z.string(), // e.g. "frontend" or "outskirts"
  isOutskirts: z.boolean().default(false),
  center: TilePosSchema,
  sizeInTiles: z.object({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  }),
  theme: z.string(), // MVP: always 'generic'
});

export type District = z.infer<typeof DistrictSchema>;

// Commit-derived fields carried on every placed object/agent so the side
// panel can render without a second DB round-trip. Intentionally flat — we
// don't duplicate the full Commit (which can carry large `changedFiles`).
// All optional to keep older worlds deserializable.
const PlacedCommitMetaSchema = z.object({
  message: z.string().optional(),
  authorLogin: z.string().nullable().optional(),
  authoredAt: z.string().datetime().optional(),
});

export const WorldObjectSchema = z.object({
  // stable id derived from commit sha + variant -> allows incremental sync
  // without duplicating on re-ingestion.
  id: z.string(),
  commitSha: z.string(),
  tier: TierSchema,
  kind: z.enum(['building', 'decor']),
  variant: z.string(), // asset key, e.g. 'house-small-01'
  districtId: z.string(),
  anchor: TilePosSchema,
  // footprint tiles that block movement; single-tile for decor.
  footprint: z.array(TilePosSchema).min(1),
  // Visual height in arbitrary units. Consumed by the Threlte renderer to
  // extrude tier-B boxes; derived from commit weight (additions+deletions).
  // Optional because tier C/D decor has no per-object height.
  height: z.number().positive().optional(),
  // LLM-authored fields (phase: naming). Null when the LLM call failed or
  // was skipped (no API key). Always optional so older worlds deserialize.
  displayName: z.string().nullable().optional(),
  tagline: z.string().nullable().optional(),
}).merge(PlacedCommitMetaSchema);

export type WorldObject = z.infer<typeof WorldObjectSchema>;

export const AgentSchema = z.object({
  id: z.string(),
  commitSha: z.string(),
  districtId: z.string(),
  spawn: TilePosSchema,
  role: z.string(), // MVP: always 'wanderer'
  // LLM-authored profile (phase: naming). `personality` is one short line
  // used both in CommitPanel and as context when the ticker phase composes
  // scenes referencing this agent. Null when LLM was skipped/failed.
  displayName: z.string().nullable().optional(),
  personality: z.string().nullable().optional(),
}).merge(PlacedCommitMetaSchema);

export type Agent = z.infer<typeof AgentSchema>;

export const WorldStatsSchema = z.object({
  inhabitants: z.number().int().nonnegative(), // tier A count
  buildings: z.number().int().nonnegative(),   // tier B count
  decor: z.number().int().nonnegative(),       // tier C + D count
  commits: z.number().int().nonnegative(),     // total commits processed
});

export type WorldStats = z.infer<typeof WorldStatsSchema>;

// Single line on the city ticker — composed by the LLM director from recent
// commits + agent roster. Optional refs let the renderer highlight the
// referenced agent / building on hover. Re-emitted whole on every sync.
export const TickerEventSchema = z.object({
  id: z.string(), // deterministic: tk-<commitSha>-<idx>
  text: z.string(),
  author: z.string().nullable().optional(),
  commitSha: z.string().nullable().optional(),
  agentId: z.string().nullable().optional(),
  objectId: z.string().nullable().optional(),
  createdAt: z.string().datetime(),
});

export type TickerEvent = z.infer<typeof TickerEventSchema>;

// Decorative props the renderer paints alongside commit-driven objects.
// Currently used for the trees lining road edges. Not commit-backed: they
// live purely in the layout layer and are skipped by the click/picking
// pipeline. Default [] keeps pre-scenery worlds deserializable.
export const SceneryPropSchema = z.object({
  id: z.string(), // deterministic: 'tree-x-y'
  variant: z.string(), // asset key, e.g. 'tree-01'
  anchor: TilePosSchema,
});

export type SceneryProp = z.infer<typeof SceneryPropSchema>;

export const WorldSchema = z.object({
  version: z.literal(1),
  seed: z.string(),
  // MVP: single archetype and palette — locked in for future schema compatibility
  archetype: z.literal('generic-settlement'),
  palette: z.literal('default'),
  grid: z.object({
    w: z.number().int().positive(),
    h: z.number().int().positive(),
  }),
  districts: z.array(DistrictSchema).min(1),
  // Visual-only paths between districts, planned by A* over the walkable mask
  // at generation time. Each entry is a contiguous tile sequence (start→goal).
  // Locked at first generation alongside districts.
  roads: z.array(z.array(TilePosSchema)),
  objects: z.array(WorldObjectSchema),
  agents: z.array(AgentSchema),
  // Decorative road-side props. Default [] keeps older worlds deserializable.
  scenery: z.array(SceneryPropSchema).default([]),
  stats: WorldStatsSchema,
  // City news feed produced by the LLM director. Rewritten on each sync.
  // Default [] keeps older worlds (pre-director) deserializable.
  ticker: z.array(TickerEventSchema).default([]),
  // incrementality cursor
  lastCommitSha: z.string(),
  generatedAt: z.string().datetime(),
});

export type World = z.infer<typeof WorldSchema>;

// ============================================================================
// Generation job progress — emitted over SSE to the generating page
// ============================================================================

// Phases mirror the worker pipeline. `queued|done|failed` are lifecycle
// markers around the real work; the rest are 1:1 with processor stages.
export const JobPhaseSchema = z.enum([
  'queued',
  'fetching',
  'ranking',
  'layout',
  'roads',
  'placing',
  'naming',
  'ticker',
  'saving',
  'done',
  'failed',
]);

export type JobPhase = z.infer<typeof JobPhaseSchema>;

export const JobProgressEventSchema = z.object({
  jobId: z.string(),
  phase: JobPhaseSchema,
  progress: z.number().min(0).max(100),
  message: z.string().optional(), // flavor text line for the UI
  error: z.string().optional(),
});

export type JobProgressEvent = z.infer<typeof JobProgressEventSchema>;

// Convenience alias matching the roadmap's "JobEvent" name.
export const JobEventSchema = JobProgressEventSchema;
export type JobEvent = JobProgressEvent;

// ============================================================================
// City creation request — wire format between web proxy and apps/api.
// ============================================================================

export const CityVisibilitySchema = z.enum(['private', 'unlisted', 'public']);
export type CityVisibility = z.infer<typeof CityVisibilitySchema>;

// Repo summary returned by `GET /me/repos`. Mirrors the GraphQL projection
// in @gitcolony/github plus an `existingSlug` field populated by the API
// when the user already has a colony for that repo (so the dialog can show
// "Open" instead of "Generate" without a second roundtrip).
export const OwnedRepoSchema = z.object({
  fullName: z.string(),
  name: z.string(),
  owner: z.string(),
  isPrivate: z.boolean(),
  isFork: z.boolean(),
  isArchived: z.boolean(),
  defaultBranch: z.string(),
  description: z.string().nullable(),
  pushedAt: z.string().nullable(),
  stargazerCount: z.number().int().nonnegative(),
  primaryLanguage: z.string().nullable(),
  existingSlug: z.string().nullable(),
});

export type OwnedRepo = z.infer<typeof OwnedRepoSchema>;

export const OwnedReposResponseSchema = z.object({
  repos: z.array(OwnedRepoSchema),
  viewerLogin: z.string(),
  fetchedAt: z.string().datetime(),
});

export type OwnedReposResponse = z.infer<typeof OwnedReposResponseSchema>;

export const CityCreateRequestSchema = z.object({
  // "owner/name" or a github URL; api normalizes.
  repoFullName: z.string().min(3),
  // Optional PAT for private repos; public flow re-uses the stored OAuth token.
  pat: z.string().min(10).optional(),
  visibility: CityVisibilitySchema.default('unlisted'),
});

export type CityCreateRequest = z.infer<typeof CityCreateRequestSchema>;
