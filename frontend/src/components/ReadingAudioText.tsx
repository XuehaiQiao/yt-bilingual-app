// Sentence-level wrapper for the reading audio bar (specs/037 §5).
//
// The four prose readers already render a paragraph through `ReadingHighlight`
// (difficulty marks + language-point ruby + clickable words). This component
// only changes the *outer* structure: the paragraph text is split into
// sentences by the shared splitter, and each sentence is handed back to the
// exact same `ReadingHighlight` renderer, wrapped in an inline
// `<span data-audio-sentence data-audio-active>`. Consequences:
//
//   - the rendered text, the DOM order and the word-click targets are the same
//     as before — the wrapper is inline and adds no block box;
//   - difficulty highlights, glossed ruby and language-point underlines keep
//     working, because `MarkedWords` is still the component painting the words;
//   - the active-sentence background is the brand token (`bg-brand/10`), never a
//     base palette colour (design-gate G1 T-04), and it is a colour change only
//     (no movement; reduced motion needs no special case).
//
// `AudioSentenceSpan` is exported so a surface that already owns a per-sentence
// row (sentence packs) can reuse the same data attributes and the same active
// treatment instead of re-implementing them.
import { useMemo, type ReactNode } from 'react';
import type { InlineLanguagePoint, WordClickHandler } from './TranscriptBlock';
import { cn } from './TranscriptBlock';
import { ReadingHighlight } from './ReadingHighlight';
import { splitSentences } from '../lib/sentenceSplit';

interface AudioSentenceSpanProps {
    /** Index inside the paragraph, matching `ReadingAudioPosition.sentence`. */
    index: number;
    active: boolean;
    children: ReactNode;
}

/** Inline sentence wrapper: the single source of the audio highlight recipe. */
export const AudioSentenceSpan: React.FC<AudioSentenceSpanProps> = ({ index, active, children }) => (
    <span
        data-audio-sentence={String(index)}
        data-audio-active={active ? '1' : undefined}
        className={cn('rounded-md transition-colors duration-200', active && 'bg-brand/15 box-decoration-clone')}
    >
        {children}
    </span>
);

interface ReadingAudioTextProps {
    /** Whole paragraph (English source). */
    text: string;
    /** Index of this paragraph in the array handed to `useReadingAudio`. */
    paragraphIndex: number;
    /** Only `active` is read; the rest of the controller is not needed here. */
    active: { paragraph: number; sentence: number } | null;
    /** Pass-through to the existing paragraph renderer. */
    onWordClick?: WordClickHandler;
    isHighlighted?: (word: string) => boolean;
    languagePoints?: InlineLanguagePoint[];
    showLanguagePoints?: boolean;
    wordGlosses?: Record<string, string>;
}

/**
 * Paragraph rendered sentence by sentence, with the sentence currently being
 * read highlighted. Everything except the outer split is unchanged from
 * `ReadingHighlight`, so word lookup / ruby / difficulty marks cannot regress.
 */
export const ReadingAudioText: React.FC<ReadingAudioTextProps> = ({
    text,
    paragraphIndex,
    active,
    onWordClick,
    isHighlighted,
    languagePoints,
    showLanguagePoints = true,
    wordGlosses,
}) => {
    const sentences = useMemo(() => splitSentences(text), [text]);
    const activeSentence = active && active.paragraph === paragraphIndex ? active.sentence : -1;

    if (sentences.length === 0) {
        return (
            <ReadingHighlight
                text={text}
                onWordClick={onWordClick}
                isHighlighted={isHighlighted}
                languagePoints={languagePoints}
                showLanguagePoints={showLanguagePoints}
                wordGlosses={wordGlosses}
            />
        );
    }

    const nodes: ReactNode[] = [];
    let cursor = 0;
    for (let index = 0; index < sentences.length; index += 1) {
        const sentence = sentences[index];
        if (sentence.start > cursor) {
            // Whitespace between sentences: passed through untouched so the
            // paragraph's text content is identical to the source.
            nodes.push(<span key={`gap-${index}`}>{text.slice(cursor, sentence.start)}</span>);
        }
        nodes.push(
            <AudioSentenceSpan key={`sentence-${index}`} index={index} active={index === activeSentence}>
                <ReadingHighlight
                    text={sentence.text}
                    onWordClick={onWordClick}
                    isHighlighted={isHighlighted}
                    languagePoints={languagePoints}
                    showLanguagePoints={showLanguagePoints}
                    wordGlosses={wordGlosses}
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
