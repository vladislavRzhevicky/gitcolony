import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  integer,
  bigint,
  pgEnum,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import type { World } from '@gitcolony/schema';

// ============================================================================
// Enums
// ============================================================================

export const visibilityEnum = pgEnum('visibility', ['private', 'unlisted', 'public']);
export const syncModeEnum = pgEnum('sync_mode', ['manual', 'auto']);
export const jobStatusEnum = pgEnum('job_status', [
  'queued',
  'running',
  'done',
  'failed',
]);

// ============================================================================
// Identity
// ============================================================================

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  githubId: bigint('github_id', { mode: 'number' }).notNull().unique(),
  githubLogin: text('github_login').notNull(),
  avatarUrl: text('avatar_url'),
  // Encrypted OAuth access token refreshed on every login. Used by worker
  // jobs created via the public tab (no PAT involved).
  encryptedOauthToken: text('encrypted_oauth_token'),
  oauthTokenUpdatedAt: timestamp('oauth_token_updated_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
});

// Extra PATs for accessing repos outside of the OAuth session
// (e.g. work GitHub account, orgs). Encrypted at application layer.
export const userTokens = pgTable(
  'user_tokens',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    label: text('label').notNull(), // user-facing label, e.g. "Work account"
    encryptedPat: text('encrypted_pat').notNull(), // AES-GCM ciphertext (base64)
    ownerLogin: text('owner_login').notNull(), // github login the PAT resolves to
    scopes: text('scopes').array(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (t) => ({
    byUser: index('user_tokens_user_idx').on(t.userId),
  }),
);

// ============================================================================
// Cities
// ============================================================================

export const cities = pgTable(
  'cities',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    // null => used the user's own OAuth token (public-tab flow)
    sourceTokenId: uuid('source_token_id').references(() => userTokens.id, {
      onDelete: 'set null',
    }),
    repoFullName: text('repo_full_name').notNull(), // "owner/name"
    slug: text('slug').notNull(), // used in share urls
    visibility: visibilityEnum('visibility').default('unlisted').notNull(),
    seed: text('seed').notNull(), // deterministic world seed
    // Sync bookkeeping — manual in MVP, auto post-MVP.
    // Keeping the columns now so we don't need a migration later.
    syncMode: syncModeEnum('sync_mode').default('manual').notNull(),
    lastSyncedSha: text('last_synced_sha'),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('cities_slug_unique').on(t.slug),
    byUser: index('cities_user_idx').on(t.userId),
    // one city per user per repo
    userRepoUnique: uniqueIndex('cities_user_repo_unique').on(t.userId, t.repoFullName),
  }),
);

// Split off the heavy jsonb blob so listing cities stays cheap.
export const cityWorlds = pgTable('city_worlds', {
  cityId: uuid('city_id')
    .primaryKey()
    .references(() => cities.id, { onDelete: 'cascade' }),
  world: jsonb('world').$type<World>().notNull(),
  schemaVersion: integer('schema_version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// ============================================================================
// Jobs
// ============================================================================

export const generationJobs = pgTable(
  'generation_jobs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cityId: uuid('city_id')
      .references(() => cities.id, { onDelete: 'cascade' })
      .notNull(),
    status: jobStatusEnum('status').default('queued').notNull(),
    progress: integer('progress').default(0).notNull(), // 0..100
    phase: text('phase'), // 'fetching' | 'ranking' | 'generating' | 'saving'
    message: text('message'), // current flavor text line, surfaced over SSE
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => ({
    byCity: index('generation_jobs_city_idx').on(t.cityId),
  }),
);

// ============================================================================
// Sharing
// ============================================================================

export const shareViews = pgTable(
  'share_views',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    cityId: uuid('city_id')
      .references(() => cities.id, { onDelete: 'cascade' })
      .notNull(),
    viewedAt: timestamp('viewed_at', { withTimezone: true }).defaultNow().notNull(),
    // store coarse info only, no PII beyond country-level
    referer: text('referer'),
    country: text('country'),
  },
  (t) => ({
    byCity: index('share_views_city_idx').on(t.cityId),
  }),
);
