// "My imported books" shelf on the content page.
//
// Sits next to the curated public-domain series. Each card shows the source
// (Gutenberg / Standard Ebooks), chapter count, cached translation count and the
// locally saved reading position. Opening one goes to the imported-book reader.
import { useEffect, useState } from 'react';
import {
    AlertCircle,
    BookOpen,
    Globe2,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    fetchImportedBooks,
    getImportedBookProgress,
    type ImportedBookSummary,
} from '../lib/importedBooks';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';

interface ImportedBooksShelfProps {
    refreshToken: number;
    onOpenBook: (bookId: string) => void;
}

export function ImportedBooksShelf({ refreshToken, onOpenBook }: ImportedBooksShelfProps) {
    const { t, formatNumber } = useI18n();
    const [books, setBooks] = useState<ImportedBookSummary[] | null>(null);
    const [failed, setFailed] = useState(false);
    const [retryToken, setRetryToken] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        fetchImportedBooks(controller.signal)
            .then((payload) => {
                if (controller.signal.aborted) return;
                setBooks(payload);
                setFailed(false);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load imported books:', error);
                setFailed(true);
            });
        return () => controller.abort();
    }, [refreshToken, retryToken]);

    const retry = () => {
        setFailed(false);
        setBooks(null);
        setRetryToken((value) => value + 1);
    };

    return (
        <div data-testid="imported-books-shelf" className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                    <h4 className="flex items-center gap-2 text-[15px] font-semibold tracking-tight text-zinc-100">
                        <Globe2 className="h-4 w-4 text-emerald-400" />
                        {t('importedBooks.title')}
                    </h4>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                        {t('importedBooks.subtitle')}
                    </p>
                </div>
            </div>

            <div className="mt-2.5 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto custom-scrollbar">
                {books === null && !failed && (
                    <div data-testid="imported-books-loading" className="flex gap-3">
                        {[0, 1].map((index) => (
                            <Card
                                key={index}
                                padding="none"
                                className="w-[220px] shrink-0 p-4 sm:w-[256px]"
                            >
                                <div className="h-4 w-16 animate-pulse rounded bg-zinc-800/70" />
                                <div className="mt-3 h-3 w-5/6 animate-pulse rounded bg-zinc-800/60" />
                                <div className="mt-2 h-3 w-2/3 animate-pulse rounded bg-zinc-800/40" />
                                <div className="mt-4 h-3 w-1/2 animate-pulse rounded bg-zinc-800/30" />
                            </Card>
                        ))}
                    </div>
                )}

                {failed && (
                    <div
                        data-testid="imported-books-failed"
                        role="alert"
                        className="flex items-start gap-3 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-4"
                    >
                        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-amber-200">
                                {t('importedBooks.failed')}
                            </p>
                            <button
                                type="button"
                                data-testid="imported-books-retry"
                                onClick={retry}
                                className="mt-2 inline-flex h-8 items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/15"
                            >
                                <RefreshCw className="h-3.5 w-3.5" />
                                {t('importedBooks.retry')}
                            </button>
                        </div>
                    </div>
                )}

                {!failed && books !== null && books.length === 0 && (
                    <p
                        data-testid="imported-books-empty"
                        className="rounded-2xl border border-dashed border-white/10 bg-zinc-900/20 px-4 py-5 text-[12px] leading-relaxed text-zinc-500"
                    >
                        {t('importedBooks.empty')}
                    </p>
                )}

                {!failed && books !== null && books.length > 0 && (
                    <div className="flex gap-3 snap-x snap-mandatory pb-1">
                        {books.map((book) => {
                            const progress = getImportedBookProgress(book.bookId);
                            return (
                                <Card
                                    key={book.bookId}
                                    variant="interactive"
                                    padding="none"
                                    testId={`imported-book-card-${book.bookId}`}
                                    ariaLabel={t('importedBooks.openBook', { title: book.title })}
                                    onClick={() => onOpenBook(book.bookId)}
                                    className="group shrink-0 w-[220px] sm:w-[256px] snap-start p-4"
                                >
                                    <div className="flex items-start justify-between gap-2">
                                        <span className="flex h-11 w-14 shrink-0 items-center justify-center rounded-lg border border-emerald-500/20 bg-emerald-500/10 text-emerald-300">
                                            <BookOpen className="h-5 w-5" />
                                        </span>
                                        <Badge tone="neutral" icon={<Globe2 />}>
                                            {book.sourceType === 'gutenberg'
                                                ? t('importedBooks.sourceGutenberg')
                                                : t('importedBooks.sourceStandardEbooks')}
                                        </Badge>
                                    </div>
                                    <h5 className="mt-3 line-clamp-2 min-h-[2.6em] break-words text-[14px] font-semibold leading-snug text-zinc-100">
                                        {book.title}
                                    </h5>
                                    <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                                        {book.author || t('importedBooks.unknownAuthor')}
                                    </p>
                                    <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                                        <span className="tabular-nums">
                                            {t('importedBooks.cardChapters', {
                                                count: formatNumber(book.chapterCount),
                                            })}
                                        </span>
                                        <span className="truncate text-emerald-400/80">
                                            {t('importedBooks.cardTranslated', {
                                                count: formatNumber(book.translatedChapters),
                                            })}
                                        </span>
                                    </div>
                                    <p className="mt-1 truncate text-[10px] text-zinc-600">
                                        {progress
                                            ? t('importedBooks.cardProgress', {
                                                  n: formatNumber(progress.chapter),
                                              })
                                            : t('importedBooks.cardNotStarted')}
                                    </p>
                                </Card>
                            );
                        })}
                    </div>
                )}
            </div>
        </div>
    );
}
