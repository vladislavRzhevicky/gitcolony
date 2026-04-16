// ============================================================================
// Emoji bubbles — decorative "mood" pop-ups over random agents (AI or not).
//
// Model: at session start we pick a count N (2–5) of independent tracks.
// Each track fires on its own 10–20s cadence and pops an emoji over a fresh
// random agent, then reschedules itself. Result is a staggered stream of
// emojis rather than synchronised waves — a few characters "reacting" at
// any given moment, but not the same characters or the same times.
// ============================================================================

export interface EmojiBubble {
  id: string;
  emoji: string;
  expiresAt: number;
}

export interface EmojiTrack {
  /** ms timestamp when this track next spawns. */
  nextSpawnAt: number;
}

export interface EmojiState {
  bubbles: EmojiBubble[];
  tracks: EmojiTrack[];
}

// Mixed pool — emotions, weather, reactions, snacks. Kept small so each
// emoji reads clearly at glance-distance.
const EMOJI_POOL: readonly string[] = [
  '😊', '😄', '😴', '😮', '🥱', '😎', '🤔', '😤', '🙃', '😂', '🥲', '🤯',
  '☀️', '🌧️', '⛅', '❄️', '🌈', '💨', '🌙',
  '☕', '🍕', '🍺', '🥐', '🍩',
  '👍', '👋', '🎉', '💡', '❤️', '✨', '🔥', '🚀', '🎵', '💬',
];

const LIFETIME_MS = 2500;
const MIN_GAP_MS = 10_000;
const MAX_GAP_MS = 20_000;
const MIN_TRACKS = 2;
const MAX_TRACKS = 5;

/** Picks a track count (2–5) and staggers each track's first spawn. */
export function initialEmojiState(now: number): EmojiState {
  const count = MIN_TRACKS + Math.floor(Math.random() * (MAX_TRACKS - MIN_TRACKS + 1));
  const tracks: EmojiTrack[] = [];
  for (let i = 0; i < count; i++) tracks.push({ nextSpawnAt: now + randGap() });
  return { bubbles: [], tracks };
}

/**
 * Expires old bubbles and fires any tracks whose timeout elapsed. Each
 * firing picks a random eligible agent (not busy with another bubble and
 * not in `eligibleIds` exclusion) and resets that track's cadence.
 */
export function advanceEmojiState(
  state: EmojiState,
  eligibleIds: readonly string[],
  now: number,
): EmojiState {
  const bubbles = state.bubbles.filter((b) => b.expiresAt > now);
  const tracks = state.tracks.map((t) => {
    if (now < t.nextSpawnAt) return t;
    const busy = new Set(bubbles.map((b) => b.id));
    const free = eligibleIds.filter((id) => !busy.has(id));
    if (free.length > 0) {
      bubbles.push({
        id: free[Math.floor(Math.random() * free.length)]!,
        emoji: EMOJI_POOL[Math.floor(Math.random() * EMOJI_POOL.length)]!,
        expiresAt: now + LIFETIME_MS,
      });
    }
    return { nextSpawnAt: now + randGap() };
  });
  return { bubbles, tracks };
}

function randGap(): number {
  return MIN_GAP_MS + Math.random() * (MAX_GAP_MS - MIN_GAP_MS);
}
