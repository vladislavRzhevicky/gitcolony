<!--
  Landing page. Composition:
   - TopBar with a Sign-in action on the right.
   - Hero: big headline, sub, primary + ghost CTA.
   - Three feature cards ("How it works"): ingest, generate, watch.
   - Showcase card row (example repos — thumbs are placeholders until the
     3D renderer lands).
   - Footer.
-->
<script lang="ts">
  import { Button, Card, Chip, TopBar } from '$lib/components';
</script>

<svelte:head>
  <title>GitColony — your repository as a living colony</title>
</svelte:head>

<TopBar>
  {#snippet right()}
    <a class="nav-link" href="/#how">How it works</a>
    <a class="nav-link" href="/#showcase">Showcase</a>
    <Button variant="primary" href="/login">Sign in with GitHub</Button>
  {/snippet}
</TopBar>

<main>
  <!-- Hero ----------------------------------------------------------- -->
  <section class="hero">
    <div class="hero__text">
      <p class="hero__eyebrow">Your repository, as a world</p>
      <h1 class="hero__title">
        Every commit becomes a&nbsp;building.
        <span class="hero__title-accent">Every contributor, a&nbsp;citizen.</span>
      </h1>
      <p class="hero__sub">
        GitColony turns a GitHub repository into a living 3D colony. Districts
        grow from directories, agents wander in from commits, and the map
        evolves as the repo does — deterministically, shareable by URL.
      </p>
      <div class="hero__actions">
        <Button variant="primary" href="/login">Sign in with GitHub</Button>
        <Button variant="ghost" href="/#how">See how it works</Button>
      </div>
      <div class="hero__meta">
        <Chip>Deterministic</Chip>
        <Chip>Shareable by URL</Chip>
        <Chip>Open source</Chip>
      </div>
    </div>
    <div class="hero__preview" aria-hidden="true">
      <div class="hero__preview-frame">
        <div class="hero__preview-glow"></div>
      </div>
    </div>
  </section>

  <!-- How it works --------------------------------------------------- -->
  <section id="how" class="section">
    <header class="section__head">
      <p class="section__eyebrow">How it works</p>
      <h2 class="section__title">Three steps from repo to colony</h2>
    </header>
    <div class="grid grid--3">
      <Card>
        <p class="feat__step">01</p>
        <h3 class="feat__title">Ingest</h3>
        <p class="feat__body">
          We read your repository through the GitHub GraphQL API — commits,
          authors, file paths. No code leaves GitHub.
        </p>
      </Card>
      <Card>
        <p class="feat__step">02</p>
        <h3 class="feat__title">Generate</h3>
        <p class="feat__body">
          A deterministic layout engine turns directories into districts,
          commits into buildings, and authors into agents.
        </p>
      </Card>
      <Card>
        <p class="feat__step">03</p>
        <h3 class="feat__title">Watch</h3>
        <p class="feat__body">
          Your colony grows as you commit. Agents roam, schedules tick, the
          map evolves. Shareable by URL.
        </p>
      </Card>
    </div>
  </section>

  <!-- Showcase -------------------------------------------------------  -->
  <section id="showcase" class="section">
    <header class="section__head">
      <p class="section__eyebrow">Showcase</p>
      <h2 class="section__title">A few colonies in the wild</h2>
    </header>
    <div class="grid grid--3">
      {#each ['sveltejs/svelte', 'tldraw/tldraw', 'honojs/hono'] as full}
        <Card>
          {#snippet thumb()}
            <div class="thumb thumb--placeholder" aria-hidden="true"></div>
          {/snippet}
          <p class="card__title">{full}</p>
          <div class="card__chips">
            <Chip>{full.split('/')[0]}</Chip>
            <Chip>active</Chip>
          </div>
          <p class="card__meta">Last synced: 2h ago</p>
        </Card>
      {/each}
    </div>
  </section>
</main>

<style>
  main {
    flex: 1;
    max-width: 1200px;
    width: 100%;
    margin: 0 auto;
    padding: 0 var(--space-6);
  }

  .nav-link {
    color: var(--fg-1);
    font-size: var(--fs-base);
    transition: color var(--dur-fast) var(--ease-out);
  }
  .nav-link:hover {
    color: var(--fg-0);
  }

  /* Hero ----------------------------------------------------------- */
  .hero {
    display: grid;
    grid-template-columns: 1.2fr 1fr;
    gap: var(--space-6);
    align-items: center;
    padding: 96px 0 80px;
  }
  @media (max-width: 860px) {
    .hero {
      grid-template-columns: 1fr;
    }
  }
  .hero__eyebrow {
    margin: 0 0 var(--space-3);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
    letter-spacing: 0.02em;
  }
  .hero__title {
    font-family: var(--font-head);
    font-size: clamp(36px, 5vw, 56px);
    line-height: 1.05;
    font-weight: var(--fw-semibold);
    letter-spacing: -0.01em;
    margin: 0;
  }
  .hero__title-accent {
    display: block;
    color: var(--fg-1);
  }
  .hero__sub {
    margin: var(--space-5) 0 var(--space-6);
    max-width: 52ch;
    color: var(--fg-1);
    font-size: 16px;
    line-height: 1.6;
  }
  .hero__actions {
    display: flex;
    gap: var(--space-3);
    flex-wrap: wrap;
    margin-bottom: var(--space-5);
  }
  .hero__meta {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }

  .hero__preview-frame {
    position: relative;
    aspect-ratio: 4 / 3;
    background: var(--bg-1);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    overflow: hidden;
  }
  .hero__preview-glow {
    position: absolute;
    inset: 20% 15% 30% 25%;
    background: radial-gradient(
      circle at 30% 30%,
      color-mix(in srgb, var(--accent) 35%, transparent) 0%,
      transparent 60%
    );
    filter: blur(8px);
  }
  .hero__preview-frame::after {
    /* subtle grid to hint at a tile map until the 3D preview lands */
    content: '';
    position: absolute;
    inset: 0;
    background-image:
      linear-gradient(var(--stroke) 1px, transparent 1px),
      linear-gradient(90deg, var(--stroke) 1px, transparent 1px);
    background-size: 32px 32px;
    opacity: 0.25;
    mask-image: radial-gradient(circle at 50% 55%, black 30%, transparent 75%);
  }

  /* Section --------------------------------------------------------- */
  .section {
    padding: 64px 0;
  }
  .section__head {
    margin-bottom: var(--space-6);
  }
  .section__eyebrow {
    margin: 0 0 var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .section__title {
    font-family: var(--font-head);
    font-size: 32px;
    font-weight: var(--fw-semibold);
    margin: 0;
  }

  .grid {
    display: grid;
    gap: var(--space-4);
  }
  .grid--3 {
    grid-template-columns: repeat(3, 1fr);
  }
  @media (max-width: 860px) {
    .grid--3 {
      grid-template-columns: 1fr;
    }
  }

  /* Feature card inner --------------------------------------------- */
  .feat__step {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-sm);
    color: var(--accent);
  }
  .feat__title {
    font-size: var(--fs-lg);
    margin: 0;
  }
  .feat__body {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-base);
    line-height: 1.6;
  }

  /* Showcase card inner -------------------------------------------- */
  .card__title {
    margin: 0;
    font-family: var(--font-mono);
    font-size: var(--fs-base);
    font-weight: var(--fw-medium);
    color: var(--fg-0);
  }
  .card__chips {
    display: flex;
    gap: var(--space-2);
    flex-wrap: wrap;
  }
  .card__meta {
    margin: 0;
    font-size: var(--fs-sm);
    color: var(--fg-1);
  }

  .thumb--placeholder {
    width: 100%;
    height: 100%;
    background:
      radial-gradient(
        circle at 30% 40%,
        color-mix(in srgb, var(--accent) 25%, transparent),
        transparent 55%
      ),
      radial-gradient(
        circle at 70% 65%,
        color-mix(in srgb, var(--accent-2) 20%, transparent),
        transparent 60%
      );
  }
</style>
