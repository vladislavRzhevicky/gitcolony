<!--
  Chip — Component/Chip (6wauX). Small informational tag.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<span class="chip">
  {@render children()}
</span>

<style>
  .chip {
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
</style>
