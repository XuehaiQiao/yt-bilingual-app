// Reactive wrapper around `detectSpeechVoice` (lib/tts, specs/037 §1.7).
//
// `detectSpeechVoice()` is a point-in-time probe. A row-level 朗读 button needs
// the answer to update once the engine reports its voices: Chrome starts with
// `getVoices() === []` (→ `unknown`, not a failure) and fires `voiceschanged`
// later, Safari/iOS reports voices after the first user gesture. Without the
// subscription a row rendered before that event would stay disabled/unknown
// for the whole session.
//
// `unknown` is deliberately NOT converted to "disabled": Chrome's empty list is
// a false negative, and `speak()` itself is a safe no-op when the engine is
// missing. Only `missing` (no engine, or voices but none in English) disables
// the button.
import { useEffect, useState } from 'react';
import { detectSpeechVoice, hasSpeechSynthesis, type SpeechVoiceAvailability } from './tts';

export function useSpeechAvailability(): SpeechVoiceAvailability {
    const [availability, setAvailability] = useState<SpeechVoiceAvailability>(() => detectSpeechVoice());

    useEffect(() => {
        if (!hasSpeechSynthesis()) return;
        const synth = window.speechSynthesis;
        const refresh = () => setAvailability(detectSpeechVoice());
        // Voices may have loaded between the initial render and this effect.
        refresh();
        synth.addEventListener?.('voiceschanged', refresh);
        return () => synth.removeEventListener?.('voiceschanged', refresh);
    }, []);

    return availability;
}

export default useSpeechAvailability;
