// Guest-only local ignore table for the word book (specs/005 §v1.1).
//
// Guests have no `word_states` row to PATCH, so their 「我会了」 mark lives only
// here (localStorage) and is never uploaded. Signed-in users do **not** read
// this store: their 已掌握 group is served by
// `GET /api/review/words?mastered=1` and updated from the PATCH response, so
// this module must never grow a second mirror for them.
export const GUEST_MASTERED_KEY = 'yt_bilingual_guest_mastered_words';

/** Normalize a word for set membership; the same word must match everywhere. */
export function normalizeMasteryWord(word: string): string {
    return word.trim().toLowerCase();
}

function readWords(): Set<string> {
    try {
        const raw = localStorage.getItem(GUEST_MASTERED_KEY);
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

/** Every locally ignored word for the guest (normalized). */
export function readGuestMastered(): Set<string> {
    return readWords();
}

/** Add/remove one word in the guest table; guest-only by contract. */
export function writeGuestMastered(word: string, mastered: boolean): void {
    const normalized = normalizeMasteryWord(word);
    if (!normalized) return;
    const words = readWords();
    if (mastered) words.add(normalized);
    else words.delete(normalized);
    try {
        localStorage.setItem(GUEST_MASTERED_KEY, JSON.stringify(Array.from(words).sort()));
    } catch {
        // Non-fatal: the row state still updates for this session.
    }
}
