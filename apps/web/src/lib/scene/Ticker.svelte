<!--
  Ticker — thin horizontal strip pinned to the bottom of the scene that
  rotates through World.ticker events one at a time with a fade transition.
  Auto-rotation pauses on hover so users can read a long line. If the
  ticker is empty the strip does not render at all.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { fade } from 'svelte/transition';
  import type { TickerEvent } from '@gitcolony/schema';

  interface Props {
    events: readonly TickerEvent[];
  }
  let { events }: Props = $props();

  // Rotation cadence — long enough to comfortably read a 100ish-char line
  // without becoming wallpaper. Pause on hover lets users linger.
  const INTERVAL_MS = 4000;

  let idx = $state(0);
  let paused = $state(false);
  let timer: ReturnType<typeof setInterval> | null = null;

  // Re-clamp the active index whenever the events list shrinks (sync that
  // returned fewer events than the previous one).
  $effect(() => {
    if (events.length === 0) {
      idx = 0;
    } else if (idx >= events.length) {
      idx = 0;
    }
  });

  onMount(() => {
    timer = setInterval(() => {
      if (paused) return;
      if (events.length <= 1) return;
      idx = (idx + 1) % events.length;
    }, INTERVAL_MS);
  });

  onDestroy(() => {
    if (timer) clearInterval(timer);
  });

  const current = $derived(events[idx] ?? null);
</script>

{#if events.length > 0 && current}
  <div
    class="ticker"
    role="status"
    aria-live="polite"
    onmouseenter={() => (paused = true)}
    onmouseleave={() => (paused = false)}
  >
    {#key current.id}
      <p class="ticker__line" in:fade={{ duration: 320 }} out:fade={{ duration: 240 }}>
        {#if current.author}
          <span class="ticker__author mono">@{current.author}</span>
        {/if}
        <span class="ticker__text">{current.text}</span>
      </p>
    {/key}
  </div>
{/if}

<style>
  .ticker {
    position: absolute;
    left: 50%;
    bottom: var(--space-4);
    transform: translateX(-50%);
    z-index: 4;
    width: min(720px, 80vw);
    height: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 var(--space-4);
    background: color-mix(in srgb, var(--bg-1) 88%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    backdrop-filter: blur(8px);
    overflow: hidden;
  }
  .ticker__line {
    margin: 0;
    display: inline-flex;
    gap: var(--space-2);
    align-items: baseline;
    font-size: var(--fs-sm);
    color: var(--fg-0);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    max-width: 100%;
  }
  .ticker__author {
    color: var(--accent);
  }
  .ticker__text {
    color: var(--fg-0);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
