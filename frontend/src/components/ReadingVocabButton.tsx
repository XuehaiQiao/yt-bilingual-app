// Reading-page word-book entry (v1.1 task 6, decision D6-1).
//
// The video page already keeps the word book one click away from its header
// (LearningHeader.tsx); reading pages had no entry at all, so a word saved
// mid-article could only be found by leaving the reader. This button reuses
// that chip recipe and opens a right-side drawer instead of navigating, so
// reading is never interrupted (D6-1).
//
// Data: App owns the favorites store. The button receives the same array the
// word-book screen gets, keeps only `type === 'vocabulary'` (the word book
// neither lists nor counts sentence favorites), and derives both the count and
// the newest-first list from it. A word saved through the global WordPopover
// updates that state, so the count/list refresh optimistically with no refetch.
import { useMemo, useState } from 'react';
import { BookMarked } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { splitIpaAndMeaning } from '../lib/favoriteSource';
import type { FavoriteItem } from '../lib/favorites';
import { Dialog } from './ui/Dialog';

/** How many of the newest saved words the drawer lists. */
const RECENT_LIMIT = 20;

interface ReadingVocabButtonProps {
    /** Every favorite, as owned by App; only vocabulary entries are shown. */
    favorites: readonly FavoriteItem[];
}

export function ReadingVocabButton({ favorites }: ReadingVocabButtonProps) {
    const { t, formatNumber } = useI18n();
    const [open, setOpen] = useState(false);

    const words = useMemo(
        () =>
            favorites
                .filter((favorite) => favorite.type === 'vocabulary')
                .sort((a, b) => (b.added_at ?? 0) - (a.added_at ?? 0)),
        [favorites],
    );
    const recent = words.slice(0, RECENT_LIMIT);
    const remaining = words.length - recent.length;
    const label = t('vocab.title');
    const count = formatNumber(words.length);

    return (
        <>
            <button
                type="button"
                data-testid="reading-wordbook"
                onClick={() => setOpen(true)}
                aria-label={t('readingVocab.openAria', { count })}
                title={t('readingVocab.openAria', { count })}
                className="inline-flex items-center gap-1.5 h-9 px-2 sm:px-3 rounded-control bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100 transition-colors shrink-0"
            >
                <BookMarked className="w-4 h-4 text-amber-400/90" />
                <span className="hidden sm:inline text-xs font-medium whitespace-nowrap">{label}</span>
                <span className="text-xs font-medium tabular-nums" data-testid="reading-wordbook-count">
                    {count}
                </span>
            </button>

            <Dialog
                open={open}
                onClose={() => setOpen(false)}
                title={label}
                description={t('readingVocab.drawerHint', { count })}
                side="right"
                testId="reading-wordbook-drawer"
                closeLabel={t('common.close')}
            >
                {recent.length === 0 ? (
                    <div
                        data-testid="reading-wordbook-empty"
                        className="flex flex-col items-center justify-center px-4 py-16 text-center"
                    >
                        <BookMarked className="w-8 h-8 text-zinc-700" aria-hidden="true" />
                        <p className="mt-3 text-sm font-medium text-zinc-400">{t('readingVocab.empty')}</p>
                        <p className="mt-1 max-w-[14rem] text-xs leading-relaxed text-zinc-600">
                            {t('readingVocab.emptyHint')}
                        </p>
                    </div>
                ) : (
                    <>
                        <ul
                            data-testid="reading-wordbook-list"
                            className="overflow-hidden rounded-card border border-white/5 bg-zinc-900/40 divide-y divide-white/5"
                        >
                            {recent.map((favorite) => {
                                const { ipa, meaning } = splitIpaAndMeaning(favorite.zh_text);
                                return (
                                    <li
                                        key={favorite.id}
                                        data-testid="reading-wordbook-word"
                                        className="flex min-w-0 items-baseline gap-2 px-3.5 py-2.5"
                                    >
                                        <span className="max-w-[45%] shrink-0 truncate text-[15px] font-semibold text-zinc-100">
                                            {favorite.en_text}
                                        </span>
                                        {ipa && (
                                            <span className="hidden max-w-[32%] shrink-0 truncate text-xs text-zinc-500 sm:inline">
                                                {ipa}
                                            </span>
                                        )}
                                        <span className="min-w-0 flex-1 truncate text-sm text-zinc-400">
                                            {meaning || '—'}
                                        </span>
                                    </li>
                                );
                            })}
                        </ul>
                        {remaining > 0 && (
                            <p className="mt-3 text-center text-[11px] text-zinc-600">
                                {t('readingVocab.more', { count: formatNumber(remaining) })}
                            </p>
                        )}
                    </>
                )}
            </Dialog>
        </>
    );
}

export default ReadingVocabButton;
