// Admin console — the standalone operations page (specs/021-admin +
// specs/023-user-profile).
//
// Unlike the 021 "stop-the-bleed" dashboard this replaces, the console is a
// full application view (no top bar, no dialog shell) with four segmented
// sections:
//   overview  — users / new 7d / active today / guests / AI cost / failed jobs
//   users     — search + pagination, credit adjustment and ban/unban
//   settings  — maintenance mode and announcement (server `app_settings`)
//   ops       — per-day/per-feature AI usage and health/diagnostics
//
// Access rules are enforced twice: `App` only opens this view for an
// administrator and this screen re-checks `isAdmin`, toasting + handing back
// to `App` (which returns home) when a non-admin ever lands here — e.g. via
// the `#admin` direct link.
//
// Every request goes through `lib/admin.ts` → `apiFetch` (credentials included).
// Tables live in their own `overflow-x-auto` wrapper with a `min-w`; the page
// root never scrolls horizontally, so a 375px phone scrolls the table only.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { motion } from 'framer-motion';
import {
  Activity,
  AlertCircle,
  ArrowLeft,
  Ban,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Coins,
  Database,
  DollarSign,
  HardDrive,
  LayoutDashboard,
  ListChecks,
  Loader2,
  LockOpen,
  Megaphone,
  RefreshCw,
  Search,
  Server,
  ShieldCheck,
  SlidersHorizontal,
  TriangleAlert,
  UserPlus,
  UserRound,
  Users,
  Wrench,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { getLanguageMeta, type TranslationKey } from '../i18n';
import { useAuth } from '../lib/auth';
import { displayUsername } from '../lib/username';
import { toast } from '../lib/toast';
import { Dialog } from './ui/Dialog';
import {
  AdminApiError,
  adjustAdminUserCredits,
  fetchAdminHealth,
  fetchAdminSettings,
  fetchAdminStats,
  fetchAdminUsage,
  fetchAdminUsers,
  saveAdminSettings,
  updateAdminUserStatus,
  type AdminHealth,
  type AdminSettings,
  type AdminStats,
  type AdminUsage,
  type AdminUserRow,
  type AdminUserStatus,
  type AdminUsersPage,
} from '../lib/admin';
import { LanguageMenu } from './LanguageMenu';

const PAGE_SIZE = 20;
const MAX_CREDIT_DELTA = 100_000;
const MAX_ANNOUNCEMENT_CHARS = 2000;

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50 disabled:pointer-events-none';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const COMPACT_BUTTON =
  'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40 disabled:pointer-events-none';
const DANGER_BUTTON =
  'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-sm font-medium text-red-400 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const SUCCESS_BUTTON =
  'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-emerald-500/10 hover:bg-emerald-500/15 border border-emerald-500/20 text-sm font-medium text-emerald-400 transition-colors disabled:opacity-50 disabled:pointer-events-none';

type AdminTab = 'overview' | 'users' | 'settings' | 'ops';

const TABS: ReadonlyArray<{
  id: AdminTab;
  labelKey: TranslationKey;
  icon: ReactNode;
}> = [
  { id: 'overview', labelKey: 'admin.tab.overview', icon: <LayoutDashboard className="w-3.5 h-3.5" /> },
  { id: 'users', labelKey: 'admin.tab.users', icon: <Users className="w-3.5 h-3.5" /> },
  { id: 'settings', labelKey: 'admin.tab.settings', icon: <SlidersHorizontal className="w-3.5 h-3.5" /> },
  { id: 'ops', labelKey: 'admin.tab.ops', icon: <Activity className="w-3.5 h-3.5" /> },
];

const FEATURE_LABEL_KEYS: Record<string, TranslationKey> = {
  translate: 'admin.feature.translate',
  summary: 'admin.feature.summary',
  define: 'admin.feature.define',
  local_show: 'admin.feature.local_show',
  quiz: 'admin.feature.quiz',
  reading: 'admin.feature.reading',
};

function featureLabel(feature: string, t: (key: TranslationKey) => string): string {
  const key = FEATURE_LABEL_KEYS[feature];
  return key ? t(key) : feature;
}

function formatBytes(value: number, formatNumber: (value: number) => string): string {
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

function formatUptime(seconds: number, formatNumber: (value: number) => string): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  if (seconds < 60) return `${formatNumber(Math.round(seconds))}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${formatNumber(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${formatNumber(hours)}h ${formatNumber(minutes % 60)}m`;
  const days = Math.floor(hours / 24);
  return `${formatNumber(days)}d ${formatNumber(hours % 24)}h`;
}

/** Locale-aware `$` formatter keeping the tiny AI estimates legible. */
function useUsdFormatter(): (value: number) => string {
  const { language } = useI18n();
  return useMemo(() => {
    const locale = getLanguageMeta(language).locale;
    const formatter = new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 4,
    });
    return (value: number): string => {
      if (!Number.isFinite(value)) return '$0.00';
      return `$${formatter.format(value)}`;
    };
  }, [language]);
}

function fallbackErrorText(error: unknown, fallback: string): string {
  if (error instanceof AdminApiError && error.message) return error.message;
  if (error instanceof TypeError) return fallback;
  return fallback;
}

function SectionTitle({
  id,
  title,
  subtitle,
  action,
}: {
  id: string;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
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
  );
}

function ErrorBanner({
  message,
  onRetry,
  retryLabel,
}: {
  message: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div
      role="alert"
      className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4"
    >
      <div className="flex items-start gap-3">
        <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
        <div className="min-w-0">
          <p className="text-sm leading-relaxed text-zinc-300 break-words">{message}</p>
          {onRetry && (
            <button type="button" onClick={onRetry} className={`${SECONDARY_BUTTON} mt-3`}>
              <RefreshCw className="w-4 h-4" />
              {retryLabel}
            </button>
          )}
        </div>
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
  testId,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  hint: string;
  danger?: boolean;
  testId: string;
}) {
  return (
    <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4 min-w-0">
      <div className="flex items-center gap-2 text-zinc-500">
        {icon}
        <span className="text-xs font-medium">{label}</span>
      </div>
      <p
        data-testid={testId}
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

function StatusBadge({ banned }: { banned: boolean }) {
  const { t } = useI18n();
  return (
    <span
      data-testid="admin-user-status-badge"
      className={`inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full border whitespace-nowrap ${
        banned
          ? 'bg-red-500/10 text-red-400 border-red-500/20'
          : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
      }`}
    >
      {banned ? t('admin.users.statusBanned') : t('admin.users.statusActive')}
    </span>
  );
}

interface CreditDialogProps {
  target: AdminUserRow;
  onClose: () => void;
  onSaved: (userId: string, credits: number) => void;
  onAuthError: () => void;
}

/**
 * Manual balance adjustment (`POST /api/admin/users/{id}/credits`).
 * A signed integer keeps the + / - cases in one field; the backend remains the
 * authority on range, reason length and the "balance cannot go negative" rule.
 */
function CreditDialog({ target, onClose, onSaved, onAuthError }: CreditDialogProps) {
  const { t, formatNumber } = useI18n();
  const [deltaText, setDeltaText] = useState('');
  const [reasonText, setReasonText] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const name = displayUsername(target.username, target.email);

  const validate = (): { delta: number; reason: string } | null => {
    const delta = Number(deltaText);
    if (
      deltaText.trim() === ''
      || !Number.isInteger(delta)
      || delta === 0
      || Math.abs(delta) > MAX_CREDIT_DELTA
    ) {
      setError(t('admin.credit.error.delta'));
      return null;
    }
    const reason = reasonText.trim();
    if (reason.length < 1 || reason.length > 200) {
      setError(t('admin.credit.error.reason'));
      return null;
    }
    return { delta, reason };
  };

  const submit = async () => {
    if (saving) return;
    const values = validate();
    if (!values) return;
    setSaving(true);
    setError(null);
    try {
      const result = await adjustAdminUserCredits(target.userId, values.delta, values.reason);
      onSaved(target.userId, result.credits);
    } catch (err) {
      if (err instanceof AdminApiError && (err.status === 401 || err.status === 403)) {
        onAuthError();
        return;
      }
      const message = fallbackErrorText(err, t('admin.credit.error.failed'));
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-zinc-400"><Coins className="w-5 h-5" /></span>
          <span className="truncate">{t('admin.credit.title')}</span>
        </span>
      }
      size="sm"
      loading={saving}
      initialFocus='[data-testid="admin-credit-delta"]'
      testId="admin-credit-dialog"
      footer={
        <>
          <button
            type="button"
            data-testid="admin-credit-cancel"
            onClick={onClose}
            disabled={saving}
            className={SECONDARY_BUTTON}
          >
            {t('admin.cancel')}
          </button>
          <button
            type="button"
            data-testid="admin-credit-submit"
            onClick={() => { void submit(); }}
            disabled={saving}
            className={PRIMARY_BUTTON}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Coins className="w-4 h-4" />}
            {saving ? t('admin.credit.saving') : t('admin.credit.submit')}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-zinc-400">
        {t('admin.credit.desc', { name })}
      </p>

      <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-zinc-800/30 px-3 py-2.5">
        <span className="text-xs text-zinc-500">{t('admin.credit.current')}</span>
        <span data-testid="admin-credit-current" className="text-sm font-semibold text-zinc-100 tabular-nums">
          {formatNumber(target.credits ?? 0)}
        </span>
      </div>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-zinc-400">{t('admin.credit.delta')}</span>
        <input
          data-testid="admin-credit-delta"
          type="number"
          step={1}
          inputMode="numeric"
          value={deltaText}
          onChange={(event) => {
            setDeltaText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder="+100 / -100"
          aria-invalid={error ? true : undefined}
          className="mt-1.5 h-10 w-full rounded-xl bg-zinc-800/50 border border-white/10 px-3 text-sm text-zinc-100 outline-none focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/15"
        />
        <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
          {t('admin.credit.deltaHint')}
        </span>
      </label>

      <label className="mt-4 block">
        <span className="text-xs font-medium text-zinc-400">{t('admin.credit.reason')}</span>
        <input
          data-testid="admin-credit-reason"
          type="text"
          maxLength={200}
          value={reasonText}
          onChange={(event) => {
            setReasonText(event.target.value);
            if (error) setError(null);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              void submit();
            }
          }}
          placeholder={t('admin.credit.reasonPlaceholder')}
          className="mt-1.5 h-10 w-full rounded-xl bg-zinc-800/50 border border-white/10 px-3 text-sm text-zinc-100 placeholder:text-zinc-600 outline-none focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/15"
        />
        <span className="mt-1 block text-[11px] leading-relaxed text-zinc-500">
          {t('admin.credit.reasonHint')}
        </span>
      </label>

      {error && (
        <p
          role="alert"
          data-testid="admin-credit-error"
          className="mt-4 flex items-start gap-1.5 text-xs text-red-400 leading-relaxed"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </Dialog>
  );
}

interface StatusDialogProps {
  target: AdminUserRow;
  onClose: () => void;
  onSaved: (userId: string, status: AdminUserStatus) => void;
  onAuthError: () => void;
}

/** Ban/unban confirmation — the second click that makes the change. */
function StatusDialog({ target, onClose, onSaved, onAuthError }: StatusDialogProps) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const banned = target.status === 'banned';
  const nextStatus: AdminUserStatus = banned ? 'active' : 'banned';
  const name = displayUsername(target.username, target.email);

  const submit = async () => {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updateAdminUserStatus(target.userId, nextStatus);
      onSaved(target.userId, result.user.status);
    } catch (err) {
      if (err instanceof AdminApiError && (err.status === 401 || err.status === 403)) {
        onAuthError();
        return;
      }
      const message = fallbackErrorText(err, t('admin.status.error.failed'));
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog
      open
      onClose={onClose}
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="shrink-0 text-zinc-400">
            {banned ? <LockOpen className="w-5 h-5" /> : <Ban className="w-5 h-5" />}
          </span>
          <span className="truncate">
            {banned ? t('admin.status.unbanTitle') : t('admin.status.banTitle')}
          </span>
        </span>
      }
      size="sm"
      loading={saving}
      initialFocus='[data-testid="admin-status-cancel"]'
      testId="admin-status-dialog"
      footer={
        <>
          <button
            type="button"
            data-testid="admin-status-cancel"
            onClick={onClose}
            disabled={saving}
            className={SECONDARY_BUTTON}
          >
            {t('admin.cancel')}
          </button>
          <button
            type="button"
            data-testid="admin-status-confirm"
            onClick={() => { void submit(); }}
            disabled={saving}
            className={banned ? SUCCESS_BUTTON : DANGER_BUTTON}
          >
            {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : banned ? <LockOpen className="w-4 h-4" /> : <Ban className="w-4 h-4" />}
            {banned ? t('admin.status.confirmUnban') : t('admin.status.confirmBan')}
          </button>
        </>
      }
    >
      <p className="text-sm leading-relaxed text-zinc-300">
        {banned
          ? t('admin.status.unbanDesc', { name })
          : t('admin.status.banDesc', { name })}
      </p>
      <p className="mt-2 text-xs leading-relaxed text-zinc-500 break-words">{target.email}</p>
      {error && (
        <p
          role="alert"
          data-testid="admin-status-error"
          className="mt-4 flex items-start gap-1.5 text-xs text-red-400 leading-relaxed"
        >
          <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>{error}</span>
        </p>
      )}
    </Dialog>
  );
}

export interface AdminConsoleScreenProps {
  /** Leave the console — App returns to the account page or home. */
  onClose: () => void;
  /** Access lost (not an admin / session expired): App toasts and goes home. */
  onDenied: () => void;
}

export function AdminConsoleScreen({ onClose, onDenied }: AdminConsoleScreenProps) {
  const { t, formatNumber, formatDate } = useI18n();
  const { user, isAdmin } = useAuth();
  const usd = useUsdFormatter();

  const [tab, setTab] = useState<AdminTab>('overview');

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

  const [settings, setSettings] = useState<AdminSettings | null>(null);
  const [settingsLoading, setSettingsLoading] = useState(true);
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const [maintenanceDraft, setMaintenanceDraft] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsSaveError, setSettingsSaveError] = useState<string | null>(null);
  const [settingsSaved, setSettingsSaved] = useState(false);

  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);

  const [creditTarget, setCreditTarget] = useState<AdminUserRow | null>(null);
  const [statusTarget, setStatusTarget] = useState<AdminUserRow | null>(null);

  const usersRequestRef = useRef(0);
  const deniedRef = useRef(false);
  const onDeniedRef = useRef(onDenied);

  useEffect(() => {
    onDeniedRef.current = onDenied;
  }, [onDenied]);

  // Single denial path: toast once, then let App leave the console. Kept
  // stable across renders so the data callbacks below do not re-fire.
  const deny = useCallback(() => {
    if (deniedRef.current) return;
    deniedRef.current = true;
    toast.error(t('admin.error.forbidden'));
    onDeniedRef.current();
  }, [t]);

  // Safety net for a direct entry or an admin flag that disappeared after a
  // session refresh; App also refuses to open the view for non-admins.
  useEffect(() => {
    if (!isAdmin) deny();
  }, [isAdmin, deny]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const next = searchInput.trim();
      setSearch((previous) => (previous === next ? previous : next));
      setOffset(0);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const describeError = useCallback((error: unknown, fallback: string): string => {
    if (error instanceof AdminApiError) {
      if (error.status === 401 || error.status === 403) {
        deny();
        return t('admin.error.forbidden');
      }
      if (error.message) return error.message;
    }
    return fallback;
  }, [deny, t]);

  const loadStats = useCallback(async () => {
    setStatsLoading(true);
    setStatsError(null);
    try {
      setStats(await fetchAdminStats());
    } catch (error) {
      setStatsError(describeError(error, t('admin.error.stats')));
    } finally {
      setStatsLoading(false);
    }
  }, [describeError, t]);

  const loadUsage = useCallback(async () => {
    setUsageLoading(true);
    setUsageError(null);
    try {
      setUsage(await fetchAdminUsage(7));
    } catch (error) {
      setUsageError(describeError(error, t('admin.error.usage')));
    } finally {
      setUsageLoading(false);
    }
  }, [describeError, t]);

  const loadHealth = useCallback(async () => {
    setHealthLoading(true);
    setHealthError(null);
    try {
      setHealth(await fetchAdminHealth());
    } catch (error) {
      setHealthError(describeError(error, t('admin.error.health')));
    } finally {
      setHealthLoading(false);
    }
  }, [describeError, t]);

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    setSettingsError(null);
    setSettingsSaveError(null);
    setSettingsSaved(false);
    try {
      const next = await fetchAdminSettings();
      setSettings(next);
      setMaintenanceDraft(next.maintenance_mode === true);
      setAnnouncementDraft(next.announcement ?? '');
    } catch (error) {
      setSettingsError(describeError(error, t('admin.settings.error.load')));
    } finally {
      setSettingsLoading(false);
    }
  }, [describeError, t]);

  const loadUsers = useCallback(async (nextOffset: number, nextSearch: string) => {
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
      setUsersError(describeError(error, t('admin.error.users')));
    } finally {
      if (requestId === usersRequestRef.current) setUsersLoading(false);
    }
  }, [describeError, t]);

  useEffect(() => {
    void loadStats();
    void loadUsage();
    void loadHealth();
    void loadSettings();
  }, [loadStats, loadUsage, loadHealth, loadSettings]);

  useEffect(() => {
    void loadUsers(offset, search);
  }, [loadUsers, offset, search]);

  const refreshActive = () => {
    if (tab === 'overview') void loadStats();
    else if (tab === 'users') void loadUsers(offset, search);
    else if (tab === 'settings') void loadSettings();
    else {
      void loadUsage();
      void loadHealth();
    }
  };

  const activeLoading = tab === 'overview'
    ? statsLoading
    : tab === 'users'
      ? usersLoading
      : tab === 'settings'
        ? settingsLoading
        : usageLoading || healthLoading;

  const handleCreditsSaved = (userId: string, credits: number) => {
    setUsersPage((previous) => (previous
      ? {
        ...previous,
        users: previous.users.map((row) => (row.userId === userId ? { ...row, credits } : row)),
      }
      : previous));
    setCreditTarget(null);
    toast.success(t('admin.credit.success', { credits: formatNumber(credits) }));
    void loadUsers(offset, search);
    void loadStats();
  };

  const handleStatusSaved = (userId: string, status: AdminUserStatus) => {
    const target = statusTarget;
    setUsersPage((previous) => (previous
      ? {
        ...previous,
        users: previous.users.map((row) => (row.userId === userId ? { ...row, status } : row)),
      }
      : previous));
    setStatusTarget(null);
    toast.success(t(
      status === 'banned' ? 'admin.status.successBan' : 'admin.status.successUnban',
      { name: displayUsername(target?.username, target?.email) },
    ));
    void loadUsers(offset, search);
  };

  const saveSettings = async () => {
    if (settingsSaving || !settings) return;
    const announcement = announcementDraft.trim();
    if (Array.from(announcement).length > MAX_ANNOUNCEMENT_CHARS) {
      setSettingsSaveError(t('admin.settings.error.tooLong'));
      return;
    }
    setSettingsSaving(true);
    setSettingsSaveError(null);
    setSettingsSaved(false);
    try {
      const next = await saveAdminSettings({
        maintenance_mode: maintenanceDraft,
        announcement: announcement === '' ? null : announcement,
      });
      setSettings(next);
      setMaintenanceDraft(next.maintenance_mode === true);
      setAnnouncementDraft(next.announcement ?? '');
      setSettingsSaved(true);
      toast.success(t('admin.settings.saved'));
    } catch (error) {
      if (error instanceof AdminApiError && (error.status === 401 || error.status === 403)) {
        deny();
        return;
      }
      const message = fallbackErrorText(error, t('admin.settings.error.save'));
      setSettingsSaveError(message);
      toast.error(message);
    } finally {
      setSettingsSaving(false);
    }
  };

  const isSelf = (row: AdminUserRow): boolean => {
    if (user?.id && row.userId === user.id) return true;
    return Boolean(
      user?.email
      && row.email
      && row.email.trim().toLowerCase() === user.email.trim().toLowerCase(),
    );
  };

  const announcement = announcementDraft.trim();
  const settingsDirty = Boolean(settings) && (
    maintenanceDraft !== (settings?.maintenance_mode ?? false)
    || announcement !== (settings?.announcement ?? '').trim()
  );
  const announcementCount = Array.from(announcementDraft).length;
  const usageRows = usage?.rows ?? [];
  const failedJobs = health?.failedJobs ?? [];
  const healthy = health?.health.status === 'ok';
  const userRows = usersPage?.users ?? [];

  return (
    <div
      data-testid="admin-screen"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
    >
      <div data-testid="admin-console" className="mx-auto w-full max-w-6xl px-4 sm:px-6 py-5 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <button
            type="button"
            data-testid="admin-back"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-9 px-2 -ml-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('admin.back')}
          </button>
          <div className="flex items-center gap-2">
            <LanguageMenu />
            <button
              type="button"
              onClick={refreshActive}
              disabled={activeLoading}
              data-testid="admin-refresh"
              className={SECONDARY_BUTTON}
            >
              <RefreshCw className={`w-4 h-4 ${activeLoading ? 'animate-spin' : ''}`} />
              {t('admin.refresh')}
            </button>
          </div>
        </div>

        <header className="mt-5">
          <div className="flex items-center gap-2 text-[11px] font-medium text-zinc-500">
            <ShieldCheck className="w-4 h-4 text-blue-400" />
            <span>{t('admin.console.eyebrow')}</span>
          </div>
          <h1 className="mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50">
            {t('admin.console.title')}
          </h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-zinc-400">
            {t('admin.console.subtitle')}
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

        <div
          role="tablist"
          aria-label={t('admin.tabs.aria')}
          data-testid="admin-tabs"
          className="mt-5 flex max-w-full items-center overflow-x-auto custom-scrollbar rounded-lg border border-white/5 bg-zinc-800/80 p-0.5 sm:inline-flex sm:w-auto"
        >
          {TABS.map((item) => {
            const selected = tab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                role="tab"
                aria-selected={selected}
                data-testid={`admin-tab-${item.id}`}
                onClick={() => setTab(item.id)}
                className={`relative flex-1 sm:flex-none whitespace-nowrap px-2.5 py-1.5 text-xs font-medium rounded-md transition-colors ${
                  selected ? 'text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {selected && (
                  <motion.span
                    layoutId="adminTabThumb"
                    className="absolute inset-0 bg-zinc-100 rounded-md shadow-sm"
                    transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                  />
                )}
                <span className="relative z-10 inline-flex items-center gap-1.5">
                  {item.icon}
                  {t(item.labelKey)}
                </span>
              </button>
            );
          })}
        </div>

        {/* ── Overview ─────────────────────────────────────────────────── */}
        {tab === 'overview' && (
          <section data-testid="admin-panel-overview" className="mt-6">
            {settings?.maintenance_mode && (
              <div
                role="status"
                data-testid="admin-maintenance-banner"
                className="mb-3 flex items-start gap-2.5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-4 py-3"
              >
                <Wrench className="w-4 h-4 text-amber-400 mt-0.5 shrink-0" />
                <p className="text-sm leading-relaxed text-amber-200/90">
                  {t('admin.overview.maintenanceOn')}
                </p>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              <StatCard
                icon={<Users className="w-4 h-4" />}
                label={t('admin.users.total')}
                value={stats ? formatNumber(stats.users.total) : '—'}
                hint={t('admin.overview.totalHint')}
                testId="admin-stat-total"
              />
              <StatCard
                icon={<UserPlus className="w-4 h-4" />}
                label={t('admin.overview.new7d')}
                value={stats ? formatNumber(stats.users.new7d) : '—'}
                hint={t('admin.overview.new7dHint')}
                testId="admin-stat-new7d"
              />
              <StatCard
                icon={<Activity className="w-4 h-4" />}
                label={t('admin.active.today')}
                value={stats ? formatNumber(stats.users.activeToday) : '—'}
                hint={t('admin.active.todayHint')}
                testId="admin-stat-active"
              />
              <StatCard
                icon={<UserRound className="w-4 h-4" />}
                label={t('admin.overview.guests')}
                value={stats ? formatNumber(stats.users.guests) : '—'}
                hint={t('admin.overview.guestsHint')}
                testId="admin-stat-guests"
              />
              <StatCard
                icon={<DollarSign className="w-4 h-4" />}
                label={t('admin.cost.today')}
                value={stats ? usd(stats.ai.todayCostUsd) : '—'}
                hint={t('admin.cost.todayHint', {
                  month: usd(stats?.ai.monthCostUsd ?? 0),
                  calls: formatNumber(stats?.ai.todayCalls ?? 0),
                })}
                testId="admin-stat-cost"
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
                testId="admin-stat-failed"
              />
            </div>

            {statsError && (
              <div className="mt-3">
                <ErrorBanner
                  message={statsError}
                  onRetry={() => { void loadStats(); }}
                  retryLabel={t('admin.retry')}
                />
              </div>
            )}
            {statsLoading && !stats && (
              <p className="mt-3 inline-flex items-center gap-2 text-xs text-zinc-500">
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                {t('admin.loading')}
              </p>
            )}
          </section>
        )}

        {/* ── Users ────────────────────────────────────────────────────── */}
        {tab === 'users' && (
          <section data-testid="admin-panel-users" className="mt-6">
            <SectionTitle
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
            />

            <div className="mt-3">
              {usersError ? (
                <ErrorBanner
                  message={usersError}
                  onRetry={() => { void loadUsers(offset, search); }}
                  retryLabel={t('admin.retry')}
                />
              ) : (
                <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
                  <div className="overflow-x-auto custom-scrollbar">
                    <table data-testid="admin-users-table" className="w-full min-w-[900px] text-left text-sm">
                      <thead className="bg-zinc-900/60 text-[11px] font-medium text-zinc-500">
                        <tr>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.username')}</th>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.email')}</th>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.users.credits')}</th>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.status')}</th>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap">{t('admin.users.createdAt')}</th>
                          <th scope="col" className="px-4 py-2.5 whitespace-nowrap text-right">{t('admin.users.actions')}</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-white/5">
                        {userRows.map((row) => {
                          const banned = row.status === 'banned';
                          const self = isSelf(row);
                          return (
                            <tr
                              key={row.userId || row.id}
                              data-testid="admin-user-row"
                              data-email={row.email}
                              data-status={banned ? 'banned' : 'active'}
                              className="text-zinc-300"
                            >
                              <td className="px-4 py-2.5 whitespace-nowrap">
                                <div className="flex items-center gap-2 min-w-0">
                                  <span className="max-w-[12rem] truncate font-medium text-zinc-200" title={displayUsername(row.username, row.email)}>
                                    {displayUsername(row.username, row.email)}
                                  </span>
                                  {self && (
                                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-800/80 border border-white/5 text-zinc-400">
                                      {t('admin.users.you')}
                                    </span>
                                  )}
                                </div>
                                <p className="mt-0.5 font-mono text-[10px] text-zinc-600">{row.id}</p>
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">
                                <span className="block max-w-[18rem] truncate text-zinc-400" title={row.email}>{row.email}</span>
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">
                                {formatNumber(row.credits ?? 0)}
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">
                                <StatusBadge banned={banned} />
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap text-xs text-zinc-400 tabular-nums">
                                {row.createdAt > 0 ? formatDate(row.createdAt, { dateStyle: 'medium' }) : '—'}
                              </td>
                              <td className="px-4 py-2.5 whitespace-nowrap">
                                <div className="flex items-center justify-end gap-1.5">
                                  <button
                                    type="button"
                                    data-testid="admin-user-credit"
                                    onClick={() => setCreditTarget(row)}
                                    className={`${COMPACT_BUTTON} bg-zinc-800/60 hover:bg-zinc-700/60 border-white/5 text-zinc-300 hover:text-zinc-100`}
                                  >
                                    <Coins className="w-3.5 h-3.5" />
                                    {t('admin.users.adjustCredits')}
                                  </button>
                                  <button
                                    type="button"
                                    data-testid="admin-user-status"
                                    onClick={() => setStatusTarget(row)}
                                    disabled={self && !banned}
                                    title={self && !banned ? t('admin.users.selfHint') : undefined}
                                    aria-label={self && !banned ? t('admin.users.selfHint') : undefined}
                                    className={`${COMPACT_BUTTON} ${
                                      banned
                                        ? 'bg-emerald-500/10 hover:bg-emerald-500/15 border-emerald-500/20 text-emerald-400'
                                        : 'bg-red-500/10 hover:bg-red-500/15 border-red-500/20 text-red-400'
                                    }`}
                                  >
                                    {banned ? <LockOpen className="w-3.5 h-3.5" /> : <Ban className="w-3.5 h-3.5" />}
                                    {banned ? t('admin.users.unban') : t('admin.users.ban')}
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                        {!usersLoading && userRows.length === 0 && (
                          <tr>
                            <td colSpan={6} className="px-4 py-10 text-center text-sm text-zinc-500">
                              {search ? t('admin.users.noMatch') : t('admin.users.empty')}
                            </td>
                          </tr>
                        )}
                        {usersLoading && userRows.length === 0 && (
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
                    <p data-testid="admin-users-page" className="text-[11px] text-zinc-500 tabular-nums">
                      {usersPage
                        ? t('admin.users.page', {
                          from: userRows.length > 0 ? formatNumber(usersPage.offset + 1) : '0',
                          to: formatNumber(usersPage.offset + userRows.length),
                          total: formatNumber(usersPage.total),
                        })
                        : '—'}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        data-testid="admin-users-prev"
                        className={SECONDARY_BUTTON}
                        disabled={usersLoading || offset <= 0}
                        onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
                      >
                        <ChevronLeft className="w-4 h-4" />
                        {t('admin.users.prev')}
                      </button>
                      <button
                        type="button"
                        data-testid="admin-users-next"
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
            </div>
          </section>
        )}

        {/* ── Settings ─────────────────────────────────────────────────── */}
        {tab === 'settings' && (
          <section data-testid="admin-panel-settings" className="mt-6 max-w-3xl">
            <SectionTitle
              id="admin-settings-title"
              title={t('admin.settings.title')}
              subtitle={t('admin.settings.subtitle')}
              action={settingsLoading ? (
                <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
              ) : undefined}
            />

            {settingsError ? (
              <div className="mt-3">
                <ErrorBanner
                  message={settingsError}
                  onRetry={() => { void loadSettings(); }}
                  retryLabel={t('admin.retry')}
                />
              </div>
            ) : (
              <>
                <div className="mt-4 rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-4">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                        <Wrench className="w-4 h-4 text-amber-400/80" />
                        {t('admin.settings.maintenance')}
                      </h3>
                      <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                        {t('admin.settings.maintenanceHint')}
                      </p>
                    </div>
                    <div className="flex items-center gap-2.5 shrink-0">
                      <span
                        data-testid="admin-settings-maintenance-state"
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-full border ${
                          maintenanceDraft
                            ? 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                            : 'bg-zinc-800/70 text-zinc-500 border-white/5'
                        }`}
                      >
                        {maintenanceDraft ? t('admin.settings.maintenanceOn') : t('admin.settings.maintenanceOff')}
                      </span>
                      <button
                        type="button"
                        role="switch"
                        aria-checked={maintenanceDraft}
                        aria-label={t('admin.settings.maintenance')}
                        data-testid="admin-settings-maintenance"
                        disabled={!settings || settingsLoading || settingsSaving}
                        onClick={() => {
                          setMaintenanceDraft((current) => !current);
                          setSettingsSaved(false);
                        }}
                        className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors disabled:opacity-50 ${
                          maintenanceDraft
                            ? 'bg-amber-500/80 border-amber-400/40'
                            : 'bg-zinc-700/80 border-white/5'
                        }`}
                      >
                        <span
                          className={`inline-block h-5 w-5 rounded-full bg-zinc-100 shadow transition-transform duration-200 ease-apple ${
                            maintenanceDraft ? 'translate-x-[22px]' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                  {maintenanceDraft && (
                    <p className="mt-3 flex items-start gap-1.5 text-xs leading-relaxed text-amber-300/90">
                      <TriangleAlert className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                      <span>{t('admin.settings.maintenanceWarning')}</span>
                    </p>
                  )}
                </div>

                <div className="mt-3 rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <h3 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                        <Megaphone className="w-4 h-4 text-blue-400/80" />
                        {t('admin.settings.announcement')}
                      </h3>
                      <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                        {t('admin.settings.announcementHint')}
                      </p>
                    </div>
                    <span className="text-[11px] text-zinc-500 tabular-nums shrink-0">
                      {t('admin.settings.announcementCount', {
                        count: formatNumber(announcementCount),
                        max: formatNumber(MAX_ANNOUNCEMENT_CHARS),
                      })}
                    </span>
                  </div>
                  <textarea
                    data-testid="admin-settings-announcement"
                    value={announcementDraft}
                    maxLength={MAX_ANNOUNCEMENT_CHARS}
                    rows={4}
                    onChange={(event) => {
                      setAnnouncementDraft(event.target.value);
                      setSettingsSaved(false);
                      if (settingsSaveError) setSettingsSaveError(null);
                    }}
                    placeholder={t('admin.settings.announcementPlaceholder')}
                    className="mt-3 w-full resize-y rounded-xl bg-zinc-800/50 border border-white/10 px-3 py-2.5 text-sm leading-relaxed text-zinc-100 placeholder:text-zinc-600 outline-none focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/15"
                  />

                  <div className="mt-3 rounded-xl border border-white/5 bg-zinc-950/50 p-3">
                    <p className="text-[11px] font-medium text-zinc-500">{t('admin.settings.preview')}</p>
                    {announcement ? (
                      <div
                        data-testid="admin-announcement-preview"
                        className="mt-2 rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-2 text-xs leading-relaxed text-blue-200 break-words"
                      >
                        {announcement}
                      </div>
                    ) : (
                      <p data-testid="admin-announcement-preview-empty" className="mt-2 text-xs text-zinc-600">
                        {t('admin.settings.previewEmpty')}
                      </p>
                    )}
                  </div>
                </div>

                {settingsSaveError && (
                  <p
                    role="alert"
                    data-testid="admin-settings-error"
                    className="mt-3 flex items-start gap-1.5 text-xs text-red-400 leading-relaxed"
                  >
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{settingsSaveError}</span>
                  </p>
                )}

                <div className="mt-4 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="admin-settings-save"
                    onClick={() => { void saveSettings(); }}
                    disabled={!settingsDirty || settingsSaving || !settings}
                    className={PRIMARY_BUTTON}
                  >
                    {settingsSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {settingsSaving ? t('admin.settings.saving') : t('admin.settings.save')}
                  </button>
                  <button
                    type="button"
                    data-testid="admin-settings-reload"
                    onClick={() => { void loadSettings(); }}
                    disabled={settingsSaving || !settingsDirty}
                    className={SECONDARY_BUTTON}
                  >
                    <RefreshCw className="w-4 h-4" />
                    {t('admin.settings.reload')}
                  </button>
                  {settingsDirty && (
                    <span data-testid="admin-settings-dirty" className="text-[11px] text-amber-400/90">
                      {t('admin.settings.dirty')}
                    </span>
                  )}
                  {settingsSaved && !settingsDirty && (
                    <span
                      data-testid="admin-settings-saved"
                      className="inline-flex items-center gap-1 text-[11px] text-emerald-400"
                    >
                      <CircleCheck className="w-3.5 h-3.5" />
                      {t('admin.settings.saved')}
                    </span>
                  )}
                </div>
              </>
            )}
          </section>
        )}

        {/* ── Usage & health ───────────────────────────────────────────── */}
        {tab === 'ops' && (
          <section data-testid="admin-panel-ops" className="mt-6 space-y-8">
            <div>
              <SectionTitle
                id="admin-usage-title"
                title={t('admin.usage.title')}
                subtitle={
                  usage
                    ? t('admin.usage.subtitle', { start: usage.start, end: usage.end })
                    : t('admin.usage.subtitleLoading')
                }
                action={usageLoading ? (
                  <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                ) : undefined}
              />

              <div className="mt-3">
                {usageError ? (
                  <ErrorBanner
                    message={usageError}
                    onRetry={() => { void loadUsage(); }}
                    retryLabel={t('admin.retry')}
                  />
                ) : (
                  <div className="rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
                    <div className="overflow-x-auto custom-scrollbar">
                      <table data-testid="admin-usage-table" className="w-full min-w-[640px] text-left text-sm">
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
                              <td className="px-4 py-2.5 whitespace-nowrap text-right tabular-nums">{usd(row.costUsd)}</td>
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
                              <td className="px-4 py-2.5 text-right tabular-nums">{usd(usage.totals.costUsd)}</td>
                            </tr>
                          </tfoot>
                        )}
                      </table>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div>
              <SectionTitle
                id="admin-health-title"
                title={t('admin.health.title')}
                subtitle={t('admin.health.subtitle')}
                action={healthLoading ? (
                  <Loader2 className="w-4 h-4 text-zinc-500 animate-spin" />
                ) : health ? (
                  <span
                    data-testid="admin-health-status"
                    className={`inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-1 rounded-full border ${
                      healthy
                        ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                        : 'bg-amber-500/10 text-amber-400 border-amber-500/20'
                    }`}
                  >
                    {healthy ? <CircleCheck className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    {healthy ? t('admin.health.ok') : t('admin.health.degraded')}
                  </span>
                ) : undefined}
              />

              <div className="mt-3">
                {healthError ? (
                  <ErrorBanner
                    message={healthError}
                    onRetry={() => { void loadHealth(); }}
                    retryLabel={t('admin.retry')}
                  />
                ) : (
                  <div data-testid="admin-health" className="grid grid-cols-1 lg:grid-cols-2 gap-3">
                    <div className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
                      <dl className="space-y-3 text-sm">
                        <div className="flex items-start justify-between gap-4">
                          <dt className="inline-flex items-center gap-2 text-zinc-500 shrink-0">
                            <Server className="w-4 h-4" />
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
                          <dt className="inline-flex items-center gap-2 text-zinc-500 shrink-0">
                            <Database className="w-4 h-4" />
                            {t('admin.health.migrations')}
                          </dt>
                          <dd
                            data-testid="admin-health-migrations"
                            className="text-right text-zinc-300 break-all font-mono text-xs"
                          >
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
                          <dd data-testid="admin-health-disk" className="text-right text-zinc-300 tabular-nums">
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
                        <ul data-testid="admin-failed-jobs" className="mt-3 space-y-2">
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
              </div>
            </div>
          </section>
        )}

        <p className="mt-8 text-[11px] leading-relaxed text-zinc-500">
          {t('admin.footerNote')}
        </p>
      </div>

      {creditTarget && (
        <CreditDialog
          target={creditTarget}
          onClose={() => setCreditTarget(null)}
          onSaved={handleCreditsSaved}
          onAuthError={deny}
        />
      )}
      {statusTarget && (
        <StatusDialog
          target={statusTarget}
          onClose={() => setStatusTarget(null)}
          onSaved={handleStatusSaved}
          onAuthError={deny}
        />
      )}
    </div>
  );
}
