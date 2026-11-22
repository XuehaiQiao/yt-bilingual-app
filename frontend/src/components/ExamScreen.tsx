// Exam practice view (V2 / specs/022-exam-practice, frontend).
//
// Four phases in one full view:
//   types   — the available bank ("CET-4 风格练习": 30 items, 10 per practice)
//             with the backend disclaimer rendered verbatim;
//   quiz    — one item at a time, progress + numbered jump row, reading passage
//             above the question, per-item "待定" flag, submit confirmation
//             that names the unanswered count;
//   result  — correct / total + unanswered count, then per-item correctness,
//             the correct answer and the explanation. Wrong/unanswered rows
//             can start another practice of the same type;
//   history — submitted practices only: date / type / correct / total, with a
//             "start again" action per row.
//
// Honesty: the backend never returns a score, percentage, predicted grade or
// pass rate, and this screen never invents one. The only numbers are correct,
// total, answered and unanswered. `disclaimer` is rendered as sent.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion, useReducedMotion } from 'framer-motion';
import {
    AlertCircle,
    ArrowLeft,
    ArrowRight,
    CheckCircle2,
    Flag,
    History,
    Loader2,
    LogIn,
    RotateCcw,
} from 'lucide-react';
import {
    ExamApiError,
    getExamHistory,
    getExamTypes,
    startExam,
    submitExam,
    type ExamHistorySession,
    type ExamItem,
    type ExamResultItem,
    type ExamStartResponse,
    type ExamSubmitResponse,
    type ExamTypeOption,
} from '../lib/exam';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import { Dialog } from './ui/Dialog';
import { SubHeader } from './ui/SubHeader';
import { PageContainer } from './layout/PageContainer';
import { PageGrid } from './layout/PageGrid';
import { SideRail } from './layout/SideRail';

interface ExamScreenProps {
    /** Guests can open the view but cannot practice (records belong to an account). */
    isGuest: boolean;
    /** Leave the view (home stays mounted underneath). */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Guest "log in to use" entry. */
    onRequestLogin?: () => void;
}

type Phase = 'types' | 'quiz' | 'result' | 'history';
type ConfirmKind = 'submit' | 'exit';

interface Draft {
    answers: Record<string, number>;
    flagged: string[];
    index: number;
}

interface TypesState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    types: ExamTypeOption[];
    disclaimer: string;
    error: string | null;
}

interface HistoryState {
    status: 'idle' | 'loading' | 'ready' | 'error';
    sessions: ExamHistorySession[];
    disclaimer: string;
    error: string | null;
}

const DRAFT_PREFIX = 'yt_exam_draft:v1:';
const LETTERS = ['A', 'B', 'C', 'D'];
const HISTORY_LIMIT = 20;

const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-50 disabled:active:scale-100';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50';
const GHOST_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors';
const CARD = 'rounded-2xl sm:rounded-3xl border border-white/5 bg-zinc-900/40';
const OPTION_BASE =
    'w-full flex items-start gap-3 rounded-xl border px-3.5 py-3 sm:px-4 text-left transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.99]';

function optionLabel(index: number | null, options: string[]): string {
    if (index == null || index < 0 || index >= options.length) return '—';
    return `${LETTERS[index] ?? '?'}. ${options[index]}`;
}

function readDraft(sessionId: string): Draft | null {
    try {
        const raw = localStorage.getItem(`${DRAFT_PREFIX}${sessionId}`);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<Draft> | null;
        if (!parsed || typeof parsed !== 'object') return null;
        const answers: Record<string, number> = {};
        if (parsed.answers && typeof parsed.answers === 'object') {
            for (const [itemId, value] of Object.entries(parsed.answers)) {
                if (
                    typeof value === 'number' &&
                    Number.isInteger(value) &&
                    value >= 0 &&
                    value <= 3
                ) {
                    answers[itemId] = value;
                }
            }
        }
        const flagged = Array.isArray(parsed.flagged)
            ? parsed.flagged.filter((itemId): itemId is string => typeof itemId === 'string')
            : [];
        const index =
            typeof parsed.index === 'number' && Number.isFinite(parsed.index)
                ? Math.max(0, Math.floor(parsed.index))
                : 0;
        return { answers, flagged, index };
    } catch {
        return null;
    }
}

function writeDraft(sessionId: string, draft: Draft): void {
    try {
        localStorage.setItem(`${DRAFT_PREFIX}${sessionId}`, JSON.stringify(draft));
    } catch {
        // Private mode / quota: the paper still works, only recovery is lost.
    }
}

function clearDraft(sessionId: string): void {
    try {
        localStorage.removeItem(`${DRAFT_PREFIX}${sessionId}`);
    } catch {
        // Non-fatal.
    }
}

export function ExamScreen({ isGuest, onClose, parentLabel, onRequestLogin }: ExamScreenProps) {
    const { t, formatNumber, formatDate } = useI18n();
    const reduceMotion = useReducedMotion();

    const [phase, setPhase] = useState<Phase>('types');
    const [typesState, setTypesState] = useState<TypesState>({
        status: isGuest ? 'idle' : 'loading',
        types: [],
        disclaimer: '',
        error: null,
    });
    const [historyState, setHistoryState] = useState<HistoryState>({
        status: 'idle',
        sessions: [],
        disclaimer: '',
        error: null,
    });
    const [session, setSession] = useState<ExamStartResponse | null>(null);
    const [result, setResult] = useState<ExamSubmitResponse | null>(null);
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<Record<string, number>>({});
    const [flagged, setFlagged] = useState<Record<string, boolean>>({});
    const [starting, setStarting] = useState(false);
    const [startingType, setStartingType] = useState<string | null>(null);
    const [submitting, setSubmitting] = useState(false);
    const [confirm, setConfirm] = useState<ConfirmKind | null>(null);
    // Keep the last kind while the exit animation runs; `confirm` is cleared the
    // moment a close starts, but the panel stays mounted for ~160ms.
    const [lastConfirm, setLastConfirm] = useState<ConfirmKind | null>(null);
    const [actionError, setActionError] = useState<string | null>(null);
    const [actionStatus, setActionStatus] = useState<number | null>(null);

    const startingRef = useRef(false);
    const submittingRef = useRef(false);
    const attemptStartedAtRef = useRef(0);

    const loadTypes = useCallback(async () => {
        setTypesState((prev) => ({ ...prev, status: 'loading', error: null }));
        try {
            const data = await getExamTypes();
            setTypesState({
                status: 'ready',
                types: Array.isArray(data.types) ? data.types : [],
                disclaimer: data.disclaimer ?? '',
                error: null,
            });
        } catch (err) {
            let message = await describeApiError(err);
            if (err instanceof ExamApiError && err.status === 403) {
                message = t('exam.errors.login');
                onRequestLogin?.();
            } else if (err instanceof ExamApiError && err.status === 503) {
                message = t('exam.errors.unavailable');
            }
            setTypesState({ status: 'error', types: [], disclaimer: '', error: message });
        }
    }, [t, onRequestLogin]);

    useEffect(() => {
        if (isGuest) return;
        void loadTypes();
    }, [isGuest, loadTypes]);

    // Persist the paper draft on every meaningful change, so leaving the view
    // (or closing the tab) does not silently discard local answers. The draft
    // never leaves this device; the server stores answers only on submit.
    useEffect(() => {
        if (!session || phase !== 'quiz') return;
        writeDraft(session.sessionId, {
            answers,
            flagged: Object.keys(flagged).filter((itemId) => flagged[itemId]),
            index,
        });
    }, [session, phase, answers, flagged, index]);

    // Escape now belongs to the shared Dialog (IX-09): no local listener.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- keep copy/testid during the Dialog exit animation
        if (confirm) setLastConfirm(confirm);
    }, [confirm]);

    const total = session?.items.length ?? 0;
    const totalItems = session?.itemCount ?? total;
    const currentItem: ExamItem | null = session?.items[index] ?? null;
    const shownConfirm = confirm ?? lastConfirm;
    const answeredCount = useMemo(() => {
        if (!session) return 0;
        return session.items.reduce(
            (count, item) => count + (answers[item.itemId] !== undefined ? 1 : 0),
            0,
        );
    }, [session, answers]);
    const flaggedCount = useMemo(() => {
        if (!session) return 0;
        return session.items.reduce(
            (count, item) => count + (flagged[item.itemId] ? 1 : 0),
            0,
        );
    }, [session, flagged]);
    const unansweredCount = Math.max(0, total - answeredCount);

    const typeLabel = useCallback(
        (typeId: string, fallback: string) =>
            typeId === 'cet4' ? t('exam.type.cet4.label') : fallback,
        [t],
    );
    const typeDescription = useCallback(
        (type: ExamTypeOption) =>
            type.id === 'cet4' ? t('exam.type.cet4.description') : type.description,
        [t],
    );

    const beginExam = useCallback(async (typeId: string) => {
        if (startingRef.current) return;
        startingRef.current = true;
        setStarting(true);
        setStartingType(typeId);
        setActionError(null);
        setActionStatus(null);
        try {
            const data = await startExam(typeId);
            if (!Array.isArray(data.items) || data.items.length === 0) {
                throw new Error(t('exam.quiz.empty'));
            }
            const itemIds = new Set(data.items.map((item) => item.itemId));
            const draft = readDraft(data.sessionId);
            const restoredAnswers: Record<string, number> = {};
            if (draft) {
                for (const [itemId, chosen] of Object.entries(draft.answers)) {
                    if (itemIds.has(itemId)) restoredAnswers[itemId] = chosen;
                }
            }
            const restoredFlags: Record<string, boolean> = {};
            if (draft) {
                for (const itemId of draft.flagged) {
                    if (itemIds.has(itemId)) restoredFlags[itemId] = true;
                }
            }
            const restoredIndex = draft
                ? Math.min(Math.max(0, draft.index), data.items.length - 1)
                : 0;
            setSession(data);
            setResult(null);
            setAnswers(restoredAnswers);
            setFlagged(restoredFlags);
            setIndex(restoredIndex);
            setActionError(null);
            setActionStatus(null);
            attemptStartedAtRef.current = Date.now();
            setPhase('quiz');
        } catch (err) {
            let message = await describeApiError(err);
            let status: number | null = null;
            if (err instanceof ExamApiError) {
                status = err.status;
                if (err.status === 403) {
                    message = t('exam.errors.login');
                    onRequestLogin?.();
                } else if (err.status === 503) {
                    message = t('exam.errors.unavailable');
                } else if (err.status === 404 || err.status === 409) {
                    message = t('exam.quiz.sessionGone');
                } else if (err.message) {
                    message = err.message;
                }
            }
            setActionError(message || t('exam.errors.start'));
            setActionStatus(status);
        } finally {
            startingRef.current = false;
            setStarting(false);
            setStartingType(null);
        }
    }, [t, onRequestLogin]);

    const loadHistory = useCallback(async () => {
        setHistoryState((prev) => ({ ...prev, status: 'loading', error: null }));
        try {
            const data = await getExamHistory(HISTORY_LIMIT);
            setHistoryState({
                status: 'ready',
                sessions: Array.isArray(data.sessions) ? data.sessions : [],
                disclaimer: data.disclaimer ?? '',
                error: null,
            });
        } catch (err) {
            if (err instanceof ExamApiError && err.status === 403) onRequestLogin?.();
            const message = await describeApiError(err);
            setHistoryState({
                status: 'error',
                sessions: [],
                disclaimer: '',
                error: message,
            });
        }
    }, [onRequestLogin]);

    const openHistory = useCallback(() => {
        setPhase('history');
        void loadHistory();
    }, [loadHistory]);

    const submitPaper = useCallback(async () => {
        if (!session || submittingRef.current) return;
        submittingRef.current = true;
        setSubmitting(true);
        setActionError(null);
        setActionStatus(null);
        const payloadAnswers = session.items.flatMap((item) => {
            const chosen = answers[item.itemId];
            return chosen === undefined ? [] : [{ itemId: item.itemId, chosenIndex: chosen }];
        });
        try {
            const data = await submitExam({
                sessionId: session.sessionId,
                answers: payloadAnswers,
                durationMs: Math.max(0, Date.now() - attemptStartedAtRef.current),
            });
            clearDraft(session.sessionId);
            setResult(data);
            setConfirm(null);
            setPhase('result');
        } catch (err) {
            let message = await describeApiError(err);
            let status: number | null = null;
            if (err instanceof ExamApiError) {
                status = err.status;
                if (err.status === 403) {
                    message = t('exam.errors.login');
                    onRequestLogin?.();
                } else if (err.status === 503) {
                    message = t('exam.errors.unavailable');
                } else if (err.status === 404 || err.status === 409) {
                    message = t('exam.quiz.sessionGone');
                } else if (err.message) {
                    message = err.message;
                }
            }
            setConfirm(null);
            setActionError(message || t('exam.quiz.error'));
            setActionStatus(status);
        } finally {
            submittingRef.current = false;
            setSubmitting(false);
        }
    }, [session, answers, t, onRequestLogin]);

    const handleClose = useCallback(() => {
        if (phase === 'quiz' && session) {
            writeDraft(session.sessionId, {
                answers,
                flagged: Object.keys(flagged).filter((itemId) => flagged[itemId]),
                index,
            });
            setConfirm('exit');
            return;
        }
        onClose();
    }, [phase, session, answers, flagged, index, onClose]);

    const confirmAction = () => {
        if (confirm === 'submit') {
            void submitPaper();
            return;
        }
        if (confirm === 'exit') {
            setConfirm(null);
            onClose();
        }
    };

    const toggleFlag = () => {
        if (!currentItem) return;
        setFlagged((prev) => {
            const next = { ...prev };
            if (next[currentItem.itemId]) delete next[currentItem.itemId];
            else next[currentItem.itemId] = true;
            return next;
        });
    };

    const chooseOption = (optionIndex: number) => {
        if (!currentItem) return;
        setAnswers((prev) => ({ ...prev, [currentItem.itemId]: optionIndex }));
    };

    const headerTitle =
        phase === 'types'
            ? t('exam.types.title')
            : phase === 'quiz' && session
                ? typeLabel(session.examType, session.label)
                : phase === 'result'
                    ? t('exam.result.title')
                    : t('exam.history.title');
    const headerSubtitle =
        phase === 'types'
            ? t('exam.subtitle')
            : phase === 'quiz'
                ? t('exam.quiz.subtitle', { count: formatNumber(totalItems) })
                : phase === 'result'
                    ? t('exam.result.subtitle')
                    : t('exam.history.subtitle');

    const historyDate = (entry: ExamHistorySession): string => {
        const stamp = Number.isFinite(entry.submittedAt)
            ? entry.submittedAt
            : Date.parse(entry.date);
        if (!Number.isFinite(stamp)) return '—';
        return formatDate(stamp, { dateStyle: 'medium', timeStyle: 'short' });
    };

    const renderTypeCard = (type: ExamTypeOption) => (
        <section
            key={type.id}
            data-testid={`exam-type-${type.id}`}
            className={`${CARD} p-5 sm:p-6`}
        >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0">
                    <h2 className="text-lg font-semibold tracking-tight text-zinc-100 break-words">
                        {typeLabel(type.id, type.label)}
                    </h2>
                    <p className="mt-1 text-sm leading-relaxed text-zinc-400 break-words">
                        {typeDescription(type)}
                    </p>
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                    <span className="rounded-full border border-white/5 bg-zinc-800/60 px-2 py-0.5 text-[11px] font-medium text-zinc-400 tabular-nums">
                        {t('exam.types.bankCount', { count: formatNumber(type.itemCount) })}
                    </span>
                    <span className="rounded-full border border-white/5 bg-zinc-800/60 px-2 py-0.5 text-[11px] font-medium text-zinc-400 tabular-nums">
                        {t('exam.types.sessionCount', { count: formatNumber(type.sessionItemCount) })}
                    </span>
                </div>
            </div>
            <button
                type="button"
                data-testid={`exam-type-start-${type.id}`}
                onClick={() => void beginExam(type.id)}
                disabled={starting}
                className={`${PRIMARY_BUTTON} mt-4 w-full sm:w-auto`}
            >
                {starting && startingType === type.id ? (
                    <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                    <ArrowRight className="w-4 h-4" />
                )}
                {starting && startingType === type.id
                    ? t('exam.types.starting')
                    : t('exam.types.start')}
            </button>
        </section>
    );

    const typesBody = isGuest ? (
        <section data-testid="exam-guest-card" className={`${CARD} p-6 sm:p-8`}>
            <div className="flex flex-col items-center text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-blue-500/20 bg-blue-500/10">
                    <LogIn className="w-5 h-5 text-blue-400" />
                </div>
                <h2 className="mt-4 text-lg font-semibold tracking-tight text-zinc-100">
                    {t('exam.home.guest')}
                </h2>
                <p className="mt-2 max-w-md text-sm leading-relaxed text-zinc-400 break-words">
                    {t('exam.home.guestHint')}
                </p>
                {onRequestLogin && (
                    <button
                        type="button"
                        data-testid="exam-guest-login"
                        onClick={onRequestLogin}
                        className={`${PRIMARY_BUTTON} mt-5 w-full sm:w-auto`}
                    >
                        <LogIn className="w-4 h-4" />
                        {t('exam.home.guestAction')}
                    </button>
                )}
                <p className="mt-5 text-[11px] leading-relaxed text-zinc-500 break-words">
                    {t('exam.home.disclaimer')}
                </p>
            </div>
        </section>
    ) : typesState.status === 'loading' || typesState.status === 'idle' ? (
        <div
            data-testid="exam-types-loading"
            className={`${CARD} flex items-center justify-center gap-3 p-8 text-sm text-zinc-400`}
        >
            <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
            {t('exam.types.loading')}
        </div>
    ) : typesState.status === 'error' ? (
        <div data-testid="exam-types-error" className={`${CARD} p-5 sm:p-6`}>
            <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 w-5 h-5 shrink-0 text-amber-400" />
                <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium text-zinc-200">{t('exam.types.error')}</p>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-500 break-words">
                        {typesState.error}
                    </p>
                </div>
            </div>
            <button
                type="button"
                data-testid="exam-types-retry"
                onClick={() => void loadTypes()}
                className={`${SECONDARY_BUTTON} mt-4 w-full sm:w-auto`}
            >
                <RotateCcw className="w-4 h-4" />
                {t('exam.types.retry')}
            </button>
        </div>
    ) : (
        <div className="flex flex-col gap-3 sm:gap-4">
            <div data-testid="exam-types" className="flex flex-col gap-3 sm:gap-4">
                {typesState.types.map(renderTypeCard)}
            </div>
            {actionError && (
                <p
                    data-testid="exam-action-error"
                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-300 break-words"
                >
                    {actionError}
                </p>
            )}
        </div>
    );

    const quizBody = session && currentItem ? (
        <div
            data-testid="exam-quiz"
            data-index={index}
            data-total={session.items.length}
            className="flex flex-col gap-3 sm:gap-4"
        >
            {session.resumed && (
                <p
                    data-testid="exam-resumed"
                    className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs leading-relaxed text-blue-300 break-words"
                >
                    {t('exam.quiz.resumed')}
                </p>
            )}

            <div className={`${CARD} px-3.5 py-3 sm:px-4`}>
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                    <p
                        data-testid="exam-progress"
                        className="text-sm font-medium text-zinc-200 tabular-nums"
                    >
                        {t('exam.quiz.header', {
                            current: formatNumber(index + 1),
                            total: formatNumber(session.items.length),
                        })}
                    </p>
                    <p className="text-[11px] font-medium text-zinc-500 tabular-nums">
                        {t('exam.quiz.answered', {
                            answered: formatNumber(answeredCount),
                            total: formatNumber(session.items.length),
                        })}
                    </p>
                </div>
                <div
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800"
                    role="progressbar"
                    aria-valuemin={1}
                    aria-valuemax={session.items.length}
                    aria-valuenow={index + 1}
                    aria-label={t('exam.quiz.progressAria')}
                >
                    <div
                        className="h-full rounded-full bg-blue-500 transition-[width] duration-300 ease-apple"
                        style={{ width: `${((index + 1) / session.items.length) * 100}%` }}
                    />
                </div>
                <div data-testid="exam-nav" className="mt-2.5 flex flex-wrap items-center gap-1">
                    {session.items.map((item, itemIndex) => {
                        const isAnswered = answers[item.itemId] !== undefined;
                        const isFlagged = Boolean(flagged[item.itemId]);
                        const isCurrent = itemIndex === index;
                        return (
                            <button
                                key={item.itemId}
                                type="button"
                                data-testid={`exam-nav-${itemIndex}`}
                                data-answered={isAnswered ? 'true' : 'false'}
                                data-flagged={isFlagged ? 'true' : 'false'}
                                aria-current={isCurrent ? 'step' : undefined}
                                aria-label={t('exam.quiz.header', {
                                    current: formatNumber(itemIndex + 1),
                                    total: formatNumber(session.items.length),
                                })}
                                onClick={() => setIndex(itemIndex)}
                                className={`relative flex h-6 w-6 items-center justify-center rounded-md border text-[10px] font-medium tabular-nums transition-colors ${
                                    isCurrent
                                        ? 'border-blue-400/50 bg-blue-500/15 text-blue-200'
                                        : isAnswered
                                            ? 'border-white/10 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-700/60'
                                            : 'border-white/5 bg-zinc-900/60 text-zinc-500 hover:bg-zinc-800/60'
                                }`}
                            >
                                {formatNumber(itemIndex + 1)}
                                {isFlagged && (
                                    <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-amber-400" />
                                )}
                            </button>
                        );
                    })}
                </div>
                <p className="mt-2 text-[11px] text-zinc-500 tabular-nums">
                    {t('exam.quiz.legend', {
                        answered: formatNumber(answeredCount),
                        flagged: formatNumber(flaggedCount),
                    })}
                </p>
            </div>

            <section data-testid="exam-question" className={`${CARD} p-4 sm:p-6`}>
                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                        {t(`exam.quiz.type.${currentItem.type}`)}
                    </span>
                    <span className="rounded-full border border-white/5 bg-zinc-800/60 px-2 py-0.5 text-[11px] font-medium text-zinc-400 tabular-nums">
                        {t('exam.quiz.band', { band: currentItem.band })}
                    </span>
                    {flagged[currentItem.itemId] && (
                        <span
                            data-testid="exam-flag-state"
                            className="rounded-full border border-amber-500/20 bg-amber-500/10 px-2 py-0.5 text-[11px] font-medium text-amber-300"
                        >
                            {t('exam.quiz.flagged')}
                        </span>
                    )}
                </div>

                {currentItem.passage && (
                    <div
                        data-testid="exam-passage"
                        className="mt-3 max-h-72 overflow-y-auto custom-scrollbar rounded-xl border border-white/5 bg-zinc-950/40 p-3.5 sm:p-4"
                    >
                        <p className="text-[11px] font-medium text-zinc-500 break-words">
                            {currentItem.passage.title}
                        </p>
                        <p className="mt-1.5 whitespace-pre-line text-sm leading-relaxed text-zinc-300 break-words">
                            {currentItem.passage.text}
                        </p>
                    </div>
                )}

                <p
                    data-testid="exam-prompt"
                    className="mt-3 text-base leading-relaxed text-zinc-100 break-words"
                >
                    {currentItem.prompt}
                </p>

                <div
                    role="group"
                    aria-label={t('exam.quiz.optionsAria')}
                    className="mt-3 space-y-2"
                >
                    {currentItem.options.map((option, optionIndex) => {
                        const selected = answers[currentItem.itemId] === optionIndex;
                        return (
                            <button
                                key={optionIndex}
                                type="button"
                                data-testid={`exam-option-${optionIndex}`}
                                aria-pressed={selected}
                                onClick={() => chooseOption(optionIndex)}
                                className={`${OPTION_BASE} ${
                                    selected
                                        ? 'border-blue-400/40 bg-blue-500/10 text-zinc-100'
                                        : 'border-white/5 bg-zinc-800/30 text-zinc-300 hover:border-white/10 hover:bg-zinc-800/60'
                                }`}
                            >
                                <span
                                    className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold tabular-nums ${
                                        selected
                                            ? 'border-blue-400/40 bg-blue-500/15 text-blue-300'
                                            : 'border-white/10 bg-white/5 text-zinc-500'
                                    }`}
                                >
                                    {LETTERS[optionIndex] ?? optionIndex + 1}
                                </span>
                                <span className="min-w-0 text-sm leading-relaxed break-words">
                                    {option}
                                </span>
                            </button>
                        );
                    })}
                </div>
            </section>

            <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2">
                    <button
                        type="button"
                        data-testid="exam-prev"
                        onClick={() => setIndex((prev) => Math.max(0, prev - 1))}
                        disabled={index === 0 || submitting}
                        className={`${SECONDARY_BUTTON} flex-1 sm:flex-none`}
                    >
                        <ArrowLeft className="w-4 h-4" />
                        {t('exam.quiz.previous')}
                    </button>
                    <button
                        type="button"
                        data-testid="exam-next"
                        onClick={() =>
                            setIndex((prev) => Math.min(session.items.length - 1, prev + 1))
                        }
                        disabled={index >= session.items.length - 1 || submitting}
                        className={`${SECONDARY_BUTTON} flex-1 sm:flex-none`}
                    >
                        {t('exam.quiz.next')}
                        <ArrowRight className="w-4 h-4" />
                    </button>
                </div>
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <button
                        type="button"
                        data-testid="exam-flag"
                        aria-pressed={Boolean(flagged[currentItem.itemId])}
                        onClick={toggleFlag}
                        disabled={submitting}
                        title={t('exam.quiz.flagHint')}
                        className={`inline-flex h-10 flex-1 items-center justify-center gap-2 rounded-xl border px-4 text-sm font-medium transition-colors disabled:opacity-50 sm:flex-none ${
                            flagged[currentItem.itemId]
                                ? 'border-amber-500/20 bg-amber-500/10 text-amber-300 hover:bg-amber-500/15'
                                : 'border-white/5 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100'
                        }`}
                    >
                        <Flag className="w-4 h-4" />
                        {flagged[currentItem.itemId]
                            ? t('exam.quiz.flagged')
                            : t('exam.quiz.flag')}
                    </button>
                    <button
                        type="button"
                        data-testid="exam-submit"
                        onClick={() => setConfirm('submit')}
                        disabled={submitting}
                        className={`${PRIMARY_BUTTON} flex-1 sm:ml-auto sm:flex-none`}
                    >
                        {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                        {submitting ? t('exam.quiz.submitting') : t('exam.quiz.submit')}
                    </button>
                </div>
            </div>

            {actionError && (
                <div
                    data-testid="exam-quiz-error"
                    className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2"
                >
                    <p className="text-xs leading-relaxed text-amber-300 break-words">
                        {actionError}
                    </p>
                    {(actionStatus === 404 || actionStatus === 409) && (
                        <button
                            type="button"
                            data-testid="exam-quiz-restart"
                            onClick={() => void beginExam(session.examType)}
                            className={`${SECONDARY_BUTTON} mt-2`}
                        >
                            {t('exam.quiz.restart')}
                        </button>
                    )}
                </div>
            )}
        </div>
    ) : (
        <div className="flex flex-col gap-4">
            <p className="text-sm text-zinc-400">{t('exam.quiz.empty')}</p>
            <button type="button" onClick={onClose} className={`${SECONDARY_BUTTON} w-full sm:w-auto`}>
                {t('exam.result.home')}
            </button>
        </div>
    );

    const renderResultRow = (item: ExamResultItem, rowIndex: number) => {
        const status = item.correct ? 'correct' : item.answered ? 'wrong' : 'unanswered';
        return (
            <article
                key={item.itemId}
                data-testid={`exam-result-row-${rowIndex}`}
                data-status={status}
                className={`${CARD} p-4 sm:p-5`}
            >
                <div className="flex items-start gap-3">
                    <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/5 text-[11px] font-medium tabular-nums text-zinc-400">
                        {formatNumber(rowIndex + 1)}
                    </span>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <span className="rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300">
                                {t(`exam.quiz.type.${item.type}`)}
                            </span>
                            <span
                                className={`inline-flex items-center gap-1 text-[11px] font-medium ${
                                    status === 'correct'
                                        ? 'text-emerald-400'
                                        : status === 'wrong'
                                            ? 'text-amber-400'
                                            : 'text-zinc-500'
                                }`}
                            >
                                {status === 'correct' && <CheckCircle2 className="w-3.5 h-3.5" />}
                                {status === 'wrong' && <AlertCircle className="w-3.5 h-3.5" />}
                                {status === 'correct'
                                    ? t('exam.result.correct')
                                    : status === 'wrong'
                                        ? t('exam.result.wrong')
                                        : t('exam.result.unansweredTag')}
                            </span>
                        </div>

                        {item.passage && (
                            <details className="mt-2 rounded-xl border border-white/5 bg-zinc-950/40 px-3 py-2">
                                <summary className="cursor-pointer text-[11px] font-medium text-zinc-500 hover:text-zinc-300">
                                    {t('exam.result.passage')}
                                </summary>
                                <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-zinc-400 break-words">
                                    {item.passage.text}
                                </p>
                            </details>
                        )}

                        <p className="mt-2 text-sm leading-relaxed text-zinc-200 break-words">
                            {item.prompt}
                        </p>

                        <div className="mt-2 space-y-1 text-xs leading-relaxed sm:text-sm">
                            <p className="text-zinc-400 break-words">
                                <span className="text-zinc-500">
                                    {t('exam.result.yourAnswer')}：
                                </span>
                                {item.answered
                                    ? optionLabel(item.chosenIndex, item.options)
                                    : t('exam.result.notAnswered')}
                            </p>
                            {!item.correct && (
                                <p className="text-zinc-400 break-words">
                                    <span className="text-zinc-500">
                                        {t('exam.result.correctAnswer')}：
                                    </span>
                                    <span className="text-emerald-300">
                                        {optionLabel(item.correctIndex, item.options)}
                                    </span>
                                </p>
                            )}
                        </div>

                        <div className="mt-2.5 rounded-xl border border-white/5 bg-zinc-950/40 px-3 py-2.5">
                            <p className="text-[11px] font-medium text-zinc-500">
                                {t('exam.result.explanation')}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-300 break-words sm:text-sm">
                                {item.explanation || t('exam.result.noExplanation')}
                            </p>
                        </div>

                        {!item.correct && (
                            <button
                                type="button"
                                data-testid={`exam-result-retry-row-${rowIndex}`}
                                onClick={() => void beginExam(result?.examType ?? 'cet4')}
                                disabled={starting}
                                title={t('exam.result.retryHint')}
                                className={`${SECONDARY_BUTTON} mt-2.5 h-9 w-full px-3 text-xs sm:w-auto`}
                            >
                                {starting ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                ) : (
                                    <RotateCcw className="w-3.5 h-3.5" />
                                )}
                                {t('exam.result.retryItem')}
                            </button>
                        )}
                    </div>
                </div>
            </article>
        );
    };

    const resultBody = result ? (
        <div data-testid="exam-result" className="flex flex-col gap-4 sm:gap-6">
            {result.reused && (
                <p
                    data-testid="exam-result-reused"
                    className="rounded-xl border border-blue-500/20 bg-blue-500/5 px-3 py-2 text-xs leading-relaxed text-blue-300 break-words"
                >
                    {t('exam.result.reused')}
                </p>
            )}

            <section className="glass-card rounded-3xl p-5 text-center sm:p-8">
                <p className="text-xs text-zinc-500">{t('exam.result.correctLabel')}</p>
                <div
                    data-testid="exam-result-correct"
                    data-correct={result.correct}
                    data-total={result.total}
                    className="mt-1 text-5xl font-semibold tracking-tight text-zinc-50 tabular-nums"
                >
                    {t('exam.result.correctValue', {
                        correct: formatNumber(result.correct),
                        total: formatNumber(result.total),
                    })}
                </div>
                {result.unanswered > 0 ? (
                    <p
                        data-testid="exam-result-unanswered"
                        className="mt-2 text-sm text-zinc-400 tabular-nums"
                    >
                        {t('exam.result.unanswered', { count: formatNumber(result.unanswered) })}
                    </p>
                ) : (
                    <p data-testid="exam-result-unanswered" className="mt-2 text-sm text-zinc-500">
                        {t('exam.result.answeredAll')}
                    </p>
                )}
                <div className="mt-5 flex flex-col justify-center gap-2 sm:flex-row sm:flex-wrap">
                    <button
                        type="button"
                        data-testid="exam-result-retry"
                        onClick={() => void beginExam(result.examType)}
                        disabled={starting}
                        className={PRIMARY_BUTTON}
                    >
                        {starting ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                            <RotateCcw className="w-4 h-4" />
                        )}
                        {starting ? t('exam.result.retrying') : t('exam.result.retrySimilar')}
                    </button>
                    <button
                        type="button"
                        data-testid="exam-result-history"
                        onClick={openHistory}
                        className={SECONDARY_BUTTON}
                    >
                        <History className="w-4 h-4" />
                        {t('exam.result.history')}
                    </button>
                    <button
                        type="button"
                        data-testid="exam-result-home"
                        onClick={onClose}
                        className={GHOST_BUTTON}
                    >
                        {t('exam.result.home')}
                    </button>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-500 break-words">
                    {t('exam.result.retryHint')}
                </p>
                {actionError && (
                    <p
                        data-testid="exam-result-action-error"
                        className="mt-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs leading-relaxed text-amber-300 break-words"
                    >
                        {actionError}
                    </p>
                )}
            </section>

            <section>
                <h2 className="mb-2 text-[17px] font-semibold tracking-tight text-zinc-100">
                    {t('exam.result.perQuestion')}
                </h2>
                <div className="flex flex-col gap-2 sm:gap-3">
                    {result.items.map(renderResultRow)}
                </div>
            </section>
        </div>
    ) : (
        <p className="text-sm text-zinc-400">{t('exam.quiz.empty')}</p>
    );

    const historyBody = (
        <div data-testid="exam-history" className="flex flex-col gap-4">
            {historyState.status === 'loading' || historyState.status === 'idle' ? (
                <div
                    data-testid="exam-history-loading"
                    className={`${CARD} flex items-center justify-center gap-3 p-8 text-sm text-zinc-400`}
                >
                    <Loader2 className="w-4 h-4 animate-spin text-blue-400" />
                    {t('exam.history.loading')}
                </div>
            ) : historyState.status === 'error' ? (
                <div data-testid="exam-history-error" className={`${CARD} p-5 sm:p-6`}>
                    <div className="flex items-start gap-3">
                        <AlertCircle className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                        <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-zinc-200">
                                {t('exam.history.error')}
                            </p>
                            <p className="mt-1 text-xs leading-relaxed text-zinc-500 break-words">
                                {historyState.error}
                            </p>
                        </div>
                    </div>
                    <button
                        type="button"
                        data-testid="exam-history-retry"
                        onClick={() => void loadHistory()}
                        className={`${SECONDARY_BUTTON} mt-4 w-full sm:w-auto`}
                    >
                        <RotateCcw className="w-4 h-4" />
                        {t('exam.history.retry')}
                    </button>
                </div>
            ) : historyState.sessions.length === 0 ? (
                <div data-testid="exam-history-empty" className={`${CARD} p-8 text-center`}>
                    <History className="mx-auto mb-3 h-10 w-10 text-zinc-700" />
                    <p className="text-sm font-medium text-zinc-400">{t('exam.history.empty')}</p>
                    <p className="mt-1 text-xs leading-relaxed text-zinc-600">
                        {t('exam.history.emptyHint')}
                    </p>
                </div>
            ) : (
                <div
                    data-testid="exam-history-list"
                    className="overflow-hidden rounded-2xl border border-white/5 bg-zinc-900/40 divide-y divide-white/5"
                >
                    {historyState.sessions.map((entry, rowIndex) => (
                        <div
                            key={entry.sessionId}
                            data-testid={`exam-history-row-${rowIndex}`}
                            className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="text-[11px] font-medium text-zinc-500 tabular-nums">
                                    {historyDate(entry)}
                                </p>
                                <p className="mt-0.5 text-sm font-medium text-zinc-200 break-words">
                                    {typeLabel(entry.examType, entry.label)}
                                </p>
                            </div>
                            <div className="flex flex-row items-center justify-between gap-3 sm:justify-end">
                                <div className="min-w-0 text-left sm:text-right">
                                    <p
                                        data-testid={`exam-history-score-${rowIndex}`}
                                        className="text-sm font-medium text-zinc-200 tabular-nums break-words"
                                    >
                                        {t('exam.history.answerLine', {
                                            correct: formatNumber(entry.correct),
                                            total: formatNumber(entry.total),
                                        })}
                                    </p>
                                    {entry.total > entry.answered && (
                                        <p className="mt-0.5 text-[11px] text-zinc-500 tabular-nums">
                                            {t('exam.history.unanswered', {
                                                count: formatNumber(entry.total - entry.answered),
                                            })}
                                        </p>
                                    )}
                                </div>
                                <button
                                    type="button"
                                    data-testid={`exam-history-restart-${rowIndex}`}
                                    onClick={() => void beginExam(entry.examType)}
                                    disabled={starting}
                                    className={`${SECONDARY_BUTTON} h-9 px-3 text-xs`}
                                >
                                    <RotateCcw className="w-3.5 h-3.5" />
                                    {t('exam.history.restart')}
                                </button>
                            </div>
                        </div>
                    ))}
                </div>
            )}
        </div>
    );

    const body =
        phase === 'types'
            ? typesBody
            : phase === 'quiz'
                ? quizBody
                : phase === 'result'
                    ? resultBody
                    : historyBody;

    // Desktop side rail (docs/设计-桌面布局规范.md §6): the phase's explanation,
    // rendered from the server copy verbatim. The three disclaimer test ids move
    // with it; on the mobile single column it stacks after the phase body.
    const railNote =
        phase === 'types'
            ? typesState.disclaimer || t('exam.home.disclaimer')
            : phase === 'result'
                ? result?.disclaimer || t('exam.home.disclaimer')
                : phase === 'history'
                    ? historyState.disclaimer || t('exam.home.disclaimer')
                    : t('exam.home.disclaimer');
    const rail = (
        <SideRail testId="exam-rail">
            <section
                data-testid={
                    phase === 'types'
                        ? 'exam-type-disclaimer'
                        : phase === 'result'
                            ? 'exam-result-disclaimer'
                            : 'exam-rail-note'
                }
                data-phase={phase}
                className="rounded-panel border border-line-subtle bg-surface/40 p-4 sm:p-5"
            >
                <p className="text-micro font-medium text-fg-muted">
                    {t('exam.types.disclaimerTitle')}
                </p>
                <p className="mt-1 text-xs leading-relaxed text-fg-secondary break-words">
                    {railNote}
                </p>
            </section>
        </SideRail>
    );

    return (
        <div
            data-testid="exam-screen"
            data-phase={phase}
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
        >
            <SubHeader
                title={headerTitle}
                onBack={handleClose}
                parentLabel={parentLabel}
                meta={t('exam.eyebrow')}
                backTestId="exam-back"
                titleTestId="exam-title"
                actions={!isGuest && phase !== 'quiz' && (
                    <button
                        type="button"
                        data-testid={phase === 'history' ? 'exam-history-back' : 'exam-history-button'}
                        onClick={
                            phase === 'history'
                                ? () => setPhase(result ? 'result' : 'types')
                                : openHistory
                        }
                        className="inline-flex h-9 items-center gap-1.5 rounded-control border border-white/5 bg-zinc-800/60 px-2.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 sm:px-3"
                    >
                        {phase === 'history' ? (
                            <ArrowLeft className="h-4 w-4" />
                        ) : (
                            <History className="h-4 w-4" />
                        )}
                        <span className="hidden sm:inline">
                            {phase === 'history' ? t('exam.history.back') : t('exam.history')}
                        </span>
                    </button>
                )}
            />

            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
            <PageContainer variant="standard" className="py-4 sm:py-8">
                <PageGrid testId="exam-grid" railTestId="exam-rail-slot" rail={rail}>
                    <div className="flex flex-col gap-4 sm:gap-6">
                <p className="text-xs leading-relaxed text-fg-muted break-words">
                    {headerSubtitle}
                </p>

                <motion.div
                    key={phase}
                    initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
                >
                    {body}
                </motion.div>
                    </div>
                </PageGrid>
            </PageContainer>
            </div>

            <Dialog
                open={confirm !== null}
                onClose={() => setConfirm(null)}
                title={
                    shownConfirm === 'submit'
                        ? unansweredCount > 0
                            ? t('exam.quiz.submitTitleUnanswered', {
                                count: formatNumber(unansweredCount),
                            })
                            : t('exam.quiz.submitTitle')
                        : shownConfirm === 'exit'
                            ? t('exam.quiz.exitTitle')
                            : undefined
                }
                description={
                    shownConfirm === 'submit'
                        ? t('exam.quiz.submitBody', { total: formatNumber(total) })
                        : shownConfirm === 'exit'
                            ? t('exam.quiz.exitBody')
                            : undefined
                }
                size="sm"
                loading={submitting}
                initialFocus='[data-testid="exam-confirm-cancel"]'
                testId={shownConfirm ? `exam-confirm-${shownConfirm}` : undefined}
                footer={
                    <>
                        <button
                            type="button"
                            data-testid="exam-confirm-cancel"
                            onClick={() => setConfirm(null)}
                            disabled={submitting}
                            className={`${SECONDARY_BUTTON} w-full sm:w-auto`}
                        >
                            {t('exam.quiz.keepGoing')}
                        </button>
                        <button
                            type="button"
                            data-testid="exam-confirm-ok"
                            onClick={confirmAction}
                            disabled={submitting}
                            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                        >
                            {submitting && <Loader2 className="h-4 w-4 animate-spin" />}
                            {shownConfirm === 'submit'
                                ? t('exam.quiz.submitConfirm')
                                : t('exam.quiz.exitConfirm')}
                        </button>
                    </>
                }
            >
                {shownConfirm === 'submit' && flaggedCount > 0 && (
                    <p
                        data-testid="exam-confirm-flagged"
                        className="text-xs leading-relaxed text-amber-300 break-words"
                    >
                        {t('exam.quiz.submitFlagged', {
                            count: formatNumber(flaggedCount),
                        })}
                    </p>
                )}
            </Dialog>
        </div>
    );
}
