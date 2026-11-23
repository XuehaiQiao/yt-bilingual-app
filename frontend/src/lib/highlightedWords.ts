// Rail data for the reading highlight panel (specs/042).
//
// The four readers used to show the word book (我的收藏) in the right rail,
// which has nothing to do with the page being read. The rail now shows the
// page's own highlighted words, and this module is the single collection
// point: it scans the same English text the reader renders, asks the shared
// `useReadingHighlights` answer (backend classify + mastered/ignored filter)
// whether a token is marked, and de-duplicates by lowercase form.
//
// Keep this pure and reader-agnostic: `isHighlighted` / `wordLevels` are
// passed in instead of calling the hook here, so every reader (and the
// acceptance fixtures) shares one rule. No second difficulty rule lives here.
import { cleanReadingWord } from './useReadingHighlights';

export interface HighlightedWord {
    /** Lowercase dictionary form: the de-dupe key and the gloss lookup key. */
    word: string;
    /** Highlighted occurrences on this page (tooltip only, not a row column). */
    count: number;
    /** API CEFR level for the form; a highlighted form always has one. */
    level: string | null;
    /** Contextual gloss from the analysis; '' when the page has none. */
    gloss: string;
}

export interface CollectHighlightedWordsOptions {
    /** From `useReadingHighlights`; owns the enabled / failed / mastered gates. */
    isHighlighted: (word: string) => boolean;
    /** From `useReadingHighlights`; lowercase form → API level. */
    wordLevels: ReadonlyMap<string, string | null>;
    /** Lowercase word → gloss (merged from every analysis block). */
    glosses?: Readonly<Record<string, string>>;
}

/**
 * Collect the de-duplicated highlighted words of one page, in reading order.
 *
 * Token boundaries match `ClickableWords`: split on whitespace, then strip
 * leading/trailing punctuation with `cleanReadingWord`, so the word the rail
 * lists is exactly the word the surface can mark. Only tokens the hook marks
 * are counted — a form that is marked in one occurrence is not counted for a
 * proper-noun/capitalised occurrence the hook rejected.
 */
export function collectHighlightedWords(
    texts: readonly string[],
    { isHighlighted, wordLevels, glosses }: CollectHighlightedWordsOptions,
): HighlightedWord[] {
    const counts = new Map<string, number>();
    for (const text of texts) {
        for (const raw of text.split(/\s+/)) {
            if (!raw) continue;
            const token = cleanReadingWord(raw);
            if (token.length < 2 || !/[A-Za-z]/.test(token)) continue;
            // The hook owns the final decision (enabled / classify failure /
            // already-mastered filter); never re-implement it here.
            if (!isHighlighted(token)) continue;
            const form = token.toLowerCase();
            counts.set(form, (counts.get(form) ?? 0) + 1);
        }
    }
    // Map keeps first-appearance order, so the rail reads in page order.
    return [...counts].map(([word, count]) => ({
        word,
        count,
        level: wordLevels.get(word) ?? null,
        gloss: glosses?.[word] ?? '',
    }));
}

/**
 * Flatten the analysis' per-block `wordGlossesByBlock` into one lowercase
 * lookup for the rail. The first non-empty gloss wins (a word can be analysed
 * in several blocks); keys/values are trimmed and empty glosses are skipped so
 * the rail can render `—` instead of an empty box.
 */
export function mergeWordGlosses(
    byBlock:
        | Readonly<Record<string, Readonly<Record<string, string>>>>
        | null
        | undefined,
): Record<string, string> {
    const merged: Record<string, string> = {};
    if (!byBlock) return merged;
    for (const block of Object.values(byBlock)) {
        if (!block) continue;
        for (const [rawWord, rawGloss] of Object.entries(block)) {
            const word = rawWord.trim().toLowerCase();
            const gloss = typeof rawGloss === 'string' ? rawGloss.trim() : '';
            if (!word || !gloss || merged[word]) continue;
            merged[word] = gloss;
        }
    }
    return merged;
}
