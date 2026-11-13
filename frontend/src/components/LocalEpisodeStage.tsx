import React from 'react';
import { Clapperboard, Pause, Play } from 'lucide-react';

/**
 * Media stage for local episodes. There is no video stream for SRT-only
 * shows, so this renders the same aspect-ratio media slot as the YouTube
 * player with a placeholder card carrying the show/episode identity and the
 * simulated-playback controls (play/pause, seekable progress, time readout).
 *
 * The parent owns playback state: a wall-clock timer drives `currentTime`,
 * so this component is intentionally stateless.
 */
export interface LocalEpisodeStageProps {
    /** Series title (metadata.channel for local episodes). */
    showTitle: string;
    /** Episode title (metadata.title, usually includes the SxxExx label). */
    episodeTitle: string;
    /** e.g. "S01E01"; omitted when metadata has no season/episode label. */
    episodeLabel?: string;
    /** Episode duration in seconds (last subtitle block end). */
    duration: number;
    currentTime: number;
    isPlaying: boolean;
    onTogglePlay: () => void;
    /** Seek to an absolute time in seconds. */
    onSeek: (time: number) => void;
}

const formatTime = (seconds: number) => {
    const safe = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
    const mins = Math.floor(safe / 60);
    const secs = Math.floor(safe % 60);
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export const LocalEpisodeStage: React.FC<LocalEpisodeStageProps> = ({
    showTitle,
    episodeTitle,
    episodeLabel,
    duration,
    currentTime,
    isPlaying,
    onTogglePlay,
    onSeek,
}) => {
    const total = Number.isFinite(duration) && duration > 0 ? duration : 0;
    const percent = total > 0 ? Math.min(100, Math.max(0, (currentTime / total) * 100)) : 0;

    const seekFromPointer = (e: React.PointerEvent<HTMLDivElement>) => {
        if (total <= 0) return;
        const rect = e.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        onSeek(ratio * total);
    };

    const handleProgressKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
        if (total <= 0) return;
        let next: number | null = null;
        if (e.key === 'ArrowLeft') next = currentTime - 5;
        else if (e.key === 'ArrowRight') next = currentTime + 5;
        else if (e.key === 'Home') next = 0;
        else if (e.key === 'End') next = total;
        if (next == null) return;
        e.preventDefault();
        e.stopPropagation();
        onSeek(Math.min(total, Math.max(0, next)));
    };

    return (
        <div className="absolute inset-0 p-4">
            <div
                data-testid="local-media-placeholder"
                className="glass-card h-full w-full rounded-xl overflow-hidden shadow-2xl shadow-black/40 relative flex flex-col"
            >
                {/* Quiet depth: a brand-blue cast and two hairline rings, no
                    new material next to the glass card. */}
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-0 bg-gradient-to-br from-blue-500/[0.08] via-transparent to-purple-500/[0.06]"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -right-20 -top-24 w-64 h-64 rounded-full border border-white/5"
                />
                <div
                    aria-hidden="true"
                    className="pointer-events-none absolute -left-16 -bottom-24 w-56 h-56 rounded-full border border-white/5"
                />

                <div className="relative flex-1 min-h-0 flex flex-col items-center justify-center gap-2 px-6 text-center">
                    <div className="hidden sm:flex w-12 h-12 mb-1 rounded-2xl bg-zinc-800/60 border border-white/10 shadow-elev-1 items-center justify-center">
                        <Clapperboard className="w-6 h-6 text-blue-400" />
                    </div>
                    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11px] font-medium px-2 py-0.5 rounded-full bg-blue-500/10 border border-blue-500/20 text-blue-300">
                        <Clapperboard className="w-3 h-3" />
                        本地剧集{episodeLabel ? ` · ${episodeLabel}` : ''}
                    </span>
                    <h2 className="max-w-full truncate text-[17px] font-semibold tracking-tight text-zinc-100">
                        {showTitle}
                    </h2>
                    {episodeTitle && episodeTitle !== showTitle && (
                        <p className="max-w-full truncate text-xs text-zinc-500">{episodeTitle}</p>
                    )}
                </div>

                <div className="relative flex-none flex items-center gap-3 px-4 py-3 border-t border-white/5 bg-zinc-950/40">
                    <button
                        type="button"
                        data-testid="local-play-toggle"
                        onClick={onTogglePlay}
                        aria-label={isPlaying ? '暂停' : '播放'}
                        title={isPlaying ? '暂停（空格）' : '播放（空格）'}
                        className="w-9 h-9 rounded-full flex items-center justify-center transition-colors duration-200 active:scale-[0.95] bg-white/10 text-zinc-100 hover:bg-white/15 ring-1 ring-white/15 shrink-0"
                    >
                        {isPlaying ? (
                            <Pause className="w-4 h-4" fill="currentColor" />
                        ) : (
                            <Play className="w-4 h-4 ml-0.5" fill="currentColor" />
                        )}
                    </button>

                    <div
                        data-testid="local-progress"
                        role="slider"
                        aria-label="播放进度"
                        aria-valuemin={0}
                        aria-valuemax={Math.round(total)}
                        aria-valuenow={Math.round(Math.min(currentTime, total))}
                        tabIndex={0}
                        onPointerDown={seekFromPointer}
                        onKeyDown={handleProgressKeyDown}
                        className="relative flex-1 h-6 flex items-center cursor-pointer touch-none"
                    >
                        <div className="h-1 w-full rounded-full bg-zinc-800 overflow-hidden">
                            <div
                                data-testid="local-progress-fill"
                                className="h-full rounded-full bg-blue-500"
                                style={{ width: `${percent}%` }}
                            />
                        </div>
                        <span
                            aria-hidden="true"
                            className="absolute top-1/2 -translate-y-1/2 w-2.5 h-2.5 rounded-full bg-white shadow-md shadow-black/40"
                            style={{ left: `calc(${percent}% - 5px)` }}
                        />
                    </div>

                    <span
                        data-testid="local-time"
                        className="shrink-0 text-[11px] font-medium tabular-nums text-zinc-500"
                    >
                        <span className="text-zinc-300">{formatTime(currentTime)}</span> / {formatTime(total)}
                    </span>
                </div>
            </div>
        </div>
    );
};
