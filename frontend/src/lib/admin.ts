// Admin console API client — specs/021-admin + specs/023-user-profile.
//
// The read endpoints are the original stop-the-bleed snapshot; the mutation
// helpers (credits / ban state / settings) were added by specs/023 and are the
// only writes the console performs. Every call goes through `apiFetch`, so the
// httpOnly session cookie and the shared 401 handling apply unchanged.
import { apiFetch } from './api';
import type { TranslationKey } from '../i18n';
import type {
  AdminBalanceAdjustResult,
  AdminBalanceDirection,
  AdminBillingSummary,
  AdminLedgerPage,
} from './billing';

export interface AdminUsersStats {
  total: number;
  new7d: number;
  activeToday: number;
  guests: number;
}

export interface AdminFeatureUsage {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AdminStats {
  users: AdminUsersStats;
  ai: {
    todayCostUsd: number;
    monthCostUsd: number;
    todayCalls: number;
    todayByFeature: Record<string, AdminFeatureUsage>;
  };
  jobs: { failed: number; running: number; pendingRetry: number };
  generatedAt: string;
}

export type AdminUserStatus = 'active' | 'banned';

export interface AdminUserRow {
  /** First 8 characters of the user id (enough for support, no full id leak). */
  id: string;
  /** Full user id — the credits/status endpoints require it. */
  userId: string;
  email: string;
  /** Display name; null for accounts created before usernames existed. */
  username: string | null;
  /**
   * Frozen pre-M3 balance in the legacy `credits` unit (display as history
   * only; never a billing amount). `balanceMicroUsd` is the real balance.
   */
  credits: number;
  /** Real AI balance in integer µUSD (M3a). */
  balanceMicroUsd?: number;
  /** Same value as a USD string, for debugging; the UI formats from µUSD. */
  balanceUsd?: string;
  status: AdminUserStatus;
  /** Epoch milliseconds. */
  createdAt: number;
  monthCostUsd: number;
  eventCount: number;
  /** Epoch milliseconds; null when the user never produced events/attempts. */
  lastActiveAt: number | null;
}

export interface AdminUsersPage {
  users: AdminUserRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export interface AdminUsageRow {
  day: string;
  feature: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface AdminUsageDay {
  day: string;
  calls: number;
  costUsd: number;
}

export interface AdminUsage {
  days: number;
  start: string;
  end: string;
  rows: AdminUsageRow[];
  daysSummary: AdminUsageDay[];
  totals: { calls: number; inputTokens: number; outputTokens: number; costUsd: number };
}

export interface AdminFailedJob {
  id: string;
  userId: string;
  kind: string;
  contentRef: string;
  error: string;
  updatedAt: number;
}

export interface AdminHealth {
  health: {
    status: 'ok' | 'degraded' | string;
    version: string | null;
    db: {
      ok: boolean;
      migrations: { current: string | null; head: string | null };
    };
    uptimeSeconds: number;
    time: string | null;
  };
  disk: { dataDir: string; sizeBytes: number };
  failedJobs: AdminFailedJob[];
}

/** `GET/PUT /api/admin/settings` payload (specs/023 §5). */
export interface AdminSettings {
  maintenance_mode: boolean;
  announcement: string | null;
}

export interface AdminSettingsPatch {
  maintenance_mode?: boolean;
  /** `null` clears the announcement; omitting the field keeps it. */
  announcement?: string | null;
}

// ── Invite codes (specs/032 / M1 G1 invite-only registration) ──────────────

export type AdminInviteStatus = 'active' | 'used' | 'expired' | 'revoked';
export type AdminInviteStatusFilter = AdminInviteStatus | 'all';

export interface AdminInviteRow {
  id: string;
  /** First 6 characters of the normalized code; enough to tell codes apart. */
  prefix: string;
  label: string | null;
  maxUses: number;
  usedCount: number;
  status: AdminInviteStatus;
  createdBy: string;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds; null = never expires. */
  expiresAt: number | null;
  revokedAt: number | null;
  revokedBy: string | null;
  lastUsedAt: number | null;
}

export interface AdminInviteCounts {
  active: number;
  used: number;
  expired: number;
  revoked: number;
}

export interface AdminInvitePage {
  invites: AdminInviteRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  status: AdminInviteStatusFilter;
  counts: AdminInviteCounts;
  config: AdminRegistrationConfig;
}

/** Server-side registration switches (read-only in the console). */
export interface AdminRegistrationConfig {
  registrationOpen: boolean;
  inviteSignupEnabled: boolean;
  inviteRequired: boolean;
  registrationClosed: boolean;
}

/** One generated code — `code` is plaintext and only returned once. */
export interface AdminInviteGenerated {
  id: string;
  code: string;
  prefix: string;
  label: string | null;
  maxUses: number;
  usedCount: number;
  createdAt: number;
  expiresAt: number | null;
}

export interface AdminInvitesCreated {
  codes: AdminInviteGenerated[];
  config: AdminRegistrationConfig;
}

export interface AdminInviteCreateInput {
  count?: number;
  label?: string;
  maxUses?: number;
  expiresInDays?: number;
}

export interface AdminInviteRevoked {
  invite: AdminInviteRow;
  alreadyRevoked: boolean;
}

/** `PATCH /api/admin/users/{id}` response user (full id). */
export interface AdminUpdatedUser {
  id: string;
  email: string;
  username: string | null;
  credits: number;
  status: AdminUserStatus;
  createdAt: number;
}

export class AdminApiError extends Error {
  readonly status: number;
  /** Stable backend error code (e.g. `deletion_not_due`); absent on old routes. */
  readonly code?: string;
  /** Seconds from `Retry-After` (password/export rate limits). */
  readonly retryAfter?: number;

  constructor(
    message: string,
    status: number,
    options: { code?: string; retryAfter?: number } = {},
  ) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
    this.code = options.code;
    this.retryAfter = options.retryAfter;
  }
}

interface AdminErrorInfo {
  message: string;
  code?: string;
  retryAfter?: number;
}

async function readError(response: Response): Promise<AdminErrorInfo> {
  const headerRetry = Number(response.headers.get('Retry-After'));
  try {
    const data = (await response.json()) as {
      detail?: unknown;
      code?: unknown;
      retryAfter?: unknown;
    };
    const info: AdminErrorInfo = {
      message: response.statusText || `HTTP ${response.status}`,
      code: typeof data?.code === 'string' ? data.code : undefined,
      retryAfter:
        typeof data?.retryAfter === 'number' && data.retryAfter > 0
          ? data.retryAfter
          : Number.isFinite(headerRetry) && headerRetry > 0
            ? headerRetry
            : undefined,
    };
    if (typeof data?.detail === 'string' && data.detail.trim()) {
      return { ...info, message: data.detail };
    }
    if (Array.isArray(data?.detail) && data.detail.length > 0) {
      // FastAPI validation errors: keep the first human-readable message.
      const first = data.detail[0] as { msg?: unknown } | null;
      if (first && typeof first.msg === 'string' && first.msg.trim()) {
        return { ...info, message: first.msg };
      }
    }
    return info;
  } catch {
    // Non-JSON error body: fall through to the status text.
    return {
      message: response.statusText || `HTTP ${response.status}`,
      retryAfter:
        Number.isFinite(headerRetry) && headerRetry > 0 ? headerRetry : undefined,
    };
  }
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) {
    const info = await readError(response);
    throw new AdminApiError(info.message, response.status, {
      code: info.code,
      retryAfter: info.retryAfter,
    });
  }
  try {
    return (await response.json()) as T;
  } catch {
    throw new AdminApiError('invalid admin payload', -1);
  }
}

export function fetchAdminStats(): Promise<AdminStats> {
  return requestJson<AdminStats>('/api/admin/stats');
}

export function fetchAdminUsers(options: {
  limit?: number;
  offset?: number;
  search?: string;
} = {}): Promise<AdminUsersPage> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const search = (options.search ?? '').trim();
  if (search) params.set('search', search);
  const query = params.toString();
  return requestJson<AdminUsersPage>(`/api/admin/users${query ? `?${query}` : ''}`);
}

export function fetchAdminUsage(days = 7): Promise<AdminUsage> {
  return requestJson<AdminUsage>(`/api/admin/usage?days=${encodeURIComponent(String(days))}`);
}

export function fetchAdminHealth(): Promise<AdminHealth> {
  return requestJson<AdminHealth>('/api/admin/health');
}

/**
 * @deprecated M3b — legacy `credits` unit (`POST .../credits`).
 *
 * Kept only for old callers/tests: the backend still accepts it for
 * compatibility, but it does **not** touch `balance_micro_usd` and therefore
 * cannot pay for AI calls. The console uses
 * {@link adjustAdminUserBalance} instead.
 */
export function adjustAdminUserCredits(
  userId: string,
  delta: number,
  reason: string,
): Promise<{ credits: number }> {
  return requestJson<{ credits: number }>(
    `/api/admin/users/${encodeURIComponent(userId)}/credits`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delta, reason }),
    },
  );
}

/**
 * Manual micro-USD balance adjustment (M3b, `POST /api/admin/users/{id}/balance`).
 *
 * Exactly one of `amountUsd` (string, ≤6 decimals) / `amountMicroUsd` is sent;
 * the console always sends the USD string so the admin types what the user
 * owes/paid. `idempotencyKey` makes a retried request replay the original
 * ledger row instead of charging twice. The backend owns the ±$100 cap, the
 * "reason required" rule and the "cannot debit below zero" check (400/409).
 */
export function adjustAdminUserBalance(
  userId: string,
  input: {
    amountUsd?: string;
    amountMicroUsd?: number;
    direction: AdminBalanceDirection;
    reason: string;
    idempotencyKey?: string;
  },
): Promise<AdminBalanceAdjustResult> {
  return requestJson<AdminBalanceAdjustResult>(
    `/api/admin/users/${encodeURIComponent(userId)}/balance`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.amountUsd !== undefined ? { amountUsd: input.amountUsd } : {}),
        ...(input.amountMicroUsd !== undefined
          ? { amountMicroUsd: input.amountMicroUsd }
          : {}),
        direction: input.direction,
        reason: input.reason,
        ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      }),
    },
  );
}

/** A user's append-only balance ledger, newest first (limit ≤ 100). */
export function fetchAdminUserLedger(
  userId: string,
  options: { limit?: number; offset?: number } = {},
): Promise<AdminLedgerPage> {
  const params = new URLSearchParams();
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return requestJson<AdminLedgerPage>(
    `/api/admin/users/${encodeURIComponent(userId)}/ledger${query ? `?${query}` : ''}`,
  );
}

/**
 * Billing/cost summary (`GET /api/admin/billing/summary`).
 *
 * `from` / `to` are `usage_date` days (`YYYY-MM-DD`, inclusive). Money is
 * returned as integer µUSD plus a display string; the UI formats from µUSD.
 */
export function fetchAdminBillingSummary(
  options: { from?: string; to?: string } = {},
): Promise<AdminBillingSummary> {
  const params = new URLSearchParams();
  if (options.from) params.set('from', options.from);
  if (options.to) params.set('to', options.to);
  const query = params.toString();
  return requestJson<AdminBillingSummary>(
    `/api/admin/billing/summary${query ? `?${query}` : ''}`,
  );
}

/** Ban (`banned`) or unban (`active`) a user. */
export function updateAdminUserStatus(
  userId: string,
  status: AdminUserStatus,
): Promise<{ user: AdminUpdatedUser }> {
  return requestJson<{ user: AdminUpdatedUser }>(
    `/api/admin/users/${encodeURIComponent(userId)}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    },
  );
}

export function fetchAdminSettings(): Promise<AdminSettings> {
  return requestJson<AdminSettings>('/api/admin/settings');
}

export function saveAdminSettings(patch: AdminSettingsPatch): Promise<AdminSettings> {
  return requestJson<AdminSettings>('/api/admin/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
}


export function fetchAdminInvites(options: {
  status?: AdminInviteStatusFilter;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminInvitePage> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return requestJson<AdminInvitePage>(`/api/admin/invites${query ? `?${query}` : ''}`);
}

/** Generate 1–10 invites; the plaintext `code` is only in this response. */
export function createAdminInvites(
  input: AdminInviteCreateInput,
): Promise<AdminInvitesCreated> {
  return requestJson<AdminInvitesCreated>('/api/admin/invites', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
}

export function revokeAdminInvite(inviteId: string): Promise<AdminInviteRevoked> {
  return requestJson<AdminInviteRevoked>(
    `/api/admin/invites/${encodeURIComponent(inviteId)}/revoke`,
    { method: 'POST' },
  );
}


// ── Account lifecycle (M2b / specs/033): deletion requests + audit ─────────

export type AdminDeletionRequestStatus = 'pending' | 'cancelled' | 'completed' | 'failed';
export type AdminDeletionStatusFilter = AdminDeletionRequestStatus | 'all';

/** Present only while the user row still exists; `null` after a hard delete. */
export interface AdminDeletionRequestUser {
  userId: string;
  email: string;
  username: string | null;
  status: string;
}

export interface AdminDeletionRequestRow {
  id: string;
  status: AdminDeletionRequestStatus;
  requestedAt: number;
  dueAt: number;
  verifiedVia: string;
  reason: string | null;
  completedAt: number | null;
  counts: Record<string, number> | null;
  error: string | null;
  /** sha256(user_id) — the only identity left after a completed deletion. */
  userIdHash: string;
  operatorId: string | null;
  /** pending && dueAt <= serverTime. */
  overdue: boolean;
  user: AdminDeletionRequestUser | null;
}

export interface AdminDeletionRequestsPage {
  requests: AdminDeletionRequestRow[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  serverTime: number;
}

export interface AdminDeletionExecuteResult {
  status: 'completed';
  userIdHash: string;
  counts: Record<string, number>;
  request: AdminDeletionRequestRow | { id: string; status: string };
}

export interface AdminAuditEntry {
  id: number;
  actorId: string;
  action: string;
  targetType: string;
  targetId: string | null;
  detail: Record<string, unknown> | string | null;
  requestId: string | null;
  createdAt: number;
}

export interface AdminAuditPage {
  entries: AdminAuditEntry[];
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export function fetchAdminDeletionRequests(options: {
  status?: AdminDeletionStatusFilter;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminDeletionRequestsPage> {
  const params = new URLSearchParams();
  if (options.status) params.set('status', options.status);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return requestJson<AdminDeletionRequestsPage>(
    `/api/admin/deletion-requests${query ? `?${query}` : ''}`,
  );
}

/**
 * `POST /api/admin/deletion-requests/{id}/execute` — hard delete.
 * Backend requires `confirm: "DELETE"`, a 1–200 char reason and `force` when
 * the cooldown has not elapsed (409 `deletion_not_due`).
 */
export function executeAdminDeletion(
  requestId: string,
  input: { confirm: string; reason: string; force?: boolean },
): Promise<AdminDeletionExecuteResult> {
  return requestJson<AdminDeletionExecuteResult>(
    `/api/admin/deletion-requests/${encodeURIComponent(requestId)}/execute`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        confirm: input.confirm,
        reason: input.reason,
        force: input.force === true,
      }),
    },
  );
}

export function fetchAdminAudit(options: {
  action?: string;
  limit?: number;
  offset?: number;
} = {}): Promise<AdminAuditPage> {
  const params = new URLSearchParams();
  if (options.action) params.set('action', options.action);
  if (options.limit != null) params.set('limit', String(options.limit));
  if (options.offset != null) params.set('offset', String(options.offset));
  const query = params.toString();
  return requestJson<AdminAuditPage>(`/api/admin/audit${query ? `?${query}` : ''}`);
}

// ── Daily AI quotas (specs/047-quota-admin) ───────────────────────────────
//
// The backend resolves a feature limit in three layers:
// user override (`quota_overrides`) > global default (`app_settings`
// `ai_quota_defaults`) > env/config (`AI_DAILY_QUOTA_*`). `0` disables the
// feature (there is no "unlimited"); `null` means "delete the stored value and
// inherit the next layer down". Every write returns the refreshed table so the
// panel never has to guess the post-write state.

/** Feature label keys shared by the billing and quota panels. */
export const ADMIN_FEATURE_LABEL_KEYS: Record<string, TranslationKey> = {
  translate: 'admin.feature.translate',
  summary: 'admin.feature.summary',
  define: 'admin.feature.define',
  local_show: 'admin.feature.local_show',
  quiz: 'admin.feature.quiz',
  reading: 'admin.feature.reading',
  books: 'admin.feature.books',
  analysis: 'admin.feature.analysis',
  course_generation: 'admin.feature.course_generation',
};

/** Localized feature name; unknown features fall back to the raw key. */
export function adminFeatureLabel(
  feature: string,
  t: (key: TranslationKey) => string,
): string {
  const key = ADMIN_FEATURE_LABEL_KEYS[feature];
  return key ? t(key) : feature;
}

export type AdminQuotaSource = 'config' | 'default' | 'user_override';

export interface AdminQuotaBudgets {
  /** Read-only per-user daily USD budget (env-configured this phase). */
  userDailyUsd: number;
  /** Read-only site-wide daily USD budget (env-configured this phase). */
  globalDailyUsd: number;
}

export interface AdminQuotaDefaultRow {
  feature: string;
  /** Current default limit: app_settings value, or env/config when absent. */
  defaultLimit: number;
  /** `default` = stored app_settings override; `config` = env fallback. */
  source: 'default' | 'config';
}

export interface AdminQuotaDefaults {
  features: AdminQuotaDefaultRow[];
  budgets: AdminQuotaBudgets;
}

/**
 * One changed feature as returned by both PUT endpoints. `from`/`to` are
 * *stored* values, so `null` means "inherits the layer below".
 */
export interface AdminQuotaChange {
  from: number | null;
  to: number | null;
}

export interface AdminQuotaDefaultsResponse extends AdminQuotaDefaults {
  changes?: Record<string, AdminQuotaChange>;
}

export interface AdminQuotaUserSummary {
  id: string;
  email: string | null;
  username: string | null;
  status: string | null;
}

export interface AdminQuotaUserFeature {
  feature: string;
  defaultLimit: number;
  /** `null` = no per-user override (inherits the default). */
  overrideLimit: number | null;
  effectiveLimit: number;
  usedToday: number;
  remaining: number;
  source: AdminQuotaSource;
}

export interface AdminQuotaUser {
  user: AdminQuotaUserSummary;
  features: AdminQuotaUserFeature[];
}

export interface AdminQuotaUserUpdateResponse extends AdminQuotaUser {
  changes?: Record<string, AdminQuotaChange>;
}

/** `GET /api/admin/quotas` — 8 default limits + read-only budgets. */
export function fetchAdminQuotas(): Promise<AdminQuotaDefaults> {
  return requestJson<AdminQuotaDefaults>('/api/admin/quotas');
}

/**
 * `PUT /api/admin/quotas/defaults` — `null` deletes the stored value and
 * falls back to env/config. Empty object is rejected by the backend (400).
 */
export function updateAdminQuotaDefaults(
  limits: Record<string, number | null>,
): Promise<AdminQuotaDefaultsResponse> {
  return requestJson<AdminQuotaDefaultsResponse>('/api/admin/quotas/defaults', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ limits }),
  });
}

/** `GET /api/admin/quotas/users/{id}` — 404 unknown user, 503 missing table. */
export function fetchAdminUserQuotas(userId: string): Promise<AdminQuotaUser> {
  return requestJson<AdminQuotaUser>(
    `/api/admin/quotas/users/${encodeURIComponent(userId)}`,
  );
}

/**
 * `PUT /api/admin/quotas/users/{id}` — set overrides (`0` disables) or clear
 * them with `null`; `reason` is required (1–200 chars) and audited.
 */
export function updateAdminUserQuotas(
  userId: string,
  input: { overrides: Record<string, number | null>; reason: string },
): Promise<AdminQuotaUserUpdateResponse> {
  return requestJson<AdminQuotaUserUpdateResponse>(
    `/api/admin/quotas/users/${encodeURIComponent(userId)}`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ overrides: input.overrides, reason: input.reason }),
    },
  );
}
