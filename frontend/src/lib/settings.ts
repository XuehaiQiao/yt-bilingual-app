// Learner profile settings (persisted in localStorage).

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

export function loadVocabLevel(): VocabLevelId {
    const saved = localStorage.getItem(VOCAB_LEVEL_KEY) || '';
    if (VOCAB_LEVELS.some(l => l.id === saved)) return saved as VocabLevelId;
    if (saved in LEGACY_LEVELS) return LEGACY_LEVELS[saved];
    return 'orbit';
}

export function saveVocabLevel(level: VocabLevelId) {
    localStorage.setItem(VOCAB_LEVEL_KEY, level);
}

// Current global model, chosen in the home-screen model bar. Every LLM call
// (translation, local shows, dictionary) reads it so they all follow the same
// provider; when nothing is saved yet the bar seeds it from the backend
// default returned by GET /api/models.
export const MODEL_KEY = 'yt_bilingual_last_model';

export function loadModel(): string {
    return localStorage.getItem(MODEL_KEY) || '';
}

export function saveModel(modelId: string) {
    if (modelId) localStorage.setItem(MODEL_KEY, modelId);
}
