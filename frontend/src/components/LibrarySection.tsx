// Home "free library" window (user request #11).
//
// Sits directly below "For you": no login, no LLM, no price estimate. The list
// is 50+ pre-built videos (bilingual blocks already on disk, YouTube embed,
// A1–C2 level filter chips) and the original/public-domain bilingual articles.
// Clicking a card hands the id to App, which fetches the detail and enters the
// existing video view or the local article reader.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
    AlertCircle,
    BookOpen,
    Clock,
    FileText,
    Library,
    Play,
    RefreshCw,
} from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { getAbilityProfile } from '../lib/ability';
import {
    difficultyBadge,
    difficultyBucket,
    difficultyKey,
    fetchDifficultyBatch,
    type DifficultyItem,
} from '../lib/difficulty';
import {
    fetchLibraryIndex,
    type LibraryArticleSummary,
    type LibraryIndex,
    type LibraryVideoSummary,
} from '../lib/library';
import { Tabs, tabPanelProps } from './ui/Tabs';
import { FilterChip } from './ui/FilterChip';

interface LibrarySectionProps {
    /** Open a pre-built video (App loads blocks and enters the video view). */
    onOpenVideo: (id: string) => void;
    /** Open an original article in the local reader. */
    onOpenArticle: (id: string) => void;
}

type LibraryTab = 'videos' | 'articles';

const CEFR_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const;
const LEVEL_FILTERS = ['ALL', ...CEFR_LEVELS] as const;
type LevelFilter = (typeof LEVEL_FILTERS)[number];

const CARD =
    'group shrink-0 w-[196px] sm:w-[236px] snap-start text-left rounded-2xl border border-white/5 ' +
    'bg-zinc-900/40 p-4 hover:border-white/10 hover:bg-zinc-800/40 transition-colors cursor-pointer';

function DifficultyBadge({
    level,
    difficulty,
    testId,
    hideBand = false,
}: {
    level: string;
    difficulty?: DifficultyItem | null;
    testId: string;
    /** Videos already show an editorial level badge; suppress the second CEFR. */
    hideBand?: boolean;
}) {
    const { t } = useI18n();
    const band = hideBand ? null : difficultyBadge(difficulty, level);
    const bucket = difficultyBucket(difficulty);
    return (
        <span className="inline-flex flex-col items-end gap-0.5">
            {band && (
                <span
                    data-testid={testId}
                    data-cefr-input={difficulty?.cefrInput ?? ''}
                    data-bucket={bucket ?? ''}
                    title={t('difficulty.estimateHint')}
                    className="inline-flex items-center rounded-full border border-blue-500/20 bg-blue-500/10 px-2 py-0.5 text-[11px] font-medium text-blue-300"
                >
                    {band}
                </span>
            )}
            {bucket && (
                <span className="text-[10px] text-zinc-500 tabular-nums">
                    {t('difficulty.novelty', { bucket })}
                </span>
            )}
        </span>
    );
}

function VideoCard({
    video,
    onOpen,
    difficulty,
}: {
    video: LibraryVideoSummary;
    onOpen: (id: string) => void;
    difficulty?: DifficultyItem | null;
}) {
    const { t, formatNumber } = useI18n();
    return (
        <button
            type="button"
            data-testid={`library-video-card-${video.id}`}
            aria-label={t('library.videoCardAria', { title: video.title })}
            onClick={() => onOpen(video.id)}
            className={CARD}
        >
            <div className="flex items-center justify-between">
                <span className="w-10 h-10 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-300 flex items-center justify-center">
                    <Play className="w-4 h-4" fill="currentColor" />
                </span>
                <span
                    data-testid="library-free-badge"
                    className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"
                >
                    {t('library.free')}
                </span>
            </div>
            <h4 className="mt-3 min-h-[2.6em] text-[13px] font-semibold leading-snug text-zinc-100 line-clamp-2 break-words">
                {video.title}
            </h4>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{video.channel}</p>
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                <span className="inline-flex min-w-0 items-center gap-1.5 tabular-nums">
                    <span
                        data-testid={`library-video-level-${video.id}`}
                        title={t('library.levelTagAria', { level: video.level })}
                        className="inline-flex items-center rounded-md bg-zinc-800/80 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300"
                    >
                        {video.level}
                    </span>
                    <span className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {t('library.minutes', { count: formatNumber(Math.max(1, Math.round(video.duration / 60))) })}
                    </span>
                </span>
                <DifficultyBadge
                    level={video.level}
                    difficulty={difficulty}
                    testId={`library-video-difficulty-${video.id}`}
                    hideBand
                />
            </div>
            <p className="mt-2 text-[10px] font-medium text-zinc-600 group-hover:text-zinc-500 transition-colors">
                {t('library.cardHint')}
            </p>
        </button>
    );
}

function ArticleCard({
    article,
    onOpen,
    difficulty,
}: {
    article: LibraryArticleSummary;
    onOpen: (id: string) => void;
    difficulty?: DifficultyItem | null;
}) {
    const { t, formatNumber } = useI18n();
    return (
        <button
            type="button"
            data-testid={`library-article-card-${article.id}`}
            aria-label={t('library.articleCardAria', { title: article.title })}
            onClick={() => onOpen(article.id)}
            className={CARD}
        >
            <div className="flex items-center justify-between">
                <span className="w-10 h-10 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-300 flex items-center justify-center">
                    <BookOpen className="w-4 h-4" />
                </span>
                <span
                    data-testid="library-free-badge"
                    className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300"
                >
                    {t('library.free')}
                </span>
            </div>
            <h4 className="mt-3 min-h-[2.6em] text-[13px] font-semibold leading-snug text-zinc-100 line-clamp-2 break-words">
                {article.title}
            </h4>
            <p className="mt-0.5 truncate text-[11px] text-zinc-500">{t('library.articleHint')}</p>
            <div className="mt-3 flex items-center justify-between gap-2 text-[11px] text-zinc-500">
                <span className="inline-flex items-center gap-1 tabular-nums">
                    <FileText className="w-3.5 h-3.5" />
                    {t('library.words', { count: formatNumber(article.wordCount) })}
                </span>
                <DifficultyBadge
                    level={article.level}
                    difficulty={difficulty}
                    testId={`library-article-difficulty-${article.id}`}
                />
            </div>
            <p className="mt-2 text-[10px] font-medium text-zinc-600 group-hover:text-zinc-500 transition-colors">
                {t('library.cardHint')}
            </p>
        </button>
    );
}

function SkeletonCard() {
    return (
        <div className="shrink-0 w-[196px] sm:w-[236px] rounded-2xl border border-white/5 bg-zinc-900/40 p-4">
            <div className="flex items-center justify-between">
                <div className="w-10 h-10 rounded-xl bg-zinc-800/70 animate-pulse" />
                <div className="h-4 w-10 rounded-full bg-zinc-800/60 animate-pulse" />
            </div>
            <div className="mt-3 h-3 w-5/6 rounded bg-zinc-800/70 animate-pulse" />
            <div className="mt-1.5 h-3 w-2/3 rounded bg-zinc-800/50 animate-pulse" />
            <div className="mt-4 h-3 w-1/2 rounded bg-zinc-800/40 animate-pulse" />
        </div>
    );
}

export function LibrarySection({ onOpenVideo, onOpenArticle }: LibrarySectionProps) {
    const { t, formatNumber } = useI18n();
    const [data, setData] = useState<LibraryIndex | null>(null);
    const [levelFilter, setLevelFilter] = useState<LevelFilter>('ALL');
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState(false);
    const [tab, setTab] = useState<LibraryTab>('videos');
    const [retryToken, setRetryToken] = useState(0);
    const [difficulties, setDifficulties] = useState<Record<string, DifficultyItem>>({});

    const loadDifficulty = useCallback(async (payload: LibraryIndex, signal: AbortSignal) => {
        const refs = [
            ...payload.videos.map((video) => ({ kind: 'video' as const, ref: video.id })),
            ...payload.articles.map((article) => ({ kind: 'article' as const, ref: article.id })),
        ];
        if (refs.length === 0) return;
        // 没有画像时按推荐接口同款的默认区间 A2–B1（高带 B1）估算生词桶；
        // 与服务端默认 band 一致，不把它写成「你的等级」。
        let band: string | null = 'B1';
        try {
            const profile = await getAbilityProfile();
            band = profile.vocabulary?.high ?? 'B1';
        } catch {
            // 画像不可用：保留默认高带，只影响「生词约 X%」的估算。
        }
        try {
            const map = await fetchDifficultyBatch(refs, band);
            if (!signal.aborted) setDifficulties(map);
        } catch (error) {
            if (!signal.aborted) console.warn('Failed to load library difficulty:', error);
        }
    }, []);

    const load = useCallback(() => {
        const controller = new AbortController();
        fetchLibraryIndex()
            .then((payload) => {
                if (controller.signal.aborted) return;
                setData(payload);
                void loadDifficulty(payload, controller.signal);
            })
            .catch((error: unknown) => {
                if (controller.signal.aborted) return;
                if (error instanceof DOMException && error.name === 'AbortError') return;
                console.error('Failed to load free library:', error);
                setFailed(true);
            })
            .finally(() => {
                if (!controller.signal.aborted) setLoading(false);
            });
        return controller;
    }, [loadDifficulty]);

    useEffect(() => {
        const controller = load();
        return () => controller.abort();
    }, [load, retryToken]);

    const videos = data?.videos ?? [];
    const articles = data?.articles ?? [];
    const levelCounts = useMemo(() => {
        const counts: Record<string, number> = {};
        for (const video of videos) counts[video.level] = (counts[video.level] ?? 0) + 1;
        return counts;
    }, [videos]);
    const filteredVideos = useMemo(
        () => (levelFilter === 'ALL' ? videos : videos.filter((video) => video.level === levelFilter)),
        [videos, levelFilter],
    );
    const activeItems = tab === 'videos' ? filteredVideos : articles;
    const retry = () => {
        setLoading(true);
        setFailed(false);
        setRetryToken((previous) => previous + 1);
    };

    const tabs: { key: LibraryTab; label: string; count: number; icon: ReactNode }[] = [
        { key: 'videos', label: t('library.tab.videos'), count: videos.length, icon: <Play className="w-3.5 h-3.5" /> },
        { key: 'articles', label: t('library.tab.articles'), count: articles.length, icon: <FileText className="w-3.5 h-3.5" /> },
    ];

    return (
        <section data-testid="library-section" className="min-w-0">
            <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2">
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <Library className="w-4 h-4 text-emerald-400 shrink-0" />
                        <h3 className="text-[17px] font-semibold tracking-tight text-zinc-100">
                            {t('library.title')}
                        </h3>
                        <span className="inline-flex items-center rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-300">
                            {t('library.free')}
                        </span>
                    </div>
                    <p className="mt-0.5 text-xs leading-relaxed text-zinc-500 break-words">
                        {t('library.subtitle')}
                    </p>
                </div>

                <Tabs
                    skin="panel"
                    items={tabs.map((item) => ({
                        id: item.key,
                        label: item.label,
                        count: item.count,
                        icon: item.icon,
                        testId: `library-tab-${item.key}`,
                    }))}
                    value={tab}
                    onChange={(id) => setTab(id as LibraryTab)}
                    layoutId="library-tab"
                    ariaLabel={t('library.title')}
                    idPrefix="library"
                    testId="library-tabs"
                />
            </div>

            <div {...tabPanelProps('library', tab)}>
            {tab === 'videos' && videos.length > 0 && (
                <div
                    data-testid="library-level-filter"
                    role="group"
                    aria-label={t('library.filter.groupAria')}
                    className="mt-2.5 -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 custom-scrollbar"
                >
                    {LEVEL_FILTERS.map((level) => {
                        const active = levelFilter === level;
                        const count = level === 'ALL' ? videos.length : levelCounts[level] ?? 0;
                        const label = level === 'ALL' ? t('library.filter.all') : level;
                        return (
                            <FilterChip
                                key={level}
                                selected={active}
                                count={formatNumber(count)}
                                ariaLabel={
                                    level === 'ALL'
                                        ? t('library.filter.allChipAria', { count: formatNumber(count) })
                                        : t('library.filter.chipAria', { level, count: formatNumber(count) })
                                }
                                testId={`library-level-${level}`}
                                onClick={() => setLevelFilter(level)}
                            >
                                {label}
                            </FilterChip>
                        );
                    })}
                </div>
            )}

            {loading && !data ? (
                <div
                    data-testid="library-loading"
                    className="mt-3 flex gap-3 overflow-hidden"
                    aria-live="polite"
                >
                    {Array.from({ length: 3 }).map((_, index) => (
                        <SkeletonCard key={index} />
                    ))}
                    <span className="sr-only">{t('library.loading')}</span>
                </div>
            ) : failed && !data ? (
                <div
                    data-testid="library-failed"
                    className="mt-3 flex flex-wrap items-center gap-3 rounded-2xl border border-white/5 bg-zinc-900/40 px-4 py-3"
                >
                    <AlertCircle className="w-4 h-4 text-zinc-500 shrink-0" />
                    <p className="min-w-0 flex-1 text-xs leading-relaxed text-zinc-500">
                        {t('library.failed')}
                    </p>
                    <button
                        type="button"
                        onClick={retry}
                        className="inline-flex items-center gap-2 h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                    >
                        <RefreshCw className="w-3.5 h-3.5" />
                        {t('library.retry')}
                    </button>
                </div>
            ) : activeItems.length === 0 ? (
                <p
                    data-testid="library-empty"
                    className="mt-3 rounded-2xl border border-white/5 bg-zinc-900/40 px-4 py-3 text-xs text-zinc-500"
                >
                    {t('library.empty')}
                </p>
            ) : (
                <div
                    data-testid={`library-${tab}-list`}
                    className="mt-3 flex gap-3 overflow-x-auto pb-2 -mx-1 px-1 snap-x snap-mandatory custom-scrollbar"
                >
                    {tab === 'videos'
                        ? filteredVideos.map((video) => (
                              <VideoCard
                                  key={video.id}
                                  video={video}
                                  onOpen={onOpenVideo}
                                  difficulty={difficulties[difficultyKey('video', video.id)]}
                              />
                          ))
                        : articles.map((article) => (
                              <ArticleCard
                                  key={article.id}
                                  article={article}
                                  onOpen={onOpenArticle}
                                  difficulty={difficulties[difficultyKey('article', article.id)]}
                              />
                          ))}
                </div>
            )}
            </div>
        </section>
    );
}
