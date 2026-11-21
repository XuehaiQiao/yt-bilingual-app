// "For you" recommendation row (user request #10 / V1 rule recommendations).
//
// Sits directly under the Today workbench. The backend does the selection and
// writes the reason; this component only renders it and hands the chosen
// YouTube URL to the same estimate → processing flow as the home link input.
// "换一批" changes the deterministic `seed` instead of inventing new data.
import { useEffect, useState } from 'react';
import { AlertCircle, Clock, Loader2, Play, RefreshCw, Sparkles } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import {
    fetchRecommendations,
    formatRecommendationDuration,
    type RecommendationResult,
} from '../lib/recommend';
import { Badge } from './ui/Badge';
import { Card } from './ui/Card';

interface HomeRecommendationsProps {
    /** Reuse the existing estimate dialog / processing pipeline (never a new path). */
    onSelect: (url: string) => void;
}

const THUMB =
    'relative aspect-video rounded-lg overflow-hidden bg-zinc-900 border border-white/5';

export function HomeRecommendations({ onSelect }: HomeRecommendationsProps) {
    const { t, targetLang } = useI18n();
    const [result, setResult] = useState<RecommendationResult | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [seed, setSeed] = useState(0);
    const [retryToken, setRetryToken] = useState(0);

    useEffect(() => {
        const controller = new AbortController();
        // The network is the external system this effect syncs with.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setLoading(true);
        setFailed(false);
        fetchRecommendations({ limit: 6, seed, signal: controller.signal })
            .then((payload) => {
                if (controller.signal.aborted) return;
                setResult(payload);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load recommendations:', error);
                setFailed(true);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return () => controller.abort();
    }, [seed, retryToken, targetLang]);

    const items = result?.items ?? [];
    const basis = result?.basis ?? null;
    const subtitle = basis
        ? basis.source === 'profile'
            ? t('home.recommend.subtitleProfile', { band: basis.band })
            : t('home.recommend.subtitleDefault', { band: basis.band })
        : t('home.recommend.subtitle');

    const refresh = () => setSeed((previous) => (previous + 1) % 1000);
    const retry = () => {
        if (seed !== 0) setSeed(0);
        setRetryToken((previous) => previous + 1);
    };

    return (
        <section
            data-testid="home-recommendations"
            data-source={basis?.source ?? ''}
            data-band={basis?.band ?? ''}
            data-preliminary={result?.preliminary ? 'true' : 'false'}
            className="min-w-0"
        >
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Sparkles className="w-4 h-4 text-blue-400 shrink-0" />
                        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('home.recommend.title')}
                        </h3>
                        {result?.preliminary && (
                            <Badge
                                tone="neutral"
                                testId="recommend-preliminary"
                                title={t('home.recommend.preliminaryHint')}
                            >
                                {t('home.recommend.preliminary')}
                            </Badge>
                        )}
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 break-words">
                        {subtitle}
                    </p>
                </div>
                <button
                    type="button"
                    data-testid="recommend-refresh"
                    onClick={refresh}
                    disabled={loading}
                    className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-50 disabled:cursor-default"
                >
                    <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
                    {t('home.recommend.refresh')}
                </button>
            </div>

            {loading && !result ? (
                <div
                    data-testid="recommend-loading"
                    className="mt-3 flex gap-3 overflow-hidden"
                    aria-live="polite"
                >
                    {Array.from({ length: 3 }).map((_, index) => (
                        <Card
                            key={index}
                            padding="none"
                            className="w-[168px] sm:w-[224px] shrink-0 p-2 sm:p-2.5"
                        >
                            <div className="aspect-video rounded-lg bg-zinc-800/70 animate-pulse" />
                            <div className="mt-2 h-3 w-4/5 rounded bg-zinc-800/70 animate-pulse" />
                            <div className="mt-1.5 h-3 w-2/3 rounded bg-zinc-800/50 animate-pulse" />
                        </Card>
                    ))}
                    <span className="sr-only">{t('home.recommend.loading')}</span>
                </div>
            ) : failed && !result ? (
                <Card
                    padding="none"
                    testId="recommend-failed"
                    className="mt-3 flex flex-wrap items-center gap-3 px-4 py-3"
                >
                    <AlertCircle className="w-4 h-4 text-zinc-500 shrink-0" />
                    <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-500">
                        {t('home.recommend.failed')}
                    </p>
                    <button
                        type="button"
                        onClick={retry}
                        className="inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {t('home.recommend.retry')}
                    </button>
                </Card>
            ) : items.length === 0 ? (
                <Card
                    padding="none"
                    testId="recommend-empty"
                    className="mt-3 px-4 py-3 text-xs leading-relaxed text-zinc-500"
                >
                    {t('home.recommend.empty')}
                </Card>
            ) : (
                <div
                    data-testid="recommend-row"
                    className={`mt-3 flex gap-2.5 sm:gap-3 overflow-x-auto overflow-y-hidden pb-2 pr-1 snap-x snap-mandatory custom-scrollbar ${
                        loading ? 'opacity-60 transition-opacity' : ''
                    }`}
                >
                    {items.map((item, index) => {
                        const duration = formatRecommendationDuration(item.duration);
                        const title = item.title || t('home.recommend.untitled');
                        // One visible CEFR per card: the computed input band when
                        // available, otherwise the editorial level. The novelty
                        // chip below never repeats a second band.
                        const displayLevel = item.difficulty?.cefrInput ?? item.level;
                        return (
                            <Card
                                key={`${item.videoId}-${index}`}
                                variant="interactive"
                                padding="none"
                                testId={`recommend-card-${index}`}
                                data-video-id={item.videoId}
                                data-level={displayLevel}
                                ariaLabel={t('home.recommend.cardAria', { title })}
                                onClick={() => onSelect(item.url)}
                                className="group w-[168px] sm:w-[224px] shrink-0 snap-start p-2 sm:p-2.5"
                            >
                                <div className={THUMB}>
                                    <div className="absolute inset-0 flex items-center justify-center text-zinc-700">
                                        <Play className="w-7 h-7" />
                                    </div>
                                    {item.thumbnail && (
                                        <img
                                            src={item.thumbnail}
                                            alt=""
                                            loading="lazy"
                                            decoding="async"
                                            className="relative w-full h-full object-cover"
                                            onError={(event) => {
                                                event.currentTarget.style.display = 'none';
                                            }}
                                        />
                                    )}
                                    <span
                                        className="absolute top-1.5 left-1.5 inline-flex items-center rounded-md border border-white/10 bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-medium text-zinc-200 tabular-nums backdrop-blur-sm"
                                        title={t('home.recommend.levelAria', { level: displayLevel })}
                                    >
                                        {displayLevel}
                                    </span>
                                    {duration && (
                                        <span className="absolute bottom-1.5 right-1.5 inline-flex items-center gap-1 rounded-md bg-zinc-950/80 px-1.5 py-0.5 text-[11px] font-medium text-zinc-300 tabular-nums backdrop-blur-sm">
                                            <Clock className="w-3 h-3" />
                                            {duration}
                                        </span>
                                    )}
                                </div>
                                <p className="mt-2 min-h-[2.5em] text-[13px] font-medium leading-snug text-zinc-100 line-clamp-2 break-words">
                                    {title}
                                </p>
                                <p className="mt-0.5 truncate text-[11px] text-zinc-500">
                                    {item.channel || t('home.recommend.unknownChannel')}
                                </p>
                                {item.difficulty?.bucket && (
                                    <Badge
                                        tone="neutral"
                                        testId={`recommend-difficulty-${index}`}
                                        data-cefr-input={item.difficulty?.cefrInput ?? ''}
                                        data-bucket={item.difficulty.bucket}
                                        title={t('difficulty.estimateHint')}
                                        className="mt-1"
                                    >
                                        {t('difficulty.novelty', { bucket: item.difficulty.bucket })}
                                    </Badge>
                                )}
                                <p className="mt-1 min-h-[2.9em] text-[11px] leading-relaxed text-zinc-500 line-clamp-2 break-words">
                                    {item.reason}
                                </p>
                            </Card>
                        );
                    })}
                </div>
            )}

            {loading && result && (
                <p className="sr-only" aria-live="polite">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    {t('home.recommend.loading')}
                </p>
            )}
        </section>
    );
}
