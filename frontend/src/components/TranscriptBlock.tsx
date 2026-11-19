import React, { useEffect, useMemo, useState } from 'react';
import { Star, Languages } from 'lucide-react';
import { isUntranslated, type TranslationMode } from '../lib/transcript';
import { cleanReadingWord } from '../lib/useReadingHighlights';
import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";
import { motion } from 'framer-motion';
import { useI18n } from '../i18n/I18nProvider';
import type { LanguageCode } from '../i18n';

export function cn(...inputs: ClassValue[]) {
    return twMerge(clsx(inputs));
}

export type WordClickHandler = (word: string, e: React.MouseEvent) => void;

/** Strip leading/trailing punctuation for dictionary lookup. */
const cleanWord = (token: string) => cleanReadingWord(token);

/** Render plain text with each word clickable for dictionary lookup. */
export const ClickableWords: React.FC<{
    text: string;
    onWordClick: WordClickHandler;
    /** Optional reading-difficulty emphasis (amber background). */
    isHighlighted?: (word: string) => boolean;
    /** Contextual Chinese gloss for a word already marked by the base layer. */
    glossForWord?: (word: string) => string | null | undefined;
}> = ({ text, onWordClick, isHighlighted, glossForWord }) => (
    <>
        {text.split(/(\s+)/).map((token, i) => {
            const word = cleanWord(token);
            if (!word || /^\s+$/.test(token)) return <span key={i}>{token}</span>;
            const highlighted = isHighlighted?.(word) ?? false;
            const gloss = highlighted ? glossForWord?.(word) : null;
            if (gloss) {
                return (
                    <ruby
                        key={i}
                        data-word-hit={word}
                        data-highlight="1"
                        data-gloss={gloss}
                        aria-label={`${word}: ${gloss}`}
                        onClick={(e) => { e.stopPropagation(); onWordClick(word, e); }}
                        className="gloss-word cursor-pointer rounded-sm bg-amber-400/15 text-amber-50 transition-colors hover:bg-white/10"
                    >
                        {token}
                        <rt className="text-[10px] font-medium text-amber-300/90 select-none">{gloss}</rt>
                    </ruby>
                );
            }
            return (
                <span
                    key={i}
                    data-word-hit={word}
                    data-highlight={highlighted ? '1' : undefined}
                    onClick={(e) => { e.stopPropagation(); onWordClick(word, e); }}
                    className={cn(
                        'cursor-pointer rounded-sm transition-colors hover:bg-white/10',
                        highlighted
                            && 'rounded-sm bg-amber-400/15 text-amber-50',
                    )}
                >
                    {token}
                </span>
            );
        })}
    </>
);

/** Difficulty background + language-point underline over one sentence. */
export const MarkedWords: React.FC<{
    text: string;
    onWordClick?: WordClickHandler;
    isHighlighted?: (word: string) => boolean;
    languagePoints?: InlineLanguagePoint[];
    showLanguagePoints?: boolean;
    glossForWord?: (word: string) => string | null | undefined;
}> = ({ text, onWordClick, isHighlighted, languagePoints, showLanguagePoints = true, glossForWord }) => {
    const marked = useMemo(() => {
        if (!onWordClick) return <span>{text}</span>;
        if (!showLanguagePoints || !languagePoints?.length) {
            return <ClickableWords text={text} onWordClick={onWordClick} isHighlighted={isHighlighted} glossForWord={glossForWord} />;
        }
        const ranges: Array<{ point: InlineLanguagePoint; index: number; length: number }> = [];
        let lastEnd = 0;
        const candidates = languagePoints
            .map((point) => ({ point, index: text.indexOf(point.text) }))
            .filter((item) => item.index !== -1 && item.point.text.trim().length > 0)
            .sort((a, b) => a.index - b.index);
        for (const candidate of candidates) {
            if (candidate.index < lastEnd) continue;
            ranges.push({ ...candidate, length: candidate.point.text.length });
            lastEnd = candidate.index + candidate.point.text.length;
        }
        if (ranges.length === 0) {
            return <ClickableWords text={text} onWordClick={onWordClick} isHighlighted={isHighlighted} glossForWord={glossForWord} />;
        }
        const parts: React.ReactNode[] = [];
        let cursor = 0;
        ranges.forEach((range, i) => {
            if (range.index > cursor) {
                parts.push(
                    <ClickableWords
                        key={`gap-${i}`}
                        text={text.slice(cursor, range.index)}
                        onWordClick={onWordClick}
                        isHighlighted={isHighlighted}
                        glossForWord={glossForWord}
                    />,
                );
            }
            const phrase = text.slice(range.index, range.index + range.length);
            parts.push(
                <span
                    key={`point-${i}`}
                    data-language-point={range.point.kind}
                    data-word-hit={phrase}
                    title={range.point.meaning || phrase}
                    onClick={(e) => {
                        e.stopPropagation();
                        onWordClick(phrase, e);
                    }}
                    className="cursor-help rounded-sm underline decoration-sky-400/70 decoration-2 underline-offset-4 transition-colors hover:bg-white/10"
                >
                    {phrase}
                </span>,
            );
            cursor = range.index + range.length;
        });
        if (cursor < text.length) {
            parts.push(
                <ClickableWords
                    key="gap-end"
                    text={text.slice(cursor)}
                    onWordClick={onWordClick}
                    isHighlighted={isHighlighted}
                    glossForWord={glossForWord}
                />,
            );
        }
        return parts;
    }, [glossForWord, isHighlighted, languagePoints, onWordClick, showLanguagePoints, text]);
    return <>{marked}</>;
};


export const HighlightedText: React.FC<{
    text: string;
    highlights: Array<{ word: string; color: string; annotation?: string }>;
    onWordClick?: WordClickHandler;
}> = ({ text, highlights, onWordClick }) => {
    const renderPlain = (segment: string, key: string | number) =>
        onWordClick
            ? <span key={key}><ClickableWords text={segment} onWordClick={onWordClick} /></span>
            : <span key={key}>{segment}</span>;

    if (!highlights || highlights.length === 0) return renderPlain(text, 'all');

    const parts: React.ReactNode[] = [];
    let currentIndex = 0;

    const matches = highlights.map(hl => {
        const idx = text.indexOf(hl.word);
        return { ...hl, index: idx, length: hl.word.length };
    }).filter(m => m.index !== -1).sort((a, b) => a.index - b.index);

    const validMatches: typeof matches = [];
    let lastEnd = 0;
    for (const match of matches) {
        if (match.index >= lastEnd) {
            validMatches.push(match);
            lastEnd = match.index + match.length;
        }
    }

    if (validMatches.length === 0) return renderPlain(text, 'all');

    validMatches.forEach((match, i) => {
        if (match.index > currentIndex) {
            parts.push(renderPlain(text.slice(currentIndex, match.index), `text-${i}`));
        }
        const phrase = text.slice(match.index, match.index + match.length);
        // Teaching highlights use one frozen amber recipe, matching the
        // reading difficulty mark; sentence-pack chunks keep their own
        // CHUNK_STYLE colours in SentenceText instead of this component.
        const clickProps = {
            className: cn(
                'bg-amber-400/[0.08] underline decoration-amber-400/50 decoration-dotted decoration-1 underline-offset-[3px]',
                onWordClick && 'cursor-pointer hover:bg-white/10 rounded-sm',
            ),
            onClick: onWordClick ? (e: React.MouseEvent) => { e.stopPropagation(); onWordClick(phrase, e); } : undefined,
        };
        // Annotation rendered as ruby above the word instead of inline
        // parentheses, so the Chinese gloss doesn't interrupt the English flow.
        parts.push(
            match.annotation ? (
                <ruby key={`hl-${i}`} {...clickProps} data-word-hit={onWordClick ? phrase : undefined}>
                    {phrase}
                    <rt className="text-[10px] font-medium text-amber-300/90 select-none">{match.annotation}</rt>
                </ruby>
            ) : (
                <span key={`hl-${i}`} {...clickProps} data-word-hit={onWordClick ? phrase : undefined}>{phrase}</span>
            )
        );
        currentIndex = match.index + match.length;
    });

    if (currentIndex < text.length) {
        parts.push(renderPlain(text.slice(currentIndex), `text-end`));
    }

    return <>{parts}</>;
};

export interface InlineLanguagePoint {
    text: string;
    meaning?: string;
    kind: 'idiom' | 'culture';
}

interface TranscriptBlockProps {
    id: number;
    start: number;
    end: number;
    enText: string;
    zhText: string;
    highlights: Array<{
        en_word: string;
        zh_word: string;
        color: string;
    }>;
    isActive: boolean;
    isFavorited?: boolean;
    onToggleFavorite?: (e: React.MouseEvent) => void;
    translationMode?: TranslationMode;
    dictation?: boolean;
    onWordLookup?: (word: string, sentence: string, start: number, e: React.MouseEvent) => void;
    /** CEFR difficulty highlight callback, shared with the readers. */
    isHighlighted?: (word: string) => boolean;
    /** Idiom / fixed-expression / culture spans for this block. */
    languagePoints?: InlineLanguagePoint[];
    /** Contextual Chinese glosses keyed by lower-case English word. */
    wordGlosses?: Record<string, string>;
    /** Independent visibility switch for the language-point underline layer. */
    showLanguagePoints?: boolean;
    /** Visibility/threshold identity for the difficulty layer (memo contract). */
    difficultyEnabled?: boolean;
    difficultyLevel?: string;
    difficultyVersion?: number;
    /** Forces a re-render of this memoized block when the UI language changes. */
    uiLanguage?: LanguageCode;
}

const TranscriptBlockInner: React.FC<TranscriptBlockProps> = ({ start, enText, zhText, isActive, isFavorited, onToggleFavorite, translationMode = 'all', dictation = false, onWordLookup, isHighlighted, languagePoints, wordGlosses, showLanguagePoints = true }) => {
    const { t } = useI18n();
    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    // Per-sentence override on top of the global mode (null = follow mode)
    const [overrideShow, setOverrideShow] = useState<boolean | null>(null);
    const modeDefault = translationMode === 'all';
    const showTranslation = overrideShow !== null ? overrideShow : modeDefault;

    // Dictation mode: English stays blurred until the learner reveals it
    const [revealed, setRevealed] = useState(false);
    useEffect(() => {
        setRevealed(false);
    }, [dictation, enText]);
    const blurred = dictation && !revealed;

    // Difficulty background + language-point underline are shared with readers.

    return (
        <div
            className={cn(
                "relative px-4 py-3 rounded-2xl transition-colors duration-200 ease-apple cursor-pointer group",
                !isActive && "hover:bg-zinc-800/40"
            )}
        >
            {isActive && (
                <motion.div
                    layoutId="activeTranscript"
                    className="absolute inset-0 bg-zinc-800/60 rounded-2xl border border-white/10 shadow-[0_1px_1px_rgba(0,0,0,0.3),0_8px_24px_-8px_rgba(0,0,0,0.5)]"
                    transition={{ type: "spring", stiffness: 380, damping: 32 }}
                />
            )}
            <div className="relative z-10">
                <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-3">
                        <span className={cn(
                            "text-[11px] font-medium tabular-nums",
                            isActive ? "text-blue-400" : "text-zinc-500"
                        )}>
                            {formatTime(start)}
                        </span>
                        <button
                            onClick={(e) => {
                                e.stopPropagation();
                                setOverrideShow(!showTranslation);
                            }}
                            className={cn(
                                "p-1.5 rounded-lg transition-colors",
                                showTranslation ? "bg-blue-500/10 text-blue-400" : "text-zinc-500 hover:text-zinc-300 hover:bg-white/5"
                            )}
                            title={t('transcript.toggleTranslation')}
                        >
                            <Languages className="w-3.5 h-3.5" />
                        </button>
                    </div>

                    <button
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleFavorite?.(e);
                        }}
                        className="p-1.5 rounded-lg hover:bg-white/5 transition-[opacity,background-color] duration-200 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
                    >
                        <Star
                            className={cn("w-4 h-4 transition-colors", isFavorited ? "fill-amber-400 text-amber-400 opacity-100" : "text-zinc-500 hover:text-zinc-300")}
                        />
                    </button>
                </div>

                <div className="space-y-1">
                    <p
                        data-lookup-context={enText}
                        data-lookup-start={start}
                        onClick={blurred ? (e) => { e.stopPropagation(); setRevealed(true); } : undefined}
                        title={blurred ? t('transcript.revealOriginal') : undefined}
                        className={cn(
                            "ruby-safe-line text-base tracking-normal transition-[filter,opacity,color] duration-300 ease-apple",
                            isActive ? "text-zinc-50" : "text-zinc-400",
                            blurred && "blur-[6px] select-none opacity-60 hover:opacity-80 cursor-pointer"
                        )}
                    >
                        {blurred ? (
                            <span>{enText}</span>
                        ) : (
                            <MarkedWords
                                text={enText}
                                onWordClick={onWordLookup ? (word, e) => onWordLookup(word, enText, start, e) : undefined}
                                isHighlighted={isHighlighted}
                                languagePoints={languagePoints}
                                showLanguagePoints={showLanguagePoints}
                                glossForWord={(word) => wordGlosses?.[word.toLowerCase()]}
                            />
                        )}
                    </p>
                    <div className={cn(
                        "grid transition-[grid-template-rows,opacity,margin] duration-300 ease-apple",
                        showTranslation ? "grid-rows-[1fr] opacity-100 mt-2" : "grid-rows-[0fr] opacity-0 mt-0"
                    )}>
                        <div className="overflow-hidden min-h-0">
                            {isUntranslated(zhText) ? (
                                <p className="text-[15px] leading-relaxed text-zinc-600 animate-pulse">
                                    {t('transcript.translatingLine')}
                                </p>
                            ) : (
                                // 中文字号略大于 text-sm：汉字在小字号低对比度下比拉丁字母更难读
                                <p className={cn(
                                    "text-[15px] leading-relaxed transition-colors duration-300 ease-apple",
                                    isActive ? "text-zinc-400" : "text-zinc-500"
                                )}>
                                    {zhText}
                                </p>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

// 477-sentence transcripts re-render in lockstep with playback otherwise.
// Compare everything except the callback props (their captured values are
// covered by the data props compared here).
export const TranscriptBlock = React.memo(TranscriptBlockInner, (prev, next) =>
    prev.id === next.id &&
    prev.start === next.start &&
    prev.end === next.end &&
    prev.enText === next.enText &&
    prev.zhText === next.zhText &&
    prev.highlights === next.highlights &&
    prev.isActive === next.isActive &&
    prev.isFavorited === next.isFavorited &&
    prev.translationMode === next.translationMode &&
    prev.dictation === next.dictation &&
    prev.showLanguagePoints === next.showLanguagePoints &&
    prev.languagePoints === next.languagePoints &&
    prev.difficultyEnabled === next.difficultyEnabled &&
    prev.difficultyLevel === next.difficultyLevel &&
    prev.difficultyVersion === next.difficultyVersion &&
    prev.uiLanguage === next.uiLanguage &&
    (prev.onWordLookup === undefined) === (next.onWordLookup === undefined)
);
