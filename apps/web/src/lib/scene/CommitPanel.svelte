<!--
  CommitPanel — docked side panel shown when a scene object is picked.
  Renders commit metadata carried on the WorldObject / Agent itself
  (no additional fetch). Subject-first layout: short commit message,
  then author + timestamp + sha.
-->
<script lang="ts">
  import type { Picked } from './mapping';

  interface Props {
    picked: Picked | null;
    onClose: () => void;
  }

  let { picked, onClose }: Props = $props();

  const shortSha = $derived(picked?.commitSha?.slice(0, 8) ?? '');
  const subject = $derived((picked?.message ?? '').split('\n', 1)[0] ?? '');
  const when = $derived(
    picked?.authoredAt ? new Date(picked.authoredAt).toLocaleDateString() : null,
  );
</script>

{#if picked}
  <aside class="panel" aria-label="commit details">
    <header class="panel__head">
      <span class="panel__kind">{picked.kind === 'agent' ? 'Inhabitant' : 'Building'}</span>
      <button type="button" class="panel__close" onclick={onClose} aria-label="Close">×</button>
    </header>
    {#if picked.displayName}
      <h2 class="panel__name">{picked.displayName}</h2>
      {#if picked.tagline}
        <p class="panel__tagline">{picked.tagline}</p>
      {/if}
      {#if picked.personality}
        <p class="panel__tagline">{picked.personality}</p>
      {/if}
      <p class="panel__subject panel__subject--small">{subject || '(no commit message)'}</p>
    {:else}
      <h2 class="panel__subject">{subject || '(no commit message)'}</h2>
    {/if}
    <dl class="panel__fields">
      <div class="row">
        <dt>sha</dt>
        <dd class="mono">{shortSha}</dd>
      </div>
      {#if picked.authorLogin}
        <div class="row">
          <dt>author</dt>
          <dd class="mono">@{picked.authorLogin}</dd>
        </div>
      {/if}
      {#if when}
        <div class="row">
          <dt>date</dt>
          <dd class="mono">{when}</dd>
        </div>
      {/if}
      <div class="row">
        <dt>district</dt>
        <dd class="mono">{picked.districtId}</dd>
      </div>
    </dl>
  </aside>
{/if}

<style>
  .panel {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    width: 280px;
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    backdrop-filter: blur(8px);
    z-index: 5;
  }
  .panel__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
  }
  .panel__kind {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
    text-transform: lowercase;
  }
  .panel__close {
    background: transparent;
    border: none;
    color: var(--fg-1);
    font-size: 22px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
  }
  .panel__close:hover {
    color: var(--fg-0);
  }
  .panel__name {
    margin: 0;
    font-family: var(--font-head);
    font-size: 20px;
    color: var(--fg-0);
    line-height: 1.2;
  }
  .panel__tagline {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--fg-1);
    line-height: 1.4;
  }
  .panel__subject {
    margin: 0;
    font-family: var(--font-head);
    font-size: var(--fs-md);
    color: var(--fg-0);
    line-height: 1.35;
  }
  .panel__subject--small {
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--fg-1);
    font-style: italic;
  }
  .panel__fields {
    margin: 0;
    display: grid;
    gap: var(--space-2);
  }
  .row {
    display: grid;
    grid-template-columns: 72px 1fr;
    gap: var(--space-2);
    font-size: var(--fs-sm);
  }
  dt {
    color: var(--fg-1);
    font-family: var(--font-ui);
  }
  dd {
    margin: 0;
    color: var(--fg-0);
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mono {
    font-family: var(--font-mono);
  }
</style>
