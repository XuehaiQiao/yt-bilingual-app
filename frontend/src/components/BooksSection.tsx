// Content page "public-domain books" block (series launch: Oz / Peter Rabbit / Alice).
//
// Renders one group per series; each group shows the currently readable books
// plus a "more coming" tile. The backend stores only metadata + Chinese
// translations; opening a book goes to the dedicated reader route, which
// fetches the English source from Project Gutenberg per chapter.
import { useEffect, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookMarked,
    BookOpen,
    Globe2,
    Loader2,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { fetchBooksIndex, type BookSeries, type BookSummary, type BooksIndex } from '../lib/books';

interface BooksSectionProps {
    onOpenBook: (bookId: string) => void;
    onOpenSeries: (seriesId: string) => void;
}

const CARD =
    'group shrink-0 w-[220px] sm:w-[256px] snap-start text-left rounded-2xl border border-white/5 ' +
    'bg-zinc-900/40 p-4 hover:border-white/10 hover:bg-zinc-800/40 transition-colors cursor-pointer';

function LevelBadge({ level }: { level: string }) {
    return (
        <span className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300">
            {level}
        </span>
    );
}

function BookCard({
    book,
    totalBooks,
    onOpen,
}: {
    book: BookSummary;
    totalBooks: number;
    onOpen: (id: string) => void;
}) {
    const { t, formatNumber } = useI18n();
    return (
        <button
            type="button"
            data-testid={`book-card-${book.id}`}
            aria-label={t('books.openBook', { title: book.titleZh })}
            onClick={() => onOpen(book.id)}
            className={CARD}
        >
            <div className="flex items-start justify-between gap-2">
                <span className="w-11 h-14 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 flex items-center justify-center shrink-0">
                    <BookOpen className="w-5 h-5" />
                </span>
                <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-300">
                    <Globe2 className="w-3 h-3" />
                    {t('books.badgeShort')}
                </span>
            </div>
            <h4 className="mt-3 min-h-[2.6em] text-[14px] font-semibold leading-snug text-zinc-100 line-clamp-2 break-words">
                {book.titleZh}
            </h4>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{book.title}</p>
            <p className="mt-1 truncate text-[11px] text-zinc-500">{book.author}</p>
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                <span className="tabular-nums">
                    {t('books.chapters', {
                        readable: formatNumber(book.readableChapters),
                        total: formatNumber(book.totalChapters),
                    })}
                </span>
                <LevelBadge level={book.level} />
            </div>
            <p className="mt-1 text-[10px] text-zinc-600">
                {t('books.seriesTotal', { count: formatNumber(totalBooks) })}
            </p>
        </button>
    );
}

function SeriesGroup({
    series,
    onOpenBook,
    onOpenSeries,
}: {
    series: BookSeries;
    onOpenBook: (id: string) => void;
    onOpenSeries: (id: string) => void;
}) {
    const { t, formatNumber } = useI18n();
    const available = series.books.filter((book) => book.status === 'available');
    const comingSoon = series.books.length - available.length;
    return (
        <div data-testid={`book-series-${series.id}`} className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                    <h4 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                        {series.title}
                    </h4>
                    <p className="mt-0.5 text-[11px] text-zinc-500">
                        {series.author} · {t('books.seriesTotal', { count: formatNumber(series.totalBooks) })} ·{' '}
                        {t('books.availableCount', { count: formatNumber(available.length) })}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid={`book-series-link-${series.id}`}
                    onClick={() => onOpenSeries(series.id)}
                    className="inline-flex items-center gap-1 h-7 px-2 -mx-2 rounded-lg text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                >
                    {t('books.seriesLink')}
                    <ArrowRight className="w-3.5 h-3.5" />
                </button>
            </div>

            <div className="mt-2.5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto custom-scrollbar">
                <div className="flex gap-3 snap-x snap-mandatory pb-1">
                    {available.map((book) => (
                        <BookCard
                            key={book.id}
                            book={book}
                            totalBooks={series.totalBooks}
                            onOpen={onOpenBook}
                        />
                    ))}
                    {comingSoon > 0 && (
                        <button
                            type="button"
                            data-testid={`books-coming-soon-${series.id}`}
                            onClick={() => onOpenSeries(series.id)}
                            className="group shrink-0 w-[180px] snap-start text-left rounded-2xl border border-dashed border-white/10 bg-zinc-900/20 p-4 hover:border-white/20 hover:bg-zinc-900/40 transition-colors cursor-pointer"
                        >
                            <span className="w-11 h-14 rounded-lg bg-zinc-800/60 border border-white/5 text-zinc-500 flex items-center justify-center">
                                <BookMarked className="w-5 h-5" />
                            </span>
                            <p className="mt-3 text-[13px] font-medium text-zinc-300">
                                {t('books.comingSoonCount', { count: formatNumber(comingSoon) })}
                            </p>
                            <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                                {t('books.comingSoonHint')}
                            </p>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
}

function Skeleton() {
    return (
        <div className="space-y-5" aria-hidden="true">
            {[0, 1, 2].map((group) => (
                <div key={group}>
                    <div className="h-4 w-36 rounded bg-zinc-800/70 animate-pulse" />
                    <div className="mt-3 flex gap-3 overflow-hidden">
                        {[0, 1].map((card) => (
                            <div
                                key={card}
                                className="shrink-0 w-[220px] sm:w-[256px] rounded-2xl border border-white/5 bg-zinc-900/40 p-4"
                            >
                                <div className="w-11 h-14 rounded-lg bg-zinc-800/70 animate-pulse" />
                                <div className="mt-3 h-3 w-5/6 rounded bg-zinc-800/70 animate-pulse" />
                                <div className="mt-2 h-3 w-2/3 rounded bg-zinc-800/50 animate-pulse" />
                                <div className="mt-4 h-3 w-1/2 rounded bg-zinc-800/40 animate-pulse" />
                            </div>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function BooksSection({ onOpenBook, onOpenSeries }: BooksSectionProps) {
    const { t, formatNumber } = useI18n();
    const [data, setData] = useState<BooksIndex | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [retryToken, setRetryToken] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        fetchBooksIndex()
            .then((payload) => {
                if (!controller.signal.aborted) setData(payload);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load public-domain books:', error);
                setFailed(true);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [retryToken]);

    const retry = () => {
        setFailed(false);
        setLoading(true);
        setRetryToken((previous) => previous + 1);
    };

    return (
        <section data-testid="books-section" className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <BookMarked className="w-4 h-4 text-blue-400 shrink-0" />
                        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('books.title')}
                        </h3>
                        <span className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold text-blue-300">
                            {t('books.badge')}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 break-words">
                        {t('books.subtitle')}
                    </p>
                </div>
                {data && (
                    <span className="text-[11px] text-zinc-500 tabular-nums">
                        {t('books.counts', {
                            series: formatNumber(data.counts.series),
                            books: formatNumber(data.counts.availableBooks),
                        })}
                    </span>
                )}
            </div>

            <div className="mt-3 space-y-6">
                {loading && <Skeleton />}

                {!loading && failed && (
                    <div
                        data-testid="books-failed"
                        role="alert"
                        className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
                    >
                        <div className="flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                            <div className="min-w-0 flex-1">
                                <p className="text-sm font-medium text-amber-200">{t('books.failed')}</p>
                                <p className="mt-1 text-xs text-amber-200/70">{t('books.failedHint')}</p>
                                <button
                                    type="button"
                                    data-testid="books-retry"
                                    onClick={retry}
                                    className="mt-3 inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 text-xs font-medium text-amber-200 transition-colors"
                                >
                                    <RefreshCw className="w-3.5 h-3.5" />
                                    {t('books.retry')}
                                </button>
                            </div>
                        </div>
                    </div>
                )}

                {!loading && !failed && data?.series.length === 0 && (
                    <p className="text-sm text-zinc-500">{t('books.empty')}</p>
                )}

                {!loading && !failed &&
                    data?.series.map((series) => (
                        <SeriesGroup
                            key={series.id}
                            series={series}
                            onOpenBook={onOpenBook}
                            onOpenSeries={onOpenSeries}
                        />
                    ))}

                {loading && (
                    <span className="sr-only" data-testid="books-loading">
                        <Loader2 className="w-4 h-4" />
                    </span>
                )}
            </div>
        </section>
    );
}
