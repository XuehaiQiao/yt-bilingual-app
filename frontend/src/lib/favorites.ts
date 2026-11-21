// Per-item favorites API (M1 ④). The backend still stores one JSON file per
// user, but writes are locked + atomic and addressed per item; the whole-file
// PUT is kept only for legacy clients (replaceAllFavorites) and must not be
// used by the app.
import { apiFetch } from './api';

export type FavoriteType = 'sentence' | 'vocabulary';

export interface FavoriteHighlight {
    en_word: string;
    zh_word: string;
    color: string;
}

/**
 * Where a favorite came from (`video` = YouTube). `wordlist` is the built-in
 * vocabulary / phrase lists in the word book (specs/005 §v1.2): `source_ref` is
 * the list id (`cefr` / `gre` / `cet4` / `cet6` / `phrases`) and `source_title`
 * the list label. It has no page to open, so the row's source line stays inert.
 */
export type FavoriteSourceKind =
    | 'video'
    | 'local_show'
    | 'article'
    | 'sentence_pack'
    | 'library_article'
    | 'book'
    | 'imported_book'
    | 'wordlist';

/**
 * Provenance of a favorite. Optional because records created before this
 * existed have no source_* fields; `lib/favoriteSource` falls back to the
 * videoId heuristic for those. The backend flattens `meta` into the stored record and
 * keeps unknown keys, so these arrive at the top level on GET.
 */
export interface FavoriteSourceFields {
    source_kind?: FavoriteSourceKind;
    /** videoId / showId / articleId / `L<levelId>`. */
    source_ref?: string;
    /** Video / show / article / sentence-pack title. */
    source_title?: string;
}

export interface FavoriteItem extends FavoriteSourceFields {
    id: string;
    videoId: string;
    start: number;
    en_text: string;
    zh_text: string;
    added_at?: number;
    highlights?: FavoriteHighlight[];
    type?: FavoriteType;
    context_en?: string;
    context_zh?: string;
}

/** What a call site knows before the server normalizes/assigns fields. */
export interface FavoriteDraft extends FavoriteSourceFields {
    id: string;
    type: FavoriteType;
    videoId: string;
    start: number;
    en_text: string;
    zh_text: string;
    added_at: number;
    highlights?: FavoriteHighlight[];
    context_en?: string;
    context_zh?: string;
}

async function errorDetail(response: Response): Promise<string> {
    const body = await response.json().catch(() => null);
    if (body && typeof body.detail === 'string') return body.detail;
    return `HTTP ${response.status}`;
}

export async function fetchFavorites(): Promise<FavoriteItem[]> {
    const response = await apiFetch('/api/favorites');
    if (!response.ok) throw new Error(await errorDetail(response));
    const data = await response.json();
    return Array.isArray(data) ? data : [];
}

/**
 * Add one favorite. The backend is idempotent by id/content fingerprint and
 * returns the stored entry (server-normalized), which may carry a different id
 * when the same content already exists.
 */
export async function addFavorite(draft: FavoriteDraft): Promise<FavoriteItem> {
    const payload = {
        id: draft.id,
        type: draft.type,
        text: draft.en_text,
        translation: draft.zh_text,
        videoId: draft.videoId,
        time: draft.start,
        addedAt: draft.added_at,
        meta: {
            ...(draft.context_en ? { context_en: draft.context_en } : {}),
            ...(draft.context_zh ? { context_zh: draft.context_zh } : {}),
            ...(draft.highlights?.length ? { highlights: draft.highlights } : {}),
            ...(draft.source_kind ? { source_kind: draft.source_kind } : {}),
            ...(draft.source_ref ? { source_ref: draft.source_ref } : {}),
            ...(draft.source_title ? { source_title: draft.source_title } : {}),
        },
    };
    const response = await apiFetch('/api/favorites', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
    });
    if (!response.ok) throw new Error(await errorDetail(response));
    const body = await response.json();
    return (body?.favorite ?? body) as FavoriteItem;
}

/**
 * Delete one favorite. 404 means the row is already gone (another tab won the
 * race), which counts as success for an optimistic delete.
 */
export async function removeFavorite(id: string): Promise<void> {
    const response = await apiFetch(`/api/favorites/${encodeURIComponent(id)}`, {
        method: 'DELETE',
    });
    if (response.ok || response.status === 404) return;
    throw new Error(await errorDetail(response));
}

/**
 * Legacy whole-file PUT. Kept as one compatibility path for old clients and
 * rollbacks; App.tsx intentionally does not call it anymore.
 */
export async function replaceAllFavorites(favorites: FavoriteItem[]): Promise<number> {
    const response = await apiFetch('/api/favorites', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ favorites }),
    });
    if (!response.ok) throw new Error(await errorDetail(response));
    const body = await response.json();
    return typeof body?.count === 'number' ? body.count : favorites.length;
}
