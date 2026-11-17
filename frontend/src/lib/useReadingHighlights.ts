// Reading difficulty highlight (user request 2026-11-17 #3).
//
// The slider in 我的 · 设置 is a *highlighting* preference: words above the
// selected band are marked in articles and books so the learner can spot the
// words that deserve attention. It is not an ability rating and it never
// decides what content is recommended.
//
// Contract:
//   - the selected `VocabLevelId` maps to a CEFR threshold (A1…C2);
//   - every word's level comes from GET /api/vocabulary/level (batched ≤100 by
//     lib/vocabulary.ts). A word whose rank is above the threshold is marked;
//   - `null` from the API means "not a valid English word" (numbers, names,
//     typos) — it is not guessed into C1+; a returned `C1+` is treated as the
//     rank between C1 and C2;
//   - C2 is the highest stop, so at C2 nothing is marked;
//   - an unavailable API fails silently into "no highlight" — reading is never
//     blocked and a level is never invented;
//   - results are cached per lowercase word so switching chapters does not
//     re-request the same words.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchVocabularyLevels } from './vocabulary';
import {
    loadVocabLevel,
    VOCAB_LEVEL_EVENT,
    VOCAB_LEVEL_KEY,
    VOCAB_LEVELS,
    type VocabLevelId,
} from './settings';

/** localStorage key for the per-reader "标亮生词" switch (default on). */
export const READING_HIGHLIGHT_KEY = 'yt_bilingual_reading_highlight';

export function loadReadingHighlightEnabled(): boolean {
    return localStorage.getItem(READING_HIGHLIGHT_KEY) !== '0';
}

export function saveReadingHighlightEnabled(enabled: boolean) {
    localStorage.setItem(READING_HIGHLIGHT_KEY, enabled ? '1' : '0');
}

/**
 * Strip leading/trailing punctuation exactly like `ClickableWords` does, so a
 * rendered token and a lookup key always agree. Exported for that component.
 */
export function cleanReadingWord(token: string): string {
    return token.replace(/^[^A-Za-z0-9']+|[^A-Za-z0-9']+$/g, '');
}

function collectReadingWords(corpus: string): string[] {
    const words = new Set<string>();
    for (const raw of corpus.split(/\s+/)) {
        const token = cleanReadingWord(raw);
        // Lookup is case-insensitive and only meaningful for words with a
        // letter; punctuation-only or numeric tokens are skipped.
        if (token.length < 2 || !/[A-Za-z]/.test(token)) continue;
        words.add(token.toLowerCase());
    }
    return Array.from(words);
}

/** Word ranks: A1 < A2 < B1 < B2 < C1 < C1+ < C2. */
const WORD_LEVEL_RANK: Record<string, number> = {
    A1: 0,
    A2: 1,
    B1: 2,
    B2: 3,
    C1: 4,
    'C1+': 5,
    C2: 6,
};

/**
 * Slider thresholds. C2 intentionally uses the same rank as the `C2` word band
 * (the top): the backend never returns C2, so choosing C2 marks nothing extra.
 */
const VOCAB_LEVEL_RANK: Record<VocabLevelId, number> = {
    liftoff: 0,
    orbit: 1,
    moonwalk: 2,
    interstellar: 3,
    'deep-space': 4,
    supernova: 6,
};

function wordRank(level: string | null): number | null {
    if (!level) return null;
    const normalized = level.trim().toUpperCase();
    return WORD_LEVEL_RANK[normalized] ?? null;
}

/** Process-wide cache: word → A1…C1 / C1+ / null. Shared across readers. */
const wordLevelCache = new Map<string, string | null>();

export interface ReadingHighlights {
    /** Switch state (persisted; default on). */
    enabled: boolean;
    setEnabled: (next: boolean) => void;
    /** Current slider stop (also drives the toggle's threshold hint). */
    level: VocabLevelId;
    /** Display label of the current stop, e.g. `B1`. */
    levelLabel: string;
    /** Word → API level (`A1`…`C2` / `C1+` / null) for the current text. */
    wordLevels: ReadonlyMap<string, string | null>;
    /** True when this rendered word is above the current threshold. */
    isHighlighted: (word: string) => boolean;
}

/**
 * Resolve highlight state for the English text of a reader. The hook is safe
 * to call while an article/chapter is still loading (`texts` empty).
 */
export function useReadingHighlights(texts: readonly string[]): ReadingHighlights {
    const [level, setLevel] = useState<VocabLevelId>(loadVocabLevel);
    const [enabled, setEnabledState] = useState<boolean>(loadReadingHighlightEnabled);
    // Bumped after a lookup finishes; the word map itself is derived from the
    // shared cache below (no setState-in-effect cascade for cached words).
    const [, bumpCacheVersion] = useState(0);
    // The corpus that failed lookup, so a failure paints no marks but a new
    // text (or turning the switch back on) retries instead of staying broken.
    const [failedCorpus, setFailedCorpus] = useState<string | null>(null);

    // Join first: callers usually build the array inline, but the join result
    // is a stable value and keeps the word-list memo from thrashing.
    const corpus = texts.join('\n');
    const words = useMemo(() => collectReadingWords(corpus), [corpus]);
    const failed = failedCorpus === corpus;

    // The 我的 slider (or another tab) changes the threshold without remounting
    // the reader; re-read it and let the highlight callback recompute.
    useEffect(() => {
        const sync = () => setLevel(loadVocabLevel());
        const onStorage = (event: StorageEvent) => {
            if (event.key === VOCAB_LEVEL_KEY) sync();
        };
        window.addEventListener(VOCAB_LEVEL_EVENT, sync);
        window.addEventListener('storage', onStorage);
        return () => {
            window.removeEventListener(VOCAB_LEVEL_EVENT, sync);
            window.removeEventListener('storage', onStorage);
        };
    }, []);

    useEffect(() => {
        if (!enabled || words.length === 0 || failed) return;
        const missing = words.filter((word) => !wordLevelCache.has(word));
        if (missing.length === 0) return;

        const controller = new AbortController();
        let cancelled = false;
        fetchVocabularyLevels(missing, { signal: controller.signal })
            .then((fetched) => {
                for (const [word, value] of Object.entries(fetched)) {
                    wordLevelCache.set(word.toLowerCase(), value);
                }
                if (cancelled) return;
                setFailedCorpus(null);
                bumpCacheVersion((version) => version + 1);
            })
            .catch(() => {
                // Silent fallback: no highlight, no error toast, no guess.
                if (cancelled || controller.signal.aborted) return;
                setFailedCorpus(corpus);
                bumpCacheVersion((version) => version + 1);
            });
        return () => {
            cancelled = true;
            controller.abort();
        };
    }, [corpus, enabled, failed, words]);

    const setEnabled = useCallback((next: boolean) => {
        setEnabledState(next);
        saveReadingHighlightEnabled(next);
        // Turning highlight back on is an explicit retry after a failed lookup.
        if (next) setFailedCorpus(null);
    }, []);

    const levelLabel = VOCAB_LEVELS.find((entry) => entry.id === level)?.label ?? 'A2';
    const thresholdRank = VOCAB_LEVEL_RANK[level];

    // Derived from the shared cache on every render: cached words paint
    // immediately (no effect round-trip) and a failed corpus paints nothing.
    const wordLevels = new Map<string, string | null>();
    if (!failed) {
        for (const word of words) {
            if (wordLevelCache.has(word)) {
                wordLevels.set(word, wordLevelCache.get(word) ?? null);
            }
        }
    }

    const isHighlighted = (word: string) => {
        if (!enabled || failed) return false;
        const value = wordLevels.get(word.trim().toLowerCase());
        if (value === undefined) return false;
        const rank = wordRank(value);
        return rank !== null && rank > thresholdRank;
    };

    return { enabled, setEnabled, level, levelLabel, wordLevels, isHighlighted };
}
