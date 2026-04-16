<!--
  Chip — Component/Chip (6wauX). Small informational tag.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
    tip?: string;
  }

  let { children, tip }: Props = $props();
</script>

<span class="chip" data-tip={tip}>
  {@render children()}
</span>

<style>
  .chip {
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--fg-1);
  }
  /* Instant hover tooltip. Mirrors the .bar__icon tooltip on the city
     page so icons + chips share the same visual language. */
  .chip[data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-sm, 4px);
    font-size: var(--fs-xs, 12px);
    color: var(--fg-0);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease-out);
    z-index: 20;
  }
  .chip[data-tip]:hover::after {
    opacity: 1;
  }
</style>
