// Profile — first-level page (P0 IA §3.4). AccountScreen's body now doubles
// as the 我的 page: account header + library rows (favorites / weekly report /
// ability profile) + balance + settings + about + admin console + logout.
//
// The same component still supports the legacy full-screen "account" shell
// (back button) for compatibility; `isPage` switches the chrome and hides it.
// Guests see a login card instead of the balance, but keep favorites,
// language/model/install settings and about — the IA explicitly keeps them
// usable without an account.
import { useCallback, useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import {
  AlertCircle,
  BookOpen,
  CalendarRange,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Coins,
  FileText,
  Gauge,
  Languages,
  Loader2,
  Lock,
  LogOut,
  Pencil,
  RefreshCw,
  ShieldCheck,
  BookMarked,
  UserRound,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import type { PlacementProfile } from '../lib/placement';
import { useInstallPrompt, useOnlineStatus } from '../lib/pwa';
import { BackButton } from './ui/BackButton';
import { PageHeader } from './ui/PageHeader';
import { toast, describeApiError } from '../lib/toast';
import { displayUsername, usernameInitial, usernameProblem } from '../lib/username';
import { loadVocabLevel, saveVocabLevel, VOCAB_LEVEL_EVENT, VOCAB_LEVELS, type VocabLevelId } from '../lib/settings';
import { formatMicroUsd, formatUsdNumber } from '../lib/billing';
import { LanguageSettingsModal } from './LanguageSettingsModal';
import { AccountDataSection, PendingDeletionCard } from './AccountDataSection';
import { ModelBar } from './ModelBar';
import { PwaInstallButton } from './PwaInstallButton';
import { VocabAxis } from './ui/Axis';
import { Button } from './ui/Button';

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
  /** Book balance in integer µUSD (M3a / specs/034). */
  balanceMicroUsd?: number;
  balanceUsd?: string;
  /** Book balance minus active call holds. */
  availableMicroUsd?: number;
  availableUsd?: string;
  activeHoldsMicroUsd?: number;
  /** Frozen pre-M3 `users.credits` unit — history only, never a bill. */
  creditsLegacy?: number;
  monthSpendUsd: number;
  usageToday: { minutes: number };
  version: string;
  preliminary: boolean;
}

interface AccountScreenProps {
  /** Legacy full-screen close. Optional on the first-level 我的 page. */
  onClose?: () => void;
  /** Parent screen name for the legacy back control's aria label. */
  parentLabel?: string;
  /** First-level page mode: page title instead of a back button. */
  isPage?: boolean;
  /** Opens the existing public blog view (the product's official window). */
  onOpenBlog?: () => void;
  /** Opens the admin console view — only rendered for administrators. */
  onOpenAdmin?: () => void;
  /** Guest shell: opens the login overlay. */
  onRequestLogin?: () => void;
  /** 我的·单词本 row (opens the standalone word-book page). */
  onOpenWordbook?: () => void;
  wordbookCount?: number;
  /** 我的·本周报告 row. */
  onOpenReport?: () => void;
  /** 我的·能力档案 row: opens the full ability profile. */
  onOpenAbility?: () => void;
  placementProfile?: PlacementProfile | null;
}

const ROW_BUTTON =
  'inline-flex items-center gap-2 h-8 px-2.5 rounded-lg text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-white/5 transition-colors shrink-0';

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
  parentLabel,
  isPage = false,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
  onOpenWordbook,
  wordbookCount = 0,
  onOpenReport,
  onOpenAbility,
  placementProfile = null,
}) => {
  const { status, user, isAdmin, logout, updateUsername } = useAuth();
  const { t, language, languages, formatNumber, formatDate } = useI18n();
  const online = useOnlineStatus();
  const { canInstall, isIos, isStandalone } = useInstallPrompt();

  const [summary, setSummary] = useState<AccountSummary | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [languageOpen, setLanguageOpen] = useState(false);
  // The CEFR axis now lives here (moved out of the content page); the choice
  // is stored immediately and drives word highlighting in later content.
  const [vocabLevel, setVocabLevel] = useState<VocabLevelId>(loadVocabLevel);
  const vocabLevelMeta = VOCAB_LEVELS.find((level) => level.id === vocabLevel) ?? VOCAB_LEVELS[0];

  const handleVocabLevelChange = (level: VocabLevelId) => {
    if (level === vocabLevel) return;
    setVocabLevel(level);
    saveVocabLevel(level);
    toast.success(t('profile.vocabLevelSaved'));
  };

  // App seeds the slider from the ability profile on first run (or another
  // tab changes it); keep the displayed value in sync without a remount.
  useEffect(() => {
    const sync = () => setVocabLevel(loadVocabLevel());
    window.addEventListener(VOCAB_LEVEL_EVENT, sync);
    window.addEventListener('storage', sync);
    return () => {
      window.removeEventListener(VOCAB_LEVEL_EVENT, sync);
      window.removeEventListener('storage', sync);
    };
  }, []);

  const [isEditingName, setIsEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState('');
  const [nameError, setNameError] = useState<string | null>(null);
  const [isSavingName, setIsSavingName] = useState(false);

  const isAuthenticated = status === 'authenticated';
  // 7-day deletion cooldown (specs/033): the account is signed in but every
  // business endpoint answers 403 `account_pending_deletion`, so the page swaps
  // the balance/library for the cooldown card + export, never the guest card.
  const isPendingDeletion = isAuthenticated && user?.status === 'deletion_pending';
  const currentName = displayUsername(
    summary?.user.username ?? user?.username,
    summary?.user.email ?? user?.email,
  );
  const currentEmail = summary?.user.email ?? user?.email ?? '';
  const memberSince = summary?.user.memberSince ?? 0;

  const loadSummary = useCallback(async () => {
    // Pending accounts cannot read /api/user/summary (403 by contract); skip
    // the request instead of flashing a "forbidden" banner on every visit.
    if (status !== 'authenticated' || isPendingDeletion) return;
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
  }, [status, isPendingDeletion, t]);

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

  const refreshAction = isAuthenticated && (
    <Button
      variant="secondary"
      size="md"
      loading={isLoading}
      onClick={() => { void loadSummary(); }}
      testId="account-refresh"
      iconLeft={<RefreshCw className="w-4 h-4" />}
    >
      {t('account.refresh')}
    </Button>
  );

  const pageChrome = isPage ? (
    <div className="flex items-start justify-between gap-3">
      <PageHeader
        title={t('profile.title')}
        subtitle={t('profile.subtitle')}
        testId="profile-page-header"
        titleTestId="profile-title"
      />
      {refreshAction}
    </div>
  ) : (
    <div className="flex items-center justify-between gap-3">
      <BackButton
        onBack={() => onClose?.()}
        parentLabel={parentLabel}
        testId="account-back"
        className="-ml-2"
      />
      {refreshAction}
    </div>
  );

  // Library rows: the word book works for guests too; report/placement row opens
  // the view (the app routes guests to login when the screen needs an account).
  const libraryRows = (
    <section aria-label={t('profile.library')} className="mt-6">
      <div className="grid grid-cols-1 lg:grid-cols-3 divide-y lg:divide-y-0 lg:divide-x divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
        <button
          type="button"
          data-testid="profile-wordbook-row"
          onClick={onOpenWordbook}
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="flex min-w-0 items-center gap-3">
            <BookMarked className="w-4 h-4 text-amber-400/90 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-200">{t('profile.wordbook')}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{t('profile.wordbookHint')}</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span className="text-xs text-zinc-500 tabular-nums">
              {t('profile.wordbookCount', { count: formatNumber(wordbookCount) })}
            </span>
            <ChevronRight className="w-4 h-4 text-zinc-600" />
          </span>
        </button>

        <button
          type="button"
          data-testid="profile-report-row"
          onClick={onOpenReport}
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="flex min-w-0 items-center gap-3">
            <CalendarRange className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-200">{t('profile.report')}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{t('profile.reportHint')}</span>
            </span>
          </span>
          <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
        </button>

        <button
          type="button"
          data-testid="profile-level-row"
          onClick={onOpenAbility}
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="flex min-w-0 items-center gap-3">
            <Gauge className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="min-w-0">
              <span className="block text-sm font-medium text-zinc-200">{t('profile.level')}</span>
              <span className="mt-0.5 block text-xs text-zinc-500">{t('profile.levelHint')}</span>
            </span>
          </span>
          <span className="flex items-center gap-1.5 shrink-0">
            <span data-testid="profile-level-value" className="text-xs text-zinc-500">
              {placementProfile
                ? placementProfile.cefr || t('placement.profile.noIntervalShort')
                : t('profile.levelEmpty')}
            </span>
            <ChevronRight className="w-4 h-4 text-zinc-600" />
          </span>
        </button>
      </div>
    </section>
  );

  const settingsSection = (
    <section
      aria-label={t('account.settings.title')}
      data-testid="account-settings"
      className="mt-8"
    >
      <CardTitle icon={<Languages className="w-5 h-5" />}>{t('account.settings.title')}</CardTitle>
      <div className="mt-3 divide-y divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/40">
        <SettingRow
          icon={<Languages className="w-4 h-4" />}
          label={t('account.settings.yourLanguage')}
          hint={t('account.settings.yourLanguageHint')}
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
          icon={<span className="block w-4 h-4 rounded-md bg-blue-500/20 border border-blue-500/30" />}
          label={t('account.settings.model')}
          hint={t('account.settings.modelHint')}
          stack
        >
          <ModelBar />
        </SettingRow>

        {/* CEFR axis (moved from the content page): inline, saved on pick. */}
        <div data-testid="account-vocab-level" className="p-4">
          <div className="flex items-start gap-3">
            <BookOpen className="w-4 h-4 text-zinc-500 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-zinc-200">{t('home.vocabAxisTitle')}</p>
                  <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                    {t('profile.vocabLevelHint')}
                  </p>
                </div>
                <span
                  data-testid="account-vocab-current"
                  className="inline-flex shrink-0 items-center rounded-full border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-0.5 text-[11px] font-medium text-zinc-300 tabular-nums"
                >
                  {vocabLevelMeta.label}
                </span>
              </div>
              <div className="mt-3 max-w-xl">
                <VocabAxis
                  value={vocabLevel}
                  onChange={handleVocabLevelChange}
                  showTitle={false}
                />
              </div>
            </div>
          </div>
        </div>

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
  );

  const aboutSection = (
    <section
      aria-label={t('account.about.title')}
      data-testid="account-about"
      className="mt-8"
    >
      <CardTitle icon={<FileText className="w-5 h-5" />}>{t('account.about.title')}</CardTitle>
      <div className="mt-3 divide-y divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/40 overflow-hidden">
        <SettingRow icon={<FileText className="w-4 h-4" />} label={t('account.about.version')}>
          <span
            data-testid="account-version"
            className="text-sm font-medium text-zinc-300 tabular-nums"
          >
            {summary?.version ? `v${summary.version}` : '—'}
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

        {/* The two legal pages are real public routes (M4): plain anchors leave
            the app shell the same way the blog entry does. */}
        <a
          href="#/privacy"
          data-testid="account-privacy"
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="flex min-w-0 items-center gap-3">
            <ShieldCheck className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="text-sm font-medium text-zinc-200">{t('account.about.privacy')}</span>
          </span>
          <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
        </a>

        <a
          href="#/terms"
          data-testid="account-terms"
          className="w-full flex items-center justify-between gap-3 p-4 text-left hover:bg-white/[0.03] transition-colors"
        >
          <span className="flex min-w-0 items-center gap-3">
            <FileText className="w-4 h-4 text-zinc-500 shrink-0" />
            <span className="text-sm font-medium text-zinc-200">{t('account.about.terms')}</span>
          </span>
          <ChevronRight className="w-4 h-4 text-zinc-600 shrink-0" />
        </a>
      </div>
    </section>
  );

  // Guest / session-expired: the summary endpoint is 403 by contract. The
  // page still offers the word book, settings and about; the account header offers
  // login instead of an error banner.
  // The summary endpoint is 403 for guests and for `deletion_pending`
  // accounts. Only the former is a login gate; the pending case keeps the
  // page and shows the cooldown card (below) instead of the guest card.
  if (!isAuthenticated || (forbidden && !isPendingDeletion)) {
    return (
      <div
        data-testid="account-screen"
        data-page-scroll
        className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10"
      >
        <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
          {pageChrome}

          <div
            data-testid="account-guest"
            className="mt-6 rounded-3xl border border-white/5 bg-zinc-900/40 p-6 sm:p-8 flex flex-col items-center text-center"
          >
            <div className="w-14 h-14 rounded-full bg-zinc-800/80 border border-white/5 flex items-center justify-center">
              <UserRound className="w-6 h-6 text-zinc-500" />
            </div>
            <p className="mt-4 text-sm font-medium text-zinc-300">{t('account.guest.title')}</p>
            <p className="mt-1 max-w-xs text-xs leading-relaxed text-zinc-500">
              {t('account.guest.desc')}
            </p>
            {onRequestLogin && (
              <Button
                variant="primary"
                size="lg"
                onClick={onRequestLogin}
                testId="account-guest-login"
                iconLeft={<UserRound className="w-4 h-4" />}
                className="mt-5"
              >
                {t('account.guest.login')}
              </Button>
            )}
          </div>

          {libraryRows}
          {settingsSection}
          {aboutSection}

          <p className="mt-8 text-center text-[11px] leading-relaxed text-zinc-600">
            {t('account.footerNote')}
          </p>
        </div>

        <LanguageSettingsModal isOpen={languageOpen} onClose={() => setLanguageOpen(false)} />
      </div>
    );
  }

  const balanceMicro = summary?.balanceMicroUsd ?? 0;
  const availableMicro = summary?.availableMicroUsd ?? balanceMicro;
  const holdsMicro = summary?.activeHoldsMicroUsd ?? 0;
  const creditsLegacy = summary?.creditsLegacy ?? summary?.user.credits ?? 0;
  const negative = Boolean(summary) && (balanceMicro < 0 || availableMicro < 0);
  const monthSpend = summary?.monthSpendUsd ?? 0;
  const minutes = summary?.usageToday.minutes ?? 0;

  return (
    <div
      data-testid="account-screen"
      data-page-scroll
      className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10"
    >
      <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 py-6 sm:py-8">
        {pageChrome}

        {isPendingDeletion && <PendingDeletionCard />}

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
                <h2
                  data-testid="account-username"
                  className="min-w-0 truncate text-2xl font-semibold tracking-tight text-zinc-50"
                >
                  {currentName}
                </h2>
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
                <Button
                  variant="secondary"
                  size="md"
                  onClick={() => { void loadSummary(); }}
                  iconLeft={<RefreshCw className="w-4 h-4" />}
                  className="mt-3"
                >
                  {t('account.retry')}
                </Button>
              </div>
            </div>
          </section>
        )}

        {!isPendingDeletion && libraryRows}

        {/* ── Balance card (M3b / specs/034): micro-USD balance + usage ── */}
        {!isPendingDeletion && (
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
            data-negative={negative ? 'true' : undefined}
            className={`mt-3 rounded-2xl border bg-zinc-900/40 overflow-hidden ${
              negative ? 'border-red-500/30' : 'border-white/5'
            }`}
          >
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-px bg-white/5">
              {/* Available balance = book balance − active call holds. */}
              <div className="bg-zinc-900/60 p-4 sm:p-5 min-w-0">
                <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                  <Wallet className={`w-3.5 h-3.5 ${negative ? 'text-red-400' : 'text-blue-400/80'}`} />
                  {t('account.balance.available')}
                </div>
                <p
                  data-testid="account-balance-available"
                  className={`mt-1.5 text-3xl font-semibold tracking-tight tabular-nums break-words ${
                    negative ? 'text-red-400' : 'text-zinc-50'
                  }`}
                >
                  {!summary ? '—' : formatMicroUsd(availableMicro, language)}
                </p>
                <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                  {t('account.balance.availableHint')}
                </p>
                <p className="mt-2 text-xs text-zinc-500 tabular-nums">
                  {t('account.balance.book')}{' '}
                  <span
                    data-testid="account-balance-book"
                    className={`font-medium ${negative ? 'text-red-300' : 'text-zinc-200'}`}
                  >
                    {!summary ? '—' : formatMicroUsd(balanceMicro, language)}
                  </span>
                </p>
                {summary && holdsMicro > 0 && (
                  <p
                    data-testid="account-balance-holds"
                    className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300 tabular-nums"
                  >
                    <Lock className="w-3 h-3" />
                    {t('account.balance.holdsValue', {
                      amount: formatMicroUsd(holdsMicro, language),
                    })}
                  </p>
                )}
                {summary && holdsMicro > 0 && (
                  <p className="mt-1.5 text-[11px] leading-relaxed text-zinc-500">
                    {t('account.balance.holdsHint')}
                  </p>
                )}
              </div>

              {/* Month AI spend + today's learning (the summary's existing fields). */}
              <div className="bg-zinc-900/60 p-4 sm:p-5 min-w-0 grid grid-cols-2 gap-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                    <Coins className="w-3.5 h-3.5 text-amber-400/80" />
                    {t('account.balance.monthSpend')}
                  </div>
                  <p
                    data-testid="account-month-spend"
                    className="mt-1.5 text-xl font-semibold tracking-tight text-zinc-100 tabular-nums break-words"
                  >
                    {!summary ? '—' : formatUsdNumber(monthSpend, language)}
                  </p>
                  <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                    {t('account.balance.monthSpendHint')}
                  </p>
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-zinc-500">
                    <Clock className="w-3.5 h-3.5 text-emerald-400/80" />
                    {t('account.balance.today')}
                  </div>
                  <p
                    data-testid="account-today-minutes"
                    className="mt-1.5 text-xl font-semibold tracking-tight text-zinc-100 tabular-nums break-words"
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
            </div>

            {/* Zero / negative balance: say exactly what happens on the next AI call. */}
            {summary && availableMicro <= 0 && (
              <div
                role="status"
                data-testid="account-balance-low"
                className={`flex items-start gap-2.5 border-t px-4 py-3 sm:px-5 ${
                  negative
                    ? 'border-red-500/20 bg-red-500/[0.06]'
                    : 'border-amber-500/20 bg-amber-500/[0.06]'
                }`}
              >
                <AlertCircle
                  className={`w-4 h-4 mt-0.5 shrink-0 ${negative ? 'text-red-400' : 'text-amber-400'}`}
                />
                <p
                  className={`text-xs leading-relaxed ${
                    negative ? 'text-red-200/90' : 'text-amber-200/90'
                  }`}
                >
                  {negative ? t('account.balance.overrun') : t('account.balance.zero')}
                </p>
              </div>
            )}

            <div
              data-testid="account-balance-note"
              className="border-t border-white/5 bg-zinc-900/30 px-4 py-3 sm:px-5"
            >
              <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-zinc-500">
                <li>{t('account.balance.grant')}</li>
                <li>{t('account.balance.topup')}</li>
                <li>{t('account.balance.nonRefundable')}</li>
              </ul>
              {creditsLegacy > 0 && (
                <p
                  data-testid="account-balance-legacy"
                  className="mt-2 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-zinc-500"
                >
                  {t('account.balance.legacy', { credits: formatNumber(creditsLegacy) })}
                </p>
              )}
              {summary?.preliminary && (
                <p data-testid="account-preliminary" className="mt-1 text-[11px] leading-relaxed text-amber-400/80">
                  {t('account.balance.preliminary')}
                </p>
              )}
            </div>
          </div>
        </motion.section>
        )}

        {settingsSection}
        {aboutSection}

        <AccountDataSection pending={isPendingDeletion} />

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
