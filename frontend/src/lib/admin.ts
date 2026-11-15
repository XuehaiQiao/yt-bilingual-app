// Admin (止血台) API client — specs/021-admin.
//
// Every endpoint is read-only and requires a logged-in admin; the backend
// answers 401/403 otherwise. The client deliberately exposes no mutation
// helpers: the admin surface is a stop-the-bleed dashboard, not a CMS.
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

export interface AdminUserRow {
  /** First 8 characters of the user id (enough for support, no full id leak). */
  id: string;
  email: string;
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
  } catch {
    // Non-JSON error body: fall through to the status text.
  }
  return response.statusText || `HTTP ${response.status}`;
}

async function readJson<T>(path: string): Promise<T> {
  const response = await apiFetch(path);
  if (!response.ok) throw new AdminApiError(await readError(response), response.status);
  try {
    return (await response.json()) as T;
  } catch {
    throw new AdminApiError('invalid admin payload', -1);
  }
}

export function fetchAdminStats(): Promise<AdminStats> {
  return readJson<AdminStats>('/api/admin/stats');
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
  return readJson<AdminUsersPage>(`/api/admin/users${query ? `?${query}` : ''}`);
}

export function fetchAdminUsage(days = 7): Promise<AdminUsage> {
  return readJson<AdminUsage>(`/api/admin/usage?days=${encodeURIComponent(String(days))}`);
}

export function fetchAdminHealth(): Promise<AdminHealth> {
  return readJson<AdminHealth>('/api/admin/health');
}
