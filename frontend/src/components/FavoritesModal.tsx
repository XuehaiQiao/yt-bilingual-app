import React from 'react';
import { X, Play, Trash2, Star, Download, FileSpreadsheet } from 'lucide-react';
import { exportAnkiTsv, exportCsv } from '../lib/exporter';
import { useI18n } from '../i18n/I18nProvider';
import type { TranslationKey } from '../i18n';
import { motion, AnimatePresence } from 'framer-motion';

export interface FavoriteItem {
    id: string;
    videoId: string;
    start: number;
    en_text: string;
    zh_text: string;
    added_at?: number;
    highlights?: Array<{
        en_word: string;
        zh_word: string;
        color: string;
    }>;
    type?: 'sentence' | 'vocabulary';
    context_en?: string;
    context_zh?: string;
}

interface FavoritesModalProps {
    isOpen: boolean;
    onClose: () => void;
    favorites: FavoriteItem[];
    onRemoveFavorite: (id: string) => void;
    onPlayFavorite: (videoId: string, start: number) => void;
}
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useState, useMemo } from 'react';
import { VideoPlayer } from './VideoPlayer';
import { HighlightedText } from './TranscriptBlock';

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

// ... inside the component
export const FavoritesModal: React.FC<FavoritesModalProps> = ({ isOpen, onClose, favorites, onRemoveFavorite, onPlayFavorite }) => {
    const { t, formatMonth } = useI18n();
    const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
    const [playingFav, setPlayingFav] = useState<{ videoId: string, start: number } | null>(null);

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

    return (
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
                    >
                        <div className="flex items-center justify-between px-6 py-5 border-b border-white/5 shrink-0">
                            <h2 className="text-2xl font-semibold text-zinc-100 tracking-tight">{t('favorites.title')}</h2>
                            <div className="flex items-center gap-2">
                                {favorites.length > 0 && (
                                    <>
                                        <button
                                            onClick={() => exportAnkiTsv(favorites)}
                                            className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
                                            title={t('favorites.exportAnkiTitle')}
                                        >
                                            <Download className="w-4 h-4" /> {t('favorites.exportAnki')}
                                        </button>
                                        <button
                                            onClick={() => exportCsv(favorites)}
                                            className="inline-flex items-center gap-2 h-9 px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-sm font-medium text-zinc-300 hover:text-zinc-100 transition-colors"
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

                        <div className="p-6 overflow-y-auto flex-1 custom-scrollbar space-y-6">
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
                                                        {items.map((fav) => (
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
                                                                        {fav.type === 'vocabulary' && (
                                                                            <span className="text-[11px] font-medium text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded-full">{t('favorites.type.vocabulary')}</span>
                                                                        )}
                                                                    </div>
                                                                    {fav.type === 'vocabulary' && fav.en_text && fav.zh_text ? (
                                                                        <div className="p-3 bg-zinc-900/60 rounded-lg border border-white/5 inline-block">
                                                                            <div className="flex items-center gap-3">
                                                                                <span className="text-lg font-semibold text-zinc-100">{fav.en_text}</span>
                                                                                <span className="text-sm text-zinc-400 font-medium">{fav.zh_text}</span>
                                                                            </div>
                                                                        </div>
                                                                    ) : null}
                                                                    <div className={fav.type === 'vocabulary' ? 'opacity-70 text-sm' : ''}>
                                                                        <p className="text-base text-zinc-100 font-normal leading-relaxed mb-2">
                                                                            <HighlightedText 
                                                                                text={fav.type === 'vocabulary' ? (fav.context_en || '') : fav.en_text} 
                                                                                highlights={(fav.highlights || []).map(h => ({ 
                                                                                    word: h.en_word, 
                                                                                    color: h.color, 
                                                                                    annotation: h.zh_word 
                                                                                }))} 
                                                                            />
                                                                        </p>
                                                                        <p className="text-[15px] text-zinc-400 leading-relaxed">{fav.type === 'vocabulary' ? fav.context_zh : fav.zh_text}</p>
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
    );
};
