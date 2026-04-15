// Small relative-time formatter used by the dashboard and the repo picker.
// Intentionally simple — we don't need Intl.RelativeTimeFormat plural rules
// here, the cards are scanned, not read word-by-word.
export function relativeTime(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const then = typeof iso === 'string' ? new Date(iso).getTime() : iso.getTime();
  const dt = Date.now() - then;
  if (dt < 0 || Number.isNaN(dt)) return '';
  const m = Math.floor(dt / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}
