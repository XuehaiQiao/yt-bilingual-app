// Account page — the signed-in user's own dashboard (specs/023 frontend).
//
// One full-screen view (like review/report/admin) opened from the top bar:
//   header   avatar placeholder + display name (inline rename via
//            PATCH /api/user/profile) + email + member-since date
//   balance  credits / month AI spend / today's learning minutes
//            (GET /api/user/summary; no payment system: the balance is
//            credited by an administrator)
//   settings interface + translation language (the shared
//            LanguageSettingsModal), default model (shared ModelBar), PWA
//            install entry (shared PwaInstallButton)
//   about    version, official blog (existing BlogScreen), privacy/terms
//            placeholder — no fabricated links
//   actions  logout, plus the admin console entry for administrators only
//
// Guests never get a summary response (403); the page shows a login prompt
// instead of an error so the entry stays useful from a guest session.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  ArrowLeft,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  FileText,
  Globe,
  Languages,
  Loader2,
  LogOut,
  Pencil,
  RefreshCw,
  ShieldCheck,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import { getLanguageMeta, type LanguageCode } from '../i18n';
import { useInstallPrompt, useOnlineStatus } from '../lib/pwa';
import { toast, describeApiError } from '../lib/toast';
import { displayUsername, usernameInitial, usernameProblem } from '../lib/username';
import { LanguageSettingsModal } from './LanguageSettingsModal';
import { ModelBar } from './ModelBar';
import { PwaInstallButton } from './PwaInstallButton';

export interface AccountUser {
  id: string;
  email: string;
  username?: string | null;
  credits: number;
  memberSince: number;
  status?: string;
}

interface AccountSummary {
  user: AccountUser;
  monthSpendUsd: number;
  usageToday: { minutes: number };
  version: string;
  preliminary: boolean;
}

interface AccountScreenProps {
  onClose: () => void;
  /** Opens the existing public blog view (the product's official window). */
  onOpenBlog?: () => void;
  /** Opens the admin console view — only rendered for administrators. */
  onOpenAdmin?: () => void;
  /** Guest shell: opens the login overlay. */
  onRequestLogin?: () => void;
}

const PRIMARY_BUTTON =
  'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50 disabled:pointer-events-none';
const SECONDARY_BUTTON =
  'inline-flex items-center justify-center gap-2 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:pointer-events-none';
const ROW_BUTTON =
  'inline-flex items-center gap-2 h-8 px-2.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-white/5 transition-colors shrink-0';

/**
 * `$0.0042` for tiny estimates, `$1.20` otherwise. The fraction digits are
 * pinned explicitly: `formatNumber` uses Intl's default ceiling of 3 digits,
 * which would round the ledger's 6-decimal estimates to `$0.004`.
 */
function formatUsd(value: number, language: LanguageCode): string {
  if (!Number.isFinite(value)) return '$0.00';
  const digits = value !== 0 && Math.abs(value) < 0.01 ? 4 : 2;
  const number = new Intl.NumberFormat(getLanguageMeta(language).locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(value);
  return `$${number}`;
}

function CardTitle({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-zinc-100">
      <span className="text-zinc-500">{icon}</span>
      {children}
    </h2>
  );
}

function SettingRow({
  icon,
  label,
  hint,
  stack = false,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  hint?: string;
  /** Put the control on its own line below `sm` (wide controls like ModelBar). */
  stack?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      className={`flex gap-3 p-4 ${
        stack
          ? 'flex-col sm:flex-row sm:items-center sm:justify-between'
          : 'items-center justify-between'
      }`}
    >
      <div className="flex min-w-0 items-center gap-3">
        <span className="text-zinc-500 shrink-0">{icon}</span>
        <div className="min-w-0">
          <p className="text-sm font-medium text-zinc-200">{label}</p>
          {hint && <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">{hint}</p>}
        </div>
      </div>
      <div
        className={`flex shrink-0 items-center ${
          stack ? 'w-full justify-end sm:w-auto' : ''
        }`}
      >
        {children}
      </div>
    </div>
  );
}

export const AccountScreen: React.FC<AccountScreenProps> = ({
  onClose,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
}) => {
  const { status, user, isAdmin, logout, updateUsername } = useAuth();
  const { t, language, targetLang, languages, formatNumber, formatDate } = useI18n();
  const online = useOnlineStatus();
  const { canInstall, isIos, isStandalone } = useInstallPrompt();

  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);

  const isAuthenticated = status === 'authenticated';
  const currentName = displayUsername(
    summary?.user.username ?? user?.username,
    summary?.user.email ?? user?.email,
  );
  const currentEmail = summary?.user.email ?? user?.email ?? '';
  const memberSince = summary?.user.memberSince ?? 0;

  const loadSummary = useCallback(async () => {
    if (status !== 'authenticated') return;
    setIsLoading(true);
    setLoadError(null);
    setForbidden(false);
    try {
      const res = await apiFetch('/api/user/summary');
      if (res.status === 403) {
        setForbidden(true);
        return;
      }
      if (!res.ok) throw new Error(await describeApiError(res));
      const data = (await res.json().catch(() => null)) as AccountSummary | null;
      if (!data || !data.user) throw new Error(t('account.error.load'));
      setSummary(data);
    } catch (err) {
      setLoadError(await describeApiError(err));
    } finally {
      setIsLoading(false);
    }
  }, [status, t]);

  useEffect(() => {
    void loadSummary();
  }, [loadSummary]);

  const startEditingName = () => {
    setNameDraft(currentName);
    setNameError(null);
    setIsEditingName(true);
  };

  const cancelEditingName = () => {
    setIsEditingName(false);
    setNameError(null);
  };

  const saveName = async () => {
    if (isSavingName) return;
    const problem = usernameProblem(nameDraft);
    if (problem) {
      setNameError(t(problem));
      return;
    }
    if (nameDraft.trim() === currentName) {
      setIsEditingName(false);
      return;
    }
    setIsSavingName(true);
    setNameError(null);
    try {
      const next = await updateUsername(nameDraft);
      setSummary((prev) => (prev
        ? { ...prev, user: { ...prev.user, username: next.username ?? null } }
        : prev));
      setIsEditingName(false);
      toast.success(t('account.username.saved'));
    } catch (err) {
      setNameError(await describeApiError(err));
    } finally {
      setIsSavingName(false);
    }
  };

  const handleLogout = async () => {
    await logout();
  };

  // Guest / session-expired: the summary endpoint is 403 by contract, so the
  // page offers a login entry instead of an error banner.
  if (!isAuthenticated || forbidden) {
    return (
      <div
        data-testid="account-screen"
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
      >
        <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
          <button
            type="button"
            data-testid="account-back"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-9 px-2 -ml-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('account.back')}
          </button>

          <div
            data-testid="account-guest"
            className="mt-16 flex flex-col items-center justify-center py-16 text-center"
          >
            <div className="w-14 h-14 rounded-full bg-zinc-800/80 border border-white/5 flex items-center justify-center">
              <UserRound className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="mt-4 text-sm font-medium text-zinc-300">{t('account.guest.title')}</p>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-500">
              {t('account.guest.desc')}
            </p>
            {onRequestLogin && (
              <button
                type="button"
                data-testid="account-guest-login"
                onClick={onRequestLogin}
                className={`${PRIMARY_BUTTON} mt-5`}
              >
                <UserRound className="w-4 h-4" />
                {t('account.guest.login')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  const credits = summary?.user.credits ?? 0;
  const monthSpend = summary?.monthSpendUsd ?? 0;
  const minutes = summary?.usageToday.minutes ?? 0;
  const version = summary?.version ?? '';
  const targetLanguage =
    languages.find((item) => item.code === targetLang) ?? languages[0];

  return (
    <div
      data-testid="account-screen"
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
    >
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 sm:py-8">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <button
            type="button"
            data-testid="account-back"
            onClick={onClose}
            className="inline-flex items-center gap-1.5 h-9 px-2 -ml-2 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            {t('account.back')}
          </button>
          <button
            type="button"
            onClick={() => { void loadSummary(); }}
            disabled={isLoading}
            data-testid="account-refresh"
            className={SECONDARY_BUTTON}
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            {t('account.refresh')}
          </button>
        </div>

        {/* ── Header: avatar + display name + email + member since ─────── */}
        <header className="mt-5 flex items-start gap-4">
          <div
            data-testid="account-avatar"
            aria-hidden="true"
            className="w-14 h-14 shrink-0 rounded-full bg-zinc-800/80 border border-white/10 flex items-center justify-center text-xl font-semibold text-zinc-100"
          >
            {usernameInitial(currentName) || <UserRound className="w-6 h-6 text-zinc-500" />}
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-medium text-zinc-500">{t('account.eyebrow')}</p>
            {isEditingName ? (
              <div className="mt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    data-testid="account-username-input"
                    type="text"
                    autoComplete="nickname"
                    aria-label={t('account.username.editAria')}
                    aria-invalid={nameError ? true : undefined}
                    value={nameDraft}
                    autoFocus
                    onChange={(event) => {
                      setNameDraft(event.target.value);
                      if (nameError) setNameError(null);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault();
                        void saveName();
                      } else if (event.key === 'Escape') {
                        event.preventDefault();
                        cancelEditingName();
                      }
                    }}
                    className="h-10 w-full max-w-[16rem] min-w-0 rounded-xl bg-zinc-800/50 border border-white/10 px-3 text-lg font-semibold text-zinc-100 outline-none focus-visible:border-brand/60 focus-visible:ring-2 focus-visible:ring-brand/15"
                  />
                  <button
                    type="button"
                    data-testid="account-username-save"
                    onClick={() => { void saveName(); }}
                    disabled={isSavingName}
                    aria-label={t('account.username.save')}
                    title={t('account.username.save')}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-zinc-100 text-zinc-900 hover:bg-white active:scale-[0.98] transition-colors disabled:opacity-50"
                  >
                    {isSavingName ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    data-testid="account-username-cancel"
                    onClick={cancelEditingName}
                    disabled={isSavingName}
                    aria-label={t('account.username.cancel')}
                    title={t('account.username.cancel')}
                    className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 transition-colors"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
                {nameError ? (
                  <p
                    data-testid="account-username-error"
                    role="alert"
                    className="mt-1.5 flex items-start gap-1.5 text-xs text-red-400 leading-relaxed"
                  >
                    <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                    <span>{nameError}</span>
                  </p>
                ) : (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                    {t('account.username.hint')}
                  </p>
                )}
              </div>
            ) : (
              <div className="mt-1 flex items-center gap-1.5 min-w-0">
                <h1
                  data-testid="account-username"
                  className="min-w-0 truncate text-2xl font-semibold tracking-tight text-zinc-50"
                >
                  {currentName}
                </h1>
                <button
                  type="button"
                  data-testid="account-edit-username"
                  onClick={startEditingName}
                  aria-label={t('account.username.editAria')}
                  title={t('account.username.editAria')}
                  className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors shrink-0"
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {isAdmin && (
                  <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300 shrink-0">
                    {t('account.adminBadge')}
                  </span>
                )}
              </div>
            )}
            <p
              data-testid="account-email"
              className="mt-1 truncate text-sm text-zinc-400"
              title={currentEmail}
            >
              {currentEmail}
            </p>
            <p className="mt-1 text-xs text-zinc-500 tabular-nums">
              {t('account.memberSince', {
                date: memberSince > 0
                  ? formatDate(memberSince, { dateStyle: 'long' })
                  : '—',
              })}
            </p>
          </div>
        </header>

        {loadError && (
          <section
            role="alert"
            data-testid="account-error"
            className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4"
          >
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
              <div className="min-w-0">
                <p className="text-sm leading-relaxed text-zinc-300 break-words">{loadError}</p>
                <button
                  type="button"
                  onClick={() => { void loadSummary(); }}
                  className={`${SECONDARY_BUTTON} mt-3`}
                >
                  <RefreshCw className="w-4 h-4" />
                  {t('account.retry')}
                </button>
              </div>
            </div>
          </section>
        )}

        {/* ── Balance card: credits / month spend / today's minutes ────── */}
        <motion.section
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          aria-label={t('account.balance.title')}
          className="mt-6"
        >
          <CardTitle icon={<Wallet className="w-5 h-5" />}>{t('account.balance.title')}</CardTitle>
          <div
            data-testid="account-balance"
            className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-px rounded-2xl border border-white/5 bg-white/5 overflow-hidden"
          >
            <div className="bg-zinc-900/60 p-4 min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                <Coins className="w-3.5 h-3.5 text-amber-400/80" />
                {t('account.balance.credits')}
              </div>
              <p
                data-testid="account-credits"
                className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100 tabular-nums break-words"
              >
                {!summary ? '—' : formatNumber(credits)}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {t('account.balance.creditsHint')}
              </p>
            </div>
            <div className="bg-zinc-900/60 p-4 min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                <Wallet className="w-3.5 h-3.5 text-blue-400/80" />
                {t('account.balance.monthSpend')}
              </div>
              <p
                data-testid="account-month-spend"
                className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100 tabular-nums break-words"
              >
                {!summary ? '—' : formatUsd(monthSpend, language)}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {t('account.balance.monthSpendHint')}
              </p>
            </div>
            <div className="bg-zinc-900/60 p-4 min-w-0">
              <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                <Clock className="w-3.5 h-3.5 text-emerald-400/80" />
                {t('account.balance.today')}
              </div>
              <p
                data-testid="account-today-minutes"
                className="mt-1.5 text-2xl font-semibold tracking-tight text-zinc-100 tabular-nums break-words"
              >
                {!summary
                  ? '—'
                  : t('account.balance.minutes', {
                    minutes: formatNumber(Number(minutes.toFixed(1))),
                  })}
              </p>
              <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                {t('account.balance.todayHint')}
              </p>
            </div>
          </div>
          <p data-testid="account-balance-note" className="mt-2 text-[11px] leading-relaxed text-zinc-500">
            {t('account.balance.adminNote')}
            {summary?.preliminary && (
              <span data-testid="account-preliminary"> {t('account.balance.preliminary')}</span>
            )}
          </p>
        </motion.section>

        {/* ── Settings ─────────────────────────────────────────────────── */}
        <section aria-label={t('account.settings.title')} className="mt-8">
          <CardTitle icon={<Languages className="w-5 h-5" />}>{t('account.settings.title')}</CardTitle>
          <div className="mt-3 divide-y divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/40">
            <SettingRow
              icon={<Languages className="w-4 h-4" />}
              label={t('account.settings.uiLanguage')}
              hint={t('account.settings.uiLanguageHint')}
            >
              <button
                type="button"
                data-testid="account-language"
                onClick={() => setLanguageOpen(true)}
                aria-haspopup="dialog"
                className={ROW_BUTTON}
                title={t('account.settings.languageAria')}
              >
                {languages.find((item) => item.code === language)?.nativeName ?? language}
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
              </button>
            </SettingRow>

            <SettingRow
              icon={<Globe className="w-4 h-4" />}
              label={t('account.settings.targetLanguage')}
              hint={t('account.settings.targetLanguageHint')}
            >
              <button
                type="button"
                data-testid="account-target-language"
                onClick={() => setLanguageOpen(true)}
                aria-haspopup="dialog"
                className={ROW_BUTTON}
                title={t('account.settings.languageAria')}
              >
                {targetLanguage?.nativeName ?? targetLang}
                <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
              </button>
            </SettingRow>

            <SettingRow
              icon={<span className="block w-4 h-4 rounded-md bg-blue-500/20 border border-blue-500/30" />}
              label={t('account.settings.model')}
              hint={t('account.settings.modelHint')}
              stack
            >
              <ModelBar />
            </SettingRow>

            <SettingRow
              icon={<FileText className="w-4 h-4" />}
              label={t('account.settings.install')}
              hint={t('account.settings.installHint')}
              stack
            >
              {isStandalone ? (
                <span
                  data-testid="account-install-installed"
                  className="text-xs font-medium text-emerald-400"
                >
                  {t('account.settings.installed')}
                </span>
              ) : !online ? (
                <span data-testid="account-install-hint" className="max-w-[18rem] text-right text-[11px] leading-relaxed text-zinc-500">
                  {t('account.settings.installOffline')}
                </span>
              ) : canInstall || isIos ? (
                <PwaInstallButton />
              ) : (
                <span
                  data-testid="account-install-hint"
                  className="max-w-[18rem] text-right text-[11px] leading-relaxed text-zinc-500"
                >
                  {t('account.settings.installUnavailable')}
                </span>
              )}
            </SettingRow>
          </div>
        </section>

        {/* ── About ────────────────────────────────────────────────────── */}
        <section aria-label={t('account.about.title')} className="mt-8">
          <CardTitle icon={<FileText className="w-5 h-5" />}>{t('account.about.title')}</CardTitle>
          <div className="mt-3 divide-y divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
            <SettingRow
              icon={<FileText className="w-4 h-4" />}
              label={t('account.about.version')}
            >
              <span
                data-testid="account-version"
                className="text-sm font-medium text-zinc-300 tabular-nums"
              >
                {version ? `v${version}` : '—'}
              </span>
            </SettingRow>

            <button
              type="button"
              data-testid="account-blog"
              onClick={onOpenBlog}
              disabled={!onOpenBlog}
              className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors disabled:cursor-default"
            >
              <span className="flex min-w-0 items-center gap-3">
                <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
                <span className="text-sm font-medium text-zinc-200">{t('account.about.blog')}</span>
              </span>
              <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
            </button>

            {/* Privacy/terms have no page yet: say so instead of inventing a
                URL (spec: "不要造假链接"). */}
            <div className="flex items-center justify-between gap-3 p-4">
              <span className="flex min-w-0 items-center gap-3">
                <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
                <span className="text-sm font-medium text-zinc-200">{t('account.about.legal')}</span>
              </span>
              <span
                data-testid="account-legal-pending"
                className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/70 border border-white/5 text-zinc-500 shrink-0"
              >
                {t('account.about.legalPending')}
              </span>
            </div>
          </div>
        </section>

        {/* ── Actions ──────────────────────────────────────────────────── */}
        <section className="mt-8 space-y-3">
          {isAdmin && onOpenAdmin && (
            <div>
              <button
                type="button"
                data-testid="account-admin-entry"
                onClick={onOpenAdmin}
                className="w-full inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-sm font-medium text-blue-300 hover:text-blue-200 transition-colors"
              >
                <ShieldCheck className="w-4 h-4" />
                {t('account.adminEntry')}
                <ChevronRight className="w-4 h-4" />
              </button>
              <p className="mt-1.5 text-center text-[11px] leading-relaxed text-zinc-500">
                {t('account.adminEntryHint')}
              </p>
            </div>
          )}

          <button
            type="button"
            data-testid="account-logout"
            onClick={() => { void handleLogout(); }}
            className="w-full inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-sm font-medium text-red-400 transition-colors"
          >
            <LogOut className="w-4 h-4" />
            {t('account.logout')}
          </button>
        </section>

        <p className="mt-8 text-center text-[11px] leading-relaxed text-zinc-600">
          {t('account.footerNote')}
        </p>
      </div>

      <LanguageSettingsModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
    </div>
  );
};
