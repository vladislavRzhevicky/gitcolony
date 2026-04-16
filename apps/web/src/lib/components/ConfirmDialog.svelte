<!--
  ConfirmDialog — centered modal for "are you sure?" confirmations.

  Follows the Dialog/modal spec in docs/design.md: SidePanel surface
  (bg-1, stroke, radius-md, padding 24, gap 16), head-font title,
  Ghost + (Primary|Danger) actions right-aligned.
-->
<script lang="ts">
  import Button from './Button.svelte';

  interface Props {
    open: boolean;
    title: string;
    message?: string;
    confirmLabel?: string;
    cancelLabel?: string;
    variant?: 'primary' | 'danger';
    busy?: boolean;
    onConfirm: () => void;
    onCancel: () => void;
  }

  let {
    open,
    title,
    message,
    confirmLabel = 'Confirm',
    cancelLabel = 'Cancel',
    variant = 'primary',
    busy = false,
    onConfirm,
    onCancel,
  }: Props = $props();

  function onKey(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'Escape' && !busy) onCancel();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="cd-title"
    tabindex="-1"
  >
    <div class="panel">
      <header class="panel__head">
        <h2 id="cd-title" class="panel__title">{title}</h2>
        {#if message}
          <p class="panel__sub">{message}</p>
        {/if}
      </header>

      <div class="panel__actions">
        <Button variant="ghost" type="button" disabled={busy} onclick={onCancel}>
          {cancelLabel}
        </Button>
        <Button variant={variant} type="button" disabled={busy} onclick={onConfirm}>
          {busy ? 'working…' : confirmLabel}
        </Button>
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
    z-index: 60;
    padding: var(--space-4);
  }
  .panel {
    width: 100%;
    max-width: 420px;
    background: var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
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
    color: var(--fg-0);
  }
  .panel__sub {
    margin: 0;
    color: var(--fg-1);
    line-height: 1.5;
    font-size: var(--fs-base);
  }
  .panel__actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--space-2);
  }
</style>
