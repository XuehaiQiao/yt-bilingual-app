import { WifiOff } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { useOnlineStatus } from '../lib/pwa';

/**
 * Small, non-blocking offline marker. The app shell is still usable from the
 * service-worker cache; the full backend (subtitle generation, history, auth)
 * is not, so the copy avoids promising more than that.
 */
export function OfflineIndicator() {
  const { t } = useI18n();
  const online = useOnlineStatus();
  if (online) return null;

  return (
    <div
      data-testid="offline-banner"
      role="status"
      aria-live="polite"
      style={{
        left: 'calc(env(safe-area-inset-left, 0px) + 16px)',
        bottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)',
      }}
      className="fixed z-[95] flex items-center gap-2.5 max-w-[calc(100vw-2rem)] pl-3 pr-4 py-2.5 rounded-xl bg-zinc-900/85 backdrop-blur-xl border border-amber-500/25 shadow-elev-2 pointer-events-none"
    >
      <span className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
        <WifiOff className="w-4 h-4 text-amber-400" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-amber-300">{t('pwa.offline')}</p>
        <p className="mt-0.5 text-[11px] leading-tight text-zinc-500">{t('pwa.offlineHint')}</p>
      </div>
    </div>
  );
}
