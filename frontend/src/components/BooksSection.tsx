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
    BookPlus,
    Globe2,
    Loader2,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { fetchBooksIndex, type BookSeries, type BookSummary, type BooksIndex } from '../lib/books';
import { BookImportDialog } from './BookImportDialog';
import { ImportedBooksShelf } from './ImportedBooksShelf';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';
import { CollectionCard } from './ui/CollectionCard';
import { ShelfSection } from './ui/ShelfSection';

interface BooksSectionProps {
    onOpenBook: (bookId: string) => void;
    onOpenSeries: (seriesId: string) => void;
    onOpenImportedBook: (bookId: string) => void;
    onRequestLogin: () => void;
    isGuest: boolean;
    /** A public-domain book link handed over from the article reader. */
    importSeed?: { url: string; nonce: number } | null;
    onImportSeedConsumed?: () => void;
}

function BookCard({
    book,
    onOpen,
}: {
    book: BookSummary;
    totalBooks: number;
    onOpen: (id: string) => void;
}) {
    const { t, formatNumber } = useI18n();
    return (
        <CollectionCard
            testId={`book-card-${book.id}`}
            ariaLabel={t('books.openBook', { title: book.titleZh })}
            onClick={() => onOpen(book.id)}
            visual={<BookOpen className="h-9 w-9 text-brand-300" aria-hidden="true" />}
            badge={<Badge tone="success" icon={<Globe2 />}>{t('books.badgeShort')}</Badge>}
            title={book.titleZh}
            subtitle={`${book.title} · ${book.author}`}
            meta={(
                <>
                    <span className="tabular-nums">
                        {book.translatedChapters > 0
                            ? t('books.translatedChapters', {
                                  translated: formatNumber(book.translatedChapters),
                                  total: formatNumber(book.totalChapters),
                              })
                            : t('books.originalReadable')}
                    </span>
                    <Badge tone="neutral">{book.level}</Badge>
                </>
            )}
            className="w-full"
        />
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
                        {series.translatedChapters > 0
                            ? ` · ${t('books.translatedCount', { count: formatNumber(series.translatedChapters) })}`
                            : ''}
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

            <div className="mt-2.5">
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
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
                            className="group min-w-0 w-full text-left rounded-2xl border border-dashed border-white/10 bg-zinc-900/20 p-4 hover:border-white/20 hover:bg-zinc-900/40 transition-colors cursor-pointer"
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
                            <Card
                                key={card}
                                padding="none"
                                className="shrink-0 w-[220px] sm:w-[256px] p-4"
                            >
                                <div className="w-11 h-14 rounded-lg bg-zinc-800/70 animate-pulse" />
                                <div className="mt-3 h-3 w-5/6 rounded bg-zinc-800/70 animate-pulse" />
                                <div className="mt-2 h-3 w-2/3 rounded bg-zinc-800/50 animate-pulse" />
                                <div className="mt-4 h-3 w-1/2 rounded bg-zinc-800/40 animate-pulse" />
                            </Card>
                        ))}
                    </div>
                </div>
            ))}
        </div>
    );
}

export function BooksSection({
    onOpenBook,
    onOpenSeries,
    onOpenImportedBook,
    onRequestLogin,
    isGuest,
    importSeed,
    onImportSeedConsumed,
}: BooksSectionProps) {
    const { t, formatNumber } = useI18n();
    const [data, setData] = useState<BooksIndex | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [retryToken, setRetryToken] = useState(0);
    // The article reader hands the link over by navigating to this page, so the
    // section remounts with the seed already present (no effect-setState loop).
    const [importOpen, setImportOpen] = useState(() => Boolean(importSeed));
    const [initialImportUrl, setInitialImportUrl] = useState(() => importSeed?.url ?? '');
    const [importedToken, setImportedToken] = useState(0);

    useEffect(() => {
        if (!importSeed) return;
        onImportSeedConsumed?.();
    }, [importSeed, onImportSeedConsumed]);

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
        <ShelfSection
            icon={BookMarked}
            title={t('books.title')}
            hint={t('books.subtitle')}
            testId="books-section"
            actions={(
                <>
                    <Badge tone="neutral">{t('books.badge')}</Badge>
                    {data && (
                        <span className="text-[11px] text-fg-muted tabular-nums">
                            {t('books.counts', {
                                series: formatNumber(data.counts.series),
                                books: formatNumber(data.counts.availableBooks),
                                translated: formatNumber(data.counts.translatedChapters),
                            })}
                        </span>
                    )}
                    <button
                        type="button"
                        data-testid="book-import-open"
                        onClick={() => {
                            if (isGuest) {
                                onRequestLogin();
                                return;
                            }
                            setImportOpen(true);
                        }}
                        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-brand/20 bg-brand/10 px-2.5 text-xs font-medium text-brand-300 transition-colors hover:bg-brand/15 hover:text-brand-400"
                    >
                        <BookPlus className="h-3.5 w-3.5" />
                        {t('importedBooks.importButton')}
                    </button>
                </>
            )}
        >
            {isGuest && (
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500">
                    {t('importedBooks.guestHint')}
                </p>
            )}

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

                {!isGuest && (
                    <div className="border-t border-white/5 pt-5">
                        <ImportedBooksShelf
                            refreshToken={importedToken}
                            onOpenBook={onOpenImportedBook}
                        />
                    </div>
                )}
            </div>

            <BookImportDialog
                open={importOpen}
                initialUrl={initialImportUrl}
                onClose={() => {
                    setImportOpen(false);
                    setInitialImportUrl('');
                }}
                onImported={(bookId) => {
                    setImportOpen(false);
                    setInitialImportUrl('');
                    setImportedToken((value) => value + 1);
                    onOpenImportedBook(bookId);
                }}
                onRequestLogin={onRequestLogin}
            />
        </ShelfSection>
    );
}
