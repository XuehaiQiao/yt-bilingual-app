// Desktop navigation rail (≥lg). P0 asks for a real three-pane shell: a fixed
// 240px sidebar that also carries the "shortcut" destinations the old top bar
// could not fit. Collapsing to 72px (icons + tooltips) keeps the main region
// wide for the learning workspace; the choice is persisted in localStorage.
//
// Everything here routes through the same App callbacks as the top tabs, so a
// shortcut is a second door to an existing view — never a new screen.
import { useState } from 'react';
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Compass,
  GraduationCap,
  History,
  Library,
  Newspaper,
  Settings,
  ShieldCheck,
  UserRound,
  type LucideIcon,
} from 'lucide-react';
import type { NavState, TabId } from '../lib/nav';
import { formatDueBadge, NAV_TABS } from '../lib/navTabs';
import { useAuth } from '../lib/auth';
import { displayUsername, usernameInitial } from '../lib/username';
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from '../lib/layout';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { LanguageMenu } from './LanguageMenu';

export type SidebarQuickId =
  | 'history'
  | 'sentences'
  | 'library'
  | 'books'
  | 'discover'
  | 'blog'
  | 'admin';

interface SidebarProps {
  state: NavState;
  dueCount: number;
  onNavigate: (tab: TabId) => void;
  onOpenHistory: () => void;
  /** Opens the sentence packs at the learner's current vocabulary band. */
  onOpenSentences: () => void;
  onOpenLibrary: () => void;
  onOpenBooks: () => void;
  onOpenDiscover: () => void;
  onOpenBlog: () => void;
  onOpenAdmin: () => void;
  onRequestLogin?: () => void;
}

interface QuickItemDef {
  id: SidebarQuickId;
  icon: LucideIcon;
  labelKey: TranslationKey;
  onClick: () => void;
  /** Optional count badge (word book only today). */
  count?: number;
}

interface QuickGroup {
  id: string;
  labelKey: TranslationKey;
  items: QuickItemDef[];
}

export function Sidebar({
  state,
  dueCount,
  onNavigate,
  onOpenHistory,
  onOpenSentences,
  onOpenLibrary,
  onOpenBooks,
  onOpenDiscover,
  onOpenBlog,
  onOpenAdmin,
  onRequestLogin,
}: SidebarProps) {
  const { t } = useI18n();
  const { status, user, isAdmin } = useAuth();
  const [collapsed, setCollapsed] = useState<boolean>(loadSidebarCollapsed);

  const isGuest = status === 'guest';
  const displayName = displayUsername(user?.username, user?.email);
  const initial = usernameInitial(displayName);

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  };

  const subKind = state.sub?.kind ?? null;
  const activeQuick: SidebarQuickId | null =
    subKind === 'sentences' ? 'sentences'
      : subKind === 'discover' ? 'discover'
        : subKind === 'blog' ? 'blog'
          : subKind === 'admin' ? 'admin'
            : null;

  const quickGroups: QuickGroup[] = [
    {
      id: 'content',
      labelKey: 'sidebar.group.content',
      items: [
        { id: 'library', icon: Library, labelKey: 'sidebar.library', onClick: onOpenLibrary },
        { id: 'books', icon: BookOpen, labelKey: 'sidebar.books', onClick: onOpenBooks },
        { id: 'discover', icon: Compass, labelKey: 'sidebar.discover', onClick: onOpenDiscover },
        { id: 'sentences', icon: GraduationCap, labelKey: 'sidebar.sentences', onClick: onOpenSentences },
        { id: 'blog', icon: Newspaper, labelKey: 'sidebar.blog', onClick: onOpenBlog },
      ],
    },
    {
      id: 'history',
      labelKey: 'sidebar.group.history',
      items: [
        { id: 'history', icon: History, labelKey: 'sidebar.history', onClick: onOpenHistory },
      ],
    },
  ];
  if (isAdmin) {
    quickGroups.push({
      id: 'manage',
      labelKey: 'sidebar.group.manage',
      items: [
        { id: 'admin', icon: ShieldCheck, labelKey: 'sidebar.admin', onClick: onOpenAdmin },
      ],
    });
  }

  const navButtonClass = (active: boolean) =>
    `relative flex w-full items-center rounded-xl transition-colors duration-200 ${
      collapsed ? 'justify-center h-10' : 'gap-3 h-10 px-3'
    } ${
      active
        ? 'bg-white/[0.07] text-zinc-50'
        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
    }`;

  const renderBadge = (count: number, testId: string, compact: boolean) =>
    count > 0 ? (
      <span
        data-testid={testId}
        aria-label={t('practice.badge.aria', { count })}
        className={`min-w-[16px] h-4 px-1 rounded-full bg-brand text-[9px] font-semibold text-white tabular-nums flex items-center justify-center ${
          compact ? 'absolute -top-1 -right-1.5' : 'ml-auto shrink-0'
        }`}
      >
        {formatDueBadge(count)}
      </span>
    ) : null;

  return (
    <aside
      data-testid="sidebar"
      data-collapsed={collapsed ? 'true' : 'false'}
      aria-label={t('nav.aria.primary')}
      style={{ width: collapsed ? 72 : 240 }}
      className="hidden lg:flex flex-none h-full flex-col overflow-hidden border-r border-white/5 bg-zinc-950/50 backdrop-blur-xl transition-[width] duration-200 ease-apple"
    >
      {/* Brand + collapse toggle. Collapsed: logo above the chevron. */}
      <div
        className={`flex-none flex items-center border-b border-white/5 ${
          collapsed ? 'flex-col justify-center gap-1 h-16 px-2' : 'gap-2.5 h-16 px-3'
        }`}
      >
        <button
          type="button"
          data-testid="sidebar-brand"
          onClick={() => onNavigate('today')}
          aria-label={t('brand.fullName')}
          title={t('brand.fullName')}
          className={`rounded-[10px] overflow-hidden ring-1 ring-white/10 cursor-pointer flex-shrink-0 focus-visible:outline-none ${
            collapsed ? 'w-8 h-8' : 'w-9 h-9'
          }`}
        >
          <img src="/hero_icon.png" alt={t('topbar.logoAlt')} className="w-full h-full object-cover" />
        </button>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <p data-testid="sidebar-brand-name" className="truncate text-[15px] font-semibold tracking-tight text-zinc-100">
              {t('brand.name')}
            </p>
            <p className="truncate text-[10px] font-medium text-zinc-500">LinguaTrek</p>
          </div>
        )}
        <button
          type="button"
          data-testid="sidebar-toggle"
          onClick={toggle}
          aria-expanded={!collapsed}
          aria-label={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          title={collapsed ? t('sidebar.expand') : t('sidebar.collapse')}
          className={`inline-flex items-center justify-center rounded-lg border border-white/5 bg-zinc-800/40 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/60 transition-colors shrink-0 ${
            collapsed ? 'w-8 h-6' : 'w-8 h-8 ml-auto'
          }`}
        >
          {collapsed
            ? <ChevronRight className="w-4 h-4" aria-hidden="true" />
            : <ChevronLeft className="w-4 h-4" aria-hidden="true" />}
        </button>
      </div>

      {/* Scrollable destinations; the user card stays pinned below. */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-2 py-3">
        <nav aria-label={t('nav.aria.primary')}>
          <ul className="flex flex-col gap-1">
            {NAV_TABS.map(tab => {
              const Icon = tab.icon;
              const active = state.tab === tab.id;
              const label = t(tab.labelKey);
              return (
                <li key={tab.id}>
                  <button
                    type="button"
                    data-testid={`sidebar-nav-${tab.id}`}
                    aria-current={active ? 'page' : undefined}
                    aria-label={label}
                    title={label}
                    onClick={() => onNavigate(tab.id)}
                    className={navButtonClass(active)}
                  >
                    <span className={collapsed ? 'relative' : 'relative shrink-0'}>
                      <Icon
                        className={`w-[18px] h-[18px] ${active ? 'text-brand-400' : 'text-zinc-500'}`}
                        aria-hidden="true"
                      />
                      {tab.id === 'practice' && collapsed && renderBadge(dueCount, 'sidebar-practice-badge', true)}
                    </span>
                    {!collapsed && (
                      <span className="min-w-0 truncate text-sm font-medium">{label}</span>
                    )}
                    {tab.id === 'practice' && !collapsed && renderBadge(dueCount, 'sidebar-practice-badge', false)}
                  </button>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="mt-4 border-t border-white/5 pt-3">
          {!collapsed && (
            <p className="px-3 pb-1.5 text-[10px] font-medium text-zinc-600">{t('sidebar.quick')}</p>
          )}
          <div className="flex flex-col gap-3">
            {quickGroups.map((group, groupIndex) => (
              <section
                key={group.id}
                aria-label={t(group.labelKey)}
                className={collapsed && groupIndex > 0 ? 'border-t border-white/5 pt-2' : undefined}
              >
                {!collapsed && (
                  <p className="px-3 pb-1 text-[10px] font-medium text-zinc-600">{t(group.labelKey)}</p>
                )}
                <ul className="flex flex-col gap-0.5">
                  {group.items.map(item => {
                    const Icon = item.icon;
                    const label = t(item.labelKey);
                    const active = activeQuick === item.id;
                    return (
                      <li key={item.id}>
                        <button
                          type="button"
                          data-testid={`sidebar-quick-${item.id}`}
                          aria-current={active ? 'page' : undefined}
                          aria-label={label}
                          title={label}
                          onClick={item.onClick}
                          className={navButtonClass(active)}
                        >
                          <span className={collapsed ? 'relative' : 'relative shrink-0'}>
                            <Icon
                              className={`w-[18px] h-[18px] ${active ? 'text-brand-400' : 'text-zinc-500'}`}
                              aria-hidden="true"
                            />
                          </span>
                          {!collapsed && (
                            <span className="min-w-0 truncate text-sm font-medium">{label}</span>
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ))}
          </div>
        </div>
      </div>

      {/* Pinned footer: account + language + settings. */}
      <div className="flex-none border-t border-white/5 p-2.5">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              data-testid="sidebar-user"
              onClick={() => (isGuest ? onRequestLogin?.() : onNavigate('profile'))}
              aria-label={t('topbar.accountAria')}
              title={isGuest ? t('sidebar.loginHint') : displayName || t('topbar.accountAria')}
              className="w-9 h-9 rounded-full bg-zinc-800/80 border border-white/10 flex items-center justify-center text-xs font-semibold text-zinc-200 hover:border-white/20 hover:bg-zinc-700/80 transition-colors"
            >
              {initial || <UserRound className="w-4 h-4 text-zinc-500" />}
            </button>
            <LanguageMenu iconOnly />
            <button
              type="button"
              data-testid="sidebar-settings"
              onClick={() => onNavigate('profile')}
              aria-label={t('profile.settings')}
              title={t('profile.settings')}
              className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-400 hover:text-zinc-100 transition-colors"
            >
              <Settings className="w-4 h-4" aria-hidden="true" />
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              data-testid="sidebar-user"
              onClick={() => (isGuest ? onRequestLogin?.() : onNavigate('profile'))}
              aria-label={t('topbar.accountAria')}
              title={isGuest ? t('sidebar.loginHint') : user?.email || displayName}
              className="w-full flex items-center gap-2.5 p-2 rounded-xl hover:bg-white/5 border border-transparent hover:border-white/5 transition-colors"
            >
              <span
                aria-hidden="true"
                className="w-8 h-8 rounded-full bg-zinc-800/80 border border-white/10 flex items-center justify-center text-[11px] font-semibold text-zinc-200 shrink-0"
              >
                {initial || <UserRound className="w-4 h-4 text-zinc-500" />}
              </span>
              <span className="min-w-0 flex-1 text-left">
                <span data-testid="sidebar-username" className="block truncate text-[13px] font-medium text-zinc-200">
                  {isGuest ? t('sidebar.guest') : displayName || t('topbar.accountAria')}
                </span>
                <span className="block truncate text-[10px] text-zinc-500">
                  {isGuest ? t('sidebar.loginHint') : user?.email}
                </span>
              </span>
            </button>
            <div className="mt-2 flex items-center gap-2">
              <LanguageMenu />
              <button
                type="button"
                data-testid="sidebar-settings"
                onClick={() => onNavigate('profile')}
                aria-label={t('profile.settings')}
                title={t('profile.settings')}
                className="ml-auto inline-flex items-center justify-center w-9 h-9 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-400 hover:text-zinc-100 transition-colors"
              >
                <Settings className="w-4 h-4" aria-hidden="true" />
              </button>
            </div>
          </>
        )}
      </div>
    </aside>
  );
}
