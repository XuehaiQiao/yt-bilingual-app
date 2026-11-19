// Public resources page (`#/resources`).
//
// A curated set of *legal* free / public-domain destinations: the official blog
// and the in-app free library (internal), plus Project Gutenberg, Standard
// Ebooks and LibriVox (external, opened in a new tab). The page never hosts or
// mirrors copyrighted text — it only links to the rights holders / official
// free libraries.
import { ArrowRight, ArrowUpRight, BookOpen, Library, Newspaper, Volume2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicContainer, PublicShell } from './ui/PublicShell';

type ResourceId = 'blog' | 'library' | 'gutenberg' | 'standardebooks' | 'librivox';

interface ResourceCard {
  id: ResourceId;
  icon: LucideIcon;
  href: string;
  external: boolean;
  titleKey: TranslationKey;
  bodyKey: TranslationKey;
  ctaKey: TranslationKey;
}

const CARDS: readonly ResourceCard[] = [
  {
    id: 'blog',
    icon: Newspaper,
    href: '#/blog',
    external: false,
    titleKey: 'public.resources.blog.title',
    bodyKey: 'public.resources.blog.body',
    ctaKey: 'public.resources.blog.cta',
  },
  {
    id: 'library',
    icon: Library,
    href: '#/app/content',
    external: false,
    titleKey: 'public.resources.library.title',
    bodyKey: 'public.resources.library.body',
    ctaKey: 'public.resources.library.cta',
  },
  {
    id: 'gutenberg',
    icon: BookOpen,
    href: 'https://www.gutenberg.org/',
    external: true,
    titleKey: 'public.resources.gutenberg.title',
    bodyKey: 'public.resources.gutenberg.body',
    ctaKey: 'public.resources.gutenberg.cta',
  },
  {
    id: 'standardebooks',
    icon: BookOpen,
    href: 'https://standardebooks.org/',
    external: true,
    titleKey: 'public.resources.standardebooks.title',
    bodyKey: 'public.resources.standardebooks.body',
    ctaKey: 'public.resources.standardebooks.cta',
  },
  {
    id: 'librivox',
    icon: Volume2,
    href: 'https://librivox.org/',
    external: true,
    titleKey: 'public.resources.librivox.title',
    bodyKey: 'public.resources.librivox.body',
    ctaKey: 'public.resources.librivox.cta',
  },
];

export function ResourcesScreen() {
  const { t } = useI18n();

  return (
    <PublicShell
      testId="resources-screen"
      contained={false}
      header={<PublicHeader active="resources" />}
      footer={<PublicFooter />}
    >
      <section className="py-16 sm:py-24">
        <PublicContainer>
          <div className="max-w-3xl">
            <p className="text-micro font-medium text-fg-muted">{t('public.resources.eyebrow')}</p>
            <h1
              data-testid="resources-title"
              className="mt-3 text-display-sm font-semibold tracking-hero text-fg-primary sm:text-display"
            >
              {t('public.resources.title')}
            </h1>
            <p className="mt-5 max-w-2xl text-section leading-relaxed text-fg-secondary">
              {t('public.resources.subtitle')}
            </p>
          </div>

          <ul className="mt-12 grid gap-3 sm:grid-cols-2 sm:gap-4 lg:grid-cols-3">
            {CARDS.map(({ id, icon: Icon, href, external, titleKey, bodyKey, ctaKey }) => (
              <li key={id}>
                <a
                  href={href}
                  data-testid={`resource-card-${id}`}
                  target={external ? '_blank' : undefined}
                  rel={external ? 'noopener noreferrer' : undefined}
                  className="group flex h-full flex-col rounded-card border border-line-subtle bg-surface/40 p-5 transition-[background-color,border-color] duration-200 ease-apple hover:border-line-strong hover:bg-surface/50 sm:p-6"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control-lg border border-brand/20 bg-brand/10 text-brand-300">
                    <Icon className="h-4 w-4" aria-hidden="true" />
                  </span>
                  <h2 className="mt-4 text-ui font-semibold tracking-tight text-fg-primary">
                    {t(titleKey)}
                  </h2>
                  <p className="mt-2 flex-1 text-ui leading-relaxed text-fg-secondary">
                    {t(bodyKey)}
                  </p>
                  <span className="mt-4 inline-flex items-center gap-1.5 text-ui font-medium text-brand-300">
                    {t(ctaKey)}
                    {external ? (
                      <ArrowUpRight className="h-4 w-4" aria-hidden="true" />
                    ) : (
                      <ArrowRight className="h-4 w-4" aria-hidden="true" />
                    )}
                  </span>
                </a>
              </li>
            ))}
          </ul>

          <p className="mt-8 text-micro leading-relaxed text-fg-muted">{t('public.resources.note')}</p>
        </PublicContainer>
      </section>
    </PublicShell>
  );
}
