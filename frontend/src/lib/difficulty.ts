// Content difficulty client (CEFR M2, specs/026).
//
// The backend computes a rule-based `difficulty.v1` vector offline; this module
// only reads the public batch endpoint and passes the numbers through. Honesty
// rules:
//   - a malformed / missing item is dropped, never invented;
//   - `bucket` is the server's estimate bucket ("生词约 X%"), not a user-level
//     claim; the UI never calls it personalized or an exact percentage;
//   - when the server has no difficulty row (`source === "legacy"`), the badge
//     falls back to the editorial level and no novelty bucket is shown.
import { apiFetch } from './api';

export type DifficultyKind = 'video' | 'article' | 'curated' | 'local_show';

const KINDS: readonly DifficultyKind[] = ['video', 'article', 'curated', 'local_show'];
const CEFR_INPUTS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C1+'] as const;
export type DifficultyBand = (typeof CEFR_INPUTS)[number];

export interface DifficultyRef {
    kind: DifficultyKind;
    ref: string;
}

export interface DifficultyItem {
    kind: DifficultyKind;
    ref: string;
    level: string | null;
    cefrInput: DifficultyBand | null;
    lexicalBand: DifficultyBand | null;
    syntaxBand: DifficultyBand | null;
    /** Estimate bucket, e.g. `3–5%` (server side, by the caller's band). */
    bucket: string | null;
    utrBand: number | null;
    estimated: boolean;
    source: 'computed' | 'legacy';
    confidence: number | null;
}

export class DifficultyApiError extends Error {
    readonly status: number;

    constructor(message: string, status: number) {
        super(message);
        this.name = 'DifficultyApiError';
        this.status = status;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asKind(value: unknown): DifficultyKind | null {
    return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
        ? (value as DifficultyKind)
        : null;
}

function asBand(value: unknown): DifficultyBand | null {
    return typeof value === 'string' && (CEFR_INPUTS as readonly string[]).includes(value)
        ? (value as DifficultyBand)
        : null;
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeItem(raw: unknown): DifficultyItem | null {
    if (!isRecord(raw)) return null;
    const kind = asKind(raw.kind);
    const ref = asText(raw.ref);
    if (!kind || !ref) return null;
    return {
        kind,
        ref,
        level: asText(raw.level) || null,
        cefrInput: asBand(raw.cefrInput),
        lexicalBand: asBand(raw.lexicalBand),
        syntaxBand: asBand(raw.syntaxBand),
        bucket: asText(raw.bucket) || null,
        utrBand: asNumber(raw.utrBand),
        estimated: raw.estimated === true,
        source: raw.source === 'computed' ? 'computed' : 'legacy',
        confidence: asNumber(raw.confidence),
    };
}

export function difficultyKey(kind: DifficultyKind, ref: string): string {
    return `${kind}:${ref}`;
}

/**
 * Fetch difficulty summaries for up to 50 items.
 *
 * `band` is the user's vocabulary band upper bound (A1–C1, optional). When the
 * app has no profile the caller omits it and the server returns no `utrBand`;
 * cards then show the badge but no novelty bucket.
 */
export async function fetchDifficultyBatch(
    items: DifficultyRef[],
    band: string | null = null,
): Promise<Record<string, DifficultyItem>> {
    const unique: DifficultyRef[] = [];
    const seen = new Set<string>();
    for (const item of items) {
        if (!item || !asKind(item.kind) || !asText(item.ref)) continue;
        const key = difficultyKey(item.kind, item.ref);
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push({ kind: item.kind, ref: item.ref });
        if (unique.length >= 50) break;
    }
    if (unique.length === 0) return {};

    const params = new URLSearchParams();
    params.set('items', unique.map((item) => `${item.kind}:${item.ref}`).join(','));
    if (band && /^[A-C][12]$/.test(band)) params.set('band', band);
    const response = await apiFetch(`/api/content/difficulty/batch?${params.toString()}`);
    if (!response.ok) {
        throw new DifficultyApiError('内容难度不可用', response.status);
    }
    const data = (await response.json()) as unknown;
    if (!isRecord(data) || !Array.isArray(data.items)) {
        throw new DifficultyApiError('内容难度数据格式不正确', 0);
    }
    const result: Record<string, DifficultyItem> = {};
    for (const raw of data.items) {
        const item = normalizeItem(raw);
        if (item) result[difficultyKey(item.kind, item.ref)] = item;
    }
    return result;
}

/** The badge band: computed difficulty first, then the editorial level. */
export function difficultyBadge(item: DifficultyItem | null | undefined, editorialLevel: string | null = null): string | null {
    if (!item) return editorialLevel;
    return item.cefrInput ?? editorialLevel ?? item.level ?? null;
}

/** Novelty bucket only for computed rows; legacy rows must stay blank. */
export function difficultyBucket(item: DifficultyItem | null | undefined): string | null {
    if (!item || item.source !== 'computed') return null;
    return item.bucket;
}
