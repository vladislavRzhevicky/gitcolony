<!--
  Dashboard — lists the caller's colonies. Matches Dashboard V3 in
  docs/design.pen: page title on the left, "Add city" primary on the right,
  one card per colony with a gradient thumbnail, repo name, stat chips,
  last-sync line, and Open / Sync actions.

  The empty state (zero colonies) falls back to the original welcome card
  so new users still get an onboarding nudge.
-->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button, Card, Chip, NewCityDialog, TopBar, UserBadge } from '$lib/components';
  import { relativeTime } from '$lib/time';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  let dialogOpen = $state(false);
  // Per-row busy flag keyed by slug so clicking Sync on one card doesn't
  // disable the others.
  let syncing = $state<Record<string, boolean>>({});
  let rowError = $state<Record<string, string | null>>({});

  async function onSync(slug: string) {
    if (syncing[slug]) return;
    syncing = { ...syncing, [slug]: true };
    rowError = { ...rowError, [slug]: null };
    try {
      const res = await fetch(`/api/cities/${slug}/sync`, { method: 'POST' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Refresh the list so the "generating…" chip and progress appear.
      await invalidateAll();
    } catch (e) {
      rowError = {
        ...rowError,
        [slug]: e instanceof Error ? e.message : 'failed to sync',
      };
    } finally {
      syncing = { ...syncing, [slug]: false };
    }
  }

  // A colony is "working" when its latest job hasn't reached a terminal state.
  function isRunning(job: { status: string } | null | undefined) {
    return job && job.status !== 'done' && job.status !== 'failed';
  }

  // Cheap stable hash → hue. Used only for the placeholder thumbnail gradient
  // so colonies from different repos don't all look identical.
  function hue(seed: string | null | undefined, shift = 0): number {
    if (!seed) return (210 + shift) % 360;
    let h = 0;
    for (let i = 0; i < seed.length; i++) {
      h = (Math.imul(31, h) + seed.charCodeAt(i)) | 0;
    }
    return (((h >>> 0) % 360) + shift) % 360;
  }
</script>

<svelte:head>
  <title>Dashboard — GitColony</title>
</svelte:head>

<TopBar>
  {#snippet right()}
    <UserBadge login={data.user?.githubLogin} />
    <a class="icon-btn" href="/settings" aria-label="Settings" data-tip="Settings">
      <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" stroke-width="2"/><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
    </a>
    <form method="POST" action="/auth/logout" class="signout">
      <button type="submit" class="icon-btn" aria-label="Sign out" data-tip="Sign out">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      </button>
    </form>
  {/snippet}
</TopBar>

<main class="dash">
  {#if data.cities.length === 0}
    <!-- Empty state: preserve the original onboarding card. -->
    <header class="dash__head">
      <p class="dash__eyebrow">Dashboard</p>
      <h1 class="dash__title">
        Welcome, <span class="mono">@{data.user?.githubLogin ?? 'anonymous'}</span>
      </h1>
      <p class="dash__sub">
        Your colonies will appear here. Generate one from any repository you own
        — we read metadata through the GitHub GraphQL API and never touch your code.
      </p>
    </header>

    <section class="dash__empty">
      <Card>
        <div class="empty">
          <div class="empty__art" aria-hidden="true"></div>
          <h2 class="empty__title">No colonies yet</h2>
          <p class="empty__body">
            Point us at a repository you own and we'll turn its structure into a
            living 3D world. Generation takes about a minute for a typical repo.
          </p>
          <div class="empty__actions">
            <Button variant="primary" onclick={() => (dialogOpen = true)}>
              Generate a colony
            </Button>
            <Button variant="secondary" href="/#showcase">See examples</Button>
          </div>
          <div class="empty__chips">
            <Chip>Deterministic</Chip>
            <Chip>Shareable by URL</Chip>
            <Chip>Revocable</Chip>
          </div>
        </div>
      </Card>
    </section>
  {:else}
    <header class="dash__head dash__head--row">
      <h1 class="dash__title">Your colonies</h1>
      <Button variant="primary" onclick={() => (dialogOpen = true)}>+ Add city</Button>
    </header>

    <ul class="list">
      {#each data.cities as city (city.id)}
        {@const running = isRunning(city.latestJob)}
        <li>
          <Card>
            <div class="row">
              <!-- Deterministic thumbnail derived from the seed so each colony
                   gets a stable, unique-looking tile until we render real
                   miniature screenshots. -->
              <div
                class="row__thumb"
                aria-hidden="true"
                style:--h1="{hue(city.seed)}deg"
                style:--h2="{hue(city.seed, 120)}deg"
              ></div>

              <div class="row__body">
                <a class="row__name mono" href="/cities/{city.slug}">
                  {city.repoFullName}
                </a>
                <div class="row__chips">
                  {#if city.stats}
                    <Chip>{city.stats.inhabitants} agents</Chip>
                    <Chip>{city.stats.buildings} buildings</Chip>
                    <Chip>{city.stats.commits} commits</Chip>
                  {:else if running}
                    <Chip>{city.latestJob?.phase ?? 'queued'} · {city.latestJob?.progress ?? 0}%</Chip>
                  {:else}
                    <Chip>no world yet</Chip>
                  {/if}
                  {#if city.visibility !== 'unlisted'}
                    <Chip>{city.visibility}</Chip>
                  {/if}
                </div>
                <p class="row__meta">
                  {#if city.lastSyncedAt}
                    Last synced {relativeTime(city.lastSyncedAt)}
                  {:else}
                    Created {relativeTime(city.createdAt)}
                  {/if}
                </p>
                {#if rowError[city.slug]}
                  <p class="row__err" role="alert">{rowError[city.slug]}</p>
                {/if}
              </div>

              <div class="row__actions">
                <Button variant="primary" href="/cities/{city.slug}">Open</Button>
                <Button
                  variant="secondary"
                  disabled={syncing[city.slug] || !!running}
                  onclick={() => onSync(city.slug)}
                >
                  {syncing[city.slug] ? 'Syncing…' : running ? 'Generating…' : 'Sync'}
                </Button>
              </div>
            </div>
          </Card>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<NewCityDialog open={dialogOpen} onClose={() => (dialogOpen = false)} />

<style>
  .signout {
    margin: 0;
  }
  /* Icon-only controls in the top-bar. `data-tip` gives an instant
     tooltip below the icon — the native title attribute has a ~1s
     browser delay that feels broken for these small actions. */
  .icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--fg-1);
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .icon-btn:hover {
    color: var(--fg-0);
    background: var(--bg-2);
  }
  .icon-btn svg {
    width: 18px;
    height: 18px;
  }
  .icon-btn[data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    color: var(--fg-0);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease-out);
    z-index: 20;
  }
  .icon-btn[data-tip]:hover::after,
  .icon-btn[data-tip]:focus-visible::after {
    opacity: 1;
  }

  .dash {
    flex: 1;
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    padding: 64px var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .dash__head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .dash__head--row {
    flex-direction: row;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .dash__eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .dash__title {
    font-family: var(--font-head);
    font-size: 32px;
    font-weight: var(--fw-semibold);
    margin: 0;
    color: var(--fg-0);
  }
  .dash__sub {
    margin: 0;
    color: var(--fg-1);
    max-width: 64ch;
    line-height: 1.6;
  }
  .mono {
    font-family: var(--font-mono);
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }

  .row {
    display: grid;
    grid-template-columns: 96px 1fr auto;
    gap: var(--space-4);
    align-items: center;
  }
  .row__thumb {
    width: 96px;
    height: 96px;
    border-radius: var(--radius-md);
    border: var(--stroke-w) solid var(--stroke);
    background:
      radial-gradient(
        circle at 30% 35%,
        hsl(var(--h1) 60% 45% / 0.55),
        transparent 60%
      ),
      radial-gradient(
        circle at 70% 65%,
        hsl(var(--h2) 60% 45% / 0.45),
        transparent 65%
      ),
      var(--bg-0);
  }
  .row__body {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
  }
  .row__name {
    color: var(--fg-0);
    font-size: var(--fs-md);
    font-weight: var(--fw-semibold);
    text-decoration: none;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .row__name:hover {
    color: var(--accent);
  }
  .row__chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .row__meta {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-sm);
  }
  .row__err {
    margin: 0;
    color: var(--danger, #d04f4f);
    font-size: var(--fs-sm);
  }
  .row__actions {
    display: flex;
    gap: var(--space-2);
    align-items: center;
  }

  .empty {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    align-items: flex-start;
    padding: var(--space-4) 0;
  }
  .empty__art {
    width: 100%;
    height: 180px;
    border-radius: var(--radius-md);
    background:
      radial-gradient(
        circle at 30% 40%,
        color-mix(in srgb, var(--accent) 25%, transparent),
        transparent 55%
      ),
      radial-gradient(
        circle at 70% 65%,
        color-mix(in srgb, var(--accent-2) 20%, transparent),
        transparent 60%
      ),
      var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
  }
  .empty__title {
    font-family: var(--font-head);
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    margin: 0;
  }
  .empty__body {
    margin: 0;
    color: var(--fg-1);
    max-width: 56ch;
    line-height: 1.55;
  }
  .empty__actions {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
  }
  .empty__chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  @media (max-width: 640px) {
    .row {
      grid-template-columns: 64px 1fr;
    }
    .row__thumb {
      width: 64px;
      height: 64px;
    }
    .row__actions {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
</style>
