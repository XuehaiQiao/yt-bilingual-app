import { apiFetch } from './lib/api';
import { CourseApiError, COURSE_MVP_LESSON_ID, generateCourse, isCourseAbortError } from './lib/course';
import { lazy, Suspense, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Star, ChevronDown, Loader2, XCircle, Repeat, Keyboard, EyeOff, PanelRightOpen, PanelRightClose, AlertTriangle, Play, Pause, GraduationCap, BookOpenCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { AuthScreen } from './components/AuthScreen';
import { WelcomeScreen } from './components/WelcomeScreen';
import { Dialog } from './components/ui/Dialog';
import { BackButton } from './components/ui/BackButton';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import { getLanguageMeta, getRuntimeTargetLang } from './i18n';
import type { TranslationKey } from './i18n';
import { ModelProvider } from './lib/model';
import { useNav } from './lib/useNav';
import { isAppHash, isDevUiHash, parsePublicRoute, parseRoute, resolveRoute, TASK_SUB_KINDS, toHash, type PublicView, type SectionAnchor, type SubRoute, type TabId } from './lib/nav';
import { VideoPlayer } from './components/VideoPlayer';
import { LocalEpisodeStage } from './components/LocalEpisodeStage';
import { TranscriptView } from './components/TranscriptView';
import type { InlineLanguagePoint } from './components/TranscriptBlock';
import { ReadingHighlightToggle } from './components/ReadingHighlight';
import { LanguagePointToggle } from './components/ui/LanguagePointToggle';
import { useReadingHighlights } from './lib/useReadingHighlights';
import { loadLanguagePointsEnabled } from './lib/highlightLayers';
import { TeachingNotesPanel, type TeachingNotesStatus } from './components/TeachingNotesPanel';
import { addFavorite, fetchFavorites, removeFavorite, type FavoriteDraft, type FavoriteItem } from './lib/favorites';
import { ChannelVideoList } from './components/ChannelVideoList';
import { Toaster } from './components/Toaster';
import { WordPopover, type WordDefinition, type WordLookupTarget } from './components/WordPopover';
import { SentenceView, sentenceFavId } from './components/SentenceView';
import { ReviewScreen } from './components/ReviewScreen';
import { QuizScreen } from './components/QuizScreen';
import { ReportScreen, type WeekReportEvidence } from './components/ReportScreen';
import { PlacementScreen } from './components/PlacementScreen';
import { AbilityScreen } from './components/AbilityScreen';
import { ExamScreen } from './components/ExamScreen';
import { DiscoverScreen } from './components/DiscoverScreen';
import { ReaderScreen } from './components/ReaderScreen';
import { LibraryArticleReader } from './components/LibraryArticleReader';
import { BookReaderScreen } from './components/BookReaderScreen';
import { BookSeriesScreen } from './components/BookSeriesScreen';
import { ImportedBookReaderScreen } from './components/ImportedBookReaderScreen';
import { PublicBlogScreen } from './components/PublicBlogScreen';
import { PricingScreen } from './components/PricingScreen';
import { ResourcesScreen } from './components/ResourcesScreen';
import { AdminConsoleScreen } from './components/AdminConsoleScreen';
import { OfflineIndicator } from './components/OfflineIndicator';
import { AppShell, type ProfileSectionId } from './components/AppShell';
import { LearningHeader } from './components/LearningHeader';
import { LocalVideoLearning } from './components/LocalVideoLearning';
import { buildLocalTranscript, readLocalSubtitleFile, type LocalTranscriptBlock } from './lib/localMedia';
import {
  buildLocalVideoId,
  getLocalVideo,
  putLocalVideo,
  type LocalVideoOpenMeta,
  type LocalVideoRecord,
} from './lib/localVideoLibrary';
import { TodayScreen } from './components/TodayScreen';
import { CourseScreen } from './components/CourseScreen';
import { ContentScreen } from './components/ContentScreen';
import { PracticeScreen } from './components/PracticeScreen';
import { ProfileScreen } from './components/ProfileScreen';
import { VocabularyBookScreen } from './components/VocabularyBookScreen';
import { toast, describeApiError } from './lib/toast';
import { getReviewStats, type ReviewStats } from './lib/review';
import { startLesson, QuizApiError, type LessonQuestions } from './lib/quiz';
import { endWatch, notePlayback, pauseWatch, startWatch } from './lib/events';
import {
  installLearningTelemetry,
  noteDictLookup,
  notePlaybackRate,
  noteVideoReplay,
  type ReplayMethod,
} from './lib/learningTelemetry';
import { segToPlain, CHUNK_STYLE, type Sentence, type SegChunk } from './lib/sentences';
import { consumeSseStream, findActiveIndex, isUntranslated, loadTranslationMode, TRANSLATION_MODE_KEY, type TranslationMode } from './lib/transcript';
import {
  clearPendingJob,
  fetchJobSnapshot,
  finishJob,
  loadPendingJob,
  recordJobMeta,
  recordJobProgress,
  type JobSnapshot,
  type PendingJob,
} from './lib/jobs';
import {
  hasSavedVocabLevel,
  loadVocabLevel,
  loadModel,
  saveVocabLevel,
  vocabLevelFromCefr,
  VOCAB_LEVEL_EVENT,
  type VocabLevelId,
} from './lib/settings';
import {
  applyTeachingAnalysisHighlights,
  fetchTeachingAnalysis,
  teachingAnalysisFromPayload,
  type TeachingAnalysis,
  type TeachingAnalysisIssue,
} from './lib/teachingAnalysis';
import {
  clampSplitRatio,
  DEFAULT_SPLIT_RATIO,
  loadSplitRatio,
  loadTranscriptLayout,
  MAX_SPLIT_RATIO,
  MIN_SPLIT_RATIO,
  saveSplitRatio,
  saveTranscriptLayout,
  type TranscriptLayout,
} from './lib/layout';
import { getProgress, saveProgress } from './lib/progress';
import { getProfile, type PlacementProfile } from './lib/placement';
import { fetchLibraryArticle, fetchLibraryVideo, type LibraryArticle } from './lib/library';
import ReactMarkdown from 'react-markdown';

// Dev-only component matrix (QA-X-31). Lazy so the chunk is never part of the
// app's first screen; `AuthGate` decides whether it may mount at all.
const DevUIScreen = lazy(() => import('./components/DevUIScreen'));

interface TranscriptItem {
  id: number;
  start: number;
  end: number;
  en_text: string;
  zh_text: string;
  highlights: Array<{
    en_word: string;
    zh_word: string;
    color: string;
  }>;
}

// How long an app-issued seek may take to reach the player before a backwards
// tick is treated as a user drag (CEFR M2 #7 video_replay).
const SEEK_SETTLE_MS = 2500;

// Desktop chrome (docs/信息架构-导航重构.md §4.1): immersive task views own the
// whole width, so the Sidebar and the primary tabs step aside. Panel-style sub
// views (discover / report / word book) keep the shell so their
// shortcut entry shows an active state. The set itself lives in `lib/nav.ts`
// (navigation-model §12.1) so QA and the shell share one definition.

// Breadcrumb fragment shown in the desktop top bar for each sub view.
const SUB_LABEL_KEYS: Record<SubRoute['kind'], TranslationKey> = {
  learn: 'topbar.feature.video',
  review: 'topbar.feature.review',
  report: 'topbar.feature.report',
  placement: 'topbar.feature.placement',
  exam: 'topbar.feature.exam',
  discover: 'topbar.feature.discover',
  reader: 'topbar.feature.reader',
  sentences: 'topbar.feature.sentences',
  book: 'topbar.feature.book',
  'book-series': 'topbar.feature.bookSeries',
  'imported-book': 'topbar.feature.importedBook',
  vocabulary: 'topbar.feature.vocabulary',
  ability: 'topbar.feature.ability',
  admin: 'topbar.feature.admin',
  course: 'topbar.feature.course',
};

/** Parent tab name for every sub-view back control's aria label. */
const SHOW_COURSE_GENERATION = false;

const PARENT_LABEL_KEYS: Record<TabId, TranslationKey> = {
  today: 'nav.today',
  content: 'nav.content',
  practice: 'nav.practice',
  profile: 'nav.profile',
};

/** Sections of the 我的 page the desktop sidebar can scroll to. */
const PROFILE_SECTION_TESTIDS: Record<Exclude<ProfileSectionId, 'account'>, string> = {
  balance: 'account-balance',
  settings: 'account-settings',
  about: 'account-about',
};

function formatClock(seconds: number): string {
  const safe = Number.isFinite(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
  const mm = Math.floor(safe / 60).toString().padStart(2, '0');
  const ss = (safe % 60).toString().padStart(2, '0');
  return `${mm}:${ss}`;
}

// Local-episode refs can arrive as `<show>_S01E01`, `<show>-S01E01` or
// `<show>/S01E01` (specs/015 normalizes them server-side). Report evidence
// uses the canonical form; compare both sides through this shape.
function normalizeLocalContentRef(ref: string): string {
  const match = ref.match(/^(.+?)[-_/]S(\d+)E(\d+)$/i);
  if (!match) return ref;
  return `${match[1].toLowerCase()}-S${match[2].padStart(2, '0')}E${match[3].padStart(2, '0')}`;
}

function contentRefMatches(
  evidence: { contentRef: string; kind: 'video' | 'local_show' },
  videoId: string,
  isLocalSubtitle: boolean,
): boolean {
  if (evidence.kind === 'local_show' && isLocalSubtitle) {
    return normalizeLocalContentRef(evidence.contentRef) === normalizeLocalContentRef(videoId);
  }
  return evidence.contentRef === videoId;
}

function AppContent({ onRequestLogin }: { onRequestLogin?: () => void }) {
  const { user, status, isAdmin, dataRevision } = useAuth();
  const { t, language, targetLang } = useI18n();
  const { state, go, open, replace, back, openAnchor } = useNav();
  // Sub-view back controls name the source tab as the parent (NM §5.1).
  const parentLabel = t(PARENT_LABEL_KEYS[state.tab]);

  const [videoId, setVideoId] = useState('');
  const [loadingState, setLoadingState] = useState<'processing' | 'loading' | 'asr' | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [localVideo, setLocalVideo] = useState<{
    videoUrl: string;
    fileName: string;
    subtitleName?: string;
    transcript: LocalTranscriptBlock[];
    /** Present only for a session backed by a saved file handle. */
    recordId?: string;
    /** Saved playback position, applied once the video metadata is known. */
    initialTime: number;
  } | null>(null);
  // Bumped after a local video session closes so the Content shelf re-reads
  // the cover/progress/subtitle written while the player was open.
  const [localVideoLibraryRevision, setLocalVideoLibraryRevision] = useState(0);
  const localVideoPatchQueue = useRef<Promise<void>>(Promise.resolve());
  const localVideoLatestTime = useRef(0);
  const localVideoProgressSavedAt = useRef(0);
  const [summary, setSummary] = useState<string>('');
  const [metadata, setMetadata] = useState<any>(null);
  const isLocalSubtitle = Boolean(metadata?.is_local_subtitle);
  // Free library videos are pre-built: blocks arrive from /api/library/videos,
  // the player still embeds YouTube, and nothing in this path calls the
  // estimate/processing/translation endpoints.
  const isLibraryVideo = Boolean(metadata?.is_library);
  // Local episodes may be mapped to a real YouTube video (frozen backend
  // contract: payload.metadata.youtube_video_id). When present, the same
  // VideoPlayer as the "看视频" branch drives playback; otherwise the local
  // episode keeps its simulated wall-clock player.
  const localYouTubeId = isLocalSubtitle && typeof metadata?.youtube_video_id === 'string'
    ? metadata.youtube_video_id.trim()
    : '';
  const hasLocalVideo = localYouTubeId.length > 0;
  // Player failure must never block subtitle learning: when the embed errors
  // out we fall back to the simulated clock for seeking/highlighting.
  const [localVideoError, setLocalVideoError] = useState(false);
  const localVideoFallback = hasLocalVideo && localVideoError;
  const useSubtitleTimer = isLocalSubtitle && (!hasLocalVideo || localVideoFallback);
  const [isSummaryOpen, setIsSummaryOpen] = useState(false);
  const [isVocabOpen, setIsVocabOpen] = useState(false);
  // Learning-view layout: transcript placement (`stacked` under the media vs
  // `split` docked right) and the draggable left-column ratio. Both persist.
  const [transcriptLayout, setTranscriptLayout] = useState<TranscriptLayout>(loadTranscriptLayout);
  const [leftRatio, setLeftRatio] = useState<number>(loadSplitRatio);
  const [isResizing, setIsResizing] = useState(false);
  // The docked-right transcript is a desktop layout: mobile has exactly one
  // scroll container (layout §6.3), so a `split` preference saved on desktop
  // must not reorder the mobile page (summary before transcript). The stored
  // preference is kept, so going back to desktop restores it untouched.
  const [isCompactViewport, setIsCompactViewport] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 767.98px)').matches
      : false,
  );
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767.98px)');
    const onChange = () => setIsCompactViewport(media.matches);
    media.addEventListener?.('change', onChange);
    return () => media.removeEventListener?.('change', onChange);
  }, []);
  const isTranscriptExpanded = transcriptLayout === 'split' && !isCompactViewport;
  const fullscreenWrapperRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekCommand, setSeekCommand] = useState<{ time: number, timestamp: number } | null>(null);

  // Free library article: rendered by the local reader inside the learn route.
  const [libraryArticle, setLibraryArticle] = useState<LibraryArticle | null>(null);

  // Ability profile (M4): fetched once at app level so Today / Practice /
  // Profile all read the same value (P0 IA §10.3).
  const [placementProfile, setPlacementProfile] = useState<PlacementProfile | null>(null);
  const [placementLoading, setPlacementLoading] = useState(true);
  const [placementFailed, setPlacementFailed] = useState(false);
  const [placementNonce, setPlacementNonce] = useState(0);

  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null);
  const [reviewStatsLoading, setReviewStatsLoading] = useState(false);
  const [reviewStatsFailed, setReviewStatsFailed] = useState(false);
  // Bumped whenever a review/exam/learning view closes so badges refetch.
  const [reviewStatsNonce, setReviewStatsNonce] = useState(0);

  // Comprehension quiz (M3 / specs/014) — an in-page overlay of the learning
  // view (P0 IA §7.1: the quiz is not a route; a refresh lands on the video).
  const [quizOpen, setQuizOpen] = useState(false);
  const [quizLesson, setQuizLesson] = useState<LessonQuestions | null>(null);
  const [quizStarting, setQuizStarting] = useState(false);
  const [quizCacheReady, setQuizCacheReady] = useState(false);
  // Synchronous guard: a double click on the entry must not fire two
  // `startLesson` requests (a cache miss calls the model once per request).
  const quizStartBusyRef = useRef(false);
  // Course generation (specs/030) — one in-flight request per video. The
  // backend caches by content, but two rapid clicks would still both hit the
  // generator before the first result lands.
  const [courseGenerating, setCourseGenerating] = useState(false);
  const courseGeneratingRef = useRef(false);
  // Where the player was when the quiz opened; leaving the quiz (not via an
  // evidence link) returns there instead of restarting the video at 0.
  const quizReturnTimeRef = useRef(0);
  // `currentTime` can keep advancing while `/api/lesson/start` is in flight;
  // a ref lets the handler read the latest value after the await.
  const currentTimeRef = useRef(0);
  // CEFR M2 #7 replay baseline: the last position the learner actually saw.
  // Kept separate from `currentTime` so a click-seek can be classified as
  // backwards even before the YouTube player reports its new position.
  const playbackPositionRef = useRef(0);
  const lastSeekTargetRef = useRef<{ time: number; at: number } | null>(null);

  // Dictation (blind listening) mode: English blurred until revealed per sentence
  const [dictationMode, setDictationMode] = useState(false);

  // Handover state for the Start-learning input's non-YouTube modes. The
  // screens consume and clear these once, so a normal nav-menu entry never
  // replays an old topic/import.
  const [discoverInitialQuery, setDiscoverInitialQuery] = useState<string | null>(null);
  const [readerInitialImport, setReaderInitialImport] = useState<
    { mode: 'url' | 'text'; value: string; title?: string } | null
  >(null);
  // Handover from the article reader: a public-domain book link is not an
  // article, so switch to the content page and open the book-import dialog with
  // the URL prefilled.
  const [bookImportSeed, setBookImportSeed] = useState<
    { url: string; nonce: number } | null
  >(null);

  // Click-to-define dictionary popover
  const [wordLookup, setWordLookup] = useState<WordLookupTarget | null>(null);

  const handleWordLookup = useCallback((word: string, sentence: string, start: number, e: React.MouseEvent) => {
    setWordLookup({ word, context: sentence, start, x: e.clientX, y: e.clientY });
  }, []);

  // Reading lookups carry the article id/title so the star in the dictionary
  // card saves the word under that article (and the favorites "出处" row can
  // name/link it) instead of the (empty) current video.
  const handleReaderWordLookup = useCallback((
    word: string,
    sentence: string,
    start: number,
    e: React.MouseEvent,
    sourceId?: string,
    sourceTitle?: string,
  ) => {
    setWordLookup({
      word,
      context: sentence,
      start,
      x: e.clientX,
      y: e.clientY,
      ...(sourceId ? { sourceId, sourceTitle, sourceKind: 'article' as const } : {}),
    });
  }, []);

  // Free library articles are local content with their own route, so their
  // words carry a distinct source kind: the favorites "出处" row must be able
  // to reopen `#/app/content/learn/library/<id>` instead of the reading API article route.
  const handleLibraryArticleWordLookup = useCallback((
    word: string,
    sentence: string,
    start: number,
    e: React.MouseEvent,
    sourceId?: string,
    sourceTitle?: string,
  ) => {
    setWordLookup({
      word,
      context: sentence,
      start,
      x: e.clientX,
      y: e.clientY,
      ...(sourceId ? { sourceId, sourceTitle, sourceKind: 'library_article' as const } : {}),
    });
  }, []);

  // Public-domain books and imported books pass their id/title through the
  // reader, so a saved word can jump back to the exact book (书籍 source).
  const handleBookWordLookup = useCallback((
    word: string,
    sentence: string,
    start: number,
    e: React.MouseEvent,
    source?: { id: string; title?: string },
  ) => {
    setWordLookup({
      word,
      context: sentence,
      start,
      x: e.clientX,
      y: e.clientY,
      ...(source?.id ? { sourceId: source.id, sourceTitle: source.title, sourceKind: 'book' as const } : {}),
    });
  }, []);

  const handleImportedBookWordLookup = useCallback((
    word: string,
    sentence: string,
    start: number,
    e: React.MouseEvent,
    source?: { id: string; title?: string },
  ) => {
    setWordLookup({
      word,
      context: sentence,
      start,
      x: e.clientX,
      y: e.clientY,
      ...(source?.id ? { sourceId: source.id, sourceTitle: source.title, sourceKind: 'imported_book' as const } : {}),
    });
  }, []);

  // The article reader recognises public-domain book links and hands them here:
  // switch to the content page and open the book-import dialog prefilled.
  const handleImportPublicDomainBook = useCallback((url: string) => {
    setBookImportSeed({ url, nonce: Date.now() });
    go('content');
  }, [go]);

  // Hover-to-switch: the card stays mounted; only its target word/position
  // changes. Guard against a stale dwell timer firing after the card closed.
  const handleSwitchWord = useCallback((target: WordLookupTarget) => {
    setWordLookup(prev => (prev ? {
      ...target,
      sourceId: prev.sourceId,
      sourceTitle: prev.sourceTitle,
      sourceKind: prev.sourceKind,
    } : prev));
  }, []);

  // CEFR M2 #7 `dict_lookup`: one event per opened/switched dictionary card.
  // The context sentence is deliberately not passed — only the word, its
  // content id and a coarse source are sent.
  useEffect(() => {
    if (!wordLookup) return;
    const sub = state.sub;
    const source = sub?.kind === 'book' || sub?.kind === 'imported-book'
      ? 'book'
      : sub?.kind === 'reader' || (sub?.kind === 'learn' && libraryArticle)
        ? 'reader'
        : sub?.kind === 'sentences'
          ? 'sentence'
          : 'transcript';
    const contentRef = wordLookup.sourceId
      || (sub?.kind === 'book' ? sub.bookId : undefined)
      || (sub?.kind === 'imported-book' ? sub.bookId : undefined)
      || (sub?.kind === 'learn' ? videoId : undefined)
      || undefined;
    noteDictLookup({ word: wordLookup.word, contentRef, source });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wordLookup]);

  // Playback controls: speed, play/pause command, single-sentence loop
  const [playbackRate, setPlaybackRate] = useState(1);
  const [playToggleCommand, setPlayToggleCommand] = useState<number | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const loopBlockRef = useRef<{ start: number; end: number } | null>(null);

  // Global policy for showing the Chinese line (persisted)
  const [translationMode, setTranslationMode] = useState<TranslationMode>(loadTranslationMode);
  useEffect(() => {
    localStorage.setItem(TRANSLATION_MODE_KEY, translationMode);
  }, [translationMode]);

  useEffect(() => {
    currentTimeRef.current = currentTime;
  }, [currentTime]);

  // CEFR M2 #7 tab_visibility: page-load listeners; the tracker only records
  // hidden/visible transitions plus the seconds the tab was visible.
  useEffect(() => {
    installLearningTelemetry();
  }, []);

  // New content starts a new replay baseline; otherwise a backwards jump on
  // video B would be measured against video A's position.
  useEffect(() => {
    playbackPositionRef.current = 0;
    lastSeekTargetRef.current = null;
  }, [videoId]);

  // Layout preferences: write the transcript placement immediately, and the
  // split ratio once a drag settles (no localStorage churn on every frame).
  useEffect(() => {
    saveTranscriptLayout(transcriptLayout);
  }, [transcriptLayout]);
  useEffect(() => {
    if (!isResizing) saveSplitRatio(leftRatio);
  }, [leftRatio, isResizing]);

  // While dragging the divider a transparent shield covers the page (and the
  // video iframe, which would otherwise swallow pointermove). Releasing
  // anywhere — including outside the window — ends the drag.
  useEffect(() => {
    if (!isResizing) return;
    const stop = () => setIsResizing(false);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    const prevUserSelect = document.body.style.userSelect;
    const prevCursor = document.body.style.cursor;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
      document.body.style.userSelect = prevUserSelect;
      document.body.style.cursor = prevCursor;
    };
  }, [isResizing]);

  // Streaming translation: progress info + abort handle + deferred seek
  const [translationProgress, setTranslationProgress] = useState<{ done: number; total: number; stage?: string } | null>(null);
  const streamAbortRef = useRef<AbortController | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  // Favorite jump into a local episode: consumed once the episode payload is
  // in state (the target may be a simulated timer or a real YouTube player).
  const pendingLocalSeekRef = useRef<number | null>(null);
  // Weekly-report evidence jump: contentRef + seconds, consumed by the same
  // post-load effect. It takes precedence over the resume-from-progress path.
  const pendingEvidenceSeekRef = useRef<{ contentRef: string; time: number; kind: 'video' | 'local_show' } | null>(null);

  // ── Teaching analysis (specs/028) ───────────────────────────────────────
  // Analysed content is shared across users and cached by
  // content_hash + level + target_lang. The page keeps the payload copy (from
  // a history cache that already carries idioms/culture) separate from the
  // endpoint copy, so the payload can win without an extra request while a
  // level switch still triggers a fresh lookup.
  const [vocabLevel, setVocabLevel] = useState<VocabLevelId>(loadVocabLevel);
  const [showLanguagePoints, setShowLanguagePoints] = useState<boolean>(loadLanguagePointsEnabled);
  const [payloadTeachingAnalysis, setPayloadTeachingAnalysis] = useState<{
    analysis: TeachingAnalysis;
    level: VocabLevelId;
    stale: boolean;
  } | null>(null);
  const [teachingAnalysis, setTeachingAnalysis] = useState<TeachingAnalysis | null>(null);
  // True only for endpoint results: those highlights are authoritative and
  // override the legacy per-block highlights in the translation payload.
  const [teachingHighlightsAuthoritative, setTeachingHighlightsAuthoritative] = useState(false);
  const [teachingNotesStatus, setTeachingNotesStatus] = useState<TeachingNotesStatus>('idle');
  const [teachingNotesRetry, setTeachingNotesRetry] = useState(0);
  // The payload only stores idioms/culture, not the level they were generated
  // for. Keep an entry per content ref, and mark every known payload stale when
  // the level changes: after a settings change the payload may still carry the
  // old level's analysis, so the endpoint (cache-first) wins even when a later
  // reopen shows that payload again.
  const payloadAnalysisLevelsRef = useRef(
    new Map<string, { level: VocabLevelId; stale: boolean }>(),
  );
  const vocabLevelRef = useRef<VocabLevelId>(vocabLevel);

  // The highlighter level is saved from 我的. Keep a live copy so returning to a
  // still-mounted video refetches; opening a video again reads it at load time.
  useEffect(() => {
    const syncLevel = () => {
      const next = loadVocabLevel();
      if (next !== vocabLevelRef.current) {
        vocabLevelRef.current = next;
        payloadAnalysisLevelsRef.current.forEach((entry) => { entry.stale = true; });
      }
      setVocabLevel(next);
    };
    window.addEventListener(VOCAB_LEVEL_EVENT, syncLevel);
    window.addEventListener('storage', syncLevel);
    return () => {
      window.removeEventListener(VOCAB_LEVEL_EVENT, syncLevel);
      window.removeEventListener('storage', syncLevel);
    };
  }, []);

  const resetTeachingAnalysis = useCallback(() => {
    setTeachingAnalysis(null);
    setTeachingHighlightsAuthoritative(false);
    setTeachingNotesStatus('idle');
    setPayloadTeachingAnalysis(null);
  }, []);

  const capturePayloadTeachingAnalysis = useCallback((payload: unknown) => {
    const fromPayload = teachingAnalysisFromPayload(payload);
    if (!fromPayload?.contentRef) {
      setPayloadTeachingAnalysis(null);
      return;
    }
    const level = loadVocabLevel();
    let entry = payloadAnalysisLevelsRef.current.get(fromPayload.contentRef);
    if (!entry) {
      entry = { level, stale: false };
      payloadAnalysisLevelsRef.current.set(fromPayload.contentRef, entry);
    } else if (entry.level !== level) {
      // A level change happened before this payload was read back; the payload
      // may still hold the previous level's idioms/culture.
      entry.level = level;
      entry.stale = true;
    }
    setPayloadTeachingAnalysis({ analysis: fromPayload, level: entry.level, stale: entry.stale });
  }, []);

  const cancelTranslationStream = () => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setTranslationProgress(null);
  };


  // Local subtitle playback timer
  const subtitleTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [isSubtitlePlaying, setIsSubtitlePlaying] = useState(false);

  const startSubtitleTimer = useCallback((fromTime: number) => {
    // Stop any existing timer
    if (subtitleTimerRef.current) clearInterval(subtitleTimerRef.current);
    setCurrentTime(fromTime);
    setIsSubtitlePlaying(true);
    const startWall = Date.now();
    const startOffset = fromTime;
    subtitleTimerRef.current = setInterval(() => {
      const elapsed = (Date.now() - startWall) / 1000;
      setCurrentTime(startOffset + elapsed);
    }, 100);
  }, []);

  const pauseSubtitleTimer = useCallback(() => {
    if (subtitleTimerRef.current) clearInterval(subtitleTimerRef.current);
    subtitleTimerRef.current = null;
    setIsSubtitlePlaying(false);
    // Pausing is a natural flush point for the watch-event segment.
    pauseWatch(currentTimeRef.current);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (subtitleTimerRef.current) clearInterval(subtitleTimerRef.current);
    };
  }, []);

  // A real video player (the YouTube branch or a mapped local episode) owns
  // currentTime; leaving the simulated timer running would corrupt it.
  useEffect(() => {
    if (!useSubtitleTimer) pauseSubtitleTimer();
  }, [useSubtitleTimer, pauseSubtitleTimer]);

  // Each newly mapped local episode starts with a clean embed-error state.
  useEffect(() => {
    setLocalVideoError(false);
  }, [localYouTubeId]);

  // Favorites logic — per-item API (M1 ④). The backend serializes file writes;
  // each mutation is optimistic here and rolls back with a toast on failure.
  const [favorites, setFavorites] = useState<FavoriteItem[]>([]);
  const favoritesLoaded = useRef(false);

  // Channel History Logic
  const [selectedChannel, setSelectedChannel] = useState<string | null>(null);

  // Channel Subscriptions logic — load from backend, sync to backend
  const [subscriptions, setSubscriptions] = useState<{ id: string, name: string }[]>([]);
  const subsLoaded = useRef(false);

  // Load favorites & subscriptions from backend on mount, and again after a
  // guest claim (`dataRevision`): login merges the guest directory server-side,
  // so the already-mounted app must refetch instead of keeping guest data.
  useEffect(() => {
    favoritesLoaded.current = false;
    subsLoaded.current = false;
    fetchFavorites()
      .then(data => { setFavorites(data); favoritesLoaded.current = true; })
      .catch(() => {
        // Fallback to localStorage
        const saved = localStorage.getItem('yt_bilingual_favorites');
        if (saved) {
          try { setFavorites(JSON.parse(saved)); } catch { localStorage.removeItem('yt_bilingual_favorites'); }
        }
        favoritesLoaded.current = true;
      });
    apiFetch('/api/subscriptions')
      .then(r => r.json())
      .then(data => { setSubscriptions(data); subsLoaded.current = true; })
      .catch(() => {
        const saved = localStorage.getItem('yt_bilingual_subs');
        if (saved) setSubscriptions(JSON.parse(saved));
        subsLoaded.current = true;
      });
  }, [dataRevision]);

  // Favorites are persisted one item at a time by the handlers below. The old
  // whole-file PUT path still exists server-side for legacy clients (see
  // lib/favorites.replaceAllFavorites), but the app never sends it: two tabs
  // using PUT would overwrite each other again.
  useEffect(() => {
    if (!favoritesLoaded.current) return; // Don't save on initial load
    localStorage.setItem('yt_bilingual_favorites', JSON.stringify(favorites));
  }, [favorites]);

  // Sync subscriptions to backend + localStorage whenever they change
  useEffect(() => {
    if (!subsLoaded.current) return;
    localStorage.setItem('yt_bilingual_subs', JSON.stringify(subscriptions));
    apiFetch('/api/subscriptions', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscriptions })
    }).catch(() => {});
  }, [subscriptions]);

  // Ability profile for Today's placement strip, Practice's placement row and
  // Profile's profile row. No profile is a normal state (`profile: null`).
  useEffect(() => {
    let cancelled = false;
    setPlacementLoading(true);
    setPlacementFailed(false);
    getProfile()
      .then(data => {
        if (!cancelled) setPlacementProfile(data?.profile ?? null);
      })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load placement profile:', err);
        setPlacementFailed(true);
      })
      .finally(() => {
        if (!cancelled) setPlacementLoading(false);
      });
    return () => { cancelled = true; };
  }, [placementNonce, dataRevision]);

  // Seed the highlighter once from the ability profile's upper band (A2–B1 →
  // B1). The slider is a reading preference, not an ability rating, but the
  // first visit should not make the learner guess: only when they have never
  // saved a level. Once saved, this effect never writes again. Top-level (not
  // 我的) so it also applies before the first video/reading is opened; no
  // profile (guest / not tested yet) keeps the existing default.
  useEffect(() => {
    if (placementLoading || placementFailed || !placementProfile) return;
    if (hasSavedVocabLevel()) return;
    const seeded = vocabLevelFromCefr(
      placementProfile.levelBandHigh || placementProfile.cefr,
    );
    if (seeded) saveVocabLevel(seeded);
  }, [placementLoading, placementFailed, placementProfile]);

  // Review stats power the practice badge and the Today review card. Guests are
  // skipped: specs/013 makes every review endpoint 403 without an account.
  // `targetLang` is part of the key because the deck is language-scoped.
  useEffect(() => {
    if (status !== 'authenticated') {
      setReviewStats(null);
      setReviewStatsLoading(false);
      setReviewStatsFailed(false);
      return;
    }
    let cancelled = false;
    setReviewStatsLoading(true);
    setReviewStatsFailed(false);
    getReviewStats()
      .then(next => { if (!cancelled) setReviewStats(next); })
      .catch(err => {
        if (cancelled) return;
        console.error('Failed to load review stats:', err);
        setReviewStatsFailed(true);
      })
      .finally(() => { if (!cancelled) setReviewStatsLoading(false); });
    return () => { cancelled = true; };
  }, [status, targetLang, dataRevision, reviewStatsNonce]);

  // M1 ⑤ interrupted-job recovery, now opt-in (P0 IA R7: a refresh must never
  // fire processing on its own). The record is offered as a banner; the stream
  // only reconnects after the user clicks it.
  const [pendingResume, setPendingResume] = useState<PendingJob | null>(null);
  const resumeOfferCheckedRef = useRef(false);
  useEffect(() => {
    if (!user || resumeOfferCheckedRef.current) return;
    resumeOfferCheckedRef.current = true;
    void (async () => {
      const pending = loadPendingJob();
      if (!pending) return;
      // 语言切换后旧任务的译文本就不是当前设置要的，直接丢弃。
      if (pending.targetLang !== getRuntimeTargetLang()) {
        clearPendingJob();
        return;
      }
      setPendingResume(pending);
    })();
  }, [user]);

  const handleResumePending = async () => {
    const pending = pendingResume;
    if (!pending) return;
    setPendingResume(null);
    let snapshot: JobSnapshot | null;
    try {
      snapshot = await fetchJobSnapshot(pending.jobId);
      // 刚刷新时服务端可能还没察觉到连接已断（active=true）：等它收尾
      // 再问一次，避免「刷新后要多刷一次」的竞态。
      for (let attempt = 0; attempt < 3 && snapshot?.active; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
        snapshot = await fetchJobSnapshot(pending.jobId);
      }
    } catch {
      toast.error(t('jobs.resumeFailed'));
      return;
    }
    if (!snapshot || snapshot.status === 'done') {
      clearPendingJob();
      return;
    }
    if (snapshot.status === 'failed') {
      clearPendingJob();
      toast.error(t('jobs.failedHint'));
      return;
    }
    if (snapshot.active) {
      toast.info(t('jobs.busyHint'));
      return;
    }
    if (!snapshot.canResume) {
      clearPendingJob();
      return;
    }
    await handleUrlSubmit(pending.url, {
      jobId: pending.jobId,
      from: snapshot.cursor,
    });
  };

  const handleToggleSubscription = () => {
    if (status === 'guest') {
      toast.info(t('guest.loginToSave'));
      return;
    }
    if (!metadata?.channel_url || !metadata?.channel) return;
    const isSubbed = subscriptions.some(s => s.id === metadata.channel_url);
    if (isSubbed) {
      setSubscriptions(prev => prev.filter(s => s.id !== metadata.channel_url));
    } else {
      setSubscriptions(prev => [...prev, { id: metadata.channel_url, name: metadata.channel }]);
    }
  };

  // Per-item favorite mutations: optimistic local state, rollback + toast on
  // failure. Both operations are server-idempotent, so a double click or a
  // concurrent tab cannot corrupt the stored list.
  const addFavoriteOptimistically = useCallback(async (draft: FavoriteDraft) => {
    const optimistic: FavoriteItem = {
      id: draft.id,
      videoId: draft.videoId,
      start: draft.start,
      en_text: draft.en_text,
      zh_text: draft.zh_text,
      added_at: draft.added_at,
      highlights: draft.highlights,
      type: draft.type,
      context_en: draft.context_en,
      context_zh: draft.context_zh,
      source_kind: draft.source_kind,
      source_ref: draft.source_ref,
      source_title: draft.source_title,
    };
    setFavorites(prev => (prev.some(f => f.id === optimistic.id) ? prev : [...prev, optimistic]));
    try {
      const saved = await addFavorite(draft);
      setFavorites(prev => {
        const next = prev.map(f => (f.id === optimistic.id ? { ...optimistic, ...saved } : f));
        // 服务端按内容指纹去重时可能返回另一个已有 id；按 id 去重避免重复卡片。
        return next.filter((fav, index) => next.findIndex(other => other.id === fav.id) === index);
      });
    } catch (err) {
      setFavorites(prev => prev.filter(f => f.id !== optimistic.id));
      toast.error(await describeApiError(err));
    }
  }, []);

  const removeFavoriteOptimistically = useCallback(async (id: string) => {
    const removed = favorites.find(f => f.id === id);
    setFavorites(prev => prev.filter(f => f.id !== id));
    try {
      await removeFavorite(id);
    } catch (err) {
      if (removed) {
        setFavorites(prev => (prev.some(f => f.id === id) ? prev : [...prev, removed]));
      }
      toast.error(await describeApiError(err));
    }
  }, [favorites]);

  const toggleFavorite = useCallback((draft: FavoriteDraft) => {
    // Guests may sample the app but not save: prompt to log in instead of
    // writing data that would be easy to lose (M1 ⑧ requirement).
    if (status === 'guest') {
      toast.info(t('guest.loginToSave'));
      return;
    }
    if (favorites.some(f => f.id === draft.id)) {
      void removeFavoriteOptimistically(draft.id);
    } else {
      void addFavoriteOptimistically(draft);
    }
  }, [favorites, addFavoriteOptimistically, removeFavoriteOptimistically, status, t]);

  // Where the currently loaded content lives, attached to every favorite made
  // from it. Local episodes are refs like `show_S01E01`; videos are 11-char
  // ids. Titles may be missing (live streams / old caches) — the favorites
  // row then shows "来源未知" instead of pretending.
  const currentSourceFields = useCallback((): Pick<FavoriteDraft, 'source_kind' | 'source_ref' | 'source_title'> => ({
    source_kind: metadata?.is_local_subtitle ? 'local_show' : 'video',
    source_ref: videoId,
    source_title: typeof metadata?.title === 'string' && metadata.title.trim() ? metadata.title : undefined,
  }), [videoId, metadata?.is_local_subtitle, metadata?.title]);

  const handleToggleFavorite = useCallback((item: TranscriptItem) => {
    toggleFavorite({
      id: `${videoId}-${item.id}`,
      videoId,
      start: item.start,
      en_text: item.en_text,
      zh_text: item.zh_text,
      added_at: Date.now(),
      highlights: item.highlights,
      type: 'sentence',
      ...currentSourceFields(),
    });
  }, [videoId, toggleFavorite, currentSourceFields]);

  const handleToggleVocabFavorite = (e: React.MouseEvent, item: any) => {
    e.stopPropagation();
    toggleFavorite({
      id: `vocab-${videoId}-${item.en.replace(/\s+/g, '-')}`,
      videoId,
      start: item.start,
      en_text: item.en,
      zh_text: item.zh,
      context_en: item.en_text,
      context_zh: item.zh_text,
      added_at: Date.now(),
      highlights: item.highlights,
      type: 'vocabulary',
      ...currentSourceFields(),
    });
  };

  const handleRemoveFavorite = (id: string) => {
    void removeFavoriteOptimistically(id);
  };

  // Add/remove a dictionary lookup to the vocabulary favorites. Reading
  // lookups know their article (id + title); transcript lookups fall back to
  // the currently loaded video/episode.
  const handleToggleDictFavorite = (def: WordDefinition) => {
    if (!wordLookup) return;
    // A lookup can point at a reading-API article or a free-library article;
    // both keep their own id/title, but the "出处" row routes them differently.
    const lookupSourceKind = wordLookup.sourceKind === 'article'
      || wordLookup.sourceKind === 'library_article'
      || wordLookup.sourceKind === 'book'
      || wordLookup.sourceKind === 'imported_book'
      ? wordLookup.sourceKind
      : wordLookup.sourceId
        ? 'article'
        : null;
    const sourceId = wordLookup.sourceId || videoId;
    toggleFavorite({
      id: `vocab-${sourceId}-${def.word.replace(/\s+/g, '-')}`,
      videoId: sourceId,
      start: wordLookup.start,
      en_text: def.word,
      zh_text: [def.ipa, def.zh].filter(Boolean).join(' '),
      context_en: wordLookup.context,
      context_zh: '',
      added_at: Date.now(),
      highlights: [],
      type: 'vocabulary',
      ...(lookupSourceKind
        ? {
          source_kind: lookupSourceKind,
          source_ref: sourceId,
          source_title: wordLookup.sourceTitle,
        }
        : currentSourceFields()),
    });
  };

  // ── Route helpers (navigation-model D-01/D-02) ───────────────────────────
  // Every forward move is a push (tab root→sub, sub→sub, list→detail, source→
  // target); only tab switches and same-screen params replace. The browser
  // history is the back stack, so there is no client-side depth clamp.
  const isLearningView = state.sub?.kind === 'learn';
  const isSubView = state.sub !== null;
  const isTaskView = state.sub !== null && TASK_SUB_KINDS.has(state.sub.kind);
  const routeKey = toHash(state);

  const requireAccount = (): boolean => {
    if (status === 'authenticated') return true;
    onRequestLogin?.();
    return false;
  };

  const openSub = useCallback((sub: SubRoute) => {
    open(sub);
  }, [open]);

  const navigateTab = (tab: TabId) => {
    if (state.tab === tab && !state.sub && !state.anchor) {
      const scroller = document.querySelector('[data-page-scroll]');
      if (scroller instanceof HTMLElement) {
        scroller.scrollTo({ top: 0, behavior: 'smooth' });
      }
      return;
    }
    go(tab);
  };

  // A route change dismisses transient overlays: a dictionary popover or a
  // channel list belongs to the screen that opened it (navigation-model §2.2).
  const previousRouteKeyRef = useRef(routeKey);
  useEffect(() => {
    if (previousRouteKeyRef.current === routeKey) return;
    previousRouteKeyRef.current = routeKey;
    setWordLookup(null);
    setSelectedChannel(null);
  }, [routeKey]);

  const resetLearning = useCallback(() => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    resetTeachingAnalysis();
    setTranslationProgress(null);
    if (subtitleTimerRef.current) clearInterval(subtitleTimerRef.current);
    subtitleTimerRef.current = null;
    setIsSubtitlePlaying(false);
    setVideoId('');
    setTranscript([]);
    setSummary('');
    setMetadata(null);
    setCurrentTime(0);
    setSeekCommand(null);
    setQuizCacheReady(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setQuizStarting(false);
    setLibraryArticle(null);
    setWordLookup(null);
    setSelectedChannel(null);
    setReviewStatsNonce(prev => prev + 1);
  }, [resetTeachingAnalysis]);

  const handlePlayFavorite = (favVideoId: string, start: number) => {
    if (favVideoId.length > 11) {
      // Local Subtitle: Extract showId, season, episode from string like "house-of-cards_S03E03"
      const match = favVideoId.match(/^(.+)_S(\d+)E(\d+)$/);
      if (match) {
        // The target clock (simulated timer vs. mapped YouTube player) is only
        // known once the episode payload is loaded, so hand it to the effect.
        pendingLocalSeekRef.current = start;
        void handleSelectEpisode(match[1], parseInt(match[2]), parseInt(match[3]));
      }
    } else {
      if (favVideoId !== videoId) {
        // Seek as soon as the stream's meta event arrives (don't wait for full translation)
        pendingSeekRef.current = start;
        void handleUrlSubmit(`https://youtube.com/watch?v=${favVideoId}`);
      } else {
        setSeekCommand({ time: start, timestamp: Date.now() });
      }
    }
  };

  // ── Content loading (YouTube / local episode / free library) ──────────────
  const handleUrlSubmit = async (
    url: string,
    resume?: { jobId?: string; from?: number },
  ) => {
    pauseSubtitleTimer();
    resetTeachingAnalysis();
    // A fresh stream only proves a cache once the backend writes the payload
    // (on `meta` for reused caches, on `done` for new ones).
    setQuizCacheReady(false);
    // Model choice is global now: every LLM call reads the same saved setting
    // instead of taking a per-video argument from a dialog.
    const model = loadModel();
    // Basic extraction
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([^&?]+)/);
    const id = match ? match[1] : null;

    if (!id) {
      toast.error(t('errors.invalidYoutubeUrl'));
      return;
    }

    // Replace any in-flight stream
    streamAbortRef.current?.abort();
    const controller = new AbortController();
    streamAbortRef.current = controller;

    setLoadingState('processing');
    // Capture the target for this stream: late events from the previous
    // language must never be painted into the new-language UI (spec §5.3).
    const requestedTargetLang = getRuntimeTargetLang();

    try {
      const response = await apiFetch('/api/process-video-stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          model: model || undefined,
          vocab_level: loadVocabLevel(),
          // 续传：jobId + 最后收到的 block 游标（后端据此只补未翻译的句子）。
          ...(resume?.jobId ? { jobId: resume.jobId, from: resume.from ?? 0 } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok || !response.body) {
        throw new Error(await describeApiError(response));
      }

      await consumeSseStream(response.body, (evt) => {
        if (typeof evt.data?.targetLang === 'string' && evt.data.targetLang !== requestedTargetLang) {
          return;
        }
        switch (evt.event) {
          case 'meta': {
            const blocks = evt.data.blocks || [];
            setTranscript(blocks);
            setMetadata(evt.data.metadata || null);
            setSummary('');
            setVideoId(evt.data.videoId || id);
            setCurrentTime(0);
            setLoadingState(null); // English is visible — drop the overlay
            // Reused caches are already on disk; a `cached:false` stream waits
            // for `done` before the quiz entry becomes available.
            if (evt.data.cached === true) setQuizCacheReady(true);
            // M1 ⑤：记住 jobId 与游标，刷新/断线后从这里续传（服务端提供
            // jobId 时才有；纯缓存秒开没有生成任务，不会留下记录）。
            recordJobMeta(evt.data, {
              url,
              videoId: evt.data.videoId || id,
              targetLang: requestedTargetLang,
            });
            const metaCursor = typeof evt.data.cursor === 'number' ? evt.data.cursor : 0;
            const metaTotal = typeof evt.data.total === 'number' ? evt.data.total : blocks.length;
            const untranslated = blocks.filter((b: TranscriptItem) => isUntranslated(b.zh_text)).length;
            setTranslationProgress(
              untranslated > 0
                // 续传时从「已翻 N 句」接着显示，进度条不会从中途归零。
                ? (metaCursor > 0 ? { done: metaCursor, total: metaTotal } : { done: 0, total: untranslated })
                : null,
            );
            if (evt.data.resumed === true) {
              toast.info(t('jobs.resumedHint', { done: metaCursor, total: metaTotal }));
            }
            if (pendingSeekRef.current != null) {
              const resumeAt = pendingSeekRef.current;
              pendingSeekRef.current = null;
              setTimeout(() => setSeekCommand({ time: resumeAt, timestamp: Date.now() }), 1000);
            }
            // The URL now points at the learning view (push once).
            open({
              kind: 'learn',
              source: 'youtube',
              videoId: evt.data.videoId || id,
            });
            break;
          }
          case 'batch': {
            const byId = new Map<number, TranscriptItem>((evt.data.blocks || []).map((b: TranscriptItem) => [b.id, b]));
            setTranscript(prev => prev.map(b => byId.get(b.id) ?? b));
            if (evt.data.progress) setTranslationProgress(prev => ({ ...prev, ...evt.data.progress }));
            // 批次游标落 sessionStorage：刷新后从这里继续，不重复付费。
            recordJobProgress(evt.data);
            break;
          }
          case 'stage':
            if (evt.data.stage === 'asr') {
              // Pre-meta: still in the loading overlay, switch its copy
              setLoadingState('asr');
            } else {
              setTranslationProgress(prev => prev ? { ...prev, stage: evt.data.stage } : { done: 0, total: 0, stage: evt.data.stage });
            }
            break;
          case 'summary':
            setSummary(evt.data.summary || '');
            break;
          case 'error':
            throw new Error(evt.data.detail || t('errors.processFailed'));
          case 'done':
            setTranslationProgress(null);
            finishJob({ jobId: evt.data.jobId, videoId: evt.data.videoId || id });
            // Fresh generation persisted its cache by now.
            setQuizCacheReady(true);
            break;
        }
      });
      setTranslationProgress(null);
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        setTranslationProgress(null);
        return;
      }
      console.error(error);
      toast.error(await describeApiError(error));
      // 进度已经落盘：告诉用户刷新能接着看，而不是从头再花一次钱。
      if (loadPendingJob()?.videoId === id) {
        toast.info(t('jobs.interruptedHint'));
      }
      setTranslationProgress(null);
    } finally {
      setLoadingState(null);
    }
  };

  const handleSelectEpisode = async (showId: string, season: number, episode: number) => {
    pauseSubtitleTimer();
    resetTeachingAnalysis();
    setQuizCacheReady(false);
    setLoadingState('loading');
    // The target can change while this request is in flight. The response is
    // still in the old language, so apply it only if the setting is unchanged.
    const requestedTargetLang = getRuntimeTargetLang();
    try {
      // Try loading from history cache first (already processed episodes).
      // Like any other history load, pass the global model so a cache with
      // untranslated blocks repairs itself with the model the user picked.
      const cacheFilename = `${showId}_S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}.json`;
      const savedModel = loadModel();
      const modelQuery = savedModel ? `?model=${encodeURIComponent(savedModel)}` : '';
      const cacheResponse = await apiFetch(`/api/history/${cacheFilename}${modelQuery}`);
      if (getRuntimeTargetLang() !== requestedTargetLang) return;

      if (cacheResponse.ok) {
        // Already processed — load directly from cache
        const data = await cacheResponse.json();
        if (getRuntimeTargetLang() !== requestedTargetLang) return;
        setTranscript(data.transcript);
        setSummary(data.summary || '');
        setMetadata({ ...data.metadata, is_local_subtitle: true });
        setVideoId(data.videoId);
        capturePayloadTeachingAnalysis(data);
        setCurrentTime(0);
        setQuizCacheReady(true);
      } else {
        setLoadingState('processing');
        // Not yet processed — run the full processing pipeline
        const response = await apiFetch('/api/process-subtitle', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ show_id: showId, season, episode, model: loadModel() || undefined }),
        });

        if (!response.ok) throw new Error(await describeApiError(response));

        const data = await response.json();
        if (getRuntimeTargetLang() !== requestedTargetLang) return;
        setTranscript(data.transcript);
        setSummary(data.summary || '');
        setMetadata({ ...data.metadata, is_local_subtitle: true });
        setVideoId(data.videoId);
        capturePayloadTeachingAnalysis(data);
        setCurrentTime(0);
        setQuizCacheReady(true);
      }
      open({ kind: 'learn', source: 'local', showId, season, episode });
    } catch (error) {
      console.error(error);
      pendingLocalSeekRef.current = null;
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  const handleLoadHistory = async (filename: string) => {
    pauseSubtitleTimer();
    resetTeachingAnalysis();
    setQuizCacheReady(false);
    setLoadingState('loading');
    const requestedTargetLang = getRuntimeTargetLang();
    try {
      // Pass the last picked model so repairing a partially translated cache
      // retries with the provider the user actually chose.
      const savedModel = loadModel();
      const query = savedModel ? `?model=${encodeURIComponent(savedModel)}` : '';
      const response = await apiFetch(`/api/history/${filename}${query}`);
      if (!response.ok) throw new Error(await describeApiError(response));

      const data = await response.json();
      if (getRuntimeTargetLang() !== requestedTargetLang) return;
      setTranscript(data.transcript);
      setSummary(data.summary || '');
      setMetadata(data.metadata || null);
      setVideoId(data.videoId);
      capturePayloadTeachingAnalysis(data);
      setCurrentTime(0);
      // Loaded straight out of history: the bilingual cache already exists.
      setQuizCacheReady(true);
      // Local-episode caches share the `SxxEyy` shape; everything else is a
      // YouTube video id.
      const localMatch = String(filename).match(/^(.+?)[-_]S(\d+)E(\d+)\.json$/i);
      if (data.metadata?.is_local_subtitle && localMatch) {
        open({
          kind: 'learn',
          source: 'local',
          showId: localMatch[1],
          season: Number.parseInt(localMatch[2], 10),
          episode: Number.parseInt(localMatch[3], 10),
        });
      } else {
        open({ kind: 'learn', source: 'youtube', videoId: data.videoId });
      }
    } catch (error) {
      console.error(error);
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  // ── Free library (user request #11) ──────────────────────────────────────
  // Both entries leave the normal learning pipeline untouched: the video path
  // only reads pre-built blocks and enters the existing player, the article
  // path only renders a local payload. Neither calls estimate/process/define.
  const applyLibraryVideo = (data: Awaited<ReturnType<typeof fetchLibraryVideo>>) => {
    resetTeachingAnalysis();
    setTranscript(data.blocks);
    setSummary('');
    setMetadata({
      title: data.title,
      channel: data.channel,
      duration: data.duration,
      level: data.level,
      free: true,
      source: 'youtube',
      is_library: true,
      youtubeId: data.youtubeId,
      thumbnail: data.thumbnail,
    });
    setVideoId(data.youtubeId);
    setCurrentTime(0);
    setSeekCommand(null);
    setLocalVideoError(false);
  };

  const handleOpenLibraryVideo = async (id: string) => {
    setWordLookup(null);
    setSelectedChannel(null);
    setLibraryArticle(null);
    setQuizCacheReady(false);
    setLoadingState('loading');
    try {
      const data = await fetchLibraryVideo(id);
      applyLibraryVideo(data);
      open({ kind: 'learn', source: 'library', itemId: id });
    } catch (error) {
      console.error('Failed to load free library video:', error);
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  const handleOpenLibraryArticle = async (id: string) => {
    setWordLookup(null);
    setSelectedChannel(null);
    resetTeachingAnalysis();
    setLoadingState('loading');
    try {
      const data = await fetchLibraryArticle(id);
      setLibraryArticle(data);
      open({ kind: 'learn', source: 'library', itemId: id });
    } catch (error) {
      console.error('Failed to load free library article:', error);
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  const handleCloseLibraryArticle = () => {
    back();
  };

  // Refresh/direct-link restore of a learn route. Only cache reads — never
  // process/estimate (P0 IA R7). A miss returns to the content page with a
  // toast instead of silently re-billing.
  const restoreLearnRoute = async (sub: Extract<SubRoute, { kind: 'learn' }>) => {
    resetTeachingAnalysis();
    if (sub.source === 'library' && sub.itemId) {
      try {
        const data = await fetchLibraryVideo(sub.itemId);
        applyLibraryVideo(data);
        return;
      } catch {
        // Not a library video — try the original article payload.
      }
      try {
        const article = await fetchLibraryArticle(sub.itemId);
        setLibraryArticle(article);
        return;
      } catch (error) {
        console.error('Failed to restore library item:', error);
        toast.info(t('nav.cacheMiss'));
        replace({ tab: 'content', sub: null });
        return;
      }
    }

    if (sub.source === 'local' && sub.showId) {
      const filename = `${sub.showId}_S${String(sub.season ?? 1).padStart(2, '0')}E${String(sub.episode ?? 1).padStart(2, '0')}.json`;
      try {
        const response = await apiFetch(`/api/history/${filename}`);
        if (!response.ok) throw new Error('cache miss');
        const data = await response.json();
        setTranscript(data.transcript);
        setSummary(data.summary || '');
        setMetadata({ ...data.metadata, is_local_subtitle: true });
        setVideoId(data.videoId);
        capturePayloadTeachingAnalysis(data);
        setCurrentTime(0);
        setQuizCacheReady(true);
      } catch {
        toast.info(t('nav.cacheMiss'));
        replace({ tab: 'content', sub: null });
      }
      return;
    }

    // YouTube: only restore when /api/history already has this video's cache.
    try {
      const response = await apiFetch('/api/history');
      const items = response.ok ? await response.json() : [];
      const item = Array.isArray(items)
        ? items.find(candidate => candidate?.videoId === sub.videoId)
        : undefined;
      if (item?.filename) {
        await handleLoadHistory(item.filename);
        return;
      }
    } catch {
      // fall through
    }
    toast.info(t('nav.cacheMiss'));
    replace({ tab: 'content', sub: null });
  };

  // Route restore runs once per distinct learn href (on mount / refresh only;
  // in-app entries already have their payload before the hash changes).
  const restoredLearnRef = useRef('');
  useEffect(() => {
    if (!isLearningView) {
      restoredLearnRef.current = '';
      return;
    }
    const sub = state.sub as Extract<SubRoute, { kind: 'learn' }>;
    const key = toHash({ tab: state.tab, sub });
    if (restoredLearnRef.current === key) return;
    const loadedMatches =
      transcript.length > 0 && Boolean(videoId) && (
        (sub.source === 'youtube' && sub.videoId === videoId) ||
        (sub.source === 'local' && isLocalSubtitle) ||
        (sub.source === 'library' && (isLibraryVideo || libraryArticle !== null))
      );
    restoredLearnRef.current = key;
    if (loadedMatches) return;
    void restoreLearnRoute(sub);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.sub, state.tab, transcript.length, videoId, isLocalSubtitle, isLibraryVideo, libraryArticle]);

  // Leaving the learning view ends the segment and clears the payload (no
  // background translation per B-3; the cache stays on disk).
  const wasLearningRef = useRef(false);
  useEffect(() => {
    if (wasLearningRef.current && !isLearningView) {
      resetLearning();
    }
    wasLearningRef.current = isLearningView;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLearningView]);

  // A quiz is an overlay of the learning view only. Leaving the view (desktop
  // top-bar tab, browser back) discards it instead of painting it over a tab
  // page (the URL never carried it, per IA §7.1).
  useEffect(() => {
    if (quizOpen && !isLearningView) {
      setQuizOpen(false);
      setQuizLesson(null);
    }
  }, [quizOpen, isLearningView]);

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
    // A seek issued moments ago may be followed by a stale tick from the old
    // position (the YouTube embed is not instant); don't misread that as a
    // user replay. Once the player reports near the target, tracking resumes.
    const pendingSeek = lastSeekTargetRef.current;
    const seekRecent = Boolean(
      pendingSeek && Date.now() - pendingSeek.at < SEEK_SETTLE_MS
    );
    const staleAfterSeek = Boolean(
      seekRecent
      && pendingSeek
      && Math.abs(time - pendingSeek.time) > 1.5
    );
    if (!staleAfterSeek) {
      // Native YouTube scrubbing is not routed through `seekTo`, so a
      // backwards position jump seen only in the poll is the "drag back"
      // replay signal. Our own seeks were already reported by `seekTo` and
      // are ignored during the settle window.
      if (!seekRecent && time < playbackPositionRef.current - 1.5) {
        noteVideoReplay({
          contentRef: videoId,
          fromSeconds: playbackPositionRef.current,
          toSeconds: time,
          method: 'seek',
        });
      }
      playbackPositionRef.current = time;
    }
    // The YouTube player and the simulated local clock both land here (via
    // their own source); watch events count only movement of this position.
    notePlayback(time);
  }, [videoId]);

  // ── Watch reporting (M5) ─────────────────────────────────────────────────
  // One segment per open content. Switching video/episode, leaving the learning
  // view, or opening the quiz ends the segment: the tracker emits what was
  // played and flushes the queue.
  const hasTranscript = transcript.length > 0;
  useEffect(() => {
    if (!isLearningView || !videoId || !hasTranscript || quizOpen) return;
    startWatch({
      contentRef: videoId,
      kind: metadata?.is_local_subtitle ? 'local_show' : 'video',
    });
    return () => endWatch();
  }, [isLearningView, videoId, hasTranscript, metadata?.is_local_subtitle, quizOpen]);

  // SRT-only local episodes have no player callback; the simulated clock's
  // `currentTime` is the playback position. Only feed it while playing so a
  // paused episode keeps its last emitted segment clean.
  useEffect(() => {
    if (!useSubtitleTimer || !isSubtitlePlaying) return;
    // The simulated clock owns the position for SRT-only episodes, so it is
    // also the authoritative replay baseline there.
    playbackPositionRef.current = currentTime;
    notePlayback(currentTime);
  }, [currentTime, useSubtitleTimer, isSubtitlePlaying]);

  // --- Playback progress: save (throttled) and resume ---
  const lastSavedTimeRef = useRef(0);
  const resumedVideoRef = useRef<string | null>(null);

  useEffect(() => {
    if (!videoId || transcript.length === 0 || currentTime < 5) return;
    if (Math.abs(currentTime - lastSavedTimeRef.current) < 5) return;
    lastSavedTimeRef.current = currentTime;
    saveProgress(videoId, currentTime, transcript[transcript.length - 1]?.end ?? 0);
  }, [currentTime, videoId, transcript]);

  useEffect(() => {
    if (!videoId || transcript.length === 0) return;

    // Weekly-report evidence wins over every resume path: it was clicked with
    // an explicit second, so never replace it with local progress.
    const evidenceSeek = pendingEvidenceSeekRef.current;
    if (
      evidenceSeek
      && contentRefMatches(evidenceSeek, videoId, Boolean(metadata?.is_local_subtitle))
    ) {
      pendingEvidenceSeekRef.current = null;
      resumedVideoRef.current = videoId;
      lastSavedTimeRef.current = 0;
      if (useSubtitleTimer) {
        setCurrentTime(evidenceSeek.time);
      } else {
        setSeekCommand({ time: evidenceSeek.time, timestamp: Date.now() });
      }
      return;
    }

    // A local-episode favorite jump takes precedence over resume, and works
    // whether the episode uses a mapped player or the simulated clock.
    if (pendingLocalSeekRef.current != null) {
      const resumeAt = pendingLocalSeekRef.current;
      pendingLocalSeekRef.current = null;
      resumedVideoRef.current = videoId;
      lastSavedTimeRef.current = 0;
      if (useSubtitleTimer) {
        startSubtitleTimer(resumeAt);
      } else {
        setSeekCommand({ time: resumeAt, timestamp: Date.now() });
      }
      return;
    }

    if (resumedVideoRef.current === videoId) return;
    resumedVideoRef.current = videoId;
    lastSavedTimeRef.current = 0;
    if (pendingSeekRef.current != null) return; // a favorites jump takes precedence

    const saved = getProgress(videoId);
    const duration = transcript[transcript.length - 1]?.end ?? 0;
    if (saved && saved.time > 15 && saved.time < duration - 30) {
      const resumeAt = saved.time;
      const mm = Math.floor(resumeAt / 60).toString().padStart(2, '0');
      const ss = Math.floor(resumeAt % 60).toString().padStart(2, '0');
      if (useSubtitleTimer) {
        setCurrentTime(resumeAt);
      } else {
        setTimeout(() => setSeekCommand({ time: resumeAt, timestamp: Date.now() }), 1200);
      }
      toast.info(t('transcript.resumeToast', { time: `${mm}:${ss}` }));
    }
  }, [videoId, transcript, metadata?.is_local_subtitle, useSubtitleTimer, startSubtitleTimer, t]);

  // Unified seek: the simulated clock for SRT-only local episodes, a player
  // command for YouTube and for local episodes mapped to a real video.
  // CEFR M2 #7: backwards seeks are the `video_replay` signal; forward jumps
  // (normal sentence navigation) are not replay. The method records how the
  // seek happened (click / keyboard / loop / other seek).
  const seekTo = useCallback((time: number, method: ReplayMethod = 'seek') => {
    const target = Number.isFinite(time) ? Math.max(0, time) : 0;
    const from = playbackPositionRef.current;
    if (Number.isFinite(time) && from - target > 1.5) {
      noteVideoReplay({
        contentRef: videoId,
        fromSeconds: from,
        toSeconds: target,
        method,
      });
    }
    playbackPositionRef.current = target;
    lastSeekTargetRef.current = { time: target, at: Date.now() };
    if (useSubtitleTimer) {
      startSubtitleTimer(target);
    } else {
      setSeekCommand({ time: target, timestamp: Date.now() });
    }
  }, [useSubtitleTimer, startSubtitleTimer, videoId]);

  // ── Teaching analysis: load once per content + level + target language ───
  // Free-library videos/articles are pre-built payloads with no analysis row;
  // every other learning view (YouTube video, local episode) is eligible.
  const teachingAnalysisContentRef =
    videoId && !isLibraryVideo && !libraryArticle ? videoId : '';

  useEffect(() => {
    if (!teachingAnalysisContentRef || transcript.length === 0) {
      setTeachingAnalysis(null);
      setTeachingHighlightsAuthoritative(false);
      setTeachingNotesStatus('idle');
      return;
    }
    if (status === 'guest' || status === 'anonymous') {
      setTeachingAnalysis(null);
      setTeachingHighlightsAuthoritative(false);
      setTeachingNotesStatus('login');
      return;
    }
    if (status !== 'authenticated') {
      setTeachingNotesStatus('loading');
      return;
    }

    // A history payload that already carries the merged analysis wins: no
    // endpoint call, and the transcript's own highlights are already correct.
    const payloadMatches = payloadTeachingAnalysis !== null
      && !payloadTeachingAnalysis.stale
      && payloadTeachingAnalysis.level === vocabLevel
      && (
        payloadTeachingAnalysis.analysis.contentRef === teachingAnalysisContentRef
        || !payloadTeachingAnalysis.analysis.contentRef
      );
    if (payloadMatches) {
      setTeachingAnalysis(payloadTeachingAnalysis.analysis);
      setTeachingHighlightsAuthoritative(false);
      setTeachingNotesStatus('ready');
      return;
    }

    // While a fresh stream is still translating, the backend has not produced
    // analysis yet; asking now would race the same generation (and count it
    // twice). Wait for the progress bar/summary stage to finish.
    if (loadingState !== null || translationProgress !== null) {
      setTeachingNotesStatus('loading');
      return;
    }
    // A fresh stream only marks the cache ready on `done`, after the backend
    // has persisted both translations and analysis. Asking earlier (e.g. after
    // an aborted translation) could cache an analysis with empty zh_words.
    if (!quizCacheReady) {
      setTeachingNotesStatus('loading');
      return;
    }

    const controller = new AbortController();
    let cancelled = false;
    let issue: TeachingAnalysisIssue | undefined;
    setTeachingAnalysis(null);
    setTeachingHighlightsAuthoritative(false);
    setTeachingNotesStatus('loading');
    fetchTeachingAnalysis(teachingAnalysisContentRef, vocabLevel, {
      targetLang,
      signal: controller.signal,
      onIssue: (nextIssue) => { issue = nextIssue; },
    }).then((nextAnalysis) => {
      if (cancelled) return;
      if (nextAnalysis) {
        setTeachingAnalysis(nextAnalysis);
        setTeachingHighlightsAuthoritative(true);
        setTeachingNotesStatus('ready');
        return;
      }
      if (issue === 'forbidden') setTeachingNotesStatus('login');
      else if (issue === 'not-found') setTeachingNotesStatus('empty');
      else setTeachingNotesStatus('error');
    }).catch(() => {
      if (!cancelled) setTeachingNotesStatus('error');
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [
    teachingAnalysisContentRef,
    transcript.length,
    status,
    payloadTeachingAnalysis,
    vocabLevel,
    targetLang,
    loadingState,
    translationProgress,
    quizCacheReady,
    teachingNotesRetry,
  ]);

  // Endpoint highlights override the translation payload's old highlights;
  // without analysis (guest / not found / failure) the original blocks remain
  // the fallback, so subtitles keep their legacy highlights.
  const displayTranscript = useMemo(
    () => (teachingAnalysis && teachingHighlightsAuthoritative
      ? applyTeachingAnalysisHighlights(transcript, teachingAnalysis.highlights)
      : transcript),
    [transcript, teachingAnalysis, teachingHighlightsAuthoritative],
  );

  const videoHighlight = useReadingHighlights(displayTranscript.map((item) => item.en_text));

  const wordGlossesByBlock = useMemo(() => {
    const map: Record<string, Record<string, string>> = {};
    for (const [blockId, entries] of Object.entries(teachingAnalysis?.highlights ?? {})) {
      const glosses: Record<string, string> = {};
      for (const entry of entries) {
        const word = entry.en_word?.trim().toLowerCase();
        const gloss = entry.zh_word?.trim();
        if (word && gloss) glosses[word] = gloss;
      }
      if (Object.keys(glosses).length > 0) map[blockId] = glosses;
    }
    return map;
  }, [teachingAnalysis]);

  const languagePointsByBlock = useMemo(() => {
    const map: Record<string, InlineLanguagePoint[]> = {};
    const push = (blockId: number | string, point: InlineLanguagePoint) => {
      if (!point.text.trim()) return;
      const key = String(blockId);
      (map[key] ??= []).push(point);
    };
    for (const idiom of teachingAnalysis?.idioms ?? []) {
      push(idiom.blockId, { text: idiom.phrase, meaning: idiom.meaning, kind: 'idiom' });
    }
    for (const culture of teachingAnalysis?.culture ?? []) {
      push(culture.blockId, { text: culture.term, meaning: culture.note, kind: 'culture' });
    }
    return map;
  }, [teachingAnalysis]);

  // Active sentence index — TranscriptView depends on this, not on raw
  // 100ms time ticks, so the 400+ sentence list re-renders only when the
  // spoken sentence actually changes.
  const activeTranscriptIndex = useMemo(
    () => findActiveIndex(transcript, currentTime),
    [transcript, currentTime]
  );

  const favoriteIds = useMemo(() => favorites.map(f => f.id), [favorites]);
  // The 单词本 badge counts saved words only. Sentence favorites stay in the
  // store for the by-item API, but the word book neither lists nor exports them.
  const vocabularyFavoriteCount = useMemo(
    () => favorites.filter(f => f.type === 'vocabulary').length,
    [favorites],
  );

  const handleTranscriptClick = useCallback((time: number) => {
    // Re-pin the loop to the clicked sentence
    if (loopEnabled) {
      const block = transcript.find(b => b.start === time);
      if (block) loopBlockRef.current = { start: block.start, end: block.end };
    }
    seekTo(time, 'click');
  }, [loopEnabled, transcript, seekTo]);

  // 「语言点」items carry a block id, not a time: resolve it against the
  // transcript so the note and its quote land on the exact subtitle block.
  const handleTeachingNoteSeek = useCallback((blockId: number | string) => {
    const block = transcript.find((item) => String(item.id) === String(blockId));
    if (block) seekTo(block.start, 'click');
  }, [transcript, seekTo]);

  const handleTeachingNotesRetry = useCallback(() => {
    setTeachingNotesRetry((previous) => previous + 1);
  }, []);

  const toggleLoop = useCallback(() => {
    setLoopEnabled(prev => {
      if (prev) {
        loopBlockRef.current = null;
        return false;
      }
      const idx = findActiveIndex(transcript, currentTime);
      if (idx < 0) return false;
      loopBlockRef.current = { start: transcript[idx].start, end: transcript[idx].end };
      return true;
    });
  }, [transcript, currentTime]);

  // --- Resizable split: pointer drag + keyboard nudging on the divider ---
  const handleResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const row = fullscreenWrapperRef.current;
    if (!row) return;
    const rect = row.getBoundingClientRect();
    if (rect.width <= 0) return;
    setLeftRatio(clampSplitRatio(((e.clientX - rect.left) / rect.width) * 100));
  }, []);

  const handleDividerKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === 'ArrowLeft') next = leftRatio - 2;
    else if (e.key === 'ArrowRight') next = leftRatio + 2;
    else if (e.key === 'Home') next = MIN_SPLIT_RATIO;
    else if (e.key === 'End') next = MAX_SPLIT_RATIO;
    else return;
    e.preventDefault();
    setLeftRatio(clampSplitRatio(next));
  };

  // Single-sentence loop: jump back when playback passes the pinned block
  useEffect(() => {
    if (!loopEnabled || !loopBlockRef.current) return;
    if (currentTime > loopBlockRef.current.end + 0.05) {
      seekTo(loopBlockRef.current.start, 'loop');
    }
  }, [currentTime, loopEnabled, seekTo]);

  // Keyboard shortcuts: Space play/pause, ←→ prev/next sentence, R replay, L loop
  useEffect(() => {
    // The quiz view owns the keyboard while it is open (1–4 / Enter / Esc).
    if (!isLearningView || !videoId || transcript.length === 0 || quizOpen) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (useSubtitleTimer) {
            if (isSubtitlePlaying) pauseSubtitleTimer();
            else startSubtitleTimer(currentTime);
          } else {
            setPlayToggleCommand(Date.now());
          }
          break;
        case 'ArrowLeft': {
          e.preventDefault();
          const idx = findActiveIndex(transcript, currentTime);
          const prev = transcript[Math.max(0, idx - 1)];
          if (prev) seekTo(prev.start, 'keyboard');
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const idx = findActiveIndex(transcript, currentTime);
          const next = transcript[Math.min(transcript.length - 1, idx + 1)];
          if (next) seekTo(next.start, 'keyboard');
          break;
        }
        case 'r': case 'R': {
          const idx = findActiveIndex(transcript, currentTime);
          if (idx >= 0) seekTo(transcript[idx].start, 'keyboard');
          break;
        }
        case 'l': case 'L':
          toggleLoop();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isLearningView, videoId, transcript, currentTime, useSubtitleTimer, isSubtitlePlaying, seekTo, toggleLoop, pauseSubtitleTimer, startSubtitleTimer, quizOpen]);

  // ── Sub-view openers (all entries go through the route model) ────────────
  const handleOpenReview = () => {
    if (!requireAccount()) return;
    openSub({ kind: 'review' });
  };

  // 12-minute course (specs/029): the one private-beta lesson.
  const handleOpenCourse = () => {
    openSub({ kind: 'course', lessonId: COURSE_MVP_LESSON_ID });
  };

  // Generate a 12-minute course from the current video's processed bilingual
  // subtitles (specs/030). Readiness/caching/quota live in the backend; this
  // handler only separates "source not ready" (finish subtitles/translation)
  // from retryable failures.
  const handleGenerateCourse = async () => {
    if (courseGeneratingRef.current) return;
    if (status !== 'authenticated') {
      toast.info(t('course.generate.login'));
      onRequestLogin?.();
      return;
    }
    if (!videoId) return;
    if (isLocalSubtitle) {
      // The endpoint takes a YouTube video id; local episodes have no source
      // contract yet, so never send an SxxEyy show id as a videoId.
      toast.info(t('course.generate.notReady'));
      return;
    }
    courseGeneratingRef.current = true;
    setCourseGenerating(true);
    try {
      const result = await generateCourse({
        sourceKind: 'youtube',
        videoId,
        level: vocabLevel,
      });
      openSub({ kind: 'course', lessonId: result.lessonId });
    } catch (error) {
      if (isCourseAbortError(error)) return;
      if (error instanceof CourseApiError) {
        switch (error.code) {
          case 'unauthorized':
          case 'forbidden':
            toast.info(t('course.generate.login'));
            onRequestLogin?.();
            return;
          case 'source_not_ready':
            toast.info(t('course.generate.notReady'));
            return;
          case 'rate_limited':
            toast.info(t('course.generate.rateLimited'));
            return;
          case 'generation_failed':
          case 'server':
          case 'network':
          case 'invalid_response':
            toast.error(t('course.generate.failed'));
            return;
          default:
            toast.error(t('course.generate.generic'));
            return;
        }
      }
      toast.error(t('course.generate.failed'));
    } finally {
      courseGeneratingRef.current = false;
      setCourseGenerating(false);
    }
  };

  const handleCloseReview = () => {
    back();
    setReviewStatsNonce(prev => prev + 1);
  };

  const handleStartQuiz = async () => {
    if (quizStartBusyRef.current) return;
    if (!quizCacheReady) {
      toast.info(t('quiz.entry.disabledHint'));
      return;
    }
    if (status !== 'authenticated') {
      toast.info(t('quiz.errors.login'));
      onRequestLogin?.();
      return;
    }
    if (!videoId) return;
    quizStartBusyRef.current = true;
    setQuizStarting(true);
    // A dictionary popover belongs to the video view; entering the quiz must
    // not leave it floating over the question card.
    setWordLookup(null);
    try {
      const lesson = await startLesson({
        // Local episode cache filenames and videoIds share the SxxEyy shape;
        // the backend normalizes it back to `<show_id>-S01E01`.
        kind: isLocalSubtitle ? 'local_show' : 'video',
        contentRef: videoId,
      });
      if (!lesson.questions || lesson.questions.length === 0) {
        toast.info(t('quiz.errors.noQuestions'));
        return;
      }
      quizReturnTimeRef.current = currentTimeRef.current;
      pauseSubtitleTimer();
      setQuizLesson(lesson);
      setQuizOpen(true);
    } catch (err) {
      if (err instanceof QuizApiError) {
        if (err.status === 404) {
          toast.info(t('quiz.errors.noCache'));
        } else if (err.status === 422) {
          toast.info(t('quiz.errors.tooShort'));
        } else if (err.status === 403) {
          toast.info(t('quiz.errors.login'));
          onRequestLogin?.();
        } else if (err.status === 429) {
          toast.info(t('quiz.errors.rateLimited'));
        } else {
          toast.error(await describeApiError(err));
        }
      } else {
        toast.error(await describeApiError(err));
      }
    } finally {
      quizStartBusyRef.current = false;
      setQuizStarting(false);
    }
  };

  // Close the quiz back to the video. Re-issue a seek so the remounted player
  // resumes where it was when the quiz opened (the iframe is unmounted while
  // the quiz view is showing, so it would otherwise restart at 0).
  const handleQuizExit = () => {
    const resumeAt = quizReturnTimeRef.current;
    setQuizOpen(false);
    setQuizLesson(null);
    if (Number.isFinite(resumeAt) && resumeAt > 0) seekTo(resumeAt);
  };

  // "回看证据": close the quiz, then seek the player to the evidence second.
  const handleQuizEvidence = (start: number) => {
    setQuizOpen(false);
    setQuizLesson(null);
    if (Number.isFinite(start)) seekTo(Math.max(0, start));
  };

  // Quiz "home" leaves the learning view entirely (the IA's learning page has
  // no route-less exit; this is the one deliberate escape hatch).
  const handleQuizHome = () => {
    resetLearning();
    go('today');
  };

  const handleOpenPlacement = (view: 'intro' | 'profile') => {
    // `view` is a same-screen parameter: intro ↔ profile replaces, it does not
    // stack a second placement frame. Fresh entries push (D-02).
    if (state.sub?.kind === 'placement') {
      replace({ tab: state.tab, sub: { kind: 'placement', view } });
      return;
    }
    openSub({ kind: 'placement', view });
  };

  // The ability profile is the entry point for "what do we know about you";
  // the placement test/profile page stays as the retest detail page.
  const handleOpenAbility = () => {
    openSub({ kind: 'ability' });
  };

  const handleCloseAbility = () => {
    back();
  };

  const handleClosePlacement = () => {
    back();
    setPlacementNonce(prev => prev + 1);
    setReviewStatsNonce(prev => prev + 1);
  };

  const handleOpenExam = () => {
    if (!requireAccount()) return;
    openSub({ kind: 'exam' });
  };

  const handleCloseExam = () => {
    back();
    setReviewStatsNonce(prev => prev + 1);
  };

  const handleOpenReport = () => {
    if (!requireAccount()) return;
    openSub({ kind: 'report' });
  };

  const handleCloseReport = () => {
    back();
  };

  // Evidence "回看": open the referenced content and seek to the evidence
  // second. Existing opening paths are reused (favorites jump / history load /
  // local episode loader); the video id is first resolved through the history
  // index so no re-processing (and no model spend) is triggered when possible.
  const handleOpenEvidence = async (evidence: WeekReportEvidence) => {
    const start = Number.isFinite(evidence.start) ? Math.max(0, evidence.start) : 0;
    setQuizOpen(false);
    setQuizLesson(null);

    // Already-open content: seek in place (the player remounts after the
    // report branch unmounts, so `seekCommand` is consumed on ready).
    if (videoId && transcript.length > 0 && contentRefMatches(evidence, videoId, isLocalSubtitle)) {
      if (useSubtitleTimer) setCurrentTime(start);
      else setSeekCommand({ time: start, timestamp: Date.now() });
      return;
    }

    if (evidence.kind === 'local_show') {
      const match = evidence.contentRef.match(/^(.+?)[-_/]S(\d+)E(\d+)$/i);
      if (match) {
        pendingEvidenceSeekRef.current = {
          contentRef: evidence.contentRef,
          time: start,
          kind: evidence.kind,
        };
        await handleSelectEpisode(
          match[1],
          Number.parseInt(match[2], 10),
          Number.parseInt(match[3], 10),
        );
        return;
      }
    }

    // YouTube: find the cached history filename for this video id. If there is
    // no cache, fall back to the normal URL pipeline (which may re-process).
    try {
      const response = await apiFetch('/api/history');
      if (response.ok) {
        const items = await response.json() as Array<{ filename?: string; videoId?: string }>;
        const item = Array.isArray(items)
          ? items.find(candidate => candidate?.videoId === evidence.contentRef)
          : undefined;
        if (item?.filename) {
          pendingEvidenceSeekRef.current = {
            contentRef: evidence.contentRef,
            time: start,
            kind: evidence.kind,
          };
          await handleLoadHistory(item.filename);
          return;
        }
      }
    } catch {
      // Fall through to the URL pipeline below.
    }
    pendingSeekRef.current = start;
    await handleUrlSubmit(`https://www.youtube.com/watch?v=${encodeURIComponent(evidence.contentRef)}`);
  };

  const handleOpenDiscover = () => {
    if (!requireAccount()) return;
    // A normal entry must not replay a topic handed over earlier.
    setDiscoverInitialQuery(null);
    openSub({ kind: 'discover' });
  };

  // Start-learning "search" mode: same account gate as the discover entry,
  // then let the view prefill + auto-run the query.
  const handleStartSearch = (query: string) => {
    const trimmed = query.trim();
    if (!trimmed) return;
    if (!requireAccount()) return;
    setDiscoverInitialQuery(trimmed);
    openSub({ kind: 'discover' });
  };

  const handleCloseDiscover = () => {
    setDiscoverInitialQuery(null);
    back();
  };

  const handleDiscoverStart = (url: string) => {
    // J26: the processing pipeline pushes the learning route on top of the
    // discovery view, so "back" returns to the candidate list (no replace).
    void handleUrlSubmit(url);
  };

  const handleOpenReader = () => {
    setReaderInitialImport(null);
    openSub({ kind: 'reader' });
  };

  // Start-learning "read article" mode: a bare http(s) URL goes through the
  // existing URL import; anything else is treated as pasted body. No other
  // URL-shape probing happens anywhere.
  const handleStartRead = (value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (!requireAccount()) return;
    const isUrl = /^https?:\/\/\S+$/i.test(trimmed) && trimmed.length <= 4096;
    const mode: 'url' | 'text' = isUrl ? 'url' : 'text';
    setReaderInitialImport({ mode, value: trimmed });
    openSub({ kind: 'reader' });
  };

  const handleCloseReader = () => {
    setReaderInitialImport(null);
    back();
  };

  // Saved-word source jump into one article (specs/019 detail view).
  const handleOpenFavoriteArticle = (articleId: string) => {
    setWordLookup(null);
    setReaderInitialImport(null);
    openSub({ kind: 'reader', articleId });
  };

  // Free library articles live under the learn route, not the reading API.
  const handleOpenFavoriteLibraryArticle = (articleId: string) => {
    setWordLookup(null);
    void handleOpenLibraryArticle(articleId);
  };

  // Saved-word source jump into a sentence pack (`source_ref` = `L<levelId>`).
  const handleOpenFavoriteSentencePack = (levelId: number) => {
    if (!Number.isInteger(levelId) || levelId <= 0) return;
    setWordLookup(null);
    openSub({ kind: 'sentences', levelId });
  };

  const handleOpenSentences = (levelId: number) => {
    openSub({ kind: 'sentences', levelId });
  };

  const handleSelectSentenceLevel = (levelId: number) => {
    // In-screen level switch (same screen, new param): replace, never stack 5
    // history entries; keep the source tab the pack was opened from.
    replace({ tab: state.tab, sub: { kind: 'sentences', levelId } });
  };

  // The official blog is a public page (`#/blog`), not an app sub route: leave
  // the app shell and let the public site's own listener take over. `AppShell`'s
  // public-hash skip keeps `useNav` from canonicalising this back to `#/app`.
  const handleOpenBlog = () => {
    window.location.hash = '#/blog';
  };

  // ── Section anchors (D-05) ───────────────────────────────────────────────
  // `#/app/content/library` and `#/app/content/books` are real URLs: the address bar
  // owns the destination, the content page scrolls to the section. Sections
  // mount asynchronously, so the scroll retries briefly instead of polling
  // from the click handler (navigation-model §9).
  const scrollToPageAnchor = useCallback((testId: string, attempts = 0, fallbackTestId?: string) => {
    const findTarget = () => {
      const primary = document.querySelector(`[data-page-scroll] [data-testid="${testId}"]`);
      if (primary) return primary;
      return fallbackTestId
        ? document.querySelector(`[data-page-scroll] [data-testid="${fallbackTestId}"]`)
        : null;
    };
    const element = findTarget();
    if (element instanceof HTMLElement) {
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      element.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'start' });
      // Async sections change height after the first scroll (sentence packs
      // load an empty card, the report rail settles …), which can leave the
      // target above the viewport. Re-align once after the layout settles; a
      // target already parked at the top is left alone.
      if (attempts === 0) {
        window.setTimeout(() => {
          const target = findTarget();
          const scroller = target?.closest('[data-page-scroll]');
          if (!(target instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
          const offset = target.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
          if (offset < -8 || offset > 160) {
            target.scrollIntoView({
              behavior: window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
              block: 'start',
            });
          }
        }, 450);
      }
      return;
    }
    if (attempts < 12) {
      window.setTimeout(() => scrollToPageAnchor(testId, attempts + 1, fallbackTestId), 100);
    }
  }, []);

  const scrollPageToTop = useCallback(() => {
    const scroller = document.querySelector('[data-page-scroll]');
    if (!(scroller instanceof HTMLElement)) return;
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }, []);

  const anchorTestId = (anchor: SectionAnchor) => (
    anchor === 'library' ? 'content-library'
      : anchor === 'books' ? 'content-books'
        : 'content-sentence-packs'
  );

  useEffect(() => {
    if (state.tab !== 'content' || state.sub || !state.anchor) return;
    scrollToPageAnchor(anchorTestId(state.anchor));
  }, [state.anchor, state.tab, state.sub, scrollToPageAnchor]);

  const handleOpenHistoryShortcut = () => {
    // Today's history list has no URL anchor (P2): scroll after the tab renders.
    // The old `today-history-list` wrapper was replaced by the unified
    // recent-learning card, so fall back to `recent-learning` when absent.
    if (state.tab === 'today' && !state.sub) {
      scrollToPageAnchor('today-history-list', 0, 'recent-learning');
      return;
    }
    go('today');
    window.setTimeout(
      () => scrollToPageAnchor('today-history-list', 0, 'recent-learning'),
      100,
    );
  };

  const openSectionAnchor = (anchor: SectionAnchor) => {
    const testId = anchorTestId(anchor);
    if (state.tab === 'content' && !state.sub && state.anchor === anchor) {
      scrollToPageAnchor(testId);
      return;
    }
    openAnchor(anchor);
  };

  const handleOpenLibraryShortcut = () => openSectionAnchor('library');
  const handleOpenBooksShortcut = () => openSectionAnchor('books');

  // The sidebar sentence entry is a content door, not a direct lesson: open
  // the Content tab and scroll to the sentence-packs section. Selecting a
  // level there still opens the sentence view.
  const handleOpenSentencesShortcut = () => {
    openSectionAnchor('sentence-packs');
  };

  // ── Desktop sidebar second-level entries ─────────────────────────────────
  // Each child forces its owning tab before opening, so the expanded group and
  // the source tab in the URL agree. The route model is unchanged: tab root
  // (replace) → existing sub view (push).
  const openSubFromTab = (tab: TabId, sub: SubRoute) => {
    if (state.tab !== tab) go(tab);
    openSub(sub);
  };

  const handleOpenDiscoverShortcut = () => {
    if (!requireAccount()) return;
    // A sidebar entry never replays a topic handed over earlier.
    setDiscoverInitialQuery(null);
    openSubFromTab('content', { kind: 'discover' });
  };

  const handleOpenReportShortcut = () => {
    if (!requireAccount()) return;
    openSubFromTab('today', { kind: 'report' });
  };

  const handleOpenReviewShortcut = () => {
    if (!requireAccount()) return;
    openSubFromTab('practice', { kind: 'review' });
  };

  const handleOpenExamShortcut = () => {
    if (!requireAccount()) return;
    openSubFromTab('practice', { kind: 'exam' });
  };

  const handleOpenPlacementShortcut = () => {
    const view = placementProfile ? 'profile' : 'intro';
    if (state.tab === 'practice' && state.sub?.kind === 'placement') {
      replace({ tab: 'practice', sub: { kind: 'placement', view } });
      return;
    }
    openSubFromTab('practice', { kind: 'placement', view });
  };

  const handleOpenAbilityShortcut = () => {
    openSubFromTab('profile', { kind: 'ability' });
  };

  const handleOpenProfileSection = (section: ProfileSectionId) => {
    const scroll = () => {
      if (section === 'account') {
        scrollPageToTop();
        return;
      }
      scrollToPageAnchor(PROFILE_SECTION_TESTIDS[section]);
    };
    if (state.tab === 'profile' && !state.sub) {
      scroll();
      return;
    }
    go('profile');
    window.setTimeout(scroll, 100);
  };

  // Desktop top-bar shortcut: Content page, paste input focused.
  const focusContentComposer = useCallback(() => {
    const focusInput = (attempts = 0) => {
      const input = document.getElementById('video-url') as
        | HTMLInputElement
        | HTMLTextAreaElement
        | null;
      if (input) {
        const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        input.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
        input.focus({ preventScroll: true });
        return;
      }
      if (attempts < 8) window.setTimeout(() => focusInput(attempts + 1), 80);
    };
    go('content');
    window.setTimeout(() => focusInput(), 80);
  }, [go]);

  // Admin console (specs/021 + 023). Standalone full-page shell; the only
  // in-app entry is the administrator section of the profile page.
  const handleOpenAdmin = () => {
    if (!isAdmin) {
      toast.error(t('admin.error.forbidden'));
      return;
    }
    openSub({ kind: 'admin' });
  };

  const handleCloseAdmin = () => {
    back();
  };

  const handleAdminDenied = () => {
    replace({ tab: 'profile', sub: null });
  };

  // Access guard for a hand-typed #/app/profile/admin (or a bookmarked /admin):
  // wait one tick for the auth/admin flag, then either render or bounce.
  const adminGuardRef = useRef(false);
  useEffect(() => {
    if (state.sub?.kind !== 'admin') {
      adminGuardRef.current = false;
      return;
    }
    if (status === 'loading' || adminGuardRef.current) return;
    const timer = window.setTimeout(() => {
      adminGuardRef.current = true;
      if (!isAdmin) {
        toast.error(t('admin.error.forbidden'));
        replace({ tab: 'profile', sub: null });
      }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [state.sub, status, isAdmin, replace, t]);

  // Legacy `/admin` path (SPA fallback): rewrite to the canonical hash once and
  // keep the old "wait a tick for the admin flag" behaviour.
  const adminPathRef = useRef(false);
  useEffect(() => {
    if (adminPathRef.current) return;
    const pathname = window.location.pathname;
    if (!/(?:^|\/)admin\/?$/.test(pathname)) {
      adminPathRef.current = true;
      return;
    }
    if (status === 'loading') return;
    const timer = window.setTimeout(() => {
      adminPathRef.current = true;
      const nextPath = pathname.replace(/\/admin\/?$/, '/');
      const nextHash = isAdmin ? '#/app/profile/admin' : '#/app/profile';
      window.history.replaceState(null, '', `${nextPath}${window.location.search}${nextHash}`);
      replace(parseRoute(nextHash));
      if (!isAdmin) toast.error(t('admin.error.forbidden'));
    }, 500);
    return () => window.clearTimeout(timer);
  }, [isAdmin, status, replace, t]);

  const handleOpenWordbookRoute = () => {
    // J23: always push on top of whatever is open (learning page included), so
    // the word book's back arrow returns to that exact context. `open()` is
    // de-duplicated, so sitting on the word book never stacks another frame.
    open({ kind: 'vocabulary' });
  };

  const handleToggleSentenceFavorite = useCallback((s: Sentence, levelId: number, levelTitle?: string) => {
    toggleFavorite({
      id: sentenceFavId(levelId, s.n),
      // >11 chars so a saved word is never mistaken for a YouTube id
      videoId: `sentence-pack-L${levelId}`,
      start: 0,
      en_text: segToPlain(s.seg),
      zh_text: s.zh,
      added_at: Date.now(),
      highlights: s.seg
        .filter((p): p is SegChunk => typeof p !== 'string')
        .map(p => ({ en_word: p.t, zh_word: p.g, color: CHUNK_STYLE[p.c].text })),
      type: 'sentence',
      source_kind: 'sentence_pack',
      source_ref: `L${levelId}`,
      source_title: levelTitle?.trim() || undefined,
    });
  }, [toggleFavorite]);

  // Translation target language changed. Cost protection (specs/012 §5.3):
  // abort the in-flight stream and leave the current sub view rather than
  // mixing the old language's batches into the new UI. Nothing is re-translated
  // here; the next submit/open picks the new targetLang up from `apiFetch`.
  const previousTargetLangRef = useRef(targetLang);
  useEffect(() => {
    if (previousTargetLangRef.current === targetLang) return;
    previousTargetLangRef.current = targetLang;

    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setLoadingState(null);
    setTranslationProgress(null);
    setWordLookup(null);
    pendingSeekRef.current = null;
    pendingLocalSeekRef.current = null;

    // The admin console and the word book do not depend on the
    // translation target language; leave those open. Everything else is
    // closed so stale old-language content is never painted.
    if (state.sub && state.sub.kind !== 'admin' && state.sub.kind !== 'vocabulary') {
      replace({ tab: state.tab, sub: null });
    }
    resetLearning();

    toast.info(t('language.targetChangedToast', {
      language: getLanguageMeta(targetLang).displayNames[language],
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetLang, language, t]);

  // Composing the learning view's feature label from the route/payload.
  const featureLabel = libraryArticle || isLibraryVideo
    ? t('topbar.feature.library')
    : isLocalSubtitle
      ? t('topbar.feature.local')
      : t('topbar.feature.video');
  // ── Learning-view building blocks ───────────────────────────────────────
  // Both learning modes (YouTube and local SRT episodes) share one two-column
  // shell: the transcript pane and the summary pane each have two possible
  // homes (below the media vs the right sidebar), so they are built once and
  // placed by the layout below instead of being duplicated.

  const episodeDuration = transcript.length > 0 ? transcript[transcript.length - 1]?.end ?? 0 : 0;
  const localEpisodeLabel = String(metadata?.title || '').match(/S\d+E\d+/i)?.[0]?.toUpperCase() ?? '';

  const mediaStage = (
    <div
      data-testid="video-area"
      className="flex-none w-full aspect-video max-h-[62%] min-h-[180px] relative bg-transparent"
    >
      {isLocalSubtitle && !hasLocalVideo ? (
        <LocalEpisodeStage
          showTitle={metadata?.channel || metadata?.title || t('transcript.localEpisodeBadge')}
          episodeTitle={metadata?.title || ''}
          episodeLabel={localEpisodeLabel}
          duration={episodeDuration}
          currentTime={currentTime}
          isPlaying={isSubtitlePlaying}
          onTogglePlay={() => {
            if (isSubtitlePlaying) pauseSubtitleTimer();
            else startSubtitleTimer(currentTime);
          }}
          onSeek={seekTo}
        />
      ) : (
        <VideoPlayer
          videoId={hasLocalVideo ? localYouTubeId : videoId}
          seekCommand={seekCommand}
          onTimeUpdate={handleTimeUpdate}
          wrapperRef={fullscreenWrapperRef}
          playbackRate={playbackRate}
          playToggleCommand={playToggleCommand}
          onPlayerReady={hasLocalVideo ? () => setLocalVideoError(false) : undefined}
          onPlayerError={hasLocalVideo ? () => setLocalVideoError(true) : undefined}
          onPlaybackStateChange={(playing) => { if (!playing) pauseWatch(); }}
        />
      )}

      {/* Free library banner: makes it obvious the bilingual subtitles are
          already on disk and no processing/translation request is running. */}
      {isLibraryVideo && (
        <div
          data-testid="library-video-badge"
          className="absolute left-3 top-3 z-30 pointer-events-none inline-flex items-center rounded-full border border-emerald-500/20 bg-zinc-950/80 backdrop-blur-md px-3 py-1.5 text-[11px] font-semibold text-emerald-300 shadow-lg shadow-black/30"
        >
          {t('library.videoBadge')}
        </div>
      )}

      {/* The embedded player failed (offline / embed denied / removed video).
          Keep every subtitle affordance usable and offer a simulated clock
          instead of blocking the episode behind a dead iframe. */}
      {hasLocalVideo && localVideoFallback && (
        <div
          data-testid="local-video-unavailable"
          role="status"
          className="absolute inset-x-4 bottom-4 z-30 flex items-center gap-2.5 rounded-lg bg-zinc-950/85 backdrop-blur-md px-3 py-2 ring-1 ring-white/10 shadow-lg shadow-black/30"
        >
          <AlertTriangle className="w-4 h-4 text-amber-400 shrink-0" />
          <span className="flex-1 min-w-0 text-xs text-zinc-300 truncate">
            {t('transcript.videoUnavailable')}
          </span>
          <span
            data-testid="local-fallback-time"
            className="shrink-0 text-[11px] font-medium tabular-nums text-zinc-500"
          >
            {formatClock(currentTime)}
          </span>
          <button
            type="button"
            data-testid="local-fallback-play-toggle"
            onClick={() => {
              if (isSubtitlePlaying) pauseSubtitleTimer();
              else startSubtitleTimer(currentTime);
            }}
            aria-label={isSubtitlePlaying ? t('transcript.pause') : t('transcript.play')}
            title={isSubtitlePlaying ? t('transcript.pauseTitle') : t('transcript.playTitle')}
            className="w-7 h-7 shrink-0 rounded-full flex items-center justify-center bg-white/10 text-zinc-100 hover:bg-white/15 ring-1 ring-white/15 transition-colors active:scale-[0.95]"
          >
            {isSubtitlePlaying ? (
              <Pause className="w-3.5 h-3.5" fill="currentColor" />
            ) : (
              <Play className="w-3.5 h-3.5 ml-0.5" fill="currentColor" />
            )}
          </button>
        </div>
      )}
    </div>
  );

  const channelBar = metadata?.channel ? (
    <div className="glass-panel border-t-0 border-r border-white/5 px-6 py-4 flex items-center justify-between shrink-0 z-10">
      <div className="flex items-center gap-3">
        <span className="text-xs font-medium text-zinc-500 whitespace-nowrap">{t('transcript.channelLabel')}</span>
        <button
          onClick={() => setSelectedChannel(metadata.channel)}
          className="inline-flex items-center h-8 px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-blue-400 text-sm font-medium whitespace-nowrap transition-colors"
        >
          <span className="truncate max-w-[160px]">{metadata.channel}</span>
        </button>
        {metadata.channel_url && (
          <button
            onClick={handleToggleSubscription}
            className={`inline-flex items-center h-8 px-3 text-sm font-medium rounded-lg border whitespace-nowrap transition-colors ${subscriptions.some(s => s.id === metadata.channel_url)
              ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20 hover:bg-emerald-500/15'
              : 'bg-zinc-800/60 text-zinc-300 border-white/5 hover:text-zinc-100 hover:bg-zinc-700/60'
              }`}
          >
            {subscriptions.some(s => s.id === metadata.channel_url) ? t('transcript.subscribed') : t('transcript.subscribe')}
          </button>
        )}
      </div>
      <h3 className="text-white font-medium text-sm truncate ml-4 max-w-[40%] opacity-80" title={metadata.title}>
        {metadata.title}
      </h3>
    </div>
  ) : null;

  const summaryBody = (
    <>
      <TeachingNotesPanel
        status={teachingNotesStatus}
        analysis={teachingAnalysis}
        transcript={transcript}
        onSeek={handleTeachingNoteSeek}
        onRetry={handleTeachingNotesRetry}
        onRequestLogin={onRequestLogin}
      />
      {summary ? (
        <>
          <button
            onClick={() => setIsSummaryOpen(prev => !prev)}
            className="flex items-center justify-between w-full pb-2 cursor-pointer group"
          >
            <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 group-hover:text-purple-300 transition-colors">{t('transcript.summaryTitle')}</h2>
            <ChevronDown
              className={`w-4 h-4 text-zinc-400 group-hover:text-purple-400 transition-transform duration-300 ${isSummaryOpen ? 'rotate-180' : ''}`}
            />
          </button>
          <div
            className={`grid transition-[grid-template-rows,opacity] duration-300 ease-apple ${isSummaryOpen ? 'grid-rows-[1fr] opacity-100 mt-2' : 'grid-rows-[0fr] opacity-0'}`}
          >
            <div className="overflow-hidden min-h-0 text-zinc-300 text-sm leading-relaxed space-y-2">
              <ReactMarkdown
                components={{
                  h1: ({ node, ...props }) => <h1 className="text-base font-semibold text-zinc-100 mt-5 mb-2" {...props} />,
                  h2: ({ node, ...props }) => <h2 className="text-[15px] font-semibold text-zinc-100 mt-4 mb-1.5" {...props} />,
                  h3: ({ node, ...props }) => <h3 className="text-sm font-semibold text-zinc-300 mt-3 mb-1.5" {...props} />,
                  p: ({ node, ...props }) => <p className="text-zinc-300 leading-relaxed" {...props} />,
                  ul: ({ node, ...props }) => <ul className="list-disc pl-5 space-y-1 text-zinc-300 marker:text-zinc-600" {...props} />,
                  ol: ({ node, ...props }) => <ol className="list-decimal pl-5 space-y-1 text-zinc-300 marker:text-zinc-600" {...props} />,
                  li: ({ node, ...props }) => <li className="pl-1" {...props} />,
                  strong: ({ node, ...props }) => <strong className="font-semibold text-zinc-100" {...props} />,
                  code: ({ node, className, children, ...props }: any) => {
                    const isInline = !className && !String(children).includes('\n');
                    return isInline
                      ? <code className="bg-zinc-800 text-zinc-200 px-1.5 py-0.5 rounded text-xs border border-white/10 font-mono" {...props}>{children}</code>
                      : <code className="block bg-zinc-800 text-zinc-300 p-3 rounded-lg text-xs overflow-x-auto my-2 border border-white/10 font-mono" {...props}>{children}</code>;
                  }
                }}
              >
                {summary}
              </ReactMarkdown>
            </div>
          </div>
        </>
      ) : (
        <>
          <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 mb-2 pb-2">{t('transcript.tipsTitle')}</h2>
          <ul className="text-zinc-400 space-y-2 list-disc list-inside">
            <li>{t('transcript.tips.1')}</li>
            <li>{t('transcript.tips.2')}</li>
            <li>{t('transcript.tips.3')}</li>
            <li>{t('transcript.tips.4')}</li>
          </ul>
        </>
      )}

      {/* Vocabulary Summary Accordion */}
      {transcript.length > 0 && (() => {
        const seen = new Set<string>();
        const vocabItems: { en: string; zh: string; start: number; en_text: string; zh_text: string; highlights: any[] }[] = [];
        for (const block of displayTranscript) {
          if (block.highlights) {
            for (const h of block.highlights) {
              const key = `${h.en_word}|||${h.zh_word}`;
              if (!seen.has(key)) {
                seen.add(key);
                vocabItems.push({
                  en: h.en_word,
                  zh: h.zh_word,
                  start: block.start,
                  en_text: block.en_text,
                  zh_text: block.zh_text,
                  highlights: block.highlights
                });
              }
            }
          }
        }
        if (vocabItems.length === 0) return null;
        return (
          <div className="mt-6 pt-6 border-t border-white/5">
            <button
              onClick={() => setIsVocabOpen(prev => !prev)}
              className="flex items-center justify-between w-full cursor-pointer group"
            >
              <h2 className="text-[17px] font-semibold tracking-tight text-zinc-100 group-hover:text-purple-300 transition-colors">
                {t('transcript.vocabTitle')}
                <span className="ml-2 text-sm font-normal text-zinc-500 tabular-nums">({vocabItems.length})</span>
              </h2>
              <ChevronDown
                className={`w-4 h-4 text-zinc-400 group-hover:text-purple-400 transition-transform duration-300 ${isVocabOpen ? 'rotate-180' : ''}`}
              />
            </button>
            <div
              className={`grid transition-[grid-template-rows,opacity] duration-300 ease-apple ${isVocabOpen ? 'grid-rows-[1fr] opacity-100 mt-3' : 'grid-rows-[0fr] opacity-0'}`}
            >
              <div className="overflow-hidden min-h-0 space-y-1">
                {vocabItems.map((item, idx) => {
                  const vocabId = `vocab-${videoId}-${item.en.replace(/\s+/g, '-')}`;
                  const isFav = favorites.some(f => f.id === vocabId);
                  return (
                    <button
                      key={idx}
                      onClick={() => seekTo(item.start)}
                      className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-zinc-800/80 transition-colors group/row cursor-pointer"
                    >
                      <span className="text-purple-300 font-medium text-sm text-left group-hover/row:text-purple-200 transition-colors flex-1">{item.en}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-zinc-400 text-sm text-right group-hover/row:text-zinc-300 transition-colors">{item.zh}</span>
                        <div
                          onClick={(e) => handleToggleVocabFavorite(e, item)}
                          className={`p-1.5 rounded-lg hover:bg-white/5 transition-[opacity,background-color,color] duration-200 ${isFav ? 'text-amber-400' : 'text-zinc-500 opacity-0 group-hover/row:opacity-100 [@media(pointer:coarse)]:opacity-100 hover:text-amber-400'}`}
                        >
                          <Star className="w-4 h-4" fill={isFav ? "currentColor" : "none"} />
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        );
      })()}
    </>
  );

  // `pageScroll` is the one place the learning page differs by platform: on
  // mobile the transcript grows with the page (the only scroll container is
  // the layout wrapper) and auto-follow scrolls that container; on desktop
  // (and in the PiP window) the transcript keeps its own scrollbar.
  // Layout §6.3 (L-01).
  const renderTranscriptContent = (pageScroll: boolean) => (
    <>
      {/* Transcript toolbar: translation mode, loop, speed. On mobile it is
          one horizontally scrollable row so the tools never wrap into a
          multi-line block above the subtitles (§6.3 rule 7). */}
      <div className="flex-none flex flex-wrap max-md:flex-nowrap max-md:overflow-x-auto max-md:overscroll-x-contain items-center gap-x-3 gap-y-1.5 px-4 py-2 bg-zinc-950/60 backdrop-blur-xl border-b border-white/5 z-20">
        <span className="text-xs text-zinc-500 font-medium shrink-0 whitespace-nowrap">{t('transcript.translationLabel')}</span>
        <div className="inline-flex items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5">
          {([
            { key: 'all', label: t('transcript.mode.all') },
            { key: 'hidden', label: t('transcript.mode.hidden') },
          ] as { key: TranslationMode; label: string }[]).map(opt => (
            <button
              key={opt.key}
              onClick={() => setTranslationMode(opt.key)}
              className={`relative px-2.5 py-1 text-xs font-medium rounded-md whitespace-nowrap transition-colors ${
                translationMode === opt.key
                  ? 'text-zinc-900'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {translationMode === opt.key && (
                <motion.span
                  layoutId="transModeThumb"
                  className="absolute inset-0 bg-zinc-100 rounded-md shadow-sm"
                  transition={{ type: 'spring', stiffness: 420, damping: 36 }}
                />
              )}
              <span className="relative z-10">{opt.label}</span>
            </button>
          ))}
        </div>

        <ReadingHighlightToggle
          enabled={videoHighlight.enabled}
          onChange={videoHighlight.setEnabled}
          levelLabel={videoHighlight.levelLabel}
          testId="video-highlight-toggle"
        />
        <LanguagePointToggle
          enabled={showLanguagePoints}
          onChange={setShowLanguagePoints}
          testId="video-language-points-toggle"
        />

        <div className="w-px h-4 bg-white/10 shrink-0" />

        <button
          onClick={() => {
            setDictationMode(prev => {
              if (!prev) setTranslationMode('hidden'); // 听写时默认全部隐藏
              return !prev;
            });
          }}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
            dictationMode
              ? 'bg-amber-500/15 text-amber-300 border-amber-500/30'
              : 'bg-zinc-800/80 text-zinc-400 border-white/5 hover:text-zinc-200'
          }`}
          title={t('transcript.dictationTitle')}
        >
          <EyeOff className="w-3.5 h-3.5" />
          {t('transcript.dictation')}
        </button>

        <button
          onClick={toggleLoop}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
            loopEnabled
              ? 'bg-blue-500/15 text-blue-300 border-blue-500/30'
              : 'bg-zinc-800/80 text-zinc-400 border-white/5 hover:text-zinc-200'
          }`}
          title={t('transcript.loopTitle')}
        >
          <Repeat className="w-3.5 h-3.5" />
          {t('transcript.loop')}
        </button>

        {(!isLocalSubtitle || hasLocalVideo) && (
          <select
            data-testid="playback-rate-select"
            value={playbackRate}
            onChange={(e) => {
              const next = parseFloat(e.target.value);
              notePlaybackRate({ contentRef: videoId, fromRate: playbackRate, toRate: next });
              setPlaybackRate(next);
            }}
            className="appearance-none bg-zinc-800/80 text-zinc-300 text-xs font-medium rounded-lg border border-white/5 h-7 pl-2.5 pr-6 outline-none cursor-pointer hover:text-zinc-100 shrink-0 bg-no-repeat bg-[right_0.5rem_center] bg-[length:10px] bg-[url('data:image/svg+xml;utf8,<svg%20xmlns=%22http://www.w3.org/2000/svg%22%20viewBox=%220%200%2010%206%22><path%20d=%22M1%201l4%204%204-4%22%20stroke=%22%2371717a%22%20stroke-width=%221.5%22%20fill=%22none%22%20stroke-linecap=%22round%22/></svg>')]"
            title={t('transcript.speedTitle')}
          >
            {[0.5, 0.75, 1, 1.25, 1.5, 2].map(r => (
              <option key={r} value={r}>{r}x</option>
            ))}
          </select>
        )}

        {/* Comprehension quiz entry (M3 / specs/014). Enabled only once the
            current video has a bilingual subtitle cache; without one, the
            click still explains why instead of being a dead disabled button. */}
        <button
          type="button"
          data-testid="quiz-entry-button"
          data-cache-ready={quizCacheReady ? 'true' : 'false'}
          onClick={() => void handleStartQuiz()}
          aria-disabled={!quizCacheReady || quizStarting}
          aria-label={quizCacheReady ? t('quiz.entry.title') : t('quiz.entry.disabledHint')}
          title={quizCacheReady ? t('quiz.entry.title') : t('quiz.entry.disabledHint')}
          className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
            quizCacheReady
              ? 'bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20 text-blue-300'
              : 'bg-zinc-800/50 border-white/5 text-zinc-500 opacity-60 cursor-not-allowed'
          }`}
        >
          {quizStarting
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <GraduationCap className="w-3.5 h-3.5" />}
          <span>{quizStarting ? t('quiz.entry.preparing') : t('quiz.entry')}</span>
        </button>

        {/* Course generation (specs/030). The source is this video's processed
            bilingual subtitles, so the button is shown on YouTube/library
            videos only (local episodes have no generate contract). */}
        {SHOW_COURSE_GENERATION && !isLocalSubtitle && (
          <button
            type="button"
            data-testid="course-generate-button"
            data-state={courseGenerating ? 'loading' : 'idle'}
            onClick={() => void handleGenerateCourse()}
            disabled={courseGenerating}
            aria-busy={courseGenerating}
            aria-label={courseGenerating ? t('course.generate.loading') : t('course.generate.cta')}
            title={courseGenerating ? t('course.generate.loading') : t('course.generate.cta')}
            className={`inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border transition-colors shrink-0 ${
              courseGenerating
                ? 'bg-blue-500/10 border-blue-500/20 text-blue-300 cursor-wait'
                : 'bg-blue-500/10 hover:bg-blue-500/15 border-blue-500/20 text-blue-300'
            }`}
          >
            {courseGenerating
              ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
              : <BookOpenCheck className="w-3.5 h-3.5" />}
            <span>{courseGenerating ? t('course.generate.loading') : t('course.generate.cta')}</span>
          </button>
        )}

        <div className="flex-1" />

        <span
          className="hidden lg:flex items-center gap-1 text-[11px] text-zinc-600 shrink-0 cursor-default"
          title={t('transcript.shortcutsTitle')}
        >
          <Keyboard className="w-3.5 h-3.5" /> {t('transcript.shortcutsHint')}
        </span>

        {/* Transcript placement toggle: tucked under the media ↔ docked right */}
        <button
          type="button"
          data-testid="transcript-layout-toggle"
            onClick={() => setTranscriptLayout(prev => (prev === 'split' ? 'stacked' : 'split'))}
            aria-pressed={isTranscriptExpanded}
            title={isTranscriptExpanded
              ? t('transcript.layout.collapseTitle', { media: isLocalSubtitle ? t('transcript.media.local') : t('transcript.media.video') })
              : t('transcript.layout.expandTitle', { media: isLocalSubtitle ? t('transcript.media.local') : t('transcript.media.video') })}
            className="hidden md:inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border border-white/5 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition-colors shrink-0"
          >
            {isTranscriptExpanded
              ? <PanelRightClose className="w-3.5 h-3.5" />
              : <PanelRightOpen className="w-3.5 h-3.5" />}
            <span>{isTranscriptExpanded ? t('transcript.layout.collapse') : t('transcript.layout.expand')}</span>
        </button>
      </div>

      {/* Streaming translation progress */}
      {translationProgress && (
        <div className="flex-none flex items-center gap-3 px-4 py-2 bg-zinc-900/80 backdrop-blur-md backdrop-saturate-150 border-b border-white/5 z-20">
          <Loader2 className="w-4 h-4 text-blue-400 animate-spin shrink-0" />
          <span className="text-xs text-zinc-300 font-medium tabular-nums flex-1 truncate">
            {translationProgress.stage === 'summary'
              ? t('transcript.progress.summary')
              : t('transcript.progress.translating', { done: translationProgress.done, total: translationProgress.total })}
          </span>
          {translationProgress.total > 0 && (
            <div className="w-24 h-1.5 rounded-full bg-zinc-800 overflow-hidden shrink-0">
              <div
                className="h-full bg-blue-500 rounded-full transition-[width] duration-500 ease-out"
                style={{ width: `${Math.round((translationProgress.done / translationProgress.total) * 100)}%` }}
              />
            </div>
          )}
          <button
            onClick={() => {
              cancelTranslationStream();
              toast.info(t('transcript.stopToast'));
            }}
            className="flex items-center gap-1 text-xs text-zinc-400 hover:text-red-400 transition-colors shrink-0"
            title={t('transcript.progress.stop')}
          >
            <XCircle className="w-3.5 h-3.5" /> {t('common.stop')}
          </button>
        </div>
      )}

      <div className="relative flex-1 min-h-0 bg-transparent">
        {/* Edge fades belong to the inner desktop scroller. On mobile the
            page itself scrolls, so an absolutely-positioned fade here would
            just dim the first/last sentences. */}
        <div className="max-md:hidden absolute top-0 inset-x-0 h-8 bg-gradient-to-b from-[#09090b] to-transparent z-10 pointer-events-none"></div>
        <TranscriptView
          transcript={displayTranscript}
          activeIndex={activeTranscriptIndex}
          videoId={videoId}
          favorites={favoriteIds}
          onTranscriptClick={handleTranscriptClick}
          onToggleFavorite={handleToggleFavorite}
          translationMode={translationMode}
          dictation={dictationMode}
          onWordLookup={handleWordLookup}
          isHighlighted={videoHighlight.isHighlighted}
          languagePointsByBlock={languagePointsByBlock}
          wordGlossesByBlock={wordGlossesByBlock}
          showLanguagePoints={showLanguagePoints}
          difficultyEnabled={videoHighlight.enabled}
          difficultyLevel={videoHighlight.level}
          difficultyVersion={videoHighlight.wordLevels.size}
          borderLeft={isTranscriptExpanded}
          uiLanguage={language}
          pageScroll={pageScroll}
        />
        <div className="max-md:hidden absolute bottom-0 inset-x-0 h-16 bg-gradient-to-t from-[#09090b] to-transparent z-10 pointer-events-none"></div>
      </div>
    </>
  );

  // ── View rendering ──────────────────────────────────────────────────────
  // Everything below is a pure mapping from `NavState` to a component. No
  // view-priority `if/else` chain, no hidden booleans (P0 IA §1.2 problem 3).
  const sub = state.sub;

  const subFrame = (node: React.ReactNode) => (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">{node}</div>
  );

  // Admin console is its own full-page shell: no consumer top bar / bottom
  // bar. A non-admin hand-typed URL is bounced by the guard effect above; the
  // placeholder avoids flashing the console while that tick runs.
  if (sub?.kind === 'admin') {
    return (
      <div
        data-testid="app-shell"
        className="h-screen w-full flex flex-col bg-[#09090b] overflow-hidden text-zinc-100 selection:bg-purple-500/30"
        style={{ height: '100dvh' }}
      >
        {isAdmin ? (
          <AdminConsoleScreen onClose={handleCloseAdmin} parentLabel={t('nav.profile')} onDenied={handleAdminDenied} />
        ) : (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-zinc-500" />
          </div>
        )}
      </div>
    );
  }

  const learningView = (
    <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
      <LearningHeader
        title={metadata?.title || t('common.unknownVideo')}
        featureLabel={featureLabel}
        onBack={() => back()}
        parentLabel={parentLabel}
        wordbookCount={vocabularyFavoriteCount}
        onOpenWordbook={handleOpenWordbookRoute}
      />
      <div
        ref={fullscreenWrapperRef}
        data-testid="learning-scroll"
        className="learning-scroll flex-1 min-h-0 flex flex-col md:flex-row overflow-hidden max-md:overflow-y-auto relative bg-transparent group/wrapper"
      >
        {/* One shell for both learning modes. Left column: media stage +
            whatever sits beneath it — the transcript by default, the
            summary/vocabulary when the transcript is expanded to the right. */}
        <div
          data-testid="video-column"
          style={{ '--left-w': `${leftRatio}%` } as React.CSSProperties}
          className="w-full max-md:h-auto md:h-full md:w-[var(--left-w)] flex flex-col min-w-0 shrink-0"
        >
          {mediaStage}
          {!isLocalSubtitle && channelBar}

          {isTranscriptExpanded ? (
            <div
              data-testid="summary-panel"
              className="p-6 bg-zinc-900/60 backdrop-blur-xl border-t border-white/5 md:flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar"
            >
              {summaryBody}
            </div>
          ) : (
            <div
              data-testid="transcript-column"
              className="md:flex-1 md:min-h-0 flex flex-col relative border-t border-white/5 bg-transparent"
            >
              {renderTranscriptContent(true)}
            </div>
          )}
        </div>

            {/* Draggable split: desktop only. Drag changes the left column
                percentage within [MIN, MAX]; double-click or Home/End restore. */}
            <div
              data-testid="split-divider"
              role="separator"
              aria-orientation="vertical"
              aria-label={t('transcript.splitDividerAria')}
              aria-valuemin={MIN_SPLIT_RATIO}
              aria-valuemax={MAX_SPLIT_RATIO}
              aria-valuenow={Math.round(leftRatio)}
              tabIndex={0}
              title={t('transcript.splitDividerTitle')}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                e.preventDefault();
                setIsResizing(true);
              }}
              onKeyDown={handleDividerKeyDown}
              onDoubleClick={() => setLeftRatio(DEFAULT_SPLIT_RATIO)}
              className="hidden md:flex relative w-2 flex-none cursor-col-resize touch-none select-none items-center justify-center group/divider"
            >
              <span className={`absolute inset-y-0 left-1/2 -translate-x-1/2 w-px transition-colors duration-200 ${isResizing ? 'bg-blue-500/60' : 'bg-white/5 group-hover/divider:bg-white/10'}`} />
              <span className={`relative z-10 w-1 h-8 rounded-full transition-[background-color,opacity] duration-200 ${isResizing ? 'bg-blue-400/70' : 'bg-white/10 opacity-0 group-hover/divider:opacity-100 group-focus-visible/divider:opacity-100'}`} />
            </div>

            {/* Right column: summary sidebar by default, transcript when the
                transcript is expanded. */}
            <div
              data-testid="right-column"
              className="w-full md:flex-1 min-w-0 max-md:shrink-0 md:h-full flex flex-col relative border-t md:border-t-0 border-white/5 bg-transparent"
            >
              {isTranscriptExpanded ? (
                <div
                  data-testid="transcript-column"
                  className="md:h-full md:flex-1 min-h-0 flex flex-col relative bg-transparent"
                >
                  {renderTranscriptContent(true)}
                </div>
              ) : (
                <div
                  data-testid="summary-panel"
                  className="p-6 bg-zinc-900/60 backdrop-blur-xl md:overflow-y-auto custom-scrollbar md:h-full md:min-h-0"
                >
                  {summaryBody}
                </div>
              )}
            </div>
        {/* Drag shield: covers the video iframe (which would otherwise swallow
            pointermove) and suppresses text selection while dragging. */}
        {isResizing && createPortal(
          <div
            data-testid="resize-shield"
            className="fixed inset-0 z-[60] cursor-col-resize select-none"
            onPointerMove={handleResizeMove}
            onContextMenu={(e) => e.preventDefault()}
          />,
          document.body
        )}
      </div>
    </div>
  );

  const handlePlacementStartLearning = () => {
    go('today');
    setReviewStatsNonce(prev => prev + 1);
    window.setTimeout(() => {
      const input = document.getElementById('video-url') as HTMLInputElement | null;
      if (!input) return;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      input.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
    }, 350);
  };

  const profileView = (
    <ProfileScreen
      wordbookCount={vocabularyFavoriteCount}
      placementProfile={placementProfile}
      onOpenWordbook={handleOpenWordbookRoute}
      onOpenReport={handleOpenReport}
      onOpenAbility={handleOpenAbility}
      onOpenBlog={handleOpenBlog}
      onOpenAdmin={handleOpenAdmin}
      onRequestLogin={() => onRequestLogin?.()}
    />
  );

  // Record writes go through one queue: progress, cover and subtitle can land
  // in the same second and a naive read-modify-write would drop one of them.
  const patchLocalVideoRecord = useCallback((id: string, patch: Partial<LocalVideoRecord>) => {
    localVideoPatchQueue.current = localVideoPatchQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          const current = await getLocalVideo(id);
          if (!current) return;
          await putLocalVideo({ ...current, ...patch });
        } catch (error) {
          console.warn('Failed to update the local video record:', error);
        }
      });
  }, []);

  // Playback progress is throttled to one write every few seconds; pause,
  // close and tab-switch force one final write.
  const saveLocalVideoProgress = useCallback((seconds: number, force = false) => {
    if (!Number.isFinite(seconds)) return;
    localVideoLatestTime.current = seconds;
    const recordId = localVideo?.recordId;
    if (!recordId) return;
    const now = Date.now();
    if (!force && now - localVideoProgressSavedAt.current < 4000) return;
    localVideoProgressSavedAt.current = now;
    void patchLocalVideoRecord(recordId, { progress: seconds });
  }, [localVideo?.recordId, patchLocalVideoRecord]);

  const handleLocalVideoMetadata = useCallback((duration: number) => {
    const recordId = localVideo?.recordId;
    if (!recordId || !Number.isFinite(duration) || duration <= 0) return;
    void patchLocalVideoRecord(recordId, { duration });
  }, [localVideo?.recordId, patchLocalVideoRecord]);

  const handleLocalVideoCover = useCallback((coverDataUrl: string) => {
    const recordId = localVideo?.recordId;
    if (!recordId) return;
    void patchLocalVideoRecord(recordId, { coverDataUrl });
  }, [localVideo?.recordId, patchLocalVideoRecord]);

  const handleOpenLocalVideo = useCallback(async (
    video: File,
    subtitle: File | null,
    meta?: LocalVideoOpenMeta,
  ) => {
    // A saved row keeps its id so a moved/edited file updates that row instead
    // of creating a duplicate; a fresh picker choice uses the file fingerprint.
    const recordId = meta?.record?.id
      ?? (meta?.fileHandle ? buildLocalVideoId(video) : undefined);
    let existing = meta?.record;
    if (recordId) {
      try {
        const stored = await getLocalVideo(recordId);
        if (stored) existing = stored;
      } catch (error) {
        console.warn('Failed to read the saved local video record:', error);
      }
    }
    // Subtitle text is enough to rebuild the transcript: no second file pick.
    const restoredTranscript = existing?.subtitleText
      ? buildLocalTranscript(existing.subtitleText)
      : [];
    const initialTime = Number.isFinite(existing?.progress) ? (existing?.progress ?? 0) : 0;
    const videoUrl = URL.createObjectURL(video);
    localVideoLatestTime.current = initialTime;
    localVideoProgressSavedAt.current = 0;
    setLocalVideo((previous) => {
      if (previous) URL.revokeObjectURL(previous.videoUrl);
      return {
        videoUrl,
        fileName: video.name,
        subtitleName: restoredTranscript.length > 0 ? existing?.subtitleName : undefined,
        transcript: restoredTranscript,
        recordId,
        initialTime,
      };
    });
    if (recordId && meta?.fileHandle) {
      try {
        await putLocalVideo({
          id: recordId,
          name: video.name,
          size: video.size,
          lastModified: video.lastModified,
          fileHandle: meta.fileHandle,
          coverDataUrl: existing?.coverDataUrl,
          duration: existing?.duration ?? 0,
          progress: initialTime,
          subtitleName: restoredTranscript.length > 0 ? existing?.subtitleName : undefined,
          subtitleText: restoredTranscript.length > 0 ? existing?.subtitleText : undefined,
          lastOpenedAt: Date.now(),
        });
      } catch (error) {
        console.error('Failed to save the local video record:', error);
        toast.error(t('localVideo.librarySaveFailed'));
      }
    }
    if (!subtitle) return;
    const result = await readLocalSubtitleFile(subtitle);
    setLocalVideo((current) => {
      if (!current || current.videoUrl !== videoUrl) return current;
      if (result.ok) {
        return { ...current, subtitleName: subtitle.name, transcript: result.transcript };
      }
      // A newly picked broken subtitle must not discard a remembered one.
      return restoredTranscript.length > 0
        ? current
        : { ...current, subtitleName: undefined, transcript: [] };
    });
    if (result.ok) {
      if (recordId) {
        void patchLocalVideoRecord(recordId, {
          subtitleName: subtitle.name,
          subtitleText: result.text,
        });
      }
    } else {
      toast.error(result.reason === 'empty'
        ? t('localVideo.subtitleEmpty')
        : t('localVideo.subtitleReadFailed'));
    }
  }, [t, patchLocalVideoRecord]);

  // Subtitle chosen inside the player: swap the transcript in place. The video
  // URL/state is untouched, so playback position and play state survive. The
  // raw text is persisted so a saved episode reopens with the same cues.
  const handleLoadLocalSubtitle = async (file: File) => {
    const recordId = localVideo?.recordId;
    const result = await readLocalSubtitleFile(file);
    if (result.ok) {
      setLocalVideo((current) => (current
        ? { ...current, subtitleName: file.name, transcript: result.transcript }
        : current));
      if (recordId) {
        void patchLocalVideoRecord(recordId, {
          subtitleName: file.name,
          subtitleText: result.text,
        });
      }
    }
    return result;
  };

  const closeLocalVideo = useCallback(() => {
    const recordId = localVideo?.recordId;
    const finalTime = localVideoLatestTime.current;
    setLocalVideo((previous) => {
      if (previous) URL.revokeObjectURL(previous.videoUrl);
      return null;
    });
    if (!recordId) {
      setLocalVideoLibraryRevision((revision) => revision + 1);
      return;
    }
    // Save one last time, then bump the revision so the remounted Content
    // shelf reads the fresh cover/progress instead of the stale row.
    localVideoPatchQueue.current = localVideoPatchQueue.current
      .catch(() => {})
      .then(async () => {
        try {
          const current = await getLocalVideo(recordId);
          if (current) {
            await putLocalVideo({
              ...current,
              progress: finalTime,
              lastOpenedAt: Date.now(),
            });
          }
        } catch (error) {
          console.warn('Failed to save the final local video position:', error);
        }
      })
      .finally(() => setLocalVideoLibraryRevision((revision) => revision + 1));
  }, [localVideo?.recordId]);

  const renderView = () => {
    if (localVideo && state.tab === 'content' && !state.sub) {
      return (
        <LocalVideoLearning
          videoUrl={localVideo.videoUrl}
          fileName={localVideo.fileName}
          subtitleName={localVideo.subtitleName}
          transcript={localVideo.transcript}
          initialTime={localVideo.initialTime}
          wordbookCount={vocabularyFavoriteCount}
          onOpenWordbook={handleOpenWordbookRoute}
          onClose={closeLocalVideo}
          onWordLookup={handleWordLookup}
          onLoadSubtitle={handleLoadLocalSubtitle}
          onCaptureCover={handleLocalVideoCover}
          onProgress={(seconds) => saveLocalVideoProgress(seconds)}
          onPersist={(seconds) => saveLocalVideoProgress(seconds, true)}
          onMetadata={handleLocalVideoMetadata}
        />
      );
    }

    // The comprehension quiz is an overlay of the learning view, not a route
    // (IA §7.1). It wins while open; closing it re-renders the video.
    if (quizOpen && quizLesson) {
      return subFrame(
        <QuizScreen
          lesson={quizLesson}
          onExit={handleQuizExit}
          parentLabel={parentLabel}
          onSeekEvidence={handleQuizEvidence}
          onHome={handleQuizHome}
          onRequestLogin={onRequestLogin}
        />,
      );
    }

    if (sub) {
      switch (sub.kind) {
        case 'learn':
          if (libraryArticle) {
            return subFrame(
              <LibraryArticleReader
                article={libraryArticle}
                onClose={handleCloseLibraryArticle}
                parentLabel={parentLabel}
                onWordLookup={handleLibraryArticleWordLookup}
              />,
            );
          }
          if (transcript.length > 0) return learningView;
          return (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 text-zinc-500">
              <Loader2 className="w-6 h-6 animate-spin" />
              <p data-testid="restoring-view" className="text-sm">{t('nav.restoring')}</p>
            </div>
          );
        case 'course':
          return subFrame(
            <CourseScreen
              lessonId={sub.lessonId}
              isGuest={status === 'guest'}
              onRequestLogin={onRequestLogin}
              onExit={back}
              parentLabel={parentLabel}
            />,
          );
        case 'review':
          return subFrame(
            <ReviewScreen onClose={handleCloseReview} parentLabel={parentLabel} onRequestLogin={onRequestLogin} />,
          );
        case 'report':
          return subFrame(
            <ReportScreen
              onClose={handleCloseReport}
              parentLabel={parentLabel}
              onOpenEvidence={(evidence) => { void handleOpenEvidence(evidence); }}
              onOpenReview={handleOpenReview}
            />,
          );
        case 'placement':
          return subFrame(
            <PlacementScreen
              initialView={sub.view}
              isGuest={status === 'guest'}
              onClose={handleClosePlacement}
              parentLabel={parentLabel}
              onStartLearning={handlePlacementStartLearning}
              onRequestLogin={onRequestLogin}
              onOpenAbility={handleOpenAbility}
            />,
          );
        case 'ability':
          return subFrame(
            <AbilityScreen
              onClose={handleCloseAbility}
              parentLabel={parentLabel}
              onOpenPlacement={() => handleOpenPlacement('intro')}
            />,
          );
        case 'exam':
          return subFrame(
            <ExamScreen
              isGuest={status === 'guest'}
              onClose={handleCloseExam}
              parentLabel={parentLabel}
              onRequestLogin={onRequestLogin}
            />,
          );
        case 'discover':
          return subFrame(
            <DiscoverScreen
              onClose={handleCloseDiscover}
              parentLabel={parentLabel}
              onStart={handleDiscoverStart}
              onRequestLogin={onRequestLogin}
              initialQuery={discoverInitialQuery ?? undefined}
              onInitialQueryConsumed={() => setDiscoverInitialQuery(null)}
            />,
          );
        case 'reader':
          return subFrame(
            <ReaderScreen
              // Remount on a target-language switch or a different article the
              // favorites row jumps to (same key the pre-P0 nonce provided).
              key={`reader:${targetLang}:${sub.articleId ?? ''}`}
              onClose={handleCloseReader}
              parentLabel={parentLabel}
              onRequestLogin={onRequestLogin}
              isGuest={status === 'guest'}
              onWordLookup={handleReaderWordLookup}
              onImportPublicDomainBook={handleImportPublicDomainBook}
              initialArticleId={sub.articleId}
              initialImport={readerInitialImport ?? undefined}
              onInitialImportConsumed={() => setReaderInitialImport(null)}
            />,
          );
        case 'sentences':
          return subFrame(
            <SentenceView
              key={`sentences:${sub.levelId}`}
              levelId={sub.levelId}
              onSelectLevel={handleSelectSentenceLevel}
              onWordLookup={handleWordLookup}
              onToggleFavorite={handleToggleSentenceFavorite}
              favoriteIds={favoriteIds}
              onClose={() => back()}
              parentLabel={parentLabel}
            />,
          );
        case 'book':
          return subFrame(
            <BookReaderScreen
              key={`book:${sub.bookId}`}
              bookId={sub.bookId}
              onClose={() => back()}
              parentLabel={parentLabel}
              onOpenSeries={(seriesId) => openSub({ kind: 'book-series', seriesId })}
              onWordLookup={handleBookWordLookup}
            />,
          );
        case 'book-series':
          return subFrame(
            <BookSeriesScreen
              key={`book-series:${sub.seriesId}`}
              seriesId={sub.seriesId}
              onClose={() => back()}
              parentLabel={parentLabel}
              onOpenBook={(bookId) => openSub({ kind: 'book', bookId })}
            />,
          );
        case 'imported-book':
          return subFrame(
            <ImportedBookReaderScreen
              key={`imported-book:${targetLang}:${sub.bookId}`}
              bookId={sub.bookId}
              onClose={() => back()}
              parentLabel={parentLabel}
              onWordLookup={handleImportedBookWordLookup}
              onRequestLogin={() => onRequestLogin?.()}
            />,
          );
        case 'vocabulary':
          return subFrame(
            <VocabularyBookScreen
              favorites={favorites}
              onBack={back}
              parentLabel={parentLabel}
              onRemoveFavorite={handleRemoveFavorite}
              onPlayFavorite={handlePlayFavorite}
              onOpenArticle={handleOpenFavoriteArticle}
              onOpenLibraryArticle={handleOpenFavoriteLibraryArticle}
              onOpenSentencePack={handleOpenFavoriteSentencePack}
              onOpenBook={(bookId) => { setWordLookup(null); openSub({ kind: 'book', bookId }); }}
              onOpenImportedBook={(bookId) => { setWordLookup(null); openSub({ kind: 'imported-book', bookId }); }}
            />,
          );
        default:
          return profileView;
      }
    }

    switch (state.tab) {
      case 'content':
        return (
          <ContentScreen
            isGuest={status === 'guest'}
            busy={loadingState !== null}
            subscriptions={subscriptions}
            onSelectEpisode={(showId, season, episode) => { void handleSelectEpisode(showId, season, episode); }}
            onSelectChannel={setSelectedChannel}
            onUnsubscribe={(channelId) => setSubscriptions(prev => prev.filter(s => s.id !== channelId))}
            onSubmitUrl={handleUrlSubmit}
            onSearch={handleStartSearch}
            onRead={handleStartRead}
            onOpenLibraryVideo={(id) => { void handleOpenLibraryVideo(id); }}
            onOpenLibraryArticle={(id) => { void handleOpenLibraryArticle(id); }}
            onOpenBookSeries={(id) => openSub({ kind: 'book-series', seriesId: id })}
            onOpenImportedBook={(id) => openSub({ kind: 'imported-book', bookId: id })}
            bookImportSeed={bookImportSeed}
            onBookImportSeedConsumed={() => setBookImportSeed(null)}
            onOpenDiscover={handleOpenDiscover}
            onOpenReader={handleOpenReader}
            onOpenSentences={handleOpenSentences}
            onOpenBlog={handleOpenBlog}
            onOpenReport={handleOpenReport}
            onOpenLocalVideo={handleOpenLocalVideo}
            localVideoLibraryRevision={localVideoLibraryRevision}
            onLoadHistory={(filename) => { void handleLoadHistory(filename); }}
            onRequestLogin={() => onRequestLogin?.()}
          />
        );
      case 'practice':
        return (
          <PracticeScreen
            isGuest={status === 'guest'}
            reviewStats={reviewStats}
            reviewStatsLoading={reviewStatsLoading}
            reviewStatsFailed={reviewStatsFailed}
            placementProfile={placementProfile}
            placementLoading={placementLoading}
            placementFailed={placementFailed}
            onOpenReview={handleOpenReview}
            onOpenExam={handleOpenExam}
            onOpenPlacement={handleOpenPlacement}
            onGoContinue={() => go('today')}
          />
        );
      case 'profile':
        return profileView;
      case 'today':
      default:
        return (
          <TodayScreen
            isGuest={status === 'guest'}
            reviewStats={reviewStats}
            reviewStatsLoading={reviewStatsLoading}
            reviewStatsFailed={reviewStatsFailed}
            placementProfile={placementProfile}
            placementLoading={placementLoading}
            placementFailed={placementFailed}
            onSubmitUrl={handleUrlSubmit}
            onSearch={handleStartSearch}
            onRead={handleStartRead}
            onLoadHistory={(filename) => { void handleLoadHistory(filename); }}
            onOpenArticle={(articleId) => openSub({ kind: 'reader', articleId })}
            onOpenBook={(bookId) => openSub({ kind: 'book', bookId })}
            onOpenImportedBook={(bookId) => openSub({ kind: 'imported-book', bookId })}
            onOpenReview={handleOpenReview}
            onOpenReport={handleOpenReport}
            onOpenPlacement={handleOpenPlacement}
            onOpenContent={() => go('content')}
            onOpenCourse={handleOpenCourse}
            vocabLevel={vocabLevel}
            onRequestLogin={onRequestLogin}
            onOpenLesson={(lessonId) => openSub({ kind: 'course', lessonId })}
          />
        );
    }
  };

  const subLabel = state.sub
    ? (state.sub.kind === 'learn' ? featureLabel : t(SUB_LABEL_KEYS[state.sub.kind]))
    : undefined;

  return (
    <div
      data-testid="app-shell"
      className="h-screen w-full flex flex-col bg-[#09090b] overflow-hidden text-zinc-100 selection:bg-purple-500/30"
      style={{ height: '100dvh' }}
    >
      <AppShell
        state={state}
        dueCount={reviewStats?.dueNow ?? 0}
        isSub={isSubView}
        isTask={isTaskView}
        hideWordbook={Boolean(localVideo)}
        subLabel={subLabel}
        onNavigate={navigateTab}
        onRequestLogin={onRequestLogin}
        onStartLearning={focusContentComposer}
        onOpenWordbook={handleOpenWordbookRoute}
        wordbookCount={vocabularyFavoriteCount}
        onOpenHistory={handleOpenHistoryShortcut}
        onOpenSentences={handleOpenSentencesShortcut}
        onOpenLibrary={handleOpenLibraryShortcut}
        onOpenBooks={handleOpenBooksShortcut}
        onOpenDiscover={handleOpenDiscoverShortcut}
        onOpenReport={handleOpenReportShortcut}
        onOpenReview={handleOpenReviewShortcut}
        onOpenExam={handleOpenExamShortcut}
        onOpenPlacement={handleOpenPlacementShortcut}
        onOpenAbility={handleOpenAbilityShortcut}
        onOpenProfileSection={handleOpenProfileSection}
        onOpenAdmin={handleOpenAdmin}
      >
        {pendingResume && (
          <div
            data-testid="resume-banner"
            className="flex-none flex items-center gap-2 px-3 sm:px-4 py-2 bg-blue-500/10 border-b border-blue-500/20 text-xs text-blue-200"
          >
            <span className="min-w-0 flex-1 leading-relaxed">{t('jobs.resumeAvailable')}</span>
            <button
              type="button"
              data-testid="resume-banner-continue"
              onClick={() => { void handleResumePending(); }}
              className="inline-flex items-center h-7 px-2.5 rounded-lg bg-blue-500/20 hover:bg-blue-500/30 border border-blue-500/30 text-[11px] font-medium text-blue-100 transition-colors shrink-0"
            >
              {t('jobs.resumeAction')}
            </button>
            <button
              type="button"
              data-testid="resume-banner-dismiss"
              onClick={() => setPendingResume(null)}
              aria-label={t('common.close')}
              title={t('common.close')}
              className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-blue-300/70 hover:text-blue-100 hover:bg-blue-500/20 transition-colors shrink-0"
            >
              ×
            </button>
          </div>
        )}
        {renderView()}
      </AppShell>

      {loadingState && <ProcessingOverlay loadingState={loadingState} />}


      <ChannelVideoList
        isOpen={!!selectedChannel}
        onClose={() => setSelectedChannel(null)}
        channelName={selectedChannel}
        onLoadHistory={handleLoadHistory}
        onReprocess={(reprocessId) => { void handleUrlSubmit(`https://www.youtube.com/watch?v=${reprocessId}`); }}
      />

      <AnimatePresence>
        {wordLookup && (
          <WordPopover
            word={wordLookup.word}
            context={wordLookup.context}
            x={wordLookup.x}
            y={wordLookup.y}
            onClose={() => setWordLookup(null)}
            onToggleFavorite={handleToggleDictFavorite}
            isFavorited={favorites.some(f => f.id === `vocab-${wordLookup.sourceId || videoId}-${wordLookup.word.replace(/\s+/g, '-')}`)}
            onSwitchWord={handleSwitchWord}
          />
        )}
      </AnimatePresence>
    </div>
  );
}

// Blocking overlay while a link is being estimated/processed/transcribed.
// Lives at the app root so it also covers the first-level pages that started
// the job (Today / Content). It is intentionally not dismissible (A2 C4 busy /
// A3 IX-09): `alertdialog` + `loading` removes Escape/backdrop/X and exposes
// aria-busy while the job runs.
function ProcessingOverlay({ loadingState }: { loadingState: 'processing' | 'loading' | 'asr' }) {
  const { t } = useI18n();
  const title = loadingState === 'asr'
    ? t('home.loading.asr')
    : loadingState === 'processing'
      ? t('home.loading.processing')
      : t('home.loading.loading');
  return (
    <Dialog
      open
      onClose={() => {}}
      role="alertdialog"
      loading
      showClose={false}
      size="sm"
      title={title}
      testId="processing-overlay"
    >
      <div className="flex flex-col items-center gap-4 py-2 text-center">
        <Loader2 className="w-12 h-12 text-zinc-300 animate-spin" />
        {loadingState === 'processing' && (
          <p className="text-zinc-400">{t('home.loading.processingHint')}</p>
        )}
        {loadingState === 'asr' && (
          <p className="text-zinc-400">{t('home.loading.asrHint')}</p>
        )}
      </div>
    </Dialog>
  );
}

// Quiet holding screen while GET /api/auth/me decides where the app starts.
function AuthLoadingScreen() {
  const { t } = useI18n();
  return (
    <div
      data-testid="auth-loading"
      className="h-screen w-full flex flex-col items-center justify-center gap-3 bg-[#09090b] text-zinc-500"
    >
      <Loader2 className="w-6 h-6 animate-spin" />
      <p className="text-sm">{t('auth.checking')}</p>
    </div>
  );
}

// ── Public site + login (outside the app shell) ─────────────────────────────
// Routing contract:
//   `/` (no hash)            → marketing home (WelcomeScreen)
//   `#/welcome`              → `/` via replaceState (the old front door)
//   `#/blog[/<slug>]`        → public blog (list / article)
//   `#/pricing`              → pricing (beta-free, no invented price)
//   `#/resources`            → free / public-domain resources
//   `#/login[?next=...]`     → existing AuthScreen (public)
//   `#/app...`               → the learning app (AppShell + AuthGate)
//   anything else            → home (clean the address bar) — never a white screen
// The public pages never render the app shell and never pass through
// AppShell/AuthGate; the old in-app blog aliases (`#/<tab>/blog...`,
// `#/app/<tab>/blog...`) are rewritten to `#/blog...` once.

/**
 * `#/login?next=<hash>` return target (D-09). Only an app hash is accepted
 * (`#/app/...`; legacy `#/today` is canonicalised), `http(s)://` is rejected so
 * this can never become an open redirect, and another public page (blog,
 * pricing, resources, welcome, login) is not a valid destination.
 * Invalid/absent → null (the caller lands on `#/app/today`).
 */
function readLoginNext(): string | null {
  const hash = window.location.hash;
  if (parsePublicRoute(hash)?.view !== 'login') return null;
  const queryIndex = hash.indexOf('?');
  if (queryIndex === -1) return null;
  const candidate = new URLSearchParams(hash.slice(queryIndex + 1)).get('next');
  if (!candidate) return null;
  const normalized = candidate.startsWith('#')
    ? candidate
    : candidate.startsWith('/') ? `#${candidate}` : '';
  if (!normalized) return null;
  if (/^#\/(welcome|login|blog|pricing|resources|dev)(?:[/?]|$)/.test(normalized)) return null;
  const resolved = resolveRoute(normalized);
  if (resolved.kind === 'invalid') return null;
  return resolved.canonical;
}

interface PublicLocation {
  /** Public page to render; `null` means "the app owns this URL". */
  view: PublicView | null;
  /** True when the hash is an app URL (including legacy unprefixed spellings). */
  app: boolean;
  /** Blog article slug when `view === 'blog'`. */
  slug: string | null;
  /** Login return target (`#/app/...`) when `view === 'login'`. */
  next: string | null;
  devUi: boolean;
  /** Address-bar rewrite the public router must apply once (`/` or `#/blog...`). */
  redirect: string | null;
}

function readPublicLocation(): PublicLocation {
  const hash = window.location.hash;
  const devUi = isDevUiHash(hash);
  if (devUi) {
    return { view: null, app: false, slug: null, next: null, devUi: true, redirect: null };
  }
  const publicRoute = parsePublicRoute(hash);
  if (publicRoute) {
    return {
      view: publicRoute.view,
      app: false,
      slug: publicRoute.slug ?? null,
      next: readLoginNext(),
      devUi: false,
      redirect: publicRoute.rewrite ? publicRoute.canonical : null,
    };
  }
  if (isAppHash(hash)) {
    return { view: null, app: true, slug: null, next: null, devUi: false, redirect: null };
  }
  // Unknown non-app hash: the public home is the safe fallback. Blank is home
  // by definition (no rewrite needed); a stray hash is cleaned once.
  return {
    view: 'home',
    app: false,
    slug: null,
    next: null,
    devUi: false,
    redirect: hash ? '/' : null,
  };
}

function usePublicView() {
  const [publicLocation, setPublicLocation] = useState(readPublicLocation);
  const sync = useCallback(() => setPublicLocation(readPublicLocation()), []);
  useEffect(() => {
    window.addEventListener('hashchange', sync);
    window.addEventListener('popstate', sync);
    return () => {
      window.removeEventListener('hashchange', sync);
      window.removeEventListener('popstate', sync);
    };
  }, [sync]);
  return { ...publicLocation, sync };
}

// The login view keeps a way back to the marketing page; `#/welcome` is the
// public alias that the router replaces with `/` (no phantom hash entry).
function LoginView({ next }: { next: string | null }) {
  const { t } = useI18n();
  const { status } = useAuth();
  return (
    <div className="relative">
      <BackButton
        onBack={() => { window.location.hash = '#/welcome'; }}
        ariaLabel={t('welcome.login.back')}
        label={t('welcome.login.back')}
        testId="login-back"
        className="fixed left-4 top-5 z-30 sm:left-6 sm:top-6"
      />
      <AuthScreen
        onGuestContinue={() => {
          // `guest` can use the app right away; `anonymous` (backend session
          // unavailable) would just bounce back to the auth gate, so return to
          // the public home instead. Keep the `?next=` target when there is one
          // (D-09): a guest opening a deep link should land on it, not Today.
          window.location.hash = status === 'anonymous'
            ? '#/welcome'
            : (next ?? '#/app/today');
        }}
      />
    </div>
  );
}

// The only switch between the public site, the auth screen and the app.
// Session state lives in AuthProvider, so login/signup/logout and global 401s
// all land here.
//
// M1 ⑧: `guest` is the normal pre-signup state — the app stays usable and the
// top bar offers "游客 · 登录保存". Clicking it overlays the auth screen instead
// of replacing the app, so a guest who changes their mind keeps their video.
function AuthGate() {
  const { status, isAdmin } = useAuth();
  const { t } = useI18n();
  const [showAuth, setShowAuth] = useState(false);
  const {
    view: publicView,
    app,
    slug: blogSlug,
    next: loginNext,
    devUi,
    redirect: publicRedirect,
    sync: syncPublicView,
  } = usePublicView();

  // One-shot public canonicalisation: `#/welcome` → `/`, old in-app blog →
  // `#/blog...`, `#/` or a stray hash → `/`. `replaceState` keeps the public
  // page out of the back history; `sync` re-reads the cleaned URL.
  useEffect(() => {
    if (!publicRedirect) return;
    const target = publicRedirect === '/'
      ? `${window.location.pathname}${window.location.search}`
      : publicRedirect;
    window.history.replaceState(window.history.state, '', target);
    syncPublicView();
  }, [publicRedirect, syncPublicView]);

  // Signing in from #/login lands on the `?next=` target (or Today), never back
  // on the login URL. The `replace` keeps #/login out of the back history.
  // `publicView` (not a fresh hash read) is a dependency so that arriving at
  // #/login later in the same session — a hand-edited URL — is also redirected.
  useEffect(() => {
    if (status !== 'authenticated' || publicView !== 'login') return;
    window.history.replaceState(window.history.state, '', loginNext ?? '#/app/today');
    syncPublicView();
  }, [status, publicView, loginNext, syncPublicView]);

  // ⛔ Dev-only component matrix. Not a `NavState`: the normal route model
  // never sees it, it has no navigation entry, and a deep link is the only
  // way in. Development builds open it for any auth state (so the matrix can
  // be reviewed offline); a production build requires the authenticated
  // admin flag. Every other status falls through to the normal auth/app
  // switch below, which treats the hash as an invalid route (no data leak).
  const devUiAllowed = devUi && (import.meta.env.DEV || isAdmin);
  if (devUiAllowed && (import.meta.env.DEV || status !== 'loading')) {
    return (
      <Suspense fallback={<AuthLoadingScreen />}>
        <DevUIScreen />
      </Suspense>
    );
  }

  // Public site: the same shell + header/footer for home, blog, pricing and
  // resources. None of these mount AppShell/AuthGate's app branches, and they
  // render before the session bootstrap resolves — reading the blog must not
  // depend on the backend being up. (Only the header CTA adapts once the
  // session status arrives.)
  if (publicView === 'home') return <WelcomeScreen />;
  if (publicView === 'blog') return <PublicBlogScreen slug={blogSlug ?? undefined} />;
  if (publicView === 'pricing') return <PricingScreen />;
  if (publicView === 'resources') return <ResourcesScreen />;

  if (status === 'loading') return <AuthLoadingScreen />;
  if (publicView === 'login') {
    if (status !== 'authenticated') return <LoginView next={loginNext} />;
    // An authenticated user is still sitting on #/login for one tick while the
    // redirect effect above rewrites the hash to `?next=`/Today. Render the
    // quiet loading screen instead of AppContent: mounting the app with a
    // public hash would make `useNav` treat it as invalid and drop the target.
    return <AuthLoadingScreen />;
  }
  // `app` is the normal branch; a non-app URL without a public match was
  // already turned into home above. Keep a safety net instead of a blank page.
  if (!app) return <WelcomeScreen />;
  if (status === 'anonymous') return <AuthScreen />;
  if (status === 'guest') {
    return (
      <>
        <AppContent onRequestLogin={() => setShowAuth(true)} />
        {showAuth && (
          <Dialog
            open
            onClose={() => setShowAuth(false)}
            fullscreen
            showClose={false}
            ariaLabel={t('brand.fullName')}
            initialFocus='[data-testid="auth-email"]'
            testId="guest-auth-overlay"
          >
            {/* AuthScreen is its own full-height page; cancel the dialog body
                padding so it keeps the exact pre-migration layout. */}
            <div className="-m-6">
              <AuthScreen onGuestContinue={() => setShowAuth(false)} />
            </div>
          </Dialog>
        )}
      </>
    );
  }
  return <AppContent />;
}

function App() {
  return (
    <I18nProvider>
      <AuthProvider>
        {/* One model catalog / selection for the whole app (P0 IA §10.3). */}
        <ModelProvider>
          <AuthGate />
          {/* The offline marker sits above the auth gate so it survives every
              screen, not only the signed-in shell. */}
          <OfflineIndicator />
          {/* One Toaster for every branch: it survives the auth gate switch, so
              "session expired" and backend-unreachable toasts are not dropped. */}
          <Toaster />
        </ModelProvider>
      </AuthProvider>
    </I18nProvider>
  );
}

export default App;
