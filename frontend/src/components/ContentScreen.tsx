// Content — first-level page (P0 IA §3.2).
//
// "What do I learn?" — paste a link (main action), discover/read secondary
// entries, the CEFR vocabulary axis, the materials shelf (local shows +
// sentence packs), the free library, rule recommendations, subscription
// updates and the public blog footer. Every block reuses the existing
// component: this page only arranges them and routes the callbacks.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
    ArrowRight,
    Bell,
    BookOpen,
    Compass,
    Loader2,
    Newspaper,
    Rss,
    Tv,
    Youtube,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { blogFeedUrl } from '../lib/blog';
import { loadVocabLevel, saveVocabLevel, type VocabLevelId } from '../lib/settings';
import type { EstimateDialogHandle } from './EstimateDialog';
import { EstimateDialog } from './EstimateDialog';
import { StartLearning } from './StartLearning';
import { VocabAxis } from './VocabAxis';
import { ShowBrowser } from './ShowBrowser';
import { SentencePacks } from './SentencePacks';
import { LibrarySection } from './LibrarySection';
import { BooksSection } from './BooksSection';
import { HomeRecommendations } from './HomeRecommendations';
import { useI18n } from '../i18n/I18nProvider';

const PAGE_PAD = 'pb-[calc(56px+env(safe-area-inset-bottom)+16px)] md:pb-10';
const SECTION_TITLE = 'text-[17px] font-semibold tracking-tight text-zinc-100';

interface ChannelUpdate {
    videoId: string;
    title: string;
    channel?: string;
    thumbnail?: string;
}

interface ContentScreenProps {
    isGuest: boolean;
    busy: boolean;
    subscriptions: { id: string; name: string }[];
    onSelectEpisode: (showId: string, season: number, episode: number) => void;
    onSelectChannel: (name: string) => void;
    onUnsubscribe: (id: string) => void;
    onSubmitUrl: (url: string) => void;
    onSearch: (query: string) => void;
    onRead: (value: string) => void;
    onOpenLibraryVideo: (id: string) => void;
    onOpenLibraryArticle: (id: string) => void;
    onOpenBook: (id: string) => void;
    onOpenBookSeries: (id: string) => void;
    onOpenDiscover: () => void;
    onOpenReader: () => void;
    onOpenSentences: (levelId: number) => void;
    onOpenBlog: () => void;
    onRequestLogin: () => void;
}

export function ContentScreen({
    isGuest,
    busy,
    subscriptions,
    onSelectEpisode,
    onSelectChannel,
    onUnsubscribe,
    onSubmitUrl,
    onSearch,
    onRead,
    onOpenLibraryVideo,
    onOpenLibraryArticle,
    onOpenBook,
    onOpenBookSeries,
    onOpenDiscover,
    onOpenReader,
    onOpenSentences,
    onOpenBlog,
    onRequestLogin,
}: ContentScreenProps) {
    const { t } = useI18n();
    const estimateRef = useRef<EstimateDialogHandle>(null);
    const [vocabLevel, setVocabLevel] = useState<VocabLevelId>(loadVocabLevel);
    const [channelUpdates, setChannelUpdates] = useState<ChannelUpdate[]>([]);
    const [updatesLoading, setUpdatesLoading] = useState(false);
    // Unsubscribing hides the list immediately; no effect-level reset needed.
    const hasSubscriptions = subscriptions.length > 0;
    const visibleUpdates = hasSubscriptions ? channelUpdates : [];
    const showUpdatesLoading = hasSubscriptions && updatesLoading;

    const handleVocabLevelChange = (level: VocabLevelId) => {
        setVocabLevel(level);
        saveVocabLevel(level);
    };

    useEffect(() => {
        let cancelled = false;
        if (subscriptions.length === 0) {
            // Rendered list is derived below (`visibleUpdates`), so there is
            // nothing to reset here; skipping the request keeps effects clean.
            return () => { cancelled = true; };
        }
        // Loader flag for the fetch below; the network is the external system
        // this effect syncs with (same pattern as the other data cards).
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUpdatesLoading(true);
        apiFetch('/api/channel-updates', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ channels: subscriptions.map(sub => sub.id) }),
        })
            .then(res => res.json())
            .then(data => {
                if (!cancelled) setChannelUpdates(Array.isArray(data.updates) ? data.updates : []);
            })
            .catch(err => console.error('Failed to fetch channel updates:', err))
            .finally(() => {
                if (!cancelled) setUpdatesLoading(false);
            });
        return () => { cancelled = true; };
    }, [subscriptions]);

    const estimate = useCallback((url: string) => {
        estimateRef.current?.estimate(url);
    }, []);

    // Discovery needs an account (403 by contract): prompt before entering
    // the screen instead of letting the guest hit an empty search page.
    const handleDiscover = () => {
        if (isGuest) {
            onRequestLogin();
            return;
        }
        onOpenDiscover();
    };

    return (
        <div
            data-testid="content-screen"
            data-page-scroll
            className={`flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar bg-[#09090b] ${PAGE_PAD}`}
        >
            <div className="mx-auto w-full max-w-5xl px-4 sm:px-6 pt-5 sm:pt-8 space-y-6 sm:space-y-8">
                <EstimateDialog ref={estimateRef} onStart={onSubmitUrl} />

                <header>
                    <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-zinc-50">
                        {t('content.title')}
                    </h1>
                    <p className="mt-1 text-sm text-zinc-500">{t('content.subtitle')}</p>
                </header>

                {/* Main action: paste a link (same estimate pipeline as Today). */}
                <div data-testid="content-start-input">
                    <StartLearning
                        variant="primary"
                        disabled={busy}
                        onEstimate={estimate}
                        onSearch={onSearch}
                        onRead={onRead}
                    >
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-zinc-500">
                            <div className="flex items-center gap-x-2">
                                <span>{t('home.discover.prompt')}</span>
                                <button
                                    type="button"
                                    data-testid="discover-entry"
                                    onClick={handleDiscover}
                                    className="inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                >
                                    <Compass className="w-3.5 h-3.5" />
                                    {t('home.discover.action')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                            <span aria-hidden="true" className="hidden sm:block w-px h-3 bg-white/10" />
                            <div className="flex items-center gap-x-2">
                                <span>{t('home.reader.prompt')}</span>
                                <button
                                    type="button"
                                    data-testid="reader-entry"
                                    onClick={onOpenReader}
                                    className="inline-flex items-center gap-1 h-7 px-1.5 -mx-1.5 rounded-lg font-medium text-blue-400 hover:text-blue-300 hover:bg-white/5 transition-colors"
                                >
                                    <BookOpen className="w-3.5 h-3.5" />
                                    {t('home.reader.action')}
                                    <ArrowRight className="w-3.5 h-3.5" />
                                </button>
                            </div>
                        </div>
                    </StartLearning>
                </div>

                {/* Learner level: calibrates which words get highlighted. */}
                <section>
                    <VocabAxis value={vocabLevel} onChange={handleVocabLevelChange} />
                </section>

                {/* Materials shelf: local shows + sentence packs. */}
                <section data-testid="content-materials">
                    <h2 className={SECTION_TITLE}>{t('content.materials')}</h2>
                    <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 sm:gap-6">
                        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-3">
                                <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100">
                                    <Tv className="w-4 h-4 text-blue-400" />
                                    {t('content.showsTitle')}
                                </h3>
                                <span className="text-[11px] text-zinc-500">{t('content.showsHint')}</span>
                            </div>
                            <ShowBrowser onSelectEpisode={onSelectEpisode} isLoading={busy} />
                        </div>
                        <div className="rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5 min-w-0">
                            <div className="flex items-center justify-between gap-2 mb-3">
                                <h3 className="flex items-center gap-2 text-sm font-semibold tracking-tight text-zinc-100">
                                    <BookOpen className="w-4 h-4 text-blue-400" />
                                    {t('content.sentencesTitle')}
                                </h3>
                                <span className="text-[11px] text-zinc-500">{t('content.sentencesHint')}</span>
                            </div>
                            <SentencePacks onSelectLevel={onOpenSentences} />
                        </div>
                    </div>
                </section>

                {/* Free library: pre-built videos + original articles. */}
                <section data-testid="content-library">
                    <LibrarySection
                        onOpenVideo={onOpenLibraryVideo}
                        onOpenArticle={onOpenLibraryArticle}
                    />
                </section>

                {/* Public-domain books: 3 launch series, source fetched on demand. */}
                <section data-testid="content-books">
                    <BooksSection
                        onOpenBook={onOpenBook}
                        onOpenSeries={onOpenBookSeries}
                    />
                </section>

                {/* Rule recommendations. */}
                <section>
                    <HomeRecommendations onSelect={estimate} />
                </section>

                {/* Subscriptions + latest videos (merged card). */}
                <section data-testid="content-subscriptions">
                    <h2 className={SECTION_TITLE}>{t('content.subscriptionsTitle')}</h2>
                    <div className="mt-3 rounded-3xl border border-white/5 bg-zinc-900/40 p-4 sm:p-5">
                        {subscriptions.length === 0 ? (
                            <p className="text-sm text-zinc-500">{t('content.noSubscriptions')}</p>
                        ) : (
                            <>
                                <div className="flex flex-wrap items-center gap-2">
                                    {subscriptions.slice(0, 6).map(sub => (
                                        <span
                                            key={sub.id}
                                            className="inline-flex items-center h-8 rounded-lg bg-zinc-800/60 border border-white/5 text-sm font-medium text-zinc-300"
                                        >
                                            <button
                                                type="button"
                                                onClick={() => onSelectChannel(sub.name)}
                                                className="h-full px-3 rounded-l-lg hover:bg-zinc-700/60 hover:text-zinc-100 transition-colors"
                                            >
                                                {sub.name}
                                            </button>
                                            <button
                                                type="button"
                                                data-testid={`unsubscribe-${sub.id}`}
                                                onClick={() => onUnsubscribe(sub.id)}
                                                aria-label={t('content.unsubscribe', { channel: sub.name })}
                                                title={t('content.unsubscribe', { channel: sub.name })}
                                                className="h-full px-2 rounded-r-lg text-zinc-500 hover:text-red-400 hover:bg-zinc-700/60 border-l border-white/5 transition-colors"
                                            >
                                                ×
                                            </button>
                                        </span>
                                    ))}
                                </div>

                                <div className="mt-4 flex items-center gap-2">
                                    <Bell className="w-4 h-4 text-amber-400 shrink-0" />
                                    <h3 className="text-[13px] font-semibold tracking-tight text-zinc-200">
                                        {t('content.latestVideos')}
                                    </h3>
                                    {showUpdatesLoading && <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-500" />}
                                </div>
                                <div className="mt-2 max-h-72 overflow-y-auto custom-scrollbar space-y-2 pr-1">
                                    {visibleUpdates.length === 0 && !showUpdatesLoading ? (
                                        <p className="py-3 text-sm text-zinc-500">{t('home.noUploads')}</p>
                                    ) : (
                                        visibleUpdates.map((update, index) => (
                                            <button
                                                key={`${update.videoId}-${index}`}
                                                type="button"
                                                onClick={() => estimate(`https://youtube.com/watch?v=${update.videoId}`)}
                                                className="w-full flex gap-3 p-2.5 rounded-xl bg-zinc-800/30 hover:bg-zinc-800/60 border border-white/5 hover:border-white/10 transition-colors text-left"
                                            >
                                                <span className="w-24 aspect-video rounded-lg bg-zinc-800 overflow-hidden shrink-0 relative">
                                                    {update.thumbnail && <img src={update.thumbnail} className="w-full h-full object-cover" alt="" />}
                                                </span>
                                                <span className="flex flex-col justify-center min-w-0">
                                                    <span className="text-zinc-300 text-sm font-medium line-clamp-2">{update.title}</span>
                                                    <span className="text-zinc-500 text-xs mt-1 inline-flex items-center gap-1">
                                                        <Youtube className="w-3 h-3" />{update.channel}
                                                    </span>
                                                </span>
                                            </button>
                                        ))
                                    )}
                                </div>
                            </>
                        )}
                    </div>
                </section>

                {/* Footer: public blog + RSS. */}
                <footer className="mt-2 pt-6 border-t border-white/5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
                    <p className="text-xs leading-relaxed text-zinc-500">{t('blog.footerNote')}</p>
                    <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
                        <button
                            type="button"
                            data-testid="blog-entry"
                            onClick={onOpenBlog}
                            className="inline-flex items-center gap-1.5 h-8 px-2 -mx-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                        >
                            <Newspaper className="w-4 h-4" />
                            {t('blog.title')}
                        </button>
                        <a
                            href={blogFeedUrl()}
                            target="_blank"
                            rel="noopener noreferrer"
                            data-testid="blog-feed-link"
                            aria-label={t('blog.feedAria')}
                            className="inline-flex items-center gap-1.5 h-8 px-2 -mx-2 rounded-lg text-sm font-medium text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                        >
                            <Rss className="w-4 h-4" />
                            {t('blog.feed')}
                        </a>
                    </div>
                </footer>
            </div>
        </div>
    );
}
