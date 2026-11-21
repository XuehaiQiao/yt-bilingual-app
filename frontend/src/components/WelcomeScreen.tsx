// Public marketing home (the bare origin, `/`).
//
// The homepage is the front door for visitors *and* a page a signed-in learner
// can return to. It sits outside the app shell and shares `PublicShell`,
// `PublicHeader` and `PublicFooter` with the blog / pricing / resources pages,
// so the public site has one header, one footer and one page measure.
// CTAs point at the app routes (`#/app/content`, `#/app/content/library`), the public
// blog (`#/blog`) and the login page (`#/login`); no app logic is duplicated.
//
// Visual rules follow the design system: zinc neutrals through semantic tokens,
// one brand accent, one primary action per viewport, and no decorative
// gradients or animations.
import {
  ArrowRight,
  BarChart3,
  CalendarCheck,
  Captions,
  Compass,
  Gauge,
  Library,
  Link2,
  ListChecks,
  LogIn,
  Newspaper,
  PlayCircle,
  Repeat,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicContainer, PublicShell } from './ui/PublicShell';

const SECTION = 'border-t border-line-subtle';
const SURFACE_CARD = 'rounded-card border border-line-subtle bg-surface/40';
const INTERACTIVE_CARD =
  `${SURFACE_CARD} group block p-5 transition-[background-color,border-color] duration-200 ease-apple ` +
  'hover:border-line-strong hover:bg-surface/50 sm:p-6';
const ICON_TILE =
  'flex h-9 w-9 shrink-0 items-center justify-center rounded-control-lg border border-brand/20 bg-brand/10 text-brand-300';
const EYEBROW = 'text-micro font-medium text-fg-muted';
const H2 = 'mt-2 text-page font-semibold tracking-tight text-fg-primary sm:text-page-lg';
const BODY = 'text-ui leading-relaxed text-fg-secondary';
const HERO_PRIMARY =
  'inline-flex h-control-xl items-center justify-center gap-2 rounded-full bg-control px-6 text-ui font-semibold ' +
  'text-fg-inverse transition-[background-color,transform] duration-200 ease-apple hover:bg-white active:scale-[0.98]';
const HERO_SECONDARY =
  'inline-flex h-control-xl items-center justify-center gap-2 rounded-full border border-line-subtle bg-surface-2/60 px-6 text-ui font-medium ' +
  'text-fg-strong transition-[background-color,border-color,color] duration-200 ease-apple ' +
  'hover:border-line-strong hover:bg-surface-3/60 hover:text-fg-primary active:scale-[0.98]';

interface Feature {
  icon: LucideIcon;
  title: TranslationKey;
  body: TranslationKey;
}

interface Idea {
  icon: LucideIcon;
  title: TranslationKey;
  body: TranslationKey;
}

interface Step {
  icon: LucideIcon;
  title: TranslationKey;
  body: TranslationKey;
}

const IDEAS: Idea[] = [
  {
    icon: Compass,
    title: 'welcome.idea.journey.title',
    body: 'welcome.idea.journey.body',
  },
  {
    icon: PlayCircle,
    title: 'welcome.idea.content.title',
    body: 'welcome.idea.content.body',
  },
  {
    icon: BarChart3,
    title: 'welcome.idea.facts.title',
    body: 'welcome.idea.facts.body',
  },
];

const FEATURES: Feature[] = [
  {
    icon: Captions,
    title: 'welcome.feature.subtitles.title',
    body: 'welcome.feature.subtitles.body',
  },
  {
    icon: ListChecks,
    title: 'welcome.feature.quiz.title',
    body: 'welcome.feature.quiz.body',
  },
  {
    icon: Repeat,
    title: 'welcome.feature.fsrs.title',
    body: 'welcome.feature.fsrs.body',
  },
  {
    icon: Gauge,
    title: 'welcome.feature.ability.title',
    body: 'welcome.feature.ability.body',
  },
  {
    icon: CalendarCheck,
    title: 'welcome.feature.report.title',
    body: 'welcome.feature.report.body',
  },
  {
    icon: Library,
    title: 'welcome.feature.library.title',
    body: 'welcome.feature.library.body',
  },
];

const STEPS: Step[] = [
  {
    icon: Link2,
    title: 'welcome.step1.title',
    body: 'welcome.step1.body',
  },
  {
    icon: ListChecks,
    title: 'welcome.step2.title',
    body: 'welcome.step2.body',
  },
  {
    icon: CalendarCheck,
    title: 'welcome.step3.title',
    body: 'welcome.step3.body',
  },
];

const HERO_CHIPS: TranslationKey[] = [
  'welcome.hero.chip.subtitles',
  'welcome.hero.chip.review',
  'welcome.hero.chip.ability',
];

export function WelcomeScreen() {
  const { t } = useI18n();

  return (
    <PublicShell
      testId="welcome-screen"
      contained={false}
      header={<PublicHeader />}
      footer={<PublicFooter />}
    >
      {/* Hero: brand + positioning + one primary CTA, one secondary CTA. */}
      <section className="py-16 sm:py-24">
        <PublicContainer>
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-line-subtle bg-surface/40 px-3 py-1 text-micro font-medium text-fg-secondary">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
              {t('brand.engine')}
            </p>
            <h1 className="mt-5 text-display-sm font-semibold tracking-hero text-fg-primary sm:text-display md:text-display-lg">
              {t('welcome.hero.brand')}
            </h1>
            <p className="mt-5 max-w-2xl text-section leading-relaxed text-fg-secondary sm:text-dialog">
              {t('welcome.hero.tagline')}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#/app/content" data-testid="welcome-enter" className={HERO_PRIMARY}>
                {t('welcome.hero.enter')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a href="#/login" data-testid="welcome-login" className={HERO_SECONDARY}>
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {t('welcome.hero.login')}
              </a>
            </div>
            <p className="mt-4 text-micro text-fg-secondary">{t('welcome.hero.trial')}</p>

            <ul className="mt-9 flex flex-wrap gap-2">
              {HERO_CHIPS.map((key) => (
                <li
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-line-subtle bg-surface/40 px-3 py-1 text-micro text-fg-secondary"
                >
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-brand" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
        </PublicContainer>
      </section>

      {/* 理念: journey, real content, facts over streaks. */}
      <section id="idea" className={SECTION}>
        <PublicContainer className="py-14 sm:py-20">
          <p className={EYEBROW}>{t('welcome.idea.eyebrow')}</p>
          <h2 className={H2}>{t('welcome.idea.title')}</h2>
          <div className="mt-9 grid gap-8 md:grid-cols-3">
            {IDEAS.map(({ icon: Icon, title, body }) => (
              <article key={title} className="border-l border-line-strong pl-4">
                <Icon className="h-4 w-4 text-brand-300" aria-hidden="true" />
                <h3 className="mt-3 text-ui font-semibold tracking-tight text-fg-primary">{t(title)}</h3>
                <p className={`mt-2 ${BODY}`}>{t(body)}</p>
              </article>
            ))}
          </div>
        </PublicContainer>
      </section>

      {/* 核心功能: the loop from real content to evidence. */}
      <section id="features" className={SECTION}>
        <PublicContainer className="py-14 sm:py-20">
          <p className={EYEBROW}>{t('welcome.features.eyebrow')}</p>
          <h2 className={H2}>{t('welcome.features.title')}</h2>
          <p className={`mt-3 max-w-2xl ${BODY}`}>{t('welcome.features.subtitle')}</p>

          <div className="mt-9 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {FEATURES.map(({ icon: Icon, title, body }) => (
              <article key={title} className={`${SURFACE_CARD} p-5 sm:p-6`}>
                <span className={ICON_TILE}>
                  <Icon className="h-4 w-4" aria-hidden="true" />
                </span>
                <h3 className="mt-4 text-ui font-semibold tracking-tight text-fg-primary">{t(title)}</h3>
                <p className={`mt-2 ${BODY}`}>{t(body)}</p>
              </article>
            ))}
          </div>
        </PublicContainer>
      </section>

      {/* 怎么用: three steps. */}
      <section id="how" className={SECTION}>
        <PublicContainer className="py-14 sm:py-20">
          <p className={EYEBROW}>{t('welcome.steps.eyebrow')}</p>
          <h2 className={H2}>{t('welcome.steps.title')}</h2>
          <ol className="mt-9 grid gap-6 md:grid-cols-3 md:gap-8">
            {STEPS.map(({ icon: Icon, title, body }, index) => (
              <li key={title}>
                <div className="flex items-center gap-3">
                  <span className="text-ui font-semibold tabular-nums text-brand-300">
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <Icon className="h-4 w-4 text-fg-muted" aria-hidden="true" />
                </div>
                <h3 className="mt-3 text-ui font-semibold tracking-tight text-fg-primary">{t(title)}</h3>
                <p className={`mt-2 ${BODY}`}>{t(body)}</p>
              </li>
            ))}
          </ol>
        </PublicContainer>
      </section>

      {/* 免费资源 + 博客: both are real, public destinations. */}
      <section id="explore" className={SECTION}>
        <PublicContainer className="py-14 sm:py-20">
          <p className={EYEBROW}>{t('welcome.explore.eyebrow')}</p>
          <h2 className={H2}>{t('welcome.explore.title')}</h2>
          <p className={`mt-3 max-w-2xl ${BODY}`}>{t('welcome.explore.subtitle')}</p>

          <div className="mt-9 grid gap-3 sm:grid-cols-2 sm:gap-4">
            <a
              href="#/app/content"
              data-testid="welcome-library-link"
              className={INTERACTIVE_CARD}
            >
              <div className="flex items-center gap-3">
                <span className={ICON_TILE}>
                  <Library className="h-4 w-4" aria-hidden="true" />
                </span>
                <h3 className="text-ui font-semibold tracking-tight text-fg-primary">
                  {t('welcome.explore.library.title')}
                </h3>
              </div>
              <p className={`mt-3 ${BODY}`}>{t('welcome.explore.library.body')}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-ui font-medium text-brand-300">
                {t('welcome.explore.library.cta')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </a>

            <a
              href="#/blog"
              data-testid="welcome-blog-link"
              className={INTERACTIVE_CARD}
            >
              <div className="flex items-center gap-3">
                <span className={ICON_TILE}>
                  <Newspaper className="h-4 w-4" aria-hidden="true" />
                </span>
                <h3 className="text-ui font-semibold tracking-tight text-fg-primary">
                  {t('welcome.explore.blog.title')}
                </h3>
              </div>
              <p className={`mt-3 ${BODY}`}>{t('welcome.explore.blog.body')}</p>
              <span className="mt-4 inline-flex items-center gap-1.5 text-ui font-medium text-brand-300">
                {t('welcome.explore.blog.cta')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </span>
            </a>
          </div>
        </PublicContainer>
      </section>
    </PublicShell>
  );
}
