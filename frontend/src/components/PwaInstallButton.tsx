import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { Download, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { useInstallPrompt, useOnlineStatus } from '../lib/pwa';

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
 */
export function PwaInstallButton({ wrapperClassName = '' }: { wrapperClassName?: string }) {
  const { t } = useI18n();
  const online = useOnlineStatus();
  const { canInstall, isIos, isStandalone, promptInstall } = useInstallPrompt();
  const [showIosHelp, setShowIosHelp] = useState(false);

  useEffect(() => {
    if (!showIosHelp) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setShowIosHelp(false);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [showIosHelp]);

  if (isStandalone || !online) return null;
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

      {createPortal(
        <AnimatePresence>
          {showIosHelp && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.18 }}
              className="fixed inset-0 z-[120] flex items-end sm:items-center justify-center p-4 bg-zinc-950/70 backdrop-blur-md"
              style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 16px)' }}
              onClick={() => setShowIosHelp(false)}
            >
              <motion.div
                role="dialog"
                aria-modal="true"
                aria-labelledby="ios-install-title"
                data-testid="ios-install-help"
                initial={{ opacity: 0, y: 20, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 12, scale: 0.98 }}
                transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                className="w-full max-w-sm overflow-hidden rounded-2xl bg-zinc-900/90 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60"
                onClick={(event) => event.stopPropagation()}
              >
                <div className="flex items-start justify-between gap-3 px-6 py-5 border-b border-white/5">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className="w-10 h-10 shrink-0 rounded-[10px] overflow-hidden ring-1 ring-white/10">
                      <img src="/hero_icon.png" alt="" className="w-full h-full object-cover" />
                    </div>
                    <div className="min-w-0">
                      <h2 id="ios-install-title" className="text-xl font-semibold tracking-tight text-zinc-100">
                        {t('pwa.ios.title')}
                      </h2>
                      <p className="mt-1 text-xs text-zinc-500">{t('pwa.ios.subtitle')}</p>
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="ios-install-close"
                    onClick={() => setShowIosHelp(false)}
                    aria-label={t('pwa.ios.close')}
                    className="p-2 rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors shrink-0"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>

                <ol className="px-6 py-5 space-y-4">
                  {[t('pwa.ios.step1'), t('pwa.ios.step2'), t('pwa.ios.step3')].map((step, index) => (
                    <li key={step} className="flex items-start gap-3">
                      <span className="mt-0.5 w-6 h-6 shrink-0 rounded-full flex items-center justify-center bg-zinc-800/80 border border-white/5 text-[11px] font-medium tabular-nums text-zinc-300">
                        {index + 1}
                      </span>
                      <p className="text-sm leading-relaxed text-zinc-300">{step}</p>
                    </li>
                  ))}
                </ol>

                <div className="px-6 py-4 border-t border-white/5">
                  <button
                    type="button"
                    onClick={() => setShowIosHelp(false)}
                    className="w-full inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple"
                  >
                    {t('pwa.ios.gotIt')}
                  </button>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
  );
}
