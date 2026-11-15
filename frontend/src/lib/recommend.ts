// Recommendation client (user request #10 / V1 rule recommendations, specs/018).
//
// The backend owns the rule scoring (band ±1, topic diversity, freshness,
// exclude already-watched, reason text). This module only mirrors the frozen
// response shape and keeps the honesty rules:
//   - a malformed item is dropped, never filled with invented metadata;
//   - `reason` / `basis` are displayed exactly as the backend sent them;
//   - `preliminary` is not hidden or upgraded to "accurate".
import { apiFetch } from './api';

export type RecommendationLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
export type RecommendationSource = 'profile' | 'default';

export interface RecommendationItem {
    videoId: string;
    title: string;
    channel: string;
    /** Duration in seconds (backend keeps the YouTube value). */
    duration: number;
    thumbnail: string;
    level: RecommendationLevel;
    topic: string;
    reason: string;
    url: string;
}

export interface RecommendationBasis {
    /** CEFR interval label, e.g. `A2–B1` (en dash). */
    band: string;
    source: RecommendationSource;
}

export interface RecommendationResult {
    items: RecommendationItem[];
    basis: RecommendationBasis;
    /** Sample-size caveat from the placement profile; never upgraded client-side. */
    preliminary: boolean;
}

const LEVELS: readonly RecommendationLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

function asLevel(value: unknown): RecommendationLevel | null {
    return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
        ? (value as RecommendationLevel)
        : null;
}

function asText(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function asDuration(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0
        ? Math.round(value)
        : 0;
}

/** `mm:ss` — recommendation cards show exact video length, not a rounded label. */
export function formatRecommendationDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.round(seconds);
    const minutes = Math.floor(total / 60);
    const rest = total % 60;
    return `${minutes}:${String(rest).padStart(2, '0')}`;
}

function normalizeItem(raw: unknown): RecommendationItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const record = raw as Record<string, unknown>;
    const videoId = asText(record.videoId);
    if (!/^[A-Za-z0-9_-]{11}$/.test(videoId)) return null;
    const level = asLevel(record.level);
    if (!level) return null;
    const url = asText(record.url);
    if (!/^https:\/\/www\.youtube\.com\/watch\?v=[A-Za-z0-9_-]{11}$/.test(url)) return null;
    return {
        videoId,
        title: asText(record.title),
        channel: asText(record.channel),
        duration: asDuration(record.duration),
        thumbnail: asText(record.thumbnail),
        level,
        topic: asText(record.topic),
        reason: asText(record.reason),
        url,
    };
}

function normalizeResult(raw: unknown): RecommendationResult {
    if (!raw || typeof raw !== 'object') throw new Error('invalid recommendations payload');
    const record = raw as Record<string, unknown>;
    if (!Array.isArray(record.items)) throw new Error('invalid recommendations payload');
    const items = record.items
        .map(normalizeItem)
        .filter((item): item is RecommendationItem => item !== null);

    const rawBasis = record.basis;
    if (!rawBasis || typeof rawBasis !== 'object') throw new Error('invalid recommendations basis');
    const basisRecord = rawBasis as Record<string, unknown>;
    const band = asText(basisRecord.band);
    const source = basisRecord.source;
    if (!band || (source !== 'profile' && source !== 'default')) {
        throw new Error('invalid recommendations basis');
    }
    return {
        items,
        basis: { band, source },
        preliminary: record.preliminary === true,
    };
}

export interface FetchRecommendationsOptions {
    limit?: number;
    /** Deterministic rotation for "换一批"; 0 = the first batch. */
    seed?: number;
    signal?: AbortSignal;
}

/** `GET /api/recommendations?limit=6&seed=N`（targetLang 由 apiFetch 注入）。 */
export async function fetchRecommendations(
    options: FetchRecommendationsOptions = {},
): Promise<RecommendationResult> {
    const limit = Math.min(12, Math.max(1, options.limit ?? 6));
    const seed = Math.max(0, Math.floor(options.seed ?? 0));
    const response = await apiFetch(
        `/api/recommendations?limit=${limit}&seed=${seed}`,
        { signal: options.signal },
    );
    if (!response.ok) {
        throw new Error(`recommendations request failed: ${response.status}`);
    }
    return normalizeResult(await response.json());
}
