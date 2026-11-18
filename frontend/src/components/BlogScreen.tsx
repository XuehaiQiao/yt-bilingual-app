// Official blog channel (specs/020-blog).
//
// Two states in one full-screen view: the article list and the article detail.
// Content comes from `GET /api/blog/*` (public, no login) and originates from
// `content/blog/*.md` in the repository — there is no CMS or database.
//
// Rendering rules:
//   - `react-markdown` renders the Markdown. Raw HTML is skipped (never turned
//     into DOM), so an article containing `<script>` cannot execute. The
//     backend also returns an escaped HTML field for non-React consumers; we
//     deliberately do not use `dangerouslySetInnerHTML` here.
//   - The Giscus slot is reserved but disabled until all four VITE_GISCUS_*
//     variables are configured; otherwise readers see "评论即将开放".
import { useCallback, useEffect, useRef, useState } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import {
  AlertCircle,
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Loader2,
  MessageCircle,
  RefreshCw,
  Rss,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
  BlogApiError,
  blogFeedUrl,
  getBlogPost,
  listBlogPosts,
  type BlogPost,
  type BlogPostSummary,
} from '../lib/blog';
import { SubHeader } from './ui/SubHeader';

const GISCUS = {
  repo: import.meta.env.VITE_GISCUS_REPO as string | undefined,
  repoId: import.meta.env.VITE_GISCUS_REPO_ID as string | undefined,
  category: import.meta.env.VITE_GISCUS_CATEGORY as string | undefined,
  categoryId: import.meta.env.VITE_GISCUS_CATEGORY_ID as string | undefined,
};

const SECONDARY_BUTTON =
  'inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50';

function giscusConfigured(): boolean {
  return Boolean(GISCUS.repo && GISCUS.repoId && GISCUS.category && GISCUS.categoryId);
}

// react-markdown hands each component the AST `node` prop. Forwarding it to a
// DOM element would leak an object attribute, so every renderer drops it.
function stripMarkdownNode<T extends object>(props: T): Omit<T, 'node'> {
  const { node, ...rest } = props as T & { node?: unknown };
  void node;
  return rest as Omit<T, 'node'>;
}

const markdownComponents: Components = {
  h1: (props) => (
    <h2 className="mt-9 mb-3 text-xl font-semibold tracking-tight text-zinc-50" {...stripMarkdownNode(props)} />
  ),
  h2: (props) => (
    <h2 className="mt-9 mb-3 text-xl font-semibold tracking-tight text-zinc-50" {...stripMarkdownNode(props)} />
  ),
  h3: (props) => (
    <h3 className="mt-7 mb-2 text-[17px] font-semibold tracking-tight text-zinc-100" {...stripMarkdownNode(props)} />
  ),
  h4: (props) => (
    <h4 className="mt-6 mb-2 text-[15px] font-semibold text-zinc-100" {...stripMarkdownNode(props)} />
  ),
  p: (props) => (
    <p className="my-4 text-[15px] leading-7 text-zinc-300 break-words" {...stripMarkdownNode(props)} />
  ),
  a: ({ node, href, children, ...props }) => {
    void node;
    const external = Boolean(href && /^https?:\/\//i.test(href));
    return (
      <a
        href={href}
        target={external ? '_blank' : undefined}
        rel={external ? 'noopener noreferrer' : undefined}
        className="text-blue-400 underline decoration-blue-400/40 underline-offset-2 hover:text-blue-300 break-words"
        {...stripMarkdownNode(props)}
      >
        {children}
      </a>
    );
  },
  ul: (props) => (
    <ul className="my-4 space-y-1.5 pl-5 list-disc text-[15px] leading-7 text-zinc-300 marker:text-zinc-600" {...stripMarkdownNode(props)} />
  ),
  ol: (props) => (
    <ol className="my-4 space-y-1.5 pl-5 list-decimal text-[15px] leading-7 text-zinc-300 marker:text-zinc-600" {...stripMarkdownNode(props)} />
  ),
  li: (props) => <li className="pl-1 break-words" {...stripMarkdownNode(props)} />,
  blockquote: (props) => (
    <blockquote className="my-5 border-l-2 border-blue-400/40 pl-4 text-zinc-400 [&>p]:my-2" {...stripMarkdownNode(props)} />
  ),
  hr: () => <hr className="my-8 border-white/5" />,
  strong: (props) => <strong className="font-semibold text-zinc-100" {...stripMarkdownNode(props)} />,
  em: (props) => <em className="not-italic text-zinc-100" {...stripMarkdownNode(props)} />,
  code: ({ node, className, children, ...props }) => {
    void node;
    const block = Boolean(className);
    if (block) {
      return (
        <code
          className="block overflow-x-auto rounded-xl border border-white/5 bg-zinc-900/80 p-4 text-xs leading-6 text-zinc-300 font-mono"
          {...stripMarkdownNode(props)}
        >
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded-md border border-white/10 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-200 font-mono break-words"
        {...stripMarkdownNode(props)}
      >
        {children}
      </code>
    );
  },
  pre: (props) => <pre className="my-5" {...stripMarkdownNode(props)} />,
};

function errorText(error: unknown, fallback: string): string {
  if (error instanceof BlogApiError && error.message && error.status !== -1) return error.message;
  return fallback;
}

function formatPostDate(
  value: string,
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string,
): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return formatDate(parsed, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function GiscusComments({ slug, lang }: { slug: string; lang: string }) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const configured = giscusConfigured();

  useEffect(() => {
    if (!configured) return;
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    const script = document.createElement('script');
    script.src = 'https://giscus.app/client.js';
    script.async = true;
    script.crossOrigin = 'anonymous';
    script.setAttribute('data-repo', GISCUS.repo ?? '');
    script.setAttribute('data-repo-id', GISCUS.repoId ?? '');
    script.setAttribute('data-category', GISCUS.category ?? '');
    script.setAttribute('data-category-id', GISCUS.categoryId ?? '');
    // The app has no per-article URL yet, so map discussions by slug instead
    // of pathname; this also survives future route changes.
    script.setAttribute('data-mapping', 'specific');
    script.setAttribute('data-term', `blog/${slug}`);
    script.setAttribute('data-strict', '0');
    script.setAttribute('data-reactions-enabled', '1');
    script.setAttribute('data-emit-metadata', '0');
    script.setAttribute('data-input-position', 'bottom');
    script.setAttribute('data-theme', 'dark');
    script.setAttribute('data-lang', lang === 'vi-VN' ? 'vi' : 'zh-CN');
    container.appendChild(script);
    return () => {
      container.replaceChildren();
    };
  }, [configured, lang, slug]);

  if (!configured) {
    return (
      <div
        data-testid="blog-comments-placeholder"
        className="rounded-2xl border border-white/5 bg-zinc-900/40 px-5 py-6"
      >
        <div className="flex items-start gap-3">
          <MessageCircle className="w-5 h-5 text-zinc-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-sm font-medium text-zinc-300">{t('blog.comments.soon')}</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('blog.comments.soonHint')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      data-testid="blog-comments-giscus"
      className="min-h-[120px] rounded-2xl border border-white/5 bg-zinc-900/30 p-3 sm:p-4"
    />
  );
}

function BlogListCard({
  post,
  onOpen,
  formatDate,
}: {
  post: BlogPostSummary;
  onOpen: (slug: string) => void;
  formatDate: (date: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}) {
  const { t, formatNumber } = useI18n();
  return (
    <li>
      <button
        type="button"
        data-testid={`blog-post-${post.slug}`}
        onClick={() => onOpen(post.slug)}
        className="w-full text-left rounded-2xl border border-white/5 bg-zinc-900/40 hover:bg-zinc-900/60 hover:border-white/10 p-5 sm:p-6 transition-[background-color,border-color] duration-200 ease-apple"
      >
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-zinc-500">
          <time dateTime={post.date}>{formatPostDate(post.date, formatDate)}</time>
          <span aria-hidden="true">·</span>
          <span className="tabular-nums">
            {t('blog.readingTime', { minutes: formatNumber(post.readingMinutes) })}
          </span>
        </div>
        <h2 className="mt-2 text-lg sm:text-xl font-semibold tracking-tight text-zinc-100 break-words">
          {post.title}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-zinc-400 break-words">{post.excerpt}</p>
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap gap-1.5" aria-label={t('blog.tagAria')}>
            {post.tags.map((tag) => (
              <span
                key={tag}
                className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/70 border border-white/5 text-zinc-400"
              >
                {tag}
              </span>
            ))}
          </div>
          <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-400">
            {t('blog.readMore')}
            <ArrowRight className="w-3.5 h-3.5" />
          </span>
        </div>
      </button>
    </li>
  );
}

export function BlogScreen({
  onClose,
  initialSlug,
  onOpenArticle,
  parentLabel,
}: {
  onClose: () => void;
  /** Parent screen name for the back control's aria label. */
  parentLabel?: string;
  /** Article slug from the route (`#/<tab>/blog/<slug>`); absent = list. */
  initialSlug?: string;
  /** List → article: the app pushes `...#/blog/<slug>` (N-01/J27). */
  onOpenArticle: (slug: string) => void;
}) {
  const { t, language, formatDate, formatNumber } = useI18n();

  const [posts, setPosts] = useState<BlogPostSummary[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  // The URL owns which article is open: a refresh or a shared link renders the
  // article directly, and Back restores the list without local state.
  const selectedSlug = initialSlug ?? null;

  const [article, setArticle] = useState<BlogPost | null>(null);
  const [articleLoading, setArticleLoading] = useState(false);
  const [articleError, setArticleError] = useState<string | null>(null);
  const [articleNotFound, setArticleNotFound] = useState(false);
  // Retry must re-run the fetch even when the slug did not change.
  const [articleReloadKey, setArticleReloadKey] = useState(0);

  const loadList = useCallback(async () => {
    setListLoading(true);
    setListError(null);
    try {
      const data = await listBlogPosts();
      setPosts(data.posts);
    } catch (error) {
      setListError(errorText(error, t('blog.error')));
    } finally {
      setListLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadList();
  }, [loadList]);

  useEffect(() => {
    if (!selectedSlug) {
      setArticle(null);
      setArticleError(null);
      setArticleNotFound(false);
      setArticleLoading(false);
      return;
    }
    let cancelled = false;
    setArticleLoading(true);
    setArticleError(null);
    setArticleNotFound(false);
    setArticle(null);
    getBlogPost(selectedSlug)
      .then((data) => {
        if (!cancelled) setArticle(data);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        const notFound = error instanceof BlogApiError && error.status === 404;
        setArticleNotFound(notFound);
        setArticleError(
          notFound
            ? t('blog.notFound')
            : errorText(error, t('blog.detailError')),
        );
      })
      .finally(() => {
        if (!cancelled) setArticleLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedSlug, articleReloadKey, t]);

  const handleBack = () => {
    // Both list → parent and article → list go through the route/history:
    // App passes `back()`, which pops the pushed article frame or, for a deep
    // link with no in-app history, replaces with the blog list (`parentOf`).
    onClose();
  };

  const feedUrl = blogFeedUrl();

  return (
    <div
      data-testid="blog-screen"
      className="flex-1 min-h-0 flex flex-col bg-[#09090b]"
    >
      <SubHeader
        title={t('blog.title')}
        onBack={handleBack}
        parentLabel={parentLabel}
        backAriaLabel={selectedSlug ? t('blog.backToList') : undefined}
        backLabel={selectedSlug ? t('blog.backToList') : undefined}
        backTestId="blog-back"
        titleAs={selectedSlug ? 'p' : 'h1'}
        actions={(
          <a
            href={feedUrl}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('blog.feedAria')}
            className="inline-flex h-9 items-center gap-1.5 rounded-control border border-white/5 bg-zinc-800/60 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100"
          >
            <Rss className="w-4 h-4" />
            <span className="hidden sm:inline">{t('blog.feed')}</span>
          </a>
        )}
      />
      <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
      <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-6 sm:py-10">
        {selectedSlug ? (
          <article className="mt-6">
            {articleLoading && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                <p className="text-sm text-zinc-400">{t('blog.detailLoading')}</p>
              </div>
            )}

            {!articleLoading && articleError && (
              <section
                role="alert"
                data-testid="blog-detail-error"
                className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm leading-relaxed text-zinc-300 break-words">{articleError}</p>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {!articleNotFound && (
                        <button
                          type="button"
                          onClick={() => setArticleReloadKey((key) => key + 1)}
                          className={SECONDARY_BUTTON}
                        >
                          <RefreshCw className="w-4 h-4" />
                          {t('blog.retry')}
                        </button>
                      )}
                      <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                        <ArrowLeft className="w-4 h-4" />
                        {t('blog.backToList')}
                      </button>
                    </div>
                  </div>
                </div>
              </section>
            )}

            {!articleLoading && !articleError && article && (
              <>
                <header>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-medium text-zinc-500">
                    <time dateTime={article.date}>
                      {t('blog.published', { date: formatPostDate(article.date, formatDate) })}
                    </time>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {t('blog.readingTime', { minutes: formatNumber(article.readingMinutes) })}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className="inline-flex items-center gap-1 text-zinc-400">
                      <BookOpen className="w-3.5 h-3.5" />
                      {t('blog.articleLanguage')}
                    </span>
                  </div>
                  <h1 className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50 break-words">
                    {article.title}
                  </h1>
                  <p className="mt-3 text-sm leading-relaxed text-zinc-400 break-words">{article.excerpt}</p>
                  <div className="mt-4 flex flex-wrap gap-1.5" aria-label={t('blog.tagAria')}>
                    {article.tags.map((tag) => (
                      <span
                        key={tag}
                        className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/70 border border-white/5 text-zinc-400"
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                  <hr className="mt-6 border-white/5" />
                </header>

                <div data-testid="blog-markdown" className="mt-2">
                  <ReactMarkdown components={markdownComponents} skipHtml>
                    {article.markdown}
                  </ReactMarkdown>
                </div>

                <footer className="mt-12 border-t border-white/5 pt-7">
                  <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                    {t('blog.comments.title')}
                  </h2>
                  <div className="mt-4">
                    <GiscusComments slug={article.slug} lang={language} />
                  </div>
                </footer>
              </>
            )}
          </article>
        ) : (
          <>
            <header className="mt-1">
              <p className="text-micro font-medium text-brand-300">{t('blog.eyebrow')}</p>
              <p className="mt-1 text-ui leading-relaxed text-fg-secondary">{t('blog.subtitle')}</p>
            </header>

            {listLoading && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                <p className="text-sm text-zinc-400">{t('blog.loading')}</p>
              </div>
            )}

            {!listLoading && listError && (
              <section
                role="alert"
                data-testid="blog-list-error"
                className="mt-8 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
              >
                <div className="flex items-start gap-3">
                  <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-zinc-300">{t('blog.error')}</p>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 break-words">{listError}</p>
                    <button type="button" onClick={() => void loadList()} className={`${SECONDARY_BUTTON} mt-3`}>
                      <RefreshCw className="w-4 h-4" />
                      {t('blog.retry')}
                    </button>
                  </div>
                </div>
              </section>
            )}

            {!listLoading && !listError && posts.length === 0 && (
              <div className="flex flex-col items-center justify-center py-24 text-center">
                <BookOpen className="w-10 h-10 text-zinc-700 mb-3" />
                <p className="text-sm font-medium text-zinc-400">{t('blog.empty')}</p>
              </div>
            )}

            {!listLoading && !listError && posts.length > 0 && (
              <ul data-testid="blog-post-list" aria-label={t('blog.listAria')} className="mt-8 space-y-4">
                {posts.map((post) => (
                  <BlogListCard
                    key={post.slug}
                    post={post}
                    onOpen={onOpenArticle}
                    formatDate={formatDate}
                  />
                ))}
              </ul>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}
