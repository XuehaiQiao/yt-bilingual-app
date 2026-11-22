// Content discovery view (specs/017-discover, frontend).
//
// One job: turn "what do you want to learn?" into 3–5 candidates, then hand the
// chosen YouTube URL to the very same estimate → processing flow as the home
// link input. The backend owns search/caption/rerank honesty rules; this view
// renders exactly what it returns (including "unknown" captions) and never
// invents a candidate.
import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    Captions,
    CheckCircle2,
    Clock,
    Compass,
    HelpCircle,
    Loader2,
    LogIn,
    Play,
    RefreshCw,
    Search,
    SearchX,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
    DiscoverApiError,
    discoverContent,
    formatDiscoverDuration,
    type DiscoverResult,
} from '../lib/discover';
import { loadModel } from '../lib/settings';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { EstimateDialog, type EstimateDialogHandle } from './EstimateDialog';
import { PageContainer } from './layout/PageContainer';
import { SubHeader } from './ui/SubHeader';

interface DiscoverScreenProps {
    /** Back to the home screen; the last result stays in session storage. */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Existing App processing pipeline (same one the home input uses). */
    onStart: (url: string) => void;
    onRequestLogin?: () => void;
    /**
     * Query handed over by the Start-learning "search" mode. When present the
     * view prefills the field and immediately runs the search once, so the
     * user never has to type the topic a second time.
     */
    initialQuery?: string;
    /** Called once the handed-over query has been dispatched. */
    onInitialQueryConsumed?: () => void;
}

interface StoredDiscoverState {
    query: string;
    submittedQuery: string;
    result: DiscoverResult;
}

interface ModelsPayload {
    models?: Array<{ id?: string; available?: boolean }>;
    default?: string;
}

const STORAGE_PREFIX = 'yt_bilingual_discover_last';
const BADGE = 'inline-flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border';

function storageKey(targetLang: string): string {
    return `${STORAGE_PREFIX}:${targetLang}`;
}

/**
 * Keep the last successful result for this tab + target language. Returning
 * from the estimate dialog keeps the mounted component; this also covers
 * leaving the view and coming back ("返回搜索页保留上次结果").
 */
function readStoredState(targetLang: string): StoredDiscoverState | null {
    try {
        const raw = sessionStorage.getItem(storageKey(targetLang));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<StoredDiscoverState>;
        if (typeof parsed.query !== 'string' || typeof parsed.submittedQuery !== 'string') return null;
        if (!parsed.result || !Array.isArray(parsed.result.candidates)) return null;
        return {
            query: parsed.query,
            submittedQuery: parsed.submittedQuery,
            result: parsed.result,
        };
    } catch {
        return null;
    }
}

function writeStoredState(targetLang: string, state: StoredDiscoverState): void {
    try {
        sessionStorage.setItem(storageKey(targetLang), JSON.stringify(state));
    } catch {
        // Private mode / storage full: results still live in React state.
    }
}

function errorKeyForStatus(status: number): TranslationKey {
    switch (status) {
        case 0:
            return 'discover.error.network';
        case 400:
            return 'discover.error.invalid';
        case 403:
            return 'discover.error.login';
        case 429:
            return 'discover.error.rateLimited';
        case 503:
            return 'discover.error.unavailable';
        case 504:
            return 'discover.error.timeout';
        default:
            return 'discover.error.unknown';
    }
}

export function DiscoverScreen({
    onClose,
    parentLabel,
    onStart,
    onRequestLogin,
    initialQuery,
    onInitialQueryConsumed,
}: DiscoverScreenProps) {
    const { t, language, targetLang } = useI18n();
    const handedOverQuery = initialQuery?.trim() ?? '';

    // Lazy initial state so re-entering the view shows the previous result;
    // a query handed over by the Start-learning input wins over that cache.
    const [initial] = useState(() => readStoredState(targetLang));
    const [query, setQuery] = useState(handedOverQuery || initial?.query || '');
    const [submittedQuery, setSubmittedQuery] = useState(handedOverQuery || initial?.submittedQuery || '');
    const [result, setResult] = useState<DiscoverResult | null>(initial?.result ?? null);
    const [isLoading, setIsLoading] = useState(false);
    const [errorStatus, setErrorStatus] = useState<number | null>(null);
    const [currentModelId, setCurrentModelId] = useState(loadModel);

    const requestIdRef = useRef(0);
    const loadingRef = useRef(false);
    const inputRef = useRef<HTMLInputElement>(null);
    const estimateRef = useRef<EstimateDialogHandle>(null);

    useEffect(() => {
        inputRef.current?.focus();
    }, []);

    // Invalidate any in-flight response when the view unmounts.
    useEffect(() => () => {
        requestIdRef.current += 1;
    }, []);

    // The estimate dialog names the model that will actually run. When the
    // user never picked one, mirror ModelBar's "saved → backend default →
    // first usable" resolution without persisting it as a user choice.
    useEffect(() => {
        if (currentModelId) return;
        let cancelled = false;
        apiFetch('/api/models')
            .then((response) => (response.ok ? response.json() : null))
            .then((data: ModelsPayload | null) => {
                if (cancelled || !data) return;
                const catalog = Array.isArray(data.models) ? data.models : [];
                const saved = loadModel();
                const savedModel = catalog.find((model) => model.id === saved);
                const fallback =
                    catalog.find((model) => model.id === data.default && model.available) ||
                    catalog.find((model) => model.id === data.default) ||
                    catalog.find((model) => model.available) ||
                    catalog[0];
                const resolved = savedModel ?? fallback;
                if (resolved?.id) setCurrentModelId(resolved.id);
            })
            .catch(() => {
                // Keep the dialog's "未选择" hint; the estimate itself still works.
            });
        return () => {
            cancelled = true;
        };
    }, [currentModelId]);

    const runSearch = async (rawQuery: string, force: boolean) => {
        const normalized = rawQuery.trim();
        if (!normalized || loadingRef.current) return;
        loadingRef.current = true;
        const requestId = requestIdRef.current + 1;
        requestIdRef.current = requestId;
        setQuery(normalized);
        setSubmittedQuery(normalized);
        setIsLoading(true);
        setErrorStatus(null);
        try {
            const data = await discoverContent(normalized, targetLang, force);
            if (requestId !== requestIdRef.current) return;
            setResult(data);
            writeStoredState(targetLang, {
                query: normalized,
                submittedQuery: normalized,
                result: data,
            });
        } catch (err) {
            if (requestId !== requestIdRef.current) return;
            setErrorStatus(err instanceof DiscoverApiError ? err.status : 0);
        } finally {
            loadingRef.current = false;
            if (requestId === requestIdRef.current) setIsLoading(false);
        }
    };

    const handleSubmit = (event: FormEvent) => {
        event.preventDefault();
        void runSearch(query, false);
    };

    // Handover from the Start-learning "search" mode: prefill already happened
    // in state, and this runs the search once on mount. The zero-delay timer
    // (cleared by the effect cleanup) keeps React StrictMode's double effect
    // from firing the request twice.
    useEffect(() => {
        if (!handedOverQuery) return;
        const timer = window.setTimeout(() => {
            onInitialQueryConsumed?.();
            void runSearch(handedOverQuery, false);
        }, 0);
        return () => window.clearTimeout(timer);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    const handleRetry = () => {
        void runSearch(submittedQuery || query, false);
    };

    // "换一批": same topic, bypass the backend's 24h cache.
    const handleForceRefresh = () => {
        void runSearch(submittedQuery || query, true);
    };

    const openCandidate = (videoId: string) => {
        estimateRef.current?.estimate(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    };

    const candidateCount = result?.candidates.length ?? 0;

    return (
        <div
            data-testid="discover-screen"
            className="flex-1 min-h-0 flex flex-col bg-[#09090b]"
        >
            <SubHeader
                title={t('discover.title')}
                onBack={onClose}
                parentLabel={parentLabel}
                backTestId="discover-back"
            />
            <EstimateDialog
                ref={estimateRef}
                currentModelId={currentModelId}
                onStart={onStart}
            />

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
            <PageContainer
                variant="standard"
                testId="discover-page-container"
                className="py-5 sm:py-8"
            >
                <header className="mt-0 flex items-start gap-3">
                    <div className="w-10 h-10 rounded-xl bg-brand/10 border border-brand/20 flex items-center justify-center shrink-0">
                        <Compass className="w-5 h-5 text-brand-300" />
                    </div>
                    <div className="min-w-0">
                        <p className="text-ui leading-relaxed text-fg-secondary">
                            {t('discover.subtitle')}
                        </p>
                    </div>
                </header>

                <section className="mt-5 rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5">
                    <form onSubmit={handleSubmit}>
                        <label htmlFor="discover-query" className="sr-only">
                            {t('discover.input.label')}
                        </label>
                        <div className="flex items-center gap-2 rounded-full bg-zinc-900/60 p-1.5 pl-4 sm:pl-5 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                            <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                            <input
                                id="discover-query"
                                ref={inputRef}
                                data-testid="discover-query-input"
                                type="text"
                                maxLength={200}
                                enterKeyHint="search"
                                autoComplete="off"
                                value={query}
                                onChange={(event) => setQuery(event.target.value)}
                                placeholder={t('discover.input.placeholder')}
                                className="w-full min-w-0 bg-transparent border-none outline-none focus:outline-none text-zinc-100 placeholder-zinc-500 px-2 py-2.5 text-sm sm:text-base"
                            />
                            <button
                                type="submit"
                                data-testid="discover-submit"
                                aria-label={t('discover.submit')}
                                disabled={isLoading || query.trim() === ''}
                                className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 h-9 px-3 sm:px-4 rounded-full bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50"
                            >
                                {isLoading
                                    ? <Loader2 className="w-4 h-4 animate-spin" />
                                    : <Search className="w-4 h-4 sm:hidden" />}
                                <span className="hidden sm:inline">{t('discover.submit')}</span>
                            </button>
                        </div>
                    </form>
                    <p className="mt-2.5 text-xs leading-relaxed text-zinc-500 break-words">
                        {t('discover.input.examples')}
                    </p>
                    <p className="mt-1 text-[11px] leading-relaxed text-zinc-600 break-words">
                        {t('discover.input.hint')}
                    </p>
                </section>

                {isLoading ? (
                    <section
                        data-testid="discover-loading"
                        role="status"
                        aria-live="polite"
                        className="mt-6"
                    >
                        <div className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                            <span>{t('discover.loading.title')}</span>
                        </div>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                            {t('discover.loading.hint')}
                        </p>
                        <div className="mt-4 space-y-2.5">
                            {[0, 1, 2].map((index) => (
                                <div
                                    key={index}
                                    className="flex gap-3 rounded-xl border border-white/5 bg-zinc-900/40 p-3 motion-safe:animate-pulse"
                                >
                                    <div className="w-24 sm:w-40 aspect-video rounded-lg bg-zinc-800/70 shrink-0" />
                                    <div className="flex-1 min-w-0 space-y-2 py-1">
                                        <div className="h-4 w-3/4 rounded bg-zinc-800/70" />
                                        <div className="h-3 w-1/2 rounded bg-zinc-800/60" />
                                        <div className="h-3 w-full rounded bg-zinc-800/50" />
                                    </div>
                                </div>
                            ))}
                        </div>
                    </section>
                ) : errorStatus !== null ? (
                    <section
                        data-testid="discover-error"
                        className="mt-6 rounded-2xl border border-amber-500/20 bg-amber-500/[0.06] p-5"
                    >
                        <div className="flex items-start gap-3">
                            <AlertCircle className="w-5 h-5 text-amber-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                                <h3 className="text-sm font-semibold text-zinc-100">
                                    {t('discover.error.title')}
                                </h3>
                                <p
                                    data-testid="discover-error-message"
                                    className="mt-1 text-xs leading-relaxed text-zinc-400 break-words"
                                >
                                    {t(errorKeyForStatus(errorStatus))}
                                </p>
                                <div className="mt-4 flex flex-wrap items-center gap-2">
                                    <button
                                        type="button"
                                        data-testid="discover-retry"
                                        onClick={handleRetry}
                                        disabled={isLoading}
                                        className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50"
                                    >
                                        <RefreshCw className="w-4 h-4" />
                                        {t('common.retry')}
                                    </button>
                                    {errorStatus === 403 && onRequestLogin && (
                                        <button
                                            type="button"
                                            data-testid="discover-login"
                                            onClick={onRequestLogin}
                                            className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-sm font-medium text-blue-300 hover:text-blue-200 transition-colors"
                                        >
                                            <LogIn className="w-4 h-4" />
                                            {t('discover.login')}
                                        </button>
                                    )}
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="inline-flex items-center gap-2 h-9 px-4 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                    >
                                        <ArrowLeft className="w-4 h-4" />
                                        {t('discover.back')}
                                    </button>
                                </div>
                            </div>
                        </div>
                    </section>
                ) : result ? (
                    <section
                        data-testid="discover-results"
                        aria-live="polite"
                        className="mt-6"
                    >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                            <div className="min-w-0">
                                <h3
                                    data-testid="discover-results-title"
                                    className="text-[17px] font-semibold tracking-tight text-zinc-100"
                                >
                                    {candidateCount === 0
                                        ? t('discover.empty.heading')
                                        : t('discover.results.title', { count: candidateCount })}
                                </h3>
                                <p className="mt-0.5 text-xs text-zinc-500 break-words">
                                    {t('discover.results.query', { query: submittedQuery })}
                                </p>
                            </div>
                            <button
                                type="button"
                                data-testid="discover-force-refresh"
                                onClick={handleForceRefresh}
                                disabled={isLoading || submittedQuery.trim() === ''}
                                className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50"
                            >
                                <RefreshCw className="w-4 h-4" />
                                {t('discover.results.force')}
                            </button>
                        </div>

                        {result.degraded && (
                            <div
                                data-testid="discover-degraded"
                                className="mt-3 flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/[0.06] px-3 py-2 text-xs leading-relaxed text-amber-400"
                            >
                                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                                <span>{t('discover.results.degraded')}</span>
                            </div>
                        )}

                        {result.cached && (
                            <p
                                data-testid="discover-cached"
                                className="mt-3 text-[11px] leading-relaxed text-zinc-500"
                            >
                                {t('discover.results.cached')}
                            </p>
                        )}

                        {candidateCount > 0 && candidateCount < 3 && (
                            <p className="mt-3 text-xs leading-relaxed text-amber-400/90">
                                {t('discover.results.partial', { count: candidateCount })}
                            </p>
                        )}

                        {candidateCount === 0 ? (
                            <div
                                data-testid="discover-empty"
                                className="mt-4 flex flex-col items-center justify-center rounded-2xl border border-white/5 bg-zinc-900/40 px-4 py-12 text-center"
                            >
                                <SearchX className="w-10 h-10 text-zinc-700 mb-3" />
                                <p className="text-sm font-medium text-zinc-400">
                                    {t('discover.empty.title')}
                                </p>
                                <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-500">
                                    {t('discover.empty.hint')}
                                </p>
                                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                                    <button
                                        type="button"
                                        data-testid="discover-empty-retry"
                                        onClick={handleRetry}
                                        className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                                    >
                                        <RefreshCw className="w-4 h-4" />
                                        {t('common.retry')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={onClose}
                                        className="inline-flex items-center gap-2 h-9 px-4 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                    >
                                        <ArrowLeft className="w-4 h-4" />
                                        {t('discover.back')}
                                    </button>
                                </div>
                            </div>
                        ) : (
                            <div className="mt-4 space-y-2.5">
                                {result.candidates.map((candidate, index) => {
                                    const title = candidate.title.trim() || t('discover.card.untitled');
                                    const channel = candidate.channel.trim() || t('discover.card.unknownChannel');
                                    const duration = formatDiscoverDuration(candidate.duration);
                                    return (
                                        <button
                                            key={`${candidate.videoId}-${index}`}
                                            type="button"
                                            data-testid={`discover-candidate-${index}`}
                                            data-video-id={candidate.videoId}
                                            aria-label={t('discover.card.selectAria', { title })}
                                            onClick={() => openCandidate(candidate.videoId)}
                                            className="group w-full text-left p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors cursor-pointer"
                                        >
                                            <div className="flex items-start gap-3">
                                                <div className="relative w-24 sm:w-40 shrink-0 aspect-video rounded-lg overflow-hidden bg-zinc-900 border border-white/5">
                                                    <Play className="absolute inset-0 m-auto w-6 h-6 text-zinc-700" />
                                                    {candidate.thumbnail && (
                                                        <img
                                                            src={candidate.thumbnail}
                                                            alt=""
                                                            loading="lazy"
                                                            decoding="async"
                                                            className="relative w-full h-full object-cover"
                                                            onError={(event) => {
                                                                event.currentTarget.style.display = 'none';
                                                            }}
                                                        />
                                                    )}
                                                </div>
                                                <div className="min-w-0 flex-1">
                                                    <div className="flex items-start justify-between gap-2">
                                                        <h4 className="min-w-0 text-sm sm:text-[15px] font-medium leading-snug text-zinc-100 line-clamp-2 break-words">
                                                            {title}
                                                        </h4>
                                                        {candidate.level && (
                                                            <span
                                                                data-testid={`discover-level-${index}`}
                                                                title={t('discover.card.levelAria', { level: candidate.level })}
                                                                className="shrink-0 inline-flex items-center rounded-md border border-white/10 bg-zinc-800/70 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 tabular-nums"
                                                            >
                                                                {candidate.level}
                                                            </span>
                                                        )}
                                                    </div>
                                                    <p className="mt-1 text-xs text-zinc-500 truncate">
                                                        {channel}
                                                    </p>
                                                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                                                        {duration && (
                                                            <span
                                                                data-testid={`discover-duration-${index}`}
                                                                className="inline-flex items-center gap-1 text-[11px] font-medium text-zinc-500 tabular-nums"
                                                            >
                                                                <Clock className="w-3 h-3" />
                                                                {duration}
                                                            </span>
                                                        )}
                                                        <span
                                                            data-testid={`discover-subtitles-${index}`}
                                                            data-state={candidate.hasEnglishSubs ? 'available' : 'unknown'}
                                                            className={`${BADGE} ${candidate.hasEnglishSubs
                                                                ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                                                                : 'bg-amber-500/10 border-amber-500/20 text-amber-400'
                                                            }`}
                                                        >
                                                            {candidate.hasEnglishSubs
                                                                ? <Captions className="w-3 h-3" />
                                                                : <HelpCircle className="w-3 h-3" />}
                                                            {candidate.hasEnglishSubs
                                                                ? t('discover.card.subtitles')
                                                                : t('discover.card.subtitlesUnknown')}
                                                        </span>
                                                        {candidate.alreadyProcessed && (
                                                            <span
                                                                data-testid={`discover-processed-${index}`}
                                                                className={`${BADGE} bg-emerald-500/10 border-emerald-500/20 text-emerald-400`}
                                                            >
                                                                <CheckCircle2 className="w-3 h-3" />
                                                                {t('discover.card.processed')}
                                                            </span>
                                                        )}
                                                    </div>
                                                    {candidate.reason && (
                                                        <p
                                                            data-testid={`discover-reason-${index}`}
                                                            className="mt-1.5 text-xs leading-relaxed text-zinc-400 line-clamp-2 break-words"
                                                        >
                                                            {candidate.reason}
                                                        </p>
                                                    )}
                                                    <span className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-blue-400 group-hover:text-blue-300 transition-colors">
                                                        {t('discover.card.select')}
                                                        <ArrowRight className="w-3.5 h-3.5" />
                                                    </span>
                                                </div>
                                            </div>
                                        </button>
                                    );
                                })}
                            </div>
                        )}

                        {candidateCount > 0 && (
                            <p className="mt-4 text-[11px] leading-relaxed text-zinc-600 break-words">
                                {language === 'zh-CN' && result.disclaimer
                                    ? result.disclaimer
                                    : t('discover.disclaimer')}
                            </p>
                        )}
                    </section>
                ) : null}
            </PageContainer>
            </div>
        </div>
    );
}
