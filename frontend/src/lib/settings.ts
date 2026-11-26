// Learner profile settings (persisted in localStorage).
//
// P2-50: both settings describe the *learner*, so they live in the
// identity-scoped namespace (`lib/storageScope.ts`) instead of browser-wide v1
// keys. They are copied out of the v1 key by the one-time migration.
import { readScopedText, writeScopedText, STORAGE_STORES } from './storageScope';

/**
 * Legacy v1 key. Kept because `useReadingHighlights` filters cross-tab
 * `storage` events by this exact key (that module is outside the P2-50 write
 * scope). `saveVocabLevel` mirrors the new value here as a notification
 * channel only — **no reader in this build loads its value**, so it can never
 * leak one account's level into another's highlights.
 */
export const VOCAB_LEVEL_KEY = 'yt_bilingual_vocab_level';

// Six levels along a vocabulary-size axis (~4k → 20k+ words), named after a
// journey into space — numbers stay backstage, the metaphor does the talking.
// Displayed as CEFR bands A1–C2 (the plan deliberately drops the old space
// metaphors). Internal ids stay unchanged so saved settings keep working.
export const VOCAB_LEVELS = [
    { id: 'liftoff', label: 'A1', tagline: 'Beginner — everyday words are still new' },
    { id: 'orbit', label: 'A2', tagline: 'Elementary — handles simple daily exchanges' },
    { id: 'moonwalk', label: 'B1', tagline: 'Intermediate — follows familiar topics with help' },
    { id: 'interstellar', label: 'B2', tagline: 'Upper-intermediate — reads and listens with less support' },
    { id: 'deep-space', label: 'C1', tagline: 'Advanced — long texts and implicit meaning' },
    { id: 'supernova', label: 'C2', tagline: 'Mastery — only the rarest expressions are new' },
] as const;

export type VocabLevelId = typeof VOCAB_LEVELS[number]['id'];

// Earlier releases stored exam-based ids; map them onto the new axis.
const LEGACY_LEVELS: Record<string, VocabLevelId> = {
    cet4: 'liftoff',
    cet6: 'orbit',
    kaoyan: 'moonwalk',
    ielts: 'interstellar',
    advanced: 'deep-space',
};

/** Fired whenever the highlighter level is saved, so mounted readers/rows can
 *  recompute without a reload (the `storage` event only covers other tabs). */
export const VOCAB_LEVEL_EVENT = 'yt-bilingual:vocab-level';

export function loadVocabLevel(): VocabLevelId {
    const saved = readScopedText(STORAGE_STORES.vocabLevel) || '';
    if (VOCAB_LEVELS.some(l => l.id === saved)) return saved as VocabLevelId;
    if (saved in LEGACY_LEVELS) return LEGACY_LEVELS[saved];
    return 'orbit';
}

/**
 * True when the learner ever saved the slider (current or legacy ids).
 *
 * The ability profile seeds the slider only on the very first run; once a
 * choice exists it is never overwritten, even when the profile later changes.
 */
export function hasSavedVocabLevel(): boolean {
    const saved = readScopedText(STORAGE_STORES.vocabLevel) || '';
    return VOCAB_LEVELS.some(l => l.id === saved) || saved in LEGACY_LEVELS;
}

export function saveVocabLevel(level: VocabLevelId) {
    writeScopedText(STORAGE_STORES.vocabLevel, level);
    // Cross-tab notification channel (see VOCAB_LEVEL_KEY above); the scoped
    // key can never be matched by the reader's legacy-name filter.
    try {
        localStorage.setItem(VOCAB_LEVEL_KEY, level);
    } catch {
        // Private mode / quota: the scoped write above is the source of truth.
    }
    window.dispatchEvent(new CustomEvent<VocabLevelId>(VOCAB_LEVEL_EVENT, { detail: level }));
}

/** CEFR band → slider stop. The slider's internal ids stay as they are. */
const CEFR_TO_VOCAB_LEVEL: Record<string, VocabLevelId> = {
    A1: 'liftoff',
    A2: 'orbit',
    B1: 'moonwalk',
    B2: 'interstellar',
    C1: 'deep-space',
    C2: 'supernova',
};

/**
 * Map a placement/ability band to the slider's stop, using the *high* edge of
 * the interval (`A2–B1` → B1). Returns null when the band cannot be parsed so
 * callers keep the existing default instead of guessing.
 */
export function vocabLevelFromCefr(band: string | null | undefined): VocabLevelId | null {
    if (!band) return null;
    const matches = String(band).toUpperCase().match(/\b(A1|A2|B1|B2|C1|C2)\b/g);
    if (!matches || matches.length === 0) return null;
    // Interval labels are ordered low → high; the last match is the high band.
    return CEFR_TO_VOCAB_LEVEL[matches[matches.length - 1]] ?? null;
}

// Current model, chosen in the home-screen model bar. Every LLM call
// (translation, local shows, dictionary) reads it so they all follow the same
// provider; when nothing is saved yet the bar seeds it from the backend
// default returned by GET /api/models.
//
// P2-50: the choice is per learner (a shared device must not silently spend
// account B's credits on account A's model), so it is scoped like the level.
/** Legacy v1 key (migration source only; never read by this build). */
export const MODEL_KEY = 'yt_bilingual_last_model';

export function loadModel(): string {
    return readScopedText(STORAGE_STORES.lastModel) || '';
}

export function saveModel(modelId: string) {
    if (modelId) writeScopedText(STORAGE_STORES.lastModel, modelId);
}
