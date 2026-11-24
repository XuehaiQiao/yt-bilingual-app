import React, { useEffect, useRef, useState } from 'react';
import type { YouTubeProps } from 'react-youtube';
import YouTube from 'react-youtube';
import { Clapperboard } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';

interface VideoPlayerProps {
    videoId: string;
    onTimeUpdate: (time: number) => void;
    seekCommand?: { time: number; timestamp: number } | null;
    playbackRate?: number;
    playToggleCommand?: number | null; // timestamp; toggles play/pause when it changes
    /** Optional: the embed became playable (used by local episodes to clear a fallback). */
    onPlayerReady?: () => void;
    /** Optional: the embed failed (unavailable / embed denied / network). */
    onPlayerError?: (code: number) => void;
    /** Optional: play/pause transitions, used to flush watch-event segments. */
    onPlaybackStateChange?: (playing: boolean) => void;
    /** 观影模式 (specs/044): hints the page-level layout, never the embed. */
    watchMode?: boolean;
    /** Optional: render the 观影模式 entry in the player toolbar. */
    onToggleWatchMode?: () => void;
    /** 观影模式 overlay slot: painted between the embed and the controls. */
    children?: React.ReactNode;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
    videoId,
    onTimeUpdate,
    seekCommand,
    playbackRate = 1,
    playToggleCommand,
    onPlayerReady,
    onPlayerError,
    onPlaybackStateChange,
    watchMode = false,
    onToggleWatchMode,
    children,
}) => {
    const { t } = useI18n();
    const playerRef = useRef<any>(null);
    const [isPlaying, setIsPlaying] = useState(false);
    const isPlayingRef = useRef(false);

    // Apply playback rate (also re-applied when a new video loads)
    useEffect(() => {
        try {
            playerRef.current?.setPlaybackRate(playbackRate);
        } catch { /* player not ready yet */ }
    }, [playbackRate, videoId]);

    // Toggle play/pause on command (keyboard space)
    useEffect(() => {
        if (!playToggleCommand || !playerRef.current) return;
        try {
            if (isPlayingRef.current) playerRef.current.pauseVideo();
            else playerRef.current.playVideo();
        } catch { /* ignore */ }
    }, [playToggleCommand]);

    // Watch for seek commands
    useEffect(() => {
        if (seekCommand && playerRef.current) {
            try {
                // target directly exposes YouTube Player API
                playerRef.current.seekTo(seekCommand.time, true);
                if (!isPlaying) {
                    playerRef.current.playVideo();
                }
            } catch (err) {
                console.error("Seek error:", err);
            }
        }
    }, [seekCommand]);

    // Poll for the current time only when playing
    useEffect(() => {
        let interval: ReturnType<typeof setInterval>;
        if (isPlaying && playerRef.current) {
            interval = setInterval(async () => {
                try {
                    const time = await playerRef.current.getCurrentTime();
                    onTimeUpdate(time);
                } catch (err) {
                    // Ignore
                }
            }, 100); // 100ms for smooth highlighting
        }

        return () => {
            if (interval) clearInterval(interval);
        };
    }, [isPlaying, onTimeUpdate]);

    const onReady: YouTubeProps['onReady'] = (event) => {
        playerRef.current = event.target;
        try {
            event.target.setPlaybackRate(playbackRate);
        } catch { /* player not ready yet */ }
        if (seekCommand) {
            event.target.seekTo(seekCommand.time, true);
        }
        event.target.playVideo();
        onPlayerReady?.();
    };

    const onStateChange: YouTubeProps['onStateChange'] = (event) => {
        // PlayerState.PLAYING = 1
        const playing = event.data === 1;
        setIsPlaying(playing);
        isPlayingRef.current = playing;
        onPlaybackStateChange?.(playing);
    };

    const onError: YouTubeProps['onError'] = (event) => {
        // 2 invalid id, 5 HTML5 error, 100/101/150 unavailable or embed-denied.
        console.error('YouTube player error:', event.data);
        onPlayerError?.(event.data);
    };

    const opts = {
        height: '100%',
        width: '100%',
        playerVars: {
            autoplay: 1,
            modestbranding: 1,
            rel: 0,
            playsinline: 1,
            fs: 0
        },
    };

    return (
        <div
            className="w-full h-full bg-transparent relative"
            data-testid="video-player"
            data-video-id={videoId}
        >
            <div className="absolute inset-x-0 inset-y-0 p-4 group/video">
                <div className="w-full h-full rounded-xl overflow-hidden shadow-2xl ring-1 ring-white/10 relative">
                    <YouTube
                        videoId={videoId}
                        opts={opts}
                        onReady={onReady}
                        onStateChange={onStateChange}
                        onError={onError}
                        className="w-full h-full"
                        iframeClassName="w-full h-full pointer-events-auto"
                    />

                    {children}

                    {/* 观影模式 entry (specs/044 §1). In watch mode this
                        control is NOT rendered: the floating WatchTopBar owns
                        exit (P2-15, specs/045 §4.1) so the picture carries no
                        second, redundant exit affordance. The embed's own
                        YouTube controls stay untouched either way. */}
                    {onToggleWatchMode && !watchMode && (
                        <button
                            type="button"
                            data-testid="watch-mode-toggle"
                            aria-pressed={false}
                            aria-label={t('watchMode.enter')}
                            title={t('watchMode.enter')}
                            onClick={onToggleWatchMode}
                            className="absolute bottom-4 right-16 p-2.5 bg-app/60 hover:bg-app/80 text-fg-primary rounded-lg backdrop-blur-md opacity-0 group-hover/video:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-[opacity,background-color,transform] duration-200 ease-apple motion-reduce:transition-none active:scale-[0.98] flex items-center gap-2 z-chrome pointer-events-auto"
                        >
                            <Clapperboard className="w-5 h-5" />
                            <span className="text-xs font-medium whitespace-nowrap">
                                {t('watchMode.enter')}
                            </span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
