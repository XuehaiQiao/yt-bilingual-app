// Content — first-level page (P0 IA §3.2).
//
// "What do I learn?" — paste a link (main action), discover/read secondary
// entries, the materials shelf (local shows + sentence packs), the free
// library, rule recommendations, subscription updates and the public blog
// footer. Every block reuses the existing component: this page only arranges
// them and routes the callbacks. The CEFR vocabulary axis now lives in 我的 ·
// 设置 (AccountScreen), not here.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ArrowRight,
    Bell,
    BookOpen,
    CalendarRange,
    Compass,
    Newspaper,
    Play,
    Rss,
    Tv,
    Youtube,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { blogFeedUrl } from '../lib/blog';
import { progressPercent } from '../lib/progress';
import type { HistoryItem } from './ChannelVideoList';
import type { EstimateDialogHandle } from './EstimateDialog';
import { EstimateDialog } from './EstimateDialog';
import { StartLearning } from './StartLearning';
import { ShowBrowser } from './ShowBrowser';
import { SentencePacks } from './SentencePacks';
import { LibrarySection } from './LibrarySection';
import { BooksSection } from './BooksSection';
import { HomeRecommendations } from './HomeRecommendations';
import { EmptyState, ErrorPanel, LoadingState, RefreshingState } from './ui/StateView';
import { PageHeader } from './ui/PageHeader';
import { Card, SectionHeader } from './ui/Card';
import { ShelfSection } from './ui/ShelfSection';
import { ListRow } from './ui/ListRow';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';

const PAGE_PAD = 'pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10';

interface ChannelUpdate {
    videoId: string;
    title: string;
    channel?: string;
    thumbnail?: string;
}

interface ContentScreenProps {
    isGuest: boolean;
    busy: boolean;
    subscriptions: { id: string; name: string }[];
    onSelectEpisode: (showId: string, season: number, episode: number) => void;
    onSelectChannel: (name: string) => void;
    onUnsubscribe: (id: string) => void;
    onSubmitUrl: (url: string) => void;
    onSearch: (query: string) => void;
    onRead: (value: string) => void;
    onOpenLibraryVideo: (id: string) => void;
    onOpenLibraryArticle: (id: string) => void;
    onOpenBook: (id: string) => void;
    onOpenBookSeries: (id: string) => void;
    onOpenImportedBook: (id: string) => void;
    /** A public-domain book link handed over from the article reader. */
    bookImportSeed?: { url: string; nonce: number } | null;
    onBookImportSeedConsumed?: () => void;
    onOpenDiscover: () => void;
    onOpenReader: () => void;
    onOpenSentences: (levelId: number) => void;
    onOpenBlog: () => void;
    onOpenReport: () => void;
    onLoadHistory: (filename: string) => void;
    onRequestLogin: () => void;
}

export function ContentScreen({
    isGuest,
    busy,
    subscriptions,
    onSelectEpisode,
    onSelectChannel,
    onUnsubscribe,
    onSubmitUrl,
    onSearch,
    onRead,
    onOpenLibraryVideo,
    onOpenLibraryArticle,
    onOpenBook,
    onOpenBookSeries,
    onOpenImportedBook,
    bookImportSeed,
    onBookImportSeedConsumed,
    onOpenDiscover,
    onOpenReader,
    onOpenSentences,
    onOpenBlog,
    onOpenReport,
    onLoadHistory,
    onRequestLogin,
}: ContentScreenProps) {
    const { t, formatNumber } = useI18n();
    const estimateRef = useRef<EstimateDialogHandle>(null);
    // Right rail: the last opened item and this week's three facts. Each block
    // owns one async state (IX-01) — a failed read is an error panel with a
    // retry, never the "暂无记录 / 本周还没有数据" empty copy.
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [historyReloadToken, setHistoryReloadToken] = useState(0);
    const [weekReport, setWeekReport] = useState<{
        passiveMinutes: number;
        reviewedWords: number;
        quizAccuracy: number | null;
    } | null>(null);
    const [weekState, setWeekState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [weekReloadToken, setWeekReloadToken] = useState(0);
    const [channelUpdates, setChannelUpdates] = useState<ChannelUpdate[]>([]);
    const [updatesState, setUpdatesState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
    const [updatesReloadToken, setUpdatesReloadToken] = useState(0);
    // Unsubscribing hides the list immediately; no effect-level reset needed.
    const hasSubscriptions = subscriptions.length > 0;
    const visibleUpdates = hasSubscriptions ? channelUpdates : [];
    const showUpdatesLoading = hasSubscriptions && updatesState === 'loading';
    const retryHistory = useCallback(() => {
        setHistoryState('loading');
        setHistoryReloadToken((token) => token + 1);
    }, []);
    const retryWeek = useCallback(() => {
        setWeekState('loading');
        setWeekReloadToken((token) => token + 1);
    }, []);
    const retryUpdates = useCallback(() => {
        setUpdatesState('loading');
        setUpdatesReloadToken((token) => token + 1);
    }, []);

    useEffect(() => {
        let cancelled = false;
        apiFetch('/api/history')
            .then(async (response) => {
                if (!response.ok) throw new Error(await describeApiError(response));
                const data = await response.json();
                if (!Array.isArray(data)) throw new Error('invalid history payload');
                return data;
            })
            .then((data) => {
                if (cancelled) return;
                setHistory(data);
                setHistoryState('ready');
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('Failed to fetch history for content rail:', err);
                setHistoryState('error');
            });
        return () => { cancelled = true; };
    }, [historyReloadToken]);

    useEffect(() => {
        let cancelled = false;
        apiFetch('/api/report/week')
            .then(async response => {
                if (!response.ok) throw new Error(await describeApiError(response));
                return response.json();
            })
            .then((data) => {
                if (cancelled) return;
                const numbers = data?.numbers;
                if (!numbers || typeof numbers.passiveMinutes !== 'number') {
                    throw new Error('invalid report payload');
                }
                setWeekReport({
                    passiveMinutes: numbers.passiveMinutes,
                    reviewedWords: typeof numbers.reviewedWords === 'number' ? numbers.reviewedWords : 0,
                    quizAccuracy: typeof numbers.quizAccuracy === 'number' ? numbers.quizAccuracy : null,
                });
                setWeekState('ready');
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('Failed to load weekly report for content rail:', err);
                setWeekState('error');
            });
        return () => { cancelled = true; };
    }, [weekReloadToken]);

    const latestHistory = history[0] ?? null;
    const latestProgress = latestHistory?.videoId ? progressPercent(latestHistory.videoId) : null;

    useEffect(() => {
        let cancelled = false;
        if (subscriptions.length === 0) {
            // Rendered list is derived below (`visibleUpdates`), so there is
            // nothing to reset here; skipping the request keeps effects clean.
            return () => { cancelled = true; };
        }
        // Loader flag for the fetch below; the network is the external system
        // this effect syncs with (same pattern as the other data cards).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUpdatesState('loading');
        apiFetch('/api/channel-updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channels: subscriptions.map(sub => sub.id) }),
        })
            .then(async (response) => {
                if (!response.ok) throw new Error(await describeApiError(response));
                const data = await response.json();
                if (!Array.isArray(data?.updates)) throw new Error('invalid channel updates payload');
                return data.updates as ChannelUpdate[];
            })
            .then((updates) => {
                if (cancelled) return;
                setChannelUpdates(updates);
                setUpdatesState('ready');
            })
            .catch((err) => {
                if (cancelled) return;
                console.error('Failed to fetch channel updates:', err);
                setUpdatesState('error');
            });
        return () => { cancelled = true; };
    }, [subscriptions, updatesReloadToken]);

    const estimate = useCallback((url: string) => {
        estimateRef.current?.estimate(url);
    }, []);

    // Discovery needs an account (403 by contract): prompt before entering
    // the screen instead of letting the guest hit an empty search page.
    const handleDiscover = () => {
        if (isGuest) {
            onRequestLogin();
            return;
        }
        onOpenDiscover();
    };

    return (
        <div
            data-testid="content-screen"
            data-page-scroll
            className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] ${PAGE_PAD}`}
        >
            <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-5 sm:pt-8">
                <EstimateDialog ref={estimateRef} onStart={onSubmitUrl} />

                <PageHeader
                    testId="content-page-header"
                    titleTestId="content-title"
                    title={t('content.title')}
                    subtitle={t('content.subtitle')}
                />

                <div className="mt-5 sm:mt-6 lg:mt-6 flex flex-col gap-6 sm:gap-8 xl:grid xl:grid-cols-[minmax(0,1fr)_320px] xl:gap-8 xl:items-start">
                {/* Main action: paste a link (same estimate pipeline as Today). */}
                <div data-testid="content-start-input" className="min-w-0 xl:col-start-1 xl:row-start-1">
                    <StartLearning
                        variant="primary"
                        disabled={busy}
                        onEstimate={estimate}
                        onSearch={onSearch}
                        onRead={onRead}
                    >
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                            <div className="flex items-center gap-x-2">
                                <span>{t('home.discover.prompt')}</span>
                                <button
                                    type="button"
                                    data-testid="discover-entry"
                                    onClick={handleDiscover}
                                    className="inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                >
                                    <Compass className="w-3.5 h-3.5" />
                                    {t('home.discover.action')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                            <span aria-hidden="true" className="hidden sm:block w-px h-3 bg-white/10" />
                            <div className="flex items-center gap-x-2">
                                <span>{t('home.reader.prompt')}</span>
                                <button
                                    type="button"
                                    data-testid="reader-entry"
                                    onClick={onOpenReader}
                                    className="inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                >
                                    <BookOpen className="w-3.5 h-3.5" />
                                    {t('home.reader.action')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </StartLearning>
                </div>

                {/* Right rail (≥xl): last opened item, week facts.
                    Below xl it stacks between the main action and the shelf.
                    (The CEFR axis moved to 我的 · 设置.) */}
                <aside
                    data-testid="content-rail"
                    className="min-w-0 grid grid-cols-1 sm:grid-cols-2 xl:flex xl:flex-col gap-4 sm:gap-5 xl:col-start-2 xl:row-start-1 xl:row-span-2"
                >
                    {/* Continue: the most recent item, one tap back into it. */}
                    <Card as="section" testId="content-rail-continue" className="min-w-0">
                        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100">
                            <Play className="w-4 h-4 text-blue-400 fill-current" />
                            {t('content.rail.continueTitle')}
                        </h2>
                        {latestHistory ? (
                            <>
                            {historyState === 'error' && (
                                <ErrorPanel
                                    level="inline"
                                    title={t('today.recent.errorTitle')}
                                    onRetry={retryHistory}
                                    retryLabel={t('common.retry')}
                                    retryTestId="content-rail-continue-retry"
                                    testId="content-rail-continue-error"
                                    className="mt-3"
                                />
                            )}
                            <ListRow
                                className="mt-3 gap-3"
                                onClick={() => onLoadHistory(latestHistory.filename)}
                                leading={
                                    <span className="relative block w-20 aspect-video rounded-lg overflow-hidden bg-zinc-800">
                                        {latestHistory.metadata?.thumbnail && (
                                            <img src={latestHistory.metadata.thumbnail} alt="" className="w-full h-full object-cover" />
                                        )}
                                        {latestProgress !== null && (
                                            <span className="absolute bottom-0 inset-x-0 h-1 bg-black/60">
                                                <span className="block h-full bg-emerald-500" style={{ width: `${latestProgress}%` }} />
                                            </span>
                                        )}
                                    </span>
                                }
                                title={latestHistory.metadata?.title || t('common.unknownVideo')}
                                titleClassName="line-clamp-2 break-words"
                                subtitle={
                                    <span className="inline-flex items-center gap-1">
                                        {t('content.rail.continueAction')}
                                        <ArrowRight className="w-3.5 h-3.5" />
                                    </span>
                                }
                                subtitleClassName="mt-1 text-brand-300"
                            />
                            </>
                        ) : historyState === 'loading' ? (
                            <LoadingState
                                kind="spinner"
                                label={t('common.loading')}
                                testId="content-rail-continue-loading"
                                className="mt-3"
                            />
                        ) : historyState === 'error' ? (
                            <ErrorPanel
                                level="inline"
                                title={t('today.recent.errorTitle')}
                                onRetry={retryHistory}
                                retryLabel={t('common.retry')}
                                retryTestId="content-rail-continue-retry"
                                testId="content-rail-continue-error"
                                className="mt-3"
                            />
                        ) : (
                            <EmptyState
                                size="inline"
                                icon={Play}
                                title={t('content.rail.continueEmpty')}
                                testId="content-rail-continue-empty"
                            />
                        )}
                    </Card>

                    {/* This week: same three numbers as 我的·本周报告. */}
                    <Card as="section" testId="content-rail-week" className="min-w-0">
                        <h2 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100">
                            <CalendarRange className="w-4 h-4 text-blue-400" />
                            {t('content.rail.weekTitle')}
                        </h2>
                        {weekReport ? (
                            <>
                            {weekState === 'error' && (
                                <ErrorPanel
                                    level="inline"
                                    title={t('home.today.reportFailed')}
                                    onRetry={retryWeek}
                                    retryLabel={t('common.retry')}
                                    retryTestId="content-rail-week-retry"
                                    testId="content-rail-week-error"
                                    className="mt-3"
                                />
                            )}
                            <div className="mt-3 grid grid-cols-3 gap-1.5">
                                <Card variant="stat" padding="none" className="min-w-0 px-2 py-1.5">
                                    <p className="truncate text-[10px] font-medium text-zinc-500">{t('content.rail.weekMinutes')}</p>
                                    <p className="mt-0.5 truncate text-sm font-semibold text-zinc-100 tabular-nums">
                                        {formatNumber(weekReport.passiveMinutes)}
                                        <span className="ml-0.5 text-[10px] font-medium text-zinc-500">{t('home.today.minutesUnit')}</span>
                                    </p>
                                </Card>
                                <Card variant="stat" padding="none" className="min-w-0 px-2 py-1.5">
                                    <p className="truncate text-[10px] font-medium text-zinc-500">{t('content.rail.weekReviewed')}</p>
                                    <p className="mt-0.5 truncate text-sm font-semibold text-zinc-100 tabular-nums">
                                        {formatNumber(weekReport.reviewedWords)}
                                        <span className="ml-0.5 text-[10px] font-medium text-zinc-500">{t('home.today.wordsUnit')}</span>
                                    </p>
                                </Card>
                                <Card variant="stat" padding="none" className="min-w-0 px-2 py-1.5">
                                    <p className="truncate text-[10px] font-medium text-zinc-500">{t('content.rail.weekAccuracy')}</p>
                                    <p className="mt-0.5 truncate text-sm font-semibold text-zinc-100 tabular-nums">
                                        {weekReport.quizAccuracy === null ? '—' : `${Math.round(weekReport.quizAccuracy * 100)}%`}
                                    </p>
                                </Card>
                            </div>
                            </>
                        ) : weekState === 'loading' ? (
                            <LoadingState
                                kind="spinner"
                                label={t('common.loading')}
                                testId="content-rail-week-loading"
                                className="mt-3"
                            />
                        ) : weekState === 'error' ? (
                            <ErrorPanel
                                level="inline"
                                title={t('home.today.reportFailed')}
                                onRetry={retryWeek}
                                retryLabel={t('common.retry')}
                                retryTestId="content-rail-week-retry"
                                testId="content-rail-week-error"
                                className="mt-3"
                            />
                        ) : (
                            <EmptyState
                                size="inline"
                                title={t('content.rail.weekEmpty')}
                                testId="content-rail-week-empty"
                            />
                        )}
                        <button
                            type="button"
                            data-testid="content-rail-report-link"
                            onClick={onOpenReport}
                            className="mt-3 inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg text-[11px] font-medium text-blue-300 hover:text-blue-200 hover:bg-white/5 transition-colors"
                        >
                            {t('content.rail.weekReport')}
                            <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                    </Card>
                </aside>

                {/* Main column (≥xl) / the rest of the single column below. */}
                <div
                    data-testid="content-main"
                    className="min-w-0 flex flex-col gap-6 sm:gap-8 xl:col-start-1 xl:row-start-2"
                >
                {/* Materials shelf: local shows + sentence packs. */}
                <section data-testid="content-materials">
                    <SectionHeader title={t('content.materials')} />
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-1 gap-4 sm:gap-6">
                        <ShelfSection
                            icon={Tv}
                            title={t('content.showsTitle')}
                            hint={t('content.showsHint')}
                            testId="content-local-shows"
                        >
                            <ShowBrowser onSelectEpisode={onSelectEpisode} isLoading={busy} />
                        </ShelfSection>
                        {/* SentencePacks is already a card with its own heading;
                            keep it as the grid cell to avoid nesting two cards. */}
                        <div className="min-w-0" data-testid="content-sentence-packs">
                            <SentencePacks onSelectLevel={onOpenSentences} />
                        </div>
                    </div>
                </section>

                {/* Free library: pre-built videos + original articles. */}
                <section data-testid="content-library">
                    <LibrarySection
                        onOpenVideo={onOpenLibraryVideo}
                        onOpenArticle={onOpenLibraryArticle}
                    />
                </section>

                {/* Public-domain books: 3 launch series, source fetched on demand. */}
                <section data-testid="content-books">
                    <BooksSection
                        onOpenBook={onOpenBook}
                        onOpenSeries={onOpenBookSeries}
                        onOpenImportedBook={onOpenImportedBook}
                        onRequestLogin={onRequestLogin}
                        isGuest={isGuest}
                        importSeed={bookImportSeed}
                        onImportSeedConsumed={onBookImportSeedConsumed}
                    />
                </section>

                {/* Rule recommendations. */}
                <section>
                    <HomeRecommendations onSelect={estimate} />
                </section>

                {/* Subscriptions + latest videos (merged card). */}
                <section data-testid="content-subscriptions">
                    <SectionHeader title={t('content.subscriptionsTitle')} />
                    <Card className="mt-3">
                        {subscriptions.length === 0 ? (
                            <EmptyState
                                size="inline"
                                icon={Bell}
                                title={t('content.noSubscriptions')}
                                testId="content-subscriptions-empty"
                            />
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    {subscriptions.slice(0, 6).map(sub => (
                                        <span
                                            key={sub.id}
                                            className="inline-flex items-center h-8 rounded-lg bg-zinc-800/60 border border-white/5 text-sm font-medium text-zinc-300"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => onSelectChannel(sub.name)}
                                                className="h-full px-3 rounded-l-lg hover:bg-zinc-700/60 hover:text-zinc-100 transition-colors"
                                            >
                                                {sub.name}
                                            </button>
                                            <button
                                                type="button"
                                                data-testid={`unsubscribe-${sub.id}`}
                                                onClick={() => onUnsubscribe(sub.id)}
                                                aria-label={t('content.unsubscribe', { channel: sub.name })}
                                                title={t('content.unsubscribe', { channel: sub.name })}
                                                className="h-full px-2 rounded-r-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-700/60 border-l border-white/5 transition-colors"
                                            >
                                                ×
                                            </button>
                                        </span>
                                    ))}
                                </div>

                                <div className="mt-4 flex items-center gap-2">
                                    <Bell className="w-4 h-4 text-amber-400 shrink-0" />
                                    <h3 className="text-[13px] font-semibold tracking-tight text-zinc-200">
                                        {t('content.latestVideos')}
                                    </h3>
                                    {showUpdatesLoading && visibleUpdates.length > 0 && (
                                        <RefreshingState
                                            label={t('common.loading')}
                                            testId="content-updates-refreshing"
                                        />
                                    )}
                                </div>
                                <div className="mt-2 max-h-72 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                                    {updatesState === 'error' && visibleUpdates.length > 0 && (
                                        <ErrorPanel
                                            level="inline"
                                            title={t('errors.unknown')}
                                            onRetry={retryUpdates}
                                            retryLabel={t('common.retry')}
                                            retryTestId="content-updates-retry"
                                            testId="content-updates-stale-error"
                                        />
                                    )}
                                    {visibleUpdates.length === 0 && showUpdatesLoading ? (
                                        <LoadingState
                                            kind="skeleton"
                                            rows={2}
                                            label={t('common.loading')}
                                            testId="content-updates-loading"
                                        />
                                    ) : visibleUpdates.length === 0 && updatesState === 'error' ? (
                                        <ErrorPanel
                                            level="inline"
                                            title={t('errors.unknown')}
                                            onRetry={retryUpdates}
                                            retryLabel={t('common.retry')}
                                            retryTestId="content-updates-retry"
                                            testId="content-updates-error"
                                        />
                                    ) : visibleUpdates.length === 0 ? (
                                        <EmptyState
                                            size="inline"
                                            title={t('home.noUploads')}
                                            testId="content-updates-empty"
                                        />
                                    ) : (
                                        visibleUpdates.map((update, index) => (
                                            <ListRow
                                                key={`${update.videoId}-${index}`}
                                                className="gap-3"
                                                onClick={() => estimate(`https://youtube.com/watch?v=${update.videoId}`)}
                                                leading={
                                                    <span className="relative block w-24 aspect-video overflow-hidden rounded-lg bg-zinc-800">
                                                        {update.thumbnail && <img src={update.thumbnail} className="w-full h-full object-cover" alt="" />}
                                                    </span>
                                                }
                                                title={update.title}
                                                titleClassName="line-clamp-2"
                                                subtitle={
                                                    <span className="inline-flex items-center gap-1">
                                                        <Youtube className="w-3 h-3" />{update.channel}
                                                    </span>
                                                }
                                                subtitleClassName="mt-1"
                                            />
                                        ))
                                    )}
                                </div>
                            </>
                        )}
                    </Card>
                </section>
                </div>
                </div>

                {/* Footer: public blog + RSS. */}
                <footer className="mt-6 pt-6 border-t border-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <p className="text-xs leading-relaxed text-zinc-500">{t('blog.footerNote')}</p>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <button
                            type="button"
                            data-testid="blog-entry"
                            onClick={onOpenBlog}
                            className="inline-flex items-center gap-1.5 h-8 px-2 -mx-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                        >
                            <Newspaper className="w-4 h-4" />
                            {t('blog.title')}
                        </button>
                        <a
                            href={blogFeedUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="blog-feed-link"
                            aria-label={t('blog.feedAria')}
                            className="inline-flex items-center gap-1.5 h-8 px-2 -mx-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                        >
                            <Rss className="w-4 h-4" />
                            {t('blog.feed')}
                        </a>
                    </div>
                </footer>
            </div>
        </div>
    );
}
