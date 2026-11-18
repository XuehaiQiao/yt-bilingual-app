/**
 * Shared time formatting (components.md §18, C-08).
 *
 * All call sites used to carry byte-identical `mm:ss` helpers; they will be
 * migrated here one screen at a time. New code must import these instead of
 * copying them again.
 */

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * `mm:ss`, or `h:mm:ss` once the duration reaches one hour.
 * `NaN`, `Infinity` and negative inputs render as `00:00`.
 */
export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours > 0
    ? `${hours}:${pad2(minutes)}:${pad2(secs)}`
    : `${pad2(minutes)}:${pad2(secs)}`;
}

/**
 * Countdown display: same rules as `formatClock`, but milliseconds are
 * rounded **up** so a timer shows `00:01` until it actually reaches zero.
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '00:00';
  return formatClock(Math.ceil(ms / 1000));
}
