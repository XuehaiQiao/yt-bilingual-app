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
import { Switch } from './ui/Switch';
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
    const label = t('reading.highlight.toggle');

    return (
        // The shared `ui/Switch` is the control; the surrounding pill is its
        // label, so the old testid element stays one clickable target (and the
        // readers' acceptance selectors keep working). Amber is the reading
        // highlight accent (docs/design-governance/design-system/components.md
        // C13); `ui/Switch` exposes that warm track as its `warning` tone.
        <label
            data-testid={testId}
            data-enabled={enabled ? '1' : '0'}
            title={hint}
            className={`inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border px-2 text-[11px] font-medium transition-colors ${
                enabled
                    ? 'border-amber-400/25 bg-amber-400/10 text-amber-200 hover:bg-amber-400/15'
                    : 'border-white/5 bg-zinc-800/60 text-zinc-400 hover:text-zinc-200'
            }`}
        >
            <Highlighter aria-hidden="true" className="h-3.5 w-3.5" />
            <span>{label}</span>
            <Switch
                checked={enabled}
                onChange={onChange}
                ariaLabel={label}
                tone="warning"
                className="ml-0.5"
            />
        </label>
    );
};
