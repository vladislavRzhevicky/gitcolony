<!--
  Input — Component/Input (ZPOG4). Label stacked above the field.
-->
<script lang="ts">
  interface Props {
    label?: string;
    placeholder?: string;
    value?: string;
    type?: 'text' | 'email' | 'password' | 'url';
    name?: string;
    id?: string;
    required?: boolean;
  }

  let {
    label,
    placeholder = '',
    value = $bindable(''),
    type = 'text',
    name,
    id,
    required = false,
  }: Props = $props();

  const fieldId = $derived(id ?? (name ? `input-${name}` : undefined));
</script>

<label class="input">
  {#if label}
    <span class="input__label">{label}</span>
  {/if}
  <span class="input__field">
    <input
      class="input__control"
      {type}
      {name}
      id={fieldId}
      {placeholder}
      {required}
      bind:value
    />
  </span>
</label>

<style>
  .input {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
  }
  .input__label {
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--fg-1);
  }
  .input__field {
    display: flex;
    align-items: center;
    background: var(--bg-0);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  .input__field:focus-within {
    border-color: var(--accent);
  }
  .input__control {
    flex: 1;
    width: 100%;
    color: var(--fg-0);
    font-size: var(--fs-base);
  }
  .input__control::placeholder {
    color: var(--fg-1);
  }
</style>
