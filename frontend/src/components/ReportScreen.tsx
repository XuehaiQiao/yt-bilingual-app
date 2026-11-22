// Weekly report view (specs/015-weekly-report, M5 frontend).
//
// Read-only render of `GET /api/report/week`: the backend owns every number,
// the fact sentence, the next step and the evidence window. This screen only
// formats them (and localizes its own chrome) and hands the evidence back to
// the app shell so the existing player/history path can seek there.
//
// Desktop layout (docs/设计-桌面布局规范.md, P2-02): a `standard` page container
// with a ≥xl two-column grid. The left column carries the facts/numbers/evidence;
// the right rail carries the explanation, the next step and the entry actions.
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
import { REVIEW_UI_ENABLED } from '../lib/review';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import { Button } from './ui/Button';
import { Card } from './ui/Card';
import { SubHeader } from './ui/SubHeader';
import { PageContainer } from './layout/PageContainer';
import { PageGrid } from './layout/PageGrid';
import { SideRail } from './layout/SideRail';

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
        <Card
            variant="card"
            padding="none"
            className="min-w-0 rounded-panel px-3 py-4 sm:px-5 sm:py-5"
        >
            <p className="text-micro font-medium leading-snug break-words text-fg-muted sm:text-xs">
                {label}
            </p>
            <p
                data-testid={testId}
                className="mt-2 truncate text-2xl font-semibold tracking-tight text-fg-primary tabular-nums sm:text-4xl"
            >
                {value}
            </p>
        </Card>
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
                className="flex-1 min-h-0 flex flex-col overflow-hidden bg-app"
            >
                {header}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                    <PageContainer variant="standard" className="py-4 sm:py-8">
                        <div
                            data-testid="report-loading"
                            role="status"
                            className="flex flex-col items-center justify-center py-20 text-fg-secondary"
                        >
                            <Loader2 className="h-6 w-6 animate-spin" />
                            <p className="mt-3 text-ui">{t('report.loading')}</p>
                        </div>
                    </PageContainer>
                </div>
            </div>
        );
    }

    if (phase === 'error' || !report) {
        return (
            <div
                data-testid="report-screen"
                className="flex-1 min-h-0 flex flex-col overflow-hidden bg-app"
            >
                {header}
                <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                    <PageContainer variant="standard" className="py-4 sm:py-8">
                        <div data-testid="report-error" className="flex flex-col items-center justify-center py-16 text-center">
                            <AlertTriangle className="mb-3 h-10 w-10 text-warning-fg/70" />
                            <p className="text-ui font-medium text-fg-strong">{t('report.error.title')}</p>
                            <p className="mt-1 max-w-md break-words text-caption text-fg-secondary">
                                {errorStatus === 503 ? t('report.error.migration') : (errorMessage || t('report.error.hint'))}
                            </p>
                            <Button
                                variant="secondary"
                                size="lg"
                                testId="report-retry"
                                onClick={() => void load()}
                                className="mt-5 px-4"
                            >
                                {t('common.retry')}
                            </Button>
                        </div>
                    </PageContainer>
                </div>
            </div>
        );
    }

    const numbers = report.numbers;
    const passiveMinutes = Number.isFinite(numbers.passiveMinutes) ? numbers.passiveMinutes : 0;
    const reviewedWords = Number.isFinite(numbers.reviewedWords) ? numbers.reviewedWords : 0;
    const accuracy = numbers.quizAccuracy;
    // 复习词数 is hidden while the review UI is paused, so it must not decide
    // whether the week has data either.
    const noData = passiveMinutes === 0
        && accuracy == null
        && (!REVIEW_UI_ENABLED || reviewedWords === 0);
    const evidence = report.evidence;
    const dueTomorrow = report.words?.dueTomorrow ?? 0;
    const accuracyText = accuracy == null
        ? t('report.emptyValue')
        : `${formatNumber(Math.round(accuracy * 1000) / 10)}%`;

    const dueButton = REVIEW_UI_ENABLED && dueTomorrow > 0 ? (
        <Card
            variant="interactive"
            padding="none"
            data-count={dueTomorrow}
            onClick={onOpenReview}
            testId="report-due-button"
            className="flex w-full items-center gap-4 rounded-panel p-4 text-left sm:p-5"
        >
            <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-card border border-brand/20 bg-brand/10">
                <Repeat className="h-5 w-5 text-brand-300" />
            </span>
            <span className="min-w-0 flex-1 text-ui font-medium text-fg-primary">
                {t('report.dueTomorrow', { count: dueTomorrow })}
            </span>
            <ArrowRight className="h-4 w-4 shrink-0 text-fg-muted" />
        </Card>
    ) : null;

    // Right rail: explanation, next step and actions. The two review-gated
    // blocks keep their existing visibility contract (specs/013 2026-11-22).
    const rail = (
        <SideRail testId="report-rail">
            {REVIEW_UI_ENABLED && (
                <Card
                    as="section"
                    padding="none"
                    testId="report-next-step-card"
                    className="rounded-panel border-brand/15 bg-brand/[0.07] p-4"
                >
                    <p className="text-micro font-medium text-brand-300/80">{t('report.nextLabel')}</p>
                    <p data-testid="report-next-step" className="mt-1 break-words text-ui font-medium text-fg-primary">
                        {report.nextStep}
                    </p>
                </Card>
            )}
            {dueButton}
            <Card
                as="section"
                padding="none"
                testId="report-explanation"
                className="rounded-panel p-4 sm:p-5"
            >
                <p className="text-caption leading-relaxed text-fg-secondary">
                    {t('report.footer')}
                </p>
            </Card>
        </SideRail>
    );

    return (
        <div
            data-testid="report-screen"
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-app"
        >
            {header}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                <PageContainer variant="standard" className="py-4 sm:py-8">
                    <PageGrid testId="report-grid" railTestId="report-rail-slot" rail={rail}>
                        <div className="flex flex-col gap-4 sm:gap-6">
                            <p
                                data-testid="report-week-range"
                                className="inline-flex items-center gap-1.5 text-xs text-fg-muted tabular-nums"
                            >
                                <CalendarRange className="h-3.5 w-3.5 shrink-0 text-fg-disabled" />
                                <ReportWeekRange report={report} formatDate={formatDate} />
                            </p>

                            {/* Three numbers. `null` accuracy means "no quiz attempts",
                                not 0%, so it renders the localized placeholder.
                                复习词数 disappears with the review UI (specs/013
                                2026-11-22); the other two facts stay. */}
                            <div
                                data-testid="report-numbers"
                                className={`grid ${REVIEW_UI_ENABLED ? 'grid-cols-3' : 'grid-cols-2'} gap-2 sm:gap-3`}
                            >
                                <BigStat label={t('report.stats.passive')} value={formatNumber(passiveMinutes)} testId="report-number-passive" />
                                {REVIEW_UI_ENABLED && (
                                    <BigStat label={t('report.stats.reviewed')} value={formatNumber(reviewedWords)} testId="report-number-reviewed" />
                                )}
                                <BigStat label={t('report.stats.accuracy')} value={accuracyText} testId="report-number-accuracy" />
                            </div>

                            <div className="flex items-center gap-2 text-xs text-fg-muted" data-testid="report-streak">
                                <Flame className="h-3.5 w-3.5 shrink-0 text-fg-muted" />
                                <span className="tabular-nums">{t('report.streak', { count: report.streakDays })}</span>
                            </div>

                            {noData && (
                                <Card
                                    as="section"
                                    padding="none"
                                    testId="report-empty"
                                    className="flex flex-col items-center justify-center rounded-panel px-6 py-10 text-center"
                                >
                                    <CalendarOff className="mb-3 h-10 w-10 text-fg-disabled" />
                                    <p className="text-ui font-medium text-fg-strong">{t('report.empty.title')}</p>
                                    <p className="mt-1 text-caption text-fg-secondary">{t('report.empty.hint')}</p>
                                </Card>
                            )}

                            {/* Fact (server-generated copy, verbatim). */}
                            <Card
                                as="section"
                                padding="none"
                                testId="report-fact"
                                className="rounded-panel p-5 sm:p-6"
                            >
                                <div className="flex items-start gap-3">
                                    <Quote className="mt-0.5 h-4 w-4 shrink-0 text-fg-disabled" />
                                    <div className="min-w-0">
                                        <p className="text-micro font-medium text-fg-secondary">{t('report.factLabel')}</p>
                                        <p className="mt-1.5 break-words text-body-zh leading-relaxed text-fg-primary sm:text-body">
                                            {report.fact}
                                        </p>
                                    </div>
                                </div>
                            </Card>

                            {/* Evidence: 5-second review window from the backend. */}
                            {evidence ? (
                                <Card
                                    as="section"
                                    padding="none"
                                    testId="report-evidence"
                                    className="rounded-panel p-5 sm:p-6"
                                >
                                    <div className="flex items-center justify-between gap-3">
                                        <h2 className="text-section font-semibold tracking-tight text-fg-primary">
                                            {t('report.evidence.title')}
                                        </h2>
                                        <span className="shrink-0 rounded-full border border-line-subtle bg-surface-2/60 px-2 py-0.5 text-micro font-medium text-fg-secondary">
                                            {evidence.source === 'quiz_wrong'
                                                ? t('report.evidence.fromQuiz')
                                                : t('report.evidence.fromWatch')}
                                        </span>
                                    </div>
                                    {evidence.sentence ? (
                                        <blockquote
                                            data-testid="report-evidence-sentence"
                                            className="mt-4 border-l-2 border-brand/40 pl-3 text-body leading-relaxed text-fg-primary break-words"
                                        >
                                            {evidence.sentence}
                                        </blockquote>
                                    ) : (
                                        <p data-testid="report-evidence-sentence" className="mt-4 text-ui text-fg-secondary">
                                            {t('report.evidence.noSentence')}
                                        </p>
                                    )}
                                    <div className="mt-4 flex items-center justify-between gap-3">
                                        <span className="text-micro font-medium text-fg-muted tabular-nums">
                                            {t('report.evidence.at', { time: formatClock(evidence.start) })}
                                        </span>
                                        <button
                                            type="button"
                                            data-testid="report-evidence-replay"
                                            onClick={() => onOpenEvidence(evidence)}
                                            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-control-lg border border-brand/20 bg-brand/10 px-4 text-ui font-medium text-brand-300 transition-colors hover:bg-brand/15"
                                        >
                                            {t('report.evidence.replay', { time: formatClock(evidence.start) })}
                                            <ArrowRight className="h-4 w-4" />
                                        </button>
                                    </div>
                                </Card>
                            ) : !noData ? (
                                <Card
                                    as="section"
                                    padding="none"
                                    testId="report-evidence-empty"
                                    className="flex flex-col items-center justify-center rounded-panel px-6 py-10 text-center"
                                >
                                    <CalendarOff className="mb-2.5 h-8 w-8 text-fg-disabled" />
                                    <p className="text-ui font-medium text-fg-strong">{t('report.evidence.emptyTitle')}</p>
                                    <p className="mt-1 text-caption text-fg-secondary">{t('report.evidence.emptyHint')}</p>
                                </Card>
                            ) : null}
                        </div>
                    </PageGrid>
                </PageContainer>
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
