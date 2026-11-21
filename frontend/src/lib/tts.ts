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

/** Prefer a native English voice; `undefined` = let the engine choose. */
export function pickEnglishVoice(voices: SpeechSynthesisVoice[] = listVoices()): SpeechSynthesisVoice | undefined {
    return voices.find((voice) => voice.lang?.toLowerCase().startsWith('en'));
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
