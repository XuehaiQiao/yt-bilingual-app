import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
    AlertCircle,
    ArrowRight,
    CheckCircle2,
    Loader2,
    Play,
    X,
} from 'lucide-react';
import { answerQuestion, getResult, QuizApiError } from '../lib/quiz';
import type {
    LessonQuestions,
    QuizAnswer,
    QuizEvidence,
    QuizQuestion,
    QuizResult,
} from '../lib/quiz';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';

interface QuizScreenProps {
    /** Lesson + questions returned by `POST /api/lesson/start`. */
    lesson: LessonQuestions;
    /** Leave the quiz and go back to the video (keeps the loaded lesson). */
    onExit: () => void;
    /** Close the quiz and jump the player to an evidence timestamp (seconds). */
    onSeekEvidence: (start: number) => void;
    /** Result screen's "home" action. */
    onHome: () => void;
    onRequestLogin?: () => void;
}

const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-50 disabled:active:scale-100';
const OPTION_BASE =
    'w-full flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition-[background-color,border-color,color] duration-200 ease-apple disabled:cursor-default';

function formatClock(seconds: number): string {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const mm = Math.floor(safe / 60).toString().padStart(2, '0');
    const ss = (safe % 60).toString().padStart(2, '0');
    return `${mm}:${ss}`;
}

function optionLabel(index: number, option: string): string {
    return `${index + 1}. ${option}`;
}

function optionClass(index: number, selected: number | null, answer: QuizAnswer | null): string {
    if (!answer) {
        return selected === index
            ? `${OPTION_BASE} bg-blue-500/10 border-blue-500/40 text-zinc-50`
            : `${OPTION_BASE} bg-zinc-800/30 border-white/5 text-zinc-200 hover:bg-zinc-800/60 hover:border-white/10`;
    }
    if (index === answer.answerIndex) {
        return `${OPTION_BASE} bg-emerald-500/10 border-emerald-500/30 text-emerald-200`;
    }
    if (index === answer.chosenIndex) {
        return `${OPTION_BASE} bg-amber-500/10 border-amber-500/30 text-amber-200`;
    }
    return `${OPTION_BASE} bg-zinc-800/20 border-white/5 text-zinc-500 opacity-70`;
}

interface WrongRow {
    questionId: string;
    prompt: string;
    evidence: QuizEvidence;
    chosenIndex: number;
    answerIndex: number;
}

/**
 * One lesson's 3-question comprehension quiz (M3 / specs/014).
 *
 * Answers are scored by the backend, which also returns the subtitle evidence
 * timestamps. A wrong answer can hand that timestamp back to the app, which
 * closes this view and seeks the already-loaded player. The result screen uses
 * `GET /api/lesson/{id}/result` for the correct rate and the wrong-answer list,
 * falling back to the answers of this session if that request fails.
 */
export const QuizScreen: React.FC<QuizScreenProps> = ({
    lesson,
    onExit,
    onSeekEvidence,
    onHome,
    onRequestLogin,
}) => {
    const { t, formatNumber } = useI18n();
    const reduceMotion = useReducedMotion();

    const questions = useMemo(
        () => [...lesson.questions].sort((a, b) => a.ordinal - b.ordinal),
        [lesson.questions],
    );
    const total = questions.length;

    const [index, setIndex] = useState(0);
    const [selected, setSelected] = useState<number | null>(null);
    const [answer, setAnswer] = useState<QuizAnswer | null>(null);
    const [answers, setAnswers] = useState<Record<string, QuizAnswer>>({});
    const [submitting, setSubmitting] = useState(false);
    const [submitError, setSubmitError] = useState<string | null>(null);
    const [phase, setPhase] = useState<'question' | 'result'>('question');
    const [result, setResult] = useState<QuizResult | null>(null);
    const [resultLoading, setResultLoading] = useState(false);
    const [resultError, setResultError] = useState<string | null>(null);

    const startedAtRef = useRef(Date.now());
    // Guards a second submit from a key repeat before React disables the button.
    const busyRef = useRef(false);
    // Selection is mirrored in a ref because a fast "1 then Enter" must submit
    // the just-pressed option even before React re-renders the button state.
    const selectedRef = useRef<number | null>(null);

    const current: QuizQuestion | null = questions[index] ?? null;

    // New question: reset the per-question interactions and start its timer.
    useEffect(() => {
        startedAtRef.current = Date.now();
        selectedRef.current = null;
        setSelected(null);
        setAnswer(null);
        setSubmitError(null);
    }, [current?.id]);

    const chooseOption = useCallback((optionIndex: number) => {
        selectedRef.current = optionIndex;
        setSelected(optionIndex);
    }, []);

    const handleSubmit = useCallback(async () => {
        const choice = selectedRef.current;
        if (!current || choice == null || answer || busyRef.current) return;
        busyRef.current = true;
        setSubmitting(true);
        setSubmitError(null);
        try {
            const payload = await answerQuestion({
                questionId: current.id,
                chosenIndex: choice,
                elapsedMs: Date.now() - startedAtRef.current,
            });
            setAnswer(payload);
            setAnswers(prev => ({ ...prev, [current.id]: payload }));
        } catch (err) {
            if (err instanceof QuizApiError && err.status === 403) {
                setSubmitError(t('quiz.errors.login'));
                onRequestLogin?.();
            } else {
                setSubmitError(await describeApiError(err));
            }
        } finally {
            busyRef.current = false;
            setSubmitting(false);
        }
    }, [current, answer, t, onRequestLogin]);

    const handleNext = useCallback(async () => {
        if (!answer) return;
        if (index + 1 < total) {
            // Reset synchronously: a fast Enter → 1 → Enter must not let the
            // previous question's answer leak into the next one before the
            // effect (which also resets these) has run.
            startedAtRef.current = Date.now();
            selectedRef.current = null;
            setSelected(null);
            setAnswer(null);
            setSubmitError(null);
            setIndex(index + 1);
            return;
        }
        // A double click on "查看结果" must not fire two result requests.
        if (busyRef.current) return;
        busyRef.current = true;
        setResultLoading(true);
        setResultError(null);
        try {
            setResult(await getResult(lesson.lessonId));
        } catch (err) {
            setResult(null);
            setResultError(await describeApiError(err));
        } finally {
            busyRef.current = false;
            setResultLoading(false);
            setPhase('result');
        }
    }, [answer, index, total, lesson.lessonId]);

    // Keyboard: 1–4 choose, Enter submit/advance, Escape exits. Buttons keep
    // their native space activation; Enter is owned here so choosing an option
    // and submitting stays a two-key flow.
    useEffect(() => {
        if (phase !== 'question') return;
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.defaultPrevented) return;
            if (event.metaKey || event.ctrlKey || event.altKey) return;
            const target = event.target as HTMLElement | null;
            if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;

            if (event.key === 'Escape') {
                event.preventDefault();
                onExit();
                return;
            }
            if (answer) {
                if (event.key === 'Enter' && !resultLoading) {
                    event.preventDefault();
                    void handleNext();
                }
                return;
            }
            const optionIndex = ['1', '2', '3', '4'].indexOf(event.key);
            if (optionIndex >= 0 && current && optionIndex < current.options.length && !submitting) {
                event.preventDefault();
                chooseOption(optionIndex);
                return;
            }
            if (event.key === 'Enter') {
                event.preventDefault();
                void handleSubmit();
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [phase, answer, current, submitting, resultLoading, onExit, handleNext, handleSubmit, chooseOption]);

    const localAnswers = Object.values(answers);
    const localCorrect = localAnswers.filter(item => item.correct).length;
    // The result endpoint aggregates every attempt the lesson has ever had.
    // A repeated lesson must still show *this* attempt's score, so the server
    // numbers are used only when they describe exactly this session (first
    // run); otherwise the local answers are authoritative.
    const sessionAnswered = localAnswers.length;
    const useServerResult = result != null && result.answered === sessionAnswered;
    const resultCorrect = useServerResult ? result.correct : localCorrect;
    const resultTotal = useServerResult ? result.totalQuestions : total;
    const percent = Math.round(
        useServerResult
            ? result.correctRate * 100
            : sessionAnswered > 0
                ? (localCorrect / sessionAnswered) * 100
                : 0,
    );

    // Prefer the server's wrong list (it keeps the authoritative attempt ids),
    // deduped by question in case the lesson has been answered before. If the
    // result request failed, fall back to this session's local answers.
    const wrongRows = useMemo<WrongRow[]>(() => {
        if (result) {
            const seen = new Set<string>();
            const rows: WrongRow[] = [];
            for (const wrong of result.wrongQuestions ?? []) {
                // Ignore attempts from earlier runs of the same lesson: the
                // result screen describes one attempt, like the per-question list.
                const item = answers[wrong.questionId];
                if (!item || item.correct) continue;
                if (seen.has(wrong.questionId)) continue;
                seen.add(wrong.questionId);
                rows.push({
                    questionId: wrong.questionId,
                    prompt: wrong.prompt,
                    evidence: wrong.evidence,
                    chosenIndex: wrong.chosenIndex,
                    answerIndex: wrong.answerIndex,
                });
            }
            return rows;
        }
        return questions
            .filter(question => {
                const item = answers[question.id];
                return item != null && !item.correct;
            })
            .map(question => {
                const item = answers[question.id];
                return {
                    questionId: question.id,
                    prompt: question.prompt,
                    evidence: item.evidence,
                    chosenIndex: item.chosenIndex,
                    answerIndex: item.answerIndex,
                };
            });
    }, [result, questions, answers]);

    const handleEvidence = (evidence: QuizEvidence) => {
        if (evidence.start == null || !Number.isFinite(evidence.start)) return;
        onSeekEvidence(evidence.start);
    };

    const headerTitle = phase === 'result'
        ? t('quiz.result.title')
        : t('quiz.header', { current: Math.min(index + 1, total), total });

    const optionButtons = current ? (
        <div
            role="group"
            aria-label={t('quiz.optionsAria')}
            className="mt-5 space-y-2"
        >
            {current.options.map((option, optionIndex) => (
                <button
                    key={optionIndex}
                    type="button"
                    data-testid={`quiz-option-${optionIndex}`}
                    aria-pressed={selected === optionIndex}
                    disabled={answer != null || submitting}
                    onClick={() => {
                        if (answer || submitting) return;
                        chooseOption(optionIndex);
                    }}
                    className={optionClass(optionIndex, selected, answer)}
                >
                    <span
                        className={`w-6 h-6 shrink-0 rounded-md border text-[11px] font-semibold tabular-nums flex items-center justify-center ${
                            answer
                                ? 'border-white/10 bg-white/5 text-zinc-400'
                                : selected === optionIndex
                                    ? 'border-blue-400/40 bg-blue-500/15 text-blue-300'
                                    : 'border-white/10 bg-white/5 text-zinc-500'
                        }`}
                    >
                        {optionIndex + 1}
                    </span>
                    <span className="min-w-0 text-sm leading-relaxed break-words">{option}</span>
                </button>
            ))}
        </div>
    ) : null;

    const feedback = answer ? (
        <div
            data-testid="quiz-feedback"
            data-correct={answer.correct ? 'true' : 'false'}
            className={`mt-4 rounded-2xl border px-4 py-3 ${
                answer.correct
                    ? 'bg-emerald-500/5 border-emerald-500/20'
                    : 'bg-amber-500/5 border-amber-500/20'
            }`}
        >
            <div className="flex items-center gap-2">
                {answer.correct ? (
                    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                ) : (
                    <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
                )}
                <span
                    className={`text-sm font-medium ${
                        answer.correct ? 'text-emerald-300' : 'text-amber-300'
                    }`}
                >
                    {answer.correct ? t('quiz.feedback.correct') : t('quiz.feedback.wrong')}
                </span>
            </div>

            {!answer.correct && current && (
                <p className="mt-2 text-sm text-zinc-300 leading-relaxed break-words">
                    {t('quiz.feedback.answer', {
                        answer: optionLabel(answer.answerIndex, current.options[answer.answerIndex] ?? ''),
                    })}
                </p>
            )}

            {answer.explanation && (
                <div className="mt-3 pt-3 border-t border-white/5">
                    <p className="text-[11px] font-medium text-zinc-500 mb-1">
                        {t('quiz.explanation')}
                    </p>
                    <p
                        data-testid="quiz-explanation"
                        className="text-sm text-zinc-300 leading-relaxed break-words"
                    >
                        {answer.explanation}
                    </p>
                </div>
            )}

            {!answer.correct && answer.evidence.start != null && (
                <button
                    type="button"
                    data-testid="quiz-evidence"
                    onClick={() => handleEvidence(answer.evidence)}
                    title={t('quiz.evidenceHint')}
                    className="mt-3 inline-flex items-center gap-2 h-9 px-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-sm font-medium text-blue-300 transition-colors"
                >
                    <Play className="w-3.5 h-3.5" />
                    <span>{t('quiz.evidence')}</span>
                    <span className="text-[11px] font-medium tabular-nums text-blue-400/70">
                        {formatClock(answer.evidence.start)}
                    </span>
                </button>
            )}
        </div>
    ) : null;

    const questionBody = current ? (
        <>
            <div className="flex items-center justify-between gap-3">
                <div
                    role="progressbar"
                    aria-label={t('quiz.progressAria')}
                    aria-valuemin={1}
                    aria-valuemax={total}
                    aria-valuenow={index + 1}
                    className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden"
                >
                    <div
                        className="h-full bg-brand rounded-full transition-[width] duration-300 ease-apple"
                        style={{ width: `${Math.round(((index + 1) / total) * 100)}%` }}
                    />
                </div>
                <span className="text-[11px] font-medium text-zinc-500 tabular-nums shrink-0">
                    {formatNumber(index + 1)} / {formatNumber(total)}
                </span>
            </div>

            <motion.section
                key={current.id}
                data-testid="quiz-question"
                initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
                className="glass-card rounded-3xl p-5 sm:p-8"
            >
                <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                    {t(current.questionType === 'mcq' ? 'quiz.type.mcq' : 'quiz.type.tf')}
                </span>
                <h2
                    data-testid="quiz-prompt"
                    className="mt-3 text-lg sm:text-xl font-medium leading-relaxed text-zinc-50 break-words"
                >
                    {current.prompt}
                </h2>

                {optionButtons}

                {feedback}

                {submitError && (
                    <p data-testid="quiz-submit-error" className="mt-3 text-xs text-amber-400 break-words">
                        {submitError}
                    </p>
                )}

                <div className="mt-5 flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3">
                    {!answer ? (
                        <button
                            type="button"
                            data-testid="quiz-submit"
                            onClick={() => void handleSubmit()}
                            disabled={selected == null || submitting}
                            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                        >
                            {submitting && <Loader2 className="w-4 h-4 animate-spin" />}
                            {submitting ? t('quiz.submitting') : t('quiz.submit')}
                        </button>
                    ) : (
                        <button
                            type="button"
                            data-testid="quiz-next"
                            onClick={() => void handleNext()}
                            disabled={resultLoading}
                            className={`${PRIMARY_BUTTON} w-full sm:w-auto`}
                        >
                            {resultLoading && <Loader2 className="w-4 h-4 animate-spin" />}
                            <span>{index + 1 >= total ? t('quiz.finish') : t('quiz.next')}</span>
                            {!resultLoading && <ArrowRight className="w-4 h-4" />}
                        </button>
                    )}
                </div>

                <p className="hidden sm:block mt-3 text-[11px] text-zinc-600">
                    {answer ? t('quiz.keyHintAnswered') : t('quiz.keyHint')}
                </p>
            </motion.section>
        </>
    ) : null;

    const perQuestionRows = questions.map((question, rowIndex) => {
        const item = answers[question.id];
        const status = item ? (item.correct ? 'correct' : 'wrong') : 'unanswered';
        return (
            <div
                key={question.id}
                data-testid={`quiz-result-row-${rowIndex}`}
                data-status={status}
                className="flex items-start gap-3 px-4 py-3"
            >
                <span className="w-6 h-6 shrink-0 rounded-md bg-white/5 border border-white/10 text-[11px] font-medium text-zinc-400 tabular-nums flex items-center justify-center">
                    {rowIndex + 1}
                </span>
                <p className="flex-1 min-w-0 text-sm text-zinc-300 leading-relaxed break-words">
                    {question.prompt}
                </p>
                <span
                    className={`shrink-0 inline-flex items-center gap-1 text-[11px] font-medium ${
                        status === 'correct'
                            ? 'text-emerald-400'
                            : status === 'wrong'
                                ? 'text-amber-400'
                                : 'text-zinc-600'
                    }`}
                >
                    {status === 'correct' && <CheckCircle2 className="w-3.5 h-3.5" />}
                    {status === 'wrong' && <AlertCircle className="w-3.5 h-3.5" />}
                    {status === 'correct'
                        ? t('quiz.result.correct')
                        : status === 'wrong'
                            ? t('quiz.result.wrong')
                            : t('quiz.result.unanswered')}
                </span>
            </div>
        );
    });

    const resultBody = (
        <div data-testid="quiz-result" className="flex flex-col gap-4 sm:gap-6">
            <section className="glass-card rounded-3xl p-5 sm:p-8 text-center">
                <p className="text-xs text-zinc-500">{t('quiz.result.correctRate')}</p>
                <div
                    data-testid="quiz-result-rate"
                    className="mt-1 text-5xl font-semibold tracking-tight text-zinc-50 tabular-nums"
                >
                    {formatNumber(percent)}%
                </div>
                <p data-testid="quiz-result-score" className="mt-2 text-sm text-zinc-400">
                    {t('quiz.result.score', { correct: formatNumber(resultCorrect), total: formatNumber(resultTotal) })}
                </p>
                <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                    <button
                        type="button"
                        data-testid="quiz-result-home"
                        onClick={onHome}
                        className={PRIMARY_BUTTON}
                    >
                        {t('quiz.result.home')}
                    </button>
                </div>
                {resultError && (
                    <p data-testid="quiz-result-error" className="mt-3 text-xs text-zinc-500 break-words">
                        {t('quiz.errors.result')}
                    </p>
                )}
            </section>

            <section>
                <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 mb-2">
                    {t('quiz.result.perQuestion')}
                </h2>
                <div className="rounded-2xl bg-zinc-900/40 border border-white/5 divide-y divide-white/5 overflow-hidden">
                    {perQuestionRows}
                </div>
            </section>

            <section data-testid="quiz-wrong-list">
                <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 mb-2">
                    {t('quiz.result.wrongList')}
                </h2>
                {wrongRows.length === 0 ? (
                    <p
                        data-testid="quiz-wrong-empty"
                        className="rounded-2xl bg-zinc-900/40 border border-white/5 px-4 py-4 text-sm text-zinc-400"
                    >
                        {t('quiz.result.wrongEmpty')}
                    </p>
                ) : (
                    <div className="space-y-2">
                        {wrongRows.map((row, rowIndex) => {
                            const start = row.evidence.start;
                            const question = questions.find(item => item.id === row.questionId);
                            return (
                                <div
                                    key={row.questionId}
                                    data-testid={`quiz-wrong-row-${rowIndex}`}
                                    className="rounded-2xl bg-zinc-900/40 border border-white/5 p-4 flex flex-col sm:flex-row sm:items-center gap-3"
                                >
                                    <p className="flex-1 min-w-0 text-sm text-zinc-300 leading-relaxed break-words">
                                        {row.prompt}
                                    </p>
                                    {question && (
                                        <p className="text-[11px] text-zinc-500 break-words sm:max-w-[40%]">
                                            {t('quiz.result.yourAnswer', {
                                                answer: optionLabel(row.chosenIndex, question.options[row.chosenIndex] ?? ''),
                                            })}
                                        </p>
                                    )}
                                    {start != null && (
                                        <button
                                            type="button"
                                            data-testid={`quiz-wrong-evidence-${rowIndex}`}
                                            onClick={() => handleEvidence(row.evidence)}
                                            title={t('quiz.evidenceHint')}
                                            className="inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-lg shrink-0 bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-xs font-medium text-blue-300 transition-colors"
                                        >
                                            <Play className="w-3.5 h-3.5" />
                                            <span>{t('quiz.result.review')}</span>
                                            <span className="tabular-nums text-blue-400/70">
                                                {formatClock(start)}
                                            </span>
                                        </button>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                )}
            </section>
        </div>
    );

    return (
        <div
            data-testid="quiz-screen"
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b]"
        >
            <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                <header className="flex items-center justify-between gap-3">
                    <div className="min-w-0">
                        <h1
                            data-testid="quiz-header"
                            className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-100 tabular-nums truncate"
                        >
                            {headerTitle}
                        </h1>
                        {phase === 'result' && (
                            <p className="mt-0.5 text-xs text-zinc-500">
                                {t('quiz.result.subtitle')}
                            </p>
                        )}
                    </div>
                    <button
                        type="button"
                        data-testid="quiz-exit"
                        onClick={onExit}
                        aria-label={t('quiz.exitAria')}
                        title={t('quiz.exitAria')}
                        className="p-2 rounded-full bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-400 hover:text-zinc-100 transition-colors shrink-0"
                    >
                        <X className="w-5 h-5" />
                    </button>
                </header>

                <AnimatePresence mode="wait" initial={false}>
                    {phase === 'result' ? (
                        <motion.div
                            key="result"
                            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={reduceMotion ? undefined : { opacity: 0 }}
                            transition={{ duration: 0.2 }}
                        >
                            {resultBody}
                        </motion.div>
                    ) : (
                        <motion.div
                            key="question"
                            initial={reduceMotion ? false : { opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={reduceMotion ? undefined : { opacity: 0 }}
                            transition={{ duration: 0.2 }}
                            className="flex flex-col gap-4 sm:gap-6"
                        >
                            {questionBody}
                        </motion.div>
                    )}
                </AnimatePresence>
            </div>
        </div>
    );
};
