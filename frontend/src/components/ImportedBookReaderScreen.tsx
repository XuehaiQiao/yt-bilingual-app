// Reader for an imported public-domain book (`#/content/imported-book/<id>`).
//
// Chapter list + reading pane. The English source is refetched from the
// public-domain site on every chapter open (never stored). AI translation is
// manual per chapter: the button only appears when no complete translation is
// cached, shows the daily AI quota hint, and never runs automatically.
// Reading progress (chapter + paragraph) is saved in localStorage.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    AlertCircle,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    Globe2,
    Languages,
    Loader2,
    RefreshCw,
    Sparkles,
    Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { ReadingHighlight, ReadingHighlightToggle } from './ReadingHighlight';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { BilingualRow, bilingualReadingWidth } from './BilingualRow';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { SubHeader } from './ui/SubHeader';
import {
    deleteImportedBook,
    fetchImportedBook,
    fetchImportedChapter,
    getImportedBookProgress,
    saveImportedBookProgress,
    translateImportedChapter,
    ImportedBooksApiError,
    type ImportedBookDetail,
    type ImportedChapter,
} from '../lib/importedBooks';

interface ImportedBookReaderScreenProps {
    bookId: string;
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    onWordLookup: (
        word: string,
        context: string,
        start: number,
        e: React.MouseEvent,
        source?: { id: string; title?: string },
    ) => void;
    onRequestLogin: () => void;
}

const errorKey = (status: number, fallback: TranslationKey): TranslationKey => {
    if (status === 0) return 'importedBooks.reader.network';
    if (status === 401) return 'importedBooks.reader.loginRequired';
    if (status === 404) return 'importedBooks.reader.notFound';
    return fallback;
};

const ErrorPanel = ({
    message,
    onRetry,
    retryLabel,
    testId,
}: {
    message: string;
    onRetry: () => void;
    retryLabel: string;
    testId: string;
}) => (
    <div
        data-testid={testId}
        role="alert"
        className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
    >
        <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
            <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-medium text-amber-200">{message}</p>
                <button
                    type="button"
                    onClick={onRetry}
                    className="mt-3 inline-flex h-8 items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-500/15"
                >
                    <RefreshCw className="h-3.5 w-3.5" />
                    {retryLabel}
                </button>
            </div>
        </div>
    </div>
);

const SourceBadge = ({ sourceType }: { sourceType: string }) => {
    const { t } = useI18n();
    return (
        <span
            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                sourceType === 'gutenberg'
                    ? 'border-blue-500/20 bg-blue-500/10 text-blue-300'
                    : 'border-violet-500/20 bg-violet-500/10 text-violet-300'
            }`}
        >
            <Globe2 className="h-3.5 w-3.5" />
            {sourceType === 'gutenberg'
                ? t('importedBooks.sourceGutenberg')
                : t('importedBooks.sourceStandardEbooks')}
        </span>
    );
};

export function ImportedBookReaderScreen({
    bookId,
    onClose,
    parentLabel,
    onWordLookup,
    onRequestLogin,
}: ImportedBookReaderScreenProps) {
    const { t, formatNumber } = useI18n();
    const [detail, setDetail] = useState<ImportedBookDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(true);
    const [detailError, setDetailError] = useState<TranslationKey | null>(null);
    const [detailRetry, setDetailRetry] = useState(0);
    const [chapterNumber, setChapterNumber] = useState<number | null>(null);
    const [chapter, setChapter] = useState<ImportedChapter | null>(null);
    const [chapterLoading, setChapterLoading] = useState(false);
    const [chapterError, setChapterError] = useState<TranslationKey | null>(null);
    const [chapterRetry, setChapterRetry] = useState(0);
    const [showTranslations, setShowTranslations] = useState(true);
    const [translating, setTranslating] = useState(false);
    const [translateError, setTranslateError] = useState<string | null>(null);
    const [translateNotice, setTranslateNotice] = useState<TranslationKey | null>(null);
    // Reading difficulty marks, shared with the article/public-domain readers.
    const highlight = useReadingHighlights(
        chapter ? chapter.paragraphs.map((paragraph) => paragraph.en) : [],
    );
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const saveTimerRef = useRef<number | null>(null);
    const pendingScrollRef = useRef<number | null>(null);
    const chapterNumberRef = useRef<number | null>(null);
    const detailRef = useRef<ImportedBookDetail | null>(null);

    useEffect(() => {
        chapterNumberRef.current = chapterNumber;
    }, [chapterNumber]);
    useEffect(() => {
        detailRef.current = detail;
    }, [detail]);

    // Book metadata + chapter index.
    useEffect(() => {
        const controller = new AbortController();
        setDetailLoading(true);
        fetchImportedBook(bookId, controller.signal)
            .then((payload) => {
                if (controller.signal.aborted) return;
                setDetail(payload);
                setDetailError(null);
                const saved = getImportedBookProgress(bookId);
                const first = payload.chapters[0]?.n ?? null;
                const wanted =
                    saved && payload.chapters.some((item) => item.n === saved.chapter)
                        ? saved.chapter
                        : first;
                setChapterNumber(wanted);
                setChapterLoading(wanted !== null);
                if (saved && wanted === saved.chapter) {
                    pendingScrollRef.current = saved.paragraph;
                }
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load imported book:', error);
                setDetailError(
                    errorKey(
                        error instanceof ImportedBooksApiError ? error.status : -1,
                        'importedBooks.reader.bookFailed',
                    ),
                );
            })
            .finally(() => {
                if (!controller.signal.aborted) setDetailLoading(false);
            });
        return () => controller.abort();
    }, [bookId, detailRetry]);

    // Chapter text: refetched from the public-domain source each time.
    useEffect(() => {
        if (chapterNumber === null) return;
        const controller = new AbortController();
        fetchImportedChapter(bookId, chapterNumber, controller.signal)
            .then((payload) => {
                if (controller.signal.aborted) return;
                setChapter(payload);
                setChapterError(null);
                saveImportedBookProgress(bookId, chapterNumber, pendingScrollRef.current ?? 0);
                setDetail((previous) =>
                    previous
                        ? {
                              ...previous,
                              translatedChapters: payload.translatedChapters,
                              chapters: previous.chapters.map((entry) =>
                                  entry.n === payload.chapter
                                      ? {
                                            ...entry,
                                            translated: payload.translated,
                                            translatedParagraphs: payload.paragraphs.filter(
                                                (paragraph) => paragraph.zh,
                                            ).length,
                                        }
                                      : entry,
                              ),
                          }
                        : previous,
                );
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load imported book chapter:', error);
                setChapterError(
                    errorKey(
                        error instanceof ImportedBooksApiError ? error.status : -1,
                        'importedBooks.reader.sourceFailed',
                    ),
                );
            })
            .finally(() => {
                if (!controller.signal.aborted) setChapterLoading(false);
            });
        return () => controller.abort();
    }, [bookId, chapterNumber, chapterRetry]);

    // Restore the saved paragraph after the chapter paints.
    useEffect(() => {
        if (!chapter) return;
        const target = pendingScrollRef.current;
        pendingScrollRef.current = null;
        if (target === null || target <= 0) return;
        const frame = window.requestAnimationFrame(() => {
            const container = scrollRef.current;
            if (!container) return;
            const node = container.querySelector<HTMLElement>(
                `[data-imported-paragraph="${target}"]`,
            );
            if (!node) return;
            const nodeTop =
                node.getBoundingClientRect().top -
                container.getBoundingClientRect().top +
                container.scrollTop;
            container.scrollTop = Math.max(0, nodeTop - 24);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [chapter]);

    const saveVisibleParagraph = useCallback(() => {
        const container = scrollRef.current;
        const currentChapter = chapterNumberRef.current;
        const currentDetail = detailRef.current;
        if (!container || currentChapter === null || !currentDetail) return;
        const nodes = Array.from(
            container.querySelectorAll<HTMLElement>('[data-imported-paragraph]'),
        );
        if (nodes.length === 0) return;
        const containerTop = container.getBoundingClientRect().top;
        const top = container.scrollTop + 80;
        let visible = 0;
        for (const node of nodes) {
            const nodeTop =
                node.getBoundingClientRect().top - containerTop + container.scrollTop;
            if (nodeTop <= top) visible = Number(node.dataset.importedParagraph ?? 0);
            else break;
        }
        saveImportedBookProgress(bookId, currentChapter, visible);
    }, [bookId]);

    const handleScroll = useCallback(() => {
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            saveVisibleParagraph();
        }, 600);
    }, [saveVisibleParagraph]);

    useEffect(
        () => () => {
            if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
        },
        [],
    );

    const chapters = detail?.chapters ?? [];
    const currentIndex =
        chapterNumber === null
            ? -1
            : chapters.findIndex((item) => item.n === chapterNumber);
    const previousChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
    const nextChapter =
        currentIndex >= 0 && currentIndex < chapters.length - 1
            ? chapters[currentIndex + 1]
            : null;

    const goChapter = (n: number) => {
        if (n === chapterNumber) return;
        pendingScrollRef.current = 0;
        scrollRef.current?.scrollTo({ top: 0 });
        setChapter(null);
        setChapterError(null);
        setTranslateError(null);
        setTranslateNotice(null);
        setChapterLoading(true);
        setChapterNumber(n);
    };

    const retryDetail = () => {
        setDetailError(null);
        setDetailLoading(true);
        setDetail(null);
        setChapter(null);
        setChapterLoading(false);
        setDetailRetry((value) => value + 1);
    };

    const retryChapter = () => {
        setChapterError(null);
        setChapter(null);
        setChapterLoading(true);
        setChapterRetry((value) => value + 1);
    };

    const handleTranslate = async () => {
        if (!chapter || translating) return;
        setTranslating(true);
        setTranslateError(null);
        setTranslateNotice(null);
        try {
            const result = await translateImportedChapter(bookId, chapter.chapter);
            setTranslateNotice(
                result.status === 'partial'
                    ? 'importedBooks.reader.translatePartial'
                    : 'importedBooks.reader.translateDone',
            );
            setShowTranslations(true);
            setChapterLoading(true);
            setChapterRetry((value) => value + 1);
        } catch (error) {
            if (error instanceof ImportedBooksApiError && error.status === 401) {
                onRequestLogin();
                return;
            }
            if (error instanceof ImportedBooksApiError && error.status === 429) {
                setTranslateError(error.detail);
                return;
            }
            console.error('Failed to translate imported chapter:', error);
            setTranslateError(t('importedBooks.reader.translateFailed'));
        } finally {
            setTranslating(false);
        }
    };

    const handleDelete = async () => {
        if (!detail || deleting) return;
        setDeleting(true);
        setDeleteError(null);
        try {
            await deleteImportedBook(bookId);
            onClose();
        } catch (error) {
            if (error instanceof ImportedBooksApiError && error.status === 404) {
                onClose();
                return;
            }
            console.error('Failed to delete imported book:', error);
            setDeleteError(t('importedBooks.reader.deleteFailed'));
            throw error;
        } finally {
            setDeleting(false);
        }
    };

    const quota = chapter?.quota ?? detail?.quota;
    const translatedParagraphs =
        chapter?.paragraphs.filter((paragraph) => Boolean(paragraph.zh)).length ?? 0;
    const showPendingTranslation = Boolean(chapter && !chapter.translated);
    // 双语两栏只在确实有译文可显示时启用；一章完全没译文时英文占满整行。
    const bilingualColumns = showTranslations && translatedParagraphs > 0;

    return (
        <div data-testid="imported-book-reader" className="flex h-full min-h-0 flex-col bg-[#09090b]">
            <SubHeader
                title={detail?.title || t('importedBooks.reader.loadingBook')}
                onBack={onClose}
                parentLabel={parentLabel}
                meta={detail ? (detail.author || t('importedBooks.unknownAuthor')) : undefined}
                backTestId="imported-book-reader-back"
                titleAs="p"
                actions={detail && (
                    <button
                        type="button"
                        data-testid="imported-book-delete"
                        onClick={() => {
                            setDeleteError(null);
                            setDeleteConfirmOpen(true);
                        }}
                        disabled={deleting}
                        aria-label={t('importedBooks.reader.delete')}
                        title={t('importedBooks.reader.delete')}
                        className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-control px-2 text-xs font-medium text-fg-muted transition-colors hover:bg-danger/10 hover:text-danger-fg disabled:opacity-40"
                    >
                        {deleting ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                        )}
                        <span className="hidden sm:inline">{t('importedBooks.reader.delete')}</span>
                    </button>
                )}
            />

            <div
                ref={scrollRef}
                data-testid="imported-book-reader-scroll"
                onScroll={handleScroll}
                className="min-h-0 flex-1 overflow-x-hidden overflow-y-auto custom-scrollbar"
            >
                <div className={`mx-auto w-full px-4 py-5 sm:px-8 sm:py-8 ${bilingualReadingWidth(bilingualColumns)}`}>
                    {detailLoading && (
                        <div data-testid="imported-book-loading" className="space-y-4">
                            <div className="h-8 w-2/3 animate-pulse rounded bg-zinc-800/70" />
                            <div className="h-4 w-1/2 animate-pulse rounded bg-zinc-800/50" />
                            <div className="mt-8 space-y-3">
                                {[0, 1, 2, 3].map((row) => (
                                    <div
                                        key={row}
                                        className="h-4 w-full animate-pulse rounded bg-zinc-800/40"
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {!detailLoading && detailError && (
                        <ErrorPanel
                            testId="imported-book-error"
                            message={t(detailError)}
                            onRetry={retryDetail}
                            retryLabel={t('importedBooks.reader.retry')}
                        />
                    )}

                    {!detailLoading && !detailError && detail && (
                        <>
                            <header>
                                <div className="flex flex-wrap items-center gap-2">
                                    <SourceBadge sourceType={detail.sourceType} />
                                    <span className="inline-flex items-center rounded-full border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                                        {t('importedBooks.dialog.chapterCount', {
                                            count: formatNumber(detail.chapterCount),
                                        })}
                                    </span>
                                    <span className="text-[11px] tabular-nums text-zinc-500">
                                        {t('importedBooks.reader.translatedChapters', {
                                            translated: formatNumber(detail.translatedChapters),
                                            total: formatNumber(detail.chapterCount),
                                        })}
                                    </span>
                                </div>
                                <h1
                                    data-testid="imported-book-title"
                                    className="mt-3 break-words text-2xl font-semibold tracking-tight text-zinc-100 sm:text-3xl"
                                >
                                    {detail.title}
                                </h1>
                                {detail.author && (
                                    <p className="mt-1 break-words text-sm text-zinc-400">
                                        {detail.author}
                                    </p>
                                )}
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                                    <span>
                                        {t('importedBooks.reader.source', {
                                            source: detail.source.provider,
                                        })}
                                    </span>
                                    <span className="inline-flex items-center gap-1 text-[11px] text-zinc-600">
                                        <BookOpen className="h-3.5 w-3.5" />
                                        {t('importedBooks.reader.originalHint')}
                                    </span>
                                </div>
                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <a
                                        href={detail.sourceUrl}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        data-testid="imported-book-source-link"
                                        className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-100"
                                    >
                                        <ExternalLink className="h-3.5 w-3.5" />
                                        {t('importedBooks.reader.sourceLink')}
                                    </a>
                                </div>
                                {deleteError && (
                                    <p
                                        data-testid="imported-book-delete-error"
                                        role="alert"
                                        className="mt-2 text-[12px] text-red-300"
                                    >
                                        {deleteError}
                                    </p>
                                )}
                            </header>

                            <section className="mt-6" aria-label={t('importedBooks.reader.chapters')}>
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                    <h2 className="text-[13px] font-semibold text-zinc-300">
                                        {t('importedBooks.reader.chapters')}
                                    </h2>
                                    <div className="flex items-center gap-1.5">
                                        <button
                                            type="button"
                                            data-testid="imported-book-prev-chapter"
                                            onClick={() =>
                                                previousChapter && goChapter(previousChapter.n)
                                            }
                                            disabled={!previousChapter}
                                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/5 bg-zinc-800/60 px-2 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <ChevronLeft className="h-3.5 w-3.5" />
                                            {t('importedBooks.reader.prev')}
                                        </button>
                                        <button
                                            type="button"
                                            data-testid="imported-book-next-chapter"
                                            onClick={() => nextChapter && goChapter(nextChapter.n)}
                                            disabled={!nextChapter}
                                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-white/5 bg-zinc-800/60 px-2 text-[11px] font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            {t('importedBooks.reader.next')}
                                            <ChevronRight className="h-3.5 w-3.5" />
                                        </button>
                                    </div>
                                </div>
                                <div className="mt-2 -mx-4 overflow-x-auto px-4 custom-scrollbar sm:mx-0 sm:px-0">
                                    <div className="flex snap-x snap-mandatory gap-1.5 pb-1">
                                        {chapters.map((item) => (
                                            <button
                                                key={item.n}
                                                type="button"
                                                data-testid={`imported-book-chapter-${item.n}`}
                                                onClick={() => goChapter(item.n)}
                                                aria-current={
                                                    item.n === chapterNumber ? 'page' : undefined
                                                }
                                                className={`shrink-0 snap-start rounded-lg border px-3 py-1.5 text-left transition-colors ${
                                                    item.n === chapterNumber
                                                        ? 'border-blue-500/30 bg-blue-500/10 text-blue-200'
                                                        : 'border-white/5 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
                                                }`}
                                            >
                                                <span className="flex items-center gap-1 text-[10px] tabular-nums opacity-70">
                                                    {t('importedBooks.reader.chapter', {
                                                        n: formatNumber(item.n),
                                                    })}
                                                    <span
                                                        className={`inline-flex h-1.5 w-1.5 rounded-full ${
                                                            item.translated
                                                                ? 'bg-emerald-400'
                                                                : 'bg-zinc-600'
                                                        }`}
                                                    />
                                                </span>
                                                <span className="block max-w-[150px] truncate text-[12px] font-medium">
                                                    {item.title}
                                                </span>
                                            </button>
                                        ))}
                                    </div>
                                </div>
                            </section>

                            <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-white/5 bg-zinc-900/40 px-3 py-2">
                                <span className="inline-flex shrink-0 items-center gap-1.5 text-xs font-medium text-zinc-400">
                                    <Languages className="h-4 w-4" />
                                    {t('importedBooks.reader.translation')}
                                </span>
                                <div
                                    role="group"
                                    aria-label={t('importedBooks.reader.translation')}
                                    data-testid="imported-book-translation-toggle"
                                    className="inline-flex shrink-0 items-center rounded-lg border border-white/5 bg-zinc-800/80 p-0.5"
                                >
                                    <button
                                        type="button"
                                        data-testid="imported-book-translation-all"
                                        aria-pressed={showTranslations}
                                        onClick={() => setShowTranslations(true)}
                                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                            showTranslations
                                                ? 'bg-zinc-100 text-zinc-900'
                                                : 'text-zinc-400 hover:text-zinc-200'
                                        }`}
                                    >
                                        {t('importedBooks.reader.translationAll')}
                                    </button>
                                    <button
                                        type="button"
                                        data-testid="imported-book-translation-hidden"
                                        aria-pressed={!showTranslations}
                                        onClick={() => setShowTranslations(false)}
                                        className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                            !showTranslations
                                                ? 'bg-zinc-100 text-zinc-900'
                                                : 'text-zinc-400 hover:text-zinc-200'
                                        }`}
                                    >
                                        {t('importedBooks.reader.translationHidden')}
                                    </button>
                                </div>
                                <ReadingHighlightToggle
                                    testId="imported-book-highlight-toggle"
                                    enabled={highlight.enabled}
                                    onChange={highlight.setEnabled}
                                    levelLabel={highlight.levelLabel}
                                />
                                <span className="min-w-0 flex-1 basis-full text-[11px] leading-relaxed text-zinc-600 sm:basis-0">
                                    {t('importedBooks.reader.translateHint')}
                                </span>
                            </div>

                            {quota && (
                                <p
                                    data-testid="imported-book-quota"
                                    className="mt-2 text-[11px] text-zinc-600"
                                >
                                    {t('importedBooks.reader.quotaHint', {
                                        limit: formatNumber(quota.limitPerDay),
                                    })}
                                    {quota.remainingToday !== null
                                        ? ` · ${t('importedBooks.reader.quotaRemaining', {
                                              count: formatNumber(quota.remainingToday),
                                          })}`
                                        : ''}
                                </p>
                            )}

                            {chapterLoading && (
                                <div
                                    data-testid="imported-book-chapter-loading"
                                    className="mt-6 space-y-4"
                                >
                                    <div className="flex items-center gap-2 text-xs text-zinc-500">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                        {t('importedBooks.reader.loading')}
                                    </div>
                                    {[0, 1, 2, 3].map((row) => (
                                        <div key={row} className="space-y-2">
                                            <div className="h-4 w-full animate-pulse rounded bg-zinc-800/40" />
                                            <div className="h-3 w-2/3 animate-pulse rounded bg-zinc-800/30" />
                                        </div>
                                    ))}
                                </div>
                            )}

                            {!chapterLoading && chapterError && (
                                <div className="mt-6">
                                    <ErrorPanel
                                        testId="imported-book-chapter-error"
                                        message={t(chapterError)}
                                        onRetry={retryChapter}
                                        retryLabel={t('importedBooks.reader.retry')}
                                    />
                                </div>
                            )}

                            {!chapterLoading && !chapterError && showPendingTranslation && (
                                <div
                                    data-testid="imported-book-translation-pending"
                                    className="mt-5 rounded-2xl border border-blue-500/20 bg-blue-500/[0.06] px-3.5 py-3"
                                >
                                    <div className="flex flex-wrap items-center justify-between gap-3">
                                        <div className="min-w-0">
                                            <p className="flex items-center gap-2 text-[12px] font-medium text-blue-200">
                                                <Sparkles className="h-3.5 w-3.5" />
                                                {t('importedBooks.reader.translatePending')}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-relaxed text-blue-200/70">
                                                {t('importedBooks.reader.translateCost')}
                                            </p>
                                        </div>
                                        <button
                                            type="button"
                                            data-testid="imported-book-translate"
                                            onClick={() => void handleTranslate()}
                                            disabled={translating}
                                            className="inline-flex h-9 shrink-0 items-center gap-2 rounded-lg bg-blue-500 px-3.5 text-[13px] font-semibold text-white transition-colors hover:bg-blue-400 disabled:cursor-not-allowed disabled:bg-blue-500/40"
                                        >
                                            {translating ? (
                                                <Loader2 className="h-4 w-4 animate-spin" />
                                            ) : (
                                                <Sparkles className="h-4 w-4" />
                                            )}
                                            {translating
                                                ? t('importedBooks.reader.translating')
                                                : t('importedBooks.reader.translate')}
                                        </button>
                                    </div>
                                    {translateError && (
                                        <p
                                            data-testid="imported-book-translate-error"
                                            role="alert"
                                            className="mt-2 break-words text-[12px] text-amber-200"
                                        >
                                            {translateError}
                                        </p>
                                    )}
                                </div>
                            )}

                            {!chapterLoading && !chapterError && chapter && (
                                <article className="mt-5">
                                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                                        <h2 className="break-words text-xl font-semibold tracking-tight text-zinc-100">
                                            {chapter.chapterTitle}
                                        </h2>
                                        <span className="text-[11px] text-zinc-500">
                                            {t('importedBooks.reader.sourceTitle', {
                                                title: chapter.chapterTitle,
                                            })}
                                        </span>
                                    </div>
                                    <p className="mt-1 text-[11px] text-zinc-500">
                                        {chapter.source.degraded
                                            ? t('importedBooks.reader.sourceDegraded')
                                            : t('importedBooks.reader.sourceLive')}
                                    </p>

                                    {translateNotice && (
                                        <p
                                            data-testid="imported-book-translate-notice"
                                            className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-[12px] text-emerald-200"
                                        >
                                            {t(translateNotice)}
                                        </p>
                                    )}

                                    {chapter.paragraphs.map((paragraph) => (
                                        <div
                                            key={paragraph.index}
                                            data-imported-paragraph={paragraph.index}
                                            data-testid={`imported-book-paragraph-${paragraph.index}`}
                                            className="-mx-2 mt-4 rounded-xl border border-transparent px-2 py-1 transition-colors hover:border-white/5 hover:bg-zinc-900/30"
                                        >
                                            <BilingualRow
                                                twoColumn={bilingualColumns}
                                                testId={`imported-book-row-${paragraph.index}`}
                                                english={(
                                                    <p
                                                        data-testid={`imported-book-en-${paragraph.index}`}
                                                        data-lookup-context={paragraph.en}
                                                        data-lookup-start={paragraph.index}
                                                        lang="en"
                                                        className="break-words text-base leading-relaxed text-zinc-200"
                                                    >
                                                        <ReadingHighlight
                                                            text={paragraph.en}
                                                            isHighlighted={highlight.isHighlighted}
                                                            onWordClick={(word, event) =>
                                                                onWordLookup(
                                                                    word,
                                                                    paragraph.en,
                                                                    paragraph.index,
                                                                    event,
                                                                    { id: bookId, title: detail?.title },
                                                                )
                                                            }
                                                        />
                                                    </p>
                                                )}
                                                translation={
                                                    showTranslations && paragraph.zh
                                                        ? (
                                                            <p
                                                                data-testid={`imported-book-translation-${paragraph.index}`}
                                                                lang="zh-CN"
                                                                className="break-words text-[15px] leading-relaxed text-zinc-400"
                                                            >
                                                                {paragraph.zh}
                                                            </p>
                                                        )
                                                        : showTranslations && translatedParagraphs > 0
                                                            ? (
                                                                <p
                                                                    data-testid={`imported-book-translation-missing-${paragraph.index}`}
                                                                    className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/15 bg-amber-500/[0.06] px-2 py-0.5 text-[11px] text-amber-300/90"
                                                                >
                                                                    <AlertCircle className="h-3 w-3" />
                                                                    {t('importedBooks.reader.missingTranslation')}
                                                                </p>
                                                            )
                                                            : undefined
                                                }
                                            />
                                        </div>
                                    ))}

                                    <div className="mt-6 flex items-center justify-between gap-2 border-t border-white/5 pt-4">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                previousChapter && goChapter(previousChapter.n)
                                            }
                                            disabled={!previousChapter}
                                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/5 bg-zinc-800/60 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            <ChevronLeft className="h-4 w-4" />
                                            {t('importedBooks.reader.prev')}
                                        </button>
                                        <span className="text-[11px] tabular-nums text-zinc-500">
                                            {formatNumber(chapter.chapter)} /{' '}
                                            {formatNumber(chapter.chapterCount)}
                                        </span>
                                        <button
                                            type="button"
                                            onClick={() => nextChapter && goChapter(nextChapter.n)}
                                            disabled={!nextChapter}
                                            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-white/5 bg-zinc-800/60 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 disabled:cursor-not-allowed disabled:opacity-40"
                                        >
                                            {t('importedBooks.reader.next')}
                                            <ChevronRight className="h-4 w-4" />
                                        </button>
                                    </div>
                                </article>
                            )}
                        </>
                    )}
                </div>
            </div>

            <ConfirmDialog
                open={deleteConfirmOpen && detail !== null}
                title={t('importedBooks.reader.deleteConfirm', {
                    title: detail?.title ?? '',
                })}
                confirmLabel={t('importedBooks.reader.delete')}
                destructive
                onConfirm={handleDelete}
                onClose={() => {
                    setDeleteConfirmOpen(false);
                    setDeleteError(null);
                }}
                error={deleteError}
                testId="imported-book-delete-confirm"
            />
        </div>
    );
}
