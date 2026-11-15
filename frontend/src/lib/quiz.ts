// Lesson comprehension quiz client (M3 / specs/014-quiz).
//
// The backend owns question generation, scoring and evidence timestamps; this
// module only wraps the four `/api/lesson/*` endpoints. Everything goes through
// `apiFetch`, which attaches the current translation target language where the
// endpoint accepts it (`POST /api/lesson/start`); the lesson id scopes the rest.
import { apiFetch } from './api';
import { describeApiError } from './toast';

export type QuizQuestionType = 'mcq' | 'tf';
export type LessonKind = 'video' | 'local_show';

/** Evidence block and its playback time: seconds for the player, ms for asserts. */
export interface QuizEvidence {
    blockId: number | string | null;
    /** Seconds on the subtitle timeline — hand this to the player's seek. */
    start: number | null;
    end: number | null;
    startMs: number | null;
    endMs: number | null;
}

/** A question before answering — the backend hides answers/explanations. */
export interface QuizQuestion {
    id: string;
    ordinal: number;
    questionType: QuizQuestionType;
    prompt: string;
    /** 4 options for `mcq`, 2 for `tf`. */
    options: string[];
}

/** `POST /api/lesson/start` and `GET /api/lesson/{id}/questions`. */
export interface LessonQuestions {
    lessonId: string;
    status: 'draft' | 'ready';
    kind: LessonKind;
    contentRef: string;
    targetLang: string;
    contentHash: string;
    questions: QuizQuestion[];
}

export interface StartLessonInput {
    kind: LessonKind;
    /** YouTube videoId, or `<show_id>-S01E01` for a local episode. */
    contentRef: string;
}

export interface AnswerQuestionInput {
    questionId: string;
    chosenIndex: number;
    /** Time spent on the question; optional and clamped by the server. */
    elapsedMs?: number;
}

/** `POST /api/lesson/answer` — grading, explanation and evidence. */
export interface QuizAnswer {
    correct: boolean;
    answerIndex: number;
    chosenIndex: number;
    explanation: string;
    evidence: QuizEvidence;
    lessonId: string;
    questionId: string;
    questionType: QuizQuestionType;
    attemptId: number | null;
    answeredAt: number;
}

/** One wrong attempt in `GET /api/lesson/{id}/result`. */
export interface QuizWrongQuestion {
    attemptId: number;
    questionId: string;
    questionType: QuizQuestionType;
    prompt: string;
    chosenIndex: number;
    answerIndex: number;
    explanation: string;
    evidence: QuizEvidence;
    correct: false;
    answeredAt: number;
    elapsedMs: number | null;
}

/** `GET /api/lesson/{id}/result` — server-authoritative session stats. */
export interface QuizResult {
    lessonId: string;
    status: 'draft' | 'ready';
    kind: LessonKind;
    contentRef: string;
    targetLang: string;
    totalQuestions: number;
    answered: number;
    correct: number;
    wrong: number;
    /** 0..1; format as a percentage in the UI. */
    correctRate: number;
    wrongQuestions: QuizWrongQuestion[];
    lastAnsweredAt: number | null;
}

/**
 * Typed HTTP failure so the entry point can distinguish "no subtitle cache"
 * (404) or "too few bilingual lines" (422) from ordinary failures and show
 * the matching localized hint instead of a raw backend message.
 */
export class QuizApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'QuizApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        throw new QuizApiError(response.status, await describeApiError(response));
    }
    return (await response.json()) as T;
}

/** Ensure a lesson exists for this content (model is called only on a miss). */
export function startLesson({ kind, contentRef }: StartLessonInput): Promise<LessonQuestions> {
    return request<LessonQuestions>('/api/lesson/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, contentRef }),
    });
}

/** Refetch the approved questions of an existing lesson. */
export function getQuestions(lessonId: string): Promise<LessonQuestions> {
    return request<LessonQuestions>(`/api/lesson/${encodeURIComponent(lessonId)}/questions`);
}

/** Record one answer; the server grades it and returns the evidence time. */
export function answerQuestion({
    questionId,
    chosenIndex,
    elapsedMs,
}: AnswerQuestionInput): Promise<QuizAnswer> {
    const body: Record<string, unknown> = { questionId, chosenIndex };
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
        body.elapsedMs = Math.round(elapsedMs);
    }
    return request<QuizAnswer>('/api/lesson/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Correct rate and the wrong-answer evidence list for the result screen. */
export function getResult(lessonId: string): Promise<QuizResult> {
    return request<QuizResult>(`/api/lesson/${encodeURIComponent(lessonId)}/result`);
}
