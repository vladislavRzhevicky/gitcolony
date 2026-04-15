<script lang="ts">
  import '../app.css';
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="page">
  {@render children()}
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    min-height: 100vh;
  }
</style>
