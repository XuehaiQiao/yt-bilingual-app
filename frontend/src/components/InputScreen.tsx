import { apiFetch } from '../lib/api';
import React, { useState, useEffect, useRef } from 'react';
import { Search, Loader2, Play, Youtube, Clock, Tv, Bell, ArrowRight, Trash2, Compass } from 'lucide-react';
import { motion, AnimatePresence, type Variants } from 'framer-motion';
import type { HistoryItem } from './ChannelVideoList';
import { EstimateDialog, type EstimateDialogHandle } from './EstimateDialog';
import { TodayWorkbench, type TodayWeekReport } from './TodayWorkbench';
import { HomeRecommendations } from './HomeRecommendations';
import { ShowBrowser } from './ShowBrowser';
import { loadModel, loadVocabLevel, saveVocabLevel, type VocabLevelId } from '../lib/settings';
import { VocabAxis } from './VocabAxis';
import { SentencePacks } from './SentencePacks';
import { progressPercent, clearProgress } from '../lib/progress';
import { toast, describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import type { ReviewStats } from '../lib/review';
import { getProfile, type PlacementProfile } from '../lib/placement';

interface InputScreenProps {
    onSubmit: (url: string) => void;
    onLoadHistory: (filename: string) => void;
    onSelectEpisode: (showId: string, season: number, episode: number) => void;
    onSelectSentenceLevel: (id: number) => void;
    isLoading?: boolean;
    loadingState?: 'processing' | 'loading' | 'asr' | null;
    subscriptions?: { id: string; name: string }[];
    onSelectChannel: (channelName: string) => void;
    onUnsubscribe?: (channelId: string) => void;
    /** Review entry card (M2): guests get a login hint, accounts get due counts. */
    isGuest?: boolean;
    reviewStats?: ReviewStats | null;
    reviewStatsLoading?: boolean;
    reviewStatsFailed?: boolean;
    onOpenReview?: () => void;
    /** Weekly report entry (M5): same placement as today's review. */
    onOpenReport?: () => void;
    /** Ability placement / profile entry (M4 / specs/016). */
    onOpenPlacement?: (view: 'intro' | 'profile') => void;
    /** Content discovery entry (specs/017): open the discover view. */
    onOpenDiscover?: () => void;
}

const containerVariants = {
    hidden: { opacity: 0 },
    show: {
        opacity: 1,
        transition: { staggerChildren: 0.06 }
    }
};

const itemVariants: Variants = {
    hidden: { opacity: 0, y: 16 },
    show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 340, damping: 30, mass: 0.9 } }
};

export const InputScreen: React.FC<InputScreenProps> = ({
    onSubmit,
    onLoadHistory,
    onSelectEpisode,
    onSelectSentenceLevel,
    isLoading,
    loadingState,
    subscriptions = [],
    onSelectChannel,
    isGuest = false,
    reviewStats = null,
    reviewStatsLoading = false,
    reviewStatsFailed = false,
    onOpenReview,
    onOpenReport,
    onOpenPlacement,
    onOpenDiscover,
}) => {
    const { t } = useI18n();
    const [url, setUrl] = useState('');
    const [history, setHistory] = useState<HistoryItem[]>([]);
    const [historyLoading, setHistoryLoading] = useState(true);
    const [channelUpdates, setChannelUpdates] = useState<any[]>([]);
    // Home summary of the weekly report. The report screen owns its own fetch;
    // this copy only powers the two numbers on the "this week" card, so it is
    // deliberately a small shape instead of duplicating the whole payload.
    const [weekReport, setWeekReport] = useState<TodayWeekReport | null>(null);
    const [weekReportLoading, setWeekReportLoading] = useState(true);
    const [weekReportFailed, setWeekReportFailed] = useState(false);
    // Ability profile (M4): the workbench strip names the interval when one is
    // saved and offers the 12-minute test otherwise. Refetched on every home
    // remount (returning from the placement view remounts this screen).
    const [placementProfile, setPlacementProfile] = useState<PlacementProfile | null>(null);
    const [placementLoading, setPlacementLoading] = useState(true);
    const [placementFailed, setPlacementFailed] = useState(false);
    // Estimate (cost preview → model confirm) is a reusable flow shared with
    // content discovery; this screen only opens it with the submitted URL.
    const estimateRef = useRef<EstimateDialogHandle>(null);
    const [vocabLevel, setVocabLevel] = useState<VocabLevelId>(loadVocabLevel);
    // Mirrors the model bar's global setting so the pre-flight estimate can
    // name and price the model that will actually run.
    const [currentModelId, setCurrentModelId] = useState(loadModel);

    const handleDeleteHistory = async (e: React.MouseEvent, item: HistoryItem) => {
        e.stopPropagation();
        const title = item.metadata?.title || item.filename;
        if (!window.confirm(t('home.deleteConfirm', { title }))) return;
        try {
            const res = await apiFetch(`/api/history/${encodeURIComponent(item.filename)}`, { method: 'DELETE' });
            if (!res.ok) throw new Error(await describeApiError(res));
            setHistory(prev => prev.filter(h => h.filename !== item.filename));
            if (item.videoId) clearProgress(item.videoId);
            toast.success(t('home.deletedToast'));
        } catch (err) {
            console.error('Delete history failed:', err);
            toast.error(await describeApiError(err));
        }
    };

    const handleVocabLevelChange = (level: VocabLevelId) => {
        setVocabLevel(level);
        saveVocabLevel(level);
    };

    useEffect(() => {
        let cancelled = false;
        setHistoryLoading(true);
        apiFetch('/api/history')
            .then(res => (res.ok ? res.json() : []))
            .then(data => {
                if (!cancelled) setHistory(Array.isArray(data) ? data : []);
            })
            .catch(err => console.error("Failed to fetch history:", err))
            .finally(() => {
                if (!cancelled) setHistoryLoading(false);
            });

        if (subscriptions.length > 0) {
            apiFetch('/api/channel-updates', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ channels: subscriptions.map(s => s.id) })
            })
                .then(res => res.json())
                .then(data => {
                    if (!cancelled) setChannelUpdates(data.updates || []);
                })
                .catch(err => console.error("Failed to fetch channel updates:", err));
        }

        return () => { cancelled = true; };
    }, [subscriptions]);

    // Weekly summary for the "this week" card. Guests have their own report
    // identity (M1 guest isolation), so this endpoint never forces a login.
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

    // Ability profile for the placement strip. No profile is a normal state
    // (`profile: null`), not an error; a failed fetch only degrades the strip
    // copy — the test itself stays accessible.
    useEffect(() => {
        let cancelled = false;
        setPlacementLoading(true);
        setPlacementFailed(false);
        getProfile()
            .then(data => {
                if (cancelled) return;
                setPlacementProfile(data?.profile ?? null);
            })
            .catch(err => {
                if (cancelled) return;
                console.error('Failed to load placement profile:', err);
                setPlacementFailed(true);
            })
            .finally(() => {
                if (!cancelled) setPlacementLoading(false);
            });
        return () => { cancelled = true; };
    }, []);

    const handleInterceptSubmit = (targetUrl: string) => {
        estimateRef.current?.estimate(targetUrl);
    };

    const handleSubmit = (e: React.FormEvent) => {
        e.preventDefault();
        if (url.trim()) {
            handleInterceptSubmit(url.trim());
        }
    };

    // Empty "continue" card lands here: scroll the link input into view and
    // focus it, so "start your first video" is one tap from the card.
    const focusStartInput = () => {
        const input = document.getElementById('video-url') as HTMLInputElement | null;
        if (!input) return;
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        input.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        input.focus({ preventScroll: true });
    };

    return (
        <div className="min-h-screen flex flex-col items-center px-4 sm:px-8 pt-4 sm:pt-10 pb-12 sm:pb-16 overflow-y-auto overflow-x-hidden custom-scrollbar relative bg-[#09090b]">
            <AnimatePresence>
                {(isLoading || loadingState) && (
                    <motion.div 
                        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                        className="fixed inset-0 z-50 bg-zinc-950/70 backdrop-blur-md flex flex-col items-center justify-center"
                    >
                        <Loader2 className="w-12 h-12 text-zinc-300 animate-spin mb-6" />
                        <h2 className="text-xl font-semibold tracking-tight text-zinc-100 mb-2">
                            {loadingState === 'asr' ? t('home.loading.asr') : loadingState === 'processing' ? t('home.loading.processing') : t('home.loading.loading')}
                        </h2>
                        {loadingState === 'processing' && (
                            <p className="text-zinc-400">{t('home.loading.processingHint')}</p>
                        )}
                        {loadingState === 'asr' && (
                            <p className="text-zinc-400">{t('home.loading.asrHint')}</p>
                        )}
                    </motion.div>
                )}
            </AnimatePresence>

            <EstimateDialog
                ref={estimateRef}
                currentModelId={currentModelId}
                onStart={onSubmit}
            />

            <motion.div 
                className="max-w-5xl w-full space-y-10 shrink-0 z-10"
                variants={containerVariants}
                initial="hidden"
                animate="show"
            >
                {/* Today first: date + status, three actions, model switch. */}
                <motion.div variants={itemVariants}>
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
                        onModelResolved={setCurrentModelId}
                        placementProfile={placementProfile}
                        placementLoading={placementLoading}
                        placementFailed={placementFailed}
                        onOpenPlacement={onOpenPlacement}
                    />
                </motion.div>

                {/* "For you" rule recommendations (user request #10): manual
                    curation + placement band + watch history. Clicking a card
                    reuses the exact same estimate flow as the link input. */}
                <motion.div variants={itemVariants}>
                    <HomeRecommendations onSelect={handleInterceptSubmit} />
                </motion.div>

                {/* Start learning: the old hero search, moved below today's
                    actions and reduced to a section-sized input. */}
                <motion.section
                    variants={itemVariants}
                    data-testid="start-learning"
                    className="rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-6"
                >
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('home.today.startTitle')}
                        </h3>
                        <p className="text-xs leading-relaxed text-zinc-500">
                            {t('home.today.startHint')}
                        </p>
                    </div>

                    <form className="mt-4 w-full" onSubmit={handleSubmit}>
                        <div className="flex items-center gap-2 rounded-full bg-zinc-900/60 p-1.5 pl-4 sm:pl-5 border border-white/5 focus-within:border-brand/60 focus-within:ring-2 focus-within:ring-brand/15 transition-[border-color,box-shadow] duration-200 ease-apple">
                            <Search className="w-4 h-4 text-zinc-400 shrink-0" />
                            <input
                                id="video-url"
                                name="url"
                                type="url"
                                disabled={isLoading}
                                required
                                data-testid="video-url-input"
                                aria-label={t('home.searchPlaceholder')}
                                className="w-full min-w-0 bg-transparent border-none outline-none text-zinc-100 placeholder-zinc-500 px-2 py-2.5 text-sm sm:text-base"
                                placeholder={t('home.searchPlaceholder')}
                                value={url}
                                onChange={(e) => setUrl(e.target.value)}
                            />
                            <button
                                type="submit"
                                disabled={isLoading || !url.trim()}
                                className="inline-flex items-center justify-center gap-2 whitespace-nowrap shrink-0 h-9 px-4 rounded-full bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform,opacity] duration-200 ease-apple disabled:opacity-50"
                            >
                                {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : t('home.startLearning')}
                                {!isLoading && <ArrowRight className="hidden sm:block w-4 h-4" />}
                            </button>
                        </div>
                    </form>

                    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-500">
                        <span>{t('home.discover.prompt')}</span>
                        <button
                            type="button"
                            data-testid="discover-entry"
                            onClick={onOpenDiscover}
                            className="inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                        >
                            <Compass className="w-3.5 h-3.5" />
                            {t('home.discover.action')}
                            <ArrowRight className="w-3.5 h-3.5" />
                        </button>
                    </div>
                </motion.section>

                {/* Learner level: calibrates which words get highlighted */}
                <motion.div variants={itemVariants}>
                    <VocabAxis value={vocabLevel} onChange={handleVocabLevelChange} />
                </motion.div>

                {/* Sentence Packs — the third learning mode */}
                <motion.div variants={itemVariants}>
                    <SentencePacks onSelectLevel={onSelectSentenceLevel} />
                </motion.div>

                {/* Bento Grid */}
                <motion.div variants={itemVariants} className="grid grid-cols-1 md:grid-cols-12 gap-6">
                    
                    {/* Left Column: Recent Learning */}
                    <div className="md:col-span-7 flex flex-col gap-6">
                        {/* History Card */}
                        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 flex-1 overflow-hidden">
                            <div className="flex items-center justify-between mb-6">
                                <div className="flex items-center gap-2 text-zinc-100">
                                    <Clock className="w-5 h-5" />
                                    <h3 className="text-[17px] font-semibold tracking-tight">{t('home.continueLearning')}</h3>
                                </div>
                                <div className="flex gap-1">
                                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-600"></div>
                                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-600"></div>
                                    <div className="w-1.5 h-1.5 rounded-full bg-zinc-600"></div>
                                </div>
                            </div>

                            {historyLoading && history.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-16 text-center">
                                    <Loader2 className="w-6 h-6 text-zinc-500 animate-spin mb-3" />
                                    <p className="text-sm font-medium text-zinc-400">{t('home.today.loadingHistory')}</p>
                                </div>
                            ) : history.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-16 text-center">
                                    <Clock className="w-10 h-10 text-zinc-700 mb-3" />
                                    <p className="text-sm font-medium text-zinc-400">{t('home.continueEmpty')}</p>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-4">
                                    {history.slice(0, 3).map((item) => (
                                        <motion.div
                                            key={item.filename}
                                            whileTap={{ scale: 0.98 }}
                                            transition={{ type: "spring", stiffness: 550, damping: 35 }}
                                            onClick={() => onLoadHistory(item.filename)}
                                            data-testid="history-card"
                                            className="group/card relative flex items-center gap-4 p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors cursor-pointer"
                                        >
                                            <button
                                                onClick={(e) => handleDeleteHistory(e, item)}
                                                title={t('home.removeHistoryTitle')}
                                                className="absolute top-2 right-2 z-10 p-1.5 rounded-lg bg-zinc-900/80 hover:bg-red-500/20 border border-white/5 text-zinc-400 hover:text-red-400 opacity-0 pointer-events-none group-hover/card:opacity-100 group-hover/card:pointer-events-auto [@media(pointer:coarse)]:opacity-100 [@media(pointer:coarse)]:pointer-events-auto transition-[opacity,background-color,color]"
                                            >
                                                <Trash2 className="w-3.5 h-3.5" />
                                            </button>
                                            <div className="relative w-24 aspect-video rounded-lg overflow-hidden bg-zinc-900 shrink-0">
                                                {item.metadata?.thumbnail && (
                                                    <img src={item.metadata.thumbnail} alt="thumb" className="w-full h-full object-cover" />
                                                )}
                                                <div className="absolute inset-0 bg-black/30 opacity-0 group-hover/card:opacity-100 transition-opacity flex items-center justify-center">
                                                    <span className="bg-white/15 backdrop-blur-md p-3 rounded-full">
                                                        <Play className="w-5 h-5 text-white fill-current" />
                                                    </span>
                                                </div>
                                                {item.videoId && progressPercent(item.videoId) !== null && (
                                                    <div className="absolute bottom-0 inset-x-0 h-1 bg-black/60">
                                                        <div
                                                            className="h-full bg-emerald-500"
                                                            style={{ width: `${progressPercent(item.videoId)}%` }}
                                                        />
                                                    </div>
                                                )}
                                            </div>
                                            <div className="flex flex-col overflow-hidden">
                                                <h4 className="text-zinc-200 font-medium truncate text-sm mb-1">{item.metadata?.title || t('common.unknownVideo')}</h4>
                                                <p className="text-zinc-500 text-xs flex items-center gap-1">
                                                    <Youtube className="w-3 h-3" /> {item.metadata?.channel || t('common.localFile')}
                                                    {item.videoId && progressPercent(item.videoId) !== null && (
                                                        <span className="ml-1 text-emerald-500/90">{t('common.watchedPercent', { percent: progressPercent(item.videoId) ?? 0 })}</span>
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
                            )}
                        </div>

                        {/* Local Shows Section */}
                        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 shrink-0 overflow-hidden">
                             <div className="flex items-center gap-2 mb-6 text-zinc-100">
                                <Tv className="w-5 h-5 text-blue-400" />
                                <h3 className="text-[17px] font-semibold tracking-tight">{t('home.localShows')}</h3>
                            </div>
                            <ShowBrowser onSelectEpisode={onSelectEpisode} isLoading={!!isLoading} />
                        </div>
                    </div>

                    {/* Right Column: Subscriptions & Updates */}
                    <div className="md:col-span-5 flex flex-col gap-6">
                        
                        {/* Channels Bento */}
                        {subscriptions && subscriptions.length > 0 && (
                            <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6">
                                <div className="flex items-center gap-2 mb-6 text-zinc-100">
                                    <Youtube className="w-5 h-5 text-red-500" />
                                    <h3 className="text-[17px] font-semibold tracking-tight">{t('home.subscriptions')}</h3>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    {subscriptions.slice(0, 6).map(sub => (
                                        <motion.div
                                            whileTap={{ scale: 0.98 }}
                                            transition={{ type: "spring", stiffness: 550, damping: 35 }}
                                            key={sub.id}
                                            onClick={() => onSelectChannel(sub.name)}
                                            className="inline-flex items-center h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 cursor-pointer transition-colors"
                                        >
                                            {sub.name}
                                        </motion.div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {/* Updates Bento */}
                        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-6 flex-1 flex flex-col">
                            <div className="flex items-center gap-2 mb-6 text-zinc-100">
                                <Bell className="w-5 h-5 text-amber-400" />
                                <h3 className="text-[17px] font-semibold tracking-tight">{t('home.latestVideos')}</h3>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto custom-scrollbar pr-2 space-y-4">
                                {channelUpdates.length === 0 ? (
                                    <div className="flex flex-col items-center justify-center py-16 text-center">
                                        <p className="text-sm font-medium text-zinc-400">{t('home.noUploads')}</p>
                                    </div>
                                ) : (
                                    channelUpdates.map((update, idx) => (
                                        <motion.div
                                            whileTap={{ scale: 0.98 }}
                                            transition={{ type: "spring", stiffness: 550, damping: 35 }}
                                            key={`${update.videoId}-${idx}`}
                                            onClick={() => handleInterceptSubmit(`https://youtube.com/watch?v=${update.videoId}`)}
                                            className="flex gap-4 p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors cursor-pointer group"
                                        >
                                            <div className="w-24 aspect-video rounded-lg bg-zinc-800 overflow-hidden shrink-0 relative">
                                                {update.thumbnail && <img src={update.thumbnail} className="w-full h-full object-cover" alt="" />}
                                            </div>
                                            <div className="flex flex-col justify-center">
                                                <h4 className="text-zinc-300 text-sm font-medium line-clamp-2 group-hover:text-white transition-colors">{update.title}</h4>
                                                <p className="text-zinc-500 text-xs mt-1">{update.channel}</p>
                                            </div>
                                        </motion.div>
                                    ))
                                )}
                            </div>
                        </div>

                    </div>
                </motion.div>
            </motion.div>
        </div>
    );
};
