// Word-book vocabulary lists (specs/005 / backend routes_vocabulary.py).
//
// Public read-only endpoints, no login required:
//   GET /api/vocabulary/lists                     → catalog (+ C2 available:false)
//   GET /api/vocabulary/lists/{id}?page&pageSize&q&level → paged/searchable entries
//   GET /api/vocabulary/phrases?page&pageSize&q&level&type → paged phrases
//   GET /api/vocabulary/phrases/{id}               → one phrase (+ notes/license)
//   GET /api/vocabulary/level?words=a,b,c          → word → A1–C1 / C1+ / null
//
// The UI's word-book shows one merged `cefr` list (A1–C1, filterable by level);
// the backend also keeps the legacy per-level ids (`cefr-a1`…) for older
// clients. `byLevel` is the merged list's per-level counts — the only source the
// level-filter chips use, so the UI never hardcodes 1000/2000/3000.
//
// Phrases are a separate product surface: the catalog advertises them as an
// extra list (`id: "phrases"`), but their items have a different shape and the
// generic `/lists/{id}` endpoint deliberately 404s for them. Never route a
// phrase list through `fetchVocabularyPage`.
//
// This module only transports and normalizes what the backend returns. It must
// not invent levels: a word the API does not know is rendered as "C1+" by the
// screen (the backend's own contract for words outside the 10k frequency list).
import { apiFetch } from './api';

export interface VocabularyList {
    id: string;
    label: string;
    count: number;
    /** Merged `cefr` only: counts per level, e.g. `{A1: 1000, …, C1: 3000}`. */
    byLevel: Record<string, number>;
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

/** Frequency-band levels carried by the merged `cefr` list (C2 is not modelled). */
export type CefrLevel = 'A1' | 'A2' | 'B1' | 'B2' | 'C1';
export const VOCABULARY_CEFR_LEVELS: readonly CefrLevel[] = ['A1', 'A2', 'B1', 'B2', 'C1'];

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

/** Phrase type ids from `backend/vocabulary.py:PHRASE_TYPES`. */
export type PhraseType = 'phrasal_verb' | 'idiom' | 'collocation';
/** Approximate teaching bands shipped by the curated data (no C2; C1+ empty). */
export type PhraseLevel = 'A2' | 'B1' | 'B2' | 'C1' | 'C1+';

export interface PhraseEntry {
    id: string;
    headword: string;
    type: PhraseType | '';
    cefr: PhraseLevel | '';
    translation: string;
    example: string;
    source: string;
}

export interface PhraseDetail extends PhraseEntry {
    license: string | null;
    notes: string | null;
}

export interface PhrasePage {
    items: PhraseEntry[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

export const VOCABULARY_PAGE_SIZE = 50;
export const PHRASE_PAGE_SIZE = 50;
/** Level filter chips: the curated set has no C1+ rows, and C2 is not modelled. */
export const PHRASE_LEVELS: readonly PhraseLevel[] = ['A2', 'B1', 'B2', 'C1'];
export const PHRASE_TYPES: readonly PhraseType[] = ['phrasal_verb', 'idiom', 'collocation'];
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

/** Keep only finite numeric entries (the catalog may grow new metadata). */
function numberRecord(value: unknown): Record<string, number> {
    if (!isRecord(value)) return {};
    const entries: Record<string, number> = {};
    for (const [key, raw] of Object.entries(value)) {
        if (Number.isFinite(raw)) entries[key] = Number(raw);
    }
    return entries;
}

/** Catalog in the backend's product order (merged CEFR, C2, GRE, CET4, CET6). */
export async function fetchVocabularyLists(): Promise<VocabularyList[]> {
    const response = await apiFetch('/api/vocabulary/lists');
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json().catch(() => null);
    if (!Array.isArray(data)) return [];
    return data.filter(isRecord).map((entry) => ({
        id: String(entry.id ?? ''),
        label: String(entry.label ?? ''),
        count: Number.isFinite(entry.count) ? Number(entry.count) : 0,
        byLevel: numberRecord(entry.byLevel),
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
        /** Merged `cefr` list only: restrict to one frequency band. */
        level?: CefrLevel | '';
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
    if (options.level) params.set('level', options.level);

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

/** Normalize one phrase list item; malformed rows are dropped by the caller. */
function phraseEntry(value: Record<string, unknown>): PhraseEntry | null {
    const id = String(value.id ?? '').trim();
    const headword = String(value.headword ?? '').trim();
    if (!id || !headword) return null;
    const rawType = String(value.type ?? '').trim();
    const rawLevel = String(value.cefr ?? '').trim().toUpperCase();
    return {
        id,
        headword,
        type: (PHRASE_TYPES as readonly string[]).includes(rawType) ? rawType as PhraseType : '',
        cefr: (['A2', 'B1', 'B2', 'C1', 'C1+'] as readonly string[]).includes(rawLevel)
            ? rawLevel as PhraseLevel
            : '',
        translation: String(value.translation ?? ''),
        example: String(value.example ?? ''),
        source: String(value.source ?? ''),
    };
}

/**
 * One page of the curated phrase list. `q` matches headword first and then the
 * Chinese translation (server-side); `level`/`type` are exact filters. Sending
 * `C1+` is supported by the API but the UI does not offer it because the
 * shipped data has no C1+ rows.
 */
export async function fetchPhrasePage(
    options: {
        page?: number;
        pageSize?: number;
        q?: string;
        level?: PhraseLevel | '';
        type?: PhraseType | '';
        signal?: AbortSignal;
    } = {},
): Promise<PhrasePage> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(200, Math.max(1, Math.trunc(options.pageSize ?? PHRASE_PAGE_SIZE)));
    const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
    });
    const query = (options.q ?? '').trim();
    if (query) params.set('q', query);
    if (options.level) params.set('level', options.level);
    if (options.type) params.set('type', options.type);

    const response = await apiFetch(
        `/api/vocabulary/phrases?${params.toString()}`,
        options.signal ? { signal: options.signal } : undefined,
    );
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json().catch(() => null);
    const record = isRecord(data) ? data : {};
    const items = Array.isArray(record.items)
        ? record.items.filter(isRecord).map(phraseEntry).filter((item): item is PhraseEntry => item !== null)
        : [];
    return {
        items,
        total: Number.isFinite(record.total) ? Number(record.total) : items.length,
        page: Number.isFinite(record.page) ? Number(record.page) : page,
        pageSize: Number.isFinite(record.pageSize) ? Number(record.pageSize) : pageSize,
        hasMore: record.hasMore === true,
    };
}

/** Full phrase detail; the list omits `notes`/`license`, so expansion lazy-loads this. */
export async function fetchPhraseDetail(
    id: string,
    options: { signal?: AbortSignal } = {},
): Promise<PhraseDetail> {
    const response = await apiFetch(
        `/api/vocabulary/phrases/${encodeURIComponent(id)}`,
        options.signal ? { signal: options.signal } : undefined,
    );
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json().catch(() => null);
    if (!isRecord(data)) throw new Error('Invalid phrase detail');
    const entry = phraseEntry(data);
    if (!entry) throw new Error('Invalid phrase detail');
    return {
        ...entry,
        license: typeof data.license === 'string' ? data.license : null,
        notes: typeof data.notes === 'string' && data.notes.trim() ? data.notes : null,
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
