// Admin console API client — specs/021-admin + specs/023-user-profile.
//
// The read endpoints are the original stop-the-bleed snapshot; the mutation
// helpers (credits / ban state / settings) were added by specs/023 and are the
// only writes the console performs. Every call goes through `apiFetch`, so the
// httpOnly session cookie and the shared 401 handling apply unchanged.
import { apiFetch } from './api';

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
  /** Manually credited balance (integer). */
  credits: number;
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

  constructor(message: string, status: number) {
    super(message);
    this.name = 'AdminApiError';
    this.status = status;
  }
}

async function readError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { detail?: unknown };
    if (typeof data?.detail === 'string' && data.detail.trim()) return data.detail;
    if (Array.isArray(data?.detail) && data.detail.length > 0) {
      // FastAPI validation errors: keep the first human-readable message.
      const first = data.detail[0] as { msg?: unknown } | null;
      if (first && typeof first.msg === 'string' && first.msg.trim()) return first.msg;
    }
  } catch {
    // Non-JSON error body: fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

async function requestJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await apiFetch(path, init);
  if (!response.ok) throw new AdminApiError(await readError(response), response.status);
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
 * Manually adjust a user's balance (specs/023 §5).
 *
 * `delta` is a non-zero integer (+credit / -debit); the backend rejects a
 * debit that would push the balance below zero with 400. `reason` is stored
 * in the append-only `credit_transactions` ledger.
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
