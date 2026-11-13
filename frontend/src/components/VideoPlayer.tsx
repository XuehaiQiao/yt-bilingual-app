import React, { useEffect, useRef, useState } from 'react';
import type { YouTubeProps } from 'react-youtube';
import YouTube from 'react-youtube';
import { Maximize, Minimize } from 'lucide-react';

interface VideoPlayerProps {
    videoId: string;
    onTimeUpdate: (time: number) => void;
    seekCommand?: { time: number; timestamp: number } | null;
    wrapperRef?: React.RefObject<HTMLDivElement | null>;
    playbackRate?: number;
    playToggleCommand?: number | null; // timestamp; toggles play/pause when it changes
    /** Optional: the embed became playable (used by local episodes to clear a fallback). */
    onPlayerReady?: () => void;
    /** Optional: the embed failed (unavailable / embed denied / network). */
    onPlayerError?: (code: number) => void;
}

export const VideoPlayer: React.FC<VideoPlayerProps> = ({
    videoId,
    onTimeUpdate,
    seekCommand,
    wrapperRef,
    playbackRate = 1,
    playToggleCommand,
    onPlayerReady,
    onPlayerError,
}) => {
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
        setIsPlaying(event.data === 1);
        isPlayingRef.current = event.data === 1;
    };

    const onError: YouTubeProps['onError'] = (event) => {
        // 2 invalid id, 5 HTML5 error, 100/101/150 unavailable or embed-denied.
        console.error('YouTube player error:', event.data);
        onPlayerError?.(event.data);
    };

    const [isFullscreen, setIsFullscreen] = useState(false);

    useEffect(() => {
        const handleFullscreenChange = () => {
            setIsFullscreen(!!document.fullscreenElement);
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);
        return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    }, []);

    const toggleFullscreen = () => {
        if (!document.fullscreenElement) {
            wrapperRef?.current?.requestFullscreen?.().catch(err => {
                console.error(`Error attempting to enable fullscreen: ${err.message}`);
            });
        } else {
            document.exitFullscreen?.();
        }
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
                    
                    {wrapperRef && (
                        <button
                            onClick={toggleFullscreen}
                            className="absolute bottom-4 right-4 p-2.5 bg-zinc-950/60 hover:bg-zinc-950/80 text-white rounded-lg backdrop-blur-md opacity-0 group-hover/video:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-[opacity,background-color,transform] duration-200 ease-apple active:scale-[0.98] flex items-center gap-2 z-50 pointer-events-auto"
                            title={isFullscreen ? "退出全屏" : "全屏"}
                        >
                            {isFullscreen ? <Minimize className="w-5 h-5" /> : <Maximize className="w-5 h-5" />}
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};
