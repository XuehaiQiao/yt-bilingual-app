import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, LogIn, Sparkles, Star } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { cn } from '../lib/cn';
import type { FavoriteDraft, FavoriteItem } from '../lib/favorites';
import {
    addIgnored,
    getIgnoredWords,
    normalizeIgnoredWord,
    refreshIgnored,
    removeIgnored,
    useIgnoredWords,
} from '../lib/ignoredWords';
import { setWordMastered } from '../lib/review';
import { writeGuestMastered } from '../lib/wordMastery';
import { DEFAULT_WATCH_SPLIT_RATIO, watchRailWidthCss } from '../lib/layout';
import type { InlineLanguagePoint } from './TranscriptBlock';
import type { TeachingNotesStatus } from './TeachingNotesPanel';

interface WatchGlossPanelProps {
    /**
     * `rail` — the ≥1280 fixed right column (width driven by the P2-25 split
     *          ratio: the remainder of the row, clamped to 280–560px).
     * `drawer` — the <1280 bottom sheet below the 16:9 picture (specs/045 §5).
     * P2-16 removed the old floating pill/panel over the media.
     */
    variant?: 'rail' | 'drawer';
    /**
     * P2-25: CSS width for the rail, computed by App from the split ratio
     * (`watchRailWidthCss`). The drawer ignores it and keeps `w-full`.
     */
    railWidth?: string;
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
    /**
     * P2-19: the review deck's target language (App's live `targetLang`). The
     * mastered PATCH is scoped by it, and every read-back uses the same value.
     */
    targetLang: string;
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

/**
 * P2-21: each row sits on a low-contrast rounded card. It is a background, not
 * a divider: the row keeps no border and the entry keeps none either, so the
 * P2-12 "no card chrome / no dividers" contract only gains one flat surface
 * layer. The current sentence is a touch stronger than history.
 */
const ROW_CARD_CLASS = 'rounded-control bg-surface-2/35';
const ROW_CARD_CURRENT_CLASS = 'rounded-control bg-surface-2/50';

/** P2-16: current sentence full strength; history fades with age (specs/045 §4.3). */
const HISTORY_OPACITY = 0.55;
const HISTORY_OPACITY_STEP = 0.035;
const HISTORY_OPACITY_FLOOR = 0.32;

/**
 * P2-17: the gloss rows scale with the viewport instead of sitting at the old
 * 14/13px token sizes. The fractions are viewport widths, not container
 * queries: the 360px rail keeps its width, so a 1440/1920 screen gets a larger
 * row without making the rail wider (the user asked for "随屏幕尺寸变化").
 *   word / phrase  clamp(1rem, 0.8vw + 0.5rem, 1.375rem)  → 16px … 22px
 *   definition     clamp(0.875rem, 0.55vw + 0.5rem, 1.125rem) → 14px … 18px
 * `text-ui` / `text-caption` stay on the elements as the no-clamp fallback.
 */
const WORD_FLUID_SIZE = 'clamp(1rem, 0.8vw + 0.5rem, 1.375rem)';
const GLOSS_FLUID_SIZE = 'clamp(0.875rem, 0.55vw + 0.5rem, 1.125rem)';

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

/**
 * P2-19: one row message slot with the surface that produced it. Mastery and
 * favorites write failures both surface under the row, but each keeps its own
 * stable test id (`watch-gloss-favorite-error` / `watch-gloss-mastered-error`).
 */
interface RowFeedbackEntry {
    message: string;
    testId: 'watch-gloss-favorite-error' | 'watch-gloss-mastered-error';
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
    feedback: Readonly<Record<string, RowFeedbackEntry>>;
    busyKeys: ReadonlySet<string>;
    masteredBusyKeys: ReadonlySet<string>;
    favoriteOf: (word: string) => FavoriteItem | undefined;
    /** P2-19: shared `useIgnoredWords` membership, normalized per word. */
    masteredOf: (word: string) => boolean;
    onToggleFavorite: (key: string, word: string, gloss: string) => void;
    onToggleMastered: (key: string, word: string, gloss: string) => void;
}

/**
 * P2-16: the favorite star is revealed by hover/focus on the rail and stays
 * visible on the touch drawer (there is no hover on a phone). P2-21 keeps it
 * discoverable on the rail at rest (opacity .6 → 1 on hover/focus). A failed
 * write has already been rolled back by App, so the star returns to its empty
 * state and the row explains what happened inline.
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
                'flex shrink-0 items-center justify-center rounded-control transition-opacity motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60',
                // P2-21: the rail keeps the action quietly discoverable
                // (opacity ≥ .6) instead of hiding it completely; hover/focus
                // brings it to full strength.
                alwaysShow ? 'opacity-100' : 'opacity-60 group-hover:opacity-100 group-focus-within:opacity-100',
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

/**
 * P2-19: 「我已掌握」 sits beside the favorite star in the same `ml-auto`
 * action group. It is one circle + check glyph in both states; the mastered
 * state is a solid success-green circle, the unmarked state only a hollow
 * ring. The 44px box is the touch target on the drawer; the rail is hover /
 * focus revealed like the star. Writes are owned by the panel: the state comes
 * from the shared ignored-words store, never from a local mirror, so the
 * word book / reading highlights / history rows all read the same mark.
 */
const MasteredButton: React.FC<{
    word: string;
    mastered: boolean;
    busy: boolean;
    alwaysShow: boolean;
    onToggle: () => void;
}> = ({ word, mastered, busy, alwaysShow, onToggle }) => {
    const { t } = useI18n();
    const label = mastered
        ? t('watchMode.masteredRemove', { word })
        : t('watchMode.masteredAdd', { word });
    return (
        <button
            type="button"
            data-testid="watch-gloss-mastered"
            data-word={word}
            data-mastered={mastered ? 'true' : 'false'}
            aria-label={label}
            aria-pressed={mastered}
            aria-busy={busy || undefined}
            title={label}
            disabled={busy}
            onClick={(event) => {
                event.stopPropagation();
                onToggle();
            }}
            className={cn(
                'flex shrink-0 items-center justify-center rounded-full transition-opacity motion-reduce:transition-none',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-success/50',
                alwaysShow ? 'opacity-100' : 'opacity-60 group-hover:opacity-100 group-focus-within:opacity-100',
                alwaysShow ? 'h-11 w-11' : 'h-8 w-8',
                busy && 'opacity-60',
            )}
        >
            <span
                data-testid="watch-gloss-mastered-indicator"
                data-state={mastered ? 'checked' : 'unchecked'}
                aria-hidden="true"
                className={cn(
                    'inline-flex items-center justify-center rounded-full border transition-colors motion-reduce:transition-none',
                    alwaysShow ? 'h-6 w-6' : 'h-5 w-5',
                    mastered
                        ? 'border-success bg-success text-app'
                        : 'border-line-strong text-fg-muted hover:border-success/50 hover:text-success-fg',
                )}
            >
                <Check className="h-3.5 w-3.5" strokeWidth={2.5} aria-hidden="true" />
            </span>
        </button>
    );
};

const RowFeedback: React.FC<{ entry?: RowFeedbackEntry }> = ({ entry }) => (
    entry ? (
        <p
            role="alert"
            data-testid={entry.testId}
            className="mt-0.5 pl-3 text-micro leading-relaxed text-danger-fg"
        >
            {entry.message}
        </p>
    ) : null
);

/**
 * P2-17: one unified row for both kinds of entry — the word / phrase on the
 * left, its definition on the right, same line, the definition wrapping and
 * right-aligned. Before this the language point stacked its meaning under the
 * phrase while vocabulary put it beside the word; both now share this row, the
 * 2px current-sentence marker, the favorite star and the inline feedback.
 *
 * P2-21: the row carries a low-contrast rounded card background (current
 * sentence slightly stronger) and the list leaves 4px between rows; the card
 * is a surface, never a border/divider, and the actions never shrink the
 * label/definition columns (`shrink-0` action group + `min-w-0` text).
 */
const GlossRow: React.FC<{
    testId: 'watch-gloss-word' | 'watch-gloss-language-point';
    kind: 'word' | 'point';
    label: string;
    gloss: string;
    isCurrent: boolean;
    alwaysShowActions: boolean;
    favorited: boolean;
    busy: boolean;
    mastered: boolean;
    masteredBusy: boolean;
    feedback?: RowFeedbackEntry;
    onToggle: () => void;
    onToggleMastered: () => void;
}> = ({
    testId,
    kind,
    label,
    gloss,
    isCurrent,
    alwaysShowActions,
    favorited,
    busy,
    mastered,
    masteredBusy,
    feedback,
    onToggle,
    onToggleMastered,
}) => (
    <li className="min-w-0">
        <div
            data-testid={testId}
            data-word={kind === 'word' ? label : undefined}
            data-current={isCurrent ? 'true' : 'false'}
            className={cn(
                'group relative flex min-w-0 items-start gap-2 py-1.5 pl-3 pr-2.5',
                isCurrent ? ROW_CARD_CURRENT_CLASS : ROW_CARD_CLASS,
            )}
        >
            {isCurrent && (
                <span
                    aria-hidden="true"
                    data-testid={kind === 'word' ? 'watch-gloss-current-marker' : undefined}
                    className={cn(
                        'absolute bottom-1 left-0 top-1 w-0.5 rounded-full',
                        kind === 'word' ? 'bg-warning-fg/80' : 'bg-sky-400/70',
                    )}
                />
            )}
            <span
                data-testid={kind === 'word' ? 'watch-gloss-word-text' : 'watch-gloss-point-text'}
                style={{ fontSize: WORD_FLUID_SIZE }}
                className={cn(
                    'min-w-0 break-words text-ui font-medium leading-snug',
                    kind === 'word' ? 'text-warning-fg' : 'text-sky-300',
                )}
            >
                {label}
            </span>
            <span
                data-testid="watch-gloss-definition"
                style={{ fontSize: GLOSS_FLUID_SIZE }}
                className="min-w-0 flex-1 break-words text-right text-caption leading-relaxed text-fg-secondary"
            >
                {gloss}
            </span>
            <div className="ml-auto flex shrink-0 items-center gap-0.5">
                <FavoriteButton
                    word={label}
                    gloss={gloss}
                    state={{ favorited, busy }}
                    alwaysShow={alwaysShowActions}
                    onToggle={onToggle}
                />
                <MasteredButton
                    word={label}
                    mastered={mastered}
                    busy={masteredBusy}
                    alwaysShow={alwaysShowActions}
                    onToggle={onToggleMastered}
                />
            </div>
        </div>
        <RowFeedback entry={feedback} />
    </li>
);

/**
 * One sentence's block in the rolling gloss list. P2-12 stripped the chrome:
 * no sentence context, no section headings, no kind badges and no empty
 * placeholders. P2-16 adds the current-sentence marker (a 2px bar, never a
 * border) and the hover/focus favorite star; history dims with age. P2-17
 * unifies vocabulary and language-point rows into one left-label / right-
 * definition line (specs/045 §4.3). P2-21 adds the row card background and the
 * 4px row gap; the entry itself still has no border/background/divider.
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
    masteredBusyKeys,
    favoriteOf,
    masteredOf,
    onToggleFavorite,
    onToggleMastered,
}) => {
    const points = showLanguagePoints ? entry.points : [];

    const rowFeedback = (word: string) => feedback[`${entry.blockId}:${word}`];
    const rowBusy = (word: string) => busyKeys.has(`${entry.blockId}:${word}`);
    const rowMasteredBusy = (word: string) => masteredBusyKeys.has(`${entry.blockId}:${word}`);
    const rowFavorite = (word: string) => Boolean(favoriteOf(word));
    const rowMastered = (word: string) => masteredOf(word);
    const rowToggle = (word: string, gloss: string) => onToggleFavorite(
        `${entry.blockId}:${word}`,
        word,
        gloss,
    );
    const rowToggleMastered = (word: string, gloss: string) => onToggleMastered(
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
                <ul data-testid="watch-gloss-words" className="space-y-1">
                    {entry.words.map(([word, gloss]) => (
                        <GlossRow
                            key={word}
                            testId="watch-gloss-word"
                            kind="word"
                            label={word}
                            gloss={gloss}
                            isCurrent={isCurrent}
                            alwaysShowActions={alwaysShowActions}
                            favorited={rowFavorite(word)}
                            busy={rowBusy(word)}
                            mastered={rowMastered(word)}
                            masteredBusy={rowMasteredBusy(word)}
                            feedback={rowFeedback(word)}
                            onToggle={() => rowToggle(word, gloss)}
                            onToggleMastered={() => rowToggleMastered(word, gloss)}
                        />
                    ))}
                </ul>
            )}
            {points.length > 0 && (
                <ul
                    data-testid="watch-gloss-language-points"
                    className={entry.words.length > 0 ? 'mt-1 space-y-1' : 'space-y-1'}
                >
                    {points.map((point, index) => (
                        <GlossRow
                            key={`${point.text}-${index}`}
                            testId="watch-gloss-language-point"
                            kind="point"
                            label={point.text}
                            gloss={point.meaning ?? ''}
                            isCurrent={isCurrent}
                            alwaysShowActions={alwaysShowActions}
                            favorited={rowFavorite(point.text)}
                            busy={rowBusy(point.text)}
                            mastered={rowMastered(point.text)}
                            masteredBusy={rowMasteredBusy(point.text)}
                            feedback={rowFeedback(point.text)}
                            onToggle={() => rowToggle(point.text, point.meaning ?? '')}
                            onToggleMastered={() => rowToggleMastered(point.text, point.meaning ?? '')}
                        />
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
    feedback: Readonly<Record<string, RowFeedbackEntry>>;
    busyKeys: ReadonlySet<string>;
    masteredBusyKeys: ReadonlySet<string>;
    favoriteOf: (word: string) => FavoriteItem | undefined;
    masteredOf: (word: string) => boolean;
    onToggleFavorite: (key: string, word: string, gloss: string) => void;
    onToggleMastered: (key: string, word: string, gloss: string) => void;
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
    masteredBusyKeys,
    favoriteOf,
    masteredOf,
    onToggleFavorite,
    onToggleMastered,
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
                        masteredBusyKeys={masteredBusyKeys}
                        favoriteOf={favoriteOf}
                        masteredOf={masteredOf}
                        onToggleFavorite={onToggleFavorite}
                        onToggleMastered={onToggleMastered}
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
            <h2 className="min-w-0 truncate text-dialog font-semibold tracking-tight text-fg-primary">
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
 * it the target design: a rail with 「滚动词条」+ 本句词数, a 2px marker on
 * the current sentence, fading history and a one-click favorite star, while
 * the <1280 presentation becomes a bottom drawer under a top-pinned 16:9
 * picture instead of a floating layer over the media. P2-21 adds the row card
 * background and keeps the rail actions at opacity .6 (1 on hover/focus).
 * P2-25 replaced the fixed 360px width: the rail now takes the remainder of
 * the watch row and App passes `railWidth` (280–560px clamp), so the learner
 * can trade picture width for the gloss window with the split divider.
 *
 * It never issues an AI call of its own — the only action it exposes is the
 * existing cached analysis entry (`onRequestAnalysis`).
 */
const WatchGlossPanelInner: React.FC<WatchGlossPanelProps> = ({
    variant = 'rail',
    railWidth,
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
    targetLang,
}) => {
    const { t } = useI18n();
    // P2-19: the single shared source of 已掌握 membership (server list for
    // signed-in users, the guest local table otherwise). Every history row for
    // the same word re-renders from this store, never from a local mirror.
    const ignored = useIgnoredWords();
    // P2-16: the drawer is expanded by default — on a phone a collapsed drawer
    // is effectively no gloss window at all (specs/045 §5).
    const [open, setOpen] = useState(true);
    const [history, setHistory] = useState<WatchGlossEntry[]>([]);
    const [feedback, setFeedback] = useState<Readonly<Record<string, RowFeedbackEntry>>>({});
    const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
    const [masteredBusyKeys, setMasteredBusyKeys] = useState<ReadonlySet<string>>(() => new Set());
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // True while the newest sentence may pull the window back to the top; a
    // manual scroll down turns it off until the learner scrolls back up.
    const stickToTopRef = useRef(true);
    const lastVideoRef = useRef<string | null>(videoId ?? null);
    const inFlightRef = useRef<Set<string>>(new Set());
    const masteredInFlightRef = useRef<Set<string>>(new Set());
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

    // P2-19: exact casefolded membership, the same rule the reading highlight
    // filter / word book use (`normalizeIgnoredWord` = trim + lower-case).
    const masteredOf = useCallback((word: string) => {
        const normalized = normalizeIgnoredWord(word);
        return normalized.length > 0 && ignored.words.has(normalized);
    }, [ignored.words]);

    /** Drop the row's current message before a new write (one slot per row). */
    const clearRowFeedback = useCallback((key: string) => {
        setFeedback((previous) => {
            if (!(key in previous)) return previous;
            const next = { ...previous };
            delete next[key];
            return next;
        });
    }, []);

    const flash = useCallback((
        key: string,
        message: string,
        testId: RowFeedbackEntry['testId'] = 'watch-gloss-favorite-error',
    ) => {
        setFeedback((previous) => ({ ...previous, [key]: { message, testId } }));
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
        clearRowFeedback(key);
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
        clearRowFeedback,
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

    /**
     * P2-19 write path for one row's 已掌握 mark.
     *
     * Signed-in: PATCH `{lemma, mastered, targetLang, definition}` (the meaning
     * snapshot is the row's gloss, P0-13) and then re-read the authoritative
     * mastered list with `refreshIgnored(targetLang)`. The response is
     * authoritative for the post-write mark (specs/013).
     * Guest: the existing local table (`writeGuestMastered`) only — never the
     * API — then the same `refreshIgnored()` so the shared store re-renders.
     * Throws so the caller can show the localized row message and roll back.
     */
    const applyMastered = useCallback(async (word: string, mastered: boolean, gloss: string) => {
        if (isGuest) {
            writeGuestMastered(word, mastered);
            await refreshIgnored();
            return;
        }
        const result = await setWordMastered({
            lemma: word,
            mastered,
            targetLang,
            definition: gloss.trim() || undefined,
        });
        const masteredNow = result.word.mastered === true;
        await refreshIgnored(targetLang);
        if (masteredNow !== mastered) throw new Error(t('watchMode.masteredFailed'));
    }, [isGuest, t, targetLang]);

    /**
     * P2-19 reverse write after a failed mutual-exclusion DELETE: put the mark
     * back to `false` through the same mode's write path. Returns `true` only
     * when the undo landed (guest: table membership; signed-in: PATCH response
     * + the re-read list) so the row copy never claims an undo that did not
     * happen.
     */
    const rollbackMastered = useCallback(async (word: string, gloss: string): Promise<boolean> => {
        const normalized = normalizeIgnoredWord(word);
        try {
            if (isGuest) {
                writeGuestMastered(word, false);
                await refreshIgnored();
            } else {
                const rollback = await setWordMastered({
                    lemma: word,
                    mastered: false,
                    targetLang,
                    definition: gloss.trim() || undefined,
                });
                if (rollback.word.mastered !== false) return false;
                await refreshIgnored(targetLang);
            }
            return !getIgnoredWords().has(normalized);
        } catch {
            // Best effort; stay honest about the failed rollback.
            return false;
        }
    }, [isGuest, targetLang]);

    const toggleMastered = useCallback(async (key: string, word: string, gloss: string) => {
        const lemma = word.trim();
        if (!lemma || masteredInFlightRef.current.has(key)) return;
        const normalized = normalizeIgnoredWord(lemma);
        const wasMastered = getIgnoredWords().has(normalized);
        const next = !wasMastered;
        masteredInFlightRef.current.add(key);
        setMasteredBusyKeys((previous) => new Set(previous).add(key));
        clearRowFeedback(key);
        // Signed-in readers get the immediate page update from the store; the
        // guest write below emits its own store update. A failed write restores
        // the pre-click state (never a success-looking row).
        if (!isGuest) {
            if (next) addIgnored(lemma);
            else removeIgnored(lemma);
        }
        try {
            try {
                await applyMastered(lemma, next, gloss);
            } catch {
                if (wasMastered) addIgnored(lemma);
                else removeIgnored(lemma);
                flash(key, t('watchMode.masteredFailed'), 'watch-gloss-mastered-error');
                return;
            }
            // Undoing a mark never brings the favorite back (ADR-0001).
            if (!next) return;
            // specs/005 §已掌握与收藏互斥: a mastered word is not a favorite.
            // Remove the same word's favorite AFTER the mark landed.
            const favorite = favoriteOf(lemma);
            if (!favorite) return;
            let removed = false;
            try {
                removed = await onRemoveFavorite(favorite.id);
            } catch {
                // App's remove path resolves `false`; a throw is treated the
                // same way (the star was rolled back, the mark must be undone).
                removed = false;
            }
            if (removed) return;
            // The DELETE failed and App restored the star: undo the mark rather
            // than leave the word in both states.
            const rolledBack = await rollbackMastered(lemma, gloss);
            flash(
                key,
                t(rolledBack
                    ? 'watchMode.masteredFavoriteFailed'
                    : 'watchMode.masteredFavoriteRollbackFailed'),
                'watch-gloss-mastered-error',
            );
        } finally {
            masteredInFlightRef.current.delete(key);
            setMasteredBusyKeys((previous) => {
                if (!previous.has(key)) return previous;
                const nextBusy = new Set(previous);
                nextBusy.delete(key);
                return nextBusy;
            });
        }
    }, [
        applyMastered,
        clearRowFeedback,
        favoriteOf,
        flash,
        isGuest,
        onRemoveFavorite,
        rollbackMastered,
        t,
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
            masteredBusyKeys={masteredBusyKeys}
            favoriteOf={favoriteOf}
            masteredOf={masteredOf}
            onToggleFavorite={(key, word, gloss) => { void toggleFavorite(key, word, gloss); }}
            onToggleMastered={(key, word, gloss) => { void toggleMastered(key, word, gloss); }}
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
            style={{ width: railWidth ?? watchRailWidthCss(DEFAULT_WATCH_SPLIT_RATIO) }}
            className="hidden h-full shrink-0 flex-col border-l border-line-subtle bg-surface/40 backdrop-blur-xl xl:flex"
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
