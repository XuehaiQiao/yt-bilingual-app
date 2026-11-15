// "Today" workbench (project plan §6 / §1.4 main line).
//
// The first thing the home screen answers is "what do I do today?", not
// "paste a link". Three action cards reuse the design-language card recipe:
//   1. continue the last unfinished item,
//   2. review today's due words,
//   3. open this week's report.
// The link input moved below these cards (see InputScreen) and stays one
// paste away — this component never owns the submit pipeline.
import { ArrowRight, CalendarRange, Play, Repeat } from 'lucide-react';
import { motion } from 'framer-motion';
import type { HistoryItem } from './ChannelVideoList';
import type { ReviewStats } from '../lib/review';
import { progressPercent } from '../lib/progress';
import { ModelBar } from './ModelBar';
import { useI18n } from '../i18n/I18nProvider';

export interface TodayWeekReport {
    numbers: {
        passiveMinutes: number;
        reviewedWords: number;
        quizAccuracy: number | null;
    };
}

interface TodayWorkbenchProps {
    isGuest: boolean;
    reviewStats: ReviewStats | null;
    reviewStatsLoading: boolean;
    reviewStatsFailed: boolean;
    weekReport: TodayWeekReport | null;
    weekReportLoading: boolean;
    weekReportFailed: boolean;
    history: HistoryItem[];
    historyLoading: boolean;
    onOpenReview?: () => void;
    onOpenReport?: () => void;
    onLoadHistory: (filename: string) => void;
    /** Empty "continue" card: jump to the link input below. */
    onStartFirst: () => void;
    /** Keeps the pre-flight estimate in sync with the global model. */
    onModelResolved: (modelId: string) => void;
}

const CARD = 'rounded-3xl border border-white/5 bg-zinc-900/40 p-3.5 sm:p-5 flex flex-col min-w-0';
const CARD_ICON =
    'w-8 h-8 sm:w-9 sm:h-9 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0';
const ACTION =
    'mt-3 sm:mt-4 inline-flex w-full items-center justify-center gap-2 h-9 sm:h-10 px-4 rounded-xl text-sm font-semibold transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.98]';

export function TodayWorkbench({
    isGuest,
    reviewStats,
    reviewStatsLoading,
    reviewStatsFailed,
    weekReport,
    weekReportLoading,
    weekReportFailed,
    history,
    historyLoading,
    onOpenReview,
    onOpenReport,
    onLoadHistory,
    onStartFirst,
    onModelResolved,
}: TodayWorkbenchProps) {
    const { t, formatNumber, formatDate } = useI18n();

    const dateText = formatDate(new Date(), {
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
    });

    // The history list is already newest-first (backend sorts by mtime), so
    // the first row is the most recent unfinished item. A missing local
    // progress entry just means "opened but barely watched" — say so instead
    // of pretending we can resume at a second.
    const latestItem = history[0] ?? null;
    const latestProgress = latestItem?.videoId ? progressPercent(latestItem.videoId) : null;
    const latestTitle = latestItem?.metadata?.title || t('common.unknownVideo');
    const latestChannel = latestItem?.metadata?.channel || t('common.localFile');

    // One sentence at the top: due words + minutes studied this week. Every
    // part is optional, so a fresh install (or a guest) still gets a friendly
    // line instead of a fabricated number.
    const dueNow = reviewStats?.dueNow ?? 0;
    const newToday = reviewStats?.newToday ?? 0;
    const statusParts: string[] = [];
    if (isGuest) {
        statusParts.push(t('home.today.statusGuest'));
    } else if (reviewStats) {
        statusParts.push(
            dueNow > 0
                ? t('home.today.statusDue', { count: formatNumber(dueNow) })
                : t('home.today.statusNoDue'),
        );
    }
    if (weekReport) {
        statusParts.push(
            t('home.today.statusMinutes', {
                minutes: formatNumber(weekReport.numbers.passiveMinutes),
            }),
        );
    }
    const statusLine = statusParts.length > 0
        ? statusParts.join(' · ')
        : t('home.today.statusEmpty');

    const reviewLine = isGuest
        ? t('home.today.reviewGuest')
        : !reviewStats && (reviewStatsLoading || !reviewStatsFailed)
            ? t('home.today.reviewLoading')
            : reviewStatsFailed && !reviewStats
                ? t('home.today.reviewFailed')
                : dueNow > 0
                    ? t('home.today.reviewDue', { count: formatNumber(dueNow) })
                    : t('home.today.reviewEmpty');
    const reviewHint = isGuest
        ? null
        : !reviewStats
            ? null
            : newToday > 0
                ? t('home.today.reviewNew', { count: formatNumber(newToday) })
                : dueNow > 0
                    ? t('review.home.meta', {
                        reviewed: formatNumber(reviewStats.reviewedToday),
                        days: formatNumber(reviewStats.streakDays),
                    })
                    : t('home.today.reviewEmptyHint');
    const reviewHasWork = !isGuest && !!reviewStats && (dueNow > 0 || newToday > 0);
    const reviewAction = isGuest
        ? t('home.today.reviewLogin')
        : reviewHasWork || !reviewStats
            ? t('home.today.reviewAction')
            : t('home.today.reviewView');

    const report = weekReport?.numbers ?? null;
    const reportEmpty = !!report && report.passiveMinutes === 0 && report.reviewedWords === 0;
    const reportHint = !report && weekReportLoading
        ? t('home.today.reportLoading')
        : !report && weekReportFailed
            ? t('home.today.reportFailed')
            : reportEmpty
                ? t('home.today.reportEmpty')
                : null;

    return (
        <div data-testid="today-workbench" className="min-w-0">
            {/* Today header. Language / favorites / account live in the app top
                bar; the model switch keeps its home-only spot on the right. */}
            <header className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2.5 sm:gap-4">
                <div className="min-w-0">
                    <p data-testid="today-date" className="text-[11px] sm:text-xs font-medium text-zinc-500 tabular-nums">
                        {dateText}
                    </p>
                    <h2 className="mt-0.5 sm:mt-1 text-2xl sm:text-4xl md:text-5xl font-semibold tracking-[-0.015em] text-zinc-50">
                        {t('home.today.heading')}
                    </h2>
                    <p
                        data-testid="today-status"
                        className="mt-1 sm:mt-2 max-w-2xl text-xs sm:text-sm leading-relaxed text-zinc-400 break-words"
                    >
                        {statusLine}
                    </p>
                </div>
                <div className="shrink-0 self-end sm:self-start">
                    <ModelBar onModelResolved={onModelResolved} />
                </div>
            </header>

            {/* Three actions. Equal-height cards; each action sits at the
                bottom so the row scans as one band. */}
            <div data-testid="today-cards" className="mt-4 sm:mt-5 grid grid-cols-1 md:grid-cols-3 gap-2.5 sm:gap-4">
                {/* 1. Continue learning */}
                <motion.section
                    data-testid="today-card-continue"
                    data-today-card="continue"
                    whileTap={{ scale: 0.99 }}
                    transition={{ type: 'spring', stiffness: 550, damping: 35 }}
                    className={CARD}
                >
                    <div className="flex items-center gap-2.5">
                        <div className={CARD_ICON}>
                            <Play className="w-4 h-4 text-blue-400 fill-current" />
                        </div>
                        <h3 className="text-sm sm:text-[15px] font-semibold tracking-tight text-zinc-100">
                            {t('home.today.continueEyebrow')}
                        </h3>
                    </div>

                    <div className="mt-2.5 sm:mt-3 flex-1 min-w-0">
                        {historyLoading && history.length === 0 ? (
                            <p className="py-2 text-xs text-zinc-500">{t('home.today.loadingHistory')}</p>
                        ) : latestItem ? (
                            <div className="flex items-start gap-3 min-w-0">
                                <div className="relative w-16 sm:w-24 aspect-video rounded-lg overflow-hidden bg-zinc-800 shrink-0">
                                    {latestItem.metadata?.thumbnail ? (
                                        <img
                                            src={latestItem.metadata.thumbnail}
                                            alt=""
                                            className="w-full h-full object-cover"
                                        />
                                    ) : (
                                        <div className="w-full h-full flex items-center justify-center text-zinc-600">
                                            <Play className="w-5 h-5" />
                                        </div>
                                    )}
                                    {latestProgress !== null && (
                                        <div
                                            className="absolute bottom-0 inset-x-0 h-1 bg-black/60"
                                            role="progressbar"
                                            aria-valuemin={0}
                                            aria-valuemax={100}
                                            aria-valuenow={latestProgress}
                                            aria-label={t('home.today.watchedPercent', {
                                                percent: latestProgress,
                                            })}
                                        >
                                            <div
                                                className="h-full bg-emerald-500"
                                                style={{ width: `${latestProgress}%` }}
                                            />
                                        </div>
                                    )}
                                </div>
                                <div className="min-w-0">
                                    <p className="text-[13px] sm:text-sm font-medium leading-snug text-zinc-200 line-clamp-2 break-words">
                                        {latestTitle}
                                    </p>
                                    <p className="mt-0.5 sm:mt-1 text-[11px] sm:text-xs text-zinc-500 truncate">{latestChannel}</p>
                                    <p className="mt-0.5 sm:mt-1 text-[11px] font-medium text-emerald-500/90 tabular-nums">
                                        {latestProgress !== null
                                            ? t('home.today.watchedPercent', { percent: latestProgress })
                                            : t('home.today.lastOpened')}
                                    </p>
                                </div>
                            </div>
                        ) : (
                            <div className="py-1">
                                <p className="text-sm font-medium text-zinc-300">
                                    {t('home.today.continueEmptyTitle')}
                                </p>
                                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                                    {t('home.today.continueEmptyHint')}
                                </p>
                            </div>
                        )}
                    </div>

                    <button
                        type="button"
                        data-testid="today-continue-button"
                        onClick={latestItem ? () => onLoadHistory(latestItem.filename) : onStartFirst}
                        className={`${ACTION} bg-zinc-100 text-zinc-900 hover:bg-white`}
                    >
                        {latestItem ? t('home.today.continueButton') : t('home.today.startFirst')}
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </motion.section>

                {/* 2. Today's review */}
                <motion.section
                    data-testid="review-entry-card"
                    data-today-card="review"
                    data-due={reviewStats ? dueNow : ''}
                    whileTap={{ scale: 0.99 }}
                    transition={{ type: 'spring', stiffness: 550, damping: 35 }}
                    className={CARD}
                >
                    <div className="flex items-center gap-2.5 min-w-0">
                        <div className={CARD_ICON}>
                            <Repeat className="w-4 h-4 text-blue-400" />
                        </div>
                        <h3 className="min-w-0 text-[15px] font-semibold tracking-tight text-zinc-100 truncate">
                            {t('home.today.reviewEyebrow')}
                        </h3>
                    </div>

                    <div className="mt-2.5 sm:mt-3 flex-1 min-w-0">
                        <p
                            data-testid="review-entry-line"
                            className={`text-sm sm:text-base font-semibold leading-snug break-words ${
                                dueNow > 0 ? 'text-zinc-100' : 'text-zinc-300'
                            }`}
                        >
                            {reviewLine}
                        </p>
                        {reviewHint && (
                            <p className="mt-1 text-[11px] sm:text-xs leading-relaxed text-zinc-500 break-words">
                                {reviewHint}
                            </p>
                        )}
                    </div>

                    <button
                        type="button"
                        data-testid="review-entry-button"
                        onClick={onOpenReview}
                        className={`${ACTION} bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200`}
                    >
                        {reviewAction}
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </motion.section>

                {/* 3. Weekly report (two of the three numbers; the full page
                    has all three). */}
                <motion.section
                    data-testid="report-entry-card"
                    data-today-card="report"
                    whileTap={{ scale: 0.99 }}
                    transition={{ type: 'spring', stiffness: 550, damping: 35 }}
                    className={CARD}
                >
                    <div className="flex items-center gap-2.5">
                        <div className={CARD_ICON}>
                            <CalendarRange className="w-4 h-4 text-blue-400" />
                        </div>
                        <h3 className="text-sm sm:text-[15px] font-semibold tracking-tight text-zinc-100">
                            {t('home.today.reportEyebrow')}
                        </h3>
                    </div>

                    <div className="mt-2.5 sm:mt-3 flex-1 min-w-0">
                        <div className="grid grid-cols-2 gap-1.5 sm:gap-2">
                            <div className="min-w-0 rounded-xl border border-white/5 bg-zinc-800/30 px-2 py-1.5 sm:px-2.5 sm:py-2">
                                <p className="truncate text-[10px] font-medium text-zinc-500">
                                    {t('home.today.reportMinutesLabel')}
                                </p>
                                <p className="mt-0.5 truncate text-sm sm:text-base font-semibold text-zinc-100 tabular-nums">
                                    {report ? formatNumber(report.passiveMinutes) : '—'}
                                    {report && (
                                        <span className="ml-1 text-[10px] font-medium text-zinc-500">
                                            {t('home.today.minutesUnit')}
                                        </span>
                                    )}
                                </p>
                            </div>
                            <div className="min-w-0 rounded-xl border border-white/5 bg-zinc-800/30 px-2 py-1.5 sm:px-2.5 sm:py-2">
                                <p className="truncate text-[10px] font-medium text-zinc-500">
                                    {t('home.today.reportReviewedLabel')}
                                </p>
                                <p className="mt-0.5 truncate text-sm sm:text-base font-semibold text-zinc-100 tabular-nums">
                                    {report ? formatNumber(report.reviewedWords) : '—'}
                                    {report && (
                                        <span className="ml-1 text-[10px] font-medium text-zinc-500">
                                            {t('home.today.wordsUnit')}
                                        </span>
                                    )}
                                </p>
                            </div>
                        </div>
                        {reportHint && (
                            <p className="mt-1.5 sm:mt-2 text-[11px] leading-relaxed text-zinc-500 break-words">
                                {reportHint}
                            </p>
                        )}
                    </div>

                    <button
                        type="button"
                        data-testid="report-entry-button"
                        onClick={onOpenReport}
                        className={`${ACTION} bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100`}
                    >
                        {t('home.today.reportAction')}
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </motion.section>
            </div>
        </div>
    );
}
