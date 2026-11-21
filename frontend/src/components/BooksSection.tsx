// Content page "public-domain books" block (series launch: Oz / Peter Rabbit / Alice).
//
// Renders one group per series; each group shows the currently readable books
// plus a "more coming" tile. The backend stores only metadata + Chinese
// translations; opening a book goes to the dedicated reader route, which
// fetches the English source from Project Gutenberg per chapter.
import { useEffect, useState } from 'react';
import {
    AlertCircle,
    BookMarked,
    BookPlus,
    Loader2,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { bookCoverUrl, fetchBooksIndex, type BookSeries, type BooksIndex } from '../lib/books';
import { BookImportDialog } from './BookImportDialog';
import { ImportedBooksShelf } from './ImportedBooksShelf';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';
import { CollectionCard } from './ui/CollectionCard';
import { ShelfSection } from './ui/ShelfSection';

interface BooksSectionProps {
    onOpenSeries: (seriesId: string) => void;
    onOpenImportedBook: (bookId: string) => void;
    onRequestLogin: () => void;
    isGuest: boolean;
    /** A public-domain book link handed over from the article reader. */
    importSeed?: { url: string; nonce: number } | null;
    onImportSeedConsumed?: () => void;
}

function SeriesCard({
    series,
    onOpenSeries,
}: {
    series: BookSeries;
    onOpenSeries: (id: string) => void;
}) {
    const { t, formatNumber } = useI18n();
    const coverBook = series.books.find((book) => book.status === 'available') ?? series.books[0];
    const cover = coverBook ? bookCoverUrl(coverBook) : null;
    const [coverFailed, setCoverFailed] = useState(false);
    const available = series.books.filter((book) => book.status === 'available').length;

    return (
        <CollectionCard
            testId={`book-series-${series.id}`}
            ariaLabel={`${t('books.seriesLink')}: ${series.title}`}
            onClick={() => onOpenSeries(series.id)}
            visual={cover && !coverFailed ? (
                <img
                    src={cover}
                    alt=""
                    loading="lazy"
                    decoding="async"
                    referrerPolicy="no-referrer"
                    onError={() => setCoverFailed(true)}
                    className="h-full w-full object-contain p-2"
                />
            ) : (
                <BookMarked className="h-10 w-10 text-brand-300" aria-hidden="true" />
            )}
            badge={<Badge tone="success">{t('books.badgeShort')}</Badge>}
            title={series.title}
            subtitle={series.author}
            meta={(
                <>
                    <span className="tabular-nums">
                        {t('books.seriesTotal', { count: formatNumber(series.totalBooks) })}
                        {' · '}
                        {t('books.availableCount', { count: formatNumber(available) })}
                    </span>
                    <span className="tabular-nums">
                        {series.translatedChapters > 0
                            ? t('books.translatedCount', { count: formatNumber(series.translatedChapters) })
                            : t('books.originalReadable')}
                    </span>
                </>
            )}
        />
    );
}

function Skeleton() {
    return (
        <div className="space-y-5" aria-hidden="true">
            {[0, 1, 2].map((group) => (
                <div key={group}>
                    <div className="h-4 w-36 rounded bg-zinc-800/70 animate-pulse" />
                    <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {[0, 1, 2].map((card) => (
                            <Card key={card} padding="none" className="p-3.5">
                                <div className="aspect-[16/10] rounded-lg bg-zinc-800/70 animate-pulse" />
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

                {!loading && !failed && data && data.series.length > 0 && (
                    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {data.series.map((series) => (
                            <SeriesCard
                                key={series.id}
                                series={series}
                                onOpenSeries={onOpenSeries}
                            />
                        ))}
                    </div>
                )}

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
                onImported={(bookId, options) => {
                    setImportOpen(false);
                    setInitialImportUrl('');
                    setImportedToken((value) => value + 1);
                    // A link import keeps its original "jump into the book"
                    // behavior; a local upload stays on the shelf so the new
                    // "本地" card (and its cover) is visible right away.
                    if (options?.openAfterImport) onOpenImportedBook(bookId);
                }}
                onRequestLogin={onRequestLogin}
            />
        </ShelfSection>
    );
}
