// Guest-only local ignore table for the word book (specs/005 §v1.1).
//
// Guests have no `word_states` row to PATCH, so their 「我会了」 mark lives only
// here (localStorage) and is never uploaded. Signed-in users do **not** read
// this store: their 已掌握 group is served by
// `GET /api/review/words?mastered=1` and updated from the PATCH response, so
// this module must never grow a second mirror for them.
//
// P2-50: the table is guest-private, so it lives in the guest bucket of
// `lib/storageScope.ts` instead of a browser-wide key (a later guest on the
// same device must not inherit an earlier guest/account's 「我会了」). The v1
// key is copied into the guest bucket by the one-time migration.
import { readScoped, scopedKey, writeScoped, STORAGE_STORES } from './storageScope';

/** The guest-table localStorage key for the *current* scope (guest normally). */
export function guestMasteredKey(): string {
    return scopedKey(STORAGE_STORES.guestMastered);
}

/** Normalize a word for set membership; the same word must match everywhere. */
export function normalizeMasteryWord(word: string): string {
    return word.trim().toLowerCase();
}

function readWords(): Set<string> {
    const parsed = readScoped<unknown>(STORAGE_STORES.guestMastered, null);
    if (!Array.isArray(parsed)) {
        // Private mode / corrupt value: degrade to "nothing marked locally".
        return new Set();
    }
    return new Set(
        parsed
            .filter((word): word is string => typeof word === 'string')
            .map(normalizeMasteryWord)
            .filter(Boolean),
    );
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
    writeScoped(STORAGE_STORES.guestMastered, Array.from(words).sort());
}
