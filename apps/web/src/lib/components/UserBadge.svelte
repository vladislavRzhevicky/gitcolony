<!--
  UserBadge — round avatar + @login used in the top bar.

  Avatar is pulled straight from github.com/{login}.png — a redirect GitHub
  exposes for every user, so we don't need to cache the URL in our own DB
  or include it in the JWT (the subject intentionally stays lean).

  If the image 404s or the network trips, we render initials on a tinted
  circle instead so the badge never collapses to a blank square.
-->
<script lang="ts">
  interface Props {
    login: string | null | undefined;
  }
  let { login }: Props = $props();

  // Swap to the initials fallback whenever the img fires onerror. Also
  // covers the case where `login` is missing entirely.
  let imageFailed = $state(false);

  const name = $derived(login ?? 'anonymous');
  const src = $derived(
    login ? `https://github.com/${encodeURIComponent(login)}.png?size=64` : null,
  );
  // First two characters of the login, uppercased. Good enough while we
  // don't have a real display name.
  const initials = $derived(name.slice(0, 2).toUpperCase());
</script>

<span class="badge">
  {#if src && !imageFailed}
    <img
      class="avatar"
      {src}
      alt=""
      loading="lazy"
      referrerpolicy="no-referrer"
      onerror={() => (imageFailed = true)}
    />
  {:else}
    <span class="avatar avatar--fallback" aria-hidden="true">{initials}</span>
  {/if}
  <span class="name">@{name}</span>
</span>

<style>
  .badge {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--fg-0);
  }
  .avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--bg-2);
    border: var(--stroke-w) solid var(--stroke);
    object-fit: cover;
    flex: none;
  }
  .avatar--fallback {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: var(--fw-semibold);
    color: var(--fg-1);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .name {
    font-family: var(--font-mono);
    font-size: var(--fs-md);
  }
</style>
