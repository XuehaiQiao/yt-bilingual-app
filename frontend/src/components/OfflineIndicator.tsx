import { WifiOff } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { useOnlineStatus } from '../lib/pwa';

/**
 * Small, non-blocking offline marker. The app shell is still usable from the
 * service-worker cache; the full backend (subtitle generation, history, auth)
 * is not, so the copy avoids promising more than that.
 *
 * A2 C8 / A3 IX-08: anchored just below the top bar (never the bottom), so it
 * can never collide with the toast stack or cover the mobile bottom bar.
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
      aria-atomic="true"
      className="pointer-events-none fixed right-4 top-[3.5rem] z-nav flex max-w-[calc(100vw-2rem)] items-center gap-2.5 rounded-xl border border-amber-500/25 bg-zinc-900/85 py-2.5 pl-3 pr-4 shadow-elev-2 backdrop-blur-xl md:right-6 md:top-[4.75rem]"
    >
      <span className="w-7 h-7 rounded-lg bg-amber-500/10 flex items-center justify-center shrink-0">
        <WifiOff className="w-4 h-4 text-amber-400" aria-hidden="true" />
      </span>
      <div className="min-w-0">
        <p className="text-xs font-medium text-amber-300">{t('pwa.offline')}</p>
        <p className="mt-0.5 text-[11px] leading-tight text-zinc-500">{t('pwa.offlineHint')}</p>
      </div>
    </div>
  );
}
