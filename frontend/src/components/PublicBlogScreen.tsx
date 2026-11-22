// Public official blog (`#/blog` and `#/blog/<slug>`).
//
// It is the same `BlogScreen` the app used to embed, but rendered outside the
// app shell: `PublicShell` + shared `PublicHeader`/`PublicFooter`, no
// AppShell/AuthGate around it. List → article writes the slug into the hash
// (`#/blog/<slug>`), so a refresh or a shared link opens the article directly.
// "Back" pops the article frame when the list was the previous screen inside
// the public site, and replaces to the list for a cold deep link (a browser
// `history.back()` there would leave the site).
import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { BlogScreen } from './BlogScreen';
import { PageContainer } from './layout/PageContainer';
import { PublicFooter } from './PublicFooter';
import { PublicHeader } from './PublicHeader';
import { PublicShell } from './ui/PublicShell';

export function PublicBlogScreen({ slug }: { slug?: string }) {
  const { t } = useI18n();
  // True only while the article was opened from the list *in this mount*.
  // A cold deep link starts false, so Back must not call history.back().
  const fromListRef = useRef(false);

  useEffect(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, [slug]);

  const openArticle = (nextSlug: string) => {
    if (!nextSlug) return;
    fromListRef.current = true;
    window.location.hash = `#/blog/${encodeURIComponent(nextSlug)}`;
  };

  const backToList = () => {
    if (fromListRef.current) {
      fromListRef.current = false;
      window.history.back();
      return;
    }
    window.location.hash = '#/blog';
  };

  return (
    <PublicShell
      testId="public-blog-screen"
      contained={false}
      header={<PublicHeader active="blog" />}
      footer={<PublicFooter />}
    >
      <div className="py-8 sm:py-12">
        <PageContainer variant="marketing">
          {/* The list uses the marketing measure (1200). An article keeps the
              68ch reading column so the markdown does not stretch into long
              lines on a wide screen; the back link travels with it. */}
          <div className={slug ? 'mx-auto w-full max-w-reading-body' : 'w-full'}>
            {slug && (
              <a
                href="#/blog"
                data-testid="public-blog-back"
                onClick={(event) => {
                  event.preventDefault();
                  backToList();
                }}
                className="mb-2 inline-flex items-center gap-1.5 rounded-control text-ui font-medium text-fg-secondary transition-colors hover:text-fg-primary"
              >
                <ArrowLeft className="h-4 w-4" aria-hidden="true" />
                {t('blog.backToList')}
              </a>
            )}
            <BlogScreen
              publicMode
              initialSlug={slug}
              onOpenArticle={openArticle}
              onClose={backToList}
            />
          </div>
        </PageContainer>
      </div>
    </PublicShell>
  );
}
