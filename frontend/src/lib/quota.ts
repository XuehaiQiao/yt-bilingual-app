// User quota API (v1.1 P0, specs/047 + P2-39): GET /api/quota.
//
// The endpoint is read-only and answers with the signed-in user's daily AI
// allowance per feature. The backend contract is owned by P2-39; until it is
// merged this module parses defensively so a slightly different payload shape
// still renders a truthful panel instead of a blank or a fake number:
//
//   { day?: string, resetAt?: number,
//     features?: [{ feature, limit, used, remaining, resetAt?, source? }] }
//
// `items` / `quotas` and an object map are also accepted because all three
// spellings show up in the existing billing/admin code. `0` means the feature
// is switched off (quota_config semantics — there is no "unlimited"), and the
// UI says "已关闭" instead of drawing an empty progress bar.
import { apiFetch } from './api';
import { describeApiError } from './toast';
import {
  formatDate,
  translate,
  type LanguageCode,
  type TranslationKey,
} from '../i18n';

/** The eight features that carry a user daily quota (`backend/quota_config.py`). */
export type QuotaFeatureId =
  | 'translate'
  | 'summary'
  | 'define'
  | 'local_show'
  | 'quiz'
  | 'reading'
  | 'analysis'
  | 'course_generation';

export interface QuotaFeatureUsage {
  /** Stable backend feature id (`translate`, `define`, …). */
  feature: string;
  /** `null` when the backend did not send a limit. */
  limit: number | null;
  used: number;
  remaining: number | null;
  /** Per-feature reset instant (ms); usually the same for every feature. */
  resetAt: number | null;
  /** `default` / `override` / `env` when the backend explains the source. */
  source: string | null;
}

export interface QuotaSnapshot {
  /** Backend day key (`YYYY-MM-DD`), kept for display/debug only. */
  day: string | null;
  /** When the daily counters reset (ms). */
  resetAt: number | null;
  features: QuotaFeatureUsage[];
}

export class QuotaApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'QuotaApiError';
    this.status = status;
  }
}

export const QUOTA_FEATURE_ORDER: readonly QuotaFeatureId[] = [
  'translate',
  'reading',
  'analysis',
  'define',
  'quiz',
  'summary',
  'local_show',
  'course_generation',
];

const FEATURE_LABEL_KEYS: Record<QuotaFeatureId, TranslationKey> = {
  translate: 'quota.feature.translate',
  reading: 'quota.feature.reading',
  analysis: 'quota.feature.analysis',
  define: 'quota.feature.define',
  quiz: 'quota.feature.quiz',
  summary: 'quota.feature.summary',
  local_show: 'quota.feature.localShow',
  course_generation: 'quota.feature.courseGeneration',
};

/** Localized label for a known feature; unknown ids fall through unchanged. */
export function quotaFeatureLabel(feature: string, language?: LanguageCode): string {
  const key = FEATURE_LABEL_KEYS[feature as QuotaFeatureId];
  if (!key) return feature;
  return language ? translate(language, key) : feature;
}

function toNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return null;
}

function toTimestamp(value: unknown): number | null {
  const numeric = toNumber(value);
  if (numeric !== null) {
    // Backend may send seconds or milliseconds; anything below 10^12 is seconds.
    if (numeric > 0 && numeric < 1_000_000_000_000) return numeric * 1000;
    return numeric > 0 ? numeric : null;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function firstDefined(record: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

/** Accept `limit`, `limitPerDay`, `limit_units`, `quota`, `units` spellings. */
function parseFeature(raw: unknown, fallbackResetAt: number | null): QuotaFeatureUsage | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const feature = typeof record.feature === 'string'
    ? record.feature
    : typeof record.key === 'string'
      ? record.key
      : typeof record.name === 'string'
        ? record.name
        : '';
  if (!feature) return null;

  const limit = toNumber(firstDefined(record, ['limit', 'limitPerDay', 'limit_units', 'quota']));
  const used = toNumber(firstDefined(record, ['used', 'usedToday', 'used_units', 'usedUnits'])) ?? 0;
  const explicitRemaining = toNumber(
    firstDefined(record, ['remaining', 'remainingToday', 'remaining_units']),
  );
  const remaining = explicitRemaining !== null
    ? explicitRemaining
    : limit !== null
      ? Math.max(0, limit - used)
      : null;
  const resetAt = toTimestamp(firstDefined(record, ['resetAt', 'reset_at', 'resetsAt']))
    ?? fallbackResetAt;
  const source = typeof record.source === 'string' ? record.source : null;

  return { feature, limit, used, remaining, resetAt, source };
}

/**
 * Parse any of the accepted payload shapes. Pure and exported so the
 * acceptance script can prove the tolerant path without a live backend.
 */
export function parseQuotaPayload(payload: unknown): QuotaSnapshot {
  const root = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
  const rootResetAt = toTimestamp(firstDefined(root, ['resetAt', 'reset_at', 'resetsAt']));

  let rawFeatures: unknown[] = [];
  const list = firstDefined(root, ['features', 'items', 'quotas']);
  if (Array.isArray(list)) {
    rawFeatures = list;
  } else if (list && typeof list === 'object') {
    rawFeatures = Object.entries(list as Record<string, unknown>).map(([feature, value]) => (
      value && typeof value === 'object'
        ? { feature, ...(value as Record<string, unknown>) }
        : { feature, limit: value }
    ));
  }

  const features = rawFeatures
    .map((item) => parseFeature(item, rootResetAt))
    .filter((item): item is QuotaFeatureUsage => item !== null);

  // Known features first (stable product order), unknown extras appended in
  // backend order so a new feature never disappears from the panel.
  const rank = (feature: string): number => {
    const index = QUOTA_FEATURE_ORDER.indexOf(feature as QuotaFeatureId);
    return index === -1 ? QUOTA_FEATURE_ORDER.length : index;
  };
  const seen = new Set<string>();
  const ordered = features
    .map((item, index) => ({ item, index }))
    .sort((a, b) => rank(a.item.feature) - rank(b.item.feature) || a.index - b.index)
    .map(({ item }) => item)
    .filter((item) => {
      if (seen.has(item.feature)) return false;
      seen.add(item.feature);
      return true;
    });

  const day = typeof root.day === 'string' && root.day.trim() ? root.day.trim() : null;
  return { day, resetAt: rootResetAt, features: ordered };
}

/** Next local midnight — the honest fallback when the backend sends no resetAt. */
export function nextLocalMidnight(now: number = Date.now()): number {
  const date = new Date(now);
  date.setHours(24, 0, 0, 0);
  return date.getTime();
}

/** The reset instant the panel should display. */
export function quotaResetAt(snapshot: QuotaSnapshot | null): number | null {
  if (!snapshot) return null;
  if (snapshot.resetAt) return snapshot.resetAt;
  const featureReset = snapshot.features.find((item) => item.resetAt)?.resetAt;
  return featureReset ?? null;
}

/** Localized reset copy, e.g. 「重置时间：11月26日 00:00」. */
export function formatQuotaReset(resetAt: number | null, language: LanguageCode): string {
  if (!resetAt) return translate(language, 'quota.resetUnknown');
  const formatted = formatDate(
    resetAt,
    { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' },
    language,
  );
  return translate(language, 'quota.resetAt', { time: formatted });
}

/**
 * GET /api/quota. A non-2xx answer becomes a typed error so the panel can show
 * an inline error + retry; it never throws a raw parse failure.
 */
export async function fetchQuota(): Promise<QuotaSnapshot> {
  const res = await apiFetch('/api/quota');
  if (!res.ok) {
    throw new QuotaApiError(await describeApiError(res), res.status);
  }
  const payload = await res.json().catch(() => null);
  if (!payload || typeof payload !== 'object') {
    throw new QuotaApiError(await describeApiError(new Error('invalid quota payload')), 200);
  }
  return parseQuotaPayload(payload);
}
