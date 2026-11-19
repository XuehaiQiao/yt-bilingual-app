// Practice — first-level page (P0 IA §3.3).
//
// "Turn what I studied into what I know." Review main card, comprehension
// quiz explainer (the quiz itself still lives inside the learning view, per
// §7.1), exam practice, and the ability placement row. Guests see in-card
// login prompts; the tab itself is never locked.
import { ArrowRight, GraduationCap, Gauge, Repeat, ScanSearch } from 'lucide-react';
import type { TranslationKey } from '../i18n';
import { motion } from 'framer-motion';
import type { PlacementProfile } from '../lib/placement';
import type { ReviewStats } from '../lib/review';
import { useI18n } from '../i18n/I18nProvider';
import { PageHeader } from './ui/PageHeader';
import { Card, IconTile } from './ui/Card';

const PAGE_PAD = 'pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10';
const ACTION =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-sm font-semibold transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.98]';

const CONFIDENCE_KEYS: Record<string, TranslationKey> = {
    high: 'placement.confidence.high',
    medium: 'placement.confidence.medium',
    low: 'placement.confidence.low',
};

interface PracticeScreenProps {
    isGuest: boolean;
    reviewStats: ReviewStats | null;
    reviewStatsLoading: boolean;
    reviewStatsFailed: boolean;
    placementProfile: PlacementProfile | null;
    placementLoading: boolean;
    placementFailed: boolean;
    /** Opens `#/app/{today,practice}/review`; guests get the login overlay there. */
    onOpenReview: () => void;
    onOpenExam: () => void;
    onOpenPlacement: (view: 'intro' | 'profile') => void;
    /** "去继续学习": the continue-learning home is Today. */
    onGoContinue: () => void;
}

export function PracticeScreen({
    isGuest,
    reviewStats,
    reviewStatsLoading,
    reviewStatsFailed,
    placementProfile,
    placementLoading,
    placementFailed,
    onOpenReview,
    onOpenExam,
    onOpenPlacement,
    onGoContinue,
}: PracticeScreenProps) {
    const { t, formatNumber, formatDate } = useI18n();

    const dueNow = reviewStats?.dueNow ?? 0;
    const newToday = reviewStats?.newToday ?? 0;
    const reviewLine = isGuest
        ? t('home.today.reviewGuest')
        : reviewStatsLoading && !reviewStats
            ? t('home.today.reviewLoading')
            : reviewStatsFailed && !reviewStats
                ? t('home.today.reviewFailed')
                : dueNow > 0
                    ? t('home.today.reviewDue', { count: formatNumber(dueNow) })
                    : t('home.today.reviewEmpty');
    const reviewHint = isGuest
        ? t('practice.review.guestHint')
        : reviewStats
            ? dueNow > 0
                ? t('home.today.reviewNew', { count: formatNumber(newToday) })
                : t('home.today.reviewEmptyHint')
            : null;
    const reviewAction = isGuest
        ? t('home.today.reviewLogin')
        : dueNow > 0 || newToday > 0
            ? t('home.today.reviewAction')
            : t('home.today.reviewView');

    return (
        <div
            data-testid="practice-screen"
            data-page-scroll
            className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] ${PAGE_PAD}`}
        >
            <div className="mx-auto w-full max-w-6xl px-4 sm:px-6 lg:px-8 pt-5 sm:pt-8 space-y-4 sm:space-y-5">
                <PageHeader
                    testId="practice-page-header"
                    titleTestId="practice-title"
                    title={t('practice.title')}
                    subtitle={t('practice.subtitle')}
                />

                {/* Main card: today's review. */}
                <motion.section
                    whileTap={{ scale: 0.995 }}
                    transition={{ type: 'spring', stiffness: 550, damping: 35 }}
                >
                    <Card
                        variant="panel"
                        testId="practice-review-card"
                        data-guest={isGuest ? 'true' : 'false'}
                        className="flex flex-col sm:flex-row sm:items-center gap-3.5"
                    >
                        <div className="flex items-start gap-3 min-w-0 flex-1">
                            <IconTile icon={Repeat} tone="brand" size="md" />
                            <div className="min-w-0">
                                <p className="text-[11px] font-medium text-zinc-500">{t('practice.review.title')}</p>
                                <p
                                    data-testid="practice-review-line"
                                    className={`mt-0.5 text-base sm:text-lg font-semibold leading-snug break-words ${dueNow > 0 ? 'text-zinc-100' : 'text-zinc-300'}`}
                                >
                                    {reviewLine}
                                </p>
                                {reviewHint && (
                                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 break-words">{reviewHint}</p>
                                )}
                            </div>
                        </div>
                        <button
                            type="button"
                            data-testid="practice-review-button"
                            onClick={onOpenReview}
                            className={`${ACTION} shrink-0 w-full sm:w-auto bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200`}
                        >
                            {reviewAction}
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    </Card>
                </motion.section>

                {/* Quiz explainer + exam card (md: two columns). */}
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 sm:gap-5">
                    <Card variant="card" as="section" testId="practice-quiz-card" className="flex flex-col">
                        <div className="flex items-start gap-3">
                            <IconTile icon={ScanSearch} tone="brand" size="sm" />
                            <div className="min-w-0">
                                <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                                    {t('practice.quiz.title')}
                                </h2>
                                <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('practice.quiz.hint')}</p>
                            </div>
                        </div>
                        <div className="mt-4 flex-1" />
                        <button
                            type="button"
                            data-testid="practice-quiz-continue"
                            onClick={onGoContinue}
                            className={`${ACTION} w-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100`}
                        >
                            {t('practice.quiz.goContinue')}
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    </Card>

                    <Card variant="card" as="section" testId="practice-exam-card" className="flex flex-col">
                        <div className="flex items-start gap-3">
                            <IconTile icon={GraduationCap} tone="brand" size="sm" />
                            <div className="min-w-0">
                                <h2 className="text-[15px] font-semibold tracking-tight text-zinc-100">
                                    {t('practice.exam.title')}
                                </h2>
                                <p className="mt-1 text-xs leading-relaxed text-zinc-500">
                                    {isGuest ? t('exam.home.guestHint') : t('practice.exam.hint')}
                                </p>
                                <p className="mt-1 text-[11px] leading-relaxed text-zinc-600">
                                    {t('exam.home.disclaimer')}
                                </p>
                            </div>
                        </div>
                        <div className="mt-4 flex-1" />
                        <button
                            type="button"
                            data-testid="practice-exam-button"
                            onClick={onOpenExam}
                            className={`${ACTION} w-full ${
                                isGuest
                                    ? 'bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200'
                                    : 'bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100'
                            }`}
                        >
                            {isGuest ? t('exam.home.guestAction') : t('practice.exam.start')}
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    </Card>
                {/* Placement: one quiet row. */}
                <Card
                    variant="card"
                    as="section"
                    padding="none"
                    testId="practice-placement-card"
                    className="px-4 py-3.5 sm:px-5 flex flex-col md:flex-row md:items-center xl:flex-col xl:items-stretch gap-3 md:col-span-2 xl:col-span-1"
                >
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                        <IconTile icon={Gauge} tone="brand" size="sm" />
                        <div className="min-w-0">
                            <p className="text-[11px] font-medium text-zinc-500">{t('practice.placement.title')}</p>
                            {placementLoading ? (
                                <p className="mt-0.5 text-sm text-zinc-400">{t('placement.home.loading')}</p>
                            ) : placementProfile ? (
                                <>
                                    <p className="mt-0.5 text-sm text-zinc-200">
                                        {t('placement.home.levelLine', { level: placementProfile.cefr })}
                                    </p>
                                    <p className="mt-0.5 text-[11px] text-zinc-500 break-words">
                                        {t('placement.home.meta', {
                                            confidence: CONFIDENCE_KEYS[placementProfile.confidenceLabel]
                                                ? t(CONFIDENCE_KEYS[placementProfile.confidenceLabel])
                                                : placementProfile.confidenceLabelZh || placementProfile.confidenceLabel,
                                            date: formatDate(placementProfile.updatedAt, { dateStyle: 'medium' }),
                                        })}
                                    </p>
                                </>
                            ) : (
                                <p className="mt-0.5 text-sm leading-relaxed text-zinc-400">
                                    {placementFailed ? t('placement.home.failed') : t('placement.home.ctaHint')}
                                </p>
                            )}
                        </div>
                    </div>
                    <button
                        type="button"
                        data-testid="practice-placement-button"
                        onClick={() => onOpenPlacement(placementProfile ? 'profile' : 'intro')}
                        className={`${ACTION} shrink-0 w-full md:w-auto xl:w-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100`}
                    >
                        {placementProfile ? t('placement.home.viewProfile') : t('practice.placement.short')}
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </Card>
                </div>

                <p className="pt-1 text-[11px] leading-relaxed text-zinc-600">{t('practice.footnote')}</p>
            </div>
        </div>
    );
}
