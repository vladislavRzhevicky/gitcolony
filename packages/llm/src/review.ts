// ============================================================================
// Code review phase — two AI coworkers crack jokes about a quoted snippet
// from the city's source repo. Neither of them is meant to be the author;
// the sim rolls a pair at random, picks a random commit + snippet, and asks
// for an opener + reply.
//
// Pure: no DB, no caching. The caller (apps/api route) owns patch fetching,
// rate-limit accounting, and commit-level caching. Returns null on any
// failure so the client can fall back to a normal greeting.
// ============================================================================

import { generateObject } from 'ai';
import { z } from 'zod';
import { log } from '@gitcolony/log';
import { getModel, type LLMConfig } from './gemini.js';
import { buildCodeReviewPrompt } from './prompts.js';

export interface CodeReviewAgent {
  label: string;               // displayName || login || id
  personality: string | null;  // LLM-authored one-liner from the personality phase
}

export interface CodeReviewSnippet {
  filename: string;
  language: string | null;     // e.g. 'typescript', null if unknown
  lines: string[];             // raw source lines (no trailing newline)
  startLine: number;           // 1-based line number of lines[0] in the file
}

export interface CodeReviewInput {
  // The two speakers. `reviewer` opens, `developer` replies. Names are
  // historical — both speakers are just coworkers glancing at the code;
  // neither necessarily wrote it.
  reviewer: CodeReviewAgent;
  developer: CodeReviewAgent;
  snippet: CodeReviewSnippet;
  tone: 'praise' | 'roast';
  commitSubject: string | null;
}

export interface CodeReviewLines {
  opener: string;
  reply: string;
}

const ResponseSchema = z.object({
  opener: z.string().min(1).max(220),
  reply: z.string().min(1).max(220),
});

/**
 * Generates the two lines for a playful code-review exchange. Returns null
 * on any failure; the caller falls back to a regular greeting so the chat
 * never goes silent.
 */
export async function generateCodeReview(
  input: CodeReviewInput,
  config: LLMConfig,
): Promise<CodeReviewLines | null> {
  try {
    const { object } = await generateObject({
      model: getModel(config),
      schema: ResponseSchema,
      maxRetries: 1,
      prompt: buildCodeReviewPrompt(input),
    });
    return { opener: object.opener, reply: object.reply };
  } catch (err) {
    log.warn('llm code review failed', {
      reviewer: input.reviewer.label,
      developer: input.developer.label,
      filename: input.snippet.filename,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
