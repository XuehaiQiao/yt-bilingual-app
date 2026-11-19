import React, { useCallback, useEffect, useRef } from 'react';
import { TranscriptBlock } from './TranscriptBlock';
import type { TranslationMode } from '../lib/transcript';

interface TranscriptItem {
    id: number;
    start: number;
    end: number;
    en_text: string;
    zh_text: string;
    highlights: Array<{
        en_word: string;
        zh_word: string;
        color: string;
    }>;
}

interface TranscriptViewProps {
    transcript: TranscriptItem[];
    /** Index of the sentence being spoken — computed upstream so this
     *  component only re-renders when the active sentence changes, not on
     *  every 100ms time tick. */
    activeIndex: number;
    videoId: string;
    favorites: string[];
    onTranscriptClick: (time: number) => void;
    onToggleFavorite: (item: TranscriptItem) => void;
    translationMode?: TranslationMode;
    dictation?: boolean;
    onWordLookup?: (word: string, sentence: string, start: number, e: React.MouseEvent) => void;
    isHighlighted?: (word: string) => boolean;
    languagePointsByBlock?: Record<string, import('./TranscriptBlock').InlineLanguagePoint[]>;
    showLanguagePoints?: boolean;
    difficultyEnabled?: boolean;
    difficultyLevel?: string;
    difficultyVersion?: number;
    /** Draw the hairline divider on the left edge — only when the transcript
     *  is a right-hand pane. A stacked transcript (under the video) has no
     *  left edge to divide, so the video view passes false there. */
    borderLeft?: boolean;
    /** Passed through to memoized blocks so a UI-language switch re-renders them. */
    uiLanguage?: import('../i18n').LanguageCode;
    /** Mobile learning page (layout §6.3): the transcript grows naturally and
     *  the *page* is the only scroll container. Auto-follow then scrolls the
     *  nearest scrolling ancestor; desktop keeps its own scrollbar. */
    pageScroll?: boolean;
}

// How long auto-follow stays suspended after the user scrolls manually
const USER_SCROLL_GRACE_MS = 4000;

/** On mobile the 48px LearningHeader is a sibling above the page scroller, so
 *  the active sentence parks 12px below the top of the scroller: 48 + 12 in
 *  viewport terms (layout §6.3 rule 5). Desktop keeps the 32% lyric position. */
const PAGE_FOLLOW_OFFSET_PX = 12;

/** The translation accordion animates over 300ms. Wait for it to settle before
 *  anchoring the newly active line on the mobile page, otherwise the previous
 *  sentence collapsing above the target shifts it by ~one translation line. */
const PAGE_FOLLOW_SETTLE_MS = 340;

function isScrollable(el: HTMLElement): boolean {
    const overflowY = window.getComputedStyle(el).overflowY;
    if (overflowY !== 'auto' && overflowY !== 'scroll') return false;
    return el.scrollHeight > el.clientHeight + 1;
}

function findScrollableAncestor(start: HTMLElement | null): HTMLElement | null {
    let node = start?.parentElement ?? null;
    while (node) {
        if (isScrollable(node)) return node;
        node = node.parentElement;
    }
    return null;
}

const TranscriptViewInner: React.FC<TranscriptViewProps> = ({
    transcript,
    activeIndex,
    videoId,
    favorites,
    onTranscriptClick,
    onToggleFavorite,
    translationMode,
    dictation,
    onWordLookup,
    isHighlighted,
    languagePointsByBlock,
    showLanguagePoints = true,
    difficultyEnabled = true,
    difficultyLevel = '',
    difficultyVersion = 0,
    borderLeft = true,
    uiLanguage,
    pageScroll = false,
}) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const lastUserScrollRef = useRef(0);
    // The page scroller is not known until layout exists; keep it in a ref so
    // the follow effect can use the same element the listeners are bound to.
    const scrollerRef = useRef<HTMLElement | null>(null);
    // Auto-follow is a *change* reaction: mounting (or restoring a route)
    // must not yank the mobile page down away from the video.
    const previousActiveRef = useRef(activeIndex);
    const followTimerRef = useRef<number | null>(null);

    const resolveScroller = useCallback((): HTMLElement | null => {
        const el = containerRef.current;
        if (!el) return null;
        // Desktop / PiP: this element has its own scrollbar.
        if (isScrollable(el)) return el;
        // Mobile learning page: one page-level scroll container owns the
        // gesture; never add a second one here.
        if (!pageScroll) return el;
        return findScrollableAncestor(el);
    }, [pageScroll]);

    // Detect manual scrolling so auto-follow doesn't fight the reader. Bind
    // to the element that actually scrolls: the transcript on desktop, the
    // learning-page wrapper on mobile.
    useEffect(() => {
        let scroller: HTMLElement | null = null;
        const mark = () => { lastUserScrollRef.current = Date.now(); };
        const attach = () => {
            const next = resolveScroller();
            if (next === scroller) return;
            if (scroller) {
                scroller.removeEventListener('wheel', mark);
                scroller.removeEventListener('touchmove', mark);
            }
            scroller = next;
            scrollerRef.current = next;
            if (scroller) {
                scroller.addEventListener('wheel', mark, { passive: true });
                scroller.addEventListener('touchmove', mark, { passive: true });
            }
        };
        attach();
        // Split ↔ stacked and rotation change which element scrolls.
        window.addEventListener('resize', attach);
        return () => {
            window.removeEventListener('resize', attach);
            if (scroller) {
                scroller.removeEventListener('wheel', mark);
                scroller.removeEventListener('touchmove', mark);
            }
            scrollerRef.current = null;
        };
    }, [resolveScroller, transcript.length]);

    // Apple-Music-style lyric follow: keep the active sentence ~1/3 from the
    // top on desktop; on the mobile page scroller park it just below the
    // header. One small step per sentence, only when the sentence changes.
    useEffect(() => {
        if (activeIndex < 0) return;
        const previous = previousActiveRef.current;
        previousActiveRef.current = activeIndex;
        if (previous === activeIndex) return;

        const container = containerRef.current;
        if (!container) return;
        if (Date.now() - lastUserScrollRef.current < USER_SCROLL_GRACE_MS) return;

        const initialScroller = scrollerRef.current ?? resolveScroller();
        if (!initialScroller) return;

        const scrollOnce = () => {
            // The reader may have taken over during the settle delay.
            if (Date.now() - lastUserScrollRef.current < USER_SCROLL_GRACE_MS) return;
            const el = container.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`);
            if (!el) return;
            const scroller = scrollerRef.current ?? resolveScroller();
            if (!scroller) return;

            const elRect = el.getBoundingClientRect();
            const anchorTop = scroller === container
                ? scroller.getBoundingClientRect().top + scroller.clientHeight * 0.32
                : scroller.getBoundingClientRect().top + PAGE_FOLLOW_OFFSET_PX;
            const target = scroller.scrollTop + (elRect.top - anchorTop);

            // Skip sub-pixel adjustments; smooth-scroll the rest. Reduced-motion
            // users (and browsers that no-op smooth programmatic scrolls under it)
            // get an instant jump instead.
            if (Math.abs(target - scroller.scrollTop) < 4) return;
            const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            scroller.scrollTo({ top: Math.max(0, target), behavior: reduceMotion ? 'auto' : 'smooth' });
        };

        // Desktop keeps its immediate lyric follow. On the mobile page the
        // translation accordion is still collapsing above the target, so one
        // scrollTo after it settles keeps the 12px anchor exact.
        if (initialScroller === container) {
            scrollOnce();
            return;
        }
        followTimerRef.current = window.setTimeout(scrollOnce, PAGE_FOLLOW_SETTLE_MS);
        return () => {
            if (followTimerRef.current !== null) {
                window.clearTimeout(followTimerRef.current);
                followTimerRef.current = null;
            }
        };
    }, [activeIndex, resolveScroller]);

    // Mobile: natural height, safe-area bottom padding, no inner scrollbar.
    // Desktop / PiP: the pane keeps its own scrollbar and edge-to-edge padding.
    const scrollClasses = pageScroll
        ? 'overflow-visible md:h-full md:overflow-y-auto'
        : 'h-full overflow-y-auto';
    const paddingClasses = pageScroll
        ? 'px-4 pt-4 pb-[calc(1rem+env(safe-area-inset-bottom))] md:px-6 md:py-6'
        : 'px-6 py-6';

    return (
        <div
            ref={containerRef}
            data-testid="transcript-scroll"
            className={`${paddingClasses} ${scrollClasses} bg-transparent custom-scrollbar relative ${borderLeft ? 'border-l border-white/5' : ''}`}
        >
            <div className="space-y-1.5">
                {transcript.map((item, index) => {
                    const isActive = index === activeIndex;
                    return (
                        <div
                            key={`${item.id}-${index}`}
                            data-index={index}
                            data-active={isActive}
                            // Fallback for any scrollIntoView (12px below the
                            // 48px header; the manual follow above is primary).
                            className="scroll-mt-3"
                            onClick={() => onTranscriptClick(item.start)}
                        >
                            <TranscriptBlock
                                id={item.id}
                                start={item.start}
                                end={item.end}
                                enText={item.en_text}
                                zhText={item.zh_text}
                                highlights={item.highlights}
                                isActive={isActive}
                                isFavorited={favorites.includes(`${videoId}-${item.id}`)}
                                onToggleFavorite={() => onToggleFavorite(item)}
                                translationMode={translationMode}
                                dictation={dictation}
                                onWordLookup={onWordLookup}
                                isHighlighted={isHighlighted}
                                languagePoints={languagePointsByBlock?.[String(item.id)]}
                                showLanguagePoints={showLanguagePoints}
                                difficultyEnabled={difficultyEnabled}
                                difficultyLevel={difficultyLevel}
                                difficultyVersion={difficultyVersion}
                                uiLanguage={uiLanguage}
                            />
                        </div>
                    );
                })}
            </div>
        </div>
    );
};

// Re-render only when the active sentence (or actual content/props) change —
// never on raw playback time ticks.
export const TranscriptView = React.memo(TranscriptViewInner);
