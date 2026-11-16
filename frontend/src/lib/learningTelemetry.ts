// CEFR M2 #7 behavior telemetry client (lookup / replay / rate / visibility).
//
// Four low-volume learning signals are queued in memory and delivered to the
// existing `POST /api/events` endpoint, which routes them to the append-only
// `learning_events` table. The module is deliberately defensive because it
// sits in the middle of the learning loop:
//
//   1. **Never blocks learning.** Every exported `note*` function catches its
//      own errors; delivery failures are silent (no toast, no thrown promise).
//   2. **No free text / PII.** Payloads are rebuilt from a small whitelist:
//      a normalized word, a source enum, seconds/rates, or a visibility state.
//      The sentence/context shown around a tapped word is *never* sent.
//   3. **Bounded + idempotent.** At most 20 events per request, 100 queued;
//      every event gets a page-load `sessionId` + monotonic `eventId`, and a
//      retry keeps the same ids so the server's unique index absorbs repeats.
//   4. **Sampled.** Dictionary lookups for the same word are ignored for 60s
//      (mirrors the server-side dedupe), replay events are throttled per
//      content, and visibility only reports transitions.
import { apiFetch } from './api';

export type DictLookupSource =
    | 'transcript'
    | 'reader'
    | 'book'
    | 'sentence'
    | 'other';

export type ReplayMethod = 'click' | 'keyboard' | 'loop' | 'seek';
export type VisibilityState = 'hidden' | 'visible';

interface EventBase {
    eventId: string;
    occurredAt: number;
    sessionId: string;
}

type EventBody =
    | {
        type: 'dict_lookup';
        contentRef?: string;
        word: string;
        lemma?: string;
        source: DictLookupSource;
    }
    | {
        type: 'video_replay';
        contentRef: string;
        fromSeconds: number;
        toSeconds: number;
        method: ReplayMethod;
    }
    | {
        type: 'playback_rate';
        contentRef: string;
        fromRate: number;
        toRate: number;
    }
    | {
        type: 'tab_visibility';
        state: VisibilityState;
        visibleSeconds: number;
    };

type QueuedEvent = EventBody & EventBase;

const MAX_BATCH = 20;
const MAX_QUEUE = 100;
const FLUSH_DELAY_MS = 1_500;
const LOOKUP_DEDUPE_MS = 60_000;
const REPLAY_THROTTLE_MS = 1_000;
const LOOP_REPLAY_THROTTLE_MS = 10_000;
const MAX_SECONDS = 86_400;
const MAX_WORD_CHARS = 64;
const MAX_CONTENT_REF_CHARS = 200;
const MIN_RATE = 0.25;
const MAX_RATE = 4;

const DICT_SOURCES: readonly DictLookupSource[] = [
    'transcript',
    'reader',
    'book',
    'sentence',
    'other',
];
const REPLAY_METHODS: readonly ReplayMethod[] = [
    'click',
    'keyboard',
    'loop',
    'seek',
];

const SESSION_ID = createSessionId();
let sequence = 0;
let queue: QueuedEvent[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushInFlight = false;
let visibilityInstalled = false;
let visibleSince: number | null = null;
const lastLookupAt = new Map<string, number>();
const lastReplayAt = new Map<string, number>();

function createSessionId(): string {
    try {
        if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
            return crypto.randomUUID();
        }
    } catch {
        // Fall through to the timestamp form below.
    }
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function nextEventId(): string {
    sequence += 1;
    return `${SESSION_ID}-${sequence}`;
}

function sanitizeWord(raw: unknown): string | null {
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    if (trimmed.length > MAX_WORD_CHARS) return null;
    if ([...trimmed].some((char) => char.charCodeAt(0) < 32)) return null;
    const normalized = trimmed.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
    return normalized && normalized.length <= MAX_WORD_CHARS ? normalized : null;
}

function sanitizeContentRef(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const text = raw.trim();
    if (!text || text.length > MAX_CONTENT_REF_CHARS) return undefined;
    if (text.includes('\\') || /\s/.test(text)) return undefined;
    return text;
}

function finiteNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampSeconds(value: number): number {
    return Math.max(0, Math.min(MAX_SECONDS, value));
}

function roundSeconds(value: number): number {
    return Math.round(clampSeconds(value) * 1000) / 1000;
}

function enqueue(event: EventBody): void {
    queue.push({
        ...event,
        eventId: nextEventId(),
        occurredAt: Date.now(),
        sessionId: SESSION_ID,
    } as QueuedEvent);
    if (queue.length > MAX_QUEUE) {
        queue.splice(0, queue.length - MAX_QUEUE);
    }
    scheduleFlush();
}

function scheduleFlush(): void {
    if (flushTimer != null || flushInFlight) return;
    flushTimer = setTimeout(() => {
        flushTimer = null;
        void flushBehaviorEvents();
    }, FLUSH_DELAY_MS);
    // Node's timers (unit tests) shouldn't hold the process open.
    if (typeof flushTimer === 'object' && flushTimer && 'unref' in flushTimer) {
        (flushTimer as unknown as { unref: () => void }).unref();
    }
}

type BatchResult = 'ok' | 'retry' | 'drop';

async function postBatch(batch: QueuedEvent[], keepalive: boolean): Promise<BatchResult> {
    try {
        const response = await apiFetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
            keepalive,
        });
        if (response.ok) return 'ok';
        // 4xx will never become valid; keep retrying would poison every flush.
        // 5xx/offline are transient.
        return response.status >= 500 ? 'retry' : 'drop';
    } catch {
        return 'retry';
    }
}

/**
 * Deliver queued behavior events in batches of at most 20. Failures are
 * silent and retried once with the same ids, then left for the next flush.
 */
export async function flushBehaviorEvents(options: { keepalive?: boolean } = {}): Promise<void> {
    if (flushInFlight) return;
    flushInFlight = true;
    try {
        while (queue.length > 0) {
            const batch = queue.slice(0, MAX_BATCH);
            const keepalive = Boolean(options.keepalive);
            let result = await postBatch(batch, keepalive);
            if (result === 'retry') {
                result = await postBatch(batch, keepalive);
            }
            if (result === 'drop') {
                queue = queue.slice(batch.length);
                continue;
            }
            if (result !== 'ok') break;
            queue = queue.slice(batch.length);
        }
    } catch {
        // Telemetry must never surface an error into the learning UI.
    } finally {
        flushInFlight = false;
        if (queue.length > 0) scheduleFlush();
    }
}

function emitVisibility(state: VisibilityState, visibleSeconds: number): void {
    enqueue({
        type: 'tab_visibility',
        state,
        visibleSeconds: Math.round(clampSeconds(visibleSeconds) * 10) / 10,
    });
}

function onVisibilityChange(): void {
    try {
        const now = Date.now();
        if (document.visibilityState === 'hidden') {
            const seconds = visibleSince == null ? 0 : (now - visibleSince) / 1000;
            visibleSince = null;
            emitVisibility('hidden', seconds);
            void flushBehaviorEvents({ keepalive: true });
            return;
        }
        visibleSince = now;
        emitVisibility('visible', 0);
        void flushBehaviorEvents({ keepalive: true });
    } catch {
        // A broken visibility listener must never break the page.
    }
}

function flushOnPageHide(): void {
    void flushBehaviorEvents({ keepalive: true });
}

/**
 * Install the visibility/pagehide listeners once. Idempotent; called by App on
 * mount (and lazily by every `note*` function).
 */
export function installLearningTelemetry(): void {
    if (visibilityInstalled) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    visibilityInstalled = true;
    if (document.visibilityState === 'visible') visibleSince = Date.now();
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', flushOnPageHide);
}

function ensureInstalled(): void {
    installLearningTelemetry();
}

/**
 * Record that the dictionary card was opened for a word. `contentRef` is the
 * video/article/book id; the surrounding sentence is intentionally never
 * accepted as an argument.
 */
export function noteDictLookup(input: {
    word: string;
    lemma?: string;
    contentRef?: string;
    source?: DictLookupSource;
}): void {
    try {
        const word = sanitizeWord(input.word);
        if (!word) return;
        const now = Date.now();
        const last = lastLookupAt.get(word);
        if (last != null && now - last < LOOKUP_DEDUPE_MS) return;
        lastLookupAt.set(word, now);
        if (lastLookupAt.size > 200) {
            for (const [key, at] of lastLookupAt) {
                if (now - at >= LOOKUP_DEDUPE_MS) lastLookupAt.delete(key);
            }
        }
        const lemma = input.lemma ? sanitizeWord(input.lemma) ?? undefined : undefined;
        const source = input.source && DICT_SOURCES.includes(input.source)
            ? input.source
            : 'other';
        const contentRef = sanitizeContentRef(input.contentRef);
        ensureInstalled();
        enqueue({
            type: 'dict_lookup',
            word,
            ...(lemma ? { lemma } : {}),
            ...(contentRef ? { contentRef } : {}),
            source,
        });
    } catch {
        // Never let telemetry break word lookup.
    }
}

/**
 * Record a backwards seek / replay. Forwards playback is intentionally not a
 * replay event (the caller also only reports jumps larger than ~1.5s).
 */
export function noteVideoReplay(input: {
    contentRef?: string;
    fromSeconds: number;
    toSeconds: number;
    method?: ReplayMethod;
}): void {
    try {
        const contentRef = sanitizeContentRef(input.contentRef);
        const from = finiteNumber(input.fromSeconds);
        const to = finiteNumber(input.toSeconds);
        if (!contentRef || from == null || to == null) return;
        if (from < 0 || to < 0 || from > MAX_SECONDS || to > MAX_SECONDS) return;
        if (to >= from || from - to < 0.5) return;
        const method = input.method && REPLAY_METHODS.includes(input.method)
            ? input.method
            : 'seek';
        const now = Date.now();
        const last = lastReplayAt.get(contentRef);
        const throttle = method === 'loop' ? LOOP_REPLAY_THROTTLE_MS : REPLAY_THROTTLE_MS;
        if (last != null && now - last < throttle) return;
        lastReplayAt.set(contentRef, now);
        ensureInstalled();
        enqueue({
            type: 'video_replay',
            contentRef,
            fromSeconds: roundSeconds(from),
            toSeconds: roundSeconds(to),
            method,
        });
    } catch {
        // Never let telemetry break playback.
    }
}

/** Record a user-initiated playback-rate change (from → to). */
export function notePlaybackRate(input: {
    contentRef?: string;
    fromRate: number;
    toRate: number;
}): void {
    try {
        const contentRef = sanitizeContentRef(input.contentRef);
        const from = finiteNumber(input.fromRate);
        const to = finiteNumber(input.toRate);
        if (!contentRef || from == null || to == null) return;
        if (from < MIN_RATE || from > MAX_RATE || to < MIN_RATE || to > MAX_RATE) return;
        if (Math.abs(from - to) < 1e-6) return;
        ensureInstalled();
        enqueue({
            type: 'playback_rate',
            contentRef,
            fromRate: from,
            toRate: to,
        });
    } catch {
        // Never let telemetry break playback controls.
    }
}
