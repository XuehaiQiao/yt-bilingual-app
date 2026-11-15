import { apiFetch } from './lib/api';
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { Star, ChevronDown, ExternalLink, Loader2, XCircle, Repeat, Keyboard, EyeOff, PanelRightOpen, PanelRightClose, AlertTriangle, Play, Pause, LogOut, LogIn, GraduationCap, CalendarRange, ShieldCheck } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { AuthScreen } from './components/AuthScreen';
import { LanguageMenu } from './components/LanguageMenu';
import { AuthProvider, useAuth } from './lib/auth';
import { I18nProvider, useI18n } from './i18n/I18nProvider';
import { getLanguageMeta, getRuntimeTargetLang, type TranslationKey } from './i18n';
import { InputScreen } from './components/InputScreen';
import { VideoPlayer } from './components/VideoPlayer';
import { LocalEpisodeStage } from './components/LocalEpisodeStage';
import { TranscriptView } from './components/TranscriptView';
import { FavoritesModal } from './components/FavoritesModal';
import { addFavorite, fetchFavorites, removeFavorite, type FavoriteDraft, type FavoriteItem } from './lib/favorites';
import { ChannelVideoList } from './components/ChannelVideoList';
import { Toaster } from './components/Toaster';
import { WordPopover, type WordDefinition, type WordLookupTarget } from './components/WordPopover';
import { SentenceView, sentenceFavId } from './components/SentenceView';
import { ReviewScreen } from './components/ReviewScreen';
import { QuizScreen } from './components/QuizScreen';
import { ReportScreen, type WeekReportEvidence } from './components/ReportScreen';
import { PlacementScreen, type PlacementInitialView } from './components/PlacementScreen';
import { ExamScreen } from './components/ExamScreen';
import { DiscoverScreen } from './components/DiscoverScreen';
import { ReaderScreen } from './components/ReaderScreen';
import { BlogScreen } from './components/BlogScreen';
import { AdminScreen } from './components/AdminScreen';
import { OfflineIndicator } from './components/OfflineIndicator';
import { PwaInstallButton } from './components/PwaInstallButton';
import { getReviewStats, type ReviewStats } from './lib/review';
import { startLesson, QuizApiError, type LessonQuestions } from './lib/quiz';
import { endWatch, notePlayback, pauseWatch, startWatch } from './lib/events';
import { segToPlain, CHUNK_STYLE, type Sentence, type SegChunk } from './lib/sentences';
import { toast, describeApiError } from './lib/toast';
import { consumeSseStream, findActiveIndex, isUntranslated, loadTranslationMode, TRANSLATION_MODE_KEY, type TranslationMode } from './lib/transcript';
import {
  clearPendingJob,
  fetchJobSnapshot,
  finishJob,
  loadPendingJob,
  recordJobMeta,
  recordJobProgress,
  type JobSnapshot,
} from './lib/jobs';
import { loadVocabLevel, loadModel } from './lib/settings';
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
import ReactMarkdown from 'react-markdown';

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

type FeatureNameKey = Extract<TranslationKey, 'topbar.feature.video' | 'topbar.feature.local' | 'topbar.feature.sentences' | 'topbar.feature.review' | 'topbar.feature.quiz' | 'topbar.feature.discover' | 'topbar.feature.reader' | 'topbar.feature.blog'>;

// Single source of truth for the top-bar feature label. Mirrors the view
// switch below: quiz wins, then reading, then the blog, then discovery, then
// review, then sentence pack, then local episode, then YouTube; the home screen
// (no video / empty transcript) has no feature name.
function getFeatureName(
  quizOpen: boolean,
  readerOpen: boolean,
  blogOpen: boolean,
  discoverOpen: boolean,
  reviewOpen: boolean,
  sentenceLevel: number | null,
  videoId: string,
  transcriptCount: number,
  isLocalSubtitle: boolean,
): FeatureNameKey | null {
  if (quizOpen) return 'topbar.feature.quiz';
  if (readerOpen) return 'topbar.feature.reader';
  if (blogOpen) return 'topbar.feature.blog';
  if (discoverOpen) return 'topbar.feature.discover';
  if (reviewOpen) return 'topbar.feature.review';
  if (sentenceLevel != null) return 'topbar.feature.sentences';
  if (!videoId || transcriptCount === 0) return null;
  return isLocalSubtitle ? 'topbar.feature.local' : 'topbar.feature.video';
}

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
  const { user, logout, status, isAdmin, dataRevision } = useAuth();
  const { t, language, targetLang } = useI18n();
  const [videoId, setVideoId] = useState('');
  const [loadingState, setLoadingState] = useState<'processing' | 'loading' | 'asr' | null>(null);
  const [transcript, setTranscript] = useState<TranscriptItem[]>([]);
  const [summary, setSummary] = useState<string>('');
  const [metadata, setMetadata] = useState<any>(null);
  const isLocalSubtitle = Boolean(metadata?.is_local_subtitle);
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
  const isTranscriptExpanded = transcriptLayout === 'split';
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const fullscreenWrapperRef = useRef<HTMLDivElement>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekCommand, setSeekCommand] = useState<{ time: number, timestamp: number } | null>(null);

  // Sentence Packs — third learning mode (null = not in this mode)
  const [sentenceLevel, setSentenceLevel] = useState<number | null>(null);

  // Review — fourth view, alongside the three learning modes. The view state
  // stays local (like sentenceLevel) so returning always lands on the home
  // screen, per specs/013.
  const [reviewOpen, setReviewOpen] = useState(false);
  // Content discovery — full view (specs/017). Its last result is kept in the
  // screen's session storage, so backing out and re-entering is lossless.
  const [discoverOpen, setDiscoverOpen] = useState(false);
  // Reading (specs/019): a full view like discovery. The screen owns its
  // list/reader internal state; this flag only decides which view is mounted.
  const [readerOpen, setReaderOpen] = useState(false);
  // Official blog (specs/020): a public read-only view over content/blog/*.md.
  // Like the reader, the screen owns list/detail state internally.
  const [blogOpen, setBlogOpen] = useState(false);
  // Admin stop-the-bleed dashboard (specs/021): only rendered for `isAdmin`;
  // opening it does not clear the current view, so closing returns there.
  const [adminOpen, setAdminOpen] = useState(false);
  // Weekly report — its own view (M5). Opening it from a video pauses the
  // player without discarding it; closing returns to the same content.
  const [reportOpen, setReportOpen] = useState(false);
  const reportReturnTimeRef = useRef(0);
  // Ability placement / profile (M4 / specs/016) — a full view like review.
  // `intro` is the no-profile landing; `profile` is the saved-profile page.
  const [placementOpen, setPlacementOpen] = useState(false);
  const [placementInitialView, setPlacementInitialView] = useState<PlacementInitialView>('intro');
  // Exam practice (V2 / specs/022) — a full view like placement. The screen
  // owns its types/quiz/result/history phases and its local draft answers.
  const [examOpen, setExamOpen] = useState(false);
  const [reviewStats, setReviewStats] = useState<ReviewStats | null>(null);
  const [reviewStatsLoading, setReviewStatsLoading] = useState(false);
  const [reviewStatsFailed, setReviewStatsFailed] = useState(false);
  // Bumped whenever the review view closes so the home card refetches.
  const [reviewStatsNonce, setReviewStatsNonce] = useState(0);

  // Comprehension quiz (M3 / specs/014) — a fifth view over the loaded video.
  // The lesson is kept here while the quiz is open; `quizCacheReady` mirrors
  // "this video has a bilingual subtitle cache on disk", which is the only
  // condition the toolbar entry needs (the start endpoint re-checks it).
  const [quizOpen, setQuizOpen] = useState(false);
  const [quizLesson, setQuizLesson] = useState<LessonQuestions | null>(null);
  const [quizStarting, setQuizStarting] = useState(false);
  const [quizCacheReady, setQuizCacheReady] = useState(false);
  // Synchronous guard: a double click on the entry must not fire two
  // `startLesson` requests (a cache miss calls the model once per request).
  const quizStartBusyRef = useRef(false);
  // Where the player was when the quiz opened; leaving the quiz (not via an
  // evidence link) returns there instead of restarting the video at 0.
  const quizReturnTimeRef = useRef(0);
  // `currentTime` can keep advancing while `/api/lesson/start` is in flight;
  // a ref lets the handler read the latest value after the await.
  const currentTimeRef = useRef(0);

  // Dictation (blind listening) mode: English blurred until revealed per sentence
  const [dictationMode, setDictationMode] = useState(false);

  // Click-to-define dictionary popover
  const [wordLookup, setWordLookup] = useState<WordLookupTarget | null>(null);

  const handleWordLookup = useCallback((word: string, sentence: string, start: number, e: React.MouseEvent) => {
    setWordLookup({ word, context: sentence, start, x: e.clientX, y: e.clientY });
  }, []);

  // Reading lookups carry the article id so the star in the dictionary card
  // saves the word under that article instead of the (empty) current video.
  const handleReaderWordLookup = useCallback((
    word: string,
    sentence: string,
    start: number,
    e: React.MouseEvent,
    sourceId?: string,
  ) => {
    setWordLookup({ word, context: sentence, start, x: e.clientX, y: e.clientY, sourceId });
  }, []);

  // Hover-to-switch: the card stays mounted; only its target word/position
  // changes. Guard against a stale dwell timer firing after the card closed.
  // The lookup source (e.g. a reading article id) survives the switch.
  const handleSwitchWord = useCallback((target: WordLookupTarget) => {
    setWordLookup(prev => (prev ? { ...target, sourceId: prev.sourceId } : prev));
  }, []);

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

  const cancelTranslationStream = () => {
    streamAbortRef.current?.abort();
    streamAbortRef.current = null;
    setTranslationProgress(null);
  };

  const togglePipMode = async () => {
    if (pipWindow) {
      pipWindow.close();
      return;
    }

    if (!('documentPictureInPicture' in window)) {
      toast.error(t('errors.noPip'));
      return;
    }

    try {
      const dpip = (window as any).documentPictureInPicture;
      const newPipWindow = await dpip.requestWindow({
        width: 450,
        height: 800
      });

      // Copy styles
      [...document.styleSheets].forEach((styleSheet) => {
        try {
          if (styleSheet.href) {
            const newLinkEl = document.createElement('link');
            newLinkEl.rel = 'stylesheet';
            newLinkEl.href = styleSheet.href;
            newPipWindow.document.head.appendChild(newLinkEl);
          } else if (styleSheet.cssRules) {
            const newStyleEl = document.createElement('style');
            [...styleSheet.cssRules].forEach((cssRule) => {
              newStyleEl.appendChild(document.createTextNode(cssRule.cssText));
            });
            newPipWindow.document.head.appendChild(newStyleEl);
          }
        } catch (e) {
          console.warn('Cannot copy stylesheet rules due to CORS', e);
        }
      });

      newPipWindow.addEventListener('pagehide', () => {
        setPipWindow(null);
      });

      newPipWindow.document.body.className = "bg-zinc-950 overflow-hidden m-0 p-0 h-screen flex flex-col";
      setPipWindow(newPipWindow);
    } catch (err) {
      console.error(err);
      toast.error(t('errors.pipFailed'));
    }
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
  const [isFavoritesOpen, setIsFavoritesOpen] = useState(false);
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

  // Review stats power the home entry card and the top-bar badge. Guests are
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
    });
  }, [videoId, toggleFavorite]);

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
    });
  };

  const handleRemoveFavorite = (id: string) => {
    void removeFavoriteOptimistically(id);
  };

  // Add/remove a dictionary lookup to the vocabulary favorites
  const handleToggleDictFavorite = (def: WordDefinition) => {
    if (!wordLookup) return;
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
    });
  };

  const handlePlayFavorite = (favVideoId: string, start: number) => {
    if (favVideoId.length > 11) {
      // Local Subtitle: Extract showId, season, episode from string like "house-of-cards_S03E03"
      const match = favVideoId.match(/^(.+)_S(\d+)E(\d+)$/);
      if (match) {
        // The target clock (simulated timer vs. mapped YouTube player) is only
        // known once the episode payload is loaded, so hand it to the effect.
        pendingLocalSeekRef.current = start;
        handleSelectEpisode(match[1], parseInt(match[2]), parseInt(match[3]));
      }
    } else {
      if (favVideoId !== videoId) {
        // Seek as soon as the stream's meta event arrives (don't wait for full translation)
        pendingSeekRef.current = start;
        handleUrlSubmit(`https://youtube.com/watch?v=${favVideoId}`);
      } else {
        setSeekCommand({ time: start, timestamp: Date.now() });
      }
    }
    setIsFavoritesOpen(false);
  };

  // M1 ⑤：`resume` 只在断线续传时传入（jobId + 服务端游标），普通提交不带。
  const handleUrlSubmit = async (
    url: string,
    resume?: { jobId?: string; from?: number },
  ) => {
    setSentenceLevel(null); // leave sentence mode if a video is loaded
    pauseSubtitleTimer();
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

  // M1 ⑤ 断线续传：页面刷新/重新打开后，如果本标签页还留着未完成的任务，
  // 先问后端状态（GET /api/jobs/{id}），可续才带 jobId + from 重连；
  // 已完成/失败/不存在的任务直接丢弃，不重复生成。每个标签页只尝试一次。
  const resumeCheckedRef = useRef(false);
  useEffect(() => {
    if (!user || resumeCheckedRef.current) return;
    resumeCheckedRef.current = true;
    void (async () => {
      const pending = loadPendingJob();
      if (!pending) return;
      // 语言切换后旧任务的译文本就不是当前设置要的，直接丢弃。
      if (pending.targetLang !== getRuntimeTargetLang()) {
        clearPendingJob();
        return;
      }
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
        return; // 网络暂不可用：保留记录，下次刷新再试
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
        return; // 另一条流结束后刷新还能续
      }
      if (!snapshot.canResume) {
        // 产物没了 / 状态已不可续：丢掉记录，避免每次刷新都白问一次。
        clearPendingJob();
        return;
      }
      await handleUrlSubmit(pending.url, {
        jobId: pending.jobId,
        from: snapshot.cursor,
      });
    })();
    // 只在登录态首次就绪时尝试一次；handleUrlSubmit 是普通函数，无需重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const handleSelectEpisode = async (showId: string, season: number, episode: number) => {
    setSentenceLevel(null);
    pauseSubtitleTimer();
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
        setCurrentTime(0);
        setQuizCacheReady(true);
      }
    } catch (error) {
      console.error(error);
      pendingLocalSeekRef.current = null;
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  const handleLoadHistory = async (filename: string) => {
    setSentenceLevel(null);
    pauseSubtitleTimer();
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
      setCurrentTime(0);
      // Loaded straight out of history: the bilingual cache already exists.
      setQuizCacheReady(true);
    } catch (error) {
      console.error(error);
      toast.error(await describeApiError(error));
    } finally {
      setLoadingState(null);
    }
  };

  const handleTimeUpdate = useCallback((time: number) => {
    setCurrentTime(time);
    // The YouTube player and the simulated local clock both land here (via
    // their own source); watch events count only movement of this position.
    notePlayback(time);
  }, []);

  // ── Watch reporting (M5) ─────────────────────────────────────────────────
  // One segment per open content. Switching video/episode, leaving to the
  // report/quiz/review views, or unmounting ends the segment: the tracker
  // emits what was played and flushes the queue. Guests are already covered by
  // apiFetch's credentials, so no auth check is needed here.
  const hasTranscript = transcript.length > 0;
  useEffect(() => {
    if (!videoId || !hasTranscript || reportOpen || quizOpen || reviewOpen) return;
    startWatch({
      contentRef: videoId,
      kind: metadata?.is_local_subtitle ? 'local_show' : 'video',
    });
    return () => endWatch();
  }, [videoId, hasTranscript, metadata?.is_local_subtitle, reportOpen, quizOpen, reviewOpen]);

  // SRT-only local episodes have no player callback; the simulated clock's
  // `currentTime` is the playback position. Only feed it while playing so a
  // paused episode keeps its last emitted segment clean.
  useEffect(() => {
    if (!useSubtitleTimer || !isSubtitlePlaying) return;
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
  const seekTo = useCallback((time: number) => {
    if (useSubtitleTimer) {
      startSubtitleTimer(time);
    } else {
      setSeekCommand({ time, timestamp: Date.now() });
    }
  }, [useSubtitleTimer, startSubtitleTimer]);

  // Active sentence index — TranscriptView depends on this, not on raw
  // 100ms time ticks, so the 400+ sentence list re-renders only when the
  // spoken sentence actually changes.
  const activeTranscriptIndex = useMemo(
    () => findActiveIndex(transcript, currentTime),
    [transcript, currentTime]
  );

  const favoriteIds = useMemo(() => favorites.map(f => f.id), [favorites]);

  const featureName = useMemo(
    () => getFeatureName(quizOpen, readerOpen, blogOpen, discoverOpen, reviewOpen, sentenceLevel, videoId, transcript.length, Boolean(metadata?.is_local_subtitle)),
    [quizOpen, readerOpen, blogOpen, discoverOpen, reviewOpen, sentenceLevel, videoId, transcript.length, metadata?.is_local_subtitle],
  );

  const handleTranscriptClick = useCallback((time: number) => {
    // Re-pin the loop to the clicked sentence
    if (loopEnabled) {
      const block = transcript.find(b => b.start === time);
      if (block) loopBlockRef.current = { start: block.start, end: block.end };
    }
    seekTo(time);
  }, [loopEnabled, transcript, seekTo]);

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
      seekTo(loopBlockRef.current.start);
    }
  }, [currentTime, loopEnabled, seekTo]);

  // Keyboard shortcuts: Space play/pause, ←→ prev/next sentence, R replay, L loop
  useEffect(() => {
    // The quiz view owns the keyboard while it is open (1–4 / Enter / Esc).
    if (!videoId || transcript.length === 0 || quizOpen) return;
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
          if (prev) seekTo(prev.start);
          break;
        }
        case 'ArrowRight': {
          e.preventDefault();
          const idx = findActiveIndex(transcript, currentTime);
          const next = transcript[Math.min(transcript.length - 1, idx + 1)];
          if (next) seekTo(next.start);
          break;
        }
        case 'r': case 'R': {
          const idx = findActiveIndex(transcript, currentTime);
          if (idx >= 0) seekTo(transcript[idx].start);
          break;
        }
        case 'l': case 'L':
          toggleLoop();
          break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [videoId, transcript, currentTime, useSubtitleTimer, isSubtitlePlaying, seekTo, toggleLoop, pauseSubtitleTimer, startSubtitleTimer, quizOpen]);

  const handleGoHome = () => {
    cancelTranslationStream();
    pauseSubtitleTimer();
    setVideoId('');
    setTranscript([]);
    setSummary('');
    setMetadata(null);
    setCurrentTime(0);
    setSeekCommand(null);
    setSentenceLevel(null);
    setReviewOpen(false);
    setDiscoverOpen(false);
    setReaderOpen(false);
    setBlogOpen(false);
    setAdminOpen(false);
    setReportOpen(false);
    setPlacementOpen(false);
    setExamOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setQuizStarting(false);
    setQuizCacheReady(false);
    // Returning from review can change the due count; refetch on every go-home
    // (one cheap request) so the badge never shows a stale number.
    setReviewStatsNonce(prev => prev + 1);
  };

  // Content discovery (specs/017). It is a full view like review; the selected
  // candidate goes through the same estimate → processing pipeline as a pasted
  // link. `onClose` only leaves the view, so the screen's session-stored
  // results are still there on re-entry.
  const handleOpenDiscover = () => {
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    setReportOpen(false);
    setPlacementOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setDiscoverOpen(true);
  };

  const handleCloseDiscover = () => {
    setDiscoverOpen(false);
  };

  // Reading (specs/019). Like discovery it is a full view over the home screen;
  // the reader screen keeps its own list/reader state so closing and reopening
  // always lands on the list, where progress is visible.
  const handleOpenReader = () => {
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    setReportOpen(false);
    setPlacementOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setDiscoverOpen(false);
    setReaderOpen(true);
  };

  const handleCloseReader = () => {
    setReaderOpen(false);
  };

  // Official blog (specs/020). Public and read-only; opening it closes every
  // other full view so the tree stays single-purpose.
  const handleOpenBlog = () => {
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    setReportOpen(false);
    setPlacementOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setDiscoverOpen(false);
    setReaderOpen(false);
    setBlogOpen(true);
  };

  const handleCloseBlog = () => {
    setBlogOpen(false);
  };

  const handleOpenAdmin = () => {
    // The top bar is shared chrome; drop transient overlays so the dashboard
    // opens on a clean surface, but keep the current view behind it.
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setAdminOpen(true);
  };

  const handleCloseAdmin = () => {
    setAdminOpen(false);
  };

  const handleDiscoverStart = (url: string) => {
    // Leave the discovery view first; processing renders the learning view.
    setDiscoverOpen(false);
    void handleUrlSubmit(url);
  };

  // Ability placement (M4). Like review/report it is a full view; the home
  // workbench picks the landing (`intro` without a profile, `profile` with
  // one). Closing remounts the home screen, which refetches the profile.
  const handleOpenPlacement = (view: PlacementInitialView) => {
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    setReportOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    pauseSubtitleTimer();
    pauseWatch(currentTimeRef.current);
    setPlacementInitialView(view);
    setPlacementOpen(true);
  };

  const handleClosePlacement = () => {
    setPlacementOpen(false);
    // The workbench reads the profile on mount; a completion changes it and
    // the home branch remounts on the next render anyway.
    setReviewStatsNonce(prev => prev + 1);
  };

  // Exam practice (V2 / specs/022). Full view, account-only: guests are routed
  // to login from the home entry instead of mounting the screen. Closing
  // remounts the home screen (its history list is static, nothing to refresh).
  const handleOpenExam = () => {
    if (status !== 'authenticated') {
      onRequestLogin?.();
      return;
    }
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    setReportOpen(false);
    setPlacementOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setExamOpen(true);
  };

  const handleCloseExam = () => {
    setExamOpen(false);
    setReviewStatsNonce(prev => prev + 1);
  };

  // Result page "去学习": home is the learning entry, so close and drop the
  // cursor into the paste-a-link input once it has mounted.
  const handlePlacementStartLearning = () => {
    setPlacementOpen(false);
    setReviewStatsNonce(prev => prev + 1);
    window.setTimeout(() => {
      const input = document.getElementById('video-url') as HTMLInputElement | null;
      if (!input) return;
      const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      input.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
      input.focus({ preventScroll: true });
    }, 350);
  };

  // ── Weekly report view (M5) ──────────────────────────────────────────────
  // A report is a view like review: opening it pauses the current segment and
  // closing it returns to whatever was underneath (home or the same video).
  const handleOpenReport = () => {
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setReviewOpen(false);
    reportReturnTimeRef.current = videoId ? currentTimeRef.current : 0;
    if (isSubtitlePlaying) pauseSubtitleTimer();
    pauseWatch(currentTimeRef.current);
    setReportOpen(true);
  };

  const handleCloseReport = () => {
    setReportOpen(false);
    const resumeAt = reportReturnTimeRef.current;
    if (videoId && transcript.length > 0 && Number.isFinite(resumeAt) && resumeAt > 0) {
      if (useSubtitleTimer) setCurrentTime(resumeAt);
      else setSeekCommand({ time: resumeAt, timestamp: Date.now() });
    }
  };

  // Evidence "回看": open the referenced content and seek to the evidence
  // second. Existing opening paths are reused (favorites jump / history load /
  // local episode loader); the video id is first resolved through the history
  // index so no re-processing (and no model spend) is triggered when possible.
  const handleOpenEvidence = async (evidence: WeekReportEvidence) => {
    const start = Number.isFinite(evidence.start) ? Math.max(0, evidence.start) : 0;
    setReportOpen(false);
    setReviewOpen(false);
    setQuizOpen(false);
    setQuizLesson(null);
    setSentenceLevel(null);

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

  // Review is a full view, but only accounts can use it (specs/013: guests get
  // 403). The home card still renders for guests and routes them to login.
  const handleOpenReview = () => {
    if (status !== 'authenticated') {
      onRequestLogin?.();
      return;
    }
    setWordLookup(null);
    setIsFavoritesOpen(false);
    setSelectedChannel(null);
    setQuizOpen(false);
    setQuizLesson(null);
    setReportOpen(false);
    setReviewOpen(true);
  };

  // Comprehension quiz entry — only once the current video has a bilingual
  // subtitle cache. `startLesson` re-checks on the server (404 → friendly
  // toast), and fresh-generating videos stay disabled until their `done`.
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
  // `seekTo` also starts playback for the simulated local-episode clock; for
  // the YouTube branch the remounted player seeks on ready and auto-plays.
  const handleQuizEvidence = (start: number) => {
    setQuizOpen(false);
    setQuizLesson(null);
    if (Number.isFinite(start)) seekTo(Math.max(0, start));
  };

  const handleQuizHome = () => {
    handleGoHome();
  };

  // Translation target language changed. Cost protection (specs/012 §5.3):
  // abort the in-flight stream and leave the current video/episode rather than
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

    const wasLearning = Boolean(videoId) || transcript.length > 0 || sentenceLevel !== null || reviewOpen || quizOpen;
    if (wasLearning) {
      pauseSubtitleTimer();
      setVideoId('');
      setTranscript([]);
      setSummary('');
      setMetadata(null);
      setCurrentTime(0);
      setSeekCommand(null);
      setSentenceLevel(null);
      setReviewOpen(false);
      setReportOpen(false);
      setQuizOpen(false);
      setQuizLesson(null);
      setQuizStarting(false);
      setQuizCacheReady(false);
    }

    toast.info(t('language.targetChangedToast', {
      language: getLanguageMeta(targetLang).displayNames[language],
    }));
  }, [targetLang, language, t, videoId, transcript.length, sentenceLevel, reviewOpen, quizOpen, pauseSubtitleTimer]);

  // Star a sentence into the existing vocabulary book (exportable to Anki)
  const handleToggleSentenceFavorite = useCallback((s: Sentence, levelId: number) => {
    toggleFavorite({
      id: sentenceFavId(levelId, s.n),
      // >11 chars so the favorites modal never mistakes it for a YouTube id
      videoId: `sentence-pack-L${levelId}`,
      start: 0,
      en_text: segToPlain(s.seg),
      zh_text: s.zh,
      added_at: Date.now(),
      highlights: s.seg
        .filter((p): p is SegChunk => typeof p !== 'string')
        .map(p => ({ en_word: p.t, zh_word: p.g, color: CHUNK_STYLE[p.c].text })),
      type: 'sentence',
    });
  }, [toggleFavorite]);

  const renderTopBar = () => (
    <div data-testid="top-bar" className="flex-none h-16 bg-zinc-950/60 backdrop-blur-xl border-b border-white/5 px-4 sm:px-6 flex items-center justify-between gap-2 z-20">
      <div className="flex items-center gap-3 min-w-0">
        <div className="w-10 h-10 rounded-[10px] overflow-hidden shadow-md shadow-black/40 ring-1 ring-white/10 cursor-pointer flex-shrink-0" onClick={handleGoHome}>
            <img src="/hero_icon.png" alt={t('topbar.logoAlt')} className="w-full h-full object-cover" />
        </div>
        <div className="flex items-center gap-2 min-w-0">
          <h1
            className="text-lg sm:text-xl shrink-0 whitespace-nowrap font-semibold text-zinc-100 cursor-pointer tracking-tight hover:text-white transition-colors"
            onClick={handleGoHome}
          >
            {t('brand.name')}
          </h1>
          {featureName && !adminOpen && (
            <span
              data-testid="feature-name"
              className="hidden sm:inline-flex items-center whitespace-nowrap text-[11px] font-medium px-2 py-0.5 rounded-full bg-zinc-800/50 border border-white/5 text-zinc-400"
            >
              {t(featureName)}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-2 sm:gap-3 shrink-0">
        <LanguageMenu />
        {isAdmin && (
          <button
            type="button"
            data-testid="admin-entry"
            onClick={handleOpenAdmin}
            aria-pressed={adminOpen}
            aria-label={t('admin.entry')}
            title={t('admin.entry')}
            className="inline-flex items-center gap-2 h-9 px-2.5 sm:px-3 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-300 hover:text-blue-200 transition-colors shrink-0"
          >
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span className="hidden sm:inline text-sm font-medium whitespace-nowrap">{t('admin.entry')}</span>
          </button>
        )}
        {status === 'authenticated' && !adminOpen && !reviewOpen && !quizOpen && !placementOpen && !examOpen && !discoverOpen && !readerOpen && !blogOpen && (
          <button
            type="button"
            data-testid="topbar-review-button"
            onClick={handleOpenReview}
            aria-label={reviewStats && reviewStats.dueNow > 0
              ? t('review.topbarDue', { count: reviewStats.dueNow })
              : t('review.title')}
            title={reviewStats && reviewStats.dueNow > 0
              ? t('review.topbarDue', { count: reviewStats.dueNow })
              : t('review.title')}
            className="relative inline-flex items-center gap-2 h-9 px-2.5 sm:px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 hover:text-zinc-100 transition-[background-color,border-color,color] duration-200 ease-apple shrink-0"
          >
            <Repeat className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="hidden sm:inline text-sm font-medium whitespace-nowrap">{t('review.title')}</span>
            {reviewStats && reviewStats.dueNow > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-brand text-[10px] font-semibold text-white tabular-nums flex items-center justify-center">
                {reviewStats.dueNow > 99 ? '99+' : reviewStats.dueNow}
              </span>
            )}
          </button>
        )}
        {!adminOpen && !quizOpen && !reportOpen && !placementOpen && !examOpen && !discoverOpen && !readerOpen && !blogOpen && (
          <button
            type="button"
            data-testid="topbar-report-button"
            onClick={handleOpenReport}
            aria-label={t('report.title')}
            title={t('report.title')}
            className="inline-flex items-center gap-2 h-9 px-2.5 sm:px-3 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 hover:border-white/10 text-zinc-300 hover:text-zinc-100 transition-[background-color,border-color,color] duration-200 ease-apple shrink-0"
          >
            <CalendarRange className="w-4 h-4 text-blue-400 shrink-0" />
            <span className="hidden sm:inline text-sm font-medium whitespace-nowrap">{t('report.title')}</span>
          </button>
        )}
        <button
          onClick={() => setIsFavoritesOpen(true)}
          aria-label={t('topbar.favorites', { count: favorites.length })}
          title={t('topbar.favorites', { count: favorites.length })}
          className="inline-flex items-center gap-2 h-9 px-2.5 sm:px-4 rounded-xl bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-zinc-300 hover:text-zinc-100 transition-[background-color,color,border-color,transform] duration-200 ease-apple active:scale-[0.97]"
        >
          <Star className="w-4 h-4 text-amber-400 fill-amber-400/20" />
          <span className="hidden sm:inline font-medium text-sm tabular-nums">{t('topbar.favorites', { count: favorites.length })}</span>
        </button>
        {videoId && transcript.length > 0 && !quizOpen && (
          <button
            onClick={togglePipMode}
            aria-label={pipWindow ? t('topbar.closePopOut') : t('topbar.popOut')}
            title={pipWindow ? t('topbar.closePopOut') : t('topbar.popOut')}
            className="inline-flex items-center gap-2 h-9 px-2.5 sm:px-4 rounded-xl bg-blue-500/10 hover:bg-blue-500/15 border border-blue-500/20 text-blue-400 transition-[background-color,color,border-color,transform] duration-200 ease-apple active:scale-[0.97]"
          >
            <ExternalLink className="w-4 h-4" />
            <span className="hidden sm:inline font-medium text-sm">{pipWindow ? t('topbar.closePopOut') : t('topbar.popOut')}</span>
          </button>
        )}
        <div className="flex items-center gap-2 pl-2 sm:pl-3 border-l border-white/5 min-w-0">
          {status === 'guest' ? (
            <button
              data-testid="guest-login-button"
              onClick={onRequestLogin}
              title={t('topbar.guestLoginAria')}
              aria-label={t('topbar.guestLoginAria')}
              className="inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-lg bg-brand/10 hover:bg-brand/15 border border-brand/20 text-xs font-medium text-brand-300 hover:text-brand-400 transition-colors shrink-0"
            >
              <LogIn className="w-4 h-4" />
              <span className="hidden sm:inline">{t('topbar.guestLogin')}</span>
            </button>
          ) : (
            <>
              <span
                data-testid="topbar-user-email"
                title={user?.email || ''}
                className="hidden lg:inline-block max-w-[10rem] truncate text-xs text-zinc-500"
              >
                {user?.email}
              </span>
              <button
                data-testid="logout-button"
                onClick={() => { void logout(); }}
                title={t('topbar.logoutAria')}
                aria-label={t('topbar.logoutAria')}
                className="inline-flex items-center gap-1.5 h-8 px-2.5 sm:px-3 rounded-lg bg-zinc-800/60 hover:bg-zinc-700/60 border border-white/5 text-xs font-medium text-zinc-300 hover:text-zinc-100 transition-colors shrink-0"
              >
                <LogOut className="w-4 h-4" />
                <span className="hidden sm:inline">{t('topbar.logout')}</span>
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );

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
        for (const block of transcript) {
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

  const transcriptContent = (
    <>
      {/* Transcript toolbar: translation mode, loop, speed */}
      <div className="flex-none flex flex-wrap items-center gap-x-3 gap-y-1.5 px-4 py-2 bg-zinc-950/60 backdrop-blur-xl border-b border-white/5 z-20">
        <span className="text-xs text-zinc-500 font-medium shrink-0 whitespace-nowrap">{t('transcript.translationLabel')}</span>
        <div className="inline-flex items-center rounded-lg bg-zinc-800/80 p-0.5 border border-white/5">
          {([
            { key: 'all', label: t('transcript.mode.all') },
            { key: 'active', label: t('transcript.mode.active') },
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
            value={playbackRate}
            onChange={(e) => setPlaybackRate(parseFloat(e.target.value))}
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

        <div className="flex-1" />

        <span
          className="hidden lg:flex items-center gap-1 text-[11px] text-zinc-600 shrink-0 cursor-default"
          title={t('transcript.shortcutsTitle')}
        >
          <Keyboard className="w-3.5 h-3.5" /> {t('transcript.shortcutsHint')}
        </span>

        {/* Transcript placement toggle: tucked under the media ↔ docked right */}
        {!pipWindow && (
          <button
            type="button"
            data-testid="transcript-layout-toggle"
            onClick={() => setTranscriptLayout(prev => (prev === 'split' ? 'stacked' : 'split'))}
            aria-pressed={isTranscriptExpanded}
            title={isTranscriptExpanded
              ? t('transcript.layout.collapseTitle', { media: isLocalSubtitle ? t('transcript.media.local') : t('transcript.media.video') })
              : t('transcript.layout.expandTitle', { media: isLocalSubtitle ? t('transcript.media.local') : t('transcript.media.video') })}
            className="inline-flex items-center gap-1.5 h-7 px-2.5 text-xs font-medium rounded-lg border border-white/5 bg-zinc-800/80 text-zinc-400 hover:text-zinc-200 hover:bg-zinc-700/60 transition-colors shrink-0"
          >
            {isTranscriptExpanded
              ? <PanelRightClose className="w-3.5 h-3.5" />
              : <PanelRightOpen className="w-3.5 h-3.5" />}
            <span>{isTranscriptExpanded ? t('transcript.layout.collapse') : t('transcript.layout.expand')}</span>
          </button>
        )}
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
        <div className="absolute top-0 inset-x-0 h-8 bg-gradient-to-b from-[#09090b] to-transparent z-10 pointer-events-none"></div>
        <TranscriptView
          transcript={transcript}
          activeIndex={activeTranscriptIndex}
          videoId={videoId}
          favorites={favoriteIds}
          onTranscriptClick={handleTranscriptClick}
          onToggleFavorite={handleToggleFavorite}
          translationMode={translationMode}
          dictation={dictationMode}
          onWordLookup={handleWordLookup}
          borderLeft={isTranscriptExpanded}
          uiLanguage={language}
        />
        <div className="absolute bottom-0 inset-x-0 h-16 bg-gradient-to-t from-[#09090b] to-transparent z-10 pointer-events-none"></div>
      </div>
    </>
  );


  return (
    <div data-testid="app-shell" className="h-screen w-full flex flex-col bg-[#09090b] overflow-hidden text-zinc-100 selection:bg-purple-500/30">
      {renderTopBar()}

      {/* Keyed motion.divs crossfade views on mount; no exit-gating so a
          backgrounded tab (throttled rAF) can never stall the switch. */}
      {adminOpen ? (
        <motion.div
          key="admin"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <AdminScreen onClose={handleCloseAdmin} />
        </motion.div>
      ) : placementOpen ? (
        <motion.div
          key="placement"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <PlacementScreen
            initialView={placementInitialView}
            isGuest={status === 'guest'}
            onClose={handleClosePlacement}
            onStartLearning={handlePlacementStartLearning}
            onRequestLogin={onRequestLogin}
          />
        </motion.div>
      ) : examOpen ? (
        <motion.div
          key="exam"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <ExamScreen
            isGuest={status === 'guest'}
            onClose={handleCloseExam}
            onRequestLogin={onRequestLogin}
          />
        </motion.div>
      ) : quizOpen && quizLesson ? (
        <motion.div
          key="quiz"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <QuizScreen
            lesson={quizLesson}
            onExit={handleQuizExit}
            onSeekEvidence={handleQuizEvidence}
            onHome={handleQuizHome}
            onRequestLogin={onRequestLogin}
          />
        </motion.div>
      ) : reportOpen ? (
        <motion.div
          key="report"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <ReportScreen
            onClose={handleCloseReport}
            onOpenEvidence={(evidence) => { void handleOpenEvidence(evidence); }}
            onOpenReview={handleOpenReview}
          />
        </motion.div>
      ) : reviewOpen ? (
        <motion.div
          key="review"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <ReviewScreen onClose={handleGoHome} onRequestLogin={onRequestLogin} />
        </motion.div>
      ) : discoverOpen ? (
        <motion.div
          key={`discover:${targetLang}`}
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <DiscoverScreen
            onClose={handleCloseDiscover}
            onStart={handleDiscoverStart}
            onRequestLogin={onRequestLogin}
          />
        </motion.div>
      ) : readerOpen ? (
        <motion.div
          // Remount on a target-language switch: the list/detail are scoped by
          // targetLang, so a stale translation cache must never be shown.
          key={`reader:${targetLang}`}
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <ReaderScreen
            onClose={handleCloseReader}
            onRequestLogin={onRequestLogin}
            isGuest={status === 'guest'}
            onWordLookup={handleReaderWordLookup}
          />
        </motion.div>
      ) : blogOpen ? (
        <motion.div
          key="blog"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <BlogScreen onClose={handleCloseBlog} />
        </motion.div>
      ) : sentenceLevel != null ? (
        <motion.div
          key="sentences"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 min-h-0 flex flex-col overflow-hidden"
        >
          <SentenceView
            levelId={sentenceLevel}
            onSelectLevel={setSentenceLevel}
            onWordLookup={handleWordLookup}
            onToggleFavorite={handleToggleSentenceFavorite}
            favoriteIds={favoriteIds}
          />
        </motion.div>
      ) : !videoId || transcript.length === 0 ? (
        <motion.div
          key="home"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          className="flex-1 overflow-auto custom-scrollbar"
        >
          {/* Remount on a target-language switch: history, local-show marks
              and the per-language model default all become different lists. */}
          <InputScreen
            key={`${targetLang}:${dataRevision}`}
            onSubmit={handleUrlSubmit}
            onLoadHistory={handleLoadHistory}
            onSelectEpisode={handleSelectEpisode}
            onSelectSentenceLevel={setSentenceLevel}
            isLoading={loadingState !== null}
            loadingState={loadingState}
            subscriptions={subscriptions}
            onSelectChannel={setSelectedChannel}
            onUnsubscribe={(channelId) => setSubscriptions(prev => prev.filter(s => s.id !== channelId))}
            isGuest={status === 'guest'}
            installEntry={<PwaInstallButton wrapperClassName="max-w-5xl w-full flex justify-end mb-3 shrink-0 z-10" />}
            reviewStats={reviewStats}
            reviewStatsLoading={reviewStatsLoading}
            reviewStatsFailed={reviewStatsFailed}
            onOpenReview={handleOpenReview}
            onOpenReport={handleOpenReport}
            onOpenPlacement={handleOpenPlacement}
            onOpenExam={handleOpenExam}
            onOpenDiscover={handleOpenDiscover}
            onOpenReader={handleOpenReader}
            onOpenBlog={handleOpenBlog}
          />
        </motion.div>
      ) : (
        <motion.div
          key="learning"
          initial={{ opacity: 0, scale: 0.99, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          transition={{ duration: 0.3, ease: [0.25, 1, 0.5, 1] }}
          ref={fullscreenWrapperRef}
          className="flex-1 flex flex-col md:flex-row overflow-hidden max-md:overflow-y-auto relative bg-transparent group/wrapper">
          {/* One shell for both learning modes. Left column: media stage +
              whatever sits beneath it — the transcript by default, the
              summary/vocabulary when the transcript is expanded to the right. */}
          <div
            data-testid="video-column"
            style={{ '--left-w': `${leftRatio}%` } as React.CSSProperties}
            className={`w-full max-md:h-auto md:h-full ${
              pipWindow ? 'md:w-full' : 'md:w-[var(--left-w)]'
            } flex flex-col min-w-0 shrink-0`}
          >
            {mediaStage}
            {!isLocalSubtitle && channelBar}

            {pipWindow || isTranscriptExpanded ? (
              <div
                data-testid="summary-panel"
                className="p-6 bg-zinc-900/60 backdrop-blur-xl border-t border-white/5 md:flex-1 md:min-h-0 md:overflow-y-auto custom-scrollbar"
              >
                {summaryBody}
              </div>
            ) : (
              <div
                data-testid="transcript-column"
                className="max-md:h-[52vh] md:flex-1 md:min-h-0 flex flex-col relative border-t border-white/5 bg-transparent"
              >
                {transcriptContent}
              </div>
            )}
          </div>

          {pipWindow ? (
            createPortal(
              <div className="w-full h-full flex flex-col relative bg-[#09090b]">
                {transcriptContent}
              </div>,
              pipWindow.document.body
            )
          ) : (
            <>
              {/* Draggable split: desktop only. Drag changes the left
                  column percentage within [MIN, MAX]; double-click or
                  Home/End restore/reset it. */}
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

              {/* Right column: summary sidebar by default, transcript when
                  the transcript is expanded. */}
              <div
                data-testid="right-column"
                className="w-full md:flex-1 min-w-0 max-md:shrink-0 md:h-full flex flex-col relative border-t md:border-t-0 border-white/5 bg-transparent"
              >
                {isTranscriptExpanded ? (
                  <div
                    data-testid="transcript-column"
                    className="h-[52vh] md:h-full md:flex-1 min-h-0 flex flex-col relative bg-transparent"
                  >
                    {transcriptContent}
                  </div>
                ) : (
                  <div
                    data-testid="summary-panel"
                    className="p-6 bg-zinc-900/60 backdrop-blur-xl overflow-y-auto custom-scrollbar md:h-full md:min-h-0"
                  >
                    {summaryBody}
                  </div>
                )}
              </div>
            </>
          )}

          {/* Drag shield: covers the video iframe (which would otherwise
              swallow pointermove) and suppresses text selection while dragging. */}
          {isResizing && createPortal(
            <div
              data-testid="resize-shield"
              className="fixed inset-0 z-[60] cursor-col-resize select-none"
              onPointerMove={handleResizeMove}
              onContextMenu={(e) => e.preventDefault()}
            />,
            document.body
          )}
        </motion.div>
      )}

      <FavoritesModal
        isOpen={isFavoritesOpen}
        onClose={() => setIsFavoritesOpen(false)}
        favorites={favorites}
        onRemoveFavorite={handleRemoveFavorite}
        onPlayFavorite={handlePlayFavorite}
      />

      <ChannelVideoList
        isOpen={!!selectedChannel}
        onClose={() => setSelectedChannel(null)}
        channelName={selectedChannel}
        onLoadHistory={handleLoadHistory}
        onReprocess={(videoId) => handleUrlSubmit(`https://www.youtube.com/watch?v=${videoId}`)}
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

// The only switch between the auth screen and the existing app. Session state
// lives in AuthProvider, so login/signup/logout and global 401s all land here.
//
// M1 ⑧: `guest` is the normal pre-signup state — the app stays usable and the
// top bar offers "游客 · 登录保存". Clicking it overlays the auth screen instead
// of replacing the app, so a guest who changes their mind keeps their video.
function AuthGate() {
  const { status } = useAuth();
  const [showAuth, setShowAuth] = useState(false);

  if (status === 'loading') return <AuthLoadingScreen />;
  if (status === 'anonymous') return <AuthScreen />;
  if (status === 'guest') {
    return (
      <>
        <AppContent onRequestLogin={() => setShowAuth(true)} />
        {showAuth && (
          <div
            data-testid="guest-auth-overlay"
            className="fixed inset-0 z-50 overflow-auto bg-[#09090b]"
          >
            <AuthScreen onGuestContinue={() => setShowAuth(false)} />
          </div>
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
        <AuthGate />
        {/* The offline marker sits above the auth gate so it survives every
            screen, not only the signed-in shell. The install entry itself is
            inline on home/auth (see InputScreen/AuthScreen) to avoid covering
            page content on a 375px phone. */}
        <OfflineIndicator />
        {/* One Toaster for every branch: it survives the auth gate switch, so
            "session expired" and backend-unreachable toasts are not dropped. */}
        <Toaster />
      </AuthProvider>
    </I18nProvider>
  );
}

export default App;
