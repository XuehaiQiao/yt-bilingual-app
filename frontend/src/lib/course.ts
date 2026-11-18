// 12-minute course client (specs/029-course-mvp, specs/030-course-generation).
//
// The backend owns attempts, answer keys, scoring and events. This module is a
// thin typed wrapper around `/api/course/*`: every call goes through `apiFetch`
// (session cookie + optional API key), accepts an AbortSignal for the screen's
// unmount path, and turns non-2xx responses into `CourseApiError` so the UI can
// distinguish "lesson gone" from "network down".
//
// The served lesson is sanitised: questions carry `id/prompt/options` only, so
// correctness and explanations come exclusively from the answer endpoint. The
// client never guesses an answer key.
import { api, apiFetch } from './api';

/** The one private-beta lesson this vertical slice ships. */
export const COURSE_MVP_LESSON_ID = 'ocean-noise-12min';

export type CourseStepType = 'intro' | 'words' | 'read' | 'output';
export type CourseAttemptStatus = 'in_progress' | 'completed' | 'abandoned';

export type CourseEventName =
    | 'lesson_start'
    | 'step_view'
    | 'step_complete'
    | 'answer'
    | 'output_submit'
    | 'lesson_complete'
    | 'drop';

export interface CourseWordPoint {
    id: string;
    kind: 'word' | 'form';
    word: string;
    ipa?: string;
    /** Chinese gloss; course content is authored in zh-CN today. */
    meaning: string;
    cefr?: string;
    example?: string;
    note?: string;
}

export interface CourseParagraph {
    en: string;
    zh: string;
}

export interface CourseOption {
    id: string;
    text: string;
}

/** Sanitised question: no `answer`/`explain` from the lesson endpoint. */
export interface CourseQuestion {
    id: string;
    prompt: string;
    options: CourseOption[];
}

export interface CourseStep {
    id: string;
    type: CourseStepType;
    title: string;
    minutes?: number;
    body?: string;
    bullets?: string[];
    points?: CourseWordPoint[];
    paragraphs?: CourseParagraph[];
    explain?: string;
    questions?: CourseQuestion[];
    prompt?: string;
    targetWords?: string[];
    wordRange?: Record<string, [number, number]>;
    rubric?: string[];
    sample?: string;
    exitTicket?: CourseQuestion[];
}

export interface CourseLesson {
    schema?: string;
    id: string;
    version: number;
    status?: string;
    title: string;
    titleZh?: string;
    level?: string;
    durationMinutes?: number;
    source?: {
        kind?: string;
        articleId?: string;
        license?: string;
        attribution?: string;
    };
    goal?: string;
    steps: CourseStep[];
}

export interface CourseLessonSummary {
    id: string;
    title: string;
    titleZh?: string;
    level?: string;
    durationMinutes?: number;
    status?: string;
    version: number;
}

/** Source kinds `POST /api/course/generate` accepts (specs/030). */
export type CourseGenerationSourceKind = 'youtube' | 'novel';

export type GenerateCourseInput =
    | { sourceKind: 'youtube'; videoId: string; level?: string }
    | { sourceKind: 'novel'; gutenbergId: number; chapter: number; level?: string };

/** `POST /api/course/generate` response: a ready-to-open generated lesson. */
export interface GeneratedCourse {
    lessonId: string;
    title: string;
    level: string;
    sourceKind: CourseGenerationSourceKind;
    /** True when the backend served an existing lesson without a model call. */
    cached: boolean;
    status: string;
}

export interface CourseAttempt {
    attemptId: string;
    /** Full lesson when the endpoint embeds it; the screen uses the detail call. */
    lesson: CourseLesson | null;
    status: CourseAttemptStatus;
    currentStepId: string;
    answers: Record<string, string>;
    output: string;
    startedAt: number | null;
    resumed?: boolean;
    score: number | null;
    total: number | null;
    completedAt: number | null;
}

export interface CourseAnswerResult {
    questionId: string;
    choice: string;
    correct: boolean;
    correctChoice?: string;
    explanation?: string;
}

export interface CourseOutputResult {
    text: string;
    wordCount: number;
}

export interface CourseCompleteAnswer {
    questionId: string;
    choice: string;
    correct: boolean;
}

export interface CourseCompleteResult {
    score: number;
    total: number;
    answers: CourseCompleteAnswer[];
    output: string;
    completedAt: number | null;
}

export type CourseErrorCode =
    | 'unauthorized'
    | 'forbidden'
    | 'lesson_not_found'
    | 'attempt_not_found'
    | 'not_found'
    | 'incomplete'
    | 'conflict'
    | 'source_not_ready'
    | 'generation_failed'
    | 'validation'
    | 'rate_limited'
    | 'server'
    | 'network'
    | 'aborted'
    | 'invalid_response'
    | 'unknown';

export class CourseApiError extends Error {
    readonly status: number;
    readonly code: CourseErrorCode;

    constructor(status: number, code: CourseErrorCode, message = '') {
        super(message || code);
        this.name = 'CourseApiError';
        this.status = status;
        this.code = code;
    }
}

export function isCourseAbortError(error: unknown): boolean {
    return error instanceof CourseApiError
        ? error.code === 'aborted'
        : error instanceof DOMException && error.name === 'AbortError';
}

function statusCode(status: number, body: unknown): CourseErrorCode {
    const record = isRecord(body) ? body : {};
    const detail = isRecord(record.detail) ? record.detail : {};
    const error = isRecord(record.error) ? record.error : {};
    const detailText = typeof record.detail === 'string'
        ? record.detail
        : typeof detail.message === 'string'
            ? detail.message
            : typeof error.message === 'string'
                ? error.message
                : '';
    const prefixedCode = detailText.match(/^([a-z][a-z0-9_]*)\s*[：:]/)?.[1] ?? '';
    const raw =
        (typeof record.code === 'string' && record.code) ||
        (typeof detail.code === 'string' && detail.code) ||
        (typeof error.code === 'string' && error.code) ||
        prefixedCode;
    if (raw) {
        switch (raw) {
            case 'unauthorized':
            case 'not_authenticated':
            case 'auth_required':
                return 'unauthorized';
            case 'forbidden':
                return 'forbidden';
            case 'lesson_not_found':
            case 'attempt_not_found':
            case 'incomplete':
            case 'conflict':
            case 'source_not_ready':
            case 'generation_failed':
            case 'validation':
            case 'rate_limited':
            case 'not_found':
                return raw;
            case 'attempt_completed':
            case 'attempt_closed':
            case 'answer_locked':
                return 'conflict';
            case 'output_too_long':
            case 'invalid_step':
            case 'invalid_choice':
            case 'question_not_found':
            case 'invalid_event':
            case 'invalid_payload':
            case 'payload_too_large':
                return 'validation';
            default:
                break;
        }
    }
    if (status === 401) return 'unauthorized';
    if (status === 403) return 'forbidden';
    if (status === 404) return 'not_found';
    if (status === 409) return 'conflict';
    if (status === 429) return 'rate_limited';
    if (status >= 500) return 'server';
    if (status === 400 || status === 422) return 'validation';
    return 'unknown';
}

async function readJson(response: Response): Promise<unknown> {
    return response.json().catch(() => null);
}

function errorMessage(body: unknown): string {
    if (!isRecord(body)) return '';
    if (typeof body.detail === 'string') return body.detail;
    if (typeof body.message === 'string') return body.message;
    if (isRecord(body.detail) && typeof body.detail.message === 'string') return body.detail.message;
    if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message;
    return '';
}

async function request<T>(
    path: string,
    init: RequestInit | undefined,
    fallbackCode?: CourseErrorCode,
): Promise<T> {
    let response: Response;
    try {
        response = await apiFetch(path, init);
    } catch (error) {
        if (isAbortError(error)) {
            throw new CourseApiError(0, 'aborted');
        }
        throw new CourseApiError(0, 'network');
    }
    const body = await readJson(response);
    if (!response.ok) {
        const code = fallbackCode === 'lesson_not_found' && response.status === 404
            ? 'lesson_not_found'
            : fallbackCode === 'attempt_not_found' && response.status === 404
                ? 'attempt_not_found'
                : statusCode(response.status, body);
        throw new CourseApiError(response.status, code, errorMessage(body));
    }
    return body as T;
}

function isAbortError(error: unknown): boolean {
    return error instanceof DOMException && error.name === 'AbortError';
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function normalizeQuestion(raw: unknown): CourseQuestion | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.prompt !== 'string') return null;
    const options = Array.isArray(raw.options)
        ? raw.options
            .map((option): CourseOption | null => {
                if (!isRecord(option) || typeof option.id !== 'string' || typeof option.text !== 'string') {
                    return null;
                }
                return { id: option.id, text: option.text };
            })
            .filter((option): option is CourseOption => option !== null)
        : [];
    if (options.length === 0) return null;
    return { id: raw.id, prompt: raw.prompt, options };
}

function normalizeWordPoint(raw: unknown): CourseWordPoint | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.word !== 'string') return null;
    return {
        id: raw.id,
        kind: raw.kind === 'form' ? 'form' : 'word',
        word: raw.word,
        ipa: asString(raw.ipa),
        meaning: asString(raw.meaning) ?? '',
        cefr: asString(raw.cefr),
        example: asString(raw.example),
        note: asString(raw.note),
    };
}

function normalizeStep(raw: unknown): CourseStep | null {
    if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.title !== 'string') return null;
    const type: CourseStepType = raw.type === 'intro' || raw.type === 'words' || raw.type === 'read' || raw.type === 'output'
        ? raw.type
        : 'read';
    const paragraphs = Array.isArray(raw.paragraphs)
        ? raw.paragraphs
            .map((paragraph): CourseParagraph | null => {
                if (!isRecord(paragraph) || typeof paragraph.en !== 'string') return null;
                return { en: paragraph.en, zh: asString(paragraph.zh) ?? '' };
            })
            .filter((paragraph): paragraph is CourseParagraph => paragraph !== null)
        : undefined;
    const questions = Array.isArray(raw.questions)
        ? raw.questions.map(normalizeQuestion).filter((question): question is CourseQuestion => question !== null)
        : undefined;
    const exitTicket = Array.isArray(raw.exitTicket)
        ? raw.exitTicket.map(normalizeQuestion).filter((question): question is CourseQuestion => question !== null)
        : undefined;
    let wordRange: Record<string, [number, number]> | undefined;
    if (isRecord(raw.wordRange)) {
        wordRange = {};
        for (const [key, value] of Object.entries(raw.wordRange)) {
            if (Array.isArray(value) && value.length === 2
                && typeof value[0] === 'number' && typeof value[1] === 'number') {
                wordRange[key] = [value[0], value[1]];
            }
        }
    }
    return {
        id: raw.id,
        type,
        title: raw.title,
        minutes: asNumber(raw.minutes) ?? undefined,
        body: asString(raw.body),
        bullets: Array.isArray(raw.bullets)
            ? raw.bullets.filter((bullet): bullet is string => typeof bullet === 'string')
            : undefined,
        points: Array.isArray(raw.points)
            ? raw.points.map(normalizeWordPoint).filter((point): point is CourseWordPoint => point !== null)
            : undefined,
        paragraphs,
        explain: asString(raw.explain),
        questions,
        prompt: asString(raw.prompt),
        targetWords: Array.isArray(raw.targetWords)
            ? raw.targetWords.filter((word): word is string => typeof word === 'string')
            : undefined,
        wordRange,
        rubric: Array.isArray(raw.rubric)
            ? raw.rubric.filter((item): item is string => typeof item === 'string')
            : undefined,
        sample: asString(raw.sample),
        exitTicket,
    };
}

export function normalizeCourseLesson(raw: unknown): CourseLesson {
    const source = isRecord(raw) && isRecord(raw.lesson) ? raw.lesson : raw;
    if (!isRecord(source) || typeof source.id !== 'string' || !Array.isArray(source.steps)) {
        throw new CourseApiError(200, 'invalid_response');
    }
    const steps = source.steps
        .map(normalizeStep)
        .filter((step): step is CourseStep => step !== null);
    if (steps.length === 0) throw new CourseApiError(200, 'invalid_response');
    return {
        schema: asString(source.schema),
        id: source.id,
        version: typeof source.version === 'number' ? source.version : 1,
        status: asString(source.status),
        title: typeof source.title === 'string' ? source.title : source.id,
        titleZh: asString(source.titleZh),
        level: asString(source.level),
        durationMinutes: asNumber(source.durationMinutes) ?? undefined,
        source: isRecord(source.source)
            ? {
                kind: asString(source.source.kind),
                articleId: asString(source.source.articleId),
                license: asString(source.source.license),
                attribution: asString(source.source.attribution),
            }
            : undefined,
        goal: asString(source.goal),
        steps,
    };
}

function normalizeAnswers(raw: unknown): Record<string, string> {
    let value = raw;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return {};
        }
    }
    if (!isRecord(value)) return {};
    const answers: Record<string, string> = {};
    for (const [questionId, choice] of Object.entries(value)) {
        if (typeof choice === 'string') answers[questionId] = choice;
    }
    return answers;
}

function normalizeOutput(raw: unknown): string {
    if (typeof raw === 'string') return raw;
    if (isRecord(raw) && typeof raw.text === 'string') return raw.text;
    return '';
}

export function normalizeCourseAttempt(raw: unknown): CourseAttempt {
    const source = isRecord(raw) && isRecord(raw.attempt) ? raw.attempt : raw;
    if (!isRecord(source)) throw new CourseApiError(200, 'invalid_response');
    const attemptId =
        asString(source.attemptId) || asString(source.attempt_id) || asString(source.id) || '';
    if (!attemptId) throw new CourseApiError(200, 'invalid_response');
    const status: CourseAttemptStatus =
        source.status === 'completed' || source.status === 'abandoned' ? source.status : 'in_progress';
    let lesson: CourseLesson | null = null;
    if (isRecord(source.lesson)) {
        try {
            lesson = normalizeCourseLesson(source.lesson);
        } catch {
            lesson = null;
        }
    }
    return {
        attemptId,
        lesson,
        status,
        currentStepId:
            asString(source.currentStepId) || asString(source.current_step_id) || 'S0',
        answers: normalizeAnswers(source.answers ?? source.answersJson ?? source.answers_json),
        output: normalizeOutput(source.output ?? source.outputText ?? source.output_text),
        startedAt: asNumber(source.startedAt) ?? asNumber(source.started_at),
        resumed: source.resumed === true,
        score: asNumber(source.score),
        total: asNumber(source.total),
        completedAt: asNumber(source.completedAt) ?? asNumber(source.completed_at),
    };
}

function normalizeSummary(raw: unknown): CourseLessonSummary | null {
    if (!isRecord(raw) || typeof raw.id !== 'string') return null;
    return {
        id: raw.id,
        title: asString(raw.title) ?? raw.id,
        titleZh: asString(raw.titleZh),
        level: asString(raw.level),
        durationMinutes: asNumber(raw.durationMinutes) ?? undefined,
        status: asString(raw.status),
        version: typeof raw.version === 'number' ? raw.version : 1,
    };
}

function normalizeGeneratedCourse(
    raw: unknown,
    fallbackSourceKind: CourseGenerationSourceKind,
    fallbackLevel?: string,
): GeneratedCourse {
    const record = isRecord(raw) ? raw : {};
    // The contract is flat; the nested forms keep us tolerant of a lesson
    // envelope while the backend and frontend land in parallel.
    const source = isRecord(record.course)
        ? record.course
        : isRecord(record.lesson)
            ? record.lesson
            : record;
    const lessonId =
        asString(source.lessonId)
        || asString(source.lesson_id)
        || asString(source.id)
        || '';
    if (!lessonId) throw new CourseApiError(200, 'invalid_response');
    const rawSourceKind = asString(source.sourceKind) || asString(source.source_kind);
    const sourceKind: CourseGenerationSourceKind =
        rawSourceKind === 'youtube' || rawSourceKind === 'novel'
            ? rawSourceKind
            : fallbackSourceKind;
    return {
        lessonId,
        title: asString(source.title) ?? lessonId,
        level: asString(source.level) ?? fallbackLevel ?? '',
        sourceKind,
        cached: source.cached === true,
        status: asString(source.status) ?? 'ready',
    };
}

/** `GET /api/course/lessons` — one private-beta lesson today. */
export async function fetchCourseLessons(signal?: AbortSignal): Promise<CourseLessonSummary[]> {
    const body = await request<unknown>('/api/course/lessons', { signal });
    const list = isRecord(body) && Array.isArray(body.lessons) ? body.lessons : [];
    return list.map(normalizeSummary).filter((lesson): lesson is CourseLessonSummary => lesson !== null);
}

/**
 * `POST /api/course/generate` — turn a processed video or a public-domain
 * novel chapter into a cached 12-minute lesson (specs/030 §4).
 *
 * 409 `source_not_ready` means the source text/translation is not ready yet;
 * 502 `generation_failed` means the model output failed validation. Both are
 * deliberately distinct from the generic course conflict/server codes so the
 * screen can show "finish subtitles first" vs "retry".
 *
 * The body carries only the source fields; `apiFetch` injects the current
 * `targetLang`, because the backend caches generated courses per target
 * language (the endpoint accepts it as an optional field).
 */
export async function generateCourse(
    input: GenerateCourseInput,
    signal?: AbortSignal,
): Promise<GeneratedCourse> {
    let body: unknown;
    try {
        body = await request<unknown>('/api/course/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(input),
            signal,
        });
    } catch (error) {
        if (error instanceof CourseApiError) {
            if (error.status === 409 && error.code === 'conflict') {
                throw new CourseApiError(409, 'source_not_ready', error.message);
            }
            if (error.status === 502 && error.code === 'server') {
                throw new CourseApiError(502, 'generation_failed', error.message);
            }
        }
        throw error;
    }
    return normalizeGeneratedCourse(body, input.sourceKind, input.level);
}

/** `GET /api/course/lessons/{id}` — sanitised lesson content. */
export async function fetchCourseLesson(
    lessonId: string,
    signal?: AbortSignal,
): Promise<CourseLesson> {
    const body = await request<unknown>(
        `/api/course/lessons/${encodeURIComponent(lessonId)}`,
        { signal },
        'lesson_not_found',
    );
    return normalizeCourseLesson(body);
}

/**
 * `POST /api/course/attempts` — starts the lesson or resumes the one open
 * attempt. The UI never inspects `resumed` to decide whether to restore: the
 * response is the single source of truth either way.
 */
export async function startCourseAttempt(
    lessonId: string,
    signal?: AbortSignal,
): Promise<CourseAttempt> {
    const body = await request<unknown>('/api/course/attempts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lessonId }),
        signal,
    });
    return normalizeCourseAttempt(body);
}

/** `GET /api/course/attempts/{id}` — the attempt plus score after completion. */
export async function fetchCourseAttempt(
    attemptId: string,
    signal?: AbortSignal,
): Promise<CourseAttempt> {
    const body = await request<unknown>(
        `/api/course/attempts/${encodeURIComponent(attemptId)}`,
        { signal },
        'attempt_not_found',
    );
    return normalizeCourseAttempt(body);
}

/** `POST .../answer` — first answer wins; the same choice is idempotent. */
export async function submitCourseAnswer(
    attemptId: string,
    questionId: string,
    choice: string,
    signal?: AbortSignal,
): Promise<CourseAnswerResult> {
    const body = await request<unknown>(
        `/api/course/attempts/${encodeURIComponent(attemptId)}/answer`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ questionId, choice }),
            signal,
        },
    );
    if (!isRecord(body) || typeof body.correct !== 'boolean') {
        throw new CourseApiError(200, 'invalid_response');
    }
    return {
        questionId: asString(body.questionId) ?? questionId,
        choice: asString(body.choice) ?? choice,
        correct: body.correct,
        correctChoice: asString(body.correctChoice),
        explanation: asString(body.explanation),
    };
}

/** `POST .../step` — persist the learner's place for refresh / re-entry. */
export async function setCourseStep(
    attemptId: string,
    stepId: string,
    signal?: AbortSignal,
): Promise<void> {
    await request<unknown>(
        `/api/course/attempts/${encodeURIComponent(attemptId)}/step`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ stepId }),
            signal,
        },
    );
}

/** `POST .../output` — save the written output (server word count). */
export async function saveCourseOutput(
    attemptId: string,
    text: string,
    signal?: AbortSignal,
): Promise<CourseOutputResult> {
    const body = await request<unknown>(
        `/api/course/attempts/${encodeURIComponent(attemptId)}/output`,
        {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text }),
            signal,
        },
    );
    const record = isRecord(body) ? body : {};
    return {
        text: asString(record.text) ?? text,
        wordCount: asNumber(record.wordCount) ?? countCourseWords(text),
    };
}

/** `POST .../complete` — requires all 8 answers + non-empty output (server). */
export async function completeCourseAttempt(
    attemptId: string,
    signal?: AbortSignal,
): Promise<CourseCompleteResult> {
    let body: unknown;
    try {
        body = await request<unknown>(
            `/api/course/attempts/${encodeURIComponent(attemptId)}/complete`,
            { method: 'POST', signal },
        );
    } catch (error) {
        // The contract uses 409 on this endpoint only for "not ready to finish"
        // (or an already-closed attempt), so surface it as `incomplete` even
        // when the backend sends a plain-text detail.
        if (error instanceof CourseApiError && error.status === 409) {
            throw new CourseApiError(409, 'incomplete', error.message);
        }
        throw error;
    }
    if (!isRecord(body) || typeof body.score !== 'number' || typeof body.total !== 'number') {
        throw new CourseApiError(200, 'invalid_response');
    }
    const answers = Array.isArray(body.answers)
        ? body.answers
            .map((answer): CourseCompleteAnswer | null => {
                if (!isRecord(answer) || typeof answer.questionId !== 'string') return null;
                return {
                    questionId: answer.questionId,
                    choice: asString(answer.choice) ?? '',
                    correct: answer.correct === true,
                };
            })
            .filter((answer): answer is CourseCompleteAnswer => answer !== null)
        : [];
    return {
        score: body.score,
        total: body.total,
        answers,
        output: normalizeOutput(body.output),
        completedAt: asNumber(body.completedAt),
    };
}

/**
 * Fire-and-forget course event. Reporting must never block the lesson or
 * surface an error, so every failure is swallowed after the request starts.
 * A 401 still reaches `apiFetch`'s global session-expiry listener (correct:
 * the session really did expire).
 */
export function sendCourseEvent(
    attemptId: string,
    event: CourseEventName,
    stepId?: string | null,
    payload?: Record<string, unknown>,
): void {
    const body: Record<string, unknown> = { event };
    if (stepId) body.stepId = stepId;
    if (payload && Object.keys(payload).length > 0) body.payload = payload;
    void apiFetch(`/api/course/attempts/${encodeURIComponent(attemptId)}/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
    }).catch(() => {
        // Best effort by design.
    });
}

/**
 * Unload path for the `drop` event. `sendBeacon` is the synchronous-ish
 * channel that survives a tab close; if the browser refuses the beacon (or
 * the API sits on another origin and the Blob is rejected) fall back to a
 * keepalive fetch through `apiFetch`, which still carries the session.
 */
export function sendCourseDropBeacon(attemptId: string, stepId?: string | null): void {
    const path = `/api/course/attempts/${encodeURIComponent(attemptId)}/events`;
    const body = JSON.stringify({
        event: 'drop',
        stepId: stepId || undefined,
        payload: { at: Date.now() },
    });
    try {
        if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
            const blob = new Blob([body], { type: 'application/json' });
            if (navigator.sendBeacon(api(path), blob)) return;
        }
    } catch {
        // Fall through to the keepalive fetch.
    }
    void apiFetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
    }).catch(() => {
        // Best effort by design.
    });
}

/**
 * Best-effort keepalive save for tab close / route exit. Unlike the normal
 * autosave this bypasses React and the abort controller: the page may already
 * be going away, so the request only has to start before unload.
 */
export function sendCourseOutputKeepalive(attemptId: string, text: string): void {
    if (!text.trim() || text.length > 2000) return;
    void apiFetch(`/api/course/attempts/${encodeURIComponent(attemptId)}/output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
        keepalive: true,
    }).catch(() => {
        // Best effort by design.
    });
}

/** Same word splitting rule the backend documents (spaces). */
export function countCourseWords(text: string): number {
    const trimmed = text.trim();
    if (!trimmed) return 0;
    return trimmed.split(/\s+/).length;
}

/** Copy for error codes; the screen resolves these through i18n. */
export function courseErrorTranslationKey(
    code: CourseErrorCode,
): 'course.error.unauthorized' | 'course.error.notFound' | 'course.error.network' | 'course.error.generic' {
    switch (code) {
        case 'unauthorized':
        case 'forbidden':
            return 'course.error.unauthorized';
        case 'lesson_not_found':
        case 'attempt_not_found':
        case 'not_found':
            return 'course.error.notFound';
        case 'network':
            return 'course.error.network';
        default:
            return 'course.error.generic';
    }
}
