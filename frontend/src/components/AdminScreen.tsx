// Admin (止血台) — specs/021-admin.
//
// A read-only operations snapshot for the people who answer "is the service
// healthy, who is using it, and where is the money going?". The backend only
// exposes GET endpoints; this screen therefore offers no destructive action.
//
// Layout notes:
//   - the page root is `overflow-x-hidden`; every table sits inside its own
//     `overflow-x-auto` wrapper (375px: scroll the table, never the page);
//   - all copy comes from the zh-CN / vi-VN dictionaries (`admin.*`).
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Database,
  DollarSign,
  HardDrive,
  ListChecks,
  Loader2,
  RefreshCw,
  Search,
  ShieldCheck,
  TriangleAlert,
  Users,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import {
  AdminApiError,
  fetchAdminHealth,
  fetchAdminStats,
  fetchAdminUsage,
  fetchAdminUsers,
  type AdminHealth,
  type AdminStats,
  type AdminUsage,
  type AdminUsersPage,
} from '../lib/admin';

const PAGE_SIZE = 50;

const FEATURE_LABEL_KEYS: Record<string, TranslationKey> = {
  translate: 'admin.feature.translate',
  summary: 'admin.feature.summary',
  define: 'admin.feature.define',
  local_show: 'admin.feature.local_show',
  quiz: 'admin.feature.quiz',
  reading: 'admin.feature.reading',
};

const SECONDARY_BUTTON =
  'inline-flex items-center gap-2 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:hover:bg-zinc-800/60';

function errorText(
  error: unknown,
  fallback: string,
  t: (key: TranslationKey) => string,
): string {
  if (error instanceof AdminApiError) {
    if (error.status === 401) return t('admin.error.login');
    if (error.status === 403) return t('admin.error.forbidden');
    if (error.message) return error.message;
  }
  return fallback;
}

function featureLabel(feature: string, t: (key: TranslationKey) => string): string {
  const key = FEATURE_LABEL_KEYS[feature];
  return key ? t(key) : feature;
}

function usd(value: number, formatNumber: (value: number) => string): string {
  if (!Number.isFinite(value)) return '$0';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  return `$${formatNumber(Number(value.toFixed(digits)))}`;
}

function formatBytes(
  value: number,
  formatNumber: (value: number) => string,
): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(size) : Number(size.toFixed(1));
  return `${formatNumber(rounded)} ${units[unit]}`;
}

function formatUptime(
  seconds: number,
  formatNumber: (value: number) => string,
): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${formatNumber(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${formatNumber(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${formatNumber(hours)}h ${formatNumber(minutes % 60)}m`;
  const days = Math.floor(hours / 24);
  return `${formatNumber(days)}d ${formatNumber(hours % 24)}h`;
}

function Section({
  id,
  title,
  subtitle,
  action,
  children,
}: {
  id: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="mt-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h2 id={id} className="text-[17px] font-semibold tracking-tight text-zinc-100">
            {title}
          </h2>
          {subtitle && (
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{subtitle}</p>
          )}
        </div>
        {action}
      </div>
      <div className="mt-3">{children}</div>
    </section>
  );
}

function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <p className="text-sm leading-relaxed text-zinc-300 break-words">{message}</p>
      </div>
    </div>
  );
}

function StatCard({
  icon,
  label,
  value,
  hint,
  danger,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  danger?: boolean;
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4 min-w-0">
      <div className="flex items-center gap-2 text-zinc-500">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p
        className={`mt-2 text-2xl font-semibold tracking-tight tabular-nums ${
          danger ? 'text-red-400' : 'text-zinc-100'
        }`}
      >
        {value}
      </p>
      <p className="mt-1 text-[11px] leading-relaxed text-zinc-500 tabular-nums break-words">
        {hint}
      </p>
    </div>
  );
}

export function AdminScreen({ onClose }: { onClose: () => void }) {
  const { t, formatNumber, formatDate } = useI18n();

  const [stats, setStats] = useState<AdminStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);

  const [usage, setUsage] = useState<AdminUsage | null>(null);
  const [usageError, setUsageError] = useState<string | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);

  const [usersPage, setUsersPage] = useState<AdminUsersPage | null>(null);
  const [usersError, setUsersError] = useState<string | null>(null);
  const [usersLoading, setUsersLoading] = useState(true);

  const [health, setHealth] = useState<AdminHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthLoading, setHealthLoading] = useState(true);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const usersRequestRef = useRef(0);

  // Debounce the search box: 350ms after typing stops, reset to page 1.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchInput.trim();
      setSearch((previous) => (previous === next ? previous : next));
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      setStats(await fetchAdminStats());
    } catch (error) {
      setStatsError(errorText(error, t('admin.error.stats'), t));
    } finally {
      setStatsLoading(false);
    }
  }, [t]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      setUsage(await fetchAdminUsage(7));
    } catch (error) {
      setUsageError(errorText(error, t('admin.error.usage'), t));
    } finally {
      setUsageLoading(false);
    }
  }, [t]);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      setHealth(await fetchAdminHealth());
    } catch (error) {
      setHealthError(errorText(error, t('admin.error.health'), t));
    } finally {
      setHealthLoading(false);
    }
  }, [t]);

  const loadUsers = useCallback(async (
    nextOffset: number,
    nextSearch: string,
  ) => {
    const requestId = ++usersRequestRef.current;
    setUsersLoading(true);
    setUsersError(null);
    try {
      const page = await fetchAdminUsers({
        limit: PAGE_SIZE,
        offset: nextOffset,
        search: nextSearch,
      });
      if (requestId !== usersRequestRef.current) return;
      setUsersPage(page);
    } catch (error) {
      if (requestId !== usersRequestRef.current) return;
      setUsersError(errorText(error, t('admin.error.users'), t));
    } finally {
      if (requestId === usersRequestRef.current) setUsersLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadStats();
    void loadUsage();
    void loadHealth();
  }, [loadStats, loadUsage, loadHealth]);

  useEffect(() => {
    void loadUsers(offset, search);
  }, [loadUsers, offset, search]);

  const refreshAll = () => {
    void loadStats();
    void loadUsage();
    void loadHealth();
    void loadUsers(offset, search);
  };

  const anyLoading = statsLoading || usageLoading || usersLoading || healthLoading;

  const usageRows = usage?.rows ?? [];
  const failedJobs = health?.failedJobs ?? [];
  const healthy = health?.health.status === 'ok';

  return (
    <div
      data-testid="admin-screen"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-9 px-2 -ml-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('admin.back')}
          </button>
          <button
            type="button"
            onClick={refreshAll}
            disabled={anyLoading}
            data-testid="admin-refresh"
            className={SECONDARY_BUTTON}
          >
            <RefreshCw className={`w-4 h-4 ${anyLoading ? 'animate-spin' : ''}`} />
            {t('admin.refresh')}
          </button>
        </div>

        <header className="mt-5">
          <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-500">
            <ShieldCheck className="w-4 h-4 text-blue-400" />
            <span>{t('admin.eyebrow')}</span>
          </div>
          <h1 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50">
            {t('admin.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            {t('admin.subtitle')}
          </p>
          {stats?.generatedAt && (
            <p className="mt-2 text-[11px] text-zinc-500 tabular-nums">
              {t('admin.generatedAt', {
                time: formatDate(new Date(stats.generatedAt), {
                  dateStyle: 'medium',
                  timeStyle: 'medium',
                }),
              })}
            </p>
          )}
        </header>

        {/* Overview cards */}
        <div className="mt-6 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          <StatCard
            icon={<Users className="w-4 h-4" />}
            label={t('admin.users.total')}
            value={stats ? formatNumber(stats.users.total) : '—'}
            hint={t('admin.users.totalHint', {
              newUsers: formatNumber(stats?.users.new7d ?? 0),
              guests: formatNumber(stats?.users.guests ?? 0),
            })}
          />
          <StatCard
            icon={<Activity className="w-4 h-4" />}
            label={t('admin.active.today')}
            value={stats ? formatNumber(stats.users.activeToday) : '—'}
            hint={t('admin.active.todayHint')}
          />
          <StatCard
            icon={<DollarSign className="w-4 h-4" />}
            label={t('admin.cost.today')}
            value={stats ? usd(stats.ai.todayCostUsd, formatNumber) : '—'}
            hint={t('admin.cost.todayHint', {
              month: usd(stats?.ai.monthCostUsd ?? 0, formatNumber),
              calls: formatNumber(stats?.ai.todayCalls ?? 0),
            })}
          />
          <StatCard
            icon={<TriangleAlert className="w-4 h-4" />}
            label={t('admin.jobs.failed')}
            value={stats ? formatNumber(stats.jobs.failed) : '—'}
            hint={t('admin.jobs.failedHint', {
              running: formatNumber(stats?.jobs.running ?? 0),
              pending: formatNumber(stats?.jobs.pendingRetry ?? 0),
            })}
            danger={(stats?.jobs.failed ?? 0) > 0}
          />
        </div>
        {statsError && (
          <div className="mt-3">
            <ErrorBanner message={statsError} />
          </div>
        )}

        {/* 7-day usage */}
        <Section
          id="admin-usage-title"
          title={t('admin.usage.title')}
          subtitle={
            usage
              ? t('admin.usage.subtitle', { start: usage.start, end: usage.end })
              : t('admin.usage.subtitleLoading')
          }
          action={
            usageLoading ? (
              <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
            ) : undefined
          }
        >
          {usageError ? (
            <ErrorBanner message={usageError} />
          ) : (
            <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full min-w-[640px] text-left text-sm">
                  <thead className="bg-zinc-900/60 text-[11px] font-medium text-zinc-500">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.table.day')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.table.feature')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.table.calls')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.table.inputTokens')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.table.outputTokens')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.table.cost')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {usageRows.map((row) => (
                      <tr key={`${row.day}:${row.feature}`} className="text-zinc-300">
                        <td className="px-4 py-2.5 whitespace-nowrap tabular-nums text-zinc-400">{row.day}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap">{featureLabel(row.feature, t)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{formatNumber(row.calls)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums text-zinc-400">{formatNumber(row.inputTokens)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums text-zinc-400">{formatNumber(row.outputTokens)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{usd(row.costUsd, formatNumber)}</td>
                      </tr>
                    ))}
                    {!usageLoading && usageRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-500">
                          {t('admin.usage.empty')}
                        </td>
                      </tr>
                    )}
                    {usageLoading && usageRows.length === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center">
                          <Loader2 className="w-5 h-5 text-zinc-500 animate-spin inline-block" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {usage && usageRows.length > 0 && (
                    <tfoot className="bg-zinc-900/60 text-zinc-300">
                      <tr>
                        <td className="px-4 py-2.5 text-[11px] font-medium text-zinc-500" colSpan={2}>
                          {t('admin.usage.total')}
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{formatNumber(usage.totals.calls)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-zinc-400">{formatNumber(usage.totals.inputTokens)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-zinc-400">{formatNumber(usage.totals.outputTokens)}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums">{usd(usage.totals.costUsd, formatNumber)}</td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          )}
        </Section>

        {/* Users */}
        <Section
          id="admin-users-title"
          title={t('admin.users.title')}
          subtitle={t('admin.users.subtitle')}
          action={
            <label className="relative inline-flex items-center min-w-0">
              <Search className="w-4 h-4 text-zinc-500 absolute left-3 pointer-events-none" />
              <input
                type="search"
                value={searchInput}
                onChange={(event) => setSearchInput(event.target.value)}
                placeholder={t('admin.users.searchPlaceholder')}
                aria-label={t('admin.users.searchAria')}
                data-testid="admin-user-search"
                className="h-9 w-56 max-w-[60vw] rounded-xl bg-zinc-800/60 border border-white/5 pl-9 pr-3 text-sm text-zinc-200 placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60"
              />
            </label>
          }
        >
          {usersError ? (
            <ErrorBanner message={usersError} />
          ) : (
            <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
              <div className="overflow-x-auto custom-scrollbar">
                <table className="w-full min-w-[760px] text-left text-sm">
                  <thead className="bg-zinc-900/60 text-[11px] font-medium text-zinc-500">
                    <tr>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.id')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.email')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.createdAt')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.users.monthCost')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.users.eventCount')}</th>
                      <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.lastActive')}</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/5">
                    {(usersPage?.users ?? []).map((user) => (
                      <tr key={user.id} className="text-zinc-300">
                        <td className="px-4 py-2.5 whitespace-nowrap font-mono text-xs text-zinc-400">{user.id}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap max-w-[16rem] truncate" title={user.email}>{user.email}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-zinc-400 tabular-nums">
                          {user.createdAt > 0 ? formatDate(user.createdAt, { dateStyle: 'medium' }) : '—'}
                        </td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{usd(user.monthCostUsd, formatNumber)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{formatNumber(user.eventCount)}</td>
                        <td className="px-4 py-2.5 whitespace-nowrap text-xs text-zinc-400 tabular-nums">
                          {user.lastActiveAt
                            ? formatDate(user.lastActiveAt, { dateStyle: 'medium', timeStyle: 'short' })
                            : t('admin.users.never')}
                        </td>
                      </tr>
                    ))}
                    {!usersLoading && (usersPage?.users.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-500">
                          {search ? t('admin.users.noMatch') : t('admin.users.empty')}
                        </td>
                      </tr>
                    )}
                    {usersLoading && (usersPage?.users.length ?? 0) === 0 && (
                      <tr>
                        <td colSpan={6} className="px-4 py-10 text-center">
                          <Loader2 className="w-5 h-5 text-zinc-500 animate-spin inline-block" />
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2 border-t border-white/5 px-4 py-2.5">
                <p className="text-[11px] text-zinc-500 tabular-nums">
                  {usersPage
                    ? t('admin.users.page', {
                        from: usersPage.users.length > 0 ? formatNumber(usersPage.offset + 1) : '0',
                        to: formatNumber(usersPage.offset + usersPage.users.length),
                        total: formatNumber(usersPage.total),
                      })
                    : '—'}
                </p>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={usersLoading || offset <= 0}
                    onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                  >
                    <ChevronLeft className="w-4 h-4" />
                    {t('admin.users.prev')}
                  </button>
                  <button
                    type="button"
                    className={SECONDARY_BUTTON}
                    disabled={usersLoading || !(usersPage?.hasMore ?? false)}
                    onClick={() => setOffset((current) => current + PAGE_SIZE)}
                  >
                    {t('admin.users.next')}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          )}
        </Section>

        {/* Health */}
        <Section
          id="admin-health-title"
          title={t('admin.health.title')}
          subtitle={t('admin.health.subtitle')}
          action={
            healthLoading ? (
              <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
            ) : health ? (
              <span
                className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full ${
                  healthy
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                    : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                }`}
              >
                {healthy ? <CircleCheck className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                {healthy ? t('admin.health.ok') : t('admin.health.degraded')}
              </span>
            ) : undefined
          }
        >
          {healthError ? (
            <ErrorBanner message={healthError} />
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
              <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
                <dl className="space-y-3 text-sm">
                  <div className="flex items-start justify-between gap-4">
                    <dt className="inline-flex items-center gap-2 text-zinc-500 shrink-0">
                      <Database className="w-4 h-4" />
                      {t('admin.health.version')}
                    </dt>
                    <dd className="text-right text-zinc-300 break-all">{health?.health.version ?? '—'}</dd>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-zinc-500 shrink-0">{t('admin.health.db')}</dt>
                    <dd className="text-right text-zinc-300 break-all">
                      {health
                        ? health.health.db.ok
                          ? t('admin.health.dbOk')
                          : t('admin.health.dbBad')
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-zinc-500 shrink-0">{t('admin.health.migrations')}</dt>
                    <dd className="text-right text-zinc-300 break-all font-mono text-xs">
                      {health
                        ? `${health.health.db.migrations.current ?? '—'} / ${health.health.db.migrations.head ?? '—'}`
                        : '—'}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <dt className="inline-flex items-center gap-2 text-zinc-500 shrink-0">
                      <Activity className="w-4 h-4" />
                      {t('admin.health.uptime')}
                    </dt>
                    <dd className="text-right text-zinc-300 tabular-nums">
                      {health ? formatUptime(health.health.uptimeSeconds, formatNumber) : '—'}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <dt className="inline-flex items-center gap-2 text-zinc-500 shrink-0">
                      <HardDrive className="w-4 h-4" />
                      {t('admin.health.disk')}
                    </dt>
                    <dd className="text-right text-zinc-300 tabular-nums">
                      {health ? formatBytes(health.disk.sizeBytes, formatNumber) : '—'}
                    </dd>
                  </div>
                  <div className="flex items-start justify-between gap-4">
                    <dt className="text-zinc-500 shrink-0">{t('admin.health.time')}</dt>
                    <dd className="text-right text-zinc-400 text-xs tabular-nums break-all">
                      {health?.health.time
                        ? formatDate(new Date(health.health.time), {
                            dateStyle: 'medium',
                            timeStyle: 'medium',
                          })
                        : '—'}
                    </dd>
                  </div>
                </dl>
              </div>

              <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4 min-w-0">
                <div className="flex items-center gap-2 text-zinc-500">
                  <ListChecks className="w-4 h-4" />
                  <h3 className="text-xs font-medium">{t('admin.health.failedJobs')}</h3>
                </div>
                {failedJobs.length === 0 ? (
                  <p className="mt-4 text-sm text-zinc-500">{t('admin.health.noFailedJobs')}</p>
                ) : (
                  <ul className="mt-3 space-y-2">
                    {failedJobs.map((job) => (
                      <li key={job.id} className="rounded-xl border border-white/5 bg-zinc-800/30 p-3 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-zinc-500">
                          <span className="font-mono text-zinc-400">{job.id.slice(0, 8)}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{job.kind}</span>
                          <span aria-hidden="true">·</span>
                          <span className="font-mono">{job.userId || '—'}</span>
                          <span aria-hidden="true">·</span>
                          <time dateTime={new Date(job.updatedAt).toISOString()} className="tabular-nums">
                            {job.updatedAt
                              ? formatDate(job.updatedAt, { dateStyle: 'medium', timeStyle: 'short' })
                              : '—'}
                          </time>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400 break-words whitespace-pre-wrap">
                          {job.contentRef || '—'}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-red-300/90 break-words whitespace-pre-wrap">
                          {job.error || '—'}
                        </p>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </Section>

        <p className="mt-8 text-[11px] leading-relaxed text-zinc-500">
          {t('admin.footerNote')}
        </p>
      </div>
    </div>
  );
}
