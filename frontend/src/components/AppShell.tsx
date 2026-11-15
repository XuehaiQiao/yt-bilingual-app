// Application chrome (P0 IA §4.1 / §5 / §6).
//
// Desktop (md+): brand · four text tabs · model / language / user.
// Mobile (<md): compact bar with logo + current page + language / user, and
// the four tabs live in the fixed bottom bar instead.
// Sub views keep the desktop chrome (tabs stay usable) but drop the mobile
// top/bottom bars — those screens carry their own back / close affordances.
import { LogIn, UserRound } from 'lucide-react';
import type { ReactNode } from 'react';
import type { NavState, TabId } from '../lib/nav';
import { useAuth } from '../lib/auth';
import { displayUsername, usernameInitial } from '../lib/username';
import { useI18n } from '../i18n/I18nProvider';
import { BottomBar } from './BottomBar';
import { LanguageMenu } from './LanguageMenu';
import { ModelBar } from './ModelBar';
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
  /** A full-screen sub view is open (mobile chrome is hidden). */
  isSub: boolean;
  onNavigate: (tab: TabId) => void;
  onRequestLogin?: () => void;
  children: ReactNode;
}

export function AppShell({
  state,
  dueCount,
  isSub,
  onNavigate,
  onRequestLogin,
  children,
}: AppShellProps) {
  const { t } = useI18n();
  const { status, user } = useAuth();

  const displayName = displayUsername(user?.username, user?.email);
  const initial = usernameInitial(displayName);
  const isGuest = status === 'guest';
  const activeLabel = t(TAB_LABEL_KEYS[state.tab]);

  return (
    <>
      <header
        data-testid="top-bar"
        className={`flex-none h-12 md:h-16 bg-zinc-950/60 backdrop-blur-xl border-b border-white/5 px-3 sm:px-4 lg:px-6 items-center gap-2 z-20 ${
          isSub ? 'hidden md:flex' : 'flex'
        }`}
      >
        {/* Left: brand (logo always, name ≥lg). Mobile also names the page. */}
        <div className="flex items-center gap-2.5 min-w-0 shrink-0">
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
          <h1
            className="hidden lg:block text-lg font-semibold tracking-tight text-zinc-100 cursor-pointer hover:text-white transition-colors whitespace-nowrap"
            onClick={() => onNavigate('today')}
          >
            {t('brand.name')}
          </h1>
          <span
            data-testid="topbar-page-title"
            className="md:hidden text-[17px] leading-none font-semibold tracking-tight text-zinc-100 truncate"
          >
            {activeLabel}
          </span>
        </div>

        <TopBarTabs activeTab={state.tab} dueCount={dueCount} onNavigate={onNavigate} />

        {/* Right: model chip (desktop) · language · user. Logout moved to 我的. */}
        <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0 pl-2 sm:pl-3 border-l border-white/5 min-w-0">
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
    </>
  );
}
