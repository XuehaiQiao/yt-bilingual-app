// Browser-local video learning view. The video is an object URL and the
// subtitle is parsed in the tab; nothing is uploaded. It deliberately reuses
// the transcript renderer and word lookup so the interaction matches the
// YouTube learning view, while native <video> controls own playback.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Captions, FileText, Film, Loader2, Sparkles, XCircle } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { findActiveIndex, loadTranslationMode, TRANSLATION_MODE_KEY, type TranslationMode } from '../lib/transcript';
import { useReadingHighlights } from '../lib/useReadingHighlights';
import { LearningHeader } from './LearningHeader';
import { ReadingHighlightToggle } from './ReadingHighlight';
import { LanguagePointToggle } from './ui/LanguagePointToggle';
import type { InlineLanguagePoint } from './TranscriptBlock';
import { loadLanguagePointsEnabled } from '../lib/highlightLayers';
import { processLocalVideo, type LocalVideoProcessed } from '../lib/localVideo';
import { TranscriptView } from './TranscriptView';
import type { LocalSubtitleFileError, LocalSubtitleFileResult, LocalTranscriptBlock } from '../lib/localMedia';
import { toast } from '../lib/toast';

interface LocalVideoLearningProps {
    videoUrl: string;
    fileName: string;
    subtitleName?: string;
    transcript: LocalTranscriptBlock[];
    /** Saved playback position; re-applied once the metadata is known. */
    initialTime?: number;
    wordbookCount: number;
    onOpenWordbook: () => void;
    onClose: () => void;
    onWordLookup: (word: string, sentence: string, start: number, e: React.MouseEvent) => void;
    /** Swap the subtitle without remounting the video (loaded later or replaced). */
    onLoadSubtitle: (file: File) => Promise<LocalSubtitleFileResult>;
    /** First decoded frame as a small JPEG; omitted when capture fails. */
    onCaptureCover?: (coverDataUrl: string) => void;
    /** Throttled playback position while the video is running. */
    onProgress?: (seconds: number) => void;
    /** Forced save on pause / close / tab switch. */
    onPersist?: (seconds: number) => void;
    /** Real duration once metadata arrives (persisted for progress display). */
    onMetadata?: (duration: number) => void;
}

export function LocalVideoLearning({
    videoUrl,
    fileName,
    subtitleName,
    transcript,
    initialTime,
    wordbookCount,
    onOpenWordbook,
    onClose,
    onWordLookup,
    onLoadSubtitle,
    onCaptureCover,
    onProgress,
    onPersist,
    onMetadata,
}: LocalVideoLearningProps) {
    const { t } = useI18n();
    const videoRef = useRef<HTMLVideoElement>(null);
    const subtitleInputRef = useRef<HTMLInputElement>(null);
    // Persistence callbacks are read through a ref so the unmount cleanup does
    // not re-subscribe (and never fires for an identity change mid-session).
    const persistenceRef = useRef({ onCaptureCover, onProgress, onPersist, onMetadata });
    persistenceRef.current = { onCaptureCover, onProgress, onPersist, onMetadata };
    const latestTimeRef = useRef(0);
    const lastReportedAtRef = useRef(0);
    const coverCapturedRef = useRef(false);
    const coverTimerRef = useRef<number | null>(null);
    const coverSeekRef = useRef(false);
    const disposedRef = useRef(false);
    const restoredRef = useRef(false);
    const [currentTime, setCurrentTime] = useState(0);
    const [mediaError, setMediaError] = useState(false);
    const [translationMode, setTranslationMode] = useState<TranslationMode>(loadTranslationMode);
    const [showLanguagePoints, setShowLanguagePoints] = useState<boolean>(loadLanguagePointsEnabled);
    const [processed, setProcessed] = useState<LocalVideoProcessed | null>(null);
    const [processing, setProcessing] = useState(false);
    const [processError, setProcessError] = useState<string | null>(null);
    const [subtitleLoading, setSubtitleLoading] = useState(false);
    const [subtitleError, setSubtitleError] = useState<string | null>(null);
    // Changing the subtitle invalidates an in-flight AI pass for the old cues.
    const analysisEpoch = useRef(0);
    const blocks = useMemo<LocalTranscriptBlock[]>(
        () => (processed
            ? processed.blocks.map((block) => ({ ...block, highlights: [] as [] }))
            : transcript),
        [processed, transcript],
    );
    const highlight = useReadingHighlights(blocks.map((block) => block.en_text));
    const languagePointsByBlock = useMemo(() => {
        const map: Record<string, InlineLanguagePoint[]> = {};
        if (!processed) return map;
        for (const idiom of processed.idioms) {
            (map[String(idiom.blockId)] ??= []).push({
                text: idiom.phrase,
                meaning: idiom.meaning,
                kind: 'idiom',
            });
        }
        for (const culture of processed.culture) {
            (map[String(culture.blockId)] ??= []).push({
                text: culture.term,
                meaning: culture.note,
                kind: 'culture',
            });
        }
        return map;
    }, [processed]);
    const wordGlossesByBlock = useMemo(() => {
        const map: Record<string, Record<string, string>> = {};
        if (!processed) return map;
        for (const [blockId, entries] of Object.entries(processed.highlights)) {
            const glosses: Record<string, string> = {};
            for (const entry of entries) {
                const word = entry.en_word?.trim().toLowerCase();
                const gloss = entry.zh_word?.trim();
                if (word && gloss) glosses[word] = gloss;
            }
            if (Object.keys(glosses).length > 0) map[blockId] = glosses;
        }
        return map;
    }, [processed]);
    const handleAnalyze = async () => {
        if (processing || blocks.length === 0) return;
        const epoch = analysisEpoch.current;
        setProcessing(true);
        setProcessError(null);
        try {
            const result = await processLocalVideo(blocks, highlight.level);
            if (epoch === analysisEpoch.current) setProcessed(result);
        } catch (error) {
            if (epoch === analysisEpoch.current) {
                setProcessError(error instanceof Error ? error.message : t('localVideo.analysisFailed'));
            }
        } finally {
            setProcessing(false);
        }
    };

    const subtitleErrorMessage = (reason: LocalSubtitleFileError) => {
        if (reason === 'format') return t('localVideo.subtitleFormatError');
        if (reason === 'empty') return t('localVideo.subtitleEmpty');
        return t('localVideo.subtitleReadFailed');
    };

    const loadSubtitle = async (file: File) => {
        if (subtitleLoading) return;
        setSubtitleLoading(true);
        setSubtitleError(null);
        try {
            const result = await onLoadSubtitle(file);
            if (!result.ok) {
                setSubtitleError(subtitleErrorMessage(result.reason));
                return;
            }
            // The previous AI pass described the old cues; start clean so the
            // button re-enables against the new transcript.
            analysisEpoch.current += 1;
            setProcessed(null);
            setProcessError(null);
            toast.success(t('localVideo.subtitleLoaded', { name: file.name, count: result.transcript.length }));
        } catch {
            setSubtitleError(t('localVideo.subtitleReadFailed'));
        } finally {
            setSubtitleLoading(false);
        }
    };

    const openSubtitlePicker = () => subtitleInputRef.current?.click();

    const activeIndex = useMemo(
        () => findActiveIndex(blocks, currentTime),
        [blocks, currentTime],
    );

    useEffect(() => {
        localStorage.setItem(TRANSLATION_MODE_KEY, translationMode);
    }, [translationMode]);

    const seek = (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = Math.max(0, Math.min(time, video.duration || time));
        setCurrentTime(video.currentTime);
    };

    /** Time updates are noisy; persist at most once every two seconds. */
    const reportProgress = (time: number, force = false) => {
        const now = performance.now();
        if (!force && now - lastReportedAtRef.current < 2000) return;
        lastReportedAtRef.current = now;
        persistenceRef.current.onProgress?.(time);
    };

    const handleLoadedMetadata = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        const video = event.currentTarget;
        if (Number.isFinite(video.duration) && video.duration > 0) {
            persistenceRef.current.onMetadata?.(video.duration);
        }
        // Resume the saved position only once, and never past the real end.
        if (restoredRef.current) return;
        restoredRef.current = true;
        const saved = initialTime ?? 0;
        if (!Number.isFinite(saved) || saved <= 0) return;
        if (!Number.isFinite(video.duration) || video.duration <= 0) return;
        const target = Math.min(saved, Math.max(0, video.duration - 0.25));
        if (target <= 0) return;
        try {
            video.currentTime = target;
            latestTimeRef.current = target;
            setCurrentTime(target);
        } catch {
            // A seek before the media is seekable must not break playback; the
            // video simply starts at 0 and progress is saved from there.
        }
    };

    const handleLoadedData = (event: React.SyntheticEvent<HTMLVideoElement>) => {
        if (coverCapturedRef.current) return;
        const video = event.currentTarget;
        if (!video.videoWidth || !video.videoHeight) return;
        // At `loadeddata` the first paused frame at t=0 is often a black
        // placeholder: Chromium only presents a decoded frame after a seek or
        // playback. Wait for a presented frame (rVFC) and, when the video is
        // still sitting at 0, nudge it 200ms in so the cover is a real frame.
        const capture = () => {
            coverSeekRef.current = false;
            if (coverCapturedRef.current || disposedRef.current) return;
            if (!video.videoWidth || !video.videoHeight) return;
            try {
                const canvas = document.createElement('canvas');
                canvas.width = 320;
                canvas.height = 180;
                const context = canvas.getContext('2d');
                if (!context) return;
                // Fill 320×180 (center-crop) so every cover has the same shape.
                const scale = Math.max(320 / video.videoWidth, 180 / video.videoHeight);
                const drawWidth = video.videoWidth * scale;
                const drawHeight = video.videoHeight * scale;
                context.drawImage(
                    video,
                    (320 - drawWidth) / 2,
                    (180 - drawHeight) / 2,
                    drawWidth,
                    drawHeight,
                );
                const dataUrl = canvas.toDataURL('image/jpeg', 0.72);
                if (!dataUrl.startsWith('data:image/jpeg')) return;
                coverCapturedRef.current = true;
                persistenceRef.current.onCaptureCover?.(dataUrl);
            } catch (error) {
                // No fake cover: the shelf shows its film placeholder instead.
                console.warn('Local video cover capture failed:', error);
            }
        };
        const scheduleCapture = () => {
            coverSeekRef.current = false;
            if (typeof video.requestVideoFrameCallback === 'function') {
                video.requestVideoFrameCallback(() => capture());
            }
            // Fallback for browsers without rVFC or without a presented frame.
            coverTimerRef.current = window.setTimeout(capture, 900);
        };

        const needsFrameSeek = video.paused
            && video.currentTime < 0.05
            && Number.isFinite(video.duration)
            && video.duration > 0.3;
        if (!needsFrameSeek) {
            scheduleCapture();
            return;
        }
        coverSeekRef.current = true;
        const onSeeked = () => {
            video.removeEventListener('seeked', onSeeked);
            scheduleCapture();
        };
        video.addEventListener('seeked', onSeeked, { once: true });
        try {
            // A tiny, invisible nudge: playback still reads 00:00 in the
            // controls, and a saved cover stops being a black rectangle.
            video.currentTime = Math.min(0.2, video.duration / 4);
        } catch {
            video.removeEventListener('seeked', onSeeked);
            scheduleCapture();
        }
        coverTimerRef.current = window.setTimeout(capture, 1800);
    };

    const persistNow = (time: number) => {
        latestTimeRef.current = time;
        persistenceRef.current.onPersist?.(time);
    };

    // Closing the player and switching tabs both unmount this view; a hidden
    // tab can also happen before the unmount. Both must save the position.
    useEffect(() => {
        // StrictMode runs mount → cleanup → mount in development; a fresh
        // effect must clear the disposed flag so cover capture still works.
        disposedRef.current = false;
        const persist = () => {
            const video = videoRef.current;
            const time = video && Number.isFinite(video.currentTime)
                ? video.currentTime
                : latestTimeRef.current;
            persistenceRef.current.onPersist?.(time);
        };
        const onVisibilityChange = () => {
            if (document.visibilityState === 'hidden') persist();
        };
        window.addEventListener('pagehide', persist);
        document.addEventListener('visibilitychange', onVisibilityChange);
        return () => {
            window.removeEventListener('pagehide', persist);
            document.removeEventListener('visibilitychange', onVisibilityChange);
            disposedRef.current = true;
            if (coverTimerRef.current !== null) {
                window.clearTimeout(coverTimerRef.current);
                coverTimerRef.current = null;
            }
            persist();
        };
    }, []);

    const handleClose = () => {
        const video = videoRef.current;
        persistNow(video && Number.isFinite(video.currentTime) ? video.currentTime : latestTimeRef.current);
        onClose();
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <input
                ref={subtitleInputRef}
                type="file"
                accept=".srt,.vtt"
                data-testid="local-video-subtitle-input"
                aria-label={t('localVideo.loadSubtitle')}
                className="sr-only"
                onChange={(event) => {
                    const file = event.target.files?.[0];
                    event.target.value = '';
                    if (file) void loadSubtitle(file);
                }}
            />
            <LearningHeader
                title={fileName}
                featureLabel={t('localVideo.feature')}
                onBack={handleClose}
                parentLabel={t('nav.content')}
                wordbookCount={wordbookCount}
                onOpenWordbook={onOpenWordbook}
            />
            <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-hidden">
                <section className="min-w-0 lg:w-[58%] flex flex-col bg-black/30">
                    <div className="relative flex-1 min-h-0 flex items-center justify-center bg-black">
                        {mediaError ? (
                            <div className="flex flex-col items-center gap-2 px-6 text-center text-sm text-amber-200">
                                <XCircle className="h-6 w-6" />
                                <p>{t('localVideo.unsupported')}</p>
                                <p className="text-xs text-zinc-400">{fileName}</p>
                            </div>
                        ) : (
                            <video
                                ref={videoRef}
                                data-testid="local-video-player"
                                src={videoUrl}
                                controls
                                playsInline
                                preload="metadata"
                                className="h-full w-full object-contain"
                                onLoadedMetadata={handleLoadedMetadata}
                                onLoadedData={handleLoadedData}
                                onTimeUpdate={(event) => {
                                    const time = event.currentTarget.currentTime;
                                    // The cover-capture nudge is not user progress.
                                    if (!coverSeekRef.current) {
                                        latestTimeRef.current = time;
                                        reportProgress(time);
                                    }
                                    setCurrentTime(time);
                                }}
                                onPause={(event) => persistNow(event.currentTarget.currentTime)}
                                onEnded={(event) => persistNow(event.currentTarget.currentTime)}
                                onError={() => setMediaError(true)}
                            />
                        )}
                    </div>
                    <div className="flex-none flex flex-wrap items-center gap-2 border-t border-white/5 bg-zinc-950/60 px-3 py-2 text-xs text-zinc-400">
                        <Film className="h-4 w-4 text-brand-300" />
                        <span className="truncate">{subtitleName || t('localVideo.noSubtitle')}</span>
                        <span className="text-zinc-600">
                            {transcript.length > 0
                                ? t('localVideo.cues', { count: transcript.length })
                                : t('localVideo.noTranscript')}
                        </span>
                    </div>
                </section>

                <section className="min-w-0 lg:flex-1 flex flex-col border-t lg:border-t-0 lg:border-l border-white/5 bg-[#09090b]">
                    <div className="flex-none flex flex-wrap items-center gap-2 border-b border-white/5 px-3 py-2">
                        <button
                            type="button"
                            data-testid="local-video-analyze"
                            onClick={() => { void handleAnalyze(); }}
                            disabled={processing || blocks.length === 0}
                            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-brand/20 bg-brand/10 px-2.5 text-xs font-medium text-brand-300 transition-colors hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
                        >
                            {processing
                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                : <Sparkles className="h-3.5 w-3.5" />}
                            {processing ? t('localVideo.analyzing') : t('localVideo.analyze')}
                        </button>
                        {transcript.length > 0 && (
                            <button
                                type="button"
                                data-testid="local-video-change-subtitle"
                                onClick={openSubtitlePicker}
                                disabled={subtitleLoading}
                                className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-lg border border-white/5 bg-zinc-800/60 px-2.5 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-700/60 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {subtitleLoading
                                    ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                                    : <Captions className="h-3.5 w-3.5" />}
                                {subtitleLoading ? t('localVideo.readingSubtitle') : t('localVideo.changeSubtitle')}
                            </button>
                        )}
                        <ReadingHighlightToggle
                            testId="local-video-highlight-toggle"
                            enabled={highlight.enabled}
                            onChange={highlight.setEnabled}
                            levelLabel={highlight.levelLabel}
                        />
                        <LanguagePointToggle
                            enabled={showLanguagePoints}
                            onChange={setShowLanguagePoints}
                            testId="local-video-language-points-toggle"
                        />
                        <span className="text-xs font-medium text-zinc-500">{t('transcript.translationLabel')}</span>
                        <div className="inline-flex rounded-lg border border-white/5 bg-zinc-800/80 p-0.5">
                            {(['all', 'hidden'] as const).map((mode) => (
                                <button
                                    key={mode}
                                    type="button"
                                    data-testid={`local-translation-${mode}`}
                                    onClick={() => setTranslationMode(mode)}
                                    className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
                                        translationMode === mode
                                            ? 'bg-zinc-100 text-zinc-900'
                                            : 'text-zinc-400 hover:text-zinc-200'
                                    }`}
                                >
                                    {mode === 'all' ? t('transcript.mode.all') : t('transcript.mode.hidden')}
                                </button>
                            ))}
                        </div>
                    </div>

                    {subtitleError && (
                        <p
                            role="alert"
                            data-testid="local-video-subtitle-error"
                            className="flex items-start gap-1.5 border-b border-amber-500/15 bg-amber-500/[0.05] px-3 py-1.5 text-xs text-amber-200"
                        >
                            <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                            <span>{subtitleError}</span>
                        </p>
                    )}
                    {processError && (
                        <p className="border-b border-amber-500/15 bg-amber-500/[0.05] px-3 py-1.5 text-xs text-amber-200">
                            {processError}
                        </p>
                    )}
                    {blocks.length > 0 ? (
                        <div className="flex-1 min-h-0">
                            <TranscriptView
                                transcript={blocks}
                                activeIndex={activeIndex}
                                videoId={`local:${fileName}`}
                                favorites={[]}
                                onTranscriptClick={seek}
                                onToggleFavorite={() => {}}
                                translationMode={translationMode}
                                translationPending={blocks.some((block) => block.zh_text.trim().length > 0)}
                                onWordLookup={onWordLookup}
                                isHighlighted={highlight.isHighlighted}
                                languagePointsByBlock={languagePointsByBlock}
                                wordGlossesByBlock={wordGlossesByBlock}
                                showLanguagePoints={showLanguagePoints}
                                difficultyEnabled={highlight.enabled}
                                difficultyLevel={highlight.level}
                                difficultyVersion={highlight.wordLevels.size}
                                borderLeft={false}
                                pageScroll={false}
                            />
                        </div>
                    ) : subtitleName ? (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-zinc-500">
                            <Loader2 className="h-5 w-5 animate-spin" />
                            <p className="text-sm">{t('localVideo.parsing')}</p>
                        </div>
                    ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-zinc-500">
                            <Film className="h-8 w-8" />
                            <p className="text-sm">{t('localVideo.noSubtitleHint')}</p>
                            <button
                                type="button"
                                data-testid="local-video-load-subtitle"
                                onClick={openSubtitlePicker}
                                disabled={subtitleLoading}
                                className="mt-1 inline-flex h-9 items-center gap-2 rounded-xl border border-brand/20 bg-brand/10 px-4 text-sm font-medium text-brand-300 transition-colors hover:bg-brand/15 disabled:cursor-not-allowed disabled:opacity-50"
                            >
                                {subtitleLoading
                                    ? <Loader2 className="h-4 w-4 animate-spin" />
                                    : <FileText className="h-4 w-4" />}
                                {subtitleLoading ? t('localVideo.readingSubtitle') : t('localVideo.loadSubtitle')}
                            </button>
                            <p className="text-[11px] text-zinc-600">{t('localVideo.subtitleLocalOnly')}</p>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
