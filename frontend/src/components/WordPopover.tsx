import { useCallback, useEffect, useRef, useState } from 'react';
import { X, Volume2, Star, Loader2, ChevronDown, ChevronUp, RefreshCw, Repeat, CheckCircle2, Undo2 } from 'lucide-react';
import { motion } from 'framer-motion';
import { apiFetch } from '../lib/api';
import { loadModel } from '../lib/settings';
import { describeApiError, toast } from '../lib/toast';
import { speak } from '../lib/tts';
import type { FavoriteSourceKind } from '../lib/favorites';
import { useAuth } from '../lib/auth';
import { addWord, setWordMastered, ReviewApiError } from '../lib/review';
import { hasMasteryHint, masteryScope, writeMasteryHint } from '../lib/wordMastery';
import { useI18n } from '../i18n/I18nProvider';
import { Button } from './ui/Button';

export interface WordDefinition {
    word: string;
    lemma?: string;
    ipa?: string;
    pos?: string;
    zh: string;
    definition_en?: string;
    example?: string;
    // Multiple senses, ordered by commonness. Older cached/back-end responses
    // omit this field, so it must stay optional.
    senses?: Array<{ pos?: string; zh: string; definition_en?: string }>;
}

/** Everything needed to open/retarget the card for a word. */
export interface WordLookupTarget {
    word: string;
    context: string;
    start: number;
    x: number;
    y: number;
    /**
     * Optional owning content id (e.g. a reading article id) used when the
     * looked-up word is saved to favorites. Transcript lookups leave it unset
     * so they keep using the current video id.
     */
    sourceId?: string;
    /** Human-readable title of that content (article title). */
    sourceTitle?: string;
    /** What the source is; reading lookups set `article`. */
    sourceKind?: FavoriteSourceKind;
}

interface WordPopoverProps {
    word: string;
    context: string;
    x: number;
    y: number;
    onClose: () => void;
    onToggleFavorite: (def: WordDefinition) => void;
    isFavorited: boolean;
    /** Retarget an already-open card when the pointer dwells on another word. */
    onSwitchWord: (target: WordLookupTarget) => void;
    /** Content ref of the lookup (video / article / book id) for word_sources. */
    sourceContentRef?: string;
    /** Sentence/block reference of the lookup; transcripts use the start time. */
    sourceSentenceId?: string;
    /** Guest gate: open the login overlay instead of calling the review API. */
    onRequestLogin?: () => void;
}

const CARD_WIDTH = 320;
// Only used to pick the side of the word the card opens on; the real height
// varies with senses/example length, so placement must not depend on it.
const CARD_EST_HEIGHT = 240;
const CARD_GAP = 12;
const CARD_EDGE_MARGIN = 12;
// When the card opens above the word, its bottom edge sits this far above the
// anchor so a card taller than the estimate grows upward instead of covering
// the word line (which would make the neighbouring words unhoverable).
const CARD_ABOVE_GAP = 24;
// Dwell time before actually switching words. Long enough to skip the words
// the pointer sweeps across on the way from A to B, short enough to feel
// instant. Required window: 120–200ms.
const HOVER_SWITCH_DEBOUNCE_MS = 160;

const lookupKey = (word: string, context: string) => `${word}\u0000${context}`;

/**
 * Find the clickable word under a viewport point. The click-away layer is on
 * top of the page, so `elementsFromPoint` is used to reach the word span
 * beneath it; the sentence-level lookup context/start live on the closest
 * `[data-lookup-context]` ancestor (one node per sentence, not per word).
 */
function findLookupWordAt(clientX: number, clientY: number): WordLookupTarget | null {
    for (const node of document.elementsFromPoint(clientX, clientY)) {
        if (!(node instanceof HTMLElement)) continue;
        const hit = node.dataset.wordHit ? node : node.closest<HTMLElement>('[data-word-hit]');
        const word = hit?.dataset.wordHit;
        if (!hit || !word) continue;
        const host = hit.closest<HTMLElement>('[data-lookup-context]');
        if (!host) continue;
        const rect = hit.getBoundingClientRect();
        return {
            word,
            context: host.dataset.lookupContext ?? '',
            start: Number(host.dataset.lookupStart ?? '0') || 0,
            x: rect.left + rect.width / 2,
            y: rect.bottom,
        };
    }
    return null;
}

export const WordPopover: React.FC<WordPopoverProps> = ({
    word,
    context,
    x,
    y,
    onClose,
    onToggleFavorite,
    isFavorited,
    onSwitchWord,
    sourceContentRef,
    sourceSentenceId,
    onRequestLogin,
}) => {
    const { t, targetLang } = useI18n();
    const { status, user } = useAuth();
    const isGuest = status === 'guest';
    const mastery = masteryScope(isGuest, user?.id);
    const [definition, setDefinition] = useState<WordDefinition | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [showAllSenses, setShowAllSenses] = useState(false);
    // Review deck (specs/005 / specs/013 v1.1): add + mastered entry points.
    const [reviewPhase, setReviewPhase] = useState<'idle' | 'saving' | 'added'>('idle');
    const [reviewError, setReviewError] = useState<string | null>(null);
    const [mastered, setMastered] = useState(false);
    const [masteredSaving, setMasteredSaving] = useState(false);
    const [masteredError, setMasteredError] = useState<string | null>(null);
    // Report 1.2.3: a failed lookup must offer one action instead of a dead
    // end. Bumping this re-runs the same request for the same word/context.
    const [lookupAttempt, setLookupAttempt] = useState(0);
    const [retrying, setRetrying] = useState(false);
    // Pointer-dwell state for hover switching. `hoverKeyRef` is the word (or
    // empty area) the pointer is currently over; the timer only fires once the
    // pointer has stayed on the same new word for the full debounce window.
    const hoverTimerRef = useRef<number | null>(null);
    const hoverKeyRef = useRef<string | null>(lookupKey(word, context));

    useEffect(() => {
        let cancelled = false;
        setDefinition(null);
        setError(null);
        setShowAllSenses(false);
        (async () => {
            try {
                const res = await apiFetch('/api/define', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ word, context, model: loadModel() || undefined }),
                });
                if (!res.ok) throw new Error(await describeApiError(res));
                const data = await res.json();
                // A local-dictionary/cache hit arrives as a normal success
                // payload; keep it exactly as the server sent it (no invented
                // browser dictionary fallback).
                if (!cancelled) setDefinition(data);
            } catch (e) {
                if (!cancelled) setError(await describeApiError(e));
            } finally {
                if (!cancelled) setRetrying(false);
            }
        })();
        return () => { cancelled = true; };
    }, [word, context, lookupAttempt]);

    // A different word/context starts a fresh review card: forget the last
    // action's transient state but keep the mastered mark.
    useEffect(() => {
        setReviewPhase('idle');
        setReviewError(null);
        setMasteredError(null);
    }, [word, context]);

    // The mastered mark is keyed by the lemma (what the review API stores), so
    // apply the local mirror once /api/define reveals it.
    useEffect(() => {
        if (!definition) return;
        setMastered(hasMasteryHint(mastery, definition.lemma || definition.word || word));
        // `mastery.key` is the stable identity of the storage scope.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [definition, word, mastery.key]);

    const clearHoverTimer = useCallback(() => {
        if (hoverTimerRef.current != null) {
            window.clearTimeout(hoverTimerRef.current);
            hoverTimerRef.current = null;
        }
    }, []);

    // A new word (from a click or a hover switch) resets the dwell baseline, so
    // the pointer sitting on the newly opened word never schedules a redundant
    // switch. Unmount clears any in-flight timer.
    useEffect(() => {
        hoverKeyRef.current = lookupKey(word, context);
        return clearHoverTimer;
    }, [word, context, clearHoverTimer]);

    const handleHoverMove = (e: React.PointerEvent<HTMLDivElement>) => {
        // Touch/pen keep the original click-only behavior: a moving finger must
        // never retarget the card.
        if (e.pointerType !== 'mouse') return;

        const target = findLookupWordAt(e.clientX, e.clientY);
        const key = target ? lookupKey(target.word, target.context) : null;
        // Same word / same empty area as the previous move: keep the pending
        // timer running instead of restarting it on every pixel.
        if (key === hoverKeyRef.current) return;

        clearHoverTimer();
        hoverKeyRef.current = key;

        // Moved off the words (or into the card, where this handler never
        // fires) — the card stays open; only the pending switch is dropped.
        if (!target) return;
        // Already showing this word (e.g. hovering the word that opened the
        // card): never yank the card to a slightly different position.
        if (key === lookupKey(word, context)) return;

        hoverTimerRef.current = window.setTimeout(() => {
            hoverTimerRef.current = null;
            onSwitchWord(target);
        }, HOVER_SWITCH_DEBOUNCE_MS);
    };

    // Leaving the probe (card, window) drops a pending switch so closing the
    // card can never be followed by a stale retarget.
    const handleHoverEnd = () => {
        clearHoverTimer();
        hoverKeyRef.current = null;
    };

    // Clear the dwell timer before closing; the exit animation keeps the card
    // mounted for a beat, so an in-flight timer would otherwise outlive it.
    const handleClose = () => {
        clearHoverTimer();
        onClose();
    };

    // Review word identity: the server keys word_states by lemma, so prefer the
    // dictionary's lemma over the surface form when it is available.
    const reviewLemma = (definition?.lemma || definition?.word || word).trim();

    const openLogin = () => {
        if (onRequestLogin) onRequestLogin();
        else toast.info(t('guest.loginToSave'));
    };

    const handleAddToReview = async () => {
        if (reviewPhase === 'saving' || !reviewLemma) return;
        // Guests never reach the 403: the gate is at the entry (G8 / M7b).
        if (isGuest) {
            openLogin();
            return;
        }
        setReviewPhase('saving');
        setReviewError(null);
        try {
            await addWord({
                lemma: reviewLemma,
                targetLang,
                source: { contentRef: sourceContentRef, sentenceId: sourceSentenceId },
            });
            setReviewPhase('added');
            // specs/013: re-adding a tracked word forces mastered=0 server-side.
            setMastered(false);
            writeMasteryHint(mastery, reviewLemma, false);
            toast.success(t('vocab.review.toast.added'), { dedupeKey: 'review:word-added' });
        } catch (caught) {
            setReviewPhase('idle');
            setReviewError(caught instanceof ReviewApiError && caught.status === 403
                ? t('vocab.review.loginHint')
                : t('vocab.review.error.add'));
        }
    };

    const handleToggleMastered = async () => {
        if (masteredSaving || !reviewLemma) return;
        const next = !mastered;
        // Guest: local ignore table only (文案「我会了」), never uploaded.
        if (isGuest) {
            writeMasteryHint(mastery, reviewLemma, next);
            setMastered(next);
            return;
        }
        setMasteredSaving(true);
        setMasteredError(null);
        try {
            await setWordMastered({
                lemma: reviewLemma,
                mastered: next,
                targetLang,
                source: { contentRef: sourceContentRef, sentenceId: sourceSentenceId },
            });
            writeMasteryHint(mastery, reviewLemma, next);
            setMastered(next);
            toast.success(
                next ? t('vocab.review.toast.mastered') : t('vocab.review.toast.unmastered'),
                { dedupeKey: 'review:word-mastered' },
            );
        } catch {
            setMasteredError(t('vocab.review.error.mastered'));
        } finally {
            setMasteredSaving(false);
        }
    };

    // Keep the card inside the viewport. When it sits below the anchor, `top`
    // fixes its position and the content grows downward. When it sits above,
    // anchor the *bottom* edge 24px above the anchor instead of estimating the
    // height — otherwise a tall card (long senses/example) hangs over the word
    // line and swallows pointer-moves aimed at the neighbouring words.
    const left = Math.max(CARD_EDGE_MARGIN, Math.min(x - CARD_WIDTH / 2, window.innerWidth - CARD_WIDTH - CARD_EDGE_MARGIN));
    const flipAbove = y + CARD_EST_HEIGHT + 24 > window.innerHeight;
    const maxHeight = Math.max(
        160,
        flipAbove
            ? y - CARD_ABOVE_GAP - CARD_EDGE_MARGIN
            : window.innerHeight - y - CARD_GAP - CARD_EDGE_MARGIN,
    );
    const cardPosition: React.CSSProperties = flipAbove
        ? { left, bottom: window.innerHeight - y + CARD_ABOVE_GAP, maxHeight }
        : { left, top: y + CARD_GAP, maxHeight };

    // `senses` is new on the /api/define contract; normalize defensively so a
    // malformed or pre-`senses` payload still renders the single-sense layout.
    const senses = Array.isArray(definition?.senses)
        ? definition.senses
            .filter((s) => s && typeof s.zh === 'string' && s.zh.trim().length > 0)
            .map((s, i) => ({
                // The contract makes senses[0] mirror the top-level fields; if an
                // older payload is missing them, fall back to the top-level values.
                pos: (s.pos || (i === 0 ? definition?.pos : '') || '').trim(),
                zh: s.zh.trim(),
                definition_en: (s.definition_en || (i === 0 ? definition?.definition_en : '') || '').trim(),
            }))
        : [];
    const hasSenseList = senses.length >= 2;
    const visibleSenses = hasSenseList && !showAllSenses ? senses.slice(0, 3) : senses;

    return (
        <>
            {/* click-away layer — also the hover probe: it sits above the page,
                so pointer-move hit-testing reaches the word underneath. A click
                on a word under it retargets the card instead of only closing:
                touch devices have no hover, so tapping a second word must work
                in one tap. Clicking empty space closes as before. */}
            <div
                data-testid="word-popover-overlay"
                className="fixed inset-0 z-[80]"
                onClick={(e) => {
                    const target = findLookupWordAt(e.clientX, e.clientY);
                    if (target) {
                        const nextKey = lookupKey(target.word, target.context);
                        if (nextKey !== lookupKey(word, context)) {
                            onSwitchWord(target);
                            return;
                        }
                    }
                    handleClose();
                }}
                onPointerMove={handleHoverMove}
                onPointerLeave={handleHoverEnd}
            />
            <motion.div
                data-testid="word-popover"
                initial={{ opacity: 0, y: 6, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98, transition: { duration: 0.12, ease: "easeIn" } }}
                transition={{ type: "spring", stiffness: 550, damping: 35, mass: 0.8 }}
                className="fixed z-[90] w-80 rounded-2xl bg-zinc-900/85 backdrop-blur-xl backdrop-saturate-150 border border-white/10 shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_8px_16px_-6px_rgba(0,0,0,0.5),0_24px_64px_-16px_rgba(0,0,0,0.6)] p-4 overflow-y-auto custom-scrollbar"
                style={cardPosition}
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-start justify-between gap-2 mb-1">
                    <div className="flex items-baseline gap-2 flex-wrap min-w-0">
                        <span data-testid="word-popover-word" className="text-[17px] font-semibold tracking-tight text-zinc-100 break-all">{definition?.word || word}</span>
                        {definition?.ipa && <span className="text-xs text-zinc-400">{definition.ipa}</span>}
                        {definition?.pos && !hasSenseList && <span className="text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300">{definition.pos}</span>}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                        <button
                            onClick={() => speak(definition?.word || word)}
                            className="p-1.5 rounded-lg text-zinc-500 hover:text-blue-400 hover:bg-white/5 transition-colors"
                            title={t('dictionary.speak')}
                        >
                            <Volume2 className="w-4 h-4" />
                        </button>
                        {definition && (
                            <button
                                data-testid="word-popover-favorite"
                                onClick={() => onToggleFavorite(definition)}
                                aria-label={isFavorited ? t('dictionary.removeFavorite') : t('dictionary.addFavorite')}
                                aria-pressed={isFavorited}
                                className={`p-1.5 rounded-lg transition-colors hover:bg-white/5 ${isFavorited ? 'text-amber-400' : 'text-zinc-500 hover:text-amber-400'}`}
                                title={isFavorited ? t('dictionary.removeFavorite') : t('dictionary.addFavorite')}
                            >
                                <Star className="w-4 h-4" fill={isFavorited ? 'currentColor' : 'none'} />
                            </button>
                        )}
                        <button onClick={handleClose} className="p-1.5 rounded-full text-zinc-500 hover:text-zinc-300 hover:bg-white/5 transition-colors">
                            <X className="w-4 h-4" />
                        </button>
                    </div>
                </div>

                {!definition && !error && (
                    <div className="flex items-center gap-2 py-4 text-zinc-500 text-sm">
                        <Loader2 className="w-4 h-4 animate-spin" /> {t('dictionary.loading')}
                    </div>
                )}

                {error && (
                    <div data-testid="word-popover-error" className="py-2 space-y-2">
                        <p role="alert" className="text-sm leading-relaxed text-red-400">{error}</p>
                        <button
                            type="button"
                            data-testid="word-popover-retry"
                            disabled={retrying}
                            aria-busy={retrying}
                            onClick={() => {
                                setRetrying(true);
                                setLookupAttempt(attempt => attempt + 1);
                            }}
                            className="inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-800/80 hover:bg-zinc-700/80 border border-white/5 text-xs font-medium text-zinc-200 transition-colors disabled:opacity-60 disabled:cursor-wait"
                        >
                            {retrying
                                ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                : <RefreshCw className="w-3.5 h-3.5" />}
                            {t('common.retry')}
                        </button>
                    </div>
                )}

                {definition && (
                    <div className="space-y-2 mt-1">
                        {hasSenseList ? (
                            <>
                                {/* List mode replaces the top-level zh/pos/definition_en
                                    so the first sense is never shown twice. */}
                                <ul className="space-y-2 max-h-64 overflow-y-auto pr-1 -mr-1">
                                    {visibleSenses.map((sense, i) => (
                                        <li key={`${i}-${sense.zh}`} className="flex items-start gap-2">
                                            {sense.pos && (
                                                <span className="shrink-0 mt-px text-[11px] font-medium px-2 py-0.5 rounded-full bg-purple-500/15 text-purple-300">
                                                    {sense.pos}
                                                </span>
                                            )}
                                            <div className="min-w-0 flex-1">
                                                <p className="text-sm text-zinc-100 leading-relaxed">{sense.zh}</p>
                                                {sense.definition_en && (
                                                    <p className="text-[11px] text-zinc-500 leading-relaxed">{sense.definition_en}</p>
                                                )}
                                            </div>
                                        </li>
                                    ))}
                                </ul>
                                {senses.length > 3 && (
                                    <button
                                        onClick={() => setShowAllSenses(v => !v)}
                                        aria-expanded={showAllSenses}
                                        className="flex w-full items-center justify-center gap-1 h-8 rounded-lg text-[11px] font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                                    >
                                        {showAllSenses ? (
                                            <>{t('dictionary.showLess')} <ChevronUp className="w-3.5 h-3.5" /></>
                                        ) : (
                                            <>{t('dictionary.showAll', { count: senses.length })} <ChevronDown className="w-3.5 h-3.5" /></>
                                        )}
                                    </button>
                                )}
                            </>
                        ) : (
                            <>
                                <p className="text-base text-zinc-100 font-medium">{definition.zh}</p>
                                {definition.definition_en && (
                                    <p className="text-xs text-zinc-400 leading-relaxed">{definition.definition_en}</p>
                                )}
                            </>
                        )}
                        {definition.example && (
                            <button
                                onClick={() => speak(definition.example!)}
                                className="w-full text-left text-xs text-zinc-500 italic leading-relaxed border-l-2 border-white/10 pl-2 hover:text-zinc-300 transition-colors"
                                title={t('dictionary.exampleTitle')}
                            >
                                {definition.example}
                            </button>
                        )}
                        {definition.lemma && definition.lemma.toLowerCase() !== (definition.word || word).toLowerCase() && (
                            <p className="text-[11px] text-zinc-600">{t('dictionary.lemma', { lemma: definition.lemma })}</p>
                        )}
                    </div>
                )}

                {/* v1.1 review entry points (specs/005 / specs/013 §v1.1):
                    the dictionary card is the primary "加入复习" entry; the
                    word-book favorite row is the secondary one. */}
                {definition && (
                    <div className="mt-3 border-t border-line-strong pt-3">
                        <div className="flex flex-wrap items-center gap-1.5">
                            <Button
                                size="sm"
                                variant={reviewPhase === 'added' ? 'secondary' : 'tinted'}
                                tone="brand"
                                iconLeft={reviewPhase === 'added' ? <CheckCircle2 /> : <Repeat />}
                                loading={reviewPhase === 'saving'}
                                loadingLabel={t('vocab.review.adding')}
                                ariaLabel={reviewPhase === 'added' ? t('vocab.review.added') : t('vocab.review.add')}
                                testId="word-popover-review"
                                onClick={() => { void handleAddToReview(); }}
                                className="[@media(pointer:coarse)]:min-h-11"
                            >
                                {reviewPhase === 'added' ? t('vocab.review.added') : t('vocab.review.add')}
                            </Button>
                            <Button
                                size="sm"
                                variant={mastered ? 'secondary' : 'tinted'}
                                tone="success"
                                iconLeft={mastered ? <Undo2 /> : <CheckCircle2 />}
                                loading={masteredSaving}
                                ariaLabel={mastered
                                    ? t('vocab.review.undo')
                                    : isGuest ? t('vocab.review.guestMaster') : t('vocab.review.master')}
                                testId="word-popover-mastered"
                                onClick={() => { void handleToggleMastered(); }}
                                className="[@media(pointer:coarse)]:min-h-11"
                            >
                                {mastered
                                    ? t('vocab.review.undo')
                                    : isGuest ? t('vocab.review.guestMaster') : t('vocab.review.master')}
                            </Button>
                        </div>
                        {reviewError && (
                            <p data-testid="word-popover-review-error" role="alert" className="mt-2 text-caption leading-relaxed text-danger-fg">
                                {reviewError}
                            </p>
                        )}
                        {masteredError && (
                            <p data-testid="word-popover-mastered-error" role="alert" className="mt-2 text-caption leading-relaxed text-danger-fg">
                                {masteredError}
                            </p>
                        )}
                    </div>
                )}
            </motion.div>
        </>
    );
};
