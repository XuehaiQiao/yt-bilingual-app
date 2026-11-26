// Single source of the "ignored" word set the reading highlight layer excludes
// (specs/004-vocab-level v1.1 「已掌握不标」).
//
// Two modes, one store:
//   - signed-in (`authenticated`): the authoritative list is
//     `GET /api/review/words?mastered=1&limit=200` — the `word_states.mastered`
//     column. A failed or degraded load is silent and leaves the set empty: the
//     filter fails open, so a request failure can never remove highlights, block
//     reading, or invent an error surface.
//   - guest: the local ignore table in `lib/wordMastery.ts` (the guest bucket of
//     `lib/storageScope.ts`, the same table the word book's 「我会了」 group
//     reads). It is never uploaded, and signed-in users never read it. The brief
//     suggested a fresh `yt_bilingual_ignored_words` key; reusing the existing
//     table keeps one source for one semantic (team charter §4.5) instead of
//     splitting the guest ignore state across two keys.
//
// The highlight *rules* are not duplicated here. This module only answers
// *which* words are already known: classify requests, the proper-noun list and
// the CEFR threshold stay in `useReadingHighlights` + `backend/word_rules.py`.
// Matching is exact after casefold normalization (`normalizeIgnoredWord`); the
// reading layer never lemmatises on the frontend.
import { useEffect, useSyncExternalStore } from 'react';
import { useAuth } from './auth';
import { getMasteredWords } from './review';
import {
    guestMasteredKey,
    normalizeMasteryWord,
    readGuestMastered,
    writeGuestMastered,
} from './wordMastery';
import { subscribeStorageScope } from './storageScope';

/** `guest` reads localStorage; `signedIn` reads the server mastered list. */
export type IgnoredWordsMode = 'guest' | 'signedIn';

export interface IgnoredWordsSnapshot {
    /** Casefolded (trimmed + lower-cased) ignored word forms. */
    words: ReadonlySet<string>;
    mode: IgnoredWordsMode;
    /**
     * True once the current mode's set has been resolved. For signed-in users
     * `false` means "not fetched yet" — never "nothing is ignored". Guests are
     * always `true` because their table is read synchronously.
     */
    loaded: boolean;
}

/** Same normalization as `wordMastery` / the word book: trim + casefold. */
export const normalizeIgnoredWord = normalizeMasteryWord;

const EMPTY_WORDS: ReadonlySet<string> = new Set<string>();

let snapshot: IgnoredWordsSnapshot | null = null;
/** Auth mode last applied by the hook, so mode switching stays idempotent. */
let signedInApplied = false;
let requestSeq = 0;
let inFlight: { id: number; promise: Promise<void> } | null = null;
const listeners = new Set<() => void>();

/** Fresh snapshot from the guest local table (never touches the network). */
function guestSnapshot(): IgnoredWordsSnapshot {
    return { words: readGuestMastered(), mode: 'guest', loaded: true };
}

/**
 * Lazy first read: the store is created on first use (render), not at import,
 * so vendors/SSR-ish environments never touch localStorage eagerly. Caching the
 * object keeps `useSyncExternalStore`'s snapshot reference stable.
 */
function getSnapshot(): IgnoredWordsSnapshot {
    if (!snapshot) snapshot = guestSnapshot();
    return snapshot;
}

function emit(next: IgnoredWordsSnapshot): void {
    snapshot = next;
    for (const listener of listeners) listener();
}

/** Subscribe to store changes; exported for `useSyncExternalStore` only. */
export function subscribeIgnoredWords(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

/** Current normalized set for non-React callers (React: `useIgnoredWords`). */
export function getIgnoredWords(): ReadonlySet<string> {
    return getSnapshot().words;
}

/** Current snapshot for non-React callers (e.g. a mount effect). */
export function getIgnoredSnapshot(): IgnoredWordsSnapshot {
    return getSnapshot();
}

/** True when this word (any case) is in the current ignored set. */
export function isIgnoredWord(word: string): boolean {
    const normalized = normalizeIgnoredWord(word);
    return normalized.length > 0 && getSnapshot().words.has(normalized);
}

/**
 * Persist one word to the guest table (no-op for signed-in users: the server
 * PATCH already happened and this module must not mirror it locally).
 */
function persistGuestWord(word: string, ignored: boolean): void {
    if (getSnapshot().mode !== 'guest') return;
    try {
        writeGuestMastered(word, ignored);
    } catch {
        // Private mode / quota: the in-memory set still updates for this
        // session, the same degradation `wordMastery` already accepts.
    }
}

/** Mark one word ignored so the current page recomputes immediately. */
export function addIgnored(word: string): void {
    const normalized = normalizeIgnoredWord(word);
    if (!normalized) return;
    const current = getSnapshot();
    if (current.words.has(normalized)) return;
    persistGuestWord(normalized, true);
    const words = new Set(current.words);
    words.add(normalized);
    emit({ ...current, words });
}

/** Undo an ignore; the word becomes markable again on the next render. */
export function removeIgnored(word: string): void {
    const normalized = normalizeIgnoredWord(word);
    if (!normalized) return;
    const current = getSnapshot();
    if (!current.words.has(normalized)) return;
    persistGuestWord(normalized, false);
    const words = new Set(current.words);
    words.delete(normalized);
    emit({ ...current, words });
}

/** Read the guest table again after another tab changed it. */
function syncGuestWords(): void {
    if (signedInApplied) return; // signed-in users never read the guest table
    emit(guestSnapshot());
}

/** Fetch the server mastered list once (deduped while in flight). */
function fetchSignedInWords(targetLang?: string): Promise<void> {
    if (inFlight) return inFlight.promise;
    const id = ++requestSeq;
    const promise = getMasteredWords(200, targetLang)
        .then((data) => {
            if (id !== requestSeq) return;
            const words = new Set<string>();
            for (const item of data.words ?? []) {
                const normalized = normalizeIgnoredWord(item?.lemma ?? '');
                if (normalized) words.add(normalized);
            }
            emit({ words, mode: 'signedIn', loaded: true });
        })
        .catch(() => {
            if (id !== requestSeq) return;
            // Silent degradation (specs/004 v1.1): fail open with an empty set.
            // `loaded: true` stops every mounted consumer from re-requesting.
            emit({ words: EMPTY_WORDS, mode: 'signedIn', loaded: true });
        });
    inFlight = { id, promise };
    void promise.finally(() => {
        if (inFlight?.id === id) inFlight = null;
    });
    return promise;
}

/**
 * Re-read the current mode's list. Exported so newly opened content can pick up
 * marks made elsewhere in the app (e.g. the word book's guest toggle or a
 * signed-in word-book PATCH) without a full page reload. Guests re-read
 * localStorage synchronously (cheap, no network); signed-in readers share one
 * in-flight request.
 */
export function refreshIgnored(targetLang?: string): Promise<void> {
    if (!signedInApplied) {
        const next = guestSnapshot();
        if (!sameWords(getSnapshot().words, next.words)) emit(next);
        return Promise.resolve();
    }
    return fetchSignedInWords(targetLang);
}

/** Content equality for two normalized sets (avoids a pointless re-render). */
function sameWords(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
    if (a.size !== b.size) return false;
    for (const word of a) {
        if (!b.has(word)) return false;
    }
    return true;
}

/**
 * Switch to the mode implied by the auth status and load it when needed.
 * Safe to call from every mounted consumer: repeated calls are idempotent.
 */
function applyAuthMode(signedIn: boolean): void {
    if (signedIn === signedInApplied && snapshot) {
        // Same mode: only fill an unresolved signed-in read (first mount after
        // the fetch failed never re-fires, so failures cannot become a loop).
        if (signedIn && !snapshot.loaded) void fetchSignedInWords();
        return;
    }
    signedInApplied = signedIn;
    if (!signedIn) {
        // Cancel pending server results: drop the id so their handlers no-op.
        requestSeq += 1;
        inFlight = null;
        emit(guestSnapshot());
        return;
    }
    // Signed-in starts from "no filter" until the server answers; highlights
    // are never blocked by this in-flight read.
    emit({ words: EMPTY_WORDS, mode: 'signedIn', loaded: false });
    void fetchSignedInWords();
}

/**
 * P2-50: an identity switch (A → B on the same tab) changes the storage
 * namespace. Drop the singleton so the next `applyAuthMode` re-reads the guest
 * table / refetches the account's mastered list instead of keeping A's words.
 */
function resetForScopeChange(): void {
    signedInApplied = false;
    snapshot = null;
    requestSeq += 1;
    inFlight = null;
}

subscribeStorageScope(resetForScopeChange);

/**
 * React binding: returns the ignored set and keeps the store in sync with the
 * session. Every consumer re-renders when the set changes (useSyncExternalStore),
 * which is what makes a newly mastered word disappear from the current page
 * without a classify re-request.
 */
export function useIgnoredWords(): IgnoredWordsSnapshot {
    const current = useSyncExternalStore(subscribeIgnoredWords, getSnapshot, getSnapshot);
    const { status } = useAuth();

    useEffect(() => {
        applyAuthMode(status === 'authenticated');
    }, [status]);

    useEffect(() => {
        const onStorage = (event: StorageEvent) => {
            // Cross-tab guest edits only; signed-in users never read that table.
            if (event.key === guestMasteredKey()) syncGuestWords();
        };
        window.addEventListener('storage', onStorage);
        return () => window.removeEventListener('storage', onStorage);
    }, []);

    return current;
}
