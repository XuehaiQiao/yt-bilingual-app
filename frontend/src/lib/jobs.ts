// Task (job) persistence for resumable subtitle generation (M1 ⑤).
//
// The backend persists every video-generation task: `jobId` + `cursor` survive a
// page refresh or a dropped connection. This module is the single place that
// talks to `sessionStorage` and the single call site of `GET /api/jobs/{id}`,
// so the auto-resume flow in App.tsx stays declarative.
//
// Why sessionStorage (not localStorage): a job belongs to *this* tab's stream.
// A new tab opened days later must not reconnect to a stale task; closing the
// tab drops the record, which matches "刷新/断线接着看" without cross-tab noise.
import { apiFetch } from './api';
import type { LanguageCode } from '../i18n';

/** sessionStorage key (same `yt_bilingual_` prefix as the other stores). */
export const PENDING_JOB_KEY = 'yt_bilingual_pending_job';

/** What we remember between page loads: enough to ask the server and reconnect. */
export interface PendingJob {
    jobId: string;
    videoId: string;
    url: string;
    targetLang: LanguageCode;
    /** Last block/batch cursor received (server-side `job.cursor`). */
    cursor: number;
    /** Total blocks the server expects (0 = not known yet). */
    total: number;
    updatedAt: number;
}

export type JobStatus = 'queued' | 'running' | 'partial' | 'done' | 'failed';

/** `GET /api/jobs/{id}` response (frozen shape — see backend routes_videos). */
export interface JobSnapshot {
    id: string;
    kind: string;
    contentRef: string | null;
    videoId: string | null;
    targetLang: LanguageCode;
    status: JobStatus;
    cursor: number;
    total: number;
    progress: { done: number; total: number };
    canResume: boolean;
    active: boolean;
    error: string | null;
    createdAt: number;
    updatedAt: number;
}

function storage(): Storage | null {
    try {
        return typeof window === 'undefined' ? null : window.sessionStorage;
    } catch {
        // Private mode / storage disabled: resuming is unavailable, streaming works.
        return null;
    }
}

function isPendingJob(value: unknown): value is PendingJob {
    if (!value || typeof value !== 'object') return false;
    const record = value as Record<string, unknown>;
    return (
        typeof record.jobId === 'string' &&
        record.jobId.length > 0 &&
        typeof record.videoId === 'string' &&
        typeof record.url === 'string' &&
        typeof record.targetLang === 'string' &&
        typeof record.cursor === 'number' &&
        Number.isFinite(record.cursor)
    );
}

/** Read the pending job for this tab; corrupted/legacy values are dropped. */
export function loadPendingJob(): PendingJob | null {
    const store = storage();
    if (!store) return null;
    try {
        const raw = store.getItem(PENDING_JOB_KEY);
        if (!raw) return null;
        const parsed: unknown = JSON.parse(raw);
        if (!isPendingJob(parsed)) {
            store.removeItem(PENDING_JOB_KEY);
            return null;
        }
        return {
            ...parsed,
            cursor: Math.max(0, parsed.cursor),
            total: Number.isFinite(parsed.total) ? parsed.total : 0,
            updatedAt: Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : 0,
        };
    } catch {
        return null;
    }
}

/** Replace the stored record (no-op when sessionStorage is unavailable). */
export function savePendingJob(job: PendingJob): void {
    const store = storage();
    if (!store) return;
    try {
        store.setItem(PENDING_JOB_KEY, JSON.stringify(job));
    } catch {
        // Quota/private mode: losing the record only costs a manual resubmit.
    }
}

/**
 * Merge a patch into the stored record. A `jobId` guard keeps a late event from
 * another stream (slow network, user switched video) from overwriting progress.
 */
export function updatePendingJob(
    patch: Partial<Omit<PendingJob, 'jobId'>>,
    jobId?: string,
): PendingJob | null {
    const current = loadPendingJob();
    if (!current) return null;
    if (jobId && current.jobId !== jobId) return null;
    const next: PendingJob = { ...current, ...patch, updatedAt: Date.now() };
    savePendingJob(next);
    return next;
}

/**
 * Drop the stored record. Pass the identifiers we are reacting to so a stale
 * event for a different job/video cannot erase the active one.
 */
export function clearPendingJob(match?: {
    jobId?: string;
    videoId?: string;
}): void {
    const pending = loadPendingJob();
    if (!pending) return;
    if (match?.jobId && pending.jobId !== match.jobId) return;
    if (match?.videoId && pending.videoId !== match.videoId) return;
    const store = storage();
    try {
        store?.removeItem(PENDING_JOB_KEY);
    } catch {
        // Ignore: a stale record is harmless — resume checks the server first.
    }
}

/**
 * `GET /api/jobs/{id}` — the pre-reconnect question ("should we resume?").
 *
 * Resolves `null` when the server no longer knows the job (404) or it belongs to
 * someone else (403): both mean "stop resuming". Network errors throw so the
 * caller can keep the record for the next page load instead of discarding it.
 */
export async function fetchJobSnapshot(jobId: string): Promise<JobSnapshot | null> {
    const response = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`);
    if (response.status === 404 || response.status === 403) return null;
    if (!response.ok) {
        throw new Error(`GET /api/jobs/${jobId} failed with HTTP ${response.status}`);
    }
    return (await response.json()) as JobSnapshot;
}

// ── Stream event hooks ───────────────────────────────────────────────────
// The SSE `meta` event opens the record; `batch` events advance the cursor;
// `done` (or a fully cached video without a job) clears it. Keeping the
// sessionStorage writes here — instead of in App.tsx — means the resume format
// and the reconnect logic can never drift apart.

export interface JobStreamContext {
    url: string;
    videoId: string;
    targetLang: LanguageCode;
}

export interface JobStreamMeta {
    jobId?: unknown;
    videoId?: unknown;
    cursor?: unknown;
    total?: unknown;
    resumed?: unknown;
}

function asNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Called on the SSE `meta` event: open (or refresh) the pending-job record. */
export function recordJobMeta(data: JobStreamMeta, context: JobStreamContext): void {
    const jobId = typeof data.jobId === 'string' && data.jobId ? data.jobId : null;
    const videoId =
        typeof data.videoId === 'string' && data.videoId ? data.videoId : context.videoId;
    if (!jobId) {
        // No task = fully cached video (or a backend without the jobs table):
        // nothing to resume for this video.
        clearPendingJob({ videoId });
        return;
    }
    savePendingJob({
        jobId,
        videoId,
        url: context.url,
        targetLang: context.targetLang,
        cursor: asNumber(data.cursor, 0),
        total: asNumber(data.total, 0),
        updatedAt: Date.now(),
    });
}

/** Called on SSE `batch`: persist the last cursor so a refresh resumes there. */
export function recordJobProgress(data: {
    jobId?: unknown;
    cursor?: unknown;
    total?: unknown;
}): void {
    const jobId = typeof data.jobId === 'string' ? data.jobId : undefined;
    const cursor = asNumber(data.cursor, Number.NaN);
    if (!Number.isFinite(cursor)) return;
    updatePendingJob(
        {
            cursor: Math.max(0, cursor),
            ...(typeof data.total === 'number' && Number.isFinite(data.total)
                ? { total: data.total }
                : {}),
        },
        jobId,
    );
}

/** Called on SSE `done`: the task is finished, never reconnect to it. */
export function finishJob(match?: { jobId?: unknown; videoId?: string }): void {
    const jobId =
        typeof match?.jobId === 'string' && match.jobId ? match.jobId : undefined;
    const videoId = match?.videoId;
    // With neither identifier there is nothing to safely match on: clearing
    // blindly would erase another video's pending job.
    if (!jobId && !videoId) return;
    clearPendingJob({
        ...(jobId ? { jobId } : {}),
        ...(videoId ? { videoId } : {}),
    });
}
