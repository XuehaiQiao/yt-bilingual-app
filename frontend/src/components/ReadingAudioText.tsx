// Sentence-level wrapper for the reading audio bar (specs/037 §5).
//
// The prose readers render each paragraph through the shared `ReadingSurface`
// (specs/039), and the sentence-pack reader renders one sentence at a time.
// Both need the same *outer* structure for listening: the text is split into
// sentences by the shared splitter, and each sentence is wrapped in an inline
// `<span data-audio-sentence data-audio-active>`. This file owns only that span
// recipe; the words inside it stay the single `MarkedWords` renderer.
//
// Consequences:
//   - the wrapper is inline and adds no block box, so the rendered text, the
//     DOM order and the word-click targets are unchanged;
//   - difficulty highlights, glossed ruby and language-point underlines keep
//     working, because `MarkedWords` is still the component painting the words;
//   - the active-sentence background is the brand token (`bg-brand/15`), never a
//     base palette colour (design-gate G1 T-04), and it is a colour change only
//     (no movement; reduced motion needs no special case).
//
// The old `ReadingAudioText` paragraph renderer was removed in specs/039 phase
// 2: book readers now render paragraphs through `ReadingSurface` too, so a
// second paragraph-level sentence renderer would be duplicate rendering.
import type { ReactNode } from 'react';
import { cn } from './TranscriptBlock';

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
