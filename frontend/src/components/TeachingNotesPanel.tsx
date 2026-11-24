import React, { useMemo, useState } from 'react';
import { BookOpen, ChevronDown, LogIn, RefreshCw, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { AIGeneratedBadge } from './AIGeneratedBadge';
import type { TeachingAnalysis } from '../lib/teachingAnalysis';

export type TeachingNotesStatus =
    | 'idle'
    | 'loading'
    | 'ready'
    | 'empty'
    | 'error'
    | 'login';

interface TeachingNoteBlock {
    id: number;
    start: number;
    end: number;
}

interface TeachingNotesPanelProps {
    status: TeachingNotesStatus;
    analysis: TeachingAnalysis | null;
    /** Source transcript, used only to resolve each note's `blockId` to a time. */
    transcript: TeachingNoteBlock[];
    onSeek: (blockId: number | string) => void;
    onRetry: () => void;
    onRequestLogin?: () => void;
}

const formatTime = (seconds: number) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const mins = Math.floor(safe / 60).toString().padStart(2, '0');
    const secs = (safe % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
};

const NoteRow: React.FC<{
    testId: string;
    title: string;
    meaning: string;
    quote: string;
    start: number | null;
    seekLabel: string;
    onSeek: () => void;
}> = ({ testId, title, meaning, quote, start, seekLabel, onSeek }) => (
    <button
        type="button"
        data-testid={testId}
        data-block-start={start ?? undefined}
        onClick={onSeek}
        disabled={start === null}
        title={start === null ? undefined : `${seekLabel} ${formatTime(start)}`}
        className="w-full min-w-0 text-left p-3 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors cursor-pointer disabled:cursor-default disabled:opacity-70 group/note"
    >
        <div className="flex items-start justify-between gap-3 min-w-0">
            <span className="min-w-0 flex-1 text-sm font-medium text-blue-300 group-hover/note:text-blue-200 transition-colors break-words">
                {title}
            </span>
            {start !== null && (
                <span className="shrink-0 text-[11px] font-medium tabular-nums text-zinc-500">
                    {formatTime(start)}
                </span>
            )}
        </div>
        <span className="mt-1 block text-[13px] leading-relaxed text-zinc-300 break-words">{meaning}</span>
        {quote && (
            <span className="mt-1 block text-xs leading-relaxed text-zinc-500 break-words">“{quote}”</span>
        )}
    </button>
);

/**
 * 「语言点」sidebar for the video learning view (specs/028).
 *
 * Idioms and culture notes are optional enrichment: this panel owns the
 * loading / empty / error / sign-in states so the player and transcript never
 * have to care. Clicking an item seeks to the block that carries the quote.
 */
const TeachingNotesPanelInner: React.FC<TeachingNotesPanelProps> = ({
    status,
    analysis,
    transcript,
    onSeek,
    onRetry,
    onRequestLogin,
}) => {
    const { t } = useI18n();
    const [open, setOpen] = useState(true);

    const startByBlockId = useMemo(() => {
        const map = new Map<string, number>();
        for (const block of transcript) map.set(String(block.id), block.start);
        return map;
    }, [transcript]);

    if (status === 'idle') return null;

    const idioms = analysis?.idioms ?? [];
    const culture = analysis?.culture ?? [];
    const hasNotes = idioms.length > 0 || culture.length > 0;
    const startFor = (blockId: number | string): number | null =>
        startByBlockId.get(String(blockId)) ?? null;

    const body = (() => {
        if (status === 'login') {
            return (
                <div
                    data-testid="teaching-notes-login"
                    className="flex items-start gap-2.5 rounded-xl border border-white/5 bg-zinc-800/30 px-3 py-2.5"
                >
                    <LogIn className="w-4 h-4 mt-0.5 shrink-0 text-zinc-500" />
                    <div className="min-w-0 flex-1">
                        <p className="text-[13px] leading-relaxed text-zinc-400 break-words">
                            {t('teachingNotes.loginHint')}
                        </p>
                        {onRequestLogin && (
                            <button
                                type="button"
                                data-testid="teaching-notes-login-action"
                                onClick={onRequestLogin}
                                className="mt-2 inline-flex items-center h-8 px-3 rounded-lg bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-xs font-medium text-blue-300 transition-colors"
                            >
                                {t('teachingNotes.loginAction')}
                            </button>
                        )}
                    </div>
                </div>
            );
        }

        if (status === 'loading') {
            return (
                <div
                    data-testid="teaching-notes-skeleton"
                    aria-busy="true"
                    aria-label={t('teachingNotes.loading')}
                    className="space-y-1.5"
                >
                    {[0, 1].map((index) => (
                        <div
                            key={index}
                            className="h-16 rounded-xl bg-zinc-800/30 border border-white/5 animate-pulse motion-reduce:animate-none"
                        />
                    ))}
                </div>
            );
        }

        if (status === 'error') {
            return (
                <div
                    data-testid="teaching-notes-error"
                    className="flex items-center gap-2.5 rounded-xl border border-white/5 bg-zinc-800/30 px-3 py-2.5"
                >
                    <RefreshCw className="w-4 h-4 shrink-0 text-amber-400" />
                    <p className="min-w-0 flex-1 text-[13px] leading-relaxed text-zinc-400 break-words">
                        {t('teachingNotes.error')}
                    </p>
                    <button
                        type="button"
                        data-testid="teaching-notes-retry"
                        onClick={onRetry}
                        className="shrink-0 inline-flex items-center h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                    >
                        {t('teachingNotes.retry')}
                    </button>
                </div>
            );
        }

        if (!hasNotes) {
            return (
                <div
                    data-testid="teaching-notes-empty"
                    className="flex flex-col items-center justify-center py-6 text-center"
                >
                    <Sparkles className="w-6 h-6 text-zinc-700 mb-2" />
                    <p className="text-xs font-medium text-zinc-400">{t('teachingNotes.empty')}</p>
                </div>
            );
        }

        return (
            <div className="space-y-3">
                {idioms.length > 0 && (
                    <div data-testid="teaching-notes-idioms">
                        <h3 className="mb-1.5 text-[11px] font-medium text-zinc-500">
                            {t('teachingNotes.idioms')}
                        </h3>
                        <div className="space-y-1.5">
                            {idioms.map((item, index) => (
                                <NoteRow
                                    key={`idiom-${String(item.blockId)}-${index}`}
                                    testId="teaching-note-idiom"
                                    title={item.phrase}
                                    meaning={item.meaning}
                                    quote={item.quote}
                                    start={startFor(item.blockId)}
                                    seekLabel={t('teachingNotes.seekHint')}
                                    onSeek={() => onSeek(item.blockId)}
                                />
                            ))}
                        </div>
                    </div>
                )}
                {culture.length > 0 && (
                    <div data-testid="teaching-notes-culture">
                        <h3 className="mb-1.5 text-[11px] font-medium text-zinc-500">
                            {t('teachingNotes.culture')}
                        </h3>
                        <div className="space-y-1.5">
                            {culture.map((item, index) => (
                                <NoteRow
                                    key={`culture-${String(item.blockId)}-${index}`}
                                    testId="teaching-note-culture"
                                    title={item.term}
                                    meaning={item.note}
                                    quote={item.quote}
                                    start={startFor(item.blockId)}
                                    seekLabel={t('teachingNotes.seekHint')}
                                    onSeek={() => onSeek(item.blockId)}
                                />
                            ))}
                        </div>
                    </div>
                )}
            </div>
        );
    })();

    return (
        <section
            data-testid="teaching-notes-panel"
            data-status={status}
            className="mb-6 pb-6 border-b border-white/5"
        >
            <button
                type="button"
                data-testid="teaching-notes-toggle"
                aria-expanded={open}
                onClick={() => setOpen((previous) => !previous)}
                className="flex w-full min-w-0 items-start justify-between gap-3 cursor-pointer group"
            >
                <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <BookOpen className="w-4 h-4 shrink-0 text-blue-400" />
                    <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 group-hover:text-blue-300 transition-colors">
                        {t('teachingNotes.title')}
                    </h2>
                    {analysis && (
                        <AIGeneratedBadge kind="analysis" testId="teaching-notes-ai-badge" />
                    )}
                    {analysis && (
                        <span
                            data-testid="teaching-notes-counts"
                            className="flex min-w-0 flex-wrap items-center gap-1.5"
                        >
                            <span className="whitespace-nowrap text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/5 text-zinc-400 tabular-nums">
                                {t('teachingNotes.idiomCount', { count: idioms.length })}
                            </span>
                            <span className="whitespace-nowrap text-[11px] font-medium px-2 py-0.5 rounded-full bg-white/5 text-zinc-400 tabular-nums">
                                {t('teachingNotes.cultureCount', { count: culture.length })}
                            </span>
                        </span>
                    )}
                </span>
                <span className="shrink-0 flex items-center gap-2">
                    <span className="hidden sm:inline text-[11px] text-zinc-600">
                        {open ? t('teachingNotes.collapse') : t('teachingNotes.expand')}
                    </span>
                    <ChevronDown
                        className={`w-4 h-4 text-zinc-400 group-hover:text-blue-400 transition-transform duration-300 ${open ? 'rotate-180' : ''}`}
                    />
                </span>
            </button>

            <div
                className={`grid transition-[grid-template-rows,opacity] duration-300 ease-apple ${
                    open ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0'
                }`}
            >
                <div className="overflow-hidden min-h-0">{body}</div>
            </div>
        </section>
    );
};

// Playback updates the parent every 100ms; the panel only changes when the
// analysis/transcript/status props do (all callbacks are stable from App).
export const TeachingNotesPanel = React.memo(TeachingNotesPanelInner);
