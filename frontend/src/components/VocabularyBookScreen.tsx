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
// C2 is intentionally not modelled by the backend (`available:false`): it is
// explained inside the CEFR tab instead of getting its own disabled tab.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    AlertTriangle,
    BookMarked,
    BookOpen,
    ChevronDown,
    CheckCircle2,
    Download,
    Eye,
    EyeOff,
    ExternalLink,
    FileSpreadsheet,
    FileText,
    Info,
    Loader2,
    Play,
    Repeat,
    Search,
    Star,
    Trash2,
    Tv,
    Undo2,
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
import { addWord, getMasteredWords, setWordMastered } from '../lib/review';
import { fetchSeenCounts } from '../lib/vocabSeen';
import { normalizeMasteryWord, readGuestMastered, writeGuestMastered } from '../lib/wordMastery';
import { describeApiError, toast } from '../lib/toast';
import { useAuth } from '../lib/auth';
import { useI18n } from '../i18n/I18nProvider';
import { VocabPagination } from './VocabPagination';
import { LevelBadge, WordTable, type WordTableRow } from './VocabularyRows';
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
type MineSort = 'added' | 'seen' | 'level';
type MineType = '' | 'word' | 'phrase';
type SeenPhase = 'idle' | 'loading' | 'ready' | 'unavailable';

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

/** Stable chip order for the source filter (product order, not data order). */
const SOURCE_KIND_ORDER: readonly FavoriteSourceKind[] = [
    'video',
    'local_show',
    'article',
    'library_article',
    'sentence_pack',
    'book',
    'imported_book',
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

    const hasMineFilters = Boolean(mineType || mineSource);

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
        const filtered = myWords.filter((fav) => {
            // 已掌握 rows live in their own tab only (mutually exclusive lists).
            if (masteredWords.has(normalizeMasteryWord(fav.en_text))) return false;
            if (mineType === 'word' && isPhrase(fav)) return false;
            if (mineType === 'phrase' && !isPhrase(fav)) return false;
            if (mineSource && resolveFavoriteSource(fav).kind !== mineSource) return false;
            return true;
        });
        const seenOf = (fav: FavoriteItem) => seenCounts[fav.en_text.trim()] ?? -1;
        return [...filtered].sort((a, b) => {
            if (mineSort === 'seen') {
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
    }, [myWords, mineType, mineSource, mineSort, masteredWords, seenCounts, levels]);

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
        // 我的单词 and 已掌握 also restart clean (first page, default sort, no filters).
        setMasteredPage(1);
        setMineSort('added');
        setMineType('');
        setMineSource('');
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

            {/* v1.1 sorting/filtering (specs/005 §v1.1). 已掌握 is a word list of
                its own tab now, so 我的单词 only lists the learning rows — the
                old in-page 学习/已掌握 segment is gone and the 未掌握 chip would
                be a no-op here. */}
            <div className="flex flex-col gap-2 rounded-card border border-line-subtle bg-surface-2/40 px-3 py-2.5">
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

                {hasMineFilters && (
                    <div className="flex flex-wrap items-center gap-2">
                        <Button
                            size="sm"
                            variant="ghost"
                            testId="vocab-mine-clear-filters"
                            onClick={() => {
                                setMineType('');
                                setMineSource('');
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
                    <div data-testid="vocab-mine-list" className={`${CARD} divide-y divide-white/5 overflow-hidden`}>
                        {mineRows.map((fav) => {
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
                                            <Button
                                                size="sm"
                                                variant={isReviewed ? 'secondary' : 'tinted'}
                                                tone="brand"
                                                iconLeft={isReviewed ? <CheckCircle2 /> : <Repeat />}
                                                loading={pendingReviewId === fav.id}
                                                disabled={Boolean(pendingReviewId || pendingMasteredId)}
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
                                                disabled={Boolean(pendingReviewId || pendingMasteredId)}
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
                                                            onClick={() => onRemoveFavorite(fav.id)}
                                                            title={t('vocab.delete')}
                                                            className={DANGER_BUTTON}
                                                        >
                                                            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
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
        const tableRows: WordTableRow[] = masteredRows
            .slice(start, start + VOCABULARY_PAGE_SIZE)
            .map((row) => {
                const rowLevel = levels[row.word] ?? null;
                return {
                    key: row.key,
                    word: row.word,
                    phonetic: row.phonetic,
                    translation: row.translation,
                    level: rowLevel,
                    levelTitle: rowLevel ? `CEFR ${rowLevel}` : undefined,
                    revealed: revealed.has(row.word),
                    onActivate: hideChinese ? () => toggleReveal(row.word) : undefined,
                    action: (
                        <IconButton
                            size="sm"
                            ariaLabel={`${t('vocab.review.undo')} ${row.word}`}
                            testId={`vocab-mastered-undo-${row.key}`}
                            onClick={() => { void handleMasteredRowUndo(row); }}
                        >
                            <Undo2 className="h-4 w-4" aria-hidden="true" />
                        </IconButton>
                    ),
                    error: rowError?.id === `mastered:${row.key}`
                        ? { message: rowError.message, testId: `vocab-mastered-error-${row.key}` }
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
                                rows={listData.items.map((item, index) => ({
                                    key: `${item.word}-${index}`,
                                    word: item.word,
                                    phonetic: item.phonetic,
                                    translation: item.translation,
                                    level: item.cefrLevel,
                                    levelTitle: item.cefrLevel ? `CEFR ${item.cefrLevel}` : undefined,
                                    revealed: revealed.has(item.word),
                                    onActivate: hideChinese ? () => toggleReveal(item.word) : undefined,
                                }))}
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
        </div>
    );
}
