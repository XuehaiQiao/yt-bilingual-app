// Shared public-site header (home / blog / pricing / resources).
//
// Public pages sit outside the app shell, so they must not import any app
// chrome. This header owns the brand back to `/`, the three public entries
// (blog · pricing · resources), the language switch and the single CTA that
// adapts to the session: “进入学习” for a guest/signed-in learner, otherwise
// “登录 / 注册”. It is rendered inside `PublicShell`'s `header` slot.
import { LogIn, Play } from 'lucide-react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { LanguageMenu } from './LanguageMenu';
import { PublicContainer } from './ui/PublicShell';

export type PublicNavId = 'blog' | 'pricing' | 'resources';

interface PublicNavItem {
  id: PublicNavId;
  href: string;
  testId: string;
  labelKey: TranslationKey;
}

const NAV_ITEMS: readonly PublicNavItem[] = [
  { id: 'blog', href: '#/blog', testId: 'public-nav-blog', labelKey: 'welcome.nav.blog' },
  { id: 'pricing', href: '#/pricing', testId: 'public-nav-pricing', labelKey: 'welcome.nav.pricing' },
  { id: 'resources', href: '#/resources', testId: 'public-nav-resources', labelKey: 'welcome.nav.resources' },
];

export function PublicHeader({ active }: { active?: PublicNavId }) {
  const { t } = useI18n();
  const { status } = useAuth();
  const canEnterApp = status === 'authenticated' || status === 'guest';

  return (
    <header
      data-testid="public-header"
      className="sticky top-0 z-chrome shrink-0 border-b border-line-subtle bg-app/60 backdrop-blur-xl"
    >
      <PublicContainer className="flex h-14 items-center gap-3 sm:h-16">
        <a
          href="/"
          data-testid="public-brand"
          aria-label={t('brand.name')}
          title={t('brand.name')}
          className="flex min-w-0 items-center gap-2.5 rounded-control"
        >
          <span className="h-8 w-8 shrink-0 overflow-hidden rounded-control-lg ring-1 ring-line-strong">
            <img src="/hero_icon.png" alt={t('brand.logoAlt')} className="h-full w-full object-cover" />
          </span>
          <span className="truncate text-body-zh font-semibold tracking-tight text-fg-primary">
            {t('welcome.hero.brand')}
          </span>
        </a>

        <nav aria-label={t('welcome.nav.aria')} className="ml-4 hidden items-center gap-1 md:flex">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={item.href}
              data-testid={item.testId}
              aria-current={active === item.id ? 'page' : undefined}
              className={`rounded-control px-3 py-1.5 text-ui font-medium transition-colors hover:bg-state-hover hover:text-fg-primary ${
                active === item.id ? 'bg-state-hover text-fg-primary' : 'text-fg-secondary'
              }`}
            >
              {t(item.labelKey)}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
          <LanguageMenu />
          {canEnterApp ? (
            <a
              href="#/app/today"
              data-testid="public-header-enter"
              className="inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-caption font-medium text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary sm:px-2.5 sm:text-ui [@media(pointer:coarse)]:min-h-11"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              <span className="sm:hidden">{t('welcome.nav.enterShort')}</span>
              <span className="hidden sm:inline">{t('welcome.nav.enter')}</span>
            </a>
          ) : (
            <a
              href="#/login"
              data-testid="public-header-login"
              className="inline-flex h-9 items-center gap-1.5 rounded-control px-2 text-caption font-medium text-fg-secondary transition-colors hover:bg-state-hover hover:text-fg-primary sm:px-2.5 sm:text-ui [@media(pointer:coarse)]:min-h-11"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              <span className="sm:hidden">{t('welcome.nav.loginShort')}</span>
              <span className="hidden sm:inline">{t('welcome.nav.login')}</span>
            </a>
          )}
        </div>
      </PublicContainer>
      {/* The three public entries must also be reachable at 375: the desktop
          row collapses into a compact second row instead of disappearing. */}
      <div className="border-t border-line-subtle/60 md:hidden">
        <PublicContainer className="flex items-center gap-1 py-1">
          {NAV_ITEMS.map((item) => (
            <a
              key={item.id}
              href={item.href}
              data-testid={`public-mobile-nav-${item.id}`}
              aria-current={active === item.id ? 'page' : undefined}
              className={`flex-1 rounded-control px-2 py-1.5 text-center text-caption font-medium transition-colors hover:bg-state-hover hover:text-fg-primary ${
                active === item.id ? 'bg-state-hover text-fg-primary' : 'text-fg-secondary'
              }`}
            >
              {t(item.labelKey)}
            </a>
          ))}
        </PublicContainer>
      </div>
    </header>
  );
}
