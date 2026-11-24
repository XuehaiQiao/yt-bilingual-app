import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { LogIn, Sparkles, Star } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { cn } from '../lib/cn';
import type { FavoriteDraft, FavoriteItem } from '../lib/favorites';
import type { InlineLanguagePoint } from './TranscriptBlock';
import type { TeachingNotesStatus } from './TeachingNotesPanel';

interface WatchGlossPanelProps {
    /**
     * `rail` — the ≥1280 fixed right column (360px, specs/045 §4.3).
     * `drawer` — the <1280 bottom sheet below the 16:9 picture (specs/045 §5).
     * P2-16 removed the old floating pill/panel over the media.
     */
    variant?: 'rail' | 'drawer';
    /** Block id of the sentence being spoken; null before the first cue. */
    blockId: string | null;
    /**
     * English text of the current sentence. P2-12 stopped rendering it above
     * each entry; it survives as the entry identity (an edited sentence still
     * replaces its old snapshot) and as the favorite's `context_en`.
     */
    enText?: string | null;
    /** Content identity (the YouTube video id); history is per video. */
    videoId: string;
    /** `start` of the current block, used as the favorite's playback time. */
    blockStart: number;
    /** Video title, carried into the favorite provenance (`source_title`). */
    sourceTitle?: string;
    /** `wordGlossesByBlock[blockId]` — the same map the transcript ruby uses. */
    glosses: Record<string, string>;
    /** `languagePointsByBlock[blockId]` — the same list the underline layer uses. */
    languagePoints: InlineLanguagePoint[];
    /** Follows the transcript's language-point switch (one semantic source). */
    showLanguagePoints: boolean;
    status: TeachingNotesStatus;
    /** The existing 028 entry point (GET /api/teaching-analysis). No new AI. */
    onRequestAnalysis: () => void;
    onRequestLogin?: () => void;
    /**
     * App-owned favorites. The rail's star is filled when this word is already
     * saved (matched by id or, for words saved elsewhere, by en_text), which is
     * also what keeps the App top-bar word-book count in sync.
     */
    favorites: readonly FavoriteItem[];
    /** App-owned optimistic add; resolves after the server write. */
    onAddFavorite: (draft: FavoriteDraft) => Promise<FavoriteItem>;
    /** App-owned optimistic remove; resolves `false` after a rollback. */
    onRemoveFavorite: (id: string) => Promise<boolean>;
    /** Guests may read but not save; a star press explains it inline. */
    isGuest?: boolean;
}

/** One sentence's gloss snapshot, kept so earlier sentences stay readable. */
interface WatchGlossEntry {
    blockId: string;
    enText: string;
    words: Array<[string, string]>;
    points: InlineLanguagePoint[];
}

/** P2-09: keep the recent sentences, oldest fall off the bottom. */
const MAX_HISTORY_ENTRIES = 30;

/** P2-16: current sentence full strength; history fades with age (specs/045 §4.3). */
const HISTORY_OPACITY = 0.55;
const HISTORY_OPACITY_STEP = 0.035;
const HISTORY_OPACITY_FLOOR = 0.32;

const historyOpacity = (age: number, hasCurrent: boolean) => {
    const rank = hasCurrent ? Math.max(0, age - 1) : age;
    return Math.max(HISTORY_OPACITY_FLOOR, HISTORY_OPACITY - HISTORY_OPACITY_STEP * rank);
};

const samePoint = (a: InlineLanguagePoint, b: InlineLanguagePoint) =>
    a.text === b.text && a.meaning === b.meaning && a.kind === b.kind;

const sameEntry = (a: WatchGlossEntry, b: WatchGlossEntry) =>
    a.blockId === b.blockId
    && a.enText === b.enText
    && a.words.length === b.words.length
    && a.words.every(([word, gloss], index) => word === b.words[index][0] && gloss === b.words[index][1])
    && a.points.length === b.points.length
    && a.points.every((point, index) => samePoint(point, b.points[index]));

const favoriteWordKey = (word: string) => word.trim().toLowerCase();

interface FavoriteRowState {
    favorited: boolean;
    busy: boolean;
    message?: string;
}

interface GlossEntryBodyProps {
    entry: WatchGlossEntry;
    isCurrent: boolean;
    /** Position in the list (0 = current/newest), asserted by acceptance. */
    age: number;
    /** P2-16 history fade: current 1, older entries dim with age. */
    opacity: number;
    showLanguagePoints: boolean;
    alwaysShowActions: boolean;
    /** Row key (`blockId:word`) → transient inline error / guest hint. */
    feedback: Readonly<Record<string, string>>;
    busyKeys: ReadonlySet<string>;
    favoriteOf: (word: string) => FavoriteItem | undefined;
    onToggleFavorite: (key: string, word: string, gloss: string) => void;
}

/**
 * P2-16: the favorite star is revealed by hover/focus on the rail and stays
 * visible on the touch drawer (there is no hover on a phone). A failed write
 * has already been rolled back by App, so the star returns to its empty state
 * and the row explains what happened inline.
 */
const FavoriteButton: React.FC<{
    word: string;
    gloss: string;
    state: FavoriteRowState;
    alwaysShow: boolean;
    onToggle: () => void;
}> = ({ word, gloss, state, alwaysShow, onToggle }) => {
    const { t } = useI18n();
    const label = state.favorited ? t('watchMode.favoriteRemove') : t('watchMode.favoriteAdd');
    return (
        <button
            type="button"
            data-testid="watch-gloss-favorite"
            data-word={word}
            data-favorited={state.favorited ? 'true' : 'false'}
            aria-label={label}
            aria-pressed={state.favorited}
            aria-busy={state.busy || undefined}
            title={label}
            disabled={!gloss && !state.favorited}
            onClick={(event) => {
                event.stopPropagation();
                onToggle();
            }}
            className={cn(
                'ml-auto flex shrink-0 items-center justify-center rounded-control transition-opacity motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                alwaysShow ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100',
                alwaysShow ? 'h-11 w-11' : 'h-8 w-8',
                state.favorited ? 'text-warning-fg' : 'text-fg-muted hover:text-fg-primary',
            )}
        >
            <Star
                aria-hidden="true"
                className={cn('h-4 w-4', state.favorited && 'fill-warning-fg')}
            />
        </button>
    );
};

const RowFeedback: React.FC<{ message?: string }> = ({ message }) => (
    message ? (
        <p
            role="alert"
            data-testid="watch-gloss-favorite-error"
            className="mt-0.5 pl-3 text-micro leading-relaxed text-danger-fg"
        >
            {message}
        </p>
    ) : null
);

/**
 * One sentence's block in the rolling gloss list. P2-12 stripped the chrome:
 * no sentence context, no section headings, no kind badges and no empty
 * placeholders. P2-16 adds the current-sentence marker (a 2px bar, never a
 * border) and the hover/focus favorite star; history dims with age.
 */
const GlossEntryBody: React.FC<GlossEntryBodyProps> = ({
    entry,
    isCurrent,
    age,
    opacity,
    showLanguagePoints,
    alwaysShowActions,
    feedback,
    busyKeys,
    favoriteOf,
    onToggleFavorite,
}) => {
    const points = showLanguagePoints ? entry.points : [];

    const rowFeedback = (word: string) => feedback[`${entry.blockId}:${word}`];
    const rowBusy = (word: string) => busyKeys.has(`${entry.blockId}:${word}`);
    const rowFavorite = (word: string) => Boolean(favoriteOf(word));
    const rowToggle = (word: string, gloss: string) => onToggleFavorite(
        `${entry.blockId}:${word}`,
        word,
        gloss,
    );

    return (
        <article
            data-testid="watch-gloss-entry"
            data-block-id={entry.blockId}
            data-current={isCurrent ? 'true' : 'false'}
            data-age={age}
            aria-current={isCurrent ? 'true' : undefined}
            style={{ opacity }}
            className={cn('min-w-0', isCurrent && 'relative')}
        >
            {entry.words.length > 0 && (
                <ul data-testid="watch-gloss-words" className="space-y-0.5">
                    {entry.words.map(([word, gloss]) => (
                        <li key={word} className="min-w-0">
                            <div
                                data-testid="watch-gloss-word"
                                data-word={word}
                                className="group relative flex min-w-0 items-start gap-2 py-0.5 pl-3 pr-0.5"
                            >
                                {isCurrent && (
                                    <span
                                        aria-hidden="true"
                                        data-testid="watch-gloss-current-marker"
                                        className="absolute bottom-1 left-0 top-1 w-0.5 rounded-full bg-warning-fg/80"
                                    />
                                )}
                                <span className="min-w-0 break-words text-ui font-medium text-warning-fg">
                                    {word}
                                </span>
                                <span className="min-w-0 flex-1 break-words text-caption leading-relaxed text-fg-secondary">
                                    {gloss}
                                </span>
                                <FavoriteButton
                                    word={word}
                                    gloss={gloss}
                                    state={{
                                        favorited: rowFavorite(word),
                                        busy: rowBusy(word),
                                    }}
                                    alwaysShow={alwaysShowActions}
                                    onToggle={() => rowToggle(word, gloss)}
                                />
                            </div>
                            <RowFeedback message={rowFeedback(word)} />
                        </li>
                    ))}
                </ul>
            )}
            {points.length > 0 && (
                <ul
                    data-testid="watch-gloss-language-points"
                    className={entry.words.length > 0 ? 'mt-1.5 space-y-1' : 'space-y-1'}
                >
                    {points.map((point, index) => (
                        <li
                            key={`${point.text}-${index}`}
                            data-testid="watch-gloss-language-point"
                            className="group relative min-w-0 pl-3"
                        >
                            {isCurrent && (
                                <span
                                    aria-hidden="true"
                                    className="absolute bottom-1 left-0 top-1 w-0.5 rounded-full bg-sky-400/70"
                                />
                            )}
                            <div className="flex min-w-0 items-start gap-2">
                                <div className="min-w-0 flex-1">
                                    <p className="min-w-0 break-words text-ui font-medium text-sky-300">
                                        {point.text}
                                    </p>
                                    {point.meaning && (
                                        <p className="mt-0.5 break-words text-caption leading-relaxed text-fg-secondary">
                                            {point.meaning}
                                        </p>
                                    )}
                                </div>
                                <FavoriteButton
                                    word={point.text}
                                    gloss={point.meaning ?? ''}
                                    state={{
                                        favorited: rowFavorite(point.text),
                                        busy: rowBusy(point.text),
                                    }}
                                    alwaysShow={alwaysShowActions}
                                    onToggle={() => rowToggle(point.text, point.meaning ?? '')}
                                />
                            </div>
                            <RowFeedback message={rowFeedback(point.text)} />
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
};

interface GlossBodyProps {
    /** Current sentence first, then the accumulated earlier sentences. */
    entries: WatchGlossEntry[];
    /** Which entry is the sentence being spoken (null = between sentences). */
    currentBlockId: string | null;
    showLanguagePoints: boolean;
    status: TeachingNotesStatus;
    onRequestAnalysis: () => void;
    onRequestLogin?: () => void;
    alwaysShowActions: boolean;
    feedback: Readonly<Record<string, string>>;
    busyKeys: ReadonlySet<string>;
    favoriteOf: (word: string) => FavoriteItem | undefined;
    onToggleFavorite: (key: string, word: string, gloss: string) => void;
}

const StatusSkeleton: React.FC = () => {
    const { t } = useI18n();
    return (
        <div data-testid="watch-gloss-loading" aria-busy="true" aria-label={t('watchMode.loading')} className="space-y-1.5">
            {[0, 1].map((index) => (
                <div
                    key={index}
                    className="h-9 rounded-control bg-surface-2/40 animate-pulse motion-reduce:animate-none"
                />
            ))}
        </div>
    );
};

/**
 * P2-16: a compact, top-aligned state — one explanation plus the existing
 * action. It deliberately does not fill the rail (specs/045 §4.3 / §6).
 */
const CompactState: React.FC<{
    testId: string;
    title: string;
    hint?: string;
    action?: React.ReactNode;
}> = ({ testId, title, hint, action }) => (
    <div data-testid={testId} className="max-w-[19rem]">
        <p className="text-caption font-medium leading-relaxed text-fg-strong">{title}</p>
        {hint && <p className="mt-1 text-micro leading-relaxed text-fg-muted">{hint}</p>}
        {action}
    </div>
);

const GlossBody: React.FC<GlossBodyProps> = ({
    entries,
    currentBlockId,
    showLanguagePoints,
    status,
    onRequestAnalysis,
    onRequestLogin,
    alwaysShowActions,
    feedback,
    busyKeys,
    favoriteOf,
    onToggleFavorite,
}) => {
    const { t } = useI18n();

    if (status === 'loading' || status === 'idle') return <StatusSkeleton />;

    if (status === 'login') {
        return (
            <div data-testid="watch-gloss-login" className="flex max-w-[19rem] items-start gap-2.5">
                <LogIn className="mt-0.5 h-4 w-4 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                    <p className="text-caption leading-relaxed text-fg-secondary">{t('watchMode.loginHint')}</p>
                    {onRequestLogin && (
                        <button
                            type="button"
                            data-testid="watch-gloss-login-action"
                            onClick={onRequestLogin}
                            className="mt-2 inline-flex h-8 items-center rounded-control border border-line-strong bg-state-hover px-3 text-caption font-medium text-fg-primary transition-colors hover:bg-state-pressed"
                        >
                            {t('teachingNotes.loginAction')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <CompactState
                testId="watch-gloss-error"
                title={t('watchMode.error')}
                action={(
                    <button
                        type="button"
                        data-testid="watch-gloss-retry"
                        onClick={onRequestAnalysis}
                        className="mt-2 inline-flex h-8 items-center rounded-control border border-line-subtle bg-surface-2/60 px-3 text-caption font-medium text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary"
                    >
                        {t('common.retry')}
                    </button>
                )}
            />
        );
    }

    if (status === 'empty') {
        return (
            <CompactState
                testId="watch-gloss-no-analysis"
                title={t('watchMode.noAnalysisTitle')}
                hint={t('watchMode.noAnalysisHint')}
                action={(
                    <button
                        type="button"
                        data-testid="watch-gloss-generate"
                        onClick={onRequestAnalysis}
                        className="mt-2 inline-flex h-8 items-center gap-1.5 rounded-control border border-line-strong bg-state-hover px-3 text-caption font-medium text-fg-primary transition-colors hover:bg-state-pressed"
                    >
                        <Sparkles className="h-3.5 w-3.5" />
                        {t('watchMode.generate')}
                    </button>
                )}
            />
        );
    }

    // P2-12: no per-sentence or global "no gloss" placeholder. Before the
    // first glossed sentence the window simply has no entries yet.
    if (entries.length === 0) return null;

    return (
        <div data-testid="watch-gloss-history" className="space-y-3.5">
            {entries.map((entry, index) => {
                const isCurrent = entry.blockId === currentBlockId;
                return (
                    <GlossEntryBody
                        key={entry.blockId}
                        entry={entry}
                        isCurrent={isCurrent}
                        age={index}
                        opacity={isCurrent ? 1 : historyOpacity(index, Boolean(currentBlockId))}
                        showLanguagePoints={showLanguagePoints}
                        alwaysShowActions={alwaysShowActions}
                        feedback={feedback}
                        busyKeys={busyKeys}
                        favoriteOf={favoriteOf}
                        onToggleFavorite={onToggleFavorite}
                    />
                );
            })}
        </div>
    );
};

const GlossHeader: React.FC<{ wordCount: number }> = ({ wordCount }) => {
    const { t, formatNumber } = useI18n();
    return (
        <header
            data-testid="watch-gloss-header"
            className="flex flex-none items-center justify-between gap-3 px-5 py-3"
        >
            <h2 className="min-w-0 truncate text-section font-semibold tracking-tight text-fg-primary">
                {t('watchMode.glossTitle')}
            </h2>
            <span
                data-testid="watch-gloss-count"
                title={t('watchMode.sentenceWordCountAria', { count: formatNumber(wordCount) })}
                className="shrink-0 text-micro font-medium tabular-nums text-fg-muted"
            >
                {t('watchMode.sentenceWordCount', { count: formatNumber(wordCount) })}
            </span>
        </header>
    );
};

/**
 * 观影模式滚动词条窗 (specs/044 §§3–4, specs/045 §4.3/§5).
 *
 * A second presentation of the existing teaching analysis (specs/028): the
 * words the transcript already marks in ruby plus that sentence's language
 * points. P2-09 keeps a per-sentence history (current on top, revisited
 * sentences move instead of duplicating); P2-12 strips the chrome; P2-16 makes
 * it the target design: a 360px rail with 「滚动词条」+ 本句词数, a 2px marker on
 * the current sentence, fading history and a one-click favorite star, while
 * the <1280 presentation becomes a bottom drawer under a top-pinned 16:9
 * picture instead of a floating layer over the media.
 *
 * It never issues an AI call of its own — the only action it exposes is the
 * existing cached analysis entry (`onRequestAnalysis`).
 */
const WatchGlossPanelInner: React.FC<WatchGlossPanelProps> = ({
    variant = 'rail',
    blockId,
    enText,
    videoId,
    blockStart,
    sourceTitle,
    glosses,
    languagePoints,
    showLanguagePoints,
    status,
    onRequestAnalysis,
    onRequestLogin,
    favorites,
    onAddFavorite,
    onRemoveFavorite,
    isGuest = false,
}) => {
    const { t } = useI18n();
    // P2-16: the drawer is expanded by default — on a phone a collapsed drawer
    // is effectively no gloss window at all (specs/045 §5).
    const [open, setOpen] = useState(true);
    const [history, setHistory] = useState<WatchGlossEntry[]>([]);
    const [feedback, setFeedback] = useState<Readonly<Record<string, string>>>({});
    const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // True while the newest sentence may pull the window back to the top; a
    // manual scroll down turns it off until the learner scrolls back up.
    const stickToTopRef = useRef(true);
    const lastVideoRef = useRef<string | null>(videoId ?? null);
    const inFlightRef = useRef<Set<string>>(new Set());
    const feedbackTimersRef = useRef<Map<string, number>>(new Map());

    const currentEntry = useMemo<WatchGlossEntry | null>(() => {
        if (!blockId) return null;
        const words = Object.entries(glosses ?? {});
        const points = languagePoints ?? [];
        // P2-12: empty sentences are not entries; they never create a
        // placeholder, they just leave the backlog untouched.
        if (words.length === 0 && points.length === 0) return null;
        return {
            blockId,
            enText: enText?.trim() ?? '',
            words,
            points,
        };
    }, [blockId, enText, glosses, languagePoints]);

    // A different video must never inherit the previous video's sentences:
    // block ids are only unique inside one content.
    useEffect(() => {
        const next = videoId ?? null;
        if (lastVideoRef.current === next) return;
        lastVideoRef.current = next;
        setHistory([]);
        stickToTopRef.current = true;
    }, [videoId]);

    // Only accumulate once the analysis is ready; an empty sentence yields no
    // entry at all (P2-12), so the backlog is preserved without a placeholder.
    useEffect(() => {
        if (status !== 'ready' || !currentEntry) return;
        setHistory((previous) => {
            const top = previous[0];
            if (top && sameEntry(top, currentEntry)) return previous;
            return [
                currentEntry,
                ...previous.filter((entry) => entry.blockId !== currentEntry.blockId),
            ].slice(0, MAX_HISTORY_ENTRIES);
        });
    }, [status, currentEntry]);

    // New sentence → top, unless the learner scrolled down on purpose.
    useEffect(() => {
        if (status !== 'ready' || !blockId || !stickToTopRef.current) return;
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [status, blockId, open]);

    const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        stickToTopRef.current = event.currentTarget.scrollTop <= 4;
    }, []);

    const entries = useMemo(() => {
        const older = history.filter((entry) => entry.blockId !== blockId);
        return currentEntry ? [currentEntry, ...older] : older;
    }, [currentEntry, history, blockId]);

    // Two lookups: the exact id the watch panel writes, plus the word text so
    // a word saved from the transcript / word book still shows a filled star
    // (the word book is one global list, not one list per surface).
    const favoritesById = useMemo(() => {
        const map = new Map<string, FavoriteItem>();
        for (const favorite of favorites) map.set(favorite.id, favorite);
        return map;
    }, [favorites]);
    const favoritesByWord = useMemo(() => {
        const map = new Map<string, FavoriteItem>();
        for (const favorite of favorites) {
            if (favorite.type && favorite.type !== 'vocabulary') continue;
            const key = favoriteWordKey(favorite.en_text ?? '');
            if (key && !map.has(key)) map.set(key, favorite);
        }
        return map;
    }, [favorites]);

    const favoriteOf = useCallback((word: string) => (
        favoritesById.get(`vocab-${videoId}-${word}`) ?? favoritesByWord.get(favoriteWordKey(word))
    ), [favoritesById, favoritesByWord, videoId]);

    const flash = useCallback((key: string, message: string) => {
        setFeedback((previous) => ({ ...previous, [key]: message }));
        const timers = feedbackTimersRef.current;
        const existing = timers.get(key);
        if (existing !== undefined) window.clearTimeout(existing);
        timers.set(key, window.setTimeout(() => {
            timers.delete(key);
            setFeedback((previous) => {
                if (!(key in previous)) return previous;
                const next = { ...previous };
                delete next[key];
                return next;
            });
        }, 4000));
    }, []);

    useEffect(() => () => {
        for (const timer of feedbackTimersRef.current.values()) window.clearTimeout(timer);
        feedbackTimersRef.current.clear();
    }, []);

    const toggleFavorite = useCallback(async (key: string, word: string, gloss: string) => {
        if (!word || !videoId) return;
        // M1 ⑧: guests may watch but not save; the row explains it instead of
        // letting the backend reject an invisible write.
        if (isGuest) {
            flash(key, t('watchMode.favoriteLoginHint'));
            return;
        }
        if (inFlightRef.current.has(key)) return;
        inFlightRef.current.add(key);
        setBusyKeys((previous) => new Set(previous).add(key));
        setFeedback((previous) => {
            if (!(key in previous)) return previous;
            const next = { ...previous };
            delete next[key];
            return next;
        });
        try {
            const existing = favoriteOf(word);
            if (existing) {
                // App rolls the optimistic row back; a falsy result means the
                // star came back and the row must say why.
                const removed = await onRemoveFavorite(existing.id);
                if (!removed) flash(key, t('watchMode.favoriteRemoveFailed'));
                return;
            }
            await onAddFavorite({
                id: `vocab-${videoId}-${word}`,
                type: 'vocabulary',
                videoId,
                start: Number.isFinite(blockStart) ? blockStart : 0,
                en_text: word,
                zh_text: gloss,
                ...(enText?.trim() ? { context_en: enText.trim() } : {}),
                added_at: Date.now(),
                source_kind: 'video',
                source_ref: videoId,
                ...(sourceTitle?.trim() ? { source_title: sourceTitle.trim() } : {}),
            });
        } catch {
            // App already rolled the optimistic favorite back; explain the row.
            flash(key, t('watchMode.favoriteFailed'));
        } finally {
            inFlightRef.current.delete(key);
            setBusyKeys((previous) => {
                if (!previous.has(key)) return previous;
                const next = new Set(previous);
                next.delete(key);
                return next;
            });
        }
    }, [
        blockStart,
        enText,
        favoriteOf,
        flash,
        isGuest,
        onAddFavorite,
        onRemoveFavorite,
        sourceTitle,
        t,
        videoId,
    ]);

    const wordCount = currentEntry?.words.length ?? 0;

    const body = (
        <GlossBody
            entries={entries}
            currentBlockId={blockId}
            showLanguagePoints={showLanguagePoints}
            status={status}
            onRequestAnalysis={onRequestAnalysis}
            onRequestLogin={onRequestLogin}
            alwaysShowActions={variant === 'drawer'}
            feedback={feedback}
            busyKeys={busyKeys}
            favoriteOf={favoriteOf}
            onToggleFavorite={(key, word, gloss) => { void toggleFavorite(key, word, gloss); }}
        />
    );

    if (variant === 'drawer') {
        return (
            <section
                data-testid="watch-gloss-panel"
                data-variant="drawer"
                data-status={status}
                data-open={open ? 'true' : 'false'}
                aria-label={t('watchMode.drawerAria')}
                className={cn(
                    'mt-auto flex w-full flex-col overflow-hidden rounded-t-[18px] border-t border-line-subtle bg-surface/55 backdrop-blur-xl',
                    open ? 'min-h-0 flex-1' : 'flex-none',
                )}
            >
                <button
                    type="button"
                    data-testid="watch-gloss-drawer-handle"
                    aria-expanded={open}
                    aria-controls="watch-gloss-drawer-body"
                    aria-label={open ? t('watchMode.drawerCollapse') : t('watchMode.drawerExpand')}
                    onClick={() => setOpen((previous) => !previous)}
                    className="flex h-11 w-full flex-none touch-manipulation items-center justify-center text-fg-muted transition-colors hover:text-fg-primary"
                >
                    <span aria-hidden="true" className="h-1 w-10 rounded-full bg-fg-muted/60" />
                </button>
                <GlossHeader wordCount={wordCount} />
                {open && (
                    <div
                        id="watch-gloss-drawer-body"
                        ref={scrollRef}
                        onScroll={handleScroll}
                        data-testid="watch-gloss-scroll"
                        style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}
                        className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-5 pt-0.5"
                    >
                        {body}
                    </div>
                )}
            </section>
        );
    }

    return (
        <aside
            data-testid="watch-gloss-rail"
            data-status={status}
            className="hidden h-full w-[360px] shrink-0 flex-col border-l border-line-subtle bg-surface/40 backdrop-blur-xl xl:flex"
        >
            <GlossHeader wordCount={wordCount} />
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                data-testid="watch-gloss-scroll"
                className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-5 pb-4 pt-1"
            >
                {body}
            </div>
            {status === 'ready' && entries.length > 0 && (
                <p
                    data-testid="watch-gloss-rail-hint"
                    className="flex-none px-5 pb-4 pt-2 text-micro leading-relaxed text-fg-muted"
                >
                    {t('watchMode.railHint')}
                </p>
            )}
        </aside>
    );
};

// Playback ticks the parent every 100ms; the panel only re-renders when the
// sentence, its glosses, the analysis status or the favorites actually change.
export const WatchGlossPanel = React.memo(WatchGlossPanelInner);
