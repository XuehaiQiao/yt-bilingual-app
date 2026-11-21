// Local mastery hints for the word book (specs/005 §v1.1 / specs/013 §v1.1).
//
// Two different stores share one shape because they answer the same rendering
// question ("does this row belong to the mastered group?"):
//   * guest — the spec's local ignore table (`我会了`, never uploaded): guest
//     accounts have no `word_states` row to PATCH, so mastery lives only here;
//   * signed-in — a *cache* of the server's `word_states.mastered` mark, so the
//     row can move into the 已掌握 group immediately and survive a reload.
//
// The signed-in cache is never the write source of truth: every mark/unmark
// still goes through `PATCH /api/review/words`; a failed request must not touch
// this store. The backend currently exposes no "list mastered words" endpoint,
// so words mastered on another device are not known until the user marks or
// undoes them here — the group is a best-effort mirror, not a server list.
//
// Keys are scoped per account so two users on one browser never share marks.
const GUEST_MASTERED_KEY = 'yt_bilingual_guest_mastered_words';
const AUTH_MASTERED_PREFIX = 'yt_bilingual_mastered_cache:';

/** Normalize a word for set membership; the same word must match everywhere. */
export function normalizeMasteryWord(word: string): string {
    return word.trim().toLowerCase();
}

export interface MasteryScope {
    /** localStorage key this scope reads/writes. */
    key: string;
    /** True = the guest ignore table (文案「我会了」), false = server mirror. */
    isGuest: boolean;
}

export function masteryScope(isGuest: boolean, userId: string | null | undefined): MasteryScope {
    return {
        key: isGuest ? GUEST_MASTERED_KEY : `${AUTH_MASTERED_PREFIX}${userId || 'unknown'}`,
        isGuest,
    };
}

function readWords(key: string): Set<string> {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return new Set();
        const parsed: unknown = JSON.parse(raw);
        if (!Array.isArray(parsed)) return new Set();
        return new Set(
            parsed
                .filter((word): word is string => typeof word === 'string')
                .map(normalizeMasteryWord)
                .filter(Boolean),
        );
    } catch {
        // Private mode / corrupt value: degrade to "nothing marked locally".
        return new Set();
    }
}

function writeWords(key: string, words: Set<string>): void {
    try {
        localStorage.setItem(key, JSON.stringify(Array.from(words).sort()));
    } catch {
        // Non-fatal: the row state still updates for this session.
    }
}

/** Every locally known mastered word for this scope (normalized). */
export function readMasteryHints(scope: MasteryScope): Set<string> {
    return readWords(scope.key);
}

export function hasMasteryHint(scope: MasteryScope, word: string): boolean {
    const normalized = normalizeMasteryWord(word);
    return Boolean(normalized) && readWords(scope.key).has(normalized);
}

/** Add/remove one word locally; only call after the server (or guest) accepted it. */
export function writeMasteryHint(scope: MasteryScope, word: string, mastered: boolean): void {
    const normalized = normalizeMasteryWord(word);
    if (!normalized) return;
    const words = readWords(scope.key);
    if (mastered) words.add(normalized);
    else words.delete(normalized);
    writeWords(scope.key, words);
}
