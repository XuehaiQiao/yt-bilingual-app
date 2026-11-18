// Primary navigation tabs (P0 IA §2.3 / §5). Shared by the desktop top bar
// and the mobile bottom bar so both always show the same four destinations in
// the same order. The tab metadata lives in `lib/navTabs.ts`.
import type { TabId } from '../lib/nav';
import { formatDueBadge, NAV_TABS } from '../lib/navTabs';
import { useI18n } from '../i18n/I18nProvider';
import { Tabs, type TabItem } from './ui/Tabs';

interface TopBarTabsProps {
  activeTab: TabId;
  dueCount: number;
  onNavigate: (tab: TabId) => void;
}

export function TopBarTabs({ activeTab, dueCount, onNavigate }: TopBarTabsProps) {
  const { t } = useI18n();
  const items: TabItem[] = NAV_TABS.map((tab) => ({
    id: tab.id,
    label: t(tab.labelKey),
    testId: `nav-tab-${tab.id}`,
    count: tab.id === 'practice' ? dueCount : null,
    countLabel: tab.id === 'practice' ? formatDueBadge(dueCount) : undefined,
    countAriaLabel:
      tab.id === 'practice' && dueCount > 0
        ? t('practice.badge.aria', { count: dueCount })
        : undefined,
    countTestId: tab.id === 'practice' ? 'nav-practice-badge' : undefined,
  }));

  return (
    <nav
      data-testid="nav-tabs"
      aria-label={t('nav.aria.primary')}
      className="hidden md:flex flex-1 items-center justify-center gap-1 min-w-0"
    >
      <Tabs
        skin="nav"
        items={items}
        value={activeTab}
        onChange={(id) => onNavigate(id as TabId)}
        layoutId="nav-underline"
        ariaLabel={t('nav.aria.primary')}
      />
    </nav>
  );
}
