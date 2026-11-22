// Shared chrome for the two public legal pages (`#/privacy`, `#/terms`).
//
// The legal pages are part of the public site (navigation-model §8.1): they
// render before the session bootstrap resolves, never mount AppShell/AuthGate,
// and share `PublicShell` + `PublicHeader` + `PublicFooter` with the home,
// blog, pricing and resources pages. This component owns the layout only; the
// copy lives in the i18n dictionaries so both pages stay bilingual and the
// page components stay a flat list of section keys.
//
// Layout (docs/设计-桌面布局规范.md §2/§3): the marketing measure (1200) plus a
// 240px table of contents at `xl` and above. The body column keeps its 3xl
// reading width instead of stretching with the container, and below `xl` the
// TOC disappears and the page is a single column. The TOC scrolls in-page
// (buttons, not anchors) because the hash owns the route (`#/privacy`).
//
// Reachability contract (M4): a visitor can open either page directly, from the
// footer, from the account page and from the signup disclosure; each page
// offers a way back home and into the app.
import { ArrowLeft, ArrowRight, Info } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { PageContainer } from './layout/PageContainer';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicShell } from './ui/PublicShell';

export type LegalDocumentKind = 'privacy' | 'terms';

export interface LegalSection {
  /** Stable id for `data-testid="legal-section-<id>"`. */
  id: string;
  titleKey: TranslationKey;
  paragraphs: readonly TranslationKey[];
  bullets?: readonly TranslationKey[];
}

interface LegalDocumentProps {
  kind: LegalDocumentKind;
  /** Root test id (`privacy-screen` / `terms-screen`). */
  testId: string;
  titleKey: TranslationKey;
  leadKey: TranslationKey;
  sections: readonly LegalSection[];
}

const PRIMARY =
  'inline-flex h-control-lg items-center justify-center gap-2 rounded-full bg-control px-5 text-ui font-semibold ' +
  'text-fg-inverse transition-[background-color,transform] duration-200 ease-apple hover:bg-white active:scale-[0.98]';
const SECONDARY =
  'inline-flex h-control-lg items-center justify-center gap-2 rounded-full border border-line-subtle bg-surface-2/60 px-5 text-ui font-medium ' +
  'text-fg-strong transition-[background-color,border-color,color] duration-200 ease-apple ' +
  'hover:border-line-strong hover:bg-surface-3/60 hover:text-fg-primary active:scale-[0.98]';
const LINK =
  'inline-flex items-center gap-1.5 rounded-control border border-line-subtle bg-surface-2/60 px-3 py-1.5 ' +
  'text-caption font-medium text-fg-strong transition-colors hover:border-line-strong hover:bg-surface-3/60 hover:text-fg-primary';

const OTHER: Record<LegalDocumentKind, { href: string; labelKey: TranslationKey }> = {
  privacy: { href: '#/terms', labelKey: 'public.legal.other.terms' },
  terms: { href: '#/privacy', labelKey: 'public.legal.other.privacy' },
};

export function LegalDocument({ kind, testId, titleKey, leadKey, sections }: LegalDocumentProps) {
  const { t } = useI18n();
  const other = OTHER[kind];

  // In-page jump for the TOC. `scroll-mt-24` on the heading clears the sticky
  // public header; reduced-motion users get an instant jump.
  const jumpToSection = (id: string) => {
    const target = document.getElementById(`legal-${id}-title`);
    if (!target) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
  };

  return (
    <PublicShell
      testId={testId}
      contained={false}
      header={<PublicHeader />}
      footer={<PublicFooter />}
    >
      <section className="py-10 sm:py-16">
        <PageContainer variant="marketing">
          <div className="max-w-3xl">
            <a
              href="/"
              data-testid="legal-back-home"
              className="inline-flex items-center gap-1.5 text-caption font-medium text-fg-secondary transition-colors hover:text-fg-primary [@media(pointer:coarse)]:min-h-11"
            >
              <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" />
              {t('public.legal.backHome')}
            </a>
            <p className="mt-6 text-micro font-medium text-fg-muted">{t('public.legal.eyebrow')}</p>
            <h1
              id="legal-title"
              data-testid="legal-title"
              className="mt-3 text-display-sm font-semibold tracking-hero text-fg-primary"
            >
              {t(titleKey)}
            </h1>
            <p className="mt-2 text-caption tabular-nums text-fg-muted">{t('public.legal.updated')}</p>
            <p className="mt-5 text-section leading-relaxed text-fg-secondary">{t(leadKey)}</p>
            <a href={other.href} data-testid="legal-other-doc" className={`mt-5 ${LINK}`}>
              {t(other.labelKey)}
              <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
            </a>
          </div>

          <div className="mt-10 xl:flex xl:items-start xl:gap-8">
            <div data-testid="legal-body" className="min-w-0 xl:flex-1">
              <article
                aria-labelledby="legal-title"
                className="max-w-3xl border-t border-line-subtle"
              >
                {sections.map((section, index) => {
                  const titleId = `legal-${section.id}-title`;
                  return (
                    <section
                      key={section.id}
                      aria-labelledby={titleId}
                      data-testid={`legal-section-${section.id}`}
                      className="border-b border-line-subtle py-6 sm:py-7"
                    >
                      <h2
                        id={titleId}
                        className="scroll-mt-24 text-page font-semibold tracking-tight text-fg-primary"
                      >
                        {index + 1}. {t(section.titleKey)}
                      </h2>
                      {section.paragraphs.map((key) => (
                        <p key={key} className="mt-3 text-ui leading-relaxed text-fg-secondary">
                          {t(key)}
                        </p>
                      ))}
                      {section.bullets && section.bullets.length > 0 && (
                        <ul className="mt-3 space-y-2">
                          {section.bullets.map((key) => (
                            <li
                              key={key}
                              className="flex gap-2.5 text-ui leading-relaxed text-fg-secondary"
                            >
                              <span
                                aria-hidden="true"
                                className="mt-[0.6em] h-1 w-1 shrink-0 rounded-full bg-fg-muted"
                              />
                              <span>{t(key)}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </section>
                  );
                })}
              </article>

              <aside
                data-testid="legal-contact-note"
                className="mt-8 flex max-w-3xl items-start gap-2.5 rounded-card border border-line-subtle bg-surface/40 p-4 text-caption leading-relaxed text-fg-secondary sm:p-5"
              >
                <Info className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" aria-hidden="true" />
                <p>{t('public.legal.contactNote')}</p>
              </aside>

              <div className="mt-8 flex max-w-3xl flex-col gap-3 sm:flex-row">
                <a href="#/app/content" data-testid="legal-enter" className={PRIMARY}>
                  {t('public.legal.enter')}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </a>
                <a href="/" data-testid="legal-home-bottom" className={SECONDARY}>
                  {t('public.legal.backHome')}
                </a>
              </div>
            </div>

            <nav
              data-testid="legal-toc"
              aria-label={t('public.legal.toc')}
              className="hidden min-w-0 xl:sticky xl:top-20 xl:block xl:w-sidebar xl:shrink-0"
            >
              <div className="rounded-panel border border-line-subtle bg-surface/40 p-4">
                <h2 className="text-caption font-semibold text-fg-primary">{t('public.legal.toc')}</h2>
                <div className="mt-2 flex flex-col gap-0.5">
                  {sections.map((section, index) => (
                    <button
                      key={section.id}
                      type="button"
                      data-testid={`legal-toc-${section.id}`}
                      onClick={() => jumpToSection(section.id)}
                      className="flex w-full min-w-0 items-baseline gap-2 rounded-control px-2 py-1.5 text-left transition-colors hover:bg-state-hover"
                    >
                      <span className="w-5 shrink-0 text-micro tabular-nums text-fg-muted">
                        {index + 1}
                      </span>
                      <span className="min-w-0 flex-1 text-caption leading-relaxed text-fg-secondary">
                        {t(section.titleKey)}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            </nav>
          </div>
        </PageContainer>
      </section>
    </PublicShell>
  );
}
