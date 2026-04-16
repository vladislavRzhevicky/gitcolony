<!--
  City page — full-bleed 3D canvas with floating chrome (header pill,
  tool rail, status chip). Mirrors City View V3 in docs/design.pen.
  Clicking a building / decor / agent pops the commit-details side panel.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { invalidateAll, goto } from '$app/navigation';
  import { Canvas } from '@threlte/core';
  import { Chip, ConfirmDialog } from '$lib/components';
  import ColonyScene from '$lib/scene/ColonyScene.svelte';
  import CommitPanel from '$lib/scene/CommitPanel.svelte';
  import Ticker from '$lib/scene/Ticker.svelte';
  import type { Picked } from '$lib/scene/mapping';
  import type { JobPhase, JobProgressEvent, World } from '@gitcolony/schema';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const PHASES: JobPhase[] = [
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
  ];

  let phase = $state<JobPhase>('queued');
  let progress = $state<number>(0);
  let message = $state<string | null>(null);
  let errorMsg = $state<string | null>(null);
  let world = $state<World | null>(null);
  let picked = $state<Picked | null>(null);
  let es: EventSource | null = null;

  $effect(() => {
    phase = (data.job?.phase as JobPhase) ?? 'queued';
    progress = data.job?.progress ?? 0;
    message = data.job?.message ?? null;
    errorMsg = data.job?.error ?? null;
    world = data.world;
  });

  const isTerminal = $derived(phase === 'done' || phase === 'failed');

  onMount(() => {
    if (world && isTerminal) return;
    es = new EventSource(`/api/cities/${data.slug}/events`);
    es.addEventListener('progress', async (ev) => {
      try {
        const evt = JSON.parse((ev as MessageEvent).data) as JobProgressEvent;
        phase = evt.phase;
        progress = evt.progress;
        message = evt.message ?? null;
        errorMsg = evt.error ?? null;
        if (evt.phase === 'done' || evt.phase === 'failed') {
          // Close BEFORE awaiting anything so the browser doesn't auto-
          // reconnect the tiny window between server close and our handler.
          es?.close();
          es = null;
          if (evt.phase === 'done') await invalidateAll();
        }
      } catch {
        // malformed payload — ignore frame
      }
    });
    es.onerror = () => {
      // If the stream is terminal there's no reason to let the browser retry.
      if (isTerminal) {
        es?.close();
        es = null;
      }
    };
  });

  onDestroy(() => es?.close());

  let busy = $state(false);
  let actionError = $state<string | null>(null);
  let confirming = $state<'regenerate' | 'delete' | null>(null);

  async function resubscribe() {
    es?.close();
    es = new EventSource(`/api/cities/${data.slug}/events`);
    es.addEventListener('progress', async (ev) => {
      try {
        const evt = JSON.parse((ev as MessageEvent).data) as JobProgressEvent;
        phase = evt.phase;
        progress = evt.progress;
        message = evt.message ?? null;
        errorMsg = evt.error ?? null;
        if (evt.phase === 'done' || evt.phase === 'failed') {
          es?.close();
          es = null;
          if (evt.phase === 'done') await invalidateAll();
        }
      } catch {}
    });
  }

  async function onRegenerate() {
    if (busy) return;
    busy = true;
    actionError = null;
    try {
      const res = await fetch(`/api/cities/${data.slug}/regenerate`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      world = null;
      phase = 'queued';
      progress = 0;
      message = null;
      errorMsg = null;
      await resubscribe();
      confirming = null;
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'failed to regenerate';
      confirming = null;
    } finally {
      busy = false;
    }
  }

  async function onSync() {
    if (busy) return;
    busy = true;
    actionError = null;
    try {
      const res = await fetch(`/api/cities/${data.slug}/sync`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      phase = 'queued';
      progress = 0;
      message = null;
      errorMsg = null;
      await resubscribe();
      await invalidateAll();
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'failed to sync';
    } finally {
      busy = false;
    }
  }

  async function onDelete() {
    if (busy) return;
    busy = true;
    actionError = null;
    try {
      const res = await fetch(`/api/cities/${data.slug}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) throw new Error(`HTTP ${res.status}`);
      await goto('/');
    } catch (e) {
      actionError = e instanceof Error ? e.message : 'failed to delete';
      confirming = null;
      busy = false;
    }
  }

  // Building breakdown by Kenney kit prefix — `suburban-*`, `commercial-*`
  // (including `commercial-skyscraper-*`), `industrial-*`. Only tier-B
  // objects carry kit variants; decor lives in its own tables. We surface
  // just the kits actually present so small repos (suburban-only) don't
  // stare at two empty zero-chips.
  const buildingCounts = $derived.by(() => {
    let suburban = 0;
    let commercial = 0;
    let industrial = 0;
    if (!world) return { suburban, commercial, industrial };
    for (const o of world.objects) {
      if (o.kind !== 'building') continue;
      if (o.variant.startsWith('suburban-')) suburban++;
      else if (o.variant.startsWith('commercial-')) commercial++;
      else if (o.variant.startsWith('industrial-')) industrial++;
    }
    return { suburban, commercial, industrial };
  });

  // Quarter count excludes outskirts — it's the invariant-#3 fallback and
  // always exists, so counting it inflates the figure by 1 even for empty
  // repos. Graveyard is included when present since it's a real named
  // quarter with its own pad and theme.
  const districtCount = $derived(
    world ? world.districts.filter((d) => !d.isOutskirts).length : 0,
  );

  // Friendly "synced Nm ago" line for the bottom-left status chip.
  // We use lastSyncedAt from the city row if present, else show phase while
  // a run is in progress.
  const lastSyncedAt = $derived(data.city?.lastSyncedAt ?? null);
  function syncedLabel(ts: string | Date | null): string {
    if (!ts) return 'Never synced';
    const d = typeof ts === 'string' ? new Date(ts) : ts;
    const diff = Date.now() - d.getTime();
    const m = Math.floor(diff / 60000);
    if (m < 1) return 'Synced just now';
    if (m < 60) return `Synced ${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `Synced ${h}h ago`;
    const days = Math.floor(h / 24);
    return `Synced ${days}d ago`;
  }
</script>

<svelte:head>
  <title>{data.city?.repoFullName ?? 'colony'} — GitColony</title>
</svelte:head>

<div class="stage">
  <!-- Full-bleed 3D canvas ---------------------------------------------- -->
  {#if world}
    <div class="stage__canvas">
      <Canvas>
        <ColonyScene {world} onPick={(p) => (picked = p)} />
      </Canvas>
    </div>
  {:else}
    <div class="stage__canvas stage__canvas--empty" aria-hidden="true"></div>
  {/if}

  <!-- Floating header pill (cvBar) -------------------------------------- -->
  <header class="bar">
    <a class="bar__brand" href="/">GitColony</a>
    <span class="bar__sep" aria-hidden="true"></span>
    <span class="bar__repo mono">{data.city?.repoFullName}</span>
    {#if world}
      <span class="bar__sep" aria-hidden="true"></span>
      <Chip tip="Inhabitants (agents)">
        <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"/></svg>
        {world.stats.inhabitants}
      </Chip>
      <Chip tip="Districts">
        <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z"/></svg>
        {districtCount}
      </Chip>
      {#if buildingCounts.suburban > 0}
        <Chip tip="Suburban buildings">
          <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 10l9-7 9 7v11a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z"/></svg>
          {buildingCounts.suburban}
        </Chip>
      {/if}
      {#if buildingCounts.commercial > 0}
        <Chip tip="Commercial buildings">
          <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 22V6a2 2 0 0 1 2-2h6a2 2 0 0 1 2 2v16M14 10h4a2 2 0 0 1 2 2v10M8 8h2M8 12h2M8 16h2M16 14h0M16 18h0"/></svg>
          {buildingCounts.commercial}
        </Chip>
      {/if}
      {#if buildingCounts.industrial > 0}
        <Chip tip="Industrial buildings">
          <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M2 22V12l6 4v-4l6 4V8l8-4v18zM6 18h0M12 18h0M18 18h0"/></svg>
          {buildingCounts.industrial}
        </Chip>
      {/if}
      <Chip tip={world.stats.totalCommits !== undefined && world.stats.totalCommits !== world.stats.commits ? `Commits on default branch (${world.stats.commits} ingested)` : 'Commits'}>
        <svg class="chip-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M12 2a6 6 0 0 0-4 10.5A6 6 0 0 0 12 22a6 6 0 0 0 4-9.5A6 6 0 0 0 12 2ZM12 22v-9"/></svg>
        {world.stats.totalCommits ?? world.stats.commits}
      </Chip>
    {/if}
    <span class="bar__sep" aria-hidden="true"></span>
    <button
      type="button"
      class="bar__icon"
      disabled={busy || !isTerminal}
      onclick={onSync}
      aria-label="Sync"
      data-tip="Sync"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M21 12a9 9 0 0 1-15 6.7L3 16M3 12a9 9 0 0 1 15-6.7L21 8M21 3v5h-5M3 21v-5h5"/></svg>
    </button>
    <button
      type="button"
      class="bar__icon"
      disabled={busy}
      onclick={() => (confirming = 'regenerate')}
      aria-label="Regenerate"
      data-tip="Regenerate"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>
    </button>
    <button
      type="button"
      class="bar__icon bar__icon--danger"
      disabled={busy}
      onclick={() => (confirming = 'delete')}
      aria-label="Delete"
      data-tip="Delete colony"
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M6 6l1 14a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-14M10 11v6M14 11v6"/></svg>
    </button>
  </header>

  <!-- Floating tool rail (cvRail) --------------------------------------- -->
  <nav class="rail" aria-label="Camera">
    <button type="button" class="rail__btn" aria-label="Move">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M5 9l-3 3 3 3M9 5l3-3 3 3M15 19l-3 3-3-3M19 9l3 3-3 3M2 12h20M12 2v20"/></svg>
    </button>
    <button type="button" class="rail__btn rail__btn--active" aria-label="Orbit" aria-pressed="true">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" d="M20.2 20.2c2.04-2.03.02-7.36-4.5-11.9-4.54-4.52-9.87-6.54-11.9-4.5-2.04 2.03-.02 7.36 4.5 11.9 4.54 4.52 9.87 6.54 11.9 4.5Z"/></svg>
    </button>
    <button type="button" class="rail__btn" aria-label="Zoom in">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M21 21l-4.3-4.3M8 11h6M11 8v6"/></svg>
    </button>
    <button type="button" class="rail__btn" aria-label="Zoom out">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" d="M21 21l-4.3-4.3M8 11h6"/></svg>
    </button>
    <button type="button" class="rail__btn" aria-label="Reset camera">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/></svg>
    </button>
  </nav>

  <!-- Floating status chip (cvFoot) ------------------------------------- -->
  <div class="status" role="status" aria-live="polite">
    {#if isTerminal}
      <span class="status__dot status__dot--ok" aria-hidden="true"></span>
      <span class="status__label">{syncedLabel(lastSyncedAt)}</span>
    {:else}
      <span class="status__dot status__dot--live" aria-hidden="true"></span>
      <span class="status__label mono">{phase} · {Math.round(progress)}%</span>
    {/if}
  </div>

  <!-- Action error (bottom-left, above status) -------------------------- -->
  {#if actionError}
    <p class="action-err" role="alert">{actionError}</p>
  {/if}

  <!-- Generation overlay ------------------------------------------------ -->
  {#if !isTerminal || !world}
    <div class="overlay">
      <div class="overlay__card">
        <p class="overlay__eyebrow">Generating colony</p>
        <h2 class="overlay__title mono">{data.city?.repoFullName}</h2>
        <div class="overlay__label">
          <span class="mono">{phase}</span>
          <span class="overlay__pct">{Math.round(progress)}%</span>
        </div>
        <div class="overlay__track" aria-hidden="true">
          <div class="overlay__bar" style:width="{Math.max(2, progress)}%"></div>
        </div>
        {#if message}<p class="overlay__msg">{message}</p>{/if}
        {#if errorMsg}<p class="overlay__err" role="alert">{errorMsg}</p>{/if}
        <ol class="overlay__steps">
          {#each PHASES as p (p)}
            <li
              class="overlay__step"
              class:overlay__step--active={p === phase}
              class:overlay__step--done={PHASES.indexOf(phase) > PHASES.indexOf(p)}
            >
              <span class="mono">{p}</span>
            </li>
          {/each}
        </ol>
      </div>
    </div>
  {/if}

  {#if world}
    <CommitPanel {picked} onClose={() => (picked = null)} />
    <Ticker events={world.ticker ?? []} />
  {/if}

  <ConfirmDialog
    open={confirming === 'regenerate'}
    title="Regenerate colony?"
    message="This rebuilds the world from scratch using the latest commits. The existing layout will be replaced."
    confirmLabel="Regenerate"
    variant="primary"
    busy={busy && confirming === 'regenerate'}
    onConfirm={onRegenerate}
    onCancel={() => (confirming = null)}
  />

  <ConfirmDialog
    open={confirming === 'delete'}
    title="Delete colony?"
    message="The world, agents, and ingested commit history for this repo will be permanently removed. This cannot be undone."
    confirmLabel="Delete"
    variant="danger"
    busy={busy && confirming === 'delete'}
    onConfirm={onDelete}
    onCancel={() => (confirming = null)}
  />
</div>

<style>
  /* Full-viewport stage — the 3D canvas is the subject, chrome floats. */
  .stage {
    position: fixed;
    inset: 0;
    overflow: hidden;
    background:
      radial-gradient(
        ellipse 70% 60% at 50% 40%,
        var(--bg-2) 0%,
        var(--bg-0) 100%
      );
  }

  .stage__canvas {
    position: absolute;
    inset: 0;
  }

  .mono {
    font-family: var(--font-mono);
  }

  /* Header pill ------------------------------------------------------- */
  .bar {
    position: absolute;
    top: var(--space-4);
    left: 50%;
    transform: translateX(-50%);
    display: inline-flex;
    align-items: center;
    gap: var(--space-4);
    padding: var(--space-2) var(--space-4);
    background: color-mix(in srgb, var(--bg-1) 86%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: 6px;
    backdrop-filter: blur(8px);
    z-index: 10;
  }
  .bar__brand {
    font-family: var(--font-head);
    font-size: 16px;
    font-weight: var(--fw-semibold);
    color: var(--accent);
  }
  .bar__repo {
    font-size: var(--fs-md);
    font-weight: var(--fw-medium);
    color: var(--fg-0);
  }
  .bar__sep {
    width: 1px;
    height: 20px;
    background: var(--stroke);
  }
  .bar__icon {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--fg-1);
    transition: color var(--dur-fast) var(--ease-out);
  }
  /* Instant CSS tooltip — native [title] has a ~1s browser delay. Renders
     below the icon so it doesn't cover the top-bar controls to either side. */
  .bar__icon[data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-sm, 4px);
    font-family: var(--font-ui);
    font-size: var(--fs-xs, 12px);
    color: var(--fg-0);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease-out);
    z-index: 20;
  }
  .bar__icon[data-tip]:hover::after,
  .bar__icon[data-tip]:focus-visible::after {
    opacity: 1;
  }
  .bar__icon:hover:not(:disabled) {
    color: var(--fg-0);
  }
  .bar__icon:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .bar__icon--danger:hover:not(:disabled) {
    color: var(--danger);
  }
  .bar__icon svg {
    width: 16px;
    height: 16px;
  }
  .chip-ico {
    width: 12px;
    height: 12px;
    color: var(--fg-1);
  }

  /* Tool rail --------------------------------------------------------- */
  .rail {
    position: absolute;
    top: 80px;
    left: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2);
    width: 48px;
    background: color-mix(in srgb, var(--bg-1) 86%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: 6px;
    backdrop-filter: blur(8px);
    z-index: 3;
  }
  .rail__btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    color: var(--fg-1);
    transition:
      color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .rail__btn:hover {
    color: var(--fg-0);
    background: var(--bg-2);
  }
  .rail__btn--active {
    background: var(--bg-2);
    color: var(--accent);
  }
  .rail__btn svg {
    width: 16px;
    height: 16px;
  }

  /* Status chip ------------------------------------------------------- */
  .status {
    position: absolute;
    left: var(--space-4);
    bottom: var(--space-4);
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    padding: 6px var(--space-3);
    background: color-mix(in srgb, var(--bg-1) 73%, transparent);
    border-radius: var(--radius-md);
    font-size: var(--fs-xs);
    color: var(--fg-1);
    z-index: 3;
  }
  .status__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }
  .status__dot--ok {
    background: var(--success);
  }
  .status__dot--live {
    background: var(--accent);
    animation: pulse 1.4s ease-in-out infinite;
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  .action-err {
    position: absolute;
    left: var(--space-4);
    bottom: 44px;
    margin: 0;
    padding: 6px var(--space-3);
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    border: var(--stroke-w) solid var(--danger);
    border-radius: var(--radius-md);
    color: var(--fg-0);
    font-size: var(--fs-xs);
    z-index: 3;
  }

  /* Generation overlay ----------------------------------------------- */
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
    z-index: 2;
    pointer-events: none;
  }
  .overlay__card {
    pointer-events: auto;
    width: min(440px, 100%);
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    backdrop-filter: blur(12px);
  }
  .overlay__eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .overlay__title {
    margin: 0;
    font-size: var(--fs-lg);
    color: var(--fg-0);
  }
  .overlay__label {
    display: flex;
    justify-content: space-between;
    font-size: var(--fs-md);
    color: var(--fg-0);
  }
  .overlay__pct {
    color: var(--fg-1);
    font-family: var(--font-mono);
  }
  .overlay__track {
    width: 100%;
    height: 4px;
    background: var(--bg-2);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .overlay__bar {
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-sm);
    transition: width var(--dur-base) var(--ease-out);
  }
  .overlay__msg {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-sm);
  }
  .overlay__err {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
  }
  .overlay__steps {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
    font-size: var(--fs-xs);
  }
  .overlay__step {
    color: var(--fg-1);
    opacity: 0.5;
  }
  .overlay__step--done {
    opacity: 1;
  }
  .overlay__step--active {
    opacity: 1;
    color: var(--accent);
  }
</style>
