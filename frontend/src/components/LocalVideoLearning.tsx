// Browser-local video learning view. The video is an object URL and the
// subtitle is parsed in the tab; nothing is uploaded. It deliberately reuses
// the transcript renderer and word lookup so the interaction matches the
// YouTube learning view, while native <video> controls own playback.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Film, Loader2, Sparkles, XCircle } from 'lucide-react';
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
import type { LocalTranscriptBlock } from '../lib/localMedia';

interface LocalVideoLearningProps {
    videoUrl: string;
    fileName: string;
    subtitleName?: string;
    transcript: LocalTranscriptBlock[];
    wordbookCount: number;
    onOpenWordbook: () => void;
    onClose: () => void;
    onWordLookup: (word: string, sentence: string, start: number, e: React.MouseEvent) => void;
}

export function LocalVideoLearning({
    videoUrl,
    fileName,
    subtitleName,
    transcript,
    wordbookCount,
    onOpenWordbook,
    onClose,
    onWordLookup,
}: LocalVideoLearningProps) {
    const { t } = useI18n();
    const videoRef = useRef<HTMLVideoElement>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [mediaError, setMediaError] = useState(false);
    const [translationMode, setTranslationMode] = useState<TranslationMode>(loadTranslationMode);
    const [showLanguagePoints, setShowLanguagePoints] = useState<boolean>(loadLanguagePointsEnabled);
    const [processed, setProcessed] = useState<LocalVideoProcessed | null>(null);
    const [processing, setProcessing] = useState(false);
    const [processError, setProcessError] = useState<string | null>(null);
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
        setProcessing(true);
        setProcessError(null);
        try {
            const result = await processLocalVideo(blocks, highlight.level);
            setProcessed(result);
        } catch (error) {
            setProcessError(error instanceof Error ? error.message : t('localVideo.analysisFailed'));
        } finally {
            setProcessing(false);
        }
    };

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

    return (
        <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
            <LearningHeader
                title={fileName}
                featureLabel={t('localVideo.feature')}
                onBack={onClose}
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
                                onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)}
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
                    ) : (
                        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center text-zinc-500">
                            {subtitleName ? <Loader2 className="h-5 w-5 animate-spin" /> : <Film className="h-8 w-8" />}
                            <p className="text-sm">{subtitleName ? t('localVideo.parsing') : t('localVideo.noSubtitleHint')}</p>
                        </div>
                    )}
                </section>
            </div>
        </div>
    );
}
