<!--
  ChatPanel — floating bottom-right log of AI-agent encounters.

  Reads `sim.chatLog` (a reactive $state array on the AgentSim) and renders
  each meeting as a two-bubble exchange (opener + reply). The list is
  append-only from the sim's perspective; we auto-scroll to the newest
  entry whenever `chatLog.length` changes so a user watching the city sees
  the latest greeting pop in without scrolling.

  The panel shares screen real estate with CommitPanel (top-right). They
  don't overlap by construction: CommitPanel anchors top-right, this one
  anchors bottom-right with a max-height capped well below the viewport.
-->
<script lang="ts">
  import type { AgentSim, ChatMessage } from './sim.svelte';

  interface Props {
    sim: AgentSim;
  }
  let { sim }: Props = $props();

  let collapsed = $state(false);
  let listEl = $state<HTMLDivElement | undefined>();

  // Auto-scroll to the newest entry. Tracking `sim.chatLog.length` rather
  // than `sim.chatLog` itself avoids re-scrolling on unrelated reactive
  // reads, and re-tracks correctly when older entries fall off the head
  // (ring-buffer trim changes length).
  $effect(() => {
    // eslint-disable-next-line @typescript-eslint/no-unused-expressions
    sim.chatLog.length;
    if (!listEl || collapsed) return;
    // Defer to after layout so the new bubble is in the DOM before we
    // measure scrollHeight.
    queueMicrotask(() => {
      if (listEl) listEl.scrollTop = listEl.scrollHeight;
    });
  });

  // Group consecutive messages by meetingId so a pair renders as one
  // exchange block. chatLog already arrives opener-then-reply, so a flat
  // scan builds the groups without sorting.
  const groups = $derived.by(() => {
    const out: { meetingId: string; messages: ChatMessage[] }[] = [];
    for (const m of sim.chatLog) {
      const last = out[out.length - 1];
      if (last && last.meetingId === m.meetingId) {
        last.messages.push(m);
      } else {
        out.push({ meetingId: m.meetingId, messages: [m] });
      }
    }
    return out;
  });

  const aiCount = $derived(sim.aiIds.size);

  function relTime(at: number): string {
    const sec = Math.max(0, Math.floor((Date.now() - at) / 1000));
    if (sec < 5) return 'just now';
    if (sec < 60) return `${sec}s ago`;
    const m = Math.floor(sec / 60);
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    return `${h}h ago`;
  }
</script>

<aside class="panel" class:panel--collapsed={collapsed} aria-label="City chatter">
  <header class="panel__head">
    <div class="panel__title">
      <span class="panel__dot" aria-hidden="true"></span>
      <span>City chatter</span>
      <span class="panel__count mono">{aiCount} AI</span>
    </div>
    <button
      type="button"
      class="panel__toggle"
      onclick={() => (collapsed = !collapsed)}
      aria-label={collapsed ? 'Expand chatter' : 'Collapse chatter'}
      aria-expanded={!collapsed}
    >
      {collapsed ? '▴' : '▾'}
    </button>
  </header>

  {#if !collapsed}
    <div class="panel__list" bind:this={listEl}>
      {#if groups.length === 0}
        <p class="panel__empty">
          {#if aiCount < 2}
            Too few AI citizens to chatter — this city only has {aiCount}.
          {:else}
            Waiting for the first encounter…
          {/if}
        </p>
      {:else}
        {#each groups as g (g.meetingId)}
          <div class="group">
            {#each g.messages as m (m.id)}
              <div class="msg" class:msg--pending={m.pending}>
                <div class="msg__who mono">
                  <span class="msg__name">{m.speakerLabel}</span>
                  <span class="msg__meta">
                    {#if m.source === 'llm-fallback'}
                      <span
                        class="msg__tag"
                        title="LLM call failed — canned fallback"
                      >offline</span>
                    {/if}
                    <span class="msg__time">{relTime(m.at)}</span>
                  </span>
                </div>
                {#if m.quote}
                  <figure class="msg__quote mono" aria-label="code snippet">
                    <figcaption class="msg__quote-head">
                      <span class="msg__quote-file">{m.quote.filename}</span>
                      <span class="msg__quote-lines">
                        L{m.quote.startLine}–{m.quote.startLine + m.quote.lines.length - 1}
                      </span>
                    </figcaption>
                    <pre class="msg__quote-body">{#each m.quote.lines as line, i}<span class="msg__quote-row"><span class="msg__quote-ln">{m.quote.startLine + i}</span><span class="msg__quote-code">{line || ' '}</span></span>{/each}</pre>
                  </figure>
                {/if}
                <p class="msg__text" class:msg__text--pending={m.pending}>
                  {#if m.pending}
                    <span class="dots" aria-label="thinking">
                      <span></span><span></span><span></span>
                    </span>
                  {:else}
                    {m.text}
                  {/if}
                </p>
              </div>
            {/each}
          </div>
        {/each}
      {/if}
    </div>
  {/if}
</aside>

<style>
  .panel {
    position: absolute;
    right: var(--space-4);
    bottom: var(--space-4);
    width: 320px;
    /* Clamp in both directions. The min prevents edge cases where a
       reactive re-mount produces a zero-height flex container before
       content arrives (the panel would be invisible until first message). */
    min-height: 44px;
    max-height: min(52vh, 480px);
    display: flex;
    flex-direction: column;
    background: color-mix(in srgb, var(--bg-1) 92%, transparent);
    border: var(--stroke-w) solid var(--stroke);
    border-radius: var(--radius-md);
    backdrop-filter: blur(8px);
    overflow: hidden;
    /* Sits above Ticker (z:4), status/rail (z:3), overlay (z:2). Top bar
       stays at z:10 so it always wins. */
    z-index: 6;
  }
  .panel--collapsed {
    max-height: none;
  }

  .panel__head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--space-3) var(--space-4);
    border-bottom: var(--stroke-w) solid var(--stroke);
  }
  .panel--collapsed .panel__head {
    border-bottom: none;
  }
  .panel__title {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    font-weight: var(--fw-medium);
    color: var(--fg-0);
  }
  .panel__dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--accent-2);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent-2) 22%, transparent);
  }
  .panel__count {
    font-size: var(--fs-xs);
    color: var(--fg-1);
    padding: 2px var(--space-2);
    border-radius: var(--radius-pill);
    background: var(--bg-2);
  }
  .panel__toggle {
    background: transparent;
    border: none;
    color: var(--fg-1);
    font-size: 14px;
    line-height: 1;
    padding: 0 var(--space-2);
    cursor: pointer;
  }
  .panel__toggle:hover {
    color: var(--fg-0);
  }

  .panel__list {
    flex: 1;
    /* min-height/min-width: 0 lets the flex child actually shrink below
       intrinsic content size. Without these, a wide code snippet (`<pre>`
       with `white-space: pre`) can force the list — and the whole panel —
       to stretch past 320px and off the viewport. */
    min-height: 0;
    min-width: 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: var(--space-3) var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    scrollbar-width: thin;
    scrollbar-color: var(--stroke) transparent;
  }

  .panel__empty {
    margin: 0;
    color: var(--fg-1);
    font-size: var(--fs-sm);
    font-style: italic;
  }

  .group {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    min-width: 0;
    padding-bottom: var(--space-3);
    border-bottom: var(--stroke-w) dashed color-mix(in srgb, var(--stroke) 70%, transparent);
  }
  .group:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .msg {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .msg__who {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: var(--space-2);
    font-size: var(--fs-xs);
    color: var(--fg-1);
  }
  .msg__name {
    color: var(--accent);
  }
  .msg__meta {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
  }
  .msg__time {
    color: var(--fg-1);
    opacity: 0.7;
  }
  .msg__tag {
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    padding: 1px 6px;
    border-radius: var(--radius-pill);
    background: color-mix(in srgb, var(--warn, var(--fg-1)) 18%, transparent);
    color: var(--fg-1);
    cursor: help;
  }
  .msg__text {
    margin: 0;
    font-family: var(--font-ui);
    font-size: var(--fs-sm);
    color: var(--fg-0);
    line-height: 1.45;
  }

  /* Code-review quote block. Sits between the speaker header and their
     reply so both coworkers appear to react to the same visible snippet.
     Monospace, muted background, line numbers flush-left. */
  .msg__quote {
    margin: 4px 0 2px;
    padding: 0;
    border: var(--stroke-w) solid color-mix(in srgb, var(--stroke) 80%, transparent);
    border-radius: var(--radius-sm, 6px);
    background: color-mix(in srgb, var(--bg-2) 80%, transparent);
    overflow: hidden;
  }
  .msg__quote-head {
    display: flex;
    justify-content: space-between;
    gap: var(--space-2);
    padding: 3px var(--space-2);
    font-size: 10px;
    color: var(--fg-1);
    background: color-mix(in srgb, var(--bg-1) 50%, transparent);
    border-bottom: var(--stroke-w) solid color-mix(in srgb, var(--stroke) 60%, transparent);
  }
  .msg__quote-file {
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    color: var(--fg-0);
  }
  .msg__quote-lines {
    flex: 0 0 auto;
    opacity: 0.7;
  }
  .msg__quote-body {
    margin: 0;
    padding: 4px 0;
    font-size: 11px;
    line-height: 1.4;
    color: var(--fg-0);
    overflow-x: auto;
    white-space: pre;
  }
  .msg__quote-row {
    display: flex;
  }
  .msg__quote-ln {
    flex: 0 0 28px;
    text-align: right;
    padding: 0 6px 0 4px;
    color: var(--fg-1);
    opacity: 0.55;
    user-select: none;
  }
  .msg__quote-code {
    flex: 1;
    padding-right: var(--space-2);
  }
  .msg__text--pending {
    color: var(--fg-1);
  }

  /* Three-dot typing indicator. Staggered pulse reads as "thinking" without
     needing a spinner glyph that would clash with the text-first layout. */
  .dots {
    display: inline-flex;
    gap: 3px;
    align-items: center;
    height: 1em;
  }
  .dots span {
    display: inline-block;
    width: 4px;
    height: 4px;
    border-radius: 50%;
    background: var(--fg-1);
    opacity: 0.3;
    animation: dot 1.1s ease-in-out infinite;
  }
  .dots span:nth-child(2) { animation-delay: 0.18s; }
  .dots span:nth-child(3) { animation-delay: 0.36s; }
  @keyframes dot {
    0%, 80%, 100% { opacity: 0.25; transform: translateY(0); }
    40%           { opacity: 0.9;  transform: translateY(-2px); }
  }

  .mono {
    font-family: var(--font-mono);
  }
</style>
