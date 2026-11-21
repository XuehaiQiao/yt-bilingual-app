import { apiFetch } from '../lib/api';
import React, { useState, useEffect } from 'react';
import { ChevronLeft, BookOpen, Tv, Loader2 } from 'lucide-react';
import { useI18n } from '../i18n/I18nProvider';
import { Segmented } from './ui/Segmented';
import { CollectionCard } from './ui/CollectionCard';

interface Show {
    id: string;
    title: string;
    title_zh: string;
    thumbnail: string;
    seasons_available: { [key: number]: number };
    total_episodes: number;
}

interface SeasonData {
    season: number;
    episode_count: number;
    episodes: number[];
}

interface ShowBrowserProps {
    onSelectEpisode: (showId: string, season: number, episode: number) => void;
    isLoading: boolean;
}

export const ShowBrowser: React.FC<ShowBrowserProps> = ({ onSelectEpisode, isLoading }) => {
    const { t, language } = useI18n();
    const [shows, setShows] = useState<Show[]>([]);
    const [selectedShow, setSelectedShow] = useState<Show | null>(null);
    const [seasons, setSeasons] = useState<SeasonData[]>([]);
    const [selectedSeason, setSelectedSeason] = useState<number | null>(null);
    const [loadingShows, setLoadingShows] = useState(true);
    const [processedEpisodes, setProcessedEpisodes] = useState<Set<string>>(new Set());

    useEffect(() => {
        apiFetch('/api/shows')
            .then(res => res.json())
            .then(data => {
                setShows(data.shows || []);
                setLoadingShows(false);
            })
            .catch(err => {
                console.error('Failed to load shows:', err);
                setLoadingShows(false);
            });
    }, []);

    const handleShowSelect = async (show: Show) => {
        setSelectedShow(show);
        setSelectedSeason(null);
        setProcessedEpisodes(new Set());
        try {
            const [seasonsRes, processedRes] = await Promise.all([
                apiFetch(`/api/shows/${show.id}/seasons`),
                apiFetch(`/api/shows/${show.id}/processed`)
            ]);
            const seasonsData = await seasonsRes.json();
            setSeasons(seasonsData.seasons || []);
            const processedData = await processedRes.json();
            setProcessedEpisodes(new Set(processedData.processed || []));
        } catch (err) {
            console.error('Failed to load seasons:', err);
        }
    };

    if (loadingShows) {
        return (
            <div className="flex items-center justify-center py-12">
                <Loader2 className="w-6 h-6 text-zinc-400 animate-spin" />
            </div>
        );
    }

    // Local show titles are content, not UI copy: Chinese prefers the
    // translated `title_zh`, Vietnamese shows the original title.
    const showTitle = (show: Show) => (language === 'zh-CN' ? (show.title_zh || show.title) : show.title);

    if (shows.length === 0) {
        return (
            <div className="flex flex-col items-center justify-center py-16 text-center">
                <Tv className="w-10 h-10 text-zinc-700 mb-3" />
                <p className="text-sm font-medium text-zinc-400">{t('shows.empty')}</p>
                <p className="text-xs text-zinc-600 mt-1">{t('shows.emptyHint')}</p>
            </div>
        );
    }

    return (
        <div className="space-y-4">
            {/* Header — detail view only. In list view the card header from InputScreen is the
                single "Local Shows" title, so ShowBrowser does not render its own. */}
            {selectedShow && (
                <div className="flex items-center gap-2 mb-2">
                    <button
                        onClick={() => { setSelectedShow(null); setSeasons([]); setSelectedSeason(null); }}
                        className="inline-flex items-center gap-1 h-7 px-2 -ml-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                    >
                        <ChevronLeft className="w-4 h-4" />
                        {t('shows.back')}
                    </button>
                    <h3 className="text-base font-semibold text-zinc-200 flex items-center gap-2">
                        <BookOpen className="w-5 h-5 text-blue-400" />
                        {showTitle(selectedShow)}
                    </h3>
                </div>
            )}

            {/* Show List */}
            {!selectedShow && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                    {shows.map(show => (
                        <CollectionCard
                            key={show.id}
                            testId={`local-show-card-${show.id}`}
                            ariaLabel={showTitle(show)}
                            onClick={() => handleShowSelect(show)}
                            visual={show.thumbnail
                                ? <img src={show.thumbnail} alt={show.title} loading="lazy" decoding="async" className="h-full w-full object-cover" />
                                : <Tv className="h-8 w-8 text-zinc-600" aria-hidden="true" />}
                            title={showTitle(show)}
                            subtitle={show.title}
                            meta={(
                                <span className="tabular-nums">
                                    {t('shows.seasonsEpisodes', { seasons: Object.keys(show.seasons_available).length, episodes: show.total_episodes })}
                                </span>
                            )}
                        />
                    ))}
                </div>
            )}

            {/* Season & Episode Selector */}
            {selectedShow && (
                <div className="space-y-3">
                    {/* Season selector */}
                    <Segmented
                        options={seasons.map((s) => ({
                            value: String(s.season),
                            label: (
                                <>
                                    {t('shows.season', { number: s.season })}
                                    <span className="ml-1.5 text-micro opacity-70">
                                        {t('shows.episodesShort', { count: s.episode_count })}
                                    </span>
                                </>
                            ),
                            testId: `show-season-${s.season}`,
                        }))}
                        value={selectedSeason == null ? '' : String(selectedSeason)}
                        onChange={(value) => setSelectedSeason(Number(value))}
                        layoutId="season"
                        ariaLabel={t('shows.pickSeason')}
                        size="md"
                        testId="show-season-tabs"
                    />

                    {/* Episode Grid */}
                    {selectedSeason && (
                        <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2 mt-3">
                            {seasons
                                .find(s => s.season === selectedSeason)
                                    ?.episodes.map(ep => {
                                        const epKey = `S${selectedSeason.toString().padStart(2, '0')}E${ep.toString().padStart(2, '0')}`;
                                        const isProcessed = processedEpisodes.has(epKey);
                                        return (
                                    <button
                                        key={ep}
                                        disabled={isLoading}
                                        onClick={() => onSelectEpisode(selectedShow.id, selectedSeason, ep)}
                                        className={`py-3 px-2 rounded-lg text-sm font-medium transition-[background-color,border-color,color,transform] duration-200 ease-apple active:scale-[0.98] ${
                                            isLoading
                                                ? 'bg-zinc-800/50 text-zinc-600 border border-transparent cursor-wait'
                                                : isProcessed
                                                    ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 hover:bg-emerald-500/20'
                                                    : 'bg-zinc-800/60 text-zinc-300 border border-white/5 hover:bg-zinc-700/60 hover:text-zinc-100 hover:border-white/10'
                                        }`}
                                    >
                                        E{ep.toString().padStart(2, '0')}
                                        {isProcessed && <span className="ml-1 text-[10px] opacity-70">✓</span>}
                                    </button>
                                    );
                                    })}
                        </div>
                    )}

                    {!selectedSeason && (
                        <p className="text-zinc-600 text-xs text-center py-4">
                            {t('shows.pickSeason')}
                        </p>
                    )}
                </div>
            )}
        </div>
    );
};
