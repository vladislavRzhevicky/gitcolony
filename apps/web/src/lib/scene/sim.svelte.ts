import type { Agent, District, World } from '@gitcolony/schema';
// Subpath import: root barrel drags `node:crypto` via `seed.ts`.
import {
  type AgentRuntime,
  buildGraveyardWalkable,
  buildRoadMask,
  buildSimWalkable,
  collectGraveyardPOIs,
  collectPOIs,
  flattenPOIs,
  initAgentRuntimes,
  stepAgent,
} from '@gitcolony/core/sim';
import { TILE_SIZE, tileToWorld } from './mapping';
import {
  type BuiltChatMessage,
  buildPendingMessages,
  type ChatMessageSource,
  type MeetingSkeleton,
  meetingSkeleton,
  mockLines,
  pairKey,
  pickAiIds,
} from './chatter';
import { MeetingLlmBridge, type MeetingFetcher } from './meetingLlm';
import { IntentRunner } from './directorIntents';
import type { AgentIntentFetcher } from './directorLlm';
import { advanceEmojiState, type EmojiBubble, type EmojiTrack, initialEmojiState } from './emojiBubbles';

export type { MeetingFetcher, MeetingFetchInput, MeetingFetchResult } from './meetingLlm';
export type {
  AgentIntentFetcher,
  AgentIntentFetchInput,
  AgentIntentFetchResult,
  AgentIntent,
} from './directorLlm';

// Client sim: one tile per TICK_SECONDS, linear interp between.
const TICK_SECONDS = 0.9;
const AI_EVERY_NTH = 5;
const MEET_RADIUS_MANHATTAN = 1;
// ~18s global gap / ~108s per-pair cooldown at TICK_SECONDS=0.9.
const MIN_MEETING_GAP_TICKS = 20;
const MEET_COOLDOWN_TICKS = 120;
const CHAT_LOG_MAX = 120;
const TYPING_MS = 1500;
const BUBBLE_GAP_MS = 600;

export interface AgentPose {
  id: string;
  x: number;
  z: number;
  yaw: number;
}

export type ChatMessage = BuiltChatMessage;

export interface AgentSimOptions {
  /** When set, meetings hit the LLM proxy; fallback to mocks on failure. */
  fetchMeetingLines?: MeetingFetcher;
  /** When set, AI agents periodically ask the LLM director for next action. */
  fetchAgentIntent?: AgentIntentFetcher;
}

interface Slot {
  rt: AgentRuntime;
  fromX: number;
  fromZ: number;
  toX: number;
  toZ: number;
  yaw: number;
}

export class AgentSim {
  poses = $state<AgentPose[]>([]);
  chatLog = $state<ChatMessage[]>([]);
  // Ambient decorative bubbles over random agents. Orthogonal to chat.
  emojiBubbles = $state<EmojiBubble[]>([]);
  // Speakers with an in-flight chat bubble — render loop shows dots.
  typingIds = $derived.by(() => {
    const ids = new Set<string>();
    for (const m of this.chatLog) if (m.pending) ids.add(m.speakerId);
    return ids;
  });

  readonly aiIds: ReadonlySet<string>;

  private slots: Slot[] = [];
  private elapsed = 0;
  private world: World;
  private walkable;
  private roadMask;
  private pois;
  // Ghost masks clip A* to the graveyard bbox.
  private ghostPois;
  private ghostWalkable;
  private tickCount = 0;
  private lastMeetAt = new Map<string, number>();
  private lastAnyMeetAt = Number.NEGATIVE_INFINITY;
  private agentsById: Map<string, Agent>;
  private llmBridge: MeetingLlmBridge | null;
  private intentRunner: IntentRunner | null;
  // Independent spawn tracks for emojiBubbles (plain field — only the
  // bubble list needs reactivity).
  private emojiTracks: EmojiTrack[] = [];

  constructor(world: World, options: AgentSimOptions = {}) {
    this.world = world;
    this.agentsById = new Map(world.agents.map((a) => [a.id, a]));
    const districtsById = new Map<string, District>(
      world.districts.map((d) => [d.id, d]),
    );
    this.aiIds = pickAiIds(world.agents, AI_EVERY_NTH);
    this.walkable = buildSimWalkable(world);
    this.roadMask = buildRoadMask(world);
    this.pois = flattenPOIs(collectPOIs(world, this.walkable));
    this.ghostPois = collectGraveyardPOIs(world, this.walkable);
    this.ghostWalkable = buildGraveyardWalkable(world, this.walkable);
    this.llmBridge = options.fetchMeetingLines
      ? new MeetingLlmBridge({ fetcher: options.fetchMeetingLines, agentsById: this.agentsById, districtsById })
      : null;
    this.intentRunner = options.fetchAgentIntent
      ? new IntentRunner({
          fetcher: options.fetchAgentIntent,
          world,
          aiIds: this.aiIds,
          agentsById: this.agentsById,
          districtsById,
          walkable: this.walkable,
          roadMask: this.roadMask,
          seed: world.seed,
        })
      : null;
    const runtimes = initAgentRuntimes(world, this.walkable, collectPOIs(world, this.walkable), this.roadMask);
    // Ghost first-path used global mask — drop so next tick replans inside graveyard bbox.
    for (const rt of runtimes) if (rt.role === 'ghost') rt.path = [];
    this.slots = runtimes.map((rt: AgentRuntime) => this.slotFromRuntime(rt));
    this.poses = this.slots.map((s) => ({ id: s.rt.id, x: s.fromX, z: s.fromZ, yaw: s.yaw }));
    this.emojiTracks = initialEmojiState(Date.now()).tracks;
  }

  /** True if the given agent id belongs to the AI swarm. */
  isAi(id: string): boolean {
    return this.aiIds.has(id);
  }

  /** Advances by `dt`. Catch-up capped so tab-refocus doesn't fast-forward. */
  tick(dt: number): void {
    this.elapsed += dt;
    if (this.elapsed >= TICK_SECONDS) {
      this.elapsed = Math.min(this.elapsed - TICK_SECONDS, TICK_SECONDS);
      // Director may overwrite rt.path before stepAgent consumes it.
      this.intentRunner?.beforeStep(this.tickCount, this.slots.map((s) => s.rt));
      for (const s of this.slots) {
        const isGhost = s.rt.role === 'ghost';
        const walkable = isGhost ? this.ghostWalkable : this.walkable;
        const pois = isGhost ? this.ghostPois : this.pois;
        const road = isGhost ? undefined : this.roadMask;
        if (this.intentRunner?.isFrozen(s.rt.id)) {
          this.rearmSlot(s); // idle intent: hold pose.
          continue;
        }
        stepAgent(s.rt, walkable, pois, road);
        this.rearmSlot(s);
      }
      this.tickCount++;
      this.scanMeetings();
      this.tickEmojiBubbles();
    }
    const a = this.elapsed / TICK_SECONDS;
    this.poses = this.slots.map((s) => ({
      id: s.rt.id, x: s.fromX + (s.toX - s.fromX) * a, z: s.fromZ + (s.toZ - s.fromZ) * a, yaw: s.yaw,
    }));
  }

  private slotFromRuntime(rt: AgentRuntime): Slot {
    const from = tileToWorld(rt.pos, this.world.grid, 0);
    const to = tileToWorld(rt.path[0] ?? rt.pos, this.world.grid, 0);
    return { rt, fromX: from.x, fromZ: from.z, toX: to.x, toZ: to.z, yaw: computeYaw(from.x, from.z, to.x, to.z, 0) };
  }

  /** O(n²) AI-pair scan, gated by tab-visibility + global/pair cooldowns. */
  private scanMeetings(): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    if (this.tickCount - this.lastAnyMeetAt < MIN_MEETING_GAP_TICKS) return;

    const aiSlots = this.slots.filter((s) => this.aiIds.has(s.rt.id));
    if (aiSlots.length < 2) return;

    const now = Date.now();
    outer: for (let i = 0; i < aiSlots.length; i++) {
      const a = aiSlots[i]!;
      for (let j = i + 1; j < aiSlots.length; j++) {
        const b = aiSlots[j]!;
        const dx = Math.abs(a.rt.pos.x - b.rt.pos.x);
        const dy = Math.abs(a.rt.pos.y - b.rt.pos.y);
        if (dx + dy > MEET_RADIUS_MANHATTAN) continue;

        const key = pairKey(a.rt.id, b.rt.id);
        const last = this.lastMeetAt.get(key);
        if (last !== undefined && this.tickCount - last < MEET_COOLDOWN_TICKS) continue;
        this.lastMeetAt.set(key, this.tickCount);
        this.lastAnyMeetAt = this.tickCount;

        const aA = this.agentsById.get(a.rt.id);
        const bA = this.agentsById.get(b.rt.id);
        const sk = meetingSkeleton(a.rt.id, b.rt.id, aA, bA, this.tickCount, now);
        void this.enqueueMeeting(sk);
        break outer; // cap at one exchange per tick.
      }
    }
  }

  /** Two-beat exchange with sequential reveal; LLM fetch races TYPING_MS. */
  private async enqueueMeeting(sk: MeetingSkeleton): Promise<void> {
    const [pendingOpener, pendingReply] = buildPendingMessages(sk);
    this.appendChat(pendingOpener);

    const start = Date.now();
    let resolved = this.llmBridge?.canUse()
      ? await this.llmBridge.resolve(sk)
      : null;
    if (!resolved) {
      const m = mockLines(sk.firstLabel, sk.secondLabel, sk.meetingId);
      const source: ChatMessageSource = this.llmBridge ? 'llm-fallback' : 'mock';
      resolved = { opener: m.opener, reply: m.reply, source };
    }

    const elapsed = Date.now() - start;
    if (elapsed < TYPING_MS) await sleep(TYPING_MS - elapsed);
    this.patchMessage(sk.meetingId, 'opener', resolved.opener, resolved.source);

    await sleep(BUBBLE_GAP_MS);
    this.appendChat(pendingReply);
    await sleep(TYPING_MS);
    this.patchMessage(sk.meetingId, 'reply', resolved.reply, resolved.source);
  }

  private appendChat(msg: BuiltChatMessage): void {
    const next = this.chatLog.concat([msg]);
    this.chatLog = next.length > CHAT_LOG_MAX
      ? next.slice(next.length - CHAT_LOG_MAX)
      : next;
  }

  /** Expire finished emoji bubbles and fire any tracks whose 10–20s
   * timeout elapsed. Typing agents are excluded so the two bubble
   * styles never stack on one head. */
  private tickEmojiBubbles(): void {
    if (typeof document !== 'undefined' && document.hidden) return;
    const typing = this.typingIds;
    const eligible = this.slots.filter((s) => !typing.has(s.rt.id)).map((s) => s.rt.id);
    const next = advanceEmojiState(
      { bubbles: this.emojiBubbles, tracks: this.emojiTracks },
      eligible,
      Date.now(),
    );
    this.emojiBubbles = next.bubbles;
    this.emojiTracks = next.tracks;
  }

  /** Settle one side of a pending exchange — `-a`/`-b` id suffix selects. */
  private patchMessage(meetingId: string, which: 'opener' | 'reply', text: string, source: ChatMessageSource): void {
    const suffix = which === 'opener' ? '-a' : '-b';
    this.chatLog = this.chatLog.map((m) => {
      if (m.meetingId !== meetingId || !m.id.endsWith(suffix)) return m;
      return { ...m, text, source, pending: false };
    });
  }

  private rearmSlot(s: Slot): void {
    const from = tileToWorld(s.rt.pos, this.world.grid, 0);
    const nextTile = s.rt.path[0] ?? s.rt.pos;
    const to = tileToWorld(nextTile, this.world.grid, 0);
    s.fromX = from.x;
    s.fromZ = from.z;
    s.toX = to.x;
    s.toZ = to.z;
    s.yaw = computeYaw(from.x, from.z, to.x, to.z, s.yaw);
  }
}

// Face motion direction; hold prev yaw when idle so mesh doesn't snap to 0.
function computeYaw(fx: number, fz: number, tx: number, tz: number, prev: number): number {
  const dx = tx - fx;
  const dz = tz - fz;
  if (Math.abs(dx) + Math.abs(dz) < 1e-4 * TILE_SIZE) return prev;
  return Math.atan2(dx, dz);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
