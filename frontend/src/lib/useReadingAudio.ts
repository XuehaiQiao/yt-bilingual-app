// Reading audio state machine (specs/037 §3).
//
// One hook owns the whole "listen / shadow" playback for every reading surface
// (public-domain book, imported book, free-library article, article reader,
// sentence packs). The readers only hand it the paragraph texts of the current
// scope plus a scroll container; everything below lives here exactly once:
//
//   state: idle → playing → paused → playing …
//          playing → (mode=shadow) waiting → playing …
//          playing → finished (end of scope) / unsupported (no voice) / idle
//
// Engine rules that make it reliable (specs/037 §3, §7):
//   - exactly ONE utterance is alive at a time; every state change cancels the
//     previous one before speaking;
//   - a generation counter is bumped on every cancel, and `onend`/`onerror`
//     are ignored when their generation is stale — Chrome/Safari still fire
//     `onend` after `cancel()`, and without this guard that stale callback
//     advances playback a second time;
//   - a scene change (`scopeKey`: chapter / article / search filter) cancels
//     and resets, so switching chapters can never leave the old text speaking;
//   - unmount cancels too (no residual voice after leaving the reader);
//   - a watchdog turns a silently-dead engine into an explicit failure state
//     instead of a bar stuck on "playing".
//
// Rate, mode and voice persist in localStorage under the app-wide
// `yt_bilingual_` prefix. The voice is resolved by `rankEnglishVoices`
// (Premium/Enhanced first, specs/037 §6) unless the learner picked one; a
// stored voice that has since been uninstalled falls back to the ranking and
// reports that once instead of failing silently. The current *position* is
// deliberately NOT persisted (specs/037 non-goals: no reading-position memory).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { splitSentences } from './sentenceSplit';
import {
    TTS_LANG,
    detectSpeechVoice,
    hasSpeechSynthesis,
    listVoices,
    pickEnglishVoice,
    rankEnglishVoices,
    type SpeechVoiceAvailability,
} from './tts';

export const READING_AUDIO_RATE_KEY = 'yt_bilingual_reading_audio_rate';
export const READING_AUDIO_MODE_KEY = 'yt_bilingual_reading_audio_mode';
export const READING_AUDIO_VOICE_KEY = 'yt_bilingual_reading_voice';

/** The six speed steps (specs/037 §1.3). */
export const READING_AUDIO_RATES = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;
export type ReadingAudioRate = (typeof READING_AUDIO_RATES)[number];
const DEFAULT_RATE: ReadingAudioRate = 1;

/** `continuous` reads on automatically; `shadow` pauses after every sentence. */
export type ReadingAudioMode = 'continuous' | 'shadow';

export type ReadingAudioState =
    | 'idle'
    | 'playing'
    | 'paused'
    | 'waiting'
    | 'finished'
    | 'unsupported';

export interface ReadingAudioPosition {
    paragraph: number;
    sentence: number;
}

export interface UseReadingAudioOptions {
    /** English paragraphs of the current reading scope, in render order. */
    paragraphs: readonly string[];
    /**
     * Identity of the reading scope (book+chapter+language, article id,
     * sentence pack + filter). Any change cancels speech and resets the cursor.
     */
    scopeKey: string;
    /** Scroll container holding the sentences; the active one is kept in view. */
    scrollRef?: RefObject<HTMLElement | null>;
}

export interface ReadingAudioController {
    isOpen: boolean;
    state: ReadingAudioState;
    mode: ReadingAudioMode;
    rate: ReadingAudioRate;
    /** False = the bar is disabled (missing engine / no English voice). */
    supported: boolean;
    /** `failed` = playback started but the engine reported an error. */
    failure: 'missing-voice' | 'failed' | null;
    voice: SpeechVoiceAvailability;
    /** Ranked English voices offered by the picker (novelty voices excluded). */
    voices: SpeechSynthesisVoice[];
    /** Persisted selection: `voiceURI`, or the name when a voice has no URI. */
    voiceURI: string;
    /** Display name of the selected voice; `''` until the engine reports one. */
    voiceName: string;
    /** Pick another voice; re-reads the current sentence when playback is live. */
    setVoice: (voiceURI: string) => void;
    /** True when a stored voice was gone and the automatic pick took over. */
    voiceFallback: boolean;
    active: ReadingAudioPosition | null;
    /** True while the bar is on screen and something can be read. */
    hasContent: boolean;
    /** Bottom padding (px) a reader must reserve so the bar never covers text. */
    bottomInset: number;
    setBarHeight: (height: number) => void;

    open: () => void;
    close: () => void;
    toggleOpen: () => void;
    play: () => void;
    pause: () => void;
    toggle: () => void;
    next: () => void;
    previous: () => void;
    replay: () => void;
    setMode: (mode: ReadingAudioMode) => void;
    setRate: (rate: ReadingAudioRate) => void;
}

function readStoredMode(): ReadingAudioMode {
    try {
        return window.localStorage.getItem(READING_AUDIO_MODE_KEY) === 'shadow' ? 'shadow' : 'continuous';
    } catch {
        return 'continuous';
    }
}

function readStoredRate(): ReadingAudioRate {
    try {
        const raw = Number(window.localStorage.getItem(READING_AUDIO_RATE_KEY));
        return (READING_AUDIO_RATES as readonly number[]).includes(raw)
            ? (raw as ReadingAudioRate)
            : DEFAULT_RATE;
    } catch {
        return DEFAULT_RATE;
    }
}

function storeMode(mode: ReadingAudioMode) {
    try {
        window.localStorage.setItem(READING_AUDIO_MODE_KEY, mode);
    } catch {
        /* private mode / quota: the in-memory preference still applies */
    }
}

function storeRate(rate: ReadingAudioRate) {
    try {
        window.localStorage.setItem(READING_AUDIO_RATE_KEY, String(rate));
    } catch {
        /* private mode / quota: the in-memory preference still applies */
    }
}

function readStoredVoice(): string | null {
    try {
        return window.localStorage.getItem(READING_AUDIO_VOICE_KEY)?.trim() || null;
    } catch {
        return null;
    }
}

/** Persisted identity: `voiceURI` when the engine gives one, the name otherwise. */
function voiceKey(voice: SpeechSynthesisVoice): string {
    return voice.voiceURI || voice.name;
}

function storeVoice(voice: SpeechSynthesisVoice) {
    try {
        window.localStorage.setItem(READING_AUDIO_VOICE_KEY, voiceKey(voice));
    } catch {
        /* private mode / quota: the in-memory preference still applies */
    }
}

/** Match a stored `voiceURI` OR name against the current ranked voices. */
function findVoice(voices: SpeechSynthesisVoice[], key: string): SpeechSynthesisVoice | undefined {
    return voices.find((voice) => voiceKey(voice) === key || voice.voiceURI === key || voice.name === key);
}

/** Text fields own their keystrokes; Space/←/→ must not be hijacked there. */
function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return target.isContentEditable || Boolean(target.closest('[contenteditable="true"]'));
}

/**
 * A focus inside the shared `Menu` belongs to the menu: Space activates the
 * focused `menuitemradio`, so the bar's media keys must stay out of the way.
 */
function isMenuTarget(target: EventTarget | null): boolean {
    return target instanceof Element && Boolean(target.closest('[role="menu"]'));
}

export function useReadingAudio({ paragraphs, scopeKey, scrollRef }: UseReadingAudioOptions): ReadingAudioController {
    const sentences = useMemo(
        () => paragraphs.map((paragraph) => splitSentences(paragraph ?? '')),
        [paragraphs],
    );

    const [isOpen, setIsOpen] = useState(false);
    const [state, setState] = useState<ReadingAudioState>('idle');
    const [mode, setModeState] = useState<ReadingAudioMode>(readStoredMode);
    const [rate, setRateState] = useState<ReadingAudioRate>(readStoredRate);
    const [active, setActive] = useState<ReadingAudioPosition | null>(null);
    const [voiceAvailability, setVoiceAvailability] = useState<SpeechVoiceAvailability>(() => detectSpeechVoice());
    const [voices, setVoices] = useState<SpeechSynthesisVoice[]>(() => rankEnglishVoices(listVoices()));
    const [selectedVoice, setSelectedVoice] = useState<{ uri: string; name: string }>({ uri: '', name: '' });
    const [voiceFallback, setVoiceFallback] = useState(false);
    const [failure, setFailure] = useState<'missing-voice' | 'failed' | null>(null);
    const [barHeight, setBarHeightState] = useState(0);

    // Refs mirror the render state so the utterance callbacks (which live
    // outside React's render) always read the current values.
    const stateRef = useRef<ReadingAudioState>('idle');
    const modeRef = useRef<ReadingAudioMode>(mode);
    const rateRef = useRef<ReadingAudioRate>(rate);
    const cursorRef = useRef<ReadingAudioPosition | null>(null);
    const sentencesRef = useRef(sentences);
    const voicesRef = useRef<SpeechSynthesisVoice[]>(voices);
    const selectedVoiceRef = useRef<SpeechSynthesisVoice | null>(null);
    const voiceKeyRef = useRef('');
    const generationRef = useRef(0);
    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
    const watchdogRef = useRef<number | null>(null);

    /** Adopt a voice, persist it, and optionally report a fallback. */
    const applyVoice = useCallback((voice: SpeechSynthesisVoice, fallback: boolean) => {
        const key = voiceKey(voice);
        selectedVoiceRef.current = voice;
        voiceKeyRef.current = key;
        setSelectedVoice((previous) => (
            previous.uri === key && previous.name === voice.name
                ? previous
                : { uri: key, name: voice.name }
        ));
        storeVoice(voice);
        if (fallback) setVoiceFallback(true);
    }, []);

    useEffect(() => {
        sentencesRef.current = sentences;
    }, [sentences]);

    const setPhase = useCallback((next: ReadingAudioState) => {
        stateRef.current = next;
        setState(next);
    }, []);

    const setCursor = useCallback((next: ReadingAudioPosition | null) => {
        cursorRef.current = next;
        setActive(next);
    }, []);

    const clearWatchdog = useCallback(() => {
        if (watchdogRef.current !== null) {
            window.clearTimeout(watchdogRef.current);
            watchdogRef.current = null;
        }
    }, []);

    /** Cancel the live utterance and invalidate its callbacks. */
    const cancelUtterance = useCallback(() => {
        generationRef.current += 1;
        utteranceRef.current = null;
        clearWatchdog();
        try {
            if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
        } catch {
            /* some engines throw when idle; nothing to recover from */
        }
    }, [clearWatchdog]);

    const firstPosition = useCallback((): ReadingAudioPosition | null => {
        const map = sentencesRef.current;
        for (let paragraph = 0; paragraph < map.length; paragraph += 1) {
            if (map[paragraph]?.length) return { paragraph, sentence: 0 };
        }
        return null;
    }, []);

    const nextPosition = useCallback((from: ReadingAudioPosition | null): ReadingAudioPosition | null => {
        if (!from) return firstPosition();
        const map = sentencesRef.current;
        if (from.sentence + 1 < (map[from.paragraph]?.length ?? 0)) {
            return { paragraph: from.paragraph, sentence: from.sentence + 1 };
        }
        for (let paragraph = from.paragraph + 1; paragraph < map.length; paragraph += 1) {
            if (map[paragraph]?.length) return { paragraph, sentence: 0 };
        }
        return null;
    }, [firstPosition]);

    const previousPosition = useCallback((from: ReadingAudioPosition | null): ReadingAudioPosition | null => {
        if (!from) return firstPosition();
        const map = sentencesRef.current;
        if (from.sentence > 0) return { paragraph: from.paragraph, sentence: from.sentence - 1 };
        for (let paragraph = from.paragraph - 1; paragraph >= 0; paragraph -= 1) {
            const length = map[paragraph]?.length ?? 0;
            if (length) return { paragraph, sentence: length - 1 };
        }
        return { paragraph: from.paragraph, sentence: 0 };
    }, [firstPosition]);

    /** Speak one sentence, replacing whatever was being spoken. */
    const speakAt = useCallback((position: ReadingAudioPosition) => {
        const sentence = sentencesRef.current[position.paragraph]?.[position.sentence];
        if (!sentence) {
            setPhase('finished');
            return;
        }
        if (!hasSpeechSynthesis()) {
            setVoiceAvailability('missing');
            setFailure('missing-voice');
            setPhase('unsupported');
            return;
        }
        if (detectSpeechVoice() === 'missing') {
            setVoiceAvailability('missing');
            setFailure('missing-voice');
            setPhase('unsupported');
            return;
        }

        // One utterance at a time: cancel first, then capture the fresh
        // generation for the callbacks below.
        cancelUtterance();
        const generation = generationRef.current;

        const utterance = new SpeechSynthesisUtterance(sentence.text);
        utterance.lang = TTS_LANG;
        utterance.rate = rateRef.current;
        // The picker's selection wins; before the engine has reported voices,
        // fall back to the same ranking so the first play is not silent-default.
        const selected = selectedVoiceRef.current ?? pickEnglishVoice();
        if (selected) utterance.voice = selected;

        const settle = () => {
            if (generation !== generationRef.current) return;
            clearWatchdog();
            utteranceRef.current = null;
            const next = nextPosition(cursorRef.current);
            if (modeRef.current === 'shadow') {
                // Shadow mode: read one sentence, then wait for the learner.
                // The last sentence of the scope finishes instead of waiting
                // for a "next" that does not exist.
                setPhase(next ? 'waiting' : 'finished');
                return;
            }
            if (!next) {
                setPhase('finished');
                return;
            }
            speakAt(next);
        };

        utterance.onend = () => {
            if (generation !== generationRef.current) return;
            settle();
        };
        utterance.onerror = (event) => {
            if (generation !== generationRef.current) return;
            clearWatchdog();
            utteranceRef.current = null;
            const error = (event as SpeechSynthesisErrorEvent).error;
            // `cancel()` and a replacing `speak()` report these two; they are
            // expected and must not turn the bar into an error state.
            if (error === 'interrupted' || error === 'canceled') return;
            setFailure('failed');
            setPhase('unsupported');
        };

        utteranceRef.current = utterance;
        setCursor(position);
        setFailure(null);
        // The fallback notice is a one-shot: once a sentence actually starts,
        // the learner has seen it and the status line goes back to position.
        setVoiceFallback(false);
        setPhase('playing');
        try {
            window.speechSynthesis.speak(utterance);
        } catch {
            setFailure('failed');
            setPhase('unsupported');
            return;
        }

        // Engine that never calls back (no voice installed, blocked autoplay):
        // fail visibly rather than hang in "playing" forever.
        clearWatchdog();
        watchdogRef.current = window.setTimeout(() => {
            watchdogRef.current = null;
            if (generation !== generationRef.current) return;
            setFailure('failed');
            setPhase('unsupported');
        }, Math.max(15_000, sentence.text.length * 220));
    }, [cancelUtterance, clearWatchdog, nextPosition, setCursor, setPhase]);

    const supported = voiceAvailability !== 'missing' && failure !== 'missing-voice';
    const hasContent = sentences.some((group) => group.length > 0);

    const play = useCallback(() => {
        if (!supported) return;
        const position = cursorRef.current ?? firstPosition();
        if (!position) return;
        speakAt(position);
    }, [firstPosition, speakAt, supported]);

    const pause = useCallback(() => {
        if (stateRef.current !== 'playing' && stateRef.current !== 'waiting') return;
        cancelUtterance();
        setPhase('paused');
    }, [cancelUtterance, setPhase]);

    const toggle = useCallback(() => {
        if (stateRef.current === 'playing') pause();
        else play();
    }, [pause, play]);

    const moveTo = useCallback((position: ReadingAudioPosition | null) => {
        if (!position) return;
        const current = stateRef.current;
        if (current === 'playing' || current === 'waiting') {
            speakAt(position);
            return;
        }
        // Idle / paused / finished: move the cursor (and the highlight) without
        // starting playback; the play button continues from there.
        cancelUtterance();
        setCursor(position);
        if (current === 'finished') setPhase('paused');
    }, [cancelUtterance, setCursor, setPhase, speakAt]);

    const next = useCallback(() => {
        moveTo(nextPosition(cursorRef.current));
    }, [moveTo, nextPosition]);

    const previous = useCallback(() => {
        moveTo(previousPosition(cursorRef.current));
    }, [moveTo, previousPosition]);

    const replay = useCallback(() => {
        const position = cursorRef.current ?? firstPosition();
        if (position) speakAt(position);
    }, [firstPosition, speakAt]);

    const setMode = useCallback((nextMode: ReadingAudioMode) => {
        if (modeRef.current === nextMode) return;
        modeRef.current = nextMode;
        setModeState(nextMode);
        storeMode(nextMode);
        // Leaving the waiting state for continuous mode should resume reading; the
        // other direction only takes effect when the current sentence ends.
        if (nextMode === 'continuous' && stateRef.current === 'waiting') {
            const position = cursorRef.current;
            if (position) speakAt(position);
        }
    }, [speakAt]);

    const setRate = useCallback((nextRate: ReadingAudioRate) => {
        if (rateRef.current === nextRate) return;
        rateRef.current = nextRate;
        setRateState(nextRate);
        storeRate(nextRate);
        // "New speed always applies to the current sentence" (specs/037 §1.3):
        // re-read it from the beginning at the new rate.
        if (stateRef.current === 'playing' || stateRef.current === 'waiting') {
            const position = cursorRef.current;
            if (position) speakAt(position);
        }
    }, [speakAt]);

    /**
     * Pick a voice (specs/037 §6). Cancel first so the old voice cannot finish
     * into the new selection; when a sentence is live, re-read it from the top
     * at the current rate. Paused/idle only changes the next playback, it never
     * starts speaking on its own.
     */
    const selectVoice = useCallback((nextVoiceURI: string) => {
        const target = findVoice(voicesRef.current, nextVoiceURI);
        if (!target) return;
        if (voiceKeyRef.current === voiceKey(target)) return;
        const wasLive = stateRef.current === 'playing' || stateRef.current === 'waiting';
        cancelUtterance();
        applyVoice(target, false);
        setVoiceFallback(false);
        if (wasLive) {
            const position = cursorRef.current;
            if (position) speakAt(position);
        }
    }, [applyVoice, cancelUtterance, speakAt]);

    const stop = useCallback(() => {
        cancelUtterance();
        setCursor(null);
        setPhase('idle');
    }, [cancelUtterance, setCursor, setPhase]);

    const open = useCallback(() => {
        setIsOpen(true);
        if (!cursorRef.current) {
            const first = firstPosition();
            if (first) setCursor(first);
        }
    }, [firstPosition, setCursor]);

    const close = useCallback(() => {
        stop();
        setFailure(null);
        setIsOpen(false);
    }, [setFailure, stop]);

    const toggleOpen = useCallback(() => {
        if (isOpen) close();
        else open();
    }, [close, isOpen, open]);

    const setBarHeight = useCallback((height: number) => {
        setBarHeightState((previous) => (Math.abs(previous - height) < 1 ? previous : height));
    }, []);

    // Switching chapter / article / pack stops playback immediately; scope
    // identity is the single cancellation point, so no reader has to remember
    // to call `stop()` in its own navigation handler.
    useEffect(() => {
        cancelUtterance();
        cursorRef.current = null;
        setActive(null);
        setPhase('idle');
        setFailure(null);
    }, [scopeKey, cancelUtterance, setPhase]);

    // Unmount (leaving the reader, closing the view) must never leave a voice
    // talking in the background.
    useEffect(() => () => {
        generationRef.current += 1;
        clearWatchdog();
        utteranceRef.current = null;
        try {
            if (hasSpeechSynthesis()) window.speechSynthesis.cancel();
        } catch {
            /* ignore */
        }
    }, [clearWatchdog]);

    // Voices load asynchronously in Chrome (`voiceschanged`); every refresh
    // re-ranks them, re-checks "no English voice", and resolves the stored
    // selection:
    //   - still installed → keep it;
    //   - gone / never matched → automatic pick, and when a stored choice was
    //     actually lost, report that once (specs/037 §6: no silent failure);
    //   - no voices yet → leave the stored value alone and wait for the event.
    useEffect(() => {
        if (!hasSpeechSynthesis()) {
            setVoiceAvailability('missing');
            setVoices([]);
            voicesRef.current = [];
            return;
        }
        const refresh = () => {
            const ranked = rankEnglishVoices(listVoices());
            voicesRef.current = ranked;
            setVoices(ranked);
            setVoiceAvailability(detectSpeechVoice());

            const current = selectedVoiceRef.current;
            if (current && ranked.some((voice) => voiceKey(voice) === voiceKeyRef.current)) return;
            if (current) {
                // The selected voice disappeared mid-session (uninstalled).
                if (ranked[0]) applyVoice(ranked[0], true);
                return;
            }

            const stored = readStoredVoice();
            const storedMatch = stored ? findVoice(ranked, stored) : undefined;
            if (storedMatch) {
                applyVoice(storedMatch, false);
                return;
            }
            // Voices have not arrived yet: keep the stored value for later.
            if (ranked.length === 0) return;
            applyVoice(ranked[0], Boolean(stored));
        };
        refresh();
        const synth = window.speechSynthesis;
        synth.addEventListener?.('voiceschanged', refresh);
        return () => synth.removeEventListener?.('voiceschanged', refresh);
    }, [applyVoice]);

    // Keyboard: once the bar is on screen it behaves like a media player.
    // Text fields own their Space/arrows, and the shared Menu owns keys while
    // focus is inside its popup (Space activates a menuitemradio).
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (isTextEntryTarget(event.target) || isMenuTarget(event.target)) return;
            if (event.code === 'Space') {
                event.preventDefault();
                if (event.repeat) return;
                toggle();
                return;
            }
            if (event.key === 'ArrowRight') {
                event.preventDefault();
                next();
                return;
            }
            if (event.key === 'ArrowLeft') {
                event.preventDefault();
                previous();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [isOpen, next, previous, toggle]);

    // Keep the sentence being read visible. `auto` under reduced motion: the
    // highlight itself is a colour change, never a movement.
    useEffect(() => {
        if (!active) return;
        const container = scrollRef?.current;
        if (!container) return;
        const frame = window.requestAnimationFrame(() => {
            const node = container.querySelector<HTMLElement>(
                '[data-audio-sentence][data-audio-active="1"]',
            );
            if (!node) return;
            const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
            node.scrollIntoView({ block: 'center', behavior: reduced ? 'auto' : 'smooth' });
        });
        return () => window.cancelAnimationFrame(frame);
    }, [active, scrollRef]);

    return {
        isOpen,
        state: supported ? state : 'unsupported',
        mode,
        rate,
        supported,
        failure,
        voice: voiceAvailability,
        voices,
        voiceURI: selectedVoice.uri,
        voiceName: selectedVoice.name,
        setVoice: selectVoice,
        voiceFallback,
        active,
        hasContent,
        bottomInset: isOpen ? barHeight + 16 : 0,
        setBarHeight,
        open,
        close,
        toggleOpen,
        play,
        pause,
        toggle,
        next,
        previous,
        replay,
        setMode,
        setRate,
    };
}
