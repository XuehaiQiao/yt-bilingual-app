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
//   - the classify request carries `sentenceStart` plus two corpus-level
//     observation facts per lowercase form (`hasLowercase` /
//     `hasNonInitialCapital`), collected in the same scan as the tokens. They
//     are *observations only*: the backend decides `proper` (specs/004 v1.1
//     句首专名兜底), so the frontend never applies the final rule;
//   - the classify cache key is the original word form + `sentenceStart` + the
//     two corpus facts (the backend rule is positional and corpus-level), so a
//     cached answer is never reused for a text with different observations.
//   - already-known words are not marked (specs/004 v1.1 「已掌握不标」): before
//     a word is marked, `lib/ignoredWords.ts` is asked whether it is in the
//     signed-in mastered list or the guest local ignore table. That filter is
//     render-only — the classify request, the proper-noun list and the CEFR
//     threshold are untouched, and the token can still be clicked for lookup.
//     The store is subscribed through `useIgnoredWords`, so mastering/undoing a
//     word re-renders this text and recomputes the marks without a new request.
//
// Known limitation (kept, not "solved"): a proper noun that only ever appears
// at a sentence start, and never capitalised outside a sentence start, cannot
// be distinguished from an ordinary capitalised word — word-form information
// is not enough (只出现在句首且无非句首大写的专名仍无解). A form that also
// appears in lowercase in the same text is treated as an ordinary word, so its
// capitalised non-initial occurrences may be marked — the error direction is
// "extra marks", not "missed words". Both are accepted for the block-level
// rule; the corpus fallback (never lowercase + non-initial capital) fixes the
// common `Toto` case.
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
import { getIgnoredSnapshot, useIgnoredWords, refreshIgnored } from './ignoredWords';

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

/** One token as it appeared in the text: spelling, position and corpus facts. */
export interface ReadingToken {
    text: string;
    sentenceStart: boolean;
    /** 该小写词形在本文里是否至少一次以小写出现。 */
    hasLowercase: boolean;
    /** 该词形是否至少一次以首字母大写出现在非句首。 */
    hasNonInitialCapital: boolean;
}

/**
 * classify 缓存键：原词形（保留大小写）+ 是否句首 + 两条语料级观察事实。
 *
 * 后端规则是「位置 + 语料」的：同一词形在另一篇文本里的小写/非句首大写
 * 分布可能不同，所以缓存键必须带事实，不能让不同文本借到彼此的判定。
 */
function classifyCacheKey(token: ReadingToken): string {
    return [
        token.sentenceStart ? '1' : '0',
        token.hasLowercase ? '1' : '0',
        token.hasNonInitialCapital ? '1' : '0',
        token.text,
    ].join('\u0000');
}

/**
 * 收集本文里需要 classify 的 token（原词形 + 句首标记 + 两条语料事实）。
 *
 * 句首判定与后端 `word_rules.iter_words` 同一口径：每个换行（调用方的句/段
 * block）算句首；行内第一个实词，以及句末标点（. ! ? … 等）后的第一个实词
 * 算句首；常见缩写（Mr. 等）不结束句子。
 *
 * 同一遍扫描里按小写词形累计两条观察事实（specs/004 v1.1 句首专名兜底）：
 *   - `hasLowercase`：该词形至少一次以小写（首字母小写）出现；
 *   - `hasNonInitialCapital`：该词形至少一次首字母大写且不在句首。
 * 它们只是**观察事实**，随 classify 请求发给后端；是否专名由
 * `backend/word_rules.py` 判定，前端不做最终判定。
 *
 * 只处理「清洗后至少 2 字符且含字母」的 token；纯数字/标点不送判定。
 * 同一 (原词形, sentenceStart, 两条事实) 只保留一次。
 */
export function collectReadingTokens(corpus: string): ReadingToken[] {
    interface FormFacts {
        hasLowercase: boolean;
        hasNonInitialCapital: boolean;
    }
    interface Occurrence {
        text: string;
        sentenceStart: boolean;
    }
    const formFacts = new Map<string, FormFacts>();
    const occurrences: Occurrence[] = [];
    for (const line of corpus.split('\n')) {
        let sentenceStart = true;
        for (const raw of line.split(/\s+/)) {
            if (!raw) continue;
            const token = cleanReadingWord(raw);
            const isWord = token.length >= 2 && /[A-Za-z]/.test(token);
            if (isWord) {
                const form = token.toLowerCase();
                const facts = formFacts.get(form) ?? {
                    hasLowercase: false,
                    hasNonInitialCapital: false,
                };
                if (/^[a-z]/.test(token)) facts.hasLowercase = true;
                if (/^[A-Z]/.test(token) && !sentenceStart) facts.hasNonInitialCapital = true;
                formFacts.set(form, facts);
                occurrences.push({ text: token, sentenceStart });
                sentenceStart = false;
            }
            if (endsSentence(raw)) sentenceStart = true;
        }
    }
    const tokens: ReadingToken[] = [];
    const seen = new Set<string>();
    for (const occurrence of occurrences) {
        const facts = formFacts.get(occurrence.text.toLowerCase());
        if (!facts) continue;
        const token: ReadingToken = { ...occurrence, ...facts };
        const key = classifyCacheKey(token);
        if (seen.has(key)) continue;
        seen.add(key);
        tokens.push(token);
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

/** Process-wide cache: (form, position, corpus facts) → backend classification. */
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
    // Already-known words (signed-in mastered list / guest local ignore table).
    // Subscribing here is what makes a freshly mastered word lose its mark on
    // the current page: the snapshot change re-renders this hook and
    // `isHighlighted` re-checks the set. It never re-runs the classify request.
    const ignored = useIgnoredWords();
    // Newly opened content must reflect marks made elsewhere in the app (the
    // word book's guest table, a signed-in word-book PATCH) without a reload:
    // re-read the list once per reader mount. The very first boot is already
    // covered by the store's own auth-mode read, so a not-yet-loaded signed-in
    // list is skipped rather than duplicated.
    useEffect(() => {
        if (!getIgnoredSnapshot().loaded) return;
        void refreshIgnored();
    }, []);
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
            (token) => !classifyCache.has(classifyCacheKey(token)),
        );
        if (missing.length === 0) return;

        const controller = new AbortController();
        let cancelled = false;
        fetchVocabularyClassify(missing, { signal: controller.signal })
            .then((results) => {
                results.forEach((result, index) => {
                    const token = missing[index];
                    if (!token) return;
                    classifyCache.set(classifyCacheKey(token), {
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
                const result = classifyCache.get(classifyCacheKey(token));
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
    //
    // 已忽略 / 已掌握的词（specs/004 v1.1）在渲染层排除：先查 ignored 集合，
    // 命中就返回 false。字词仍可点击查词；classify 的等级与专名规则不变。
    const isHighlighted = (word: string) => {
        if (!enabled || failed) return false;
        const form = cleanReadingWord(word.trim()).toLowerCase();
        if (form.length < 2) return false;
        if (ignored.words.has(form)) return false;
        return highlightable.has(form);
    };

    return { enabled, setEnabled, level, levelLabel, wordLevels, isHighlighted };
}
