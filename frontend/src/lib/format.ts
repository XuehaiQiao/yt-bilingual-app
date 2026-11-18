/**
 * Shared count formatting (components.md §18, N-10).
 *
 * Badges used to format counts in three different ways (`99+`, raw number,
 * `formatDueBadge`). Single source from here on.
 */

/**
 * `99+` once the count exceeds `max`; `0` stays `0` (the caller decides
 * whether to hide a zero badge). Invalid/negative inputs fall back to `0`.
 */
export function formatCount(count: number, max = 99): string {
  if (!Number.isFinite(count)) return '0';
  const normalized = Math.max(0, Math.floor(count));
  return normalized > max ? `${max}+` : String(normalized);
}

/** Legacy name used by `lib/navTabs.ts` and the three navigation shells. */
export { formatCount as formatDueBadge };
