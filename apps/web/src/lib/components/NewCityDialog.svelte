<!--
  NewCityDialog — modal triggered from the dashboard.

  Lists the viewer's owned GitHub repos (loaded once via /api/me/repos on
  open) with search-by-name. Picking a row that already has a colony
  navigates to it; otherwise it kicks off generation. The Advanced section
  preserves the manual "owner/name + PAT" path for repos outside the list
  (orgs, private with PAT, etc.) — same submit handler as before.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import Button from './Button.svelte';
  import Input from './Input.svelte';
  import { relativeTime } from '$lib/time';
  import type { OwnedRepo } from '@gitcolony/schema';

  // Per-row source tag. Decides what (if anything) we attach to POST
  // /cities when the user picks this row:
  //   - oauth   → use the session token (no extra field)
  //   - token   → saved user_tokens row; send `{ tokenId }`
  //   - inline  → unsaved PAT typed into the input; send `{ pat }`
  type Row =
    | (OwnedRepo & { source: 'oauth' })
    | (OwnedRepo & { source: 'token'; tokenId: string })
    | (OwnedRepo & { source: 'inline' });

  interface SavedToken {
    id: string;
    label: string;
    ownerLogin: string;
    scopes: string[] | null;
    createdAt: string;
    lastUsedAt: string | null;
  }

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  // Repo list state. Lazy-loaded — the request only fires the first time
  // the dialog opens. Subsequent opens reuse the in-memory list (and the
  // browser's HTTP cache too, since the proxy forwards cache-control).
  let repos = $state<Row[]>([]);
  let loading = $state(false);
  let listError = $state<string | null>(null);
  let loaded = $state(false);

  let query = $state('');

  // Submission state — shared between list-pick and the manual Advanced form.
  let submitting = $state(false);
  let submittingFullName = $state<string | null>(null);
  let formError = $state<string | null>(null);

  // Advanced (PAT) state.
  let showAdvanced = $state(false);
  let pat = $state('');
  let patLabel = $state('');
  let loadingFromPat = $state(false);
  let savingPat = $state(false);

  // Saved tokens — fetched on dialog open. Keyed state so the UI can show
  // per-row loading / delete spinners without a parent-wide flag.
  let savedTokens = $state<SavedToken[]>([]);
  let tokensLoading = $state(false);
  let tokensError = $state<string | null>(null);
  let tokenBusyId = $state<string | null>(null);

  // Merge rows into the list, deduping by fullName. Caller is expected to
  // drop rows from the same source first when it wants replace-semantics
  // (e.g. re-running an inline PAT).
  function mergeRepos(next: Row[]) {
    const seen = new Set(repos.map((r) => r.fullName));
    const additions: Row[] = [];
    for (const r of next) {
      if (seen.has(r.fullName)) continue;
      seen.add(r.fullName);
      additions.push(r);
    }
    repos = [...repos, ...additions];
  }

  async function loadRepos() {
    if (loaded || loading) return;
    loading = true;
    listError = null;
    try {
      const res = await fetch('/api/me/repos');
      const data = await res.json();
      if (!res.ok) {
        listError = typeof data.error === 'string' ? data.error : 'failed to load repositories';
        return;
      }
      const fetched = (data.repos ?? []) as OwnedRepo[];
      mergeRepos(fetched.map((r) => ({ ...r, source: 'oauth' as const })));
      loaded = true;
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      loading = false;
    }
  }

  // Fetch repos reachable by an inline PAT typed into the form.
  // Triggered by the explicit "Load repos from this token" button — no
  // auto-debounce. Replaces any prior `source: 'inline'` rows so the
  // list always reflects the currently-typed token.
  async function loadReposFromPat() {
    const token = pat.trim();
    if (!token) {
      listError = 'enter a token above first';
      return;
    }
    if (loadingFromPat) return;
    loadingFromPat = true;
    listError = null;
    try {
      const res = await fetch('/api/me/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ pat: token }),
      });
      const data = await res.json();
      if (!res.ok) {
        listError = typeof data.error === 'string' ? data.error : 'failed to load repositories';
        return;
      }
      repos = repos.filter((r) => r.source !== 'inline');
      const fetched = (data.repos ?? []) as OwnedRepo[];
      mergeRepos(fetched.map((r) => ({ ...r, source: 'inline' as const })));
      loaded = true;
      if (fetched.length === 0) {
        listError =
          'token is valid but GitHub returned 0 repositories — for fine-grained tokens on an org, ask the org owner to approve the token in GitHub → Organization settings → Personal access tokens';
      }
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      loadingFromPat = false;
    }
  }

  // Fetch repos reachable by a stored user_tokens row. Server decrypts
  // the PAT and forwards to GitHub. Rows land in the list with the
  // token id attached so pickRepo can forward `tokenId` later.
  async function loadReposFromSaved(tokenId: string) {
    if (tokenBusyId) return;
    tokenBusyId = tokenId;
    listError = null;
    try {
      const res = await fetch('/api/me/repos', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tokenId }),
      });
      const data = await res.json();
      if (!res.ok) {
        listError = typeof data.error === 'string' ? data.error : 'failed to load repositories';
        return;
      }
      // Replace rows for this specific saved token, keep others.
      repos = repos.filter(
        (r) => !(r.source === 'token' && r.tokenId === tokenId),
      );
      const fetched = (data.repos ?? []) as OwnedRepo[];
      mergeRepos(
        fetched.map((r) => ({ ...r, source: 'token' as const, tokenId })),
      );
      loaded = true;
      if (fetched.length === 0) {
        listError =
          'saved token returned 0 repositories — the org may need to approve it, or its repo access may have changed';
      }
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      tokenBusyId = null;
    }
  }

  async function loadSavedTokens() {
    if (tokensLoading) return;
    tokensLoading = true;
    tokensError = null;
    try {
      const res = await fetch('/api/me/tokens');
      const data = await res.json();
      if (!res.ok) {
        tokensError = typeof data.error === 'string' ? data.error : 'failed to load tokens';
        return;
      }
      savedTokens = (data.tokens ?? []) as SavedToken[];
    } catch (err) {
      tokensError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      tokensLoading = false;
    }
  }

  async function saveCurrentPat() {
    const token = pat.trim();
    const label = patLabel.trim();
    if (!token) {
      listError = 'enter a token above first';
      return;
    }
    if (!label) {
      listError = 'give the token a label (e.g. "work account")';
      return;
    }
    if (savingPat) return;
    savingPat = true;
    listError = null;
    try {
      const res = await fetch('/api/me/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label, pat: token }),
      });
      const data = await res.json();
      if (!res.ok) {
        const msg =
          typeof data.error === 'string'
            ? data.error
            : 'could not save token';
        listError = msg;
        return;
      }
      const created = data.token as { id: string; label: string; ownerLogin: string };
      // Clear the input — the saved entry takes over visually.
      pat = '';
      patLabel = '';
      // Convert existing inline rows (same PAT just saved) into token rows
      // so they persist across reloads without needing to refetch.
      repos = repos.map((r) =>
        r.source === 'inline'
          ? { ...r, source: 'token' as const, tokenId: created.id }
          : r,
      );
      await loadSavedTokens();
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      savingPat = false;
    }
  }

  async function deleteSavedToken(tokenId: string) {
    if (tokenBusyId) return;
    tokenBusyId = tokenId;
    try {
      const res = await fetch(`/api/me/tokens/${tokenId}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        tokensError = `delete failed: ${res.status}`;
        return;
      }
      savedTokens = savedTokens.filter((t) => t.id !== tokenId);
      // Drop repo rows tied to that token — without it we can't submit them.
      repos = repos.filter(
        (r) => !(r.source === 'token' && r.tokenId === tokenId),
      );
    } catch (err) {
      tokensError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      tokenBusyId = null;
    }
  }

  // Trigger a load only on the open=false→true edge. A naive
  // `$effect(() => { if (open) loadRepos() })` would re-run whenever any
  // $state read inside loadRepos (loading, loaded, repos) changed — and
  // on a failed fetch that means an infinite retry loop. The edge guard
  // breaks that cycle; manual retry is a separate button.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) {
      loadRepos();
      loadSavedTokens();
    }
    prevOpen = open;
  });

  // Filtered list. Search matches case-insensitive substring on full name
  // OR description. Forks / archived repos are shown as-is — the list is
  // already scoped to the user's own repos via /me/repos.
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
    opts: { pat?: string; tokenId?: string } = {},
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
      else if (opts.pat && opts.pat.length > 0) body.pat = opts.pat;
      const res = await fetch('/api/cities', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        // 409: a colony already exists for this repo (race with the join).
        // Refetch and navigate to it instead of surfacing the error.
        if (res.status === 409) {
          loaded = false;
          await loadRepos();
          const found = repos.find((r) => r.fullName === repoFullName);
          if (found?.existingSlug) {
            await goto(`/cities/${found.existingSlug}`);
            return;
          }
        }
        formError = typeof data.error === 'string' ? data.error : 'could not start generation';
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
    } else if (r.source === 'inline') {
      await generate(r.fullName, { pat: pat.trim() });
    } else {
      await generate(r.fullName);
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  // relativeTime lives in $lib/time so the dashboard can reuse it.
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
          Pick a repository you own. Already-generated colonies open instead
          of regenerating.
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
        {#if loading && !loaded}
          <p class="list__empty mono">loading repositories…</p>
        {:else if listError}
          <div class="list__empty">
            <p class="err" role="alert">{listError}</p>
            <button type="button" class="toggle" onclick={() => { loaded = false; loadRepos(); }}>
              retry
            </button>
          </div>
        {:else if filtered.length === 0}
          <p class="list__empty">
            {repos.length === 0
              ? 'no owned repositories found.'
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

      <button
        type="button"
        class="toggle"
        onclick={() => (showAdvanced = !showAdvanced)}
      >
        {showAdvanced ? 'Hide' : 'Show'} advanced (use a personal access token)
      </button>

      {#if showAdvanced}
        <div class="manual">
          <div class="pat-field">
            <Input
              label="Personal access token (optional)"
              placeholder="ghp_…  — only needed for private repos"
              type="password"
              name="pat"
              bind:value={pat}
            />
            <span
              class="help"
              tabindex="0"
              role="button"
              aria-label="How to create a token"
            >
              ?
              <span class="help__tip" role="tooltip">
                <strong>Create a fine-grained GitHub token</strong>
                <ol>
                  <li>
                    Open
                    <a
                      href="https://github.com/settings/personal-access-tokens/new"
                      target="_blank"
                      rel="noreferrer noopener"
                    >
                      github.com/settings/personal-access-tokens/new
                    </a>
                  </li>
                  <li>
                    <em>Repository access</em> → <em>Only select repositories</em> →
                    pick the repo you want to import.
                  </li>
                  <li>
                    <em>Repository permissions</em> →
                    <code>Contents: Read-only</code>,
                    <code>Metadata: Read-only</code>.
                  </li>
                  <li>Generate, copy the <code>github_pat_…</code> value, paste above.</li>
                </ol>
                <p class="help__note">
                  Classic tokens work too — scope <code>repo</code> is enough.
                  Tokens are stored encrypted and only used to read commits.
                </p>
              </span>
            </span>
          </div>
          <div class="pat-label">
            <Input
              label="Label (required to save)"
              placeholder="e.g. work account, bitstarz org"
              name="pat-label"
              bind:value={patLabel}
            />
          </div>
          <div class="manual__actions">
            <button
              type="button"
              class="toggle"
              onclick={loadReposFromPat}
              disabled={loadingFromPat || pat.trim().length === 0}
            >
              {loadingFromPat
                ? 'loading…'
                : repos.some((r) => r.source === 'inline')
                  ? 'reload repositories'
                  : 'load repositories'}
            </button>
            <button
              type="button"
              class="toggle"
              onclick={saveCurrentPat}
              disabled={savingPat || pat.trim().length === 0 || patLabel.trim().length === 0}
            >
              {savingPat ? 'saving…' : 'save token'}
            </button>
            <span class="manual__hint-text">
              save to reuse later without pasting again
            </span>
          </div>
        </div>

        <div class="saved">
          <div class="saved__head">
            <h3 class="saved__title">Saved tokens</h3>
            {#if tokensLoading}
              <span class="dim">loading…</span>
            {/if}
          </div>
          {#if tokensError}
            <p class="err" role="alert">{tokensError}</p>
          {/if}
          {#if !tokensLoading && savedTokens.length === 0 && !tokensError}
            <p class="saved__empty">
              no saved tokens yet — paste one above and click <em>save token</em>.
            </p>
          {/if}
          {#each savedTokens as t (t.id)}
            <div class="saved__row">
              <div class="saved__main">
                <span class="saved__label">{t.label}</span>
                <span class="saved__meta mono">
                  @{t.ownerLogin}
                  {#if t.lastUsedAt}· used {relativeTime(t.lastUsedAt)}{/if}
                </span>
              </div>
              <div class="saved__actions">
                <button
                  type="button"
                  class="toggle"
                  onclick={() => loadReposFromSaved(t.id)}
                  disabled={tokenBusyId !== null}
                >
                  {tokenBusyId === t.id ? 'loading…' : 'load repos'}
                </button>
                <button
                  type="button"
                  class="toggle toggle--danger"
                  onclick={() => deleteSavedToken(t.id)}
                  disabled={tokenBusyId !== null}
                  aria-label="delete token"
                >
                  delete
                </button>
              </div>
            </div>
          {/each}
        </div>
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
  .row:last-child { border-bottom: none; }
  .row:hover:not(:disabled) { background: var(--bg-1); }
  .row:disabled { cursor: progress; opacity: 0.6; }
  .row--existing .row__cta { color: var(--accent); }
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
  .dim { color: var(--fg-1); }
  .mono { font-family: var(--font-mono); }
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
  .manual {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .err {
    color: var(--danger, #d04f4f);
    font-size: var(--fs-sm);
    margin: 0;
  }
  .pat-field {
    position: relative;
  }
  .manual__actions {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .manual__hint-text {
    font-size: var(--fs-xs, 12px);
    color: var(--fg-1);
  }
  .toggle:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .toggle--danger {
    color: var(--danger, #d04f4f);
  }
  .saved {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding-top: var(--space-2);
    border-top: var(--stroke-w) solid var(--stroke);
  }
  .saved__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .saved__title {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-semibold);
    color: var(--fg-0);
  }
  .saved__empty {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .saved__row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    background: var(--bg-0);
  }
  .saved__main {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .saved__label {
    font-size: var(--fs-md);
    color: var(--fg-0);
  }
  .saved__meta {
    font-size: var(--fs-xs, 12px);
    color: var(--fg-1);
  }
  .saved__actions {
    display: flex;
    gap: var(--space-3);
  }
  .help {
    position: absolute;
    top: 2px;
    right: 0;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: var(--stroke-w) solid var(--stroke);
    color: var(--fg-1);
    font-size: 11px;
    font-family: var(--font-ui);
    line-height: 1;
    cursor: help;
    user-select: none;
    transition: color var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out);
  }
  .help:hover,
  .help:focus-visible {
    color: var(--accent);
    border-color: var(--accent);
    outline: none;
  }
  .help__tip {
    position: absolute;
    bottom: calc(100% + 8px);
    right: -8px;
    z-index: 10;
    width: 320px;
    padding: var(--space-3);
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    color: var(--fg-0);
    font-size: var(--fs-sm);
    font-family: var(--font-ui);
    line-height: 1.5;
    opacity: 0;
    pointer-events: none;
    transform: translateY(4px);
    transition: opacity var(--dur-fast) var(--ease-out),
      transform var(--dur-fast) var(--ease-out);
    cursor: auto;
  }
  .help:hover .help__tip,
  .help:focus-visible .help__tip,
  .help__tip:hover {
    opacity: 1;
    pointer-events: auto;
    transform: translateY(0);
  }
  .help__tip strong {
    display: block;
    margin-bottom: var(--space-2);
    font-weight: var(--fw-semibold);
  }
  .help__tip ol {
    margin: 0;
    padding-left: 1.2em;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }
  .help__tip a {
    color: var(--accent);
    word-break: break-all;
  }
  .help__tip code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-0);
    padding: 1px 5px;
    border-radius: 4px;
  }
  .help__note {
    margin: var(--space-2) 0 0;
    color: var(--fg-1);
    font-size: var(--fs-xs, 12px);
  }
</style>
