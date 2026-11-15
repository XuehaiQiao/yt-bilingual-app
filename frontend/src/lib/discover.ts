// Content discovery client (specs/017-discover).
//
// The backend owns the pipeline (intent rewrite → YouTube search → caption
// probing → rerank); this module only mirrors its frozen HTTP contract:
// `POST /api/discover` with `{ query, targetLang, force }`.
//
// Honesty rules from the spec are reflected here:
//   - candidates are never synthesized on the client; a malformed entry is
//     dropped, not filled with invented metadata;
//   - `hasEnglishSubs` is `true` or `null` (unknown) — never "no subtitles";
//   - `level` is an estimate and is shown exactly as the backend sent it.
import { apiFetch } from './api';
import type { LanguageCode } from '../i18n';

export type DiscoverLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';

export interface DiscoverCandidate {
    videoId: string;
    title: string;
    channel: string;
    /** Duration in seconds, from the flat YouTube metadata. */
    duration: number;
    thumbnail: string;
    /** Null when the backend sent an unknown/invalid level (never invented). */
    level: DiscoverLevel | null;
    /** One-sentence Chinese rationale, returned verbatim by the backend. */
    reason: string;
    /** true = an English track was detected; null = probe failed / unknown. */
    hasEnglishSubs: boolean | null;
    alreadyProcessed: boolean;
}

export interface DiscoverResult {
    /** English search queries the backend actually used. */
    queries: string[];
    candidates: DiscoverCandidate[];
    /** Full response served from the 24h cache. */
    cached: boolean;
    /** At least one AI step fell back to rules. */
    degraded: boolean;
    /** Backend disclaimer text (Chinese, per the frozen contract). */
    disclaimer: string;
}

export interface DiscoverApiErrorOptions {
    status: number;
    detail?: string | null;
    retryAfterSeconds?: number | null;
}

/**
 * A failed discovery request. `status` is the HTTP status, `0` for a network
 * failure and `-1` for a 2xx response whose shape is unusable. The UI maps the
 * status to localized copy; `detail` stays for diagnostics.
 */
export class DiscoverApiError extends Error {
    readonly status: number;
    readonly detail: string | null;
    readonly retryAfterSeconds: number | null;

    constructor(message: string, options: DiscoverApiErrorOptions) {
        super(message);
        this.name = 'DiscoverApiError';
        this.status = options.status;
        this.detail = options.detail ?? null;
        this.retryAfterSeconds = options.retryAfterSeconds ?? null;
    }
}

const LEVELS: readonly DiscoverLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

function asLevel(value: unknown): DiscoverLevel | null {
    return typeof value === 'string' && (LEVELS as readonly string[]).includes(value)
        ? (value as DiscoverLevel)
        : null;
}

function asNonNegativeNumber(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

function parseCandidate(value: unknown): DiscoverCandidate | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    if (typeof candidate.videoId !== 'string' || candidate.videoId.trim() === '') return null;
    return {
        videoId: candidate.videoId,
        title: typeof candidate.title === 'string' ? candidate.title : '',
        channel: typeof candidate.channel === 'string' ? candidate.channel : '',
        duration: asNonNegativeNumber(candidate.duration),
        thumbnail: typeof candidate.thumbnail === 'string' ? candidate.thumbnail : '',
        level: asLevel(candidate.level),
        reason: typeof candidate.reason === 'string' ? candidate.reason : '',
        // The API only promises `true` or `null`; anything else is treated as
        // "unknown" instead of claiming the video has no English captions.
        hasEnglishSubs: candidate.hasEnglishSubs === true ? true : null,
        alreadyProcessed: candidate.alreadyProcessed === true,
    };
}

function parseResult(value: unknown): DiscoverResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new DiscoverApiError('discover response is not an object', { status: -1 });
    }
    const body = value as Record<string, unknown>;
    if (!Array.isArray(body.candidates)) {
        throw new DiscoverApiError('discover response has no candidates array', { status: -1 });
    }
    return {
        queries: Array.isArray(body.queries)
            ? body.queries.filter((query): query is string => typeof query === 'string' && query.trim() !== '')
            : [],
        candidates: body.candidates
            .map(parseCandidate)
            .filter((candidate): candidate is DiscoverCandidate => candidate !== null),
        cached: body.cached === true,
        degraded: body.degraded === true,
        disclaimer: typeof body.disclaimer === 'string' ? body.disclaimer : '',
    };
}

/**
 * Find 3–5 YouTube candidates for a natural-language topic.
 *
 * `targetLang` is the learning/translation target (same value `apiFetch`
 * injects elsewhere), not the UI language. `force` bypasses the backend's 24h
 * response cache ("换一批").
 */
export async function discoverContent(
    query: string,
    targetLang: LanguageCode,
    force = false,
): Promise<DiscoverResult> {
    let response: Response;
    try {
        response = await apiFetch('/api/discover', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query: query.trim(), targetLang, force: Boolean(force) }),
        });
    } catch {
        throw new DiscoverApiError('discover request failed', { status: 0 });
    }

    if (!response.ok) {
        let detail: string | null = null;
        try {
            const body = (await response.json()) as { detail?: unknown };
            if (typeof body?.detail === 'string') detail = body.detail;
        } catch {
            // Non-JSON error body: status-based copy still works.
        }
        const retryAfterHeader = response.headers.get('Retry-After');
        const retryAfterSeconds = retryAfterHeader && Number.isFinite(Number(retryAfterHeader))
            ? Number(retryAfterHeader)
            : null;
        throw new DiscoverApiError(`discover failed with HTTP ${response.status}`, {
            status: response.status,
            detail,
            retryAfterSeconds,
        });
    }

    let body: unknown;
    try {
        body = await response.json();
    } catch {
        throw new DiscoverApiError('discover response is not JSON', { status: -1 });
    }
    return parseResult(body);
}

/** `1322` → `22:02`; `4821` → `1:20:21`; invalid/zero → `''`. */
export function formatDiscoverDuration(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds <= 0) return '';
    const total = Math.floor(seconds);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const remainder = total % 60;
    const pad = (value: number) => value.toString().padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(remainder)}` : `${minutes}:${pad(remainder)}`;
}
