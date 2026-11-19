// Desktop navigation rail (≥lg): four expandable browse pages, their second
// level destinations, a pinned official-blog / admin strip and the user card.
//
// The four first-level rows still navigate exactly like the top tabs; the
// chevron beside each row is a separate disclosure button, so expanding a
// group never changes the page and navigating never toggles the group. Every
// child is a second door to an existing route / scroll target — the route
// model itself is untouched (see lib/nav.ts and navigation-model.md).
//
// Collapsing to 72px keeps only the first-level icons (plus the pinned
// blog/admin icons): children and chevrons are removed from the DOM, while the
// per-tab expanded state stays remembered for the next uncollapsed render. The
// choice is persisted in localStorage.
import { useEffect, useState } from 'react';
import {
  ArrowUpRight,
  ChevronLeft,
  ChevronRight,
  CornerDownRight,
  Newspaper,
  Play,
  Settings,
  ShieldCheck,
  UserRound,
} from 'lucide-react';
import type { NavState, TabId } from '../lib/nav';
import { formatDueBadge, NAV_TABS, type NavTabDef } from '../lib/navTabs';
import { useAuth } from '../lib/auth';
import { displayUsername, usernameInitial } from '../lib/username';
import {
  loadSidebarCollapsed,
  saveSidebarCollapsed,
} from '../lib/layout';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { LanguageMenu } from './LanguageMenu';

/** Scroll destinations inside the 我的 page (each maps to a section testid). */
export type ProfileSectionId = 'account' | 'balance' | 'settings' | 'about';

interface SidebarProps {
  state: NavState;
  dueCount: number;
  onNavigate: (tab: TabId) => void;
  /** Content · start learning: jump to Content and focus the paste composer. */
  onStartLearning: () => void;
  /** History · recent learning: Today tab, scrolled to the recent list. */
  onOpenHistory: () => void;
  onOpenSentences: () => void;
  onOpenLibrary: () => void;
  onOpenBooks: () => void;
  onOpenDiscover: () => void;
  /** History · weekly report. */
  onOpenReport: () => void;
  /** Practice · today's review. */
  onOpenReview: () => void;
  /** Practice · exam practice. */
  onOpenExam: () => void;
  /** Practice · placement test. */
  onOpenPlacement: () => void;
  /** Profile · ability profile. */
  onOpenAbility: () => void;
  /** Profile · scroll to a section of the 我的 page (navigating there first). */
  onOpenProfileSection: (section: ProfileSectionId) => void;
  /** Pinned bottom strip (admin console only for admins). */
  onOpenAdmin: () => void;
  onRequestLogin?: () => void;
}

type SidebarSubItemKind = 'action' | 'section' | 'page';

interface SidebarSubItemDef {
  id: string;
  kind: SidebarSubItemKind;
  labelKey: TranslationKey;
  active: boolean;
  onSelect: () => void;
  /**
   * Test id used by the pre-expandable rail. Kept as a thin compatibility
   * alias so the existing navigation e2e (check-nav-e2e.mjs) keeps passing.
   */
  legacyQuickId?: string;
}

interface SidebarGroupDef {
  tab: NavTabDef;
  items: SidebarSubItemDef[];
}

// Owner order for the expanded desktop rail: content, history, practice,
// profile. The visible tab strip / mobile bottom bar keep their own order; a
// sidebar row is still a second door to the same tab root.
const SIDEBAR_TAB_ORDER: readonly TabId[] = ['content', 'today', 'practice', 'profile'];

const SIDEBAR_TABS: readonly NavTabDef[] = SIDEBAR_TAB_ORDER
  .map((id) => NAV_TABS.find((tab) => tab.id === id))
  .filter((tab): tab is NavTabDef => Boolean(tab));

const SUBMENU_KINDS = [
  { kind: 'action', labelKey: 'sidebar.submenu.action' },
  { kind: 'section', labelKey: 'sidebar.submenu.section' },
  { kind: 'page', labelKey: 'sidebar.submenu.page' },
] as const;

export function Sidebar({
  state,
  dueCount,
  onNavigate,
  onStartLearning,
  onOpenHistory,
  onOpenSentences,
  onOpenLibrary,
  onOpenBooks,
  onOpenDiscover,
  onOpenReport,
  onOpenReview,
  onOpenExam,
  onOpenPlacement,
  onOpenAbility,
  onOpenProfileSection,
  onOpenAdmin,
  onRequestLogin,
}: SidebarProps) {
  const { t } = useI18n();
  const { status, user, isAdmin } = useAuth();
  const [collapsed, setCollapsed] = useState<boolean>(loadSidebarCollapsed);
  // Single-open accordion. Navigating opens the destination; the chevron alone
  // can close/reopen it, so at most one group is expanded at a time.
  const [openTab, setOpenTab] = useState<TabId | null>(state.tab);
  // Which 我的 section was last picked. The three lower sections are scroll
  // targets, not routes, so they cannot derive an active state from NavState.
  const [profileSection, setProfileSection] = useState<ProfileSectionId | null>(null);

  const isGuest = status === 'guest';
  const displayName = displayUsername(user?.username, user?.email);
  const initial = usernameInitial(displayName);
  const subKind = state.sub?.kind ?? null;
  const profileRoot = state.tab === 'profile' && !state.sub;
  const activeProfileSection = profileRoot ? profileSection ?? 'account' : null;

  const toggle = () => {
    setCollapsed(prev => {
      const next = !prev;
      saveSidebarCollapsed(next);
      return next;
    });
  };

  useEffect(() => {
    // A route change (top tab, child route or browser back) opens exactly the
    // destination group; a manual collapse of the same tab is not overwritten.
    setOpenTab(state.tab);
  }, [state.tab]);

  const isExpanded = (tab: TabId) => openTab === tab;

  const toggleExpanded = (tab: TabId) => {
    setOpenTab(prev => (prev === tab ? null : tab));
  };

  const handleParentNavigate = (tab: TabId) => {
    setProfileSection(null);
    setOpenTab(tab);
    onNavigate(tab);
  };

  const handleProfileSection = (section: ProfileSectionId) => {
    setProfileSection(section);
    onOpenProfileSection(section);
  };

  const selectShortcut = (action: () => void) => {
    setProfileSection(null);
    action();
  };

  const contentItems: SidebarSubItemDef[] = [
    {
      id: 'start',
      kind: 'action',
      labelKey: 'content.startTitle',
      active: state.tab === 'content' && !state.sub && !state.anchor,
      onSelect: () => selectShortcut(onStartLearning),
    },
    {
      id: 'library',
      kind: 'section',
      labelKey: 'sidebar.library',
      active: state.tab === 'content' && !state.sub && state.anchor === 'library',
      onSelect: () => selectShortcut(onOpenLibrary),
      legacyQuickId: 'library',
    },
    {
      id: 'books',
      kind: 'section',
      labelKey: 'sidebar.books',
      active: state.tab === 'content' && !state.sub && state.anchor === 'books',
      onSelect: () => selectShortcut(onOpenBooks),
      legacyQuickId: 'books',
    },
    {
      id: 'discover',
      kind: 'page',
      labelKey: 'sidebar.discover',
      active: state.tab === 'content' && subKind === 'discover',
      onSelect: () => selectShortcut(onOpenDiscover),
      legacyQuickId: 'discover',
    },
    {
      id: 'sentences',
      kind: 'section',
      labelKey: 'sidebar.sentences',
      active: state.tab === 'content' && !state.sub && state.anchor === 'sentence-packs',
      onSelect: () => selectShortcut(onOpenSentences),
      legacyQuickId: 'sentences',
    },
  ];

  const historyItems: SidebarSubItemDef[] = [
    {
      id: 'recent',
      kind: 'section',
      labelKey: 'sidebar.history',
      active: state.tab === 'today' && !state.sub,
      onSelect: () => selectShortcut(onOpenHistory),
      legacyQuickId: 'history',
    },
    {
      id: 'report',
      kind: 'page',
      labelKey: 'sidebar.report',
      active: state.tab === 'today' && subKind === 'report',
      onSelect: () => selectShortcut(onOpenReport),
    },
  ];

  const practiceItems: SidebarSubItemDef[] = [
    {
      id: 'review',
      kind: 'page',
      labelKey: 'review.title',
      active: state.tab === 'practice' && subKind === 'review',
      onSelect: () => selectShortcut(onOpenReview),
    },
    {
      id: 'exam',
      kind: 'page',
      labelKey: 'practice.exam.title',
      active: state.tab === 'practice' && subKind === 'exam',
      onSelect: () => selectShortcut(onOpenExam),
    },
    {
      id: 'placement',
      kind: 'page',
      labelKey: 'practice.placement.title',
      active: state.tab === 'practice' && subKind === 'placement',
      onSelect: () => selectShortcut(onOpenPlacement),
    },
  ];

  const profileItems: SidebarSubItemDef[] = [
    {
      id: 'account',
      kind: 'section',
      labelKey: 'sidebar.sub.account',
      active: activeProfileSection === 'account',
      onSelect: () => handleProfileSection('account'),
    },
    {
      id: 'balance',
      kind: 'section',
      labelKey: 'sidebar.sub.balance',
      active: activeProfileSection === 'balance',
      onSelect: () => handleProfileSection('balance'),
    },
    {
      id: 'settings',
      kind: 'section',
      labelKey: 'sidebar.sub.settings',
      active: activeProfileSection === 'settings',
      onSelect: () => handleProfileSection('settings'),
    },
    {
      id: 'about',
      kind: 'section',
      labelKey: 'sidebar.sub.about',
      active: activeProfileSection === 'about',
      onSelect: () => handleProfileSection('about'),
    },
    {
      id: 'ability',
      kind: 'page',
      labelKey: 'ability.title',
      active: state.tab === 'profile' && subKind === 'ability',
      onSelect: () => selectShortcut(onOpenAbility),
    },
  ];

  const itemGroups: Record<TabId, SidebarSubItemDef[]> = {
    content: contentItems,
    today: historyItems,
    practice: practiceItems,
    profile: profileItems,
  };

  const groups: SidebarGroupDef[] = SIDEBAR_TABS.map((tab) => ({
    tab,
    items: itemGroups[tab.id],
  }));

  const navButtonClass = (active: boolean) =>
    `relative flex w-full items-center rounded-xl transition-colors duration-200 ${
      collapsed ? 'justify-center h-10' : 'gap-3 h-10 px-3'
    } ${
      active
        ? 'bg-white/[0.07] text-zinc-50'
        : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
    }`;

  const subItemClass = (active: boolean) =>
    `flex w-full items-center gap-2 rounded-lg px-2.5 h-8 text-left text-[13px] font-medium transition-colors duration-200 ${
      active
        ? 'bg-white/[0.06] text-zinc-100'
        : 'text-zinc-500 hover:text-zinc-200 hover:bg-white/[0.03]'
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
          onClick={() => handleParentNavigate('today')}
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

      {/* Scrollable browse pages; the blog/admin strip and user card stay pinned. */}
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar px-2 py-3">
        <nav aria-label={t('nav.aria.primary')}>
          <ul className="flex flex-col gap-1">
            {groups.map(({ tab, items }) => {
              const Icon = tab.icon;
              const active = state.tab === tab.id;
              const label = t(tab.labelKey);
              const open = isExpanded(tab.id);
              const submenuId = `sidebar-submenu-${tab.id}`;
              return (
                <li key={tab.id} data-testid={`sidebar-group-${tab.id}`} data-expanded={open ? 'true' : 'false'}>
                  <div className="flex items-center gap-0.5">
                    <button
                      type="button"
                      data-testid={`sidebar-nav-${tab.id}`}
                      aria-current={active ? 'page' : undefined}
                      aria-label={label}
                      title={label}
                      onClick={() => handleParentNavigate(tab.id)}
                      className={`group flex h-10 min-w-0 flex-1 items-center rounded-xl transition-colors duration-200 ${
                        collapsed ? 'justify-center' : 'gap-3 px-3'
                      } ${
                        active
                          ? 'bg-white/[0.07] text-zinc-50'
                          : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
                      }`}
                    >
                      <span className={collapsed ? 'relative' : 'relative shrink-0'}>
                        <Icon
                          className={`w-[18px] h-[18px] ${active ? 'text-brand-400' : 'text-zinc-500'}`}
                          aria-hidden="true"
                        />
                        {tab.id === 'practice' && collapsed && renderBadge(dueCount, 'sidebar-practice-badge', true)}
                      </span>
                      {!collapsed && (
                        <span className="min-w-0 flex-1 truncate text-left text-sm font-medium">{label}</span>
                      )}
                      {tab.id === 'practice' && !collapsed && renderBadge(dueCount, 'sidebar-practice-badge', false)}
                    </button>
                    {!collapsed && (
                      <button
                        type="button"
                        data-testid={`sidebar-expand-${tab.id}`}
                        aria-expanded={open}
                        aria-controls={submenuId}
                        aria-label={open
                          ? t('sidebar.submenu.collapse', { label })
                          : t('sidebar.submenu.expand', { label })}
                        title={open
                          ? t('sidebar.submenu.collapse', { label })
                          : t('sidebar.submenu.expand', { label })}
                        onClick={() => toggleExpanded(tab.id)}
                        className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-zinc-600 hover:text-zinc-200 hover:bg-white/5 transition-colors"
                      >
                        <ChevronRight
                          className={`w-3.5 h-3.5 transition-transform duration-200 ease-apple ${
                            open ? 'rotate-90' : ''
                          }`}
                          aria-hidden="true"
                        />
                      </button>
                    )}
                  </div>
                  {!collapsed && open && (
                    <div
                      id={submenuId}
                      data-testid={submenuId}
                      className="mt-1 ml-[26px] border-l border-white/5 pl-2"
                    >
                      {SUBMENU_KINDS.map(({ kind, labelKey }) => {
                        const kindItems = items.filter(item => item.kind === kind);
                        if (kindItems.length === 0) return null;
                        return (
                          <div key={kind} className="mb-1.5 last:mb-0">
                            <p className="px-2.5 pb-0.5 text-[9px] font-semibold uppercase tracking-[0.12em] text-zinc-600">
                              {t(labelKey)}
                            </p>
                            <ul className="flex flex-col gap-0.5">
                              {kindItems.map((item) => {
                                const SubIcon = item.kind === 'page'
                                  ? ArrowUpRight
                                  : item.kind === 'action' ? Play : CornerDownRight;
                                return (
                                  <li
                                    key={item.id}
                                    data-testid={item.legacyQuickId ? `sidebar-quick-${item.legacyQuickId}` : undefined}
                                  >
                                    <button
                                      type="button"
                                      data-testid={`sidebar-sub-${item.id}`}
                                      data-kind={item.kind}
                                      aria-current={item.active ? 'page' : undefined}
                                      onClick={item.onSelect}
                                      className={subItemClass(item.active)}
                                    >
                                      <SubIcon
                                        aria-hidden="true"
                                        className={`h-3.5 w-3.5 shrink-0 ${
                                          item.active ? 'text-brand-400' : 'text-zinc-600'
                                        }`}
                                      />
                                      <span className="min-w-0 flex-1 truncate">{t(item.labelKey)}</span>
                                      {item.kind === 'page' && (
                                        <ChevronRight className="h-3 w-3 shrink-0 text-zinc-700" aria-hidden="true" />
                                      )}
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </nav>
      </div>

      {/* Pinned global entries: official blog, then admin console (admins only). */}
      <div className="flex-none border-t border-white/5 px-2 py-2">
        <nav aria-label={t('sidebar.fixed')} className="flex flex-col gap-0.5">
          <a
            href="#/blog"
            data-testid="sidebar-blog"
            aria-label={t('sidebar.blog')}
            title={t('sidebar.blog')}
            className={navButtonClass(false)}
          >
            <Newspaper className="w-[18px] h-[18px] text-zinc-500" aria-hidden="true" />
            {!collapsed && (
              <span className="min-w-0 truncate text-sm font-medium">{t('sidebar.blog')}</span>
            )}
          </a>
          {isAdmin && (
            <button
              type="button"
              data-testid="sidebar-admin"
              aria-current={subKind === 'admin' ? 'page' : undefined}
              aria-label={t('sidebar.admin')}
              title={t('sidebar.admin')}
              onClick={() => selectShortcut(onOpenAdmin)}
              className={navButtonClass(subKind === 'admin')}
            >
              <ShieldCheck
                className={`w-[18px] h-[18px] ${subKind === 'admin' ? 'text-brand-400' : 'text-zinc-500'}`}
                aria-hidden="true"
              />
              {!collapsed && (
                <span className="min-w-0 truncate text-sm font-medium">{t('sidebar.admin')}</span>
              )}
            </button>
          )}
        </nav>
      </div>

      {/* Pinned footer: account + language + settings. */}
      <div className="flex-none border-t border-white/5 p-2.5">
        {collapsed ? (
          <div className="flex flex-col items-center gap-2">
            <button
              type="button"
              data-testid="sidebar-user"
              onClick={() => (isGuest ? onRequestLogin?.() : handleParentNavigate('profile'))}
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
              onClick={() => handleParentNavigate('profile')}
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
              onClick={() => (isGuest ? onRequestLogin?.() : handleParentNavigate('profile'))}
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
                onClick={() => handleParentNavigate('profile')}
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
