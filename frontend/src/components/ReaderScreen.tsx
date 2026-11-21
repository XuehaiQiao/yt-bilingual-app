// Reading view (specs/019-reading, frontend).
//
// Two states in one screen: the article list (with the URL/paste import box)
// and the reader itself. The list is what "回到继续读" means — every row shows
// the saved paragraph and opens the article at it.
//
// Scope notes:
//   - the reader shows the English source and the target-language translation
//     exactly as the backend returned them (no client-side article text is
//     invented, no "[未翻译]" marker is shown as if it were a translation);
//   - translations are produced by POST /api/article/{id}/translate, which
//     only fills missing/failed paragraphs; while it runs we poll the detail
//     endpoint so the progress bar reflects batches the backend already wrote;
//   - scrolling records the paragraph near the top of the viewport and saves
//     it (throttled/debounced), so leaving and re-entering resumes in place;
//   - word lookup reuses the app-wide WordPopover through `onWordLookup`.
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    BookOpen,
    BookPlus,
    ExternalLink,
    FileText,
    Languages,
    Loader2,
    LogIn,
    MoreHorizontal,
    RefreshCw,
    Share2,
    Trash2,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { ReadingHighlight, ReadingHighlightToggle } from './ReadingHighlight';
import { LanguagePointToggle } from './ui/LanguagePointToggle';
import type { InlineLanguagePoint } from './TranscriptBlock';
import { loadLanguagePointsEnabled } from '../lib/highlightLayers';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { BilingualRow, bilingualReadingWidth } from './BilingualRow';
import { ShareCardDialog } from './ShareCardDialog';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { SubHeader } from './ui/SubHeader';
import { ReadingVocabButton } from './ReadingVocabButton';
import type { FavoriteItem } from '../lib/favorites';
import { Segmented } from './ui/Segmented';
import { classifyPublicDomainBookUrl } from '../lib/publicDomain';
import type { ShareCardData } from '../lib/shareCard';
import { toast } from '../lib/toast';
import {
    ReadingApiError,
    deleteArticle,
    getArticle,
    importArticle,
    listArticles,
    saveProgress,
    translateArticle,
    type ArticleDetail,
    type ArticleParagraph,
    type ArticleSummary,
} from '../lib/reading';

interface ReaderScreenProps {
    /** Back to the home screen. */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    onRequestLogin?: () => void;
    isGuest?: boolean;
    /**
     * Open this article on mount instead of the list (favorites "出处" jump).
     * App remounts the screen for a new target; ordinary entries omit it.
     */
    initialArticleId?: string;
    /**
     * Handover from the Start-learning "read article" mode: prefill the import
     * form and start the existing import flow once. `mode` is decided by the
     * caller (http(s) URL = url import, anything else = pasted body).
     */
    initialImport?: { mode: ImportMode; value: string; title?: string };
    /** Called once the handed-over import has been dispatched. */
    onInitialImportConsumed?: () => void;
    /** Public-domain book link pasted here → hand off to the book importer. */
    onImportPublicDomainBook?: (url: string) => void;
    /** Reuse the app-wide dictionary card (App owns its state/favorites). */
    onWordLookup: (
        word: string,
        context: string,
        start: number,
        e: React.MouseEvent,
        sourceId?: string,
        sourceTitle?: string,
    ) => void;
    /** App-owned favorites; the header chip shows the vocabulary count. */
    favorites: readonly FavoriteItem[];
    /** Same entry as the video page: navigate to the word-book full page. */
    onOpenWordbook: () => void;
}

type ImportMode = 'url' | 'text';

const MAX_PASTED_CHARS = 2_000_000;

/** The translation a paragraph can honestly show/share (never "[未翻译]"). */
function usableTranslation(paragraph: ArticleParagraph): string | undefined {
    const translation = typeof paragraph.translation === 'string' ? paragraph.translation.trim() : '';
    if (!translation || translation === '[未翻译]' || paragraph.translationFailed) return undefined;
    return translation;
}

function statusOf(error: unknown): number {
    return error instanceof ReadingApiError ? error.status : -2;
}

function errorKeyForStatus(status: number): TranslationKey {
    switch (status) {
        case 0:
            return 'reader.error.network';
        case 400:
            return 'reader.error.invalid';
        case 403:
            return 'reader.error.login';
        case 404:
            return 'reader.error.notFound';
        case 422:
            return 'reader.error.fetch';
        case 429:
            return 'reader.error.rateLimited';
        case 503:
            return 'reader.error.unavailable';
        case -1:
            return 'reader.error.badResponse';
        default:
            return 'reader.error.unknown';
    }
}

function translationErrorKey(status: number): TranslationKey {
    switch (status) {
        case 0:
            return 'reader.error.network';
        case 400:
            return 'reader.error.invalid';
        case 403:
            return 'reader.error.login';
        case 404:
            return 'reader.error.notFound';
        case 429:
            return 'reader.translation.quota';
        case 503:
            return 'reader.translation.unavailable';
        default:
            return 'reader.error.unknown';
    }
}

const primaryButton =
    'inline-flex items-center justify-center gap-2 h-10 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50 disabled:active:scale-100';
const secondaryButton =
    'inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50';
const tintedButton =
    'inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-sm font-medium text-blue-300 hover:text-blue-200 transition-colors disabled:opacity-60 disabled:cursor-not-allowed';
const textField =
    'w-full rounded-xl bg-zinc-900/60 border border-white/5 px-3 text-sm text-zinc-100 placeholder-zinc-500 outline-none focus:border-brand/60 focus:ring-2 focus:ring-brand/15 transition-[border-color,box-shadow] duration-200';

const ReaderErrorPanel: React.FC<{
    message: string;
    retryLabel: string;
    onRetry?: () => void;
    loginLabel?: string;
    onLogin?: () => void;
    backLabel?: string;
    onBack?: () => void;
    testId?: string;
}> = ({ message, retryLabel, onRetry, loginLabel, onLogin, backLabel, onBack, testId }) => (
    <section
        data-testid={testId}
        role="alert"
        className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
    >
        <div className="flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
            <div className="min-w-0">
                <p className="text-sm leading-relaxed text-zinc-300 break-words">{message}</p>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                    {onRetry && (
                        <button type="button" onClick={onRetry} className={secondaryButton}>
                            <RefreshCw className="w-4 h-4" />
                            {retryLabel}
                        </button>
                    )}
                    {onLogin && loginLabel && (
                        <button type="button" onClick={onLogin} className={tintedButton}>
                            <LogIn className="w-4 h-4" />
                            {loginLabel}
                        </button>
                    )}
                    {onBack && backLabel && (
                        <button
                            type="button"
                            onClick={onBack}
                            className="inline-flex items-center gap-2 h-9 px-4 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                        >
                            <ArrowLeft className="w-4 h-4" />
                            {backLabel}
                        </button>
                    )}
                </div>
            </div>
        </div>
    </section>
);

export const ReaderScreen: React.FC<ReaderScreenProps> = ({
    onClose,
    parentLabel,
    onRequestLogin,
    isGuest = false,
    initialArticleId,
    initialImport,
    onInitialImportConsumed,
    onImportPublicDomainBook,
    onWordLookup,
    favorites,
    onOpenWordbook,
}) => {
    const { t, targetLang, formatNumber } = useI18n();

    // ── Article list + import ──────────────────────────────────────────────
    const [articles, setArticles] = useState<ArticleSummary[]>([]);
    const [listLoading, setListLoading] = useState(!isGuest);
    const [listError, setListError] = useState<number | null>(null);
    // The handed-over value is visible in the form immediately (the import
    // itself starts from the effect below, after the screen has mounted).
    const [importMode, setImportMode] = useState<ImportMode>(initialImport?.mode ?? 'url');
    const [urlValue, setUrlValue] = useState(
        initialImport?.mode === 'url' ? initialImport.value : '',
    );
    const [textValue, setTextValue] = useState(
        initialImport?.mode === 'text' ? initialImport.value : '',
    );
    const [titleValue, setTitleValue] = useState(initialImport?.title ?? '');
    const [importing, setImporting] = useState(false);
    const [importError, setImportError] = useState<TranslationKey | null>(null);
    // A public-domain book link is not an article; remember it so the form can
    // offer the one-click handoff to "导入公版书".
    const [publicDomainUrl, setPublicDomainUrl] = useState<string | null>(null);
    const importingRef = useRef(false);

    // ── Reader ─────────────────────────────────────────────────────────────
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [article, setArticle] = useState<ArticleDetail | null>(null);
    const [articleLoading, setArticleLoading] = useState(false);
    const [articleError, setArticleError] = useState<number | null>(null);
    const [showTranslations, setShowTranslations] = useState(true);
    const [showLanguagePoints, setShowLanguagePoints] = useState<boolean>(loadLanguagePointsEnabled);
    const [translating, setTranslating] = useState(false);
    const [translateError, setTranslateError] = useState<number | null>(null);
    const [currentIdx, setCurrentIdx] = useState(0);
    // Share card + paragraph actions. One dialog instance serves both the
    // paragraph menu and the floating "share selection" chip.
    const [shareData, setShareData] = useState<ShareCardData | null>(null);
    // The delete confirmation is one dialog instance for the whole list; the
    // article is only removed after it resolves successfully.
    const [pendingDelete, setPendingDelete] = useState<ArticleSummary | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);
    const [menuIdx, setMenuIdx] = useState<number | null>(null);
    const [selection, setSelection] = useState<{ idx: number; text: string; left: number; top: number } | null>(null);
    // Words above the slider threshold get the restrained amber mark. The hook
    // caches per word and fails silently, so reading never waits on it.
    const highlight = useReadingHighlights(
        article ? article.paragraphs.map((paragraph) => paragraph.text) : [],
    );
    const languagePointsByParagraph = useMemo(() => {
        const map: Record<number, InlineLanguagePoint[]> = {};
        for (const point of article?.languagePoints ?? []) {
            (map[point.blockId] ??= []).push({
                text: point.text,
                meaning: point.meaning,
                kind: point.kind,
            });
        }
        return map;
    }, [article?.languagePoints]);

    const mountedRef = useRef(true);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    const selectedIdRef = useRef<string | null>(null);
    const currentIdxRef = useRef(0);
    const lastSavedIdxRef = useRef<number | null>(null);
    const restoreIdxRef = useRef<number | null>(null);
    const saveTimerRef = useRef<number | null>(null);
    const pollTimerRef = useRef<number | null>(null);
    const rafRef = useRef<number | null>(null);
    const saveErrorToastRef = useRef(false);
    // Avoid retrying a failed language-point fetch on every article object update.
    const analysisRequestedRef = useRef<string | null>(null);

    const loadList = useCallback(async () => {
        setListLoading(true);
        setListError(null);
        try {
            const next = await listArticles();
            if (!mountedRef.current) return;
            setArticles(next);
        } catch (err) {
            if (!mountedRef.current) return;
            setListError(statusOf(err));
        } finally {
            if (mountedRef.current) setListLoading(false);
        }
    }, []);

    // Persist the latest paragraph. `notify=false` is used from unmount
    // cleanup, where a toast would outlive the screen for no benefit.
    const flushProgress = useCallback((notify = true) => {
        const articleId = selectedIdRef.current;
        if (!articleId) return;
        const idx = currentIdxRef.current;
        if (idx === lastSavedIdxRef.current) return;
        lastSavedIdxRef.current = idx;
        void saveProgress(articleId, idx).catch((error: unknown) => {
            const status = statusOf(error);
            if (status === 404) return;
            if (selectedIdRef.current === articleId && lastSavedIdxRef.current === idx) {
                // Allow the next scroll/exit to retry the same paragraph.
                lastSavedIdxRef.current = null;
            }
            if (notify && !saveErrorToastRef.current) {
                saveErrorToastRef.current = true;
                toast.error(t('reader.progress.saveFailed'));
            }
        });
    }, [t]);

    const scheduleSave = useCallback(() => {
        if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = window.setTimeout(() => {
            saveTimerRef.current = null;
            flushProgress();
        }, 900);
    }, [flushProgress]);

    const handleScroll = useCallback(() => {
        // A floating "share selection" chip is anchored to viewport
        // coordinates, so it must disappear as soon as the text moves.
        setSelection((previous) => (previous ? null : previous));
        if (rafRef.current != null) return;
        rafRef.current = requestAnimationFrame(() => {
            rafRef.current = null;
            const container = scrollRef.current;
            if (!container) return;
            const threshold = container.getBoundingClientRect().top + 96;
            let next = 0;
            for (const node of container.querySelectorAll<HTMLElement>('[data-paragraph-index]')) {
                if (node.getBoundingClientRect().top <= threshold) {
                    const idx = Number(node.dataset.paragraphIndex);
                    if (Number.isInteger(idx) && idx >= 0) next = idx;
                } else {
                    break;
                }
            }
            if (next !== currentIdxRef.current) {
                currentIdxRef.current = next;
                setCurrentIdx(next);
                scheduleSave();
            }
        });
    }, [scheduleSave]);

    const openArticle = useCallback(async (articleId: string) => {
        flushProgress();
        selectedIdRef.current = articleId;
        setSelectedId(articleId);
        setArticle(null);
        setArticleError(null);
        setTranslateError(null);
        setShareData(null);
        setMenuIdx(null);
        setSelection(null);
        setArticleLoading(true);
        setShowTranslations(true);
        setCurrentIdx(0);
        currentIdxRef.current = 0;
        lastSavedIdxRef.current = null;
        restoreIdxRef.current = null;
        saveErrorToastRef.current = false;
        analysisRequestedRef.current = null;
        try {
            const detail = await getArticle(
                articleId,
                targetLang,
                !isGuest && (showLanguagePoints || highlight.enabled) ? highlight.level : null,
            );
            if (!mountedRef.current || selectedIdRef.current !== articleId) return;
            setArticle(detail);
            const maxIdx = Math.max(0, detail.paragraphs.length - 1);
            const startIdx = Math.min(Math.max(0, detail.progress?.paragraphIdx ?? 0), maxIdx);
            currentIdxRef.current = startIdx;
            setCurrentIdx(startIdx);
            if (detail.progress) {
                lastSavedIdxRef.current = startIdx;
                restoreIdxRef.current = startIdx > 0 ? startIdx : null;
            }
        } catch (err) {
            if (!mountedRef.current || selectedIdRef.current !== articleId) return;
            setArticleError(statusOf(err));
        } finally {
            if (mountedRef.current && selectedIdRef.current === articleId) {
                setArticleLoading(false);
            }
        }
    }, [flushProgress, highlight.level, isGuest, showLanguagePoints, targetLang]);

    // Turn the optional language-point layer on (or change the CEFR stop)
    // without reopening the article. The request is cached per content/level
    // and only runs for signed-in readers.
    useEffect(() => {
        const articleId = selectedIdRef.current;
        if (!articleId || !article || isGuest || (!showLanguagePoints && !highlight.enabled)) return;
        if (article.analysisLevel === highlight.level) return;
        const attemptKey = `${articleId}:${highlight.level}`;
        if (analysisRequestedRef.current === attemptKey) return;
        analysisRequestedRef.current = attemptKey;
        let cancelled = false;
        getArticle(articleId, targetLang, highlight.level)
            .then((detail) => {
                if (!cancelled && selectedIdRef.current === articleId) setArticle(detail);
            })
            .catch(() => {
                // Language points are an enhancement; reading stays usable.
            });
        return () => { cancelled = true; };
    }, [article, highlight.enabled, highlight.level, isGuest, showLanguagePoints, targetLang]);

    // Favorites "出处" jump: open the requested article instead of the list.
    // App remounts this screen when a different target arrives, so this runs
    // for the mount that carries the request (the guard skips a re-run when the
    // dependency identity changes but the article is already open).
    useEffect(() => {
        if (!initialArticleId || selectedIdRef.current === initialArticleId) return;
        void openArticle(initialArticleId);
    }, [initialArticleId, openArticle]);

    const goBackToList = useCallback(() => {
        flushProgress();
        if (saveTimerRef.current != null) {
            window.clearTimeout(saveTimerRef.current);
            saveTimerRef.current = null;
        }
        selectedIdRef.current = null;
        setSelectedId(null);
        setArticle(null);
        setArticleError(null);
        setTranslateError(null);
        setShareData(null);
        setMenuIdx(null);
        setSelection(null);
        setCurrentIdx(0);
        currentIdxRef.current = 0;
        lastSavedIdxRef.current = null;
        restoreIdxRef.current = null;
        if (rafRef.current != null) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (pollTimerRef.current != null) {
            window.clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
        }
        void loadList();
    }, [flushProgress, loadList]);

    // ── Share card (paragraph menu + text selection) ────────────────────────
    // Full paragraphs keep their stored translation; a selected sub-range has
    // no honest translation, so its card shows the source text + article title.
    const shareParagraph = useCallback((paragraph: ArticleParagraph) => {
        if (!article) return;
        setShareData({
            kind: 'article',
            text: paragraph.text,
            translation: usableTranslation(paragraph),
            source: article.title || t('reader.untitled'),
        });
        setMenuIdx(null);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
    }, [article, t]);

    const shareSelection = useCallback((target = selection) => {
        if (!article || !target) return;
        setShareData({
            kind: 'selection',
            text: target.text,
            source: article.title || t('reader.untitled'),
        });
        setMenuIdx(null);
        setSelection(null);
        window.getSelection()?.removeAllRanges();
    }, [article, selection, t]);

    // Turn the browser selection into a small floating action anchored to the
    // selected text. Called on mouseup inside the scroll container; a collapsed
    // selection (a plain word click) clears the chip.
    const captureSelection = useCallback(() => {
        const browserSelection = window.getSelection();
        const text = browserSelection?.toString().replace(/\s+/g, ' ').trim() ?? '';
        if (!browserSelection || browserSelection.rangeCount === 0 || !text) {
            setSelection(null);
            return;
        }
        const range = browserSelection.getRangeAt(0);
        const node = range.commonAncestorContainer;
        const element = node instanceof Element ? node : node.parentElement;
        const host = element?.closest<HTMLElement>('[data-paragraph-index]');
        if (!host) {
            setSelection(null);
            return;
        }
        const idx = Number(host.dataset.paragraphIndex);
        if (!Number.isInteger(idx) || idx < 0) {
            setSelection(null);
            return;
        }
        const rect = range.getBoundingClientRect();
        const maxLeft = Math.max(12, window.innerWidth - 148);
        const left = Math.min(Math.max(12, rect.left), maxLeft);
        let top = rect.bottom + 8;
        if (top > window.innerHeight - 56) top = Math.max(12, rect.top - 44);
        setSelection({ idx, text, left, top });
    }, []);

    // Restore the saved paragraph once the detail is on screen. Toast names the
    // paragraph number a reader can see (1-based).
    useEffect(() => {
        if (!article) return;
        const target = restoreIdxRef.current;
        if (target == null) return;
        restoreIdxRef.current = null;
        const container = scrollRef.current;
        const node = container?.querySelector<HTMLElement>(
            `[data-paragraph-index="${target}"]`,
        );
        if (!container || !node) return;
        // Scroll relative to the paragraph's current position and re-apply on
        // the next frame: a late layout pass (toolbar wrapping, font metrics)
        // must not leave the saved paragraph a few dozen pixels off target.
        const alignToSavedParagraph = () => {
            const gap = node.getBoundingClientRect().top - container.getBoundingClientRect().top;
            container.scrollTo({ top: Math.max(0, container.scrollTop + gap - 16), behavior: 'auto' });
        };
        requestAnimationFrame(() => {
            alignToSavedParagraph();
            requestAnimationFrame(alignToSavedParagraph);
        });
        toast.info(t('reader.detail.resumed', { index: target + 1 }));
    }, [article, t]);

    useEffect(() => {
        mountedRef.current = true;
        if (!isGuest) void loadList();
        else setListLoading(false);
        return () => {
            mountedRef.current = false;
            if (saveTimerRef.current != null) window.clearTimeout(saveTimerRef.current);
            if (pollTimerRef.current != null) window.clearInterval(pollTimerRef.current);
            if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
            flushProgress(false);
        };
    }, [isGuest, loadList, flushProgress]);

    const refreshTranslations = useCallback(async (articleId: string) => {
        try {
            const detail = await getArticle(
                articleId,
                targetLang,
                !isGuest && (showLanguagePoints || highlight.enabled) ? highlight.level : null,
            );
            if (mountedRef.current && selectedIdRef.current === articleId) {
                setArticle(detail);
            }
        } catch {
            // Best-effort polling: the translate call itself reports failures.
        }
    }, [highlight.level, isGuest, showLanguagePoints, targetLang]);

    const handleTranslate = useCallback(async () => {
        const current = article;
        if (!current || translating) return;
        setTranslating(true);
        setTranslateError(null);
        if (pollTimerRef.current != null) window.clearInterval(pollTimerRef.current);
        pollTimerRef.current = window.setInterval(() => {
            void refreshTranslations(current.articleId);
        }, 2500);
        try {
            const result = await translateArticle(current.articleId, targetLang);
            await refreshTranslations(current.articleId);
            if (result.status === 'cached') {
                toast.info(t('reader.translation.cached'));
            } else if (result.failed > 0) {
                toast.info(t('reader.translation.failedToast', { count: result.failed }));
            } else {
                toast.success(t('reader.translation.done'));
            }
        } catch (err) {
            const status = statusOf(err);
            setTranslateError(status);
            toast.error(t(translationErrorKey(status)));
        } finally {
            if (pollTimerRef.current != null) {
                window.clearInterval(pollTimerRef.current);
                pollTimerRef.current = null;
            }
            if (mountedRef.current) setTranslating(false);
        }
    }, [article, translating, refreshTranslations, targetLang, t]);

    // One import pipeline shared by the form and the Start-learning handover
    // (`initialImport`). Values are passed explicitly so the automatic path
    // never has to wait for React state to settle.
    const runImport = useCallback(async (mode: ImportMode, rawValue: string, rawTitle: string) => {
        if (importingRef.current) return;

        const title = rawTitle.trim();
        if (mode === 'url') {
            if (!rawValue.trim()) {
                setImportError('reader.import.urlRequired');
                return;
            }
        } else {
            if (!rawValue.trim()) {
                setImportError('reader.import.textRequired');
                return;
            }
            if (rawValue.length > MAX_PASTED_CHARS) {
                setImportError('reader.import.tooLong');
                return;
            }
        }

        if (mode === 'url') {
            const bookLink = classifyPublicDomainBookUrl(rawValue);
            if (bookLink) {
                setImportError(null);
                setPublicDomainUrl(bookLink.url);
                return;
            }
        }

        importingRef.current = true;
        setImporting(true);
        setImportError(null);
        setPublicDomainUrl(null);
        try {
            const result = await importArticle(
                mode === 'url'
                    ? { url: rawValue.trim(), title: title || undefined }
                    : { text: rawValue, title: title || undefined },
            );
            if (!mountedRef.current) return;
            setUrlValue('');
            setTextValue('');
            setTitleValue('');
            if (result.reused) toast.info(t('reader.import.reused'));
            else toast.success(t('reader.import.done'));
            await loadList();
            if (!mountedRef.current) return;
            await openArticle(result.articleId);
        } catch (err) {
            if (mountedRef.current) setImportError(errorKeyForStatus(statusOf(err)));
        } finally {
            importingRef.current = false;
            if (mountedRef.current) setImporting(false);
        }
    }, [loadList, openArticle, t]);

    const handleImport = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        void runImport(importMode, importMode === 'url' ? urlValue : textValue, titleValue);
    };

    // Start-learning "read article" handover: prefill already happened in the
    // state initialisers; dispatch the existing import once after mount. The
    // zero-delay timer is cleared by the cleanup, so StrictMode's double
    // effect does not import twice.
    useEffect(() => {
        if (!initialImport) return;
        if (isGuest) {
            onInitialImportConsumed?.();
            return;
        }
        if (!initialImport.value.trim()) {
            onInitialImportConsumed?.();
            return;
        }
        const timer = window.setTimeout(() => {
            onInitialImportConsumed?.();
            void runImport(initialImport.mode, initialImport.value, initialImport.title ?? '');
        }, 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const requestDelete = (e: React.MouseEvent, summary: ArticleSummary) => {
        e.stopPropagation();
        setDeleteError(null);
        setPendingDelete(summary);
    };

    const handleDelete = async () => {
        if (!pendingDelete) return;
        try {
            await deleteArticle(pendingDelete.articleId);
            if (!mountedRef.current) return;
            setArticles((prev) => prev.filter((item) => item.articleId !== pendingDelete.articleId));
            toast.success(t('reader.list.deleted'));
        } catch (err) {
            const message = t(errorKeyForStatus(statusOf(err)));
            setDeleteError(message);
            toast.error(message);
            throw err;
        }
    };

    const stats = article?.stats ?? { total: 0, translated: 0, untranslated: 0 };
    const failedCount = article
        ? article.paragraphs.filter((paragraph) => paragraph.translationFailed).length
        : 0;
    const hasTranslation = stats.translated > 0;
    // ≥lg two columns only while Chinese is actually on screen: turning
    // translations off gives the English source the full width back.
    const bilingualColumns = showTranslations && hasTranslation;
    const showTranslateBar = stats.untranslated > 0 || translating || translateError !== null;
    const translateButtonLabel = translating
        ? t('reader.translation.translating')
        : failedCount > 0
            ? t('reader.translation.retryFailed')
            : stats.translated > 0
                ? t('reader.translation.fill', { count: formatNumber(stats.untranslated) })
                : t('reader.translation.translate');
    const translatePercent = stats.total > 0
        ? Math.min(100, Math.round((stats.translated / stats.total) * 100))
        : 0;

    const importStatusLabel = importMode === 'url'
        ? t('reader.import.importing')
        : t('reader.import.importingPaste');
    const canSubmitImport = importMode === 'url'
        ? urlValue.trim() !== ''
        : textValue.trim() !== '';

    // ── List state ─────────────────────────────────────────────────────────
    const listHeader = (
        <p className="text-ui leading-relaxed text-fg-secondary">
            {t('reader.subtitle')}
        </p>
    );

    const loginPanel = isGuest ? (
        <section
            data-testid="reader-login"
            className="mt-6 rounded-2xl border border-white/5 bg-zinc-900/40 px-4 py-12 text-center"
        >
            <LogIn className="w-10 h-10 text-zinc-700 mx-auto mb-3" />
            <p className="text-sm font-medium text-zinc-400">{t('reader.loginTitle')}</p>
            <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                {t('reader.error.login')}
            </p>
            {onRequestLogin && (
                <button type="button" onClick={onRequestLogin} className={`${primaryButton} mt-4`}>
                    <LogIn className="w-4 h-4" />
                    {t('reader.login')}
                </button>
            )}
        </section>
    ) : null;

    const importSection = !isGuest && (
        <section
            data-testid="reader-import"
            className="mt-6 rounded-2xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5"
        >
            <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex items-center gap-2 text-zinc-100">
                    <FileText className="w-5 h-5 text-blue-400" />
                    <h2 className="text-[17px] font-semibold tracking-tight">
                        {t('reader.import.title')}
                    </h2>
                </div>
                <Segmented
                    options={[
                        { value: 'url', label: t('reader.import.tab.url'), testId: 'reader-import-tab-url' },
                        { value: 'text', label: t('reader.import.tab.text'), testId: 'reader-import-tab-text' },
                    ]}
                    value={importMode}
                    onChange={(value) => {
                        setImportMode(value as 'url' | 'text');
                        setImportError(null);
                        setPublicDomainUrl(null);
                    }}
                    layoutId="reader-import"
                    ariaLabel={t('reader.import.tabsAria')}
                    size="sm"
                />
            </div>
            <p className="mt-2 text-xs leading-relaxed text-zinc-500">
                {t('reader.import.hint')}
            </p>
            <form className="mt-4 space-y-3" onSubmit={handleImport}>
                {importMode === 'url' ? (
                    <input
                        type="url"
                        inputMode="url"
                        value={urlValue}
                        onChange={(e) => {
                            setUrlValue(e.target.value);
                            setPublicDomainUrl(null);
                        }}
                        disabled={importing}
                        aria-label={t('reader.import.tab.url')}
                        data-testid="reader-import-url"
                        placeholder={t('reader.import.urlPlaceholder')}
                        className={`${textField} h-10`}
                    />
                ) : (
                    <textarea
                        value={textValue}
                        onChange={(e) => setTextValue(e.target.value)}
                        disabled={importing}
                        aria-label={t('reader.import.tab.text')}
                        data-testid="reader-import-text"
                        placeholder={t('reader.import.textPlaceholder')}
                        rows={6}
                        className={`${textField} min-h-[9rem] py-2.5 resize-y`}
                    />
                )}
                <input
                    type="text"
                    value={titleValue}
                    onChange={(e) => setTitleValue(e.target.value)}
                    disabled={importing}
                    aria-label={t('reader.import.titlePlaceholder')}
                    data-testid="reader-import-title"
                    placeholder={t('reader.import.titlePlaceholder')}
                    className={`${textField} h-10`}
                />
                {importError && (
                    <p
                        data-testid="reader-import-error"
                        role="alert"
                        className="text-xs leading-relaxed text-amber-400 break-words"
                    >
                        {t(importError)}
                    </p>
                )}
                {publicDomainUrl && (
                    <div
                        data-testid="reader-import-public-domain"
                        className="rounded-xl border border-blue-500/20 bg-blue-500/[0.06] px-3 py-2.5"
                    >
                        <p className="text-xs leading-relaxed text-blue-200">
                            {t('reader.import.publicDomainHint')}
                        </p>
                        {onImportPublicDomainBook && (
                            <button
                                type="button"
                                data-testid="reader-import-public-domain-cta"
                                onClick={() => onImportPublicDomainBook(publicDomainUrl)}
                                className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-lg bg-blue-500 px-3 text-xs font-semibold text-white transition-colors hover:bg-blue-400"
                            >
                                <BookPlus className="h-3.5 w-3.5" />
                                {t('reader.import.publicDomainCta')}
                            </button>
                        )}
                    </div>
                )}
                {importing && (
                    <p
                        data-testid="reader-import-loading"
                        role="status"
                        className="flex items-center gap-2 text-xs text-zinc-400"
                    >
                        <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" />
                        {importStatusLabel}
                    </p>
                )}
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <span className="text-[11px] text-zinc-600 tabular-nums">
                        {importMode === 'text'
                            ? t('reader.import.charCount', { count: formatNumber(textValue.length) })
                            : '\u00A0'}
                    </span>
                    <button
                        type="submit"
                        data-testid="reader-import-submit"
                        disabled={importing || !canSubmitImport}
                        className={primaryButton}
                    >
                        {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <FileText className="w-4 h-4" />}
                        {t('reader.import.submit')}
                    </button>
                </div>
            </form>
        </section>
    );

    const articleList = !isGuest && (
        <section data-testid="reader-list" className="mt-8">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                    {t('reader.list.title')}
                </h2>
                <span className="text-xs text-zinc-500 tabular-nums">
                    {t('reader.list.count', { count: formatNumber(articles.length) })}
                </span>
            </div>

            {listLoading ? (
                <div
                    data-testid="reader-list-loading"
                    className="flex flex-col items-center justify-center py-16 text-center"
                >
                    <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                    <p className="text-sm font-medium text-zinc-400">{t('reader.list.loading')}</p>
                </div>
            ) : listError !== null ? (
                <ReaderErrorPanel
                    testId="reader-list-error"
                    message={t(errorKeyForStatus(listError))}
                    retryLabel={t('common.retry')}
                    onRetry={() => { void loadList(); }}
                    loginLabel={listError === 403 && onRequestLogin ? t('reader.login') : undefined}
                    onLogin={listError === 403 ? onRequestLogin : undefined}
                    backLabel={t('reader.backHome')}
                    onBack={onClose}
                />
            ) : articles.length === 0 ? (
                <div
                    data-testid="reader-list-empty"
                    className="mt-4 flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-zinc-900/40 px-4 py-12 text-center"
                >
                    <BookOpen className="w-10 h-10 text-zinc-700 mb-3" />
                    <p className="text-sm font-medium text-zinc-400">{t('reader.list.emptyTitle')}</p>
                    <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                        {t('reader.list.emptyHint')}
                    </p>
                </div>
            ) : (
                <div className="mt-4 space-y-2">
                    {articles.map((summary) => {
                        const progress = summary.progress;
                        const percent = progress && summary.paragraphCount > 0
                            ? Math.min(100, Math.round(((progress.paragraphIdx + 1) / summary.paragraphCount) * 100))
                            : 0;
                        const progressLabel = progress
                            ? t('reader.list.continue', {
                                current: formatNumber(progress.paragraphIdx + 1),
                                total: formatNumber(summary.paragraphCount),
                            })
                            : t('reader.list.notStarted');
                        const title = summary.title || t('reader.untitled');
                        return (
                            <div key={summary.articleId} className="relative">
                                <button
                                    type="button"
                                    data-testid={`article-row-${summary.articleId}`}
                                    data-article-id={summary.articleId}
                                    onClick={() => { void openArticle(summary.articleId); }}
                                    className="w-full text-left pr-12 p-3 sm:p-4 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors"
                                >
                                    <div className="flex items-start gap-3">
                                        <FileText className="w-4 h-4 mt-0.5 text-zinc-500 shrink-0" />
                                        <div className="min-w-0 flex-1">
                                            <h3 className="text-sm font-medium leading-snug text-zinc-100 break-words">
                                                {title}
                                            </h3>
                                            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                                                {summary.site && (
                                                    <span className="max-w-[12rem] truncate">{summary.site}</span>
                                                )}
                                                <span className="tabular-nums">
                                                    {t('reader.words', { count: formatNumber(summary.wordCount) })}
                                                </span>
                                                <span className="tabular-nums">
                                                    {t('reader.paragraphs', { count: formatNumber(summary.paragraphCount) })}
                                                </span>
                                            </div>
                                            <div className="mt-2 flex items-center gap-2">
                                                <div className="h-1 flex-1 min-w-[2rem] max-w-[6rem] sm:max-w-[10rem] rounded-full bg-zinc-800 overflow-hidden">
                                                    <div
                                                        className="h-full bg-blue-500/80 rounded-full"
                                                        style={{ width: `${percent}%` }}
                                                    />
                                                </div>
                                                <span className="shrink-0 whitespace-nowrap text-[11px] text-zinc-500 tabular-nums">
                                                    {progressLabel}
                                                </span>
                                            </div>
                                        </div>
                                    </div>
                                </button>
                                <button
                                    type="button"
                                    data-testid={`article-delete-${summary.articleId}`}
                                    onClick={(e) => { requestDelete(e, summary); }}
                                    aria-label={t('reader.list.deleteAria', { title })}
                                    title={t('reader.list.deleteAria', { title })}
                                    className="absolute top-2 right-2 p-1.5 rounded-lg text-zinc-500 hover:text-red-400 hover:bg-red-500/10 transition-colors"
                                >
                                    <Trash2 className="w-4 h-4" />
                                </button>
                            </div>
                        );
                    })}
                </div>
            )}
        </section>
    );

    // ── Reader state ───────────────────────────────────────────────────────
    const translationToggle = hasTranslation && (
        <Segmented
            options={[
                { value: 'all', label: t('reader.translation.all'), testId: 'reader-translation-all' },
                { value: 'hidden', label: t('reader.translation.hidden'), testId: 'reader-translation-hidden' },
            ]}
            value={showTranslations ? 'all' : 'hidden'}
            onChange={(value) => setShowTranslations(value === 'all')}
            layoutId="reader-translation"
            ariaLabel={t('reader.translation.toggleAria')}
            size="sm"
            testId="reader-translation-toggle"
        />
    );

    const translateSection = article && showTranslateBar && (
        <section
            data-testid="reader-translation-bar"
            className="mt-5 rounded-2xl border border-white/5 bg-zinc-900/40 p-4"
        >
            <div className="flex flex-wrap items-start gap-3">
                <Languages className="w-5 h-5 text-blue-400 shrink-0 mt-0.5" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium leading-relaxed text-zinc-200">
                        {translating
                            ? t('reader.translation.translating')
                            : failedCount > 0
                                ? t('reader.translation.partial', { count: formatNumber(failedCount) })
                                : stats.translated > 0
                                    ? t('reader.translation.fill', { count: formatNumber(stats.untranslated) })
                                    : t('reader.translation.none')}
                    </p>
                    <p className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                        {t('reader.translation.progress', {
                            done: formatNumber(stats.translated),
                            total: formatNumber(stats.total),
                        })}
                    </p>
                    {translating && stats.total > 0 && (
                        <div className="mt-2 h-1.5 rounded-full bg-zinc-800 overflow-hidden">
                            <div
                                className="h-full bg-blue-500 rounded-full transition-[width] duration-500 ease-out"
                                style={{ width: `${translatePercent}%` }}
                            />
                        </div>
                    )}
                    {translateError !== null && (
                        <p
                            data-testid="reader-translate-error"
                            role="alert"
                            className="mt-2 text-xs leading-relaxed text-red-400 break-words"
                        >
                            {t(translationErrorKey(translateError))}
                        </p>
                    )}
                </div>
                <button
                    type="button"
                    data-testid="reader-translate-button"
                    onClick={() => { void handleTranslate(); }}
                    disabled={translating}
                    className={`${tintedButton} shrink-0`}
                >
                    {translating ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                    ) : failedCount > 0 ? (
                        <RefreshCw className="w-4 h-4" />
                    ) : (
                        <Languages className="w-4 h-4" />
                    )}
                    {translateButtonLabel}
                </button>
            </div>
        </section>
    );

    const readingView = selectedId !== null && (
        <div data-testid="reader-article" data-current-paragraph={currentIdx} className="flex flex-col h-full min-h-0">
            <SubHeader
                title={t('reader.title')}
                onBack={goBackToList}
                parentLabel={parentLabel}
                backAriaLabel={t('reader.backToList')}
                backLabel={t('reader.backToList')}
                backTestId="reader-back-list"
                titleAs="p"
                actions={<ReadingVocabButton favorites={favorites} onOpenWordbook={onOpenWordbook} />}
            />
            <div
                data-testid="reader-toolbar"
                className="flex-none flex items-center justify-end gap-2 px-4 sm:px-8 py-2 border-b border-white/5 bg-zinc-950/40"
            >
                <span className="hidden sm:inline text-xs text-zinc-500">
                    {t('reader.wordLookupHint')}
                </span>
                {article && (
                    <ReadingHighlightToggle
                        testId="reader-highlight-toggle"
                        enabled={highlight.enabled}
                        onChange={highlight.setEnabled}
                        levelLabel={highlight.levelLabel}
                    />
                )}
                {article && !isGuest && (
                    <LanguagePointToggle
                        enabled={showLanguagePoints}
                        onChange={setShowLanguagePoints}
                        testId="reader-language-points-toggle"
                    />
                )}
                {article && translationToggle}
            </div>

            <div
                ref={scrollRef}
                onScroll={handleScroll}
                onMouseUp={captureSelection}
                data-testid="reader-scroll"
                className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar"
            >
                <div className={`mx-auto px-4 sm:px-8 py-6 sm:py-10 ${bilingualReadingWidth(bilingualColumns)}`}>
                    {articleLoading ? (
                        <div
                            data-testid="reader-article-loading"
                            className="flex flex-col items-center justify-center py-24 text-center"
                        >
                            <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                            <p className="text-sm font-medium text-zinc-400">{t('reader.detail.loading')}</p>
                        </div>
                    ) : articleError !== null ? (
                        <ReaderErrorPanel
                            testId="reader-article-error"
                            message={t(errorKeyForStatus(articleError))}
                            retryLabel={t('common.retry')}
                            onRetry={() => { if (selectedId) void openArticle(selectedId); }}
                            backLabel={t('reader.backToList')}
                            onBack={goBackToList}
                        />
                    ) : article ? (
                        <>
                            <header>
                                <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-100 break-words">
                                    {article.title || t('reader.untitled')}
                                </h1>
                                <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-zinc-500">
                                    {article.site && (
                                        <span className="max-w-[16rem] truncate">{article.site}</span>
                                    )}
                                    <span className="tabular-nums">
                                        {t('reader.words', { count: formatNumber(article.wordCount) })}
                                    </span>
                                    <span className="tabular-nums">
                                        {t('reader.paragraphs', { count: formatNumber(article.paragraphs.length) })}
                                    </span>
                                    {article.sourceUrl && (
                                        <a
                                            href={article.sourceUrl}
                                            target="_blank"
                                            rel="noreferrer noopener"
                                            className="inline-flex items-center gap-1 text-blue-400 hover:text-blue-300 transition-colors"
                                            title={t('reader.sourceLink')}
                                        >
                                            <ExternalLink className="w-3 h-3" />
                                            {t('reader.sourceLink')}
                                        </a>
                                    )}
                                </div>
                            </header>

                            {translateSection}

                            <div className="mt-6 space-y-1.5">
                                {article.paragraphs.map((paragraph) => {
                                    const translated = typeof paragraph.translation === 'string'
                                        && paragraph.translation.trim() !== ''
                                        && paragraph.translation.trim() !== '[未翻译]'
                                        && !paragraph.translationFailed;
                                    return (
                                        <article
                                            key={paragraph.idx}
                                            data-paragraph-index={paragraph.idx}
                                            data-testid={`reader-paragraph-${paragraph.idx}`}
                                            className={`relative group rounded-2xl border px-4 py-4 sm:px-5 transition-colors duration-200 ${
                                                currentIdx === paragraph.idx
                                                    ? 'border-white/10 bg-zinc-900/50'
                                                    : 'border-transparent'
                                            }`}
                                        >
                                            {/* Paragraph actions: hover/focus on desktop,
                                                always visible for touch pointers. The menu
                                                is the discoverable path to "share paragraph";
                                                selecting text also raises a floating chip. */}
                                            <div className="absolute right-1.5 top-2.5 z-10">
                                                <button
                                                    type="button"
                                                    data-testid={`reader-paragraph-menu-button-${paragraph.idx}`}
                                                    aria-label={t('share.paragraphMenuAria', { index: paragraph.idx + 1 })}
                                                    aria-expanded={menuIdx === paragraph.idx}
                                                    onClick={() => setMenuIdx(menuIdx === paragraph.idx ? null : paragraph.idx)}
                                                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100 [@media(pointer:coarse)]:opacity-100"
                                                >
                                                    <MoreHorizontal className="w-4 h-4" />
                                                </button>
                                                {menuIdx === paragraph.idx && (
                                                    <>
                                                        <div
                                                            className="fixed inset-0 z-10"
                                                            onClick={() => setMenuIdx(null)}
                                                        />
                                                        <div
                                                            data-testid={`reader-paragraph-menu-${paragraph.idx}`}
                                                            className="absolute right-0 top-9 z-20 w-44 p-1 rounded-xl bg-zinc-900/95 backdrop-blur-xl border border-white/10 shadow-2xl shadow-black/60"
                                                        >
                                                            <button
                                                                type="button"
                                                                data-testid={`reader-share-paragraph-${paragraph.idx}`}
                                                                onClick={() => shareParagraph(paragraph)}
                                                                className="flex w-full items-center gap-2 px-3 py-2 rounded-lg text-left text-sm text-zinc-300 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                                            >
                                                                <Share2 className="w-4 h-4" />
                                                                {t('share.menu.paragraph')}
                                                            </button>
                                                        </div>
                                                    </>
                                                )}
                                            </div>
                                            <BilingualRow
                                                twoColumn={bilingualColumns}
                                                testId={`reader-row-${paragraph.idx}`}
                                                english={(
                                                    <p
                                                        data-testid={`reader-en-${paragraph.idx}`}
                                                        data-lookup-context={paragraph.text}
                                                        data-lookup-start={paragraph.idx}
                                                        lang={article.lang || undefined}
                                                        className="ruby-safe-line pr-8 text-base sm:text-[17px] text-zinc-200 break-words"
                                                    >
                                                        <ReadingHighlight
                                                            text={paragraph.text}
                                                            isHighlighted={highlight.isHighlighted}
                                                            languagePoints={languagePointsByParagraph[paragraph.idx]}
                                                            showLanguagePoints={showLanguagePoints}
                                                            wordGlosses={paragraph.glosses}
                                                            onWordClick={(word, e) => onWordLookup(
                                                                word,
                                                                paragraph.text,
                                                                paragraph.idx,
                                                                e,
                                                                article.articleId,
                                                                article.title || t('reader.untitled'),
                                                            )}
                                                        />
                                                    </p>
                                                )}
                                                translation={
                                                    showTranslations && translated ? (
                                                        <p
                                                            data-testid={`reader-translation-${paragraph.idx}`}
                                                            lang={article.targetLang || undefined}
                                                            className="pr-8 text-[15px] leading-relaxed text-zinc-400 break-words"
                                                        >
                                                            {paragraph.translation}
                                                        </p>
                                                    ) : showTranslations && paragraph.translationFailed ? (
                                                        <div className="flex flex-wrap items-center gap-2 pr-8 text-xs text-amber-400/90">
                                                            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                                                            <span>{t('reader.translation.failed')}</span>
                                                            <button
                                                                type="button"
                                                                data-testid={`reader-translation-retry-${paragraph.idx}`}
                                                                onClick={() => { void handleTranslate(); }}
                                                                disabled={translating}
                                                                className="inline-flex items-center gap-1 h-7 px-2 rounded-lg bg-amber-500/10 hover:bg-amber-500/15 border border-amber-500/20 text-amber-300 transition-colors disabled:opacity-50"
                                                            >
                                                                <RefreshCw className="w-3 h-3" />
                                                                {t('reader.translation.retry')}
                                                            </button>
                                                        </div>
                                                    ) : undefined
                                                }
                                            />
                                        </article>
                                    );
                                })}
                            </div>
                        </>
                    ) : (
                        <div
                            data-testid="reader-article-empty"
                            className="flex flex-col items-center justify-center py-24 text-center"
                        >
                            <BookOpen className="w-10 h-10 text-zinc-700 mb-3" />
                            <p className="text-sm font-medium text-zinc-400">{t('reader.detail.missing')}</p>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );

    return (
        <div data-testid="reader-screen" className="h-full min-h-0 flex flex-col bg-[#09090b]">
            {!readingView && (
                <SubHeader
                    title={t('reader.title')}
                    onBack={onClose}
                    parentLabel={parentLabel}
                    backTestId="reader-back-home"
                    titleAs="h1"
                />
            )}
            {readingView || (
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                    <div className="max-w-3xl mx-auto px-4 sm:px-8 py-6 sm:py-10">
                        {listHeader}
                        {loginPanel}
                        {importSection}
                        {articleList}
                    </div>
                </div>
            )}
            {selection && !shareData && (
                <button
                    type="button"
                    data-testid="reader-share-selection-fab"
                    onClick={() => shareSelection()}
                    style={{ left: selection.left, top: selection.top }}
                    className="fixed z-[95] inline-flex items-center gap-1.5 h-8 pl-2.5 pr-3 rounded-lg bg-zinc-100 text-zinc-900 text-xs font-semibold shadow-xl shadow-black/40 active:scale-[0.98] transition-transform duration-150"
                >
                    <Share2 className="w-3.5 h-3.5" />
                    {t('share.action')}
                </button>
            )}
            <ConfirmDialog
                open={pendingDelete !== null}
                title={t('reader.deleteConfirm', {
                    title: pendingDelete?.title || t('reader.untitled'),
                })}
                confirmLabel={t('reader.list.deleteAria', {
                    title: pendingDelete?.title || t('reader.untitled'),
                })}
                destructive
                onConfirm={handleDelete}
                onClose={() => {
                    setPendingDelete(null);
                    setDeleteError(null);
                }}
                error={deleteError}
                testId="article-delete-confirm"
            />
            <ShareCardDialog
                isOpen={shareData !== null}
                data={shareData}
                onClose={() => setShareData(null)}
            />
        </div>
    );
};
