// Exam practice client (V2 / specs/022-exam-practice, frontend).
//
// The backend owns sampling, grading and history. This module only wraps the
// four `/api/exam/*` endpoints and mirrors their JSON contract; every request
// goes through `apiFetch` (session cookie + optional API key are attached
// there).
//
// Honesty rules enforced by the UI on top of this module: the response only
// carries `correct` / `total` / `answered` / `unanswered` and per-item
// correctness — there is no score, percentage, predicted grade or pass rate.
// The client must not synthesize one, and must render the backend `disclaimer`
// as sent.
import { apiFetch } from './api';
import { describeApiError } from './toast';

export type ExamItemType = 'vocab' | 'grammar' | 'reading';

/** One reading passage; only reading items embed one. */
export interface ExamPassage {
    id: string;
    title: string;
    text: string;
}

/** One question on the served paper. The backend never sends `answerIndex`. */
export interface ExamItem {
    itemId: string;
    type: ExamItemType;
    band: string;
    topic: string;
    prompt: string;
    options: string[];
    /** Reading items only. */
    passage?: ExamPassage;
}

/** One row of `GET /api/exam/types`. */
export interface ExamTypeOption {
    id: string;
    label: string;
    /** Size of the static bank (30 today). */
    itemCount: number;
    /** Items served per practice (10 today). */
    sessionItemCount: number;
    description: string;
    disclaimer: string;
}

export interface ExamTypesResponse {
    types: ExamTypeOption[];
    disclaimer: string;
}

/** `POST /api/exam/start` — a fresh paper or the one still in progress. */
export interface ExamStartResponse {
    sessionId: string;
    examType: string;
    label: string;
    status: 'in_progress';
    /** True when the server reused the existing unsubmitted session. */
    resumed: boolean;
    startedAt: number;
    itemCount: number;
    totals: { vocab: number; grammar: number; reading: number; all: number };
    instructions: string;
    items: ExamItem[];
    disclaimer: string;
}

/** Per-question grading row on the submit response. */
export interface ExamResultItem extends ExamItem {
    /** `null` when the item was left unanswered. */
    chosenIndex: number | null;
    correctIndex: number;
    correct: boolean;
    answered: boolean;
    explanation: string;
}

/** `POST /api/exam/submit` — grading only, never a score. */
export interface ExamSubmitResponse {
    sessionId: string;
    examType: string;
    label: string;
    status: 'submitted';
    /** True when this session had already been submitted (idempotent replay). */
    reused: boolean;
    startedAt: number;
    submittedAt: number;
    durationMs: number | null;
    correct: number;
    total: number;
    answered: number;
    unanswered: number;
    items: ExamResultItem[];
    disclaimer: string;
}

/** One submitted practice row; deliberately has no score field. */
export interface ExamHistorySession {
    sessionId: string;
    examType: string;
    label: string;
    startedAt: number;
    submittedAt: number;
    /** Server ISO timestamp (fallback if `submittedAt` is absent). */
    date: string;
    correct: number;
    total: number;
    answered: number;
    durationMs: number | null;
}

export interface ExamHistoryResponse {
    sessions: ExamHistorySession[];
    limit: number;
    disclaimer: string;
}

/** One submitted answer; unanswered items are simply omitted. */
export interface ExamAnswerInput {
    itemId: string;
    chosenIndex: number;
}

export interface SubmitExamInput {
    sessionId: string;
    answers: ExamAnswerInput[];
    /** Client-measured practice time; the backend clamps/validates it. */
    durationMs?: number;
}

/**
 * Typed HTTP failure so the screen can distinguish "not logged in" (403),
 * "this session ended" (404/409) and "practice unavailable" (503) from an
 * ordinary transport error.
 */
export class ExamApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ExamApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        throw new ExamApiError(response.status, await describeApiError(response));
    }
    return (await response.json()) as T;
}

/** Available practice types (static bank; current only `cet4`). */
export function getExamTypes(): Promise<ExamTypesResponse> {
    return request<ExamTypesResponse>('/api/exam/types');
}

/** Start a practice, or resume the one unsubmitted session. */
export function startExam(type: string): Promise<ExamStartResponse> {
    return request<ExamStartResponse>('/api/exam/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
    });
}

/** Submit answers; the backend grades and returns per-item explanations. */
export function submitExam({ sessionId, answers, durationMs }: SubmitExamInput): Promise<ExamSubmitResponse> {
    const body: Record<string, unknown> = {
        sessionId,
        answers: answers.map(({ itemId, chosenIndex }) => ({ itemId, chosenIndex })),
    };
    if (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0) {
        body.durationMs = Math.round(durationMs);
    }
    return request<ExamSubmitResponse>('/api/exam/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Submitted practices, newest first (date/label/correct/total only). */
export function getExamHistory(limit = 20): Promise<ExamHistoryResponse> {
    const safe = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 100) : 20;
    return request<ExamHistoryResponse>(`/api/exam/history?limit=${safe}`);
}
