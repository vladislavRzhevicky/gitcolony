<!--
  Card — Component/Card (gfd2X). Vertical container: optional thumb slot, body.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    thumb?: Snippet;
    children: Snippet;
  }

  let { thumb, children }: Props = $props();
</script>

<article class="card">
  {#if thumb}
    <div class="card__thumb">
      {@render thumb()}
    </div>
  {/if}
  <div class="card__body">
    {@render children()}
  </div>
</article>

<style>
  .card {
    display: flex;
    flex-direction: column;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .card__thumb {
    background: var(--bg-1);
    height: 220px;
    width: 100%;
  }
  .card__body {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding: var(--space-4);
  }
</style>
