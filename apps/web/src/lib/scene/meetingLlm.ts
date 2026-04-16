// ============================================================================
// Meeting-LLM bridge — bolts the async greet pipeline onto the sim without
// dragging budget, concurrency, or payload-shaping into AgentSim itself.
//
// The sim asks `canUse()` on each meeting, pushes pending placeholders into
// its chatLog, then hands the skeleton to `resolve()`. On settle we invoke
// `onSettle` to patch the two messages in place. Failures collapse to the
// canned pool tagged `llm-fallback` so the panel can render the degraded
// path explicitly.
// ============================================================================

import type { Agent, District } from '@gitcolony/schema';
import type { ChatMessageSource, MeetingSkeleton } from './chatter';

/** Shape the page-level proxy receives. Flat, JSON-friendly. */
export interface MeetingFetchInput {
  meetingId: string;
  first: MeetingAgentInput;
  second: MeetingAgentInput;
  context: { districtName: string | null };
}

export interface MeetingAgentInput {
  label: string;
  personality: string | null;
  districtName: string | null;
  commitSubject: string | null;
}

export interface MeetingFetchResult {
  opener: string;
  reply: string;
}

export type MeetingFetcher = (
  input: MeetingFetchInput,
) => Promise<MeetingFetchResult | null>;

export interface MeetingResolved {
  opener: string;
  reply: string;
  source: ChatMessageSource;
}

export interface MeetingLlmBridgeOptions {
  fetcher: MeetingFetcher;
  agentsById: Map<string, Agent>;
  districtsById: Map<string, District>;
  /** Per-session call cap; defaults to 200. */
  budget?: number;
  /** Max concurrent in-flight greet requests; defaults to 3. */
  maxInFlight?: number;
}

export class MeetingLlmBridge {
  private fetcher: MeetingFetcher;
  private agentsById: Map<string, Agent>;
  private districtsById: Map<string, District>;
  private budget: number;
  private maxInFlight: number;
  private inFlight = 0;

  constructor(o: MeetingLlmBridgeOptions) {
    this.fetcher = o.fetcher;
    this.agentsById = o.agentsById;
    this.districtsById = o.districtsById;
    this.budget = o.budget ?? 200;
    this.maxInFlight = o.maxInFlight ?? 3;
  }

  /**
   * Gate for the LLM path. Skips when the tab is hidden so backgrounded
   * colonies don't quietly burn through the per-session budget.
   */
  canUse(): boolean {
    if (this.budget <= 0) return false;
    if (this.inFlight >= this.maxInFlight) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  /**
   * Fetches opener + reply for a meeting. Returns null on any failure —
   * network, upstream non-2xx, shape mismatch — and the caller falls back
   * to canned phrases tagged `llm-fallback`. Decrements `budget` up front
   * so a burst of simultaneous meetings can't race past the cap.
   */
  async resolve(sk: MeetingSkeleton): Promise<MeetingResolved | null> {
    this.budget--;
    this.inFlight++;
    try {
      const result = await this.fetcher(this.buildInput(sk));
      if (result && result.opener && result.reply) {
        return { opener: result.opener, reply: result.reply, source: 'llm' };
      }
      return null;
    } catch {
      return null;
    } finally {
      this.inFlight--;
    }
  }

  private buildInput(sk: MeetingSkeleton): MeetingFetchInput {
    const firstAgent = this.agentsById.get(sk.firstId);
    const secondAgent = this.agentsById.get(sk.secondId);
    const firstDistrict = firstAgent
      ? this.districtsById.get(firstAgent.districtId)?.name ?? null
      : null;
    const secondDistrict = secondAgent
      ? this.districtsById.get(secondAgent.districtId)?.name ?? null
      : null;
    return {
      meetingId: sk.meetingId,
      first: {
        label: sk.firstLabel,
        personality: firstAgent?.personality ?? null,
        districtName: firstDistrict,
        commitSubject: firstAgent?.message ?? null,
      },
      second: {
        label: sk.secondLabel,
        personality: secondAgent?.personality ?? null,
        districtName: secondDistrict,
        commitSubject: secondAgent?.message ?? null,
      },
      context: { districtName: firstDistrict ?? secondDistrict },
    };
  }
}
