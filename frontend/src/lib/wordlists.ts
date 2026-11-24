// Word-list client transport: custom lists (specs/038-custom-wordlists §5) and
// the read-only CEFR 10k lemma list (specs/040, last section).
//
// Every endpoint needs a signed-in account (guests get 403). The word book
// treats 403/404 as "this surface is unavailable" (no tabs, no error banner),
// exactly like the review state filter does, so a partially deployed backend
// never breaks the built-in lists. Only a real failure (5xx/network) becomes an
// error state, and it is always retryable.
import { apiFetch } from './api';
import {
    VOCABULARY_CEFR_LEVELS,
    type CefrLevel,
} from './vocabulary';

export interface CustomWordlist {
    id: string;
    name: string;
    itemCount: number;
    createdAt: number;
}

export interface CustomWordlistItem {
    /** Server item id (needed by 勾选删除); older builds may omit it. */
    id: string | null;
    word: string;
    translation: string | null;
    phonetic: string | null;
    cefr: string | null;
    example: string | null;
}

export interface CustomWordlistPage {
    id: string;
    name: string;
    items: CustomWordlistItem[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

/** `POST /api/wordlists/import` payload: ≤10000 validated entries. */
export interface ImportWordlistInput {
    name: string;
    filename: string;
    items: Array<{
        word: string;
        translation?: string | null;
        phonetic?: string | null;
        cefr?: string | null;
        example?: string | null;
    }>;
}

export interface ImportWordlistResult {
    list: CustomWordlist;
    skipped: number;
}

/**
 * Typed HTTP failure so callers can distinguish "needs an account / not
 * deployed" (403/404) from a transient failure without parsing strings.
 */
export class WordlistsApiError extends Error {
    readonly status: number;
    readonly code: string | null;

    constructor(status: number, message: string, code: string | null = null) {
        super(message);
        this.name = 'WordlistsApiError';
        this.status = status;
        this.code = code;
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function errorMessage(body: unknown, status: number): { message: string; code: string | null } {
    if (isRecord(body)) {
        const detail = typeof body.detail === 'string' ? body.detail.trim() : '';
        const code = typeof body.code === 'string' ? body.code : null;
        if (detail) return { message: detail, code };
        if (code) return { message: code, code };
    }
    return { message: `HTTP ${status}`, code: null };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const { message, code } = errorMessage(body, response.status);
        throw new WordlistsApiError(response.status, message, code);
    }
    return (await response.json()) as T;
}

function normalizeList(value: unknown): CustomWordlist | null {
    if (!isRecord(value)) return null;
    const id = typeof value.id === 'string' ? value.id.trim() : '';
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    if (!id || !name) return null;
    return {
        id,
        name,
        itemCount: Number.isFinite(value.itemCount) ? Math.max(0, Number(value.itemCount)) : 0,
        createdAt: Number.isFinite(value.createdAt) ? Number(value.createdAt) : 0,
    };
}

function normalizeItem(value: unknown): CustomWordlistItem | null {
    if (!isRecord(value)) return null;
    const word = typeof value.word === 'string' ? value.word.trim() : '';
    if (!word) return null;
    const optional = (key: string): string | null => {
        const raw = value[key];
        return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
    };
    const id = typeof value.id === 'string' && value.id.trim() ? value.id.trim() : null;
    return {
        id,
        word,
        translation: optional('translation'),
        phonetic: optional('phonetic'),
        cefr: optional('cefr'),
        example: optional('example'),
    };
}

/** `GET /api/wordlists` — the account's lists, in creation order. */
export async function fetchCustomWordlists(): Promise<CustomWordlist[]> {
    const data = await request<unknown>('/api/wordlists');
    const lists = isRecord(data) && Array.isArray(data.lists) ? data.lists : [];
    return lists
        .map(normalizeList)
        .filter((list): list is CustomWordlist => list !== null);
}

/** `GET /api/wordlists/{id}?page&pageSize&q` — server paging + search. */
export async function fetchCustomWordlistPage(
    id: string,
    input: { page?: number; pageSize?: number; q?: string; signal?: AbortSignal } = {},
): Promise<CustomWordlistPage> {
    const params = new URLSearchParams({
        page: String(Math.max(1, Math.trunc(input.page ?? 1))),
        pageSize: String(Math.min(200, Math.max(1, Math.trunc(input.pageSize ?? 50)))),
    });
    if (input.q?.trim()) params.set('q', input.q.trim());
    const data = await request<unknown>(
        `/api/wordlists/${encodeURIComponent(id)}?${params.toString()}`,
        input.signal ? { signal: input.signal } : undefined,
    );
    if (!isRecord(data)) throw new WordlistsApiError(500, 'invalid wordlist payload');
    const items = Array.isArray(data.items) ? data.items : [];
    const normalized = items
        .map(normalizeItem)
        .filter((item): item is CustomWordlistItem => item !== null);
    const total = Number.isFinite(data.total) ? Math.max(0, Number(data.total)) : normalized.length;
    return {
        id: typeof data.id === 'string' ? data.id : id,
        name: typeof data.name === 'string' ? data.name : '',
        items: normalized,
        total,
        page: Number.isFinite(data.page) ? Math.max(1, Number(data.page)) : Math.max(1, Math.trunc(input.page ?? 1)),
        pageSize: Number.isFinite(data.pageSize) ? Number(data.pageSize) : Math.max(1, Math.trunc(input.pageSize ?? 50)),
        // The server is authoritative; the fallback keeps paging usable on an
        // older build that omits the flag.
        hasMore: typeof data.hasMore === 'boolean'
            ? data.hasMore
            : (Number.isFinite(data.page) ? Number(data.page) : 1) * (Number.isFinite(data.pageSize) ? Number(data.pageSize) : 50) < total,
    };
}

/**
 * Load every item of one list (client-side paging / sorting / filtering,
 * specs/005 §统一词表 UI). The server caps each page at 200 and a list at
 * 10000 words, so the loop is bounded; an aborted signal stops between pages.
 */
export async function fetchAllCustomWordlistItems(
    id: string,
    signal?: AbortSignal,
): Promise<{ items: CustomWordlistItem[]; total: number }> {
    const items: CustomWordlistItem[] = [];
    let total = 0;
    for (let page = 1; page <= 50; page += 1) {
        const data = await fetchCustomWordlistPage(id, { page, pageSize: 200, signal });
        total = data.total;
        items.push(...data.items);
        if (!data.hasMore || data.items.length === 0) break;
        if (signal?.aborted) break;
    }
    return { items, total };
}

/** `PATCH /api/wordlists/{id}` — rename one list (≤80 chars, unique). */
export async function renameCustomWordlist(id: string, name: string): Promise<CustomWordlist> {
    const data = await request<unknown>(`/api/wordlists/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
    });
    const list = isRecord(data) ? normalizeList(data.list) : null;
    if (!list) throw new WordlistsApiError(500, 'invalid wordlist payload');
    return list;
}

/**
 * `DELETE /api/wordlists/{id}/items` — delete selected rows of one list
 * (1–500 ids). The list and every favorite/review snapshot stay untouched.
 */
export async function deleteCustomWordlistItems(
    id: string,
    itemIds: readonly string[],
): Promise<{ deleted: number; itemCount: number }> {
    const data = await request<unknown>(`/api/wordlists/${encodeURIComponent(id)}/items`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemIds: [...itemIds] }),
    });
    const record = isRecord(data) ? data : {};
    return {
        deleted: Number.isFinite(record.deleted) ? Number(record.deleted) : itemIds.length,
        itemCount: Number.isFinite(record.itemCount) ? Number(record.itemCount) : 0,
    };
}

/** `POST /api/wordlists/import` — 201 with the created list + skipped count. */
export async function importCustomWordlist(input: ImportWordlistInput): Promise<ImportWordlistResult> {
    const payload = {
        ...(input.name.trim() ? { name: input.name.trim() } : {}),
        ...(input.filename.trim() ? { filename: input.filename.trim() } : {}),
        items: input.items.map((item) => ({
            word: item.word,
            ...(item.translation ? { translation: item.translation } : {}),
            ...(item.phonetic ? { phonetic: item.phonetic } : {}),
            ...(item.cefr ? { cefr: item.cefr } : {}),
            ...(item.example ? { example: item.example } : {}),
        })),
    };
    const data = await request<unknown>('/api/wordlists/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!isRecord(data)) throw new WordlistsApiError(500, 'invalid import payload');
    const list = normalizeList(data.list);
    if (!list) throw new WordlistsApiError(500, 'invalid import payload');
    return {
        list,
        skipped: Number.isFinite(data.skipped) ? Math.max(0, Number(data.skipped)) : 0,
    };
}

// ── Anki `.apkg` parse（specs/046-apkg-import §2）─────────────────────────
//
// The browser never unzips or reads the SQLite collection: the package is
// uploaded as multipart `file` and the backend answers decks / models / notes.
// The wizard then turns the chosen deck+model into two or three local columns
// and reuses the normal validation + `/api/wordlists/import` path.
//
// Status codes the dialog distinguishes: 400 (not an APKG / no notes),
// 403 (guest or expired session), 413 (>50 MB), 503 (parser unavailable).
export interface ApkgWordlistDeck {
    id: string;
    name: string;
    /** Notes in this deck, before the model filter (server count). */
    noteCount: number;
}

export interface ApkgWordlistModel {
    id: string;
    name: string;
    /** Field names in template order; the wizard maps word/translation onto them. */
    fields: string[];
}

export interface ApkgWordlistNote {
    deckId: string;
    modelId: string;
    /** One cell per model field; already HTML-cleaned by the backend. */
    fields: string[];
}

export interface ApkgWordlistResult {
    fileName: string;
    decks: ApkgWordlistDeck[];
    models: ApkgWordlistModel[];
    notes: ApkgWordlistNote[];
    total: number;
    /** True when the server capped the parse (10000 notes, specs/046 §1). */
    truncated: boolean;
}

function normalizeId(value: unknown): string {
    if (typeof value === 'string') return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
    return '';
}

function normalizeApkgDeck(value: unknown): ApkgWordlistDeck | null {
    if (!isRecord(value)) return null;
    const id = normalizeId(value.id);
    if (!id) return null;
    return {
        id,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
        noteCount: Number.isFinite(value.noteCount) ? Math.max(0, Number(value.noteCount)) : 0,
    };
}

function normalizeApkgModel(value: unknown): ApkgWordlistModel | null {
    if (!isRecord(value)) return null;
    const id = normalizeId(value.id);
    if (!id) return null;
    const fields = Array.isArray(value.fields)
        ? value.fields.map((field) => (typeof field === 'string' ? field : '')).filter((field) => field.trim() !== '')
        : [];
    return {
        id,
        name: typeof value.name === 'string' && value.name.trim() ? value.name.trim() : id,
        fields,
    };
}

function normalizeApkgNote(value: unknown): ApkgWordlistNote | null {
    if (!isRecord(value)) return null;
    const deckId = normalizeId(value.deckId);
    const modelId = normalizeId(value.modelId);
    if (!deckId || !modelId) return null;
    const fields = Array.isArray(value.fields)
        ? value.fields.map((field) => (typeof field === 'string' ? field : ''))
        : [];
    return { deckId, modelId, fields };
}

/**
 * `POST /api/wordlists/apkg-parse` — upload one `.apkg` (multipart `file`) and
 * return its decks/models/notes. The dialog checks the 50 MB limit first.
 */
export async function parseApkgWordlist(file: File): Promise<ApkgWordlistResult> {
    const form = new FormData();
    form.append('file', file, file.name);
    const data = await request<unknown>('/api/wordlists/apkg-parse', {
        method: 'POST',
        body: form,
    });
    if (!isRecord(data)) throw new WordlistsApiError(500, 'invalid apkg payload');
    const decks = (Array.isArray(data.decks) ? data.decks : [])
        .map(normalizeApkgDeck)
        .filter((deck): deck is ApkgWordlistDeck => deck !== null);
    const models = (Array.isArray(data.models) ? data.models : [])
        .map(normalizeApkgModel)
        .filter((model): model is ApkgWordlistModel => model !== null);
    const notes = (Array.isArray(data.notes) ? data.notes : [])
        .map(normalizeApkgNote)
        .filter((note): note is ApkgWordlistNote => note !== null);
    const total = Number.isFinite(data.total) ? Math.max(0, Number(data.total)) : notes.length;
    return {
        fileName: typeof data.fileName === 'string' && data.fileName.trim()
            ? data.fileName.trim()
            : file.name,
        decks,
        models,
        notes,
        total: Math.max(total, notes.length),
        truncated: data.truncated === true,
    };
}

/**
 * `DELETE /api/wordlists/{id}` — deletes the table and its rows only; favorites
 * and review states keep their snapshots (specs/038 §1). A 404 means the table
 * is already gone (another tab won the race) and counts as success.
 */
export async function deleteCustomWordlist(id: string): Promise<void> {
    const response = await apiFetch(`/api/wordlists/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (response.ok || response.status === 404) return;
    const body = await response.json().catch(() => null);
    const { message, code } = errorMessage(body, response.status);
    throw new WordlistsApiError(response.status, message, code);
}

/**
 * `POST /api/wordlists/{id}/backfill-cefr` — fill the rows whose CEFR is empty
 * from the 10k frequency table (A1–C1 only; existing values are never
 * overwritten; C1+/unknown stay empty). Idempotent: a second call updates 0.
 * 403/404 mean "this list is not yours (or an older backend)"; 503 means the
 * frequency table is unavailable.
 */
export interface BackfillCefrResult {
    /** Rows updated by this call. */
    updated: number;
    /** Every item in the list. */
    total: number;
    /** Items still without a CEFR after this call (C1+ / unknown). */
    remaining: number;
}

export async function backfillCustomWordlistCefr(id: string): Promise<BackfillCefrResult> {
    const data = await request<unknown>(
        `/api/wordlists/${encodeURIComponent(id)}/backfill-cefr`,
        { method: 'POST' },
    );
    const record = isRecord(data) ? data : {};
    const count = (key: string): number => (
        Number.isFinite(record[key]) ? Math.max(0, Number(record[key])) : 0
    );
    return { updated: count('updated'), total: count('total'), remaining: count('remaining') };
}

// ── CEFR 10k lemma 词形表（specs/040-cefr-lemma-list）──────────────────────
//
// `GET /api/vocabulary/lemma-list?q=&level=&sort=&page=&pageSize=` is a public
// read-only endpoint (guests included, no AI, no writes): the 10,000 lemmas of
// `content/wordlist/frequency_bands.v1.json`, their form→lemma mappings and the
// lexicon's phonetic/translation. Only transport + normalization lives here; a
// missing level/meaning stays empty and is never fabricated.
//
// The 词形 tab is deliberately read-only (no favorite/mastered/edit/batch/
// export), so this section exposes one fetcher and no write calls.
/** Server page size for the 词形 tab (`lemma_list.DEFAULT_PAGE_SIZE`). */
export const LEMMA_PAGE_SIZE = 50;
export const LEMMA_MAX_PAGE_SIZE = 200;
/** Frequency order (default) or alphabetical; matches `lemma_list.SORTS`. */
export type LemmaSort = 'rank' | 'alpha';
export const LEMMA_LEVELS: readonly CefrLevel[] = VOCABULARY_CEFR_LEVELS;

export interface LemmaListItem {
    lemma: string;
    rank: number;
    /** Empty when the server omits it (never fabricated as C1). */
    level: CefrLevel | '';
    phonetic: string;
    translation: string;
    /** Forms mapping to this lemma, alphabetical (`[]` when none). */
    forms: string[];
}

export interface LemmaListPage {
    items: LemmaListItem[];
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
}

/** Typed HTTP failure so the panel can show the server's message + retry. */
export class LemmaListApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'LemmaListApiError';
        this.status = status;
    }
}

function normalizeLemmaItem(value: unknown): LemmaListItem | null {
    if (!isRecord(value)) return null;
    const lemma = typeof value.lemma === 'string' ? value.lemma.trim() : '';
    if (!lemma) return null;
    const level = typeof value.level === 'string'
        && (LEMMA_LEVELS as readonly string[]).includes(value.level)
        ? value.level as CefrLevel
        : '';
    return {
        lemma,
        rank: Number.isFinite(value.rank) ? Number(value.rank) : 0,
        level,
        phonetic: typeof value.phonetic === 'string' ? value.phonetic : '',
        translation: typeof value.translation === 'string' ? value.translation : '',
        forms: Array.isArray(value.forms)
            ? value.forms.filter((form): form is string => typeof form === 'string')
            : [],
    };
}

/** `GET /api/vocabulary/lemma-list` — server paging/search/level/sort. */
export async function fetchLemmaListPage(
    options: {
        page?: number;
        pageSize?: number;
        q?: string;
        level?: CefrLevel | '';
        sort?: LemmaSort;
        signal?: AbortSignal;
    } = {},
): Promise<LemmaListPage> {
    const page = Math.max(1, Math.trunc(options.page ?? 1));
    const pageSize = Math.min(
        LEMMA_MAX_PAGE_SIZE,
        Math.max(1, Math.trunc(options.pageSize ?? LEMMA_PAGE_SIZE)),
    );
    const params = new URLSearchParams({
        page: String(page),
        pageSize: String(pageSize),
        sort: options.sort ?? 'rank',
    });
    const query = (options.q ?? '').trim();
    if (query) params.set('q', query);
    if (options.level) params.set('level', options.level);

    const response = await apiFetch(
        `/api/vocabulary/lemma-list?${params.toString()}`,
        options.signal ? { signal: options.signal } : undefined,
    );
    if (!response.ok) {
        const body = await response.json().catch(() => null);
        const { message } = errorMessage(body, response.status);
        throw new LemmaListApiError(response.status, message);
    }
    const data = await response.json().catch(() => null);
    const record = isRecord(data) ? data : {};
    const items = Array.isArray(record.items)
        ? record.items
            .map(normalizeLemmaItem)
            .filter((item): item is LemmaListItem => item !== null)
        : [];
    const total = Number.isFinite(record.total) ? Number(record.total) : items.length;
    return {
        items,
        total,
        page: Number.isFinite(record.page) ? Number(record.page) : page,
        pageSize: Number.isFinite(record.pageSize) ? Number(record.pageSize) : pageSize,
        hasMore: typeof record.hasMore === 'boolean'
            ? record.hasMore
            : page * pageSize < total,
    };
}
