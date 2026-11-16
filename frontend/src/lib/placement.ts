// Placement test client (M4 / specs/016-placement).
//
// The backend owns sampling, scoring, the CEFR band, confidence, strengths /
// weaknesses and the single rule-based advice. This module only wraps the four
// `/api/placement/*` endpoints and mirrors their JSON contract; every request
// goes through `apiFetch` (guest cookies + optional API key are attached there).
//
// Honesty rules enforced by the UI on top of this module: `preliminary`,
// `sampleSize` and `disclaimer` are rendered as the backend sent them — the
// client never turns the band into a score, never drops the disclaimer and
// never fills an estimate the backend did not provide.
import { apiFetch } from './api';
import { describeApiError } from './toast';

export type PlacementItemType = 'vocab' | 'reading';

/** One question on the served paper. The backend never sends `answerIndex`. */
export interface PlacementItem {
    /** Session-scoped id `q-01`…`q-32` (the bank id is not exposed). */
    itemId: string;
    type: PlacementItemType;
    band: string;
    /** Vocab: the English word. Reading: the question. */
    prompt: string;
    options: string[];
    /** Always true today; the UI still offers "skip" per item. */
    skippable?: boolean;
    /** Reading items only. */
    passage?: string;
}

/** `GET /api/placement/start`. */
export interface PlacementStart {
    sessionId: string;
    status: 'in_progress';
    resumed: boolean;
    attempt: number;
    startedAt: number;
    durationLimitMs: number;
    itemCount: number;
    /** `vocab` is 27 (24 real + 3 pseudo, not distinguished by the backend). */
    totals: { vocab: number; reading: number; all: number };
    instructions: string;
    items: PlacementItem[];
    preliminary: boolean;
    sampleSize: number;
    disclaimer: string;
}

/** `cefr.label` is the en-dash interval, e.g. `A2–B2`; `point` is the estimate. */
export interface PlacementCefr {
    point: string;
    low: string;
    high: string;
    label: string;
}

export interface PlacementDomainStats {
    total: number;
    answered: number;
    correct: number;
    accuracy: number;
    weightedScore: number;
    bands: Record<string, { correct: number; total: number }>;
    band: string;
    /** Vocabulary only: coarse lemma-count midpoint (A1 1500 … C1 12000). */
    estimate?: number;
}

export interface PlacementBreakdown {
    version: string;
    calibration: string;
    vocab: PlacementDomainStats & { band: string; estimate: number };
    /** M1 shim: the reading band is removed; only counts/scores remain. */
    reading: Omit<PlacementDomainStats, 'band'>;
    pseudo: { total: number; claimed: number; skipped: number; suspicion: number };
    overall: PlacementDomainStats;
    answered: number;
    skipped: number;
    durationMs: number;
    strengths: string[];
    weaknesses: string[];
    advice: string;
    measuredDomains: string[];
    notMeasured: string[];
    sampleSize: number;
    preliminary: boolean;
    disclaimer: string;
}

/** Saved ability profile (`GET /api/placement/profile` → `profile`). */
export interface PlacementProfile {
    /** Interval label, e.g. `A2–B2`. */
    cefr: string;
    levelBandLow: string;
    levelBandHigh: string;
    vocabEstimate: number | null;
    readingEstimate: string | null;
    confidence: number;
    /** `high` / `medium` / `low`. */
    confidenceLabel: string;
    confidenceLabelZh: string;
    pseudoWordSuspicion: number;
    /** Server milliseconds UTC. */
    updatedAt: number;
    /** `placement` (this release only writes this) or `user_edit`. */
    source: string;
    strengths: string[];
    weaknesses: string[];
    advice: string | null;
    measuredDomains: string[];
    notMeasured: string[];
    preliminary: boolean;
    sampleSize: number;
    disclaimer: string;
}

/** `POST /api/placement/submit` — `breakdown` + profile are embedded. */
export interface PlacementResult {
    sessionId: string;
    status: 'submitted';
    /** True when the session had already been submitted (idempotent replay). */
    reused: boolean;
    score: number;
    cefr: PlacementCefr;
    confidence: number;
    confidenceLabel: string;
    confidenceLabelZh: string;
    pseudoWordSuspicion: number;
    preliminary: boolean;
    sampleSize: number;
    durationMs: number;
    breakdown: PlacementBreakdown;
    disclaimer: string;
    profile: PlacementProfile | null;
}

export interface PlacementProfileResponse {
    profile: PlacementProfile | null;
    preliminary: boolean;
    sampleSize: number;
    disclaimer: string;
}

export interface PlacementResetResponse {
    reset: boolean;
    abandonedSessions: number;
    profileKept: boolean;
    message: string;
}

/** One submission row; `chosenIndex` -1 (or omitted) = "don't know"/skip. */
export interface PlacementAnswerInput {
    itemId: string;
    chosenIndex: number;
}

export interface SubmitPlacementInput {
    sessionId: string;
    answers: PlacementAnswerInput[];
    /** Client-measured time on the paper; the backend clamps/validates it. */
    durationMs?: number;
}

/**
 * Typed HTTP failure so the screen can distinguish "migration missing" (503),
 * "this session end ed, start a new one" (404/409) and identity problems (403)
 * from ordinary transport errors.
 */
export class PlacementApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'PlacementApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        throw new PlacementApiError(response.status, await describeApiError(response));
    }
    return (await response.json()) as T;
}

/** Start (or resume) the one in-progress placement session. */
export function startPlacement(): Promise<PlacementStart> {
    return request<PlacementStart>('/api/placement/start');
}

/** Submit the whole paper; the backend scores, saves and upserts the profile. */
export function submitPlacement({
    sessionId,
    answers,
    durationMs,
}: SubmitPlacementInput): Promise<PlacementResult> {
    const body: Record<string, unknown> = {
        sessionId,
        answers: answers.map(({ itemId, chosenIndex }) => ({ itemId, chosenIndex })),
    };
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
        body.durationMs = Math.round(durationMs);
    }
    return request<PlacementResult>('/api/placement/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Current profile, or `profile: null` when the user has never finished one. */
export function getProfile(): Promise<PlacementProfileResponse> {
    return request<PlacementProfileResponse>('/api/placement/profile');
}

/** Abandon any in-progress session; submitted history and the profile stay. */
export function resetPlacement(): Promise<PlacementResetResponse> {
    return request<PlacementResetResponse>('/api/placement/reset', { method: 'POST' });
}
