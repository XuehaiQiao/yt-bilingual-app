// Reading difficulty highlight (user request 2026-11-17 #3).
//
// The slider in 我的 · 设置 is a *highlighting* preference: words above the
// selected band are marked in articles and books so the learner can spot the
// words that deserve attention. It is not an ability rating and it never
// decides what content is recommended.
//
// Contract (specs/004 + specs/028, v2):
//   - the selected `VocabLevelId` maps to a CEFR threshold (A1…C2);
//   - every token is classified by `POST /api/vocabulary/classify` (batched by
//     lib/vocabulary.ts). The backend is the single source of the proper-noun
//     list and of the capitalisation rule: a token is marked only when
//     `proper === false` and its level rank is above the threshold;
//   - the frontend must not keep a second proper-noun list or a second
//     capitalisation rule (the old frontend proper-noun module was deleted);
//   - `null` level means "not a valid English word" (numbers, garbage) — it is
//     not guessed into C1+; a returned `C1+` is treated as the rank between C1
//     and C2; C2 is the highest stop, so at C2 nothing is marked;
//   - an unavailable API fails silently into "no highlight" — reading is never
//     blocked and a level is never invented;
//   - the classify cache key is the original word form + `sentenceStart` (the
//     backend rule is positional), so the cache of one reader can be reused by
//     another without letting a capitalised occurrence borrow the wrong answer.
//
// Known limitation (kept, not "solved"): a block is a sentence/paragraph and
// its first token is assumed to start a sentence. A proper noun at the start
// of a block is indistinguishable from an ordinary capitalised word, so a
// proper noun at position 0 (and any unlisted one) is necessarily missed by
// the proper-noun filter (句首专名必漏). The same form appearing elsewhere in
// lowercase/sentence-start can also make its non-initial capitalised
// occurrences get marked — the error direction is "extra marks", not "missed
// words". Both are accepted for the block-level v1 rule.
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
    fetchVocabularyClassify,
    type VocabularyClassifyResult,
} from './vocabulary';
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

/** 句末标点（后面可再跟收尾引号/括号）：其后的首个实词算「句首」。 */
const SENTENCE_END_RE = /[.!?…。！？]["'”’)\]}]*$/;

/** 不结束句子的常见缩写，避免把 Mr. Darcy / e.g. this 的后一个词误判成句首。 */
const NON_TERMINAL_ABBREVIATIONS = new Set([
    'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs',
    'e.g', 'i.e', 'a.m', 'p.m', 'u.s', 'u.k',
]);

function endsSentence(rawToken: string): boolean {
    if (!SENTENCE_END_RE.test(rawToken)) return false;
    // cleanReadingWord 会去掉结尾标点，只留词干。
    return !NON_TERMINAL_ABBREVIATIONS.has(cleanReadingWord(rawToken).toLowerCase());
}

/** One token as it appeared in the text: original spelling + positional context. */
export interface ReadingToken {
    text: string;
    sentenceStart: boolean;
}

/** classify 缓存键：原词形（保留大小写）+ 是否句首。 */
function classifyCacheKey(text: string, sentenceStart: boolean): string {
    return `${sentenceStart ? '1' : '0'}\u0000${text}`;
}

/**
 * 收集本文里需要 classify 的 token（原词形 + 句首标记）。
 *
 * 句首判定与后端 `word_rules.iter_words` 同一口径：每个换行（调用方的句/段
 * block）算句首；行内第一个实词，以及句末标点（. ! ? … 等）后的第一个实词
 * 算句首；常见缩写（Mr. 等）不结束句子。
 *
 * 只处理「清洗后至少 2 字符且含字母」的 token；纯数字/标点不送判定。
 * 同一 (原词形, sentenceStart) 只保留一次——后端返回专名标记与位置有关，
 * 所以必须在缓存键里带上 sentenceStart。
 */
export function collectReadingTokens(corpus: string): ReadingToken[] {
    const tokens: ReadingToken[] = [];
    const seen = new Set<string>();
    for (const line of corpus.split('\n')) {
        let sentenceStart = true;
        for (const raw of line.split(/\s+/)) {
            if (!raw) continue;
            const token = cleanReadingWord(raw);
            const isWord = token.length >= 2 && /[A-Za-z]/.test(token);
            if (isWord) {
                const key = classifyCacheKey(token, sentenceStart);
                if (!seen.has(key)) {
                    seen.add(key);
                    tokens.push({ text: token, sentenceStart });
                }
                sentenceStart = false;
            }
            if (endsSentence(raw)) sentenceStart = true;
        }
    }
    return tokens;
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

/** Process-wide cache: (original form, sentenceStart) → backend classification. */
const classifyCache = new Map<string, VocabularyClassifyResult>();

export interface ReadingHighlights {
    /** Switch state (persisted; default on). */
    enabled: boolean;
    setEnabled: (next: boolean) => void;
    /** Current slider stop (also drives the toggle's threshold hint). */
    level: VocabLevelId;
    /** Display label of the current stop, e.g. `B1`. */
    levelLabel: string;
    /** Lower-case form → API level for the judged (non-proper) words in this text. */
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
    // Bumped after a lookup finishes; the derived maps below depend on it even
    // though the shared cache itself is a module-level map (no setState-in-
    // effect cascade for already cached words).
    const [cacheVersion, bumpCacheVersion] = useState(0);
    // The corpus that failed lookup, so a failure paints no marks but a new
    // text (or turning the switch back on) retries instead of staying broken.
    const [failedCorpus, setFailedCorpus] = useState<string | null>(null);

    // Join first: callers usually build the array inline, but the join result
    // is a stable value and keeps the token-list memo from thrashing.
    const corpus = texts.join('\n');
    const tokens = useMemo(() => collectReadingTokens(corpus), [corpus]);
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
        if (!enabled || tokens.length === 0 || failed) return;
        const missing = tokens.filter(
            (token) => !classifyCache.has(classifyCacheKey(token.text, token.sentenceStart)),
        );
        if (missing.length === 0) return;

        const controller = new AbortController();
        let cancelled = false;
        fetchVocabularyClassify(missing, { signal: controller.signal })
            .then((results) => {
                results.forEach((result, index) => {
                    const token = missing[index];
                    if (!token) return;
                    classifyCache.set(classifyCacheKey(token.text, token.sentenceStart), {
                        text: token.text,
                        level: result.level,
                        proper: result.proper,
                    });
                });
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
    }, [corpus, enabled, failed, tokens]);

    const setEnabled = useCallback((next: boolean) => {
        setEnabledState(next);
        saveReadingHighlightEnabled(next);
        // Turning highlight back on is an explicit retry after a failed lookup.
        if (next) setFailedCorpus(null);
    }, []);

    const levelLabel = VOCAB_LEVELS.find((entry) => entry.id === level)?.label ?? 'A2';
    const thresholdRank = VOCAB_LEVEL_RANK[level];

    // Derived from the shared cache on every relevant render: cached words
    // paint immediately (no effect round-trip) and a failed corpus paints
    // nothing. `highlightable` is keyed by lower-case form because the
    // rendered token carries no sentence position: a word is markable when at
    // least one of its occurrences is non-proper and above the threshold.
    const { wordLevels, highlightable } = useMemo(() => {
        const levels = new Map<string, string | null>();
        const forms = new Set<string>();
        if (!failed) {
            for (const token of tokens) {
                const result = classifyCache.get(
                    classifyCacheKey(token.text, token.sentenceStart),
                );
                if (!result) continue;
                const form = token.text.toLowerCase();
                if (result.proper) continue;
                if (!levels.has(form)) levels.set(form, result.level);
                const rank = wordRank(result.level);
                if (rank !== null && rank > thresholdRank) forms.add(form);
            }
        }
        return { wordLevels: levels, highlightable: forms };
    }, [tokens, cacheVersion, failed, thresholdRank]);

    // 调用方（ClickableWords 等）传进来的是保留原始大小写的 token；大小写与
    // 专名判断已经由后端 classify 完成，这里只按「小写词形是否在本文里被判
    // 为可标亮」查。若先按小写缓存查 level，句首的 London 会借到 london 的
    // 等级被误标——所以由 highlightable 集合统一收口。
    const isHighlighted = (word: string) => {
        if (!enabled || failed) return false;
        const form = cleanReadingWord(word.trim()).toLowerCase();
        return form.length >= 2 && highlightable.has(form);
    };

    return { enabled, setEnabled, level, levelLabel, wordLevels, isHighlighted };
}
