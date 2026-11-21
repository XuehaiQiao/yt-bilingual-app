// Where a favorite came from ("出处"), shared by the word-book screen.
//
// New favorites carry `source_kind` / `source_ref` / `source_title` (see
// lib/favorites). Records created before those fields existed only have
// `videoId`, so the kind is inferred from its shape; the title is then unknown
// and the row is not linkable (never pretend we know where it came from).
import type { FavoriteItem, FavoriteSourceKind } from './favorites';

export interface ResolvedFavoriteSource {
    kind: FavoriteSourceKind;
    ref: string;
    /** Null when unknown: a link without a title is still not offered. */
    title: string | null;
}

const SOURCE_KINDS: readonly FavoriteSourceKind[] = [
    'video',
    'local_show',
    'article',
    'library_article',
    'sentence_pack',
    'book',
    'imported_book',
    'wordlist',
];
const SENTENCE_PACK_PREFIX = 'sentence-pack-';

export function resolveFavoriteSource(fav: FavoriteItem): ResolvedFavoriteSource {
    const title = typeof fav.source_title === 'string' && fav.source_title.trim()
        ? fav.source_title.trim()
        : null;
    const storedRef = typeof fav.source_ref === 'string' ? fav.source_ref.trim() : '';
    const storedKind = fav.source_kind && SOURCE_KINDS.includes(fav.source_kind)
        ? fav.source_kind
        : null;
    if (storedKind) {
        const fallbackRef = storedKind === 'sentence_pack'
            ? fav.videoId.replace(SENTENCE_PACK_PREFIX, '')
            : fav.videoId;
        return { kind: storedKind, ref: storedRef || fallbackRef, title };
    }
    // Legacy records: infer the kind from videoId only.
    if (fav.videoId.startsWith(SENTENCE_PACK_PREFIX)) {
        return { kind: 'sentence_pack', ref: fav.videoId.slice(SENTENCE_PACK_PREFIX.length), title: null };
    }
    if (fav.videoId.length === 11) return { kind: 'video', ref: fav.videoId, title: null };
    if (fav.videoId) return { kind: 'article', ref: fav.videoId, title: null };
    return { kind: 'video', ref: '', title: null };
}

/** Existing `zh_text` is `"/ipa/ 释义"`; without IPA it is just the meaning. */
export function splitIpaAndMeaning(zhText: string | undefined): { ipa: string | null; meaning: string } {
    const text = (zhText || '').trim();
    const match = text.match(/^\/([^/]{1,120})\/\s*(.*)$/);
    if (!match) return { ipa: null, meaning: text };
    return { ipa: `/${match[1].trim()}/`, meaning: match[2].trim() };
}

/** `source_ref` for sentence-pack favorites is `L<levelId>`. */
export function sentencePackLevel(ref: string): number | null {
    const match = /^L(\d+)$/i.exec(ref.trim());
    if (!match) return null;
    const level = Number(match[1]);
    return Number.isInteger(level) && level > 0 ? level : null;
}
