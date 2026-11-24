import React, { useMemo } from 'react';
import { useI18n } from '../i18n/I18nProvider';
import { isUntranslated } from '../lib/transcript';
import type { WatchSubtitleMode } from '../lib/layout';
import type { InlineLanguagePoint } from './TranscriptBlock';

interface WatchSubtitleOverlayProps {
    /** Current sentence only — never the whole transcript (specs/044 §2). */
    enText?: string | null;
    zhText?: string | null;
    /**
     * 字幕三态 (specs/045 §4.2.1). `bilingual` paints English above the Chinese
     * support line, `english` paints only the English line, and `off` renders
     * nothing at all so the video's own captions are used untouched. The watch
     * shell already stops mounting this component when the mode is `off`; the
     * guard here keeps that contract even if a caller forgets.
     */
    mode?: WatchSubtitleMode;
    /**
     * P2-17: the current sentence's glossary, keyed by the lowercase word /
     * phrase the transcript also marks. It is the same map the gloss window
     * and the transcript ruby read, so the in-sentence highlight can never
     * disagree with the rail.
     */
    glosses?: Readonly<Record<string, string>>;
    /** P2-17: the current sentence's idioms / culture notes (blue highlight). */
    languagePoints?: readonly InlineLanguagePoint[];
    /**
     * P2-17: position against the video's lower edge. Pointer / touch / key
     * activity sets `raised` so the sentence clears the native YouTube control
     * strip; 2.5s of stillness sets `dock` so the sentence settles on the
     * lower edge together with the now-hidden native controls. `raised` wins
     * when a caller passes both.
     */
    raised?: boolean;
    dock?: boolean;
}

/**
 * 观影模式的单句字幕窗 (specs/044 §2 / specs/045 §4.2).
 *
 * A scrim pinned near the lower edge of the media stage — a transparent→dark
 * gradient, not a full-width solid band (specs/045 §4.2). It shows only the
 * sentence that is being spoken: English above as the primary line, Chinese
 * below as the supporting line when the bilingual mode is on. It is
 * `pointer-events-none` end to end so the YouTube iframe keeps every click,
 * including the native control bar / native CC entry (P2-15 §3).
 *
 * P2-17 (dock / raise): the native YouTube controls and this sentence share the
 * lower edge, so only one of them may live there at a time. While the learner
 * is moving the pointer / touching / pressing keys the sentence sits at
 * `bottom-[15%]`, above the native control strip. After 2.5s of stillness
 * (App.tsx owns the timer, the same 2.5s contract as the floating top bar) it
 * drops to `bottom-[4%]` — the native controls have faded out by then too. The
 * 200ms bottom transition is removed under `prefers-reduced-motion`, where the
 * two positions switch instantly (specs/044 §2).
 *
 * P2-17 (highlight): matching words from `glosses` are wrapped in an amber
 * `<span>`, matching idioms / culture points from `languagePoints` in a blue
 * one. Ranges never overlap (a language point wins over a word inside it),
 * every character of the original sentence is kept in order, and nothing is
 * built with `dangerouslySetInnerHTML` — matching happens on the text and the
 * slices are React children. The Chinese support line stays plain.
 *
 * P2-11: the sizes are fluid and scale with the media stage's own width through
 * container query units (`cqi`), never the page viewport or JS:
 *   English clamp(1.0625rem, 2cqi, 2rem)       → 17px … 32px
 *   Chinese clamp(0.9375rem, 1.7cqi, 1.625rem) → 15px … 26px
 * 1cqi = 1% of the `video-area` container, which App.tsx marks with
 * `container-type: inline-size`. The `text-section` / `text-body-zh` classes
 * stay as the fixed 17/15px fallback: in engines without container queries the
 * inline declaration is dropped as invalid and the token size applies, so no
 * line can ever end up without a font size. English stays above Chinese at
 * every width because both floors and both slopes keep a gap.
 */
const EN_FLUID_SIZE = 'clamp(1.0625rem, 2cqi, 2rem)';
const ZH_FLUID_SIZE = 'clamp(0.9375rem, 1.7cqi, 1.625rem)';

/** Same position contract as the top bar: 2.5s of stillness (App.tsx timer). */
const RAISED_BOTTOM = '15%';
const DOCKED_BOTTOM = '0%';

type HighlightKind = 'word' | 'point';

interface HighlightRange {
    start: number;
    end: number;
    kind: HighlightKind;
}

/** Treat apostrophes/hyphens as word characters: "habit" must not hit "habits". */
const isWordChar = (character: string) => /[A-Za-z0-9'’-]/.test(character);

/**
 * All non-overlapping occurrences of `needle` in `text`, case-insensitively,
 * with a word-boundary check so a gloss for "walk" never lights up "walking".
 * Phrases ("before breakfast") go through the same path.
 */
const findOccurrences = (text: string, needle: string, kind: HighlightKind): HighlightRange[] => {
    const haystack = text.toLowerCase();
    const target = needle.trim().toLowerCase();
    if (!target) return [];
    const ranges: HighlightRange[] = [];
    let from = 0;
    while (from <= haystack.length - target.length) {
        const index = haystack.indexOf(target, from);
        if (index < 0) break;
        const before = index > 0 ? text[index - 1] : '';
        const after = index + target.length < text.length ? text[index + target.length] : '';
        if ((!before || !isWordChar(before)) && (!after || !isWordChar(after))) {
            ranges.push({ start: index, end: index + target.length, kind });
        }
        from = index + 1;
    }
    return ranges;
};

/**
 * P2-17: language points are painted first, so an idiom/culture phrase always
 * wins over a word inside it (the card's "范围不重叠（点优先）"). Words are
 * tried longest-first so "short walk" beats "walk" when both are glossed. Any
 * candidate that overlaps an accepted range is dropped; the rest are sorted by
 * position and rendered as the original text's slices.
 */
const buildHighlightRanges = (
    text: string,
    glosses: Readonly<Record<string, string>> | undefined,
    languagePoints: readonly InlineLanguagePoint[] | undefined,
): HighlightRange[] => {
    const accepted: HighlightRange[] = [];
    const overlaps = (candidate: HighlightRange) => accepted.some(
        (range) => candidate.start < range.end && range.start < candidate.end,
    );
    const add = (candidate: HighlightRange) => {
        if (!overlaps(candidate)) accepted.push(candidate);
    };

    for (const point of languagePoints ?? []) {
        for (const range of findOccurrences(text, point.text, 'point')) add(range);
    }
    const words = Object.keys(glosses ?? {}).sort((a, b) => b.length - a.length);
    for (const word of words) {
        for (const range of findOccurrences(text, word, 'word')) add(range);
    }
    return accepted.sort((a, b) => a.start - b.start);
};

const HIGHLIGHT_CLASS: Record<HighlightKind, string> = {
    word: 'rounded-sm bg-amber-400/20 text-amber-100',
    point: 'rounded-sm bg-sky-400/20 text-sky-100',
};

const WatchSubtitleOverlayInner: React.FC<WatchSubtitleOverlayProps> = ({
    enText,
    zhText,
    mode = 'bilingual',
    glosses,
    languagePoints,
    raised,
    dock,
}) => {
    const { t } = useI18n();
    const english = enText?.trim() ?? '';
    const chinese = mode === 'english' || isUntranslated(zhText ?? undefined)
        ? ''
        : (zhText ?? '').trim();
    const highlightRanges = useMemo(
        () => (english ? buildHighlightRanges(english, glosses, languagePoints) : []),
        [english, glosses, languagePoints],
    );
    // P2-17: `raised` is the explicit position; `dock` is its complement and
    // only supplied by the watch shell.
    const isRaised = raised ?? !dock;

    // No current sentence (before the first cue / empty payload): hide, do not
    // paint an empty window.
    if (!english || mode === 'off') return null;

    const segments: React.ReactNode[] = [];
    let cursor = 0;
    for (const range of highlightRanges) {
        if (range.start > cursor) segments.push(english.slice(cursor, range.start));
        segments.push(
            <span
                key={`${range.start}-${range.end}-${range.kind}`}
                data-testid="watch-subtitle-highlight"
                data-kind={range.kind}
                data-highlight={english.slice(range.start, range.end)}
                className={HIGHLIGHT_CLASS[range.kind]}
            >
                {english.slice(range.start, range.end)}
            </span>,
        );
        cursor = range.end;
    }
    if (cursor < english.length) segments.push(english.slice(cursor));

    return (
        <div
            data-testid="watch-subtitle-overlay"
            data-mode={mode}
            data-dock={isRaised ? 'false' : 'true'}
            data-raised={isRaised ? 'true' : 'false'}
            role="region"
            aria-label={t('watchMode.subtitleAria')}
            style={{ bottom: isRaised ? RAISED_BOTTOM : DOCKED_BOTTOM }}
            className="pointer-events-none absolute inset-x-0 z-overlay transition-[bottom] duration-200 ease-apple motion-reduce:transition-none motion-reduce:duration-0"
        >
            {/* Scrim, not a band: the gradient is transparent at the top and
                only dark enough behind the type, so the picture runs through it
                (specs/045 §4.2). Safe edges keep the text off the iframe sides. */}
            <div className="bg-gradient-to-t from-app/80 via-app/45 to-transparent px-4 pb-2 pt-6 sm:px-12 sm:pt-10 xl:pt-16">
                <div className="mx-auto w-full max-w-[min(68ch,86%)] text-center">
                    <p
                        data-testid="watch-subtitle-en"
                        style={{ fontSize: EN_FLUID_SIZE }}
                        className={`text-section font-semibold leading-snug text-fg-primary text-balance ${chinese ? 'mb-0.5' : ''}`}
                    >
                        {segments}
                    </p>
                    {chinese && (
                        <p
                            data-testid="watch-subtitle-zh"
                            style={{ fontSize: ZH_FLUID_SIZE }}
                            className="text-body-zh leading-snug text-fg-strong text-balance"
                        >
                            {chinese}
                        </p>
                    )}
                </div>
            </div>
        </div>
    );
};

// The parent re-renders every playback tick; memo keeps this to sentence
// boundaries only, so the window never flickers on a 100ms update.
export const WatchSubtitleOverlay = React.memo(WatchSubtitleOverlayInner);
