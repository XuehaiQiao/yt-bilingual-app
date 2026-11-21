import { useState } from 'react';
import { Download } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { canOfferInstall, useInstallPrompt, useOnlineStatus } from '../lib/pwa';
import { Dialog } from './ui/Dialog';

/**
 * One inline install entry for both platforms:
 *   - Chrome/Edge: the captured `beforeinstallprompt` event becomes this
 *     button; clicking it opens the browser's native install dialog.
 *   - iOS Safari: no prompt exists, so the button opens short
 *     "Share → Add to Home Screen" instructions.
 *
 * It is hidden when already installed, when offline, or when the browser
 * offers no install path (Firefox desktop, in-app browsers, …). Home and the
 * auth screen place it in the normal document flow — never over a card, which
 * would make part of the page unclickable on a 375px phone.
 *
 * It is also hidden until the third recorded page load: the install ask is
 * useful once the learner has actually come back (report 1.3.3). The count is
 * written once per page load in `main.tsx`.
 */
export function PwaInstallButton({ wrapperClassName = '' }: { wrapperClassName?: string }) {
  const { t } = useI18n();
  const online = useOnlineStatus();
  const { canInstall, isIos, isStandalone, promptInstall } = useInstallPrompt();
  const [showIosHelp, setShowIosHelp] = useState(false);
  const [installEligible] = useState(() => canOfferInstall());

  if (!installEligible || isStandalone || !online) return null;
  if (!canInstall && !isIos) return null;

  const handleClick = async () => {
    if (canInstall) {
      await promptInstall();
      return;
    }
    setShowIosHelp(true);
  };

  return (
    <>
      <div className={wrapperClassName}>
        <button
          type="button"
          data-testid="install-button"
          onClick={() => { void handleClick(); }}
          aria-label={t('pwa.installAria')}
          title={t('pwa.installAria')}
          className="inline-flex items-center gap-1.5 h-9 px-3.5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-xs font-medium text-zinc-300 hover:text-zinc-100 active:scale-[0.98] transition-[background-color,border-color,color,transform] duration-200 ease-apple"
        >
          <Download className="w-4 h-4 text-blue-400" />
          <span>{t('pwa.install')}</span>
        </button>
      </div>

      <Dialog
        open={showIosHelp}
        onClose={() => setShowIosHelp(false)}
        size="sm"
        sheet
        testId="ios-install-help"
        closeLabel={t('pwa.ios.close')}
        title={
          <span className="flex min-w-0 items-center gap-3">
            <span className="h-10 w-10 shrink-0 overflow-hidden rounded-[10px] ring-1 ring-white/10">
              <img src="/hero_icon.png" alt="" className="h-full w-full object-cover" />
            </span>
            <span className="min-w-0 truncate">{t('pwa.ios.title')}</span>
          </span>
        }
        description={t('pwa.ios.subtitle')}
        footer={
          <button
            type="button"
            onClick={() => setShowIosHelp(false)}
            className="w-full inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple"
          >
            {t('pwa.ios.gotIt')}
          </button>
        }
      >
        <ol className="space-y-4">
          {[t('pwa.ios.step1'), t('pwa.ios.step2'), t('pwa.ios.step3')].map((step, index) => (
            <li key={step} className="flex items-start gap-3">
              <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center bg-zinc-800/80 border border-white/5 text-[11px] font-medium tabular-nums text-zinc-300">
                {index + 1}
              </span>
              <p className="text-sm leading-relaxed text-zinc-300">{step}</p>
            </li>
          ))}
        </ol>
      </Dialog>
    </>
  );
}
