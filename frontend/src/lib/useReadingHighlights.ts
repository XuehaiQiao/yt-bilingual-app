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
//   - 缓存仍只按小写词形存词级（切换章节不重查）；但专名与「非句首大写」在
//     进缓存之前就被过滤掉（见 collectReadingWords / isHighlighted），避免大写
//     形态借到普通词形的等级（缓存串味）。
//
// 标亮最小版（v1.1 任务 3，D3-1）自本版起区分大小写：
//   - 小写词、以及**句首**首字母大写的词，仍按上面的频率判据判（句首词照常判，
//     否则句首普通词会被整片放过）；
//   - 非句首的「首字母大写」token 一律不标（多半是专名），也不送查词级、不进缓存；
//   - lib/properNouns.ts 的常见人名/地名/缩写名单**任何位置**都不标亮。
//   - 已知限制：文本按句/段（block）传入，句首专名只能靠上面那份小名单兜底，
//     名单外的句首专名必然漏判——句首普通词与句首专名在词形上无法区分。
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isProperNoun } from './properNouns';
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

/** Token 的首个字母是否大写（iPhone 这类首字母小写的不算）。 */
export function startsWithCapitalLetter(token: string): boolean {
    const first = /[A-Za-z]/.exec(token)?.[0];
    return first !== undefined && first === first.toUpperCase();
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

/**
 * 收集需要查词级的「小写词形」集合（已按标亮最小版规则过滤）。
 *
 * 规则（v1.1 任务 3，D3-1）：
 *   - 非句首的「首字母大写」token 不可能是普通小写词，直接跳过——不查词级、
 *     不进缓存，这同时保证了缓存里不会有专名/大写形态的等级；
 *   - 句首 token 仍按原频率判据，加入待查集合（否则句首普通词会被整片放过）；
 *   - 名单内专名任何位置都跳过（句首专名的唯一兜底）。
 *
 * 句首判定：每个换行（调用方的句/段 block）算句首；行内第一个实词，以及句末
 * 标点（. ! ? … 等）后的第一个实词算句首；常见缩写（Mr. 等）不结束句子。
 *
 * 已知限制：block 是句级，句子被 block 切断或缩写后接普通词时可能误判句首；
 * 同一词形若在本文里另有小写/句首出现，它在别处的非句首大写形态仍会被判到
 * （isHighlighted 拿不到 token 位置）。句首专名若不在名单内，必然漏判。
 */
export function collectReadingWords(corpus: string): string[] {
    const words = new Set<string>();
    for (const line of corpus.split('\n')) {
        let sentenceStart = true;
        for (const raw of line.split(/\s+/)) {
            if (!raw) continue;
            const token = cleanReadingWord(raw);
            // 只处理有意义（含字母、长度 ≥2）的词；纯数字/标点 token 不改变
            // 句首状态，除非它本身就是句末标点（下面单独处理）。
            const isWord = token.length >= 2 && /[A-Za-z]/.test(token);
            if (isWord && !isProperNoun(token)) {
                const lower = token.toLowerCase();
                if (!startsWithCapitalLetter(token) || sentenceStart) {
                    words.add(lower);
                }
            }
            if (isWord) sentenceStart = false;
            if (endsSentence(raw)) sentenceStart = true;
        }
    }
    return Array.from(words);
}

/**
 * 纯函数：这个 token 是否**可能**按频率判据判亮（大小写 + 专名规则）。
 *
 * 返回 true 只表示「没有被专名/大小写规则挡掉」，真正是否标亮还得看词级
 * 与阈值。判定顺序：
 *   1. 少于 2 个字符、或没有字母的 token（数字/标点）不判；
 *   2. 名单内专名任何位置都不判（句首专名的唯一兜底）；
 *   3. 非句首的「首字母大写」token 不判。是否算句首由 collectReadingWords
 *      预先算好：只有「本文里出现过小写形态或句首形态」的词形进入 eligibleWords，
 *      所以这里等于要求该词形在当前文本里有可按频率判的用法。
 *
 * 注意：这里拿不到 token 在句中的位置，若同一词形在本文里另有小写/句首出现，
 * 它在别处的非句首大写形态也会被判到——这是 block 句级方案的已知残留误差，
 * 方向是「多标」而不是「漏标」，可接受。
 */
export function canJudgeReadingWordCase(token: string, eligibleWords: ReadonlySet<string>): boolean {
    const word = cleanReadingWord(token.trim());
    if (word.length < 2 || !/[A-Za-z]/.test(word)) return false;
    if (isProperNoun(word)) return false;
    return !startsWithCapitalLetter(word) || eligibleWords.has(word.toLowerCase());
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
    // 当前文本里「可以按频率判」的小写词形（小写出现或句首出现）。
    // isHighlighted 用它挡掉非句首大写 token——即使共享缓存被别的文本喂过。
    const eligibleWords = useMemo(() => new Set(words), [words]);
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

    // 调用方（ClickableWords 等）传进来的是保留原始大小写的 token；这里正用
    // 大小写做专名/句首判断，小写只用于查词级——不再像以前那样先把大小写丢掉。
    // 先做大小写/专名判定、再查 level 缓存：缓存只按小写词形存 level，若先查
    // 缓存，句首的 London 会借到 london 的等级被误标成生词（缓存串味）。
    const isHighlighted = (word: string) => {
        if (!enabled || failed) return false;
        if (!canJudgeReadingWordCase(word, eligibleWords)) return false;
        const value = wordLevels.get(cleanReadingWord(word.trim()).toLowerCase());
        if (value === undefined) return false;
        const rank = wordRank(value);
        return rank !== null && rank > thresholdRank;
    };

    return { enabled, setEnabled, level, levelLabel, wordLevels, isHighlighted };
}
