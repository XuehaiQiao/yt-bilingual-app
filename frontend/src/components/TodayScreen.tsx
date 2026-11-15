// Today — first-level page (P0 IA §3.1).
//
// One decision surface: what do I do today? Header + (main input for a fresh
// user) + placement strip while there is no profile + three cards (continue /
// review / report) + the compact "learn something new" input once history
// exists. The exam card moved to 练习; the model bar moved to the app chrome.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, Loader2, Play, Trash2, Youtube } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiFetch } from '../lib/api';
import type { HistoryItem } from './ChannelVideoList';
import type { PlacementProfile } from '../lib/placement';
import type { ReviewStats } from '../lib/review';
import type { EstimateDialogHandle } from './EstimateDialog';
import { EstimateDialog } from './EstimateDialog';
import { TodayWorkbench, type TodayWeekReport } from './TodayWorkbench';
import { StartLearning } from './StartLearning';
import { progressPercent, clearProgress } from '../lib/progress';
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
    onLoadHistory: (filename: string) => void;
    onOpenReview: () => void;
    onOpenReport: () => void;
    onOpenPlacement: (view: 'intro' | 'profile') => void;
    /** "学新内容" fallback when the paste input is not on screen. */
    onOpenContent: () => void;
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
    onLoadHistory,
    onOpenReview,
    onOpenReport,
    onOpenPlacement,
    onOpenContent,
}: TodayScreenProps) {
    const { t } = useI18n();
    const estimateRef = useRef<EstimateDialogHandle>(null);
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [weekReport, setWeekReport] = useState<TodayWeekReport | null>(null);
    const [weekReportLoading, setWeekReportLoading] = useState(true);
    const [weekReportFailed, setWeekReportFailed] = useState(false);

    useEffect(() => {
        let cancelled = false;
        setHistoryLoading(true);
        apiFetch('/api/history')
            .then(res => (res.ok ? res.json() : []))
            .then(data => {
                if (!cancelled) setHistory(Array.isArray(data) ? data : []);
            })
            .catch(err => console.error('Failed to fetch history:', err))
            .finally(() => {
                if (!cancelled) setHistoryLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    useEffect(() => {
        let cancelled = false;
        setWeekReportLoading(true);
        setWeekReportFailed(false);
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
            })
            .catch(err => {
                if (cancelled) return;
                console.error('Failed to load weekly report summary:', err);
                setWeekReportFailed(true);
            })
            .finally(() => {
                if (!cancelled) setWeekReportLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const handleDeleteHistory = useCallback(async (event: React.MouseEvent, item: HistoryItem) => {
        event.stopPropagation();
        const title = item.metadata?.title || item.filename;
        if (!window.confirm(t('home.deleteConfirm', { title }))) return;
        try {
            const res = await apiFetch(`/api/history/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(await describeApiError(res));
            setHistory(prev => prev.filter(entry => entry.filename !== item.filename));
            if (item.videoId) clearProgress(item.videoId);
            toast.success(t('home.deletedToast'));
        } catch (err) {
            console.error('Delete history failed:', err);
            toast.error(await describeApiError(err));
        }
    }, [t]);

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
                onEstimate={(url) => estimateRef.current?.estimate(url)}
            />
        </div>
    ) : null;

    return (
        <div
            data-testid="today-screen"
            data-page-scroll
            className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] ${PAGE_PAD}`}
        >
            <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 pt-4 sm:pt-8">
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
                />

                {hasHistory && (
                    <section className="mt-5" data-testid="today-history-list">
                        <div className="flex items-baseline justify-between gap-3">
                            <h2 className="flex items-center gap-2 text-[17px] font-semibold tracking-tight text-zinc-100">
                                <Clock className="w-4 h-4 text-zinc-500" />
                                {t('today.history.title')}
                            </h2>
                            <p className="text-[11px] text-zinc-500">{t('today.history.hint')}</p>
                        </div>
                        <div className="mt-3 flex flex-col gap-2.5">
                            {history.slice(0, 3).map(item => (
                                <motion.div
                                    key={item.filename}
                                    whileTap={{ scale: 0.98 }}
                                    transition={{ type: 'spring', stiffness: 550, damping: 35 }}
                                    onClick={() => onLoadHistory(item.filename)}
                                    data-testid="history-card"
                                    className="group/card relative flex items-center gap-3.5 p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors cursor-pointer"
                                >
                                    <button
                                        onClick={(event) => { void handleDeleteHistory(event, item); }}
                                        title={t('home.removeHistoryTitle')}
                                        aria-label={t('home.removeHistoryTitle')}
                                        className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-zinc-900/80 hover:bg-red-500/20 border border-white/5 text-zinc-400 hover:text-red-400 opacity-0 pointer-events-none group-hover/card:opacity-100 group-hover/card:pointer-events-auto [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:pointer-events-auto transition-[opacity,background-color,color]"
                                    >
                                        <Trash2 className="w-3.5 h-3.5" />
                                    </button>
                                    <div className="relative w-20 sm:w-24 aspect-video rounded-lg overflow-hidden bg-zinc-900 shrink-0">
                                        {item.metadata?.thumbnail && (
                                            <img src={item.metadata.thumbnail} alt="thumb" className="w-full h-full object-cover" />
                                        )}
                                        <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center">
                                            <span className="bg-white/15 backdrop-blur-md p-2.5 rounded-full">
                                                <Play className="w-4 h-4 text-white fill-current" />
                                            </span>
                                        </div>
                                        {item.videoId && progressPercent(item.videoId) !== null && (
                                            <div className="absolute bottom-0 inset-x-0 h-1 bg-black/60">
                                                <div className="h-full bg-emerald-500" style={{ width: `${progressPercent(item.videoId)}%` }} />
                                            </div>
                                        )}
                                    </div>
                                    <div className="flex flex-col overflow-hidden min-w-0">
                                        <h4 className="text-zinc-200 font-medium truncate text-sm mb-1">{item.metadata?.title || t('common.unknownVideo')}</h4>
                                        <p className="text-zinc-500 text-xs flex items-center gap-1 truncate">
                                            <Youtube className="w-3 h-3 shrink-0" /> {item.metadata?.channel || t('common.localFile')}
                                            {item.videoId && progressPercent(item.videoId) !== null && (
                                                <span className="ml-1 text-emerald-500/90 shrink-0">{t('common.watchedPercent', { percent: progressPercent(item.videoId) ?? 0 })}</span>
                                            )}
                                        </p>
                                        <div className="flex items-center gap-2 mt-1.5">
                                            <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-zinc-700/40 border border-white/5 text-zinc-400 truncate max-w-[9rem]">
                                                {item.modelName || t('common.notRecorded')}
                                            </span>
                                            <span className="text-[10px] text-zinc-500 tabular-nums">
                                                {item.studyCount ? t('common.studiedTimes', { count: item.studyCount }) : t('common.noSessions')}
                                            </span>
                                        </div>
                                    </div>
                                </motion.div>
                            ))}
                        </div>
                    </section>
                )}

                {hasHistory && (
                    <div className="mt-5">
                        <StartLearning
                            variant="compact"
                            hint={t('today.newContent')}
                            onEstimate={(url) => estimateRef.current?.estimate(url)}
                        />
                    </div>
                )}

                {hasHistory && historyLoading && history.length === 0 && (
                    <div className="mt-4 flex items-center gap-2 text-xs text-zinc-500">
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        {t('home.today.loadingHistory')}
                    </div>
                )}
            </div>
        </div>
    );
}
