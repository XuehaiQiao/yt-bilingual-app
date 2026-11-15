import React, { useEffect, useMemo, useState } from 'react';
import {
    X,
    Play,
    Trash2,
    Star,
    Download,
    FileSpreadsheet,
    Share2,
    ChevronDown,
    ChevronRight,
    FileText,
    Tv,
    BookOpen,
    ExternalLink,
    Link2Off,
} from 'lucide-react';
import { exportAnkiTsv, exportCsv } from '../lib/exporter';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion';
import type { FavoriteItem, FavoriteSourceKind } from '../lib/favorites';
import { ShareCardDialog } from './ShareCardDialog';
import type { ShareCardData } from '../lib/shareCard';
import { VideoPlayer } from './VideoPlayer';
import { HighlightedText } from './TranscriptBlock';

interface FavoritesModalProps {
    isOpen: boolean;
    onClose: () => void;
    favorites: FavoriteItem[];
    onRemoveFavorite: (id: string) => void;
    onPlayFavorite: (videoId: string, start: number) => void;
    /** Open the reader at one article (favorites "出处" jump). */
    onOpenArticle: (articleId: string) => void;
    /** Open one sentence pack by level id (favorites "出处" jump). */
    onOpenSentencePack: (levelId: number) => void;
}

// Grouping logic. Bucket labels come from the dictionary; month headings use
// Intl for the active UI language (2026年1月 / tháng 1 năm 2026).
const getGroupTitle = (
    timestamp: number | undefined,
    t: (key: TranslationKey) => string,
    formatMonth: (date: Date) => string,
) => {
    if (!timestamp) return t('favorites.group.earlier');

    const now = new Date();
    const date = new Date(timestamp);

    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const lastWeek = new Date(today);
    lastWeek.setDate(lastWeek.getDate() - 7);

    if (date >= today) return t('favorites.group.today');
    if (date >= yesterday && date < today) return t('favorites.group.yesterday');
    if (date >= lastWeek && date < yesterday) return t('favorites.group.last7');

    return formatMonth(date);
};

// ── Vocabulary source (出处) ──────────────────────────────────────────────
// New favorites carry source_* (see lib/favorites). Records created before
// that only have videoId, so the kind is inferred from its shape and the title
// is unknown — the row then reads "来源未知" and is not clickable.
type SourceIconComponent = React.ComponentType<{ className?: string }>;

const SOURCE_ICON: Record<FavoriteSourceKind, SourceIconComponent> = {
    video: Play,
    local_show: Tv,
    article: FileText,
    sentence_pack: BookOpen,
};

const SOURCE_TITLE_KEY: Record<FavoriteSourceKind, TranslationKey> = {
    video: 'favorites.source.kind.video',
    local_show: 'favorites.source.kind.local_show',
    article: 'favorites.source.kind.article',
    sentence_pack: 'favorites.source.kind.sentence_pack',
};

const SOURCE_KINDS: readonly FavoriteSourceKind[] = ['video', 'local_show', 'article', 'sentence_pack'];
const SENTENCE_PACK_PREFIX = 'sentence-pack-';

interface ResolvedFavoriteSource {
    kind: FavoriteSourceKind;
    ref: string;
    /** Null when unknown: the title is required to link anywhere. */
    title: string | null;
}

function resolveFavoriteSource(fav: FavoriteItem): ResolvedFavoriteSource {
    const title = typeof fav.source_title === 'string' && fav.source_title.trim()
        ? fav.source_title.trim()
        : null;
    const storedRef = typeof fav.source_ref === 'string' ? fav.source_ref.trim() : '';
    const storedKind = fav.source_kind && SOURCE_KINDS.includes(fav.source_kind)
        ? fav.source_kind
        : null;
    if (storedKind) {
        const fallbackRef = storedKind === 'sentence_pack'
            ? fav.videoId.replace(SENTENCE_PACK_PREFIX, '')
            : fav.videoId;
        return { kind: storedKind, ref: storedRef || fallbackRef, title };
    }
    // Legacy records: infer the kind from videoId only.
    if (fav.videoId.startsWith(SENTENCE_PACK_PREFIX)) {
        return { kind: 'sentence_pack', ref: fav.videoId.slice(SENTENCE_PACK_PREFIX.length), title: null };
    }
    if (fav.videoId.length === 11) return { kind: 'video', ref: fav.videoId, title: null };
    return { kind: 'article', ref: fav.videoId, title: null };
}

/** Existing `zh_text` is `"/ipa/ 释义"`; without IPA it is just the meaning. */
function splitIpaAndMeaning(zhText: string | undefined): { ipa: string | null; meaning: string } {
    const text = (zhText || '').trim();
    const match = text.match(/^\/([^/]{1,120})\/\s*(.*)$/);
    if (!match) return { ipa: null, meaning: text };
    return { ipa: `/${match[1].trim()}/`, meaning: match[2].trim() };
}

function sentencePackLevel(ref: string): number | null {
    const match = /^L(\d+)$/i.exec(ref.trim());
    if (!match) return null;
    const level = Number(match[1]);
    return Number.isInteger(level) && level > 0 ? level : null;
}

const secondaryButton =
    'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors';
const dangerButton =
    'inline-flex items-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-xs font-medium text-red-400 transition-colors';

interface VocabularyRowProps {
    fav: FavoriteItem;
    expanded: boolean;
    reduceMotion: boolean;
    onToggleExpanded: () => void;
    onRequestSourceOpen: (fav: FavoriteItem, source: ResolvedFavoriteSource) => void;
    onReview: (fav: FavoriteItem) => void;
    onShare: (fav: FavoriteItem) => void;
    onRemove: () => void;
}

/**
 * One vocabulary favorite. Collapsed it is exactly one line — word + IPA +
 * meaning — so the list shows many words at once; expanding reveals the
 * source link, the original sentence and the actions. Sentence favorites keep
 * the older, larger card (see FavoritesModal).
 */
const VocabularyRow: React.FC<VocabularyRowProps> = ({
    fav,
    expanded,
    reduceMotion,
    onToggleExpanded,
    onRequestSourceOpen,
    onReview,
    onShare,
    onRemove,
}) => {
    const { t } = useI18n();
    const source = resolveFavoriteSource(fav);
    const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
    const SourceIcon = SOURCE_ICON[source.kind];
    const clickable = Boolean(source.title && source.ref);
    const sourceLabel = source.title
        ? t('favorites.source.from', {
            source: t(SOURCE_TITLE_KEY[source.kind], { title: source.title }),
        })
        : t('favorites.source.unknown');

    return (
        <motion.div
            layout
            initial={{ opacity: 0, x: -10 }}
            animate={{ opacity: 1, x: 0 }}
            key={fav.id}
            data-testid={`favorite-vocab-${fav.id}`}
            className="glass-card rounded-xl overflow-hidden"
        >
            <button
                type="button"
                data-testid={`favorite-vocab-toggle-${fav.id}`}
                aria-expanded={expanded}
                aria-label={expanded ? t('common.collapse') : t('common.expand')}
                onClick={onToggleExpanded}
                className="flex w-full min-w-0 items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.03] sm:px-4"
            >
                <span
                    data-testid={`favorite-vocab-word-${fav.id}`}
                    className="max-w-[42%] shrink-0 truncate text-[15px] font-semibold text-zinc-100"
                >
                    {fav.en_text}
                </span>
                {ipa && (
                    <span
                        data-testid={`favorite-vocab-ipa-${fav.id}`}
                        className="max-w-[32%] shrink-0 truncate text-xs font-normal text-zinc-500"
                    >
                        {ipa}
                    </span>
                )}
                <span
                    data-testid={`favorite-vocab-meaning-${fav.id}`}
                    className="min-w-0 flex-1 truncate text-sm text-zinc-400"
                >
                    {meaning}
                </span>
                <ChevronDown
                    className={`w-4 h-4 shrink-0 text-zinc-500 transition-transform duration-200 ease-apple motion-reduce:transition-none ${
                        expanded ? 'rotate-180' : ''
                    }`}
                />
            </button>

            <AnimatePresence initial={false}>
                {expanded && (
                    <motion.div
                        key="body"
                        initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                        animate={{ height: 'auto', opacity: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                        transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
                        className="overflow-hidden"
                    >
                        <div className="space-y-2.5 border-t border-white/5 px-3.5 pb-3 pt-2.5 sm:px-4">
                            <button
                                type="button"
                                data-testid={`favorite-vocab-source-${fav.id}`}
                                disabled={!clickable}
                                onClick={() => onRequestSourceOpen(fav, source)}
                                className={`-mx-2 flex max-w-[calc(100%+1rem)] items-center gap-2 rounded-lg px-2 py-1 text-left text-xs ${
                                    clickable
                                        ? 'text-blue-300 hover:text-blue-200 hover:bg-blue-500/10 transition-colors'
                                        : 'text-zinc-500 cursor-default'
                                }`}
                            >
                                {clickable
                                    ? <SourceIcon className="w-3.5 h-3.5 shrink-0" />
                                    : <Link2Off className="w-3.5 h-3.5 shrink-0" />}
                                <span
                                    data-testid={`favorite-vocab-source-label-${fav.id}`}
                                    className="min-w-0 truncate"
                                >
                                    {sourceLabel}
                                </span>
                                {clickable && <ExternalLink className="w-3 h-3 shrink-0 opacity-70" />}
                            </button>

                            {(fav.context_en || fav.context_zh) && (
                                <div
                                    data-testid={`favorite-vocab-context-${fav.id}`}
                                    className="space-y-1 rounded-lg border border-white/5 bg-zinc-950/30 px-3 py-2"
                                >
                                    {fav.context_en && (
                                        <p className="text-[13px] leading-relaxed text-zinc-200 break-words">
                                            <HighlightedText
                                                text={fav.context_en}
                                                highlights={(fav.highlights || []).map(h => ({
                                                    word: h.en_word,
                                                    color: h.color,
                                                    annotation: h.zh_word,
                                                }))}
                                            />
                                        </p>
                                    )}
                                    {fav.context_zh && (
                                        <p className="text-[13px] leading-relaxed text-zinc-400 break-words">
                                            {fav.context_zh}
                                        </p>
                                    )}
                                </div>
                            )}

                            <div className="flex flex-wrap items-center gap-2">
                                <button
                                    type="button"
                                    data-testid={`favorite-vocab-review-${fav.id}`}
                                    onClick={() => onReview(fav)}
                                    className={secondaryButton}
                                    title={t('favorites.review')}
                                >
                                    <Play className="w-3.5 h-3.5" /> {t('favorites.review')}
                                </button>
                                <button
                                    type="button"
                                    data-testid={`favorite-delete-${fav.id}`}
                                    onClick={onRemove}
                                    className={dangerButton}
                                    title={t('favorites.delete')}
                                >
                                    <Trash2 className="w-3.5 h-3.5" /> {t('favorites.delete')}
                                </button>
                                <button
                                    type="button"
                                    data-testid={`favorite-share-${fav.id}`}
                                    onClick={() => onShare(fav)}
                                    className={secondaryButton}
                                    title={t('share.action')}
                                    aria-label={t('share.action')}
                                >
                                    <Share2 className="w-3.5 h-3.5" /> {t('share.action')}
                                </button>
                            </div>
                        </div>
                    </motion.div>
                )}
            </AnimatePresence>
        </motion.div>
    );
};

// ... inside the component
export const FavoritesModal: React.FC<FavoritesModalProps> = ({
    isOpen,
    onClose,
    favorites,
    onRemoveFavorite,
    onPlayFavorite,
    onOpenArticle,
    onOpenSentencePack,
}) => {
    const { t, formatMonth } = useI18n();
    const reduceMotion = useReducedMotion() ?? false;
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
    const [playingFav, setPlayingFav] = useState<{ videoId: string, start: number } | null>(null);
    const [shareData, setShareData] = useState<ShareCardData | null>(null);
    const [expandedVocab, setExpandedVocab] = useState<Record<string, boolean>>({});
    // Source clicks navigate away, so they are confirmed first. This is a
    // custom dialog on purpose (window.confirm cannot be styled/tested).
    const [pendingSource, setPendingSource] = useState<{
        fav: FavoriteItem;
        source: ResolvedFavoriteSource;
    } | null>(null);

    // Group the favorites
    const groups = useMemo(() => {
        const sorted = [...favorites].sort((a, b) => (b.added_at || 0) - (a.added_at || 0));
        const map: Record<string, typeof favorites> = {};

        sorted.forEach(fav => {
            const title = getGroupTitle(fav.added_at, t, formatMonth);
            if (!map[title]) map[title] = [];
            map[title].push(fav);
        });

        return map;
    }, [favorites, t, formatMonth]);

    const formatTime = (seconds: number) => {
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    };

    const toggleGroup = (title: string) => {
        setCollapsedGroups(prev => ({
            ...prev,
            [title]: !prev[title]
        }));
    };

    const toggleVocab = (id: string) => {
        setExpandedVocab(prev => ({ ...prev, [id]: !prev[id] }));
    };

    // A favorite only stores the video id and position, so the card names the
    // platform/time; local episodes are labelled as such instead of pretending
    // to be YouTube. Text/translation are exactly what the favorite holds.
    const shareFavorite = (fav: FavoriteItem) => {
        const time = formatTime(fav.start);
        const source = fav.videoId.length > 11
            ? t('share.source.local', { time })
            : t('share.source.video', { time });
        if (fav.type === 'vocabulary') {
            setShareData({
                kind: 'vocabulary',
                word: fav.en_text,
                wordTranslation: fav.zh_text || undefined,
                text: fav.context_en || '',
                translation: fav.context_zh || undefined,
                source,
            });
            return;
        }
        setShareData({
            kind: 'sentence',
            text: fav.en_text,
            translation: fav.zh_text || undefined,
            source,
        });
    };

    // Source row click: ask first, then navigate on confirm.
    const requestSourceOpen = (fav: FavoriteItem, source: ResolvedFavoriteSource) => {
        if (!source.title || !source.ref) return;
        setPendingSource({ fav, source });
    };

    const confirmSourceOpen = () => {
        const pending = pendingSource;
        if (!pending) return;
        setPendingSource(null);
        const { fav, source } = pending;
        if (source.kind === 'article') {
            onOpenArticle(source.ref);
            return;
        }
        if (source.kind === 'sentence_pack') {
            const level = sentencePackLevel(source.ref);
            if (level != null) onOpenSentencePack(level);
            return;
        }
        // video + local_show reuse the existing favorites jump.
        onPlayFavorite(source.ref, fav.start);
    };

    // 回看: same destination as the source link, but it is already an explicit
    // action — no confirmation. Legacy (pre-source) favorites use the inferred
    // kind: local episodes jump to the episode, YouTube clips play in the
    // floating card, older article words open the reader, and sentence-pack
    // words open their pack.
    const reviewFavorite = (fav: FavoriteItem) => {
        const source = resolveFavoriteSource(fav);
        // Legacy local-episode refs also look like "long ids"; check the shape
        // before the article fallback swallows them.
        if (!fav.source_kind && /^(.+?)[-_/]S(\d+)E(\d+)$/i.test(fav.videoId)) {
            onPlayFavorite(fav.videoId, fav.start);
            return;
        }
        if (source.kind === 'article') {
            if (source.ref) onOpenArticle(source.ref);
            return;
        }
        if (source.kind === 'sentence_pack') {
            const level = sentencePackLevel(source.ref);
            if (level != null) onOpenSentencePack(level);
            return;
        }
        if (source.kind === 'local_show') {
            onPlayFavorite(source.ref || fav.videoId, fav.start);
            return;
        }
        if (source.ref) {
            setPlayingFav({ videoId: source.ref, start: fav.start });
        }
    };

    // Drop transient dialog state whenever the modal closes; the next open
    // starts from the collapsed list again.
    useEffect(() => {
        if (isOpen) return;
        setPendingSource(null);
        setExpandedVocab({});
    }, [isOpen]);

    // Escape closes the confirmation first, leaving the favorites list open.
    useEffect(() => {
        if (!pendingSource) return;
        const handleKey = (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                setPendingSource(null);
            }
        };
        window.addEventListener('keydown', handleKey);
        return () => window.removeEventListener('keydown', handleKey);
    }, [pendingSource]);

    const pendingSourceLabel = pendingSource
        ? (pendingSource.source.title
            ? t(SOURCE_TITLE_KEY[pendingSource.source.kind], { title: pendingSource.source.title })
            : t('favorites.source.unknown'))
        : '';

    return (
        <>
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: 0.2, ease: "easeIn" } }}
                    transition={{ duration: 0.25, ease: "easeOut" }}
                    className="fixed inset-0 z-50 flex flex-col bg-zinc-950/70 backdrop-blur-md w-full h-full overflow-hidden"
                >
                    <motion.div
                        initial={{ y: 24, scale: 0.98, opacity: 0 }}
                        animate={{ y: 0, scale: 1, opacity: 1 }}
                        exit={{ y: 12, scale: 0.99, opacity: 0, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } }}
                        transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.9 }}
                        className="w-full flex flex-col h-full mx-auto max-w-5xl bg-zinc-900/80 backdrop-blur-2xl border-x border-white/10"
                        data-testid="favorites-modal"
                    >
                        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 sm:px-6 py-4 sm:py-5 border-b border-white/5 shrink-0">
                            <h2 className="text-xl sm:text-2xl font-semibold text-zinc-100 tracking-tight">{t('favorites.title')}</h2>
                            <div className="flex items-center gap-2 ml-auto">
                                {favorites.length > 0 && (
                                    <>
                                        <button
                                            onClick={() => exportAnkiTsv(favorites)}
                                            className="inline-flex items-center gap-2 h-9 px-3 sm:px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                                            title={t('favorites.exportAnkiTitle')}
                                        >
                                            <Download className="w-4 h-4" /> {t('favorites.exportAnki')}
                                        </button>
                                        <button
                                            onClick={() => exportCsv(favorites)}
                                            className="inline-flex items-center gap-2 h-9 px-3 sm:px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                                            title={t('favorites.exportCsvTitle')}
                                        >
                                            <FileSpreadsheet className="w-4 h-4" /> {t('favorites.exportCsv')}
                                        </button>
                                    </>
                                )}
                                <button onClick={onClose} className="p-2 rounded-full text-zinc-400 hover:text-zinc-100 hover:bg-white/5 transition-colors">
                                    <X className="w-5 h-5" />
                                </button>
                            </div>
                        </div>

                        <div className="p-4 sm:p-6 overflow-y-auto flex-1 custom-scrollbar space-y-6">
                            {favorites.length === 0 ? (
                                <div className="flex flex-col items-center justify-center py-16 text-center">
                                    <Star className="w-10 h-10 text-zinc-700 mb-3" />
                                    <p className="text-sm font-medium text-zinc-400">{t('favorites.empty')}</p>
                                    <p className="text-xs text-zinc-600 mt-1">{t('favorites.emptyHint')}</p>
                                </div>
                            ) : (
                                Object.entries(groups).map(([title, items]) => {
                                    const isCollapsed = collapsedGroups[title];
                                    return (
                                        <div key={title} className="space-y-4">
                                            <button
                                                onClick={() => toggleGroup(title)}
                                                className="flex items-center gap-2 text-zinc-100 font-semibold text-[17px] tracking-tight hover:text-white transition-colors w-full text-left"
                                            >
                                                {isCollapsed ? <ChevronRight className="w-4 h-4 text-zinc-500" /> : <ChevronDown className="w-4 h-4 text-zinc-300" />}
                                                {title} <span className="text-[11px] font-medium tabular-nums text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-full">{items.length}</span>
                                            </button>

                                            <AnimatePresence>
                                                {!isCollapsed && (
                                                    <motion.div
                                                        initial={{ height: 0, opacity: 0 }}
                                                        animate={{ height: "auto", opacity: 1 }}
                                                        exit={{ height: 0, opacity: 0 }}
                                                        transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
                                                        className="space-y-4 pl-2 sm:pl-7 border-l border-white/5 overflow-hidden"
                                                    >
                                                        {items.map((fav) => fav.type === 'vocabulary' ? (
                                                            <VocabularyRow
                                                                key={fav.id}
                                                                fav={fav}
                                                                expanded={Boolean(expandedVocab[fav.id])}
                                                                reduceMotion={reduceMotion}
                                                                onToggleExpanded={() => toggleVocab(fav.id)}
                                                                onRequestSourceOpen={requestSourceOpen}
                                                                onReview={reviewFavorite}
                                                                onShare={shareFavorite}
                                                                onRemove={() => onRemoveFavorite(fav.id)}
                                                            />
                                                        ) : (
                                                            <motion.div
                                                                layout
                                                                initial={{ opacity: 0, x: -10 }}
                                                                animate={{ opacity: 1, x: 0 }}
                                                                key={fav.id}
                                                                className="glass-card rounded-xl p-5 flex gap-4 group hover:bg-zinc-800/60 transition-colors"
                                                            >
                                                                <div className="flex-1 space-y-3">
                                                                    <div className="flex items-center gap-3">
                                                                        <span className="text-[11px] font-medium tabular-nums text-blue-400 bg-blue-500/10 px-2 py-0.5 rounded-full">
                                                                            {formatTime(fav.start)}
                                                                        </span>
                                                                    </div>
                                                                    <div>
                                                                        <p className="text-base text-zinc-100 font-normal leading-relaxed mb-2">
                                                                            <HighlightedText
                                                                                text={fav.en_text}
                                                                                highlights={(fav.highlights || []).map(h => ({
                                                                                    word: h.en_word,
                                                                                    color: h.color,
                                                                                    annotation: h.zh_word
                                                                                }))}
                                                                            />
                                                                        </p>
                                                                        <p className="text-[15px] text-zinc-400 leading-relaxed">{fav.zh_text}</p>
                                                                    </div>
                                                                </div>
                                                                <div className="flex flex-col gap-2 justify-center opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity">
                                                                    <button
                                                                        onClick={() => {
                                                                            if (fav.videoId.length > 11) {
                                                                                onClose();
                                                                                onPlayFavorite(fav.videoId, fav.start);
                                                                            } else {
                                                                                setPlayingFav({ videoId: fav.videoId, start: fav.start });
                                                                            }
                                                                        }}
                                                                        className="p-3 bg-zinc-100 hover:bg-white text-zinc-900 rounded-xl transition-[background-color,transform] duration-200 ease-apple active:scale-[0.96]"
                                                                        title={fav.videoId.length > 11 ? t('favorites.playJump') : t('favorites.playClip')}
                                                                    >
                                                                        <Play className="w-4 h-4 fill-current" />
                                                                    </button>
                                                                    <button
                                                                        onClick={() => shareFavorite(fav)}
                                                                        data-testid={`favorite-share-${fav.id}`}
                                                                        className="p-3 bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 rounded-xl transition-colors"
                                                                        title={t('share.action')}
                                                                        aria-label={t('share.action')}
                                                                    >
                                                                        <Share2 className="w-4 h-4" />
                                                                    </button>
                                                                    <button
                                                                        onClick={() => onRemoveFavorite(fav.id)}
                                                                        className="p-3 bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-red-400 rounded-xl transition-colors"
                                                                        title={t('favorites.delete')}
                                                                    >
                                                                        <Trash2 className="w-4 h-4" />
                                                                    </button>
                                                                </div>
                                                            </motion.div>
                                                        ))}
                                                    </motion.div>
                                                )}
                                            </AnimatePresence>
                                        </div>
                                    );
                                })
                            )}
                        </div>
                    </motion.div>

                    {playingFav && (
                        <div className="fixed bottom-6 right-6 w-[480px] aspect-video bg-black rounded-2xl shadow-2xl overflow-hidden border border-white/10 z-[60] group cursor-move">
                            <div className="absolute top-3 right-3 z-10 opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100 transition-opacity">
                                <button
                                    onClick={() => setPlayingFav(null)}
                                    className="p-2 text-white bg-black/60 hover:bg-black/80 rounded-full transition-colors backdrop-blur-md"
                                >
                                    <X className="w-4 h-4" />
                                </button>
                            </div>
                            <VideoPlayer
                                videoId={playingFav.videoId}
                                seekCommand={{ time: playingFav.start, timestamp: Date.now() }}
                                onTimeUpdate={() => {}}
                            />
                        </div>
                    )}
                </motion.div>
            )}
        </AnimatePresence>

        {/* Source confirmation. A custom dialog, rendered outside the sliding
            panel so its fixed positioning is never affected by the transform. */}
        <AnimatePresence>
            {pendingSource && (
                <motion.div
                    key="favorite-source-confirm"
                    data-testid="favorite-source-confirm"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.15 } }}
                    transition={{ duration: reduceMotion ? 0 : 0.2 }}
                    className="fixed inset-0 z-[70] flex items-center justify-center bg-zinc-950/70 backdrop-blur-md p-4"
                    onClick={() => setPendingSource(null)}
                >
                    <motion.div
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="favorite-source-confirm-title"
                        data-testid="favorite-source-confirm-dialog"
                        initial={reduceMotion ? false : { opacity: 0, y: 12, scale: 0.98 }}
                        animate={{ opacity: 1, y: 0, scale: 1 }}
                        exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 8, scale: 0.99, transition: { duration: 0.15 } }}
                        transition={reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 32 }}
                        onClick={(event) => event.stopPropagation()}
                        className="w-full max-w-sm rounded-2xl border border-white/10 bg-zinc-900/90 backdrop-blur-2xl p-5 shadow-2xl shadow-black/60"
                    >
                        <h3 id="favorite-source-confirm-title" className="text-base font-semibold tracking-tight text-zinc-100">
                            {t('favorites.source.confirmTitle')}
                        </h3>
                        <p className="mt-2 text-sm leading-relaxed text-zinc-400 break-words">
                            {t('favorites.source.confirmBody', { source: pendingSourceLabel })}
                        </p>
                        <div className="mt-5 flex justify-end gap-2">
                            <button
                                type="button"
                                data-testid="favorite-source-confirm-cancel"
                                onClick={() => setPendingSource(null)}
                                className="inline-flex items-center h-9 px-4 rounded-xl text-sm font-medium text-zinc-300 hover:text-zinc-100 hover:bg-white/5 transition-colors"
                            >
                                {t('favorites.source.cancel')}
                            </button>
                            <button
                                type="button"
                                data-testid="favorite-source-confirm-open"
                                onClick={confirmSourceOpen}
                                className="inline-flex items-center h-9 px-5 rounded-xl bg-zinc-100 text-zinc-900 text-sm font-semibold hover:bg-white active:scale-[0.98] transition-[background-color,transform] duration-200"
                            >
                                {t('favorites.source.open')}
                            </button>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>

        <ShareCardDialog
            isOpen={shareData !== null}
            data={shareData}
            onClose={() => setShareData(null)}
        />
        </>
    );
};
