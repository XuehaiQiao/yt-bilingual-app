// 单词本 (word book) — full-page route `#/app/profile/vocabulary`.
//
// Five surfaces share one implementation (specs/005 §统一词表 UI):
//   * 我的单词 — the vocabulary favorites themselves (ADR-0001; client paged);
//   * 已掌握 — `word_states.mastered=1` only (not favorites); the meaning comes
//     from the `definition` snapshot, then `—`. Its star is disabled: mastered
//     is not a favorite and must never pretend to be one.
//   * 内置词表 — merged CEFR (A1–C1) + GRE/CET4/CET6 (`/api/vocabulary/lists`,
//     server paged, server search + level filter);
//   * 自定义词表 — imported lists (specs/038), fully loaded and client paged so
//     search / sort / filters / edit mode work on the whole list;
//   * 短语 — curated phrase list (server paged).
//
// Every list renders through the same row (`VocabularyRows.WordTable`): word /
// phonetic / left-aligned meaning / speak / LevelBadge / star / ×N (我的单词
// only) / expand arrow. The expanded area carries the full meaning, provenance
// and the row actions. Toolbars are search + one sort trigger + one filter
// trigger; pagination is 20/50/100 + page numbers + jump input. Edit mode
// (leading checkboxes + a sticky action bar) exists only on 自定义词表.
//
// 已掌握 and 我的单词 are two independent lists (ADR-0001): 我的单词 is the
// favorites list itself (count = length, no subtraction, no read-time mastery
// filter); 已掌握 is `word_states.mastered=1` on its own. Mutual exclusion is
// enforced by the write path — a legacy overlap is surfaced honestly until the
// reconcile removes the duplicate favorite, never hidden here.
//
// Review surfaces stay hidden while `REVIEW_UI_ENABLED=false` (specs/013): no
// 加入复习 action, no 状态 filter, no review counts, and no review request is
// made from this screen.
//
// C2 is intentionally not modelled by the backend (`available:false`): it is
// explained inside the CEFR tab instead of getting its own disabled tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    BookMarked,
    BookOpen,
    BookmarkPlus,
    CheckCircle2,
    Download,
    Eye,
    EyeOff,
    ExternalLink,
    FileSpreadsheet,
    FileText,
    Info,
    Library,
    Loader2,
    MoreHorizontal,
    Pencil,
    Play,
    Repeat,
    Search,
    Star,
    Trash2,
    Tv,
    Undo2,
    Upload,
    type LucideIcon,
} from 'lucide-react';
import { exportAnkiTsv, exportCsv } from '../lib/exporter';
import {
    addFavorite,
    removeFavorite,
    type FavoriteDraft,
    type FavoriteItem,
    type FavoriteSourceKind,
} from '../lib/favorites';
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
    PHRASE_TYPES,
    VOCABULARY_CEFR_LEVELS,
    type CefrLevel,
    type PhraseDetail,
    type PhraseEntry,
    type PhraseLevel,
    type PhrasePage,
    type PhraseType,
    type VocabularyList,
    type VocabularyPage,
} from '../lib/vocabulary';
import {
    addWord,
    getMasteredWords,
    listReviewWords,
    REVIEW_UI_ENABLED,
    REVIEW_WORD_STATES,
    setWordMastered,
    type ReviewWordState,
} from '../lib/review';
import {
    deleteCustomWordlist,
    deleteCustomWordlistItems,
    fetchAllCustomWordlistItems,
    fetchCustomWordlistPage,
    fetchCustomWordlists,
    renameCustomWordlist,
    WordlistsApiError,
    type CustomWordlist,
    type CustomWordlistItem,
} from '../lib/wordlists';
import { WORDLIST_MAX_LISTS } from '../lib/wordlistParse';
import { fetchSeenCounts } from '../lib/vocabSeen';
import { normalizeMasteryWord, readGuestMastered, writeGuestMastered } from '../lib/wordMastery';
import { selectMastered, selectMyWords } from '../lib/myWords';
import { describeApiError, toast } from '../lib/toast';
import { speak } from '../lib/tts';
import { useSpeechAvailability } from '../lib/useSpeechAvailability';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import { VocabPagination } from './VocabPagination';
import { WordlistImportDialog } from './WordlistImportDialog';
import {
    WordbookToolbar,
    WordTable,
    normalizePhonetic,
    type FilterGroup,
    type FilterOption,
    type SortOption,
    type WordRowAction,
    type WordTableRow,
} from './VocabularyRows';
import { Badge } from './ui/Badge';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Dialog } from './ui/Dialog';
import { Menu } from './ui/Menu';
import { SubHeader } from './ui/SubHeader';
import { Tabs, tabPanelProps, type TabItem } from './ui/Tabs';
import { Button } from './ui/Button';
import { ErrorPanel, LoadingState } from './ui/StateView';
import type { TranslationKey } from '../i18n';

interface VocabularyBookScreenProps {
    /** Every favorite; the screen keeps only `type === 'vocabulary'`. */
    favorites: FavoriteItem[];
    /** Back to the previous view (profile tab for a deep link). */
    onBack: () => void;
    /** Parent screen name for the back control's aria label. */
    parentLabel?: string;
    /**
     * Remove one favorite and keep both layers honest. App owns the optimistic
     * prop path; favorites this screen added itself are deleted locally.
     * Resolves `true` only when the favorite is really gone (App returns the
     * server outcome for prop-owned rows), so callers can roll back a paired
     * write (e.g. the mastered mark).
     */
    onRemoveFavorite: (id: string) => void | Promise<boolean>;
    onPlayFavorite: (videoId: string, start: number) => void;
    onOpenArticle: (articleId: string) => void;
    onOpenLibraryArticle: (articleId: string) => void;
    onOpenSentencePack: (levelId: number) => void;
    onOpenBook: (bookId: string) => void;
    onOpenImportedBook: (bookId: string) => void;
    /** Guest gate for review actions (opens the login overlay, never a 403). */
    onRequestLogin?: () => void;
    /**
     * Optional observer for callers that mirror mastery writes. The saved-word
     * count no longer depends on it (ADR-0001: it is the favorites list length).
     */
    onMasteredChange?: (lemma: string, mastered: boolean) => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';
type MineSort = 'added' | 'seen' | 'level' | 'alpha';
type MasteredSort = 'alpha' | 'level';
type CustomSort = 'alpha' | 'level';
type MineType = '' | 'word' | 'phrase';
type MineLevel = '' | CefrLevel | 'C1+';
type SeenPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Review-state read: `unavailable` hides the 已在复习 row state (403/404), never an error. */
type StateFilterPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Row-level add state for the built-in lists / phrases (idempotent writes). */
type RowAddState = 'idle' | 'busy' | 'added';
/** Custom-list catalog: `unavailable` = 403/404 → hide the surface, no error. */
type CustomListsPhase = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

const MINE_TAB = 'mine';
/** 已掌握 is a word list of its own, not a segment inside 我的单词 (specs/005). */
const MASTERED_TAB = 'mastered';
const PHRASES_TAB = 'phrases';
/** Merged CEFR list id (`GET /api/vocabulary/lists/cefr`); A1–C1 in one tab. */
const CEFR_TAB = 'cefr';
/** Product order: 我的单词 / 已掌握 / 短语 / CEFR 词表 / GRE / CET4 / CET6. */
const LIST_TAB_IDS = [CEFR_TAB, 'gre', 'cet4', 'cet6'] as const;
/** Custom lists are appended after every built-in tab (specs/038 §1). */
const CUSTOM_TAB_PREFIX = 'custom:';
const customTabId = (listId: string) => `${CUSTOM_TAB_PREFIX}${listId}`;
const customListId = (tabId: string): string | null => (
    tabId.startsWith(CUSTOM_TAB_PREFIX) ? tabId.slice(CUSTOM_TAB_PREFIX.length) : null
);
/** Stable selection key for one custom-list row (server id when available). */
const customItemKey = (item: CustomWordlistItem): string => (
    item.id ?? `word:${item.word}`
);
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
    wordlist: Library,
};

const SOURCE_LABEL_KEYS: Record<FavoriteSourceKind, TranslationKey> = {
    video: 'vocab.source.video',
    local_show: 'vocab.source.local_show',
    article: 'vocab.source.article',
    library_article: 'vocab.source.library_article',
    sentence_pack: 'vocab.source.sentence_pack',
    book: 'vocab.source.book',
    imported_book: 'vocab.source.imported_book',
    wordlist: 'vocab.source.wordlist',
};

/** Stable chip order for the source filter (product order, not data order). */
const SOURCE_KIND_ORDER: readonly FavoriteSourceKind[] = [
    'video',
    'local_show',
    'article',
    'library_article',
    'sentence_pack',
    'book',
    'imported_book',
    'wordlist',
];

/** Words outside the merged CEFR list render C1+ (specs/005), so they sort last. */
const OFF_LIST_RANK = VOCABULARY_CEFR_LEVELS.length;
function levelSortRank(word: string, levels: Record<string, string | null>): number {
    if (!(word in levels)) return Number.POSITIVE_INFINITY; // still loading / failed
    const level = levels[word];
    if (!level) return OFF_LIST_RANK; // C1+
    const index = (VOCABULARY_CEFR_LEVELS as readonly string[]).indexOf(level);
    return index >= 0 ? index : OFF_LIST_RANK;
}

const ACTION_BUTTON =
    'inline-flex items-center justify-center gap-1.5 h-control-sm rounded-control border border-line-subtle bg-surface-2/60 px-2.5 text-caption font-medium text-fg-strong transition-colors hover:bg-surface-3/60 hover:text-fg-primary disabled:pointer-events-none disabled:opacity-40';
const LIST_CARD = 'rounded-card border border-line-subtle bg-surface-2/30';

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
    onRequestLogin,
    onMasteredChange,
}: VocabularyBookScreenProps) {
    const { t, formatDate, formatNumber, targetLang } = useI18n();
    const { status } = useAuth();
    const isGuest = status === 'guest';
    /** `missing` = no speech engine / no English voice → 朗读 buttons disabled. */
    const speechAvailability = useSpeechAvailability();
    const speechDisabled = speechAvailability === 'missing';

    // ── v1.2: favorites written from inside the word book ─────────────────
    // App owns the favorites list, but the word book is the only place that
    // writes a favorite *without* going through an App callback (加入我的单词).
    // These two local overlays keep this screen consistent with its own writes:
    // `addedFavorites` are favorites this screen created, `deletedIds` are ones
    // it deleted. Both are merged (and de-duplicated by id) with the prop, so
    // the screen never shows a word it just added as "missing" and never
    // resurrects a row it just deleted. App's own copy catches up on its next
    // fetch (login / data revision); the word book never mutates the prop.
    const [addedFavorites, setAddedFavorites] = useState<FavoriteItem[]>([]);
    const [deletedFavoriteIds, setDeletedFavoriteIds] = useState<Set<string>>(() => new Set());
    const allFavorites = useMemo(() => {
        const propIds = new Set(favorites.map((fav) => fav.id));
        const extras = addedFavorites.filter((fav) => !propIds.has(fav.id));
        const merged = [...favorites, ...extras];
        return deletedFavoriteIds.size === 0
            ? merged
            : merged.filter((fav) => !deletedFavoriteIds.has(fav.id));
    }, [favorites, addedFavorites, deletedFavoriteIds]);

    // 我的单词 = every vocabulary favorite, newest first (ADR-0001). The count
    // and the export consume this exact list; no mastery subtraction/filter.
    const myWords = useMemo(
        () => selectMyWords(allFavorites)
            .sort((a, b) => (b.added_at || 0) - (a.added_at || 0)),
        [allFavorites],
    );

    // ── Catalog + active tab ──────────────────────────────────────────────
    const [catalog, setCatalog] = useState<VocabularyList[]>([]);
    const [catalogPhase, setCatalogPhase] = useState<Phase>('loading');
    const [catalogError, setCatalogError] = useState('');
    const [catalogNonce, setCatalogNonce] = useState(0);
    const [activeTab, setActiveTab] = useState<string>(MINE_TAB);

    // v1.3 custom word lists (specs/038): signed-in only, appended after the
    // built-in tabs. A 403/404 means "this surface is not available" (no tabs,
    // no banner); any other failure keeps the built-in lists usable and shows
    // one inline, retryable warning above the tab strip (G3 / IX-01).
    const [customLists, setCustomLists] = useState<CustomWordlist[]>([]);
    const [customListsPhase, setCustomListsPhase] = useState<CustomListsPhase>('idle');
    const [customListsError, setCustomListsError] = useState('');
    const [customListsNonce, setCustomListsNonce] = useState(0);
    const [importOpen, setImportOpen] = useState(false);

    useEffect(() => {
        if (isGuest) {
            setCustomLists([]);
            setCustomListsPhase('idle');
            setCustomListsError('');
            return;
        }
        let cancelled = false;
        setCustomListsPhase('loading');
        setCustomListsError('');
        fetchCustomWordlists()
            .then((lists) => {
                if (cancelled) return;
                setCustomLists(lists);
                setCustomListsPhase('ready');
            })
            .catch(async (error) => {
                if (cancelled) return;
                if (error instanceof WordlistsApiError && (error.status === 403 || error.status === 404)) {
                    setCustomLists([]);
                    setCustomListsPhase('unavailable');
                    return;
                }
                setCustomListsError(await describeApiError(error));
                setCustomListsPhase('error');
            });
        return () => { cancelled = true; };
    }, [isGuest, customListsNonce]);

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
    const activeIsMastered = activeTab === MASTERED_TAB;
    const activeIsCefr = activeTab === CEFR_TAB;
    const activeCustomListId = customListId(activeTab);
    const activeCustomList = activeCustomListId
        ? customLists.find((entry) => entry.id === activeCustomListId) ?? null
        : null;
    const activeIsCustom = activeCustomList != null;
    const activeList = activeIsMine || activeIsMastered || activeIsCustom
        ? null
        : catalogById.get(activeTab) ?? null;
    const activeUnavailable = activeList?.available === false;

    // If the active custom list disappears (deleted in another tab and the
    // catalog refreshed), fall back to 我的单词 instead of fetching a dead id.
    useEffect(() => {
        if (!activeCustomListId) return;
        if (customListsPhase !== 'ready' && customListsPhase !== 'unavailable') return;
        if (customLists.some((entry) => entry.id === activeCustomListId)) return;
        setActiveTab(MINE_TAB);
        setCustomQuery('');
        setCustomPage(1);
        setCustomRevealed(new Set());
        setCustomLoadPhase('idle');
        setCustomItems([]);
    }, [activeCustomListId, customLists, customListsPhase]);

    // ── My words: expand + batched CEFR lookup ────────────────────────────
    const [expanded, setExpanded] = useState<Record<string, boolean>>({});
    const [levels, setLevels] = useState<Record<string, string | null>>({});
    const [levelPhase, setLevelPhase] = useState<Phase>('idle');
    const [levelError, setLevelError] = useState('');
    const [levelNonce, setLevelNonce] = useState(0);

    // ── v1.1 word book: 我的单词 / 已掌握, sorting, filters, seen counts ────
    // Mastered marks have exactly one source of truth per account type:
    //   * guest — the local 「我会了」 table (wordMastery.ts, never uploaded);
    //   * signed-in — `GET /api/review/words?mastered=1`, fetched when 我的单词
    //     or 已掌握 opens and then updated locally from each PATCH response (no
    //     localStorage mirror for signed-in users).
    const [pageSize, setPageSize] = useState<number>(50);
    const [mineSort, setMineSort] = useState<MineSort>('added');
    const [mineType, setMineType] = useState<MineType>('');
    const [mineSource, setMineSource] = useState<'' | FavoriteSourceKind>('');
    const [mineLevel, setMineLevel] = useState<MineLevel>('');
    const [guestMastered, setGuestMastered] = useState<Set<string>>(() => readGuestMastered());
    const [serverMastered, setServerMastered] = useState<Set<string>>(() => new Set());
    // Display casing for mastered words that have no favorite record: the review
    // API returns the lemma, and the local table stores the normalized form.
    const [masteredLabels, setMasteredLabels] = useState<Record<string, string>>({});
    // Meaning snapshots for 已掌握 rows. Source order (specs/005 §已掌握与收藏
    // 互斥): `word_states.definition` from the GET, else the meaning captured
    // when the row was marked (this session), else `—`. A removed favorite never
    // feeds this map — 已掌握 is not a favorite.
    const [masteredSnapshots, setMasteredSnapshots] = useState<Record<string, {
        word: string;
        phonetic: string;
        translation: string;
    }>>({});
    const [masteredPhase, setMasteredPhase] = useState<Phase>('idle');
    // True once the signed-in list has loaded at least once; keeps stale rows
    // visible while a retry is in flight (and lets a failed retry stay inline).
    const [masteredReady, setMasteredReady] = useState(false);
    const [masteredNonce, setMasteredNonce] = useState(0);
    // 已掌握 is client paged: the API caps the list at 200 and has no offset
    // paging, so pages are a view concern only.
    const [masteredPage, setMasteredPage] = useState(1);
    const [masteredQuery, setMasteredQuery] = useState('');
    const [masteredLevel, setMasteredLevel] = useState<MineLevel>('');
    const [masteredSort, setMasteredSort] = useState<MasteredSort>('alpha');
    // hide-Chinese reveal is per row; reset whenever the switch flips.
    const [masteredRevealed, setMasteredRevealed] = useState<Set<string>>(() => new Set());
    const [reviewedWords, setReviewedWords] = useState<Set<string>>(() => new Set());
    const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
    const [pendingMasteredId, setPendingMasteredId] = useState<string | null>(null);
    // Row-level write failure: inline + retryable (IX-02 / specs/013 §v1.1),
    // never a success-looking state and never a page-level error. Keyed by
    // favorite id, or `mastered:<normalized word>` for a mastered row.
    const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
    const [seenCounts, setSeenCounts] = useState<Record<string, number>>({});
    const [seenPhase, setSeenPhase] = useState<SeenPhase>('idle');
    /** Star writes in flight, keyed by normalized word (optimistic + rollback). */
    const [favoriteBusyKeys, setFavoriteBusyKeys] = useState<Set<string>>(() => new Set());

    // ── v1.2: search / row adds ────────────────────────────────────────────
    // 状态 reads still power the (hidden) 已在复习 row state; while the review
    // UI is paused no request is made and the row action stays hidden.
    const [wordStates, setWordStates] = useState<Record<string, ReviewWordState>>({});
    const [statePhase, setStatePhase] = useState<StateFilterPhase>('idle');
    const [mineQuery, setMineQuery] = useState('');
    const [mineDebouncedQuery, setMineDebouncedQuery] = useState('');
    const [minePage, setMinePage] = useState(1);
    // Row-level 加入我的单词 requests in flight, keyed by the normalized word.
    // This is a request state only: there is deliberately NO result mirror.
    // Whether a row may render the action (and whether its star is filled) is
    // derived from `favoritedWordKeys`, the canonical favorite set — a local
    // "added" copy would drift from it after a star delete (ADR-0001).
    const [mineAddBusyKeys, setMineAddBusyKeys] = useState<Set<string>>(() => new Set());
    /** Synchronous in-flight guard: two clicks in one tick must POST once. */
    const mineAddInFlight = useRef<Set<string>>(new Set());
    const [reviewAdds, setReviewAdds] = useState<Record<string, RowAddState>>({});
    /** Custom-list 标为已掌握 rows (idempotent PATCH, same busy/added shape). */
    const [masterAdds, setMasterAdds] = useState<Record<string, RowAddState>>({});
    const [listRowErrors, setListRowErrors] = useState<Record<string, string>>({});

    // ── Custom word lists: full load + edit mode (specs/005 §统一词表 UI) ──
    // 自定义词表 is client paged like 我的单词 / 已掌握: one bounded fetch
    // (≤200/page, ≤5000 words) feeds client search, sort, filters and paging.
    const [customItems, setCustomItems] = useState<CustomWordlistItem[]>([]);
    const [customLoadPhase, setCustomLoadPhase] = useState<Phase>('idle');
    const [customLoadError, setCustomLoadError] = useState('');
    const [customSort, setCustomSort] = useState<CustomSort>('alpha');
    const [customLevel, setCustomLevel] = useState<MineLevel>('');
    const [customUnmasteredOnly, setCustomUnmasteredOnly] = useState(false);
    const [customEditMode, setCustomEditMode] = useState(false);
    const [customEditSelected, setCustomEditSelected] = useState<Set<string>>(() => new Set());
    const [customEditBusy, setCustomEditBusy] = useState(false);
    const [customEditSummary, setCustomEditSummary] = useState<string | null>(null);
    const [customItemsDeleteOpen, setCustomItemsDeleteOpen] = useState(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameName, setRenameName] = useState('');
    const [renameBusy, setRenameBusy] = useState(false);
    const [renameError, setRenameError] = useState('');

    const masteredWords = isGuest ? guestMastered : serverMastered;

    // Guest marks come from the local table; re-read on an account switch so a
    // guest claim never mixes the two sources.
    useEffect(() => {
        if (!isGuest) return;
        setGuestMastered(readGuestMastered());
    }, [isGuest]);

    // Signed-in 已掌握 list: fetch the server list when 我的单词 or 已掌握 opens
    // (and on retry). Actions afterwards update `serverMastered` from the PATCH
    // response instead of refetching — one authoritative source, no reload.
    useEffect(() => {
        if ((!activeIsMine && !activeIsMastered) || isGuest) {
            setMasteredPhase('idle');
            return;
        }
        let cancelled = false;
        setMasteredPhase('loading');
        getMasteredWords(200, targetLang)
            .then((data) => {
                if (cancelled) return;
                setServerMastered(new Set(data.words.map((word) => normalizeMasteryWord(word.lemma))));
                setMasteredLabels(Object.fromEntries(
                    data.words.map((word) => [normalizeMasteryWord(word.lemma), word.lemma.trim()]),
                ));
                // `word_states.definition` is the authoritative meaning snapshot;
                // keep a session-local snapshot when the server has none yet.
                setMasteredSnapshots((prev) => {
                    const next = { ...prev };
                    for (const word of data.words) {
                        const key = normalizeMasteryWord(word.lemma);
                        const definition = typeof word.definition === 'string'
                            ? word.definition.trim()
                            : '';
                        if (!definition) continue;
                        const split = splitIpaAndMeaning(definition);
                        next[key] = {
                            word: word.lemma.trim(),
                            // A definition-only snapshot has no IPA; keep the
                            // mark-time IPA instead of erasing it.
                            phonetic: split.ipa || next[key]?.phonetic || '',
                            translation: split.meaning,
                        };
                    }
                    return next;
                });
                setMasteredReady(true);
                setMasteredPhase('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setMasteredPhase('error');
            });
        return () => { cancelled = true; };
    }, [activeIsMine, activeIsMastered, isGuest, targetLang, masteredNonce]);

    // 已在复习 row state (specs/005): one read of the signed-in review deck,
    // reduced to `normalized lemma → state`, used only by the (flag-hidden)
    // review row action. Guests never call it; a 403 (no account) / 404
    // (endpoint not deployed) / any other failure sets the phase to
    // `unavailable`, which hides that state instead of reporting an error.
    useEffect(() => {
        // The review state is a review concept: while the review UI is paused
        // (specs/013 2026-11-22) there is no read to make — skip it and keep
        // the rest of the word book untouched.
        if (!REVIEW_UI_ENABLED || isGuest) {
            setWordStates({});
            setStatePhase('unavailable');
            return;
        }
        let cancelled = false;
        setStatePhase('loading');
        listReviewWords({ states: REVIEW_WORD_STATES, limit: 200, targetLang })
            .then((data) => {
                if (cancelled) return;
                const next: Record<string, ReviewWordState> = {};
                for (const word of data.words) {
                    const key = normalizeMasteryWord(word.lemma);
                    if (key) next[key] = word.state;
                }
                setWordStates(next);
                setStatePhase('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setWordStates({});
                setStatePhase('unavailable');
            });
        return () => { cancelled = true; };
    }, [isGuest, targetLang]);

    /** The 已在复习 row state is only trusted when the endpoint answered. */
    const stateFilterAvailable = REVIEW_UI_ENABLED && !isGuest && statePhase === 'ready';

    const myWordLemmas = useMemo(
        () => Array.from(new Set(myWords.map((fav) => fav.en_text.trim()).filter(Boolean))),
        [myWords],
    );
    // Serialized so the effect only re-runs when the word set itself changes.
    const seenWordKey = myWordLemmas.join('\u0000');

    // Seen counts only enhance sorting/one column: a missing endpoint (403/404
    // during the parallel backend build) must not block the list or show an
    // error. Guests never call it (显示「—」, specs/005 §v1.1).
    useEffect(() => {
        if (!activeIsMine || isGuest || myWordLemmas.length === 0) {
            setSeenPhase('idle');
            return;
        }
        let cancelled = false;
        setSeenPhase('loading');
        fetchSeenCounts(myWordLemmas)
            .then((counts) => {
                if (cancelled) return;
                setSeenCounts(counts);
                setSeenPhase('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setSeenCounts({});
                setSeenPhase('unavailable');
            });
        return () => { cancelled = true; };
        // `seenWordKey` captures myWordLemmas; mastery is not part of the request.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [activeIsMine, isGuest, seenWordKey]);

    // 我的单词 count is the favorites list length (ADR-0001) — no mastered
    // subtraction. 已掌握 is the independent server list; its count is that
    // list's length too (guest: the local 我会了 table).
    const masteredCount = useMemo(() => selectMastered(masteredWords).length, [masteredWords]);
    const masteredTabLabel = isGuest ? t('vocab.review.guestMaster') : t('vocab.mine.mastered');
    // Hide the counts until the signed-in list has loaded: a failed GET must
    // not render "已掌握 0" as if that were the answer (G3).
    const masteredKnown = isGuest || masteredReady;

    /** Single local write path for the mastered mark (guest table or server set). */
    const writeMasteredState = (lemma: string, mastered: boolean) => {
        const key = normalizeMasteryWord(lemma);
        if (mastered) {
            const label = lemma.trim();
            setMasteredLabels((prev) => (prev[key] === label ? prev : { ...prev, [key]: label }));
        }
        if (isGuest) {
            writeGuestMastered(lemma, mastered);
            setGuestMastered((prev) => {
                const next = new Set(prev);
                if (mastered) next.add(key);
                else next.delete(key);
                return next;
            });
            return;
        }
        setServerMastered((prev) => {
            const next = new Set(prev);
            if (mastered) next.add(key);
            else next.delete(key);
            return next;
        });
    };

    /**
     * Remember the meaning captured at mark time. This is a session overlay for
     * 已掌握 rows whose server `definition` snapshot is still null (PATCH does
     * not take a definition; the GET snapshot wins whenever it exists).
     */
    const rememberMasteredSnapshot = (input: {
        lemma: string;
        word: string;
        phonetic?: string | null;
        translation?: string | null;
    }) => {
        const key = normalizeMasteryWord(input.lemma);
        if (!key) return;
        const word = input.word.trim() || input.lemma.trim();
        const phonetic = (input.phonetic ?? '').trim();
        const translation = (input.translation ?? '').trim();
        if (!word && !translation) return;
        setMasteredSnapshots((prev) => {
            const existing = prev[key];
            if (existing
                && existing.word === word
                && existing.phonetic === phonetic
                && existing.translation === translation) {
                return prev;
            }
            // Never erase a known meaning with an empty one.
            if (!translation && existing?.translation) return prev;
            return { ...prev, [key]: { word, phonetic, translation } };
        });
    };

    const mineSourceKinds = useMemo(() => {
        const present = new Set(myWords.map((fav) => resolveFavoriteSource(fav).kind));
        return SOURCE_KIND_ORDER.filter((kind) => present.has(kind));
    }, [myWords]);

    const hasMineFilters = Boolean(mineType || mineSource || mineLevel || mineDebouncedQuery);

    /** Client level filter: unknown words are only kept by 「全部」. */
    const matchesLevel = useCallback((word: string, target: MineLevel): boolean => {
        if (!target) return true;
        if (!(word in levels)) return false;
        const level = levels[word];
        return target === 'C1+' ? level === null : level === target;
    }, [levels]);

    /** Normalized words that already have a vocabulary favorite (加入 → 已加入). */
    const favoritedWordKeys = useMemo(
        () => new Set(myWords.map((fav) => normalizeMasteryWord(fav.en_text)).filter(Boolean)),
        [myWords],
    );

    /** Shared accessible names for the unified row controls. */
    const favoriteLabelFor = useCallback((word: string): string => (
        favoritedWordKeys.has(normalizeMasteryWord(word))
            ? t('vocab.star.remove', { word })
            : t('vocab.star.add', { word })
    ), [favoritedWordKeys, t]);

    /** Newest favorite per normalized word: the mastered row's IPA/meaning. */
    const favoriteByWord = useMemo(() => {
        const map = new Map<string, FavoriteItem>();
        // `myWords` is newest-first, so the first hit is the latest record.
        for (const fav of myWords) {
            const key = normalizeMasteryWord(fav.en_text);
            if (key && !map.has(key)) map.set(key, fav);
        }
        return map;
    }, [myWords]);

    /**
     * 已掌握 rows: `word_states.mastered=1` is the only source. The row meaning
     * is the `definition` snapshot first (`/api/review/words` + the mark-time
     * session overlay), then a legacy favorite's meaning, then `—`. The star is
     * never filled here: 已掌握 is not a favorite.
     */
    const masteredRows = useMemo(() => {
        const rows: Array<{ key: string; word: string; phonetic: string; translation: string }> = [];
        for (const key of masteredWords) {
            const snapshot = masteredSnapshots[key];
            // Legacy rows may still have a favorite record (marks made before
            // the mutual-exclusion rule); it is only a meaning fallback, never
            // a 已收藏 state.
            const legacyFavorite = favoriteByWord.get(key);
            const legacy = legacyFavorite
                ? splitIpaAndMeaning(legacyFavorite.zh_text)
                : null;
            const word = (snapshot?.word
                || legacyFavorite?.en_text
                || masteredLabels[key]
                || key).trim();
            if (!word) continue;
            rows.push({
                key,
                word,
                phonetic: snapshot?.phonetic || legacy?.ipa || '',
                translation: snapshot?.translation || legacy?.meaning || '',
            });
        }
        rows.sort((a, b) => (
            a.word.toLowerCase().localeCompare(b.word.toLowerCase()) || a.word.localeCompare(b.word)
        ));
        return rows;
    }, [masteredWords, favoriteByWord, masteredLabels, masteredSnapshots]);

    // The CEFR lookup covers only the rows the active tab shows; levels already
    // fetched are cached in `levels` and never re-requested.
    const levelWords = useMemo(() => {
        const words = activeIsMastered
            ? masteredRows.map((row) => row.word)
            : myWordLemmas;
        return Array.from(new Set(words.filter(Boolean)));
    }, [activeIsMastered, masteredRows, myWordLemmas]);

    const mineRows = useMemo(() => {
        // 类型 filter (词/短语): favorites only store vocabulary rows, so a
        // multi-word entry is the phrase surface. Single-word rows stay 单词.
        const isPhrase = (fav: FavoriteItem) => /\s/.test(fav.en_text.trim());
        const needle = mineDebouncedQuery.toLowerCase();
        const filtered = myWords.filter((fav) => {
            if (mineType === 'word' && isPhrase(fav)) return false;
            if (mineType === 'phrase' && !isPhrase(fav)) return false;
            if (mineSource && resolveFavoriteSource(fav).kind !== mineSource) return false;
            if (!matchesLevel(fav.en_text.trim(), mineLevel)) return false;
            // 搜索 covers the word and the saved translation (IPA included).
            if (needle) {
                const haystack = `${fav.en_text}\n${fav.zh_text || ''}`.toLowerCase();
                if (!haystack.includes(needle)) return false;
            }
            return true;
        });
        const seenOf = (fav: FavoriteItem) => seenCounts[fav.en_text.trim()] ?? -1;
        return [...filtered].sort((a, b) => {
            if (mineSort === 'alpha') {
                const aWord = a.en_text.trim().toLowerCase();
                const bWord = b.en_text.trim().toLowerCase();
                const byWord = aWord.localeCompare(bWord, 'en');
                if (byWord !== 0) return byWord;
            } else if (mineSort === 'seen') {
                const bySeen = seenOf(b) - seenOf(a);
                if (bySeen !== 0) return bySeen;
            } else if (mineSort === 'level') {
                const byLevel = levelSortRank(a.en_text.trim(), levels)
                    - levelSortRank(b.en_text.trim(), levels);
                if (byLevel !== 0) return byLevel;
            }
            // Default: newest added first (and the stable tiebreak for every sort).
            return (b.added_at || 0) - (a.added_at || 0);
        });
    }, [
        myWords, mineType, mineSource, mineLevel, mineSort, seenCounts, levels,
        mineDebouncedQuery, matchesLevel,
    ]);

    // 我的单词 is client paged 50/page (a collection can pass a hundred favorites
    // and the favorites API has no offset paging) — same page strip as the lists.
    const minePages = Math.max(1, Math.ceil(mineRows.length / pageSize));
    const currentMinePage = Math.min(Math.max(1, minePage), minePages);
    const minePageRows = useMemo(() => {
        const start = (currentMinePage - 1) * pageSize;
        return mineRows.slice(start, start + pageSize);
    }, [mineRows, currentMinePage, pageSize]);

    const seenTitle = isGuest
        ? t('vocab.mine.seen.guest')
        : seenPhase === 'unavailable'
            ? t('vocab.mine.seen.unavailable')
            : seenPhase === 'loading'
                ? t('vocab.mine.seen.loading')
                : undefined;
    const seenText = (fav: FavoriteItem): string => {
        if (isGuest || seenPhase !== 'ready') return '';
        const count = seenCounts[fav.en_text.trim()];
        return typeof count === 'number' ? `×${formatNumber(count)}` : '';
    };

    const openLogin = () => {
        if (onRequestLogin) onRequestLogin();
        else toast.info(t('guest.loginToSave'));
    };

    /** Favorite provenance → the review API's `{contentRef, sentenceId}` shape. */
    const reviewSourceFor = (fav: FavoriteItem) => {
        const source = resolveFavoriteSource(fav);
        return {
            contentRef: source.ref || fav.videoId || undefined,
            sentenceId: String(fav.start ?? 0),
        };
    };

    // 200ms debounce for 我的单词 search (specs/005 §v1.2); the committed query
    // is what filters, so typing never re-sorts the list on every keystroke.
    useEffect(() => {
        const trimmed = mineQuery.trim();
        const timer = window.setTimeout(() => setMineDebouncedQuery(trimmed), 200);
        return () => window.clearTimeout(timer);
    }, [mineQuery]);

    // A new filter/search/sort always restarts at page 1 (a phantom page 3 of a
    // 1-page result set must never be shown).
    useEffect(() => {
        setMinePage(1);
    }, [mineDebouncedQuery, mineType, mineSource, mineLevel, mineSort, pageSize]);

    const speakRow = useCallback((text: string) => {
        const value = text.trim();
        if (value) speak(value);
    }, []);

    const speakLabelFor = useCallback((word: string): string => (
        speechDisabled ? t('vocab.speak.unavailable') : t('vocab.speak.word', { word })
    ), [speechDisabled, t]);

    const expandLabelFor = useCallback((expanded: boolean): string => (
        expanded ? t('common.collapse') : t('common.expand')
    ), [t]);

    const levelBadgeFor = useCallback((word: string): { label: string; title?: string } => {
        if (!(word in levels)) return { label: '—' };
        const level = levels[word];
        if (!level) return { label: 'C1+', title: t('vocab.level.beyond') };
        return { label: level, title: `CEFR ${level}` };
    }, [levels, t]);

    /** Level filter options; CEFR bands + C1+ for favorite/mastered surfaces. */
    const levelFilterOptions = useCallback((
        current: MineLevel,
        testIdPrefix: string,
        counts?: Record<string, number>,
    ): FilterOption[] => ([
        {
            value: '',
            label: t('vocab.filter.all'),
            checked: current === '',
            testId: `${testIdPrefix}-all`,
        },
        ...VOCABULARY_CEFR_LEVELS.map((level) => ({
            value: level,
            label: counts && typeof counts[level] === 'number'
                ? t('vocab.cefr.levelCount', { level, count: formatNumber(counts[level]) })
                : level,
            checked: current === level,
            testId: `${testIdPrefix}-${level}`,
        })),
        {
            value: 'C1+',
            label: 'C1+',
            checked: current === 'C1+',
            testId: `${testIdPrefix}-c1plus`,
        },
    ]), [formatNumber, t]);

    /** Global hide-Chinese switch, one recipe for every list toolbar. */
    const hideChineseToggle = (scope: string) => (
        <button
            type="button"
            data-testid="vocab-hide-toggle"
            data-scope={scope}
            aria-pressed={hideChinese}
            onClick={toggleHideChinese}
            title={hideChinese ? t('vocab.show') : t('vocab.hide')}
            className={`inline-flex h-control-md shrink-0 items-center justify-center gap-1.5 rounded-control border px-2.5 text-caption font-medium transition-colors ${
                hideChinese
                    ? 'border-brand/20 bg-brand/10 text-brand-300 hover:bg-brand/15'
                    : 'border-line-subtle bg-surface-2/60 text-fg-strong hover:bg-surface-3/60 hover:text-fg-primary'
            }`}
        >
            {hideChinese
                ? <Eye className="h-4 w-4" aria-hidden="true" />
                : <EyeOff className="h-4 w-4" aria-hidden="true" />}
            {hideChinese ? t('vocab.show') : t('vocab.hide')}
        </button>
    );

    // ── 加入我的单词 / 加入复习 (built-in lists + phrases) ──────────────────
    // Both writes are idempotent server-side; the row only ever shows a row
    // error after the request failed (inline, retryable, IX-02). Success is not
    // mirrored locally: the canonical favorite set retires the action and fills
    // the star on the very next render.
    const addListWordToMine = async (input: {
        rowKey: string;
        word: string;
        translation: string;
        phonetic?: string | null;
        /** Dictionary example kept in the favorite snapshot (specs/038 §3.2). */
        example?: string | null;
        listId: string;
        listLabel: string;
    }) => {
        if (isGuest) {
            openLogin();
            return;
        }
        const word = input.word.trim();
        const wordKey = normalizeMasteryWord(word);
        if (!word || !wordKey) return;
        // Canonical idempotence: a word that is already a favorite has no
        // action at all, and the same word may be shown by several lists — the
        // synchronous ref keeps a second click from sending a second POST
        // before React can retire the button.
        if (favoritedWordKeys.has(wordKey) || mineAddInFlight.current.has(wordKey)) return;
        mineAddInFlight.current.add(wordKey);
        setMineAddBusyKeys((prev) => {
            if (prev.has(wordKey)) return prev;
            const next = new Set(prev);
            next.add(wordKey);
            return next;
        });
        setListRowErrors((prev) => {
            if (!(input.rowKey in prev)) return prev;
            const next = { ...prev };
            delete next[input.rowKey];
            return next;
        });
        const draft: FavoriteDraft = {
            id: `vocab-wordlist-${input.listId}-${word.replace(/\s+/g, '-')}`.slice(0, 300),
            type: 'vocabulary',
            videoId: input.listId,
            start: 0,
            en_text: word,
            zh_text: [input.phonetic?.trim(), input.translation.trim()].filter(Boolean).join(' '),
            added_at: Date.now(),
            ...(input.example?.trim() ? { example: input.example.trim() } : {}),
            source_kind: 'wordlist',
            source_ref: input.listId,
            source_title: input.listLabel,
        };
        try {
            const saved = await addFavorite(draft);
            // The server may answer with an existing row (same id): merge by id
            // so the word book never shows the same favorite twice.
            setAddedFavorites((prev) => (
                prev.some((fav) => fav.id === saved.id) ? prev : [...prev, saved]
            ));
            setDeletedFavoriteIds((prev) => {
                if (!prev.has(saved.id)) return prev;
                const next = new Set(prev);
                next.delete(saved.id);
                return next;
            });
            toast.success(t('vocab.toast.added'), { dedupeKey: 'favorites:added' });
        } catch {
            // No local success-looking state: the row keeps the action (retry)
            // and shows the failure inline.
            setListRowErrors((prev) => ({ ...prev, [input.rowKey]: t('vocab.list.addError') }));
        } finally {
            mineAddInFlight.current.delete(wordKey);
            setMineAddBusyKeys((prev) => {
                if (!prev.has(wordKey)) return prev;
                const next = new Set(prev);
                next.delete(wordKey);
                return next;
            });
        }
    };

    const addListWordToReview = async (input: {
        rowKey: string;
        word: string;
        listId: string;
        /** Word-list meaning snapshot; the review card shows it before /api/define. */
        definition?: string | null;
    }) => {
        if (reviewAdds[input.rowKey] === 'busy' || reviewAdds[input.rowKey] === 'added') return;
        if (isGuest) {
            openLogin();
            return;
        }
        const lemma = input.word.trim();
        if (!lemma) return;
        setReviewAdds((prev) => ({ ...prev, [input.rowKey]: 'busy' }));
        setListRowErrors((prev) => {
            if (!(input.rowKey in prev)) return prev;
            const next = { ...prev };
            delete next[input.rowKey];
            return next;
        });
        try {
            const result = await addWord({
                lemma,
                targetLang,
                ...(input.definition?.trim() ? { definition: input.definition.trim() } : {}),
                source: { contentRef: input.listId },
            });
            setReviewAdds((prev) => ({ ...prev, [input.rowKey]: 'added' }));
            setReviewedWords((prev) => new Set(prev).add(normalizeMasteryWord(lemma)));
            toast.success(
                result.created ? t('vocab.review.toast.added') : t('vocab.review.toast.already'),
                { dedupeKey: 'review:fav-added' },
            );
        } catch {
            setReviewAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
            setListRowErrors((prev) => ({ ...prev, [input.rowKey]: t('vocab.review.error.add') }));
        }
    };

    /** Where one row's 加入复习 control stands when it renders. */
    const rowReviewAddState = (rowKey: string, word: string): RowAddState => {
        const local = reviewAdds[rowKey];
        if (local) return local;
        // A word the deck already tracks (state read succeeded) is 已在复习 even
        // when it was added somewhere else.
        return stateFilterAvailable && wordStates[normalizeMasteryWord(word)] ? 'added' : 'idle';
    };

    /**
     * Shared action descriptors for the list/phrase rows. The favorite state is
     * read from `favoritedWordKeys` only: a favorited row renders NO 加入我的单词
     * action (there is nothing to disable or relabel, and no local result copy
     * to drift from the canonical set).
     */
    const rowAddActions = (input: {
        rowKey: string;
        word: string;
        translation: string;
        phonetic?: string | null;
        definition?: string | null;
        example?: string | null;
        listId: string;
        listLabel: string;
    }, options?: { includeReview?: boolean }): WordRowAction[] => {
        const wordKey = normalizeMasteryWord(input.word);
        const actions: WordRowAction[] = [];
        if (wordKey && !favoritedWordKeys.has(wordKey)) {
            const busy = mineAddBusyKeys.has(wordKey);
            actions.push({
                key: 'mine',
                label: `${t('vocab.list.addMine')} ${input.word}`,
                text: t('vocab.list.addMine'),
                icon: BookmarkPlus,
                testId: `${input.rowKey}-add-mine`,
                busy,
                disabled: busy,
                onClick: () => { void addListWordToMine(input); },
            });
        }
        // specs/038 (2026-11-22): the custom-list surface hides 加入复习 while
        // the review UI is paused; the interface + definition snapshot stay.
        // specs/005/013: the same pause hides it on the built-in lists/phrases.
        if (!(options?.includeReview ?? REVIEW_UI_ENABLED)) return actions;
        const reviewState = rowReviewAddState(input.rowKey, input.word);
        const reviewLabel = reviewState === 'added' ? t('vocab.review.added') : t('vocab.review.add');
        actions.push({
            key: 'review',
            label: `${reviewLabel} ${input.word}`,
            text: reviewLabel,
            icon: Repeat,
            testId: `${input.rowKey}-add-review`,
            busy: reviewState === 'busy',
            done: reviewState === 'added',
            disabled: reviewState === 'added',
            onClick: () => { void addListWordToReview({
                rowKey: input.rowKey,
                word: input.word,
                listId: input.listId,
                definition: input.definition,
            }); },
        });
        return actions;
    };

    /**
     * 标为已掌握 for a custom word-list row (specs/038 §1). Idempotent PATCH;
     * the row stays in the word list, it just flips its own action state. A
     * word that was also a favorite loses that favorite (mutual exclusion);
     * if the removal fails the mark is rolled back and an inline, retryable
     * error appears instead of a success-looking row.
     */
    const addListWordToMastered = async (input: {
        rowKey: string;
        word: string;
        /** Meaning snapshot captured for the 已掌握 tab (word-list translation). */
        translation?: string | null;
        phonetic?: string | null;
        listId: string;
    }) => {
        const key = normalizeMasteryWord(input.word);
        if (masterAdds[input.rowKey] === 'busy' || masteredWords.has(key)) return;
        if (isGuest) {
            openLogin();
            return;
        }
        const lemma = input.word.trim();
        if (!lemma) return;
        const favorite = favoriteByWord.get(key);
        const clearRowError = () => setListRowErrors((prev) => {
            if (!(input.rowKey in prev)) return prev;
            const next = { ...prev };
            delete next[input.rowKey];
            return next;
        });
        setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'busy' }));
        clearRowError();
        try {
            const result = await setWordMastered({
                lemma,
                mastered: true,
                targetLang,
                source: { contentRef: input.listId },
            });
            const masteredNow = result.word.mastered === true;
            writeMasteredState(lemma, masteredNow);
            onMasteredChange?.(lemma, masteredNow);
            if (masteredNow) {
                rememberMasteredSnapshot({
                    lemma,
                    word: input.word,
                    phonetic: input.phonetic,
                    translation: input.translation,
                });
                if (favorite) {
                    const removed = await deleteFavoriteById(favorite.id);
                    if (!removed) {
                        // Undo the mark so a word is never both mastered and
                        // saved. The message only claims a rollback if it
                        // actually succeeded.
                        let rolledBack = false;
                        try {
                            const rollback = await setWordMastered({
                                lemma,
                                mastered: false,
                                targetLang,
                                source: { contentRef: input.listId },
                            });
                            rolledBack = rollback.word.mastered === false;
                            writeMasteredState(lemma, !rolledBack);
                            onMasteredChange?.(lemma, !rolledBack);
                        } catch {
                            // Best effort; stay honest about the failed rollback.
                        }
                        setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
                        setListRowErrors((prev) => ({
                            ...prev,
                            [input.rowKey]: t(rolledBack
                                ? 'vocab.review.error.masteredFavorite'
                                : 'vocab.review.error.mastered'),
                        }));
                        return;
                    }
                }
            }
            setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'added' }));
            toast.success(t('vocab.custom.masterToast'), { dedupeKey: 'review:fav-mastered' });
        } catch {
            setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
            setListRowErrors((prev) => ({ ...prev, [input.rowKey]: t('vocab.custom.masterError') }));
        }
    };

    const handleAddFavoriteToReview = async (fav: FavoriteItem) => {
        if (pendingReviewId || pendingMasteredId) return;
        // Guest gate at the entry: never call the endpoint that would 403.
        if (isGuest) {
            openLogin();
            return;
        }
        const lemma = fav.en_text.trim();
        if (!lemma) return;
        const key = normalizeMasteryWord(lemma);
        setPendingReviewId(fav.id);
        setRowError(null);
        try {
            const result = await addWord({
                lemma,
                targetLang,
                source: reviewSourceFor(fav),
            });
            setReviewedWords((prev) => new Set(prev).add(key));
            // specs/013: adding an already-tracked word forces mastered=0, so a
            // mastered favorite returns to 我的单词 instead of staying hidden.
            if (masteredWords.has(key)) {
                writeMasteredState(lemma, false);
                onMasteredChange?.(lemma, false);
            }
            toast.success(
                result.created ? t('vocab.review.toast.added') : t('vocab.review.toast.already'),
                { dedupeKey: 'review:fav-added' },
            );
        } catch {
            // Inline, retryable: the same row button is the retry affordance.
            setRowError({ id: fav.id, message: t('vocab.review.error.add') });
        } finally {
            setPendingReviewId(null);
        }
    };

    const handleToggleFavoriteMastered = async (fav: FavoriteItem) => {
        if (pendingReviewId || pendingMasteredId) return;
        const lemma = fav.en_text.trim();
        if (!lemma) return;
        const key = normalizeMasteryWord(lemma);
        const next = !masteredWords.has(key);
        // Guests: local ignore table only (文案「我会了」), no upload.
        if (isGuest) {
            writeMasteredState(lemma, next);
            return;
        }
        setPendingMasteredId(fav.id);
        setRowError(null);
        const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
        try {
            const result = await setWordMastered({
                lemma,
                mastered: next,
                targetLang,
                source: reviewSourceFor(fav),
            });
            // The PATCH response is authoritative for the post-write mark.
            const masteredNow = result.word.mastered === true;
            writeMasteredState(lemma, masteredNow);
            onMasteredChange?.(lemma, masteredNow);
            if (next && masteredNow) {
                rememberMasteredSnapshot({
                    lemma,
                    word: lemma,
                    phonetic: ipa,
                    translation: meaning,
                });
                // specs/005 §已掌握与收藏互斥: marking mastered also removes the
                // favorite (DELETE /api/favorites/:id) so counts, export and
                // 我的单词 stop showing it. If the removal fails, undo the mark
                // rather than leave a word in both worlds.
                const removed = await deleteFavoriteById(fav.id);
                if (!removed) {
                    // Undo the mark so a word is never both mastered and saved.
                    // The message only claims a rollback if it actually succeeded.
                    let rolledBack = false;
                    try {
                        const rollback = await setWordMastered({
                            lemma,
                            mastered: false,
                            targetLang,
                            source: reviewSourceFor(fav),
                        });
                        rolledBack = rollback.word.mastered === false;
                        writeMasteredState(lemma, !rolledBack);
                        onMasteredChange?.(lemma, !rolledBack);
                    } catch {
                        // Best effort; stay honest about the failed rollback.
                    }
                    setRowError({
                        id: fav.id,
                        message: t(rolledBack
                            ? 'vocab.review.error.masteredFavorite'
                            : 'vocab.review.error.mastered'),
                    });
                    return;
                }
            }
            toast.success(
                next ? t('vocab.review.toast.mastered') : t('vocab.review.toast.unmastered'),
                { dedupeKey: 'review:fav-mastered' },
            );
        } catch {
            setRowError({ id: fav.id, message: t('vocab.review.error.mastered') });
        } finally {
            setPendingMasteredId(null);
        }
    };

    /**
     * 已掌握 row action: move a word back by clearing its mastered mark.
     * Optimistic (the row leaves the table now), rolled back with an inline
     * row error if the write fails — same feedback model as the mine rows.
     */
    const handleMasteredRowUndo = async (row: { key: string; word: string }) => {
        if (pendingReviewId || pendingMasteredId) return;
        const lemma = row.word.trim();
        if (!lemma) return;
        const fav = favoriteByWord.get(row.key);
        setRowError(null);
        writeMasteredState(lemma, false);
        // Guests only write the local table; there is nothing to PATCH.
        if (isGuest) {
            toast.success(t('vocab.review.toast.unmastered'), { dedupeKey: 'review:fav-mastered' });
            return;
        }
        setPendingMasteredId(`mastered:${row.key}`);
        try {
            const result = await setWordMastered({
                lemma,
                mastered: false,
                targetLang,
                ...(fav ? { source: reviewSourceFor(fav) } : {}),
            });
            // The PATCH response is authoritative for the post-write mark.
            writeMasteredState(lemma, result.word.mastered === true);
            onMasteredChange?.(lemma, result.word.mastered === true);
            toast.success(t('vocab.review.toast.unmastered'), { dedupeKey: 'review:fav-mastered' });
        } catch {
            writeMasteredState(lemma, true); // roll the row back into the table
            onMasteredChange?.(lemma, true);
            setRowError({ id: `mastered:${row.key}`, message: t('vocab.review.error.mastered') });
        } finally {
            setPendingMasteredId(null);
        }
    };

    /**
     * Delete one favorite and keep both layers honest. App owns the optimistic
     * prop path (it also performs the DELETE); favorites this screen added
     * itself are removed here. Resolves `true` only when the row is really gone
     * — exactly once, so the App handler never re-sends a deleted id.
     *
     * Only the 已掌握 write paths call this directly now (marking a word
     * mastered also removes its favorite, specs/005 §已掌握与收藏互斥);
     * cancelling a favorite is the row star, one entry per surface.
     */
    const deleteFavoriteById = async (id: string): Promise<boolean> => {
        if (favorites.some((fav) => fav.id === id)) {
            try {
                const removed = await onRemoveFavorite(id);
                return removed !== false;
            } catch {
                return false;
            }
        }
        try {
            await removeFavorite(id);
        } catch {
            return false;
        }
        setAddedFavorites((prev) => prev.filter((fav) => fav.id !== id));
        return true;
    };

    const markFavoriteBusy = (word: string, busy: boolean) => {
        const key = normalizeMasteryWord(word);
        setFavoriteBusyKeys((prev) => {
            const next = new Set(prev);
            if (busy) next.add(key);
            else next.delete(key);
            return next;
        });
    };

    /**
     * 取消收藏 from a row star. Favorites App already knows go through App's
     * optimistic handler (it rolls back + toasts); ones this screen added are
     * removed here with the same optimistic/rollback contract (IX-05).
     */
    const removeFavoriteForRow = (fav: FavoriteItem) => {
        const key = normalizeMasteryWord(fav.en_text);
        if (favoriteBusyKeys.has(key)) return;
        markFavoriteBusy(fav.en_text, true);
        if (favorites.some((entry) => entry.id === fav.id)) {
            onRemoveFavorite(fav.id);
            markFavoriteBusy(fav.en_text, false);
            return;
        }
        setAddedFavorites((prev) => prev.filter((entry) => entry.id !== fav.id));
        void removeFavorite(fav.id)
            .then(() => toast.success(t('vocab.toast.removed'), { dedupeKey: 'favorites:removed' }))
            .catch(async (error) => {
                setAddedFavorites((prev) => (
                    prev.some((entry) => entry.id === fav.id) ? prev : [...prev, fav]
                ));
                toast.error(await describeApiError(error));
            })
            .finally(() => markFavoriteBusy(fav.en_text, false));
    };

    /**
     * Favorite one row (词表 / 短语 / 已掌握 star) with an optimistic overlay:
     * the star fills immediately, a failed POST removes the overlay again and
     * reports the failure as a toast (G8 / IX-02).
     */
    const addFavoriteForRow = async (input: {
        word: string;
        phonetic?: string | null;
        translation?: string | null;
        example?: string | null;
        sourceKind?: FavoriteSourceKind;
        sourceRef?: string;
        sourceTitle?: string;
    }) => {
        if (isGuest) {
            openLogin();
            return;
        }
        const word = input.word.trim();
        if (!word) return;
        const key = normalizeMasteryWord(word);
        if (!key || favoritedWordKeys.has(key) || favoriteBusyKeys.has(key)) return;
        const draft: FavoriteDraft = {
            id: `vocab-fav-${key}`.slice(0, 300),
            type: 'vocabulary',
            videoId: input.sourceRef ?? '',
            start: 0,
            en_text: word,
            zh_text: [normalizePhonetic(input.phonetic), (input.translation ?? '').trim()]
                .filter(Boolean)
                .join(' '),
            added_at: Date.now(),
            ...(input.example?.trim() ? { example: input.example.trim() } : {}),
            ...(input.sourceKind ? { source_kind: input.sourceKind } : {}),
            ...(input.sourceRef ? { source_ref: input.sourceRef } : {}),
            ...(input.sourceTitle ? { source_title: input.sourceTitle } : {}),
        };
        const optimistic: FavoriteItem = { ...draft };
        setAddedFavorites((prev) => [...prev, optimistic]);
        markFavoriteBusy(word, true);
        try {
            const saved = await addFavorite(draft);
            setAddedFavorites((prev) => prev.map((entry) => (
                entry.id === optimistic.id ? saved : entry
            )));
            setDeletedFavoriteIds((prev) => {
                if (!prev.has(saved.id)) return prev;
                const next = new Set(prev);
                next.delete(saved.id);
                return next;
            });
            toast.success(t('vocab.toast.added'), { dedupeKey: 'favorites:added' });
        } catch (error) {
            setAddedFavorites((prev) => prev.filter((entry) => entry.id !== optimistic.id));
            toast.error(await describeApiError(error));
        } finally {
            markFavoriteBusy(word, false);
        }
    };

    /** Star toggle shared by every non-我的单词 surface. */
    const toggleRowFavorite = (input: {
        word: string;
        phonetic?: string | null;
        translation?: string | null;
        example?: string | null;
        sourceKind?: FavoriteSourceKind;
        sourceRef?: string;
        sourceTitle?: string;
    }) => {
        const key = normalizeMasteryWord(input.word);
        const existing = favoriteByWord.get(key);
        if (existing) {
            removeFavoriteForRow(existing);
            return;
        }
        void addFavoriteForRow(input);
    };

    // ── Custom word-list edit mode (勾选删除 + 重命名, specs/038 §5) ────────
    const resetCustomEdit = useCallback(() => {
        setCustomEditMode(false);
        setCustomEditSelected(new Set());
        setCustomEditSummary(null);
        setCustomEditBusy(false);
    }, []);

    const toggleCustomEdit = () => {
        setCustomEditSelected(new Set());
        setCustomEditSummary(null);
        setCustomEditMode((prev) => !prev);
    };

    const toggleCustomItem = (key: string, checked: boolean) => {
        setCustomEditSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(key);
            else next.delete(key);
            return next;
        });
        setCustomEditSummary(null);
    };

    const customEditItems = useMemo(
        () => customItems.filter((item) => customEditSelected.has(customItemKey(item))),
        [customItems, customEditSelected],
    );

    /**
     * 删除所选: one request for the selected item ids; nothing is removed
     * locally before the server confirms. A failure keeps the rows and the
     * selection, and leaves an inline summary + the dialog's own retry path.
     */
    const handleDeleteCustomItems = async () => {
        const list = activeCustomList;
        if (!list || customEditBusy) return;
        const selected = customEditItems;
        if (selected.length === 0) {
            throw new Error(t('vocab.edit.selectEmpty'));
        }
        const ids = selected
            .map((item) => item.id)
            .filter((id): id is string => Boolean(id));
        if (ids.length !== selected.length) {
            const message = t('vocab.edit.missingIds');
            setCustomEditSummary(message);
            throw new Error(message);
        }
        setCustomEditBusy(true);
        setCustomEditSummary(null);
        try {
            const result = await deleteCustomWordlistItems(list.id, ids);
            const idSet = new Set(ids);
            setCustomItems((prev) => prev.filter((item) => !idSet.has(item.id ?? '')));
            setCustomLists((prev) => prev.map((entry) => (
                entry.id === list.id
                    ? {
                        ...entry,
                        itemCount: result.itemCount > 0
                            ? result.itemCount
                            : Math.max(0, entry.itemCount - result.deleted),
                    }
                    : entry
            )));
            setCustomEditSelected(new Set());
            toast.success(t('vocab.edit.deleteDone', { count: formatNumber(result.deleted) }), {
                dedupeKey: 'wordlist:items',
            });
        } catch (error) {
            setCustomEditSummary(t('vocab.edit.deleteFailed', { count: formatNumber(selected.length) }));
            throw error;
        } finally {
            setCustomEditBusy(false);
        }
    };

    const openRenameDialog = () => {
        if (!activeCustomList) return;
        setRenameName(activeCustomList.name);
        setRenameError('');
        setRenameOpen(true);
    };

    const submitRename = async () => {
        const list = activeCustomList;
        if (!list || renameBusy) return;
        const name = renameName.trim();
        if (!name) {
            setRenameError(t('vocab.custom.renameEmpty'));
            return;
        }
        if (name === list.name) {
            setRenameOpen(false);
            return;
        }
        setRenameBusy(true);
        setRenameError('');
        try {
            const updated = await renameCustomWordlist(list.id, name);
            setCustomLists((prev) => prev.map((entry) => (
                entry.id === updated.id ? updated : entry
            )));
            setRenameOpen(false);
            toast.success(t('vocab.custom.renameSuccess', { name: updated.name }), {
                dedupeKey: 'wordlist:renamed',
            });
        } catch (error) {
            setRenameError(
                error instanceof Error && error.message.trim()
                    ? error.message
                    : t('vocab.custom.renameError'),
            );
        } finally {
            setRenameBusy(false);
        }
    };

    // ── My words / 已掌握: level fetch after the rows above ────────────────
    useEffect(() => {
        if (!activeIsMine && !activeIsMastered) return;
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
    }, [activeIsMine, activeIsMastered, levelWords, levels, levelNonce]);

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
            case 'wordlist':
                // Built-in lists have no page of their own to jump back to.
                return;
            default:
                // video + local_show reuse the existing "play at position" jump.
                onPlayFavorite(source.ref, start);
        }
    }, [onOpenArticle, onOpenLibraryArticle, onOpenSentencePack, onOpenBook, onOpenImportedBook, onPlayFavorite]);

    // ── Word lists: server-side search + 50/page + hide-Chinese ───────────
    const [query, setQuery] = useState('');
    const [debouncedQuery, setDebouncedQuery] = useState('');
    const [page, setPage] = useState(1);
    /** 内置词表 level filter; '' = 全部. CEFR counts come from `byLevel`. */
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

    // ── Custom word lists: client search/paging + hide-Chinese ────────────
    // Kept separate from the built-in list state: switching between a custom
    // list and GRE must not rewrite the other surface's query/page (IX-06).
    const [customQuery, setCustomQuery] = useState('');
    const [customPage, setCustomPage] = useState(1);
    const [customNonce, setCustomNonce] = useState(0);
    const [customRevealed, setCustomRevealed] = useState<Set<string>>(() => new Set());
    const [customDeleteOpen, setCustomDeleteOpen] = useState(false);
    const [customAddAllOpen, setCustomAddAllOpen] = useState(false);

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
        // Custom lists restart clean too (first page, no search, collapsed,
        // edit mode off) — specs/005 §统一词表 UI.
        setCustomQuery('');
        setCustomPage(1);
        setCustomRevealed(new Set());
        setCustomSort('alpha');
        setCustomLevel('');
        setCustomUnmasteredOnly(false);
        setCustomLoadPhase('idle');
        setCustomItems([]);
        resetCustomEdit();
        // 我的单词 and 已掌握 also restart clean (first page, default sort, no
        // filters/search) — specs/005 §统一词表 UI.
        setMasteredPage(1);
        setMasteredQuery('');
        setMasteredLevel('');
        setMasteredSort('alpha');
        setMasteredRevealed(new Set());
        setMineSort('added');
        setMineType('');
        setMineSource('');
        setMineLevel('');
        setMineQuery('');
        setMineDebouncedQuery('');
        setMinePage(1);
    }, [catalogById, resetCustomEdit]);


    // Persist the global switch. A storage failure is non-fatal (private mode).
    useEffect(() => {
        try {
            localStorage.setItem(HIDE_CHINESE_KEY, hideChinese ? '1' : '0');
        } catch {
            // Ignore: the preference just won't survive the reload.
        }
    }, [hideChinese]);

    // Custom list: one bounded full load (≤200/page, ≤5000 words) feeds client
    // search, sorting, filters, paging and edit mode (specs/005 §统一词表 UI).
    useEffect(() => {
        if (!activeIsCustom || !activeCustomListId) {
            setCustomLoadPhase('idle');
            setCustomItems([]);
            setCustomLoadError('');
            return;
        }
        const controller = new AbortController();
        setCustomLoadPhase('loading');
        setCustomLoadError('');
        fetchAllCustomWordlistItems(activeCustomListId, controller.signal)
            .then((data) => {
                if (controller.signal.aborted) return;
                setCustomItems(data.items);
                setCustomLoadPhase('ready');
            })
            .catch(async (error) => {
                if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
                setCustomLoadError(await describeApiError(error));
                setCustomLoadPhase('error');
            });
        return () => controller.abort();
    }, [activeIsCustom, activeCustomListId, customNonce]);

    // A new custom page/search/filter starts with every translation collapsed
    // and the selection cleared (the filter may have hidden the selected rows).
    useEffect(() => {
        setCustomRevealed(new Set());
        setCustomPage(1);
        setCustomEditSelected(new Set());
        setCustomEditSummary(null);
    }, [customQuery, customSort, customLevel, customUnmasteredOnly, pageSize]);

    // A new list/page/search/level starts with every row's translation collapsed.
    useEffect(() => {
        setRevealed(new Set());
    }, [activeTab, page, masteredPage, debouncedQuery, listLevel]);

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
    }, [activeTab, page, masteredPage, debouncedQuery, listLevel]);

    useEffect(() => {
        if (activeIsMine || activeIsMastered || activeIsCustom || activeUnavailable || activeTab === PHRASES_TAB) {
            setListData(null);
            setListPhase('idle');
            return;
        }
        const controller = new AbortController();
        setListPhase('loading');
        setListError('');
        fetchVocabularyPage(activeTab, {
            page,
            pageSize,
            q: debouncedQuery,
            level: listLevel,
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
    }, [activeIsMine, activeIsMastered, activeIsCustom, activeIsCefr, activeUnavailable, activeTab, page, pageSize, debouncedQuery, listLevel, listNonce]);

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
            pageSize,
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
    }, [activeTab, phrasePage, pageSize, phraseDebouncedQuery, phraseLevel, phraseType, phraseNonce]);

    // 每页条数 is a view preference shared by every list: a new size always
    // returns to page 1 (a phantom page beyond the smaller set is never shown).
    useEffect(() => {
        setMinePage(1);
        setMasteredPage(1);
        setCustomPage(1);
        setPage(1);
        setPhrasePage(1);
    }, [pageSize]);

    useEffect(() => {
        setMasteredPage(1);
    }, [masteredQuery, masteredLevel, masteredSort]);

    // A new 内置词表 level filter restarts the server page (search keeps its
    // own debounce reset).
    useEffect(() => {
        setPage(1);
    }, [listLevel]);

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

    /** Row click: the shared row expands; hide-Chinese reveal stays a side effect. */

    const toggleMasteredReveal = (key: string) => {
        setMasteredRevealed((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    };

    const toggleHideChinese = () => {
        setHideChinese((prev) => !prev);
        setRevealed(new Set());
        setPhraseRevealed(new Set());
        setMasteredRevealed(new Set());
    };

    const toggleReveal = (word: string) => {
        setRevealed((prev) => {
            const next = new Set(prev);
            if (next.has(word)) next.delete(word);
            else next.add(word);
            return next;
        });
    };

    const phraseTotal = phraseData?.total ?? 0;
    const phrasePages = Math.max(1, Math.ceil(phraseTotal / pageSize));
    const phraseHasFilter = Boolean(phraseDebouncedQuery || phraseLevel || phraseType);
    const phraseTotalLabel = phraseHasFilter
        ? t('vocab.phrases.results', { count: formatNumber(phraseTotal) })
        : t('vocab.phrases.total', { count: formatNumber(phraseTotal) });

    const sourceText = useCallback((fav: FavoriteItem): { source: ResolvedFavoriteSource; text: string; canOpen: boolean } => {
        const source = resolveFavoriteSource(fav);
        const kindLabel = t(SOURCE_LABEL_KEYS[source.kind]);
        const level = source.kind === 'sentence_pack' ? sentencePackLevel(source.ref) : null;
        // A built-in list favorite has provenance but no page to reopen.
        const canOpen = Boolean(source.ref)
            && source.kind !== 'wordlist'
            && (source.kind !== 'sentence_pack' || level != null);
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

    const renderTabPanel = () => {
        if (activeIsMine) return renderMine();
        if (activeIsMastered) return renderMastered();
        if (activeIsCustom) return renderCustomList();
        if (activeTab === PHRASES_TAB) return renderPhrases();
        return renderList();
    };

    // The header total follows the active surface: it used to show the built-in
    // list total on every tab (「共 0 词」 on 我的单词/短语/已掌握). `null` means
    // "not known yet", so a failed or in-flight read never renders a fake 0 (G3).
    const listHasFilterServer = () => Boolean(debouncedQuery || listLevel);
    const headerTotalLabel = activeIsMine
        ? t('vocab.total', { count: formatNumber(myWords.length) })
        : activeIsMastered
            ? (masteredKnown ? t('vocab.total', { count: formatNumber(masteredCount) }) : null)
            : activeIsCustom
                ? (activeCustomList
                    ? t('vocab.total', { count: formatNumber(activeCustomList.itemCount) })
                    : null)
                : activeTab === PHRASES_TAB
                ? (phraseData ? phraseTotalLabel : null)
                : (listData
                    ? (listHasFilterServer()
                        ? t('vocab.search.results', { count: formatNumber(listData.total) })
                        : t('vocab.total', { count: formatNumber(listData.total) }))
                    : null);

    const renderHeader = () => (
        <SubHeader
            title={t('vocab.title')}
            onBack={onBack}
            parentLabel={parentLabel}
            meta={headerTotalLabel != null
                ? <span data-testid="vocab-total">{headerTotalLabel}</span>
                : undefined}
            actions={(
                <Button
                    size="sm"
                    variant="secondary"
                    iconLeft={<Upload />}
                    ariaLabel={t('vocab.custom.import')}
                    onClick={openImport}
                    testId="vocab-import-button"
                    className="h-11 w-11 px-0 sm:h-control-sm sm:w-auto sm:px-3"
                >
                    <span className="hidden sm:inline">{t('vocab.custom.import')}</span>
                </Button>
            )}
            backTestId="vocab-back"
        />
    );

    const renderTabs = () => {
        // Built-in order first; the account's custom lists follow, in creation
        // order (specs/038 §1: 词表 tab 追加到末尾).
        const tabs: string[] = [
            MINE_TAB,
            MASTERED_TAB,
            PHRASES_TAB,
            ...LIST_TAB_IDS,
            ...customLists.map((entry) => customTabId(entry.id)),
        ];
        const items: TabItem[] = tabs.map((id) => {
            const entry = catalogById.get(id);
            const listId = customListId(id);
            const customEntry = listId
                ? customLists.find((list) => list.id === listId) ?? null
                : null;
            const unavailable = entry?.available === false;
            const label = customEntry
                ? customEntry.name
                : id === MINE_TAB
                    ? t('vocab.tab.mine')
                    : id === MASTERED_TAB
                        ? masteredTabLabel
                        : id === PHRASES_TAB
                            ? t('vocab.tab.phrases')
                            : id === CEFR_TAB
                                ? t('vocab.tab.cefr')
                                : (entry?.label || FALLBACK_LABELS[id] || id);
            const count = customEntry
                ? customEntry.itemCount
                : id === MINE_TAB
                    // 我的单词 is the favorites list itself; its count no longer
                    // depends on any mastered read (ADR-0001).
                    ? myWords.length
                    : id === MASTERED_TAB
                        // The whole mastered collection, not just mastered favorites:
                        // unknown until the signed-in GET succeeds (never a fake 0).
                        ? (masteredKnown ? masteredCount : null)
                        : typeof entry?.count === 'number' && !unavailable
                            ? entry.count
                            : null;
            return {
                id,
                label,
                count,
                countLabel: count != null ? formatNumber(count) : undefined,
                countTestId: customEntry
                    ? `vocab-tab-count-custom-${customEntry.id}`
                    : !unavailable ? `vocab-tab-count-${id}` : undefined,
                disabled: unavailable,
                title: unavailable ? entry?.note ?? undefined : undefined,
                testId: customEntry ? `vocab-tab-custom-${customEntry.id}` : `vocab-tab-${id}`,
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
            <div data-testid={testId} className={`${LIST_CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                <Icon className="mb-3 h-10 w-10 text-fg-disabled" aria-hidden="true" />
                <p className="text-ui font-medium text-fg-secondary">{title}</p>
                <p className="mt-1 max-w-md text-caption leading-relaxed text-fg-muted">{hint}</p>
            </div>
        );
    };

    const renderMine = () => {
        const sortOptions: SortOption[] = [
            { value: 'added', label: t('vocab.sort.added'), testId: 'vocab-sort-added' },
            { value: 'seen', label: t('vocab.sort.seen'), testId: 'vocab-sort-seen' },
            { value: 'level', label: t('vocab.sort.level'), testId: 'vocab-sort-level' },
            { value: 'alpha', label: t('vocab.sort.alpha'), testId: 'vocab-sort-alpha' },
        ];
        const filterGroups: FilterGroup[] = [
            {
                id: 'type',
                label: t('vocab.filter.type'),
                options: [
                    { value: '', label: t('vocab.filter.all'), checked: mineType === '', testId: 'vocab-filter-type-all' },
                    { value: 'word', label: t('vocab.filter.word'), checked: mineType === 'word', testId: 'vocab-filter-type-word' },
                    { value: 'phrase', label: t('vocab.filter.phrase'), checked: mineType === 'phrase', testId: 'vocab-filter-type-phrase' },
                ],
            },
            {
                id: 'source',
                label: t('vocab.filter.source'),
                options: [
                    { value: '', label: t('vocab.filter.all'), checked: mineSource === '', testId: 'vocab-filter-source-all' },
                    ...mineSourceKinds.map((kind) => ({
                        value: kind,
                        label: t(SOURCE_LABEL_KEYS[kind]),
                        checked: mineSource === kind,
                        testId: `vocab-filter-source-${kind}`,
                    })),
                ],
            },
            {
                id: 'level',
                label: t('vocab.filter.level'),
                options: levelFilterOptions(mineLevel, 'vocab-filter-level'),
            },
        ];
        const filterActiveCount =
            Number(Boolean(mineType)) + Number(Boolean(mineSource)) + Number(Boolean(mineLevel));
        const changeFilter = (key: string) => {
            const [group, value] = key.split(':');
            if (group === 'type') setMineType(value as MineType);
            else if (group === 'source') setMineSource(value as '' | FavoriteSourceKind);
            else if (group === 'level') setMineLevel(value as MineLevel);
        };
        const clearFilters = () => {
            setMineType('');
            setMineSource('');
            setMineLevel('');
            setMineQuery('');
        };
        const sortLabel = sortOptions.find((option) => option.value === mineSort)?.label
            ?? t('vocab.sort.added');

        const rows: WordTableRow[] = minePageRows.map((fav) => {
            const word = fav.en_text.trim();
            const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
            const level = levelBadgeFor(word);
            const source = sourceText(fav);
            const SourceIcon = SOURCE_ICON[source.source.kind];
            const masteredKey = normalizeMasteryWord(word);
            const isReviewed = reviewedWords.has(masteredKey);
            const isExpanded = Boolean(expanded[fav.id]);
            const addedAtLabel = fav.added_at ? formatDate(fav.added_at) : t('vocab.timeUnknown');
            const knownLevel = word in levels;
            const levelLabel = levels[word] ?? null;
            const reviewLabel = isReviewed ? t('vocab.review.added') : t('vocab.review.add');
            const masterLabel = isGuest ? t('vocab.review.guestMaster') : t('vocab.review.master');
            const actions: WordRowAction[] = [];
            if (REVIEW_UI_ENABLED) {
                actions.push({
                    key: 'review',
                    label: `${reviewLabel} ${word}`,
                    text: reviewLabel,
                    icon: isReviewed ? CheckCircle2 : Repeat,
                    testId: `vocab-mine-review-${fav.id}`,
                    busy: pendingReviewId === fav.id,
                    done: isReviewed,
                    disabled: Boolean(pendingReviewId || pendingMasteredId),
                    onClick: () => { void handleAddFavoriteToReview(fav); },
                });
            }
            actions.push({
                key: 'master',
                label: `${masterLabel} ${word}`,
                text: masterLabel,
                icon: CheckCircle2,
                testId: `vocab-mine-master-${fav.id}`,
                busy: pendingMasteredId === fav.id,
                disabled: Boolean(pendingReviewId || pendingMasteredId),
                onClick: () => { void handleToggleFavoriteMastered(fav); },
            });
            // No 取消收藏 action here: the row star is the single cancel entry
            // (specs/005 单一来源; ADR-0001). The expanded area keeps 已掌握.
            return {
                key: fav.id,
                word,
                phonetic: ipa,
                translation: meaning,
                level: level.label,
                levelTitle: level.title,
                seenText: seenText(fav),
                seenTitle,
                // Canonical favorite state, same source as every list surface.
                favored: favoritedWordKeys.has(masteredKey),
                favoriteLabel: t('vocab.star.remove', { word }),
                onToggleFavorite: () => removeFavoriteForRow(fav),
                favoriteBusy: favoriteBusyKeys.has(masteredKey),
                speakLabel: speakLabelFor(word),
                onSpeak: () => speakRow(word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(fav.id),
                detail: (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1 sm:col-span-2">
                            <p className="text-micro text-fg-muted">{t('vocab.meaning.full')}</p>
                            <p
                                data-testid={`vocab-mine-full-${fav.id}`}
                                className="break-words text-ui leading-relaxed text-fg-secondary"
                            >
                                {meaning || '—'}
                            </p>
                            {fav.example && (
                                <p className="break-words text-caption leading-relaxed text-fg-muted">
                                    {t('vocab.example')}：{fav.example}
                                </p>
                            )}
                            {!knownLevel && levelPhase === 'error' && (
                                <p className="flex flex-wrap items-center gap-2 text-caption text-warning-fg">
                                    <span
                                        data-testid={`vocab-mine-level-error-${fav.id}`}
                                        title={levelError || undefined}
                                    >
                                        {t('vocab.level.error')}
                                    </span>
                                    <button
                                        type="button"
                                        data-testid={`vocab-mine-level-retry-${fav.id}`}
                                        onClick={() => setLevelNonce((value) => value + 1)}
                                        className="font-medium text-brand-300 hover:text-brand-400"
                                    >
                                        {t('common.retry')}
                                    </button>
                                </p>
                            )}
                            {knownLevel && levelLabel == null && (
                                <p className="text-micro text-fg-muted">{t('vocab.level.beyond')}</p>
                            )}
                        </div>
                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.detail.source')}</p>
                            <button
                                type="button"
                                data-testid={`vocab-mine-source-${fav.id}`}
                                disabled={!source.canOpen}
                                onClick={() => openSource(source.source, fav.start)}
                                title={source.canOpen ? source.text : t('vocab.source.unknown')}
                                className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-caption ${
                                    source.canOpen
                                        ? 'text-brand-300 transition-colors hover:text-brand-400'
                                        : 'cursor-default text-fg-muted'
                                }`}
                            >
                                <SourceIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                                <span className="min-w-0 truncate">{source.text}</span>
                                {source.canOpen && (
                                    <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />
                                )}
                            </button>
                        </div>
                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.detail.addedAt')}</p>
                            <p
                                data-testid={`vocab-mine-added-${fav.id}`}
                                className="text-ui tabular-nums text-fg-strong"
                            >
                                {addedAtLabel}
                            </p>
                        </div>
                    </div>
                ),
                actions,
                error: rowError?.id === fav.id
                    ? { message: rowError.message, testId: `vocab-mine-error-${fav.id}` }
                    : undefined,
                testIds: {
                    row: `vocab-mine-toggle-${fav.id}`,
                    word: `vocab-mine-word-${fav.id}`,
                    phonetic: `vocab-mine-ipa-${fav.id}`,
                    translation: `vocab-mine-meaning-${fav.id}`,
                    level: `vocab-mine-level-${fav.id}`,
                    speak: `vocab-mine-speak-${fav.id}`,
                    star: `vocab-mine-star-${fav.id}`,
                    seen: `vocab-mine-seen-${fav.id}`,
                    expand: `vocab-mine-expand-${fav.id}`,
                    detail: `vocab-mine-detail-${fav.id}`,
                },
            };
        });

        return (
            <div data-testid="vocab-mine-panel" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-caption leading-relaxed text-fg-muted">{t('vocab.mine.hint')}</p>
                    {myWords.length > 0 && (
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                data-testid="vocab-export-anki"
                                onClick={() => exportAnkiTsv(myWords)}
                                title={t('favorites.exportAnkiTitle')}
                                className={ACTION_BUTTON}
                            >
                                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">{t('favorites.exportAnki')}</span>
                            </button>
                            <button
                                type="button"
                                data-testid="vocab-export-csv"
                                onClick={() => exportCsv(myWords)}
                                title={t('favorites.exportCsvTitle')}
                                className={ACTION_BUTTON}
                            >
                                <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                                <span className="hidden sm:inline">{t('favorites.exportCsv')}</span>
                            </button>
                        </div>
                    )}
                </div>

                <WordbookToolbar
                    search={{
                        value: mineQuery,
                        onChange: setMineQuery,
                        placeholder: t('vocab.mine.search.placeholder'),
                        ariaLabel: t('vocab.mine.search.placeholder'),
                        testId: 'vocab-mine-search',
                        clearTestId: 'vocab-mine-search-clear',
                        clearLabel: t('vocab.mine.search.clear'),
                    }}
                    sort={{
                        value: mineSort,
                        label: sortLabel,
                        options: sortOptions,
                        onChange: (value) => setMineSort(value as MineSort),
                        testId: 'vocab-mine-sort',
                        menuTestId: 'vocab-mine-sort-menu',
                    }}
                    filter={{
                        groups: filterGroups,
                        activeCount: filterActiveCount,
                        onChange: changeFilter,
                        onClear: clearFilters,
                        testId: 'vocab-mine-filter',
                        clearTestId: 'vocab-mine-clear-filters',
                        menuTestId: 'vocab-mine-filter-menu',
                    }}
                />

                {!isGuest && masteredPhase === 'error' && (
                    <ErrorPanel
                        level="inline"
                        title={t('vocab.mine.mastered.error')}
                        detail={t('vocab.mine.mastered.errorHint')}
                        onRetry={() => setMasteredNonce((value) => value + 1)}
                        retryLabel={t('common.retry')}
                        testId="vocab-mastered-stale"
                        retryTestId="vocab-mastered-stale-retry"
                    />
                )}

                {myWords.length === 0
                    ? emptyState(t('vocab.empty.mine'), t('vocab.empty.mineHint'), Star, 'vocab-mine-empty')
                    : mineRows.length === 0
                        ? emptyState(
                            t('vocab.mine.empty.filtered'),
                            t('vocab.mine.empty.filteredHint'),
                            Search,
                            'vocab-mine-filtered-empty',
                        )
                        : (
                            <>
                                <WordTable
                                    rows={rows}
                                    hideChinese={false}
                                    showSeen
                                    className={LIST_CARD}
                                    listTestId="vocab-mine-list"
                                    testIdPrefix="vocab-mine"
                                    ariaLabel={t('vocab.tab.mine')}
                                />
                                <span data-testid="vocab-mine-total" className="text-caption tabular-nums text-fg-muted">
                                    {hasMineFilters
                                        ? t('vocab.search.results', { count: formatNumber(mineRows.length) })
                                        : t('vocab.total', { count: formatNumber(mineRows.length) })}
                                </span>
                                <VocabPagination
                                    scope="vocab"
                                    page={currentMinePage}
                                    pages={minePages}
                                    hasMore={currentMinePage < minePages}
                                    onChange={setMinePage}
                                    pageSize={pageSize}
                                    onPageSizeChange={setPageSize}
                                />
                            </>
                        )}
            </div>
        );
    };

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

        const sortOptions: SortOption[] = [
            { value: 'default', label: t('vocab.sort.recommended'), testId: 'phrase-sort-default' },
        ];
        const filterGroups: FilterGroup[] = [
            {
                id: 'level',
                label: t('vocab.phrases.filter.level'),
                options: [
                    { value: '', label: t('vocab.phrases.filter.all'), checked: phraseLevel === '', testId: 'phrase-level-all' },
                    ...PHRASE_LEVELS.map((level) => ({
                        value: level,
                        label: level,
                        checked: phraseLevel === level,
                        testId: `phrase-level-${level}`,
                    })),
                ],
            },
            {
                id: 'type',
                label: t('vocab.phrases.filter.type'),
                options: [
                    { value: '', label: t('vocab.phrases.filter.all'), checked: phraseType === '', testId: 'phrase-type-all' },
                    ...PHRASE_TYPES.map((type) => ({
                        value: type,
                        label: t(PHRASE_TYPE_LABEL_KEYS[type]),
                        checked: phraseType === type,
                        testId: `phrase-type-${type}`,
                    })),
                ],
            },
        ];
        const filterActiveCount = Number(Boolean(phraseLevel)) + Number(Boolean(phraseType));
        const changeFilter = (key: string) => {
            const [group, value] = key.split(':');
            if (group === 'level') setPhraseLevel(value as PhraseLevel | '');
            else if (group === 'type') setPhraseType(value as PhraseType | '');
        };
        const clearFilters = () => {
            setPhraseLevel('');
            setPhraseType('');
            setPhraseQuery('');
            setPhrasePage(1);
        };

        const rows: WordTableRow[] = (phraseData?.items ?? []).map((item: PhraseEntry) => {
            const rowKey = `phrase:${item.id}`;
            const isExpanded = phraseExpanded.has(item.id);
            const isRevealed = phraseRevealed.has(item.id);
            const chineseHidden = hideChinese && !isRevealed;
            const detail = phraseDetails[item.id];
            const detailState = phraseDetailPhase[item.id] ?? 'idle';
            const detailError = phraseDetailError[item.id] ?? '';
            const typeDescription = phraseTypeDescription(item.type);
            const sourceLabel = phraseSourceLabel(item.source);
            const example = item.example || detail?.example || '';
            const wordKey = normalizeMasteryWord(item.headword);
            return {
                key: item.id,
                word: item.headword,
                phonetic: '',
                translation: item.translation,
                level: item.cefr || '—',
                levelTitle: t('vocab.phrases.approxTitle'),
                badge: (
                    <Badge tone="neutral" testId={`phrase-type-${item.id}`}>
                        {phraseTypeLabel(item.type)}
                    </Badge>
                ),
                revealed: isRevealed,
                onActivate: hideChinese ? () => togglePhraseReveal(item.id) : undefined,
                favored: favoritedWordKeys.has(wordKey),
                favoriteLabel: favoriteLabelFor(item.headword),
                onToggleFavorite: () => toggleRowFavorite({
                    word: item.headword,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: PHRASES_TAB,
                    sourceTitle: t('vocab.tab.phrases'),
                }),
                favoriteBusy: favoriteBusyKeys.has(wordKey),
                speakLabel: speakLabelFor(item.headword),
                onSpeak: () => speakRow(item.headword),
                speakDisabled: speechDisabled,
                expandLabel: isExpanded ? t('vocab.phrases.collapse') : t('vocab.phrases.expand'),
                expanded: isExpanded,
                onToggleExpand: () => togglePhraseExpand(item.id),
                detail: (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1 sm:col-span-2">
                            <p className="text-micro text-fg-muted">{t('vocab.phrases.detail.example')}</p>
                            <p
                                data-testid="phrase-example"
                                className="break-words text-caption leading-relaxed text-fg-strong"
                            >
                                {example || '—'}
                            </p>
                        </div>

                        {!chineseHidden && (
                            <div className="min-w-0 space-y-1">
                                <p className="text-micro text-fg-muted">{t('vocab.phrases.detail.type')}</p>
                                <p
                                    data-testid="phrase-type-desc"
                                    className="break-words text-caption leading-relaxed text-fg-strong"
                                >
                                    {typeDescription || '—'}
                                </p>
                            </div>
                        )}

                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.phrases.detail.source')}</p>
                            <p
                                data-testid="phrase-source"
                                title={detail?.license ?? undefined}
                                className="break-words text-caption text-fg-strong"
                            >
                                {sourceLabel}
                            </p>
                            {detail?.license && (
                                <p className="break-words text-micro text-fg-muted">{detail.license}</p>
                            )}
                        </div>

                        {chineseHidden ? (
                            <div
                                data-testid="phrase-zh-hidden"
                                className="min-w-0 rounded-control border border-line-subtle bg-surface-2/40 px-3 py-2 text-micro leading-relaxed text-fg-muted sm:col-span-2"
                            >
                                {t('vocab.phrases.detail.zhHidden')}
                            </div>
                        ) : (
                            <>
                                {detailState === 'loading' && (
                                    <p data-testid="phrase-detail-loading" className="flex items-center gap-1.5 text-caption text-fg-muted">
                                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                        {t('vocab.phrases.detail.loading')}
                                    </p>
                                )}
                                {detailState === 'error' && (
                                    <div className="flex flex-wrap items-center gap-2 text-caption text-warning-fg">
                                        <span data-testid="phrase-detail-error">
                                            {t('vocab.phrases.detail.error')}
                                            {detailError ? ` · ${detailError}` : ''}
                                        </span>
                                        <button
                                            type="button"
                                            data-testid="phrase-detail-retry"
                                            onClick={() => loadPhraseDetail(item.id, true)}
                                            className="font-medium text-brand-300 hover:text-brand-400"
                                        >
                                            {t('common.retry')}
                                        </button>
                                    </div>
                                )}
                                {detail?.notes && (
                                    <div className="min-w-0 space-y-1 sm:col-span-2">
                                        <p className="text-micro text-fg-muted">{t('vocab.phrases.detail.notes')}</p>
                                        <p
                                            data-testid="phrase-notes"
                                            className="break-words text-caption leading-relaxed text-fg-secondary"
                                        >
                                            {detail.notes}
                                        </p>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                ),
                actions: rowAddActions({
                    rowKey,
                    word: item.headword,
                    translation: item.translation,
                    listId: PHRASES_TAB,
                    listLabel: t('vocab.tab.phrases'),
                }),
                error: listRowErrors[rowKey]
                    ? { message: listRowErrors[rowKey], testId: `phrase-add-error-${item.id}` }
                    : undefined,
                testIds: {
                    row: 'phrase-row',
                    word: 'phrase-headword',
                    translation: 'phrase-translation',
                    level: 'phrase-level',
                    speak: `${rowKey}-speak`,
                    star: `${rowKey}-star`,
                    expand: 'phrase-expand',
                    detail: `phrase-detail-${item.id}`,
                },
            };
        });

        return (
            <div data-testid="phrase-panel" className="flex flex-col gap-3">
                <WordbookToolbar
                    search={{
                        value: phraseQuery,
                        onChange: setPhraseQuery,
                        placeholder: t('vocab.phrases.search.placeholder'),
                        ariaLabel: t('vocab.phrases.search.placeholder'),
                        testId: 'phrase-search',
                        clearTestId: 'phrase-search-clear',
                        clearLabel: t('vocab.phrases.search.clear'),
                    }}
                    sort={{
                        value: 'default',
                        label: t('vocab.sort.recommended'),
                        options: sortOptions,
                        onChange: () => undefined,
                        testId: 'phrase-sort',
                        menuTestId: 'phrase-sort-menu',
                    }}
                    filter={{
                        groups: filterGroups,
                        activeCount: filterActiveCount,
                        onChange: changeFilter,
                        onClear: clearFilters,
                        testId: 'phrase-filter',
                        clearTestId: 'phrase-clear-filters',
                        menuTestId: 'phrase-filter-menu',
                    }}
                    extra={hideChineseToggle('phrases')}
                />

                <p className="flex items-start gap-1.5 text-micro leading-relaxed text-fg-muted">
                    <Info className="mt-px h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                    <span data-testid="phrase-approx-note">{t('vocab.phrases.approxNote')}</span>
                </p>

                {phrasePhase === 'loading' && (
                    <div data-testid="phrase-loading" className={`${LIST_CARD} flex items-center justify-center gap-2 py-16 text-ui text-fg-muted`}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('common.loading')}
                    </div>
                )}

                {phrasePhase === 'error' && (
                    <div data-testid="phrase-error" className={`${LIST_CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                        <AlertTriangle className="mb-3 h-10 w-10 text-warning-fg/70" aria-hidden="true" />
                        <p className="text-ui font-medium text-fg-strong">{t('vocab.phrases.error.title')}</p>
                        <p className="mt-1 max-w-md break-words text-caption text-fg-muted">
                            {phraseError || t('vocab.phrases.error.hint')}
                        </p>
                        <Button
                            size="sm"
                            variant="secondary"
                            testId="phrase-retry"
                            onClick={() => setPhraseNonce((value) => value + 1)}
                            className="mt-5"
                        >
                            {t('common.retry')}
                        </Button>
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
                            <p className="text-caption tabular-nums text-fg-muted" data-testid="phrase-total">
                                {phraseTotalLabel}
                            </p>
                            <WordTable
                                rows={rows}
                                hideChinese={hideChinese}
                                className={LIST_CARD}
                                listTestId="phrase-list"
                                testIdPrefix="phrase"
                                ariaLabel={t('vocab.tab.phrases')}
                            />
                            <VocabPagination
                                scope="phrase"
                                page={phrasePage}
                                pages={phrasePages}
                                hasMore={phraseData.hasMore}
                                onChange={setPhrasePage}
                                pageSize={pageSize}
                                onPageSizeChange={setPageSize}
                            />
                        </>
                    )
                )}
            </div>
        );
    };

    const renderMastered = () => {
        const ready = isGuest || masteredReady;
        const failed = !isGuest && masteredPhase === 'error';
        const needle = masteredQuery.trim().toLowerCase();
        const filtered = masteredRows.filter((row) => {
            if (!matchesLevel(row.word, masteredLevel)) return false;
            if (needle && !`${row.word}\n${row.translation}`.toLowerCase().includes(needle)) return false;
            return true;
        });
        const sorted = [...filtered].sort((a, b) => {
            if (masteredSort === 'level') {
                const byLevel = levelSortRank(a.word, levels) - levelSortRank(b.word, levels);
                if (byLevel !== 0) return byLevel;
            }
            return a.word.toLowerCase().localeCompare(b.word.toLowerCase(), 'en')
                || a.word.localeCompare(b.word);
        });
        const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
        const currentPage = Math.min(Math.max(1, masteredPage), pages);
        const start = (currentPage - 1) * pageSize;
        const pageRows = sorted.slice(start, start + pageSize);
        const hasFilter = Boolean(masteredQuery.trim() || masteredLevel);
        const sortOptions: SortOption[] = [
            { value: 'alpha', label: t('vocab.sort.alpha'), testId: 'vocab-mastered-sort-alpha' },
            { value: 'level', label: t('vocab.sort.level'), testId: 'vocab-mastered-sort-level' },
        ];
        const rows: WordTableRow[] = pageRows.map((row) => {
            const fav = favoriteByWord.get(row.key);
            const level = levelBadgeFor(row.word);
            const expandKey = `mastered:${row.key}`;
            const isExpanded = Boolean(expanded[expandKey]);
            const source = fav ? sourceText(fav) : null;
            const SourceIcon = source ? SOURCE_ICON[source.source.kind] : null;
            return {
                key: row.key,
                word: row.word,
                phonetic: row.phonetic,
                translation: row.translation,
                level: level.label,
                levelTitle: level.title,
                revealed: masteredRevealed.has(row.key),
                onActivate: hideChinese ? () => toggleMasteredReveal(row.key) : undefined,
                // 已掌握 is not a favorite: never a filled star, never a toggle.
                // The disabled control explains itself through its accessible name.
                favored: false,
                favoriteLabel: t('vocab.mastered.starDisabled', { word: row.word }),
                favoriteDisabled: true,
                speakLabel: speakLabelFor(row.word),
                onSpeak: () => speakRow(row.word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(expandKey),
                detail: (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.detail.source')}</p>
                            {source ? (
                                <>
                                    <button
                                        type="button"
                                        data-testid={`vocab-mastered-source-${row.key}`}
                                        disabled={!source.canOpen}
                                        onClick={() => openSource(source.source, fav?.start ?? 0)}
                                        title={source.canOpen ? source.text : t('vocab.source.unknown')}
                                        className={`inline-flex min-w-0 max-w-full items-center gap-1.5 text-caption ${
                                            source.canOpen
                                                ? 'text-brand-300 transition-colors hover:text-brand-400'
                                                : 'cursor-default text-fg-muted'
                                        }`}
                                    >
                                        {SourceIcon && <SourceIcon className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />}
                                        <span className="min-w-0 truncate">{source.text}</span>
                                    </button>
                                    {fav?.added_at && (
                                        <p
                                            data-testid={`vocab-mastered-added-${row.key}`}
                                            className="text-caption tabular-nums text-fg-muted"
                                        >
                                            {formatDate(fav.added_at)}
                                        </p>
                                    )}
                                </>
                            ) : (
                                <p className="text-caption text-fg-muted">{t('vocab.mastered.noFavorite')}</p>
                            )}
                        </div>
                    </div>
                ),
                actions: [
                    {
                        key: 'undo',
                        label: `${t('vocab.review.undo')} ${row.word}`,
                        text: t('vocab.review.undo'),
                        icon: Undo2,
                        testId: `vocab-mastered-undo-${row.key}`,
                        busy: pendingMasteredId === expandKey,
                        onClick: () => { void handleMasteredRowUndo(row); },
                    },
                ],
                error: rowError?.id === expandKey
                    ? { message: rowError.message, testId: `vocab-mastered-error-${row.key}` }
                    : undefined,
                testIds: {
                    row: 'vocab-mastered-row',
                    word: `vocab-mastered-word-${row.key}`,
                    phonetic: `vocab-mastered-ipa-${row.key}`,
                    translation: `vocab-mastered-translation-${row.key}`,
                    level: `vocab-mastered-level-${row.key}`,
                    speak: `vocab-mastered-${row.key}-speak`,
                    star: `vocab-mastered-star-${row.key}`,
                    expand: `vocab-mastered-expand-${row.key}`,
                    detail: `vocab-mastered-detail-${row.key}`,
                },
            };
        });

        return (
            <div data-testid="vocab-mastered-panel" className="flex flex-col gap-3">
                <WordbookToolbar
                    search={{
                        value: masteredQuery,
                        onChange: setMasteredQuery,
                        placeholder: t('vocab.mastered.search.placeholder'),
                        ariaLabel: t('vocab.mastered.search.placeholder'),
                        testId: 'vocab-mastered-search',
                        clearTestId: 'vocab-mastered-search-clear',
                        clearLabel: t('vocab.mastered.search.clear'),
                    }}
                    sort={{
                        value: masteredSort,
                        label: sortOptions.find((option) => option.value === masteredSort)?.label
                            ?? t('vocab.sort.alpha'),
                        options: sortOptions,
                        onChange: (value) => setMasteredSort(value as MasteredSort),
                        testId: 'vocab-mastered-sort',
                        menuTestId: 'vocab-mastered-sort-menu',
                    }}
                    filter={{
                        groups: [{
                            id: 'level',
                            label: t('vocab.filter.level'),
                            options: levelFilterOptions(masteredLevel, 'vocab-mastered-level'),
                        }],
                        activeCount: Number(Boolean(masteredLevel)),
                        onChange: (key) => {
                            const [group, value] = key.split(':');
                            if (group === 'level') setMasteredLevel(value as MineLevel);
                        },
                        onClear: () => {
                            setMasteredLevel('');
                            setMasteredQuery('');
                        },
                        testId: 'vocab-mastered-filter',
                        clearTestId: 'vocab-mastered-clear-filters',
                        menuTestId: 'vocab-mastered-filter-menu',
                    }}
                    extra={hideChineseToggle('mastered')}
                />

                {hideChinese && (
                    <p className="text-micro leading-relaxed text-fg-muted">{t('vocab.hint.hide')}</p>
                )}

                {failed && ready && (
                    <ErrorPanel
                        level="inline"
                        title={t('vocab.mine.mastered.error')}
                        detail={t('vocab.mine.mastered.errorHint')}
                        onRetry={() => setMasteredNonce((value) => value + 1)}
                        retryLabel={t('common.retry')}
                        testId="vocab-mastered-stale"
                        retryTestId="vocab-mastered-stale-retry"
                    />
                )}

                {failed && !ready ? (
                    <ErrorPanel
                        level="card"
                        title={t('vocab.mine.mastered.error')}
                        detail={t('vocab.mine.mastered.errorHint')}
                        onRetry={() => setMasteredNonce((value) => value + 1)}
                        retryLabel={t('common.retry')}
                        testId="vocab-mastered-error"
                        retryTestId="vocab-mastered-retry"
                    />
                ) : !ready ? (
                    <LoadingState
                        kind="skeleton"
                        rows={4}
                        label={t('vocab.mine.mastered.loading')}
                        testId="vocab-mastered-loading"
                        className={`${LIST_CARD} px-4 py-6`}
                    />
                ) : masteredRows.length === 0 ? (
                    emptyState(
                        t('vocab.mine.empty.mastered'),
                        t('vocab.mine.empty.masteredHint'),
                        CheckCircle2,
                        'vocab-mastered-empty',
                    )
                ) : (
                    <>
                        <span
                            data-testid="vocab-mastered-total"
                            className="text-caption tabular-nums text-fg-muted"
                        >
                            {hasFilter
                                ? t('vocab.search.results', { count: formatNumber(sorted.length) })
                                : t('vocab.total', { count: formatNumber(sorted.length) })}
                        </span>
                        <WordTable
                            rows={rows}
                            hideChinese={hideChinese}
                            className={LIST_CARD}
                            listTestId="vocab-mastered-list"
                            testIdPrefix="vocab-mastered"
                            ariaLabel={masteredTabLabel}
                        />
                        <VocabPagination
                            scope="vocab"
                            page={currentPage}
                            pages={pages}
                            hasMore={currentPage < pages}
                            onChange={setMasteredPage}
                            pageSize={pageSize}
                            onPageSizeChange={setPageSize}
                        />
                    </>
                )}
            </div>
        );
    };

    const toggleCustomReveal = (word: string) => {
        setCustomRevealed((prev) => {
            const next = new Set(prev);
            if (next.has(word)) next.delete(word);
            else next.add(word);
            return next;
        });
    };

    /** Top-bar entry: guests get the login overlay, never a local import. */
    const openImport = () => {
        if (isGuest) {
            openLogin();
            return;
        }
        if (customLists.length >= WORDLIST_MAX_LISTS) {
            toast.error(t('vocab.custom.import.limit'));
            return;
        }
        setImportOpen(true);
    };

    /** 删除词表: table + its rows only; favorites/review keep their snapshots. */
    const handleDeleteCustomList = async () => {
        const list = activeCustomList;
        if (!list) throw new Error(t('vocab.custom.deleteError'));
        try {
            await deleteCustomWordlist(list.id);
        } catch {
            throw new Error(t('vocab.custom.deleteError'));
        }
        toast.success(t('vocab.custom.deleteSuccess', { name: list.name }), {
            dedupeKey: 'wordlist:deleted',
        });
        setCustomLists((prev) => prev.filter((entry) => entry.id !== list.id));
        setCustomDeleteOpen(false);
        selectTab(MINE_TAB);
    };

    /**
     * 全部加入复习（N）: fetch every item through the server's 200/page cap,
     * then POST each word with its meaning snapshot. Nothing is reported as
     * done before the server confirms; failed words are counted, not hidden.
     */
    const handleAddAllCustomToReview = async () => {
        const list = activeCustomList;
        if (!list) throw new Error(t('vocab.custom.addAllError'));
        const collected: CustomWordlistItem[] = [];
        const seen = new Set<string>();
        try {
            let targetPage = 1;
            for (;;) {
                const data = await fetchCustomWordlistPage(list.id, { page: targetPage, pageSize: 200 });
                for (const item of data.items) {
                    const key = normalizeMasteryWord(item.word);
                    if (!key || seen.has(key)) continue;
                    seen.add(key);
                    collected.push(item);
                }
                if (!data.hasMore || data.items.length === 0 || targetPage >= 100) break;
                targetPage += 1;
            }
        } catch {
            throw new Error(t('vocab.custom.addAllError'));
        }
        let added = 0;
        let failed = 0;
        for (const item of collected) {
            const lemma = item.word.trim();
            if (!lemma) continue;
            try {
                await addWord({
                    lemma,
                    targetLang,
                    ...(item.translation?.trim() ? { definition: item.translation.trim() } : {}),
                    source: { contentRef: list.id },
                });
                added += 1;
                setReviewAdds((prev) => ({ ...prev, [`${list.id}:${lemma}`]: 'added' }));
                setReviewedWords((prev) => new Set(prev).add(normalizeMasteryWord(lemma)));
            } catch {
                failed += 1;
            }
        }
        if (failed > 0) {
            toast.error(t('vocab.custom.addAllPartial', {
                count: formatNumber(added),
                failed: formatNumber(failed),
            }), { dedupeKey: 'wordlist:add-all' });
        } else {
            toast.success(t('vocab.custom.addAllSuccess', { count: formatNumber(added) }), {
                dedupeKey: 'wordlist:add-all',
            });
        }
        setCustomNonce((value) => value + 1);
    };

    const renderCustomList = () => {
        if (!activeCustomList) return null;
        const list = activeCustomList;
        const listId = list.id;
        const needle = customQuery.trim().toLowerCase();
        const levelRank = (item: CustomWordlistItem): number => {
            const index = (VOCABULARY_CEFR_LEVELS as readonly string[]).indexOf(item.cefr ?? '');
            return index >= 0 ? index : OFF_LIST_RANK;
        };
        const filtered = customItems.filter((item) => {
            if (customLevel) {
                if (customLevel === 'C1+') return false; // 自定义词表只存 A1–C1
                if ((item.cefr ?? '').toUpperCase() !== customLevel) return false;
            }
            if (customUnmasteredOnly && masteredWords.has(normalizeMasteryWord(item.word))) return false;
            if (needle) {
                const haystack = `${item.word}\n${item.translation ?? ''}`.toLowerCase();
                if (!haystack.includes(needle)) return false;
            }
            return true;
        });
        const sorted = [...filtered].sort((a, b) => {
            if (customSort === 'level') {
                const byLevel = levelRank(a) - levelRank(b);
                if (byLevel !== 0) return byLevel;
            }
            return a.word.toLowerCase().localeCompare(b.word.toLowerCase(), 'en')
                || a.word.localeCompare(b.word);
        });
        const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
        const currentPage = Math.min(Math.max(1, customPage), pages);
        const start = (currentPage - 1) * pageSize;
        const pageRows = sorted.slice(start, start + pageSize);
        const hasFilter = Boolean(needle || customLevel || customUnmasteredOnly);
        const sortOptions: SortOption[] = [
            { value: 'alpha', label: t('vocab.sort.alpha'), testId: 'vocab-custom-sort-alpha' },
            { value: 'level', label: t('vocab.sort.level'), testId: 'vocab-custom-sort-level' },
        ];
        const filterActiveCount = Number(Boolean(customLevel)) + Number(customUnmasteredOnly);

        const rows: WordTableRow[] = pageRows.map((item) => {
            const rowKey = `${listId}:${item.word}`;
            const itemKey = customItemKey(item);
            const wordKey = normalizeMasteryWord(item.word);
            const favored = favoritedWordKeys.has(wordKey);
            const mastered = masteredWords.has(wordKey);
            const masterState = masterAdds[rowKey];
            const expandKey = `custom:${itemKey}`;
            const isExpanded = Boolean(expanded[expandKey]);
            return {
                key: itemKey,
                word: item.word,
                phonetic: item.phonetic,
                translation: item.translation,
                level: item.cefr || '—',
                levelTitle: item.cefr ? `CEFR ${item.cefr}` : undefined,
                revealed: customRevealed.has(item.word),
                onActivate: hideChinese ? () => toggleCustomReveal(item.word) : undefined,
                favored,
                favoriteLabel: favoriteLabelFor(item.word),
                onToggleFavorite: () => toggleRowFavorite({
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    example: item.example,
                    sourceKind: 'wordlist',
                    sourceRef: listId,
                    sourceTitle: list.name,
                }),
                favoriteBusy: favoriteBusyKeys.has(wordKey),
                speakLabel: speakLabelFor(item.word),
                onSpeak: () => speakRow(item.word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(expandKey),
                selection: customEditMode
                    ? {
                        checked: customEditSelected.has(itemKey),
                        onChange: (checked) => toggleCustomItem(itemKey, checked),
                        label: t('vocab.bulk.selectRow', { word: item.word }),
                        testId: `vocab-custom-select-${itemKey}`,
                        disabled: customEditBusy,
                    }
                    : undefined,
                detail: (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                        <div className="min-w-0 space-y-1 sm:col-span-2">
                            <p className="text-micro text-fg-muted">{t('vocab.meaning.full')}</p>
                            <p className="break-words text-ui leading-relaxed text-fg-secondary">
                                {item.translation || '—'}
                            </p>
                            {item.example && (
                                <p className="break-words text-caption leading-relaxed text-fg-muted">
                                    {t('vocab.example')}：{item.example}
                                </p>
                            )}
                        </div>
                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.detail.source')}</p>
                            <p className="break-words text-caption text-fg-strong">{list.name}</p>
                        </div>
                        <div className="min-w-0 space-y-1">
                            <p className="text-micro text-fg-muted">{t('vocab.level')}</p>
                            <p className="text-caption text-fg-strong">
                                {item.cefr || t('vocab.custom.noLevel')}
                            </p>
                        </div>
                    </div>
                ),
                actions: [
                    ...rowAddActions({
                        rowKey,
                        word: item.word,
                        translation: item.translation ?? '',
                        phonetic: item.phonetic,
                        definition: item.translation,
                        example: item.example,
                        listId,
                        listLabel: list.name,
                    }, { includeReview: REVIEW_UI_ENABLED }),
                    {
                        key: 'master',
                        label: `${mastered ? t('vocab.custom.mastered') : t('vocab.custom.master')} ${item.word}`,
                        text: mastered ? t('vocab.custom.mastered') : t('vocab.custom.master'),
                        icon: CheckCircle2,
                        testId: `${rowKey}-master`,
                        busy: masterState === 'busy',
                        done: mastered,
                        disabled: mastered,
                        onClick: () => {
                            void addListWordToMastered({
                                rowKey,
                                word: item.word,
                                translation: item.translation,
                                phonetic: item.phonetic,
                                listId,
                            });
                        },
                    },
                ],
                error: listRowErrors[rowKey]
                    ? { message: listRowErrors[rowKey], testId: `vocab-custom-error-${item.word}` }
                    : undefined,
                testIds: {
                    row: 'vocab-custom-row',
                    word: `vocab-custom-word-${item.word}`,
                    phonetic: `vocab-custom-ipa-${item.word}`,
                    translation: `vocab-custom-translation-${item.word}`,
                    level: `vocab-custom-level-${item.word}`,
                    speak: `${rowKey}-speak`,
                    star: `vocab-custom-star-${item.word}`,
                    expand: `vocab-custom-expand-${item.word}`,
                    detail: `vocab-custom-detail-${item.word}`,
                },
            };
        });

        return (
            <div data-testid="vocab-custom-panel" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                    <p className="max-w-xl text-caption leading-relaxed text-fg-secondary">
                        {t('vocab.custom.hint')}
                        <span className="ms-2 font-medium text-fg-strong">{list.name}</span>
                    </p>
                    <div className="flex flex-wrap items-center gap-1.5">
                        {REVIEW_UI_ENABLED && (
                            <Button
                                size="sm"
                                variant="secondary"
                                iconLeft={<Repeat />}
                                testId="vocab-custom-add-all"
                                onClick={() => setCustomAddAllOpen(true)}
                            >
                                {t('vocab.custom.addAll', { count: formatNumber(list.itemCount) })}
                            </Button>
                        )}
                        {customEditMode ? (
                            <span className="inline-flex h-control-md items-center rounded-control bg-state-selected px-2.5 text-caption font-medium text-fg-strong">
                                {t('vocab.edit.selected', { count: formatNumber(customEditSelected.size) })}
                            </span>
                        ) : (
                            <Button
                                size="sm"
                                variant="secondary"
                                iconLeft={<Pencil />}
                                testId="vocab-custom-edit"
                                onClick={toggleCustomEdit}
                            >
                                {t('vocab.edit')}
                            </Button>
                        )}
                        <Menu
                            ariaLabel={t('vocab.custom.menu')}
                            align="end"
                            compact
                            menuTestId="vocab-custom-menu"
                            trigger={({ triggerRef, triggerProps }) => (
                                <button
                                    {...triggerProps}
                                    ref={triggerRef}
                                    type="button"
                                    data-testid="vocab-custom-menu-trigger"
                                    aria-label={t('vocab.custom.menu')}
                                    title={t('vocab.custom.menu')}
                                    className="inline-flex h-control-md w-9 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-state-hover hover:text-fg-primary"
                                >
                                    <MoreHorizontal className="h-4 w-4" aria-hidden="true" />
                                </button>
                            )}
                            items={[
                                {
                                    id: 'rename',
                                    label: t('vocab.custom.rename'),
                                    icon: <Pencil />,
                                    testId: 'vocab-custom-rename',
                                    onSelect: openRenameDialog,
                                },
                                {
                                    id: 'delete',
                                    label: t('vocab.custom.delete'),
                                    icon: <Trash2 />,
                                    testId: 'vocab-custom-delete',
                                    onSelect: () => setCustomDeleteOpen(true),
                                },
                            ]}
                        />
                    </div>
                </div>

                <WordbookToolbar
                    search={{
                        value: customQuery,
                        onChange: setCustomQuery,
                        placeholder: t('vocab.custom.search.placeholder'),
                        ariaLabel: t('vocab.custom.search.placeholder'),
                        testId: 'vocab-custom-search',
                        clearTestId: 'vocab-custom-search-clear',
                        clearLabel: t('vocab.custom.search.clear'),
                    }}
                    sort={{
                        value: customSort,
                        label: sortOptions.find((option) => option.value === customSort)?.label
                            ?? t('vocab.sort.alpha'),
                        options: sortOptions,
                        onChange: (value) => setCustomSort(value as CustomSort),
                        testId: 'vocab-custom-sort',
                        menuTestId: 'vocab-custom-sort-menu',
                    }}
                    filter={{
                        groups: [
                            {
                                id: 'level',
                                label: t('vocab.filter.level'),
                                options: levelFilterOptions(customLevel, 'vocab-custom-level')
                                    .filter((option) => option.value !== 'C1+'),
                            },
                            {
                                id: 'unmastered',
                                label: t('vocab.filter.unmastered'),
                                options: [
                                    { value: '', label: t('vocab.filter.all'), checked: !customUnmasteredOnly, testId: 'vocab-custom-unmastered-all' },
                                    { value: 'on', label: t('vocab.filter.unmastered'), checked: customUnmasteredOnly, testId: 'vocab-custom-unmastered' },
                                ],
                            },
                        ],
                        activeCount: filterActiveCount,
                        onChange: (key) => {
                            const [group, value] = key.split(':');
                            if (group === 'level') setCustomLevel(value as MineLevel);
                            else if (group === 'unmastered') setCustomUnmasteredOnly(value === 'on');
                        },
                        onClear: () => {
                            setCustomLevel('');
                            setCustomUnmasteredOnly(false);
                            setCustomQuery('');
                        },
                        testId: 'vocab-custom-filter',
                        clearTestId: 'vocab-custom-clear-filters',
                        menuTestId: 'vocab-custom-filter-menu',
                    }}
                    extra={hideChineseToggle('custom')}
                />

                {hideChinese && (
                    <p className="text-micro leading-relaxed text-fg-muted">{t('vocab.hint.hide')}</p>
                )}

                {customLoadPhase === 'error' ? (
                    <ErrorPanel
                        level="card"
                        title={t('vocab.custom.error.title')}
                        detail={customLoadError || t('vocab.custom.error.hint')}
                        onRetry={() => setCustomNonce((value) => value + 1)}
                        retryLabel={t('common.retry')}
                        testId="vocab-custom-error"
                        retryTestId="vocab-custom-retry"
                    />
                ) : customLoadPhase !== 'ready' ? (
                    <LoadingState
                        kind="skeleton"
                        rows={4}
                        label={t('vocab.custom.listLoading')}
                        testId="vocab-custom-loading"
                        className={`${LIST_CARD} px-4 py-6`}
                    />
                ) : sorted.length === 0 ? (
                    hasFilter
                        ? emptyState(
                            t('vocab.empty.title'),
                            t('vocab.empty.hint'),
                            Search,
                            'vocab-custom-empty',
                        )
                        : emptyState(
                            t('vocab.custom.empty.title'),
                            t('vocab.custom.empty.hint'),
                            Library,
                            'vocab-custom-empty',
                        )
                ) : (
                    <>
                        <span data-testid="vocab-custom-total" className="text-caption tabular-nums text-fg-muted">
                            {hasFilter
                                ? t('vocab.search.results', { count: formatNumber(sorted.length) })
                                : t('vocab.total', { count: formatNumber(customItems.length) })}
                        </span>
                        <WordTable
                            rows={rows}
                            hideChinese={hideChinese}
                            className={LIST_CARD}
                            listTestId="vocab-custom-list"
                            testIdPrefix="vocab-custom"
                            selectable={customEditMode}
                            ariaLabel={list.name}
                        />
                        <VocabPagination
                            scope="vocab"
                            page={currentPage}
                            pages={pages}
                            hasMore={currentPage < pages}
                            onChange={setCustomPage}
                            pageSize={pageSize}
                            onPageSizeChange={setPageSize}
                        />
                    </>
                )}

                {customEditMode && (
                    <div
                        data-testid="vocab-custom-edit-bar"
                        className="sticky bottom-0 z-chrome flex flex-wrap items-center gap-2 rounded-card border border-line-strong bg-surface/90 px-3 py-2 shadow-elev-2 backdrop-blur-xl"
                    >
                        <span
                            data-testid="vocab-custom-selected"
                            className="text-caption tabular-nums text-fg-strong"
                        >
                            {t('vocab.edit.selected', { count: formatNumber(customEditSelected.size) })}
                        </span>
                        <div className="ms-auto flex flex-wrap items-center gap-1.5">
                            <Button
                                size="sm"
                                variant="destructive"
                                iconLeft={<Trash2 />}
                                testId="vocab-custom-edit-delete"
                                loading={customEditBusy}
                                disabled={customEditBusy || customEditSelected.size === 0}
                                onClick={() => setCustomItemsDeleteOpen(true)}
                            >
                                {t('vocab.edit.delete')}
                            </Button>
                            <Button
                                size="sm"
                                variant="secondary"
                                testId="vocab-custom-edit-done"
                                disabled={customEditBusy}
                                onClick={resetCustomEdit}
                            >
                                {t('vocab.edit.done')}
                            </Button>
                        </div>
                        {customEditSummary && (
                            <p
                                role="alert"
                                data-testid="vocab-custom-edit-summary"
                                className="w-full text-caption leading-relaxed text-danger-fg"
                            >
                                {customEditSummary}
                            </p>
                        )}
                    </div>
                )}
            </div>
        );
    };

    const renderList = () => {
        const label = activeIsCefr
            ? t('vocab.tab.cefr')
            : activeList?.label || FALLBACK_LABELS[activeTab] || activeTab;
        const total = listData?.total ?? 0;
        const listPages = Math.max(1, Math.ceil(total / pageSize));
        const hasFilter = Boolean(debouncedQuery || listLevel);
        const totalLabel = hasFilter
            ? t('vocab.search.results', { count: formatNumber(total) })
            : t('vocab.total', { count: formatNumber(total) });
        const sortOptions: SortOption[] = [
            { value: 'default', label: t('vocab.sort.list'), testId: 'vocab-sort-list' },
        ];
        const levelCounts = activeIsCefr ? activeList?.byLevel : undefined;

        const rows: WordTableRow[] = (listData?.items ?? []).map((item, index) => {
            // Row key doubles as the write-state key and the test id suffix:
            // `<list id>:<word>`.
            const rowKey = `${activeTab}:${item.word}`;
            const wordKey = normalizeMasteryWord(item.word);
            const favored = favoritedWordKeys.has(wordKey);
            const isExpanded = Boolean(expanded[`list:${rowKey}`]);
            return {
                key: `${item.word}-${index}`,
                word: item.word,
                phonetic: item.phonetic,
                translation: item.translation,
                level: item.cefrLevel || '—',
                levelTitle: item.cefrLevel ? `CEFR ${item.cefrLevel}` : undefined,
                revealed: revealed.has(item.word),
                onActivate: hideChinese ? () => toggleReveal(item.word) : undefined,
                favored,
                favoriteLabel: favoriteLabelFor(item.word),
                onToggleFavorite: () => toggleRowFavorite({
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: activeTab,
                    sourceTitle: label,
                }),
                favoriteBusy: favoriteBusyKeys.has(wordKey),
                speakLabel: speakLabelFor(item.word),
                onSpeak: () => speakRow(item.word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(`list:${rowKey}`),
                detail: (
                    <div className="min-w-0 space-y-1">
                        <p className="text-micro text-fg-muted">{t('vocab.meaning.full')}</p>
                        <p className="break-words text-ui leading-relaxed text-fg-secondary">
                            {item.translation || '—'}
                        </p>
                        <p className="text-micro text-fg-muted">
                            {t('vocab.source.fromTitle', {
                                kind: t(SOURCE_LABEL_KEYS.wordlist),
                                title: label,
                            })}
                        </p>
                    </div>
                ),
                actions: rowAddActions({
                    rowKey,
                    word: item.word,
                    translation: item.translation,
                    phonetic: item.phonetic,
                    listId: activeTab,
                    listLabel: label,
                }),
                error: listRowErrors[rowKey]
                    ? {
                        message: listRowErrors[rowKey],
                        testId: `vocab-list-error-${item.word}`,
                    }
                    : undefined,
                testIds: {
                    star: `vocab-list-star-${rowKey}`,
                    speak: `${rowKey}-speak`,
                    expand: `vocab-list-expand-${rowKey}`,
                    detail: `vocab-list-detail-${rowKey}`,
                },
            };
        });

        return (
            <div data-testid="vocab-list-panel" className="flex flex-col gap-3">
                <WordbookToolbar
                    search={{
                        value: query,
                        onChange: setQuery,
                        placeholder: t('vocab.search.placeholder'),
                        ariaLabel: t('vocab.search.placeholder'),
                        testId: 'vocab-search',
                        clearTestId: 'vocab-search-clear',
                        clearLabel: t('vocab.search.clear'),
                    }}
                    sort={{
                        value: 'default',
                        label: t('vocab.sort.list'),
                        options: sortOptions,
                        onChange: () => undefined,
                        testId: 'vocab-sort',
                        menuTestId: 'vocab-sort-menu',
                    }}
                    filter={{
                        groups: [{
                            id: 'level',
                            label: t('vocab.filter.level'),
                            options: levelFilterOptions(listLevel as MineLevel, 'vocab-level', levelCounts)
                                .filter((option) => option.value !== 'C1+'),
                        }],
                        activeCount: Number(Boolean(listLevel)),
                        onChange: (key) => {
                            const [group, value] = key.split(':');
                            if (group === 'level') setListLevel(value as CefrLevel | '');
                        },
                        onClear: () => {
                            setListLevel('');
                            setQuery('');
                        },
                        testId: 'vocab-level-filter',
                        clearTestId: 'vocab-list-clear-filters',
                        menuTestId: 'vocab-level-filter-menu',
                    }}
                    extra={hideChineseToggle('list')}
                />

                {activeIsCefr && renderC2Note()}

                {hideChinese && (
                    <p className="text-micro leading-relaxed text-fg-muted">{t('vocab.hint.hide')}</p>
                )}

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-muted">
                    <span data-testid="vocab-total" className="tabular-nums">{totalLabel}</span>
                    <span>{label}</span>
                    {activeList?.approximate && (
                        <Badge tone="neutral">{t('vocab.approximate')}</Badge>
                    )}
                </div>

                {listPhase === 'loading' && (
                    <div data-testid="vocab-loading" className={`${LIST_CARD} flex items-center justify-center gap-2 py-16 text-ui text-fg-muted`}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('common.loading')}
                    </div>
                )}

                {listPhase === 'error' && (
                    <div data-testid="vocab-error" className={`${LIST_CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                        <AlertTriangle className="mb-3 h-10 w-10 text-warning-fg/70" aria-hidden="true" />
                        <p className="text-ui font-medium text-fg-strong">{t('vocab.error.title')}</p>
                        <p className="mt-1 max-w-md break-words text-caption text-fg-muted">
                            {listError || t('vocab.error.hint')}
                        </p>
                        <Button
                            size="sm"
                            variant="secondary"
                            testId="vocab-retry"
                            onClick={() => setListNonce((value) => value + 1)}
                            className="mt-5"
                        >
                            {t('common.retry')}
                        </Button>
                    </div>
                )}

                {listPhase === 'ready' && listData && (
                    listData.items.length === 0 ? (
                        emptyState(
                            hasFilter ? t('vocab.empty.title') : t('vocab.empty.list'),
                            hasFilter ? t('vocab.empty.hint') : t('vocab.empty.listHint'),
                            Search,
                            'vocab-empty',
                        )
                    ) : (
                        <>
                            <WordTable
                                rows={rows}
                                hideChinese={hideChinese}
                                className={LIST_CARD}
                                listTestId="vocab-word-list"
                                testIdPrefix="vocab-list"
                                ariaLabel={label}
                            />
                            <VocabPagination
                                scope="vocab"
                                page={page}
                                pages={listPages}
                                hasMore={listData.hasMore}
                                onChange={setPage}
                                pageSize={pageSize}
                                onPageSizeChange={setPageSize}
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
                {customListsPhase === 'error' && (
                    <ErrorPanel
                        level="inline"
                        title={t('vocab.custom.error.title')}
                        detail={customListsError || t('vocab.custom.error.hint')}
                        onRetry={() => setCustomListsNonce((value) => value + 1)}
                        retryLabel={t('common.retry')}
                        testId="vocab-custom-lists-error"
                        retryTestId="vocab-custom-lists-retry"
                    />
                )}
                {renderTabs()}
                <div {...tabPanelProps('vocab', activeTab)}>
                    {renderTabPanel()}
                </div>
            </div>
            </div>

            {/* Custom word lists (specs/038). The wizard owns the three steps;
                both confirmations reuse the one shared ConfirmDialog. */}
            <WordlistImportDialog
                open={importOpen}
                onClose={() => setImportOpen(false)}
                existingNames={customLists.map((entry) => entry.name)}
                listCount={customLists.length}
                onImported={(list) => {
                    setCustomLists((prev) => (
                        prev.some((entry) => entry.id === list.id)
                            ? prev.map((entry) => (entry.id === list.id ? list : entry))
                            : [...prev, list]
                    ));
                    setCustomListsPhase('ready');
                    setCustomListsError('');
                    setActiveTab(customTabId(list.id));
                    setCustomQuery('');
                    setCustomPage(1);
                    setCustomRevealed(new Set());
                    setCustomSort('alpha');
                    setCustomLevel('');
                    setCustomUnmasteredOnly(false);
                    setCustomLoadPhase('idle');
                    setCustomItems([]);
                    setCustomListsNonce((value) => value + 1);
                }}
            />

            <ConfirmDialog
                open={customItemsDeleteOpen && activeCustomList != null}
                title={t('vocab.edit.deleteTitle', { count: formatNumber(customEditSelected.size) })}
                description={t('vocab.edit.deleteDesc')}
                confirmLabel={t('vocab.edit.deleteConfirm', { count: formatNumber(customEditSelected.size) })}
                onConfirm={handleDeleteCustomItems}
                onClose={() => setCustomItemsDeleteOpen(false)}
                testId="vocab-custom-items-delete"
            />

            <Dialog
                open={renameOpen}
                onClose={() => { if (!renameBusy) setRenameOpen(false); }}
                title={t('vocab.custom.renameTitle')}
                description={t('vocab.custom.renameHint')}
                size="sm"
                initialFocus='[data-testid="vocab-custom-rename-input"]'
                testId="vocab-custom-rename-dialog"
                footer={(
                    <>
                        <Button
                            variant="secondary"
                            testId="vocab-custom-rename-cancel"
                            disabled={renameBusy}
                            onClick={() => setRenameOpen(false)}
                            className="w-full sm:w-auto"
                        >
                            {t('common.cancel')}
                        </Button>
                        <Button
                            variant="primary"
                            testId="vocab-custom-rename-save"
                            loading={renameBusy}
                            onClick={() => { void submitRename(); }}
                            className="w-full sm:w-auto"
                        >
                            {t('vocab.custom.renameSave')}
                        </Button>
                    </>
                )}
            >
                <label className="block space-y-1.5">
                    <span className="text-caption font-medium text-fg-strong">
                        {t('vocab.custom.renameLabel')}
                    </span>
                    <input
                        type="text"
                        data-testid="vocab-custom-rename-input"
                        value={renameName}
                        maxLength={80}
                        disabled={renameBusy}
                        onChange={(event) => setRenameName(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key !== 'Enter') return;
                            event.preventDefault();
                            void submitRename();
                        }}
                        className="h-control-md w-full rounded-control border border-line-subtle bg-surface-2/60 px-3 text-ui text-fg-primary placeholder:text-fg-muted"
                    />
                </label>
                {renameError && (
                    <p role="alert" data-testid="vocab-custom-rename-error" className="mt-2 text-caption leading-relaxed text-danger-fg">
                        {renameError}
                    </p>
                )}
            </Dialog>

            <ConfirmDialog
                open={customDeleteOpen && activeCustomList != null}
                title={t('vocab.custom.deleteTitle', { name: activeCustomList?.name ?? '' })}
                description={t('vocab.custom.deleteDesc')}
                confirmLabel={t('vocab.custom.deleteConfirm')}
                onConfirm={handleDeleteCustomList}
                onClose={() => setCustomDeleteOpen(false)}
                testId="vocab-custom-delete-confirm"
            />

            {REVIEW_UI_ENABLED && (
                <ConfirmDialog
                    open={customAddAllOpen && activeCustomList != null}
                    title={t('vocab.custom.addAllTitle', { name: activeCustomList?.name ?? '' })}
                    description={t('vocab.custom.addAllDesc', {
                        count: formatNumber(activeCustomList?.itemCount ?? 0),
                    })}
                    confirmLabel={t('vocab.custom.addAllConfirm')}
                    destructive={false}
                    onConfirm={handleAddAllCustomToReview}
                    onClose={() => setCustomAddAllOpen(false)}
                    testId="vocab-custom-add-all-confirm"
                />
            )}
        </div>
    );
}
