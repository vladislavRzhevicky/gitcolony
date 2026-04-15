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

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open, onClose }: Props = $props();

  // Repo list state. Lazy-loaded — the request only fires the first time
  // the dialog opens. Subsequent opens reuse the in-memory list (and the
  // browser's HTTP cache too, since the proxy forwards cache-control).
  let repos = $state<OwnedRepo[]>([]);
  let loading = $state(false);
  let listError = $state<string | null>(null);
  let loaded = $state(false);

  let query = $state('');
  let showForks = $state(false);
  let showArchived = $state(false);

  // Submission state — shared between list-pick and the manual Advanced form.
  let submitting = $state(false);
  let submittingFullName = $state<string | null>(null);
  let formError = $state<string | null>(null);

  // Advanced (manual) form state.
  let showAdvanced = $state(false);
  let manualRepo = $state('');
  let pat = $state('');

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
      repos = (data.repos ?? []) as OwnedRepo[];
      loaded = true;
    } catch (err) {
      listError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      loading = false;
    }
  }

  // Trigger a load only on the open=false→true edge. A naive
  // `$effect(() => { if (open) loadRepos() })` would re-run whenever any
  // $state read inside loadRepos (loading, loaded, repos) changed — and
  // on a failed fetch that means an infinite retry loop. The edge guard
  // breaks that cycle; manual retry is a separate button.
  let prevOpen = false;
  $effect(() => {
    if (open && !prevOpen) loadRepos();
    prevOpen = open;
  });

  // Filtered list. Forks/archived hidden by default — they account for most
  // of the noise in long repo lists. Search matches case-insensitive
  // substring on full name OR description.
  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return repos.filter((r) => {
      if (!showForks && r.isFork) return false;
      if (!showArchived && r.isArchived) return false;
      if (q.length === 0) return true;
      if (r.fullName.toLowerCase().includes(q)) return true;
      if (r.description?.toLowerCase().includes(q)) return true;
      return false;
    });
  });

  async function generate(repoFullName: string, opts: { pat?: string } = {}) {
    if (submitting) return;
    submitting = true;
    submittingFullName = repoFullName;
    formError = null;
    try {
      const body: Record<string, unknown> = {
        repoFullName,
        visibility: 'unlisted',
      };
      if (opts.pat && opts.pat.length > 0) body.pat = opts.pat;
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

  async function pickRepo(r: OwnedRepo) {
    if (r.existingSlug) {
      await goto(`/cities/${r.existingSlug}`);
      return;
    }
    await generate(r.fullName);
  }

  async function submitManual(e: Event) {
    e.preventDefault();
    const name = manualRepo.trim();
    if (!name) return;
    await generate(name, { pat: pat.trim() });
  }

  function onBackdropClick(e: MouseEvent) {
    if (e.target === e.currentTarget) onClose();
  }

  function onKey(e: KeyboardEvent) {
    if (e.key === 'Escape') onClose();
  }

  // relativeTime lives in $lib/time so the dashboard can reuse it.
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="ncd-title"
    tabindex="-1"
    onclick={onBackdropClick}
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
        <div class="search__filters">
          <label class="chk">
            <input type="checkbox" bind:checked={showForks} /> show forks
          </label>
          <label class="chk">
            <input type="checkbox" bind:checked={showArchived} /> show archived
          </label>
        </div>
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
              : 'no matches — try clearing the search or showing forks/archived.'}
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
        {showAdvanced ? 'Hide' : 'Show'} advanced (manual repo / PAT)
      </button>

      {#if showAdvanced}
        <form class="manual" onsubmit={submitManual}>
          <Input
            label="Repository"
            placeholder="owner/name or https://github.com/owner/name"
            name="repo"
            bind:value={manualRepo}
          />
          <Input
            label="Personal access token (optional)"
            placeholder="ghp_…  — only needed for private repos"
            type="password"
            name="pat"
            bind:value={pat}
          />
          <div class="manual__actions">
            <Button variant="primary" type="submit" disabled={submitting}>
              {submitting && submittingFullName === manualRepo.trim()
                ? 'Starting…'
                : 'Generate'}
            </Button>
          </div>
        </form>
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
  .search__filters {
    display: flex;
    gap: var(--space-3);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .chk {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    cursor: pointer;
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
  .manual__actions {
    display: flex;
    justify-content: flex-end;
  }
  .err {
    color: var(--danger, #d04f4f);
    font-size: var(--fs-sm);
    margin: 0;
  }
</style>
