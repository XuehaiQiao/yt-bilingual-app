// Today — first-level page (P0 IA §3.1).
//
// One decision surface: what do I do today? Header + (main input for a fresh
// user) + placement strip while there is no profile + three cards (continue /
// review / report) + the merged recent-learning panel (video / article / book,
// 10 per page) + the compact "learn something new" input once history exists.
// The exam card moved to 练习; the model bar moved to the app chrome.
import { useCallback, useEffect, useRef, useState } from 'react';
import { apiFetch } from '../lib/api';
import { allowAi } from '../lib/aiGate';
import type { HistoryItem } from './ChannelVideoList';
import type { PlacementProfile } from '../lib/placement';
import type { ReviewStats } from '../lib/review';
import type { EstimateDialogHandle } from './EstimateDialog';
import { EstimateDialog } from './EstimateDialog';
import { TodayWorkbench, type TodayWeekReport } from './TodayWorkbench';
import { NovelCourseCard } from './NovelCourseCard';
import { StartLearning } from './StartLearning';
import { RecentLearning } from './RecentLearning';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { clearProgress } from '../lib/progress';
import { toast, describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';

const PAGE_PAD =
    'pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10';

interface TodayScreenProps {
    isGuest: boolean;
    reviewStats: ReviewStats | null;
    reviewStatsLoading: boolean;
    reviewStatsFailed: boolean;
    placementProfile: PlacementProfile | null;
    placementLoading: boolean;
    placementFailed: boolean;
    /** Same callback ContentScreen uses — one estimate/process pipeline. */
    onSubmitUrl: (url: string) => void;
    /** Start-input "search topics" mode: discover view auto-runs the query. */
    onSearch: (query: string) => void;
    /** Start-input "read article" mode: reader prefills/imports the value. */
    onRead: (value: string) => void;
    onLoadHistory: (filename: string) => void;
    /** Recent-learning rows: open the reading API article / book readers. */
    onOpenArticle: (articleId: string) => void;
    onOpenBook: (bookId: string) => void;
    onOpenImportedBook: (bookId: string) => void;
    onOpenReview: () => void;
    onOpenReport: () => void;
    onOpenPlacement: (view: 'intro' | 'profile') => void;
    /** "学新内容" fallback when the paste input is not on screen. */
    onOpenContent: () => void;
    /** 12-minute course entry (specs/029). */
    onOpenCourse: () => void;
    /** Current highlighter level, sent with novel course generation (specs/030). */
    vocabLevel: string;
    /** Guest generation entry: open the app's auth overlay. */
    onRequestLogin?: () => void;
    /** Generated novel lesson → the shared `#/app/today/lesson/{id}` screen. */
    onOpenLesson: (lessonId: string) => void;
}

export function TodayScreen({
    isGuest,
    reviewStats,
    reviewStatsLoading,
    reviewStatsFailed,
    placementProfile,
    placementLoading,
    placementFailed,
    onSubmitUrl,
    onSearch,
    onRead,
    onLoadHistory,
    onOpenArticle,
    onOpenBook,
    onOpenImportedBook,
    onOpenReview,
    onOpenReport,
    onOpenPlacement,
    onOpenContent,
    onOpenCourse,
    vocabLevel,
    onRequestLogin,
    onOpenLesson,
}: TodayScreenProps) {
    const { t } = useI18n();
    const estimateRef = useRef<EstimateDialogHandle>(null);
    // M7b: the estimate call is part of the AI processing pipeline; guests get
    // the shared login prompt and no `/api/estimate-cost` request.
    const estimate = useCallback((url: string) => {
        if (!allowAi(isGuest, onRequestLogin)) return;
        estimateRef.current?.estimate(url);
    }, [isGuest, onRequestLogin]);
    // One async state per block (IX-01): a failed read is an error with a
    // retry, never the "从第一个视频开始 / 暂无记录" empty branch.
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [historyState, setHistoryState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [historyReloadToken, setHistoryReloadToken] = useState(0);
    const [weekReport, setWeekReport] = useState<TodayWeekReport | null>(null);
    const [weekState, setWeekState] = useState<'loading' | 'ready' | 'error'>('loading');
    const [weekReloadToken, setWeekReloadToken] = useState(0);
    const historyLoading = historyState === 'loading';
    const historyFailed = historyState === 'error';
    const weekReportLoading = weekState === 'loading';
    const weekReportFailed = weekState === 'error';

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
                console.error('Failed to fetch history:', err);
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
            .then(data => {
                if (cancelled) return;
                const numbers = data?.numbers;
                if (!numbers || typeof numbers.passiveMinutes !== 'number') {
                    throw new Error('invalid report payload');
                }
                setWeekReport({
                    numbers: {
                        passiveMinutes: numbers.passiveMinutes,
                        reviewedWords: typeof numbers.reviewedWords === 'number' ? numbers.reviewedWords : 0,
                        quizAccuracy: typeof numbers.quizAccuracy === 'number' ? numbers.quizAccuracy : null,
                    },
                });
                setWeekState('ready');
            })
            .catch(err => {
                if (cancelled) return;
                console.error('Failed to load weekly report summary:', err);
                setWeekState('error');
            });
        return () => { cancelled = true; };
    }, [weekReloadToken]);

    const retryHistory = useCallback(() => {
        setHistoryState('loading');
        setHistoryReloadToken((token) => token + 1);
    }, []);
    const retryWeekReport = useCallback(() => {
        setWeekState('loading');
        setWeekReloadToken((token) => token + 1);
    }, []);

    // Deletion runs from the shared ConfirmDialog: the row is only touched after
    // the learner confirms, and a failed request keeps the dialog open with the
    // list untouched (IX-24).
    const [pendingDelete, setPendingDelete] = useState<{ filename: string; title: string } | null>(null);
    const [deleteError, setDeleteError] = useState<string | null>(null);

    const requestRemoveVideo = (filename: string) => {
        const item = history.find(entry => entry.filename === filename);
        if (!item) return;
        setDeleteError(null);
        setPendingDelete({ filename: item.filename, title: item.metadata?.title || item.filename });
    };

    const handleRemoveVideo = async () => {
        if (!pendingDelete) return;
        const item = history.find(entry => entry.filename === pendingDelete.filename);
        if (!item) return;
        try {
            const res = await apiFetch(`/api/history/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(await describeApiError(res));
            setHistory(prev => prev.filter(entry => entry.filename !== item.filename));
            if (item.videoId) clearProgress(item.videoId);
            toast.success(t('home.deletedToast'));
        } catch (err) {
            console.error('Delete history failed:', err);
            const message = await describeApiError(err);
            setDeleteError(message);
            toast.error(message);
            throw err;
        }
    };

    const hasHistory = history.length > 0;
    const focusStartInput = () => {
        const input = document.getElementById('video-url') as HTMLInputElement | null;
        if (!input) {
            onOpenContent();
            return;
        }
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        input.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        input.focus({ preventScroll: true });
    };

    // Wait for the history read before deciding the shape: showing the hero
    // input and swapping it for the compact one one tick later made the page
    // jump on every slow network.
    const primaryInput = !historyLoading && !hasHistory ? (
        <div className="mt-4 sm:mt-5">
            <StartLearning
                variant="primary"
                onEstimate={estimate}
                onSearch={onSearch}
                onRead={onRead}
            />
        </div>
    ) : null;

    return (
        <div
            data-testid="today-screen"
            data-page-scroll
            className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] ${PAGE_PAD}`}
        >
            <div className="mx-auto w-full max-w-[1440px] px-4 sm:px-6 lg:px-8 pt-4 sm:pt-8">
                <EstimateDialog
                    ref={estimateRef}
                    onStart={onSubmitUrl}
                />
                <TodayWorkbench
                    isGuest={isGuest}
                    reviewStats={reviewStats}
                    reviewStatsLoading={reviewStatsLoading}
                    reviewStatsFailed={reviewStatsFailed}
                    weekReport={weekReport}
                    weekReportLoading={weekReportLoading}
                    weekReportFailed={weekReportFailed}
                    history={history}
                    historyLoading={historyLoading}
                    historyFailed={historyFailed}
                    onRetryHistory={retryHistory}
                    onRetryWeekReport={retryWeekReport}
                    onOpenReview={onOpenReview}
                    onOpenReport={onOpenReport}
                    onLoadHistory={onLoadHistory}
                    onStartFirst={focusStartInput}
                    placementProfile={placementProfile}
                    placementLoading={placementLoading}
                    placementFailed={placementFailed}
                    onOpenPlacement={onOpenPlacement}
                    showPlacement={!placementProfile}
                    inputSlot={primaryInput}
                    onOpenCourse={onOpenCourse}
                />

                {/* Public-domain novel generation (specs/030). A sibling of the
                    static course banner, not a fourth workbench card: the
                    three-card row keeps its 375/1440 rhythm. */}
                <NovelCourseCard
                    isGuest={isGuest}
                    level={vocabLevel}
                    onRequestLogin={onRequestLogin}
                    onOpenLesson={onOpenLesson}
                />

                <RecentLearning
                    isGuest={isGuest}
                    history={history}
                    historyLoading={historyLoading}
                    historyFailed={historyFailed}
                    onRetryHistory={retryHistory}
                    onLoadHistory={onLoadHistory}
                    onOpenArticle={onOpenArticle}
                    onOpenBook={onOpenBook}
                    onOpenImportedBook={onOpenImportedBook}
                    onOpenContent={onOpenContent}
                    onRemoveVideo={requestRemoveVideo}
                />

                {hasHistory && (
                    <div className="mt-5">
                        <StartLearning
                            variant="compact"
                            hint={t('today.newContent')}
                            onEstimate={estimate}
                            onSearch={onSearch}
                            onRead={onRead}
                        />
                    </div>
                )}
            </div>

            <ConfirmDialog
                open={pendingDelete !== null}
                title={t('home.deleteConfirm', { title: pendingDelete?.title ?? '' })}
                confirmLabel={t('home.removeHistoryTitle')}
                destructive
                onConfirm={handleRemoveVideo}
                onClose={() => {
                    setPendingDelete(null);
                    setDeleteError(null);
                }}
                error={deleteError}
                testId="history-delete-confirm"
            />
        </div>
    );
}
