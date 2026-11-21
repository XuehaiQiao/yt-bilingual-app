// Seen-count client for the word book (specs/005 §v1.1 / specs/013).
//
// `GET /api/vocabulary/seen?words=a,b,c` (需登录, ≤100 words per call) is the
// only source for "见过次数": it aggregates `dict_lookup` learning events on
// demand. The endpoint shipped alongside this screen but older deployments /
// guests may answer 403/404/5xx, so the caller must treat any failure as
// "statistics unavailable" and keep rendering the list — the word book
// degrades to "—" and never turns this optional column into a page-level
// error.
//
// Deliberately a separate module: `lib/vocabulary.ts` owns the catalog
// endpoints and is edited by another agent in this round.
import { apiFetch } from './api';

/** The backend accepts at most 100 words per `/seen` request. */
export const VOCAB_SEEN_BATCH_SIZE = 100;

/** Raised when the seen endpoint is missing, forbidden or otherwise unusable. */
export class SeenCountsUnavailable extends Error {
    readonly status: number | null;

    constructor(message: string, status: number | null = null) {
        super(message);
        this.name = 'SeenCountsUnavailable';
        this.status = status;
    }
}

/**
 * Fetch the seen count for each word. Returns a map keyed by the exact input
 * word. A successful response with a missing key is normalized to 0 (the
 * contract says the server returns 0 rather than omitting a word).
 */
export async function fetchSeenCounts(words: readonly string[]): Promise<Record<string, number>> {
    const unique = Array.from(new Set(words.map((word) => word.trim()).filter(Boolean)));
    const counts: Record<string, number> = {};
    for (let start = 0; start < unique.length; start += VOCAB_SEEN_BATCH_SIZE) {
        const batch = unique.slice(start, start + VOCAB_SEEN_BATCH_SIZE);
        const params = new URLSearchParams({ words: batch.join(',') });
        const response = await apiFetch(`/api/vocabulary/seen?${params.toString()}`);
        if (!response.ok) {
            throw new SeenCountsUnavailable(
                `HTTP ${response.status}`,
                response.status,
            );
        }
        const data = await response.json().catch(() => null);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new SeenCountsUnavailable('malformed /seen payload');
        }
        const record = data as Record<string, unknown>;
        for (const word of batch) {
            const raw = record[word] ?? record[word.toLowerCase()];
            counts[word] = typeof raw === 'number' && Number.isFinite(raw) ? raw : 0;
        }
    }
    return counts;
}
