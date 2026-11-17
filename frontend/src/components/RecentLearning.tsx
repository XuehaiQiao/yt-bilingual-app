// "Recent learning" on Today (redesign of the old 3-row history strip).
//
// One merged list for the three ways a user learns here:
//   - video   → `/api/history` rows already fetched by TodayScreen;
//   - article → `GET /api/articles` (signed-in only; guests never request it);
//   - book    → local chapter progress for curated public-domain books and
//               imported books, resolved to titles through their indexes.
//
// The list is searchable, filterable by type, sorted by last activity and
// paginated (10/page). Time is formatted relative to today/yesterday in the
// current UI language; a missing timestamp is shown as "unknown" — never as
// 1970. Article/book indexes are fetched only when they have progress to show
// and only once per mount; leaving the screen aborts in-flight requests.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    Clock,
    FileText,
    Film,
    Loader2,
    RefreshCw,
    Search,
    Trash2,
    X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKey } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import type { HistoryItem } from './ChannelVideoList';
import { fetchBooksIndex, listBookProgress } from '../lib/books';
import {
    ImportedBooksApiError,
    fetchImportedBooks,
    listImportedBookProgress,
} from '../lib/importedBooks';
import { ReadingApiError, listArticles } from '../lib/reading';
import {
    articleRecentItems,
    curatedBookRecentItems,
    filterRecentItems,
    importedBookRecentItems,
    paginateRecentItems,
    sortRecentItems,
    videoRecentItems,
    type RecentFilter,
    type RecentItem,
    type RecentKind,
} from '../lib/recent';

const FILTERS: ReadonlyArray<{ id: RecentFilter; labelKey: TranslationKey }> = [
    { id: 'all', labelKey: 'today.recent.filter.all' },
    { id: 'video', labelKey: 'today.recent.filter.video' },
    { id: 'article', labelKey: 'today.recent.filter.article' },
    { id: 'book', labelKey: 'today.recent.filter.book' },
];

const KIND_META: Record<RecentKind, { labelKey: TranslationKey; icon: LucideIcon }> = {
    video: { labelKey: 'today.recent.type.video', icon: Film },
    article: { labelKey: 'today.recent.type.article', icon: FileText },
    book: { labelKey: 'today.recent.type.book', icon: BookOpen },
};

const PAGE_BUTTON =
    'inline-flex h-8 items-center gap-1 rounded-lg border border-white/5 bg-zinc-800/60 px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-40';

interface RecentLearningProps {
    isGuest: boolean;
    /** Already fetched by TodayScreen; this component never re-requests it. */
    history: HistoryItem[];
    historyLoading: boolean;
    onLoadHistory: (filename: string) => void;
    onOpenArticle: (articleId: string) => void;
    /** Curated public-domain book reader. */
    onOpenBook: (bookId: string) => void;
    /** Imported-book reader (signed-in). */
    onOpenImportedBook: (bookId: string) => void;
    onOpenContent: () => void;
    /** Preserves the old hover-to-delete affordance for video rows. */
    onRemoveVideo?: (filename: string) => void;
}

export function RecentLearning({
    isGuest,
    history,
    historyLoading,
    onLoadHistory,
    onOpenArticle,
    onOpenBook,
    onOpenImportedBook,
    onOpenContent,
    onRemoveVideo,
}: RecentLearningProps) {
    const { t, formatNumber, formatDate } = useI18n();
    const [articles, setArticles] = useState<RecentItem[]>([]);
    const [curatedBooks, setCuratedBooks] = useState<RecentItem[]>([]);
    const [importedBooks, setImportedBooks] = useState<RecentItem[]>([]);
    const [articlesLoading, setArticlesLoading] = useState(!isGuest);
    const [booksLoading, setBooksLoading] = useState(true);
    const [articlesFailed, setArticlesFailed] = useState(false);
    const [booksFailed, setBooksFailed] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<RecentFilter>('all');
    const [page, setPage] = useState(1);
    const listRef = useRef<HTMLDivElement>(null);

    // Articles: signed-in users only. 401/403 means "feature unavailable for
    // this account" and is skipped silently rather than surfacing an error on
    // a page whose other cards still work.
    useEffect(() => {
        if (isGuest) return; // Initial state is already "off" for a guest.
        const controller = new AbortController();
        let active = true;
        listArticles(controller.signal)
            .then((rows) => {
                if (active) setArticles(articleRecentItems(rows));
            })
            .catch((error: unknown) => {
                if (!active) return;
                const status = error instanceof ReadingApiError ? error.status : null;
                if (status === 401 || status === 403) {
                    setArticles([]);
                    return;
                }
                console.error('Failed to load recent articles:', error);
                setArticles([]);
                setArticlesFailed(true);
            })
            .finally(() => {
                if (active) setArticlesLoading(false);
            });
        return () => {
            active = false;
            controller.abort();
        };
    }, [isGuest, reloadToken]);

    // Books: read the two localStorage progress maps first, then fetch the
    // matching title index only when there is something to resolve. No
    // progress → no request at all.
    useEffect(() => {
        const controller = new AbortController();
        let active = true;
        const curatedProgress = listBookProgress();
        const importedProgress = isGuest ? [] : listImportedBookProgress();

        const load = async () => {
            let failed = false;
            if (curatedProgress.length > 0) {
                try {
                    const index = await fetchBooksIndex(controller.signal);
                    if (!active) return;
                    setCuratedBooks(curatedBookRecentItems(curatedProgress, index));
                } catch (error) {
                    if (!active || controller.signal.aborted) return;
                    console.error('Failed to resolve recent book titles:', error);
                    failed = true;
                }
            }
            if (!isGuest && importedProgress.length > 0) {
                try {
                    const books = await fetchImportedBooks(controller.signal);
                    if (!active) return;
                    setImportedBooks(importedBookRecentItems(importedProgress, books));
                } catch (error) {
                    if (!active || controller.signal.aborted) return;
                    const status = error instanceof ImportedBooksApiError ? error.status : null;
                    if (status !== 401 && status !== 403) {
                        console.error('Failed to resolve imported book titles:', error);
                        failed = true;
                    }
                }
            }
            if (active) {
                setBooksFailed(failed);
                setBooksLoading(false);
            }
        };
        void load();
        return () => {
            active = false;
            controller.abort();
        };
    }, [isGuest, reloadToken]);

    const videoItems = useMemo(() => videoRecentItems(history), [history]);
    const allItems = useMemo(
        () => sortRecentItems([...videoItems, ...articles, ...curatedBooks, ...importedBooks]),
        [videoItems, articles, curatedBooks, importedBooks],
    );

    const counts = useMemo(() => {
        const next: Record<RecentFilter, number> = { all: 0, video: 0, article: 0, book: 0 };
        for (const item of allItems) {
            next.all += 1;
            next[item.kind] += 1;
        }
        return next;
    }, [allItems]);

    const filtered = useMemo(
        () => filterRecentItems(allItems, filter, query),
        [allItems, filter, query],
    );
    const paged = paginateRecentItems(filtered, page);

    const loading = allItems.length === 0 && (historyLoading || articlesLoading || booksLoading);
    const hasError = articlesFailed || booksFailed;

    const formatLastAt = useCallback((lastAt: number): { text: string; dateTime?: string } => {
        const at = Number.isFinite(lastAt) && lastAt > 0 ? lastAt : 0;
        if (at === 0) return { text: t('today.recent.time.unknown') };
        const date = new Date(at);
        if (Number.isNaN(date.getTime())) return { text: t('today.recent.time.unknown') };
        const now = new Date();
        const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const startOfYesterday = new Date(
            now.getFullYear(),
            now.getMonth(),
            now.getDate() - 1,
        ).getTime();
        const iso = date.toISOString();
        if (at >= startOfToday) {
            const time = formatDate(at, {
                hour: '2-digit',
                minute: '2-digit',
                hourCycle: 'h23',
            });
            return { text: t('today.recent.time.today', { time }), dateTime: iso };
        }
        if (at >= startOfYesterday) {
            return { text: t('today.recent.time.yesterday'), dateTime: iso };
        }
        const options: Intl.DateTimeFormatOptions = date.getFullYear() === now.getFullYear()
            ? { month: 'short', day: 'numeric' }
            : { year: 'numeric', month: 'short', day: 'numeric' };
        return { text: formatDate(at, options), dateTime: iso };
    }, [t, formatDate]);

    const subtitleLabel = (item: RecentItem): string => {
        if (item.subtitle) return item.subtitle;
        if (item.kind === 'video') return t('common.localFile');
        if (item.kind === 'article') return t('today.recent.unknownSite');
        return item.bookSource === 'imported' ? t('importedBooks.unknownAuthor') : '';
    };

    const progressLabel = (item: RecentItem): string => {
        switch (item.kind) {
            case 'video':
                return item.progress.percent !== null
                    ? t('home.today.watchedPercent', { percent: item.progress.percent })
                    : t('home.today.lastOpened');
            case 'article':
                return item.progress.paragraphIdx !== null
                    ? t('today.recent.progress.article', { n: formatNumber(item.progress.paragraphIdx + 1) })
                    : t('today.recent.progress.notStarted');
            case 'book':
                return t('books.reader.chapter', { n: formatNumber(item.progress.chapter) });
            default:
                return '';
        }
    };

    const openItem = (item: RecentItem) => {
        switch (item.kind) {
            case 'video':
                onLoadHistory(item.filename);
                break;
            case 'article':
                onOpenArticle(item.articleId);
                break;
            case 'book':
                if (item.bookSource === 'imported') onOpenImportedBook(item.bookId);
                else onOpenBook(item.bookId);
                break;
        }
    };

    const goToPage = (next: number) => {
        setPage(next);
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        listRef.current?.scrollIntoView({
            behavior: reduceMotion ? 'auto' : 'smooth',
            block: 'start',
        });
    };

    const retry = () => {
        // Retry is an event, so resetting the pending state here (rather than
        // synchronously inside the effects) keeps React's effect rules happy.
        setArticlesLoading(!isGuest);
        setArticlesFailed(false);
        setBooksLoading(true);
        setBooksFailed(false);
        setCuratedBooks([]);
        setImportedBooks([]);
        setReloadToken((token) => token + 1);
    };

    const renderItem = (item: RecentItem) => {
        const meta = KIND_META[item.kind];
        const Icon = meta.icon;
        const time = formatLastAt(item.lastAt);
        const subtitle = subtitleLabel(item);
        return (
            <div
                key={item.key}
                data-testid="recent-item"
                data-kind={item.kind}
                data-key={item.key}
                data-last-at={item.lastAt}
                role="button"
                tabIndex={0}
                aria-label={`${t(meta.labelKey)}: ${item.title}`}
                onClick={() => openItem(item)}
                onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        openItem(item);
                    }
                }}
                className="group/recent flex min-w-0 cursor-pointer items-start gap-2.5 rounded-xl border border-white/5 bg-zinc-800/30 p-2.5 text-left transition-colors hover:border-white/10 hover:bg-zinc-800/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50 sm:p-3"
            >
                <span className="mt-0.5 inline-flex shrink-0 items-center gap-1 rounded-full border border-white/5 bg-zinc-900/60 px-1.5 py-0.5 text-[10px] font-medium text-zinc-400 sm:px-2">
                    <Icon className="h-3 w-3" aria-hidden="true" />
                    {t(meta.labelKey)}
                </span>
                <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-zinc-200">
                        {item.title || t('common.unknownVideo')}
                    </span>
                    {subtitle && (
                        <span className="mt-0.5 block truncate text-[11px] text-zinc-500">{subtitle}</span>
                    )}
                </span>
                <span className="flex shrink-0 items-start gap-1">
                    <span className="flex flex-col items-end gap-0.5">
                        <time
                            data-testid="recent-time"
                            dateTime={time.dateTime}
                            className="whitespace-nowrap text-[11px] tabular-nums text-zinc-500"
                        >
                            {time.text}
                        </time>
                        <span
                            data-testid="recent-progress"
                            className="whitespace-nowrap text-[11px] text-zinc-400"
                        >
                            {progressLabel(item)}
                        </span>
                    </span>
                    {item.kind === 'video' && onRemoveVideo && (
                        <button
                            type="button"
                            data-testid="recent-remove"
                            title={t('home.removeHistoryTitle')}
                            aria-label={t('home.removeHistoryTitle')}
                            onClick={(event) => {
                                event.stopPropagation();
                                onRemoveVideo(item.filename);
                            }}
                            className="mt-0.5 rounded-lg p-1 text-zinc-500 opacity-0 transition-[opacity,background-color,color] hover:bg-red-500/10 hover:text-red-400 focus-visible:opacity-100 group-hover/recent:opacity-100 [@media(pointer:coarse)]:opacity-100"
                        >
                            <Trash2 className="h-3.5 w-3.5" />
                        </button>
                    )}
                </span>
            </div>
        );
    };

    return (
        <section
            data-testid="recent-learning"
            data-loading={loading ? 'true' : 'false'}
            aria-labelledby="recent-learning-title"
            className="mt-5 min-w-0 rounded-3xl border border-white/5 bg-zinc-900/30 p-3.5 sm:p-5"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <h2
                        id="recent-learning-title"
                        className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-zinc-100"
                    >
                        <Clock className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                        {t('today.history.title')}
                    </h2>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                        {t('today.recent.hint')}
                    </p>
                </div>
                {!loading && allItems.length > 0 && (
                    <p
                        data-testid="recent-total"
                        className="shrink-0 pt-1 text-[11px] tabular-nums text-zinc-500"
                    >
                        {t('today.recent.total', { count: formatNumber(allItems.length) })}
                    </p>
                )}
            </div>

            <div className="mt-3.5 flex min-w-0 flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
                <div className="relative min-w-0 flex-1 sm:max-w-[360px]">
                    <Search
                        className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                        aria-hidden="true"
                    />
                    <input
                        data-testid="recent-search"
                        type="search"
                        value={query}
                        onChange={(event) => {
                            setQuery(event.target.value);
                            setPage(1);
                        }}
                        placeholder={t('today.recent.searchPlaceholder')}
                        aria-label={t('today.recent.searchPlaceholder')}
                        className="h-9 w-full rounded-xl border border-white/5 bg-zinc-900/60 pl-9 pr-9 text-sm text-zinc-200 transition-colors placeholder:text-zinc-500 focus:border-blue-500/40 focus:outline-none focus:ring-2 focus:ring-blue-500/20 [&::-webkit-search-cancel-button]:hidden [&::-webkit-search-decoration]:hidden"
                    />
                    {query && (
                        <button
                            type="button"
                            data-testid="recent-clear-search"
                            aria-label={t('today.recent.clearSearch')}
                            title={t('today.recent.clearSearch')}
                            onClick={() => {
                                setQuery('');
                                setPage(1);
                            }}
                            className="absolute right-2 top-1/2 -translate-y-1/2 rounded-lg p-1 text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                        >
                            <X className="h-3.5 w-3.5" />
                        </button>
                    )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                    {FILTERS.map((entry) => {
                        const active = filter === entry.id;
                        return (
                            <button
                                key={entry.id}
                                type="button"
                                data-testid={`recent-filter-${entry.id}`}
                                data-count={counts[entry.id]}
                                aria-pressed={active}
                                onClick={() => {
                                    setFilter(entry.id);
                                    setPage(1);
                                }}
                                className={`inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors ${
                                    active
                                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-300'
                                        : 'border-white/5 bg-zinc-900/40 text-zinc-400 hover:border-white/10 hover:bg-zinc-800/60 hover:text-zinc-200'
                                }`}
                            >
                                {t(entry.labelKey)}
                                <span
                                    className={`tabular-nums ${
                                        active ? 'text-blue-300/80' : 'text-zinc-500'
                                    }`}
                                >
                                    {formatNumber(counts[entry.id])}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </div>

            <div className="mt-3 min-w-0">
                {loading ? (
                    <div
                        data-testid="recent-loading"
                        className="flex items-center gap-2 rounded-2xl border border-white/5 bg-zinc-800/20 px-4 py-6 text-xs text-zinc-500"
                    >
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('home.today.loadingHistory')}
                    </div>
                ) : hasError && allItems.length === 0 ? (
                    <div
                        data-testid="recent-error"
                        role="alert"
                        className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4"
                    >
                        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" aria-hidden="true" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-amber-200">
                                {t('today.recent.errorTitle')}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                                {t('today.recent.errorHint')}
                            </p>
                            <button
                                type="button"
                                data-testid="recent-retry"
                                onClick={retry}
                                className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/15"
                            >
                                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                                {t('today.recent.retry')}
                            </button>
                        </div>
                    </div>
                ) : allItems.length === 0 ? (
                    <div
                        data-testid="recent-empty"
                        className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/5 px-4 py-10 text-center"
                    >
                        <Clock className="mb-3 h-10 w-10 text-zinc-700" aria-hidden="true" />
                        <p className="text-sm font-medium text-zinc-400">
                            {t('today.recent.emptyTitle')}
                        </p>
                        <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                            {t('today.recent.emptyHint')}
                        </p>
                        <button
                            type="button"
                            data-testid="recent-empty-action"
                            onClick={onOpenContent}
                            className="mt-4 inline-flex h-9 items-center gap-2 rounded-xl border border-blue-500/20 bg-blue-500/10 px-4 text-sm font-medium text-blue-300 transition-colors hover:bg-blue-500/15"
                        >
                            {t('today.recent.emptyAction')}
                            <ArrowRight className="h-4 w-4" aria-hidden="true" />
                        </button>
                    </div>
                ) : filtered.length === 0 ? (
                    <div
                        data-testid="recent-filtered-empty"
                        className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-white/5 px-4 py-8 text-center"
                    >
                        <p className="text-sm font-medium text-zinc-400">
                            {t('today.recent.filteredEmpty')}
                        </p>
                        <button
                            type="button"
                            data-testid="recent-clear-filters"
                            onClick={() => {
                                setQuery('');
                                setFilter('all');
                                setPage(1);
                            }}
                            className="mt-3 inline-flex h-8 items-center rounded-lg border border-white/5 bg-zinc-800/60 px-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60"
                        >
                            {t('today.recent.clearFilters')}
                        </button>
                    </div>
                ) : (
                    <>
                        <div
                            ref={listRef}
                            data-testid="recent-list"
                            className="grid min-w-0 grid-cols-1 gap-2.5 lg:grid-cols-2"
                        >
                            {paged.items.map(renderItem)}
                        </div>
                        {paged.pageCount > 1 && (
                            <div
                                data-testid="recent-pagination"
                                className="mt-3 flex items-center justify-between gap-2"
                            >
                                <button
                                    type="button"
                                    data-testid="recent-prev"
                                    disabled={paged.page <= 1}
                                    onClick={() => goToPage(paged.page - 1)}
                                    className={PAGE_BUTTON}
                                >
                                    <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
                                    {t('today.recent.page.prev')}
                                </button>
                                <span
                                    data-testid="recent-page-indicator"
                                    className="text-[11px] tabular-nums text-zinc-500"
                                >
                                    {t('today.recent.page.indicator', {
                                        page: formatNumber(paged.page),
                                        pages: formatNumber(paged.pageCount),
                                    })}
                                </span>
                                <button
                                    type="button"
                                    data-testid="recent-next"
                                    disabled={paged.page >= paged.pageCount}
                                    onClick={() => goToPage(paged.page + 1)}
                                    className={PAGE_BUTTON}
                                >
                                    {t('today.recent.page.next')}
                                    <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
                                </button>
                            </div>
                        )}
                        {hasError && (
                            <div
                                data-testid="recent-partial-error"
                                className="mt-2.5 flex items-center gap-2 text-[11px] text-amber-300/80"
                            >
                                <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="min-w-0 flex-1">{t('today.recent.partialError')}</span>
                                <button
                                    type="button"
                                    data-testid="recent-retry-inline"
                                    onClick={retry}
                                    className="shrink-0 rounded-lg px-2 py-1 text-amber-200/90 transition-colors hover:bg-amber-500/10"
                                >
                                    {t('today.recent.retry')}
                                </button>
                            </div>
                        )}
                    </>
                )}
            </div>
        </section>
    );
}
