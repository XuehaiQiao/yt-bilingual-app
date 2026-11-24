// Feedback API (v1.1 P0, P2-39): POST /api/feedback.
//
// Signed-in users and guests can both send feedback (the backend rate-limits
// by session/IP). Every submission carries a client-generated `requestId` so a
// learner can quote one string when something goes wrong and an operator can
// find the exact request log line. The id is generated once per dialog opening
// and shown read-only in the form — never asked from the user.
import { apiFetch } from './api';
import { describeApiError } from './toast';
import { getRuntimeLanguage, translate, type LanguageCode, type TranslationKey } from '../i18n';

export type FeedbackCategory = 'bug' | 'feature' | 'content' | 'other';

export interface FeedbackCategoryMeta {
  id: FeedbackCategory;
  labelKey: TranslationKey;
  hintKey: TranslationKey;
}

/**
 * Categories the backend accepts today (`bug` / `feature` / `content` / `other`).
 * Translation / analysis mistakes are filed under `content` — the panel hint
 * says so; adding a client-only enum would 400 on the real endpoint.
 */
export const FEEDBACK_CATEGORIES: readonly FeedbackCategoryMeta[] = [
  { id: 'bug', labelKey: 'feedback.category.bug', hintKey: 'feedback.category.bugHint' },
  { id: 'feature', labelKey: 'feedback.category.feature', hintKey: 'feedback.category.featureHint' },
  { id: 'content', labelKey: 'feedback.category.content', hintKey: 'feedback.category.contentHint' },
  { id: 'other', labelKey: 'feedback.category.other', hintKey: 'feedback.category.otherHint' },
];

/** Keep in sync with the backend's description length cap (P2-39). */
export const FEEDBACK_DESCRIPTION_MAX = 2000;
/** Below this the report is too vague to act on; the backend also rejects it. */
export const FEEDBACK_DESCRIPTION_MIN = 5;

export interface FeedbackInput {
  category: FeedbackCategory;
  description: string;
  /** Auto-generated correlation id shown in the dialog. */
  requestId: string;
}

export interface FeedbackReceipt {
  requestId: string;
  /** Backend row id when it returns one; absent is still success. */
  id: string | null;
}

export class FeedbackApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'FeedbackApiError';
    this.status = status;
  }
}

/**
 * Generate a correlation id. `crypto.randomUUID` is available in every browser
 * the PWA supports; the timestamp+random fallback keeps the form usable in an
 * older embedded webview without throwing.
 */
export function createRequestId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the deterministic-ish fallback.
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `fb-${Date.now().toString(36)}-${random}`;
}

/** The page a report came from, so operators can reproduce it. */
export function currentPageRef(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.pathname}${window.location.hash}`.slice(0, 300);
}

export async function submitFeedback(input: FeedbackInput): Promise<FeedbackReceipt> {
  const description = input.description.trim();
  if (description.length < FEEDBACK_DESCRIPTION_MIN) {
    throw new FeedbackApiError(
      translate(getRuntimeLanguage(), 'feedback.error.tooShort'),
      400,
    );
  }
  if (description.length > FEEDBACK_DESCRIPTION_MAX) {
    throw new FeedbackApiError(
      translate(getRuntimeLanguage(), 'feedback.error.tooLong'),
      400,
    );
  }
  const res = await apiFetch('/api/feedback', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      category: input.category,
      description,
      requestId: input.requestId,
      page: currentPageRef(),
    }),
  });
  const payload = await res.json().catch(() => null) as
    | { id?: unknown; requestId?: unknown; ok?: unknown }
    | null;
  if (!res.ok) {
    throw new FeedbackApiError(await describeFeedbackError(res), res.status);
  }
  return {
    requestId: typeof payload?.requestId === 'string' ? payload.requestId : input.requestId,
    id: typeof payload?.id === 'string' ? payload.id : null,
  };
}

/** Localized message for a failed feedback submission. */
export function feedbackErrorMessage(error: unknown, language: LanguageCode): string {
  if (error instanceof FeedbackApiError) {
    if (error.status === 404 || error.status === 501) {
      return translate(language, 'feedback.error.unavailable');
    }
    if (error.status === 429) return translate(language, 'auth.error.rateLimited');
    if (error.message.trim()) return error.message;
  }
  if (error instanceof TypeError) return translate(language, 'auth.recovery.offline');
  return translate(language, 'feedback.error.failed');
}

async function describeFeedbackError(res: Response): Promise<string> {
  if (res.status === 404 || res.status === 501) {
    return translate(getRuntimeLanguage(), 'feedback.error.unavailable');
  }
  return describeApiError(res);
}
