// Public-domain book reader (`#/app/content/book/<bookId>`).
//
// Two levels in one screen: the book's chapter index + series context, and the
// reading pane for one chapter. The English text is fetched from the public-
// domain source on every chapter open (never stored); the Chinese translation
// is a local build artifact. Guests can read without an account.
//
// Reading progress (chapter + paragraph) is local-only and shared by guests.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertCircle,
    ArrowRight,
    BookOpen,
    ChevronLeft,
    ChevronRight,
    ExternalLink,
    Globe2,
    Languages,
    Layers,
    Loader2,
    RefreshCw,
    Sparkles,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { ReadingHighlight, ReadingHighlightToggle } from './ReadingHighlight';
import { LanguagePointToggle } from './ui/LanguagePointToggle';
import type { InlineLanguagePoint } from './TranscriptBlock';
import { loadLanguagePointsEnabled } from '../lib/highlightLayers';
import { allowAi } from '../lib/aiGate';
import { useAuth } from '../lib/auth';
import { SubHeader } from './ui/SubHeader';
import { ReadingVocabButton } from './ReadingVocabButton';
import type { FavoriteItem } from '../lib/favorites';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { BilingualRow, bilingualReadingWidth } from './BilingualRow';
import {
    BooksApiError,
    fetchBook,
    fetchBookChapter,
    getBookProgress,
    saveBookProgress,
    translateBookChapter,
    type BookChapter,
    type BookDetail,
} from '../lib/books';

interface BookReaderScreenProps {
    bookId: string;
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    onOpenSeries: (seriesId: string) => void;
    /** M7b: generation/analysis are account-only; reading stays public. */
    onRequestLogin?: () => void;
    onWordLookup: (
        word: string,
        context: string,
        start: number,
        e: React.MouseEvent,
        source?: { id: string; title?: string },
    ) => void;
    /** App-owned favorites; the header chip shows the vocabulary count. */
    favorites: readonly FavoriteItem[];
}

const errorKey = (status: number, fallback: TranslationKey): TranslationKey => {
    if (status === 0) return 'books.reader.network';
    if (status === 404) return 'books.reader.notFound';
    return fallback;
};

// The backend's on-demand translation has documented failure semantics; map
// them onto localized reasons instead of leaking the server's Chinese detail.
const translateErrorKey = (error: unknown): TranslationKey => {
    const status = error instanceof BooksApiError ? error.status : -1;
    const code = error instanceof BooksApiError ? error.code : undefined;
    // Stable M7a/M3b codes first: these are states, not generic transport errors.
    if (code === 'login_required') return 'books.reader.loginRequired';
    if (code === 'model_unpriced') return 'errors.modelUnpriced';
    if (code === 'quota_exceeded') return 'errors.quotaExceeded';
    if (status === 402) return 'billing.insufficient.noDetails';
    switch (status) {
        case 401:
        case 403:
            // M7a: guests/expired sessions answer 403 `login_required`.
            return 'books.reader.loginRequired';
        case 400:
            return 'books.reader.translateUnsupported';
        case 404:
            return 'books.reader.notFound';
        case 413:
            return 'books.reader.translateTooLarge';
        case 429:
            return 'books.reader.translateLimit';
        case 502:
            return 'books.reader.translateFailed';
        case 503:
            return 'books.reader.translateUnavailable';
        case 504:
            return 'books.reader.translateTimeout';
        case 0:
            return 'books.reader.network';
        default:
            return 'books.reader.translateFailed';
    }
};

const SegmentedToggle = ({
    show,
    onChange,
}: {
    show: boolean;
    onChange: (next: boolean) => void;
}) => {
    const { t } = useI18n();
    return (
        <div
            role="group"
            aria-label={t('books.reader.translation')}
            data-testid="book-translation-toggle"
            className="inline-flex items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5 shrink-0"
        >
            <button
                type="button"
                data-testid="book-translation-all"
                aria-pressed={show}
                onClick={() => onChange(true)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    show ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
                }`}
            >
                {t('books.reader.translationAll')}
            </button>
            <button
                type="button"
                data-testid="book-translation-hidden"
                aria-pressed={!show}
                onClick={() => onChange(false)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors ${
                    !show ? 'bg-zinc-100 text-zinc-900' : 'text-zinc-400 hover:text-zinc-200'
                }`}
            >
                {t('books.reader.translationHidden')}
            </button>
        </div>
    );
};

const ErrorPanel = ({
    message,
    onRetry,
    retryLabel,
    testId,
    retryTestId,
}: {
    message: string;
    onRetry: () => void;
    retryLabel: string;
    testId: string;
    retryTestId?: string;
}) => (
    <div
        data-testid={testId}
        role="alert"
        className="rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
    >
        <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium text-amber-200">{message}</p>
                <button
                    type="button"
                    data-testid={retryTestId}
                    onClick={onRetry}
                    className="mt-3 inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 text-xs font-medium text-amber-200 transition-colors"
                >
                    <RefreshCw className="w-3.5 h-3.5" />
                    {retryLabel}
                </button>
            </div>
        </div>
    </div>
);

export function BookReaderScreen({
    bookId,
    onClose,
    parentLabel,
    onOpenSeries,
    onRequestLogin,
    onWordLookup,
    favorites,
}: BookReaderScreenProps) {
    const { t, language, formatNumber } = useI18n();
    const [detail, setDetail] = useState<BookDetail | null>(null);
    const [detailLoading, setDetailLoading] = useState(true);
    const [detailError, setDetailError] = useState<TranslationKey | null>(null);
    const [detailRetry, setDetailRetry] = useState(0);
    const [chapterNumber, setChapterNumber] = useState<number | null>(null);
    const [chapter, setChapter] = useState<BookChapter | null>(null);
    const { status } = useAuth();
    const canAnalyze = status === 'authenticated';
    const [chapterLoading, setChapterLoading] = useState(false);
    const [chapterError, setChapterError] = useState<TranslationKey | null>(null);
    const [chapterRetry, setChapterRetry] = useState(0);
    const [showTranslations, setShowTranslations] = useState(true);
    const [showLanguagePoints, setShowLanguagePoints] = useState<boolean>(loadLanguagePointsEnabled);
    const [translating, setTranslating] = useState(false);
    const [translateError, setTranslateError] = useState<TranslationKey | null>(null);
    const [translateNotice, setTranslateNotice] = useState<'done' | 'partial' | null>(null);
    // Reading difficulty marks, shared with the article/imported-book readers.
    const highlight = useReadingHighlights(
        chapter ? chapter.paragraphs.map((paragraph) => paragraph.en) : [],
    );
    const languagePointsByParagraph = useMemo(() => {
        const map: Record<number, InlineLanguagePoint[]> = {};
        for (const point of chapter?.languagePoints ?? []) {
            (map[point.blockId] ??= []).push({
                text: point.text,
                meaning: point.meaning,
                kind: point.kind,
            });
        }
        return map;
    }, [chapter?.languagePoints]);
    const scrollRef = useRef<HTMLDivElement>(null);
    const saveTimerRef = useRef<number | null>(null);
    const pendingScrollRef = useRef<number | null>(null);
    const chapterNumberRef = useRef<number | null>(null);
    const detailRef = useRef<BookDetail | null>(null);
    // Auto translation runs at most once per (book, chapter, language): the
    // ref survives StrictMode's double effect setup and ordinary re-renders.
    const autoTranslateRef = useRef<string | null>(null);
    const translateTokenRef = useRef(0);
    const translatingRef = useRef(false);
    // Language of the currently painted chapter: guards the auto trigger from
    // firing on a stale chapter while a language switch is refetching.
    const chapterLanguageRef = useRef(language);

    useEffect(() => {
        chapterNumberRef.current = chapterNumber;
    }, [chapterNumber]);
    useEffect(() => {
        detailRef.current = detail;
    }, [detail]);

    /**
     * Translate the current chapter's missing paragraphs (public, no login).
     *
     * Used both by the automatic first-open trigger and by the manual button
     * (failure retry / partial backfill). The response is the full chapter, so
     * the reader renders the new translation immediately without a refetch.
     */
    const runTranslation = useCallback(async () => {
        // Generate-chapter translation is an AI call (M7b): guests keep reading
        // the source / cached translation, but this button only opens login.
        if (!allowAi(!canAnalyze, onRequestLogin)) return;
        const target = chapterNumberRef.current;
        if (target === null || translatingRef.current) return;
        const token = ++translateTokenRef.current;
        translatingRef.current = true;
        setTranslating(true);
        setTranslateError(null);
        setTranslateNotice(null);
        try {
            const result = await translateBookChapter(bookId, target, language);
            // A chapter/language switch while the request was in flight: the
            // reset effect bumped the token, so this result is stale.
            if (token !== translateTokenRef.current) return;
            chapterLanguageRef.current = language;
            // The translation POST returns paragraphs without the optional
            // analysis fields; keep the glosses/language points already
            // loaded for this chapter instead of dropping the gloss layer.
            setChapter((previous) => ({
                ...result,
                languagePoints: result.languagePoints.length > 0
                    ? result.languagePoints
                    : (previous?.languagePoints ?? []),
                analysisLevel: result.analysisLevel ?? previous?.analysisLevel ?? null,
                paragraphs: result.paragraphs.map((paragraph, index) => ({
                    ...paragraph,
                    glosses: Object.keys(paragraph.glosses ?? {}).length > 0
                        ? paragraph.glosses
                        : (previous?.paragraphs[index]?.glosses ?? {}),
                })),
            }));
            setTranslateNotice(result.outcome === 'partial' ? 'partial' : 'done');
            // Analysis is intentionally skipped while the chapter is still
            // untranslated; once translation lands, fetch the enriched chapter
            // so the contextual ruby glosses can appear without a reload.
            if (canAnalyze && (showLanguagePoints || highlight.enabled)) {
                try {
                    const enriched = await fetchBookChapter(
                        bookId,
                        target,
                        language,
                        highlight.level,
                    );
                    if (token === translateTokenRef.current) setChapter(enriched);
                } catch {
                    // Enhancement only; the translated chapter remains usable.
                }
            }
        } catch (error) {
            if (token !== translateTokenRef.current) return;
            console.error('Failed to translate book chapter:', error);
            setTranslateError(
                translateErrorKey(error),
            );
        } finally {
            if (token === translateTokenRef.current) {
                translatingRef.current = false;
                setTranslating(false);
            }
        }
    }, [bookId, canAnalyze, highlight.enabled, highlight.level, language, onRequestLogin, showLanguagePoints]);

    // Switching chapter (or target language) invalidates the in-flight
    // translation and clears its transient status.
    useEffect(() => {
        translateTokenRef.current += 1;
        translatingRef.current = false;
        setTranslating(false);
        setTranslateError(null);
        setTranslateNotice(null);
    }, [bookId, chapterNumber, language, canAnalyze, showLanguagePoints, highlight.level]);

    // A language switch drops the old-language chapter before the refetch so
    // stale translations never flash under the new language.
    useEffect(() => {
        if (chapterNumber === null) return;
        setChapter(null);
        setChapterError(null);
        setChapterLoading(true);
    }, [language]); // eslint-disable-line react-hooks/exhaustive-deps

    // Book metadata + chapter index.
    useEffect(() => {
        const controller = new AbortController();
        fetchBook(bookId)
            .then((payload) => {
                if (controller.signal.aborted) return;
                setDetail(payload);
                const saved = getBookProgress(bookId);
                const first = payload.chapters[0]?.n ?? null;
                const wanted = saved && payload.chapters.some((item) => item.n === saved.chapter)
                    ? saved.chapter
                    : first;
                setChapterNumber(wanted);
                setChapterLoading(wanted !== null);
                if (saved && wanted === saved.chapter) pendingScrollRef.current = saved.paragraph;
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load book:', error);
                setDetailError(errorKey(error instanceof BooksApiError ? error.status : -1, 'books.reader.bookFailed'));
            })
            .finally(() => {
                if (!controller.signal.aborted) setDetailLoading(false);
            });
        return () => controller.abort();
    }, [bookId, detailRetry]);

    // Chapter text: refetched from the public-domain source each time. The
    // target language picks the translation column (local bundled copy or the
    // shared on-demand cache) for the current UI language.
    useEffect(() => {
        if (chapterNumber === null) return;
        const controller = new AbortController();
        fetchBookChapter(
            bookId,
            chapterNumber,
            language,
            canAnalyze && (showLanguagePoints || highlight.enabled) ? highlight.level : null,
        )
            .then((payload) => {
                if (controller.signal.aborted) return;
                chapterLanguageRef.current = language;
                setChapter(payload);
                saveBookProgress(bookId, chapterNumber, pendingScrollRef.current ?? 0);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load book chapter:', error);
                setChapterError(
                    errorKey(error instanceof BooksApiError ? error.status : -1, 'books.reader.sourceFailed'),
                );
            })
            .finally(() => {
                if (!controller.signal.aborted) setChapterLoading(false);
            });
        return () => controller.abort();
    }, [bookId, chapterNumber, chapterRetry, language, canAnalyze, showLanguagePoints, highlight.enabled, highlight.level]);

    // First open of an untranslated chapter: translate it automatically. Only
    // one automatic call per (book, chapter, language); switching chapter and
    // coming back re-evaluates, and a `cached` chapter never calls the model.
    useEffect(() => {
        if (!chapter || chapterLoading) return;
        // Never auto-translate for guests: opening a chapter is a read, not an
        // AI entry. The manual button explains the login requirement instead.
        if (!canAnalyze) return;
        if (chapterLanguageRef.current !== language) return;
        const needsTranslation = chapter.translationStatus !== 'cached'
            || chapter.missingTranslations > 0;
        if (!needsTranslation) return;
        const key = `${bookId}:${chapter.chapter}:${language}`;
        if (autoTranslateRef.current === key) return;
        autoTranslateRef.current = key;
        void runTranslation();
    }, [bookId, canAnalyze, chapter, chapterLoading, language, runTranslation]);

    // Restore the paragraph from localStorage once the chapter is painted.
    useEffect(() => {
        if (!chapter) return;
        const target = pendingScrollRef.current;
        pendingScrollRef.current = null;
        if (target === null || target <= 0) return;
        const frame = window.requestAnimationFrame(() => {
            const container = scrollRef.current;
            if (!container) return;
            const node = container.querySelector<HTMLElement>(`[data-book-paragraph="${target}"]`);
            if (!node) return;
            const nodeTop = node.getBoundingClientRect().top
                - container.getBoundingClientRect().top
                + container.scrollTop;
            container.scrollTop = Math.max(0, nodeTop - 24);
        });
        return () => window.cancelAnimationFrame(frame);
    }, [chapter]);

    const saveVisibleParagraph = useCallback(() => {
        const container = scrollRef.current;
        const currentChapter = chapterNumberRef.current;
        const currentDetail = detailRef.current;
        if (!container || currentChapter === null || !currentDetail) return;
        const nodes = Array.from(container.querySelectorAll<HTMLElement>('[data-book-paragraph]'));
        if (nodes.length === 0) return;
        const containerTop = container.getBoundingClientRect().top;
        const top = container.scrollTop + 80;
        let visible = 0;
        for (const node of nodes) {
            const nodeTop = node.getBoundingClientRect().top - containerTop + container.scrollTop;
            if (nodeTop <= top) visible = Number(node.dataset.bookParagraph ?? 0);
            else break;
        }
        saveBookProgress(bookId, currentChapter, visible);
    }, [bookId]);

    const handleScroll = useCallback(() => {
        if (saveTimerRef.current !== null) return;
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            saveVisibleParagraph();
        }, 600);
    }, [saveVisibleParagraph]);

    useEffect(() => () => {
        if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    }, []);

    const chapters = detail?.chapters ?? [];
    const currentIndex = chapterNumber === null
        ? -1
        : chapters.findIndex((item) => item.n === chapterNumber);
    const previousChapter = currentIndex > 0 ? chapters[currentIndex - 1] : null;
    const nextChapter = currentIndex >= 0 && currentIndex < chapters.length - 1
        ? chapters[currentIndex + 1]
        : null;
    const sourceUrl = detail?.catalogUrl || detail?.sourceUrl || '';
    const seriesNote = useMemo(() => t('books.series.vocabNote'), [t]);
    const translatedParagraphs = chapter?.paragraphs
        .filter((paragraph) => Boolean(paragraph.zh?.trim())).length ?? 0;
    const hasAnyTranslation = translatedParagraphs > 0;
    // `translated` only means "a bundled local translation exists"; partial
    // on-demand cache fills still need the same automatic/manual treatment.
    const needsTranslation = Boolean(chapter
        && (chapter.translationStatus !== 'cached' || chapter.missingTranslations > 0));
    // Two columns only when translated copy is actually displayed; a chapter
    // without any translation keeps the full-width English source.
    const bilingualColumns = showTranslations && hasAnyTranslation;

    const goChapter = (n: number) => {
        if (n === chapterNumber) return;
        pendingScrollRef.current = 0;
        scrollRef.current?.scrollTo({ top: 0 });
        setChapter(null);
        setChapterError(null);
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

    return (
        <div data-testid="book-reader" className="h-full min-h-0 flex flex-col bg-[#09090b]">
            <SubHeader
                title={detail?.titleZh || t('books.reader.loadingBook')}
                onBack={onClose}
                parentLabel={parentLabel}
                meta={detail ? `${detail.author} · ${detail.year}` : undefined}
                backTestId="book-reader-back"
                titleAs="p"
                actions={(
                    <>
                        <ReadingVocabButton favorites={favorites} />
                        {detail && (
                            <button
                                type="button"
                                data-testid="book-reader-series-link"
                                onClick={() => onOpenSeries(detail.seriesId)}
                                className="hidden sm:inline-flex items-center gap-1 h-9 px-2.5 rounded-control text-xs font-medium text-fg-secondary hover:text-fg-primary hover:bg-state-hover transition-colors shrink-0"
                            >
                                <Layers className="w-3.5 h-3.5" />
                                {t('books.reader.series')}
                            </button>
                        )}
                    </>
                )}
            />

            <div
                ref={scrollRef}
                data-testid="book-reader-scroll"
                onScroll={handleScroll}
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar"
            >
                <div className={`mx-auto w-full px-4 sm:px-8 py-5 sm:py-8 ${bilingualReadingWidth(bilingualColumns)}`}>
                    {detailLoading && (
                        <div data-testid="book-reader-loading" className="space-y-4">
                            <div className="h-8 w-2/3 rounded bg-zinc-800/70 animate-pulse" />
                            <div className="h-4 w-1/2 rounded bg-zinc-800/50 animate-pulse" />
                            <div className="mt-8 space-y-3">
                                {[0, 1, 2, 3].map((row) => (
                                    <div key={row} className="h-4 w-full rounded bg-zinc-800/40 animate-pulse" />
                                ))}
                            </div>
                        </div>
                    )}

                    {!detailLoading && detailError && (
                        <ErrorPanel
                            testId="book-reader-error"
                            message={t(detailError)}
                            onRetry={retryDetail}
                            retryLabel={t('books.reader.retry')}
                        />
                    )}

                    {!detailLoading && !detailError && detail && (
                        <>
                            <header>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-2.5 py-1 text-[11px] font-medium text-blue-300">
                                        <Globe2 className="w-3.5 h-3.5" />
                                        {t('books.badge')}
                                    </span>
                                    <span className="inline-flex items-center rounded-full border border-zinc-700/60 bg-zinc-800/60 px-2.5 py-1 text-[11px] font-medium text-zinc-300">
                                        {detail.level}
                                    </span>
                                    <span className="text-[11px] text-zinc-500 tabular-nums">
                                        {t('books.translatedChapters', {
                                            translated: formatNumber(detail.translatedChapters),
                                            total: formatNumber(detail.totalChapters),
                                        })}
                                    </span>
                                </div>
                                <h1
                                    data-testid="book-detail-title"
                                    className="mt-3 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100 break-words"
                                >
                                    {detail.titleZh}
                                </h1>
                                <p className="mt-1 text-sm text-zinc-400 break-words">{detail.title}</p>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                                    <span>{detail.author}</span>
                                    <span className="tabular-nums">{detail.year}</span>
                                    <span>{t('books.source', { source: detail.source })}</span>
                                    <span>{t('books.license', { license: detail.license })}</span>
                                </div>

                                <div className="mt-4 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-3">
                                    <p className="text-[12px] leading-relaxed text-amber-200/90">
                                        {t('books.contentNote', { year: detail.year })}
                                    </p>
                                </div>

                                <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        data-testid="book-series-entry"
                                        onClick={() => onOpenSeries(detail.seriesId)}
                                        className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                    >
                                        <Layers className="w-3.5 h-3.5" />
                                        {t('books.seriesLink')}
                                        <ArrowRight className="w-3.5 h-3.5" />
                                    </button>
                                    {sourceUrl && (
                                        <a
                                            href={sourceUrl}
                                            target="_blank"
                                            rel="noopener noreferrer"
                                            data-testid="book-source-link"
                                            className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg text-xs font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                        >
                                            <ExternalLink className="w-3.5 h-3.5" />
                                            {t('books.sourceLink')}
                                        </a>
                                    )}
                                </div>
                            </header>

                            {detail.status === 'coming_soon' || chapters.length === 0 ? (
                                <div className="mt-8 rounded-2xl border border-white/5 bg-zinc-900/40 p-6 text-center">
                                    <p className="text-sm font-medium text-zinc-300">
                                        {t('books.comingSoon')}
                                    </p>
                                    <p className="mt-1 text-xs text-zinc-500">
                                        {t('books.reader.comingSoonHint')}
                                    </p>
                                </div>
                            ) : (
                                <>
                                    <section className="mt-6" aria-label={t('books.reader.chapters')}>
                                        <div className="flex flex-wrap items-center justify-between gap-2">
                                            <h2 className="text-[13px] font-semibold text-zinc-300">
                                                {t('books.reader.chapters')}
                                            </h2>
                                            <div className="flex items-center gap-1.5">
                                                <button
                                                    type="button"
                                                    data-testid="book-prev-chapter"
                                                    onClick={() => previousChapter && goChapter(previousChapter.n)}
                                                    disabled={!previousChapter}
                                                    className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-[11px] font-medium text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    <ChevronLeft className="w-3.5 h-3.5" />
                                                    {t('books.reader.prev')}
                                                </button>
                                                <button
                                                    type="button"
                                                    data-testid="book-next-chapter"
                                                    onClick={() => nextChapter && goChapter(nextChapter.n)}
                                                    disabled={!nextChapter}
                                                    className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-[11px] font-medium text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    {t('books.reader.next')}
                                                    <ChevronRight className="w-3.5 h-3.5" />
                                                </button>
                                            </div>
                                        </div>
                                        <div className="mt-2 -mx-4 px-4 sm:mx-0 sm:px-0 overflow-x-auto custom-scrollbar">
                                            <div className="flex gap-1.5 snap-x snap-mandatory pb-1">
                                                {chapters.map((item) => (
                                                    <button
                                                        key={item.n}
                                                        type="button"
                                                        data-testid={`book-chapter-${item.n}`}
                                                        onClick={() => goChapter(item.n)}
                                                        aria-current={item.n === chapterNumber ? 'page' : undefined}
                                                        className={`shrink-0 snap-start rounded-lg border px-3 py-1.5 text-left transition-colors ${
                                                            item.n === chapterNumber
                                                                ? 'border-blue-500/30 bg-blue-500/10 text-blue-200'
                                                                : 'border-white/5 bg-zinc-900/40 text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
                                                        }`}
                                                    >
                                                        <span className="flex items-center gap-1 text-[10px] tabular-nums opacity-70">
                                                            {t('books.reader.chapter', { n: formatNumber(item.n) })}
                                                            {item.translated ? (
                                                                <span
                                                                    data-testid={`book-chapter-translated-${item.n}`}
                                                                    className="inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400"
                                                                />
                                                            ) : (
                                                                <span
                                                                    data-testid={`book-chapter-pending-${item.n}`}
                                                                    className="inline-flex h-1.5 w-1.5 rounded-full bg-zinc-600"
                                                                />
                                                            )}
                                                        </span>
                                                        <span className="block max-w-[150px] truncate text-[12px] font-medium">
                                                            {item.titleZh || item.title}
                                                        </span>
                                                    </button>
                                                ))}
                                            </div>
                                        </div>
                                    </section>

                                    <div className="mt-5 flex flex-wrap items-center gap-2 rounded-2xl border border-white/5 bg-zinc-900/40 px-3 py-2">
                                        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-zinc-400 shrink-0">
                                            <Languages className="w-4 h-4" />
                                            {t('books.reader.translation')}
                                        </span>
                                        <SegmentedToggle show={showTranslations} onChange={setShowTranslations} />
                                        <ReadingHighlightToggle
                                            testId="book-highlight-toggle"
                                            enabled={highlight.enabled}
                                            onChange={highlight.setEnabled}
                                            levelLabel={highlight.levelLabel}
                                        />
                                        {canAnalyze && (
                                            <LanguagePointToggle
                                                enabled={showLanguagePoints}
                                                onChange={setShowLanguagePoints}
                                                testId="book-language-points-toggle"
                                            />
                                        )}
                                        <span className={`min-w-0 text-[11px] ${
                                            translateNotice === 'done' ? 'text-emerald-400/90' : 'text-zinc-600'
                                        }`}>
                                            {translateNotice === 'done'
                                                ? t('books.reader.translateDone')
                                                : chapter && !hasAnyTranslation
                                                    ? t('books.reader.noTranslationHint')
                                                    : chapter && chapter.missingTranslations > 0
                                                        ? t('books.reader.translationPartial')
                                                        : t('books.translationHint')}
                                        </span>
                                        {chapter && needsTranslation && (
                                            <button
                                                type="button"
                                                data-testid="book-translate-chapter"
                                                onClick={() => { void runTranslation(); }}
                                                disabled={translating}
                                                className="inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-[11px] font-medium text-blue-300 transition-colors disabled:opacity-50 disabled:pointer-events-none"
                                            >
                                                {translating
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <Sparkles className="w-3.5 h-3.5" />}
                                                {translating
                                                    ? t('books.reader.translating')
                                                    : t('books.reader.translateChapter')}
                                            </button>
                                        )}
                                    </div>

                                    {chapterLoading && (
                                        <div data-testid="book-chapter-loading" className="mt-6 space-y-4">
                                            <div className="flex items-center gap-2 text-xs text-zinc-500">
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                {t('books.reader.loading')}
                                            </div>
                                            {[0, 1, 2, 3].map((row) => (
                                                <div key={row} className="space-y-2">
                                                    <div className="h-4 w-full rounded bg-zinc-800/40 animate-pulse" />
                                                    <div className="h-3 w-2/3 rounded bg-zinc-800/30 animate-pulse" />
                                                </div>
                                            ))}
                                        </div>
                                    )}

                                    {!chapterLoading && chapterError && (
                                        <div className="mt-6">
                                            <ErrorPanel
                                                testId="book-chapter-error"
                                                message={t(chapterError)}
                                                onRetry={retryChapter}
                                                retryLabel={t('books.reader.retry')}
                                            />
                                        </div>
                                    )}

                                    {!chapterLoading && !chapterError && chapter && translating && (
                                        <div
                                            data-testid="book-auto-translate-progress"
                                            role="status"
                                            aria-live="polite"
                                            className="mt-5 rounded-2xl border border-blue-500/20 bg-blue-500/[0.06] px-3.5 py-3"
                                        >
                                            <p className="flex items-center gap-2 text-[12px] font-medium text-blue-200">
                                                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                {t('books.reader.autoTranslating')}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-relaxed text-blue-200/70">
                                                {t('books.reader.autoTranslatingHint')}
                                            </p>
                                        </div>
                                    )}

                                    {!chapterLoading && !chapterError && chapter && !translating && translateError && (
                                        <div className="mt-5">
                                            <ErrorPanel
                                                testId="book-translate-error"
                                                message={t(translateError)}
                                                onRetry={() => { void runTranslation(); }}
                                                retryLabel={t('books.reader.translateRetry')}
                                                retryTestId="book-translate-retry"
                                            />
                                        </div>
                                    )}

                                    {!chapterLoading && !chapterError && chapter && !translating
                                        && !translateError && translateNotice === 'partial' && (
                                        <div
                                            data-testid="book-translate-notice"
                                            className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-3"
                                        >
                                            <p className="flex items-center gap-2 text-[12px] font-medium text-amber-200">
                                                <AlertCircle className="w-3.5 h-3.5" />
                                                {t('books.reader.translatePartial')}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
                                                {t('books.reader.translatePartialHint', {
                                                    done: formatNumber(translatedParagraphs),
                                                    total: formatNumber(chapter.paragraphs.length),
                                                })}
                                            </p>
                                        </div>
                                    )}

                                    {!chapterLoading && !chapterError && chapter && needsTranslation
                                        && !translating && !translateError && translateNotice !== 'partial' && (
                                        <div
                                            data-testid="book-chapter-translation-pending"
                                            className="mt-5 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] px-3.5 py-3"
                                        >
                                            <p className="flex items-center gap-2 text-[12px] font-medium text-amber-200">
                                                <AlertCircle className="w-3.5 h-3.5" />
                                                {hasAnyTranslation
                                                    ? t('books.reader.translationPartial')
                                                    : t('books.reader.translationPending')}
                                            </p>
                                            <p className="mt-1 text-[11px] leading-relaxed text-amber-200/70">
                                                {hasAnyTranslation
                                                    ? t('books.reader.translatePartialHint', {
                                                        done: formatNumber(translatedParagraphs),
                                                        total: formatNumber(chapter.paragraphs.length),
                                                    })
                                                    : t('books.reader.translationPendingHint', {
                                                        translated: formatNumber(chapter.translatedChapters),
                                                        total: formatNumber(chapter.totalChapters),
                                                    })}
                                            </p>
                                            {!canAnalyze && (
                                                <p
                                                    data-testid="book-guest-translate-hint"
                                                    className="mt-1.5 text-[11px] leading-relaxed text-amber-200/60"
                                                >
                                                    {t('books.reader.guestTranslateHint')}
                                                </p>
                                            )}
                                        </div>
                                    )}

                                    {!chapterLoading && !chapterError && chapter && (
                                        <article className="mt-5">
                                            <div className="flex flex-wrap items-baseline justify-between gap-2">
                                                <h2 className="text-xl font-semibold tracking-tight text-zinc-100">
                                                    {chapter.chapterTitle}
                                                </h2>
                                                <span className="text-[11px] text-zinc-500">
                                                    {t('books.reader.sourceTitle', { title: chapter.sourceTitle })}
                                                </span>
                                            </div>
                                            <p className="mt-1 text-[11px] text-zinc-500">
                                                {chapter.source.degraded
                                                    ? t('books.reader.sourceDegraded')
                                                    : t('books.reader.sourceLive')}
                                            </p>

                                            {chapter.paragraphs.map((paragraph) => (
                                                <div
                                                    key={paragraph.index}
                                                    data-book-paragraph={paragraph.index}
                                                    data-testid={`book-paragraph-${paragraph.index}`}
                                                    className="mt-4 rounded-xl border border-transparent px-2 py-1 -mx-2 hover:border-white/5 hover:bg-zinc-900/30 transition-colors"
                                                >
                                                    <BilingualRow
                                                        twoColumn={bilingualColumns}
                                                        testId={`book-row-${paragraph.index}`}
                                                        english={(
                                                            <p
                                                                data-testid={`book-en-${paragraph.index}`}
                                                                data-lookup-context={paragraph.en}
                                                                data-lookup-start={paragraph.index}
                                                                lang="en"
                                                                className="ruby-safe-line text-base text-zinc-200 break-words"
                                                            >
                                                                <ReadingHighlight
                                                                    text={paragraph.en}
                                                                    isHighlighted={highlight.isHighlighted}
                                                                    languagePoints={languagePointsByParagraph[paragraph.index]}
                                                                    showLanguagePoints={showLanguagePoints}
                                                                    wordGlosses={paragraph.glosses}
                                                                    onWordClick={(word, event) =>
                                                                        onWordLookup(word, paragraph.en, paragraph.index, event, {
                                                                            id: bookId,
                                                                            title: detail?.title,
                                                                        })
                                                                    }
                                                                />
                                                            </p>
                                                        )}
                                                        translation={
                                                            showTranslations && hasAnyTranslation
                                                                ? paragraph.zh
                                                                    ? (
                                                                        <p
                                                                            data-testid={`book-translation-${paragraph.index}`}
                                                                            lang={language}
                                                                            className="text-[15px] leading-relaxed text-zinc-400 break-words"
                                                                        >
                                                                            {paragraph.zh}
                                                                        </p>
                                                                    )
                                                                    : (
                                                                        <p
                                                                            data-testid={`book-translation-missing-${paragraph.index}`}
                                                                            className="inline-flex items-center gap-1.5 rounded-md border border-amber-500/15 bg-amber-500/[0.06] px-2 py-0.5 text-[11px] text-amber-300/90"
                                                                        >
                                                                            <AlertCircle className="w-3 h-3" />
                                                                            {t('books.reader.missingTranslation')}
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
                                                    onClick={() => previousChapter && goChapter(previousChapter.n)}
                                                    disabled={!previousChapter}
                                                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    <ChevronLeft className="w-4 h-4" />
                                                    {t('books.reader.prev')}
                                                </button>
                                                <span className="text-[11px] text-zinc-500 tabular-nums">
                                                    {formatNumber(chapter.chapter)} / {formatNumber(chapter.importedChapters)}
                                                </span>
                                                <button
                                                    type="button"
                                                    onClick={() => nextChapter && goChapter(nextChapter.n)}
                                                    disabled={!nextChapter}
                                                    className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                                                >
                                                    {t('books.reader.next')}
                                                    <ChevronRight className="w-4 h-4" />
                                                </button>
                                            </div>
                                        </article>
                                    )}

                                    <section className="mt-8 rounded-2xl border border-white/5 bg-zinc-900/30 p-4">
                                        <div className="flex items-center gap-2 text-[13px] font-medium text-zinc-300">
                                            <BookOpen className="w-4 h-4 text-blue-400" />
                                            {detail.series.title}
                                        </div>
                                        <p className="mt-1.5 text-[12px] leading-relaxed text-zinc-500">
                                            {seriesNote}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => onOpenSeries(detail.seriesId)}
                                            className="mt-3 inline-flex items-center gap-1 h-7 px-2 -mx-2 rounded-lg text-xs font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                        >
                                            {t('books.seriesLink')}
                                            <ArrowRight className="w-3.5 h-3.5" />
                                        </button>
                                    </section>
                                </>
                            )}
                        </>
                    )}
                </div>
            </div>
        </div>
    );
}
