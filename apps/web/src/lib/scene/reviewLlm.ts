// ============================================================================
// Review-LLM bridge — parallel to MeetingLlmBridge but for the code-review
// phase. The sim rolls a chance per meeting to replace a greeting with a
// playful review; when that roll wins AND the bridge has budget, the sim
// hands over a skeleton + target commit sha. We shape the fetcher input,
// dispatch through `/api/ai/review`, and return opener + reply + quote.
//
// Failures collapse to null so the sim can retry via MeetingLlmBridge or
// fall back to canned phrases — reviews are strictly additive.
// ============================================================================

import type { ChatMessageSource, MeetingSkeleton, ReviewQuote } from './chatter';

export interface ReviewFetchInput {
  citySlug: string;
  commitSha: string;
  commitSubject: string | null;
  reviewer: { label: string; personality: string | null };
  developer: { label: string; personality: string | null };
}

export interface ReviewFetchResult {
  opener: string;
  reply: string;
  quote: ReviewQuote;
}

export type ReviewFetcher = (
  input: ReviewFetchInput,
) => Promise<ReviewFetchResult | null>;

export interface ReviewResolved {
  opener: string;
  reply: string;
  quote: ReviewQuote;
  source: ChatMessageSource;
}

export interface ReviewTarget {
  commitSha: string;
  commitSubject: string | null;
  /** Personality copy for each speaker, resolved by the sim. */
  reviewer: { label: string; personality: string | null };
  developer: { label: string; personality: string | null };
}

export interface ReviewLlmBridgeOptions {
  fetcher: ReviewFetcher;
  citySlug: string;
  /** Per-session call cap; defaults to 60 (reviews cost more than greets). */
  budget?: number;
  /** Max concurrent in-flight review requests; defaults to 2. */
  maxInFlight?: number;
}

export class ReviewLlmBridge {
  private fetcher: ReviewFetcher;
  private citySlug: string;
  private budget: number;
  private maxInFlight: number;
  private inFlight = 0;

  constructor(o: ReviewLlmBridgeOptions) {
    this.fetcher = o.fetcher;
    this.citySlug = o.citySlug;
    this.budget = o.budget ?? 60;
    this.maxInFlight = o.maxInFlight ?? 2;
  }

  canUse(): boolean {
    if (this.budget <= 0) return false;
    if (this.inFlight >= this.maxInFlight) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  async resolve(
    _sk: MeetingSkeleton,
    target: ReviewTarget,
  ): Promise<ReviewResolved | null> {
    this.budget--;
    this.inFlight++;
    try {
      const result = await this.fetcher({
        citySlug: this.citySlug,
        commitSha: target.commitSha,
        commitSubject: target.commitSubject,
        reviewer: target.reviewer,
        developer: target.developer,
      });
      if (result && result.opener && result.reply && result.quote) {
        return {
          opener: result.opener,
          reply: result.reply,
          quote: result.quote,
          source: 'llm',
        };
      }
      return null;
    } catch {
      return null;
    } finally {
      this.inFlight--;
    }
  }
}
