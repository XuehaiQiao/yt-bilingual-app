import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LogIn, RefreshCw, Sparkles, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { InlineLanguagePoint } from './TranscriptBlock';
import type { TeachingNotesStatus } from './TeachingNotesPanel';

interface WatchGlossPanelProps {
    /** Block id of the sentence being spoken; null before the first cue. */
    blockId: string | null;
    /**
     * English text of the current sentence. P2-12 stopped rendering it above
     * each entry; it survives only as part of the entry identity so an edited
     * sentence still replaces its old snapshot instead of being deduplicated.
     */
    enText?: string | null;
    /**
     * Content identity (video id). The accumulated history belongs to one
     * video, so switching content starts a fresh window.
     */
    contentRef?: string | null;
    /** `wordGlossesByBlock[blockId]` — the same map the transcript ruby uses. */
    glosses: Record<string, string>;
    /** `languagePointsByBlock[blockId]` — the same list the underline layer uses. */
    languagePoints: InlineLanguagePoint[];
    /** Follows the transcript's language-point switch (one semantic source). */
    showLanguagePoints: boolean;
    status: TeachingNotesStatus;
    /** The existing 028 entry point (GET /api/teaching-analysis). No new AI. */
    onRequestAnalysis: () => void;
    onRequestLogin?: () => void;
    /**
     * `rail` — the ≥1280 fixed right column (D1-1).
     * `floating` — below 1280: a collapsed pill over the media that expands
     * into a glass layer; it never covers the video unless the learner opens it.
     */
    variant?: 'rail' | 'floating';
}

/** One sentence's gloss snapshot, kept so earlier sentences stay readable. */
interface WatchGlossEntry {
    blockId: string;
    enText: string;
    words: Array<[string, string]>;
    points: InlineLanguagePoint[];
}

/** P2-09: keep the recent sentences, oldest fall off the bottom. */
const MAX_HISTORY_ENTRIES = 30;

const samePoint = (a: InlineLanguagePoint, b: InlineLanguagePoint) =>
    a.text === b.text && a.meaning === b.meaning && a.kind === b.kind;

const sameEntry = (a: WatchGlossEntry, b: WatchGlossEntry) =>
    a.blockId === b.blockId
    && a.enText === b.enText
    && a.words.length === b.words.length
    && a.words.every(([word, gloss], index) => word === b.words[index][0] && gloss === b.words[index][1])
    && a.points.length === b.points.length
    && a.points.every((point, index) => samePoint(point, b.points[index]));

interface GlossBodyProps {
    /** Current sentence first, then the accumulated earlier sentences. */
    entries: WatchGlossEntry[];
    /** Which entry is the sentence being spoken (null = between sentences). */
    currentBlockId: string | null;
    showLanguagePoints: boolean;
    status: TeachingNotesStatus;
    onRequestAnalysis: () => void;
    onRequestLogin?: () => void;
}

const StatusSkeleton: React.FC = () => {
    const { t } = useI18n();
    return (
        <div data-testid="watch-gloss-loading" aria-busy="true" aria-label={t('watchMode.loading')} className="space-y-1.5">
            {[0, 1].map((index) => (
                <div
                    key={index}
                    className="h-12 rounded-control bg-surface-2/40 animate-pulse motion-reduce:animate-none"
                />
            ))}
        </div>
    );
};

const EmptyState: React.FC<{ testId: string; icon: React.ReactNode; title: string; hint?: string; action?: React.ReactNode }> = ({
    testId,
    icon,
    title,
    hint,
    action,
}) => (
    <div data-testid={testId} className="flex flex-col items-center justify-center py-8 text-center">
        {icon}
        <p className="text-ui font-medium text-fg-strong">{title}</p>
        {hint && <p className="mt-1 max-w-[16rem] text-caption leading-relaxed text-fg-muted">{hint}</p>}
        {action}
    </div>
);

/**
 * One sentence's block in the rolling gloss list (P2-12): words in amber with
 * their meaning, language points in sky with the meaning on the next line.
 * No sentence context, no section headings, no kind badge, no card border or
 * background, and no empty placeholder — an empty sentence simply contributes
 * nothing.
 */
const GlossEntryBody: React.FC<{
    entry: WatchGlossEntry;
    isCurrent: boolean;
    showLanguagePoints: boolean;
}> = ({ entry, isCurrent, showLanguagePoints }) => {
    const words = entry.words;
    const points = showLanguagePoints ? entry.points : [];

    return (
        <article
            data-testid="watch-gloss-entry"
            data-block-id={entry.blockId}
            data-current={isCurrent ? 'true' : 'false'}
            aria-current={isCurrent ? 'true' : undefined}
            className="min-w-0"
        >
            {words.length > 0 && (
                <ul data-testid="watch-gloss-words" className="space-y-1">
                    {words.map(([word, gloss]) => (
                        <li
                            key={word}
                            data-testid="watch-gloss-word"
                            className="flex min-w-0 items-baseline justify-between gap-3"
                        >
                            <span className="min-w-0 break-words text-ui font-medium text-amber-300/90">{word}</span>
                            <span className="min-w-0 break-words text-right text-caption text-fg-strong">{gloss}</span>
                        </li>
                    ))}
                </ul>
            )}
            {points.length > 0 && (
                <ul
                    data-testid="watch-gloss-language-points"
                    className={words.length > 0 ? 'mt-2 space-y-1.5' : 'space-y-1.5'}
                >
                    {points.map((point, index) => (
                        <li
                            key={`${point.text}-${index}`}
                            data-testid="watch-gloss-language-point"
                            className="min-w-0"
                        >
                            <p className="min-w-0 break-words text-ui font-medium text-sky-300">{point.text}</p>
                            {point.meaning && (
                                <p className="mt-1 break-words text-caption leading-relaxed text-fg-secondary">
                                    {point.meaning}
                                </p>
                            )}
                        </li>
                    ))}
                </ul>
            )}
        </article>
    );
};

const GlossBody: React.FC<GlossBodyProps> = ({
    entries,
    currentBlockId,
    showLanguagePoints,
    status,
    onRequestAnalysis,
    onRequestLogin,
}) => {
    const { t } = useI18n();

    if (status === 'loading' || status === 'idle') return <StatusSkeleton />;

    if (status === 'login') {
        return (
            <div data-testid="watch-gloss-login" className="flex items-start gap-2.5 rounded-control border border-line-subtle bg-surface-2/30 px-3 py-2.5">
                <LogIn className="w-4 h-4 mt-0.5 shrink-0 text-fg-muted" />
                <div className="min-w-0 flex-1">
                    <p className="text-caption leading-relaxed text-fg-secondary">{t('watchMode.loginHint')}</p>
                    {onRequestLogin && (
                        <button
                            type="button"
                            data-testid="watch-gloss-login-action"
                            onClick={onRequestLogin}
                            className="mt-2 inline-flex items-center h-8 px-3 rounded-control bg-state-hover hover:bg-state-pressed border border-line-strong text-caption font-medium text-fg-primary transition-colors"
                        >
                            {t('teachingNotes.loginAction')}
                        </button>
                    )}
                </div>
            </div>
        );
    }

    if (status === 'error') {
        return (
            <EmptyState
                testId="watch-gloss-error"
                icon={<RefreshCw className="w-5 h-5 text-amber-400 mb-2" />}
                title={t('watchMode.error')}
                action={(
                    <button
                        type="button"
                        data-testid="watch-gloss-retry"
                        onClick={onRequestAnalysis}
                        className="mt-3 inline-flex items-center h-8 px-3 rounded-control bg-surface-2/60 hover:bg-surface-3/60 border border-line-subtle text-caption font-medium text-fg-strong hover:text-fg-primary transition-colors"
                    >
                        {t('common.retry')}
                    </button>
                )}
            />
        );
    }

    if (status === 'empty') {
        return (
            <EmptyState
                testId="watch-gloss-no-analysis"
                icon={<Sparkles className="w-5 h-5 text-fg-disabled mb-2" />}
                title={t('watchMode.noAnalysisTitle')}
                hint={t('watchMode.noAnalysisHint')}
                action={(
                    <button
                        type="button"
                        data-testid="watch-gloss-generate"
                        onClick={onRequestAnalysis}
                        className="mt-3 inline-flex items-center gap-1.5 h-8 px-3 rounded-control bg-state-hover hover:bg-state-pressed border border-line-strong text-caption font-medium text-fg-primary transition-colors"
                    >
                        <Sparkles className="w-3.5 h-3.5" />
                        {t('watchMode.generate')}
                    </button>
                )}
            />
        );
    }

    // P2-12: no per-sentence or global "no gloss" placeholder anymore. Before
    // the first glossed sentence the window simply has no entries yet.
    if (entries.length === 0) return null;

    return (
        <div data-testid="watch-gloss-history" className="space-y-2.5">
            {entries.map((entry) => (
                <GlossEntryBody
                    key={entry.blockId}
                    entry={entry}
                    isCurrent={entry.blockId === currentBlockId}
                    showLanguagePoints={showLanguagePoints}
                />
            ))}
        </div>
    );
};

/**
 * 观影模式滚动词条窗 (specs/044 §§3–4).
 *
 * A second presentation of the existing teaching analysis (specs/028): the
 * words the transcript already marks in ruby plus that sentence's language
 * points. P2-09 turns the window into a per-sentence history — the current
 * sentence sits on top, earlier sentences slide down instead of disappearing,
 * a revisited sentence is moved (never duplicated) and the newest sentence
 * scrolls the window back to the top unless the learner deliberately scrolled
 * down to read the backlog.
 *
 * P2-12 renames it 滚动词条 and strips the chrome: no sentence context, no
 * section headings, no kind badges, no empty placeholders, no entry cards or
 * dividers — just a continuous list of words and language points.
 *
 * It never issues an AI call of its own — the only action it exposes is the
 * existing analysis entry (`onRequestAnalysis`), which is the normal cached
 * GET the learning view already uses.
 */
const WatchGlossPanelInner: React.FC<WatchGlossPanelProps> = ({
    variant = 'rail',
    blockId,
    enText,
    contentRef,
    glosses,
    languagePoints,
    showLanguagePoints,
    status,
    onRequestAnalysis,
    onRequestLogin,
}) => {
    const { t } = useI18n();
    const [open, setOpen] = useState(false);
    const [history, setHistory] = useState<WatchGlossEntry[]>([]);
    const scrollRef = useRef<HTMLDivElement | null>(null);
    // True while the newest sentence may pull the window back to the top; a
    // manual scroll down turns it off until the learner scrolls back up.
    const stickToTopRef = useRef(true);
    const lastContentRef = useRef<string | null>(contentRef ?? null);

    const currentEntry = useMemo<WatchGlossEntry | null>(() => {
        if (!blockId) return null;
        const words = Object.entries(glosses ?? {});
        const points = languagePoints ?? [];
        // P2-12: empty sentences are not entries; they never create a
        // placeholder, they just leave the backlog untouched.
        if (words.length === 0 && points.length === 0) return null;
        return {
            blockId,
            enText: enText?.trim() ?? '',
            words,
            points,
        };
    }, [blockId, enText, glosses, languagePoints]);

    // A different video must never inherit the previous video's sentences:
    // block ids are only unique inside one content.
    useEffect(() => {
        const next = contentRef ?? null;
        if (lastContentRef.current === next) return;
        lastContentRef.current = next;
        setHistory([]);
        stickToTopRef.current = true;
    }, [contentRef]);

    // Only accumulate once the analysis is ready; an empty sentence yields no
    // entry at all (P2-12), so the backlog is preserved without a placeholder.
    useEffect(() => {
        if (status !== 'ready' || !currentEntry) return;
        setHistory((previous) => {
            const top = previous[0];
            if (top && sameEntry(top, currentEntry)) return previous;
            return [
                currentEntry,
                ...previous.filter((entry) => entry.blockId !== currentEntry.blockId),
            ].slice(0, MAX_HISTORY_ENTRIES);
        });
    }, [status, currentEntry]);

    // New sentence → top, unless the learner scrolled down on purpose.
    useEffect(() => {
        if (status !== 'ready' || !blockId || !stickToTopRef.current) return;
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
    }, [status, blockId]);

    const handleScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
        stickToTopRef.current = event.currentTarget.scrollTop <= 4;
    }, []);

    const entries = useMemo(() => {
        const older = history.filter((entry) => entry.blockId !== blockId);
        return currentEntry ? [currentEntry, ...older] : older;
    }, [currentEntry, history, blockId]);

    const body = (
        <GlossBody
            entries={entries}
            currentBlockId={blockId}
            showLanguagePoints={showLanguagePoints}
            status={status}
            onRequestAnalysis={onRequestAnalysis}
            onRequestLogin={onRequestLogin}
        />
    );

    if (variant === 'floating') {
        return (
            <div className="absolute right-3 top-3 z-overlay flex flex-col items-end pointer-events-none xl:hidden">
                <button
                    type="button"
                    data-testid="watch-gloss-toggle"
                    aria-expanded={open}
                    aria-controls="watch-gloss-floating-panel"
                    onClick={() => setOpen((previous) => !previous)}
                    className="pointer-events-auto inline-flex items-center gap-1.5 h-8 px-3 rounded-control border border-line-strong bg-app/80 backdrop-blur-md text-caption font-medium text-fg-primary hover:bg-app/90 transition-colors"
                >
                    {open ? <X className="w-3.5 h-3.5" /> : <BookOpen className="w-3.5 h-3.5" />}
                    {t('watchMode.glossTitle')}
                </button>
                {open && (
                    <div
                        id="watch-gloss-floating-panel"
                        data-testid="watch-gloss-panel"
                        data-variant="floating"
                        data-status={status}
                        className="pointer-events-auto mt-2 flex max-h-[min(60dvh,24rem)] w-[min(20rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-card border border-line-strong bg-app/90 backdrop-blur-md shadow-elev-2"
                    >
                        <div
                            ref={scrollRef}
                            onScroll={handleScroll}
                            data-testid="watch-gloss-scroll"
                            className="min-h-0 flex-1 overflow-y-auto custom-scrollbar p-3"
                        >
                            {body}
                        </div>
                    </div>
                )}
            </div>
        );
    }

    return (
        <aside
            data-testid="watch-gloss-rail"
            data-status={status}
            className="hidden xl:flex h-full w-[clamp(20rem,24vw,22.5rem)] shrink-0 flex-col border-l border-line-subtle bg-surface/40 backdrop-blur-xl"
        >
            <header className="flex-none flex items-center gap-2 border-b border-line-subtle px-4 py-3">
                <BookOpen className="w-4 h-4 shrink-0 text-fg-muted" />
                <h2 className="min-w-0 truncate text-section font-semibold tracking-tight text-fg-primary">
                    {t('watchMode.glossTitle')}
                </h2>
            </header>
            <div
                ref={scrollRef}
                onScroll={handleScroll}
                data-testid="watch-gloss-scroll"
                className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4"
            >
                {body}
            </div>
        </aside>
    );
};

// Playback ticks the parent every 100ms; the panel only re-renders when the
// sentence, its glosses or the analysis status actually change.
export const WatchGlossPanel = React.memo(WatchGlossPanelInner);
