// Reading-page word-book entry (v1.1 task 6).
//
// Same interaction and visual recipe as the video page's LearningHeader chip:
// clicking navigates to the word book's full page (#/app/<tab>/vocabulary) via
// the App-owned `onOpenWordbook`, exactly like the learning header. The
// right-side drawer that shipped with D6-1 was rejected by the user after
// hands-on testing (2026-11-21): one feature must not have two interaction
// models, and the navigation spec already makes the word book a full page.
//
// Data: App owns the favorites store. The button receives the same array the
// word-book screen gets and counts it through `selectMyWords` — the single
// source ADR-0001 defines (vocabulary favorites themselves, no mastery
// subtraction). A word saved through the global WordPopover updates that state,
// so the count refreshes optimistically with no refetch.
import { BookMarked } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { FavoriteItem } from '../lib/favorites';
import { selectMyWords } from '../lib/myWords';

interface ReadingVocabButtonProps {
    /** Every favorite, as owned by App; only vocabulary entries are counted. */
    favorites: readonly FavoriteItem[];
    /** Navigate to the word-book page — the same entry the video page uses. */
    onOpenWordbook: () => void;
}

export function ReadingVocabButton({ favorites, onOpenWordbook }: ReadingVocabButtonProps) {
    const { t } = useI18n();
    const count = selectMyWords(favorites).length;

    return (
        <button
            type="button"
            data-testid="reading-wordbook"
            onClick={onOpenWordbook}
            aria-label={t('readingVocab.openAria', { count })}
            title={t('readingVocab.openAria', { count })}
            className="inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 rounded-control bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100 transition-colors shrink-0"
        >
            <BookMarked className="w-4 h-4 text-amber-400/90" />
            <span className="hidden sm:inline text-xs font-medium whitespace-nowrap">{t('vocab.title')}</span>
            <span className="text-xs font-medium tabular-nums" data-testid="reading-wordbook-count">
                {count}
            </span>
        </button>
    );
}

export default ReadingVocabButton;
