<!--
  Settings — Tokens V3 (docs/design.pen nXRM0).

  Two stacked sections: AI Models (Gemini key + selected model, drives the
  naming/ticker LLM phases) and GitHub Access Tokens (PATs used when a repo
  can't be reached via the OAuth session). Both lists are server-rendered on
  first paint via +page.server.ts and re-fetched through invalidateAll() after
  mutating calls so the UI stays consistent with the backend.
-->
<script lang="ts">
  import { invalidateAll } from '$app/navigation';
  import { Button, Input, TopBar, UserBadge } from '$lib/components';
  import { relativeTime } from '$lib/time';
  import type { PageData } from './$types';

  interface SavedToken {
    id: string;
    label: string;
    ownerLogin: string;
    scopes: string[] | null;
    createdAt: string;
    lastUsedAt: string | null;
  }

  interface SavedLlmKey {
    id: string;
    label: string;
    provider: string;
    model: string;
    createdAt: string;
    lastUsedAt: string | null;
  }

  interface GeminiModelOption {
    id: string;
    displayName: string | null;
    description: string | null;
  }

  interface Props {
    data: PageData;
  }
  let { data }: Props = $props();

  const tokens = $derived(data.tokens as SavedToken[]);
  const llmKeys = $derived(data.llmKeys as SavedLlmKey[]);
  const activeLlmKeyId = $derived(data.activeLlmKeyId as string | null);

  // --- GitHub token modal state ---------------------------------------------
  let adding = $state(false);
  let label = $state('');
  let pat = $state('');
  let saving = $state(false);
  let addError = $state<string | null>(null);

  let revokingId = $state<string | null>(null);
  let revokeError = $state<string | null>(null);

  // --- LLM key modal state --------------------------------------------------
  let addingLlm = $state(false);
  let llmLabel = $state('');
  let llmApiKey = $state('');
  let llmModel = $state('');
  let llmModels = $state<GeminiModelOption[]>([]);
  let loadingModels = $state(false);
  let savingLlm = $state(false);
  let llmError = $state<string | null>(null);
  let modelsLoadedForKey = $state<string | null>(null);

  let activatingId = $state<string | null>(null);
  let deletingLlmId = $state<string | null>(null);
  let llmListError = $state<string | null>(null);

  function openTokenModal() {
    adding = true;
    label = '';
    pat = '';
    addError = null;
  }
  function closeTokenModal() {
    if (saving) return;
    adding = false;
  }

  function openLlmModal() {
    addingLlm = true;
    llmLabel = '';
    llmApiKey = '';
    llmModel = '';
    llmModels = [];
    modelsLoadedForKey = null;
    llmError = null;
  }
  function closeLlmModal() {
    if (savingLlm || loadingModels) return;
    addingLlm = false;
  }

  async function saveToken() {
    if (saving) return;
    const l = label.trim();
    const t = pat.trim();
    if (!l) {
      addError = 'label is required';
      return;
    }
    if (!t) {
      addError = 'paste a token';
      return;
    }
    saving = true;
    addError = null;
    try {
      const res = await fetch('/api/me/tokens', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: l, pat: t }),
      });
      const body = await res.json();
      if (!res.ok) {
        addError = typeof body.error === 'string' ? body.error : 'could not save';
        return;
      }
      adding = false;
      label = '';
      pat = '';
      await invalidateAll();
    } catch (err) {
      addError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      saving = false;
    }
  }

  async function revokeToken(id: string) {
    if (revokingId) return;
    revokingId = id;
    revokeError = null;
    try {
      const res = await fetch(`/api/me/tokens/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        revokeError = `delete failed: ${res.status}`;
        return;
      }
      await invalidateAll();
    } catch (err) {
      revokeError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      revokingId = null;
    }
  }

  async function loadModels() {
    const key = llmApiKey.trim();
    if (!key) {
      llmError = 'paste an API key first';
      return;
    }
    loadingModels = true;
    llmError = null;
    try {
      const res = await fetch('/api/me/llm-keys/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ apiKey: key }),
      });
      const body = await res.json();
      if (!res.ok) {
        llmError = typeof body.error === 'string' ? body.error : 'could not load models';
        llmModels = [];
        modelsLoadedForKey = null;
        return;
      }
      llmModels = (body.models ?? []) as GeminiModelOption[];
      modelsLoadedForKey = key;
      // Preselect a sensible default: flash-lite if present, otherwise the
      // first option so the dropdown is never empty-valued.
      const preferred = llmModels.find((m) => m.id.includes('flash-lite'));
      llmModel = preferred?.id ?? llmModels[0]?.id ?? '';
    } catch (err) {
      llmError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      loadingModels = false;
    }
  }

  async function saveLlmKey() {
    if (savingLlm) return;
    const l = llmLabel.trim();
    const key = llmApiKey.trim();
    const m = llmModel.trim();
    if (!l) {
      llmError = 'label is required';
      return;
    }
    if (!key) {
      llmError = 'paste an API key';
      return;
    }
    if (!m) {
      llmError = 'pick a model';
      return;
    }
    savingLlm = true;
    llmError = null;
    try {
      const res = await fetch('/api/me/llm-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ label: l, apiKey: key, model: m }),
      });
      const body = await res.json();
      if (!res.ok) {
        llmError =
          typeof body.error === 'string'
            ? body.error
            : 'could not save';
        return;
      }
      addingLlm = false;
      llmLabel = '';
      llmApiKey = '';
      llmModel = '';
      llmModels = [];
      modelsLoadedForKey = null;
      await invalidateAll();
    } catch (err) {
      llmError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      savingLlm = false;
    }
  }

  async function activateLlmKey(id: string) {
    if (activatingId) return;
    activatingId = id;
    llmListError = null;
    try {
      const res = await fetch(`/api/me/llm-keys/${id}/activate`, {
        method: 'POST',
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        llmListError =
          typeof body.error === 'string' ? body.error : `activate failed: ${res.status}`;
        return;
      }
      await invalidateAll();
    } catch (err) {
      llmListError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      activatingId = null;
    }
  }

  async function deleteLlmKey(id: string) {
    if (deletingLlmId) return;
    deletingLlmId = id;
    llmListError = null;
    try {
      const res = await fetch(`/api/me/llm-keys/${id}`, { method: 'DELETE' });
      if (!res.ok && res.status !== 204) {
        llmListError = `delete failed: ${res.status}`;
        return;
      }
      await invalidateAll();
    } catch (err) {
      llmListError = err instanceof Error ? err.message : 'unexpected error';
    } finally {
      deletingLlmId = null;
    }
  }

  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape') return;
    if (adding) closeTokenModal();
    else if (addingLlm) closeLlmModal();
  }

  function fmtDate(iso: string | null | undefined): string {
    if (!iso) return '';
    const d = new Date(iso);
    return d.toLocaleDateString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  }
</script>

<svelte:window onkeydown={onKey} />

<svelte:head>
  <title>Settings — GitColony</title>
</svelte:head>

<TopBar>
  {#snippet right()}
    <UserBadge login={data.user?.githubLogin} />
    <a class="icon-btn" href="/dashboard" aria-label="Dashboard" data-tip="Dashboard">
      <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M3 12l9-9 9 9M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"/></svg>
    </a>
    <form method="POST" action="/auth/logout" class="signout">
      <button type="submit" class="icon-btn" aria-label="Sign out" data-tip="Sign out">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/></svg>
      </button>
    </form>
  {/snippet}
</TopBar>

<main class="body">
  <!-- ================= AI Models ========================================= -->
  <section class="section" aria-label="AI models">
    <header class="head">
      <div class="head__left">
        <h1 class="head__title">AI Models</h1>
        <p class="head__helper">
          Save one or more Gemini API keys and pick which model drives the
          naming and ticker phases during colony generation. Keys are stored
          encrypted; the browser never sees them again after saving.
        </p>
      </div>
      <Button variant="primary" onclick={openLlmModal}>+ Add model</Button>
    </header>

    {#if llmListError}
      <p class="err" role="alert">{llmListError}</p>
    {/if}

    <div class="cards" aria-label="Saved LLM keys">
      {#if llmKeys.length === 0}
        <p class="empty">
          No models configured yet. Add a Gemini API key to enable AI-generated
          names, taglines and the city ticker.
        </p>
      {:else}
        {#each llmKeys as k (k.id)}
          {@const isActive = activeLlmKeyId === k.id}
          <article class="card" class:card--active={isActive}>
            <header class="card__head">
              <div class="card__head-left">
                <span class="card__name">{k.label}</span>
                {#if isActive}
                  <span class="card__active-chip">Active</span>
                {/if}
              </div>
              <div class="card__head-right">
                {#if !isActive}
                  <button
                    type="button"
                    class="card__action"
                    disabled={activatingId !== null || deletingLlmId !== null}
                    onclick={() => activateLlmKey(k.id)}
                  >
                    {activatingId === k.id ? 'Activating…' : 'Use this'}
                  </button>
                {/if}
                <button
                  type="button"
                  class="card__revoke"
                  disabled={deletingLlmId !== null || activatingId !== null}
                  onclick={() => deleteLlmKey(k.id)}
                  aria-label="Delete model"
                >
                  {deletingLlmId === k.id ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </header>

            <div class="card__scopes">
              <span class="scope mono">{k.provider}</span>
              <span class="scope mono">{k.model}</span>
            </div>

            <div class="card__meta">
              <span>Added: {fmtDate(k.createdAt)}</span>
              <span>
                {k.lastUsedAt ? `Last used: ${relativeTime(k.lastUsedAt)}` : 'Never used'}
              </span>
            </div>
          </article>
        {/each}
      {/if}
    </div>
  </section>

  <!-- ================= GitHub tokens ==================================== -->
  <section class="section" aria-label="GitHub tokens">
    <header class="head">
      <div class="head__left">
        <h1 class="head__title">GitHub Access Tokens</h1>
        <p class="head__helper">
          Manage personal access tokens used for private and organisation
          repositories. Tokens need <code>repo</code> scope (classic) or
          <code>Contents: Read-only</code> + <code>Metadata: Read-only</code>
          (fine-grained). When a colony is generated, we match the repo's
          owner to one of these tokens automatically.
        </p>
      </div>
      <Button variant="primary" onclick={openTokenModal}>+ Add token</Button>
    </header>

    {#if revokeError}
      <p class="err" role="alert">{revokeError}</p>
    {/if}

    <div class="cards" aria-label="Saved tokens">
      {#if tokens.length === 0}
        <p class="empty">
          No saved tokens yet. Add one to reuse it across every colony you
          generate from repos that token can reach.
        </p>
      {:else}
        {#each tokens as t (t.id)}
          <article class="card">
            <header class="card__head">
              <span class="card__name">{t.label}</span>
              <button
                type="button"
                class="card__revoke"
                disabled={revokingId !== null}
                onclick={() => revokeToken(t.id)}
                aria-label="Revoke token"
              >
                {revokingId === t.id ? 'Revoking…' : 'Revoke'}
              </button>
            </header>

            {#if t.scopes && t.scopes.length > 0}
              <div class="card__scopes">
                {#each t.scopes as s (s)}
                  <span class="scope mono">{s}</span>
                {/each}
              </div>
            {/if}

            <div class="card__meta">
              <span>Added: {fmtDate(t.createdAt)}</span>
              <span>
                {t.lastUsedAt ? `Last used: ${relativeTime(t.lastUsedAt)}` : 'Never used'}
              </span>
            </div>

            <div class="card__user">
              <svg
                class="card__user-icon"
                viewBox="0 0 24 24"
                aria-hidden="true"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  stroke-width="2"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                  d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z"
                />
              </svg>
              <span class="card__user-login mono">@{t.ownerLogin}</span>
            </div>
          </article>
        {/each}
      {/if}
    </div>
  </section>
</main>

{#if adding}
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-token-title"
  >
    <div class="modal">
      <header class="modal__head">
        <h2 id="add-token-title" class="modal__title">Add New Token</h2>
        <button
          type="button"
          class="modal__close"
          aria-label="Close"
          onclick={closeTokenModal}
          disabled={saving}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 6l12 12M18 6L6 18"
            />
          </svg>
        </button>
      </header>

      <Input
        label="Label"
        placeholder="e.g. Work Laptop"
        name="token-label"
        bind:value={label}
      />

      <Input
        label="Token"
        placeholder="ghp_xxxxxxxxxxxxxxxxxxxx"
        type="password"
        name="token-value"
        bind:value={pat}
      />

      <p class="modal__help">
        Paste a GitHub personal access token with <code>repo</code> scope.
        Create one at
        <a
          href="https://github.com/settings/personal-access-tokens/new"
          target="_blank"
          rel="noreferrer noopener"
        >
          github.com/settings/personal-access-tokens
        </a>.
        Tokens are stored encrypted and only used to read commits.
      </p>

      {#if addError}
        <p class="err" role="alert">{addError}</p>
      {/if}

      <div class="modal__btns">
        <Button variant="secondary" type="button" onclick={closeTokenModal} disabled={saving}>
          Cancel
        </Button>
        <Button variant="primary" type="button" onclick={saveToken} disabled={saving}>
          {saving ? 'Saving…' : 'Save Token'}
        </Button>
      </div>
    </div>
  </div>
{/if}

{#if addingLlm}
  <div
    class="backdrop"
    role="dialog"
    aria-modal="true"
    aria-labelledby="add-llm-title"
  >
    <div class="modal">
      <header class="modal__head">
        <h2 id="add-llm-title" class="modal__title">Add AI Model</h2>
        <button
          type="button"
          class="modal__close"
          aria-label="Close"
          onclick={closeLlmModal}
          disabled={savingLlm || loadingModels}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
              d="M6 6l12 12M18 6L6 18"
            />
          </svg>
        </button>
      </header>

      <Input
        label="Label"
        placeholder="e.g. Personal Gemini"
        name="llm-label"
        bind:value={llmLabel}
      />

      <div class="key-row">
        <Input
          label="API Key"
          placeholder="AIza..."
          type="password"
          name="llm-key"
          bind:value={llmApiKey}
        />
        <Button
          variant="secondary"
          type="button"
          onclick={loadModels}
          disabled={loadingModels || savingLlm || llmApiKey.trim().length === 0}
        >
          {loadingModels ? 'Loading…' : 'Load models'}
        </Button>
      </div>

      {#if llmModels.length > 0}
        <label class="select">
          <span class="select__label">Model</span>
          <span class="select__field">
            <select class="select__control" bind:value={llmModel}>
              {#each llmModels as m (m.id)}
                <option value={m.id}>{m.displayName ? `${m.displayName} (${m.id})` : m.id}</option>
              {/each}
            </select>
          </span>
        </label>
      {:else if modelsLoadedForKey}
        <p class="modal__help">No compatible models found for this key.</p>
      {/if}

      <p class="modal__help">
        Paste a Google AI Studio API key. Create one at
        <a
          href="https://aistudio.google.com/app/apikey"
          target="_blank"
          rel="noreferrer noopener"
        >
          aistudio.google.com/app/apikey
        </a>.
        Keys are encrypted at rest and only ever sent to Google from the
        server during generation.
      </p>

      {#if llmError}
        <p class="err" role="alert">{llmError}</p>
      {/if}

      <div class="modal__btns">
        <Button variant="secondary" type="button" onclick={closeLlmModal} disabled={savingLlm || loadingModels}>
          Cancel
        </Button>
        <Button
          variant="primary"
          type="button"
          onclick={saveLlmKey}
          disabled={savingLlm || loadingModels || llmModels.length === 0}
        >
          {savingLlm ? 'Saving…' : 'Save Model'}
        </Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .signout {
    margin: 0;
  }
  .icon-btn {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 32px;
    height: 32px;
    border-radius: var(--radius-md);
    background: transparent;
    border: none;
    color: var(--fg-1);
    cursor: pointer;
    transition:
      color var(--dur-fast) var(--ease-out),
      background var(--dur-fast) var(--ease-out);
  }
  .icon-btn:hover {
    color: var(--fg-0);
    background: var(--bg-2);
  }
  .icon-btn svg {
    width: 18px;
    height: 18px;
  }
  .icon-btn[data-tip]::after {
    content: attr(data-tip);
    position: absolute;
    top: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 4px 8px;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    color: var(--fg-0);
    white-space: nowrap;
    opacity: 0;
    pointer-events: none;
    transition: opacity var(--dur-fast) var(--ease-out);
    z-index: 20;
  }
  .icon-btn[data-tip]:hover::after,
  .icon-btn[data-tip]:focus-visible::after {
    opacity: 1;
  }

  .body {
    flex: 1;
    width: 100%;
    max-width: 960px;
    margin: 0 auto;
    padding: 40px var(--space-6);
    display: flex;
    flex-direction: column;
    gap: 40px;
  }

  .section {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }

  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }
  .head__left {
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 600px;
  }
  .head__title {
    font-family: var(--font-head);
    font-size: 28px;
    font-weight: var(--fw-semibold);
    margin: 0;
    color: var(--fg-0);
  }
  .head__helper {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-base);
    line-height: 1.5;
  }
  .head__helper code {
    font-family: var(--font-mono);
    font-size: 12px;
    background: var(--bg-1);
    padding: 1px 5px;
    border-radius: var(--radius-md);
    color: var(--fg-0);
  }

  .err {
    margin: 0;
    color: var(--danger);
    font-size: var(--fs-sm);
  }

  .empty {
    margin: 0;
    padding: var(--space-5);
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    color: var(--fg-1);
    font-size: var(--fs-base);
  }

  .cards {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  .card {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: var(--space-5);
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
  }
  .card--active {
    border-color: var(--accent);
  }
  .card__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .card__head-left {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .card__head-right {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .card__name {
    font-family: var(--font-ui);
    font-size: 15px;
    font-weight: var(--fw-semibold);
    color: var(--fg-0);
  }
  .card__active-chip {
    padding: 2px 8px;
    border-radius: var(--radius-md);
    background: var(--accent);
    color: var(--bg-0);
    font-family: var(--font-ui);
    font-size: var(--fs-xs);
    font-weight: var(--fw-semibold);
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .card__action {
    padding: 6px 12px;
    border-radius: var(--radius-md);
    background: transparent;
    border: var(--stroke-w) solid var(--stroke);
    color: var(--fg-0);
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: var(--fw-medium);
    cursor: pointer;
    transition:
      background var(--dur-fast) var(--ease-out),
      border-color var(--dur-fast) var(--ease-out),
      opacity var(--dur-fast) var(--ease-out);
  }
  .card__action:hover:not(:disabled) {
    border-color: var(--accent);
    color: var(--accent);
  }
  .card__action:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .card__revoke {
    padding: 6px 12px;
    border-radius: var(--radius-md);
    background: var(--danger);
    color: #fff;
    font-family: var(--font-ui);
    font-size: 12px;
    font-weight: var(--fw-semibold);
    border: none;
    cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
  }
  .card__revoke:hover:not(:disabled) {
    background: color-mix(in srgb, var(--danger) 90%, #fff 10%);
  }
  .card__revoke:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .card__scopes {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .scope {
    padding: 3px 8px;
    background: var(--bg-1);
    border-radius: var(--radius-md);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .card__meta {
    display: flex;
    gap: var(--space-4);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .card__user {
    display: flex;
    align-items: center;
    gap: 6px;
    color: var(--fg-1);
  }
  .card__user-icon {
    width: 14px;
    height: 14px;
  }
  .card__user-login {
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .mono {
    font-family: var(--font-mono);
  }

  /* Modal ------------------------------------------------------------- */
  .backdrop {
    position: fixed;
    inset: 0;
    background: color-mix(in srgb, var(--bg-0) 70%, transparent);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 50;
    padding: var(--space-4);
  }
  .modal {
    width: 100%;
    max-width: 480px;
    background: var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: 6px;
    padding: 28px;
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }
  .modal__head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .modal__title {
    margin: 0;
    font-family: var(--font-head);
    font-size: 20px;
    font-weight: var(--fw-semibold);
    color: var(--fg-0);
  }
  .modal__close {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    color: var(--fg-1);
    background: transparent;
    border: none;
    cursor: pointer;
    transition: color var(--dur-fast) var(--ease-out);
  }
  .modal__close:hover:not(:disabled) {
    color: var(--fg-0);
  }
  .modal__close:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .modal__close svg {
    width: 20px;
    height: 20px;
  }
  .modal__help {
    margin: 0;
    color: var(--fg-1);
    font-size: 12px;
    line-height: 1.5;
  }
  .modal__help code {
    font-family: var(--font-mono);
    font-size: 11px;
    background: var(--bg-0);
    padding: 1px 5px;
    border-radius: var(--radius-md);
    color: var(--fg-0);
  }
  .modal__help a {
    color: var(--accent);
    word-break: break-all;
  }
  .modal__btns {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
  }

  /* Key + load-models row ----------------------------------------------- */
  .key-row {
    display: flex;
    align-items: flex-end;
    gap: var(--space-2);
  }
  .key-row :global(.input) {
    flex: 1;
  }
  /* Match the button's box exactly to the adjacent Input field so they
     line up on the bottom edge. Input field is padding 10 + border 1 on
     each side + a 14px/normal native <input>, which renders ~40px tall. */
  .key-row :global(.btn) {
    height: 40px;
    padding-top: 0;
    padding-bottom: 0;
  }

  /* Native <select> styled to match the Input component. ---------------- */
  .select {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    width: 100%;
  }
  .select__label {
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--fg-1);
  }
  .select__field {
    display: flex;
    align-items: center;
    background: var(--bg-0);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: 10px 12px;
    transition: border-color var(--dur-fast) var(--ease-out);
  }
  .select__field:focus-within {
    border-color: var(--accent);
  }
  .select__control {
    flex: 1;
    width: 100%;
    background: transparent;
    color: var(--fg-0);
    font-family: var(--font-ui);
    font-size: var(--fs-base);
    border: none;
    outline: none;
    appearance: none;
    cursor: pointer;
  }
</style>
