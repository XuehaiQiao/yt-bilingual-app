// Word-book vocabulary lists (specs/005 / backend routes_vocabulary.py).
//
// Public read-only endpoints, no login required:
//   GET /api/vocabulary/lists                     → catalog (+ C2 available:false)
//   GET /api/vocabulary/lists/{id}?page&pageSize&q → paged/searchable entries
//   GET /api/vocabulary/level?words=a,b,c          → word → A1–C1 / C1+ / null
//
// This module only transports and normalizes what the backend returns. It must
// not invent levels: a word the API does not know is rendered as "C1+" by the
// screen (the backend's own contract for words outside the 10k frequency list).
import { apiFetch } from './api';

export interface VocabularyList {
    id: string;
    label: string;
    count: number;
    source: string | null;
    license: string | null;
    notice: string | null;
    /** True when the level boundaries are frequency-band estimates. */
    approximate: boolean;
    /** False for C2: there is no modelled list, so it must not be fetched. */
    available: boolean;
    version: string;
    note: string | null;
}

export interface VocabularyEntry {
    word: string;
    phonetic: string;
    translation: string;
    cefrLevel: string;
}

export interface VocabularyPage {
    items: VocabularyEntry[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

export const VOCABULARY_PAGE_SIZE = 50;
/** The `/level` endpoint accepts at most 100 words per request. */
export const VOCABULARY_LEVEL_BATCH_SIZE = 100;

async function errorDetail(response: Response): Promise<string> {
    const body = await response.json().catch(() => null);
    if (body && typeof body.detail === 'string') return body.detail;
    return `HTTP ${response.status}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** Catalog in the backend's product order (A1…C1, C2, GRE, CET4, CET6). */
export async function fetchVocabularyLists(): Promise<VocabularyList[]> {
    const response = await apiFetch('/api/vocabulary/lists');
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.filter(isRecord).map((entry) => ({
        id: String(entry.id ?? ''),
        label: String(entry.label ?? ''),
        count: Number.isFinite(entry.count) ? Number(entry.count) : 0,
        source: typeof entry.source === 'string' ? entry.source : null,
        license: typeof entry.license === 'string' ? entry.license : null,
        notice: typeof entry.notice === 'string' ? entry.notice : null,
        approximate: entry.approximate === true,
        // Fail closed: a malformed catalog entry must not be fetched as if it
        // were a real list (C2 is the important case).
        available: entry.available !== false,
        version: typeof entry.version === 'string' ? entry.version : '',
        note: typeof entry.note === 'string' ? entry.note : null,
    })).filter((entry) => entry.id.length > 0);
}

/** One page (default 50) of a list; `q` is server-side, case-insensitive. */
export async function fetchVocabularyPage(
    listId: string,
    options: {
        page?: number;
        pageSize?: number;
        q?: string;
        signal?: AbortSignal;
    } = {},
): Promise<VocabularyPage> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? VOCABULARY_PAGE_SIZE)));
    const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
    });
    const query = (options.q ?? '').trim();
    if (query) params.set('q', query);

    const response = await apiFetch(
        `/api/vocabulary/lists/${encodeURIComponent(listId)}?${params.toString()}`,
        options.signal ? { signal: options.signal } : undefined,
    );
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json().catch(() => null);
    const record = isRecord(data) ? data : {};
    const items = Array.isArray(record.items)
        ? record.items.filter(isRecord).map((item) => ({
            word: String(item.word ?? ''),
            phonetic: String(item.phonetic ?? ''),
            translation: String(item.translation ?? ''),
            cefrLevel: String(item.cefrLevel ?? ''),
        }))
        : [];
    return {
        items,
        total: Number.isFinite(record.total) ? Number(record.total) : items.length,
        page: Number.isFinite(record.page) ? Number(record.page) : page,
        pageSize: Number.isFinite(record.pageSize) ? Number(record.pageSize) : pageSize,
        hasMore: record.hasMore === true,
    };
}

/**
 * Batched word → CEFR level lookup. The response keys preserve the caller's
 * exact spelling; a `null` value means the token is not a valid English word,
 * which the word-book screen renders like an off-list word (C1+).
 */
export async function fetchVocabularyLevels(
    words: readonly string[],
    options: { signal?: AbortSignal } = {},
): Promise<Record<string, string | null>> {
    const unique = Array.from(new Set(
        words.map((word) => String(word ?? '').trim()).filter(Boolean),
    ));
    const levels: Record<string, string | null> = {};
    for (let index = 0; index < unique.length; index += VOCABULARY_LEVEL_BATCH_SIZE) {
        const batch = unique.slice(index, index + VOCABULARY_LEVEL_BATCH_SIZE);
        const params = new URLSearchParams({ words: batch.join(',') });
        const response = await apiFetch(`/api/vocabulary/level?${params.toString()}`, options.signal ? { signal: options.signal } : undefined);
        if (!response.ok) throw new Error(await errorDetail(response));
        const data = await response.json().catch(() => null);
        if (!isRecord(data)) continue;
        for (const word of batch) {
            const value = data[word];
            levels[word] = typeof value === 'string' && value.trim() ? value.trim() : null;
        }
    }
    return levels;
}
