// Account lifecycle API client (M2b UI for specs/033 / backend M2a).
//
// The backend owns every rule: 7-day deletion cooldown, one pending request per
// user, export quotas (1/24h, 3/30d), a single in-flight export job, 24h
// temporary files and a download token that only appears in the 202 response.
// This module only carries types, request helpers and the stable-`code` → copy
// mapping, so screens never parse Chinese/English backend prose.
//
// Error bodies are `{detail, code}` with an optional `Retry-After` header; the
// password-confirmation endpoints share one local rate limiter.
import { apiFetch } from './api';
import { getRuntimeLanguage, type TranslationKey, type TranslationParams } from '../i18n';

/** The literal the backend requires as the deletion confirmation word. */
export const DELETE_CONFIRM_WORD = 'DELETE';

export type AccountStatus = 'active' | 'banned' | 'deletion_pending';
export type DeletionRequestStatus = 'pending' | 'cancelled' | 'completed' | 'failed';
export type ExportJobStatus = 'queued' | 'running' | 'ready' | 'failed' | 'expired';

export interface DeletionRequestInfo {
  id: string;
  status: DeletionRequestStatus;
  requestedAt: number;
  dueAt: number;
  verifiedVia: string;
  reason: string | null;
  completedAt: number | null;
  counts: Record<string, number> | null;
  error: string | null;
}

export interface DeletionState {
  status: AccountStatus | string;
  dueAt: number | null;
  deletion: DeletionRequestInfo | null;
  cooldownDays: number;
  backupRetentionDays: number;
  notice: string;
}

export interface DeletionSubmitResult {
  status: string;
  requestedAt: number;
  dueAt: number;
  sessionsRevoked: boolean;
  cooldownDays: number;
  backupRetentionDays: number;
  deletion: DeletionRequestInfo;
}

export interface CancelDeletionResult {
  status: 'active';
  cancelledAt: number;
  cooldownDays: number;
  backupRetentionDays: number;
}

export interface ExportJob {
  id: string;
  status: ExportJobStatus;
  requestedAt: number;
  completedAt: number | null;
  expiresAt: number | null;
  sizeBytes: number | null;
  downloadedAt: number | null;
  error: string | null;
  downloadable: boolean;
}

export interface ExportLimits {
  per24h: number;
  per30d: number;
  ttlHours: number;
  maxBytes: number;
  concurrentJobs: number;
}

export interface ExportsResponse {
  jobs: ExportJob[];
  limits: ExportLimits;
}

export interface CreateExportResult {
  jobId: string;
  status: ExportJobStatus;
  requestedAt: number;
  expiresAt: number;
  /** Plaintext token, returned by this 202 response only. */
  downloadToken: string;
  downloadPath: string;
  limits: ExportLimits;
}

export interface DeletionSubmitInput {
  password: string;
  username: string;
  confirm: string;
  reason?: string;
}

/**
 * A lifecycle failure with the HTTP status and the backend's stable `code`.
 * `retryAfter` is seconds (body `retryAfter` or the `Retry-After` header).
 */
export class LifecycleApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly retryAfter?: number;
  /** `24h` / `30d` for export quota errors. */
  readonly window?: string;

  constructor(
    message: string,
    status: number,
    options: { code?: string; retryAfter?: number; window?: string } = {},
  ) {
    super(message);
    this.name = 'LifecycleApiError';
    this.status = status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
    this.window = options.window;
  }
}

interface LifecycleErrorBody {
  detail?: unknown;
  code?: unknown;
  retryAfter?: unknown;
  window?: unknown;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : undefined;
}

/** Read a failed response into a `LifecycleApiError` (never throws on bad JSON). */
export async function readLifecycleError(response: Response): Promise<LifecycleApiError> {
  const body = (await response.json().catch(() => null)) as LifecycleErrorBody | null;
  const detail = typeof body?.detail === 'string' && body.detail.trim() ? body.detail : '';
  const headerRetry = Number(response.headers.get('Retry-After'));
  const retryAfter = positiveNumber(body?.retryAfter)
    ?? (Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined);
  return new LifecycleApiError(
    detail || `HTTP ${response.status}`,
    response.status,
    {
      code: typeof body?.code === 'string' ? body.code : undefined,
      retryAfter,
      window: typeof body?.window === 'string' ? body.window : undefined,
    },
  );
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw await readLifecycleError(response);
  try {
    return (await response.json()) as T;
  } catch {
    throw new LifecycleApiError('invalid lifecycle payload', response.status);
  }
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  return requestJson<T>(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** `GET /api/account/deletion` — status, due date and the latest request. */
export function fetchDeletionState(): Promise<DeletionState> {
  return requestJson<DeletionState>('/api/account/deletion');
}

/** `POST /api/account/deletion` (202) — enters the cooldown and revokes sessions. */
export function requestDeletion(input: DeletionSubmitInput): Promise<DeletionSubmitResult> {
  return postJson<DeletionSubmitResult>('/api/account/deletion', {
    password: input.password,
    username: input.username,
    confirm: input.confirm,
    ...(input.reason?.trim() ? { reason: input.reason.trim() } : {}),
  });
}

/** `POST /api/account/deletion/cancel` — password-confirmed return to active. */
export function cancelDeletion(password: string): Promise<CancelDeletionResult> {
  return postJson<CancelDeletionResult>('/api/account/deletion/cancel', { password });
}

/** `GET /api/account/exports` — jobs and current limits (no tokens). */
export function fetchExports(): Promise<ExportsResponse> {
  return requestJson<ExportsResponse>('/api/account/exports');
}

/** `POST /api/account/export` (202) — the only place the download token exists. */
export function createExport(password: string): Promise<CreateExportResult> {
  return postJson<CreateExportResult>('/api/account/export', { password });
}

export interface ExportDownload {
  blob: Blob;
  filename: string;
}

/**
 * `GET /api/account/export/{jobId}?token=` — fetch the ZIP as a blob so the
 * one-time token never lands in the URL bar/history and failures stay readable
 * instead of navigating the tab to a JSON error page.
 */
export async function downloadExport(jobId: string, token: string): Promise<ExportDownload> {
  const response = await apiFetch(
    `/api/account/export/${encodeURIComponent(jobId)}?token=${encodeURIComponent(token)}`,
  );
  if (!response.ok) throw await readLifecycleError(response);
  const blob = await response.blob();
  if (blob.size === 0) {
    // A 200 with no body means the server-side file vanished mid-download; map
    // it to the export-failed copy instead of leaking an English dev message.
    throw new LifecycleApiError('empty export', response.status, { code: 'export_failed' });
  }
  return { blob, filename: `linguatrek-export-${jobId}.zip` };
}

/** `DELETE /api/account/export/{jobId}` — removes the temp file (idempotent). */
export function deleteExport(jobId: string): Promise<{ ok?: boolean; status?: string }> {
  return requestJson(`/api/account/export/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

// ── Download tokens ────────────────────────────────────────────────────────
// The backend only returns the token in the create response, so a reload would
// otherwise strand a ready file. Keep it tab-scoped in sessionStorage (cleared
// when the tab closes) instead of localStorage; it is the same secret the 202
// already handed to JS, never the httpOnly session cookie.
const TOKEN_PREFIX = 'linguatrek.export.token.';

export function readExportToken(jobId: string): string | null {
  try {
    return window.sessionStorage.getItem(`${TOKEN_PREFIX}${jobId}`);
  } catch {
    return null;
  }
}

export function storeExportToken(jobId: string, token: string): void {
  try {
    window.sessionStorage.setItem(`${TOKEN_PREFIX}${jobId}`, token);
  } catch {
    // Private mode / storage disabled: the in-memory state still works this page.
  }
}

export function clearExportToken(jobId: string): void {
  try {
    window.sessionStorage.removeItem(`${TOKEN_PREFIX}${jobId}`);
  } catch {
    // Ignore: nothing to clean up.
  }
}

// ── Localized errors ───────────────────────────────────────────────────────

export type Translate = (key: TranslationKey, params?: TranslationParams) => string;

const ERROR_KEYS: Record<string, TranslationKey> = {
  password_invalid: 'account.errors.passwordInvalid',
  password_rate_limited: 'account.errors.passwordRateLimited',
  confirmation_invalid: 'account.errors.confirmationInvalid',
  deletion_already_pending: 'account.errors.deletionAlreadyPending',
  deletion_not_pending: 'account.errors.deletionNotPending',
  deletion_not_due: 'account.errors.deletionNotDue',
  deletion_not_found: 'account.errors.deletionNotFound',
  deletion_completed: 'account.errors.deletionCompleted',
  deletion_failed: 'account.errors.deletionFailed',
  last_admin: 'account.errors.lastAdmin',
  invalid_reason: 'account.errors.invalidReason',
  user_not_found: 'account.errors.deletionNotFound',
  lifecycle_unavailable: 'account.errors.unavailable',
  export_busy: 'account.errors.exportBusy',
  export_rate_limited: 'account.errors.exportRateLimited',
  export_not_ready: 'account.errors.exportNotReady',
  export_not_found: 'account.errors.exportNotFound',
  export_failed: 'account.errors.exportFailed',
  export_expired: 'account.errors.exportExpired',
  export_token_invalid: 'account.errors.exportTokenInvalid',
};

/** Translation key for a known lifecycle `code` (admin screens reuse this). */
export function lifecycleErrorKey(code: string | undefined): TranslationKey | undefined {
  return code ? ERROR_KEYS[code] : undefined;
}

/** Human duration for `Retry-After` / `retryAfter` seconds (localized). */
export function formatRetryAfter(seconds: number | undefined, t: Translate): string {
  const total = Math.max(1, Math.ceil(seconds ?? 60));
  if (total >= 3600) {
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    return t('account.retryAfter.hours', {
      hours: String(hours),
      minutes: String(minutes),
    });
  }
  if (total >= 60) {
    return t('account.retryAfter.minutes', { minutes: String(Math.ceil(total / 60)) });
  }
  return t('account.retryAfter.seconds', { seconds: String(total) });
}

/**
 * Map a lifecycle failure to readable copy. Known codes win (and keep the
 * retry window); unknown server prose is only echoed in Chinese, otherwise the
 * UI would leak an untranslated backend message into the vi-VN interface.
 */
export function lifecycleErrorText(error: unknown, t: Translate): string {
  if (error instanceof LifecycleApiError) {
    const key = lifecycleErrorKey(error.code);
    if (key) {
      if (error.code === 'password_rate_limited' || error.code === 'export_rate_limited') {
        return t(key, { duration: formatRetryAfter(error.retryAfter, t) });
      }
      return t(key);
    }
    if (getRuntimeLanguage() === 'zh-CN' && error.message) return error.message;
    return t('account.errors.generic');
  }
  if (error instanceof TypeError) return t('account.errors.network');
  if (error instanceof Error && error.message) return error.message;
  return t('account.errors.generic');
}
