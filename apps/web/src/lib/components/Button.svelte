<!--
  Button — mirrors Component/Button/{Primary,Secondary,Ghost,Danger} from
  docs/design.pen. All variants share a uniform corner radius.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    type?: 'button' | 'submit' | 'reset';
    href?: string;
    disabled?: boolean;
    form?: string;
    onclick?: (e: MouseEvent) => void;
    children: Snippet;
  }

  let {
    variant = 'primary',
    type = 'button',
    href,
    disabled = false,
    form,
    onclick,
    children,
  }: Props = $props();
</script>

{#if href}
  <a class="btn btn--{variant}" {href} aria-disabled={disabled}>
    {@render children()}
  </a>
{:else}
  <button class="btn btn--{variant}" {type} {disabled} {form} {onclick}>
    {@render children()}
  </button>
{/if}

<style>
  .btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: 10px 20px;
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    line-height: 1;
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      color var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
    user-select: none;
    white-space: nowrap;
    text-decoration: none;
  }

  .btn[aria-disabled='true'],
  .btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Primary — warm accent fill. */
  .btn--primary {
    background: var(--accent);
    color: var(--bg-0);
    font-weight: var(--fw-semibold);
    border-radius: var(--radius-md);
  }
  .btn--primary:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--accent) 90%, #fff 10%);
  }

  /* Secondary — outlined, neutral. */
  .btn--secondary {
    background: transparent;
    color: var(--fg-0);
    font-weight: var(--fw-medium);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
  }
  .btn--secondary:hover:not(:disabled):not([aria-disabled='true']) {
    background: var(--bg-2);
    border-color: color-mix(in srgb, var(--stroke) 50%, var(--fg-1) 50%);
  }

  /* Ghost — lowest weight. */
  .btn--ghost {
    background: transparent;
    color: var(--fg-1);
    font-weight: var(--fw-medium);
    border-radius: var(--radius-md);
  }
  .btn--ghost:hover:not(:disabled):not([aria-disabled='true']) {
    color: var(--fg-0);
    background: var(--bg-2);
  }

  /* Danger — destructive actions. */
  .btn--danger {
    background: var(--danger);
    color: #fff;
    font-weight: var(--fw-semibold);
    border-radius: var(--radius-md);
  }
  .btn--danger:hover:not(:disabled):not([aria-disabled='true']) {
    background: color-mix(in srgb, var(--danger) 90%, #fff 10%);
  }
</style>
