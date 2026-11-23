// Right-rail panel shared by the four reading surfaces (specs/042).
//
// Replaces the old 「我的收藏/单词本生词」 panel, which listed the word book
// regardless of the page. It now lists the page's own highlighted words
// (unique, with CEFR level and the analysis gloss) and lets the learner save
// one with a star. Saving/removing goes through the App-owned optimistic
// favorite path, so the top-bar word-book count and every other surface update
// without a refresh. Guests get the app's login prompt instead of a write.
//
// The panel is data-only: the caller passes the same text the reader renders
// plus the `useReadingHighlights` answer, so no second difficulty rule exists
// here (specs/004 + specs/028 stay the single source).
import { useMemo, useRef, useState } from 'react';
import { Star } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { cn } from '../../lib/cn';
import type { FavoriteDraft, FavoriteItem, FavoriteSourceKind } from '../../lib/favorites';
import {
    collectHighlightedWords,
    mergeWordGlosses,
    type HighlightedWord,
} from '../../lib/highlightedWords';
import { LevelBadge } from '../VocabularyRows';
import { IconButton } from '../ui/Button';

export interface ReadingHighlightRailProps {
    /** Per-reader test id prefix: `reader` / `library` / `book` / `imported-book`. */
    testIdPrefix: string;
    /** The English text the reader renders, one entry per paragraph/chapter block. */
    texts: readonly string[];
    /** Analysis `wordGlossesByBlock`; merged into a lowercase lookup. */
    glossesByBlock?: Readonly<Record<string, Readonly<Record<string, string>>>> | null;
    /** The reader's 难度标亮 switch; false = the panel explains how to turn it on. */
    enabled: boolean;
    /** From `useReadingHighlights`: owns enabled / failed / mastered filtering. */
    isHighlighted: (word: string) => boolean;
    /** From `useReadingHighlights`: lowercase form → CEFR level. */
    wordLevels: ReadonlyMap<string, string | null>;
    /** App-owned favorites: drives the filled star and the word-book count. */
    favorites: readonly FavoriteItem[];
    /** Favorite provenance for words saved from this page. */
    sourceKind: FavoriteSourceKind;
    sourceRef: string;
    sourceTitle?: string;
    /** Guests may read but not save; the star opens the login prompt instead. */
    isGuest?: boolean;
    onRequestLogin?: () => void;
    /** App-owned optimistic add; resolves after the server write. */
    onAddFavorite: (draft: FavoriteDraft) => Promise<FavoriteItem>;
    /** App-owned optimistic remove; resolves `false` after a rollback. */
    onRemoveFavorite: (id: string) => Promise<boolean>;
}

/**
 * One row: word + level badge, the analysis gloss on a second line, and the
 * star. Removal failures are surfaced by the App-owned toast (single feedback
 * layer); add failures are shown inline because App's add path stays quiet for
 * call sites that own their own feedback (P1-10 contract).
 */
export function ReadingHighlightRail({
    testIdPrefix,
    texts,
    glossesByBlock,
    enabled,
    isHighlighted,
    wordLevels,
    favorites,
    sourceKind,
    sourceRef,
    sourceTitle,
    isGuest = false,
    onRequestLogin,
    onAddFavorite,
    onRemoveFavorite,
}: ReadingHighlightRailProps) {
    const { t, formatNumber } = useI18n();
    const [busyWords, setBusyWords] = useState<ReadonlySet<string>>(() => new Set());
    const [errors, setErrors] = useState<Readonly<Record<string, string>>>({});
    // Synchronous double-click guard: state updates are async, so a second
    // click in the same tick must not send a duplicate POST/DELETE.
    const inFlight = useRef<Set<string>>(new Set());

    const glosses = useMemo(() => mergeWordGlosses(glossesByBlock), [glossesByBlock]);
    const words = useMemo(
        () => collectHighlightedWords(texts, { isHighlighted, wordLevels, glosses }),
        [texts, isHighlighted, wordLevels, glosses],
    );
    // Lookup is by en_text (lowercase), not by id: the same word may already be
    // saved from another page/source, and the word book is one global list.
    const favoritesByWord = useMemo(() => {
        const map = new Map<string, FavoriteItem>();
        for (const favorite of favorites) {
            if (favorite.type !== 'vocabulary') continue;
            const word = favorite.en_text.trim().toLowerCase();
            if (word && !map.has(word)) map.set(word, favorite);
        }
        return map;
    }, [favorites]);

    const markBusy = (word: string, busy: boolean) => {
        setBusyWords((prev) => {
            const next = new Set(prev);
            if (busy) next.add(word);
            else next.delete(word);
            return next;
        });
    };

    const setError = (word: string, message: string | null) => {
        setErrors((prev) => {
            if (!message) {
                if (!(word in prev)) return prev;
                const next = { ...prev };
                delete next[word];
                return next;
            }
            return { ...prev, [word]: message };
        });
    };

    const toggleFavorite = async (item: HighlightedWord) => {
        if (busyWords.has(item.word) || inFlight.current.has(item.word)) return;
        // M1 ⑧: guests may read but not save; ask for an account instead of
        // sending a write the backend would reject.
        if (isGuest) {
            onRequestLogin?.();
            return;
        }
        const existing = favoritesByWord.get(item.word);
        inFlight.current.add(item.word);
        setError(item.word, null);
        markBusy(item.word, true);
        try {
            if (existing) {
                // App rolls the optimistic row back and toasts its own failure,
                // so a falsy result needs no second inline message.
                await onRemoveFavorite(existing.id);
                return;
            }
            await onAddFavorite({
                id: `vocab-${sourceRef}-${item.word}`,
                type: 'vocabulary',
                videoId: sourceRef,
                start: 0,
                en_text: item.word,
                zh_text: item.gloss,
                added_at: Date.now(),
                source_kind: sourceKind,
                source_ref: sourceRef,
                ...(sourceTitle ? { source_title: sourceTitle } : {}),
            });
        } catch {
            // App already removed the optimistic favorite; explain the row.
            setError(item.word, t('reading.highlightRail.failed'));
        } finally {
            inFlight.current.delete(item.word);
            markBusy(item.word, false);
        }
    };

    return (
        <section
            data-testid={`${testIdPrefix}-rail-highlighted`}
            className="rounded-panel border border-line-subtle bg-surface/40 p-4 sm:p-5"
        >
            <h3 className="text-caption font-semibold text-fg-primary">
                {t('reading.highlightRail.title')}
            </h3>
            <p
                data-testid={`${testIdPrefix}-rail-count`}
                className="mt-1 text-micro text-fg-muted"
            >
                {t('reading.highlightRail.total', { count: formatNumber(words.length) })}
            </p>

            {/*
              P2-04's layout acceptance still keys on the pre-042 panel id. Keep
              a transparent (display: contents) anchor so that check keeps
              measuring this rail instead of silently skipping it.
            */}
            <div className="contents" data-testid={`${testIdPrefix}-rail-vocabulary`}>
                {!enabled ? (
                    <div data-testid={`${testIdPrefix}-rail-empty-off`}>
                        <p className="mt-2 text-caption font-medium text-fg-secondary">
                            {t('reading.highlightRail.emptyOff')}
                        </p>
                        <p className="mt-1 text-micro leading-relaxed text-fg-muted">
                            {t('reading.highlightRail.emptyOffHint')}
                        </p>
                    </div>
                ) : words.length === 0 ? (
                    <div data-testid={`${testIdPrefix}-rail-empty`}>
                        <p className="mt-2 text-caption font-medium text-fg-secondary">
                            {t('reading.highlightRail.empty')}
                        </p>
                        <p className="mt-1 text-micro leading-relaxed text-fg-muted">
                            {t('reading.highlightRail.emptyHint')}
                        </p>
                    </div>
                ) : (
                    <ul className="mt-2 flex max-h-80 flex-col gap-0.5 overflow-y-auto custom-scrollbar">
                        {words.map((item) => {
                            const favorited = favoritesByWord.has(item.word);
                            const busy = busyWords.has(item.word);
                            const error = errors[item.word];
                            return (
                                <li
                                    key={item.word}
                                    data-testid={`${testIdPrefix}-rail-word-${item.word}`}
                                    data-word={item.word}
                                    data-level={item.level ?? ''}
                                    data-favorited={favorited ? '1' : '0'}
                                    className="flex items-start gap-2 rounded-lg px-2 py-1.5 transition-colors hover:bg-state-hover"
                                >
                                    <div className="min-w-0 flex-1">
                                        <div className="flex min-w-0 items-center gap-1.5">
                                            <span
                                                title={
                                                    item.count > 1
                                                        ? t('reading.highlightRail.occurrences', {
                                                            count: formatNumber(item.count),
                                                        })
                                                        : item.word
                                                }
                                                className="min-w-0 truncate text-ui font-medium text-fg-strong"
                                            >
                                                {item.word}
                                            </span>
                                            {item.level ? (
                                                <LevelBadge
                                                    level={item.level}
                                                    testId={`${testIdPrefix}-rail-level-${item.word}`}
                                                />
                                            ) : (
                                                <span className="text-micro text-fg-muted">—</span>
                                            )}
                                        </div>
                                        <p
                                            data-testid={`${testIdPrefix}-rail-gloss-${item.word}`}
                                            title={item.gloss || undefined}
                                            className={cn(
                                                'mt-0.5 truncate text-micro leading-relaxed',
                                                item.gloss ? 'text-fg-muted' : 'text-fg-disabled',
                                            )}
                                        >
                                            {item.gloss || '—'}
                                        </p>
                                        {error && (
                                            <p
                                                role="alert"
                                                data-testid={`${testIdPrefix}-rail-error-${item.word}`}
                                                className="mt-0.5 text-micro leading-relaxed text-danger-fg"
                                            >
                                                {error}
                                            </p>
                                        )}
                                    </div>
                                    <span
                                        className="inline-flex shrink-0"
                                        title={
                                            isGuest
                                                ? t('reading.highlightRail.guest')
                                                : favorited
                                                    ? t('reading.highlightRail.remove')
                                                    : t('reading.highlightRail.add')
                                        }
                                    >
                                        <IconButton
                                            size="sm"
                                            ariaLabel={
                                                favorited
                                                    ? t('reading.highlightRail.remove')
                                                    : t('reading.highlightRail.add')
                                            }
                                            ariaPressed={favorited}
                                            testId={`${testIdPrefix}-rail-star-${item.word}`}
                                            disabled={!sourceRef || busy}
                                            loading={busy}
                                            onClick={() => { void toggleFavorite(item); }}
                                        >
                                            <Star
                                                aria-hidden="true"
                                                className={cn(
                                                    'h-4 w-4',
                                                    favorited
                                                        ? 'fill-warning-fg text-warning-fg'
                                                        : 'text-fg-muted',
                                                )}
                                            />
                                        </IconButton>
                                    </span>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>
        </section>
    );
}

export default ReadingHighlightRail;
