// ============================================================================
// Chatter — pure helpers for the AI-agent meeting / dialogue pipeline.
//
// Exposes:
//   - pairKey(a, b)        — order-independent stable string for cooldown maps.
//   - pickAiIds(agents, n) — deterministic "every Nth" selection by sorted id.
//   - mockLines(a, b, ...) — canned opener+reply for the mock pre-LLM phase.
//   - displayFor(agent)    — human-readable label (displayName > login > id).
//
// This file contains zero reactive state and zero I/O. The sim layer in
// `sim.svelte.ts` owns the `$state` chat log and the per-tick scan; we just
// hand it deterministic strings.
// ============================================================================

import type { Agent } from '@gitcolony/schema';
import { pickAgentName } from '@gitcolony/core/names';

/**
 * Pair cooldown key. Order-independent so `pairKey(a, b) === pairKey(b, a)`.
 * Uses `\x00` separator to stay unambiguous even if an id ever contained `|`.
 */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}\x00${b}` : `${b}\x00${a}`;
}

/**
 * Selects every Nth agent (by sorted id) as AI-controlled. Deterministic
 * across sessions for a given world, so the same swarm always materialises.
 *
 * We sort by id — stable across `initAgentRuntimes` because the schema ids
 * are `agent-<commitSha>` and world-gen emits them in ingestion order, which
 * is not guaranteed to be stable across regenerates. Sorting by id is.
 */
export function pickAiIds(agents: readonly Agent[], everyNth = 5): Set<string> {
  const ids = agents.map((a) => a.id).sort();
  const out = new Set<string>();
  for (let i = everyNth - 1; i < ids.length; i += everyNth) {
    out.add(ids[i]!);
  }
  return out;
}

/**
 * Stable "First Last" label picked deterministically from hardcoded pools
 * (see `@gitcolony/core/names`). We ignore the LLM-authored displayName —
 * it tended to riff on commit subjects and read like job titles rather
 * than inhabitants.
 */
export function displayFor(agent: Agent | undefined): string {
  if (!agent) return 'someone';
  return pickAgentName(agent.id);
}

// ----------------------------------------------------------------------------
// Mock canned phrases — used until the LLM layer is wired up.
//
// Templates use `%NAME%` for the partner's label. Two pools: openers (first
// speaker) and replies (second speaker). Choice is deterministic per
// (pairKey, tickAtMeet) so test reruns reproduce exactly.
// ----------------------------------------------------------------------------

const OPENERS: readonly string[] = [
  'Morning, %NAME%.',
  'Hey, %NAME%!',
  'Fancy meeting you here.',
  'Long time no see, %NAME%.',
  'How goes the grind?',
  'You shipping anything today?',
  'Coffee later?',
  'Seen the latest merge?',
  'All quiet on your end?',
  'Got a minute, %NAME%?',
];

const REPLIES: readonly string[] = [
  'Rough week, honestly.',
  'All good. You?',
  'Same as always.',
  "Don't remind me.",
  'Just shipping things.',
  'Too many reviewers, not enough reviews.',
  'Needs more tests.',
  "Catch up later — I'm late.",
  'One commit at a time.',
  "Can't complain.",
];

export interface MockLines {
  opener: string;
  reply: string;
}

/**
 * Produces the two lines for a single meeting event. The caller decides
 * which line belongs to which agent (typically the `opener` goes to the
 * lexicographically smaller id, so pair order is stable).
 */
export function mockLines(
  aLabel: string,
  bLabel: string,
  salt: string,
): MockLines {
  const opener = substitute(pickFrom(OPENERS, `${salt}|op`), bLabel);
  const reply = substitute(pickFrom(REPLIES, `${salt}|rp`), aLabel);
  return { opener, reply };
}

// ----------------------------------------------------------------------------
// Meeting → chat messages
// ----------------------------------------------------------------------------

/**
 * Provenance tag for a chat message so the UI can style an exchange by
 * source. `llm-fallback` marks a meeting where the LLM call was attempted
 * and failed, so the displayed text comes from the local canned pool.
 */
export type ChatMessageSource = 'mock' | 'llm' | 'llm-fallback';

export interface BuiltChatMessage {
  id: string;
  meetingId: string;
  speakerId: string;
  partnerId: string;
  speakerLabel: string;
  partnerLabel: string;
  text: string;
  tick: number;
  at: number;
  source: ChatMessageSource;
  /** True while an LLM call is in flight; false/undefined once settled. */
  pending?: boolean;
}

export interface MeetingSkeleton {
  firstId: string;
  secondId: string;
  firstLabel: string;
  secondLabel: string;
  meetingId: string;
  tick: number;
  at: number;
}

/**
 * Canonicalises speaker order by id so opener/reply always come from the
 * same side across reloads for a given pair. Returns the frame both
 * `buildMockMessages` and `buildPendingMessages` slot their text into.
 */
export function meetingSkeleton(
  aId: string,
  bId: string,
  aAgent: Agent | undefined,
  bAgent: Agent | undefined,
  tick: number,
  at: number,
): MeetingSkeleton {
  const [firstId, secondId, firstAgent, secondAgent] = aId < bId
    ? [aId, bId, aAgent, bAgent]
    : [bId, aId, bAgent, aAgent];
  const key = pairKey(firstId, secondId);
  return {
    firstId,
    secondId,
    firstLabel: displayFor(firstAgent),
    secondLabel: displayFor(secondAgent),
    meetingId: `meet-${key}-${tick}`,
    tick,
    at,
  };
}

function pair(
  sk: MeetingSkeleton,
  opener: string,
  reply: string,
  source: ChatMessageSource,
  pending?: boolean,
): [BuiltChatMessage, BuiltChatMessage] {
  const base = { tick: sk.tick, at: sk.at, source, pending };
  return [
    {
      id: `${sk.meetingId}-a`,
      meetingId: sk.meetingId,
      speakerId: sk.firstId,
      partnerId: sk.secondId,
      speakerLabel: sk.firstLabel,
      partnerLabel: sk.secondLabel,
      text: opener,
      ...base,
    },
    {
      id: `${sk.meetingId}-b`,
      meetingId: sk.meetingId,
      speakerId: sk.secondId,
      partnerId: sk.firstId,
      speakerLabel: sk.secondLabel,
      partnerLabel: sk.firstLabel,
      text: reply,
      ...base,
    },
  ];
}

/** Canned-phrase exchange. Used when LLM is unavailable or as a fallback. */
export function buildMockMessages(
  sk: MeetingSkeleton,
  source: ChatMessageSource = 'mock',
): [BuiltChatMessage, BuiltChatMessage] {
  const { opener, reply } = mockLines(
    sk.firstLabel,
    sk.secondLabel,
    `${sk.meetingId}`,
  );
  return pair(sk, opener, reply, source);
}

/** Placeholder exchange shown while an LLM call is in flight. */
export function buildPendingMessages(
  sk: MeetingSkeleton,
): [BuiltChatMessage, BuiltChatMessage] {
  return pair(sk, '…', '…', 'llm', true);
}

function substitute(template: string, name: string): string {
  return template.replaceAll('%NAME%', name);
}

function pickFrom<T>(pool: readonly T[], salt: string): T {
  // FNV-1a 32-bit — small, fast, stable across engines. We only need
  // uniform-ish bucketing into a ~10-entry pool, not cryptographic quality.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < salt.length; i++) {
    h ^= salt.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return pool[(h >>> 0) % pool.length]!;
}
