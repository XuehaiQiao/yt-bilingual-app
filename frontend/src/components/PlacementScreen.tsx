// Ability placement test + profile view (M4 / specs/016-placement, frontend).
//
// Four phases in one full view:
//   intro   — what the test is (12 min, no going back, interval not a score);
//   quiz    — one item at a time, progress + 12-minute countdown, skip, submit;
//   result  — CEFR interval + point estimate + confidence + strengths /
//             weaknesses + the single advice + the backend disclaimer;
//   profile — the saved profile (interval, source, updated time, retest).
//
// Honesty: every numeric/verbal judgement is rendered from the backend payload
// as-is (`preliminary`, `sampleSize`, `disclaimer`, `advice`, `strengths`,
// `weaknesses`). This component never turns the band into a score and never
// hides the "preliminary estimate" caveat.
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
    ArrowRight,
    BookOpen,
    Check,
    Clock3,
    Gauge,
    Info,
    Loader2,
    LogIn,
    RotateCcw,
    ShieldQuestion,
    Sparkles,
    X,
} from 'lucide-react';
import {
    getProfile,
    PlacementApiError,
    resetPlacement,
    startPlacement,
    submitPlacement,
    type PlacementItem,
    type PlacementProfile,
    type PlacementProfileResponse,
    type PlacementResult,
    type PlacementStart,
} from '../lib/placement';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

export type PlacementInitialView = 'intro' | 'profile';

interface PlacementScreenProps {
    /** Home entry: no profile → intro; saved profile → profile. */
    initialView?: PlacementInitialView;
    isGuest: boolean;
    /** Leave the view (home stays mounted underneath). */
    onClose: () => void;
    /** Result screen "go learn": close and put the cursor in the link input. */
    onStartLearning?: () => void;
    /** Guest "log in to keep it longer" entry. */
    onRequestLogin?: () => void;
}

type Phase = 'intro' | 'quiz' | 'result' | 'profile';
type ProfilePhase = 'loading' | 'ready' | 'error';
type ConfirmKind = 'exit' | 'submit' | 'retest';

const DEFAULT_DURATION_LIMIT_MS = 12 * 60 * 1000;

const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-50 disabled:active:scale-100';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50';
const GHOST_BUTTON =
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors';
const CARD = 'rounded-3xl border border-white/5 bg-zinc-900/40';
const OPTION_BASE =
    'w-full flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.99]';

const CONFIDENCE_KEYS: Record<string, TranslationKey> = {
    high: 'placement.confidence.high',
    medium: 'placement.confidence.medium',
    low: 'placement.confidence.low',
};

const DOMAIN_KEYS: Record<string, TranslationKey> = {
    vocab: 'placement.domain.vocab',
    reading: 'placement.domain.reading',
    listening: 'placement.domain.listening',
    speaking: 'placement.domain.speaking',
    writing: 'placement.domain.writing',
};

const SOURCE_KEYS: Record<string, TranslationKey> = {
    placement: 'placement.profile.source.placement',
    user_edit: 'placement.profile.source.user_edit',
};

function formatCountdown(ms: number): string {
    const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
    const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, '0');
    const seconds = (totalSeconds % 60).toString().padStart(2, '0');
    return `${minutes}:${seconds}`;
}

/** `A2–B2` → half-width dash, so the label always line-breaks as one token. */
function intervalLabel(value: string): string {
    return value.replace(/[–—]/g, '–');
}

export function PlacementScreen({
    initialView = 'intro',
    isGuest,
    onClose,
    onStartLearning,
    onRequestLogin,
}: PlacementScreenProps) {
    const { t, formatNumber, formatDate } = useI18n();
    const reduceMotion = useReducedMotion();
    const scrollRef = useRef<HTMLDivElement>(null);

    const [phase, setPhase] = useState<Phase>(initialView);
    const [profileState, setProfileState] = useState<{
        phase: ProfilePhase;
        data: PlacementProfileResponse | null;
        error: string | null;
    }>({ phase: 'loading', data: null, error: null });

    const [session, setSession] = useState<PlacementStart | null>(null);
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, number>>({});
    const [selected, setSelected] = useState<number | null>(null);
    const [result, setResult] = useState<PlacementResult | null>(null);
    const [remainingMs, setRemainingMs] = useState(DEFAULT_DURATION_LIMIT_MS);
    const [timedOut, setTimedOut] = useState(false);

    const [starting, setStarting] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [errorStatus, setErrorStatus] = useState<number | null>(null);
    const [retestError, setRetestError] = useState<string | null>(null);
    const [confirm, setConfirm] = useState<ConfirmKind | null>(null);

    // Refs mirror the state that async callbacks / the countdown read. React
    // state alone would hand a stale paper/answer set to a timer callback.
    const sessionRef = useRef<PlacementStart | null>(null);
    const indexRef = useRef(0);
    const answersRef = useRef<Record<string, number>>({});
    const selectedRef = useRef<number | null>(null);
    const deadlineRef = useRef(0);
    const attemptStartedRef = useRef(0);
    const startingRef = useRef(false);
    const submittingRef = useRef(false);
    const submittedRef = useRef(false);
    const autoSubmitRef = useRef(false);

    const loadProfile = useCallback(async () => {
        setProfileState(prev => ({ ...prev, phase: 'loading', error: null }));
        try {
            const data = await getProfile();
            setProfileState({ phase: 'ready', data, error: null });
        } catch (err) {
            setProfileState({ phase: 'error', data: null, error: await describeApiError(err) });
        }
    }, []);

    useEffect(() => {
        void loadProfile();
    }, [loadProfile]);

    // The screen scrolls itself; every phase/question starts at the top.
    useEffect(() => {
        scrollRef.current?.scrollTo({ top: 0 });
    }, [phase, index]);

    const beginPlacement = useCallback(async (options?: { resetFirst?: boolean }) => {
        if (startingRef.current) return;
        startingRef.current = true;
        setStarting(true);
        setError(null);
        setErrorStatus(null);
        setRetestError(null);
        try {
            if (options?.resetFirst) await resetPlacement();
            const data = await startPlacement();
            if (!Array.isArray(data.items) || data.items.length === 0) {
                throw new Error(t('placement.errors.empty'));
            }
            sessionRef.current = data;
            indexRef.current = 0;
            answersRef.current = {};
            selectedRef.current = null;
            deadlineRef.current =
                Date.now() +
                (Number.isFinite(data.durationLimitMs) && data.durationLimitMs > 0
                    ? data.durationLimitMs
                    : DEFAULT_DURATION_LIMIT_MS);
            attemptStartedRef.current = Date.now();
            submittedRef.current = false;
            autoSubmitRef.current = false;
            setSession(data);
            setIndex(0);
            setAnswers({});
            setSelected(null);
            setResult(null);
            setTimedOut(false);
            setRemainingMs(deadlineRef.current - Date.now());
            setConfirm(null);
            setPhase('quiz');
        } catch (err) {
            let message: string;
            if (err instanceof PlacementApiError && err.status === 403) {
                message = t('placement.errors.login');
                onRequestLogin?.();
            } else {
                message = await describeApiError(err);
            }
            setError(message);
            if (options?.resetFirst) setRetestError(message);
            setErrorStatus(err instanceof PlacementApiError ? err.status : null);
        } finally {
            startingRef.current = false;
            setStarting(false);
        }
    }, [t, onRequestLogin]);

    const submitPaper = useCallback(async () => {
        const current = sessionRef.current;
        if (!current || submittedRef.current || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        setError(null);
        setErrorStatus(null);
        const durationMs = Math.max(0, Date.now() - attemptStartedRef.current);
        try {
            const payload = await submitPlacement({
                sessionId: current.sessionId,
                answers: Object.entries(answersRef.current).map(([itemId, chosenIndex]) => ({
                    itemId,
                    chosenIndex,
                })),
                durationMs,
            });
            if (!payload?.cefr?.label || !payload.breakdown) {
                throw new Error(t('placement.errors.result'));
            }
            submittedRef.current = true;
            setResult(payload);
            setConfirm(null);
            if (payload.profile) {
                setProfileState({
                    phase: 'ready',
                    data: {
                        profile: payload.profile,
                        preliminary: payload.preliminary,
                        sampleSize: payload.sampleSize,
                        disclaimer: payload.disclaimer,
                    },
                    error: null,
                });
            }
            setPhase('result');
        } catch (err) {
            setError(await describeApiError(err));
            setErrorStatus(err instanceof PlacementApiError ? err.status : null);
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [t]);

    // 12-minute countdown. At zero the paper is submitted exactly once; if that
    // request fails the error panel offers a manual retry instead of looping.
    useEffect(() => {
        if (phase !== 'quiz' || !session) return;
        const update = () => {
            const left = Math.max(0, deadlineRef.current - Date.now());
            setRemainingMs(left);
            if (left <= 0 && !autoSubmitRef.current) {
                autoSubmitRef.current = true;
                setTimedOut(true);
                void submitPaper();
            }
        };
        update();
        const timer = window.setInterval(update, 1000);
        return () => window.clearInterval(timer);
    }, [phase, session, submitPaper]);

    const recordAndAdvance = useCallback((choice: number) => {
        const current = sessionRef.current;
        if (!current || submittingRef.current) return;
        const item = current.items[indexRef.current];
        if (!item) return;
        const nextAnswers = { ...answersRef.current, [item.itemId]: choice };
        answersRef.current = nextAnswers;
        setAnswers(nextAnswers);
        selectedRef.current = null;
        setSelected(null);
        if (indexRef.current + 1 >= current.items.length) {
            void submitPaper();
            return;
        }
        indexRef.current += 1;
        setIndex(indexRef.current);
    }, [submitPaper]);

    const chooseOption = useCallback((optionIndex: number) => {
        selectedRef.current = optionIndex;
        setSelected(optionIndex);
    }, []);

    // Skipped questions are decisions too (`chosenIndex: -1` is submitted), so
    // the "unanswered" warning counts recorded rows, while the visible "answered"
    // counter only counts real choices — a skip is not an answer.
    const recordedCount = Object.keys(answers).length;
    const answeredCount = Object.values(answers).filter((choice) => choice >= 0).length;
    const totalCount = session?.items.length ?? 0;

    const requestSubmit = useCallback(() => {
        if (submittingRef.current) return;
        if (recordedCount < totalCount) {
            setConfirm('submit');
            return;
        }
        void submitPaper();
    }, [recordedCount, totalCount, submitPaper]);

    // The quiz width is fixed by the design language; one keyboard rule set
    // covers option selection, advance/skip and the exit confirmation.
    useEffect(() => {
        if (phase !== 'quiz' || confirm) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.repeat) return;
            if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
            if (event.key === 'Escape') {
                event.preventDefault();
                setConfirm('exit');
                return;
            }
            if (submitting) return;
            const optionIndex = ['1', '2', '3', '4'].indexOf(event.key);
            if (optionIndex >= 0) {
                const item = sessionRef.current?.items[indexRef.current];
                if (item && optionIndex < item.options.length) {
                    event.preventDefault();
                    chooseOption(optionIndex);
                }
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                if (selectedRef.current != null) recordAndAdvance(selectedRef.current);
                else recordAndAdvance(-1);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [phase, confirm, submitting, chooseOption, recordAndAdvance]);

    useEffect(() => {
        if (!confirm) return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            setConfirm(null);
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [confirm]);

    const handleExitClick = () => {
        if (submitting) return;
        if (phase === 'quiz') {
            setConfirm('exit');
            return;
        }
        onClose();
    };

    // Explicit exit = the answers of this sitting are discarded (backend
    // semantics: an unsubmitted session is never scored). `reset` abandons it
    // so the next entry starts a clean paper instead of resuming empty answers.
    const handleExitConfirm = () => {
        setConfirm(null);
        if (sessionRef.current && !submittedRef.current) {
            void resetPlacement().catch(() => {
                // Losing the reset is non-fatal: an in-progress session is
                // resumed on the next start, never scored on its own.
            });
        }
        onClose();
    };

    const handleRetestConfirm = () => {
        void beginPlacement({ resetFirst: true });
    };

    const profilePayload = profileState.data;
    const profile: PlacementProfile | null = profilePayload?.profile ?? null;
    const confidenceText = (label: string, zhLabel?: string): string => {
        const key = CONFIDENCE_KEYS[label];
        return key ? t(key) : (zhLabel || label);
    };
    const domainLabel = (domain: string): string => {
        const key = DOMAIN_KEYS[domain];
        return key ? t(key) : domain;
    };

    const headerTitle =
        phase === 'quiz'
            ? t('placement.quiz.title')
            : phase === 'result'
                ? t('placement.result.title')
                : phase === 'profile'
                    ? t('placement.profile.title')
                    : t('placement.title');

    const headerSubtitle =
        phase === 'quiz' && session
            ? t('placement.quiz.header', {
                current: formatNumber(Math.min(index + 1, totalCount)),
                total: formatNumber(totalCount),
            })
            : phase === 'result'
                ? t('placement.result.subtitle')
                : phase === 'profile'
                    ? t('placement.profile.subtitle')
                    : t('placement.intro.subtitle');

    const currentItem: PlacementItem | null = session?.items[index] ?? null;
    const isLastQuestion = session != null && index + 1 >= session.items.length;
    const timerWarning = remainingMs <= 2 * 60 * 1000;

    const errorPanel = (message: string | null, onRetry?: () => void) => {
        if (!message) return null;
        const isFatalStart =
            errorStatus === 404 ||
            errorStatus === 409;
        return (
            <div
                data-testid="placement-error"
                className="rounded-2xl border border-amber-500/20 bg-amber-500/5 p-4"
            >
                <div className="flex items-start gap-2">
                    <ShieldQuestion className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <p className="text-sm text-amber-200 break-words">{message}</p>
                        {errorStatus === 503 && (
                            <p className="mt-1 text-xs text-amber-400/80 break-words">
                                {t('placement.errors.migration')}
                            </p>
                        )}
                        {isFatalStart && (
                            <p className="mt-1 text-xs text-amber-400/80">
                                {t('placement.errors.restartHint')}
                            </p>
                        )}
                    </div>
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                    {isFatalStart && (
                        <button
                            type="button"
                            data-testid="placement-restart"
                            onClick={() => void beginPlacement({ resetFirst: true })}
                            disabled={starting}
                            className={SECONDARY_BUTTON}
                        >
                            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                            {t('placement.errors.restart')}
                        </button>
                    )}
                    {onRetry && (
                        <button
                            type="button"
                            data-testid="placement-error-retry"
                            onClick={onRetry}
                            className={SECONDARY_BUTTON}
                        >
                            {t('common.retry')}
                        </button>
                    )}
                </div>
            </div>
        );
    };

    // ── Intro ─────────────────────────────────────────────────────────────
    const introBody = (
        <div data-testid="placement-intro" className="flex flex-col gap-4 sm:gap-5">
            <section className={`${CARD} p-5 sm:p-7`}>
                <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 flex items-center justify-center shrink-0">
                        <Gauge className="w-5 h-5 text-blue-400" />
                    </div>
                    <div className="min-w-0">
                        <h2 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-50">
                            {t('placement.intro.heading')}
                        </h2>
                        <p className="mt-1 text-sm leading-relaxed text-zinc-400">
                            {t('placement.intro.lead')}
                        </p>
                    </div>
                </div>

                <ul className="mt-5 space-y-3.5">
                    <li className="flex items-start gap-3">
                        <Clock3 className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-200">{t('placement.intro.durationTitle')}</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                                {t('placement.intro.durationHint')}
                            </p>
                        </div>
                    </li>
                    <li className="flex items-start gap-3">
                        <ArrowRight className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-200">{t('placement.intro.linearTitle')}</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                                {t('placement.intro.linearHint')}
                            </p>
                        </div>
                    </li>
                    <li className="flex items-start gap-3">
                        <Info className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-sm font-medium text-zinc-200">{t('placement.intro.rangeTitle')}</p>
                            <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                                {t('placement.intro.rangeHint')}
                            </p>
                        </div>
                    </li>
                    {isGuest && (
                        <li className="flex items-start gap-3">
                            <LogIn className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                                <p className="text-sm font-medium text-zinc-200">{t('placement.intro.guestTitle')}</p>
                                <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
                                    {t('placement.intro.guestHint')}
                                </p>
                            </div>
                        </li>
                    )}
                </ul>

                {profile && (
                    <p
                        data-testid="placement-intro-current"
                        className="mt-5 rounded-xl border border-white/5 bg-zinc-800/30 px-3.5 py-2.5 text-xs leading-relaxed text-zinc-400"
                    >
                        {t('placement.intro.previous', { level: intervalLabel(profile.cefr) })}
                    </p>
                )}

                <div className="mt-6 flex flex-col sm:flex-row gap-2">
                    <button
                        type="button"
                        data-testid="placement-start"
                        onClick={() => void beginPlacement()}
                        disabled={starting}
                        className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                    >
                        {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Sparkles className="w-4 h-4" />}
                        {starting ? t('placement.intro.starting') : t('placement.intro.start')}
                    </button>
                    <button
                        type="button"
                        data-testid="placement-intro-home"
                        onClick={onClose}
                        className={`${GHOST_BUTTON} w-full sm:w-auto`}
                    >
                        {t('placement.home')}
                    </button>
                </div>

                {errorPanel(error, () => void beginPlacement())}
            </section>

            {profilePayload && (
                <section
                    data-testid="placement-intro-disclaimer"
                    className="rounded-2xl border border-white/5 bg-zinc-900/30 p-4"
                >
                    {profilePayload.preliminary && (
                        <p className="text-xs text-amber-300/90">
                            {t('placement.result.preliminaryHint', {
                                count: formatNumber(profilePayload.sampleSize),
                            })}
                        </p>
                    )}
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 break-words">
                        {profilePayload.disclaimer}
                    </p>
                </section>
            )}
        </div>
    );

    // ── Quiz ──────────────────────────────────────────────────────────────
    const quizBody = currentItem ? (
        <div
            data-testid="placement-quiz"
            data-index={index}
            data-total={totalCount}
            className="flex flex-col gap-4 sm:gap-5"
        >
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <div
                    role="progressbar"
                    aria-label={t('placement.quiz.progressAria')}
                    aria-valuemin={1}
                    aria-valuemax={totalCount}
                    aria-valuenow={index + 1}
                    className="flex-1 min-w-[120px] h-1.5 rounded-full bg-zinc-800 overflow-hidden"
                >
                    <div
                        className="h-full bg-brand rounded-full transition-[width] duration-300 ease-apple"
                        style={{ width: `${Math.round(((index + 1) / Math.max(1, totalCount)) * 100)}%` }}
                    />
                </div>
                <span
                    data-testid="placement-progress"
                    className="text-[11px] font-medium text-zinc-500 tabular-nums shrink-0"
                >
                    {t('placement.quiz.answered', {
                        answered: formatNumber(answeredCount),
                        total: formatNumber(totalCount),
                    })}
                </span>
                <span
                    data-testid="placement-timer"
                    data-warning={timerWarning ? 'true' : 'false'}
                    className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-lg border text-[11px] font-medium tabular-nums shrink-0 ${
                        timerWarning
                            ? 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                            : 'border-white/5 bg-zinc-800/50 text-zinc-400'
                    }`}
                >
                    <Clock3 className="w-3.5 h-3.5" />
                    {formatCountdown(remainingMs)}
                </span>
                <button
                    type="button"
                    data-testid="placement-submit-early"
                    onClick={requestSubmit}
                    disabled={submitting}
                    className="inline-flex items-center justify-center gap-1.5 h-7 px-2.5 rounded-lg border border-white/5 bg-zinc-800/60 hover:bg-zinc-700/60 text-[11px] font-medium text-zinc-300 hover:text-zinc-100 transition-colors shrink-0 disabled:opacity-50"
                >
                    {t('placement.quiz.submit')}
                </button>
            </div>

            <motion.section
                key={currentItem.itemId}
                data-testid="placement-question"
                data-item-type={currentItem.type}
                initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.22, ease: [0.25, 1, 0.5, 1] }}
                className="glass-card rounded-3xl p-5 sm:p-7"
            >
                <div className="flex flex-wrap items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                        {currentItem.type === 'reading' ? (
                            <BookOpen className="w-3 h-3" />
                        ) : (
                            <Gauge className="w-3 h-3" />
                        )}
                        {currentItem.type === 'reading'
                            ? t('placement.quiz.type.reading')
                            : t('placement.quiz.type.vocab')}
                    </span>
                </div>

                {currentItem.passage && (
                    <div
                        data-testid="placement-passage"
                        className="mt-4 rounded-2xl border border-white/5 bg-zinc-800/30 px-4 py-3 text-sm leading-relaxed text-zinc-300 whitespace-pre-line break-words"
                    >
                        {currentItem.passage}
                    </div>
                )}

                <h2
                    data-testid="placement-prompt"
                    className="mt-4 text-xl sm:text-2xl font-medium leading-relaxed text-zinc-50 break-words"
                >
                    {currentItem.prompt}
                </h2>
                {currentItem.type === 'vocab' && (
                    <p className="mt-1.5 text-xs text-zinc-500">{t('placement.quiz.vocabHint')}</p>
                )}

                <div role="group" aria-label={t('placement.quiz.optionsAria')} className="mt-4 space-y-2">
                    {currentItem.options.map((option, optionIndex) => {
                        const isSelected = selected === optionIndex;
                        return (
                            <button
                                key={optionIndex}
                                type="button"
                                data-testid={`placement-option-${optionIndex}`}
                                aria-pressed={isSelected}
                                disabled={submitting}
                                onClick={() => chooseOption(optionIndex)}
                                className={`${OPTION_BASE} ${
                                    isSelected
                                        ? 'bg-blue-500/10 border-blue-500/40 text-zinc-50'
                                        : 'bg-zinc-800/30 border-white/5 text-zinc-200 hover:bg-zinc-800/60 hover:border-white/10'
                                }`}
                            >
                                <span
                                    className={`w-6 h-6 shrink-0 rounded-md border text-[11px] font-semibold tabular-nums flex items-center justify-center ${
                                        isSelected
                                            ? 'border-blue-400/40 bg-blue-500/15 text-blue-300'
                                            : 'border-white/10 bg-white/5 text-zinc-500'
                                    }`}
                                >
                                    {optionIndex + 1}
                                </span>
                                <span className="min-w-0 flex-1 text-sm leading-relaxed break-words">{option}</span>
                                {isSelected && <Check className="w-4 h-4 shrink-0 text-blue-400 mt-0.5" />}
                            </button>
                        );
                    })}
                </div>

                <div className="mt-5 flex flex-col-reverse sm:flex-row sm:items-center gap-2">
                    <button
                        type="button"
                        data-testid="placement-skip"
                        onClick={() => recordAndAdvance(-1)}
                        disabled={submitting}
                        title={t('placement.quiz.skipTitle')}
                        className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                    >
                        {t('placement.quiz.skip')}
                    </button>
                    <div className="flex-1" />
                    <button
                        type="button"
                        data-testid="placement-next"
                        onClick={() => {
                            if (selectedRef.current != null) recordAndAdvance(selectedRef.current);
                            else recordAndAdvance(-1);
                        }}
                        disabled={submitting}
                        className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                    >
                        {submitting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : isLastQuestion ? (
                            <Check className="w-4 h-4" />
                        ) : (
                            <ArrowRight className="w-4 h-4" />
                        )}
                        <span>
                            {submitting
                                ? t('placement.quiz.submitting')
                                : isLastQuestion
                                    ? t('placement.quiz.finish')
                                    : t('placement.quiz.next')}
                        </span>
                    </button>
                </div>

                <p className="hidden sm:block mt-3 text-[11px] text-zinc-600">
                    {t('placement.quiz.keyHint')}
                </p>
            </motion.section>

            {timedOut && submitting && (
                <p data-testid="placement-timed-out" className="text-xs text-amber-300/90">
                    {t('placement.quiz.timeUp')}
                </p>
            )}

            {errorPanel(error, () => void submitPaper())}
        </div>
    ) : (
        <div className="py-16 text-center text-sm text-zinc-500">{t('placement.quiz.noItems')}</div>
    );

    // ── Result ────────────────────────────────────────────────────────────
    const resultBody = result ? (
        <div data-testid="placement-result" className="flex flex-col gap-4 sm:gap-5">
            <section className={`${CARD} p-5 sm:p-8 text-center`}>
                <p className="text-xs font-medium text-zinc-500">{t('placement.result.intervalLabel')}</p>
                <p
                    data-testid="placement-result-cefr"
                    className="mt-1 text-5xl sm:text-6xl font-semibold tracking-tight text-zinc-50 tabular-nums break-words"
                >
                    {intervalLabel(result.cefr.label)}
                </p>
                <p data-testid="placement-result-point" className="mt-2 text-sm text-zinc-400">
                    {t('placement.result.pointLabel')}{' '}
                    <span className="font-medium text-zinc-200">{result.cefr.point}</span>
                </p>

                <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
                    <span
                        data-testid="placement-result-confidence"
                        className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300"
                    >
                        <span>
                            {t('placement.result.confidenceLabel')}{' '}
                            {confidenceText(result.confidenceLabel, result.confidenceLabelZh)}
                        </span>
                        <span className="tabular-nums text-blue-300/70">{result.confidence.toFixed(2)}</span>
                    </span>
                    {result.preliminary && (
                        <span
                            data-testid="placement-result-preliminary"
                            className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/20 text-amber-300"
                        >
                            {t('placement.result.preliminaryBadge')}
                        </span>
                    )}
                    <span className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/5 border border-white/5 text-zinc-400">
                        {t('placement.result.sample', { count: formatNumber(result.sampleSize) })}
                    </span>
                </div>

                {result.preliminary && (
                    <p
                        data-testid="placement-result-preliminary-hint"
                        className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-zinc-500"
                    >
                        {t('placement.result.preliminaryHint', {
                            count: formatNumber(result.sampleSize),
                        })}
                    </p>
                )}

                <div className="mx-auto mt-5 grid max-w-md grid-cols-1 sm:grid-cols-2 gap-2 text-left">
                    <div className="rounded-xl border border-white/5 bg-zinc-800/30 px-3 py-2.5 min-w-0">
                        <p className="text-[11px] text-zinc-500">{t('placement.result.vocabLabel')}</p>
                        <p className="mt-0.5 text-sm font-semibold text-zinc-200 break-words">
                            {t('placement.result.vocabValue', {
                                count: formatNumber(result.breakdown.vocab.estimate),
                            })}
                        </p>
                    </div>
                    <div className="rounded-xl border border-white/5 bg-zinc-800/30 px-3 py-2.5 min-w-0">
                        <p className="text-[11px] text-zinc-500">{t('placement.result.readingLabel')}</p>
                        <p className="mt-0.5 text-sm font-semibold text-zinc-200 break-words">
                            {result.breakdown.reading.band}
                        </p>
                    </div>
                </div>
            </section>

            <section className={`${CARD} p-5`} data-testid="placement-result-domains">
                <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                    {t('placement.result.strengths')}
                </h3>
                <div className="mt-2 flex flex-wrap gap-2">
                    {result.breakdown.strengths.map((item, strengthIndex) => (
                        <span
                            key={`strength-${strengthIndex}`}
                            className="text-xs font-medium px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 break-words"
                        >
                            {item}
                        </span>
                    ))}
                </div>
                <h3 className="mt-4 text-[17px] font-semibold tracking-tight text-zinc-100">
                    {t('placement.result.weaknesses')}
                </h3>
                {result.breakdown.weaknesses.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                        {result.breakdown.weaknesses.map((item, weaknessIndex) => (
                            <span
                                key={`weakness-${weaknessIndex}`}
                                className="text-xs font-medium px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 break-words"
                            >
                                {item}
                            </span>
                        ))}
                    </div>
                ) : (
                    <p className="mt-2 text-xs text-zinc-500">{t('placement.result.noWeakness')}</p>
                )}
                <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 gap-2">
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                        <span className="text-zinc-400">{t('placement.result.measured')}: </span>
                        {result.breakdown.measuredDomains.map(domainLabel).join(' · ')}
                    </p>
                    <p className="text-[11px] leading-relaxed text-zinc-500">
                        <span className="text-zinc-400">{t('placement.result.notMeasured')}: </span>
                        {result.breakdown.notMeasured.map(domainLabel).join(' · ')}
                    </p>
                </div>
            </section>

            {result.breakdown.advice && (
                <section
                    data-testid="placement-result-advice"
                    className={`${CARD} p-5 flex items-start gap-3`}
                >
                    <Sparkles className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('placement.result.advice')}
                        </h3>
                        <p className="mt-1 text-sm leading-relaxed text-zinc-300 break-words">
                            {result.breakdown.advice}
                        </p>
                    </div>
                </section>
            )}

            <section
                data-testid="placement-result-disclaimer"
                className="rounded-2xl border border-white/5 bg-zinc-900/30 p-4"
            >
                <p className="text-[11px] font-medium text-zinc-500">{t('placement.result.disclaimerLabel')}</p>
                <p className="mt-1 text-xs leading-relaxed text-zinc-400 break-words">{result.disclaimer}</p>
            </section>

            {isGuest && (
                <div
                    data-testid="placement-guest-hint"
                    className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-2xl border border-blue-500/15 bg-blue-500/5 p-4"
                >
                    <p className="flex-1 text-xs leading-relaxed text-zinc-400">
                        {t('placement.guest.hint')}
                    </p>
                    {onRequestLogin && (
                        <button
                            type="button"
                            data-testid="placement-guest-login"
                            onClick={onRequestLogin}
                            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-xs font-medium text-blue-300 transition-colors shrink-0"
                        >
                            <LogIn className="w-3.5 h-3.5" />
                            {t('placement.guest.login')}
                        </button>
                    )}
                </div>
            )}

            <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                <button
                    type="button"
                    data-testid="placement-result-learn"
                    onClick={onStartLearning ?? onClose}
                    className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                >
                    {t('placement.result.learn')}
                    <ArrowRight className="w-4 h-4" />
                </button>
                <button
                    type="button"
                    data-testid="placement-result-home"
                    onClick={onClose}
                    className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                >
                    {t('placement.home')}
                </button>
                <button
                    type="button"
                    data-testid="placement-result-retest"
                    onClick={() => void beginPlacement()}
                    disabled={starting}
                    className={`${GHOST_BUTTON} w-full sm:w-auto`}
                >
                    {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                    {t('placement.result.retest')}
                </button>
            </div>

            {errorPanel(error, () => void beginPlacement())}
        </div>
    ) : null;

    // ── Profile ───────────────────────────────────────────────────────────
    const profileBody = (
        <div data-testid="placement-profile" className="flex flex-col gap-4 sm:gap-5">
            {profileState.phase === 'loading' && (
                <div className={`${CARD} flex items-center gap-3 p-6`} data-testid="placement-profile-loading">
                    <Loader2 className="w-5 h-5 text-blue-400 animate-spin shrink-0" />
                    <p className="text-sm text-zinc-400">{t('placement.profile.loading')}</p>
                </div>
            )}

            {profileState.phase === 'error' && (
                <div className={`${CARD} p-5`} data-testid="placement-profile-error">
                    <div className="flex items-start gap-2">
                        <ShieldQuestion className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                        <div className="min-w-0">
                            <p className="text-sm text-amber-200">{t('placement.profile.error')}</p>
                            {profileState.error && (
                                <p className="mt-1 text-xs text-zinc-500 break-words">{profileState.error}</p>
                            )}
                        </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="placement-profile-retry"
                            onClick={() => void loadProfile()}
                            className={SECONDARY_BUTTON}
                        >
                            {t('common.retry')}
                        </button>
                        <button type="button" onClick={onClose} className={GHOST_BUTTON}>
                            {t('placement.home')}
                        </button>
                    </div>
                </div>
            )}

            {profileState.phase === 'ready' && !profile && (
                <div className={`${CARD} flex flex-col items-center p-8 text-center`} data-testid="placement-profile-empty">
                    <Gauge className="w-10 h-10 text-zinc-700 mb-3" />
                    <p className="text-sm font-medium text-zinc-300">{t('placement.profile.emptyTitle')}</p>
                    <p className="mt-1 max-w-sm text-xs leading-relaxed text-zinc-500">
                        {t('placement.profile.emptyHint')}
                    </p>
                    <button
                        type="button"
                        data-testid="placement-profile-start"
                        onClick={() => void beginPlacement()}
                        disabled={starting}
                        className={`${PRIMARY_BUTTON} mt-5`}
                    >
                        {starting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {t('placement.profile.emptyAction')}
                    </button>
                    {errorPanel(error, () => void beginPlacement())}
                </div>
            )}

            {profileState.phase === 'ready' && profile && (
                <>
                    <section className={`${CARD} p-5 sm:p-8 text-center`}>
                        <p className="text-xs font-medium text-zinc-500">{t('placement.profile.current')}</p>
                        <p
                            data-testid="placement-profile-cefr"
                            className="mt-1 text-5xl sm:text-6xl font-semibold tracking-tight text-zinc-50 tabular-nums break-words"
                        >
                            {intervalLabel(profile.cefr)}
                        </p>
                        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
                            <p
                                data-testid="placement-profile-confidence"
                                className="inline-flex items-center gap-1.5 text-[11px] font-medium px-2.5 py-1 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300"
                            >
                                <span>
                                    {t('placement.result.confidenceLabel')}{' '}
                                    {confidenceText(profile.confidenceLabel, profile.confidenceLabelZh)}
                                </span>
                                <span className="tabular-nums text-blue-300/70">{profile.confidence.toFixed(2)}</span>
                            </p>
                            <span
                                data-testid="placement-profile-sample"
                                className="text-[11px] font-medium px-2.5 py-1 rounded-full bg-white/5 border border-white/5 text-zinc-400"
                            >
                                {t('placement.result.sample', { count: formatNumber(profile.sampleSize) })}
                            </span>
                        </div>
                        {profile.preliminary && (
                            <p
                                data-testid="placement-profile-preliminary"
                                className="mx-auto mt-3 max-w-md text-xs leading-relaxed text-zinc-500"
                            >
                                {t('placement.result.preliminaryHint', {
                                    count: formatNumber(profile.sampleSize),
                                })}
                            </p>
                        )}
                    </section>

                    <section className={`${CARD} p-5`}>
                        <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-3">
                            <div className="min-w-0">
                                <dt className="text-[11px] text-zinc-500">{t('placement.profile.source')}</dt>
                                <dd className="mt-0.5 text-sm text-zinc-200">
                                    {SOURCE_KEYS[profile.source] ? t(SOURCE_KEYS[profile.source]) : profile.source}
                                </dd>
                            </div>
                            <div className="min-w-0">
                                <dt className="text-[11px] text-zinc-500">{t('placement.profile.updated')}</dt>
                                <dd className="mt-0.5 text-sm text-zinc-200 tabular-nums">
                                    {formatDate(profile.updatedAt, {
                                        dateStyle: 'medium',
                                        timeStyle: 'short',
                                    })}
                                </dd>
                            </div>
                            <div className="min-w-0">
                                <dt className="text-[11px] text-zinc-500">{t('placement.profile.vocab')}</dt>
                                <dd className="mt-0.5 text-sm text-zinc-200">
                                    {profile.vocabEstimate != null
                                        ? t('placement.result.vocabValue', {
                                            count: formatNumber(profile.vocabEstimate),
                                        })
                                        : t('placement.profile.unknownValue')}
                                </dd>
                            </div>
                            <div className="min-w-0">
                                <dt className="text-[11px] text-zinc-500">{t('placement.profile.reading')}</dt>
                                <dd className="mt-0.5 text-sm text-zinc-200">
                                    {profile.readingEstimate || t('placement.profile.unknownValue')}
                                </dd>
                            </div>
                        </dl>
                    </section>

                    {(profile.strengths.length > 0 || profile.weaknesses.length > 0) && (
                        <section className={`${CARD} p-5`}>
                            <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                                {t('placement.result.strengths')}
                            </h3>
                            <div className="mt-2 flex flex-wrap gap-2">
                                {profile.strengths.map((item, strengthIndex) => (
                                    <span
                                        key={`profile-strength-${strengthIndex}`}
                                        className="text-xs font-medium px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-300 break-words"
                                    >
                                        {item}
                                    </span>
                                ))}
                            </div>
                            <h3 className="mt-4 text-[17px] font-semibold tracking-tight text-zinc-100">
                                {t('placement.result.weaknesses')}
                            </h3>
                            {profile.weaknesses.length > 0 ? (
                                <div className="mt-2 flex flex-wrap gap-2">
                                    {profile.weaknesses.map((item, weaknessIndex) => (
                                        <span
                                            key={`profile-weakness-${weaknessIndex}`}
                                            className="text-xs font-medium px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-300 break-words"
                                        >
                                            {item}
                                        </span>
                                    ))}
                                </div>
                            ) : (
                                <p className="mt-2 text-xs text-zinc-500">{t('placement.result.noWeakness')}</p>
                            )}
                        </section>
                    )}

                    {profile.advice && (
                        <section className={`${CARD} p-5 flex items-start gap-3`}>
                            <Sparkles className="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                            <div className="min-w-0">
                                <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                                    {t('placement.result.advice')}
                                </h3>
                                <p className="mt-1 text-sm leading-relaxed text-zinc-300 break-words">
                                    {profile.advice}
                                </p>
                            </div>
                        </section>
                    )}

                    <section
                        data-testid="placement-profile-disclaimer"
                        className="rounded-2xl border border-white/5 bg-zinc-900/30 p-4"
                    >
                        <p className="text-[11px] font-medium text-zinc-500">
                            {t('placement.result.disclaimerLabel')}
                        </p>
                        <p className="mt-1 text-xs leading-relaxed text-zinc-400 break-words">
                            {profile.disclaimer}
                        </p>
                    </section>

                    {isGuest && (
                        <div
                            data-testid="placement-profile-guest"
                            className="flex flex-col sm:flex-row sm:items-center gap-2 rounded-2xl border border-blue-500/15 bg-blue-500/5 p-4"
                        >
                            <p className="flex-1 text-xs leading-relaxed text-zinc-400">
                                {t('placement.guest.hint')}
                            </p>
                            {onRequestLogin && (
                                <button
                                    type="button"
                                    onClick={onRequestLogin}
                                    className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-xs font-medium text-blue-300 transition-colors shrink-0"
                                >
                                    <LogIn className="w-3.5 h-3.5" />
                                    {t('placement.guest.login')}
                                </button>
                            )}
                        </div>
                    )}

                    {retestError && (
                        <p data-testid="placement-profile-retest-error" className="text-xs text-amber-300 break-words">
                            {retestError}
                        </p>
                    )}

                    <div className="flex flex-col sm:flex-row flex-wrap gap-2">
                        <button
                            type="button"
                            data-testid="placement-profile-retest"
                            onClick={() => setConfirm('retest')}
                            disabled={starting}
                            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                        >
                            {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <RotateCcw className="w-4 h-4" />}
                            {t('placement.profile.retest')}
                        </button>
                        <button
                            type="button"
                            data-testid="placement-profile-home"
                            onClick={onClose}
                            className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                        >
                            {t('placement.home')}
                        </button>
                    </div>
                </>
            )}
        </div>
    );

    const body =
        phase === 'intro'
            ? introBody
            : phase === 'quiz'
                ? quizBody
                : phase === 'result'
                    ? resultBody
                    : profileBody;

    const confirmCopy: Record<
        ConfirmKind,
        { title: string; body: string; confirm: string; cancel: string }
    > = {
        exit: {
            title: t('placement.quiz.exitConfirmTitle'),
            body: t('placement.quiz.exitConfirmBody'),
            confirm: t('placement.quiz.exitConfirm'),
            cancel: t('placement.quiz.keepGoing'),
        },
        submit: {
            title: t('placement.quiz.submitConfirmTitle', {
                count: formatNumber(Math.max(0, totalCount - recordedCount)),
            }),
            body: t('placement.quiz.submitConfirmBody', {
                count: formatNumber(Math.max(0, totalCount - recordedCount)),
            }),
            confirm: t('placement.quiz.submitConfirm'),
            cancel: t('placement.quiz.keepGoing'),
        },
        retest: {
            title: t('placement.profile.retestConfirmTitle'),
            body: t('placement.profile.retestConfirmBody'),
            confirm: t('placement.profile.retestConfirm'),
            cancel: t('placement.cancel'),
        },
    };

    const confirmAction = () => {
        if (confirm === 'exit') {
            handleExitConfirm();
            return;
        }
        if (confirm === 'submit') {
            setConfirm(null);
            void submitPaper();
            return;
        }
        if (confirm === 'retest') {
            setRetestError(null);
            handleRetestConfirm();
        }
    };

    return (
        <div
            ref={scrollRef}
            data-testid="placement-screen"
            data-phase={phase}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
        >
            <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                <header className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                        <p className="text-[11px] font-medium text-blue-400/90 tracking-tight">
                            {t('placement.eyebrow')}
                        </p>
                        <h1
                            data-testid="placement-title"
                            className="mt-0.5 text-xl sm:text-2xl font-semibold tracking-tight text-zinc-100 break-words"
                        >
                            {headerTitle}
                        </h1>
                        <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 break-words">
                            {headerSubtitle}
                        </p>
                    </div>
                    <button
                        type="button"
                        data-testid="placement-exit"
                        onClick={handleExitClick}
                        aria-label={t('placement.closeAria')}
                        title={t('placement.closeAria')}
                        className="p-2 rounded-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-400 hover:text-zinc-100 transition-colors shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </header>

                <AnimatePresence mode="wait" initial={false}>
                    <motion.div
                        key={phase}
                        initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={reduceMotion ? undefined : { opacity: 0 }}
                        transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                    >
                        {body}
                    </motion.div>
                </AnimatePresence>
            </div>

            {confirm && createPortal(
                <div
                    className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-zinc-950/70 backdrop-blur-md p-4"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="placement-confirm-title"
                    data-testid={`placement-confirm-${confirm}`}
                >
                    <div className="w-full max-w-sm rounded-2xl bg-zinc-900/90 backdrop-blur-2xl border border-white/10 shadow-2xl shadow-black/60 p-5">
                        <h2
                            id="placement-confirm-title"
                            className="text-xl font-semibold tracking-tight text-zinc-100 break-words"
                        >
                            {confirmCopy[confirm].title}
                        </h2>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400 break-words">
                            {confirmCopy[confirm].body}
                        </p>
                        {retestError && confirm === 'retest' && (
                            <p className="mt-2 text-xs text-amber-300 break-words">{retestError}</p>
                        )}
                        <div className="mt-5 flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
                            <button
                                type="button"
                                data-testid="placement-confirm-cancel"
                                onClick={() => setConfirm(null)}
                                className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                            >
                                {confirmCopy[confirm].cancel}
                            </button>
                            <button
                                type="button"
                                data-testid="placement-confirm-ok"
                                onClick={confirmAction}
                                disabled={starting}
                                className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                            >
                                {starting && <Loader2 className="w-4 h-4 animate-spin" />}
                                {confirmCopy[confirm].confirm}
                            </button>
                        </div>
                    </div>
                </div>,
                document.body,
            )}
        </div>
    );
}
