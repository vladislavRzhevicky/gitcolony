// ============================================================================
// Code-hunk utilities — pure helpers for extracting a short reviewable
// snippet from a GitHub REST `commits/:sha` response. Used server-side by
// the /ai/review route to pick one run of added lines for the joke
// code-review dialogue.
//
// Pure: no I/O, no globals. Lives in packages/core so snippets can be
// extracted server-side (apps/api) and unit-tested without pulling the
// GitHub client.
// ============================================================================

// File extensions we consider worth quoting. Excludes bundles, generated
// artefacts, binaries, translation resources, configs, and docs — where a
// quoted snippet would be boring, meaningless, or risky.
const ALLOWED_EXTENSIONS = new Set<string>([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs',
  'svelte', 'vue', 'astro',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift',
  'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'php',
  'lua', 'sh', 'bash', 'zsh', 'sql',
  'css', 'scss',
  'html',
]);

// Path-fragment blocklist — skip generated, vendored, translation-heavy,
// and framework build dirs regardless of extension.
const BLOCKED_PATH = /(^|\/)(locales?|i18n|translations?|l10n|__snapshots__|fixtures?|vendor|node_modules|dist|build|generated|\.next|\.svelte-kit|\.nuxt|\.turbo)(\/|$)/i;

// Minified / source-map / snapshot files — technically in allowed exts but
// not human-written.
const BLOCKED_NAME = /\.(min\.(js|css)|map|snap)$/i;

// Secret-adjacent files — refuse entirely so we don't risk quoting them
// even when the snippet itself isn't a detected pattern.
const SECRETY_PATH = /(^|\/)(\.env.*|secrets?\..*|.*\.pem|.*\.p12|.*\.key)$/i;

export function extensionOf(path: string): string | null {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1]! : null;
}

export function isReviewableFile(path: string): boolean {
  if (BLOCKED_PATH.test(path)) return false;
  if (BLOCKED_NAME.test(path)) return false;
  if (SECRETY_PATH.test(path)) return false;
  const ext = extensionOf(path);
  if (!ext) return false;
  return ALLOWED_EXTENSIONS.has(ext);
}

// Rough language tag for the LLM prompt. Not a complete mapping — just
// enough for the model to riff on idioms specific to the language.
const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  mjs: 'javascript', cjs: 'javascript',
  svelte: 'svelte', vue: 'vue', astro: 'astro',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust',
  java: 'java', kt: 'kotlin', swift: 'swift',
  c: 'c', cc: 'c++', cpp: 'c++', h: 'c', hpp: 'c++',
  cs: 'c#', php: 'php',
  lua: 'lua', sh: 'bash', bash: 'bash', zsh: 'bash', sql: 'sql',
  css: 'css', scss: 'scss', html: 'html',
};

export function detectLanguage(path: string): string | null {
  const ext = extensionOf(path);
  return ext ? LANGUAGE_BY_EXT[ext] ?? null : null;
}

// Crude secret-shape detector. Applied to the final quoted snippet before
// it leaves this package. False positives just skip a snippet; false
// negatives on a known token shape are the only real risk.
const SECRET_PATTERNS: readonly RegExp[] = [
  /sk-[a-z0-9]{20,}/i,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{40,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /AKIA[0-9A-Z]{16}/,
  /AIza[0-9A-Za-z_-]{30,}/,
  /xox[baprs]-[a-z0-9-]{20,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/,
];

export function containsSecrets(text: string): boolean {
  for (const re of SECRET_PATTERNS) {
    if (re.test(text)) return true;
  }
  return false;
}

// A contiguous run of `+` lines from a unified-diff hunk, paired with the
// 1-based line number in the NEW file of the first line in the run.
export interface AddedRun {
  filename: string;
  lines: string[];
  startLine: number;
}

// Parses a unified-diff `patch` string (as returned by GitHub's REST commit
// endpoint) and returns every run of added lines tagged with its new-file
// starting line number. Deletions end a run (context switch). We roast
// additions, not removals.
export function parseAddedRuns(filename: string, patch: string): AddedRun[] {
  const out: AddedRun[] = [];
  let newLineNum = 0;
  let run: { lines: string[]; startLine: number } | null = null;
  const flush = () => {
    if (run && run.lines.length > 0) {
      out.push({ filename, lines: run.lines, startLine: run.startLine });
    }
    run = null;
  };
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      flush();
      // "@@ -a,b +c,d @@" — c is the starting new-file line.
      const m = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLineNum = m ? parseInt(m[1]!, 10) : 0;
      continue;
    }
    if (raw.startsWith('+++') || raw.startsWith('---')) continue;
    if (raw.startsWith('+')) {
      const text = raw.slice(1);
      if (!run) run = { lines: [], startLine: newLineNum };
      run.lines.push(text);
      newLineNum++;
      continue;
    }
    if (raw.startsWith('-')) {
      flush();
      continue;
    }
    if (raw.startsWith('\\')) continue; // "\ No newline at end of file"
    // context or blank
    flush();
    if (raw.length === 0 || raw.startsWith(' ')) newLineNum++;
  }
  flush();
  return out;
}

export interface SnippetLimits {
  minLines: number;
  maxLines: number;
  maxChars: number;
}

const DEFAULT_LIMITS: SnippetLimits = { minLines: 2, maxLines: 8, maxChars: 400 };

// Picks one reviewable run from the parsed set. Trims leading/trailing
// blank lines, caps length, rejects runs that leak secrets or collapse to
// whitespace-only. Returns null when no candidate survives the filters.
export function pickReviewableRun(
  runs: readonly AddedRun[],
  rng: () => number = Math.random,
  limits: SnippetLimits = DEFAULT_LIMITS,
): AddedRun | null {
  const candidates: AddedRun[] = [];
  for (const r of runs) {
    const trimmed = trimRun(r, limits);
    if (!trimmed) continue;
    if (containsSecrets(trimmed.lines.join('\n'))) continue;
    candidates.push(trimmed);
  }
  if (candidates.length === 0) return null;
  const i = Math.floor(rng() * candidates.length);
  return candidates[i] ?? null;
}

function trimRun(r: AddedRun, limits: SnippetLimits): AddedRun | null {
  let start = 0;
  let end = r.lines.length;
  while (start < end && r.lines[start]!.trim() === '') start++;
  while (end > start && r.lines[end - 1]!.trim() === '') end--;
  const core = r.lines.slice(start, end);
  if (core.length < limits.minLines) return null;
  let capped = core.slice(0, limits.maxLines);
  let budget = limits.maxChars;
  const clipped: string[] = [];
  for (const l of capped) {
    if (l.length + 1 > budget) {
      if (budget > 8) clipped.push(`${l.slice(0, budget - 1)}…`);
      break;
    }
    clipped.push(l);
    budget -= l.length + 1;
  }
  capped = clipped;
  if (capped.length < limits.minLines) return null;
  return { filename: r.filename, lines: capped, startLine: r.startLine + start };
}
