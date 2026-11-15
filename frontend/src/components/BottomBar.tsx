// Mobile bottom bar (P0 IA §6): four tabs, icon + label, safe-area padding.
// Hidden on md+ (the desktop top bar carries the tabs) and hidden while a sub
// view is open (each full-screen task owns its own header / close control).
import { formatDueBadge, NAV_TABS } from '../lib/navTabs';
import type { TabId } from '../lib/nav';
import { useI18n } from '../i18n/I18nProvider';

interface BottomBarProps {
  activeTab: TabId;
  dueCount: number;
  onNavigate: (tab: TabId) => void;
}

export function BottomBar({ activeTab, dueCount, onNavigate }: BottomBarProps) {
  const { t } = useI18n();
  return (
    <nav
      data-testid="bottom-bar"
      aria-label={t('nav.aria.primary')}
      className="md:hidden fixed inset-x-0 bottom-0 z-30 border-t border-white/5 bg-zinc-950/85 backdrop-blur-xl"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="flex items-stretch">
        {NAV_TABS.map(tab => {
          const Icon = tab.icon;
          const active = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              data-testid={`bottom-tab-${tab.id}`}
              aria-current={active ? 'page' : undefined}
              aria-label={t(tab.labelKey)}
              onClick={() => onNavigate(tab.id)}
              className={`relative flex-1 h-14 flex flex-col items-center justify-center gap-1 transition-colors active:bg-white/5 ${
                active ? 'text-brand-400' : 'text-zinc-500'
              }`}
            >
              <span className="relative">
                <Icon className="w-5 h-5" aria-hidden="true" />
                {tab.id === 'practice' && dueCount > 0 && (
                  <span
                    data-testid="bottom-practice-badge"
                    aria-label={t('practice.badge.aria', { count: dueCount })}
                    className="absolute -top-0.5 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-[10px] font-semibold text-white tabular-nums flex items-center justify-center"
                  >
                    {formatDueBadge(dueCount)}
                  </span>
                )}
              </span>
              <span className="text-[10px] font-medium leading-none whitespace-nowrap">
                {t(tab.labelKey)}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
