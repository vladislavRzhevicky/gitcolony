// ============================================================================
// Intent runner — applies LLM-authored `AgentIntent`s to the deterministic
// A* sim. The bridge (directorLlm.ts) owns the fetch; this module owns the
// per-agent state machine: when to re-ask, how to translate each intent
// into a path override or a frozen tick.
//
// Contract with AgentSim:
//   - Call `beforeStep(tickCount, slots)` once per tick, before stepping.
//   - Consult `isFrozen(agentId)` per agent to skip stepAgent while idle.
//   - `rt.path` is the mutation surface — setting it routes stepAgent onto
//     an LLM-chosen tile sequence; clearing it lets the default POI
//     rotation resume on the next tick.
// ============================================================================

import type { Agent, District, TilePos, World } from '@gitcolony/schema';
import { aStar } from '@gitcolony/core/sim';
import type { GridMask } from '@gitcolony/core/sim';
import type {
  AgentIntent,
  AgentIntentFetcher,
  DirectorSubjectInput,
} from './directorLlm';
import { DirectorLlmBridge } from './directorLlm';

// Rough cadence: each agent asks for a fresh intent every 135-270s on top of
// a first-ask stagger so they don't synchronise. Matches the chat throttle
// feel — the colony should look deliberate, not twitchy.
const TICK_SECONDS = 0.9;
const BASE_REQUERY_TICKS = Math.round(135 / TICK_SECONDS); // ~135s
const REQUERY_JITTER_TICKS = Math.round(135 / TICK_SECONDS);
const INITIAL_STAGGER_TICKS = Math.round(20 / TICK_SECONDS);
// Hard upper bound on a follow_agent intent — keeps an agent from locking
// onto a moving target forever if the peer never settles.
const FOLLOW_MAX_TICKS = Math.round(40 / TICK_SECONDS);
// Idle has its own `ticks` from the LLM; we clamp to be safe.
const IDLE_MAX_TICKS = 40;

/** Interface the sim exposes to the runner for reading live positions. */
export interface SlotView {
  id: string;
  pos: TilePos;
  path: TilePos[];
  role: string;
}

export interface IntentRunnerOptions {
  fetcher: AgentIntentFetcher;
  world: Pick<World, 'agents' | 'districts'>;
  aiIds: ReadonlySet<string>;
  agentsById: Map<string, Agent>;
  districtsById: Map<string, District>;
  walkable: GridMask;
  roadMask?: GridMask;
  /** Used to hash-stagger the first ask per agent. */
  seed: string;
}

interface IntentState {
  active: AgentIntent | null;
  idleTicksLeft: number;
  followTicksLeft: number;
  // Re-plan cadence for follow_agent — cheaper than every tick.
  followPlanCooldown: number;
  // Tick at which the next intent request becomes eligible.
  nextAskTick: number;
}

export class IntentRunner {
  private bridge: DirectorLlmBridge;
  private walkable: GridMask;
  private roadMask?: GridMask;
  private aiIds: ReadonlySet<string>;
  private agentsById: Map<string, Agent>;
  private districtsById: Map<string, District>;
  private states = new Map<string, IntentState>();
  // Populated by beforeStep() from the current slots array; read when
  // building the fetch payload so peers carry live district info.
  private slotIndex = new Map<string, SlotView>();
  // Quick lookup: tile → districtId, for attributing current location.
  private tileToDistrict: (pos: TilePos) => string | null;
  private populationByDistrict: Map<string, number>;

  constructor(o: IntentRunnerOptions) {
    this.walkable = o.walkable;
    this.roadMask = o.roadMask;
    this.aiIds = o.aiIds;
    this.agentsById = o.agentsById;
    this.districtsById = o.districtsById;
    this.bridge = new DirectorLlmBridge({
      fetcher: o.fetcher,
      agentsById: o.agentsById,
      districtsById: o.districtsById,
      onIntent: (id, intent) => this.applyIntent(id, intent),
    });

    // Population = how many agents live in each district (home district,
    // not current). Cheap one-shot; agents don't migrate.
    this.populationByDistrict = new Map();
    for (const a of o.world.agents) {
      this.populationByDistrict.set(
        a.districtId,
        (this.populationByDistrict.get(a.districtId) ?? 0) + 1,
      );
    }

    // Precompute district bboxes for tile lookup. Tiny grids, n is small.
    const districts = o.world.districts;
    this.tileToDistrict = (pos) => {
      for (const d of districts) {
        const halfW = Math.floor(d.sizeInTiles.w / 2);
        const halfH = Math.floor(d.sizeInTiles.h / 2);
        if (
          pos.x >= d.center.x - halfW && pos.x <= d.center.x + halfW &&
          pos.y >= d.center.y - halfH && pos.y <= d.center.y + halfH
        ) {
          return d.id;
        }
      }
      return null;
    };

    // Seed per-agent state with a staggered first-ask tick.
    let i = 0;
    for (const id of o.aiIds) {
      const stagger = hash32(`${o.seed}:${id}`) % Math.max(1, INITIAL_STAGGER_TICKS);
      this.states.set(id, {
        active: null,
        idleTicksLeft: 0,
        followTicksLeft: 0,
        followPlanCooldown: 0,
        nextAskTick: stagger + i,
      });
      i++;
    }
  }

  /** True while an idle intent is counting down for this agent. */
  isFrozen(agentId: string): boolean {
    return (this.states.get(agentId)?.idleTicksLeft ?? 0) > 0;
  }

  /**
   * Drives active intents forward and fires new requests for due agents.
   * Mutates `rt.path` directly — callers invoke this before stepAgent.
   */
  beforeStep(tickCount: number, slots: SlotView[]): void {
    this.slotIndex.clear();
    for (const s of slots) this.slotIndex.set(s.id, s);

    for (const s of slots) {
      if (!this.aiIds.has(s.id)) continue;
      const st = this.states.get(s.id);
      if (!st) continue;
      this.advance(st, s, tickCount);
      if (!st.active && tickCount >= st.nextAskTick && this.bridge.canUse(s.id)) {
        void this.bridge.resolve(this.buildSubject(s));
        // Tentatively push the next tick out so we don't retry every tick
        // while the first request is still in flight.
        st.nextAskTick = tickCount + BASE_REQUERY_TICKS;
      }
    }
  }

  private advance(st: IntentState, s: SlotView, tickCount: number): void {
    if (!st.active) return;
    if (st.idleTicksLeft > 0) {
      st.idleTicksLeft--;
      if (st.idleTicksLeft === 0) this.clear(st, tickCount);
      return;
    }
    if (st.active.kind === 'follow_agent') {
      st.followTicksLeft--;
      if (st.followPlanCooldown > 0) {
        st.followPlanCooldown--;
      } else {
        this.replanFollow(st.active.agentId, s);
        st.followPlanCooldown = 3;
      }
      if (st.followTicksLeft <= 0) this.clear(st, tickCount);
      return;
    }
    if (st.active.kind === 'goto_poi') {
      // Done when the one-shot path drains; stepAgent then falls back to
      // the default rotation naturally on the next tick.
      if (s.path.length === 0) this.clear(st, tickCount);
    }
  }

  private clear(st: IntentState, tickCount: number): void {
    st.active = null;
    st.idleTicksLeft = 0;
    st.followTicksLeft = 0;
    st.followPlanCooldown = 0;
    const jitter = Math.floor(Math.random() * REQUERY_JITTER_TICKS);
    st.nextAskTick = tickCount + BASE_REQUERY_TICKS + jitter;
  }

  private applyIntent(agentId: string, intent: AgentIntent): void {
    const st = this.states.get(agentId);
    const s = this.slotIndex.get(agentId);
    if (!st || !s) return;
    st.active = intent;
    if (intent.kind === 'idle') {
      st.idleTicksLeft = Math.max(1, Math.min(IDLE_MAX_TICKS, intent.ticks));
      return;
    }
    if (intent.kind === 'wander') {
      // Nothing to override — let default POI rotation take over. Clearing
      // the current path nudges stepAgent to replan via its own rotation.
      s.path.length = 0;
      return;
    }
    if (intent.kind === 'goto_poi') {
      const d = this.districtsById.get(intent.districtId);
      if (!d) { st.active = null; return; }
      this.planTo(s, d.center);
      return;
    }
    if (intent.kind === 'follow_agent') {
      st.followTicksLeft = FOLLOW_MAX_TICKS;
      st.followPlanCooldown = 0;
      this.replanFollow(intent.agentId, s);
    }
  }

  private replanFollow(targetId: string, s: SlotView): void {
    const target = this.slotIndex.get(targetId);
    if (!target) return;
    this.planTo(s, target.pos);
  }

  private planTo(s: SlotView, goal: TilePos): void {
    if (goal.x === s.pos.x && goal.y === s.pos.y) {
      s.path.length = 0;
      return;
    }
    const path = aStar(this.walkable, s.pos, goal, this.roadMask);
    if (!path || path.length <= 1) {
      s.path.length = 0;
      return;
    }
    // Overwrite in place so stepAgent's next shift() consumes the new route.
    s.path.length = 0;
    for (let i = 1; i < path.length; i++) s.path.push(path[i]!);
  }

  private buildSubject(s: SlotView): DirectorSubjectInput {
    const peers: DirectorSubjectInput['peers'] = [];
    for (const other of this.slotIndex.values()) {
      if (other.id === s.id) continue;
      if (!this.aiIds.has(other.id)) continue;
      peers.push({ id: other.id, districtId: this.tileToDistrict(other.pos) });
      if (peers.length >= 8) break;
    }
    return {
      id: s.id,
      currentDistrictId: this.tileToDistrict(s.pos),
      populationByDistrict: this.populationByDistrict,
      peers,
      timeOfDay: timeOfDay(),
    };
  }
}

function timeOfDay(): 'morning' | 'afternoon' | 'evening' | 'night' {
  const h = new Date().getHours();
  if (h < 6) return 'night';
  if (h < 12) return 'morning';
  if (h < 18) return 'afternoon';
  return 'evening';
}

function hash32(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
