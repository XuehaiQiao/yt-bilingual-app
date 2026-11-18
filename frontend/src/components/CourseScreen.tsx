// 12-minute course screen (specs/029-course-mvp).
//
// One lesson, one step at a time: S0 intro → S1 word cards → S2–S4 read /
// explain / two questions each → S5 writing + two exit-ticket questions.
// The backend owns the attempt (current step, answers, output, score); this
// screen starts or resumes it and mirrors the served content. It never knows
// an answer key before the answer endpoint replies, and the 12:00 timer is
// display-only by product decision — reaching 00:00 never locks the learner
// out.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    ArrowRight,
    Check,
    CheckCircle2,
    Clock3,
    Eye,
    EyeOff,
    GraduationCap,
    Lightbulb,
    Loader2,
    Lock,
    LogIn,
    PenLine,
    RefreshCw,
    X,
    XCircle,
} from 'lucide-react';
import type { TranslationKey } from '../i18n';
import { useI18n } from '../i18n/I18nProvider';
import { SubHeader } from './ui/SubHeader';
import {
    completeCourseAttempt,
    countCourseWords,
    courseErrorTranslationKey,
    fetchCourseLesson,
    isCourseAbortError,
    saveCourseOutput,
    sendCourseDropBeacon,
    sendCourseEvent,
    sendCourseOutputKeepalive,
    setCourseStep,
    startCourseAttempt,
    submitCourseAnswer,
    type CourseAnswerResult,
    type CourseAttempt,
    type CourseLesson,
    type CourseQuestion,
    type CourseStep,
    type CourseWordPoint,
} from '../lib/course';
import { toast } from '../lib/toast';

interface CourseScreenProps {
    lessonId: string;
    isGuest: boolean;
    /** Guest entry: open the app's auth overlay. */
    onRequestLogin?: () => void;
    /** Leave the lesson (back to the entry page, today by default). */
    onExit: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
}

interface CompletionState {
    score: number;
    total: number;
    output: string;
    completedAt: number | null;
}

interface LoadedCourse {
    lesson: CourseLesson;
    attempt: CourseAttempt;
}

const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 sm:h-11 px-4 sm:px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-40 disabled:active:scale-100 disabled:hover:bg-zinc-100';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 sm:h-11 px-4 sm:px-5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-40';
const CARD = 'rounded-2xl sm:rounded-3xl border border-white/5 bg-zinc-900/40';
const OPTION_BASE =
    'w-full flex items-start gap-3 rounded-xl border px-3.5 sm:px-4 py-3 text-left transition-[background-color,border-color,color] duration-200';

function formatClock(remainingMs: number): string {
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

async function loadCourse(lessonId: string, signal: AbortSignal): Promise<LoadedCourse> {
    // Detail first: a missing lesson must not create an attempt.
    const lesson = await fetchCourseLesson(lessonId, signal);
    const attempt = await startCourseAttempt(lessonId, signal);
    return { lesson, attempt };
}

function scrollPageToTop(node: HTMLDivElement | null): void {
    if (!node) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    node.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
}

function CourseHeader({
    lesson,
    stepIndex,
    totalSteps,
    remainingMs,
    timeOver,
    showTimer,
    showProgress,
    onExit,
    parentLabel,
}: {
    lesson: CourseLesson;
    stepIndex: number;
    totalSteps: number;
    remainingMs: number;
    timeOver: boolean;
    showTimer: boolean;
    showProgress: boolean;
    onExit: () => void;
    parentLabel?: string;
}) {
    const { t, language } = useI18n();
    const title = language === 'zh-CN' && lesson.titleZh ? lesson.titleZh : lesson.title;
    const subtitle = language === 'zh-CN' ? lesson.title : lesson.titleZh;
    const meta = [
        lesson.level,
        lesson.durationMinutes ? t('course.meta.minutes', { minutes: lesson.durationMinutes }) : null,
    ].filter(Boolean).join(' · ');
    const timerTone = remainingMs <= 120_000 ? 'text-amber-300' : 'text-zinc-300';

    return (
        <>
            <SubHeader
                title={title}
                onBack={onExit}
                parentLabel={parentLabel}
                meta={<span className="hidden sm:inline-flex">{[subtitle, meta].filter(Boolean).join(' · ')}</span>}
                backLabel={t('course.exit')}
                backTestId="course-exit"
                titleTestId="course-title"
                testId="course-header"
                titleAs="p"
            />

            {(showProgress || showTimer) && (
                <div
                    data-testid="course-toolbar"
                    className="flex-none border-b border-white/5 bg-zinc-950/40 px-3 pb-2.5 pt-2 sm:px-4 lg:px-6"
                >
                    <div className="mx-auto w-full max-w-5xl">
                        <div className="mb-1.5 flex items-center justify-between gap-3">
                            <p className="min-w-0 truncate text-[11px] text-zinc-500">
                                {t('course.progress')}
                            </p>
                            <div className="flex shrink-0 items-center gap-2">
                                {timeOver && showTimer && (
                                    <p className="text-[11px] text-amber-300/90">{t('course.timer.over')}</p>
                                )}
                                {showProgress && (
                                    <span
                                        data-testid="course-step-count"
                                        className="inline-flex items-center whitespace-nowrap text-[11px] font-medium text-zinc-400 tabular-nums"
                                    >
                                        {t('course.stepOf', { current: stepIndex + 1, total: totalSteps })}
                                    </span>
                                )}
                                {showTimer && (
                                    <span
                                        data-testid="course-timer"
                                        data-over={timeOver ? 'true' : 'false'}
                                        role="timer"
                                        aria-label={t('course.timer.remaining')}
                                        title={timeOver ? t('course.timer.over') : t('course.timer.remaining')}
                                        className={`inline-flex h-7 items-center gap-1.5 rounded-lg border border-white/5 bg-zinc-800/50 px-2.5 text-xs font-medium tabular-nums ${timerTone}`}
                                    >
                                        <Clock3 className="w-3.5 h-3.5" />
                                        {formatClock(remainingMs)}
                                    </span>
                                )}
                            </div>
                        </div>
                        {showProgress && (
                            <div
                                data-testid="course-progress"
                                role="progressbar"
                                aria-valuemin={0}
                                aria-valuemax={totalSteps}
                                aria-valuenow={stepIndex + 1}
                                aria-label={t('course.progress')}
                                className="h-1.5 rounded-full bg-zinc-800 overflow-hidden"
                            >
                                <div
                                    className="h-full rounded-full bg-brand transition-[width] duration-300 ease-apple"
                                    style={{ width: `${Math.round(((stepIndex + 1) / Math.max(1, totalSteps)) * 100)}%` }}
                                />
                            </div>
                        )}
                    </div>
                </div>
            )}
        </>
    );
}

function QuestionBlock({
    question,
    number,
    chosen,
    result,
    pending,
    disabled,
    onAnswer,
}: {
    question: CourseQuestion;
    number: number;
    chosen: string | undefined;
    result: CourseAnswerResult | undefined;
    pending: boolean;
    disabled: boolean;
    onAnswer: (question: CourseQuestion, choice: string) => void;
}) {
    const { t } = useI18n();
    const answered = Boolean(chosen);
    const correctChoice = result?.correctChoice;
    const correctOption = correctChoice
        ? question.options.find(option => option.id === correctChoice)
        : undefined;
    const locked = answered || pending || disabled;

    return (
        <div
            id={`course-q-${question.id}`}
            data-testid={`course-question-${question.id}`}
            className="rounded-2xl border border-white/5 bg-zinc-900/30 p-3.5 sm:p-4"
        >
            <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                    <p className="text-[11px] font-medium text-zinc-500 tabular-nums">
                        {t('course.question.number', { number })}
                    </p>
                    <p className="mt-1 text-[14px] sm:text-[15px] font-medium leading-relaxed text-zinc-100">
                        {question.prompt}
                    </p>
                </div>
                {answered && (
                    <span className="shrink-0 text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/70 border border-white/5 text-zinc-400">
                        {t('course.answer.answered')}
                    </span>
                )}
            </div>

            <div className="mt-3 space-y-2" role="group" aria-label={question.prompt}>
                {question.options.map(option => {
                    const isChosen = chosen === option.id;
                    const isCorrect = Boolean(result?.correct && isChosen);
                    const isWrong = Boolean(result && !result.correct && isChosen);
                    const isRevealedCorrect = Boolean(result && !result.correct && correctChoice === option.id);
                    let tone = 'border-white/5 bg-zinc-800/30 text-zinc-300';
                    if (isCorrect || isRevealedCorrect) {
                        tone = 'border-emerald-500/30 bg-emerald-500/10 text-emerald-200';
                    } else if (isWrong) {
                        tone = 'border-red-500/30 bg-red-500/10 text-red-200';
                    } else if (isChosen) {
                        tone = 'border-blue-500/30 bg-blue-500/10 text-blue-100';
                    } else if (locked) {
                        tone = 'border-white/5 bg-zinc-800/20 text-zinc-500';
                    } else {
                        tone += ' hover:bg-zinc-800/60 hover:border-white/10';
                    }
                    return (
                        <button
                            key={option.id}
                            type="button"
                            data-testid={`course-option-${question.id}-${option.id}`}
                            data-state={
                                isCorrect || isRevealedCorrect
                                    ? 'correct'
                                    : isWrong
                                        ? 'wrong'
                                        : isChosen
                                            ? 'chosen'
                                            : 'idle'
                            }
                            onClick={() => onAnswer(question, option.id)}
                            disabled={locked}
                            aria-pressed={isChosen}
                            className={`${OPTION_BASE} ${tone} ${locked && !isChosen && !isRevealedCorrect ? 'cursor-default' : 'active:scale-[0.99]'}`}
                        >
                            <span
                                className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-semibold shrink-0 ${
                                    isCorrect || isRevealedCorrect
                                        ? 'bg-emerald-500/20 text-emerald-200'
                                        : isWrong
                                            ? 'bg-red-500/20 text-red-200'
                                            : isChosen
                                                ? 'bg-blue-500/20 text-blue-200'
                                                : 'bg-zinc-700/50 text-zinc-400'
                                }`}
                            >
                                {option.id}
                            </span>
                            <span className="flex-1 text-[13px] sm:text-sm leading-relaxed">{option.text}</span>
                            {isCorrect && <Check className="w-4 h-4 text-emerald-300 shrink-0 mt-0.5" />}
                            {isWrong && <X className="w-4 h-4 text-red-300 shrink-0 mt-0.5" />}
                        </button>
                    );
                })}
            </div>

            {pending && !result && (
                <p className="mt-2.5 inline-flex items-center gap-1.5 text-xs text-zinc-500">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    {t('course.answer.submitting')}
                </p>
            )}

            {result && (
                <div
                    data-testid={`course-feedback-${question.id}`}
                    role="status"
                    className={`mt-3 rounded-xl border px-3.5 py-3 ${
                        result.correct
                            ? 'border-emerald-500/20 bg-emerald-500/[0.06]'
                            : 'border-red-500/20 bg-red-500/[0.06]'
                    }`}
                >
                    <p
                        className={`flex items-center gap-1.5 text-[13px] font-medium ${
                            result.correct ? 'text-emerald-300' : 'text-red-300'
                        }`}
                    >
                        {result.correct
                            ? <CheckCircle2 className="w-4 h-4" />
                            : <XCircle className="w-4 h-4" />}
                        {result.correct ? t('course.answer.correct') : t('course.answer.incorrect')}
                    </p>
                    {!result.correct && correctChoice && (
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-300">
                            {t('course.answer.correctChoice', {
                                choice: correctOption
                                    ? `${correctChoice}. ${correctOption.text}`
                                    : correctChoice,
                            })}
                        </p>
                    )}
                    {result.explanation && (
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                            <span className="font-medium text-zinc-300">
                                {t('course.answer.explanation')}
                            </span>
                            {' · '}
                            {result.explanation}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
}

function CourseGuest({ onRequestLogin, onExit, parentLabel }: Pick<CourseScreenProps, 'onRequestLogin' | 'onExit'> & { parentLabel?: string }) {
    const { t } = useI18n();
    return (
        <div className="flex-1 min-h-0 flex flex-col bg-[#09090b]" data-testid="course-guest">
            <SubHeader
                title={t('course.entry.badgeShort')}
                onBack={onExit}
                parentLabel={parentLabel}
                backLabel={t('course.exit')}
                backTestId="course-exit"
                titleAs="p"
            />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="mx-auto w-full max-w-xl px-4 sm:px-6 py-12 sm:py-20">
                    <div className={`${CARD} p-6 sm:p-8 text-center`}>
                        <div className="mx-auto w-12 h-12 rounded-2xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center">
                            <LogIn className="w-5 h-5 text-blue-400" />
                        </div>
                        <h1 className="mt-4 text-xl sm:text-2xl font-semibold tracking-tight text-zinc-100">
                            {t('course.guest.title')}
                        </h1>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                            {t('course.guest.body')}
                        </p>
                        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2">
                            <button
                                type="button"
                                data-testid="course-guest-login"
                                onClick={onRequestLogin}
                                className={PRIMARY_BUTTON}
                            >
                                <LogIn className="w-4 h-4" />
                                {t('course.guest.login')}
                            </button>
                            <button
                                type="button"
                                data-testid="course-guest-back"
                                onClick={onExit}
                                className={SECONDARY_BUTTON}
                            >
                                {t('course.guest.back')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
}

export function CourseScreen({ lessonId, isGuest, onRequestLogin, onExit, parentLabel }: CourseScreenProps) {
    const { t, formatNumber } = useI18n();
    const [loadPhase, setLoadPhase] = useState<'loading' | 'ready' | 'error'>('loading');
    const [loadErrorKey, setLoadErrorKey] = useState<TranslationKey>('course.error.generic');
    const [reloadNonce, setReloadNonce] = useState(0);
    const [lesson, setLesson] = useState<CourseLesson | null>(null);
    const [attempt, setAttempt] = useState<CourseAttempt | null>(null);
    const [currentStepId, setCurrentStepId] = useState('');
    const [answers, setAnswers] = useState<Record<string, string>>({});
    const [feedback, setFeedback] = useState<Record<string, CourseAnswerResult>>({});
    const [answerPending, setAnswerPending] = useState<Record<string, boolean>>({});
    const [revealed, setRevealed] = useState<Record<string, boolean>>({});
    const [showZh, setShowZh] = useState(true);
    const [output, setOutput] = useState('');
    const [outputDirty, setOutputDirty] = useState(false);
    const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
    const [submitState, setSubmitState] = useState<'idle' | 'submitting'>('idle');
    const [formError, setFormError] = useState<string | null>(null);
    const [advancing, setAdvancing] = useState(false);
    const [completed, setCompleted] = useState<CompletionState | null>(null);
    const [now, setNow] = useState(() => Date.now());

    const scrollRef = useRef<HTMLDivElement | null>(null);
    const textareaRef = useRef<HTMLTextAreaElement | null>(null);
    const attemptRef = useRef<CourseAttempt | null>(null);
    const stepRef = useRef('');
    const outputRef = useRef('');
    const outputDirtyRef = useRef(false);
    const mountedRef = useRef(true);
    const completedRef = useRef(false);
    const dropSentRef = useRef(false);
    const lastStepViewRef = useRef<string | null>(null);
    const stepEnteredAtRef = useRef(Date.now());
    const advancingRef = useRef(false);
    const submittingRef = useRef(false);
    const answerPendingRef = useRef<Set<string>>(new Set());
    const outputSubmittedRef = useRef(false);
    const actionAbortRef = useRef<AbortController>(new AbortController());
    // Shared load promise: React StrictMode re-runs the mount effect once in
    // development. Reusing one promise (with a delayed abort on cleanup) keeps
    // a single start request instead of creating two attempts.
    const loadRef = useRef<{
        key: string;
        promise: Promise<LoadedCourse>;
        controller: AbortController;
        cancelTimer: number | null;
    } | null>(null);

    useEffect(() => {
        mountedRef.current = true;
        return () => {
            mountedRef.current = false;
        };
    }, []);

    useEffect(() => {
        const controller = new AbortController();
        actionAbortRef.current = controller;
        return () => controller.abort();
    }, []);

    // Unmount drop (spec §4): sendBeacon, but let a StrictMode remount cancel
    // the delayed send first. `pagehide` covers a tab close where React never
    // gets to run the cleanup.
    useEffect(() => {
        const sendDrop = () => {
            const current = attemptRef.current;
            if (!current || completedRef.current || dropSentRef.current) return;
            dropSentRef.current = true;
            // Persisting the written output is more important than the event:
            // flush it on the same unload path before the drop beacon.
            if (outputDirtyRef.current) {
                sendCourseOutputKeepalive(current.attemptId, outputRef.current);
            }
            sendCourseDropBeacon(current.attemptId, stepRef.current);
        };
        const onPageHide = () => sendDrop();
        window.addEventListener('pagehide', onPageHide);
        return () => {
            window.removeEventListener('pagehide', onPageHide);
            window.setTimeout(() => {
                if (mountedRef.current) return;
                sendDrop();
            }, 250);
        };
    }, []);

    // Load lesson + attempt. Guests never reach this branch.
    useEffect(() => {
        if (isGuest) return;
        const key = `${lessonId}:${reloadNonce}`;
        if (loadRef.current && loadRef.current.key !== key) {
            loadRef.current.controller.abort();
            loadRef.current = null;
        }
        if (!loadRef.current) {
            const controller = new AbortController();
            loadRef.current = {
                key,
                controller,
                promise: loadCourse(lessonId, controller.signal),
                cancelTimer: null,
            };
        }
        const task = loadRef.current;
        if (task.cancelTimer !== null) {
            window.clearTimeout(task.cancelTimer);
            task.cancelTimer = null;
        }
        let cancelled = false;

        setLoadPhase('loading');
        setLoadErrorKey('course.error.generic');
        setLesson(null);
        setAttempt(null);
        setCurrentStepId('');
        setAnswers({});
        setFeedback({});
        setOutput('');
        setOutputDirty(false);
        outputDirtyRef.current = false;
        setSaveState('idle');
        setFormError(null);
        setCompleted(null);
        setRevealed({});
        completedRef.current = false;
        attemptRef.current = null;
        stepRef.current = '';
        outputRef.current = '';
        lastStepViewRef.current = null;
        outputSubmittedRef.current = false;
        answerPendingRef.current.clear();

        void task.promise
            .then(({ lesson: loadedLesson, attempt: loadedAttempt }) => {
                if (cancelled) return;
                const hasStep = loadedLesson.steps.some(step => step.id === loadedAttempt.currentStepId);
                const initialStepId = hasStep
                    ? loadedAttempt.currentStepId
                    : loadedLesson.steps[0]?.id ?? '';
                setLesson(loadedLesson);
                setAttempt(loadedAttempt);
                setCurrentStepId(initialStepId);
                setAnswers(loadedAttempt.answers);
                setOutput(loadedAttempt.output);
                outputRef.current = loadedAttempt.output;
                attemptRef.current = loadedAttempt;
                stepRef.current = initialStepId;
                stepEnteredAtRef.current = Date.now();
                setLoadPhase('ready');

                if (loadedAttempt.status === 'completed') {
                    completedRef.current = true;
                    setCompleted({
                        score: loadedAttempt.score ?? 0,
                        total: loadedAttempt.total ?? countCourseQuestions(loadedLesson),
                        output: loadedAttempt.output,
                        completedAt: loadedAttempt.completedAt,
                    });
                    return;
                }

                if (!loadedAttempt.resumed) {
                    sendCourseEvent(loadedAttempt.attemptId, 'lesson_start', initialStepId, {
                        lessonId: loadedLesson.id,
                        version: loadedLesson.version,
                    });
                }

                // Restore correctness/explanations after a refresh. Re-posting
                // the same choice is documented as idempotent (`换 choice 409`),
                // so this only reads the server's verdict, never changes it.
                const restored = Object.entries(loadedAttempt.answers);
                if (restored.length > 0) {
                    const signal = actionAbortRef.current.signal;
                    void Promise.all(restored.map(async ([questionId, choice]) => {
                        try {
                            const result = await submitCourseAnswer(
                                loadedAttempt.attemptId,
                                questionId,
                                choice,
                                signal,
                            );
                            if (mountedRef.current && !signal.aborted) {
                                setFeedback(prev => ({ ...prev, [questionId]: result }));
                            }
                        } catch {
                            // Keep the restored selection visible; the answer
                            // endpoint may be temporarily unreachable.
                        }
                    }));
                }
            })
            .catch((error: unknown) => {
                if (cancelled) return;
                if (isCourseAbortError(error)) return;
                setLoadPhase('error');
                setLoadErrorKey(
                    error instanceof Error && 'code' in error
                        ? courseErrorTranslationKey(error.code as Parameters<typeof courseErrorTranslationKey>[0])
                        : 'course.error.generic',
                );
            });

        return () => {
            cancelled = true;
            if (task.cancelTimer !== null) window.clearTimeout(task.cancelTimer);
            task.cancelTimer = window.setTimeout(() => {
                if (loadRef.current === task) {
                    task.controller.abort();
                    loadRef.current = null;
                }
            }, 300);
        };
    }, [isGuest, lessonId, reloadNonce]);

    // Timer: display only. It is anchored to the server's startedAt so a
    // refresh does not reset the clock; 00:00 is informative, never blocking.
    useEffect(() => {
        if (loadPhase !== 'ready' || !attempt?.startedAt || completed) return;
        setNow(Date.now());
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [attempt?.startedAt, loadPhase, completed]);

    const durationMs = (lesson?.durationMinutes ?? 12) * 60_000;
    const remainingMs = attempt?.startedAt
        ? Math.min(durationMs, Math.max(0, attempt.startedAt + durationMs - now))
        : durationMs;
    const timeOver = remainingMs <= 0;

    const currentStepIndex = useMemo(() => {
        if (!lesson) return 0;
        const index = lesson.steps.findIndex(step => step.id === currentStepId);
        return index < 0 ? 0 : index;
    }, [lesson, currentStepId]);
    const currentStep: CourseStep | null = lesson?.steps[currentStepIndex] ?? null;

    const allQuestions = useMemo(() => {
        if (!lesson) return [] as CourseQuestion[];
        const questions: CourseQuestion[] = [];
        for (const step of lesson.steps) {
            if (step.questions) questions.push(...step.questions);
            if (step.exitTicket) questions.push(...step.exitTicket);
        }
        return questions;
    }, [lesson]);
    const totalQuestionCount = allQuestions.length;
    const answeredQuestionCount = allQuestions.filter(question => answers[question.id]).length;

    const questionNumbers = useMemo(() => {
        const numbers = new Map<string, number>();
        allQuestions.forEach((question, index) => numbers.set(question.id, index + 1));
        return numbers;
    }, [allQuestions]);

    const currentQuestions = useMemo(() => {
        if (!currentStep) return [] as CourseQuestion[];
        if (currentStep.type === 'output') return currentStep.exitTicket ?? [];
        return currentStep.questions ?? [];
    }, [currentStep]);
    const currentAnsweredCount = currentQuestions.filter(question => answers[question.id]).length;
    const currentAllAnswered = currentQuestions.every(question => answers[question.id]);

    // `step_view` once per step. The ref keeps StrictMode's effect replay from
    // double-firing; a real remount/reload starts a new component.
    useEffect(() => {
        if (loadPhase !== 'ready' || !attempt || completed || !currentStepId) return;
        if (lastStepViewRef.current === currentStepId) return;
        lastStepViewRef.current = currentStepId;
        stepEnteredAtRef.current = Date.now();
        sendCourseEvent(attempt.attemptId, 'step_view', currentStepId, { elapsedMs: 0 });
    }, [loadPhase, attempt, currentStepId, completed]);

    useEffect(() => {
        outputRef.current = output;
    }, [output]);

    useEffect(() => {
        outputDirtyRef.current = outputDirty;
    }, [outputDirty]);

    // Autosave the written output so a refresh (or a closed tab) keeps it even
    // when the learner never reaches the completion button.
    useEffect(() => {
        if (loadPhase !== 'ready' || !attempt || completed || !outputDirty) return;
        const text = output;
        const timer = window.setTimeout(() => {
            if (!mountedRef.current) return;
            setSaveState('saving');
            void saveCourseOutput(attempt.attemptId, text, actionAbortRef.current.signal)
                .then(() => {
                    if (!mountedRef.current) return;
                    if (outputRef.current === text) {
                        setOutputDirty(false);
                        outputDirtyRef.current = false;
                        setSaveState('saved');
                    }
                })
                .catch((error: unknown) => {
                    if (!mountedRef.current || isCourseAbortError(error)) return;
                    setSaveState('error');
                });
        }, 1200);
        return () => window.clearTimeout(timer);
    }, [loadPhase, attempt, output, outputDirty, completed]);

    const handleRetry = useCallback(() => {
        loadRef.current?.controller.abort();
        loadRef.current = null;
        setReloadNonce(prev => prev + 1);
    }, []);

    const goToStep = useCallback(async (targetStep: CourseStep) => {
        if (!attempt || !currentStep || advancingRef.current) return;
        advancingRef.current = true;
        setAdvancing(true);
        setFormError(null);
        try {
            await setCourseStep(attempt.attemptId, targetStep.id, actionAbortRef.current.signal);
            if (!mountedRef.current) return;
            sendCourseEvent(attempt.attemptId, 'step_complete', currentStep.id, {
                durationMs: Math.max(0, Date.now() - stepEnteredAtRef.current),
                answered: currentAnsweredCount,
                total: currentQuestions.length,
            });
            stepEnteredAtRef.current = Date.now();
            setCurrentStepId(targetStep.id);
            stepRef.current = targetStep.id;
            scrollPageToTop(scrollRef.current);
        } catch (error) {
            if (mountedRef.current && !isCourseAbortError(error)) {
                setFormError(t('course.step.error'));
            }
        } finally {
            advancingRef.current = false;
            if (mountedRef.current) setAdvancing(false);
        }
    }, [attempt, currentStep, currentAnsweredCount, currentQuestions.length, t]);

    const handleNext = useCallback(() => {
        if (!lesson || !currentStep) return;
        if ((currentStep.type === 'read') && !currentAllAnswered) return;
        const nextStep = lesson.steps[currentStepIndex + 1];
        if (!nextStep) return;
        void goToStep(nextStep);
    }, [lesson, currentStep, currentStepIndex, currentAllAnswered, goToStep]);

    const handleAnswer = useCallback(async (question: CourseQuestion, choice: string) => {
        if (!attempt || completed || answers[question.id] || answerPendingRef.current.has(question.id)) return;
        answerPendingRef.current.add(question.id);
        setAnswerPending(prev => ({ ...prev, [question.id]: true }));
        try {
            const result = await submitCourseAnswer(
                attempt.attemptId,
                question.id,
                choice,
                actionAbortRef.current.signal,
            );
            if (!mountedRef.current) return;
            setAnswers(prev => ({ ...prev, [question.id]: choice }));
            setFeedback(prev => ({ ...prev, [question.id]: result }));
            setFormError(null);
            sendCourseEvent(attempt.attemptId, 'answer', currentStep?.id, {
                questionId: question.id,
                choice,
                correct: result.correct,
            });
        } catch (error) {
            if (mountedRef.current && !isCourseAbortError(error)) {
                toast.error(t('course.answer.error'));
            }
        } finally {
            answerPendingRef.current.delete(question.id);
            if (mountedRef.current) {
                setAnswerPending(prev => {
                    const next = { ...prev };
                    delete next[question.id];
                    return next;
                });
            }
        }
    }, [attempt, completed, answers, currentStep, t]);

    const handleOutputChange = useCallback((value: string) => {
        setOutput(value);
        outputRef.current = value;
        setOutputDirty(true);
        outputDirtyRef.current = true;
        setSaveState('idle');
        setFormError(null);
    }, []);

    const saveOutputOnBlur = useCallback(() => {
        if (!attempt || completed || !outputDirty) return;
        const text = output;
        if (!text.trim() || text.length > 2000) return;
        setSaveState('saving');
        void saveCourseOutput(attempt.attemptId, text, actionAbortRef.current.signal)
            .then(() => {
                if (!mountedRef.current) return;
                if (outputRef.current === text) {
                    setOutputDirty(false);
                    outputDirtyRef.current = false;
                    setSaveState('saved');
                }
            })
            .catch((error: unknown) => {
                if (!mountedRef.current || isCourseAbortError(error)) return;
                setSaveState('error');
            });
    }, [attempt, completed, output, outputDirty]);

    const focusOutput = useCallback(() => {
        textareaRef.current?.focus({ preventScroll: false });
        textareaRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, []);

    const scrollToQuestion = useCallback((questionId: string) => {
        const node = document.getElementById(`course-q-${questionId}`);
        node?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, []);

    const handleSubmit = useCallback(async () => {
        if (!attempt || !lesson || completed || submittingRef.current) return;
        submittingRef.current = true;
        setFormError(null);
        const trimmed = output.trim();
        if (!trimmed) {
            setFormError(t('course.output.empty'));
            submittingRef.current = false;
            focusOutput();
            return;
        }
        if (output.length > 2000) {
            setFormError(t('course.output.tooLong'));
            submittingRef.current = false;
            focusOutput();
            return;
        }
        const unanswered = allQuestions.find(question => !answers[question.id]);
        if (unanswered) {
            const remaining = allQuestions.filter(question => !answers[question.id]).length;
            setFormError(t('course.output.missingQuestions', { count: formatNumber(remaining) }));
            submittingRef.current = false;
            scrollToQuestion(unanswered.id);
            return;
        }

        setSubmitState('submitting');
        try {
            await saveCourseOutput(attempt.attemptId, output, actionAbortRef.current.signal);
            if (!mountedRef.current) return;
            setOutputDirty(false);
            outputDirtyRef.current = false;
            if (!outputSubmittedRef.current) {
                outputSubmittedRef.current = true;
                sendCourseEvent(attempt.attemptId, 'output_submit', currentStep?.id, {
                    wordCount: countCourseWords(output),
                    chars: output.length,
                });
            }
            const result = await completeCourseAttempt(
                attempt.attemptId,
                actionAbortRef.current.signal,
            );
            if (!mountedRef.current) return;
            const finalOutput = result.output || output;
            setOutput(finalOutput);
            outputRef.current = finalOutput;
            completedRef.current = true;
            setCompleted({
                score: result.score,
                total: result.total,
                output: finalOutput,
                completedAt: result.completedAt,
            });
            sendCourseEvent(attempt.attemptId, 'step_complete', currentStep?.id, {
                durationMs: Math.max(0, Date.now() - stepEnteredAtRef.current),
                answered: totalQuestionCount,
                total: totalQuestionCount,
            });
            sendCourseEvent(attempt.attemptId, 'lesson_complete', currentStep?.id, {
                score: result.score,
                total: result.total,
            });
            scrollPageToTop(scrollRef.current);
        } catch (error) {
            if (!mountedRef.current || isCourseAbortError(error)) return;
            setFormError(
                error instanceof Error && 'code' in error && error.code === 'incomplete'
                    ? t('course.complete.incomplete')
                    : t('course.complete.error'),
            );
        } finally {
            submittingRef.current = false;
            if (mountedRef.current) setSubmitState('idle');
        }
    }, [
        attempt,
        lesson,
        completed,
        output,
        allQuestions,
        answers,
        currentStep,
        totalQuestionCount,
        t,
        formatNumber,
        focusOutput,
        scrollToQuestion,
    ]);

    if (isGuest) {
        return <CourseGuest onRequestLogin={onRequestLogin} onExit={onExit} parentLabel={parentLabel} />;
    }

    if (loadPhase === 'loading' || (!lesson && loadPhase !== 'error')) {
        return (
            <div className="flex-1 min-h-0 flex flex-col bg-[#09090b]" data-testid="course-loading">
                <SubHeader
                    title={t('course.entry.badgeShort')}
                    onBack={onExit}
                    parentLabel={parentLabel}
                    backLabel={t('course.exit')}
                    titleAs="p"
                />
                <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-500">
                    <Loader2 className="w-6 h-6 animate-spin" />
                    <p className="text-sm">{t('course.loading')}</p>
                </div>
            </div>
        );
    }

    if (loadPhase === 'error' || !lesson) {
        return (
            <div className="flex-1 min-h-0 flex flex-col bg-[#09090b]" data-testid="course-error">
                <SubHeader
                    title={t('course.entry.badgeShort')}
                    onBack={onExit}
                    parentLabel={parentLabel}
                    backLabel={t('course.exit')}
                    titleAs="p"
                />
                <div className="flex-1 flex flex-col items-center justify-center px-6 text-center">
                    <div className="w-10 h-10 rounded-full bg-zinc-800/60 border border-white/5 flex items-center justify-center text-zinc-500">
                        <XCircle className="w-5 h-5" />
                    </div>
                    <h1 className="mt-3 text-base font-semibold text-zinc-200">{t('course.error.title')}</h1>
                    <p data-testid="course-error-message" className="mt-1 max-w-sm text-sm leading-relaxed text-zinc-500">
                        {t(loadErrorKey)}
                    </p>
                    <button
                        type="button"
                        data-testid="course-retry"
                        onClick={handleRetry}
                        className={`${SECONDARY_BUTTON} mt-5`}
                    >
                        <RefreshCw className="w-4 h-4" />
                        {t('course.retry')}
                    </button>
                </div>
            </div>
        );
    }

    const lessonStepCount = lesson.steps.length;
    const completionSample = lesson.steps.find(step => step.type === 'output')?.sample;

    if (completed) {
        const ratio = completed.total > 0 ? completed.score / completed.total : 0;
        const messageKey: TranslationKey = ratio >= 0.875
            ? 'course.complete.high'
            : ratio >= 0.625
                ? 'course.complete.mid'
                : 'course.complete.low';
        return (
            <div className="flex-1 min-h-0 flex flex-col bg-[#09090b]" data-testid="course-complete">
                <CourseHeader
                    lesson={lesson}
                    stepIndex={lessonStepCount - 1}
                    totalSteps={lessonStepCount}
                    remainingMs={remainingMs}
                    timeOver={timeOver}
                    showTimer={false}
                    showProgress={false}
                    onExit={onExit}
                    parentLabel={parentLabel}
                />
                <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                    <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-8 sm:py-12">
                        <div className="text-center">
                            <div className="mx-auto w-12 h-12 rounded-2xl bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center">
                                <CheckCircle2 className="w-6 h-6 text-emerald-300" />
                            </div>
                            <h1 className="mt-4 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50">
                                {t('course.complete.title')}
                            </h1>
                            <p className="mt-2 text-sm leading-relaxed text-zinc-400">{t(messageKey)}</p>
                        </div>

                        <div className={`${CARD} mt-6 p-5 sm:p-6`}>
                            <div className="flex flex-col items-center" data-testid="course-complete-score">
                                <p className="text-[11px] font-medium text-zinc-500">
                                    {t('course.complete.score')}
                                </p>
                                <p className="mt-1 flex items-baseline gap-1 tabular-nums">
                                    <span className="text-5xl sm:text-6xl font-semibold tracking-tight text-zinc-50">
                                        {completed.score}
                                    </span>
                                    <span className="text-xl text-zinc-500">/ {completed.total}</span>
                                </p>
                                <p className="mt-1.5 text-xs text-zinc-400">
                                    {t('course.complete.correct', {
                                        score: formatNumber(completed.score),
                                        total: formatNumber(completed.total),
                                    })}
                                </p>
                            </div>
                        </div>

                        <section className={`${CARD} mt-3 p-5 sm:p-6`}>
                            <h2 className="flex items-center gap-2 text-sm font-semibold text-zinc-100">
                                <PenLine className="w-4 h-4 text-blue-400" />
                                {t('course.complete.output')}
                            </h2>
                            <p className="mt-2.5 whitespace-pre-wrap break-words text-sm leading-relaxed text-zinc-300">
                                {completed.output || '—'}
                            </p>
                            <p className="mt-3 text-[11px] text-zinc-500 tabular-nums">
                                {t('course.output.words', { count: formatNumber(countCourseWords(completed.output)) })}
                            </p>
                        </section>

                        {completionSample && (
                            <section className="mt-3 rounded-2xl border border-white/5 bg-zinc-900/30 p-4 sm:p-5">
                                <h2 className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                                    <Lightbulb className="w-3.5 h-3.5" />
                                    {t('course.complete.sample')}
                                </h2>
                                <p className="mt-2 text-sm leading-relaxed text-zinc-400">
                                    {completionSample}
                                </p>
                            </section>
                        )}

                        <div className="mt-6 flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                            <button
                                type="button"
                                data-testid="course-complete-today"
                                onClick={onExit}
                                className={`${PRIMARY_BUTTON} sm:flex-1`}
                            >
                                {t('course.complete.backToday')}
                                <ArrowRight className="w-4 h-4" />
                            </button>
                            <button
                                type="button"
                                data-testid="course-complete-next"
                                disabled
                                className={`${SECONDARY_BUTTON} sm:flex-1`}
                                title={t('course.complete.nextLocked')}
                            >
                                <Lock className="w-4 h-4" />
                                {t('course.complete.nextLocked')}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        );
    }

    const footerHint = (() => {
        if (formError) return null;
        if (!currentStep) return null;
        if (currentStep.type === 'words' && currentStep.points) {
            return t('course.words.hint', {
                revealed: formatNumber(currentStep.points.filter(point => revealed[point.id]).length),
                total: formatNumber(currentStep.points.length),
            });
        }
        if (currentStep.type === 'read') {
            return currentAllAnswered
                ? t('course.questions.answered', {
                    answered: formatNumber(currentAnsweredCount),
                    total: formatNumber(currentQuestions.length),
                })
                : t('course.questions.finishToContinue');
        }
        if (currentStep.type === 'output') {
            return t('course.questions.answered', {
                answered: formatNumber(answeredQuestionCount),
                total: formatNumber(totalQuestionCount),
            });
        }
        return null;
    })();

    const footerAction = (() => {
        if (!currentStep) return null;
        if (currentStep.type === 'output') {
            const submitting = submitState === 'submitting';
            return (
                <button
                    type="button"
                    data-testid="course-submit"
                    onClick={() => { void handleSubmit(); }}
                    disabled={submitting}
                    className={PRIMARY_BUTTON}
                >
                    {submitting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Check className="w-4 h-4" />}
                    {submitting ? t('course.output.submitting') : t('course.output.submit')}
                </button>
            );
        }
        const isFinalLearningStep = currentStepIndex === lessonStepCount - 1;
        const nextStep = lesson.steps[currentStepIndex + 1];
        const blocked = !nextStep || isFinalLearningStep || advancing
            || (currentStep.type === 'read' && !currentAllAnswered);
        return (
            <button
                type="button"
                data-testid="course-next"
                onClick={handleNext}
                disabled={blocked}
                className={PRIMARY_BUTTON}
            >
                {advancing ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
                {currentStep.type === 'intro' ? t('course.start') : t('course.next')}
                {!advancing && <ArrowRight className="w-4 h-4" />}
            </button>
        );
    })();

    return (
        <div className="flex-1 min-h-0 flex flex-col bg-[#09090b]" data-testid="course-screen">
            <CourseHeader
                lesson={lesson}
                stepIndex={currentStepIndex}
                totalSteps={lessonStepCount}
                remainingMs={remainingMs}
                timeOver={timeOver}
                showTimer
                showProgress
                onExit={onExit}
                parentLabel={parentLabel}
            />

            <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 py-5 sm:py-8">
                    {currentStep?.type === 'intro' && (
                        <section className="animate-fade-in">
                            <div className={`${CARD} p-5 sm:p-7`}>
                                <div className="flex flex-wrap items-center gap-2">
                                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                                        {lesson.level}
                                    </span>
                                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/60 border border-white/5 text-zinc-400 tabular-nums">
                                        {t('course.meta.minutes', { minutes: lesson.durationMinutes ?? 12 })}
                                    </span>
                                    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/60 border border-white/5 text-zinc-400 tabular-nums">
                                        {t('course.meta.questions', { count: totalQuestionCount })}
                                    </span>
                                </div>
                                <h1 className="mt-4 text-2xl sm:text-3xl font-semibold tracking-tight text-zinc-50">
                                    {currentStep.title}
                                </h1>
                                <p className="mt-3 text-[15px] leading-relaxed text-zinc-300">
                                    {currentStep.body}
                                </p>
                                {currentStep.bullets && currentStep.bullets.length > 0 && (
                                    <ul className="mt-4 space-y-2">
                                        {currentStep.bullets.map(bullet => (
                                            <li key={bullet} className="flex items-start gap-2.5 text-sm text-zinc-400">
                                                <Check className="w-4 h-4 text-emerald-400/90 shrink-0 mt-0.5" />
                                                <span className="leading-relaxed">{bullet}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                            {lesson.goal && (
                                <div className="mt-3 rounded-2xl border border-blue-500/15 bg-blue-500/[0.06] p-4">
                                    <p className="flex items-center gap-2 text-xs font-medium text-blue-300">
                                        <GraduationCap className="w-4 h-4" />
                                        {t('course.intro.goal')}
                                    </p>
                                    <p className="mt-1.5 text-sm leading-relaxed text-zinc-300">
                                        {lesson.goal}
                                    </p>
                                </div>
                            )}
                        </section>
                    )}

                    {currentStep?.type === 'words' && (
                        <section className="animate-fade-in">
                            <div className="flex items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-50">
                                        {currentStep.title}
                                    </h1>
                                    {currentStep.body && (
                                        <p className="mt-1.5 text-sm leading-relaxed text-zinc-400">
                                            {currentStep.body}
                                        </p>
                                    )}
                                </div>
                                <span className="shrink-0 text-[11px] text-zinc-500 tabular-nums">
                                    {formatNumber(currentStep.points?.filter(point => revealed[point.id]).length ?? 0)}
                                    {' / '}
                                    {formatNumber(currentStep.points?.length ?? 0)}
                                </span>
                            </div>
                            <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2.5 sm:gap-3">
                                {currentStep.points?.map(point => {
                                    const open = Boolean(revealed[point.id]);
                                    return (
                                        <WordCard
                                            key={point.id}
                                            point={point}
                                            open={open}
                                            onToggle={() => setRevealed(prev => ({ ...prev, [point.id]: true }))}
                                        />
                                    );
                                })}
                            </div>
                        </section>
                    )}

                    {currentStep?.type === 'read' && (
                        <section className="animate-fade-in">
                            <div className="flex items-start justify-between gap-3">
                                <h1 className="min-w-0 text-xl sm:text-2xl font-semibold tracking-tight text-zinc-50">
                                    {currentStep.title}
                                </h1>
                                <button
                                    type="button"
                                    data-testid="course-zh-toggle"
                                    onClick={() => setShowZh(prev => !prev)}
                                    aria-pressed={showZh}
                                    className="shrink-0 inline-flex items-center gap-1.5 h-8 px-2.5 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-[11px] font-medium text-zinc-400 hover:text-zinc-200 transition-colors"
                                >
                                    {showZh ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                                    {showZh ? t('course.zh.hide') : t('course.zh.show')}
                                </button>
                            </div>

                            <div className="mt-4 space-y-3">
                                {currentStep.paragraphs?.map((paragraph, index) => (
                                    <article
                                        key={`${currentStep.id}-p${index}`}
                                        className="rounded-2xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5"
                                    >
                                        <p className="text-[16px] sm:text-[17px] leading-[1.85] text-zinc-100">
                                            {paragraph.en}
                                        </p>
                                        {showZh && paragraph.zh && (
                                            <p className="mt-3 border-t border-white/5 pt-3 text-sm leading-relaxed text-zinc-400">
                                                {paragraph.zh}
                                            </p>
                                        )}
                                    </article>
                                ))}
                            </div>

                            {currentStep.explain && (
                                <div className="mt-3 rounded-2xl border border-blue-500/15 bg-blue-500/[0.06] p-4">
                                    <p className="flex items-center gap-2 text-xs font-medium text-blue-300">
                                        <Lightbulb className="w-4 h-4" />
                                        {t('course.explain')}
                                    </p>
                                    <p className="mt-1.5 text-sm leading-relaxed text-zinc-300">
                                        {currentStep.explain}
                                    </p>
                                </div>
                            )}

                            {currentQuestions.length > 0 && (
                                <div className="mt-5">
                                    <div className="flex items-center justify-between gap-3 mb-2.5">
                                        <h2 className="text-sm font-semibold tracking-tight text-zinc-100">
                                            {t('course.questions.title')}
                                        </h2>
                                        <span className="text-[11px] font-medium text-zinc-500 tabular-nums">
                                            {t('course.questions.answered', {
                                                answered: formatNumber(currentAnsweredCount),
                                                total: formatNumber(currentQuestions.length),
                                            })}
                                        </span>
                                    </div>
                                    <div className="space-y-2.5">
                                        {currentQuestions.map((question, index) => (
                                            <QuestionBlock
                                                key={question.id}
                                                question={question}
                                                number={questionNumbers.get(question.id) ?? index + 1}
                                                chosen={answers[question.id]}
                                                result={feedback[question.id]}
                                                pending={Boolean(answerPending[question.id])}
                                                disabled={Boolean(answers[question.id])}
                                                onAnswer={(item, choice) => { void handleAnswer(item, choice); }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </section>
                    )}

                    {currentStep?.type === 'output' && (
                        <section className="animate-fade-in">
                            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-50">
                                {currentStep.title}
                            </h1>

                            <div className={`${CARD} mt-4 p-4 sm:p-5`}>
                                <div className="flex items-start gap-2.5">
                                    <PenLine className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                                    <p className="text-[14px] sm:text-[15px] leading-relaxed text-zinc-200">
                                        {currentStep.prompt}
                                    </p>
                                </div>
                                {currentStep.targetWords && currentStep.targetWords.length > 0 && (
                                    <div className="mt-3">
                                        <p className="text-[11px] font-medium text-zinc-500">
                                            {t('course.output.targetWords')}
                                        </p>
                                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                                            {currentStep.targetWords.map(word => (
                                                <span
                                                    key={word}
                                                    className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/60 border border-white/5 text-zinc-300"
                                                >
                                                    {word}
                                                </span>
                                            ))}
                                        </div>
                                    </div>
                                )}
                            </div>

                            <div className="mt-4">
                                <label
                                    htmlFor="course-output"
                                    className="text-xs font-medium text-zinc-400"
                                >
                                    {t('course.output.label')}
                                </label>
                                <textarea
                                    id="course-output"
                                    ref={textareaRef}
                                    data-testid="course-output"
                                    value={output}
                                    onChange={event => handleOutputChange(event.target.value)}
                                    onBlur={saveOutputOnBlur}
                                    placeholder={t('course.output.placeholder')}
                                    rows={7}
                                    spellCheck={false}
                                    disabled={submitState === 'submitting'}
                                    className={`mt-1.5 w-full resize-y rounded-2xl border bg-zinc-900/50 px-4 py-3.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none focus-visible:outline-none focus:border-blue-500/40 transition-colors ${
                                        output.length > 2000
                                            ? 'border-red-500/40'
                                            : 'border-white/5 hover:border-white/10'
                                    }`}
                                />
                                <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-[11px]">
                                    <div className="flex items-center gap-2 text-zinc-500">
                                        <span data-testid="course-word-count" className="tabular-nums text-zinc-400">
                                            {t('course.output.words', { count: formatNumber(countCourseWords(output)) })}
                                        </span>
                                        <span aria-hidden="true">·</span>
                                        <span
                                            data-testid="course-char-count"
                                            className={`tabular-nums ${output.length > 2000 ? 'text-red-300' : ''}`}
                                        >
                                            {t('course.output.charCount', { count: formatNumber(output.length) })}
                                        </span>
                                        {saveState !== 'idle' && (
                                            <>
                                                <span aria-hidden="true">·</span>
                                                <span
                                                    data-testid="course-save-state"
                                                    className={saveState === 'error' ? 'text-red-300' : 'text-zinc-500'}
                                                >
                                                    {saveState === 'saving'
                                                        ? t('course.output.saving')
                                                        : saveState === 'saved'
                                                            ? t('course.output.saved')
                                                            : t('course.output.saveFailed')}
                                                </span>
                                            </>
                                        )}
                                    </div>
                                    <span className="text-zinc-500">
                                        {t('course.output.recommended', {
                                            min: formatNumber(outputWordRange(currentStep)[0]),
                                            max: formatNumber(outputWordRange(currentStep)[1]),
                                        })}
                                    </span>
                                </div>
                            </div>

                            {currentStep.rubric && currentStep.rubric.length > 0 && (
                                <div className="mt-4 rounded-2xl border border-white/5 bg-zinc-900/30 p-4">
                                    <p className="flex items-center gap-2 text-xs font-medium text-zinc-400">
                                        <CheckCircle2 className="w-3.5 h-3.5" />
                                        {t('course.output.rubric')}
                                    </p>
                                    <ul className="mt-2 space-y-1.5">
                                        {currentStep.rubric.map(item => (
                                            <li key={item} className="flex items-start gap-2 text-xs leading-relaxed text-zinc-500">
                                                <span className="mt-[7px] w-1 h-1 rounded-full bg-zinc-500 shrink-0" />
                                                {item}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}

                            {currentQuestions.length > 0 && (
                                <div className="mt-5">
                                    <div className="flex items-center justify-between gap-3 mb-2.5">
                                        <h2 className="text-sm font-semibold tracking-tight text-zinc-100">
                                            {t('course.questions.exitTitle')}
                                        </h2>
                                        <span className="text-[11px] font-medium text-zinc-500 tabular-nums">
                                            {t('course.questions.answered', {
                                                answered: formatNumber(currentAnsweredCount),
                                                total: formatNumber(currentQuestions.length),
                                            })}
                                        </span>
                                    </div>
                                    <div className="space-y-2.5">
                                        {currentQuestions.map((question, index) => (
                                            <QuestionBlock
                                                key={question.id}
                                                question={question}
                                                number={questionNumbers.get(question.id) ?? index + 1}
                                                chosen={answers[question.id]}
                                                result={feedback[question.id]}
                                                pending={Boolean(answerPending[question.id])}
                                                disabled={Boolean(answers[question.id])}
                                                onAnswer={(item, choice) => { void handleAnswer(item, choice); }}
                                            />
                                        ))}
                                    </div>
                                </div>
                            )}
                        </section>
                    )}
                </div>
            </div>

            <footer className="flex-none border-t border-white/5 bg-zinc-950/70 backdrop-blur-xl">
                <div className="mx-auto w-full max-w-3xl px-4 sm:px-6 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))] flex items-center gap-3">
                    <div className="min-w-0 flex-1 text-[11px] sm:text-xs leading-relaxed">
                        {formError ? (
                            <p data-testid="course-form-error" role="alert" className="text-red-300">
                                {formError}
                            </p>
                        ) : (
                            <p data-testid="course-footer-hint" className="text-zinc-500">
                                {footerHint}
                            </p>
                        )}
                    </div>
                    <div className="shrink-0">{footerAction}</div>
                </div>
            </footer>
        </div>
    );
}

function WordCard({
    point,
    open,
    onToggle,
}: {
    point: CourseWordPoint;
    open: boolean;
    onToggle: () => void;
}) {
    const { t } = useI18n();
    return (
        <button
            type="button"
            data-testid={`course-word-${point.id}`}
            data-open={open ? 'true' : 'false'}
            onClick={onToggle}
            aria-expanded={open}
            className={`text-left rounded-2xl border p-4 transition-[background-color,border-color] duration-200 ease-apple ${
                open
                    ? 'border-blue-500/20 bg-blue-500/[0.06]'
                    : 'border-white/5 bg-zinc-900/40 hover:bg-zinc-900/70 hover:border-white/10'
            }`}
        >
            <div className="flex items-center justify-between gap-2">
                <span className="text-[10px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/70 border border-white/5 text-zinc-400">
                    {point.kind === 'form' ? t('course.words.kindForm') : t('course.words.kindWord')}
                </span>
                {point.cefr && (
                    <span className="text-[10px] font-medium text-zinc-500 tabular-nums">{point.cefr}</span>
                )}
            </div>
            <div className="mt-2 flex items-start justify-between gap-2">
                <p className={`min-w-0 font-semibold text-zinc-100 ${point.kind === 'form' ? 'text-[15px] leading-snug' : 'text-lg'}`}>
                    {point.word}
                </p>
                {!open && <Eye className="w-4 h-4 text-zinc-500 shrink-0 mt-1" />}
            </div>
            {point.ipa && <p className="mt-0.5 text-xs text-zinc-500">{point.ipa}</p>}

            {open ? (
                <div className="mt-2.5 border-t border-white/5 pt-2.5">
                    <p className="text-sm leading-relaxed text-zinc-200">
                        <span className="text-zinc-500">{t('course.words.meaning')} · </span>
                        {point.meaning}
                    </p>
                    {point.example && (
                        <p className="mt-1.5 text-xs leading-relaxed text-zinc-400">
                            <span className="font-medium text-zinc-300">{t('course.words.example')}</span>
                            {' · '}
                            {point.example}
                        </p>
                    )}
                    {point.note && (
                        <p className="mt-1 text-[11px] leading-relaxed text-zinc-500">
                            <span className="font-medium text-zinc-400">{t('course.words.note')}</span>
                            {' · '}
                            {point.note}
                        </p>
                    )}
                </div>
            ) : (
                <p className="mt-2.5 text-[11px] font-medium text-blue-300">
                    {t('course.words.reveal')}
                </p>
            )}
        </button>
    );
}

function outputWordRange(step: CourseStep): [number, number] {
    const ranges = step.wordRange ?? {};
    return ranges.B1 ?? ranges.A2 ?? ranges.B2 ?? Object.values(ranges)[0] ?? [40, 60];
}

function countCourseQuestions(lesson: CourseLesson): number {
    let total = 0;
    for (const step of lesson.steps) {
        total += step.questions?.length ?? 0;
        total += step.exitTicket?.length ?? 0;
    }
    return total;
}
