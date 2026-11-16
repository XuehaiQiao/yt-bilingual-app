// Application chrome (P0 IA §4.1 / §5 / §6, desktop IA revision).
//
// ≥lg:  [Sidebar 240/72] [ TopBar · Main ]   — a real desktop three-pane shell.
// md–lg: brand (logo only) · four text tabs · model / language / user.
// <md:   compact bar with logo + current page + language / user; the four tabs
//        live in the fixed bottom bar instead.
//
// Immersive task views (video / reader / sentence pack / review / exam …) hide
// the Sidebar and the primary tabs on desktop so the workspace owns the full
// width. Non-task sub views (blog / discover / report / favorites) keep the
// shell, which gives their shortcut entry a visible active state.
import { LogIn, Play, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { NavState, TabId } from '../lib/nav';
import { useAuth } from '../lib/auth';
import { displayUsername, usernameInitial } from '../lib/username';
import { useI18n } from '../i18n/I18nProvider';
import { BottomBar } from './BottomBar';
import { LanguageMenu } from './LanguageMenu';
import { ModelBar } from './ModelBar';
import { Sidebar } from './Sidebar';
import { TAB_SUBTITLE_KEYS } from '../lib/navTabs';
import { TopBarTabs } from './TopBarTabs';
import type { TranslationKey } from '../i18n';

const TAB_LABEL_KEYS: Record<TabId, TranslationKey> = {
  today: 'nav.today',
  content: 'nav.content',
  practice: 'nav.practice',
  profile: 'nav.profile',
};

interface AppShellProps {
  state: NavState;
  dueCount: number;
  /** Any sub view is open (mobile chrome is hidden, as before). */
  isSub: boolean;
  /** Immersive task: desktop Sidebar + tabs hide so the view is full width. */
  isTask: boolean;
  /** Breadcrumb fragment for the open sub view (e.g. 官方博客). */
  subLabel?: string;
  onNavigate: (tab: TabId) => void;
  onRequestLogin?: () => void;
  /** Desktop shortcut: jump to Content and focus the paste input. */
  onStartLearning: () => void;
  onOpenFavorites: () => void;
  onOpenReport: () => void;
  onOpenHistory: () => void;
  onOpenSentences: () => void;
  onOpenLibrary: () => void;
  onOpenBooks: () => void;
  onOpenDiscover: () => void;
  onOpenBlog: () => void;
  onOpenAdmin: () => void;
  children: ReactNode;
}

export function AppShell({
  state,
  dueCount,
  isSub,
  isTask,
  subLabel,
  onNavigate,
  onRequestLogin,
  onStartLearning,
  onOpenFavorites,
  onOpenReport,
  onOpenHistory,
  onOpenSentences,
  onOpenLibrary,
  onOpenBooks,
  onOpenDiscover,
  onOpenBlog,
  onOpenAdmin,
  children,
}: AppShellProps) {
  const { t } = useI18n();
  const { status, user } = useAuth();

  const displayName = displayUsername(user?.username, user?.email);
  const initial = usernameInitial(displayName);
  const isGuest = status === 'guest';
  const activeLabel = t(TAB_LABEL_KEYS[state.tab]);
  const desktopTitle = isSub && subLabel ? subLabel : activeLabel;
  const desktopSubtitle = isSub ? activeLabel : t(TAB_SUBTITLE_KEYS[state.tab]);

  return (
    <div className="flex flex-1 min-h-0 min-w-0 overflow-hidden">
      {!isTask && (
        <Sidebar
          state={state}
          dueCount={dueCount}
          onNavigate={onNavigate}
          onOpenFavorites={onOpenFavorites}
          onOpenReport={onOpenReport}
          onOpenHistory={onOpenHistory}
          onOpenSentences={onOpenSentences}
          onOpenLibrary={onOpenLibrary}
          onOpenBooks={onOpenBooks}
          onOpenDiscover={onOpenDiscover}
          onOpenBlog={onOpenBlog}
          onOpenAdmin={onOpenAdmin}
          onRequestLogin={onRequestLogin}
        />
      )}

      <div className="flex flex-1 min-h-0 min-w-0 flex-col">
        <header
          data-testid="top-bar"
          className={`flex-none h-12 md:h-16 bg-zinc-950/60 backdrop-blur-xl border-b border-white/5 px-3 sm:px-4 lg:px-6 items-center gap-2 z-20 ${
            isSub ? 'hidden md:flex' : 'flex'
          }`}
        >
          {/* Left · <lg: brand (logo always, name ≥lg lives in the Sidebar).
              Mobile also names the current page. */}
          <div className="flex lg:hidden items-center gap-2.5 min-w-0 shrink-0">
            <button
              type="button"
              data-testid="brand-home"
              onClick={() => onNavigate('today')}
              aria-label={t('brand.name')}
              title={t('brand.name')}
              className="w-8 h-8 md:w-10 md:h-10 rounded-[10px] overflow-hidden ring-1 ring-white/10 cursor-pointer flex-shrink-0 focus-visible:outline-none"
            >
              <img src="/hero_icon.png" alt={t('topbar.logoAlt')} className="w-full h-full object-cover" />
            </button>
            <span
              data-testid="topbar-mobile-title"
              className="md:hidden text-[17px] leading-none font-semibold tracking-tight text-zinc-100 truncate"
            >
              {activeLabel}
            </span>
          </div>

          {/* Left · ≥lg: page title + one-line subtitle / breadcrumb. The brand
              and primary navigation live in the Sidebar, so this never repeats
              the four tabs. */}
          <div className="hidden lg:flex flex-col justify-center min-w-0">
            <h1
              data-testid="topbar-page-title"
              className="truncate text-[15px] font-semibold tracking-tight text-zinc-100"
            >
              {desktopTitle}
            </h1>
            <p
              data-testid="topbar-page-subtitle"
              className="truncate text-[11px] leading-tight text-zinc-500"
            >
              {desktopSubtitle}
            </p>
          </div>

          {/* md–lg keep the existing text tabs; ≥lg (and immersive tasks) do not. */}
          {!isTask && (
            <div data-testid="topbar-tabs" className="hidden md:flex flex-1 min-w-0 lg:hidden">
              <TopBarTabs activeTab={state.tab} dueCount={dueCount} onNavigate={onNavigate} />
            </div>
          )}

          {/* Right: desktop start shortcut · model chip (md+) · language · user. */}
          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0 pl-2 sm:pl-3 border-l border-white/5 min-w-0">
            <button
              type="button"
              data-testid="topbar-start"
              onClick={onStartLearning}
              aria-label={t('topbar.startLearningTitle')}
              title={t('topbar.startLearningTitle')}
              className="hidden lg:inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-zinc-100 text-zinc-900 text-xs font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple shrink-0"
            >
              <Play className="w-3.5 h-3.5 fill-current" />
              <span className="whitespace-nowrap">{t('topbar.startLearning')}</span>
            </button>
            <div className="hidden md:block">
              <ModelBar compact />
            </div>
            <LanguageMenu />
            {isGuest && onRequestLogin && (
              <button
                type="button"
                data-testid="guest-login-button"
                onClick={onRequestLogin}
                aria-label={t('topbar.guestLoginAria')}
                title={t('topbar.guestLoginAria')}
                className="inline-flex items-center gap-1.5 h-9 px-2.5 rounded-xl bg-brand/10 hover:bg-brand/15 border border-brand/20 text-xs font-medium text-brand-300 hover:text-brand-400 transition-colors shrink-0"
              >
                <LogIn className="w-4 h-4" />
                <span className="hidden sm:inline whitespace-nowrap">{t('topbar.guestLogin')}</span>
              </button>
            )}
            <button
              type="button"
              data-testid="topbar-account"
              onClick={() => onNavigate('profile')}
              aria-current={state.tab === 'profile' ? 'page' : undefined}
              aria-label={t('topbar.accountAria')}
              title={isGuest
                ? t('topbar.accountAria')
                : user?.email
                  ? `${displayName} · ${user.email}`
                  : displayName}
              className={`inline-flex items-center gap-1.5 h-9 px-1.5 sm:pr-2.5 rounded-xl border transition-colors shrink-0 ${
                state.tab === 'profile'
                  ? 'bg-zinc-700/60 border-white/10 text-zinc-100'
                  : 'bg-zinc-800/60 hover:bg-zinc-700/60 border-white/5 text-zinc-300 hover:text-zinc-100'
              }`}
            >
              <span
                aria-hidden="true"
                className="w-6 h-6 rounded-full bg-zinc-700 border border-white/10 flex items-center justify-center text-[10px] font-semibold text-zinc-200 shrink-0"
              >
                {initial || <UserRound className="w-3.5 h-3.5 text-zinc-400" />}
              </span>
              <span
                data-testid="topbar-username"
                className="hidden lg:inline max-w-[7.5rem] truncate text-xs font-medium"
              >
                {isGuest ? t('topbar.accountAria') : displayName}
              </span>
            </button>
          </div>
        </header>

        <main
          data-testid="app-main"
          className="flex-1 min-h-0 flex flex-col overflow-hidden relative"
        >
          {children}
        </main>

        {!isSub && <BottomBar activeTab={state.tab} dueCount={dueCount} onNavigate={onNavigate} />}
      </div>
    </div>
  );
}
