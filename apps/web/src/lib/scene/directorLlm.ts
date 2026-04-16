// ============================================================================
// Director-LLM bridge — orchestrates the "what next?" intent calls for AI
// agents without dragging budget, concurrency, or payload shaping into
// AgentSim itself.
//
// The sim asks `canUse(agentId)` when an agent is due for a fresh intent,
// hands a payload to `resolve()`, and receives the applied intent via
// `onIntent`. Failures silently drop the intent — the sim keeps its
// deterministic A* rotation running underneath, so a dead fetcher just
// means agents never deviate from the default POI cycle.
// ============================================================================

import type { Agent, District } from '@gitcolony/schema';

/** Wire shape expected by /api/ai/intent. Matches `DirectorInput` on server. */
export interface AgentIntentFetchInput {
  subject: {
    id: string;
    label: string;
    personality: string | null;
    homeDistrictName: string | null;
    currentDistrictName: string | null;
    commitSubject: string | null;
  };
  districts: Array<{
    id: string;
    name: string;
    population: number;
    isHome: boolean;
    isCurrent: boolean;
  }>;
  peers: Array<{
    id: string;
    label: string;
    districtName: string | null;
  }>;
  timeOfDay?: 'morning' | 'afternoon' | 'evening' | 'night';
}

/** Discriminated union mirroring server-side `AgentIntent`. */
export type AgentIntent =
  | { kind: 'goto_poi'; districtId: string; reason?: string }
  | { kind: 'follow_agent'; agentId: string; reason?: string }
  | { kind: 'idle'; ticks: number; reason?: string }
  | { kind: 'wander'; reason?: string };

export interface AgentIntentFetchResult {
  intent: AgentIntent;
}

export type AgentIntentFetcher = (
  input: AgentIntentFetchInput,
) => Promise<AgentIntentFetchResult | null>;

export type IntentApply = (agentId: string, intent: AgentIntent) => void;

export interface DirectorSubjectInput {
  id: string;
  currentDistrictId: string | null;
  populationByDistrict: ReadonlyMap<string, number>;
  peers: Array<{ id: string; districtId: string | null }>;
  timeOfDay?: AgentIntentFetchInput['timeOfDay'];
}

export interface DirectorLlmBridgeOptions {
  fetcher: AgentIntentFetcher;
  agentsById: Map<string, Agent>;
  districtsById: Map<string, District>;
  onIntent: IntentApply;
  /** Per-session call cap; defaults to 200. */
  budget?: number;
  /** Max concurrent in-flight intent requests; defaults to 2. */
  maxInFlight?: number;
}

export class DirectorLlmBridge {
  private fetcher: AgentIntentFetcher;
  private agentsById: Map<string, Agent>;
  private districtsById: Map<string, District>;
  private onIntent: IntentApply;
  private budget: number;
  private maxInFlight: number;
  private inFlight = 0;
  // Agents already awaiting a response — skip them so we don't queue up
  // duplicate requests while a previous one is still round-tripping.
  private pending = new Set<string>();

  constructor(o: DirectorLlmBridgeOptions) {
    this.fetcher = o.fetcher;
    this.agentsById = o.agentsById;
    this.districtsById = o.districtsById;
    this.onIntent = o.onIntent;
    this.budget = o.budget ?? 200;
    this.maxInFlight = o.maxInFlight ?? 2;
  }

  /**
   * Gate for issuing a new intent request. Skips when the tab is hidden
   * so a backgrounded colony doesn't quietly burn the budget.
   */
  canUse(agentId: string): boolean {
    if (this.budget <= 0) return false;
    if (this.inFlight >= this.maxInFlight) return false;
    if (this.pending.has(agentId)) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  /**
   * Fires the intent request for one agent. Decrements budget up front so
   * a burst on the same tick can't race past the cap. Silently drops on
   * any failure — deterministic rotation keeps the agent moving.
   */
  async resolve(subject: DirectorSubjectInput): Promise<void> {
    const payload = this.buildInput(subject);
    if (!payload) return;
    this.budget--;
    this.inFlight++;
    this.pending.add(subject.id);
    try {
      const result = await this.fetcher(payload);
      if (result?.intent) {
        this.onIntent(subject.id, result.intent);
      }
    } catch {
      // swallow — caller's next tick will try again when canUse() allows.
    } finally {
      this.inFlight--;
      this.pending.delete(subject.id);
    }
  }

  private buildInput(subject: DirectorSubjectInput): AgentIntentFetchInput | null {
    const agent = this.agentsById.get(subject.id);
    if (!agent) return null;
    const homeName = this.districtsById.get(agent.districtId)?.name ?? null;
    const currentName = subject.currentDistrictId
      ? this.districtsById.get(subject.currentDistrictId)?.name ?? null
      : null;
    const districts: AgentIntentFetchInput['districts'] = [];
    for (const d of this.districtsById.values()) {
      districts.push({
        id: d.id,
        name: d.name,
        population: subject.populationByDistrict.get(d.id) ?? 0,
        isHome: d.id === agent.districtId,
        isCurrent: d.id === subject.currentDistrictId,
      });
    }
    const peers: AgentIntentFetchInput['peers'] = [];
    for (const p of subject.peers) {
      const peer = this.agentsById.get(p.id);
      if (!peer) continue;
      peers.push({
        id: p.id,
        label: peer.displayName ?? peer.authorLogin ?? p.id.slice(0, 8),
        districtName: p.districtId
          ? this.districtsById.get(p.districtId)?.name ?? null
          : null,
      });
    }
    return {
      subject: {
        id: agent.id,
        label: agent.displayName ?? agent.authorLogin ?? agent.id.slice(0, 8),
        personality: agent.personality ?? null,
        homeDistrictName: homeName,
        currentDistrictName: currentName,
        commitSubject: agent.message ?? null,
      },
      districts,
      peers,
      timeOfDay: subject.timeOfDay,
    };
  }
}
