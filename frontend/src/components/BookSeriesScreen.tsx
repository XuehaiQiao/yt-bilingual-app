// Series page (`#/app/content/book-series/<seriesId>`).
//
// Shows every book in the series — including the titles that are still
// `coming_soon` — so the reader can see what repeats: the same characters and
// the same rural/Oz vocabulary come back in each volume. Available books open
// the reader; coming-soon books are visible but not clickable.
import { useEffect, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookOpen,
    CalendarDays,
    CheckCircle2,
    Globe2,
    Layers,
    Lock,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { fetchBooksIndex, type BookSeries } from '../lib/books';
import { SubHeader } from './ui/SubHeader';

interface BookSeriesScreenProps {
    seriesId: string;
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    onOpenBook: (bookId: string) => void;
}

const LevelBadge = ({ level }: { level: string }) => (
    <span className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300">
        {level}
    </span>
);

export function BookSeriesScreen({ seriesId, onClose, parentLabel, onOpenBook }: BookSeriesScreenProps) {
    const { t, formatNumber } = useI18n();
    const [series, setSeries] = useState<BookSeries | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [notFound, setNotFound] = useState(false);
    const [retryToken, setRetryToken] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        fetchBooksIndex()
            .then((payload) => {
                if (controller.signal.aborted) return;
                const found = payload.series.find((item) => item.id === seriesId);
                if (!found) setNotFound(true);
                else setSeries(found);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load book series:', error);
                setFailed(true);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [seriesId, retryToken]);

    const available = series?.books.filter((book) => book.status === 'available') ?? [];
    const comingSoon = series?.books.filter((book) => book.status === 'coming_soon') ?? [];

    return (
        <div data-testid="book-series-screen" className="h-full min-h-0 flex flex-col bg-[#09090b]">
            <SubHeader
                title={series?.title || t('books.series.title')}
                onBack={onClose}
                parentLabel={parentLabel}
                meta={series?.author}
                backTestId="book-series-back"
                titleAs="h1"
            />

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                <div className="mx-auto w-full max-w-3xl px-4 sm:px-8 py-5 sm:py-8">
                    {loading && (
                        <div data-testid="book-series-loading" className="space-y-4">
                            <div className="h-8 w-2/3 rounded bg-zinc-800/70 animate-pulse" />
                            <div className="h-4 w-full rounded bg-zinc-800/50 animate-pulse" />
                            <div className="mt-8 space-y-2">
                                {[0, 1, 2, 3].map((row) => (
                                    <div key={row} className="h-16 rounded-xl bg-zinc-900/50 animate-pulse" />
                                ))}
                            </div>
                        </div>
                    )}

                    {!loading && failed && (
                        <div
                            data-testid="book-series-error"
                            role="alert"
                            className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
                        >
                            <div className="flex items-start gap-3">
                                <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                                <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-amber-200">
                                        {t('books.series.failed')}
                                    </p>
                                    <button
                                        type="button"
                                        onClick={() => {
                                            setFailed(false);
                                            setLoading(true);
                                            setRetryToken((value) => value + 1);
                                        }}
                                        className="mt-3 inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 text-xs font-medium text-amber-200 transition-colors"
                                    >
                                        <RefreshCw className="w-3.5 h-3.5" />
                                        {t('books.retry')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    )}

                    {!loading && !failed && notFound && (
                        <div data-testid="book-series-not-found" className="py-16 text-center">
                            <Layers className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
                            <p className="text-sm font-medium text-zinc-400">{t('books.series.notFound')}</p>
                        </div>
                    )}

                    {!loading && !failed && !notFound && series && (
                        <>
                            <header>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300">
                                        <Globe2 className="w-3.5 h-3.5" />
                                        {t('books.badge')}
                                    </span>
                                    <span className="inline-flex items-center rounded-full border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                                        {series.author}
                                    </span>
                                </div>
                                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                                    <span className="inline-flex items-center gap-1.5">
                                        <BookOpen className="w-3.5 h-3.5" />
                                        {t('books.seriesTotal', { count: formatNumber(series.totalBooks) })}
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400/80" />
                                        {t('books.availableCount', { count: formatNumber(available.length) })}
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <CalendarDays className="w-3.5 h-3.5" />
                                        {t('books.series.readableChapters', {
                                            count: formatNumber(series.readableChapters),
                                        })}
                                    </span>
                                    <span className="inline-flex items-center gap-1.5">
                                        <BookOpen className="w-3.5 h-3.5" />
                                        {t('books.series.translatedChapters', {
                                            count: formatNumber(series.translatedChapters),
                                        })}
                                    </span>
                                </div>
                                <p className="mt-3 text-sm leading-relaxed text-zinc-400 break-words">
                                    {series.description}
                                </p>
                                <div className="mt-4 rounded-2xl border border-blue-500/15 bg-blue-500/[0.05] px-3.5 py-3">
                                    <p className="text-[12px] leading-relaxed text-blue-200/85">
                                        {t('books.series.vocabNote')}
                                    </p>
                                </div>
                            </header>

                            {available.length > 0 && (
                                <section className="mt-7" data-testid="book-series-available">
                                    <h2 className="text-[13px] font-semibold text-zinc-300">
                                        {t('books.series.availableNow')} · {formatNumber(available.length)}
                                    </h2>
                                    <div className="mt-2 space-y-2">
                                        {available.map((book) => (
                                            <button
                                                key={book.id}
                                                type="button"
                                                data-testid={`book-series-book-${book.id}`}
                                                onClick={() => onOpenBook(book.id)}
                                                className="w-full flex items-center gap-3 p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors text-left"
                                            >
                                                <span className="w-10 h-14 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-300 flex items-center justify-center shrink-0">
                                                    <BookOpen className="w-5 h-5" />
                                                </span>
                                                <span className="min-w-0 flex-1">
                                                    <span className="block truncate text-sm font-medium text-zinc-100">
                                                        {book.titleZh}
                                                    </span>
                                                    <span className="block truncate text-[11px] text-zinc-500">
                                                        {book.title} · {book.year}
                                                    </span>
                                                    <span className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-zinc-500">
                                                        <LevelBadge level={book.level} />
                                                        <span className="tabular-nums">
                                                            {book.translatedChapters > 0
                                                                ? t('books.translatedChapters', {
                                                                      translated: formatNumber(book.translatedChapters),
                                                                      total: formatNumber(book.totalChapters),
                                                                  })
                                                                : t('books.originalReadable')}
                                                        </span>
                                                        {book.translatedChapters > 0 && (
                                                            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300">
                                                                <CheckCircle2 className="w-3 h-3" />
                                                                {t('books.badgeTranslated')}
                                                            </span>
                                                        )}
                                                    </span>
                                                </span>
                                                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 shrink-0">
                                                    {t('books.series.open')}
                                                    <ArrowRight className="w-3.5 h-3.5" />
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {comingSoon.length > 0 && (
                                <section className="mt-7" data-testid="book-series-coming-soon">
                                    <h2 className="text-[13px] font-semibold text-zinc-300">
                                        {t('books.series.comingSoon')} · {formatNumber(comingSoon.length)}
                                    </h2>
                                    <div className="mt-2 divide-y divide-white/5 rounded-2xl border border-white/5 bg-zinc-900/30 px-4">
                                        {comingSoon.map((book) => (
                                            <div
                                                key={book.id}
                                                data-testid={`book-series-soon-${book.id}`}
                                                className="flex items-center gap-3 py-3"
                                            >
                                                <span className="w-8 h-10 rounded-md bg-zinc-800/60 border border-white/5 text-zinc-500 flex items-center justify-center shrink-0">
                                                    <BookOpen className="w-4 h-4" />
                                                </span>
                                                <div className="min-w-0 flex-1">
                                                    <p className="truncate text-[13px] font-medium text-zinc-300">
                                                        {book.titleZh}
                                                    </p>
                                                    <p className="truncate text-[11px] text-zinc-500">
                                                        {book.title} · {book.year}
                                                    </p>
                                                    {book.contentNote && (
                                                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                                                            {book.contentNote}
                                                        </p>
                                                    )}
                                                </div>
                                                <span className="shrink-0 rounded-full border border-white/5 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-medium text-zinc-500">
                                                    {t('books.comingSoon')}
                                                </span>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            {series.excluded.length > 0 && (
                                <section className="mt-8" data-testid="book-series-excluded">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <Lock className="w-3.5 h-3.5 text-amber-400/80" />
                                        <h2 className="text-[13px] font-semibold text-zinc-300">
                                            {t('books.series.excludedTitle')} · {formatNumber(series.excluded.length)}
                                        </h2>
                                    </div>
                                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                                        {t('books.series.excludedHint')}
                                    </p>
                                    <div className="mt-2 divide-y divide-white/5 rounded-2xl border border-amber-500/15 bg-amber-500/[0.04] px-4">
                                        {series.excluded.map((item) => (
                                            <div key={`${item.title}-${item.year}`} className="py-3">
                                                <div className="flex flex-wrap items-baseline justify-between gap-2">
                                                    <p className="text-[13px] font-medium text-zinc-300">
                                                        {item.title}
                                                    </p>
                                                    <span className="flex items-center gap-2">
                                                        <span
                                                            className={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${
                                                                item.reason.includes('版权未到期') || item.reason.includes('保护期')
                                                                    ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                                                                    : 'border-white/10 bg-zinc-800/60 text-zinc-400'
                                                            }`}
                                                        >
                                                            {item.reason.includes('版权未到期') || item.reason.includes('保护期')
                                                                ? t('books.copyrightNotExpired')
                                                                : t('books.outOfScope')}
                                                        </span>
                                                        <span className="text-[11px] tabular-nums text-zinc-500">
                                                            {item.year}
                                                        </span>
                                                    </span>
                                                </div>
                                                <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">
                                                    {item.reason}
                                                </p>
                                            </div>
                                        ))}
                                    </div>
                                </section>
                            )}

                            <p className="mt-6 text-[11px] leading-relaxed text-zinc-600">
                                {t('books.originalNote')}
                            </p>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
