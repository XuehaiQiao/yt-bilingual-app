import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import {
    BookOpen,
    CalendarOff,
    CheckCircle2,
    Loader2,
    MoreHorizontal,
    Repeat,
    RotateCcw,
    ShieldAlert,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { loadModel } from '../lib/settings';
import { describeApiError, toast } from '../lib/toast';
import { SubHeader } from './ui/SubHeader';
import { Menu } from './ui/Menu';
import { Dialog } from './ui/Dialog';
import {
    answerWord,
    getReviewQueue,
    getReviewStats,
    getSuspendedWords,
    restoreWord,
    ReviewApiError,
    suspendWord,
    type ReviewQueue,
    type ReviewRating,
    type ReviewStats,
    type ReviewWord,
} from '../lib/review';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';

interface ReviewScreenProps {
    /** Return to the home screen (specs/013: review is a view, not a page). */
    onClose: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Guest 403 path: open the auth screen instead of dead-ending. */
    onRequestLogin?: () => void;
}

/** `/api/define` shape (target-language text lives in `zh`, legacy field name). */
interface ReviewDefinition {
    word?: string;
    lemma?: string;
    ipa?: string;
    pos?: string;
    pos_label?: string;
    zh?: string;
    definition_en?: string;
    example?: string;
    example_translation?: string;
}

interface SessionCounts {
    answered: number;
    again: number;
    hard: number;
    good: number;
    easy: number;
    suspended: number;
}

const EMPTY_SESSION: SessionCounts = {
    answered: 0,
    again: 0,
    hard: 0,
    good: 0,
    easy: 0,
    suspended: 0,
};

const RATING_META: ReadonlyArray<{
    value: ReviewRating;
    label: TranslationKey;
    /** Standard SRS name kept visible next to the localized label. */
    term: string;
    tone: string;
    text: string;
}> = [
    {
        value: 'again',
        label: 'review.rating.again',
        term: 'Again',
        tone: 'bg-red-500/10 hover:bg-red-500/15 border-red-500/20 text-red-400',
        text: 'text-red-400',
    },
    {
        value: 'hard',
        label: 'review.rating.hard',
        term: 'Hard',
        tone: 'bg-amber-500/10 hover:bg-amber-500/15 border-amber-500/20 text-amber-400',
        text: 'text-amber-400',
    },
    {
        value: 'good',
        label: 'review.rating.good',
        term: 'Good',
        tone: 'bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20 text-blue-400',
        text: 'text-blue-400',
    },
    {
        value: 'easy',
        label: 'review.rating.easy',
        term: 'Easy',
        tone: 'bg-emerald-500/10 hover:bg-emerald-500/15 border-emerald-500/20 text-emerald-400',
        text: 'text-emerald-400',
    },
];

const PRIMARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-11 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200 ease-apple disabled:opacity-50';
const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-2 h-10 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors';

type Phase = 'loading' | 'error' | 'review' | 'empty' | 'done';

interface LoadError {
    status: number | null;
    message: string;
}

function StatCard({ label, value, testId }: { label: string; value: string; testId: string }) {
    return (
        <div
            data-testid={testId}
            className="rounded-xl bg-zinc-800/30 border border-white/5 px-2 sm:px-3 py-2 min-w-0"
        >
            <div className="text-base sm:text-lg font-semibold tabular-nums text-zinc-100 truncate">{value}</div>
            <div className="text-[10px] sm:text-[11px] text-zinc-500 mt-0.5 truncate">{label}</div>
        </div>
    );
}

/**
 * 生词复习 screen (M2 / specs/013).
 *
 * The backend is the only scheduler: this component fetches one deck, shows
 * one card at a time, posts a grade, and lets the server decide the next due
 * date. It never ranks words and never marks a wrong answer with a red cross —
 * a review is practice, not an exam.
 */
export const ReviewScreen: React.FC<ReviewScreenProps> = ({ onClose, parentLabel, onRequestLogin }) => {
    const { t, formatNumber } = useI18n();
    const reduceMotion = useReducedMotion();

    const [phase, setPhase] = useState<Phase>('loading');
    const [queue, setQueue] = useState<ReviewQueue | null>(null);
    const [stats, setStats] = useState<ReviewStats | null>(null);
    const [index, setIndex] = useState(0);
    const [revealed, setRevealed] = useState(false);
    const [loadError, setLoadError] = useState<LoadError | null>(null);

    const [definition, setDefinition] = useState<ReviewDefinition | null>(null);
    const [defineState, setDefineState] = useState<'idle' | 'loading' | 'error'>('idle');
    const [defineError, setDefineError] = useState<string | null>(null);
    const [answerError, setAnswerError] = useState<string | null>(null);

    const [submitting, setSubmitting] = useState<ReviewRating | null>(null);
    const [suspendBusy, setSuspendBusy] = useState(false);
    const [menuOpen, setMenuOpen] = useState(false);
    const [session, setSession] = useState<SessionCounts>(EMPTY_SESSION);

    // Restore-paused-words dialog: opened from the empty/done view only.
    const [suspendedOpen, setSuspendedOpen] = useState(false);
    const [suspendedList, setSuspendedList] = useState<ReviewWord[]>([]);
    const [suspendedLoading, setSuspendedLoading] = useState(false);
    const [suspendedError, setSuspendedError] = useState<string | null>(null);
    const [restoringId, setRestoringId] = useState<string | null>(null);
    const restoringRef = useRef(false);

    // Definition requests can outlive the card that started them; the token
    // makes the late response drop instead of painting the wrong word.
    const defineTokenRef = useRef(0);
    const startedAtRef = useRef(Date.now());
    // Guards against a second answer/suspend firing before React re-renders
    // the disabled buttons (e.g. two quick key presses).
    const busyRef = useRef(false);

    const current: ReviewWord | null = queue?.items[index] ?? null;

    const loadDeck = useCallback(async () => {
        setPhase('loading');
        setLoadError(null);
        setQueue(null);
        setStats(null);
        setIndex(0);
        setRevealed(false);
        setDefinition(null);
        setDefineState('idle');
        setDefineError(null);
        setAnswerError(null);
        setMenuOpen(false);
        setSession(EMPTY_SESSION);
        setSuspendedOpen(false);
        setSuspendedList([]);
        setSuspendedError(null);

        try {
            const nextQueue = await getReviewQueue();
            setQueue(nextQueue);
            // Stats are decorative here: a failed fetch must not hide the deck.
            try {
                setStats(await getReviewStats());
            } catch {
                // Header falls back to dashes; the deck stays usable.
            }
            startedAtRef.current = Date.now();
            setPhase(nextQueue.items.length === 0 ? 'empty' : 'review');
        } catch (err) {
            setLoadError({
                status: err instanceof ReviewApiError ? err.status : null,
                message: await describeApiError(err),
            });
            setPhase('error');
        }
    }, []);

    useEffect(() => {
        void loadDeck();
    }, [loadDeck]);

    // New card: reset the per-card interactions and start its timer. The
    // token bump also invalidates a definition request from the old card.
    useEffect(() => {
        defineTokenRef.current += 1;
        setRevealed(false);
        setDefinition(null);
        setDefineState('idle');
        setDefineError(null);
        setAnswerError(null);
        setMenuOpen(false);
        startedAtRef.current = Date.now();
    }, [current?.id]);

    const loadDefinition = useCallback(async (lemma: string) => {
        const token = ++defineTokenRef.current;
        setDefineState('loading');
        setDefineError(null);
        try {
            const response = await apiFetch('/api/define', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ word: lemma, model: loadModel() || undefined }),
            });
            if (!response.ok) throw new Error(await describeApiError(response));
            const data = (await response.json()) as ReviewDefinition;
            if (defineTokenRef.current !== token) return;
            setDefinition(data);
            setDefineState('idle');
        } catch (err) {
            if (defineTokenRef.current !== token) return;
            setDefineError(await describeApiError(err));
            setDefineState('error');
        }
    }, []);

    const handleReveal = useCallback(() => {
        if (!current || revealed) return;
        setRevealed(true);
        if (defineState !== 'loading') void loadDefinition(current.lemma);
    }, [current, revealed, defineState, loadDefinition]);

    const finishDeck = useCallback(async () => {
        setPhase('done');
        setRevealed(false);
        try {
            setStats(await getReviewStats());
        } catch {
            // Keep the locally updated header counters.
        }
    }, []);

    const advance = useCallback(() => {
        setRevealed(false);
        if (!queue) return;
        if (index + 1 >= queue.items.length) {
            void finishDeck();
        } else {
            setIndex(index + 1);
        }
    }, [queue, index, finishDeck]);

    const handleRate = useCallback(async (rating: ReviewRating) => {
        if (!current || !revealed || submitting || busyRef.current) return;
        busyRef.current = true;
        setSubmitting(rating);
        setAnswerError(null);
        try {
            const result = await answerWord({
                lemma: current.lemma,
                rating,
                elapsedMs: Date.now() - startedAtRef.current,
            });
            setSession(prev => {
                const next = { ...prev, answered: prev.answered + 1 };
                next[rating] += 1;
                return next;
            });
            // The server log count is authoritative, but one local increment
            // keeps the header honest while the deck is still open.
            setStats(prev => prev ? { ...prev, reviewedToday: prev.reviewedToday + 1 } : prev);
            if (result.autoSuspended) {
                toast.info(t('review.autoSuspended', { word: current.lemma }));
            }
            advance();
        } catch (err) {
            setAnswerError(await describeApiError(err));
        } finally {
            busyRef.current = false;
            setSubmitting(null);
        }
    }, [current, revealed, submitting, advance, t]);

    const handleSuspend = async () => {
        if (!current || suspendBusy || busyRef.current) return;
        busyRef.current = true;
        setSuspendBusy(true);
        setMenuOpen(false);
        setAnswerError(null);
        try {
            await suspendWord(current.lemma);
            setSession(prev => ({ ...prev, suspended: prev.suspended + 1 }));
            toast.success(t('review.suspend.success', { word: current.lemma }));
            advance();
        } catch (err) {
            setAnswerError(await describeApiError(err));
        } finally {
            busyRef.current = false;
            setSuspendBusy(false);
        }
    };

    // Restore dialog: fetch the paused deck when it opens. The list endpoint is
    // intentionally not language-scoped — each row carries its own targetLang.
    const openSuspended = useCallback(async () => {
        setSuspendedOpen(true);
        setSuspendedLoading(true);
        setSuspendedError(null);
        try {
            const data = await getSuspendedWords();
            setSuspendedList(data.words);
        } catch (err) {
            setSuspendedList([]);
            setSuspendedError(await describeApiError(err));
        } finally {
            setSuspendedLoading(false);
        }
    }, []);

    const handleRestore = useCallback(async (word: ReviewWord) => {
        if (restoringRef.current) return;
        restoringRef.current = true;
        setRestoringId(word.id);
        setSuspendedError(null);
        try {
            await restoreWord(word.lemma, word.targetLang);
            setSuspendedList(prev => prev.filter(item => item.id !== word.id));
            // Keep the header count honest without refetching stats.
            setStats(prev => prev
                ? { ...prev, suspendedWords: Math.max(0, prev.suspendedWords - 1) }
                : prev);
            toast.success(t('review.suspended.restoreSuccess', { word: word.lemma }));
        } catch (err) {
            setSuspendedError(await describeApiError(err));
        } finally {
            restoringRef.current = false;
            setRestoringId(null);
        }
    }, [t]);

    // Keyboard: Space reveals, 1–4 grade. Escape closes the menu or the view.
    // Focused buttons/inputs keep their native key handling.
    useEffect(() => {
        if (phase !== 'review') return;
        const onKeyDown = (event: KeyboardEvent) => {
            const target = event.target as HTMLElement | null;
            const inField = !!target?.closest('input, textarea, select, [contenteditable="true"]');

            if (event.key === 'Escape') {
                if (menuOpen) {
                    setMenuOpen(false);
                } else if (!inField) {
                    onClose();
                }
                return;
            }
            // The open menu owns arrows/Enter/Space/Tab; do not grade or
            // reveal the card behind it.
            if (menuOpen) return;
            if (inField || event.metaKey || event.ctrlKey || event.altKey) return;

            if (event.code === 'Space' || event.key === ' ') {
                if (revealed) return;
                if (target?.closest('button, a')) return; // let the button activate itself
                event.preventDefault();
                handleReveal();
                return;
            }

            const ratingIndex = ['1', '2', '3', '4'].indexOf(event.key);
            if (ratingIndex >= 0 && revealed && !submitting) {
                event.preventDefault();
                void handleRate(RATING_META[ratingIndex].value);
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [phase, revealed, submitting, menuOpen, onClose, handleReveal, handleRate]);

    const header = (
        <SubHeader
            title={t('review.title')}
            onBack={onClose}
            parentLabel={parentLabel}
            backTestId="review-back"
        />
    );

    const statsRow = (
        <div className="grid grid-cols-4 gap-1.5 sm:gap-2" data-testid="review-stats">
            <StatCard
                testId="review-stat-due"
                label={t('review.stats.dueToday')}
                value={stats ? formatNumber(stats.dueToday) : '—'}
            />
            <StatCard
                testId="review-stat-new"
                label={t('review.stats.newWords')}
                value={stats ? formatNumber(stats.newWords) : '—'}
            />
            <StatCard
                testId="review-stat-reviewed"
                label={t('review.stats.reviewed')}
                value={stats ? formatNumber(stats.reviewedToday) : '—'}
            />
            <StatCard
                testId="review-stat-streak"
                label={t('review.stats.streak')}
                value={stats ? formatNumber(stats.streakDays) : '—'}
            />
        </div>
    );

    const progress = phase === 'review' && queue && current ? (
        <div className="flex items-center gap-3">
            <div
                className="flex-1 h-1.5 rounded-full bg-zinc-800 overflow-hidden"
                role="progressbar"
                aria-valuemin={1}
                aria-valuemax={queue.items.length}
                aria-valuenow={index + 1}
                aria-label={t('review.progressAria')}
            >
                <div
                    className="h-full bg-brand rounded-full transition-[width] duration-300 ease-apple"
                    style={{ width: `${Math.round((index / queue.items.length) * 100)}%` }}
                />
            </div>
            <span
                data-testid="review-progress"
                className="text-xs text-zinc-500 tabular-nums shrink-0"
            >
                {t('review.progress', { current: index + 1, total: queue.items.length })}
            </span>
        </div>
    ) : null;

    const definitionBody = (
        <div
            data-testid="review-definition"
            className="rounded-2xl bg-zinc-900/40 border border-white/5 p-4 sm:p-5 min-h-[88px]"
        >
            {defineState === 'loading' && (
                <div className="flex items-center gap-2 text-sm text-zinc-400">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    {t('review.define.loading')}
                </div>
            )}
            {defineState === 'error' && (
                <div className="space-y-2">
                    <p className="text-sm text-zinc-300">{t('review.define.error')}</p>
                    {defineError && <p className="text-xs text-zinc-500 break-words">{defineError}</p>}
                    <button
                        type="button"
                        onClick={() => current && void loadDefinition(current.lemma)}
                        className="inline-flex items-center h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 transition-colors"
                    >
                        {t('common.retry')}
                    </button>
                </div>
            )}
            {defineState === 'idle' && definition && (
                <>
                    {(definition.pos_label || definition.pos) && (
                        <span className="inline-block text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                            {definition.pos_label || definition.pos}
                        </span>
                    )}
                    <p
                        data-testid="review-definition-zh"
                        className="mt-2 text-lg sm:text-xl leading-relaxed text-zinc-100 break-words"
                    >
                        {definition.zh || t('review.define.empty')}
                    </p>
                    {definition.definition_en && (
                        <p className="mt-2 text-sm text-zinc-500 leading-relaxed break-words">
                            {definition.definition_en}
                        </p>
                    )}
                    {definition.example && (
                        <div className="mt-3 pt-3 border-t border-white/5">
                            <p className="text-[11px] text-zinc-500 mb-1">{t('review.define.example')}</p>
                            <p className="text-sm text-zinc-300 leading-relaxed break-words">{definition.example}</p>
                            {definition.example_translation && (
                                <p className="mt-1 text-xs text-zinc-500 leading-relaxed break-words">
                                    {definition.example_translation}
                                </p>
                            )}
                        </div>
                    )}
                </>
            )}
            {defineState === 'idle' && !definition && (
                <p className="text-sm text-zinc-500">{t('review.define.empty')}</p>
            )}
        </div>
    );

    const ratingButtons = (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3">
            {RATING_META.map((meta, metaIndex) => (
                <button
                    key={meta.value}
                    type="button"
                    data-testid={`review-rating-${meta.value}`}
                    onClick={() => void handleRate(meta.value)}
                    disabled={submitting !== null}
                    aria-label={`${t(meta.label)} (${metaIndex + 1})`}
                    title={`${t(meta.label)} · ${metaIndex + 1}`}
                    className={`flex flex-col items-center justify-center gap-0.5 h-16 rounded-xl border text-sm font-medium transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.98] disabled:opacity-60 ${meta.tone}`}
                >
                    <span className="flex items-center gap-1.5">
                        {submitting === meta.value && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                        <span>{t(meta.label)}</span>
                    </span>
                    <span className="text-[10px] opacity-60 tabular-nums">
                        {meta.term} · {metaIndex + 1}
                    </span>
                </button>
            ))}
        </div>
    );

    const renderBody = () => {
        if (phase === 'loading') {
            return (
                <div className="flex flex-col items-center justify-center py-20 text-zinc-500" data-testid="review-loading">
                    <Loader2 className="w-6 h-6 animate-spin mb-3" />
                    <p className="text-sm">{t('review.loading')}</p>
                </div>
            );
        }

        if (phase === 'error') {
            return (
                <div className="flex flex-col items-center justify-center py-16 text-center" data-testid="review-error">
                    <ShieldAlert className="w-10 h-10 text-zinc-700 mb-3" />
                    <h2 className="text-sm font-medium text-zinc-400">{t('review.error.title')}</h2>
                    <p className="mt-2 max-w-md text-xs text-zinc-500 leading-relaxed break-words">
                        {loadError?.status === 403 ? t('review.error.loginRequired') : loadError?.message}
                    </p>
                    <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
                        {loadError?.status === 403 && onRequestLogin && (
                            <button type="button" onClick={onRequestLogin} className={PRIMARY_BUTTON}>
                                {t('review.loginAction')}
                            </button>
                        )}
                        <button
                            type="button"
                            data-testid="review-retry"
                            onClick={() => void loadDeck()}
                            className={SECONDARY_BUTTON}
                        >
                            {t('common.retry')}
                        </button>
                        <button type="button" onClick={onClose} className={SECONDARY_BUTTON}>
                            {t('review.backHome')}
                        </button>
                    </div>
                </div>
            );
        }

        if (phase === 'empty' || phase === 'done') {
            const completed = phase === 'done' || (stats?.reviewedToday ?? 0) > 0;
            const remainingToday = stats?.dueToday ?? 0;
            return (
                <div
                    className="flex flex-col items-center justify-center py-12 text-center"
                    data-testid={phase === 'done' ? 'review-done' : 'review-empty'}
                >
                    <div className="w-14 h-14 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mb-4">
                        {completed
                            ? <CheckCircle2 className="w-7 h-7 text-emerald-400" />
                            : <Repeat className="w-7 h-7 text-zinc-500" />}
                    </div>
                    <h2 className="text-2xl font-semibold tracking-tight text-zinc-100">
                        {completed ? t('review.empty.titleDone') : t('review.empty.titleNone')}
                    </h2>

                    {stats !== null && stats.suspendedWords > 0 && (
                        <button
                            type="button"
                            data-testid="review-suspended-open"
                            onClick={() => void openSuspended()}
                            className="mt-3 inline-flex items-center gap-1.5 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                        >
                            <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />
                            {t('review.suspended.open', { count: stats.suspendedWords })}
                        </button>
                    )}

                    {phase === 'done' ? (
                        <>
                            <p className="mt-1 text-sm text-zinc-400">
                                {t('review.done.answered', { count: session.answered })}
                            </p>
                            {session.suspended > 0 && (
                                <p className="mt-1 text-xs text-zinc-500">
                                    {t('review.done.suspended', { count: session.suspended })}
                                </p>
                            )}
                            <div className="grid grid-cols-4 gap-2 w-full max-w-md mt-6">
                                {RATING_META.map(meta => (
                                    <div
                                        key={meta.value}
                                        className="rounded-xl bg-zinc-900/60 border border-white/5 px-2 py-3"
                                    >
                                        <div className={`text-lg font-semibold tabular-nums ${meta.text}`}>
                                            {formatNumber(session[meta.value])}
                                        </div>
                                        <div className="text-[11px] text-zinc-500 mt-0.5">{t(meta.label)}</div>
                                    </div>
                                ))}
                            </div>
                            {stats && (
                                <p className="mt-5 text-xs text-zinc-500">
                                    {t('review.done.today', {
                                        count: stats.reviewedToday,
                                        days: stats.streakDays,
                                    })}
                                </p>
                            )}
                            <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
                                <button type="button" onClick={onClose} className={PRIMARY_BUTTON} data-testid="review-done-home">
                                    {t('review.backHome')}
                                </button>
                                <button
                                    type="button"
                                    onClick={() => void loadDeck()}
                                    className={SECONDARY_BUTTON}
                                    data-testid="review-done-restart"
                                >
                                    {t('review.done.restart')}
                                </button>
                            </div>
                        </>
                    ) : (
                        <>
                            <p className="mt-2 max-w-md text-sm text-zinc-400 leading-relaxed">
                                {completed ? t('review.empty.hintDone') : t('review.empty.hintNone')}
                            </p>
                            {remainingToday > 0 && (
                                <p className="mt-1 text-xs text-zinc-500">
                                    {t('review.empty.pending', { count: remainingToday })}
                                </p>
                            )}
                            <button
                                type="button"
                                onClick={onClose}
                                className={`${PRIMARY_BUTTON} mt-6`}
                                data-testid="review-empty-home"
                            >
                                {t('review.backHome')}
                            </button>
                        </>
                    )}
                </div>
            );
        }

        if (!current || !queue) return null;

        return (
            <>
                {progress}
                <motion.div
                    key={current.id}
                    data-testid="review-card"
                    initial={reduceMotion ? false : { opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.25, ease: [0.25, 1, 0.5, 1] }}
                    className="glass-card rounded-3xl p-5 sm:p-8 relative"
                >
                    <div className="flex items-start justify-between gap-3 min-h-[2rem]">
                        {current.state === 'new' ? (
                            <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                                {t('review.state.new')}
                            </span>
                        ) : (
                            <span />
                        )}
                        <Menu
                            ariaLabel={t('review.menu')}
                            open={menuOpen}
                            onOpenChange={setMenuOpen}
                            popupClassName="w-60"
                            items={[
                                {
                                    id: 'suspend',
                                    label: t('review.menu.suspend'),
                                    description: t('review.menu.suspendHint'),
                                    icon: <CalendarOff />,
                                    disabled: suspendBusy,
                                    testId: 'review-suspend',
                                    onSelect: () => {
                                        void handleSuspend();
                                    },
                                },
                            ]}
                            trigger={({ triggerRef, triggerProps }) => (
                                <button
                                    ref={triggerRef}
                                    {...triggerProps}
                                    type="button"
                                    data-testid="review-suspend-menu"
                                    aria-label={t('review.menu')}
                                    title={t('review.menu')}
                                    className="p-1.5 rounded-lg text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors"
                                >
                                    <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
                                </button>
                            )}
                        />
                    </div>

                    <div className="text-center pt-1 pb-3">
                        <h2
                            data-testid="review-word"
                            className="text-4xl sm:text-5xl font-semibold tracking-tight text-zinc-50 break-words"
                        >
                            {current.lemma}
                        </h2>
                        <p
                            data-testid="review-ipa"
                            className="mt-2 text-sm text-zinc-500 tabular-nums min-h-[1.25rem] break-words"
                        >
                            {definition?.ipa || t('review.ipaPending')}
                        </p>
                    </div>

                    <AnimatePresence mode="wait" initial={false}>
                        {!revealed ? (
                            <motion.div
                                key="prompt"
                                initial={reduceMotion ? false : { opacity: 0 }}
                                animate={{ opacity: 1 }}
                                exit={reduceMotion ? undefined : { opacity: 0 }}
                                transition={{ duration: 0.18 }}
                                className="flex flex-col items-center gap-3 pt-2"
                            >
                                <button
                                    type="button"
                                    data-testid="review-reveal"
                                    onClick={handleReveal}
                                    className={PRIMARY_BUTTON}
                                >
                                    <BookOpen className="w-4 h-4" />
                                    {t('review.reveal')}
                                </button>
                                <p className="hidden sm:block text-xs text-zinc-600">
                                    {t('review.keyHint')}
                                </p>
                            </motion.div>
                        ) : (
                            <motion.div
                                key="answer"
                                initial={reduceMotion ? false : { opacity: 0, y: 6 }}
                                animate={{ opacity: 1, y: 0 }}
                                transition={{ duration: 0.2 }}
                                className="pt-1"
                            >
                                {definitionBody}
                                {answerError && (
                                    <p className="mt-3 text-xs text-red-400 break-words" data-testid="review-answer-error">
                                        {answerError}
                                    </p>
                                )}
                                <div className="mt-5">{ratingButtons}</div>
                                <p className="hidden sm:block mt-3 text-center text-[11px] text-zinc-600">
                                    {t('review.keyHintRate')}
                                </p>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </motion.div>
            </>
        );
    };

    return (
        <div
            data-testid="review-screen"
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
        >
            {header}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
                <div className="mx-auto w-full max-w-2xl px-4 sm:px-6 py-4 sm:py-8 flex flex-col gap-4 sm:gap-6">
                    {statsRow}
                    {renderBody()}
                    <Dialog
                        open={suspendedOpen}
                        onClose={() => setSuspendedOpen(false)}
                        title={t('review.suspended.title')}
                        description={t('review.suspended.description')}
                        size="sm"
                        testId="review-suspended-dialog"
                    >
                        {suspendedLoading ? (
                            <div className="flex items-center gap-2 py-6 text-sm text-zinc-400">
                                <Loader2 className="w-4 h-4 animate-spin" />
                                {t('review.suspended.loading')}
                            </div>
                        ) : suspendedList.length === 0 ? (
                            <div className="space-y-3 py-4">
                                {suspendedError ? (
                                    <>
                                        <p className="text-sm text-zinc-300">
                                            {t('review.suspended.error')}
                                        </p>
                                        <p
                                            data-testid="review-suspended-error"
                                            className="text-xs text-zinc-500 break-words"
                                        >
                                            {suspendedError}
                                        </p>
                                        <button
                                            type="button"
                                            onClick={() => void openSuspended()}
                                            className={SECONDARY_BUTTON}
                                        >
                                            {t('common.retry')}
                                        </button>
                                    </>
                                ) : (
                                    <p
                                        data-testid="review-suspended-empty"
                                        className="text-sm text-zinc-500"
                                    >
                                        {t('review.suspended.empty')}
                                    </p>
                                )}
                            </div>
                        ) : (
                            <div className="space-y-2">
                                {suspendedError && (
                                    <p
                                        data-testid="review-suspended-error"
                                        className="text-xs text-red-400 break-words"
                                    >
                                        {suspendedError}
                                    </p>
                                )}
                                <ul className="space-y-2" data-testid="review-suspended-list">
                                    {suspendedList.map(word => (
                                        <li
                                            key={word.id}
                                            className="flex items-center justify-between gap-3 rounded-xl bg-zinc-800/30 border border-white/5 px-3 py-2.5"
                                        >
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-zinc-100 break-words">
                                                    {word.lemma}
                                                </p>
                                                <p className="mt-0.5 text-[11px] text-zinc-500">
                                                    {word.targetLang} · {t('review.suspended.failStreak', { count: word.failStreak })}
                                                </p>
                                            </div>
                                            <button
                                                type="button"
                                                data-testid="review-suspended-restore"
                                                onClick={() => void handleRestore(word)}
                                                disabled={restoringId !== null}
                                                className="inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 shrink-0"
                                            >
                                                {restoringId === word.id
                                                    ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                                    : <RotateCcw className="w-3.5 h-3.5" aria-hidden="true" />}
                                                {t('review.suspended.restore')}
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                            </div>
                        )}
                    </Dialog>
                </div>
            </div>
        </div>
    );
};
