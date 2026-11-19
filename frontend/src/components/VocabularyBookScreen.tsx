// 单词本 (word book) — full-page replacement for the old favorites modal.
//
// Two halves, one route (`#/profile/vocabulary`):
//   1. 我的单词 — saved vocabulary favorites (sentences / share cards excluded),
//      one line by default; expanding reveals the CEFR level (batched /level
//      lookup; off-list words read C1+), provenance, saved time and delete.
//   2. 词表 — 短语 + one merged CEFR 词表 (A1–C1) + GRE/CET4/CET6 from
//      `/api/vocabulary/lists`, with server-side search, 50-per-page pagination
//      and a global "hide Chinese" switch (persisted; hidden rows reveal their
//      translation on tap). The merged CEFR tab adds level chips whose counts
//      come from the catalog's `byLevel`; the old per-level A1–C1 tabs are gone.
//
// C2 is intentionally not modelled by the backend (`available:false`): it is
// explained inside the CEFR tab instead of getting its own disabled tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    BookMarked,
    BookOpen,
    ChevronDown,
    Download,
    Eye,
    EyeOff,
    ExternalLink,
    FileSpreadsheet,
    FileText,
    Info,
    Loader2,
    Play,
    Search,
    Star,
    Trash2,
    Tv,
    X,
    type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
import { exportAnkiTsv, exportCsv } from '../lib/exporter';
import type { FavoriteItem, FavoriteSourceKind } from '../lib/favorites';
import {
    resolveFavoriteSource,
    sentencePackLevel,
    splitIpaAndMeaning,
    type ResolvedFavoriteSource,
} from '../lib/favoriteSource';
import {
    fetchPhraseDetail,
    fetchPhrasePage,
    fetchVocabularyLevels,
    fetchVocabularyLists,
    fetchVocabularyPage,
    PHRASE_LEVELS,
    PHRASE_PAGE_SIZE,
    PHRASE_TYPES,
    VOCABULARY_CEFR_LEVELS,
    VOCABULARY_PAGE_SIZE,
    type CefrLevel,
    type PhraseDetail,
    type PhraseEntry,
    type PhraseLevel,
    type PhrasePage,
    type PhraseType,
    type VocabularyList,
    type VocabularyPage,
} from '../lib/vocabulary';
import { describeApiError } from '../lib/toast';
import { useI18n } from '../i18n/I18nProvider';
import { VocabPagination } from './VocabPagination';
import { SubHeader } from './ui/SubHeader';
import { Tabs, tabPanelProps, type TabItem } from './ui/Tabs';
import { FilterChip } from './ui/FilterChip';
import type { TranslationKey } from '../i18n';

interface VocabularyBookScreenProps {
    /** Every favorite; the screen keeps only `type === 'vocabulary'`. */
    favorites: FavoriteItem[];
    /** Back to the previous view (profile tab for a deep link). */
    onBack: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /** Optimistic delete + rollback/toast live in App; the row disappears now. */
    onRemoveFavorite: (id: string) => void;
    onPlayFavorite: (videoId: string, start: number) => void;
    onOpenArticle: (articleId: string) => void;
    onOpenLibraryArticle: (articleId: string) => void;
    onOpenSentencePack: (levelId: number) => void;
    onOpenBook: (bookId: string) => void;
    onOpenImportedBook: (bookId: string) => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';

const MINE_TAB = 'mine';
const PHRASES_TAB = 'phrases';
/** Merged CEFR list id (`GET /api/vocabulary/lists/cefr`); A1–C1 in one tab. */
const CEFR_TAB = 'cefr';
/** Product order: 我的单词 / 短语 / CEFR 词表 / GRE / CET4 / CET6. */
const LIST_TAB_IDS = [CEFR_TAB, 'gre', 'cet4', 'cet6'] as const;
const FALLBACK_LABELS: Record<string, string> = {
    cefr: 'CEFR 词表',
    gre: 'GRE',
    cet4: 'CET4',
    cet6: 'CET6',
};
const PHRASE_TYPE_LABEL_KEYS: Record<PhraseType, TranslationKey> = {
    phrasal_verb: 'vocab.phrases.type.phrasal_verb',
    idiom: 'vocab.phrases.type.idiom',
    collocation: 'vocab.phrases.type.collocation',
};
const PHRASE_TYPE_DESC_KEYS: Record<PhraseType, TranslationKey> = {
    phrasal_verb: 'vocab.phrases.typeDesc.phrasal_verb',
    idiom: 'vocab.phrases.typeDesc.idiom',
    collocation: 'vocab.phrases.typeDesc.collocation',
};
const PHRASE_SOURCE_KEYS: Record<string, TranslationKey> = {
    curated: 'vocab.phrases.source.curated',
    ECDICT: 'vocab.phrases.source.ecdict',
};
/** Hidden for the whole word-book; persisted across reloads by design. */
const HIDE_CHINESE_KEY = 'yt_bilingual_vocab_hide_zh';

const SOURCE_ICON: Record<FavoriteSourceKind, LucideIcon> = {
    video: Play,
    local_show: Tv,
    article: FileText,
    library_article: BookOpen,
    sentence_pack: BookOpen,
    book: BookOpen,
    imported_book: BookMarked,
};

const SOURCE_LABEL_KEYS: Record<FavoriteSourceKind, TranslationKey> = {
    video: 'vocab.source.video',
    local_show: 'vocab.source.local_show',
    article: 'vocab.source.article',
    library_article: 'vocab.source.library_article',
    sentence_pack: 'vocab.source.sentence_pack',
    book: 'vocab.source.book',
    imported_book: 'vocab.source.imported_book',
};

const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:pointer-events-none';
const DANGER_BUTTON =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-xs font-medium text-red-400 transition-colors';
const CARD = 'rounded-2xl border border-white/5 bg-zinc-900/40';

function levelBadgeClass(level: string): string {
    return level === 'C1+'
        ? 'bg-amber-500/10 text-amber-300 border-amber-500/20'
        : 'bg-blue-500/10 text-blue-300 border-blue-500/20';
}

function LevelBadge({ level, testId, title }: { level: string; testId?: string; title?: string }) {
    return (
        <span
            data-testid={testId}
            title={title}
            className={`inline-flex shrink-0 items-center rounded-full border px-2 py-0.5 text-[11px] font-medium tabular-nums ${levelBadgeClass(level)}`}
        >
            {level}
        </span>
    );
}

export function VocabularyBookScreen({
    favorites,
    onBack,
    parentLabel,
    onRemoveFavorite,
    onPlayFavorite,
    onOpenArticle,
    onOpenLibraryArticle,
    onOpenSentencePack,
    onOpenBook,
    onOpenImportedBook,
}: VocabularyBookScreenProps) {
    const { t, formatDate, formatNumber } = useI18n();
    const reduceMotion = useReducedMotion() ?? false;

    const myWords = useMemo(
        () => favorites
            .filter((fav) => fav.type === 'vocabulary')
            .sort((a, b) => (b.added_at || 0) - (a.added_at || 0)),
        [favorites],
    );

    // ── Catalog + active tab ──────────────────────────────────────────────
    const [catalog, setCatalog] = useState<VocabularyList[]>([]);
    const [catalogPhase, setCatalogPhase] = useState<Phase>('loading');
    const [catalogError, setCatalogError] = useState('');
    const [catalogNonce, setCatalogNonce] = useState(0);
    const [activeTab, setActiveTab] = useState<string>(MINE_TAB);

    useEffect(() => {
        let cancelled = false;
        setCatalogPhase('loading');
        fetchVocabularyLists()
            .then((lists) => {
                if (cancelled) return;
                setCatalog(lists);
                setCatalogPhase('ready');
            })
            .catch(async (error) => {
                if (cancelled) return;
                setCatalogError(await describeApiError(error));
                setCatalogPhase('error');
            });
        return () => { cancelled = true; };
    }, [catalogNonce]);

    const catalogById = useMemo(
        () => new Map(catalog.map((entry) => [entry.id, entry])),
        [catalog],
    );
    const activeIsMine = activeTab === MINE_TAB;
    const activeIsCefr = activeTab === CEFR_TAB;
    const activeList = activeIsMine ? null : catalogById.get(activeTab) ?? null;
    const activeUnavailable = activeList?.available === false;

    // ── My words: expand + batched CEFR lookup ────────────────────────────
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [levels, setLevels] = useState<Record<string, string | null>>({});
    const [levelPhase, setLevelPhase] = useState<Phase>('idle');
    const [levelError, setLevelError] = useState('');
    const [levelNonce, setLevelNonce] = useState(0);
    const levelWords = useMemo(
        () => Array.from(new Set(myWords.map((fav) => fav.en_text.trim()).filter(Boolean))),
        [myWords],
    );

    useEffect(() => {
        if (!activeIsMine) return;
        const missing = levelWords.filter((word) => !(word in levels));
        if (missing.length === 0) return;
        let cancelled = false;
        setLevelPhase('loading');
        setLevelError('');
        fetchVocabularyLevels(missing)
            .then((fetched) => {
                if (cancelled) return;
                setLevels((prev) => ({ ...prev, ...fetched }));
                setLevelPhase('ready');
            })
            .catch(async (error) => {
                if (cancelled) return;
                setLevelError(await describeApiError(error));
                setLevelPhase('error');
            });
        return () => { cancelled = true; };
    }, [activeIsMine, levelWords, levels, levelNonce]);

    const toggleExpanded = useCallback((id: string) => {
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }));
    }, []);

    const openSource = useCallback((source: ResolvedFavoriteSource, start: number) => {
        if (!source.ref) return;
        switch (source.kind) {
            case 'article':
                onOpenArticle(source.ref);
                return;
            case 'library_article':
                onOpenLibraryArticle(source.ref);
                return;
            case 'book':
                onOpenBook(source.ref);
                return;
            case 'imported_book':
                onOpenImportedBook(source.ref);
                return;
            case 'sentence_pack': {
                const level = sentencePackLevel(source.ref);
                if (level != null) onOpenSentencePack(level);
                return;
            }
            default:
                // video + local_show reuse the existing "play at position" jump.
                onPlayFavorite(source.ref, start);
        }
    }, [onOpenArticle, onOpenLibraryArticle, onOpenSentencePack, onOpenBook, onOpenImportedBook, onPlayFavorite]);

    // ── Word lists: server-side search + 50/page + hide-Chinese ───────────
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [page, setPage] = useState(1);
    /** CEFR tab only; '' = 全部. Counts for the chips come from `byLevel`. */
    const [listLevel, setListLevel] = useState<CefrLevel | ''>('');
    const [listPhase, setListPhase] = useState<Phase>('idle');
    const [listData, setListData] = useState<VocabularyPage | null>(null);
    const [listError, setListError] = useState('');
    const [listNonce, setListNonce] = useState(0);
    const [revealed, setRevealed] = useState<Set<string>>(new Set());
    const [hideChinese, setHideChinese] = useState<boolean>(() => {
        try {
            return localStorage.getItem(HIDE_CHINESE_KEY) === '1';
        } catch {
            return false;
        }
    });

    // ── Phrases: independent paging/search/filter state ───────────────────
    // Deliberately separate from the word-list state above: switching tabs (or
    // searching a phrase) must never rewrite what the A1/GRE list is showing.
    const [phraseQuery, setPhraseQuery] = useState('');
    const [phraseDebouncedQuery, setPhraseDebouncedQuery] = useState('');
    const [phrasePage, setPhrasePage] = useState(1);
    const [phraseLevel, setPhraseLevel] = useState<PhraseLevel | ''>('');
    const [phraseType, setPhraseType] = useState<PhraseType | ''>('');
    const [phrasePhase, setPhrasePhase] = useState<Phase>('idle');
    const [phraseData, setPhraseData] = useState<PhrasePage | null>(null);
    const [phraseError, setPhraseError] = useState('');
    const [phraseNonce, setPhraseNonce] = useState(0);
    const [phraseRevealed, setPhraseRevealed] = useState<Set<string>>(new Set());
    const [phraseExpanded, setPhraseExpanded] = useState<Set<string>>(new Set());
    const [phraseDetails, setPhraseDetails] = useState<Record<string, PhraseDetail>>({});
    const [phraseDetailPhase, setPhraseDetailPhase] = useState<Record<string, Phase>>({});
    const [phraseDetailError, setPhraseDetailError] = useState<Record<string, string>>({});
    const phraseDetailControllers = useRef<Map<string, AbortController>>(new Map());

    const selectTab = useCallback((id: string) => {
        if (id !== MINE_TAB && catalogById.get(id)?.available === false) return;
        setActiveTab(id);
        // Both surfaces restart from page 1 with a clean query/reveal state.
        setQuery('');
        setDebouncedQuery('');
        setPage(1);
        setListLevel('');
        setRevealed(new Set());
        setPhraseQuery('');
        setPhraseDebouncedQuery('');
        setPhrasePage(1);
        setPhraseLevel('');
        setPhraseType('');
        setPhraseRevealed(new Set());
        setPhraseExpanded(new Set());
    }, [catalogById]);


    // Persist the global switch. A storage failure is non-fatal (private mode).
    useEffect(() => {
        try {
            localStorage.setItem(HIDE_CHINESE_KEY, hideChinese ? '1' : '0');
        } catch {
            // Ignore: the preference just won't survive the reload.
        }
    }, [hideChinese]);

    // 300ms debounce; entering a query starts again from page 1.
    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedQuery(query.trim());
            setPage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [query]);

    // A new list/page/search/level starts with every row's translation collapsed.
    useEffect(() => {
        setRevealed(new Set());
    }, [activeTab, page, debouncedQuery, listLevel]);

    useEffect(() => {
        if (activeIsMine || activeUnavailable || activeTab === PHRASES_TAB) {
            setListData(null);
            setListPhase('idle');
            return;
        }
        const controller = new AbortController();
        setListPhase('loading');
        setListError('');
        fetchVocabularyPage(activeTab, {
            page,
            pageSize: VOCABULARY_PAGE_SIZE,
            q: debouncedQuery,
            level: activeIsCefr ? listLevel : '',
            signal: controller.signal,
        })
            .then((data) => {
                if (controller.signal.aborted) return;
                setListData(data);
                setListPhase('ready');
            })
            .catch(async (error) => {
                if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
                setListError(await describeApiError(error));
                setListPhase('error');
            });
        return () => controller.abort();
    }, [activeIsMine, activeIsCefr, activeUnavailable, activeTab, page, debouncedQuery, listLevel, listNonce]);

    // 300ms phrase search debounce; a changed query restarts from page 1.
    // Compare with the committed query first: the initial mount (and a tab
    // reset) must not schedule a page-1 jump after the user already paged.
    useEffect(() => {
        const trimmed = phraseQuery.trim();
        const timer = window.setTimeout(() => {
            if (trimmed === phraseDebouncedQuery) return;
            setPhraseDebouncedQuery(trimmed);
            setPhrasePage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [phraseQuery, phraseDebouncedQuery]);

    // New page/search/filter: drop temporary Chinese reveals and open details
    // so a stale row never stays expanded across a different result set.
    useEffect(() => {
        setPhraseRevealed(new Set());
        setPhraseExpanded(new Set());
    }, [phrasePage, phraseDebouncedQuery, phraseLevel, phraseType]);

    useEffect(() => {
        if (activeTab !== PHRASES_TAB) {
            setPhrasePhase('idle');
            return;
        }
        const controller = new AbortController();
        setPhrasePhase('loading');
        setPhraseError('');
        fetchPhrasePage({
            page: phrasePage,
            pageSize: PHRASE_PAGE_SIZE,
            q: phraseDebouncedQuery,
            level: phraseLevel,
            type: phraseType,
            signal: controller.signal,
        })
            .then((data) => {
                if (controller.signal.aborted) return;
                setPhraseData(data);
                setPhrasePhase('ready');
            })
            .catch(async (error) => {
                if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
                setPhraseError(await describeApiError(error));
                setPhrasePhase('error');
            });
        return () => controller.abort();
    }, [activeTab, phrasePage, phraseDebouncedQuery, phraseLevel, phraseType, phraseNonce]);

    // Abort pending detail requests on unmount.
    useEffect(() => () => {
        phraseDetailControllers.current.forEach((controller) => controller.abort());
        phraseDetailControllers.current.clear();
    }, []);

    const loadPhraseDetail = useCallback((id: string, force = false) => {
        if (!id) return;
        if (!force && (phraseDetails[id] || phraseDetailPhase[id] === 'loading')) return;
        phraseDetailControllers.current.get(id)?.abort();
        const controller = new AbortController();
        phraseDetailControllers.current.set(id, controller);
        setPhraseDetailPhase((prev) => ({ ...prev, [id]: 'loading' }));
        setPhraseDetailError((prev) => ({ ...prev, [id]: '' }));
        fetchPhraseDetail(id, { signal: controller.signal })
            .then((detail) => {
                if (controller.signal.aborted) return;
                setPhraseDetails((prev) => ({ ...prev, [id]: detail }));
                setPhraseDetailPhase((prev) => ({ ...prev, [id]: 'ready' }));
            })
            .catch(async (error) => {
                if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
                const message = await describeApiError(error);
                setPhraseDetailError((prev) => ({ ...prev, [id]: message }));
                setPhraseDetailPhase((prev) => ({ ...prev, [id]: 'error' }));
            })
            .finally(() => {
                if (phraseDetailControllers.current.get(id) === controller) {
                    phraseDetailControllers.current.delete(id);
                }
            });
    }, [phraseDetails, phraseDetailPhase]);

    const togglePhraseExpand = useCallback((id: string) => {
        const willExpand = !phraseExpanded.has(id);
        setPhraseExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
        if (willExpand) loadPhraseDetail(id);
    }, [phraseExpanded, loadPhraseDetail]);

    const togglePhraseReveal = useCallback((id: string) => {
        setPhraseRevealed((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    /** Row click: expand normally, but reveal Chinese first when it is hidden. */
    const activatePhraseRow = useCallback((id: string) => {
        if (hideChinese) togglePhraseReveal(id);
        else togglePhraseExpand(id);
    }, [hideChinese, togglePhraseExpand, togglePhraseReveal]);

    const toggleHideChinese = () => {
        setHideChinese((prev) => !prev);
        setRevealed(new Set());
        setPhraseRevealed(new Set());
    };

    const toggleReveal = (word: string) => {
        setRevealed((prev) => {
            const next = new Set(prev);
            if (next.has(word)) next.delete(word);
            else next.add(word);
            return next;
        });
    };

    /** Level chips: a new band always restarts at page 1; search combines. */
    const selectListLevel = (level: CefrLevel | '') => {
        setListLevel(level);
        setPage(1);
    };

    const total = listData?.total ?? 0;
    const pages = Math.max(1, Math.ceil(total / VOCABULARY_PAGE_SIZE));
    const listHasFilter = Boolean(debouncedQuery) || (activeIsCefr && Boolean(listLevel));
    const totalLabel = listHasFilter
        ? t('vocab.search.results', { count: formatNumber(total) })
        : t('vocab.total', { count: formatNumber(total) });

    const phraseTotal = phraseData?.total ?? 0;
    const phrasePages = Math.max(1, Math.ceil(phraseTotal / PHRASE_PAGE_SIZE));
    const phraseHasFilter = Boolean(phraseDebouncedQuery || phraseLevel || phraseType);
    const phraseTotalLabel = phraseHasFilter
        ? t('vocab.phrases.results', { count: formatNumber(phraseTotal) })
        : t('vocab.phrases.total', { count: formatNumber(phraseTotal) });

    const sourceText = useCallback((fav: FavoriteItem): { source: ResolvedFavoriteSource; text: string; canOpen: boolean } => {
        const source = resolveFavoriteSource(fav);
        const kindLabel = t(SOURCE_LABEL_KEYS[source.kind]);
        const level = source.kind === 'sentence_pack' ? sentencePackLevel(source.ref) : null;
        const canOpen = Boolean(source.ref) && (source.kind !== 'sentence_pack' || level != null);
        if (source.title) {
            return {
                source,
                text: t('vocab.source.fromTitle', { kind: kindLabel, title: source.title }),
                canOpen,
            };
        }
        if (source.ref) {
            return { source, text: t('vocab.source.fromKind', { kind: kindLabel }), canOpen };
        }
        return { source, text: t('vocab.source.unknown'), canOpen: false };
    }, [t]);

    const mineTabCount = myWords.length;

    const renderHeader = () => (
        <SubHeader
            title={t('vocab.title')}
            onBack={onBack}
            parentLabel={parentLabel}
            meta={<span data-testid="vocab-total">{totalLabel}</span>}
            backTestId="vocab-back"
        />
    );

    const renderTabs = () => {
        const tabs: string[] = [MINE_TAB, PHRASES_TAB, ...LIST_TAB_IDS];
        const items: TabItem[] = tabs.map((id) => {
            const entry = catalogById.get(id);
            const unavailable = entry?.available === false;
            const label = id === MINE_TAB
                ? t('vocab.tab.mine')
                : id === PHRASES_TAB
                    ? t('vocab.tab.phrases')
                    : id === CEFR_TAB
                        ? t('vocab.tab.cefr')
                        : (entry?.label || FALLBACK_LABELS[id] || id);
            const count = id === MINE_TAB
                ? mineTabCount
                : typeof entry?.count === 'number' && !unavailable
                    ? entry.count
                    : null;
            return {
                id,
                label,
                count,
                countLabel: count != null ? formatNumber(count) : undefined,
                countTestId: !unavailable ? `vocab-tab-count-${id}` : undefined,
                disabled: unavailable,
                title: unavailable ? entry?.note ?? undefined : undefined,
                testId: `vocab-tab-${id}`,
            };
        });
        return (
            <Tabs
                skin="panel"
                items={items}
                value={activeTab}
                onChange={(id) => selectTab(id)}
                layoutId="vocab-tab"
                ariaLabel={t('vocab.title')}
                idPrefix="vocab"
                testId="vocab-tabs"
                className="w-fit max-w-full self-start overflow-x-auto custom-scrollbar"
            />
        );
    };

    const renderC2Note = () => (
        <p
            data-testid="vocab-c2-note"
            className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-600"
        >
            <Info className="mt-px w-3.5 h-3.5 shrink-0" aria-hidden="true" />
            <span>{t('vocab.c2.note')}</span>
        </p>
    );

    const emptyState = (title: string, hint: string, icon: LucideIcon, testId: string) => {
        const Icon = icon;
        return (
            <div data-testid={testId} className={`${CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                <Icon className="mb-3 h-10 w-10 text-zinc-700" aria-hidden="true" />
                <p className="text-sm font-medium text-zinc-400">{title}</p>
                <p className="mt-1 max-w-md text-xs leading-relaxed text-zinc-600">{hint}</p>
            </div>
        );
    };

    const renderMine = () => (
        <div data-testid="vocab-mine-panel" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-zinc-500">{t('vocab.mine.hint')}</p>
                {myWords.length > 0 && (
                    <div className="flex items-center gap-2">
                        <button
                            type="button"
                            data-testid="vocab-export-anki"
                            onClick={() => exportAnkiTsv(myWords)}
                            title={t('favorites.exportAnkiTitle')}
                            className={SECONDARY_BUTTON}
                        >
                            <Download className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">{t('favorites.exportAnki')}</span>
                        </button>
                        <button
                            type="button"
                            data-testid="vocab-export-csv"
                            onClick={() => exportCsv(myWords)}
                            title={t('favorites.exportCsvTitle')}
                            className={SECONDARY_BUTTON}
                        >
                            <FileSpreadsheet className="w-3.5 h-3.5" />
                            <span className="hidden sm:inline">{t('favorites.exportCsv')}</span>
                        </button>
                    </div>
                )}
            </div>

            {myWords.length === 0
                ? emptyState(t('vocab.empty.mine'), t('vocab.empty.mineHint'), Star, 'vocab-mine-empty')
                : (
                    <div data-testid="vocab-mine-list" className={`${CARD} divide-y divide-white/5 overflow-hidden`}>
                        {myWords.map((fav) => {
                            const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
                            const isExpanded = Boolean(expanded[fav.id]);
                            const word = fav.en_text.trim();
                            const knownLevel = word in levels;
                            const level = levels[word] ?? null;
                            const levelLabel = level ?? 'C1+';
                            const source = sourceText(fav);
                            const SourceIcon = SOURCE_ICON[source.source.kind];
                            const addedAtLabel = fav.added_at
                                ? formatDate(fav.added_at)
                                : t('vocab.timeUnknown');
                            return (
                                <div key={fav.id} data-testid={`vocab-mine-${fav.id}`}>
                                    <button
                                        type="button"
                                        data-testid={`vocab-mine-toggle-${fav.id}`}
                                        aria-expanded={isExpanded}
                                        aria-controls={`vocab-mine-detail-${fav.id}`}
                                        aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
                                        onClick={() => toggleExpanded(fav.id)}
                                        className="flex w-full min-w-0 items-center gap-2 px-3.5 py-2.5 text-left transition-colors hover:bg-white/[0.03] sm:px-4"
                                    >
                                        <span
                                            data-testid={`vocab-mine-word-${fav.id}`}
                                            className="max-w-[42%] shrink-0 truncate text-[15px] font-semibold text-zinc-100"
                                        >
                                            {fav.en_text}
                                        </span>
                                        {ipa && (
                                            <span
                                                data-testid={`vocab-mine-ipa-${fav.id}`}
                                                className="max-w-[30%] shrink-0 truncate text-xs font-normal text-zinc-500"
                                            >
                                                {ipa}
                                            </span>
                                        )}
                                        <span
                                            data-testid={`vocab-mine-meaning-${fav.id}`}
                                            className="min-w-0 flex-1 truncate text-sm text-zinc-400"
                                        >
                                            {meaning || '—'}
                                        </span>
                                        <ChevronDown
                                            className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform duration-200 ease-apple motion-reduce:transition-none ${
                                                isExpanded ? 'rotate-180' : ''
                                            }`}
                                            aria-hidden="true"
                                        />
                                    </button>

                                    <AnimatePresence initial={false}>
                                        {isExpanded && (
                                            <motion.div
                                                key="body"
                                                id={`vocab-mine-detail-${fav.id}`}
                                                data-testid={`vocab-mine-detail-${fav.id}`}
                                                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                                animate={{ height: 'auto', opacity: 1 }}
                                                exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                                transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
                                                className="overflow-hidden"
                                            >
                                                <div className="grid grid-cols-1 gap-3 border-t border-white/5 px-3.5 pb-3.5 pt-3 sm:grid-cols-2 sm:px-4">
                                                    <div className="min-w-0 space-y-1">
                                                        <p className="text-[11px] text-zinc-500">{t('vocab.level')}</p>
                                                        <div className="flex min-h-6 flex-wrap items-center gap-2">
                                                            {knownLevel ? (
                                                                <LevelBadge
                                                                    testId={`vocab-mine-level-${fav.id}`}
                                                                    level={levelLabel}
                                                                    title={levelLabel === 'C1+' ? t('vocab.level.beyond') : `CEFR ${levelLabel}`}
                                                                />
                                                            ) : levelPhase === 'error' ? (
                                                                <span
                                                                    data-testid={`vocab-mine-level-error-${fav.id}`}
                                                                    title={levelError || undefined}
                                                                    className="inline-flex items-center gap-1 text-xs text-amber-300"
                                                                >
                                                                    {t('vocab.level.error')}
                                                                </span>
                                                            ) : (
                                                                <span className="inline-flex items-center gap-1.5 text-xs text-zinc-500">
                                                                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                                    {t('vocab.level.loading')}
                                                                </span>
                                                            )}
                                                            {!knownLevel && levelPhase === 'error' && (
                                                                <button
                                                                    type="button"
                                                                    data-testid={`vocab-mine-level-retry-${fav.id}`}
                                                                    onClick={() => setLevelNonce((value) => value + 1)}
                                                                    className="text-[11px] font-medium text-blue-300 hover:text-blue-200"
                                                                >
                                                                    {t('common.retry')}
                                                                </button>
                                                            )}
                                                        </div>
                                                        {knownLevel && levelLabel === 'C1+' && (
                                                            <p className="text-[11px] text-zinc-600">{t('vocab.level.beyond')}</p>
                                                        )}
                                                    </div>

                                                    <div className="min-w-0 space-y-1">
                                                        <p className="text-[11px] text-zinc-500">{t('vocab.source')}</p>
                                                        <button
                                                            type="button"
                                                            data-testid={`vocab-mine-source-${fav.id}`}
                                                            disabled={!source.canOpen}
                                                            onClick={() => openSource(source.source, fav.start)}
                                                            title={source.canOpen ? source.text : t('vocab.source.unknown')}
                                                            className={`-mx-1 flex max-w-[calc(100%+0.5rem)] items-center gap-2 rounded-lg px-1 py-0.5 text-left text-xs ${
                                                                source.canOpen
                                                                    ? 'text-blue-300 transition-colors hover:bg-blue-500/10 hover:text-blue-200'
                                                                    : 'cursor-default text-zinc-500'
                                                            }`}
                                                        >
                                                            <SourceIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                                            <span className="min-w-0 truncate">{source.text}</span>
                                                            {source.canOpen && <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
                                                        </button>
                                                    </div>

                                                    <div className="min-w-0 space-y-1">
                                                        <p className="text-[11px] text-zinc-500">{t('vocab.addedAt')}</p>
                                                        <p
                                                            data-testid={`vocab-mine-added-${fav.id}`}
                                                            className="text-xs text-zinc-300 tabular-nums"
                                                        >
                                                            {addedAtLabel}
                                                        </p>
                                                    </div>

                                                    <div className="flex items-end justify-start sm:justify-end">
                                                        <button
                                                            type="button"
                                                            data-testid={`vocab-mine-delete-${fav.id}`}
                                                            onClick={() => onRemoveFavorite(fav.id)}
                                                            title={t('vocab.delete')}
                                                            className={DANGER_BUTTON}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                                                            {t('vocab.delete')}
                                                        </button>
                                                    </div>

                                                    {(fav.context_en || fav.context_zh) && (
                                                        <div className="min-w-0 space-y-1.5 rounded-xl border border-white/5 bg-zinc-950/30 px-3 py-2 sm:col-span-2">
                                                            <p className="text-[11px] text-zinc-500">{t('vocab.context')}</p>
                                                            {fav.context_en && (
                                                                <p className="break-words text-[13px] leading-relaxed text-zinc-200">{fav.context_en}</p>
                                                            )}
                                                            {fav.context_zh && (
                                                                <p className="break-words text-[13px] leading-relaxed text-zinc-400">{fav.context_zh}</p>
                                                            )}
                                                        </div>
                                                    )}
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        })}
                    </div>
                )}
        </div>
    );

    const renderPhrases = () => {
        const phraseTypeLabel = (type: string): string => (
            type in PHRASE_TYPE_LABEL_KEYS
                ? t(PHRASE_TYPE_LABEL_KEYS[type as PhraseType])
                : t('vocab.phrases.type.unknown')
        );
        const phraseTypeDescription = (type: string): string => (
            type in PHRASE_TYPE_DESC_KEYS
                ? t(PHRASE_TYPE_DESC_KEYS[type as PhraseType])
                : ''
        );
        const phraseSourceLabel = (source: string): string => (
            PHRASE_SOURCE_KEYS[source]
                ? t(PHRASE_SOURCE_KEYS[source])
                : (source || t('vocab.phrases.source.unknown'))
        );
        const typeBadge = (type: string) => (
            <span
                data-testid="phrase-type"
                className="order-1 inline-flex shrink-0 items-center rounded-full border border-white/5 bg-white/[0.04] px-2 py-0.5 text-[11px] font-medium text-zinc-400 sm:order-2"
            >
                {phraseTypeLabel(type)}
            </span>
        );

        return (
            <div data-testid="phrase-panel" className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative min-w-0 flex-1">
                        <Search
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                            aria-hidden="true"
                        />
                        <input
                            type="text"
                            data-testid="phrase-search"
                            value={phraseQuery}
                            onChange={(event) => setPhraseQuery(event.target.value)}
                            placeholder={t('vocab.phrases.search.placeholder')}
                            aria-label={t('vocab.phrases.search.placeholder')}
                            className="h-10 w-full min-w-0 rounded-xl border border-white/5 bg-zinc-800/60 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                        />
                        {phraseQuery && (
                            <button
                                type="button"
                                data-testid="phrase-search-clear"
                                onClick={() => setPhraseQuery('')}
                                aria-label={t('vocab.phrases.search.clear')}
                                title={t('vocab.phrases.search.clear')}
                                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        data-testid="vocab-hide-toggle"
                        data-scope="phrases"
                        aria-pressed={hideChinese}
                        onClick={toggleHideChinese}
                        title={hideChinese ? t('vocab.show') : t('vocab.hide')}
                        className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                            hideChinese
                                ? 'border-blue-500/20 bg-blue-500/10 text-blue-300 hover:bg-blue-500/15'
                                : 'border-white/5 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100'
                        }`}
                    >
                        {hideChinese ? <Eye className="h-4 w-4" aria-hidden="true" /> : <EyeOff className="h-4 w-4" aria-hidden="true" />}
                        {hideChinese ? t('vocab.show') : t('vocab.hide')}
                    </button>
                </div>

                <div className="flex flex-col gap-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-[11px] text-zinc-500">{t('vocab.phrases.filter.level')}</span>
                        <FilterChip
                            selected={phraseLevel === ''}
                            testId="phrase-level-all"
                            onClick={() => setPhraseLevel('')}
                        >
                            {t('vocab.phrases.filter.all')}
                        </FilterChip>
                        {PHRASE_LEVELS.map((level) => (
                            <FilterChip
                                key={level}
                                selected={phraseLevel === level}
                                testId={`phrase-level-${level}`}
                                onClick={() => setPhraseLevel(level)}
                            >
                                {level}
                            </FilterChip>
                        ))}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5">
                        <span className="mr-1 text-[11px] text-zinc-500">{t('vocab.phrases.filter.type')}</span>
                        <FilterChip
                            selected={phraseType === ''}
                            testId="phrase-type-all"
                            onClick={() => setPhraseType('')}
                        >
                            {t('vocab.phrases.filter.all')}
                        </FilterChip>
                        {PHRASE_TYPES.map((type) => (
                            <FilterChip
                                key={type}
                                selected={phraseType === type}
                                testId={`phrase-type-${type}`}
                                onClick={() => setPhraseType(type)}
                            >
                                {t(PHRASE_TYPE_LABEL_KEYS[type])}
                            </FilterChip>
                        ))}
                    </div>
                </div>

                <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-zinc-500">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span data-testid="phrase-approx-note">{t('vocab.phrases.approxNote')}</span>
                </p>

                {(phraseData || phrasePhase === 'ready') && (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                        <span data-testid="phrase-total" className="tabular-nums">{phraseTotalLabel}</span>
                        {phraseHasFilter && (
                            <button
                                type="button"
                                data-testid="phrase-clear-filters"
                                onClick={() => {
                                    setPhraseQuery('');
                                    setPhraseLevel('');
                                    setPhraseType('');
                                    setPhrasePage(1);
                                }}
                                className="font-medium text-blue-300 transition-colors hover:text-blue-200"
                            >
                                {t('vocab.phrases.clearFilters')}
                            </button>
                        )}
                    </div>
                )}

                {phrasePhase === 'loading' && (
                    <div data-testid="phrase-loading" className={`${CARD} flex items-center justify-center gap-2 py-16 text-sm text-zinc-500`}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('common.loading')}
                    </div>
                )}

                {phrasePhase === 'error' && (
                    <div data-testid="phrase-error" className={`${CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                        <AlertTriangle className="mb-3 h-10 w-10 text-amber-400/70" aria-hidden="true" />
                        <p className="text-sm font-medium text-zinc-300">{t('vocab.phrases.error.title')}</p>
                        <p className="mt-1 max-w-md break-words text-xs text-zinc-500">{phraseError || t('vocab.phrases.error.hint')}</p>
                        <button
                            type="button"
                            data-testid="phrase-retry"
                            onClick={() => setPhraseNonce((value) => value + 1)}
                            className={`${SECONDARY_BUTTON} mt-5`}
                        >
                            {t('common.retry')}
                        </button>
                    </div>
                )}

                {phrasePhase === 'ready' && phraseData && (
                    phraseData.items.length === 0 ? (
                        emptyState(
                            phraseHasFilter ? t('vocab.phrases.empty.title') : t('vocab.phrases.empty.list'),
                            phraseHasFilter ? t('vocab.phrases.empty.hint') : t('vocab.phrases.empty.listHint'),
                            Search,
                            'phrase-empty',
                        )
                    ) : (
                        <>
                            <p className="text-[11px] leading-relaxed text-zinc-500">
                                {hideChinese ? t('vocab.phrases.hint.hide') : t('vocab.phrases.hint')}
                            </p>
                            <div data-testid="phrase-list" className={`${CARD} overflow-hidden`}>
                                <div className="divide-y divide-white/5">
                                    {phraseData.items.map((item: PhraseEntry) => {
                                        const isExpanded = phraseExpanded.has(item.id);
                                        const isRevealed = phraseRevealed.has(item.id);
                                        const chineseHidden = hideChinese && !isRevealed;
                                        const detail = phraseDetails[item.id];
                                        const detailState = phraseDetailPhase[item.id] ?? 'idle';
                                        const detailError = phraseDetailError[item.id] ?? '';
                                        const typeDescription = phraseTypeDescription(item.type);
                                        const sourceLabel = phraseSourceLabel(item.source);
                                        const example = item.example || detail?.example || '';
                                        return (
                                            <div
                                                key={item.id}
                                                data-testid={`phrase-item-${item.id}`}
                                                className={isExpanded ? 'bg-white/[0.02]' : undefined}
                                            >
                                                <div className="flex items-stretch">
                                                    <button
                                                        type="button"
                                                        data-testid="phrase-row"
                                                        data-phrase-id={item.id}
                                                        aria-expanded={hideChinese ? undefined : isExpanded}
                                                        aria-pressed={hideChinese ? isRevealed : undefined}
                                                        title={hideChinese ? (isRevealed ? t('vocab.tapHide') : t('vocab.tapReveal')) : undefined}
                                                        onClick={() => activatePhraseRow(item.id)}
                                                        className="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5 text-left transition-colors hover:bg-white/[0.03]"
                                                    >
                                                        <span
                                                            data-testid="phrase-headword"
                                                            className="order-1 min-w-0 flex-1 break-words text-[15px] font-semibold leading-snug text-zinc-100 sm:order-1"
                                                        >
                                                            {item.headword}
                                                        </span>
                                                        <span className="order-3 flex w-full min-w-0 flex-wrap items-center gap-2 sm:contents">
                                                            {typeBadge(item.type)}
                                                            <span className="order-2 min-w-0 flex-1 break-words text-sm text-zinc-400 sm:order-3">
                                                                {chineseHidden ? null : (
                                                                    <span data-testid="phrase-translation">{item.translation || '—'}</span>
                                                                )}
                                                            </span>
                                                        </span>
                                                        <span className="order-2 flex shrink-0 items-center gap-2 self-start sm:order-4 sm:self-auto">
                                                            {hideChinese && (
                                                                isRevealed
                                                                    ? <Eye className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                                                                    : <EyeOff className="h-3.5 w-3.5 text-zinc-600" aria-hidden="true" />
                                                            )}
                                                            <LevelBadge
                                                                testId="phrase-level"
                                                                level={item.cefr || '—'}
                                                                title={t('vocab.phrases.approxTitle')}
                                                            />
                                                        </span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        data-testid="phrase-expand"
                                                        aria-expanded={isExpanded}
                                                        aria-controls={`phrase-detail-${item.id}`}
                                                        aria-label={isExpanded ? t('vocab.phrases.collapse') : t('vocab.phrases.expand')}
                                                        title={isExpanded ? t('vocab.phrases.collapse') : t('vocab.phrases.expand')}
                                                        onClick={() => togglePhraseExpand(item.id)}
                                                        className="flex w-10 shrink-0 items-center justify-center text-zinc-500 transition-colors hover:bg-white/[0.03] hover:text-zinc-300"
                                                    >
                                                        <ChevronDown
                                                            className={`h-4 w-4 transition-transform duration-200 ease-apple motion-reduce:transition-none ${
                                                                isExpanded ? 'rotate-180' : ''
                                                            }`}
                                                            aria-hidden="true"
                                                        />
                                                    </button>
                                                </div>

                                                <AnimatePresence initial={false}>
                                                    {isExpanded && (
                                                        <motion.div
                                                            key="body"
                                                            id={`phrase-detail-${item.id}`}
                                                            data-testid="phrase-detail"
                                                            initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                                                            animate={{ height: 'auto', opacity: 1 }}
                                                            exit={reduceMotion ? { opacity: 0 } : { height: 0, opacity: 0 }}
                                                            transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.25, 1, 0.5, 1] }}
                                                            className="overflow-hidden"
                                                        >
                                                            <div className="grid grid-cols-1 gap-3 border-t border-white/5 px-4 pb-4 pt-3 sm:grid-cols-2">
                                                                <div className="min-w-0 space-y-1 sm:col-span-2">
                                                                    <p className="text-[11px] text-zinc-500">{t('vocab.phrases.detail.example')}</p>
                                                                    <p
                                                                        data-testid="phrase-example"
                                                                        className="break-words text-[13px] leading-relaxed text-zinc-200"
                                                                    >
                                                                        {example || '—'}
                                                                    </p>
                                                                </div>

                                                                {!chineseHidden && (
                                                                    <div className="min-w-0 space-y-1">
                                                                        <p className="text-[11px] text-zinc-500">{t('vocab.phrases.detail.type')}</p>
                                                                        <p
                                                                            data-testid="phrase-type-desc"
                                                                            className="break-words text-[13px] leading-relaxed text-zinc-300"
                                                                        >
                                                                            {typeDescription || '—'}
                                                                        </p>
                                                                    </div>
                                                                )}

                                                                <div className="min-w-0 space-y-1">
                                                                    <p className="text-[11px] text-zinc-500">{t('vocab.phrases.detail.source')}</p>
                                                                    <p
                                                                        data-testid="phrase-source"
                                                                        title={detail?.license ?? undefined}
                                                                        className="break-words text-xs text-zinc-300"
                                                                    >
                                                                        {sourceLabel}
                                                                    </p>
                                                                    {detail?.license && (
                                                                        <p className="break-words text-[11px] text-zinc-600">{detail.license}</p>
                                                                    )}
                                                                </div>

                                                                {chineseHidden ? (
                                                                    <div
                                                                        data-testid="phrase-zh-hidden"
                                                                        className="min-w-0 rounded-xl border border-white/5 bg-zinc-950/30 px-3 py-2 text-[11px] leading-relaxed text-zinc-500 sm:col-span-2"
                                                                    >
                                                                        {t('vocab.phrases.detail.zhHidden')}
                                                                    </div>
                                                                ) : (
                                                                    <>
                                                                        {detailState === 'loading' && (
                                                                            <p data-testid="phrase-detail-loading" className="flex items-center gap-1.5 text-xs text-zinc-500">
                                                                                <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                                                {t('vocab.phrases.detail.loading')}
                                                                            </p>
                                                                        )}
                                                                        {detailState === 'error' && (
                                                                            <div className="flex flex-wrap items-center gap-2 text-xs text-amber-300">
                                                                                <span data-testid="phrase-detail-error">
                                                                                    {t('vocab.phrases.detail.error')}
                                                                                    {detailError ? ` · ${detailError}` : ''}
                                                                                </span>
                                                                                <button
                                                                                    type="button"
                                                                                    data-testid="phrase-detail-retry"
                                                                                    onClick={() => loadPhraseDetail(item.id, true)}
                                                                                    className="font-medium text-amber-100 underline-offset-2 hover:underline"
                                                                                >
                                                                                    {t('common.retry')}
                                                                                </button>
                                                                            </div>
                                                                        )}
                                                                        {detail?.notes && (
                                                                            <div className="min-w-0 space-y-1 sm:col-span-2">
                                                                                <p className="text-[11px] text-zinc-500">{t('vocab.phrases.detail.notes')}</p>
                                                                                <p
                                                                                    data-testid="phrase-notes"
                                                                                    className="break-words text-[13px] leading-relaxed text-zinc-400"
                                                                                >
                                                                                    {detail.notes}
                                                                                </p>
                                                                            </div>
                                                                        )}
                                                                    </>
                                                                )}
                                                            </div>
                                                        </motion.div>
                                                    )}
                                                </AnimatePresence>
                                            </div>
                                        );
                                    })}
                                </div>
                            </div>

                            <VocabPagination
                                scope="phrase"
                                page={phrasePage}
                                pages={phrasePages}
                                hasMore={phraseData.hasMore}
                                onChange={setPhrasePage}
                            />
                        </>
                    )
                )}
            </div>
        );
    };

    const renderList = () => {
        const label = activeIsCefr
            ? t('vocab.tab.cefr')
            : activeList?.label || FALLBACK_LABELS[activeTab] || activeTab;
        return (
            <div data-testid="vocab-list-panel" className="flex flex-col gap-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                    <div className="relative min-w-0 flex-1">
                        <Search
                            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-zinc-500"
                            aria-hidden="true"
                        />
                        <input
                            type="text"
                            data-testid="vocab-search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('vocab.search.placeholder')}
                            aria-label={t('vocab.search.placeholder')}
                            className="h-10 w-full min-w-0 rounded-xl border border-white/5 bg-zinc-800/60 pl-9 pr-9 text-sm text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                        />
                        {query && (
                            <button
                                type="button"
                                data-testid="vocab-search-clear"
                                onClick={() => setQuery('')}
                                aria-label={t('vocab.search.clear')}
                                title={t('vocab.search.clear')}
                                className="absolute right-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-lg text-zinc-500 transition-colors hover:bg-white/5 hover:text-zinc-300"
                            >
                                <X className="h-4 w-4" aria-hidden="true" />
                            </button>
                        )}
                    </div>
                    <button
                        type="button"
                        data-testid="vocab-hide-toggle"
                        aria-pressed={hideChinese}
                        onClick={toggleHideChinese}
                        title={hideChinese ? t('vocab.show') : t('vocab.hide')}
                        className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                            hideChinese
                                ? 'border-blue-500/20 bg-blue-500/10 text-blue-300 hover:bg-blue-500/15'
                                : 'border-white/5 bg-zinc-800/60 text-zinc-300 hover:bg-zinc-700/60 hover:text-zinc-100'
                        }`}
                    >
                        {hideChinese ? <Eye className="h-4 w-4" aria-hidden="true" /> : <EyeOff className="h-4 w-4" aria-hidden="true" />}
                        {hideChinese ? t('vocab.show') : t('vocab.hide')}
                    </button>
                </div>

                {hideChinese && (
                    <p className="text-[11px] leading-relaxed text-zinc-500">{t('vocab.hint.hide')}</p>
                )}

                {activeIsCefr && (
                    <div className="flex flex-col gap-2">
                        <div
                            data-testid="vocab-level-filter"
                            className="flex flex-wrap items-center gap-1.5"
                        >
                            <span className="mr-1 text-[11px] text-zinc-500">
                                {t('vocab.cefr.filter.level')}
                            </span>
                            <FilterChip
                                selected={listLevel === ''}
                                testId="vocab-level-all"
                                onClick={() => selectListLevel('')}
                            >
                                {t('vocab.cefr.filter.all')}
                            </FilterChip>
                            {VOCABULARY_CEFR_LEVELS.map((level) => {
                                const count = activeList?.byLevel?.[level];
                                return (
                                    <FilterChip
                                        key={level}
                                        selected={listLevel === level}
                                        testId={`vocab-level-${level}`}
                                        onClick={() => selectListLevel(level)}
                                    >
                                        {count != null
                                            ? t('vocab.cefr.levelCount', {
                                                level,
                                                count: formatNumber(count),
                                            })
                                            : level}
                                    </FilterChip>
                                );
                            })}
                        </div>
                        {renderC2Note()}
                    </div>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-zinc-500">
                    <span data-testid="vocab-total" className="tabular-nums">{totalLabel}</span>
                    <span className="text-zinc-600">{label}</span>
                    {activeList?.approximate && (
                        <span className="rounded-full border border-white/5 bg-white/[0.03] px-2 py-0.5 text-[10px] text-zinc-500">
                            {t('vocab.approximate')}
                        </span>
                    )}
                </div>

                {listPhase === 'loading' && (
                    <div data-testid="vocab-loading" className={`${CARD} flex items-center justify-center gap-2 py-16 text-sm text-zinc-500`}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('common.loading')}
                    </div>
                )}

                {listPhase === 'error' && (
                    <div data-testid="vocab-error" className={`${CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                        <AlertTriangle className="mb-3 h-10 w-10 text-amber-400/70" aria-hidden="true" />
                        <p className="text-sm font-medium text-zinc-300">{t('vocab.error.title')}</p>
                        <p className="mt-1 max-w-md break-words text-xs text-zinc-500">{listError || t('vocab.error.hint')}</p>
                        <button
                            type="button"
                            data-testid="vocab-retry"
                            onClick={() => setListNonce((value) => value + 1)}
                            className={`${SECONDARY_BUTTON} mt-5`}
                        >
                            {t('common.retry')}
                        </button>
                    </div>
                )}

                {listPhase === 'ready' && listData && (
                    listData.items.length === 0 ? (
                        emptyState(
                            listHasFilter ? t('vocab.empty.title') : t('vocab.empty.list'),
                            listHasFilter ? t('vocab.empty.hint') : t('vocab.empty.listHint'),
                            Search,
                            'vocab-empty',
                        )
                    ) : (
                        <>
                            <div data-testid="vocab-word-list" className={`${CARD} overflow-hidden`}>
                                <div className="hidden grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_auto] gap-3 border-b border-white/5 px-4 py-2 text-[11px] font-medium text-zinc-500 md:grid">
                                    <span>{t('vocab.col.word')}</span>
                                    <span>{t('vocab.col.translation')}</span>
                                    <span className="text-right">{t('vocab.col.level')}</span>
                                </div>
                                <div className="divide-y divide-white/5">
                                    {listData.items.map((item, index) => {
                                        const isRevealed = revealed.has(item.word);
                                        const translationHidden = hideChinese && !isRevealed;
                                        return (
                                            <button
                                                key={`${item.word}-${index}`}
                                                type="button"
                                                data-testid="vocab-list-row"
                                                data-word={item.word}
                                                aria-pressed={hideChinese ? isRevealed : undefined}
                                                title={hideChinese
                                                    ? (isRevealed ? t('vocab.tapHide') : t('vocab.tapReveal'))
                                                    : undefined}
                                                onClick={hideChinese ? () => toggleReveal(item.word) : undefined}
                                                className={`grid w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 px-4 py-2.5 text-left transition-colors md:grid-cols-[minmax(0,1.15fr)_minmax(0,1.55fr)_auto] md:gap-y-0 ${
                                                    hideChinese ? 'cursor-pointer hover:bg-white/[0.03]' : 'cursor-default'
                                                }`}
                                            >
                                                <span className="flex min-w-0 items-baseline gap-2">
                                                    <span data-testid="vocab-list-word" className="min-w-0 truncate text-[15px] font-semibold text-zinc-100">
                                                        {item.word}
                                                    </span>
                                                    {item.phonetic && (
                                                        <span className="min-w-0 truncate text-xs text-zinc-500">
                                                            {item.phonetic}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="col-span-2 row-start-2 min-w-0 md:col-span-1 md:col-start-2 md:row-start-1">
                                                    {translationHidden ? null : (
                                                        <span
                                                            data-testid="vocab-list-translation"
                                                            className="block truncate text-sm text-zinc-400"
                                                        >
                                                            {item.translation || '—'}
                                                        </span>
                                                    )}
                                                </span>
                                                <span className="col-start-2 row-start-1 flex items-center justify-end gap-2 md:col-start-3">
                                                    {hideChinese && (
                                                        isRevealed
                                                            ? <Eye className="h-3.5 w-3.5 text-zinc-500" aria-hidden="true" />
                                                            : <EyeOff className="h-3.5 w-3.5 text-zinc-600" aria-hidden="true" />
                                                    )}
                                                    <LevelBadge
                                                        testId="vocab-list-level"
                                                        level={item.cefrLevel || '—'}
                                                        title={item.cefrLevel ? `CEFR ${item.cefrLevel}` : undefined}
                                                    />
                                                </span>
                                            </button>
                                        );
                                    })}
                                </div>
                            </div>

                            <VocabPagination
                                scope="vocab"
                                page={page}
                                pages={pages}
                                hasMore={listData.hasMore}
                                onChange={setPage}
                            />
                        </>
                    )
                )}
            </div>
        );
    };

    return (
        <div
            data-testid="vocabulary-book"
            className="flex-1 min-h-0 flex flex-col overflow-hidden bg-[#09090b]"
        >
            {renderHeader()}
            <div className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden custom-scrollbar">
            <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4 sm:gap-5 sm:px-6 sm:py-8">
                {catalogPhase === 'error' && (
                    <div
                        data-testid="vocab-catalog-error"
                        role="alert"
                        className="flex items-start gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs text-amber-200"
                    >
                        <AlertTriangle className="mt-px h-4 w-4 shrink-0" aria-hidden="true" />
                        <span className="min-w-0 flex-1 break-words">
                            {t('vocab.error.title')}
                            {catalogError ? ` · ${catalogError}` : ''}
                        </span>
                        <button
                            type="button"
                            data-testid="vocab-catalog-retry"
                            onClick={() => setCatalogNonce((value) => value + 1)}
                            className="shrink-0 font-medium text-amber-100 underline-offset-2 hover:underline"
                        >
                            {t('common.retry')}
                        </button>
                    </div>
                )}
                {renderTabs()}
                <div {...tabPanelProps('vocab', activeTab)}>
                    {activeIsMine ? renderMine() : activeTab === PHRASES_TAB ? renderPhrases() : renderList()}
                </div>
            </div>
            </div>
        </div>
    );
}
