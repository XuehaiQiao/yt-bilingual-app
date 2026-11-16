// Public landing page (#/welcome, pre-login).
//
// This page sits outside the app shell on purpose: it is the front door for a
// visitor who has not signed in yet, so it owns its own header/footer and never
// renders the four tabs or the model bar. Copy lives in i18n (zh-CN / vi-VN);
// CTAs point at existing routes (`#/today`, `#/login`, `#/content`,
// `#/content/blog`) instead of duplicating any app logic.
//
// Visual rules follow docs/设计语言.md: zinc neutrals, one blue accent, no
// decorative gradients or animations. Unfinished footer destinations render as
// disabled "coming soon" items — never as dead links.
import {
  ArrowRight,
  ArrowUpRight,
  BarChart3,
  CalendarCheck,
  Captions,
  Compass,
  Github,
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
import { LanguageMenu } from './LanguageMenu';

const GITHUB_URL = 'https://github.com/XuehaiQiao/yt-bilingual-app';

const PAGE = 'mx-auto w-full max-w-5xl px-5 sm:px-8';
const SECTION = 'border-t border-white/5';
const CARD = 'rounded-2xl border border-white/5 bg-zinc-900/40';
const EYEBROW = 'text-xs font-medium text-zinc-500';
const H2 = 'mt-2 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50';
const BODY = 'text-sm leading-relaxed text-zinc-400';
const PRIMARY_CTA =
  'inline-flex items-center justify-center gap-2 h-12 px-6 rounded-full bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple';
const SECONDARY_CTA =
  'inline-flex items-center justify-center gap-2 h-12 px-6 rounded-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-sm font-medium text-zinc-200 hover:text-zinc-50 transition-[background-color,border-color,color] duration-200';
const CARD_ICON =
  'w-9 h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center text-blue-400 shrink-0';

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

function ComingSoon({ label, testId }: { label: string; testId: string }) {
  const { t } = useI18n();
  return (
    <span
      data-testid={testId}
      data-coming-soon="true"
      aria-disabled="true"
      title={t('welcome.footer.comingSoon')}
      className="inline-flex items-center gap-2 text-sm text-zinc-500 cursor-default select-none"
    >
      {label}
      <span className="rounded-full border border-white/5 bg-zinc-800/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-500">
        {t('welcome.footer.comingSoon')}
      </span>
    </span>
  );
}

export function WelcomeScreen() {
  const { t } = useI18n();

  return (
    <div data-testid="welcome-screen" className="min-h-screen w-full bg-[#09090b] text-zinc-100">
      {/* Own header: brand, two public entries, language, login. No app chrome. */}
      <header
        data-testid="welcome-header"
        className="sticky top-0 z-30 border-b border-white/5 bg-zinc-950/70 backdrop-blur-xl"
      >
        <div className={`${PAGE} flex h-14 items-center gap-3 sm:h-16`}>
          <a
            href="#/welcome"
            data-testid="welcome-brand"
            aria-label={t('brand.name')}
            title={t('brand.name')}
            className="flex min-w-0 items-center gap-2.5"
          >
            <span className="h-8 w-8 shrink-0 overflow-hidden rounded-[10px] ring-1 ring-white/10">
              <img src="/hero_icon.png" alt={t('brand.logoAlt')} className="h-full w-full object-cover" />
            </span>
            <span className="truncate text-[15px] font-semibold tracking-tight text-zinc-100">
              {t('welcome.hero.brand')}
            </span>
          </a>

          <nav aria-label={t('welcome.nav.aria')} className="ml-4 hidden items-center gap-1 md:flex">
            <a
              href="#/content"
              data-testid="welcome-header-library"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              {t('welcome.nav.library')}
            </a>
            <a
              href="#/content/blog"
              data-testid="welcome-header-blog"
              className="rounded-lg px-3 py-1.5 text-sm font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
            >
              {t('welcome.nav.blog')}
            </a>
          </nav>

          <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-2">
            <LanguageMenu />
            <a
              href="#/login"
              data-testid="welcome-header-login"
              className="inline-flex h-9 items-center gap-1.5 rounded-xl border border-white/5 bg-zinc-800/60 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:border-white/10 hover:bg-zinc-700/60 hover:text-zinc-100 sm:px-3 sm:text-sm"
            >
              <LogIn className="h-4 w-4" aria-hidden="true" />
              <span className="sm:hidden">{t('welcome.nav.loginShort')}</span>
              <span className="hidden sm:inline">{t('welcome.nav.login')}</span>
            </a>
          </div>
        </div>
      </header>

      <main>
        {/* Hero: brand + positioning + two CTAs. */}
        <section className={`${PAGE} py-16 sm:py-24`}>
          <div className="max-w-3xl">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/5 bg-zinc-900/40 px-3 py-1 text-xs font-medium text-zinc-400">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-brand" />
              {t('brand.engine')}
            </p>
            <h1 className="mt-5 text-4xl font-semibold tracking-[-0.015em] text-zinc-50 sm:text-5xl md:text-6xl">
              {t('welcome.hero.brand')}
            </h1>
            <p className="mt-5 max-w-2xl text-lg leading-relaxed text-zinc-400 sm:text-xl">
              {t('welcome.hero.tagline')}
            </p>

            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <a href="#/today" data-testid="welcome-enter" className={PRIMARY_CTA}>
                {t('welcome.hero.enter')}
                <ArrowRight className="h-4 w-4" aria-hidden="true" />
              </a>
              <a href="#/login" data-testid="welcome-login" className={SECONDARY_CTA}>
                <LogIn className="h-4 w-4" aria-hidden="true" />
                {t('welcome.hero.login')}
              </a>
            </div>
            <p className="mt-4 text-xs text-zinc-500">{t('welcome.hero.trial')}</p>

            <ul className="mt-9 flex flex-wrap gap-2">
              {HERO_CHIPS.map((key) => (
                <li
                  key={key}
                  className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-zinc-900/40 px-3 py-1 text-xs text-zinc-400"
                >
                  <span aria-hidden="true" className="h-1 w-1 rounded-full bg-brand" />
                  {t(key)}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* 理念: journey, real content, facts over streaks. */}
        <section id="idea" className={SECTION}>
          <div className={`${PAGE} py-14 sm:py-20`}>
            <p className={EYEBROW}>{t('welcome.idea.eyebrow')}</p>
            <h2 className={H2}>{t('welcome.idea.title')}</h2>
            <div className="mt-9 grid gap-8 md:grid-cols-3">
              {IDEAS.map(({ icon: Icon, title, body }) => (
                <article key={title} className="border-l border-white/10 pl-4">
                  <Icon className="h-4 w-4 text-blue-400" aria-hidden="true" />
                  <h3 className="mt-3 text-[15px] font-semibold tracking-tight text-zinc-100">{t(title)}</h3>
                  <p className={`mt-2 ${BODY}`}>{t(body)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 核心功能: the loop from real content to evidence. */}
        <section id="features" className={SECTION}>
          <div className={`${PAGE} py-14 sm:py-20`}>
            <p className={EYEBROW}>{t('welcome.features.eyebrow')}</p>
            <h2 className={H2}>{t('welcome.features.title')}</h2>
            <p className={`mt-3 max-w-2xl ${BODY}`}>{t('welcome.features.subtitle')}</p>

            <div className="mt-9 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
              {FEATURES.map(({ icon: Icon, title, body }) => (
                <article key={title} className={`${CARD} p-5 sm:p-6`}>
                  <span className={CARD_ICON}>
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h3 className="mt-4 text-[15px] font-semibold tracking-tight text-zinc-100">{t(title)}</h3>
                  <p className={`mt-2 ${BODY}`}>{t(body)}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* 怎么用: three steps. */}
        <section id="how" className={SECTION}>
          <div className={`${PAGE} py-14 sm:py-20`}>
            <p className={EYEBROW}>{t('welcome.steps.eyebrow')}</p>
            <h2 className={H2}>{t('welcome.steps.title')}</h2>
            <ol className="mt-9 grid gap-6 md:grid-cols-3 md:gap-8">
              {STEPS.map(({ icon: Icon, title, body }, index) => (
                <li key={title}>
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-semibold tabular-nums text-blue-300">
                      {String(index + 1).padStart(2, '0')}
                    </span>
                    <Icon className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                  </div>
                  <h3 className="mt-3 text-[15px] font-semibold tracking-tight text-zinc-100">{t(title)}</h3>
                  <p className={`mt-2 ${BODY}`}>{t(body)}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* 免费资源 + 博客: both are real, public destinations. */}
        <section id="explore" className={SECTION}>
          <div className={`${PAGE} py-14 sm:py-20`}>
            <p className={EYEBROW}>{t('welcome.explore.eyebrow')}</p>
            <h2 className={H2}>{t('welcome.explore.title')}</h2>
            <p className={`mt-3 max-w-2xl ${BODY}`}>{t('welcome.explore.subtitle')}</p>

            <div className="mt-9 grid gap-3 sm:grid-cols-2 sm:gap-4">
              <a
                href="#/content"
                data-testid="welcome-library-link"
                className={`${CARD} group block p-5 transition-[background-color,border-color] duration-200 hover:border-white/10 hover:bg-zinc-800/40 sm:p-6`}
              >
                <div className="flex items-center gap-3">
                  <span className={CARD_ICON}>
                    <Library className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                    {t('welcome.explore.library.title')}
                  </h3>
                </div>
                <p className={`mt-3 ${BODY}`}>{t('welcome.explore.library.body')}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-300 transition-colors group-hover:text-blue-200">
                  {t('welcome.explore.library.cta')}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </a>

              <a
                href="#/content/blog"
                data-testid="welcome-blog-link"
                className={`${CARD} group block p-5 transition-[background-color,border-color] duration-200 hover:border-white/10 hover:bg-zinc-800/40 sm:p-6`}
              >
                <div className="flex items-center gap-3">
                  <span className={CARD_ICON}>
                    <Newspaper className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h3 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                    {t('welcome.explore.blog.title')}
                  </h3>
                </div>
                <p className={`mt-3 ${BODY}`}>{t('welcome.explore.blog.body')}</p>
                <span className="mt-4 inline-flex items-center gap-1.5 text-sm font-medium text-blue-300 transition-colors group-hover:text-blue-200">
                  {t('welcome.explore.blog.cta')}
                  <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </span>
              </a>
            </div>
          </div>
        </section>
      </main>

      <footer className={SECTION}>
        <div className={`${PAGE} flex flex-col gap-8 py-10`}>
          <div className="flex flex-col justify-between gap-8 sm:flex-row sm:items-start">
            <div>
              <div className="flex items-center gap-2.5">
                <span className="h-7 w-7 overflow-hidden rounded-[8px] ring-1 ring-white/10">
                  <img src="/hero_icon.png" alt="" className="h-full w-full object-cover" />
                </span>
                <span className="text-sm font-semibold tracking-tight text-zinc-200">
                  {t('welcome.hero.brand')}
                </span>
              </div>
              <p className="mt-3 max-w-xs text-xs leading-relaxed text-zinc-500">
                {t('welcome.footer.tagline')}
              </p>
            </div>

            <nav
              aria-label={t('welcome.footer.aria')}
              className="flex flex-wrap items-center gap-x-6 gap-y-3"
            >
              <ComingSoon label={t('welcome.footer.about')} testId="welcome-about" />
              <a
                href="#/content/blog"
                data-testid="welcome-footer-blog"
                className="text-sm text-zinc-400 transition-colors hover:text-zinc-100"
              >
                {t('welcome.footer.blog')}
              </a>
              <ComingSoon label={t('welcome.footer.privacy')} testId="welcome-privacy" />
              <ComingSoon label={t('welcome.footer.terms')} testId="welcome-terms" />
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noopener noreferrer"
                data-testid="welcome-github"
                className="inline-flex items-center gap-1.5 text-sm text-zinc-400 transition-colors hover:text-zinc-100"
              >
                <Github className="h-4 w-4" aria-hidden="true" />
                {t('welcome.footer.github')}
                <ArrowUpRight className="h-3.5 w-3.5 text-zinc-600" aria-hidden="true" />
              </a>
            </nav>
          </div>

          <p className="text-xs tabular-nums text-zinc-600">
            {t('welcome.footer.copyright', { year: new Date().getFullYear() })}
          </p>
        </div>
      </footer>
    </div>
  );
}
