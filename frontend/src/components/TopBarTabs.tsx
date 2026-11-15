// Primary navigation tabs (P0 IA §2.3 / §5). Shared by the desktop top bar
// and the mobile bottom bar so both always show the same four destinations in
// the same order. The tab metadata lives in `lib/navTabs.ts`.
import { motion } from 'framer-motion';
import type { TabId } from '../lib/nav';
import { formatDueBadge, NAV_TABS } from '../lib/navTabs';
import { useI18n } from '../i18n/I18nProvider';

interface TopBarTabsProps {
  activeTab: TabId;
  dueCount: number;
  onNavigate: (tab: TabId) => void;
}

export function TopBarTabs({ activeTab, dueCount, onNavigate }: TopBarTabsProps) {
  const { t } = useI18n();
  return (
    <nav
      data-testid="nav-tabs"
      aria-label={t('nav.aria.primary')}
      className="hidden md:flex flex-1 items-center justify-center gap-1 min-w-0"
    >
      {NAV_TABS.map(tab => {
        const active = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            data-testid={`nav-tab-${tab.id}`}
            aria-current={active ? 'page' : undefined}
            aria-label={t(tab.labelKey)}
            onClick={() => onNavigate(tab.id)}
            className={`relative h-9 px-2.5 md:px-3 rounded-lg text-[13px] lg:text-sm font-medium whitespace-nowrap transition-colors duration-200 ${
              active
                ? 'text-zinc-50 bg-white/[0.04]'
                : 'text-zinc-400 hover:text-zinc-100 hover:bg-white/5'
            }`}
          >
            {t(tab.labelKey)}
            {tab.id === 'practice' && dueCount > 0 && (
              <span
                data-testid="nav-practice-badge"
                aria-label={t('practice.badge.aria', { count: dueCount })}
                className="absolute -top-0.5 -right-0.5 min-w-[16px] h-4 px-1 rounded-full bg-brand text-[9px] font-semibold text-white tabular-nums flex items-center justify-center"
              >
                {formatDueBadge(dueCount)}
              </span>
            )}
            {active && (
              <motion.span
                layoutId="nav-underline"
                className="absolute -bottom-[13px] left-2 right-2 h-[2px] rounded-full bg-brand"
                transition={{ type: 'spring', stiffness: 420, damping: 36 }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
