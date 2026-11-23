import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, LogIn, RefreshCw, Sparkles, X } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import type { InlineLanguagePoint } from './TranscriptBlock';
import type { TeachingNotesStatus } from './TeachingNotesPanel';

interface WatchGlossPanelProps {
    /** Block id of the sentence being spoken; null before the first cue. */
    blockId: string | null;
    /** English text of the current sentence, used as the entry's one-line context. */
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
                    className="h-12 rounded-control bg-surface-2/40 border border-line-subtle animate-pulse motion-reduce:animate-none"
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

/** One sentence's block: context line, words, language points. */
const GlossEntryBody: React.FC<{
    entry: WatchGlossEntry;
    isCurrent: boolean;
    showLanguagePoints: boolean;
}> = ({ entry, isCurrent, showLanguagePoints }) => {
    const { t } = useI18n();
    const words = entry.words;
    const points = showLanguagePoints ? entry.points : [];

    return (
        <article
            data-testid="watch-gloss-entry"
            data-block-id={entry.blockId}
            data-current={isCurrent ? 'true' : 'false'}
            aria-current={isCurrent ? 'true' : undefined}
            className={
                isCurrent
                    ? 'min-w-0 rounded-control border border-line-subtle/80 bg-surface-2/25 px-2.5 py-2'
                    : 'min-w-0 border-b border-line-subtle/50 pb-3 last:border-b-0 last:pb-0'
            }
        >
            <header className="mb-2 flex min-w-0 items-center gap-2">
                <span
                    data-testid="watch-gloss-entry-context"
                    title={entry.enText || undefined}
                    className="min-w-0 flex-1 truncate text-micro leading-tight text-fg-muted"
                >
                    {entry.enText || '—'}
                </span>
                {isCurrent && (
                    <span
                        data-testid="watch-gloss-entry-current"
                        aria-hidden="true"
                        className="h-1.5 w-1.5 shrink-0 rounded-full bg-brand"
                    />
                )}
            </header>
            {words.length > 0 && (
                <section data-testid="watch-gloss-words">
                    <h3 className="mb-1.5 text-micro font-medium text-fg-muted">{t('watchMode.words')}</h3>
                    <ul className="space-y-1.5">
                        {words.map(([word, gloss]) => (
                            <li
                                key={word}
                                data-testid="watch-gloss-word"
                                className="flex items-baseline justify-between gap-3 rounded-control border border-line-subtle bg-surface-2/30 px-2.5 py-1.5"
                            >
                                <span className="min-w-0 break-words text-ui font-medium text-amber-300/90">{word}</span>
                                <span className="min-w-0 break-words text-right text-caption text-fg-strong">{gloss}</span>
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {points.length > 0 && (
                <section data-testid="watch-gloss-language-points" className={words.length > 0 ? 'mt-2.5' : ''}>
                    <h3 className="mb-1.5 text-micro font-medium text-fg-muted">{t('watchMode.languagePoints')}</h3>
                    <ul className="space-y-1.5">
                        {points.map((point, index) => (
                            <li
                                key={`${point.kind}-${point.text}-${index}`}
                                data-testid="watch-gloss-language-point"
                                data-kind={point.kind}
                                className="rounded-control border border-line-subtle bg-surface-2/30 px-2.5 py-2"
                            >
                                <div className="flex items-start justify-between gap-2">
                                    <span className="min-w-0 break-words text-ui font-medium text-sky-300">{point.text}</span>
                                    <span className="shrink-0 rounded-full bg-state-hover px-2 py-0.5 text-micro font-medium text-fg-secondary">
                                        {point.kind === 'idiom' ? t('teachingNotes.idioms') : t('teachingNotes.culture')}
                                    </span>
                                </div>
                                {point.meaning && (
                                    <p className="mt-1 break-words text-caption leading-relaxed text-fg-secondary">{point.meaning}</p>
                                )}
                            </li>
                        ))}
                    </ul>
                </section>
            )}
            {words.length === 0 && points.length === 0 && (
                <div
                    data-testid={isCurrent ? 'watch-gloss-empty' : 'watch-gloss-entry-empty'}
                    className="flex items-center gap-2 rounded-control border border-dashed border-line-subtle px-2.5 py-2 text-caption text-fg-muted"
                >
                    <BookOpen className="h-3.5 w-3.5 shrink-0 text-fg-disabled" aria-hidden="true" />
                    <span>{t('watchMode.noGloss')}</span>
                </div>
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

    if (entries.length === 0) {
        return (
            <EmptyState
                testId="watch-gloss-empty"
                icon={<BookOpen className="w-5 h-5 text-fg-disabled mb-2" />}
                title={t('watchMode.noGloss')}
            />
        );
    }

    return (
        <div data-testid="watch-gloss-history" className="space-y-3">
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
 * 观影模式词条窗 (specs/044 §§3–4).
 *
 * A second presentation of the existing teaching analysis (specs/028): the
 * words the transcript already marks in ruby plus that sentence's language
 * points. P2-09 turns the window into a per-sentence history — the current
 * sentence sits on top, earlier sentences slide down instead of disappearing,
 * a revisited sentence is moved (never duplicated) and the newest sentence
 * scrolls the window back to the top unless the learner deliberately scrolled
 * down to read the backlog.
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
        return {
            blockId,
            enText: enText?.trim() ?? '',
            words: Object.entries(glosses ?? {}),
            points: languagePoints ?? [],
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

    // Only accumulate once the analysis is ready; a sentence without words or
    // points stays as the current top placeholder instead of polluting history.
    useEffect(() => {
        if (status !== 'ready' || !currentEntry) return;
        if (currentEntry.words.length === 0 && currentEntry.points.length === 0) return;
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
