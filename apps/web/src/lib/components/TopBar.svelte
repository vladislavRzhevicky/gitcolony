<!--
  TopBar — Component/TopBar (4JkBz). Left: wordmark. Right: free-form slot.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    right?: Snippet;
  }

  let { right }: Props = $props();
</script>

<header class="topbar">
  <a class="topbar__brand" href="/">GitColony</a>
  <div class="topbar__right">
    {#if right}
      {@render right()}
    {/if}
  </div>
</header>

<style>
  .topbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: var(--topbar-h);
    padding: 0 var(--space-6);
    background: var(--bg-1);
    border-bottom: var(--stroke-w) solid var(--stroke);
  }
  .topbar__brand {
    font-family: var(--font-head);
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    color: var(--accent);
  }
  .topbar__right {
    display: flex;
    align-items: center;
    gap: var(--space-4);
  }
</style>
