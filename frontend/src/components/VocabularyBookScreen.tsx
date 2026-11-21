// 单词本 (word book) — full-page replacement for the old favorites modal.
//
// Two halves, one route (`#/app/profile/vocabulary`):
//   1. 我的单词 — saved vocabulary favorites that are **not** marked 已掌握,
//      one line by default; expanding reveals the CEFR level (batched /level
//      lookup; off-list words read C1+), provenance, saved time and delete.
//   2. 词表 — 已掌握 (its own tab, same table as the built-in lists) + 短语 +
//      one merged CEFR 词表 (A1–C1) + GRE/CET4/CET6 from
//      `/api/vocabulary/lists`, with server-side search, 50-per-page pagination
//      and a global "hide Chinese" switch (persisted; hidden rows reveal their
//      translation on tap). The merged CEFR tab adds level chips whose counts
//      come from the catalog's `byLevel`; the old per-level A1–C1 tabs are gone.
//
// 已掌握 and 我的单词 are mutually exclusive lists (specs/005 §v1.1): a mastered
// word lives exclusively in the 已掌握 tab and never in 我的单词.
//
// v1.2 (specs/005 §v1.2) adds the daily-use layer on top of that:
//   * a 朗读 button on every row (我的单词 / 已掌握 / 词表 / 短语) reusing
//     `lib/tts.speak` — local only, no AI call, disabled when the browser has no
//     English voice;
//   * client-side 搜索 + 状态 chips on 我的单词. The state data comes from
//     `GET /api/review/words?state=` (lib/review.listReviewWords); guests never
//     request it and a 403/404 (endpoint not deployed yet) hides the whole group
//     instead of showing an error — the list itself keeps working;
//   * 加入我的单词 / 加入复习 on every built-in list and phrase row, idempotent,
//     with an inline 已加入 / 已在复习 state and a retryable inline failure;
//   * multi-select + bulk actions (加入复习 / 标为已掌握或撤销 / 删除收藏) on
//     我的单词 and 已掌握, with a confirmation dialog for deletes and a per-item
//     result summary that keeps the failed rows selected;
//   * 字母 A→Z sorting and 50-per-page client paging for 我的单词.
//
// C2 is intentionally not modelled by the backend (`available:false`): it is
// explained inside the CEFR tab instead of getting its own disabled tab.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
    AlertTriangle,
    BookMarked,
    BookOpen,
    BookmarkPlus,
    ChevronDown,
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
    Play,
    Repeat,
    Search,
    Star,
    Trash2,
    Tv,
    Undo2,
    Volume2,
    X,
    type LucideIcon,
} from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion';
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
import {
    addWord,
    getMasteredWords,
    listReviewWords,
    REVIEW_WORD_STATES,
    setWordMastered,
    WORD_STATE_FILTER_STATES,
    WORD_STATE_FILTERS,
    type ReviewWordState,
    type WordStateFilter,
} from '../lib/review';
import { fetchSeenCounts } from '../lib/vocabSeen';
import { normalizeMasteryWord, readGuestMastered, writeGuestMastered } from '../lib/wordMastery';
import { describeApiError, toast } from '../lib/toast';
import { speak } from '../lib/tts';
import { useSpeechAvailability } from '../lib/useSpeechAvailability';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import { VocabPagination } from './VocabPagination';
import {
    LevelBadge,
    WordRowActionButton,
    WordTable,
    type WordRowAction,
    type WordTableRow,
} from './VocabularyRows';
import { ConfirmDialog } from './ui/ConfirmDialog';
import { Checkbox } from './ui/Checkbox';
import { SubHeader } from './ui/SubHeader';
import { Tabs, tabPanelProps, type TabItem } from './ui/Tabs';
import { FilterChip } from './ui/FilterChip';
import { Segmented } from './ui/Segmented';
import { Button, IconButton } from './ui/Button';
import { ErrorPanel, LoadingState } from './ui/StateView';
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
    /** Guest gate for review actions (opens the login overlay, never a 403). */
    onRequestLogin?: () => void;
}

type Phase = 'idle' | 'loading' | 'ready' | 'error';
type MineSort = 'added' | 'seen' | 'level' | 'alpha';
type MineType = '' | 'word' | 'phrase';
type SeenPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** 状态 chips: `unavailable` hides the group (403/404/any failure), never an error. */
type StateFilterPhase = 'idle' | 'loading' | 'ready' | 'unavailable';
/** Row-level add state for the built-in lists / phrases (idempotent writes). */
type RowAddState = 'idle' | 'busy' | 'added';

const MINE_TAB = 'mine';
/** 已掌握 is a word list of its own, not a segment inside 我的单词 (specs/005). */
const MASTERED_TAB = 'mastered';
const PHRASES_TAB = 'phrases';
/** Merged CEFR list id (`GET /api/vocabulary/lists/cefr`); A1–C1 in one tab. */
const CEFR_TAB = 'cefr';
/** Product order: 我的单词 / 已掌握 / 短语 / CEFR 词表 / GRE / CET4 / CET6. */
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

/** 状态 filter labels, in product order (specs/005 §v1.2). */
const WORD_STATE_LABEL_KEYS: Record<WordStateFilter, TranslationKey> = {
    new: 'vocab.state.new',
    learning: 'vocab.state.learning',
    review: 'vocab.state.review',
    suspended: 'vocab.state.suspended',
};

/** Words outside the merged CEFR list render C1+ (specs/005), so they sort last. */
const OFF_LIST_RANK = VOCABULARY_CEFR_LEVELS.length;
function levelSortRank(word: string, levels: Record<string, string | null>): number {
    if (!(word in levels)) return Number.POSITIVE_INFINITY; // still loading / failed
    const level = levels[word];
    if (!level) return OFF_LIST_RANK; // C1+
    const index = (VOCABULARY_CEFR_LEVELS as readonly string[]).indexOf(level);
    return index >= 0 ? index : OFF_LIST_RANK;
}

const SECONDARY_BUTTON =
    'inline-flex items-center justify-center gap-1.5 h-9 px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors disabled:opacity-40 disabled:pointer-events-none';
const DANGER_BUTTON =
    'inline-flex items-center justify-center gap-1.5 h-8 px-3 rounded-lg bg-red-500/10 hover:bg-red-500/15 border border-red-500/20 text-xs font-medium text-red-400 transition-colors';
const CARD = 'rounded-2xl border border-white/5 bg-zinc-900/40';

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
}: VocabularyBookScreenProps) {
    const { t, formatDate, formatNumber, targetLang } = useI18n();
    const { status } = useAuth();
    const isGuest = status === 'guest';
    const reduceMotion = useReducedMotion() ?? false;
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

    const myWords = useMemo(
        () => allFavorites
            .filter((fav) => fav.type === 'vocabulary')
            .sort((a, b) => (b.added_at || 0) - (a.added_at || 0)),
        [allFavorites],
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
    const activeIsMastered = activeTab === MASTERED_TAB;
    const activeIsCefr = activeTab === CEFR_TAB;
    const activeList = activeIsMine || activeIsMastered ? null : catalogById.get(activeTab) ?? null;
    const activeUnavailable = activeList?.available === false;

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
    const [mineSort, setMineSort] = useState<MineSort>('added');
    const [mineType, setMineType] = useState<MineType>('');
    const [mineSource, setMineSource] = useState<'' | FavoriteSourceKind>('');
    const [guestMastered, setGuestMastered] = useState<Set<string>>(() => readGuestMastered());
    const [serverMastered, setServerMastered] = useState<Set<string>>(() => new Set());
    // Display casing for mastered words that have no favorite record: the review
    // API returns the lemma, and the local table stores the normalized form.
    const [masteredLabels, setMasteredLabels] = useState<Record<string, string>>({});
    const [masteredPhase, setMasteredPhase] = useState<Phase>('idle');
    // True once the signed-in list has loaded at least once; keeps stale rows
    // visible while a retry is in flight (and lets a failed retry stay inline).
    const [masteredReady, setMasteredReady] = useState(false);
    const [masteredNonce, setMasteredNonce] = useState(0);
    // 已掌握 is client paged (50/page): the API caps the list at 200 and has no
    // offset paging, so pages are a view concern only.
    const [masteredPage, setMasteredPage] = useState(1);
    const [reviewedWords, setReviewedWords] = useState<Set<string>>(() => new Set());
    const [pendingReviewId, setPendingReviewId] = useState<string | null>(null);
    const [pendingMasteredId, setPendingMasteredId] = useState<string | null>(null);
    // Row-level write failure: inline + retryable (IX-02 / specs/013 §v1.1),
    // never a success-looking state and never a page-level error. Keyed by
    // favorite id, or `mastered:<normalized word>` for a mastered row.
    const [rowError, setRowError] = useState<{ id: string; message: string } | null>(null);
    const [seenCounts, setSeenCounts] = useState<Record<string, number>>({});
    const [seenPhase, setSeenPhase] = useState<SeenPhase>('idle');

    // ── v1.2: search / 状态 filter / row adds / multi-select + bulk ────────
    // 状态 chips read `GET /api/review/words?state=` (specs/013). The endpoint
    // needs an account and is being deployed in parallel: a 403/404 (or any
    // other failure) hides the whole group instead of rendering an error — a
    // filter that cannot be trusted must never silently drop rows.
    const [wordStates, setWordStates] = useState<Record<string, ReviewWordState>>({});
    const [statePhase, setStatePhase] = useState<StateFilterPhase>('idle');
    const [mineQuery, setMineQuery] = useState('');
    const [mineDebouncedQuery, setMineDebouncedQuery] = useState('');
    const [mineState, setMineState] = useState<WordStateFilter | ''>('');
    const [minePage, setMinePage] = useState(1);
    // Row-level 加入我的单词 / 加入复习 state, keyed by `<listId>:<word>` for the
    // built-in lists and `phrase:<phrase id>` for phrases. The inline error
    // replaces the success state on failure; the same button is the retry.
    const [mineAdds, setMineAdds] = useState<Record<string, RowAddState>>({});
    const [reviewAdds, setReviewAdds] = useState<Record<string, RowAddState>>({});
    const [listRowErrors, setListRowErrors] = useState<Record<string, string>>({});
    // Bulk selection keys: favorite id on 我的单词, `mastered:<normalized word>`
    // on 已掌握 (a mastered word may have no favorite record). `bulkSummary`
    // carries the per-item failure text and is cleared on the next action.
    const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
    const [bulkBusy, setBulkBusy] = useState(false);
    const [bulkSummary, setBulkSummary] = useState<string | null>(null);
    const [bulkRowErrors, setBulkRowErrors] = useState<Record<string, string>>({});
    const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
    /** Which bulk button is running (one spinner, every button disabled). */
    const [bulkAction, setBulkAction] = useState<'review' | 'master' | 'unmaster' | 'delete' | null>(null);
    /** Row delete in flight (single-row delete disables itself, no double send). */
    const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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
                setMasteredReady(true);
                setMasteredPhase('ready');
            })
            .catch(() => {
                if (cancelled) return;
                setMasteredPhase('error');
            });
        return () => { cancelled = true; };
    }, [activeIsMine, activeIsMastered, isGuest, targetLang, masteredNonce]);

    // 状态 filter source (specs/005 §v1.2): one read of the signed-in review deck,
    // reduced to `normalized lemma → state`. Fetched once per screen mount (list
    // tabs use it for their initial 已在复习 state too). Guests never call it; a
    // 403 (no account) / 404 (endpoint not deployed) / any other failure sets the
    // phase to `unavailable`, which hides the chips instead of reporting an error.
    useEffect(() => {
        if (isGuest) {
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

    /** The 状态 group is only offered when the endpoint answered successfully. */
    const stateFilterAvailable = !isGuest && statePhase === 'ready';
    /** Chips keep their slot while loading (disabled), so the toolbar does not jump. */
    const stateFilterVisible = !isGuest && (statePhase === 'loading' || statePhase === 'ready');
    const effectiveMineState: WordStateFilter | '' = stateFilterAvailable ? mineState : '';

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

    // 我的单词 count: favorites that are not mastered. The two tabs partition
    // the word surface, so a mastered favorite is never counted twice.
    const masteredCount = useMemo(
        () => myWords.filter((fav) => masteredWords.has(normalizeMasteryWord(fav.en_text))).length,
        [myWords, masteredWords],
    );
    const learningCount = myWords.length - masteredCount;
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

    const mineSourceKinds = useMemo(() => {
        const present = new Set(myWords.map((fav) => resolveFavoriteSource(fav).kind));
        return SOURCE_KIND_ORDER.filter((kind) => present.has(kind));
    }, [myWords]);

    const hasMineFilters = Boolean(mineType || mineSource || mineDebouncedQuery || effectiveMineState);

    /** Normalized words that already have a vocabulary favorite (加入 → 已加入). */
    const favoritedWordKeys = useMemo(
        () => new Set(myWords.map((fav) => normalizeMasteryWord(fav.en_text)).filter(Boolean)),
        [myWords],
    );

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
     * 已掌握 rows: the mastered set (server for signed-in, local for guests)
     * enriched with the favorite's word casing + `/ipa/ 释义`; a mastered word
     * without a favorite keeps the lemma and renders `—` for both. Sorted by
     * word so client paging is stable across re-renders.
     */
    const masteredRows = useMemo(() => {
        const rows: Array<{ key: string; word: string; phonetic: string; translation: string }> = [];
        for (const key of masteredWords) {
            const fav = favoriteByWord.get(key);
            const word = fav ? fav.en_text.trim() : (masteredLabels[key] ?? key).trim();
            if (!word) continue;
            const split = fav ? splitIpaAndMeaning(fav.zh_text) : { ipa: null, meaning: '' };
            rows.push({
                key,
                word,
                phonetic: split.ipa || '—',
                translation: split.meaning || '—',
            });
        }
        rows.sort((a, b) => (
            a.word.toLowerCase().localeCompare(b.word.toLowerCase()) || a.word.localeCompare(b.word)
        ));
        return rows;
    }, [masteredWords, favoriteByWord, masteredLabels]);

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
        const stateMembers = effectiveMineState ? WORD_STATE_FILTER_STATES[effectiveMineState] : null;
        const filtered = myWords.filter((fav) => {
            // 已掌握 rows live in their own tab only (mutually exclusive lists).
            if (masteredWords.has(normalizeMasteryWord(fav.en_text))) return false;
            if (mineType === 'word' && isPhrase(fav)) return false;
            if (mineType === 'phrase' && !isPhrase(fav)) return false;
            if (mineSource && resolveFavoriteSource(fav).kind !== mineSource) return false;
            // 状态 filter: a word with no review record has no state, so it can
            // never match a specific state (only 全部 keeps it) — honest, and
            // the group is hidden whenever the state read failed.
            if (stateMembers) {
                const state = wordStates[normalizeMasteryWord(fav.en_text)];
                if (!state || !stateMembers.includes(state)) return false;
            }
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
        myWords, mineType, mineSource, mineSort, masteredWords, seenCounts, levels,
        mineDebouncedQuery, effectiveMineState, wordStates,
    ]);

    // 我的单词 is client paged 50/page (a collection can pass a hundred favorites
    // and the favorites API has no offset paging) — same page strip as the lists.
    const minePages = Math.max(1, Math.ceil(mineRows.length / VOCABULARY_PAGE_SIZE));
    const currentMinePage = Math.min(Math.max(1, minePage), minePages);
    const minePageRows = useMemo(() => {
        const start = (currentMinePage - 1) * VOCABULARY_PAGE_SIZE;
        return mineRows.slice(start, start + VOCABULARY_PAGE_SIZE);
    }, [mineRows, currentMinePage]);

    const seenTitle = isGuest
        ? t('vocab.mine.seen.guest')
        : seenPhase === 'unavailable'
            ? t('vocab.mine.seen.unavailable')
            : seenPhase === 'loading'
                ? t('vocab.mine.seen.loading')
                : undefined;
    const seenText = (fav: FavoriteItem): string => {
        if (isGuest || seenPhase !== 'ready') return '—';
        const count = seenCounts[fav.en_text.trim()];
        return typeof count === 'number' ? t('vocab.mine.seen', { count: formatNumber(count) }) : '—';
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
    }, [mineDebouncedQuery, mineType, mineSource, mineSort, effectiveMineState]);

    const toggleSelected = useCallback((id: string, checked: boolean) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            if (checked) next.add(id);
            else next.delete(id);
            return next;
        });
        setBulkSummary(null);
    }, []);

    const clearSelection = useCallback(() => {
        setSelectedIds(new Set());
        setBulkSummary(null);
        setBulkRowErrors({});
    }, []);

    /** Select-all only ever covers the rows currently on screen (one page). */
    const toggleSelectAll = useCallback((ids: readonly string[], checked: boolean) => {
        setSelectedIds((prev) => {
            const next = new Set(prev);
            for (const id of ids) {
                if (checked) next.add(id);
                else next.delete(id);
            }
            return next;
        });
        setBulkSummary(null);
    }, []);

    const speakRow = useCallback((text: string) => {
        const value = text.trim();
        if (value) speak(value);
    }, []);

    /** Locale-aware list join for the bulk failure summary (no separator key). */
    const formatList = useCallback((items: readonly string[]): string => {
        if (items.length === 0) return '';
        try {
            return new Intl.ListFormat(targetLang, { style: 'short', type: 'conjunction' })
                .format(items);
        } catch {
            return items.join(', ');
        }
    }, [targetLang]);

    // ── 加入我的单词 / 加入复习 (built-in lists + phrases) ──────────────────
    // Both writes are idempotent server-side; the row only ever shows
    // 已加入 / 已在复习 after the request resolved, and a failure leaves an
    // inline, retryable error on that row (IX-02 row level, never a fake state).
    const addListWordToMine = async (input: {
        rowKey: string;
        word: string;
        translation: string;
        phonetic?: string | null;
        listId: string;
        listLabel: string;
    }) => {
        if (mineAdds[input.rowKey] === 'busy' || mineAdds[input.rowKey] === 'added') return;
        if (isGuest) {
            openLogin();
            return;
        }
        const word = input.word.trim();
        if (!word) return;
        const zhText = [input.phonetic?.trim(), input.translation.trim()].filter(Boolean).join(' ');
        setMineAdds((prev) => ({ ...prev, [input.rowKey]: 'busy' }));
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
            zh_text: zhText,
            added_at: Date.now(),
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
            setMineAdds((prev) => ({ ...prev, [input.rowKey]: 'added' }));
            toast.success(t('vocab.toast.added'), { dedupeKey: 'favorites:added' });
        } catch {
            setMineAdds((prev) => ({ ...prev, [input.rowKey]: 'idle' }));
            setListRowErrors((prev) => ({ ...prev, [input.rowKey]: t('vocab.list.addError') }));
        }
    };

    const addListWordToReview = async (input: {
        rowKey: string;
        word: string;
        listId: string;
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

    /** Where one row's 加入我的单词 control stands when it renders. */
    const rowMineAddState = (rowKey: string, word: string): RowAddState => {
        const local = mineAdds[rowKey];
        if (local) return local;
        return favoritedWordKeys.has(normalizeMasteryWord(word)) ? 'added' : 'idle';
    };
    const rowReviewAddState = (rowKey: string, word: string): RowAddState => {
        const local = reviewAdds[rowKey];
        if (local) return local;
        // A word the deck already tracks (state read succeeded) is 已在复习 even
        // when it was added somewhere else.
        return stateFilterAvailable && wordStates[normalizeMasteryWord(word)] ? 'added' : 'idle';
    };

    /** Shared action descriptors for the list/phrase rows (label flips on done). */
    const rowAddActions = (input: {
        rowKey: string;
        word: string;
        translation: string;
        phonetic?: string | null;
        listId: string;
        listLabel: string;
    }): WordRowAction[] => {
        const mineState = rowMineAddState(input.rowKey, input.word);
        const reviewState = rowReviewAddState(input.rowKey, input.word);
        const mineLabel = mineState === 'added' ? t('vocab.list.added') : t('vocab.list.addMine');
        const reviewLabel = reviewState === 'added' ? t('vocab.review.added') : t('vocab.review.add');
        return [
            {
                key: 'mine',
                label: `${mineLabel} ${input.word}`,
                text: mineLabel,
                icon: BookmarkPlus,
                testId: `${input.rowKey}-add-mine`,
                busy: mineState === 'busy',
                done: mineState === 'added',
                disabled: mineState === 'added',
                onClick: () => { void addListWordToMine(input); },
            },
            {
                key: 'review',
                label: `${reviewLabel} ${input.word}`,
                text: reviewLabel,
                icon: Repeat,
                testId: `${input.rowKey}-add-review`,
                busy: reviewState === 'busy',
                done: reviewState === 'added',
                disabled: reviewState === 'added',
                onClick: () => { void addListWordToReview({ rowKey: input.rowKey, word: input.word, listId: input.listId }); },
            },
        ];
    };

    /** 朗读 control, disabled (with a reason) when no English voice exists. */
    const rowSpeakAction = (input: { rowKey: string; text: string }): WordRowAction => ({
        key: 'speak',
        label: speechDisabled
            ? t('vocab.speak.unavailable')
            : t('vocab.speak.word', { word: input.text }),
        icon: Volume2,
        testId: `${input.rowKey}-speak`,
        disabled: speechDisabled,
        onClick: () => speakRow(input.text),
    });

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
            if (masteredWords.has(key)) writeMasteredState(lemma, false);
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
        try {
            const result = await setWordMastered({
                lemma,
                mastered: next,
                targetLang,
                source: reviewSourceFor(fav),
            });
            // The PATCH response is authoritative for the post-write mark.
            writeMasteredState(lemma, result.word.mastered === true);
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
            toast.success(t('vocab.review.toast.unmastered'), { dedupeKey: 'review:fav-mastered' });
        } catch {
            writeMasteredState(lemma, true); // roll the row back into the table
            setRowError({ id: `mastered:${row.key}`, message: t('vocab.review.error.mastered') });
        } finally {
            setPendingMasteredId(null);
        }
    };

    // ── v1.2 batch operations (我的单词 / 已掌握) ──────────────────────────
    // Every item is written one at a time and nothing is reported as done
    // before the server confirmed it: the failed rows keep their selection and
    // an inline error, so retrying is just pressing the same button again.
    const mineSelected = useMemo(
        () => myWords.filter((fav) => selectedIds.has(fav.id)),
        [myWords, selectedIds],
    );
    const masteredSelected = useMemo(
        () => masteredRows.filter((row) => selectedIds.has(`mastered:${row.key}`)),
        [masteredRows, selectedIds],
    );

    /**
     * Delete one favorite and keep both layers honest. The API call here is the
     * authoritative result (batch needs per-item success/failure); App's
     * optimistic handler then runs for favorites App already knows, so its list
     * and the sidebar count drop the row too. App's `removeFavorite` treats the
     * resulting 404 as success, so the follow-up call is a silent no-op.
     */
    const deleteFavoriteById = async (id: string) => {
        await removeFavorite(id);
        if (favorites.some((fav) => fav.id === id)) onRemoveFavorite(id);
        setAddedFavorites((prev) => prev.filter((fav) => fav.id !== id));
    };

    const runBulk = async (
        action: 'review' | 'master' | 'unmaster' | 'delete',
        targets: Array<{ id: string; label: string; run: () => Promise<void> }>,
        successText: (count: number) => string,
    ) => {
        if (bulkBusy || targets.length === 0) return;
        setBulkBusy(true);
        setBulkAction(action);
        setBulkSummary(null);
        setBulkRowErrors({});
        const failed: Array<{ id: string; label: string }> = [];
        let succeeded = 0;
        for (const target of targets) {
            try {
                await target.run();
                succeeded += 1;
            } catch {
                failed.push({ id: target.id, label: target.label });
            }
        }
        setBulkRowErrors(Object.fromEntries(
            failed.map((item) => [item.id, t('vocab.bulk.rowError')]),
        ));
        // Only failures stay selected; successes are done and out of the way.
        setSelectedIds(new Set(failed.map((item) => item.id)));
        setBulkBusy(false);
        setBulkAction(null);
        if (failed.length > 0) {
            const summary = t('vocab.bulk.failed', {
                count: failed.length,
                items: formatList(failed.slice(0, 3).map((item) => item.label)),
            });
            setBulkSummary(summary);
            toast.error(summary, { dedupeKey: 'vocab:bulk' });
            return;
        }
        toast.success(successText(succeeded), { dedupeKey: 'vocab:bulk' });
    };

    /** 批量「加入复习」: signed-in only (guest gate at the entry, never a 403). */
    const handleBulkAddReview = () => {
        if (bulkBusy) return;
        if (isGuest) {
            openLogin();
            return;
        }
        const rows = mineSelected.filter((fav) => fav.en_text.trim());
        void runBulk('review', rows.map((fav) => {
            const lemma = fav.en_text.trim();
            const key = normalizeMasteryWord(lemma);
            return {
                id: fav.id,
                label: lemma,
                run: async () => {
                    await addWord({ lemma, targetLang, source: reviewSourceFor(fav) });
                    // Adding re-opens a mastered word (specs/013), same as the
                    // single-row entry.
                    if (masteredWords.has(key)) writeMasteredState(lemma, false);
                    setReviewedWords((prev) => new Set(prev).add(key));
                },
            };
        }), (count) => t('vocab.bulk.reviewDone', { count }));
    };

    /** 批量「标为已掌握」(我的单词) / 「撤销已掌握」(已掌握). */
    const handleBulkSetMastered = (mastered: boolean) => {
        if (bulkBusy) return;
        if (mastered) {
            const rows = mineSelected.filter((fav) => fav.en_text.trim());
            void runBulk('master', rows.map((fav) => {
                const lemma = fav.en_text.trim();
                return {
                    id: fav.id,
                    label: lemma,
                    run: async () => {
                        if (isGuest) {
                            writeMasteredState(lemma, true);
                            return;
                        }
                        const result = await setWordMastered({
                            lemma,
                            mastered: true,
                            targetLang,
                            source: reviewSourceFor(fav),
                        });
                        writeMasteredState(lemma, result.word.mastered === true);
                    },
                };
            }), (count) => t('vocab.bulk.masterDone', { count }));
            return;
        }
        void runBulk('unmaster', masteredSelected.map((row) => {
            const lemma = row.word.trim();
            const fav = favoriteByWord.get(row.key);
            return {
                id: `mastered:${row.key}`,
                label: row.word,
                run: async () => {
                    if (!lemma) throw new Error('empty lemma');
                    if (isGuest) {
                        writeMasteredState(lemma, false);
                        return;
                    }
                    const result = await setWordMastered({
                        lemma,
                        mastered: false,
                        targetLang,
                        ...(fav ? { source: reviewSourceFor(fav) } : {}),
                    });
                    writeMasteredState(lemma, result.word.mastered === true);
                },
            };
        }), (count) => t('vocab.bulk.unmasterDone', { count }));
    };

    /** Rows the 删除收藏 batch can act on (a mastered word may have no favorite). */
    const bulkDeletableFavorites = useMemo(
        () => (activeIsMine
            ? mineSelected
            : masteredSelected
                .map((row) => favoriteByWord.get(row.key))
                .filter((fav): fav is FavoriteItem => Boolean(fav))),
        [activeIsMine, mineSelected, masteredSelected, favoriteByWord],
    );

    const handleBulkDelete = async () => {
        if (bulkBusy) return;
        const rows = bulkDeletableFavorites;
        await runBulk('delete', rows.map((fav) => ({
            id: fav.id,
            label: fav.en_text.trim(),
            run: () => deleteFavoriteById(fav.id),
        })), (count) => t('vocab.bulk.deleteDone', { count }));
    };

    /** Single-row delete from the expanded detail — same authoritative path. */
    const handleRowDelete = async (fav: FavoriteItem) => {
        if (pendingDeleteId) return;
        setRowError(null);
        setPendingDeleteId(fav.id);
        try {
            await deleteFavoriteById(fav.id);
            toast.success(t('vocab.toast.removed'), { dedupeKey: 'favorites:removed' });
        } catch {
            setRowError({ id: fav.id, message: t('vocab.delete.error') });
        } finally {
            setPendingDeleteId(null);
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
        // 我的单词 and 已掌握 also restart clean (first page, default sort, no
        // filters/search/state, empty selection) — specs/005 §v1.2.
        setMasteredPage(1);
        setMineSort('added');
        setMineType('');
        setMineSource('');
        setMineQuery('');
        setMineDebouncedQuery('');
        setMineState('');
        setMinePage(1);
        setSelectedIds(new Set());
        setBulkSummary(null);
        setBulkRowErrors({});
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
    }, [activeTab, page, masteredPage, debouncedQuery, listLevel]);

    useEffect(() => {
        if (activeIsMine || activeIsMastered || activeUnavailable || activeTab === PHRASES_TAB) {
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
        if (activeTab === PHRASES_TAB) return renderPhrases();
        return renderList();
    };

    // The header total follows the active surface: it used to show the built-in
    // list total on every tab (「共 0 词」 on 我的单词/短语/已掌握). `null` means
    // "not known yet", so a failed or in-flight read never renders a fake 0 (G3).
    const headerTotalLabel = activeIsMine
        ? (masteredKnown ? t('vocab.total', { count: formatNumber(learningCount) }) : null)
        : activeIsMastered
            ? (masteredKnown ? t('vocab.total', { count: formatNumber(masteredRows.length) }) : null)
            : activeTab === PHRASES_TAB
                ? (phraseData ? phraseTotalLabel : null)
                : (listData ? totalLabel : null);

    const renderHeader = () => (
        <SubHeader
            title={t('vocab.title')}
            onBack={onBack}
            parentLabel={parentLabel}
            meta={headerTotalLabel != null
                ? <span data-testid="vocab-total">{headerTotalLabel}</span>
                : undefined}
            backTestId="vocab-back"
        />
    );

    const renderTabs = () => {
        const tabs: string[] = [MINE_TAB, MASTERED_TAB, PHRASES_TAB, ...LIST_TAB_IDS];
        const items: TabItem[] = tabs.map((id) => {
            const entry = catalogById.get(id);
            const unavailable = entry?.available === false;
            const label = id === MINE_TAB
                ? t('vocab.tab.mine')
                : id === MASTERED_TAB
                    ? masteredTabLabel
                    : id === PHRASES_TAB
                        ? t('vocab.tab.phrases')
                        : id === CEFR_TAB
                            ? t('vocab.tab.cefr')
                            : (entry?.label || FALLBACK_LABELS[id] || id);
            const count = id === MINE_TAB
                // Hidden until the signed-in mastered read succeeds: an unknown
                // mastered set must not be counted as learning words.
                ? (masteredKnown ? learningCount : null)
                : id === MASTERED_TAB
                    // The whole mastered collection, not just mastered favorites:
                    // unknown until the signed-in GET succeeds (never a fake 0).
                    ? (masteredKnown ? masteredWords.size : null)
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

    /**
     * Selection bar shared by 我的单词 and 已掌握. The select-all checkbox only
     * covers the rows on the current page (a paged list cannot select rows the
     * user has never seen), and the per-tab action set is passed in.
     */
    const renderBulkBar = (input: {
        scope: 'vocab-mine' | 'vocab-mastered';
        pageIds: readonly string[];
        selectedCount: number;
        actions: ReactNode;
    }) => {
        const allPageSelected = input.pageIds.length > 0
            && input.pageIds.every((id) => selectedIds.has(id));
        return (
            <div
                data-testid={`${input.scope}-bulk`}
                className="flex flex-wrap items-center gap-2 rounded-card border border-line-subtle bg-surface-2/40 px-3 py-2"
            >
                <Checkbox
                    checked={allPageSelected}
                    onChange={(checked) => toggleSelectAll(input.pageIds, checked)}
                    ariaLabel={t('vocab.bulk.selectAll')}
                    testId={`${input.scope}-select-all`}
                    disabled={bulkBusy || input.pageIds.length === 0}
                />
                <span
                    data-testid={`${input.scope}-selected`}
                    className="text-caption tabular-nums text-fg-muted"
                >
                    {t('vocab.bulk.selected', { count: formatNumber(input.selectedCount) })}
                </span>
                <div className="ms-auto flex flex-wrap items-center gap-1.5">
                    {input.actions}
                    {input.selectedCount > 0 && (
                        <Button
                            size="sm"
                            variant="ghost"
                            testId={`${input.scope}-bulk-clear`}
                            onClick={clearSelection}
                            disabled={bulkBusy}
                        >
                            {t('vocab.bulk.clear')}
                        </Button>
                    )}
                </div>
                {bulkSummary && (
                    <p
                        role="alert"
                        data-testid={`${input.scope}-bulk-summary`}
                        className="w-full text-caption leading-relaxed text-danger-fg"
                    >
                        {bulkSummary}
                    </p>
                )}
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

            {/* v1.2 (specs/005 §v1.2): client search + 状态 chips + 字母 A→Z.
                已掌握 is a tab of its own now, so 我的单词 only lists learning
                rows — the old in-page 学习/已掌握 segment is gone. */}
            <div className="flex flex-col gap-2 rounded-card border border-line-subtle bg-surface-2/40 px-3 py-2.5">
                <div className="relative min-w-0">
                    <Search
                        className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-muted"
                        aria-hidden="true"
                    />
                    <input
                        type="text"
                        data-testid="vocab-mine-search"
                        value={mineQuery}
                        onChange={(event) => setMineQuery(event.target.value)}
                        placeholder={t('vocab.mine.search.placeholder')}
                        aria-label={t('vocab.mine.search.placeholder')}
                        className="h-control-md w-full min-w-0 rounded-control border border-line-subtle bg-surface-2/60 ps-9 pe-9 text-ui text-fg-primary placeholder:text-fg-muted"
                    />
                    {mineQuery && (
                        <button
                            type="button"
                            data-testid="vocab-mine-search-clear"
                            onClick={() => setMineQuery('')}
                            aria-label={t('vocab.mine.search.clear')}
                            title={t('vocab.mine.search.clear')}
                            className="absolute end-1.5 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-control text-fg-muted transition-colors hover:bg-state-hover hover:text-fg-primary"
                        >
                            <X className="h-4 w-4" aria-hidden="true" />
                        </button>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-2">
                    <Segmented
                        size="sm"
                        ariaLabel={t('vocab.sort.label')}
                        layoutId="vocab-mine-sort"
                        testId="vocab-mine-sort"
                        value={mineSort}
                        onChange={(value) => setMineSort(value as MineSort)}
                        options={[
                            { value: 'added', label: t('vocab.sort.added'), testId: 'vocab-sort-added' },
                            { value: 'seen', label: t('vocab.sort.seen'), testId: 'vocab-sort-seen' },
                            { value: 'level', label: t('vocab.sort.level'), testId: 'vocab-sort-level' },
                            { value: 'alpha', label: t('vocab.sort.alpha'), testId: 'vocab-sort-alpha' },
                        ]}
                    />
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-caption text-fg-muted">{t('vocab.filter.type')}</span>
                    <FilterChip selected={mineType === ''} testId="vocab-filter-type-all" onClick={() => setMineType('')}>
                        {t('vocab.filter.all')}
                    </FilterChip>
                    <FilterChip selected={mineType === 'word'} testId="vocab-filter-type-word" onClick={() => setMineType('word')}>
                        {t('vocab.filter.word')}
                    </FilterChip>
                    <FilterChip selected={mineType === 'phrase'} testId="vocab-filter-type-phrase" onClick={() => setMineType('phrase')}>
                        {t('vocab.filter.phrase')}
                    </FilterChip>
                </div>

                <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-caption text-fg-muted">{t('vocab.filter.source')}</span>
                    <FilterChip selected={mineSource === ''} testId="vocab-filter-source-all" onClick={() => setMineSource('')}>
                        {t('vocab.filter.all')}
                    </FilterChip>
                    {mineSourceKinds.map((kind) => (
                        <FilterChip
                            key={kind}
                            selected={mineSource === kind}
                            testId={`vocab-filter-source-${kind}`}
                            onClick={() => setMineSource(kind)}
                        >
                            {t(SOURCE_LABEL_KEYS[kind])}
                        </FilterChip>
                    ))}
                </div>

                {/* 状态 chips: signed-in only, and only once `GET /api/review/words
                    ?state=` answered — a 403/404 hides the group, never an error
                    (specs/005 §v1.2). They are disabled while the read is in
                    flight so a click can never filter against an empty map. */}
                {stateFilterVisible && (
                    <div className="flex flex-wrap items-center gap-1.5" data-testid="vocab-state-filter">
                        <span className="mr-1 text-caption text-fg-muted">{t('vocab.state.filter')}</span>
                        <FilterChip
                            selected={effectiveMineState === ''}
                            testId="vocab-state-all"
                            disabled={statePhase !== 'ready'}
                            onClick={() => setMineState('')}
                        >
                            {t('vocab.filter.all')}
                        </FilterChip>
                        {WORD_STATE_FILTERS.map((state) => (
                            <FilterChip
                                key={state}
                                selected={effectiveMineState === state}
                                testId={`vocab-state-${state}`}
                                disabled={statePhase !== 'ready'}
                                onClick={() => setMineState(state)}
                            >
                                {t(WORD_STATE_LABEL_KEYS[state])}
                            </FilterChip>
                        ))}
                    </div>
                )}

                {hasMineFilters && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            testId="vocab-mine-clear-filters"
                            onClick={() => {
                                setMineType('');
                                setMineSource('');
                                setMineQuery('');
                                setMineState('');
                            }}
                        >
                            {t('vocab.filter.clear')}
                        </Button>
                    </div>
                )}
            </div>

            {/* The signed-in mastered list is a separate async read: until it
                succeeds, mastered words would show up here as unmastered. */}
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

            {myWords.length > 0 && renderBulkBar({
                scope: 'vocab-mine',
                pageIds: minePageRows.map((fav) => fav.id),
                selectedCount: mineSelected.length,
                actions: (
                    <>
                        <Button
                            size="sm"
                            variant="tinted"
                            tone="brand"
                            iconLeft={<Repeat />}
                            testId="vocab-mine-bulk-review"
                            loading={bulkAction === 'review'}
                            disabled={bulkBusy || mineSelected.length === 0}
                            onClick={handleBulkAddReview}
                        >
                            {t('vocab.review.add')}
                        </Button>
                        <Button
                            size="sm"
                            variant="tinted"
                            tone="success"
                            iconLeft={<CheckCircle2 />}
                            testId="vocab-mine-bulk-master"
                            loading={bulkAction === 'master'}
                            disabled={bulkBusy || mineSelected.length === 0}
                            onClick={() => handleBulkSetMastered(true)}
                        >
                            {t('vocab.bulk.master')}
                        </Button>
                        <Button
                            size="sm"
                            variant="destructive"
                            iconLeft={<Trash2 />}
                            testId="vocab-mine-bulk-delete"
                            loading={bulkAction === 'delete'}
                            disabled={bulkBusy || mineSelected.length === 0}
                            onClick={() => setBulkDeleteOpen(true)}
                        >
                            {t('vocab.bulk.delete')}
                        </Button>
                    </>
                ),
            })}

            {myWords.length === 0
                ? emptyState(t('vocab.empty.mine'), t('vocab.empty.mineHint'), Star, 'vocab-mine-empty')
                : mineRows.length === 0
                    ? hasMineFilters
                        ? emptyState(
                            t('vocab.mine.empty.filtered'),
                            t('vocab.mine.empty.filteredHint'),
                            Search,
                            'vocab-mine-filtered-empty',
                        )
                        : emptyState(
                            t('vocab.mine.empty.allMastered'),
                            t('vocab.mine.empty.allMasteredHint'),
                            CheckCircle2,
                            'vocab-mine-all-mastered',
                        )
                    : (
                    <>
                    <div data-testid="vocab-mine-list" className={`${CARD} divide-y divide-white/5 overflow-hidden`}>
                        {minePageRows.map((fav) => {
                            const { ipa, meaning } = splitIpaAndMeaning(fav.zh_text);
                            const isExpanded = Boolean(expanded[fav.id]);
                            const word = fav.en_text.trim();
                            const knownLevel = word in levels;
                            const level = levels[word] ?? null;
                            const levelLabel = level ?? 'C1+';
                            const source = sourceText(fav);
                            const SourceIcon = SOURCE_ICON[source.source.kind];
                            const masteredKey = normalizeMasteryWord(word);
                            const isReviewed = reviewedWords.has(masteredKey);
                            // Marking a word mastered moves it to the 已掌握 tab;
                            // undoing from there is the only reverse direction.
                            const masterLabel = isGuest ? t('vocab.review.guestMaster') : t('vocab.review.master');
                            const reviewLabel = isReviewed ? t('vocab.review.added') : t('vocab.review.add');
                            const addedAtLabel = fav.added_at
                                ? formatDate(fav.added_at)
                                : t('vocab.timeUnknown');
                            const isSelected = selectedIds.has(fav.id);
                            return (
                                <div key={fav.id} data-testid={`vocab-mine-${fav.id}`}>
                                    <div className="flex flex-wrap items-stretch">
                                    <div className="flex shrink-0 items-center ps-2">
                                        <Checkbox
                                            checked={isSelected}
                                            onChange={(checked) => toggleSelected(fav.id, checked)}
                                            ariaLabel={t('vocab.bulk.selectRow', { word })}
                                            testId={`vocab-mine-select-${fav.id}`}
                                            disabled={bulkBusy}
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        data-testid={`vocab-mine-toggle-${fav.id}`}
                                        aria-expanded={isExpanded}
                                        aria-controls={`vocab-mine-detail-${fav.id}`}
                                        aria-label={isExpanded ? t('common.collapse') : t('common.expand')}
                                        onClick={() => toggleExpanded(fav.id)}
                                        className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-state-hover sm:px-4"
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
                                    </div>

                                    {/* Secondary review entry points + provenance.
                                        The source link reopens the last place the
                                        word was saved from; seen counts are
                                        optional data (「—」 when unavailable). */}
                                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3.5 pb-2.5 sm:px-4">
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
                                            {source.canOpen && <ExternalLink className="h-3 w-3 shrink-0 opacity-70" aria-hidden="true" />}
                                        </button>
                                        <span
                                            data-testid={`vocab-mine-seen-${fav.id}`}
                                            className="text-caption tabular-nums text-fg-muted"
                                            title={seenTitle}
                                        >
                                            {seenText(fav)}
                                        </span>
                                        <span className="ms-auto flex items-center gap-1.5">
                                            <span
                                                className="inline-flex"
                                                title={speechDisabled
                                                    ? t('vocab.speak.unavailable')
                                                    : t('vocab.speak.word', { word })}
                                                onClick={(event) => event.stopPropagation()}
                                            >
                                                <IconButton
                                                    size="sm"
                                                    ariaLabel={speechDisabled
                                                        ? t('vocab.speak.unavailable')
                                                        : t('vocab.speak.word', { word })}
                                                    testId={`vocab-mine-speak-${fav.id}`}
                                                    disabled={speechDisabled}
                                                    onClick={() => speakRow(word)}
                                                >
                                                    <Volume2 className="h-4 w-4" aria-hidden="true" />
                                                </IconButton>
                                            </span>
                                            <Button
                                                size="sm"
                                                variant={isReviewed ? 'secondary' : 'tinted'}
                                                tone="brand"
                                                iconLeft={isReviewed ? <CheckCircle2 /> : <Repeat />}
                                                loading={pendingReviewId === fav.id}
                                                disabled={bulkBusy || Boolean(pendingReviewId || pendingMasteredId)}
                                                ariaLabel={reviewLabel}
                                                testId={`vocab-mine-review-${fav.id}`}
                                                onClick={() => { void handleAddFavoriteToReview(fav); }}
                                                className="[@media(pointer:coarse)]:min-h-11"
                                            >
                                                {reviewLabel}
                                            </Button>
                                            <Button
                                                size="sm"
                                                variant="tinted"
                                                tone="success"
                                                iconLeft={<CheckCircle2 />}
                                                loading={pendingMasteredId === fav.id}
                                                disabled={bulkBusy || Boolean(pendingReviewId || pendingMasteredId)}
                                                ariaLabel={masterLabel}
                                                testId={`vocab-mine-master-${fav.id}`}
                                                onClick={() => { void handleToggleFavoriteMastered(fav); }}
                                                className="[@media(pointer:coarse)]:min-h-11"
                                            >
                                                {masterLabel}
                                            </Button>
                                        </span>
                                    </div>
                                    {rowError?.id === fav.id && (
                                        <p
                                            data-testid={`vocab-mine-error-${fav.id}`}
                                            role="alert"
                                            className="px-3.5 pb-2 text-caption leading-relaxed text-danger-fg sm:px-4"
                                        >
                                            {rowError.message}
                                        </p>
                                    )}
                                    {bulkRowErrors[fav.id] && (
                                        <p
                                            data-testid={`vocab-mine-bulk-error-${fav.id}`}
                                            role="alert"
                                            className="px-3.5 pb-2 text-caption leading-relaxed text-danger-fg sm:px-4"
                                        >
                                            {bulkRowErrors[fav.id]}
                                        </p>
                                    )}

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
                                                            onClick={() => { void handleRowDelete(fav); }}
                                                            disabled={pendingDeleteId === fav.id}
                                                            aria-busy={pendingDeleteId === fav.id || undefined}
                                                            title={t('vocab.delete')}
                                                            className={`${DANGER_BUTTON} disabled:opacity-50 disabled:pointer-events-none`}
                                                        >
                                                            {pendingDeleteId === fav.id
                                                                ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                                                                : <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />}
                                                            {t('vocab.delete')}
                                                        </button>
                                                    </div>
                                                </div>
                                            </motion.div>
                                        )}
                                    </AnimatePresence>
                                </div>
                            );
                        })}
                    </div>
                    <span data-testid="vocab-mine-total" className="text-xs text-fg-muted tabular-nums">
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
                    />
                    </>
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

                                                {/* v1.2 row actions: 朗读 + 加入我的单词 +
                                                    加入复习. Same action line as the word
                                                    lists, so 已加入/已在复习 keeps a text
                                                    label at every width. */}
                                                <div className="flex flex-wrap items-center justify-end gap-1 px-4 pb-2">
                                                    <WordRowActionButton
                                                        action={rowSpeakAction({ rowKey, text: item.headword })}
                                                    />
                                                    {rowAddActions({
                                                        rowKey,
                                                        word: item.headword,
                                                        translation: item.translation,
                                                        listId: PHRASES_TAB,
                                                        listLabel: t('vocab.tab.phrases'),
                                                    }).map((action) => (
                                                        <WordRowActionButton key={action.key} action={action} />
                                                    ))}
                                                </div>
                                                {listRowErrors[rowKey] && (
                                                    <p
                                                        data-testid={`phrase-add-error-${item.id}`}
                                                        role="alert"
                                                        className="px-4 pb-2 text-caption leading-relaxed text-danger-fg"
                                                    >
                                                        {listRowErrors[rowKey]}
                                                    </p>
                                                )}

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

    /**
     * 已掌握 — a word list of its own (specs/005 §v1.1), rendered with the same
     * three-column table as the built-in lists: word + IPA / translation / CEFR
     * badge, honouring the global hide-Chinese switch, client paged 50/page
     * (the review API caps the mastered list at 200 and has no offset paging).
     */
    const renderMastered = () => {
        const ready = isGuest || masteredReady;
        const failed = !isGuest && masteredPhase === 'error';
        const pages = Math.max(1, Math.ceil(masteredRows.length / VOCABULARY_PAGE_SIZE));
        const currentPage = Math.min(Math.max(1, masteredPage), pages);
        const start = (currentPage - 1) * VOCABULARY_PAGE_SIZE;
        const pageRows = masteredRows.slice(start, start + VOCABULARY_PAGE_SIZE);
        const tableRows: WordTableRow[] = pageRows.map((row) => {
            const rowLevel = levels[row.word] ?? null;
            const selectionKey = `mastered:${row.key}`;
            const rowBulkError = bulkRowErrors[selectionKey];
            return {
                key: row.key,
                word: row.word,
                phonetic: row.phonetic,
                translation: row.translation,
                level: rowLevel,
                levelTitle: rowLevel ? `CEFR ${rowLevel}` : undefined,
                revealed: revealed.has(row.word),
                onActivate: hideChinese ? () => toggleReveal(row.word) : undefined,
                selection: {
                    checked: selectedIds.has(selectionKey),
                    onChange: (checked) => toggleSelected(selectionKey, checked),
                    label: t('vocab.bulk.selectRow', { word: row.word }),
                    testId: `vocab-mastered-select-${row.key}`,
                    disabled: bulkBusy,
                },
                actions: [
                    rowSpeakAction({ rowKey: `vocab-mastered-${row.key}`, text: row.word }),
                    {
                        key: 'undo',
                        label: `${t('vocab.review.undo')} ${row.word}`,
                        icon: Undo2,
                        testId: `vocab-mastered-undo-${row.key}`,
                        disabled: bulkBusy,
                        onClick: () => { void handleMasteredRowUndo(row); },
                    },
                ],
                error: rowError?.id === selectionKey
                    ? { message: rowError.message, testId: `vocab-mastered-error-${row.key}` }
                    : rowBulkError
                        ? { message: rowBulkError, testId: `vocab-mastered-bulk-error-${row.key}` }
                        : undefined,
            };
        });

        return (
            <div data-testid="vocab-mastered-panel" className="flex flex-col gap-3">
                <div className="flex flex-wrap items-center justify-end gap-2">
                    <button
                        type="button"
                        data-testid="vocab-hide-toggle"
                        data-scope="mastered"
                        aria-pressed={hideChinese}
                        onClick={toggleHideChinese}
                        title={hideChinese ? t('vocab.show') : t('vocab.hide')}
                        className={`inline-flex h-10 shrink-0 items-center justify-center gap-1.5 rounded-xl border px-3 text-xs font-medium transition-colors ${
                            hideChinese
                                ? 'border-brand/20 bg-brand/10 text-brand-300 hover:bg-brand/15'
                                : 'border-line-subtle bg-surface-2/60 text-fg-strong hover:bg-surface-3/60 hover:text-fg-primary'
                        }`}
                    >
                        {hideChinese ? <Eye className="h-4 w-4" aria-hidden="true" /> : <EyeOff className="h-4 w-4" aria-hidden="true" />}
                        {hideChinese ? t('vocab.show') : t('vocab.hide')}
                    </button>
                </div>

                {hideChinese && (
                    <p className="text-micro leading-relaxed text-fg-muted">{t('vocab.hint.hide')}</p>
                )}

                {/* Keep stale rows on a failed refresh; a first-load failure is an
                    error panel with retry, never an empty state (G3 / IX-01). */}
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
                        className={`${CARD} px-4 py-6`}
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
                        {renderBulkBar({
                            scope: 'vocab-mastered',
                            pageIds: pageRows.map((row) => `mastered:${row.key}`),
                            selectedCount: masteredSelected.length,
                            actions: (
                                <>
                                    <Button
                                        size="sm"
                                        variant="secondary"
                                        iconLeft={<Undo2 />}
                                        testId="vocab-mastered-bulk-unmaster"
                                        loading={bulkAction === 'unmaster'}
                                        disabled={bulkBusy || masteredSelected.length === 0}
                                        onClick={() => handleBulkSetMastered(false)}
                                    >
                                        {t('vocab.bulk.unmaster')}
                                    </Button>
                                    <Button
                                        size="sm"
                                        variant="destructive"
                                        iconLeft={<Trash2 />}
                                        testId="vocab-mastered-bulk-delete"
                                        loading={bulkAction === 'delete'}
                                        disabled={
                                            bulkBusy
                                            || masteredSelected.length === 0
                                            || bulkDeletableFavorites.length === 0
                                        }
                                        onClick={() => setBulkDeleteOpen(true)}
                                    >
                                        {t('vocab.bulk.delete')}
                                    </Button>
                                </>
                            ),
                        })}
                        <span
                            data-testid="vocab-mastered-total"
                            className="text-xs text-fg-muted tabular-nums"
                        >
                            {t('vocab.total', { count: formatNumber(masteredRows.length) })}
                        </span>
                        <WordTable
                            rows={tableRows}
                            hideChinese={hideChinese}
                            className={CARD}
                            listTestId="vocab-mastered-list"
                            testIdPrefix="vocab-mastered"
                        />
                        <VocabPagination
                            scope="vocab"
                            page={currentPage}
                            pages={pages}
                            hasMore={currentPage < pages}
                            onChange={setMasteredPage}
                        />
                    </>
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
                    <p className="text-micro leading-relaxed text-fg-muted">{t('vocab.hint.hide')}</p>
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
                            {/* Same table component as 已掌握 (VocabularyRows). */}
                            <WordTable
                                rows={listData.items.map((item, index) => {
                                    // Row key doubles as the write-state key and the
                                    // test id suffix: `<list id>:<word>`.
                                    const rowKey = `${activeTab}:${item.word}`;
                                    return {
                                        key: `${item.word}-${index}`,
                                        word: item.word,
                                        phonetic: item.phonetic,
                                        translation: item.translation,
                                        level: item.cefrLevel,
                                        levelTitle: item.cefrLevel ? `CEFR ${item.cefrLevel}` : undefined,
                                        revealed: revealed.has(item.word),
                                        onActivate: hideChinese ? () => toggleReveal(item.word) : undefined,
                                        actions: [
                                            rowSpeakAction({ rowKey, text: item.word }),
                                            ...rowAddActions({
                                                rowKey,
                                                word: item.word,
                                                translation: item.translation,
                                                phonetic: item.phonetic,
                                                listId: activeTab,
                                                listLabel: label,
                                            }),
                                        ],
                                        error: listRowErrors[rowKey]
                                            ? {
                                                message: listRowErrors[rowKey],
                                                testId: `vocab-list-error-${item.word}`,
                                            }
                                            : undefined,
                                    };
                                })}
                                hideChinese={hideChinese}
                                className={CARD}
                                listTestId="vocab-word-list"
                            />

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
                    {renderTabPanel()}
                </div>
            </div>
            </div>

            {/* 批量删除 always asks first (IX-03 / G8). The dialog owns Escape,
                backdrop, focus and the per-item progress; failures are reported
                afterwards by the bulk summary and keep their rows selected. */}
            <ConfirmDialog
                open={bulkDeleteOpen}
                title={t('vocab.bulk.deleteTitle', { count: formatNumber(bulkDeletableFavorites.length) })}
                description={t('vocab.bulk.deleteDesc')}
                confirmLabel={t('vocab.bulk.deleteConfirm', { count: formatNumber(bulkDeletableFavorites.length) })}
                onConfirm={handleBulkDelete}
                onClose={() => setBulkDeleteOpen(false)}
                testId="vocab-bulk-delete"
            />
        </div>
    );
}
