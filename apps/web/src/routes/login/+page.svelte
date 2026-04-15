<!--
  Login page. Single centered card: sign-in with GitHub.

  The button is a native form submit — pressing it triggers the `default`
  action in +page.server.ts, which builds a PKCE challenge via OpenAuth and
  303s the browser to the issuer. No separate /auth/*/start route.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { Button, Chip, TopBar } from '$lib/components';

  const errorCopy: Record<string, string> = {
    missing_code: 'Sign-in was cancelled before we heard back from GitHub.',
    exchange_failed: 'GitHub accepted the sign-in but the token exchange failed. Try again.',
  };
  const error = $derived.by(() => {
    const code = $page.url.searchParams.get('error');
    if (!code) return null;
    return errorCopy[code] ?? 'Something went wrong signing you in. Try again.';
  });
</script>

<svelte:head>
  <title>Sign in — GitColony</title>
</svelte:head>

<TopBar>
  {#snippet right()}
    <a class="nav-link" href="/">Back</a>
  {/snippet}
</TopBar>

<main class="login">
  <article class="login__card">
    <header class="login__head">
      <p class="login__eyebrow">Sign in</p>
      <h1 class="login__title">Welcome to GitColony</h1>
      <p class="login__sub">
        We sign you in with GitHub to generate a colony from your repositories.
        No code is uploaded — only metadata via the GitHub GraphQL API.
      </p>
    </header>

    <form method="POST" class="login__action">
      <Button variant="primary" type="submit">
        <span class="gh-glyph" aria-hidden="true">{'\u2B22'}</span>
        Continue with GitHub
      </Button>
    </form>

    {#if error}
      <p class="login__error" role="alert">{error}</p>
    {/if}

    <ul class="login__scopes">
      <li>
        <span class="dot"></span>
        Read public and private repositories you own
      </li>
      <li>
        <span class="dot"></span>
        Only commit metadata is read — never your code
      </li>
      <li>
        <span class="dot"></span>
        We never push, open issues, or modify your repos
      </li>
    </ul>

    <footer class="login__foot">
      <div class="login__chips">
        <Chip>Deterministic</Chip>
        <Chip>Revocable</Chip>
      </div>
      <p class="login__fine">
        By continuing you agree to our <a href="/terms">Terms</a> and
        <a href="/privacy">Privacy notice</a>.
      </p>
    </footer>
  </article>
</main>

<style>
  .nav-link {
    color: var(--fg-1);
    font-size: var(--fs-base);
  }
  .nav-link:hover {
    color: var(--fg-0);
  }

  .login {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--space-6);
  }

  .login__card {
    width: 100%;
    max-width: 440px;
    background: var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    padding: var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-5);
  }

  .login__head {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .login__eyebrow {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .login__title {
    font-family: var(--font-head);
    font-size: var(--fs-lg);
    font-weight: var(--fw-semibold);
    margin: 0;
    color: var(--fg-0);
  }
  .login__sub {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-base);
    line-height: 1.55;
  }

  .login__action {
    display: flex;
    margin: 0;
  }
  .login__action :global(.btn) {
    width: 100%;
  }

  .login__error {
    margin: 0;
    padding: var(--space-3) var(--space-4);
    background: color-mix(in srgb, var(--danger) 15%, transparent);
    border: var(--stroke-w) solid var(--danger);
    border-radius: var(--radius-md);
    color: var(--fg-0);
    font-size: var(--fs-sm);
  }

  .gh-glyph {
    font-family: var(--font-mono);
    font-size: 16px;
    line-height: 1;
  }

  .login__scopes {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }
  .login__scopes li {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--success);
    flex-shrink: 0;
  }

  .login__foot {
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    padding-top: var(--space-4);
    border-top: var(--stroke-w) solid var(--stroke);
  }
  .login__chips {
    display: flex;
    gap: var(--space-2);
  }
  .login__fine {
    margin: 0;
    font-size: var(--fs-xs);
    color: var(--fg-1);
  }
  .login__fine a {
    color: var(--fg-0);
    border-bottom: 1px solid var(--stroke);
  }
  .login__fine a:hover {
    border-bottom-color: var(--accent);
  }
</style>
