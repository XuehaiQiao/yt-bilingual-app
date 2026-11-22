// Shared reading surface (specs/039 phases 1–2).
//
// One paragraph renderer for every prose reader. Before this component the four
// readers each had their own paragraph loop, their own `MarkedWords` wiring and
// their own sentence highlight wrapper, so "English paragraph" behaved
// differently depending on where it was opened. The shells keep what is
// genuinely theirs (import/translate/progress, chapter index, free-library
// no-account path, upload/cover, toolbar, playback bar); this file only owns:
//
//   - the paragraph loop and the single/bilingual column switch
//     (`BilingualRow`, same scroll container as before);
//   - `MarkedWords` as the single word renderer: clickable words, difficulty
//     amber marks (`isHighlighted`), always-visible language-point ruby and
//     contextual gloss ruby;
//   - the audio-sentence wrapper (`AudioSentenceSpan`): the sentence currently
//     being read gets the brand wash. The playback bar itself stays in the
//     shell, so mounting/ordering of the bar never changes with this refactor;
//   - the per-paragraph DOM contract (`data-paragraph-index`, frozen
//     `data-word-hit` / `data-lookup-*`, `data-audio-sentence`) and the old
//     testid aliases (`<prefix>-paragraph-*`, `-row-*`, `-en-*`, `-translation-*`)
//     so the acceptance scripts keep working.
//
// Shell-specific chrome is injected, not re-implemented: paragraph actions
// (share menu) via `renderParagraphActions`, and the failed-translation retry
// via `onRetryTranslation`. Book shells keep their compact row density through
// `extraParagraphClass` (their old class recipe, merged by tailwind-merge) and
// keep the `data-*-paragraph` attribute their scroll/progress code queries
// through `paragraphIndexAttr`; they do not clone the paragraph DOM.
// Colours come from the semantic tokens (design-gate G1).
import { useMemo, type ReactNode } from 'react';
import { AlertCircle, RefreshCw } from 'lucide-react';
import { useI18n } from '../../i18n/I18nProvider';
import { splitSentences } from '../../lib/sentenceSplit';
import type { ReadingAudioPosition } from '../../lib/useReadingAudio';
import type { ReadingAnalysisStatus } from '../../lib/useReadingAnalysis';
import { AudioSentenceSpan } from '../ReadingAudioText';
import { BilingualRow } from '../BilingualRow';
import {
    MarkedWords,
    cn,
    type InlineLanguagePoint,
    type WordClickHandler,
} from '../TranscriptBlock';

/** One paragraph as the surface renders it (id/index may coincide). */
export interface ReadingSurfaceParagraph {
    /** Stable id used in testids and `data-paragraph-index`. */
    id: number;
    /** Reading/audio position (article `idx`, library/book paragraph index). */
    index: number;
    en: string;
    /** Translation shown in the right column / under the source. */
    zh?: string | null;
    /** Contextual glosses keyed by lower-case word. */
    glosses?: Record<string, string>;
    /** Already-resolved language points for this paragraph. */
    languagePoints?: InlineLanguagePoint[];
    /** The backend stored `[未翻译]` for this paragraph. */
    translationFailed?: boolean;
}

/** `single` = English full width; `two-column` = EN left / ZH right at ≥lg. */
export type ReadingSurfaceLayout = 'single' | 'two-column';

export interface ReadingSurfaceProps {
    paragraphs: readonly ReadingSurfaceParagraph[];
    /** Difficulty predicate from `useReadingHighlights` (shell-owned switch). */
    isHighlighted?: (word: string) => boolean;
    /** Language-point ruby switch (shell-owned). */
    showLanguagePoints?: boolean;
    /**
     * Shared listening state. Only `active` is read here; the bar and its
     * controls stay mounted by the shell (specs/039 §3).
     */
    audio: { active: ReadingAudioPosition | null };
    layout?: ReadingSurfaceLayout;
    /** Hidden translations collapse the row to one column in the shell. */
    showTranslations?: boolean;
    /**
     * Word click. The paragraph is handed back so the shell can keep its
     * provenance/context (source id + title) without wrapping every paragraph.
     */
    onWordClick?: (
        word: string,
        e: React.MouseEvent,
        paragraph: ReadingSurfaceParagraph,
    ) => void;
    /** Prefix for `-paragraph-`, `-row-`, `-en-` testids (e.g. `reader`). */
    testIdPrefix: string;
    /** Override only the translation cell's prefix (library keeps its old id). */
    translationTestIdPrefix?: string;
    /** `lang` of the English cell (article payload language). */
    englishLang?: string;
    /** `lang` of the translation cell; omitted = no attribute. */
    translationLang?: string;
    /** Paragraph the reader is currently on (progress marker). */
    currentParagraphIndex?: number | null;
    /** Shell-owned paragraph actions rendered in the shared top-right slot. */
    renderParagraphActions?: (paragraph: ReadingSurfaceParagraph) => ReactNode;
    /** Shell-owned retry for a failed paragraph translation. */
    onRetryTranslation?: (paragraph: ReadingSurfaceParagraph) => void;
    translating?: boolean;
    /**
     * `login` = a signed-out/expired reader asked for analysis: show the sign-in
     * hint, never an error (specs/039 §3).
     */
    analysisStatus?: ReadingAnalysisStatus;
    /**
     * Attribute name that carries `paragraph.index` on the paragraph node
     * (e.g. `data-book-paragraph`, `data-imported-paragraph`). The book readers'
     * scroll restoration and progress persistence query this attribute, so the
     * shared surface keeps it instead of the shell wrapping the paragraph.
     */
    paragraphIndexAttr?: string;
    /**
     * Replaces the default `space-y-1.5` list spacing. The book readers space
     * their own rows (`mt-4`), which a parent `space-y-*` would override; they
     * pass `''` and keep the row margin in `extraParagraphClass`.
     */
    listClassName?: string;
    /**
     * Extra classes merged onto each paragraph (book readers keep their compact
     * row recipe). `cn` uses tailwind-merge, so a conflicting utility (padding,
     * rounding, hover colour) replaces the default instead of stacking.
     */
    extraParagraphClass?: string;
    /**
     * Translation-cell label shown for a paragraph with no translation while
     * the scope has some (book readers). Omitted = render nothing, as before.
     * The shell decides *when* the state applies by passing the label.
     */
    translationMissingLabel?: string;
}

/**
 * MarkedWords wrapped per sentence for the audio highlight: it keeps the exact
 * word DOM every reader had before (`data-word-hit`, ruby, difficulty marks)
 * and only adds the inline `AudioSentenceSpan` around each sentence. Since
 * specs/039 phase 2 this is the only paragraph-level sentence renderer; the old
 * `ReadingAudioText` component was removed and only `AudioSentenceSpan` stays
 * in `ReadingAudioText.tsx` for the sentence-pack reader.
 */
const SentenceMarkedWords: React.FC<{
    text: string;
    paragraphIndex: number;
    active: ReadingAudioPosition | null;
    onWordClick?: WordClickHandler;
    isHighlighted?: (word: string) => boolean;
    languagePoints?: InlineLanguagePoint[];
    showLanguagePoints: boolean;
    wordGlosses?: Record<string, string>;
}> = ({
    text,
    paragraphIndex,
    active,
    onWordClick,
    isHighlighted,
    languagePoints,
    showLanguagePoints,
    wordGlosses,
}) => {
    const sentences = useMemo(() => splitSentences(text), [text]);
    const activeSentence = active && active.paragraph === paragraphIndex ? active.sentence : -1;

    if (sentences.length === 0) {
        return (
            <MarkedWords
                text={text}
                onWordClick={onWordClick}
                isHighlighted={isHighlighted}
                languagePoints={languagePoints}
                showLanguagePoints={showLanguagePoints}
                hoverSurface="text"
                glossForWord={(word) => wordGlosses?.[word.toLowerCase()]}
            />
        );
    }

    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (let index = 0; index < sentences.length; index += 1) {
        const sentence = sentences[index];
        if (sentence.start > cursor) {
            // Whitespace between sentences stays untouched, so the paragraph's
            // text content is identical to the source.
            nodes.push(<span key={`gap-${index}`}>{text.slice(cursor, sentence.start)}</span>);
        }
        nodes.push(
            <AudioSentenceSpan key={`sentence-${index}`} index={index} active={index === activeSentence}>
                <MarkedWords
                    text={sentence.text}
                    onWordClick={onWordClick}
                    isHighlighted={isHighlighted}
                    languagePoints={languagePoints}
                    showLanguagePoints={showLanguagePoints}
                    hoverSurface="text"
                    glossForWord={(word) => wordGlosses?.[word.toLowerCase()]}
                />
            </AudioSentenceSpan>,
        );
        cursor = sentence.end;
    }
    if (cursor < text.length) {
        nodes.push(<span key="tail">{text.slice(cursor)}</span>);
    }
    return <>{nodes}</>;
};

/**
 * Render the paragraphs of a reading scope. Fetches nothing: analysis comes in
 * as `languagePointsByBlock` / `wordGlossesByBlock` (via `useReadingAnalysis`)
 * and stays a pure rendering concern here.
 */
export const ReadingSurface: React.FC<ReadingSurfaceProps> = ({
    paragraphs,
    isHighlighted,
    showLanguagePoints = true,
    audio,
    layout = 'single',
    showTranslations = true,
    onWordClick,
    testIdPrefix,
    translationTestIdPrefix,
    englishLang = 'en',
    translationLang,
    currentParagraphIndex = null,
    renderParagraphActions,
    onRetryTranslation,
    translating = false,
    analysisStatus,
    paragraphIndexAttr,
    listClassName = 'space-y-1.5',
    extraParagraphClass,
    translationMissingLabel,
}) => {
    const { t } = useI18n();
    const twoColumn = layout === 'two-column';
    const translationPrefix = translationTestIdPrefix ?? `${testIdPrefix}-translation`;

    if (paragraphs.length === 0) return null;

    return (
        <div data-testid={`${testIdPrefix}-paragraphs`} className={listClassName || undefined}>
            {analysisStatus === 'login' && showLanguagePoints && (
                <p
                    data-testid={`${testIdPrefix}-analysis-login`}
                    role="status"
                    className="px-1 text-caption text-fg-secondary"
                >
                    {t('errors.loginRequired')}
                </p>
            )}
            {paragraphs.map((paragraph) => {
                const current = currentParagraphIndex === paragraph.id;
                // Paragraph actions need room in the top-right corner; the
                // free-library reader has none and keeps its old full width.
                const reserved = renderParagraphActions ? 'pr-8' : undefined;
                const wordClick: WordClickHandler | undefined = onWordClick
                    ? (word, e) => onWordClick(word, e, paragraph)
                    : undefined;
                const indexAttributes = paragraphIndexAttr
                    ? { [paragraphIndexAttr]: paragraph.index }
                    : undefined;
                const translationText = showTranslations && paragraph.zh && paragraph.zh.trim()
                    ? paragraph.zh
                    : null;
                const translation = !showTranslations
                    ? undefined
                    : translationText
                        ? (
                            <p
                                data-testid={`${translationPrefix}-${paragraph.id}`}
                                lang={translationLang}
                                className={cn('text-body-zh text-fg-secondary break-words', reserved)}
                            >
                                {translationText}
                            </p>
                        )
                        : paragraph.translationFailed
                            ? (
                                <div className={cn('flex flex-wrap items-center gap-2 text-xs text-warning-fg/90', reserved)}>
                                    <AlertCircle className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                    <span>{t('reader.translation.failed')}</span>
                                    {onRetryTranslation && (
                                        <button
                                            type="button"
                                            data-testid={`${translationPrefix}-retry-${paragraph.id}`}
                                            onClick={() => onRetryTranslation(paragraph)}
                                            disabled={translating}
                                            className="inline-flex h-7 items-center gap-1 rounded-lg border border-warning/20 bg-warning/10 px-2 text-warning-fg transition-colors hover:bg-warning/15 disabled:opacity-50"
                                        >
                                            <RefreshCw className="h-3 w-3" aria-hidden="true" />
                                            {t('reader.translation.retry')}
                                        </button>
                                    )}
                                </div>
                            )
                            : translationMissingLabel
                                ? (
                                    <p
                                        data-testid={`${translationPrefix}-missing-${paragraph.id}`}
                                        className={cn(
                                            'inline-flex items-center gap-1.5 rounded-md border border-warning/20 bg-warning/10 px-2 py-0.5 text-caption text-warning-fg/90',
                                            reserved,
                                        )}
                                    >
                                        <AlertCircle className="h-3 w-3 shrink-0" aria-hidden="true" />
                                        {translationMissingLabel}
                                    </p>
                                )
                                : undefined;

                return (
                    <article
                        key={paragraph.id}
                        {...indexAttributes}
                        data-testid={`${testIdPrefix}-paragraph-${paragraph.id}`}
                        data-paragraph-index={paragraph.id}
                        data-reading-paragraph={paragraph.index}
                        className={cn(
                            'relative group rounded-2xl border px-4 py-4 sm:px-5 transition-colors duration-200',
                            current
                                ? 'border-line-strong bg-surface/50'
                                : 'border-transparent',
                            'hover:border-line-subtle hover:bg-surface/30',
                            extraParagraphClass,
                        )}
                    >
                        {renderParagraphActions && (
                            <div className="absolute right-1.5 top-2.5 z-raised">
                                {renderParagraphActions(paragraph)}
                            </div>
                        )}
                        <BilingualRow
                            twoColumn={twoColumn}
                            testId={`${testIdPrefix}-row-${paragraph.id}`}
                            english={(
                                <p
                                    data-testid={`${testIdPrefix}-en-${paragraph.id}`}
                                    data-lookup-context={paragraph.en}
                                    data-lookup-start={paragraph.index}
                                    lang={englishLang || undefined}
                                    className={cn(
                                        'ruby-safe-line text-base sm:text-section text-fg-primary break-words',
                                        reserved,
                                    )}
                                >
                                    <SentenceMarkedWords
                                        text={paragraph.en}
                                        paragraphIndex={paragraph.index}
                                        active={audio.active}
                                        onWordClick={wordClick}
                                        isHighlighted={isHighlighted}
                                        languagePoints={paragraph.languagePoints}
                                        showLanguagePoints={showLanguagePoints}
                                        wordGlosses={paragraph.glosses}
                                    />
                                </p>
                            )}
                            translation={translation}
                        />
                    </article>
                );
            })}
        </div>
    );
};
