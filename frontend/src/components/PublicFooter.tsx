// Shared public-site footer (home / blog / pricing / resources / legal pages).
//
// Same slots as the old welcome footer: brand + tagline, the public
// destinations (blog, pricing, resources, the real privacy/terms pages) and the
// repository link. Every entry is a real destination: the M4 legal links
// replaced the old disabled "coming soon" placeholders, so the footer no longer
// advertises an unshipped page. Public pages render this inside
// `PublicShell`'s `footer` slot.
import { ArrowUpRight, Github } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { PublicContainer } from './ui/PublicShell';

const GITHUB_URL = 'https://github.com/XuehaiQiao/yt-bilingual-app';

export function PublicFooter() {
  const { t } = useI18n();

  return (
    <footer data-testid="public-footer" className="border-t border-line-subtle">
      <PublicContainer className="flex flex-col gap-8 py-10">
        <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-start">
          <div>
            <div className="flex items-center gap-2.5">
              <span className="h-7 w-7 overflow-hidden rounded-control ring-1 ring-line-strong">
                <img src="/hero_icon.png" alt="" className="h-full w-full object-cover" />
              </span>
              <span className="text-ui font-semibold tracking-tight text-fg-strong">
                {t('welcome.hero.brand')}
              </span>
            </div>
            <p className="mt-3 max-w-xs text-micro leading-relaxed text-fg-muted">
              {t('welcome.footer.tagline')}
            </p>
          </div>

          <nav
            aria-label={t('welcome.footer.aria')}
            className="flex flex-wrap items-center gap-x-6 gap-y-3"
          >
            <a
              href="#/blog"
              data-testid="public-footer-blog"
              className="text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('welcome.footer.blog')}
            </a>
            <a
              href="#/pricing"
              data-testid="public-footer-pricing"
              className="text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('welcome.nav.pricing')}
            </a>
            <a
              href="#/resources"
              data-testid="public-footer-resources"
              className="text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('welcome.nav.resources')}
            </a>
            <a
              href="#/privacy"
              data-testid="public-footer-privacy"
              className="text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('welcome.footer.privacy')}
            </a>
            <a
              href="#/terms"
              data-testid="public-footer-terms"
              className="text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              {t('welcome.footer.terms')}
            </a>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              data-testid="welcome-github"
              className="inline-flex items-center gap-1.5 text-ui text-fg-secondary transition-colors hover:text-fg-primary"
            >
              <Github className="h-4 w-4" aria-hidden="true" />
              {t('welcome.footer.github')}
              <ArrowUpRight className="h-3.5 w-3.5 text-fg-muted" aria-hidden="true" />
            </a>
          </nav>
        </div>

        <p className="text-micro tabular-nums text-fg-muted">
          {t('welcome.footer.copyright', { year: new Date().getFullYear() })}
        </p>
      </PublicContainer>
    </footer>
  );
}
