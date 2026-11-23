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
// (P0-14) is shared by every surface: the toolbar's 编辑 button opens a leading
// checkbox column + a sticky 已选 N / actions / 完成 bar; switching tabs or 完成
// exits and clears the selection, and the row star/check are disabled while it
// is on.
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
    Upload,
    type LucideIcon,
} from 'lucide-react';
import {
    exportAnkiTsv,
    exportCsv,
    exportTable,
    type ExportColumn,
} from '../lib/exporter';
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
    type VocabularyEntry,
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
    WordFamilyTable,
    fetchWordFamilyPage,
    WordbookToolbar,
    WordTable,
    normalizePhonetic,
    type FilterGroup,
    type FilterOption,
    type SortOption,
    type WordFamilyMember,
    type WordFamilyMemberState,
    type WordFamilyPage,
    type WordFamilyRow,
    type WordFamilySort,
    type WordRowAction,
    type WordTableRow,
    type WordTableSelectAll,
} from './VocabularyRows';
import { Badge } from './ui/Badge';
import { PageContainer } from './layout/PageContainer';
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
     * P1-10: App-owned optimistic add for every new favorite this screen
     * writes (built-in lists / phrases / custom lists / word-family members /
     * 加入收藏 batch). App inserts it into its single favorites list — so the
     * top-bar 单词本 count and 我的收藏 update without a refresh — posts it and
     * rolls it back on failure. Resolves with the stored favorite; rejects with
     * the API error after rolling back, so this screen can report it inline the
     * way it always has. Without it (standalone use) the screen keeps its local
     * overlay path.
     */
    onAddFavorite?: (draft: FavoriteDraft) => Promise<FavoriteItem>;
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
type MasteredSort = 'added' | 'alpha' | 'level';
type CustomSort = 'alpha' | 'level';
type MineType = '' | 'word' | 'phrase';
type MineLevel = '' | CefrLevel | 'C1+';
type SeenPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Review-state read: `unavailable` hides the 已在复习 row state (403/404), never an error. */
type StateFilterPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Row-level add state for the built-in lists / phrases (idempotent writes). */
type RowAddState = 'idle' | 'busy' | 'added';
/** P0-14 edit-mode batch actions; the active tab decides which are available. */
type EditAction = 'unfavorite' | 'favorite' | 'master' | 'unmaster' | 'delete';
/** One selected row snapshot handed to the sequential batch runner. */
interface EditEntry {
    key: string;
    word: string;
    run: () => Promise<void>;
}
/** P0-15: one row's batch handlers, kept after the row leaves the rendered page. */
type EditRowActions = Partial<Record<EditAction, () => Promise<void>>>;
/** P0-15: key→word/handlers map so a cross-page batch can run unrendered rows. */
interface EditRowRegistration {
    key: string;
    word: string;
    actions: EditRowActions;
}
/** One bottom-bar action for the active tab's operation matrix. */
interface EditBarAction {
    key: EditAction;
    label: string;
    icon: LucideIcon;
    testId: string;
    destructive?: boolean;
    onSelect: () => void;
}
/** Custom-list catalog: `unavailable` = 403/404 → hide the surface, no error. */
type CustomListsPhase = 'idle' | 'loading' | 'ready' | 'error' | 'unavailable';

const MINE_TAB = 'mine';
/** 已掌握 is a word list of its own, not a segment inside 我的单词 (specs/005). */
const MASTERED_TAB = 'mastered';
const PHRASES_TAB = 'phrases';
/** Merged CEFR list id (`GET /api/vocabulary/lists/cefr`); A1–C1 in one tab. */
const CEFR_TAB = 'cefr';
/** specs/041: read-only CEFR 10k word family list, after CET6 (custom lists follow). */
const WORD_FAMILY_TAB = 'word-family';
/** Product order: 我的单词 / 已掌握 / 短语 / CEFR 词表 / GRE / CET4 / CET6 / 词族. */
const LIST_TAB_IDS = [CEFR_TAB, 'gre', 'cet4', 'cet6', WORD_FAMILY_TAB] as const;
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
/** P0-16: file-name-safe list token; non-ASCII names fall back to the list id. */
const fileSlug = (value: string): string => (
    value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
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
/** P0-14: success toast per batch action (the count is the completed rows). */
const EDIT_DONE_KEYS: Record<EditAction, TranslationKey> = {
    unfavorite: 'vocab.edit.unfavoriteDone',
    favorite: 'vocab.edit.favoriteDone',
    master: 'vocab.edit.masterDone',
    unmaster: 'vocab.edit.unmasterDone',
    delete: 'vocab.edit.deleteDone',
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
    onAddFavorite,
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
    // App owns the favorites list. New favorites go through `onAddFavorite`
    // (P1-10) so App's copy — and the top-bar count — is updated immediately.
    // These two local overlays are the standalone fallback only (no callback
    // supplied): `addedFavorites` are favorites this screen created itself,
    // `deletedIds` are ones it deleted. Both are merged (and de-duplicated by
    // id) with the prop, so the screen never shows a word it just added as
    // "missing" and never resurrects a row it just deleted. The word book never
    // mutates the prop.
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
    const activeIsWordFamily = activeTab === WORD_FAMILY_TAB;
    const activeCustomListId = customListId(activeTab);
    const activeCustomList = activeCustomListId
        ? customLists.find((entry) => entry.id === activeCustomListId) ?? null
        : null;
    const activeIsCustom = activeCustomList != null;
    const activeList = activeIsMine || activeIsMastered || activeIsCustom || activeIsWordFamily
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
    // P0-16: default 已掌握 order is 加入时间 (newest first); `createdAt` comes
    // from GET /api/review/words (guests have no server row → 0, alphabetical).
    const [masteredSort, setMasteredSort] = useState<MasteredSort>('added');
    const [masteredCreatedAt, setMasteredCreatedAt] = useState<Record<string, number>>({});
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
    /**
     * Synchronous in-flight guard for star writes: two clicks in the same tick
     * read the same render state, so the Set above cannot stop the second POST.
     */
    const favoriteWriteInFlight = useRef<Set<string>>(new Set());

    // ── v1.2: search / row adds ────────────────────────────────────────────
    // 状态 reads still power the (hidden) 已在复习 row state; while the review
    // UI is paused no request is made and the row action stays hidden.
    const [wordStates, setWordStates] = useState<Record<string, ReviewWordState>>({});
    const [statePhase, setStatePhase] = useState<StateFilterPhase>('idle');
    const [mineQuery, setMineQuery] = useState('');
    const [mineDebouncedQuery, setMineDebouncedQuery] = useState('');
    const [minePage, setMinePage] = useState(1);
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
    /** P0-16: the list whose export is fetching all rows (its buttons disable). */
    const [exportBusy, setExportBusy] = useState<string | null>(null);
    /** Synchronous in-flight guard: two clicks in one tick read the same render state. */
    const exportInFlight = useRef(false);
    const [renameOpen, setRenameOpen] = useState(false);
    const [renameName, setRenameName] = useState('');
    const [renameBusy, setRenameBusy] = useState(false);
    const [renameError, setRenameError] = useState('');

    // ── Edit mode shared by every word list (P0-14) ───────────────────────
    // One mode at a time: switching tabs exits editing and clears the selection
    // (specs/005 §编辑模式). Selection keys are the row's stable identity on the
    // active surface (`fav.id` / normalized mastered word / list row key /
    // phrase id / custom item key).
    const [editMode, setEditMode] = useState(false);
    const [editSelected, setEditSelected] = useState<Set<string>>(() => new Set());
    const [editRunning, setEditRunning] = useState<EditAction | null>(null);
    const [editSummary, setEditSummary] = useState<string | null>(null);
    const [editErrors, setEditErrors] = useState<Record<string, string>>({});
    const [editDeleteOpen, setEditDeleteOpen] = useState(false);
    const editBusy = editRunning != null;
    /**
     * Synchronous in-flight guard: two rapid clicks read the same render state,
     * so `editBusy` alone cannot stop the second batch.
     */
    const editRunInFlight = useRef(false);
    /**
     * P0-15: every selected row's handlers, keyed by the same stable key as
     * `editSelected`. It survives pagination so a batch can run the rows that
     * are no longer rendered; search/filter/sort/tab changes clear it with the
     * selection.
     */
    const editRows = useRef<Map<string, EditRowRegistration>>(new Map());
    /** 全选 on a server-paged list is fetching every page (loading + disabled). */
    const [editAllLoading, setEditAllLoading] = useState(false);
    const [editAllError, setEditAllError] = useState<string | null>(null);
    /** Invalidates an in-flight select-all when the view/selection changes. */
    const editAllToken = useRef(0);

    const masteredWords = isGuest ? guestMastered : serverMastered;

    // Guest marks come from the local table; re-read on an account switch so a
    // guest claim never mixes the two sources.
    useEffect(() => {
        if (!isGuest) return;
        setGuestMastered(readGuestMastered());
    }, [isGuest]);

    // Signed-in 已掌握 list: fetch the server list when 我的单词 or 已掌握 opens
    // (and on retry), plus the 词族 tab now that its members carry the check
    // (P1-07) — the check state must be right before the first member click.
    // Actions afterwards update `serverMastered` from the PATCH response instead
    // of refetching — one authoritative source, no reload.
    useEffect(() => {
        if ((!activeIsMine && !activeIsMastered && !activeIsWordFamily) || isGuest) {
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
                // P0-16: the server row's `createdAt` is the 加入时间 sort key.
                setMasteredCreatedAt(Object.fromEntries(
                    data.words.map((word) => [
                        normalizeMasteryWord(word.lemma),
                        typeof word.createdAt === 'number' && Number.isFinite(word.createdAt)
                            ? word.createdAt
                            : 0,
                    ]),
                ));
                setMasteredReady(true);
                setMasteredPhase('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setMasteredPhase('error');
            });
        return () => { cancelled = true; };
    }, [activeIsMine, activeIsMastered, activeIsWordFamily, isGuest, targetLang, masteredNonce]);

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
     * Remember the meaning captured at mark time. P0-13 persists it through the
     * PATCH `definition` snapshot, while this session overlay keeps the row
     * readable immediately (the refreshed GET snapshot wins when it lands).
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

    /**
     * P0-16: remember when the server says a word joined 已掌握, so a row marked
     * in this session sorts by 加入时间 before the next list refresh.
     */
    const rememberMasteredCreatedAt = (lemma: string, createdAt: number | undefined) => {
        const key = normalizeMasteryWord(lemma);
        if (!key || typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt <= 0) {
            return;
        }
        setMasteredCreatedAt((prev) => (
            prev[key] === createdAt ? prev : { ...prev, [key]: createdAt }
        ));
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

    /**
     * Accessible name of the row's 已掌握 check (P0-10): the pressed state is
     * the mark itself, so the name flips to 取消已掌握. Guests keep the local
     * 「我会了」 wording — that surface is not called 已掌握 (specs/005).
     */
    const masteredLabelFor = useCallback((word: string, mastered: boolean): string => {
        if (isGuest) {
            return `${mastered ? t('vocab.review.undo') : t('vocab.review.guestMaster')} ${word}`;
        }
        return mastered
            ? t('vocab.row.unmaster', { word })
            : t('vocab.row.master', { word });
    }, [isGuest, t]);

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
        const rows: Array<{
            key: string;
            word: string;
            phonetic: string;
            translation: string;
            /** P0-16: 加入时间 for the default `added` sort (0 when unknown). */
            createdAt: number;
        }> = [];
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
                createdAt: masteredCreatedAt[key] ?? 0,
            });
        }
        rows.sort((a, b) => (
            a.word.toLowerCase().localeCompare(b.word.toLowerCase()) || a.word.localeCompare(b.word)
        ));
        return rows;
    }, [masteredWords, favoriteByWord, masteredLabels, masteredSnapshots, masteredCreatedAt]);

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

    // ── P0-16: list exports (TSV / CSV) ───────────────────────────────────
    /** Level shown in an export: same truth as the badge, empty while unknown. */
    const exportLevelFor = useCallback((word: string): string => {
        if (!(word in levels)) return '';
        const level = levels[word];
        return level ?? 'C1+';
    }, [levels]);

    /**
     * Run one list export. The caller must build the **complete** current result
     * set (current search/filter/sort, every page) before this downloads: a
     * failure surfaces one toast and never writes a partial file. `scope`
     * disables the buttons while the (possibly multi-page) fetch is running.
     */
    const runListExport = async (scope: string, task: () => Promise<void> | void) => {
        if (exportInFlight.current) return;
        exportInFlight.current = true;
        setExportBusy(scope);
        try {
            await task();
        } catch (error) {
            let message = t('vocab.export.failed');
            if (error instanceof Error && error.message.trim()) {
                message = error.message;
            } else {
                const described = await describeApiError(error).catch(() => '');
                if (described) message = described;
            }
            toast.error(message, { dedupeKey: 'vocab:export' });
        } finally {
            exportInFlight.current = false;
            setExportBusy(null);
        }
    };

    /** One list's TSV + CSV pair, rendered in the shared panel toolbar. */
    const exportButtons = (input: {
        scope: string;
        tsvTestId: string;
        csvTestId: string;
        disabled: boolean;
        onTsv: () => void;
        onCsv: () => void;
    }) => {
        const busy = exportBusy === input.scope;
        const disabled = input.disabled || exportBusy != null;
        return (
            <div className="flex items-center gap-1.5" data-testid={`${input.tsvTestId}-group`}>
                <button
                    type="button"
                    data-testid={input.tsvTestId}
                    onClick={input.onTsv}
                    disabled={disabled}
                    aria-busy={busy || undefined}
                    aria-label={t('favorites.exportAnki')}
                    title={t('vocab.export.tsvTitle')}
                    className={ACTION_BUTTON}
                >
                    {busy
                        ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        : <Download className="h-3.5 w-3.5" aria-hidden="true" />}
                    <span className="hidden sm:inline">{t('favorites.exportAnki')}</span>
                </button>
                <button
                    type="button"
                    data-testid={input.csvTestId}
                    onClick={input.onCsv}
                    disabled={disabled}
                    aria-busy={busy || undefined}
                    aria-label={t('favorites.exportCsv')}
                    title={t('vocab.export.csvTitle')}
                    className={ACTION_BUTTON}
                >
                    <FileSpreadsheet className="h-3.5 w-3.5" aria-hidden="true" />
                    <span className="hidden sm:inline">{t('favorites.exportCsv')}</span>
                </button>
            </div>
        );
    };

    // ── 加入复习 (built-in lists + phrases) ────────────────────────────────
    // No 加入我的单词 write lives here: saving/unsaving is the row star on
    // every surface (specs/005 §统一词表 UI). The review write stays idempotent
    // and is hidden while REVIEW_UI_ENABLED=false.
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
     * Shared 加入复习 descriptor for the list/phrase rows. There is deliberately
     * no save/favorite action here: 加入我的单词 was removed (P0-09) because the
     * row star is the one favorite toggle on every surface (specs/005 §统一词表 UI).
     */
    const rowReviewActions = (input: {
        rowKey: string;
        word: string;
        listId: string;
        definition?: string | null;
    }): WordRowAction[] => {
        // specs/038 (2026-11-22): the custom-list surface hides 加入复习 while
        // the review UI is paused; the interface + definition snapshot stay.
        // specs/005/013: the same pause hides it on the built-in lists/phrases.
        if (!REVIEW_UI_ENABLED) return [];
        const reviewState = rowReviewAddState(input.rowKey, input.word);
        const reviewLabel = reviewState === 'added' ? t('vocab.review.added') : t('vocab.review.add');
        return [{
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
        }];
    };

    /**
     * 已掌握 toggle of a fixed word-list row (内置词表 / 短语 / 自定义词表),
     * P0-10: the row check is the only mastery control and its pressed state is
     * the source of truth. Marking PATCHes mastered=true and, per the mutual
     * exclusion invariant (specs/005 §已掌握与收藏互斥), removes the same word's
     * favorite; if that removal fails the mark is rolled back and an inline,
     * retryable row error appears instead of a success-looking row. Unmarking
     * only clears `word_states.mastered` and never refills the favorite
     * (ADR-0001). Idempotent; one row writes at a time.
     */
    /**
     * Mastered write for one fixed-list row (内置词表 / 短语 / 自定义词表).
     * Shared by the row check and the P0-14 batch action; throws a localized
     * Error so the caller can keep the row selected and show it inline.
     */
    const applyListWordMastered = async (input: {
        rowKey: string;
        word: string;
        /** Meaning snapshot captured for the 已掌握 tab (word-list translation). */
        translation?: string | null;
        phonetic?: string | null;
        listId: string;
    }, mastered: boolean): Promise<void> => {
        const key = normalizeMasteryWord(input.word);
        const lemma = input.word.trim();
        if (!key || !lemma) throw new Error(t('vocab.review.error.mastered'));
        let masteredNow: boolean;
        let createdAt: number | undefined;
        try {
            const result = await setWordMastered({
                lemma,
                mastered,
                targetLang,
                source: { contentRef: input.listId },
                // P0-13: snapshot the row's meaning on mark (only when known);
                // the backend fills an empty definition and never overwrites.
                ...(mastered && input.translation?.trim()
                    ? { definition: input.translation.trim() }
                    : {}),
            });
            // The PATCH response is authoritative for the post-write mark.
            masteredNow = result.word.mastered === true;
            createdAt = result.word.createdAt;
        } catch {
            throw new Error(t('vocab.review.error.mastered'));
        }
        writeMasteredState(lemma, masteredNow);
        if (masteredNow) rememberMasteredCreatedAt(lemma, createdAt);
        onMasteredChange?.(lemma, masteredNow);
        if (!mastered) {
            if (masteredNow) throw new Error(t('vocab.review.error.mastered'));
            return;
        }
        if (!masteredNow) throw new Error(t('vocab.review.error.mastered'));
        rememberMasteredSnapshot({
            lemma,
            word: input.word,
            phonetic: input.phonetic,
            translation: input.translation,
        });
        const favorite = favoriteByWord.get(key);
        if (!favorite) return;
        // A mastered word is not a favorite: remove the record. A failed DELETE
        // rolls the mark back instead of leaving the word in both worlds.
        const removed = await deleteFavoriteById(favorite.id);
        if (removed) return;
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
        throw new Error(t(rolledBack
            ? 'vocab.review.error.masteredFavorite'
            : 'vocab.review.error.mastered'));
    };

    const toggleListRowMastered = async (input: {
        rowKey: string;
        word: string;
        translation?: string | null;
        phonetic?: string | null;
        listId: string;
    }) => {
        const key = normalizeMasteryWord(input.word);
        if (!key || masterAdds[input.rowKey] === 'busy') return;
        if (isGuest) {
            openLogin();
            return;
        }
        if (!input.word.trim()) return;
        const next = !masteredWords.has(key);
        const clearRowError = () => setListRowErrors((prev) => {
            if (!(input.rowKey in prev)) return prev;
            const nextErrors = { ...prev };
            delete nextErrors[input.rowKey];
            return nextErrors;
        });
        setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'busy' }));
        clearRowError();
        try {
            await applyListWordMastered(input, next);
            setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
            toast.success(
                next ? t('vocab.review.toast.mastered') : t('vocab.review.toast.unmastered'),
                { dedupeKey: 'review:fav-mastered' },
            );
        } catch (error) {
            setMasterAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
            setListRowErrors((prev) => ({
                ...prev,
                [input.rowKey]: editErrorText(error),
            }));
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

    /**
     * Mark/unmark one 我的收藏 row (P0-14 shares the mark path with the batch
     * runner). Marking PATCHes mastered=true with the meaning snapshot and then
     * DELETEs the favorite (specs/005 §已掌握与收藏互斥); a failed removal rolls
     * the mark back rather than leave the word in both worlds. Throws a
     * localized Error — the row handler shows it inline, the batch keeps the
     * failed row selected.
     */
    const applyFavoriteMastered = async (fav: FavoriteItem, mastered: boolean): Promise<void> => {
        const lemma = fav.en_text.trim();
        if (!lemma) throw new Error(t('vocab.review.error.mastered'));
        const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
        let masteredNow: boolean;
        let createdAt: number | undefined;
        try {
            const result = await setWordMastered({
                lemma,
                mastered,
                targetLang,
                source: reviewSourceFor(fav),
                // P0-13: favorite rows keep IPA in zh_text; snapshot only the
                // meaning part (same split the row displays), never the IPA.
                ...(mastered && meaning ? { definition: meaning } : {}),
            });
            // The PATCH response is authoritative for the post-write mark.
            masteredNow = result.word.mastered === true;
            createdAt = result.word.createdAt;
        } catch {
            throw new Error(t('vocab.review.error.mastered'));
        }
        writeMasteredState(lemma, masteredNow);
        if (masteredNow) rememberMasteredCreatedAt(lemma, createdAt);
        onMasteredChange?.(lemma, masteredNow);
        if (!mastered) {
            if (masteredNow) throw new Error(t('vocab.review.error.mastered'));
            return;
        }
        if (!masteredNow) throw new Error(t('vocab.review.error.mastered'));
        rememberMasteredSnapshot({
            lemma,
            word: lemma,
            phonetic: ipa,
            translation: meaning,
        });
        const removed = await deleteFavoriteById(fav.id);
        if (removed) return;
        // Undo the mark so a word is never both mastered and saved. The message
        // only claims a rollback if it actually succeeded.
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
        throw new Error(t(rolledBack
            ? 'vocab.review.error.masteredFavorite'
            : 'vocab.review.error.mastered'));
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
        try {
            await applyFavoriteMastered(fav, next);
            toast.success(
                next ? t('vocab.review.toast.mastered') : t('vocab.review.toast.unmastered'),
                { dedupeKey: 'review:fav-mastered' },
            );
        } catch (error) {
            setRowError({ id: fav.id, message: editErrorText(error) });
        } finally {
            setPendingMasteredId(null);
        }
    };

    /**
     * Clear one 已掌握 row's mark (optimistic; a failed PATCH rolls the row back
     * into the table). Shared by the row check and the P0-14 batch action.
     */
    const unmasterWordRow = async (row: { key: string; word: string }): Promise<void> => {
        const lemma = row.word.trim();
        if (!lemma) throw new Error(t('vocab.review.error.mastered'));
        const fav = favoriteByWord.get(row.key);
        writeMasteredState(lemma, false);
        // Guests only write the local table; there is nothing to PATCH.
        if (isGuest) return;
        try {
            const result = await setWordMastered({
                lemma,
                mastered: false,
                targetLang,
                ...(fav ? { source: reviewSourceFor(fav) } : {}),
            });
            // The PATCH response is authoritative for the post-write mark.
            const masteredNow = result.word.mastered === true;
            writeMasteredState(lemma, masteredNow);
            onMasteredChange?.(lemma, masteredNow);
            if (masteredNow) throw new Error(t('vocab.review.error.mastered'));
        } catch (error) {
            writeMasteredState(lemma, true); // roll the row back into the table
            onMasteredChange?.(lemma, true);
            throw error instanceof Error
                ? error
                : new Error(t('vocab.review.error.mastered'));
        }
    };

    /**
     * 已掌握 row action: move a word back by clearing its mastered mark.
     * Optimistic (the row leaves the table now), rolled back with an inline
     * row error if the write fails — same feedback model as the mine rows.
     */
    const handleMasteredRowUndo = async (row: { key: string; word: string }) => {
        if (pendingReviewId || pendingMasteredId) return;
        if (!row.word.trim()) return;
        setRowError(null);
        setPendingMasteredId(`mastered:${row.key}`);
        try {
            await unmasterWordRow(row);
            toast.success(t('vocab.review.toast.unmastered'), { dedupeKey: 'review:fav-mastered' });
        } catch (error) {
            setRowError({ id: `mastered:${row.key}`, message: editErrorText(error) });
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
        if (favoriteBusyKeys.has(key) || favoriteWriteInFlight.current.has(key)) return;
        favoriteWriteInFlight.current.add(key);
        const release = () => {
            favoriteWriteInFlight.current.delete(key);
            markFavoriteBusy(fav.en_text, false);
        };
        markFavoriteBusy(fav.en_text, true);
        if (favorites.some((entry) => entry.id === fav.id)) {
            // App owns the DELETE; release the synchronous guard when it settles
            // so a second click in the same tick cannot send a duplicate DELETE.
            const result = onRemoveFavorite(fav.id);
            void Promise.resolve(result).then(release, release);
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
            .finally(release);
    };

    /**
     * Favorite one row (词表 / 短语 / 已掌握 star + P0-14 加入收藏). With
     * `onAddFavorite` (P1-10) App owns the optimistic insert, the POST and the
     * rollback, so the favorites prop — and therefore the top-bar 单词本 count
     * and 我的收藏 — updates immediately; the local overlay is only the
     * standalone fallback. Resolves `true` only when a favorite was written;
     * `false` covers guests and rows that are already saved (idempotent no-op).
     * Failures are rethrown so the caller can report them as a toast or a row
     * error (batch mode keeps the row selected).
     */
    const persistFavoriteForRow = async (input: {
        word: string;
        phonetic?: string | null;
        translation?: string | null;
        example?: string | null;
        sourceKind?: FavoriteSourceKind;
        sourceRef?: string;
        sourceTitle?: string;
    }): Promise<boolean> => {
        if (isGuest) {
            openLogin();
            return false;
        }
        const word = input.word.trim();
        if (!word) throw new Error(t('vocab.edit.rowFailed'));
        const key = normalizeMasteryWord(word);
        if (!key) throw new Error(t('vocab.edit.rowFailed'));
        // Already saved / another write in flight is a no-op, never a duplicate.
        if (favoritedWordKeys.has(key) || favoriteBusyKeys.has(key)
            || favoriteWriteInFlight.current.has(key)) return false;
        favoriteWriteInFlight.current.add(key);
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
        // App-owned writes are already optimistic on App's side: adding a local
        // overlay too would duplicate the row until App's copy replaces it.
        const optimistic: FavoriteItem | null = onAddFavorite ? null : { ...draft };
        if (optimistic) setAddedFavorites((prev) => [...prev, optimistic]);
        markFavoriteBusy(word, true);
        try {
            const saved = onAddFavorite ? await onAddFavorite(draft) : await addFavorite(draft);
            if (optimistic) {
                setAddedFavorites((prev) => prev.map((entry) => (
                    entry.id === optimistic.id ? saved : entry
                )));
            }
            setDeletedFavoriteIds((prev) => {
                if (!prev.has(saved.id)) return prev;
                const next = new Set(prev);
                next.delete(saved.id);
                return next;
            });
            return true;
        } catch (error) {
            if (optimistic) {
                setAddedFavorites((prev) => prev.filter((entry) => entry.id !== optimistic.id));
            }
            throw error;
        } finally {
            favoriteWriteInFlight.current.delete(key);
            markFavoriteBusy(word, false);
        }
    };

    /** Row-star wrapper: one success toast, API failures stay in a toast. */
    const addFavoriteForRow = async (input: {
        word: string;
        phonetic?: string | null;
        translation?: string | null;
        example?: string | null;
        sourceKind?: FavoriteSourceKind;
        sourceRef?: string;
        sourceTitle?: string;
    }) => {
        try {
            if (await persistFavoriteForRow(input)) {
                toast.success(t('vocab.toast.added'), { dedupeKey: 'favorites:added' });
            }
        } catch (error) {
            toast.error(await describeApiError(error));
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

    // ── P1-07: 词族成员逐词收藏 / 标已掌握 ────────────────────────────────
    // The family row stays read-only; its members are ordinary word rows. The
    // star writes a wordlist favorite with the family provenance
    // (`source_ref='word-family:<id>'`) and rolls back on failure; the check is
    // the shared mastered write, which also removes the same word's favorite
    // (specs/005 §已掌握与收藏互斥). Both report failures inline on the member
    // row, and repeat clicks stay idempotent through the shared guards.
    const familyMemberRowKey = (familyId: string, lemma: string): string => (
        `family-member:${familyId}:${normalizeMasteryWord(lemma)}`
    );

    const clearFamilyMemberError = (rowKey: string) => {
        setListRowErrors((prev) => {
            if (!(rowKey in prev)) return prev;
            const next = { ...prev };
            delete next[rowKey];
            return next;
        });
    };

    /** One expanded member's favorite/mastered state (screen owns the data). */
    const familyMemberState = (
        row: WordFamilyRow,
        member: WordFamilyMember,
    ): WordFamilyMemberState => {
        const key = normalizeMasteryWord(member.lemma);
        const rowKey = familyMemberRowKey(row.id, member.lemma);
        const favored = favoritedWordKeys.has(key);
        const mastered = masteredWords.has(key);
        return {
            favorited: favored,
            favoriteBusy: favoriteBusyKeys.has(key),
            // 已掌握 is not a favorite: the star disables until the check is
            // switched off (P0-10), exactly like the other word lists.
            favoriteDisabled: mastered,
            favoriteLabel: mastered
                ? t('vocab.mastered.starDisabled', { word: member.lemma })
                : favoriteLabelFor(member.lemma),
            mastered,
            masteredBusy: masterAdds[rowKey] === 'busy',
            masteredLabel: masteredLabelFor(member.lemma, mastered),
            error: listRowErrors[rowKey],
        };
    };

    /** Member star: POST when unsaved, DELETE when saved; inline on failure. */
    const toggleFamilyMemberFavorite = (
        row: WordFamilyRow,
        member: WordFamilyMember,
    ) => {
        if (isGuest) {
            openLogin();
            return;
        }
        const lemma = member.lemma.trim();
        const key = normalizeMasteryWord(lemma);
        if (!key) return;
        const rowKey = familyMemberRowKey(row.id, lemma);
        if (favoriteBusyKeys.has(key) || favoriteWriteInFlight.current.has(key)) return;
        clearFamilyMemberError(rowKey);
        const existing = favoriteByWord.get(key);
        if (existing) {
            // The star fills/unfills optimistically through the App-owned
            // handler; a failed DELETE resolves false and the star rolls back.
            favoriteWriteInFlight.current.add(key);
            markFavoriteBusy(lemma, true);
            void deleteFavoriteById(existing.id)
                .then((removed) => {
                    if (!removed) throw new Error(t('vocab.edit.rowFailed'));
                    toast.success(t('vocab.toast.removed'), { dedupeKey: 'favorites:removed' });
                })
                .catch((error) => {
                    setListRowErrors((prev) => ({ ...prev, [rowKey]: editErrorText(error) }));
                })
                .finally(() => {
                    favoriteWriteInFlight.current.delete(key);
                    markFavoriteBusy(lemma, false);
                });
            return;
        }
        void persistFavoriteForRow({
            word: lemma,
            phonetic: member.phonetic,
            translation: member.translation,
            sourceKind: 'wordlist',
            sourceRef: `word-family:${row.id}`,
            sourceTitle: t('vocab.family.sourceTitle', { head: row.head }),
        })
            .then((created) => {
                if (created) toast.success(t('vocab.toast.added'), { dedupeKey: 'favorites:added' });
            })
            .catch((error) => {
                setListRowErrors((prev) => ({ ...prev, [rowKey]: editErrorText(error) }));
            });
    };

    /** Member check: the shared mastered write (snapshot + favorite removal). */
    const toggleFamilyMemberMastered = (
        row: WordFamilyRow,
        member: WordFamilyMember,
    ) => {
        void toggleListRowMastered({
            rowKey: familyMemberRowKey(row.id, member.lemma),
            word: member.lemma,
            translation: member.translation,
            phonetic: member.phonetic,
            listId: `word-family:${row.id}`,
        });
    };

    // ── Shared edit mode (P0-14) ──────────────────────────────────────────
    // Every word list uses the same mode, checkbox column and bottom action
    // bar; switching tabs exits editing and clears the selection (specs/005
    // §编辑模式). A batch runs row by row: successes leave the selection,
    // failures stay selected with an inline error + a 「N 项失败」 summary.
    const resetEdit = useCallback(() => {
        editAllToken.current += 1;
        editRows.current.clear();
        setEditMode(false);
        setEditSelected(new Set());
        setEditSummary(null);
        setEditErrors({});
        setEditDeleteOpen(false);
        setEditAllLoading(false);
        setEditAllError(null);
    }, []);

    /**
     * Clear the selection but stay in edit mode (search/filter/sort change,
     * 清除选择). P0-15: paging itself never clears it — select-all spans pages.
     */
    const clearEditSelection = useCallback(() => {
        editAllToken.current += 1;
        editRows.current.clear();
        setEditSelected(new Set());
        setEditSummary(null);
        setEditErrors({});
        setEditAllError(null);
        setEditAllLoading(false);
    }, []);

    const toggleEditMode = () => {
        if (editBusy || editAllLoading) return;
        editAllToken.current += 1;
        editRows.current.clear();
        setEditSelected(new Set());
        setEditSummary(null);
        setEditErrors({});
        setEditDeleteOpen(false);
        setEditAllLoading(false);
        setEditAllError(null);
        setEditMode((prev) => !prev);
    };

    // Switching tabs always leaves edit mode, including the fallback path that
    // drops a deleted custom list straight back to 我的收藏.
    useEffect(() => {
        resetEdit();
    }, [activeTab, resetEdit]);

    const toggleEditSelection = useCallback((key: string, checked: boolean) => {
        setEditSelected((prev) => {
            const next = new Set(prev);
            if (checked) next.add(key);
            else next.delete(key);
            return next;
        });
        setEditSummary(null);
        setEditAllError(null);
    }, []);

    /** Keep a rendered (or select-all fetched) row runnable after it unmounts. */
    const registerEditRow = useCallback((key: string, word: string, actions: EditRowActions) => {
        editRows.current.set(key, { key, word, actions });
    }, []);

    /** Current selection → batch entries, including rows on other pages. */
    const selectedEditEntries = (action: EditAction): EditEntry[] => {
        const entries: EditEntry[] = [];
        for (const row of editRows.current.values()) {
            if (!editSelected.has(row.key)) continue;
            const run = row.actions[action];
            if (!run) continue;
            entries.push({ key: row.key, word: row.word, run });
        }
        return entries;
    };

    /** Replace the selection with every row of the current filtered result set. */
    const selectAllRows = (rows: readonly EditRowRegistration[]) => {
        editRows.current = new Map(rows.map((row) => [row.key, row]));
        setEditSelected(new Set(rows.map((row) => row.key)));
        setEditSummary(null);
        setEditErrors({});
        setEditAllError(null);
    };

    /** Client-paged lists already hold every filtered row: select them at once. */
    const selectAllClient = (rows: readonly EditRowRegistration[]) => {
        if (rows.length === 0) {
            setEditSummary(t('vocab.edit.selectEmpty'));
            return;
        }
        selectAllRows(rows);
    };

    /**
     * P0-15: server-paged lists fetch every page matching the current
     * q/filter/sort (200/page — the endpoint cap) before selecting. A failure
     * keeps the previous selection and reports it inline + as a toast; it never
     * reports a partial page as "all results selected".
     */
    const selectAllServer = async (loadRows: () => Promise<EditRowRegistration[]>) => {
        if (editBusy || editAllLoading) return;
        const token = ++editAllToken.current;
        setEditAllLoading(true);
        setEditAllError(null);
        try {
            const rows = await loadRows();
            if (token !== editAllToken.current) return;
            if (rows.length === 0) {
                setEditSummary(t('vocab.edit.selectEmpty'));
                return;
            }
            selectAllRows(rows);
        } catch (error) {
            if (token !== editAllToken.current) return;
            const message = (await describeApiError(error)) || t('vocab.edit.selectAllFailed');
            setEditAllError(message);
            toast.error(message, { dedupeKey: 'vocab:select-all' });
        } finally {
            if (token === editAllToken.current) setEditAllLoading(false);
        }
    };

    /** Shared header props: tri-state follows selection size vs. result total. */
    const selectAllHeaderProps = (
        resultTotal: number,
        testId: string,
    ): Omit<WordTableSelectAll, 'onChange'> => {
        const allSelected = resultTotal > 0 && editSelected.size === resultTotal;
        return {
            checked: allSelected,
            indeterminate: editSelected.size > 0 && !allSelected,
            label: allSelected ? t('vocab.edit.clearSelection') : t('vocab.edit.selectAll'),
            disabled: editBusy || editAllLoading,
            loading: editAllLoading,
            testId,
        };
    };

    const editErrorText = (error: unknown): string => (
        error instanceof Error && error.message.trim()
            ? error.message
            : t('vocab.edit.rowFailed')
    );

    const runEditEntries = async (action: EditAction, entries: readonly EditEntry[]) => {
        if (editRunInFlight.current || editAllLoading) return;
        // Guests can only batch-undo their local 「我会了」 table; every other
        // batch is a server write and must go through the login gate first.
        if (isGuest && !(activeIsMastered && action === 'unmaster')) {
            openLogin();
            return;
        }
        if (entries.length === 0) {
            setEditSummary(t('vocab.edit.selectEmpty'));
            return;
        }
        editRunInFlight.current = true;
        setEditRunning(action);
        setEditSummary(null);
        setEditErrors((prev) => {
            if (entries.every((entry) => !(entry.key in prev))) return prev;
            const next = { ...prev };
            for (const entry of entries) delete next[entry.key];
            return next;
        });
        let completed = 0;
        let failed = 0;
        try {
            for (const entry of entries) {
                try {
                    await entry.run();
                    completed += 1;
                    setEditSelected((prev) => {
                        if (!prev.has(entry.key)) return prev;
                        const next = new Set(prev);
                        next.delete(entry.key);
                        return next;
                    });
                } catch (error) {
                    failed += 1;
                    const message = editErrorText(error);
                    setEditErrors((prev) => ({ ...prev, [entry.key]: message }));
                }
            }
        } finally {
            editRunInFlight.current = false;
            setEditRunning(null);
        }
        if (failed > 0) {
            const message = t('vocab.edit.failed', { count: formatNumber(failed) });
            setEditSummary(message);
            toast.error(message, { dedupeKey: 'vocab:edit' });
            return;
        }
        toast.success(t(EDIT_DONE_KEYS[action], { count: formatNumber(completed) }), {
            dedupeKey: 'vocab:edit',
        });
    };

    /**
     * Remove one custom-list item through its own DELETE so a partial batch can
     * report per-row outcomes; every success updates both the local rows and
     * the tab/header itemCount from the server's authoritative count.
     */
    const deleteCustomItem = async (listId: string, item: CustomWordlistItem): Promise<void> => {
        if (!item.id) throw new Error(t('vocab.edit.missingIds'));
        const result = await deleteCustomWordlistItems(listId, [item.id]);
        setCustomItems((prev) => prev.filter((entry) => entry.id !== item.id));
        setCustomLists((prev) => prev.map((entry) => (
            entry.id === listId
                ? {
                    ...entry,
                    itemCount: result.itemCount > 0
                        ? result.itemCount
                        : Math.max(0, entry.itemCount - result.deleted),
                }
                : entry
        )));
    };

    /** ConfirmDialog handler for 删除词条: one DELETE per item, row by row. */
    const confirmDeleteCustomItems = async () => {
        if (!activeCustomList) return;
        // P0-15: the key→row map covers selected items on other pages too.
        await runEditEntries('delete', selectedEditEntries('delete'));
    };

    /**
     * Sticky bottom action bar of the edit mode (P0-14/P0-15): 已选 N / 结果 M /
     * the active tab's operations / 完成, with the batch and select-all failure
     * summaries underneath. The caller passes only the operations its list
     * supports.
     */
    const renderEditBar = (actions: readonly EditBarAction[], resultTotal: number) => {
        if (!editMode) return null;
        return (
            <div
                data-testid="vocab-edit-bar"
                className="sticky bottom-0 z-chrome flex flex-wrap items-center gap-2 rounded-card border border-line-strong bg-surface/90 px-3 py-2 shadow-elev-2 backdrop-blur-xl"
            >
                <span
                    data-testid="vocab-edit-selected"
                    className="text-caption tabular-nums text-fg-strong"
                >
                    {t('vocab.edit.selected', { count: formatNumber(editSelected.size) })}
                </span>
                <span aria-hidden="true" className="text-caption text-fg-muted">/</span>
                <span
                    data-testid="vocab-edit-result-total"
                    className="text-caption tabular-nums text-fg-muted"
                >
                    {t('vocab.edit.resultTotal', { count: formatNumber(resultTotal) })}
                </span>
                {editAllLoading && (
                    <span
                        data-testid="vocab-edit-select-all-loading"
                        className="inline-flex items-center gap-1.5 text-caption text-fg-muted"
                    >
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                        {t('vocab.edit.selecting')}
                    </span>
                )}
                <div className="ms-auto flex flex-wrap items-center gap-1.5">
                    {actions.map((action) => {
                        const Icon = action.icon;
                        return (
                            <Button
                                key={action.key}
                                size="sm"
                                variant={action.destructive ? 'destructive' : 'secondary'}
                                iconLeft={<Icon />}
                                testId={action.testId}
                                loading={editRunning === action.key}
                                disabled={editBusy || editAllLoading || editSelected.size === 0}
                                onClick={action.onSelect}
                            >
                                {action.label}
                            </Button>
                        );
                    })}
                    <Button
                        size="sm"
                        variant="secondary"
                        testId="vocab-edit-done"
                        disabled={editBusy || editAllLoading}
                        onClick={resetEdit}
                    >
                        {t('vocab.edit.done')}
                    </Button>
                </div>
                {editSummary && (
                    <p
                        role="alert"
                        data-testid="vocab-edit-summary"
                        className="w-full text-caption leading-relaxed text-danger-fg"
                    >
                        {editSummary}
                    </p>
                )}
                {editAllError && (
                    <p
                        role="alert"
                        data-testid="vocab-edit-select-all-error"
                        className="w-full text-caption leading-relaxed text-danger-fg"
                    >
                        {editAllError}
                    </p>
                )}
            </div>
        );
    };

    /** Leading checkbox descriptor for one row while the list is being edited. */
    const selectionForRow = useCallback((
        key: string,
        word: string,
        testId: string,
        actions: EditRowActions,
    ) => {
        if (!editMode) return undefined;
        // P0-15: keep the handlers past this render so a batch still owns a
        // selected row after the user pages away from it.
        registerEditRow(key, word, actions);
        return {
            checked: editSelected.has(key),
            onChange: (checked: boolean) => toggleEditSelection(key, checked),
            label: t('vocab.bulk.selectRow', { word }),
            testId,
            disabled: editBusy || editAllLoading,
        };
    }, [
        editAllLoading, editBusy, editMode, editSelected, registerEditRow, t,
        toggleEditSelection,
    ]);

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

    // ── 词族（CEFR 10k word family）: read-only, own search/page/filter state
    // specs/041. Separate state for the same reason as the phrase list: a
    // family search must never rewrite what an existing word list is showing.
    const [familyQuery, setFamilyQuery] = useState('');
    const [familyDebouncedQuery, setFamilyDebouncedQuery] = useState('');
    const [familyPage, setFamilyPage] = useState(1);
    // Own per-page choice (20/50/100, default 50): the family list pages on
    // the server, but the selector must behave exactly like the other lists
    // without rewriting their shared 每页条数 preference (specs/041 §3).
    const [familyPageSize, setFamilyPageSize] = useState<number>(50);
    const [familyLevel, setFamilyLevel] = useState<CefrLevel | ''>('');
    const [familySort, setFamilySort] = useState<WordFamilySort>('rank');
    const [familyPhase, setFamilyPhase] = useState<Phase>('idle');
    const [familyData, setFamilyData] = useState<WordFamilyPage | null>(null);
    const [familyError, setFamilyError] = useState('');
    const [familyNonce, setFamilyNonce] = useState(0);
    // Accordion (P1-13): at most one family is open at a time; null = all
    // collapsed. Opening another family replaces this id, so no URL/history
    // state is written for a purely local disclosure.
    const [familyExpandedId, setFamilyExpandedId] = useState<string | null>(null);

    const selectTab = useCallback((id: string) => {
        // A running batch owns the current selection; switching views now would
        // apply its row results to a different list. 完成/操作 settle first.
        if (editBusy) return;
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
        // 词族 tab (specs/041) restarts clean too: first page, no search/filter,
        // frequency order, every member list collapsed.
        setFamilyQuery('');
        setFamilyDebouncedQuery('');
        setFamilyPage(1);
        setFamilyLevel('');
        setFamilySort('rank');
        setFamilyExpandedId(null);
        setFamilyPhase('idle');
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
        resetEdit();
        // 我的单词 and 已掌握 also restart clean (first page, default sort, no
        // filters/search) — specs/005 §统一词表 UI. P0-16: 已掌握's default is
        // 加入时间, so a tab switch returns to it too.
        setMasteredPage(1);
        setMasteredQuery('');
        setMasteredLevel('');
        setMasteredSort('added');
        setMasteredRevealed(new Set());
        setMineSort('added');
        setMineType('');
        setMineSource('');
        setMineLevel('');
        setMineQuery('');
        setMineDebouncedQuery('');
        setMinePage(1);
    }, [catalogById, editBusy, resetEdit]);


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
    // and page 1; the selection is the shared effect below (P0-15 clears it on
    // search/filter/sort, never on paging alone).
    useEffect(() => {
        setCustomRevealed(new Set());
        setCustomPage(1);
    }, [customQuery, customSort, customLevel, customUnmasteredOnly, pageSize]);

    // P0-15: any search / sort / filter change is a different result set, so the
    // edit selection is cleared and edit mode stays on. Paging alone does NOT
    // clear it: select-all spans pages and the key→row map still owns the rows
    // that are not rendered (batch + 已选 N / 结果 M remain correct).
    useEffect(() => {
        clearEditSelection();
        setEditDeleteOpen(false);
    }, [
        activeTab,
        mineQuery, mineType, mineSource, mineLevel, mineSort,
        masteredQuery, masteredLevel, masteredSort,
        customQuery, customSort, customLevel, customUnmasteredOnly,
        query, listLevel,
        phraseQuery, phraseLevel, phraseType,
        clearEditSelection,
    ]);

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
        if (activeIsMine || activeIsMastered || activeIsCustom || activeIsWordFamily || activeUnavailable || activeTab === PHRASES_TAB) {
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
    }, [activeIsMine, activeIsMastered, activeIsCustom, activeIsCefr, activeIsWordFamily, activeUnavailable, activeTab, page, pageSize, debouncedQuery, listLevel, listNonce]);

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

    // 300ms family search debounce; a changed query restarts from page 1. The
    // committed-query guard keeps the initial mount / tab reset from jumping
    // back to page 1 after the user already paged.
    useEffect(() => {
        const trimmed = familyQuery.trim();
        const timer = window.setTimeout(() => {
            if (trimmed === familyDebouncedQuery) return;
            setFamilyDebouncedQuery(trimmed);
            setFamilyPage(1);
        }, 300);
        return () => window.clearTimeout(timer);
    }, [familyQuery, familyDebouncedQuery]);

    // Server paging (20/50/100, default 50; specs/041 §3): a new
    // search/filter/sort/page starts with the accordion closed so a stale
    // expansion never lingers on another family's page.
    useEffect(() => {
        setFamilyExpandedId(null);
    }, [familyPage, familyDebouncedQuery, familyLevel, familySort]);

    // A new level filter, sort or page size restarts from the first server page
    // (same rule as the other lists: a phantom page beyond the result set is
    // never requested or shown).
    useEffect(() => {
        setFamilyPage(1);
    }, [familyLevel, familySort, familyPageSize]);

    useEffect(() => {
        if (!activeIsWordFamily) {
            setFamilyPhase('idle');
            return;
        }
        const controller = new AbortController();
        setFamilyPhase('loading');
        setFamilyError('');
        fetchWordFamilyPage({
            page: familyPage,
            pageSize: familyPageSize,
            q: familyDebouncedQuery,
            level: familyLevel,
            sort: familySort,
            signal: controller.signal,
        })
            .then((data) => {
                if (controller.signal.aborted) return;
                setFamilyData(data);
                setFamilyPhase('ready');
            })
            .catch(async (error) => {
                if (controller.signal.aborted || (error as Error)?.name === 'AbortError') return;
                setFamilyError(await describeApiError(error));
                setFamilyPhase('error');
            });
        return () => controller.abort();
    }, [activeIsWordFamily, familyPage, familyPageSize, familyDebouncedQuery, familyLevel, familySort, familyNonce]);

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

    const renderWordFamily = () => {
        // CEFR 10k word family list (specs/041): server paging with the shared
        // 20/50/100 selector, search over any member, CEFR filter,
        // frequency/alpha sort. P1-07: family rows stay read-only (no
        // edit/batch/export), while every expanded member carries the standard
        // word-row star (favorite) and 已掌握 check.
        const total = familyData?.total ?? 0;
        const pages = Math.max(1, Math.ceil(total / familyPageSize));
        const hasFilter = Boolean(familyDebouncedQuery || familyLevel);
        const totalLabel = hasFilter
            ? t('vocab.family.results', { count: formatNumber(total) })
            : t('vocab.family.total', { count: formatNumber(total) });
        const sortOptions: SortOption[] = [
            { value: 'rank', label: t('vocab.family.sort.rank'), testId: 'vocab-family-sort-rank' },
            { value: 'alpha', label: t('vocab.family.sort.alpha'), testId: 'vocab-family-sort-alpha' },
        ];
        const levelOptions: FilterOption[] = levelFilterOptions(
            familyLevel,
            'vocab-family-level',
        ).filter((option) => option.value !== 'C1+');
        const levelGroups: FilterGroup[] = [{
            id: 'level',
            label: t('vocab.filter.level'),
            options: levelOptions,
        }];
        const sortLabel = familySort === 'alpha'
            ? t('vocab.family.sort.alpha')
            : t('vocab.family.sort.rank');

        // Accordion (specs/041 §3): opening one family closes the open one;
        // clicking the open family collapses it. No URL/history write.
        const toggleFamilyExpand = (familyId: string) => {
            setFamilyExpandedId((prev) => (prev === familyId ? null : familyId));
        };

        return (
            <div data-testid="vocab-family-panel" className="flex flex-col gap-3">
                <WordbookToolbar
                    search={{
                        value: familyQuery,
                        onChange: setFamilyQuery,
                        placeholder: t('vocab.family.search.placeholder'),
                        ariaLabel: t('vocab.family.search.placeholder'),
                        testId: 'vocab-family-search',
                        clearTestId: 'vocab-family-search-clear',
                        clearLabel: t('vocab.search.clear'),
                    }}
                    sort={{
                        value: familySort,
                        label: sortLabel,
                        options: sortOptions,
                        onChange: (value) => setFamilySort(value === 'alpha' ? 'alpha' : 'rank'),
                        testId: 'vocab-family-sort',
                        menuTestId: 'vocab-family-sort-menu',
                    }}
                    filter={{
                        groups: levelGroups,
                        activeCount: Number(Boolean(familyLevel)),
                        onChange: (key) => {
                            const [group, value] = key.split(':');
                            if (group !== 'level') return;
                            setFamilyLevel(value as CefrLevel | '');
                        },
                        onClear: () => {
                            setFamilyLevel('');
                            setFamilyQuery('');
                        },
                        testId: 'vocab-family-level-filter',
                        clearTestId: 'vocab-family-clear-filters',
                        menuTestId: 'vocab-family-level-filter-menu',
                    }}
                />

                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-caption text-fg-muted">
                    <span data-testid="vocab-family-total" className="tabular-nums">{totalLabel}</span>
                    <span>{t('vocab.tab.wordFamily')}</span>
                    <span data-testid="vocab-family-readonly">{t('vocab.family.readonly')}</span>
                </div>

                {familyPhase === 'loading' && (
                    <div data-testid="vocab-family-loading" className={`${LIST_CARD} flex items-center justify-center gap-2 py-16 text-ui text-fg-muted`}>
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                        {t('common.loading')}
                    </div>
                )}

                {familyPhase === 'error' && (
                    <div data-testid="vocab-family-error" className={`${LIST_CARD} flex flex-col items-center justify-center px-6 py-16 text-center`}>
                        <AlertTriangle className="mb-3 h-10 w-10 text-warning-fg/70" aria-hidden="true" />
                        <p className="text-ui font-medium text-fg-strong">{t('vocab.error.title')}</p>
                        <p className="mt-1 max-w-md break-words text-caption text-fg-muted">
                            {familyError || t('vocab.error.hint')}
                        </p>
                        <Button
                            size="sm"
                            variant="secondary"
                            testId="vocab-family-retry"
                            onClick={() => setFamilyNonce((value) => value + 1)}
                            className="mt-5"
                        >
                            {t('common.retry')}
                        </Button>
                    </div>
                )}

                {familyPhase === 'ready' && familyData && (
                    familyData.items.length === 0 ? (
                        emptyState(
                            hasFilter ? t('vocab.empty.title') : t('vocab.empty.list'),
                            hasFilter ? t('vocab.empty.hint') : t('vocab.empty.listHint'),
                            Search,
                            'vocab-family-empty',
                        )
                    ) : (
                        <>
                            <WordFamilyTable
                                rows={familyData.items}
                                expandedFamilyId={familyExpandedId}
                                onToggleExpand={toggleFamilyExpand}
                                memberState={familyMemberState}
                                onToggleMemberFavorite={toggleFamilyMemberFavorite}
                                onToggleMemberMastered={toggleFamilyMemberMastered}
                                className={LIST_CARD}
                            />
                            <VocabPagination
                                scope="vocab"
                                page={familyPage}
                                pages={pages}
                                hasMore={familyData.hasMore}
                                onChange={setFamilyPage}
                                pageSize={familyPageSize}
                                onPageSizeChange={(size) => {
                                    setFamilyPageSize(size);
                                    setFamilyPage(1);
                                }}
                            />
                        </>
                    )
                )}
            </div>
        );
    };

    const renderTabPanel = () => {
        if (activeIsMine) return renderMine();
        if (activeIsMastered) return renderMastered();
        if (activeIsCustom) return renderCustomList();
        if (activeTab === PHRASES_TAB) return renderPhrases();
        if (activeIsWordFamily) return renderWordFamily();
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
                : activeIsWordFamily
                ? (familyData
                    ? (Boolean(familyDebouncedQuery || familyLevel)
                        ? t('vocab.family.results', { count: formatNumber(familyData.total) })
                        : t('vocab.family.total', { count: formatNumber(familyData.total) }))
                    : null)
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
                                : id === WORD_FAMILY_TAB
                                    ? t('vocab.tab.wordFamily')
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
                // The 词族 tab keeps its own hook (`vocab-family-tab`):
                // the legacy `vocab-tab-*` namespace is the pre-existing built-in
                // list tabs, whose order/count assertions must not shift when a
                // new surface is appended (P1-02/P1-05 zero-regression).
                testId: customEntry
                    ? `vocab-tab-custom-${customEntry.id}`
                    : id === WORD_FAMILY_TAB
                        ? 'vocab-family-tab'
                        : `vocab-tab-${id}`,
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

        /** P0-15: one favorite's batch handlers, shared by its row and 全选. */
        const editActionsForMine = (fav: FavoriteItem): EditRowActions => ({
            unfavorite: async () => {
                const removed = await deleteFavoriteById(fav.id);
                if (!removed) throw new Error(t('vocab.bulk.rowError'));
            },
            master: async () => { await applyFavoriteMastered(fav, true); },
        });
        /** 我的收藏 is client paged: 全选 is every filtered+sorted favorite. */
        const mineSelectAllRows = (): EditRowRegistration[] => mineRows.map((fav) => ({
            key: fav.id,
            word: fav.en_text.trim(),
            actions: editActionsForMine(fav),
        }));

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
            const isMastered = masteredWords.has(masteredKey);
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
            // P0-10: 已掌握 is the row check, never an expanded text action. No
            // 取消收藏 action either: the row star is the single cancel entry
            // (specs/005 单一来源; ADR-0001).
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
                mastered: isMastered,
                masteredLabel: masteredLabelFor(word, isMastered),
                onToggleMastered: () => { void handleToggleFavoriteMastered(fav); },
                masteredBusy: pendingMasteredId === fav.id,
                masteredDisabled: Boolean(pendingReviewId || pendingMasteredId),
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
                selection: selectionForRow(
                    fav.id,
                    word,
                    `vocab-mine-select-${fav.id}`,
                    editActionsForMine(fav),
                ),
                error: rowError?.id === fav.id
                    ? { message: rowError.message, testId: `vocab-mine-error-${fav.id}` }
                    : editErrors[fav.id]
                        ? { message: editErrors[fav.id], testId: `vocab-mine-edit-error-${fav.id}` }
                        : undefined,
                testIds: {
                    row: `vocab-mine-toggle-${fav.id}`,
                    word: `vocab-mine-word-${fav.id}`,
                    phonetic: `vocab-mine-ipa-${fav.id}`,
                    translation: `vocab-mine-meaning-${fav.id}`,
                    level: `vocab-mine-level-${fav.id}`,
                    speak: `vocab-mine-speak-${fav.id}`,
                    star: `vocab-mine-star-${fav.id}`,
                    mastered: `vocab-mine-master-toggle-${fav.id}`,
                    seen: `vocab-mine-seen-${fav.id}`,
                    expand: `vocab-mine-expand-${fav.id}`,
                    detail: `vocab-mine-detail-${fav.id}`,
                },
            };
        });

        /** 我的收藏 matrix: 取消收藏 / 标为已掌握 (both run row by row). */
        const runMineEdit = (action: 'unfavorite' | 'master') => {
            void runEditEntries(action, selectedEditEntries(action));
        };

        /**
         * P0-16: export the **current** 我的收藏 view (search + type/source/level
         * filters + sort, all client pages) with the existing favorites format —
         * Front/Back/Tags for TSV, the context CSV.
         */
        const exportMine = (format: 'tsv' | 'csv') => {
            void runListExport('mine', () => {
                if (mineRows.length === 0) {
                    toast.info(t('vocab.export.empty'), { dedupeKey: 'vocab:export' });
                    return;
                }
                if (format === 'tsv') exportAnkiTsv(mineRows);
                else exportCsv(mineRows);
            });
        };

        return (
            <div data-testid="vocab-mine-panel" className="flex flex-col gap-3">
                <p className="text-caption leading-relaxed text-fg-muted">{t('vocab.mine.hint')}</p>

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
                    edit={{
                        editing: editMode,
                        onToggle: toggleEditMode,
                        label: t('vocab.edit'),
                        doneLabel: t('vocab.edit.done'),
                        testId: 'vocab-mine-edit',
                        disabled: editBusy,
                    }}
                    extra={exportButtons({
                        scope: 'mine',
                        tsvTestId: 'vocab-export-anki',
                        csvTestId: 'vocab-export-csv',
                        disabled: mineRows.length === 0,
                        onTsv: () => exportMine('tsv'),
                        onCsv: () => exportMine('csv'),
                    })}
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
                                    selectable={editMode}
                                    selectAll={{
                                        ...selectAllHeaderProps(mineRows.length, 'vocab-select-all-mine'),
                                        onChange: (checked) => {
                                            if (checked) selectAllClient(mineSelectAllRows());
                                            else clearEditSelection();
                                        },
                                    }}
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

                {renderEditBar([
                    {
                        key: 'unfavorite',
                        label: t('vocab.edit.unfavorite'),
                        icon: Star,
                        testId: 'vocab-edit-unfavorite',
                        onSelect: () => runMineEdit('unfavorite'),
                    },
                    {
                        key: 'master',
                        label: t('vocab.edit.master'),
                        icon: CheckCircle2,
                        testId: 'vocab-edit-master',
                        onSelect: () => runMineEdit('master'),
                    },
                ], mineRows.length)}
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

        /** P0-15: one phrase's batch handlers, shared by its row and 全选. */
        const editActionsForPhrase = (item: PhraseEntry): EditRowActions => ({
            favorite: async () => {
                await persistFavoriteForRow({
                    word: item.headword,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: PHRASES_TAB,
                    sourceTitle: t('vocab.tab.phrases'),
                });
            },
            master: async () => {
                if (masteredWords.has(normalizeMasteryWord(item.headword))) return;
                await applyListWordMastered({
                    rowKey: `phrase:${item.id}`,
                    word: item.headword,
                    translation: item.translation,
                    listId: PHRASES_TAB,
                }, true);
            },
        });
        /**
         * P0-15/P0-16: fetch every page matching the current q/level/type
         * (200/page — the endpoint cap). Shared by 全选 and the cross-page export
         * so both consume exactly the same full result set.
         */
        const loadAllPhrases = async (): Promise<PhraseEntry[]> => {
            const collected = new Map<string, PhraseEntry>();
            for (let targetPage = 1; targetPage <= 25; targetPage += 1) {
                const data = await fetchPhrasePage({
                    page: targetPage,
                    pageSize: 200,
                    q: phraseDebouncedQuery,
                    level: phraseLevel,
                    type: phraseType,
                });
                for (const item of data.items) collected.set(item.id, item);
                if (!data.hasMore || data.items.length === 0) break;
            }
            return [...collected.values()];
        };
        /** 短语 is server paged: 全选 is the full q/level/type result set. */
        const phraseSelectAllRows = async (): Promise<EditRowRegistration[]> => (
            (await loadAllPhrases()).map((item) => ({
                key: item.id,
                word: item.headword,
                actions: editActionsForPhrase(item),
            }))
        );

        /** P0-16: headword / type / translation / level / example, current view. */
        const phraseExportColumns: ExportColumn<PhraseEntry>[] = [
            { header: t('vocab.export.col.headword'), value: (item) => item.headword },
            { header: t('vocab.export.col.type'), value: (item) => phraseTypeLabel(item.type) },
            { header: t('vocab.export.col.translation'), value: (item) => item.translation },
            { header: t('vocab.export.col.level'), value: (item) => item.cefr },
            { header: t('vocab.export.col.example'), value: (item) => item.example },
        ];
        const exportPhrases = (format: 'tsv' | 'csv') => {
            void runListExport('phrases', async () => {
                const items = await loadAllPhrases();
                if (items.length === 0) {
                    toast.info(t('vocab.export.empty'), { dedupeKey: 'vocab:export' });
                    return;
                }
                exportTable({
                    format,
                    baseName: 'phrases',
                    columns: phraseExportColumns,
                    rows: items,
                });
            });
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
            const favored = favoritedWordKeys.has(wordKey);
            const mastered = masteredWords.has(wordKey);
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
                favored,
                // 已掌握 is not a favorite: the star is disabled with an
                // explanation until the check is switched off (P0-10).
                favoriteLabel: mastered
                    ? t('vocab.mastered.starDisabled', { word: item.headword })
                    : favoriteLabelFor(item.headword),
                onToggleFavorite: () => toggleRowFavorite({
                    word: item.headword,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: PHRASES_TAB,
                    sourceTitle: t('vocab.tab.phrases'),
                }),
                favoriteBusy: favoriteBusyKeys.has(wordKey),
                favoriteDisabled: mastered,
                mastered,
                masteredLabel: masteredLabelFor(item.headword, mastered),
                onToggleMastered: () => {
                    void toggleListRowMastered({
                        rowKey,
                        word: item.headword,
                        translation: item.translation,
                        listId: PHRASES_TAB,
                    });
                },
                masteredBusy: masterAdds[rowKey] === 'busy',
                tone: mastered ? 'mastered' : favored ? 'favorited' : undefined,
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
                actions: rowReviewActions({
                    rowKey,
                    word: item.headword,
                    listId: PHRASES_TAB,
                }),
                selection: selectionForRow(
                    item.id,
                    item.headword,
                    `phrase-select-${item.id}`,
                    editActionsForPhrase(item),
                ),
                error: listRowErrors[rowKey]
                    ? { message: listRowErrors[rowKey], testId: `phrase-add-error-${item.id}` }
                    : editErrors[item.id]
                        ? { message: editErrors[item.id], testId: `phrase-edit-error-${item.id}` }
                        : undefined,
                testIds: {
                    row: 'phrase-row',
                    word: 'phrase-headword',
                    translation: 'phrase-translation',
                    level: 'phrase-level',
                    speak: `${rowKey}-speak`,
                    star: `${rowKey}-star`,
                    mastered: `${rowKey}-master-toggle`,
                    expand: 'phrase-expand',
                    detail: `phrase-detail-${item.id}`,
                },
            };
        });

        /** 短语 matrix: 加入收藏 / 标为已掌握. */
        const runPhraseEdit = (action: 'favorite' | 'master') => {
            void runEditEntries(action, selectedEditEntries(action));
        };

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
                    edit={{
                        editing: editMode,
                        onToggle: toggleEditMode,
                        label: t('vocab.edit'),
                        doneLabel: t('vocab.edit.done'),
                        testId: 'vocab-phrases-edit',
                        disabled: editBusy,
                    }}
                    extra={(
                        <>
                            {exportButtons({
                                scope: 'phrases',
                                tsvTestId: 'vocab-phrases-export-tsv',
                                csvTestId: 'vocab-phrases-export-csv',
                                disabled: phrasePhase !== 'ready' || (phraseData?.items.length ?? 0) === 0,
                                onTsv: () => exportPhrases('tsv'),
                                onCsv: () => exportPhrases('csv'),
                            })}
                            {hideChineseToggle('phrases')}
                        </>
                    )}
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
                                selectable={editMode}
                                selectAll={{
                                    ...selectAllHeaderProps(phraseTotal, 'vocab-select-all-phrases'),
                                    onChange: (checked) => {
                                        if (checked) void selectAllServer(phraseSelectAllRows);
                                        else clearEditSelection();
                                    },
                                }}
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

                {renderEditBar([
                    {
                        key: 'favorite',
                        label: t('vocab.edit.favorite'),
                        icon: Star,
                        testId: 'vocab-edit-favorite',
                        onSelect: () => runPhraseEdit('favorite'),
                    },
                    {
                        key: 'master',
                        label: t('vocab.edit.master'),
                        icon: CheckCircle2,
                        testId: 'vocab-edit-master',
                        onSelect: () => runPhraseEdit('master'),
                    },
                ], phraseTotal)}
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
            if (masteredSort === 'added') {
                // P0-16: default 加入时间 (newest first); equal times fall back
                // to the alphabetical order below.
                const byAdded = b.createdAt - a.createdAt;
                if (byAdded !== 0) return byAdded;
            } else if (masteredSort === 'level') {
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
            { value: 'added', label: t('vocab.sort.added'), testId: 'vocab-mastered-sort-added' },
            { value: 'alpha', label: t('vocab.sort.alpha'), testId: 'vocab-mastered-sort-alpha' },
            { value: 'level', label: t('vocab.sort.level'), testId: 'vocab-mastered-sort-level' },
        ];
        /** P0-15: one mastered row's batch handler, shared by its row and 全选. */
        const editActionsForMastered = (row: { key: string; word: string }): EditRowActions => ({
            unmaster: () => unmasterWordRow(row),
        });
        /** 已掌握 is client paged: 全选 is every filtered+sorted mastered word. */
        const masteredSelectAllRows = (): EditRowRegistration[] => sorted.map((row) => ({
            key: row.key,
            word: row.word,
            actions: editActionsForMastered(row),
        }));
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
                // P0-10: the check owns 撤销已掌握 (pressed = mastered); the
                // expanded area no longer carries a text undo action.
                mastered: true,
                masteredLabel: masteredLabelFor(row.word, true),
                onToggleMastered: () => { void handleMasteredRowUndo(row); },
                masteredBusy: pendingMasteredId === expandKey,
                selection: selectionForRow(
                    row.key,
                    row.word,
                    `vocab-mastered-select-${row.key}`,
                    editActionsForMastered(row),
                ),
                error: rowError?.id === expandKey
                    ? { message: rowError.message, testId: `vocab-mastered-error-${row.key}` }
                    : editErrors[row.key]
                        ? { message: editErrors[row.key], testId: `vocab-mastered-edit-error-${row.key}` }
                        : undefined,
                testIds: {
                    row: 'vocab-mastered-row',
                    word: `vocab-mastered-word-${row.key}`,
                    phonetic: `vocab-mastered-ipa-${row.key}`,
                    translation: `vocab-mastered-translation-${row.key}`,
                    level: `vocab-mastered-level-${row.key}`,
                    speak: `vocab-mastered-${row.key}-speak`,
                    star: `vocab-mastered-star-${row.key}`,
                    mastered: `vocab-mastered-master-toggle-${row.key}`,
                    expand: `vocab-mastered-expand-${row.key}`,
                    detail: `vocab-mastered-detail-${row.key}`,
                },
            };
        });

        /** 已掌握 matrix: 取消已掌握 only. */
        const runMasteredEdit = () => {
            void runEditEntries('unmaster', selectedEditEntries('unmaster'));
        };

        /** P0-16: word / definition (empty when absent) / level, current view. */
        const masteredExportColumns: ExportColumn<(typeof sorted)[number]>[] = [
            { header: t('vocab.export.col.word'), value: (row) => row.word },
            { header: t('vocab.export.col.definition'), value: (row) => row.translation },
            { header: t('vocab.export.col.level'), value: (row) => exportLevelFor(row.word) },
        ];
        const exportMastered = (format: 'tsv' | 'csv') => {
            void runListExport('mastered', () => {
                if (sorted.length === 0) {
                    toast.info(t('vocab.export.empty'), { dedupeKey: 'vocab:export' });
                    return;
                }
                exportTable({
                    format,
                    baseName: 'mastered',
                    columns: masteredExportColumns,
                    rows: sorted,
                });
            });
        };

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
                            ?? t('vocab.sort.added'),
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
                    edit={{
                        editing: editMode,
                        onToggle: toggleEditMode,
                        label: t('vocab.edit'),
                        doneLabel: t('vocab.edit.done'),
                        testId: 'vocab-mastered-edit',
                        disabled: editBusy,
                    }}
                    extra={(
                        <>
                            {exportButtons({
                                scope: 'mastered',
                                tsvTestId: 'vocab-mastered-export-tsv',
                                csvTestId: 'vocab-mastered-export-csv',
                                disabled: sorted.length === 0,
                                onTsv: () => exportMastered('tsv'),
                                onCsv: () => exportMastered('csv'),
                            })}
                            {hideChineseToggle('mastered')}
                        </>
                    )}
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
                            selectable={editMode}
                            selectAll={{
                                ...selectAllHeaderProps(sorted.length, 'vocab-select-all-mastered'),
                                onChange: (checked) => {
                                    if (checked) selectAllClient(masteredSelectAllRows());
                                    else clearEditSelection();
                                },
                            }}
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

                {renderEditBar([
                    {
                        key: 'unmaster',
                        label: t('vocab.edit.unmaster'),
                        icon: CheckCircle2,
                        testId: 'vocab-edit-unmaster',
                        onSelect: runMasteredEdit,
                    },
                ], sorted.length)}
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

        /** P0-15: one custom item's batch handlers, shared by its row and 全选. */
        const editActionsForCustom = (item: CustomWordlistItem): EditRowActions => ({
            delete: () => deleteCustomItem(listId, item),
            favorite: async () => {
                await persistFavoriteForRow({
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    example: item.example,
                    sourceKind: 'wordlist',
                    sourceRef: listId,
                    sourceTitle: list.name,
                });
            },
            master: async () => {
                if (masteredWords.has(normalizeMasteryWord(item.word))) return;
                await applyListWordMastered({
                    rowKey: `${listId}:${item.word}`,
                    word: item.word,
                    translation: item.translation,
                    phonetic: item.phonetic,
                    listId,
                }, true);
            },
        });
        /** 自定义词表 is loaded in full: 全选 is every filtered+sorted item. */
        const customSelectAllRows = (): EditRowRegistration[] => sorted.map((item) => ({
            key: customItemKey(item),
            word: item.word,
            actions: editActionsForCustom(item),
        }));

        /** P0-16: word / phonetic / translation / level, current view. */
        const customExportColumns: ExportColumn<CustomWordlistItem>[] = [
            { header: t('vocab.export.col.word'), value: (item) => item.word },
            { header: t('vocab.export.col.phonetic'), value: (item) => item.phonetic },
            { header: t('vocab.export.col.translation'), value: (item) => item.translation },
            { header: t('vocab.export.col.level'), value: (item) => item.cefr },
        ];
        // List identifier in the file name; non-ASCII names use the list id.
        const customBaseName = (() => {
            const slug = fileSlug(list.name) || fileSlug(list.id);
            return slug ? `custom-${slug}` : 'custom';
        })();
        const exportCustom = (format: 'tsv' | 'csv') => {
            void runListExport('custom', () => {
                if (sorted.length === 0) {
                    toast.info(t('vocab.export.empty'), { dedupeKey: 'vocab:export' });
                    return;
                }
                exportTable({
                    format,
                    baseName: customBaseName,
                    columns: customExportColumns,
                    rows: sorted,
                });
            });
        };

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
                // 已掌握 is not a favorite: the star is disabled until the
                // check is switched off (P0-10 / specs/005 §互斥).
                favoriteLabel: mastered
                    ? t('vocab.mastered.starDisabled', { word: item.word })
                    : favoriteLabelFor(item.word),
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
                favoriteDisabled: mastered,
                mastered,
                masteredLabel: masteredLabelFor(item.word, mastered),
                onToggleMastered: () => {
                    void toggleListRowMastered({
                        rowKey,
                        word: item.word,
                        translation: item.translation,
                        phonetic: item.phonetic,
                        listId,
                    });
                },
                masteredBusy: masterState === 'busy',
                tone: mastered ? 'mastered' : favored ? 'favorited' : undefined,
                speakLabel: speakLabelFor(item.word),
                onSpeak: () => speakRow(item.word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(expandKey),
                selection: selectionForRow(
                    itemKey,
                    item.word,
                    `vocab-custom-select-${itemKey}`,
                    editActionsForCustom(item),
                ),
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
                // P0-10: 已掌握 is the row check; the expanded area keeps only
                // 加入复习 (hidden while paused), never a mastered text action.
                actions: rowReviewActions({
                    rowKey,
                    word: item.word,
                    definition: item.translation,
                    listId,
                }),
                error: listRowErrors[rowKey]
                    ? { message: listRowErrors[rowKey], testId: `vocab-custom-error-${item.word}` }
                    : editErrors[itemKey]
                        ? { message: editErrors[itemKey], testId: `vocab-custom-edit-error-${itemKey}` }
                        : undefined,
                testIds: {
                    row: 'vocab-custom-row',
                    word: `vocab-custom-word-${item.word}`,
                    phonetic: `vocab-custom-ipa-${item.word}`,
                    translation: `vocab-custom-translation-${item.word}`,
                    level: `vocab-custom-level-${item.word}`,
                    speak: `${rowKey}-speak`,
                    star: `vocab-custom-star-${item.word}`,
                    mastered: `vocab-custom-master-toggle-${item.word}`,
                    expand: `vocab-custom-expand-${item.word}`,
                    detail: `vocab-custom-detail-${item.word}`,
                },
            };
        });

        /** 自定义词表 matrix: 删除词条（二次确认）/ 加入收藏 / 标为已掌握. */
        const runCustomEdit = (action: 'favorite' | 'master' | 'delete') => {
            if (action === 'delete') {
                if (editSelected.size === 0) {
                    setEditSummary(t('vocab.edit.selectEmpty'));
                    return;
                }
                setEditDeleteOpen(true);
                return;
            }
            // P0-15: the key→row map covers selected items on other pages too.
            void runEditEntries(action, selectedEditEntries(action));
        };

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
                    edit={{
                        editing: editMode,
                        onToggle: toggleEditMode,
                        label: t('vocab.edit'),
                        doneLabel: t('vocab.edit.done'),
                        testId: 'vocab-custom-edit',
                        disabled: editBusy,
                    }}
                    extra={(
                        <>
                            {exportButtons({
                                scope: 'custom',
                                tsvTestId: 'vocab-custom-export-tsv',
                                csvTestId: 'vocab-custom-export-csv',
                                disabled: customLoadPhase !== 'ready' || sorted.length === 0,
                                onTsv: () => exportCustom('tsv'),
                                onCsv: () => exportCustom('csv'),
                            })}
                            {hideChineseToggle('custom')}
                        </>
                    )}
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
                            selectable={editMode}
                            selectAll={{
                                ...selectAllHeaderProps(sorted.length, 'vocab-select-all-custom'),
                                onChange: (checked) => {
                                    if (checked) selectAllClient(customSelectAllRows());
                                    else clearEditSelection();
                                },
                            }}
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

                {renderEditBar([
                    {
                        key: 'delete',
                        label: t('vocab.edit.deleteItems'),
                        icon: Trash2,
                        testId: 'vocab-edit-delete',
                        destructive: true,
                        onSelect: () => runCustomEdit('delete'),
                    },
                    {
                        key: 'favorite',
                        label: t('vocab.edit.favorite'),
                        icon: Star,
                        testId: 'vocab-edit-favorite',
                        onSelect: () => runCustomEdit('favorite'),
                    },
                    {
                        key: 'master',
                        label: t('vocab.edit.master'),
                        icon: CheckCircle2,
                        testId: 'vocab-edit-master',
                        onSelect: () => runCustomEdit('master'),
                    },
                ], sorted.length)}
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
            ? t('vocab.family.results', { count: formatNumber(total) })
            : t('vocab.family.total', { count: formatNumber(total) });
        const sortOptions: SortOption[] = [
            { value: 'default', label: t('vocab.sort.list'), testId: 'vocab-sort-list' },
        ];
        const levelCounts = activeIsCefr ? activeList?.byLevel : undefined;

        /** P0-15: one built-in-list word's batch handlers (row + 全选 share it). */
        const editActionsForList = (item: VocabularyEntry): EditRowActions => ({
            favorite: async () => {
                await persistFavoriteForRow({
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: activeTab,
                    sourceTitle: label,
                });
            },
            master: async () => {
                if (masteredWords.has(normalizeMasteryWord(item.word))) return;
                await applyListWordMastered({
                    rowKey: `${activeTab}:${item.word}`,
                    word: item.word,
                    translation: item.translation,
                    phonetic: item.phonetic,
                    listId: activeTab,
                }, true);
            },
        });
        /**
         * P0-15/P0-16: fetch every page matching the current q/level
         * (200/page — the endpoint cap) and merge by row key. Shared by 全选
         * and the cross-page export.
         */
        const loadAllListEntries = async (): Promise<VocabularyEntry[]> => {
            const collected = new Map<string, VocabularyEntry>();
            for (let targetPage = 1; targetPage <= 25; targetPage += 1) {
                const data = await fetchVocabularyPage(activeTab, {
                    page: targetPage,
                    pageSize: 200,
                    q: debouncedQuery,
                    level: listLevel,
                });
                for (const item of data.items) collected.set(`${activeTab}:${item.word}`, item);
                if (!data.hasMore || data.items.length === 0) break;
            }
            return [...collected.values()];
        };
        /** 内置词表 is server paged: 全选 is the full q/level result set. */
        const listSelectAllRows = async (): Promise<EditRowRegistration[]> => (
            (await loadAllListEntries()).map((item) => ({
                key: `${activeTab}:${item.word}`,
                word: item.word,
                actions: editActionsForList(item),
            }))
        );

        /** P0-16: word / phonetic / translation / level, current q + level filter. */
        const listExportColumns: ExportColumn<VocabularyEntry>[] = [
            { header: t('vocab.export.col.word'), value: (item) => item.word },
            { header: t('vocab.export.col.phonetic'), value: (item) => item.phonetic },
            { header: t('vocab.export.col.translation'), value: (item) => item.translation },
            { header: t('vocab.export.col.level'), value: (item) => item.cefrLevel },
        ];
        const exportList = (format: 'tsv' | 'csv') => {
            void runListExport(`list:${activeTab}`, async () => {
                const items = await loadAllListEntries();
                if (items.length === 0) {
                    toast.info(t('vocab.export.empty'), { dedupeKey: 'vocab:export' });
                    return;
                }
                exportTable({
                    format,
                    baseName: activeTab,
                    columns: listExportColumns,
                    rows: items,
                });
            });
        };

        const rows: WordTableRow[] = (listData?.items ?? []).map((item, index) => {
            // Row key doubles as the write-state key and the test id suffix:
            // `<list id>:<word>`.
            const rowKey = `${activeTab}:${item.word}`;
            const wordKey = normalizeMasteryWord(item.word);
            const favored = favoritedWordKeys.has(wordKey);
            const mastered = masteredWords.has(wordKey);
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
                // 已掌握 is not a favorite: the star is disabled with an
                // explanation until the check is switched off (P0-10).
                favoriteLabel: mastered
                    ? t('vocab.mastered.starDisabled', { word: item.word })
                    : favoriteLabelFor(item.word),
                onToggleFavorite: () => toggleRowFavorite({
                    word: item.word,
                    phonetic: item.phonetic,
                    translation: item.translation,
                    sourceKind: 'wordlist',
                    sourceRef: activeTab,
                    sourceTitle: label,
                }),
                favoriteBusy: favoriteBusyKeys.has(wordKey),
                favoriteDisabled: mastered,
                mastered,
                masteredLabel: masteredLabelFor(item.word, mastered),
                onToggleMastered: () => {
                    void toggleListRowMastered({
                        rowKey,
                        word: item.word,
                        translation: item.translation,
                        phonetic: item.phonetic,
                        listId: activeTab,
                    });
                },
                masteredBusy: masterAdds[rowKey] === 'busy',
                tone: mastered ? 'mastered' : favored ? 'favorited' : undefined,
                speakLabel: speakLabelFor(item.word),
                onSpeak: () => speakRow(item.word),
                speakDisabled: speechDisabled,
                expandLabel: expandLabelFor(isExpanded),
                expanded: isExpanded,
                onToggleExpand: () => toggleExpanded(`list:${rowKey}`),
                selection: selectionForRow(
                    rowKey,
                    item.word,
                    `vocab-list-select-${rowKey}`,
                    editActionsForList(item),
                ),
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
                actions: rowReviewActions({
                    rowKey,
                    word: item.word,
                    listId: activeTab,
                }),
                error: listRowErrors[rowKey]
                    ? {
                        message: listRowErrors[rowKey],
                        testId: `vocab-list-error-${item.word}`,
                    }
                    : editErrors[rowKey]
                        ? {
                            message: editErrors[rowKey],
                            testId: `vocab-list-edit-error-${rowKey}`,
                        }
                        : undefined,
                testIds: {
                    star: `vocab-list-star-${rowKey}`,
                    mastered: `vocab-list-master-toggle-${rowKey}`,
                    speak: `${rowKey}-speak`,
                    expand: `vocab-list-expand-${rowKey}`,
                    detail: `vocab-list-detail-${rowKey}`,
                },
            };
        });

        /** 内置词表 matrix: 加入收藏 / 标为已掌握. */
        const runListEdit = (action: 'favorite' | 'master') => {
            void runEditEntries(action, selectedEditEntries(action));
        };

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
                    edit={{
                        editing: editMode,
                        onToggle: toggleEditMode,
                        label: t('vocab.edit'),
                        doneLabel: t('vocab.edit.done'),
                        testId: 'vocab-list-edit',
                        disabled: editBusy,
                    }}
                    extra={(
                        <>
                            {exportButtons({
                                scope: `list:${activeTab}`,
                                tsvTestId: `vocab-${activeTab}-export-tsv`,
                                csvTestId: `vocab-${activeTab}-export-csv`,
                                disabled: listPhase !== 'ready' || (listData?.items.length ?? 0) === 0,
                                onTsv: () => exportList('tsv'),
                                onCsv: () => exportList('csv'),
                            })}
                            {hideChineseToggle('list')}
                        </>
                    )}
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
                                selectable={editMode}
                                selectAll={{
                                    ...selectAllHeaderProps(total, 'vocab-select-all-list'),
                                    onChange: (checked) => {
                                        if (checked) void selectAllServer(listSelectAllRows);
                                        else clearEditSelection();
                                    },
                                }}
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

                {renderEditBar([
                    {
                        key: 'favorite',
                        label: t('vocab.edit.favorite'),
                        icon: Star,
                        testId: 'vocab-edit-favorite',
                        onSelect: () => runListEdit('favorite'),
                    },
                    {
                        key: 'master',
                        label: t('vocab.edit.master'),
                        icon: CheckCircle2,
                        testId: 'vocab-edit-master',
                        onSelect: () => runListEdit('master'),
                    },
                ], total)}
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
            {/* 表格/清单原型 (docs/设计-桌面布局规范.md §3): one wide sheet —
                toolbar and rows share this container so they always line up. */}
            <PageContainer
                variant="wide"
                testId="vocab-page-container"
                className="flex flex-col gap-4 py-4 sm:gap-5 sm:py-8"
            >
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
            </PageContainer>
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
                open={editDeleteOpen && activeCustomList != null}
                title={t('vocab.edit.deleteTitle', { count: formatNumber(editSelected.size) })}
                description={t('vocab.edit.deleteDesc')}
                confirmLabel={t('vocab.edit.deleteConfirm', { count: formatNumber(editSelected.size) })}
                onConfirm={confirmDeleteCustomItems}
                onClose={() => setEditDeleteOpen(false)}
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
