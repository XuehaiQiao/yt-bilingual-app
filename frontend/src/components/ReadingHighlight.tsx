// Reading highlight UI (user request 2026-11-17 #3).
//
// `ReadingHighlight` is the single wrapper the four readers use around
// `ClickableWords`: the hook decides which words are above the learner's
// highlight threshold, this component only paints them (a restrained amber
// underline/background that never interferes with word lookup or the
// two-column layout). `ReadingHighlightToggle` is the toolbar switch shared by
// the article and book readers; it persists through the hook.
import { Highlighter } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { ClickableWords, type WordClickHandler } from './TranscriptBlock';

interface ReadingHighlightProps {
    text: string;
    onWordClick: WordClickHandler;
    /** From `useReadingHighlights`; absent/false = plain clickable text. */
    isHighlighted?: (word: string) => boolean;
}

export const ReadingHighlight: React.FC<ReadingHighlightProps> = ({
    text,
    onWordClick,
    isHighlighted,
}) => (
    <ClickableWords
        text={text}
        onWordClick={onWordClick}
        isHighlighted={isHighlighted}
    />
);

interface ReadingHighlightToggleProps {
    enabled: boolean;
    onChange: (next: boolean) => void;
    /** The current stop's CEFR label, e.g. `B1`. */
    levelLabel: string;
    /** Unique per reader so the acceptance test can target each toolbar. */
    testId: string;
}

export const ReadingHighlightToggle: React.FC<ReadingHighlightToggleProps> = ({
    enabled,
    onChange,
    levelLabel,
    testId,
}) => {
    const { t } = useI18n();
    const hint = !enabled
        ? t('reading.highlight.offHint')
        : levelLabel === 'C2'
            ? t('reading.highlight.hintMax')
            : t('reading.highlight.hint', { level: levelLabel });

    return (
        <button
            type="button"
            role="switch"
            aria-checked={enabled}
            aria-label={t('reading.highlight.toggle')}
            data-testid={testId}
            data-enabled={enabled ? '1' : '0'}
            title={hint}
            onClick={() => onChange(!enabled)}
            className={`inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                enabled
                    ? 'border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15'
                    : 'border-white/5 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
            }`}
        >
            <Highlighter className="h-3.5 w-3.5" />
            <span>{t('reading.highlight.toggle')}</span>
            <span
                aria-hidden="true"
                className={`relative inline-flex h-3 w-5 shrink-0 items-center rounded-full transition-colors ${
                    enabled ? 'bg-amber-400/80' : 'bg-zinc-600'
                }`}
            >
                <span
                    className={`absolute h-2 w-2 rounded-full transition-transform ${
                        enabled
                            ? 'translate-x-[0.65rem] bg-zinc-950'
                            : 'translate-x-0.5 bg-zinc-300'
                    }`}
                />
            </span>
        </button>
    );
};
