// Browser text-to-speech for word/sentence pronunciation and the reading
// audio bar (specs/037).
//
// Two callers, one engine:
//   - `speak(text, rate)` is the one-shot pronunciation used by the dictionary
//     card and the sentence-pack speaker button. Its behaviour is unchanged:
//     cancel whatever is queued, then speak one en-US utterance.
//   - the reading bar (`lib/useReadingAudio.ts`) needs the *same* voice pick
//     plus explicit control over the utterance (`onend` / `onerror`, cancel
//     before switching), so the voice helpers below are exported instead of
//     duplicating the "prefer a native English voice" rule in a second place.
//
// Preference is decided in exactly one place (`rankEnglishVoices`, specs/037
// §6): Premium / Enhanced / Neural / Natural first, then Google / Siri, then
// the rest; inside a tier en-US → en-GB → other English, then name. macOS
// ships Samantha (compact) as the system default, which is why "first English
// voice" is not good enough — the ranking makes an installed Premium voice win.
export const TTS_LANG = 'en-US';

/** True when this environment can synthesise speech at all. */
export function hasSpeechSynthesis(): boolean {
    return typeof window !== 'undefined'
        && 'speechSynthesis' in window
        && typeof window.SpeechSynthesisUtterance === 'function';
}

/** Installed voices; `[]` when the engine is missing or has not loaded yet. */
export function listVoices(): SpeechSynthesisVoice[] {
    if (!hasSpeechSynthesis()) return [];
    try {
        return window.speechSynthesis.getVoices() ?? [];
    } catch {
        return [];
    }
}

/**
 * System novelty voices — sound effects, not speech. They are tagged `en-US`
 * on macOS (Bells, Boing, …) and would otherwise win the "first English
 * voice" race and read a whole book in chimes.
 */
const NOVELTY_VOICES = [
    'Bells',
    'Boing',
    'Bubbles',
    'Cellos',
    'Good News',
    'Bad News',
    'Jester',
    'Organ',
    'Superstar',
    'Trinoids',
    'Whisper',
    'Wobble',
    'Zarvox',
    'Bahh',
] as const;

/** Installed quality markers (macOS `Ava (Premium)`, Chrome `… (Natural)`). */
const PREMIUM_VOICE = /premium|enhanced|neural|natural/i;
/** Vendor quality tiers below Premium: Google / Siri voices are usually neural. */
const BRANDED_VOICE = /google|siri/i;

function isEnglishVoice(voice: SpeechSynthesisVoice): boolean {
    return typeof voice.lang === 'string' && voice.lang.toLowerCase().startsWith('en');
}

function isNoveltyVoice(voice: SpeechSynthesisVoice): boolean {
    const name = (voice.name ?? '').toLowerCase();
    return NOVELTY_VOICES.some((novelty) => name.includes(novelty.toLowerCase()));
}

function voiceTier(voice: SpeechSynthesisVoice): number {
    const name = voice.name ?? '';
    if (PREMIUM_VOICE.test(name)) return 0;
    if (BRANDED_VOICE.test(name)) return 1;
    return 2;
}

/** en-US → en-GB → any other English locale. */
function localeRank(lang: string): number {
    const normalized = (lang ?? '').toLowerCase().replace(/_/g, '-');
    if (normalized === 'en-us') return 0;
    if (normalized === 'en-gb') return 1;
    return 2;
}

/**
 * English voices a reader may use, best first (specs/037 §6):
 *   1. name marks Premium / Enhanced / Neural / Natural;
 *   2. name marks Google / Siri;
 *   3. everything else;
 * within a tier en-US → en-GB → other English, then name. Novelty voices are
 * dropped and the input array is never mutated. Pure — exported for tests.
 */
export function rankEnglishVoices(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice[] {
    return (voices ?? [])
        .filter((voice) => isEnglishVoice(voice) && !isNoveltyVoice(voice))
        .sort((a, b) => voiceTier(a) - voiceTier(b)
            || localeRank(a.lang) - localeRank(b.lang)
            || a.name.localeCompare(b.name, 'en'));
}

/** Prefer a native English voice; `undefined` = let the engine choose. */
export function pickEnglishVoice(voices: SpeechSynthesisVoice[] = listVoices()): SpeechSynthesisVoice | undefined {
    return rankEnglishVoices(voices)[0];
}

/** Ranked English voices for a picker; `[]` when the engine has none yet. */
export function listEnglishVoices(): SpeechSynthesisVoice[] {
    return rankEnglishVoices(listVoices());
}

/**
 * Voice availability for a UI that must not fail silently (specs/037 §1.7):
 *   - `missing`: no speech engine, or an engine with voices but none in English;
 *   - `unknown`: the engine exists but has not reported its voices yet;
 *   - `ready`: an English voice is available.
 * `unknown` is deliberately NOT treated as a failure — Chrome reports an empty
 * list until `voiceschanged`, and blocking the bar there would be a false
 * negative. A real playback error is surfaced at runtime instead.
 */
export type SpeechVoiceAvailability = 'ready' | 'unknown' | 'missing';

export function detectSpeechVoice(): SpeechVoiceAvailability {
    if (!hasSpeechSynthesis()) return 'missing';
    const voices = listVoices();
    if (voices.length === 0) return 'unknown';
    return pickEnglishVoice(voices) ? 'ready' : 'missing';
}

export function speak(text: string, rate = 0.95) {
    if (!('speechSynthesis' in window)) return;
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = TTS_LANG;
    utterance.rate = rate;
    // Prefer a native English voice when available
    const voice = pickEnglishVoice();
    if (voice) utterance.voice = voice;
    window.speechSynthesis.speak(utterance);
}
