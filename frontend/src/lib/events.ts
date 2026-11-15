// Watch-event client (specs/015-weekly-report, M5 frontend).
//
// The backend owns aggregation: this module only turns actual playback
// progress into small `watch` events and delivers them in batches. Three
// rules shape the implementation:
//
//   1. `watchedSeconds` counts *playback movement*, not wall-clock time:
//      pause leaves the position unchanged (no tick → no seconds) and a seek
//      jump is far larger than a normal polling interval (ignored, baseline
//      reset). A background tab that delivers 1–2s ticks still counts.
//   2. Delivery is best-effort and never blocks the player. Events are queued
//      in memory, sent ≤50 at a time, and a failed batch is retried exactly
//      once with the *same* `clientEventId`s so the server's
//      `UNIQUE(user_id, client_event_id)` can absorb the duplicate.
//   3. Leaving the page flushes synchronously-ish with `fetch(keepalive)`;
//      every 60s of playback and every pause also flushes, so a crash costs
//      at most one minute of watch time.
import { apiFetch } from './api';
import { getRuntimeTargetLang } from '../i18n';

export type WatchKind = 'video' | 'local_show';

export interface WatchTarget {
    /** Video id for YouTube; `<show>_SxxEyy` for local episodes. */
    contentRef: string;
    kind: WatchKind;
}

interface WatchEventPayload {
    type: 'watch';
    contentRef: string;
    kind: WatchKind;
    targetLang: string;
    watchedSeconds: number;
    positionSeconds: number;
    occurredAt: number;
    clientEventId: string;
}

interface ActiveWatch extends WatchTarget {
    targetLang: string;
    /** Unemitted playback seconds (fractional; emitted as whole seconds). */
    pendingSeconds: number;
    lastPosition: number | null;
    /** Timestamp of the last position sample, used only for diagnostics. */
    lastSampleAt: number | null;
    /** Emits the pending segment every 60s of continuous playback. */
    segmentTimer: ReturnType<typeof setInterval> | null;
}

const MAX_BATCH = 50;
const SEGMENT_INTERVAL_MS = 60_000;
// A normal poll moves ≤0.2s (100ms at 2×). Anything above this is a seek.
const MAX_PLAYBACK_STEP_SECONDS = 2;
// A paused-then-resumed tab can report a large gap once; if the position did
// not move correspondingly, don't count it. This is a seatbelt, not a clock:
// the primary signal stays the playback position delta.
const MAX_RESUME_GAP_SECONDS = 30;
const MAX_QUEUED_EVENTS = 400;

// Per page load. Retries keep the same ids; a reload starts a new namespace
// so a fresh event can never be mistaken for a retry of an older one.
const SESSION_ID = createSessionId();
let sequence = 0;
let queue: WatchEventPayload[] = [];
let active: ActiveWatch | null = null;
let flushInFlight = false;
let retryTimer: ReturnType<typeof setInterval> | null = null;
let listenersInstalled = false;

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

function nextClientEventId(): string {
    sequence += 1;
    return `${SESSION_ID}-${sequence}`;
}

function clampPosition(position: number): number {
    if (!Number.isFinite(position) || position < 0) return 0;
    return Math.min(position, 86_400);
}

function enqueue(event: Omit<WatchEventPayload, 'clientEventId'>): void {
    queue.push({ ...event, clientEventId: nextClientEventId() });
    if (queue.length > MAX_QUEUED_EVENTS) {
        queue.splice(0, queue.length - MAX_QUEUED_EVENTS);
    }
}

/** Turn the unemitted seconds of the active segment into one queued event. */
function emitPendingSegment(): void {
    if (!active) return;
    const whole = Math.floor(active.pendingSeconds);
    if (whole < 1 || active.lastPosition == null) return;
    active.pendingSeconds -= whole;
    enqueue({
        type: 'watch',
        contentRef: active.contentRef,
        kind: active.kind,
        targetLang: active.targetLang,
        watchedSeconds: whole,
        positionSeconds: Math.round(clampPosition(active.lastPosition)),
        occurredAt: Date.now(),
    });
}

function clearSegmentTimer(): void {
    if (active?.segmentTimer) clearInterval(active.segmentTimer);
    if (active) active.segmentTimer = null;
}

function ensureSegmentTimer(): void {
    if (!active || active.segmentTimer) return;
    active.segmentTimer = setInterval(() => {
        emitPendingSegment();
        void flushWatch();
    }, SEGMENT_INTERVAL_MS);
}

function installListeners(): void {
    if (listenersInstalled || typeof window === 'undefined' || typeof document === 'undefined') return;
    listenersInstalled = true;

    // Backgrounding a tab is the most common way a session ends without a
    // cleanup callback: emit what we have and hand it to keepalive fetch.
    const flushForPageHide = () => {
        emitPendingSegment();
        void flushWatch({ keepalive: true });
    };
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') flushForPageHide();
    });
    window.addEventListener('pagehide', flushForPageHide);

    // Retry queued events after a transient network outage without waiting
    // for the user to touch the player again.
    retryTimer = setInterval(() => {
        if (queue.length > 0) void flushWatch();
    }, SEGMENT_INTERVAL_MS);
    if (typeof retryTimer === 'object' && retryTimer && 'unref' in retryTimer) {
        // Node's timers (unit tests) shouldn't hold the process open.
        (retryTimer as unknown as { unref: () => void }).unref();
    }
}

type BatchResult = 'ok' | 'retry' | 'drop';

async function postBatch(batch: WatchEventPayload[], keepalive: boolean): Promise<BatchResult> {
    try {
        const response = await apiFetch('/api/events', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ events: batch }),
            keepalive,
        });
        if (response.ok) return 'ok';
        // 4xx means this batch will never be accepted (bad payload/identity);
        // keep retrying would poison every future flush. 5xx is transient.
        return response.status >= 500 ? 'retry' : 'drop';
    } catch {
        // Offline, aborted by the browser, CORS... keep it for the next flush.
        return 'retry';
    }
}

/**
 * Send queued events in batches of ≤50. Failures are silent (watch reporting
 * must never surface an error while the user is watching) and retried once
 * with the same ids before the batch stays in the queue for the next flush.
 */
export async function flushWatch(options: { keepalive?: boolean } = {}): Promise<void> {
    installListeners();
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
    } finally {
        flushInFlight = false;
    }
}

/** Begin (or continue) counting for the currently open content. */
export function startWatch(target: WatchTarget): void {
    installListeners();
    if (!target.contentRef) return;
    if (active && active.contentRef === target.contentRef && active.kind === target.kind) {
        return;
    }
    if (active) endWatch();
    active = {
        contentRef: target.contentRef,
        kind: target.kind,
        targetLang: getRuntimeTargetLang(),
        pendingSeconds: 0,
        lastPosition: null,
        lastSampleAt: null,
        segmentTimer: null,
    };
}

/**
 * Feed one playback position sample (seconds) from the player. Safe to call
 * on every tick: pause produces no call, seeks reset the baseline.
 */
export function notePlayback(positionSeconds: number): void {
    if (!active || !Number.isFinite(positionSeconds)) return;
    const position = clampPosition(positionSeconds);
    const now = Date.now();

    if (active.lastPosition == null) {
        active.lastPosition = position;
        active.lastSampleAt = now;
        return;
    }

    const delta = position - active.lastPosition;
    const wallGap = active.lastSampleAt == null ? 0 : (now - active.lastSampleAt) / 1000;

    if (delta > 0 && delta <= MAX_PLAYBACK_STEP_SECONDS) {
        active.pendingSeconds += delta;
        ensureSegmentTimer();
    } else if (delta > MAX_PLAYBACK_STEP_SECONDS && wallGap < MAX_RESUME_GAP_SECONDS) {
        // A seek/loop jump. Keep the new position as the baseline without
        // counting the skipped span.
    }

    active.lastPosition = position;
    active.lastSampleAt = now;
}

/**
 * Playback stopped (pause, quiz, background). Emit the current segment and
 * try to deliver immediately; counting resumes on the next tick.
 */
export function pauseWatch(positionSeconds?: number): void {
    if (!active) return;
    if (positionSeconds != null && Number.isFinite(positionSeconds)) {
        notePlayback(positionSeconds);
    }
    clearSegmentTimer();
    emitPendingSegment();
    void flushWatch();
}

/** Content switched or closed: finish the segment and deliver everything. */
export function endWatch(): void {
    if (!active) return;
    clearSegmentTimer();
    emitPendingSegment();
    active = null;
    void flushWatch();
}
