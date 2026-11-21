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
// Engine rules that make it reliable (specs/037 §6):
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
// Rate and mode persist in localStorage under the app-wide `yt_bilingual_`
// prefix. The current *position* is deliberately NOT persisted (specs/037
// non-goals: no reading-position memory).
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { splitSentences } from './sentenceSplit';
import {
    TTS_LANG,
    detectSpeechVoice,
    hasSpeechSynthesis,
    pickEnglishVoice,
    type SpeechVoiceAvailability,
} from './tts';

export const READING_AUDIO_RATE_KEY = 'yt_bilingual_reading_audio_rate';
export const READING_AUDIO_MODE_KEY = 'yt_bilingual_reading_audio_mode';

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

/** Text fields own their keystrokes; Space/←/→ must not be hijacked there. */
function isTextEntryTarget(target: EventTarget | null): boolean {
    if (!(target instanceof HTMLElement)) return false;
    const tag = target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return target.isContentEditable || Boolean(target.closest('[contenteditable="true"]'));
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
    const [voice, setVoice] = useState<SpeechVoiceAvailability>(() => detectSpeechVoice());
    const [failure, setFailure] = useState<'missing-voice' | 'failed' | null>(null);
    const [barHeight, setBarHeightState] = useState(0);

    // Refs mirror the render state so the utterance callbacks (which live
    // outside React's render) always read the current values.
    const stateRef = useRef<ReadingAudioState>('idle');
    const modeRef = useRef<ReadingAudioMode>(mode);
    const rateRef = useRef<ReadingAudioRate>(rate);
    const cursorRef = useRef<ReadingAudioPosition | null>(null);
    const sentencesRef = useRef(sentences);
    const generationRef = useRef(0);
    const utteranceRef = useRef<SpeechSynthesisUtterance | null>(null);
    const watchdogRef = useRef<number | null>(null);

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
            setVoice('missing');
            setFailure('missing-voice');
            setPhase('unsupported');
            return;
        }
        if (detectSpeechVoice() === 'missing') {
            setVoice('missing');
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
        const selected = pickEnglishVoice();
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

    const supported = voice !== 'missing' && failure !== 'missing-voice';
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

    // Voices load asynchronously in Chrome (`voiceschanged`); re-check so a
    // late "no English voice" becomes the disabled state instead of a silent
    // no-op on the first play.
    useEffect(() => {
        if (!hasSpeechSynthesis()) {
            setVoice('missing');
            return;
        }
        const refresh = () => setVoice(detectSpeechVoice());
        refresh();
        const synth = window.speechSynthesis;
        synth.addEventListener?.('voiceschanged', refresh);
        return () => synth.removeEventListener?.('voiceschanged', refresh);
    }, []);

    // Keyboard: once the bar is on screen it behaves like a media player.
    // Text fields keep their own Space/arrows (typing must never be hijacked).
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (event.altKey || event.ctrlKey || event.metaKey) return;
            if (isTextEntryTarget(event.target)) return;
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
        voice,
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
