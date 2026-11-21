// Review engine client (specs/013-review-engine).
//
// The backend owns every scheduling decision: this module only wraps the four
// HTTP endpoints the review screen needs. All requests go through `apiFetch`,
// which attaches the current translation target language — the review queue
// and stats are scoped by it, so switching the target language never mixes
// decks. Time values are milliseconds UTC; formatting belongs to the UI.
import { apiFetch } from './api';
import { describeApiError } from './toast';

/** FSRS answer grades, ordered from "forgot" to "too easy". */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

export const REVIEW_RATINGS: readonly ReviewRating[] = ['again', 'hard', 'good', 'easy'];

export type ReviewWordState = 'new' | 'learning' | 'review' | 'relearning' | 'suspended';

export interface ReviewWordSource {
    contentRef?: string | null;
    sentenceId?: string | null;
    createdAt?: number;
}

/** One tracked word as returned by the API (`step`/`fail_streak` stay private). */
export interface ReviewWord {
    id: string;
    lemma: string;
    targetLang: string;
    state: ReviewWordState;
    dueAt: number;
    stability: number | null;
    difficulty: number | null;
    reps: number;
    lapses: number;
    failStreak: number;
    lastReviewedAt: number | null;
    createdAt: number;
    sources: ReviewWordSource[];
}

export interface ReviewQueueCounts {
    due: number;
    new: number;
    total: number;
}

export interface ReviewQueue {
    targetLang: string;
    now: number;
    limit: number;
    newLimit: number;
    counts: ReviewQueueCounts;
    /** Cards scheduled now, oldest due first. */
    due: ReviewWord[];
    /** Never-seen words, oldest added first. */
    new: ReviewWord[];
    /** `due + new` — the order the screen consumes. */
    items: ReviewWord[];
}

export interface ReviewStats {
    targetLang: string | null;
    now: number;
    /** UTC calendar day, e.g. `2026-11-15` (backend "today" boundary). */
    today: string;
    dueToday: number;
    dueNow: number;
    reviewedToday: number;
    reviewedWordsToday: number;
    newWords: number;
    newToday: number;
    totalWords: number;
    suspendedWords: number;
    streakDays: number;
}

export interface ReviewAnswerResult {
    status: 'ok';
    word: ReviewWord;
    suspended: boolean;
    autoSuspended: boolean;
    dueAt: number;
}

export interface ReviewSuspendResult {
    status: 'ok';
    suspended: boolean;
    word: ReviewWord;
}

/**
 * Suspended words waiting for a restore (specs/013). `targetLang` stays null
 * when the request did not scope by language; `total` is the unpaged count.
 */
export interface ReviewSuspendedList {
    targetLang: string | null;
    now: number;
    total: number;
    words: ReviewWord[];
}

export interface AnswerWordInput {
    lemma: string;
    rating: ReviewRating;
    /** Time spent on the card before grading; optional for older callers. */
    elapsedMs?: number;
}

/**
 * Typed HTTP failure so the UI can distinguish "review needs an account"
 * (403) from a transient network/backend error and localize each one.
 */
export class ReviewApiError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ReviewApiError';
        this.status = status;
    }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await apiFetch(path, init);
    if (!response.ok) {
        throw new ReviewApiError(response.status, await describeApiError(response));
    }
    return (await response.json()) as T;
}

/** Due words first, then unseen words — `items` is already the deck order. */
export function getReviewQueue(limit = 20, newLimit = 10): Promise<ReviewQueue> {
    const params = new URLSearchParams({
        limit: String(limit),
        newLimit: String(newLimit),
    });
    return request<ReviewQueue>(`/api/review/queue?${params.toString()}`);
}

/** Today's counts for the review header and the home entry card. */
export function getReviewStats(): Promise<ReviewStats> {
    return request<ReviewStats>('/api/review/stats');
}

/** Record one grade; the server advances the FSRS state and returns the word. */
export function answerWord({ lemma, rating, elapsedMs }: AnswerWordInput): Promise<ReviewAnswerResult> {
    const body: Record<string, unknown> = { lemma, rating };
    if (typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
        body.elapsedMs = Math.round(elapsedMs);
    }
    return request<ReviewAnswerResult>('/api/review/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
}

/** Manually suspend a word so it leaves the queue (idempotent on the server). */
export function suspendWord(lemma: string): Promise<ReviewSuspendResult> {
    return request<ReviewSuspendResult>('/api/review/suspend', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lemma }),
    });
}

/**
 * Words currently paused (auto-suspended after 3 `again` grades, or manual),
 * most recently touched first. Omitting `targetLang` covers every language —
 * the restore dialog lists the word's own language on each row.
 */
export function getSuspendedWords(limit = 100): Promise<ReviewSuspendedList> {
    const params = new URLSearchParams({ limit: String(limit) });
    return request<ReviewSuspendedList>(`/api/review/suspended?${params.toString()}`);
}

/**
 * Put a suspended word back into the queue (idempotent). The server clears its
 * fail streak; `targetLang` is optional only because the backend falls back to
 * zh-CN — callers restoring a listed word should pass its own language.
 */
export function restoreWord(lemma: string, targetLang?: string): Promise<ReviewSuspendResult> {
    const params = new URLSearchParams({ lemma });
    if (targetLang) params.set('targetLang', targetLang);
    return request<ReviewSuspendResult>(`/api/review/suspend?${params.toString()}`, {
        method: 'DELETE',
    });
}
