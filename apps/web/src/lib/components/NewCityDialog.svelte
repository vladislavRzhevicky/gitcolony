<!--
  NewCityDialog — modal triggered from the dashboard.

  Lists every repo the caller can reach, merged across three sources:
    - the OAuth session (`/api/me/repos`, GET),
    - each saved token the user manages on /settings (`/api/me/repos` POST
      with `{ tokenId }`).
  Tokens load automatically on open — the user does not paste or configure
  anything here. Managing tokens themselves happens on /settings.

  Picking a row that already has a colony navigates to it; otherwise it
  kicks off generation, forwarding the matching `tokenId` when the row
  originated from a saved token so access checks pass.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from './Button.svelte';
  import Input from './Input.svelte';
  import { relativeTime } from '$lib/time';
  import type { OwnedRepo } from '@gitcolony/schema';

  // Per-row source tag. Decides what (if anything) we attach to POST
  // /cities when the user picks this row:
  //   - oauth → use the session token (no extra field)
  //   - token → saved user_tokens row; send `{ tokenId }`
  type Row =
    | (OwnedRepo & { source: 'oauth' })
    | (OwnedRepo & { source: 'token'; tokenId: string });

  interface SavedToken {
    id: string;
    label: string;
    ownerLogin: string;
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  // Repo list state. Lazy-loaded — requests only fire the first time the
  // dialog opens. Subsequent opens reuse the in-memory list.
  let repos = $state<Row[]>([]);
  let loading = $state(false);
  let listError = $state<string | null>(null);
  let loaded = $state(false);

  // Number of saved tokens still fetching their repos. We show a footer
  // hint while non-zero so the user knows the list is still growing.
  let tokenLoads = $state(0);

  let query = $state('');

  // Submission state — one at a time, keyed to the specific fullName so
  // only the clicked row shows its "starting…" label.
  let submitting = $state(false);
  let submittingFullName = $state<string | null>(null);
  let formError = $state<string | null>(null);

  // Merge rows into the list, deduping by fullName. First source to
  // resolve a given repo wins — later merges skip it. This keeps the
  // OAuth row priority and avoids duplicates when an org repo is
  // reachable via both the session and a saved token.
  function mergeRepos(next: Row[]) {
    const seen = new Set(repos.map((r) => r.fullName));
    const additions: Row[] = [];
    for (const r of next) {
      if (seen.has(r.fullName)) continue;
      seen.add(r.fullName);
      additions.push(r);
    }
    if (additions.length > 0) repos = [...repos, ...additions];
  }

  async function loadOauthRepos() {
    loading = true;
    listError = null;
    try {
      const res = await fetch('/api/me/repos');
      const data = await res.json();
      if (!res.ok) {
        listError =
          typeof data.error === 'string' ? data.error : 'failed to load repositories';
        return;
      }
      const fetched = (data.repos ?? []) as OwnedRepo[];
      mergeRepos(fetched.map((r) => ({ ...r, source: 'oauth' as const })));
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      loading = false;
    }
  }

  // Resolve repos reachable by a saved token. Errors from one token are
  // non-fatal — surface a low-key inline message but keep going so a
  // single revoked token doesn't hide repos from the others.
  async function loadReposFromToken(tokenId: string) {
    tokenLoads++;
    try {
      const res = await fetch('/api/me/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenId }),
      });
      const data = await res.json();
      if (!res.ok) return; // silent per-token fail — other tokens still merge
      const fetched = (data.repos ?? []) as OwnedRepo[];
      mergeRepos(
        fetched.map((r) => ({ ...r, source: 'token' as const, tokenId })),
      );
    } catch {
      // same reasoning — don't let a network blip blank the dialog.
    } finally {
      tokenLoads--;
    }
  }

  // Full load sequence: OAuth first (fastest, the common case), then
  // fan out across every saved token in parallel so their repos fold
  // in as each request returns.
  async function loadAll() {
    if (loaded || loading) return;
    await loadOauthRepos();
    try {
      const res = await fetch('/api/me/tokens');
      if (res.ok) {
        const body = await res.json();
        const saved = (body.tokens ?? []) as SavedToken[];
        await Promise.all(saved.map((t) => loadReposFromToken(t.id)));
      }
    } catch {
      // saved-tokens lookup is best-effort — oauth repos are already in.
    }
    loaded = true;
  }

  // Trigger a load only on the open=false→true edge. A naive
  // `$effect(() => { if (open) loadAll() })` would re-run whenever any
  // $state read inside loadAll (loading, loaded, repos) changed — and
  // on a failed fetch that means an infinite retry loop.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) loadAll();
    prevOpen = open;
  });

  // Filtered list. Case-insensitive substring match on full name OR
  // description. We don't hide forks/archived — the list is already
  // tightly scoped by affiliation + saved-token access.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return repos;
    return repos.filter((r) => {
      if (r.fullName.toLowerCase().includes(q)) return true;
      if (r.description?.toLowerCase().includes(q)) return true;
      return false;
    });
  });

  async function generate(
    repoFullName: string,
    opts: { tokenId?: string } = {},
  ) {
    if (submitting) return;
    submitting = true;
    submittingFullName = repoFullName;
    formError = null;
    try {
      const body: Record<string, unknown> = {
        repoFullName,
        visibility: 'unlisted',
      };
      if (opts.tokenId) body.tokenId = opts.tokenId;
      const res = await fetch('/api/cities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409: a colony already exists for this repo (race with the join).
        // Refresh and navigate to it instead of surfacing the error.
        if (res.status === 409) {
          loaded = false;
          repos = [];
          await loadAll();
          const found = repos.find((r) => r.fullName === repoFullName);
          if (found?.existingSlug) {
            await goto(`/cities/${found.existingSlug}`);
            return;
          }
        }
        formError =
          typeof data.error === 'string' ? data.error : 'could not start generation';
        return;
      }
      await goto(`/cities/${data.slug}`);
    } catch (err) {
      formError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      submitting = false;
      submittingFullName = null;
    }
  }

  async function pickRepo(r: Row) {
    if (r.existingSlug) {
      await goto(`/cities/${r.existingSlug}`);
      return;
    }
    if (r.source === 'token') {
      await generate(r.fullName, { tokenId: r.tokenId });
    } else {
      await generate(r.fullName);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ncd-title"
    tabindex="-1"
  >
    <div class="panel">
      <header class="panel__head">
        <h2 id="ncd-title" class="panel__title">Generate a colony</h2>
        <p class="panel__sub">
          Pick a repository. Already-generated colonies open instead of
          regenerating.
          <a class="panel__link" href="/settings">Manage access tokens →</a>
        </p>
      </header>

      <div class="search">
        <Input
          label="Search"
          placeholder="filter by name or description…"
          name="search"
          bind:value={query}
        />
      </div>

      <div class="list" role="listbox" aria-label="Your repositories">
        {#if loading && repos.length === 0}
          <p class="list__empty mono">loading repositories…</p>
        {:else if listError && repos.length === 0}
          <div class="list__empty">
            <p class="err" role="alert">{listError}</p>
            <button
              type="button"
              class="toggle"
              onclick={() => {
                loaded = false;
                repos = [];
                loadAll();
              }}
            >
              retry
            </button>
          </div>
        {:else if filtered.length === 0}
          <p class="list__empty">
            {repos.length === 0
              ? 'no repositories found.'
              : 'no matches — try clearing the search.'}
          </p>
        {:else}
          {#each filtered as r (r.fullName)}
            <button
              type="button"
              class="row"
              class:row--existing={r.existingSlug !== null}
              disabled={submitting}
              onclick={() => pickRepo(r)}
            >
              <div class="row__main">
                <span class="row__name mono">{r.fullName}</span>
                <span class="row__meta">
                  {#if r.isPrivate}<span class="badge">private</span>{/if}
                  {#if r.isFork}<span class="badge">fork</span>{/if}
                  {#if r.isArchived}<span class="badge">archived</span>{/if}
                  {#if r.source === 'token'}<span class="badge">via token</span>{/if}
                  {#if r.primaryLanguage}
                    <span class="dim">{r.primaryLanguage}</span>
                  {/if}
                  {#if r.stargazerCount > 0}
                    <span class="dim">★ {r.stargazerCount}</span>
                  {/if}
                  {#if r.pushedAt}
                    <span class="dim">{relativeTime(r.pushedAt)}</span>
                  {/if}
                </span>
                {#if r.description}
                  <span class="row__desc">{r.description}</span>
                {/if}
              </div>
              <span class="row__cta">
                {#if submittingFullName === r.fullName}
                  starting…
                {:else if r.existingSlug}
                  open →
                {:else}
                  generate →
                {/if}
              </span>
            </button>
          {/each}
        {/if}
      </div>

      {#if tokenLoads > 0}
        <p class="hint mono">loading repositories from saved tokens…</p>
      {/if}

      {#if formError}
        <p class="err" role="alert">{formError}</p>
      {/if}

      <div class="panel__actions">
        <Button variant="ghost" type="button" onclick={onClose}>Close</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg-0) 70%, transparent);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: var(--space-4);
  }
  .panel {
    width: 100%;
    max-width: 640px;
    max-height: calc(100vh - var(--space-6));
    background: var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: var(--space-5);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    overflow: hidden;
  }
  .panel__head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .panel__title {
    font-family: var(--font-head);
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    margin: 0;
  }
  .panel__sub {
    margin: 0;
    color: var(--fg-1);
    line-height: 1.5;
  }
  .panel__link {
    color: var(--accent);
    text-decoration: none;
    margin-left: var(--space-2);
  }
  .panel__link:hover {
    text-decoration: underline;
  }
  .panel__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
  .search {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .list {
    flex: 1;
    min-height: 200px;
    max-height: 360px;
    overflow-y: auto;
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    background: var(--bg-0);
  }
  .list__empty {
    padding: var(--space-4);
    color: var(--fg-1);
    font-size: var(--fs-sm);
    margin: 0;
  }
  .row {
    width: 100%;
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-3);
    background: transparent;
    border: none;
    border-bottom: var(--stroke-w) solid var(--stroke);
    cursor: pointer;
    text-align: left;
    color: var(--fg-0);
    font-family: var(--font-ui);
    transition: background-color var(--dur-base, 150ms) var(--ease-out);
  }
  .row:last-child {
    border-bottom: none;
  }
  .row:hover:not(:disabled) {
    background: var(--bg-1);
  }
  .row:disabled {
    cursor: progress;
    opacity: 0.6;
  }
  .row--existing .row__cta {
    color: var(--accent);
  }
  .row__main {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    flex: 1;
  }
  .row__name {
    font-size: var(--fs-md);
    color: var(--fg-0);
  }
  .row__meta {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    align-items: center;
    font-size: var(--fs-xs, 12px);
    color: var(--fg-1);
  }
  .row__desc {
    font-size: var(--fs-sm);
    color: var(--fg-1);
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
  .row__cta {
    font-size: var(--fs-sm);
    color: var(--fg-1);
    white-space: nowrap;
    align-self: center;
  }
  .badge {
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: 1px 6px;
    font-family: var(--font-mono);
    font-size: 11px;
    color: var(--fg-1);
  }
  .dim {
    color: var(--fg-1);
  }
  .mono {
    font-family: var(--font-mono);
  }
  .hint {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-xs);
  }
  .toggle {
    background: transparent;
    border: none;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    align-self: flex-start;
    padding: 0;
  }
  .err {
    color: var(--danger, #d04f4f);
    font-size: var(--fs-sm);
    margin: 0;
  }
</style>
