// Weekly report view (specs/015-weekly-report, M5 frontend).
//
// Read-only render of `GET /api/report/week`: the backend owns every number,
// the fact sentence, the next step and the evidence window. This screen only
// formats them (and localizes its own chrome) and hands the evidence back to
// the app shell so the existing player/history path can seek there.
import { useCallback, useEffect, useState } from 'react';
import {
    AlertTriangle,
    ArrowRight,
    CalendarOff,
    CalendarRange,
    Flame,
    Loader2,
    Quote,
    Repeat,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import { SubHeader } from './ui/SubHeader';

export interface WeekReportEvidence {
    source: 'quiz_wrong' | 'watch';
    contentRef: string;
    kind: 'video' | 'local_show';
    targetLang: string;
    start: number;
    end: number;
    startMs: number;
    endMs: number;
    durationSeconds: number;
    sentence: string | null;
    blockId?: number | string | null;
    questionId?: string;
    attemptId?: number;
    answeredAt?: number;
    positionSeconds?: number;
    watchedSeconds?: number;
    occurredAt?: number;
}

export interface WeekReport {
    version: number;
    weekStart: string;
    weekEnd: string;
    timezone: string;
    generatedAt: number;
    numbers: {
        passiveMinutes: number;
        reviewedWords: number;
        quizAccuracy: number | null;
    };
    fact: string;
    nextStep: string;
    evidence: WeekReportEvidence | null;
    streakDays: number;
    quiz: { attempts: number; correct: number };
    words: { new: number; reviewed: number; dueTomorrow: number };
}

interface ReportScreenProps {
    /** Return to the previous view (home, or the video that was open). */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Open the evidence content and seek to `evidence.start`. */
    onOpenEvidence: (evidence: WeekReportEvidence) => void;
    /** "Due tomorrow" entry: the review view. */
    onOpenReview: () => void;
}

type Phase = 'loading' | 'ready' | 'error';

const CARD = 'rounded-3xl border border-white/5 bg-zinc-900/40';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors';

function parseIsoDate(value: string): Date {
    return new Date(`${value}T00:00:00Z`);
}

function formatClock(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const mm = Math.floor(safe / 60).toString().padStart(2, '0');
    const ss = (safe % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
}

function BigStat({ label, value, testId }: { label: string; value: string; testId: string }) {
    return (
        <div className={`${CARD} px-3 py-4 sm:px-5 sm:py-5 min-w-0`}>
            <p className="text-[11px] sm:text-xs font-medium text-zinc-500 leading-snug break-words">
                {label}
            </p>
            <p
                data-testid={testId}
                className="mt-2 text-2xl sm:text-4xl font-semibold tracking-tight text-zinc-50 tabular-nums truncate"
            >
                {value}
            </p>
        </div>
    );
}

export function ReportScreen({ onClose, parentLabel, onOpenEvidence, onOpenReview }: ReportScreenProps) {
    const { t, formatNumber, formatDate } = useI18n();
    const [phase, setPhase] = useState<Phase>('loading');
    const [report, setReport] = useState<WeekReport | null>(null);
    const [errorMessage, setErrorMessage] = useState('');
    const [errorStatus, setErrorStatus] = useState<number | null>(null);

    const load = useCallback(async () => {
        setPhase('loading');
        setErrorMessage('');
        setErrorStatus(null);
        try {
            const response = await apiFetch('/api/report/week');
            if (!response.ok) {
                setErrorStatus(response.status);
                throw new Error(await describeApiError(response));
            }
            const data = (await response.json()) as WeekReport;
            if (!data?.numbers || !data.weekStart) throw new Error('invalid report payload');
            setReport(data);
            setPhase('ready');
        } catch (error) {
            setErrorMessage(await describeApiError(error));
            setPhase('error');
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const header = (
        <SubHeader
            title={t('report.title')}
            onBack={onClose}
            parentLabel={parentLabel}
            backTestId="report-back"
        />
    );

    if (phase === 'loading') {
        return (
            <div
                data-testid="report-screen"
                className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
            >
                {header}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                    <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                        <div
                            data-testid="report-loading"
                            role="status"
                            className="flex flex-col items-center justify-center py-20 text-zinc-500"
                        >
                            <Loader2 className="w-6 h-6 animate-spin" />
                            <p className="mt-3 text-sm">{t('report.loading')}</p>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    if (phase === 'error' || !report) {
        return (
            <div
                data-testid="report-screen"
                className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
            >
                {header}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                    <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                        <div data-testid="report-error" className="flex flex-col items-center justify-center py-16 text-center">
                            <AlertTriangle className="w-10 h-10 text-amber-400/70 mb-3" />
                            <p className="text-sm font-medium text-zinc-300">{t('report.error.title')}</p>
                            <p className="mt-1 max-w-md text-xs text-zinc-500 break-words">
                                {errorStatus === 503 ? t('report.error.migration') : (errorMessage || t('report.error.hint'))}
                            </p>
                            <button type="button" data-testid="report-retry" onClick={() => void load()} className={`${SECONDARY_BUTTON} mt-5`}>
                                {t('common.retry')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const numbers = report.numbers;
    const passiveMinutes = Number.isFinite(numbers.passiveMinutes) ? numbers.passiveMinutes : 0;
    const reviewedWords = Number.isFinite(numbers.reviewedWords) ? numbers.reviewedWords : 0;
    const accuracy = numbers.quizAccuracy;
    const noData = passiveMinutes === 0 && reviewedWords === 0 && accuracy == null;
    const evidence = report.evidence;
    const dueTomorrow = report.words?.dueTomorrow ?? 0;
    const accuracyText = accuracy == null
        ? t('report.emptyValue')
        : `${formatNumber(Math.round(accuracy * 1000) / 10)}%`;

    return (
        <div
            data-testid="report-screen"
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
        >
            {header}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                    <p
                        data-testid="report-week-range"
                        className="inline-flex items-center gap-1.5 text-xs text-zinc-500 tabular-nums"
                    >
                        <CalendarRange className="w-3.5 h-3.5 text-zinc-600 shrink-0" />
                        <ReportWeekRange report={report} formatDate={formatDate} />
                    </p>

                    {/* Three numbers. `null` accuracy means "no quiz attempts",
                        not 0%, so it renders the localized placeholder. */}
                    <div data-testid="report-numbers" className="grid grid-cols-3 gap-2 sm:gap-3">
                        <BigStat label={t('report.stats.passive')} value={formatNumber(passiveMinutes)} testId="report-number-passive" />
                        <BigStat label={t('report.stats.reviewed')} value={formatNumber(reviewedWords)} testId="report-number-reviewed" />
                        <BigStat label={t('report.stats.accuracy')} value={accuracyText} testId="report-number-accuracy" />
                    </div>

                    <div className="flex items-center gap-2 text-xs text-zinc-500" data-testid="report-streak">
                        <Flame className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                        <span className="tabular-nums">{t('report.streak', { count: report.streakDays })}</span>
                    </div>

                {noData && (
                    <div data-testid="report-empty" className={`${CARD} flex flex-col items-center justify-center py-10 px-6 text-center`}>
                        <CalendarOff className="w-10 h-10 text-zinc-700 mb-3" />
                        <p className="text-sm font-medium text-zinc-400">{t('report.empty.title')}</p>
                        <p className="mt-1 text-xs text-zinc-600">{t('report.empty.hint')}</p>
                    </div>
                )}

                {/* Fact + next step (server-generated copy, verbatim). */}
                <section data-testid="report-fact" className={`${CARD} p-5 sm:p-6`}>
                    <div className="flex items-start gap-3">
                        <Quote className="w-4 h-4 mt-0.5 text-zinc-600 shrink-0" />
                        <div className="min-w-0">
                            <p className="text-[11px] font-medium text-zinc-500">{t('report.factLabel')}</p>
                            <p className="mt-1.5 text-[15px] sm:text-base leading-relaxed text-zinc-200 break-words">
                                {report.fact}
                            </p>
                        </div>
                    </div>
                    <div className="mt-4 rounded-2xl bg-blue-500/[0.07] border border-blue-500/15 px-4 py-3.5">
                        <p className="text-[11px] font-medium text-blue-300/80">{t('report.nextLabel')}</p>
                        <p data-testid="report-next-step" className="mt-1 text-sm font-medium text-zinc-100 break-words">
                            {report.nextStep}
                        </p>
                    </div>
                </section>

                {/* Evidence: 5-second review window from the backend. */}
                {evidence ? (
                    <section data-testid="report-evidence" className={`${CARD} p-5 sm:p-6`}>
                        <div className="flex items-center justify-between gap-3">
                            <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                                {t('report.evidence.title')}
                            </h2>
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/60 border border-white/5 text-zinc-400 shrink-0">
                                {evidence.source === 'quiz_wrong'
                                    ? t('report.evidence.fromQuiz')
                                    : t('report.evidence.fromWatch')}
                            </span>
                        </div>
                        {evidence.sentence ? (
                            <blockquote
                                data-testid="report-evidence-sentence"
                                className="mt-4 border-l-2 border-blue-500/40 pl-3 text-base leading-relaxed text-zinc-100 break-words"
                            >
                                {evidence.sentence}
                            </blockquote>
                        ) : (
                            <p data-testid="report-evidence-sentence" className="mt-4 text-sm text-zinc-500">
                                {t('report.evidence.noSentence')}
                            </p>
                        )}
                        <div className="mt-4 flex items-center justify-between gap-3">
                            <span className="text-[11px] font-medium text-zinc-500 tabular-nums">
                                {t('report.evidence.at', { time: formatClock(evidence.start) })}
                            </span>
                            <button
                                type="button"
                                data-testid="report-evidence-replay"
                                onClick={() => onOpenEvidence(evidence)}
                                className="inline-flex items-center justify-center gap-2 h-9 px-4 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-sm font-medium text-blue-300 hover:text-blue-200 transition-colors shrink-0"
                            >
                                {t('report.evidence.replay', { time: formatClock(evidence.start) })}
                                <ArrowRight className="w-4 h-4" />
                            </button>
                        </div>
                    </section>
                ) : !noData ? (
                    <section data-testid="report-evidence-empty" className={`${CARD} flex flex-col items-center justify-center py-10 px-6 text-center`}>
                        <CalendarOff className="w-8 h-8 text-zinc-700 mb-2.5" />
                        <p className="text-sm font-medium text-zinc-400">{t('report.evidence.emptyTitle')}</p>
                        <p className="mt-1 text-xs text-zinc-600">{t('report.evidence.emptyHint')}</p>
                    </section>
                ) : null}

                {/* Due-tomorrow entry into the existing review view. */}
                {dueTomorrow > 0 && (
                    <button
                        type="button"
                        data-testid="report-due-button"
                        data-count={dueTomorrow}
                        onClick={onOpenReview}
                        className={`${CARD} w-full flex items-center gap-4 p-4 sm:p-5 text-left hover:bg-zinc-800/60 hover:border-white/10 transition-colors`}
                    >
                        <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                            <Repeat className="w-5 h-5 text-blue-400" />
                        </div>
                        <span className="flex-1 min-w-0 text-sm font-medium text-zinc-200">
                            {t('report.dueTomorrow', { count: dueTomorrow })}
                        </span>
                        <ArrowRight className="w-4 h-4 text-zinc-500 shrink-0" />
                    </button>
                )}

                <p className="pb-2 text-center text-[11px] text-zinc-600">
                    {t('report.footer')}
                </p>
                </div>
            </div>
        </div>
    );
}

/**
 * Monday→today range. The report week is UTC-based; "today" is the viewer's
 * calendar day, clamped to the week so a just-opened report never shows an
 * inverted range around the UTC/local midnight boundary.
 */
function ReportWeekRange({
    report,
    formatDate,
}: {
    report: WeekReport;
    formatDate: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
}) {
    const start = parseIsoDate(report.weekStart);
    const endExclusive = parseIsoDate(report.weekEnd);
    const now = new Date();
    const today = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
    const lastDay = new Date(Math.min(today.getTime(), endExclusive.getTime() - 86_400_000));
    const safeLast = lastDay.getTime() < start.getTime() ? start : lastDay;
    const options: Intl.DateTimeFormatOptions = { month: 'short', day: 'numeric', timeZone: 'UTC' };
    return (
        <>
            {formatDate(start, options)}
            <span aria-hidden="true">–</span>
            {formatDate(safeLast, options)}
        </>
    );
}
