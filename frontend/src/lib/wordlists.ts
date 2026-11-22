// Custom word lists — client transport for specs/038-custom-wordlists §5.
//
// Every endpoint needs a signed-in account (guests get 403). The word book
// treats 403/404 as "this surface is unavailable" (no tabs, no error banner),
// exactly like the review state filter does, so a partially deployed backend
// never breaks the built-in lists. Only a real failure (5xx/network) becomes an
// error state, and it is always retryable.
import { apiFetch } from './api';

export interface CustomWordlist {
    id: string;
    name: string;
    itemCount: number;
    createdAt: number;
}

export interface CustomWordlistItem {
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

/** `POST /api/wordlists/import` payload: ≤5000 validated entries. */
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
    return {
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
