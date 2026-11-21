// Public pricing page (`#/pricing`).
//
// The product has no public price yet: the page says exactly that ("内测免费 /
// 定价即将公布") instead of inventing a number. It is part of the public site,
// so it shares `PublicShell` + `PublicHeader` + `PublicFooter` with the home,
// blog and resources pages and never renders the app shell.
import { ArrowRight, Check, Info, LogIn } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicContainer, PublicShell } from './ui/PublicShell';

const PRIMARY =
  'inline-flex h-control-xl items-center justify-center gap-2 rounded-full bg-control px-6 text-ui font-semibold ' +
  'text-fg-inverse transition-[background-color,transform] duration-200 ease-apple hover:bg-white active:scale-[0.98]';
const SECONDARY =
  'inline-flex h-control-xl items-center justify-center gap-2 rounded-full border border-line-subtle bg-surface-2/60 px-6 text-ui font-medium ' +
  'text-fg-strong transition-[background-color,border-color,color] duration-200 ease-apple ' +
  'hover:border-line-strong hover:bg-surface-3/60 hover:text-fg-primary active:scale-[0.98]';

export function PricingScreen() {
  const { t } = useI18n();
  const { status } = useAuth();
  const showLogin = status !== 'authenticated';

  return (
    <PublicShell
      testId="pricing-screen"
      contained={false}
      header={<PublicHeader active="pricing" />}
      footer={<PublicFooter />}
    >
      <section className="py-16 sm:py-24">
        <PublicContainer>
          <div className="max-w-3xl">
            <p className="text-micro font-medium text-fg-muted">{t('public.pricing.eyebrow')}</p>
            <h1
              data-testid="pricing-title"
              className="mt-3 text-display-sm font-semibold tracking-hero text-fg-primary sm:text-display"
            >
              {t('public.pricing.title')}
            </h1>
            <p className="mt-5 max-w-2xl text-section leading-relaxed text-fg-secondary">
              {t('public.pricing.subtitle')}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#/app/content" data-testid="pricing-cta-enter" className={PRIMARY}>
                {t('public.pricing.cta.enter')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              {showLogin && (
                <a href="#/login" data-testid="pricing-cta-login" className={SECONDARY}>
                  <LogIn className="h-4 w-4" aria-hidden="true" />
                  {t('public.pricing.cta.login')}
                </a>
              )}
            </div>
          </div>

          <div className="mt-12 grid gap-4 lg:grid-cols-2">
            <article
              data-testid="pricing-free-card"
              className="rounded-card border border-line-subtle bg-surface/40 p-6 sm:p-8"
            >
              <span className="inline-flex items-center rounded-full border border-brand/20 bg-brand/10 px-3 py-1 text-micro font-medium text-brand-300">
                {t('public.pricing.free.tag')}
              </span>
              <h2 className="mt-4 text-page font-semibold tracking-tight text-fg-primary">
                {t('public.pricing.free.title')}
              </h2>
              <ul className="mt-5 space-y-3">
                {(['public.pricing.free.item1', 'public.pricing.free.item2', 'public.pricing.free.item3'] as const).map(
                  (key) => (
                    <li key={key} className="flex items-start gap-2.5 text-ui leading-relaxed text-fg-secondary">
                      <Check className="mt-0.5 h-4 w-4 shrink-0 text-brand-300" aria-hidden="true" />
                      <span>{t(key)}</span>
                    </li>
                  ),
                )}
              </ul>
            </article>

            <article className="rounded-card border border-line-subtle bg-surface/20 p-6 sm:p-8">
              <h2 className="text-ui font-semibold tracking-tight text-fg-primary">
                {t('public.pricing.next.title')}
              </h2>
              <p className="mt-3 text-ui leading-relaxed text-fg-secondary">
                {t('public.pricing.next.body')}
              </p>
              <p
                data-testid="pricing-note"
                className="mt-5 flex items-start gap-2 text-micro leading-relaxed text-fg-muted"
              >
                <Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span>{t('public.pricing.note')}</span>
              </p>
            </article>
          </div>
        </PublicContainer>
      </section>
    </PublicShell>
  );
}
