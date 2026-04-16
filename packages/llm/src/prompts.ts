// ============================================================================
// All LLM prompt templates for the project.
//
// Pure string-building — each builder takes a typed input from its phase
// module and returns the text handed to `generateObject({ prompt })`.
// Consolidated here so tone and rule-wording stay consistent across phases
// and so tuning a prompt doesn't require re-reading five separate modules.
//
// Types are imported back from each phase module (`import type`) to avoid
// duplicating contracts; runtime stays one-way (phase modules → prompts).
// ============================================================================

import type { MeetingAgent, MeetingContext } from './chatter.js';
import type { DirectorInput } from './director.js';
import type { NameInput } from './naming.js';
import type { AgentProfileInput } from './personality.js';
import type { TickerInput } from './ticker.js';
import type { CodeReviewInput } from './review.js';

// ----------------------------------------------------------------------------
// Naming — per-building displayName + tagline (tier-B buildings).
// ----------------------------------------------------------------------------

export function buildNamingPrompt(items: readonly NameInput[]): string {
  const lines = items.map(
    (it) =>
      `- id=${it.id} | district=${it.districtName} | type=${it.semanticType} | variant=${it.variant} | commit="${truncate(it.commitMessage, 140)}"`,
  );
  return [
    'You name buildings for a stylized city built from a software repository.',
    'Each building represents one git commit. Give it a short evocative name and a one-line tagline.',
    '',
    'Rules:',
    '- displayName: 1-3 words, English, Title Case, max 24 chars. Suggest the building type (workshop, hall, library, tower, clinic, archive, depot, etc.) without being literal.',
    '- tagline: one sentence, English, max 60 chars, no trailing period. Hint at what the commit changed but in city-flavor language. No emoji.',
    '- Do not echo the commit hash. Do not mention git, code, or commits explicitly.',
    '- Each input has a stable id; respond with the same id verbatim.',
    '',
    'Buildings:',
    ...lines,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Personality — per-agent displayName + one-line personality (tier-A).
// ----------------------------------------------------------------------------

export function buildPersonalityPrompt(items: readonly AgentProfileInput[]): string {
  const lines = items.map(
    (it) =>
      `- id=${it.id} | author=${it.authorLogin ?? 'anon'} | district=${it.districtName} | type=${it.semanticType} | commit="${truncate(it.commitMessage, 140)}"`,
  );
  return [
    'You write character profiles for inhabitants of a stylized city built from a software repository.',
    'Each inhabitant was spawned by one git commit and lives in a district named after a top-level project folder.',
    '',
    'Rules:',
    '- displayName: a short in-world name (1-2 words, max 24 chars). May playfully riff on the author handle but is not the handle itself.',
    '- personality: one sentence, English, max 100 chars, no trailing period. Voice the trade or temperament implied by the commit type and district. No emoji, no mention of git/code/commits.',
    '- Each input has a stable id; respond with the same id verbatim.',
    '',
    'Inhabitants:',
    ...lines,
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Ticker — 5-10 short city news scenes derived from recent commits.
// ----------------------------------------------------------------------------

export function buildTickerPrompt(input: TickerInput): string {
  const commits = input.commits
    .slice(0, 20)
    .map(
      (c) =>
        `- sha=${c.sha} | author=${c.author ?? 'anon'} | district=${c.districtName ?? 'unknown'} | type=${c.semanticType} | "${truncate(c.message, 140)}"`,
    );
  const agents = [...input.agents]
    .sort((a, b) => Number(!!b.displayName) - Number(!!a.displayName))
    .slice(0, 30)
    .map(
      (a) =>
        `- id=${a.id} | name=${a.displayName ?? '(anon)'} | district=${a.districtName} | personality="${truncate(a.personality ?? '', 100)}"`,
    );
  const objects = [...input.objects]
    .filter((o) => o.displayName)
    .slice(0, 30)
    .map(
      (o) => `- id=${o.id} | name=${o.displayName} | district=${o.districtName}`,
    );

  return [
    'You are the city ticker for a software-repository-as-city visualisation.',
    'Compose 5-10 short, present-tense scenes from the most recent commits and the roster below.',
    '',
    'Rules:',
    '- text: one sentence per event, English, max 110 chars, no trailing period, no emoji.',
    '- Reference inhabitants by displayName when you know one; otherwise mention the author handle as @handle.',
    '- When an event clearly involves a roster agent or building, set agentId / objectId to its id from the roster.',
    '- commitSha and author should match the source commit when applicable.',
    '- Mix moods: a couple of construction events, a couple of social events, the rest commit-derived news.',
    '',
    'Recent commits:',
    ...commits,
    '',
    'Inhabitants on file:',
    ...(agents.length > 0 ? agents : ['(none)']),
    '',
    'Named buildings:',
    ...(objects.length > 0 ? objects : ['(none)']),
  ].join('\n');
}

// ----------------------------------------------------------------------------
// Chatter — opener + reply for a single meeting between two AI agents.
// ----------------------------------------------------------------------------

export function buildChatterPrompt(
  first: MeetingAgent,
  second: MeetingAgent,
  context: MeetingContext,
): string {
  return [
    'You voice two inhabitants of a stylized city built from a software repository.',
    'They just crossed paths on the street and exchange two short lines.',
    '',
    'Rules:',
    '- opener: comes from the first inhabitant. Greets or acknowledges the second by their label when natural.',
    '- reply: comes from the second inhabitant. Addresses the first or riffs on the opener.',
    '- Each line: 1 sentence, English, under 100 characters, no trailing period if you can help it.',
    '- Voice reflects the inhabitant\'s personality and their district. Keep it warm and grounded.',
    '- No emoji. Do not mention git, code, commits, or the word "AI".',
    '- Do not put quotes around the lines; return raw sentences.',
    '',
    `First inhabitant: label=${first.label} | district=${first.districtName ?? 'unknown'} | vibe=${first.personality ?? 'steady citizen'} | from commit="${truncate(first.commitSubject ?? '', 80)}"`,
    `Second inhabitant: label=${second.label} | district=${second.districtName ?? 'unknown'} | vibe=${second.personality ?? 'steady citizen'} | from commit="${truncate(second.commitSubject ?? '', 80)}"`,
    context.districtName
      ? `They meet on a street in: ${context.districtName}`
      : 'They meet on a city street.',
    context.timeOfDay ? `Time of day: ${context.timeOfDay}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

// ----------------------------------------------------------------------------
// Director — next action for one AI agent.
// ----------------------------------------------------------------------------

export function buildDirectorPrompt(input: DirectorInput): string {
  const { subject, districts, peers, timeOfDay } = input;
  const districtLines = districts
    .map((d) => {
      const tags = [d.isHome ? 'home' : '', d.isCurrent ? 'here' : '']
        .filter(Boolean)
        .join(',');
      const suffix = tags ? ` [${tags}]` : '';
      return `  - id=${d.id} | name=${d.name} | pop=${d.population}${suffix}`;
    })
    .join('\n');
  const peerLines = peers.length
    ? peers
        .map((p) => `  - id=${p.id} | label=${p.label} | in=${p.districtName ?? 'unknown'}`)
        .join('\n')
    : '  (no peers nearby)';

  return [
    'You direct one inhabitant of a small stylized city built from a code repository.',
    'Pick exactly one next action from the available tools. Stay in character.',
    '',
    'Subject:',
    `  label=${subject.label} | home=${subject.homeDistrictName ?? 'unknown'} | current=${subject.currentDistrictName ?? 'unknown'}`,
    `  vibe=${subject.personality ?? 'steady citizen'}`,
    `  from commit="${truncate(subject.commitSubject ?? '', 80)}"`,
    '',
    'Districts (id, name, population):',
    districtLines || '  (none)',
    '',
    'AI peers in the colony:',
    peerLines,
    timeOfDay ? `\nTime of day: ${timeOfDay}` : '',
    '',
    'Rules:',
    '- Prefer variety over repetition. Do not always `goto_poi`.',
    '- `goto_poi.districtId` MUST be one of the district ids listed above.',
    '- `follow_agent.agentId` MUST be one of the AI peer ids listed above.',
    '- `idle.ticks` is 1..40. Reasonable loiter is 4..12.',
    '- `reason` is optional, under 80 chars, in-character third-person.',
  ]
    .filter(Boolean)
    .join('\n');
}

// ----------------------------------------------------------------------------
// Code review — two coworkers crack jokes about a quoted code snippet.
// Tuned for tone: playful roast OR playful praise, never cruel. Language
// follows the commit subject (Cyrillic → Russian, else English) so Russian
// repos get Russian jabs.
// ----------------------------------------------------------------------------

export function buildCodeReviewPrompt(input: CodeReviewInput): string {
  const { snippet, reviewer, developer, tone, commitSubject } = input;
  const endLine = snippet.startLine + snippet.lines.length - 1;
  const toneLine =
    tone === 'praise'
      ? "Tone: over-the-top PRAISE. Earnest admiration, mock-reverence, dramatic compliments. Not sarcastic — genuinely enthusiastic in a funny way."
      : "Tone: playful ROAST. Tease the code like you're ribbing a coworker. Exaggerate, use vivid metaphors. Never cruel, never personal, never profane.";

  return [
    'You voice two coworkers in a stylized city who just spotted a code snippet from their company repo and are reacting out loud to each other.',
    'Neither of them wrote it — they are simply reading and commenting.',
    '',
    'Rules:',
    "- opener: one sentence from the first speaker reacting to the snippet itself.",
    '- reply: one sentence from the second speaker, either piling on, pushing back, or adding a twist. Must read as a response to the opener.',
    '- Each line: max 140 characters, no trailing period required, no emoji, no slurs, no personal attacks, no profanity.',
    '- Stay on the snippet. Do NOT mention git, commits, pull requests, "AI", or the word "code review" explicitly.',
    '- Do NOT repeat or quote the snippet text in your lines — it is shown separately.',
    '- Language: if the commit subject contains Cyrillic letters, reply in Russian. Otherwise reply in English. Never mix languages.',
    '',
    toneLine,
    '',
    `First speaker: ${reviewer.label}${reviewer.personality ? ` (${truncate(reviewer.personality, 100)})` : ''}`,
    `Second speaker: ${developer.label}${developer.personality ? ` (${truncate(developer.personality, 100)})` : ''}`,
    commitSubject
      ? `Commit subject that introduced this snippet: "${truncate(commitSubject, 140)}"`
      : '',
    '',
    `Snippet is from \`${snippet.filename}\`${snippet.language ? ` (${snippet.language})` : ''}, lines ${snippet.startLine}-${endLine}:`,
    '```',
    ...snippet.lines,
    '```',
  ]
    .filter(Boolean)
    .join('\n');
}

// ----------------------------------------------------------------------------
// Shared helpers
// ----------------------------------------------------------------------------

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
