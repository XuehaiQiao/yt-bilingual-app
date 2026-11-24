// Acceptance check for specs/044 (观影模式 minimum, video page only).
//
// Runs the real React learning view against a fully mocked backend and a
// mocked YouTube IFrame API, so playback time is deterministic: the stub
// player advances `getCurrentTime()` in real time, and `seekTo()` lands
// exactly on the requested sentence.
//
// Covered:
//   1. toggle persists to `yt_bilingual_watch_mode`; the transcript placement
//      and split ratio keys are untouched by the toggle;
//   2. watch ON: teaching panel / summary / transcript toolbar are NOT
//      mounted, the media owns the page and the ≥1280 gloss rail is 320–360;
//   3. the single-sentence overlay follows the active sentence (playback and
//      seek), shows Chinese above English, clears the player controls and
//      never intercepts a click (`pointer-events: none`);
//   4. the rolling gloss window (P2-12: 滚动词条) shows the same words /
//      language points the analysis gives the transcript as one continuous
//      borderless list — no sentence context, no section headings, no kind
//      badge, no per-sentence/global empty placeholder — and a no-analysis
//      state that reuses the existing 028 GET (no new AI: every
//      teaching-analysis request in the run is a GET, no process/translate
//      calls are made);
//   4b. P2-09 typography: English is the primary line above the Chinese
//       support line; 1440 and 375 stay inside the media stage without
//       horizontal clipping;
//   4c. P2-09 history: the gloss window keeps earlier sentences under the
//       current one (5 sentences driven by seek), a revisited block moves to
//       the top instead of duplicating, an empty sentence adds no entry and
//       keeps the backlog, and the window auto-scrolls to the top until the
//       learner scrolls down by hand; P2-12: long words / glosses wrap at 375;
//   4d. P2-11 fluid type: `video-area` is a container-query source and the
//       subtitle lines use `clamp(…cqi…)`, so 375 sits at the 17/15 floors,
//       1440 watch is larger than the 1440 normal layout, 1920 is larger than
//       1440, and a stubbed fullscreen window that grows keeps scaling; English
//       stays above Chinese at every tier and long sentences never clip;
//   5. watch OFF restores the previous stacked/split layout + teaching panel;
//   6. reduced-motion: the overlay/rail carry no animation or transition;
//   7. 1440, 1920 and 375 screenshots, no horizontal overflow at 375.
//   8. P2-10 page fullscreen: the retired player fullscreen button is gone; the
//      watch toggle calls `requestFullscreen()` on the learning shell inside the
//      click gesture, leaving watch mode calls `exitFullscreen()`, a
//      rejected/missing Fullscreen API degrades to the layout silently, and a
//      route change cleans up the page fullscreen (all via a page-side stub).
//      P2-17 changed the ESC contract: a real exit from OUR page fullscreen
//      leaves 观影模式 too, while the initial sync, a route change and a
//      fullscreen we never owned must not flip the mode.
//   9. P2-13 gloss source: a history payload that already carries
//      `analysis.v5` + block highlights + idioms (its teaching-analysis
//      endpoint 404s) still paints transcript ruby (`data-gloss`) and the
//      rolling gloss words; when the endpoint is authoritative, a block it
//      leaves empty keeps neither ruby nor a word entry (the old payload gloss
//      must not come back).
//  10. P2-15 immersive shell: AppShell's top bar and the LearningHeader are NOT
//      rendered; the floating `watch-topbar` (back / title+source / 观影模式
//      chip / CC / 退出观影) is the only chrome, has no fake settings button,
//      fades out after 2.5s of stillness and returns on pointer / touch /
//      keyboard activity. Leaving the mode restores both chromes.
//  11. P2-15 stage: the 16:9 picture is centred in the remaining viewport on a
//      size-container stage, an ambient (blurred/gradient) layer fills the
//      letterbox instead of dead black, and 1440 / 1920 / 375 never overflow.
//  12. P2-15 subtitles: `watchSubtitleMode` = bilingual | english | off, stored
//      under `yt_bilingual_watch_subtitle_mode`, switchable from the CC menu
//      (click and keyboard) and by `C`; `off` does not render the overlay, the
//      player is never remounted and the playhead is preserved; the gloss panel
//      keeps working while the overlay is off. The native-caption coexistence
//      copy is visible and nothing reads/controls the iframe's own CC state.
//  13. P2-15 native controls: YouTube keeps its own control bar and native CC
//      entry — no custom transport/progress bar is added. P2-17: the raised
//      subtitle clears the bottom strip those controls live in; the docked
//      position is only used once both have gone quiet.
//  14. P2-10 / P2-11 / P2-12 / P2-13 keep their previous coverage (the P2-10
//      ESC assertion was revised by P2-17 above; the watch toggle → top-bar
//      exit selector moved in P2-15).
//  15. P2-16 desktop rail: exactly 360px, 「滚动词条」+ 本句词数, current
//      sentence target pinned on top inside three rows with a 2px marker,
//      fading history, no headings / context / placeholder, and a hover/focus
//      favorite star that writes one vocabulary draft
//      (`vocab-<video>-<word>`, type/source_kind=video, start=blockStart,
//      context_en=current sentence) and syncs the App top-bar count.
//  16. P2-16 mobile: the 16:9 picture is pinned to the top (8px margins), the
//      gloss window is a bottom drawer that owns the remaining height, is
//      expanded by default, collapses/expands from its handle, never covers
//      the picture/native controls, and 375 has no overflow; subtitle modes,
//      CC and exit keep working. The old floating pill is gone.
//  17. P2-16 favorites: failed add/remove roll back inline (stars restored),
//      and a guest gets an inline login/analysis state instead of invented
//      words or a rejected write.
//  18. P2-17 subtitle dock: pointer / touch / key activity raises the English
//      line above the native control strip (~15% bottom); 2.5s of stillness
//      docks it at the lower video edge (~0.5% bottom) through a 200ms bottom
//      transition (instant under reduced motion); pointer movement restores
//      the raised position.
//  19. P2-17 gloss rows: vocabulary and language points share one row — label
//      left, right-aligned definition on the SAME line, wrapping — and the
//      type is fluid (~16→22 / 14→18px) across 375 / 1440 / 1920 with a
//      slightly larger 「滚动词条」 title.
//  20. P2-17 subtitle highlight: the current sentence's glossed words get an
//      amber span, idioms / culture points a sky span, ranges never overlap
//      (points win), the full sentence text is preserved, the highlight follows
//      the sentence, and the `off` mode renders none of it.
//  21. P2-19 「我已掌握」: every word/point row carries a circle+check beside
//      the star in the same action group (rail hover/focus, drawer always on,
//      44px on touch). Signed-in: true → PATCH `/api/review/words`
//      {lemma, mastered, targetLang, definition=gloss}, then the mastered list
//      is re-read (aria-pressed + filled green from the shared store); false →
//      PATCH mastered=false, the favorite is NOT restored (ADR-0001). Mutual
//      exclusion: a successful mark deletes the same word's favorite; a failed
//      DELETE rolls the mark back (PATCH false) with an inline error. A failed
//      PATCH rolls the visual mark back inline. Guests write only
//      `yt_bilingual_guest_mastered_words` (never the API). History rows and
//      the page share one `useIgnoredWords` source; 375/1440 stay un-squeezed.
//
// Run (needs `npm run dev` on :5173; Playwright lives in scripts/node_modules):
//   node scripts/watch-mode-acceptance.mjs
//   APP_URL=http://127.0.0.1:5174 node scripts/watch-mode-acceptance.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const ORIGIN = BASE.replace(/\/$/, '');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOTS = '/tmp';

fs.mkdirSync(SHOTS, { recursive: true });

const shot = (name) => `${SHOTS}/watch-mode-${name}@${HEAD}.png`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// P2-11: the fluid subtitle type scale lives inline in WatchSubtitleOverlay
// (the `text-section` / `text-body-zh` classes stay as the no-cqi fallback).
// 1cqi = 1% of the `video-area` container width, so the same declaration
// resolves differently in the normal and watch layouts.
const FLUID_EN = 'clamp(1.0625rem, 2cqi, 2rem)';
const FLUID_ZH = 'clamp(0.9375rem, 1.7cqi, 1.625rem)';

// ── fixtures ───────────────────────────────────────────────────────────────
const VIDEO_ID = 'acceptance-watch';
const EMPTY_VIDEO_ID = 'acceptance-watch-empty';
const HISTORY_VIDEO_ID = 'acceptance-watch-history';
const HISTORY_FILE = `${VIDEO_ID}_zh-CN.json`;
const HISTORY_VIDEO_FILE = `${HISTORY_VIDEO_ID}_zh-CN.json`;
const EMPTY_HISTORY_FILE = `${EMPTY_VIDEO_ID}_zh-CN.json`;
// P2-13: payload-merged analysis (no endpoint row) and endpoint-authoritative.
const PAYLOAD_VIDEO_ID = 'acceptance-watch-payload';
const PAYLOAD_HISTORY_FILE = `${PAYLOAD_VIDEO_ID}_zh-CN.json`;
const AUTHORITATIVE_VIDEO_ID = 'acceptance-watch-authoritative';
const AUTHORITATIVE_HISTORY_FILE = `${AUTHORITATIVE_VIDEO_ID}_zh-CN.json`;

// First cue starts at 8s so "no current sentence → overlay hidden" is
// observable before the first seek.
const BLOCKS = [
    {
        id: 0,
        start: 8,
        end: 12,
        en_text: 'Small habits quietly shape the way a whole day feels.',
        zh_text: '小习惯悄悄塑造一整天的感受。',
        highlights: [],
    },
    {
        id: 1,
        start: 12,
        end: 16,
        en_text: 'A short walk before breakfast makes the whole day feel slower.',
        zh_text: '早餐前散一小段步，会让一整天都慢下来。',
        highlights: [],
    },
    {
        id: 2,
        start: 16,
        end: 20,
        en_text: 'Nobody moves after that.',
        zh_text: '之后没有人再动。',
        highlights: [],
    },
];

const EMPTY_BLOCKS = [
    {
        id: 0,
        start: 0,
        end: 4,
        en_text: 'This clip has no teaching analysis yet.',
        zh_text: '这段视频还没有教学分析。',
        highlights: [],
    },
];

// P2-09: a longer run of sentences so the gloss window has to scroll. The
// first three cues reuse the fixtures above; the last three add new sentences
// that arrive after the learner has manually scrolled the history.
const HISTORY_BLOCKS = [
    ...BLOCKS,
    {
        id: 3,
        start: 20,
        end: 24,
        en_text: 'The room stays still for a while.',
        zh_text: '房间安静了一会儿。',
        highlights: [],
    },
    {
        id: 4,
        start: 24,
        end: 28,
        en_text: 'Then the kettle starts to sing.',
        zh_text: '然后水壶开始鸣叫。',
        highlights: [],
    },
    {
        id: 5,
        start: 28,
        end: 32,
        // P2-12: a deliberately long word for the wrap/no-overflow check.
        en_text: 'Steam curls uncharacteristically up toward the window.',
        zh_text: '蒸汽一反常态地朝窗户升起。',
        highlights: [],
    },
];

const METADATA = {
    title: 'Watch Mode Acceptance',
    channel: 'LinguaTrek Test',
    channel_url: 'https://www.youtube.com/@linguatrek-test',
    duration: 24,
};

// P2-13: a history payload that already carries the merged analysis.v5, i.e.
// the backend wrote per-block highlights + idioms into the transcript payload.
// Its teaching-analysis endpoint is deliberately 404, so every gloss on screen
// can only come from the payload.
const PAYLOAD_BLOCKS = BLOCKS.map((block, index) => ({
    ...block,
    highlights: index === 0
        ? [{ en_word: 'habits', zh_word: '习惯', color: '' }]
        : [],
}));
const PAYLOAD_IDIOMS = [
    { blockId: 1, phrase: 'before breakfast', meaning: '早餐前', quote: 'A short walk before breakfast…' },
];

// P2-13: a legacy payload with merged block highlights while the endpoint is
// still authoritative. The endpoint below leaves block 0 empty on purpose.
const AUTHORITATIVE_BLOCKS = [
    { ...BLOCKS[0], highlights: [{ en_word: 'habits', zh_word: '习惯', color: '' }] },
    { ...BLOCKS[1], highlights: [{ en_word: 'walk', zh_word: '散步', color: '' }] },
    { ...BLOCKS[2], highlights: [] },
];

const ANALYSIS = {
    contentRef: VIDEO_ID,
    level: 'B1',
    targetLang: 'zh-CN',
    contentHash: 'hash-watch-acceptance',
    analysisVersion: 'v5',
    model: 'acceptance-model',
    createdAt: 1763000000000,
    highlights: {
        0: [{ en_word: 'habits', zh_word: '习惯', color: '' }],
        1: [{ en_word: 'breakfast', zh_word: '早餐', color: '' }],
    },
    idioms: [
        { blockId: 1, phrase: 'before breakfast', meaning: '早餐前', quote: 'A short walk before breakfast…' },
    ],
    culture: [],
};

const HISTORY_ANALYSIS = {
    ...ANALYSIS,
    contentRef: HISTORY_VIDEO_ID,
    contentHash: 'hash-watch-history',
    highlights: {
        0: [
            { en_word: 'habits', zh_word: '习惯', color: '' },
            { en_word: 'quietly', zh_word: '悄悄地', color: '' },
            // P2-12: enough rows for the 375 window to overflow (scroll contract).
            { en_word: 'shape', zh_word: '塑造', color: '' },
            { en_word: 'whole', zh_word: '整个', color: '' },
        ],
        1: [
            { en_word: 'breakfast', zh_word: '早餐', color: '' },
            { en_word: 'walk', zh_word: '散步', color: '' },
            { en_word: 'makes', zh_word: '使', color: '' },
            { en_word: 'slower', zh_word: '更慢', color: '' },
        ],
        3: [
            { en_word: 'stays', zh_word: '保持', color: '' },
            { en_word: 'still', zh_word: '静止', color: '' },
            { en_word: 'room', zh_word: '房间', color: '' },
            { en_word: 'while', zh_word: '一会儿', color: '' },
        ],
        4: [
            { en_word: 'kettle', zh_word: '水壶', color: '' },
            { en_word: 'sing', zh_word: '鸣叫', color: '' },
            { en_word: 'starts', zh_word: '开始', color: '' },
        ],
        5: [
            { en_word: 'steam', zh_word: '蒸汽', color: '' },
            { en_word: 'curls', zh_word: '卷曲', color: '' },
            // P2-12: long word + long meaning must wrap inside the 375 panel.
            {
                en_word: 'uncharacteristically',
                zh_word: '一反常态地、出人意料地、和平时完全不一样地（长释义换行验收）',
                color: '',
            },
        ],
    },
};

const AUTHORITATIVE_ANALYSIS = {
    ...ANALYSIS,
    contentRef: AUTHORITATIVE_VIDEO_ID,
    contentHash: 'hash-watch-authoritative',
    // The endpoint owns block 0 and leaves it empty: the payload's old gloss
    // for "habits" must not survive. Block 1 replaces the payload's "walk".
    highlights: {
        1: [{ en_word: 'breakfast', zh_word: '早餐', color: '' }],
    },
    idioms: [],
};

// P2-19: a free-library video carries its analysis inside the payload and is
// public, so a guest can see real gloss rows (guests get no AI call otherwise).
// This is the only surface that exercises the guest-only local mastered table.
const LIBRARY_VIDEO_ID = 'acceptance-watch-library';
const LIBRARY_ANALYSIS = {
    ...ANALYSIS,
    contentRef: LIBRARY_VIDEO_ID,
    contentHash: 'hash-watch-library',
    highlights: {
        0: [{ en_word: 'habits', zh_word: '习惯', color: '' }],
        1: [{ en_word: 'breakfast', zh_word: '早餐', color: '' }],
    },
    idioms: [
        { blockId: 1, phrase: 'before breakfast', meaning: '早餐前', quote: 'A short walk before breakfast…' },
    ],
    culture: [],
};
const LIBRARY_PAYLOAD = {
    id: LIBRARY_VIDEO_ID,
    title: 'Library Watch Acceptance',
    channel: 'LinguaTrek Test',
    duration: 24,
    level: 'B1',
    youtubeId: 'acceptance-watch-library-video',
    free: true,
    source: 'youtube',
    // The rolling gloss reads the transcript's per-block highlights directly
    // for library videos (unlike article paragraphs).
    blocks: BLOCKS.map((block, index) => ({
        ...block,
        highlights: index === 0
            ? [{ en_word: 'habits', zh_word: '习惯', color: '' }]
            : index === 1
                ? [{ en_word: 'breakfast', zh_word: '早餐', color: '' }]
                : [],
    })),
    // The backend merges the analysis into the payload (specs/028): idioms /
    // culture live at the top level, block highlights sit on the blocks — not
    // under a nested `analysis` field.
    videoId: LIBRARY_VIDEO_ID,
    targetLang: 'zh-CN',
    analysisVersion: 'v5',
    idioms: LIBRARY_ANALYSIS.idioms,
    culture: [],
};

const HISTORY_ITEMS = [
    { videoId: VIDEO_ID, filename: HISTORY_FILE, title: METADATA.title, channel: METADATA.channel },
    { videoId: HISTORY_VIDEO_ID, filename: HISTORY_VIDEO_FILE, title: 'History Clip', channel: METADATA.channel },
    { videoId: EMPTY_VIDEO_ID, filename: EMPTY_HISTORY_FILE, title: 'No Analysis Clip', channel: METADATA.channel },
    { videoId: PAYLOAD_VIDEO_ID, filename: PAYLOAD_HISTORY_FILE, title: 'Payload Analysis Clip', channel: METADATA.channel },
    {
        videoId: AUTHORITATIVE_VIDEO_ID,
        filename: AUTHORITATIVE_HISTORY_FILE,
        title: 'Endpoint Authoritative Clip',
        channel: METADATA.channel,
    },
];

const videoPayload = (videoId, blocks, title) => ({
    videoId,
    metadata: {
        ...METADATA,
        title: title ?? (videoId === VIDEO_ID ? METADATA.title : 'No Analysis Clip'),
        duration: blocks[blocks.length - 1]?.end ?? METADATA.duration,
    },
    summary: '',
    transcript: blocks,
});

// P2-13: the merged-analysis payload shape the backend writes for
// `analysis.v5` (block highlights inside the transcript + top-level idioms).
const PAYLOAD_ANALYSIS_PAYLOAD = {
    ...videoPayload(PAYLOAD_VIDEO_ID, PAYLOAD_BLOCKS, 'Payload Analysis Clip'),
    analysisVersion: 'analysis.v5',
    idioms: PAYLOAD_IDIOMS,
    culture: [],
};
// A legacy merged payload without top-level analysis points: the endpoint is
// still requested and stays authoritative.
const AUTHORITATIVE_PAYLOAD = {
    ...videoPayload(AUTHORITATIVE_VIDEO_ID, AUTHORITATIVE_BLOCKS, 'Endpoint Authoritative Clip'),
    analysisVersion: 'analysis.v5',
};

const cors = {
    'access-control-allow-origin': ORIGIN,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

// Minimal YouTube IFrame API replacement: a container-sized poster plus a
// player whose clock actually advances while "playing". No network, no iframe.
const YT_STUB = `(() => {
  const now = () => Date.now();
  function Player(element, options) {
    const events = (options && options.events) || {};
    const self = this;
    this._state = -1;
    this._time = 0;
    this._playingSince = now();
    this._rate = 1;
    if (element) {
      element.innerHTML = '<div style="width:100%;height:100%;background:linear-gradient(135deg,#18181b 0%,#27272a 55%,#09090b 100%);display:flex;align-items:center;justify-content:center;color:#52525b;font:500 14px -apple-system,BlinkMacSystemFont,sans-serif;letter-spacing:.04em">YouTube player · acceptance stub</div>';
    }
    this._sync = () => {
      if (self._state === 1) {
        const nowMs = now();
        self._time += (nowMs - self._playingSince) / 1000 * self._rate;
        self._playingSince = nowMs;
      }
    };
    this._setState = (state) => {
      if (self._state === state) return;
      self._state = state;
      if (events.onStateChange) events.onStateChange({ target: self, data: state });
    };
    this.getPlayerState = () => self._state;
    this.getCurrentTime = () => { self._sync(); return self._time; };
    this.getDuration = () => 24;
    this.getPlaybackRate = () => self._rate;
    this.setPlaybackRate = (rate) => { self._sync(); self._rate = Number(rate) || 1; };
    this.seekTo = (seconds) => { self._time = Number(seconds) || 0; self._playingSince = now(); self._setState(1); };
    this.playVideo = () => { self._playingSince = now(); self._setState(1); };
    this.pauseVideo = () => { self._sync(); self._setState(2); };
    this.stopVideo = () => { self._time = 0; self._setState(0); };
    this.loadVideoById = (arg) => { if (arg && typeof arg === 'object' && typeof arg.startSeconds === 'number') self._time = arg.startSeconds; self.playVideo(); };
    this.cueVideoById = () => {};
    this.getIframe = () => Promise.resolve(element || null);
    this.addEventListener = () => {};
    this.removeEventListener = () => {};
    this.destroy = () => { self._state = -1; };
    setTimeout(() => {
      if (events.onReady) events.onReady({ target: self });
    }, 0);
  }
  window.YT = {
    Player,
    PlayerState: { UNSTARTED: -1, ENDED: 0, PLAYING: 1, PAUSED: 2, BUFFERING: 3, CUED: 5 },
  };
  if (typeof window.onYouTubeIframeAPIReady === 'function') window.onYouTubeIframeAPIReady();
})();`;

/** One context with every /api/** route mocked and the IFrame stub installed. */
async function createContext(browser, {
    width = 1440,
    height = 900,
    reducedMotion = 'no-preference',
    hasTouch = false,
    watchOn = false,
    // P2-16: favorites acceptance knobs.
    guest = false,
    favoritesSeed = [],
    favoritePostStatus = 200,
    favoriteDeleteStatus = 200,
    // P2-19: mastered acceptance knobs. `seededMastered` = master list the
    // server already holds; `masteredPatchStatus` drives the rollback run.
    seededMastered = [],
    masteredPatchStatus = 200,
    masteredPatchDelayMs = 0,
} = {}) {
    const context = await browser.newContext({
        viewport: { width, height },
        reducedMotion,
        hasTouch,
    });
    await context.addInitScript(({ watchOn }) => {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_vocab_level', 'B1');
        localStorage.setItem('yt_bilingual_transcript_layout', 'split');
        localStorage.setItem('yt_bilingual_split_ratio', '60');
        // Seed only when absent: addInitScript runs on every navigation, so a
        // reload must keep the mode the previous page persisted.
        if (localStorage.getItem('yt_bilingual_watch_mode') === null) {
            localStorage.setItem('yt_bilingual_watch_mode', watchOn ? 'on' : 'off');
        }
    }, { watchOn });

    await context.route('**/iframe_api*', (route) => route.fulfill({
        status: 200,
        contentType: 'application/javascript',
        headers: { 'access-control-allow-origin': '*' },
        body: YT_STUB,
    }));

    // P2-16: the per-item favorites store survives reloads inside one context,
    // so "add → reload → star still filled" is a real persistence check.
    const favoriteStore = favoritesSeed.map((item) => ({ ...item }));
    // P2-19: the mastered list is server state: PATCH updates it, the GET the
    // ignored-words store reads returns it, so a reload keeps the mark.
    const masteredStore = new Set(
        seededMastered.map((word) => String(word).trim().toLowerCase()).filter(Boolean),
    );
    const masteredWord = (lemma) => ({
        id: `word-${lemma}`,
        lemma,
        targetLang: 'zh-CN',
        state: 'review',
        dueAt: 0,
        stability: null,
        difficulty: null,
        reps: 0,
        lapses: 0,
        failStreak: 0,
        lastReviewedAt: null,
        createdAt: 1763000000000,
        sources: [],
        mastered: true,
    });

    await context.route('**/api/**', async (route) => {
        const request = route.request();
        if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const pathname = new URL(request.url()).pathname;
        const respond = (data, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: cors,
            body: JSON.stringify(data),
        });

        if (pathname === '/api/auth/me') {
            if (guest) return respond({ user: null, isAdmin: false, guest: true });
            return respond({ user: { id: 'u-watch', email: 'watch@example.com' }, isAdmin: false, guest: false });
        }
        if (pathname === '/api/auth/registration') {
            return respond({ registrationOpen: false, inviteSignupEnabled: true, inviteRequired: true, registrationClosed: false });
        }
        if (pathname === '/api/history') return respond(HISTORY_ITEMS);
        if (pathname === `/api/history/${HISTORY_FILE}`) return respond(videoPayload(VIDEO_ID, BLOCKS));
        if (pathname === `/api/history/${HISTORY_VIDEO_FILE}`) return respond(videoPayload(HISTORY_VIDEO_ID, HISTORY_BLOCKS, 'History Clip'));
        if (pathname === `/api/history/${EMPTY_HISTORY_FILE}`) return respond(videoPayload(EMPTY_VIDEO_ID, EMPTY_BLOCKS));
        // P2-19: public library video payload (analysis included) for the
        // guest-only mastered path — guest players have no teaching endpoint.
        if (pathname === `/api/library/videos/${LIBRARY_VIDEO_ID}`) return respond(LIBRARY_PAYLOAD);
        // P2-13 fixtures: the first payload owns its analysis, the second one is
        // overridden by the endpoint below.
        if (pathname === `/api/history/${PAYLOAD_HISTORY_FILE}`) return respond(PAYLOAD_ANALYSIS_PAYLOAD);
        if (pathname === `/api/history/${AUTHORITATIVE_HISTORY_FILE}`) return respond(AUTHORITATIVE_PAYLOAD);
        if (pathname === `/api/teaching-analysis/${VIDEO_ID}`) return respond(ANALYSIS);
        if (pathname === `/api/teaching-analysis/${HISTORY_VIDEO_ID}`) return respond(HISTORY_ANALYSIS);
        if (pathname === `/api/teaching-analysis/${EMPTY_VIDEO_ID}`) {
            return respond({ detail: 'NOT_FOUND' }, 404);
        }
        if (pathname === `/api/teaching-analysis/${PAYLOAD_VIDEO_ID}`) {
            // P2-13: payload-only analysis — the endpoint must not be needed.
            return respond({ detail: 'NOT_FOUND' }, 404);
        }
        if (pathname === `/api/teaching-analysis/${AUTHORITATIVE_VIDEO_ID}`) return respond(AUTHORITATIVE_ANALYSIS);
        // P2-13: ruby needs the difficulty layer; mark the two fixture words
        // above B1 (the seeded vocab level) and keep every other token below it.
        if (pathname === '/api/vocabulary/classify') {
            const body = request.postDataJSON() || {};
            const items = Array.isArray(body.items) ? body.items : [];
            const aboveLevel = new Set(['habits', 'breakfast']);
            return respond({
                items: items.map((item) => {
                    const text = typeof item?.text === 'string' ? item.text : '';
                    return {
                        text,
                        level: aboveLevel.has(text.trim().toLowerCase()) ? 'C1' : 'A1',
                        proper: false,
                    };
                }),
            });
        }
        // P2-16: favorites use the per-item API. Writes echo the draft back in
        // the server shape (`time`/`text`/`translation` + flattened meta), so
        // the App's optimistic row and its top-bar count update exactly like
        // they do against the real backend. The two status knobs drive the
        // inline rollback acceptance runs.
        if (pathname === '/api/favorites') {
            if (request.method() === 'POST') {
                if (favoritePostStatus !== 200) {
                    return respond({ detail: 'favorite write failed (acceptance stub)' }, favoritePostStatus);
                }
                const body = request.postDataJSON() || {};
                const meta = body && typeof body.meta === 'object' && body.meta ? body.meta : {};
                const stored = {
                    id: body.id,
                    type: body.type,
                    videoId: body.videoId,
                    start: body.time,
                    en_text: body.text,
                    zh_text: body.translation,
                    added_at: body.addedAt,
                    ...meta,
                };
                if (!favoriteStore.some((item) => item.id === stored.id)) favoriteStore.push(stored);
                return respond(stored);
            }
            return respond(favoriteStore);
        }
        if (pathname.startsWith('/api/favorites/')) {
            if (request.method() === 'DELETE') {
                if (favoriteDeleteStatus !== 200) {
                    return respond({ detail: 'favorite delete failed (acceptance stub)' }, favoriteDeleteStatus);
                }
                const id = decodeURIComponent(pathname.slice('/api/favorites/'.length));
                const index = favoriteStore.findIndex((item) => item.id === id);
                if (index >= 0) favoriteStore.splice(index, 1);
                return respond({});
            }
            return respond({});
        }
        if (pathname === '/api/subscriptions') return respond([]);
        if (pathname === '/api/shows') return respond({ shows: [] });
        if (pathname === '/api/sentences/levels') return respond([]);
        if (pathname === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
                default: 'deepseek-chat',
            });
        }
        if (pathname === '/api/placement/profile') return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
        // P2-19: `useIgnoredWords` reads GET ...?mastered=1; the watch check
        // PATCHes the same path. The store is the server truth here, so a
        // refresh/reload must see the post-write mark (never a fake echo).
        if (pathname === '/api/review/words') {
            if (request.method() === 'PATCH') {
                if (masteredPatchStatus !== 200) {
                    // Delay first so a double click can prove the busy guard.
                    if (masteredPatchDelayMs > 0) await sleep(masteredPatchDelayMs);
                    return respond({ detail: 'mastered patch failed (acceptance stub)' }, masteredPatchStatus);
                }
                const body = request.postDataJSON() || {};
                const lemma = typeof body.lemma === 'string' ? body.lemma.trim() : '';
                const normalized = lemma.toLowerCase();
                if (!normalized) return respond({ detail: 'lemma required' }, 422);
                if (body.mastered === true) masteredStore.add(normalized);
                else masteredStore.delete(normalized);
                return respond({
                    status: 'ok',
                    word: { ...masteredWord(lemma), mastered: body.mastered === true, definition: body.definition ?? null },
                });
            }
            const masteredOnly = new URL(request.url()).searchParams.get('mastered') === '1';
            const words = masteredOnly ? [...masteredStore].map((lemma) => masteredWord(lemma)) : [];
            return respond({
                targetLang: 'zh-CN',
                now: Date.now(),
                total: words.length,
                words,
            });
        }
        if (pathname === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-23', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (pathname === '/api/recommendations') {
            return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: true });
        }
        if (pathname.startsWith('/api/')) return respond({});
        return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
    });

    return context;
}

/**
 * P2-10: deterministic page-fullscreen stub. Real fullscreen is asynchronous
 * and headless-host dependent, so the whole lifecycle is driven page-side:
 * `window.__fsStub` records requests/exits, `document.fullscreenElement` is an
 * own getter, `fullscreenchange` is dispatched like the browser would, and
 * `__fsStub.escape()` simulates the ESC/browser-chrome exit.
 */
async function stubFullscreen(page) {
    await page.addInitScript(() => {
        const state = {
            element: null,
            requests: 0,
            exits: 0,
            requestedTestId: null,
            rejectNext: false,
        };
        const notify = () => document.dispatchEvent(new Event('fullscreenchange'));
        Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            get: () => state.element,
        });
        const request = function requestFullscreen() {
            state.requests += 1;
            state.requestedTestId = this instanceof Element ? this.getAttribute('data-testid') : null;
            if (state.rejectNext) {
                state.rejectNext = false;
                return Promise.reject(new TypeError('fullscreen request denied (acceptance stub)'));
            }
            state.element = this;
            notify();
            return Promise.resolve();
        };
        Object.defineProperty(Element.prototype, 'requestFullscreen', {
            configurable: true,
            writable: true,
            value: request,
        });
        const exit = function exitFullscreen() {
            state.exits += 1;
            if (state.element === null) return Promise.resolve();
            state.element = null;
            notify();
            return Promise.resolve();
        };
        Object.defineProperty(document, 'exitFullscreen', {
            configurable: true,
            writable: true,
            value: exit,
        });
        state.escape = () => {
            if (state.element === null) return;
            state.element = null;
            notify();
        };
        window.__fsStub = state;
    });
}

async function openVideo(page, videoId) {
    await page.goto(`${BASE}/#/app/content/learn/youtube/${videoId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="video-area"]').waitFor({ state: 'visible', timeout: 20000 });
    // P2-15: the entry toggle only exists outside watch mode, so the learning
    // shell itself is the readiness signal (a persisted watch preference opens
    // the page straight into the immersive shell).
    await page.locator('[data-testid="learning-scroll"]').waitFor({ state: 'attached', timeout: 20000 });
}

/**
 * P2-19: the free-library payload carries its own analysis, so a guest sees
 * real gloss rows there (the guest AI gate is untouched). Direct route restore
 * only reads the public payload — no process/teaching-analysis request.
 */
async function openLibraryVideo(page, itemId) {
    await page.goto(`${BASE}/#/app/content/learn/library/${itemId}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="video-area"]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-testid="learning-scroll"]').waitFor({ state: 'attached', timeout: 20000 });
}

// ── P2-15 helpers ─────────────────────────────────────────────────────────
// The floating top bar fades after 2.5s of stillness. Any interaction with it
// first has to bring it back the same way a learner would (pointer movement)
// and wait for the fade-in, otherwise Playwright would click an inert /
// pointer-events-none bar.
async function revealWatchTopbar(page) {
    await page.mouse.move(2, 2);
    await page.waitForFunction(
        () => {
            const bar = document.querySelector('[data-testid="watch-topbar"]');
            return Boolean(bar)
                && bar.getAttribute('data-idle') === 'false'
                && parseFloat(getComputedStyle(bar).opacity) > 0.9;
        },
        null,
        { timeout: 5000 },
    );
}

const watchTopbarState = (page) => page.evaluate(() => {
    const bar = document.querySelector('[data-testid="watch-topbar"]');
    if (!bar) return null;
    const rect = bar.getBoundingClientRect();
    return {
        idle: bar.getAttribute('data-idle'),
        opacity: parseFloat(getComputedStyle(bar).opacity),
        pointerEvents: getComputedStyle(bar).pointerEvents,
        box: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        buttons: [...bar.querySelectorAll('button')]
            .map((button) => button.getAttribute('data-testid'))
            .filter(Boolean),
    };
});

async function enterWatchMode(page) {
    await page.locator('[data-testid="video-area"]').hover();
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'on', null, { timeout: 5000 });
    await page.locator('[data-testid="watch-topbar"]').waitFor({ state: 'attached', timeout: 5000 });
}

/** Leaves 观影模式 through the top bar (the toggle is not mounted in watch). */
async function exitWatchMode(page) {
    await revealWatchTopbar(page);
    await page.locator('[data-testid="watch-topbar-exit"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'off', null, { timeout: 5000 });
    await page.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
}

async function openSubtitleMenu(page) {
    await revealWatchTopbar(page);
    await page.locator('[data-testid="watch-subtitle-toggle"]').click();
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'visible', timeout: 5000 });
}

async function chooseSubtitleMode(page, mode) {
    await openSubtitleMenu(page);
    await page.locator(`[data-testid="watch-subtitle-mode-${mode}"]`).click();
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(
        (expected) => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === expected,
        mode,
        { timeout: 5000 },
    );
}

const subtitleModeState = (page) => page.evaluate(() => ({
    toggleMode: document.querySelector('[data-testid="watch-subtitle-toggle"]')?.getAttribute('data-mode') ?? null,
    stored: localStorage.getItem('yt_bilingual_watch_subtitle_mode'),
    overlay: document.querySelector('[data-testid="watch-subtitle-overlay"]')?.getAttribute('data-mode') ?? null,
    en: Boolean(document.querySelector('[data-testid="watch-subtitle-en"]')),
    zh: Boolean(document.querySelector('[data-testid="watch-subtitle-zh"]')),
}));

const boxOf = (page, testId) => page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
}, testId);

/**
 * P2-13: the `ruby[data-gloss]` pairs rendered inside one transcript block.
 * `data-index` is the rendered position; the fixtures keep it equal to the
 * payload block id, so a missing block returns null instead of a false empty.
 */
const transcriptRubyGlosses = (page, blockIndex) => page.evaluate((index) => {
    const block = document.querySelector(`[data-testid="transcript-scroll"] [data-index="${index}"]`);
    if (!block) return null;
    return [...block.querySelectorAll('ruby[data-gloss]')].map((ruby) => ({
        word: ruby.getAttribute('data-word-hit'),
        gloss: ruby.getAttribute('data-gloss'),
    }));
}, blockIndex);

// P2-11: computed subtitle typography plus the fit checks used by the fluid
// type tiers (375 / 1440 normal / 1440 watch / 1920 / fullscreen stub).
const subtitleType = (page) => page.evaluate(() => {
    const read = (testId) => {
        const element = document.querySelector(`[data-testid="${testId}"]`);
        if (!element) return null;
        return {
            fontSize: parseFloat(getComputedStyle(element).fontSize),
            clipped: element.scrollWidth > element.clientWidth + 1,
        };
    };
    const overlay = document.querySelector('[data-testid="watch-subtitle-overlay"]');
    const media = document.querySelector('[data-testid="video-area"]');
    const stage = overlay ? overlay.parentElement : null;
    const overlayRect = overlay ? overlay.getBoundingClientRect() : null;
    const stageRect = stage ? stage.getBoundingClientRect() : null;
    return {
        en: read('watch-subtitle-en'),
        zh: read('watch-subtitle-zh'),
        mediaWidth: media ? media.getBoundingClientRect().width : null,
        insideMedia: Boolean(
            overlayRect && stageRect
            && overlayRect.top >= stageRect.top - 1
            && overlayRect.bottom <= stageRect.bottom + 1,
        ),
        insideViewport: Boolean(
            overlayRect
            && overlayRect.left >= -1
            && overlayRect.right <= window.innerWidth + 1,
        ),
    };
});

const overlayText = (page) => page.evaluate(() => {
    const el = document.querySelector('[data-testid="watch-subtitle-overlay"]');
    return el ? el.innerText.replace(/\s+/g, ' ').trim() : null;
});

async function waitForOverlay(page, fragment, timeout = 10000) {
    await page.waitForFunction(
        (needle) => {
            const el = document.querySelector('[data-testid="watch-subtitle-overlay"]');
            return Boolean(el && (el.textContent || '').includes(needle));
        },
        fragment,
        { timeout },
    );
}

// ── P2-17 helpers ─────────────────────────────────────────────────────────
// The subtitle has two positions: raised (clear of the native control strip)
// while the learner is active, docked (bottom ~0.5%) after 2.5s of stillness.
// Distances are reported both against the overlay's own media box and against
// `video-area`, because the native control strip belongs to the latter.
const subtitlePositionState = (page) => page.evaluate(() => {
    const overlay = document.querySelector('[data-testid="watch-subtitle-overlay"]');
    const media = document.querySelector('[data-testid="video-area"]');
    if (!overlay) return null;
    const rect = overlay.getBoundingClientRect();
    const parentRect = overlay.parentElement.getBoundingClientRect();
    const mediaRect = media ? media.getBoundingClientRect() : null;
    const style = getComputedStyle(overlay);
    const durations = style.transitionDuration.split(',').map((value) => {
        const trimmed = value.trim();
        return trimmed.endsWith('ms') ? parseFloat(trimmed) : parseFloat(trimmed) * 1000;
    });
    return {
        dock: overlay.getAttribute('data-dock'),
        raised: overlay.getAttribute('data-raised'),
        bottom: rect.bottom,
        bottomGap: parentRect.bottom - rect.bottom,
        parentHeight: parentRect.height,
        mediaBottomGap: mediaRect ? mediaRect.bottom - rect.bottom : null,
        mediaHeight: mediaRect ? mediaRect.height : null,
        pointerEvents: style.pointerEvents,
        transitionProperty: style.transitionProperty,
        transitionMs: Math.max(...durations),
    };
});

/** P2-17: the in-sentence highlight spans, their text and their classes. */
const subtitleHighlightState = (page) => page.evaluate(() => {
    const en = document.querySelector('[data-testid="watch-subtitle-en"]');
    if (!en) return null;
    return {
        text: (en.textContent ?? '').trim(),
        highlights: [...en.querySelectorAll('[data-testid="watch-subtitle-highlight"]')].map((el) => ({
            text: el.textContent ?? '',
            kind: el.getAttribute('data-kind'),
            className: el.getAttribute('class') ?? '',
            background: getComputedStyle(el).backgroundColor,
            color: getComputedStyle(el).color,
        })),
    };
});

/**
 * P2-17: one row = left label + right definition. `sameLine` is the row-layout
 * contract (the language point's definition used to sit under its phrase), and
 * `definitionRect.textAlign` must be `right` for both kinds.
 */
const glossRowState = (page) => page.evaluate(() => {
    const read = (el) => {
        if (!el) return null;
        const style = getComputedStyle(el);
        const rect = el.getBoundingClientRect();
        return {
            fontSize: parseFloat(style.fontSize),
            textAlign: style.textAlign,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            width: rect.width,
        };
    };
    const rows = [...document.querySelectorAll(
        '[data-testid="watch-gloss-word"], [data-testid="watch-gloss-language-point"]',
    )].map((row) => {
        const label = row.querySelector('[data-testid="watch-gloss-word-text"], [data-testid="watch-gloss-point-text"]');
        const definition = row.querySelector('[data-testid="watch-gloss-definition"]');
        const labelRect = read(label);
        const definitionRect = read(definition);
        const entry = row.closest('[data-testid="watch-gloss-entry"]');
        return {
            testId: row.getAttribute('data-testid'),
            labelText: label?.textContent ?? '',
            glossText: definition?.textContent ?? '',
            current: entry?.getAttribute('data-current') === 'true',
            labelRect,
            definitionRect,
            sameLine: Boolean(
                labelRect && definitionRect && Math.abs(labelRect.top - definitionRect.top) <= 2,
            ),
        };
    });
    const currentRows = rows.filter((row) => row.current);
    const wordRow = currentRows.find((row) => row.testId === 'watch-gloss-word')
        ?? rows.find((row) => row.testId === 'watch-gloss-word')
        ?? null;
    const pointRow = currentRows.find((row) => row.testId === 'watch-gloss-language-point')
        ?? rows.find((row) => row.testId === 'watch-gloss-language-point')
        ?? null;
    return {
        rows,
        currentRows,
        wordRow,
        pointRow,
        wordFont: wordRow?.labelRect?.fontSize ?? null,
        definitionFont: wordRow?.definitionRect?.fontSize ?? null,
    };
});

const waitForGlossWord = (page, timeout = 10000) => page.waitForFunction(
    () => document.querySelector('[data-testid="watch-gloss-word"]') !== null,
    null,
    { timeout },
);

// Land on cue 0 or cue 1 (both carry glosses) regardless of how far playback
// progressed while the page was loading. Robust against slow dev-server starts
// where "ArrowRight from before the first cue" would otherwise overshoot.
async function seekToGlossedCue(page) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const text = await overlayText(page);
        if (text && (text.includes('Small habits') || text.includes('A short walk'))) return;
        if (text && text.includes('Nobody moves')) {
            await page.keyboard.press('ArrowLeft');
            await page.keyboard.press('ArrowLeft');
        } else {
            await page.keyboard.press('ArrowRight');
        }
        await sleep(400);
    }
    throw new Error('could not reach a glossed cue');
}

async function waitForRailText(page, fragment, timeout = 10000) {
    await page.waitForFunction(
        (needle) => {
            const el = document.querySelector('[data-testid="watch-gloss-rail"]');
            return Boolean(el && (el.textContent || '').includes(needle));
        },
        fragment,
        { timeout },
    );
}

// Pause the mocked player after a keyboard seek (the stub always starts
// playing on seekTo) so multi-step assertions cannot race a 4s cue. Blur
// first: Space on a focused button would press the button instead.
async function pausePlayback(page) {
    await page.evaluate(() => {
        const active = document.activeElement;
        if (active instanceof HTMLElement) active.blur();
    });
    await page.keyboard.press(' ');
    await sleep(120);
}

async function waitForGlossEntries(page, count, timeout = 10000) {
    await page.waitForFunction(
        (expected) => document.querySelectorAll('[data-testid="watch-gloss-entry"]').length === expected,
        count,
        { timeout },
    );
}

const glossEntryCount = (page) => page.locator('[data-testid="watch-gloss-entry"]').count();

// P2-12: entries are identified by block id now that the sentence context
// line is gone; the id also proves "current on top / older below" order.
const glossBlockIds = (page) => page.locator('[data-testid="watch-gloss-entry"]').evaluateAll(
    (entries) => entries.map((entry) => entry.getAttribute('data-block-id')),
);

async function waitForCurrentEntry(page, blockId, timeout = 10000) {
    await page.waitForFunction(
        (expected) => {
            const first = document.querySelector('[data-testid="watch-gloss-entry"]');
            return first?.getAttribute('data-current') === 'true'
                && first.getAttribute('data-block-id') === expected;
        },
        blockId,
        { timeout },
    );
}

/**
 * P2-12: the rolling list must stay chrome-free — no entry card border or
 * background, no divider between entries — and text must never overflow its
 * window (long words/glosses wrap instead of widening it).
 */
async function assertGlossListChrome(page, rootTestId, label) {
    const result = await page.evaluate((rootSelector) => {
        const root = document.querySelector(rootSelector);
        const nodes = [...document.querySelectorAll(
            '[data-testid="watch-gloss-entry"], [data-testid="watch-gloss-word"], [data-testid="watch-gloss-language-point"]',
        )];
        const rootRect = root ? root.getBoundingClientRect() : null;
        return {
            count: nodes.length,
            overflowItems: nodes.filter((node) => node.scrollWidth > node.clientWidth + 1).length,
            outsideItems: rootRect
                ? nodes.filter((node) => node.getBoundingClientRect().right > rootRect.right + 1).length
                : -1,
            rootScrollWidth: root ? root.scrollWidth : null,
            rootClientWidth: root ? root.clientWidth : null,
            chrome: nodes.map((node) => {
                const style = getComputedStyle(node);
                return {
                    testId: node.getAttribute('data-testid'),
                    borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth]
                        .map((value) => parseFloat(value) || 0),
                    background: style.backgroundColor,
                    backgroundImage: style.backgroundImage,
                    boxShadow: style.boxShadow,
                };
            }),
        };
    }, `[data-testid="${rootTestId}"]`);

    assert.ok(result.count > 0, `${label}: no gloss entries to inspect`);
    for (const node of result.chrome) {
        assert.deepEqual(node.borders, [0, 0, 0, 0], `${label}: ${node.testId} still draws a card border/divider`);
        assert.equal(node.background, 'rgba(0, 0, 0, 0)', `${label}: ${node.testId} still draws a card background`);
        assert.equal(node.backgroundImage, 'none', `${label}: ${node.testId} still draws a background texture`);
        assert.equal(node.boxShadow, 'none', `${label}: ${node.testId} still draws a card shadow`);
    }
    assert.equal(result.overflowItems, 0, `${label}: gloss text is clipped/overflows its row (long word or gloss)`);
    assert.equal(result.outsideItems, 0, `${label}: gloss content spills outside the window`);
    assert.ok(
        result.rootScrollWidth <= result.rootClientWidth + 1,
        `${label}: the gloss window scrolls horizontally (${result.rootScrollWidth} > ${result.rootClientWidth})`,
    );
    return { entries: result.count };
}

const scrollMetrics = (page) => page.locator('[data-testid="watch-gloss-scroll"]').evaluate((el) => ({
    scrollTop: el.scrollTop,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
}));

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const summary = { status: 'PASS', head: HEAD, screenshots: [] };

try {
    // ═════════════════════════════════════════════════════════════════════
    // 1440 — full flow: off → on → layout/subtitle/gloss → off → persist
    // ═════════════════════════════════════════════════════════════════════
    const desktop = await createContext(browser);
    const page = await desktop.newPage();
    await stubFullscreen(page);
    const pageErrors = [];
    const apiRequests = [];
    const favoriteWrites = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) apiRequests.push({ method: request.method(), path: url.pathname });
        if (url.pathname.startsWith('/api/favorites')) {
            let body = null;
            try { body = request.postDataJSON(); } catch { body = null; }
            favoriteWrites.push({ method: request.method(), path: url.pathname, body });
        }
    });

    await openVideo(page, VIDEO_ID);

    // — toggle OFF is the default even with a split layout stored —
    assert.equal(await page.getAttribute('[data-testid="watch-mode-toggle"]', 'aria-pressed'), 'false');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'off');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off');
    assert.equal(await page.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'the player must not render a standalone fullscreen button');
    assert.equal(await page.locator('[data-testid="watch-mode-toggle"]').count(), 1, 'the watch toggle must be the only watch control');
    assert.equal(await page.locator('[data-testid="top-bar"]').count(), 1, 'AppShell top bar missing before watch mode');
    assert.equal(await page.locator('[data-testid="learning-header"]').count(), 1, 'LearningHeader missing before watch mode');
    assert.equal(await page.locator('[data-testid="teaching-notes-panel"]').count(), 1, 'teaching panel missing before watch mode');
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 1, 'split layout not restored on load');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'off');

    // — P2-11: the media stage is the container-query source. The overlay only
    // mounts in watch mode, so the normal 1440 layout is measured with a probe
    // span inside the same container: same clamp, narrower media → smaller
    // computed size than the watch layout read below. —
    const normalType = await page.evaluate(({ en, zh }) => {
        const media = document.querySelector('[data-testid="video-area"]');
        if (!media) return null;
        const probe = document.createElement('span');
        probe.setAttribute('aria-hidden', 'true');
        probe.style.position = 'absolute';
        probe.style.visibility = 'hidden';
        media.appendChild(probe);
        probe.style.fontSize = en;
        const enPx = parseFloat(getComputedStyle(probe).fontSize);
        probe.style.fontSize = zh;
        const zhPx = parseFloat(getComputedStyle(probe).fontSize);
        probe.remove();
        return {
            mediaWidth: media.getBoundingClientRect().width,
            containerType: getComputedStyle(media).containerType,
            en: enPx,
            zh: zhPx,
        };
    }, { en: FLUID_EN, zh: FLUID_ZH });
    assert.ok(normalType, 'normal-layout media stage missing');
    assert.equal(normalType.containerType, 'inline-size', 'media stage is not a container-query source');
    assert.ok(
        normalType.en > 17 && normalType.en < 32,
        `1440 normal media should resolve the fluid clamp above the 17px floor, got ${normalType.en}px`,
    );
    assert.ok(normalType.en > normalType.zh, 'normal-layout English must stay above Chinese');

    // — turn watch mode on from the player toolbar —
    await enterWatchMode(page);
    // P2-10: the same click requests page fullscreen on the watch shell.
    await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__fsStub.requests), 1, 'entering watch mode must request page fullscreen');
    assert.equal(await page.evaluate(() => window.__fsStub.requestedTestId), 'learning-scroll', 'fullscreen must target the watch shell');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'on');
    // — P2-15 §1: immersive shell — AppShell's top bar and the LearningHeader
    //   are not rendered; the floating top bar is the only chrome. —
    assert.equal(await page.locator('[data-testid="watch-mode-toggle"]').count(), 0, 'the entry toggle must unmount in watch mode (the top bar owns exit)');
    assert.equal(await page.locator('[data-testid="top-bar"]').count(), 0, 'AppShell top bar must NOT be rendered in watch mode');
    assert.equal(await page.locator('[data-testid="learning-header"]').count(), 0, 'LearningHeader must NOT be rendered in watch mode');
    const topbarInitial = await watchTopbarState(page);
    assert.ok(topbarInitial, 'watch top bar missing');
    assert.deepEqual(
        [...topbarInitial.buttons].sort(),
        ['watch-subtitle-toggle', 'watch-topbar-back', 'watch-topbar-exit'],
        'the watch top bar must expose exactly back / CC / exit — no fake settings button',
    );
    assert.equal(
        (await page.locator('[data-testid="watch-topbar-chip"]').innerText()).trim(),
        '观影模式',
        'watch top bar chip is not 观影模式',
    );
    assert.ok(
        (await page.locator('[data-testid="watch-topbar-title"]').innerText()).includes('Watch Mode Acceptance'),
        'watch top bar title does not carry the video title',
    );
    assert.ok(
        (await page.locator('[data-testid="watch-topbar-source"]').innerText()).includes('LinguaTrek Test'),
        'watch top bar source does not carry the channel',
    );
    assert.ok(
        topbarInitial.box.y <= 1 && Math.abs(topbarInitial.box.width - 1440) < 2,
        `watch top bar is not floating at the viewport top: ${JSON.stringify(topbarInitial.box)}`,
    );
    assert.ok(
        topbarInitial.box.height >= 44 && topbarInitial.box.height <= 60,
        `watch top bar height ${topbarInitial.box.height} outside 44–60`,
    );
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(await page.locator('[data-testid="teaching-notes-panel"]').count(), 0, 'teaching panel must NOT be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="summary-panel"]').count(), 0, 'summary panel must not be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="transcript-column"]').count(), 0, 'transcript column must not be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 0, 'split divider must not be mounted in watch mode');
    // The toggle must not reset the other two layout preferences.
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_transcript_layout')), 'split');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_split_ratio')), '60');

    // — P2-15 §1: 2.5s of stillness fades the bar; keyboard / pointer bring
    //   it back. The shell itself keeps its reserved strip so the jump never
    //   shifts the stage. —
    await revealWatchTopbar(page);
    summary.screenshots.push(shot('1440-topbar'));
    await page.screenshot({ path: shot('1440-topbar') });
    const awake = await watchTopbarState(page);
    assert.equal(awake.idle, 'false');
    assert.ok(awake.opacity > 0.9, `visible top bar opacity ${awake.opacity}`);
    assert.notEqual(awake.pointerEvents, 'none', 'a visible top bar must accept clicks');
    // Move off the bar: resting on the chrome counts as being in its control,
    // the 2.5s stillness contract applies to an untouched picture.
    await page.mouse.move(720, 300);
    await page.waitForFunction(
        () => {
            const bar = document.querySelector('[data-testid="watch-topbar"]');
            return bar?.getAttribute('data-idle') === 'true' && parseFloat(getComputedStyle(bar).opacity) < 0.005;
        },
        null,
        { timeout: 6000 },
    );
    const faded = await watchTopbarState(page);
    assert.ok(faded.opacity < 0.2, `idle top bar still visible (opacity ${faded.opacity})`);
    assert.equal(faded.pointerEvents, 'none', 'an idle top bar must let clicks reach the picture');
    summary.screenshots.push(shot('1440-idle'));
    await page.screenshot({ path: shot('1440-idle') });
    // Keyboard activity reveals it (spec: 鼠标/触摸/键盘出现).
    await page.keyboard.press('Shift');
    await page.waitForFunction(
        () => {
            const bar = document.querySelector('[data-testid="watch-topbar"]');
            return bar?.getAttribute('data-idle') === 'false' && parseFloat(getComputedStyle(bar).opacity) > 0.9;
        },
        null,
        { timeout: 5000 },
    );

    // — P2-15 §2: the 16:9 picture is centred on an ambient stage; the letterbox
    //   is environment light, never a dead-black band, and nothing overflows. —
    const watchGeometry = await page.evaluate(() => {
        const box = (id) => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        const stage = document.querySelector('[data-testid="watch-stage"]');
        const ambient = document.querySelector('[data-testid="watch-stage-ambient"]');
        return {
            viewport: { width: window.innerWidth, height: window.innerHeight },
            documentWidth: document.documentElement.scrollWidth,
            shell: box('learning-scroll'),
            stage: box('watch-stage'),
            video: box('video-area'),
            ambient: ambient ? box('watch-stage-ambient') : null,
            stageContainer: stage ? getComputedStyle(stage).containerType : null,
            ambientGradient: ambient
                ? [...ambient.querySelectorAll('*')].some((element) => getComputedStyle(element).backgroundImage !== 'none')
                : false,
            ambientBlur: ambient
                ? [...ambient.querySelectorAll('*')].some((element) => getComputedStyle(element).filter.includes('blur'))
                : false,
        };
    });
    assert.ok(watchGeometry.stage && watchGeometry.video && watchGeometry.ambient, 'watch stage / media / ambient layer missing');
    assert.equal(watchGeometry.stageContainer, 'size', 'the watch stage is not a size container (centred 16:9 box)');
    assert.ok(
        Math.abs(watchGeometry.stage.y - awake.box.height) <= 2,
        `stage top ${watchGeometry.stage.y} must sit exactly below the top bar (${awake.box.height})`,
    );
    assert.ok(
        Math.abs(watchGeometry.stage.bottom - watchGeometry.viewport.height) <= 2,
        'the stage must reach the bottom of the viewport (no dead band below it)',
    );
    const videoAspect = watchGeometry.video.width / watchGeometry.video.height;
    assert.ok(Math.abs(videoAspect - 16 / 9) < 0.02, `media is not 16:9 (${videoAspect.toFixed(3)})`);
    assert.ok(
        Math.abs((watchGeometry.video.x + watchGeometry.video.width / 2) - (watchGeometry.stage.x + watchGeometry.stage.width / 2)) <= 2,
        'the media is not horizontally centred on the stage',
    );
    assert.ok(
        Math.abs((watchGeometry.video.y + watchGeometry.video.height / 2) - (watchGeometry.stage.y + watchGeometry.stage.height / 2)) <= 2,
        `the media is not vertically centred on the stage (video y ${watchGeometry.video.y}, stage ${watchGeometry.stage.y}–${watchGeometry.stage.bottom})`,
    );
    assert.ok(
        watchGeometry.video.x >= watchGeometry.stage.x - 1
        && watchGeometry.video.right <= watchGeometry.stage.right + 1
        && watchGeometry.video.y >= watchGeometry.stage.y - 1
        && watchGeometry.video.bottom <= watchGeometry.stage.bottom + 1,
        'the media overflows the watch stage',
    );
    assert.ok(watchGeometry.documentWidth <= watchGeometry.viewport.width + 1, '1440 watch layout overflows horizontally');
    assert.ok(
        Math.abs(watchGeometry.ambient.width - watchGeometry.stage.width) < 2
        && Math.abs(watchGeometry.ambient.height - watchGeometry.stage.height) < 2,
        'the ambient layer does not fill the whole stage (letterbox left as dead black)',
    );
    assert.ok(watchGeometry.ambientGradient, 'the ambient stage has no gradient environment light');
    assert.ok(watchGeometry.ambientBlur, 'the ambient stage has no blurred environment light');
    assert.ok(
        watchGeometry.video.y - watchGeometry.stage.y > 24 && watchGeometry.stage.bottom - watchGeometry.video.bottom > 24,
        'the letterbox above/below the picture is too small for an ambient stage',
    );

    // — P2-16 / specs/045 §4.3: the ≥1280 gloss window is a fixed 360px rail —
    const rail = await boxOf(page, 'watch-gloss-rail');
    assert.ok(rail, 'gloss rail missing at 1440');
    assert.ok(Math.abs(rail.width - 360) <= 1, `rail width ${rail.width} is not 360`);
    const videoColumn = await boxOf(page, 'video-column');
    const shell = await boxOf(page, 'learning-scroll');
    assert.ok(videoColumn && shell, 'video column / shell missing');
    assert.ok(Math.abs((videoColumn.x || 0) - (shell.x || 0)) < 2, 'video column should start at the shell edge');
    assert.ok(Math.abs(shell.width - (videoColumn.width + rail.width)) < 2, `shell ${shell.width} != media ${videoColumn.width} + rail ${rail.width}`);
    assert.ok(rail.x >= videoColumn.x + videoColumn.width - 2, 'rail is not to the right of the media');
    assert.ok(Math.abs(shell.x + shell.width - (rail.x + rail.width)) < 2, 'rail does not end at the shell edge');
    const mediaStageWatch = await boxOf(page, 'video-area');
    assert.ok((mediaStageWatch?.height ?? 0) > 900 * 0.62 * 0.9, 'watch mode did not enlarge the media stage');
    // P2-16: title「滚动词条」+ the current sentence's word count. Before the
    // first cue there is no current sentence, so the count is 0.
    assert.equal(
        (await page.locator('[data-testid="watch-gloss-rail"] h2').innerText()).trim(),
        '滚动词条',
        'gloss window title is not 滚动词条',
    );
    assert.equal(
        (await page.locator('[data-testid="watch-gloss-count"]').innerText()).trim(),
        '本句 0',
        'the rail header does not carry the current sentence word count',
    );

    // — before the first cue there is no current sentence → overlay hidden —
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0, 'overlay should hide with no current sentence');

    // — ArrowRight from "before the first cue" jumps to cue 0 —
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'Small habits');
    await waitForRailText(page, '习惯');
    // P2-16: current sentence target pinned on top (within three rows), header
    // count matches that sentence's words, and only the current entry carries
    // the 2px marker (no "当前句" text).
    assert.equal(
        (await page.locator('[data-testid="watch-gloss-count"]').innerText()).trim(),
        '本句 1',
        'the rail header count did not follow the current sentence',
    );
    const currentEntryPinned = await page.evaluate(() => {
        const scroll = document.querySelector('[data-testid="watch-gloss-scroll"]');
        const current = document.querySelector('[data-testid="watch-gloss-entry"][data-current="true"]');
        if (!scroll || !current) return null;
        return {
            firstBlockId: document.querySelector('[data-testid="watch-gloss-entry"]')?.getAttribute('data-block-id'),
            offsetTop: current.getBoundingClientRect().top - scroll.getBoundingClientRect().top,
            markerCount: document.querySelectorAll('[data-testid="watch-gloss-current-marker"]').length,
        };
    });
    assert.ok(currentEntryPinned, 'no current gloss entry after cue 0');
    assert.equal(currentEntryPinned.firstBlockId, '0', 'the current sentence is not the first gloss entry');
    assert.ok(
        currentEntryPinned.offsetTop <= 120,
        `the current sentence target sits ${currentEntryPinned.offsetTop}px down (must be within three rows)`,
    );
    assert.equal(currentEntryPinned.markerCount, 1, 'the current sentence must carry exactly one 2px marker per word row');
    const overlay0 = await overlayText(page);
    assert.ok(overlay0.includes('小习惯悄悄塑造一整天的感受。'), `overlay missing Chinese: ${overlay0}`);
    assert.ok(overlay0.includes('Small habits quietly shape'), `overlay missing English: ${overlay0}`);
    assert.ok(!overlay0.includes('Nobody moves'), 'overlay must only render the current sentence');
    // — P2-17: the sentence keeps every character; only the current glossed
    //   word is wrapped, and it carries the amber word treatment. —
    const cue0Highlight = await subtitleHighlightState(page);
    assert.ok(cue0Highlight, 'cue 0 subtitle highlight state missing');
    assert.equal(
        cue0Highlight.text,
        'Small habits quietly shape the way a whole day feels.',
        'the subtitle highlight changed the sentence text',
    );
    assert.equal(cue0Highlight.highlights.length, 1, 'cue 0 should highlight exactly its one glossed word');
    assert.equal(cue0Highlight.highlights[0].text, 'habits');
    assert.equal(cue0Highlight.highlights[0].kind, 'word');
    assert.match(cue0Highlight.highlights[0].className, /(^|\s)bg-amber-400\/20(\s|$)/, 'the glossed word is not amber');
    assert.match(cue0Highlight.highlights[0].className, /(^|\s)text-amber-100(\s|$)/, 'the glossed word lost the amber text tone');
    const zhBox = await boxOf(page, 'watch-subtitle-zh');
    const enBox = await boxOf(page, 'watch-subtitle-en');
    assert.ok(enBox && zhBox && enBox.y < zhBox.y, 'English must sit above Chinese');
    // English-first text order in the DOM as well (P2-09 typography switch).
    const order = await page.evaluate(() => {
        const zh = document.querySelector('[data-testid="watch-subtitle-zh"]');
        const en = document.querySelector('[data-testid="watch-subtitle-en"]');
        return Boolean(zh && en && (en.compareDocumentPosition(zh) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.ok(order, 'DOM order is not English-then-Chinese');
    const subtitleTypography = await page.evaluate(() => {
        const read = (testId) => {
            const el = document.querySelector(`[data-testid="${testId}"]`);
            if (!el) return null;
            return {
                fontSize: parseFloat(getComputedStyle(el).fontSize),
                clipped: el.scrollWidth > el.clientWidth + 1,
            };
        };
        return { en: read('watch-subtitle-en'), zh: read('watch-subtitle-zh') };
    });
    assert.ok(subtitleTypography.en && subtitleTypography.en.fontSize >= 17, `English subtitle ${subtitleTypography.en?.fontSize}px < 17px`);
    assert.ok(subtitleTypography.zh && subtitleTypography.zh.fontSize >= 15, `Chinese subtitle ${subtitleTypography.zh?.fontSize}px < 15px`);
    assert.ok(
        subtitleTypography.en.fontSize > subtitleTypography.zh.fontSize,
        `English (${subtitleTypography.en.fontSize}px) must be larger than Chinese (${subtitleTypography.zh.fontSize}px)`,
    );
    assert.ok(!subtitleTypography.en.clipped && !subtitleTypography.zh.clipped, 'subtitle text is horizontally clipped at 1440');
    const overlayFit1440 = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="watch-subtitle-overlay"]');
        const media = el ? el.parentElement : null;
        if (!el || !media) return null;
        const rect = el.getBoundingClientRect();
        const mediaRect = media.getBoundingClientRect();
        return {
            insideWidth: rect.left >= -1 && rect.right <= window.innerWidth + 1,
            insideMedia: rect.top >= mediaRect.top - 1 && rect.bottom <= mediaRect.bottom + 1,
        };
    });
    assert.ok(
        overlayFit1440 && overlayFit1440.insideWidth && overlayFit1440.insideMedia,
        `subtitle overlay overflows at 1440: ${JSON.stringify(overlayFit1440)}`,
    );

    // — P2-11: watch mode widens the media stage, so the same fluid formula
    // resolves larger than the normal layout (and stays below the 32px cap so
    // 1920 can keep growing). English must remain above Chinese. —
    const watchType = await subtitleType(page);
    assert.ok(watchType.en && watchType.zh, 'watch subtitle lines missing for the fluid type check');
    assert.ok(
        watchType.mediaWidth > normalType.mediaWidth + 1,
        `watch media ${watchType.mediaWidth}px should be wider than normal media ${normalType.mediaWidth}px`,
    );
    assert.ok(
        watchType.en.fontSize > normalType.en,
        `1440 normal font ${normalType.en}px must be smaller than 1440 watch font ${watchType.en.fontSize}px`,
    );
    assert.ok(
        watchType.en.fontSize > watchType.zh.fontSize,
        `watch English ${watchType.en.fontSize}px must stay above Chinese ${watchType.zh.fontSize}px`,
    );
    assert.ok(
        watchType.en.fontSize < 32,
        `1440 watch English ${watchType.en.fontSize}px must stay below the 32px cap so 1920 can grow`,
    );
    // The token classes are what engines without container queries fall back
    // to; an unsupported cqi drops the inline declaration, not the font size.
    const fluidFallback = await page.evaluate(() => {
        const className = (testId) => document.querySelector(`[data-testid="${testId}"]`)?.className ?? '';
        return {
            en: className('watch-subtitle-en'),
            zh: className('watch-subtitle-zh'),
            supportsCqi: CSS.supports('font-size', 'clamp(1rem, 2cqi, 2rem)'),
        };
    });
    assert.match(fluidFallback.en, /(^|\s)text-section(\s|$)/, 'English line dropped the text-section fallback');
    assert.match(fluidFallback.zh, /(^|\s)text-body-zh(\s|$)/, 'Chinese line dropped the text-body-zh fallback');
    assert.equal(fluidFallback.supportsCqi, true, 'this browser cannot check the cqi declaration');

    // — P2-17: while the learner is active the subtitle clears the native
    //   control strip; 4s of stillness docks it at the lower edge (the
    //   native controls have faded out too); pointer movement raises it
    //   again. The bottom change is a 200ms transition. —
    await page.keyboard.press('Shift');
    await page.waitForFunction(
        () => document.querySelector('[data-testid="watch-subtitle-overlay"]')?.getAttribute('data-raised') === 'true',
        null,
        { timeout: 5000 },
    );
    await sleep(260); // let the 200ms bottom transition settle
    const raisedOverlay = await subtitlePositionState(page);
    assert.ok(raisedOverlay, 'overlay geometry missing');
    assert.equal(raisedOverlay.pointerEvents, 'none', 'overlay must never intercept clicks');
    assert.ok(
        raisedOverlay.mediaBottomGap >= raisedOverlay.mediaHeight * 0.12 - 1,
        `raised overlay sits ${raisedOverlay.mediaBottomGap}px from the video bottom (<12% of ${raisedOverlay.mediaHeight})`,
    );
    assert.match(
        raisedOverlay.transitionProperty,
        /(^|[\s,])bottom([\s,]|$)/,
        `the subtitle does not transition its bottom (${raisedOverlay.transitionProperty})`,
    );
    assert.ok(
        raisedOverlay.transitionMs >= 190 && raisedOverlay.transitionMs <= 210,
        `the subtitle bottom transition is ${raisedOverlay.transitionMs}ms, expected 200ms`,
    );
    await page.waitForFunction(
        () => document.querySelector('[data-testid="watch-subtitle-overlay"]')?.getAttribute('data-dock') === 'true',
        null,
        { timeout: 7000 },
    );
    await sleep(260);
    const dockedOverlay = await subtitlePositionState(page);
    assert.ok(
        dockedOverlay.bottomGap <= dockedOverlay.parentHeight * 0.03 + 1,
        `docked overlay sits ${dockedOverlay.bottomGap}px above the lower edge (>6% of ${dockedOverlay.parentHeight})`,
    );
    assert.ok(
        raisedOverlay.bottomGap - dockedOverlay.bottomGap >= raisedOverlay.parentHeight * 0.08,
        'the subtitle did not visibly drop between the raised and docked positions',
    );
    const railBoxForPointer = await boxOf(page, 'watch-gloss-rail');
    await page.mouse.move((railBoxForPointer?.x ?? 1200) + 60, 360);
    await page.waitForFunction(
        () => document.querySelector('[data-testid="watch-subtitle-overlay"]')?.getAttribute('data-raised') === 'true',
        null,
        { timeout: 5000 },
    );
    await sleep(260);
    const raisedAgain = await subtitlePositionState(page);
    assert.ok(
        Math.abs(raisedAgain.bottomGap - raisedOverlay.bottomGap) <= 2,
        `pointer movement did not restore the raised position (${raisedAgain.bottomGap} vs ${raisedOverlay.bottomGap})`,
    );

    // P2-15 §3: the YouTube embed keeps its native control bar and native CC
    // entry. The watch shell adds no transport UI of its own, and the raised
    // subtitle scrim must clear the bottom strip those native controls live in.
    assert.equal(await page.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'retired fullscreen button is still mounted');
    assert.equal(await page.locator('[data-testid="watch-mode-toggle"]').count(), 0, 'the entry toggle must not sit over the picture in watch mode');
    assert.equal(
        await page.locator('[data-testid="watch-stage"] input[type="range"]').count(),
        0,
        'no custom transport/progress bar may be added — the native YouTube controls stay authoritative',
    );
    assert.ok(
        !(await page.locator('[data-testid="watch-stage"] [data-testid*="progress"]').count()),
        'a custom progress control appeared in the watch stage',
    );
    const mediaBox = await boxOf(page, 'video-area');
    const playerSurface = await boxOf(page, 'video-player');
    assert.ok(playerSurface, 'player surface missing');
    assert.ok(
        Math.abs(playerSurface.width - mediaBox.width) < 2 && Math.abs(playerSurface.height - mediaBox.height) < 2,
        'the player surface no longer fills the 16:9 media box — the native YouTube control bar and its native CC entry need that space',
    );
    assert.ok(
        raisedAgain.mediaBottomGap >= raisedAgain.mediaHeight * 0.12 - 1,
        'the subtitle scrim intrudes into the bottom strip where the native controls live',
    );

    // — gloss rail content matches the analysis; history may already contain
    //   more than one cue after the 4s dock wait (P2-18), so do not pin count=1.
    const glossWordTexts = await page.locator('[data-testid="watch-gloss-word"]').allInnerTexts();
    assert.ok(glossWordTexts.length >= 1, 'gloss rail lost the current word');
    // P2-17: the title grew slightly along with the row type.
    const glossTitleFont = await page.evaluate(() => parseFloat(
        getComputedStyle(document.querySelector('[data-testid="watch-gloss-rail"] h2')).fontSize,
    ));
    assert.ok(glossTitleFont >= 18, `the gloss rail title is only ${glossTitleFont}px`);
    assert.ok(glossWordTexts.some((text) => text.includes('habits')), 'gloss rail lost habits');
    assert.ok(glossWordTexts.some((text) => text.includes('习惯')), 'gloss rail lost the habits gloss');
    assert.ok((await page.locator('[data-testid="watch-gloss-language-point"]').count()) <= 1, 'unexpected language-point history');
    // P2-12: the sentence context, the current-sentence dot, the words /
    // language-point headings and any empty placeholder are gone.
    assert.equal(await page.locator('[data-testid="watch-gloss-entry-context"]').count(), 0, 'sentence context line must be gone');
    assert.equal(await page.locator('[data-testid="watch-gloss-entry-current"]').count(), 0, 'current-sentence dot must be gone');
    assert.equal(await page.locator('[data-testid="watch-gloss-rail"] h3').count(), 0, 'gloss section headings must be gone');
    assert.equal(await page.locator('[data-testid="watch-gloss-empty"]').count(), 0, 'global gloss placeholder must be gone');

    // — the overlay follows playback into cue 1 (no seek) —
    await waitForOverlay(page, 'A short walk', 12000);
    await waitForRailText(page, '早餐', 12000);
    await pausePlayback(page);
    assert.equal(await page.locator('[data-testid="watch-gloss-language-point"]').count(), 1);
    const point = page.locator('[data-testid="watch-gloss-language-point"]').first();
    const pointText = await point.innerText();
    assert.ok(pointText.includes('before breakfast') && pointText.includes('早餐前'), `language point mismatch: ${pointText}`);
    // P2-12: the idiom/culture kind badge (and its data-kind hook) is gone.
    assert.equal(await point.getAttribute('data-kind'), null, 'language point still exposes a kind badge hook');
    assert.ok(!pointText.includes('习语') && !pointText.includes('文化'), `language point still shows a kind badge: ${pointText}`);

    // — P2-17: inside cue 1 the idiom contains the glossed word "breakfast".
    //   Language points win, so one blue range covers the phrase and no amber
    //   fragment leaks out; the full sentence text is preserved. —
    const cue1Highlight = await subtitleHighlightState(page);
    assert.ok(cue1Highlight, 'cue 1 subtitle highlight state missing');
    assert.equal(
        cue1Highlight.text,
        'A short walk before breakfast makes the whole day feel slower.',
        'the subtitle highlight changed the cue 1 text',
    );
    assert.equal(
        cue1Highlight.highlights.length,
        1,
        'overlapping word + idiom ranges must collapse to one highlight (idiom wins)',
    );
    assert.equal(cue1Highlight.highlights[0].text, 'before breakfast');
    assert.equal(cue1Highlight.highlights[0].kind, 'point');
    assert.match(cue1Highlight.highlights[0].className, /(^|\s)bg-sky-400\/20(\s|$)/, 'the idiom is not blue');
    assert.match(cue1Highlight.highlights[0].className, /(^|\s)text-sky-100(\s|$)/, 'the idiom lost the blue text tone');

    // — P2-17: vocabulary and language points share one row layout: label on
    //   the left, definition right-aligned on the SAME line, both fluid. —
    const cue1GlossRows = await glossRowState(page);
    assert.equal(cue1GlossRows.currentRows.length, 2, 'cue 1 (current entry) should show one word row and one language-point row');
    assert.ok(cue1GlossRows.wordRow && cue1GlossRows.pointRow, 'cue 1 lost its word or language-point row');
    for (const row of [cue1GlossRows.wordRow, cue1GlossRows.pointRow]) {
        assert.ok(row.sameLine, `${row.testId}: the definition is not on the same line as the label`);
        assert.equal(row.definitionRect.textAlign, 'right', `${row.testId}: the definition is not right-aligned`);
    }
    assert.ok(
        cue1GlossRows.wordFont >= 18 && cue1GlossRows.wordFont <= 21,
        `1440 gloss word font ${cue1GlossRows.wordFont}px is not the ~19.5px fluid tier`,
    );
    assert.ok(
        cue1GlossRows.definitionFont >= 15 && cue1GlossRows.definitionFont <= 17,
        `1440 gloss definition font ${cue1GlossRows.definitionFont}px is not the ~16px fluid tier`,
    );

    // ═════════════════════════════════════════════════════════════════════
    // P2-15 §4 — 字幕三态: bilingual | english | off (persisted, C, CC menu)
    // ═════════════════════════════════════════════════════════════════════
    assert.deepEqual(
        await subtitleModeState(page),
        { toggleMode: 'bilingual', stored: 'bilingual', overlay: 'bilingual', en: true, zh: true },
        'the default subtitle mode must be bilingual and persisted',
    );
    // Remember the exact current sentence and the player DOM node: switching
    // the caption mode must neither reload the embed nor lose the playhead.
    await page.evaluate(() => {
        window.__watchPlayerNode = document.querySelector('[data-testid="video-player"]');
        window.__watchOverlayEn = (document.querySelector('[data-testid="watch-subtitle-en"]')?.textContent ?? '').trim();
    });
    assert.ok((await page.evaluate(() => window.__watchOverlayEn)).includes('A short walk'));

    // — CC menu: three options + the native-caption coexistence copy —
    await openSubtitleMenu(page);
    assert.equal(await page.locator('[data-testid="watch-subtitle-menu"] [role="menuitemradio"]').count(), 3, 'CC menu must offer exactly three subtitle modes');
    assert.deepEqual(
        await page.locator('[data-testid="watch-subtitle-menu"] [role="menuitemradio"]').evaluateAll((items) => items.map((item) => item.getAttribute('aria-checked'))),
        ['true', 'false', 'false'],
        'the current subtitle mode is not checked in the CC menu',
    );
    const nativeHint = await page.locator('[data-testid="watch-subtitle-native-hint"]').innerText();
    assert.ok(nativeHint.includes('原生字幕'), `the CC menu lost the native-caption coexistence copy: ${nativeHint}`);
    assert.ok(nativeHint.includes('关闭'), `the native-caption copy no longer points at 关闭: ${nativeHint}`);
    summary.screenshots.push(shot('1440-subtitle-menu'));
    await page.screenshot({ path: shot('1440-subtitle-menu') });

    // — english: only the English line, same sentence, embed untouched —
    await page.locator('[data-testid="watch-subtitle-mode-english"]').click();
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'english', null, { timeout: 5000 });
    let subtitleState = await subtitleModeState(page);
    assert.equal(subtitleState.toggleMode, 'english');
    assert.equal(subtitleState.overlay, 'english');
    assert.equal(subtitleState.en, true, '仅英文 must keep the English line');
    assert.equal(subtitleState.zh, false, '仅英文 must hide the Chinese line');
    assert.equal(
        await page.evaluate(() => window.__watchPlayerNode === document.querySelector('[data-testid="video-player"]')),
        true,
        'switching the subtitle mode remounted the player',
    );
    assert.equal(
        await page.evaluate(() => (document.querySelector('[data-testid="watch-subtitle-en"]')?.textContent ?? '').trim()),
        await page.evaluate(() => window.__watchOverlayEn),
        'switching the subtitle mode moved the playhead / changed the sentence',
    );
    summary.screenshots.push(shot('1440-english'));
    await page.screenshot({ path: shot('1440-english') });

    // — off: no overlay at all, the native captions are usable, the gloss
    //   window keeps working (P2-16 will redesign it; this phase must not
    //   couple it to the overlay). —
    await chooseSubtitleMode(page, 'off');
    subtitleState = await subtitleModeState(page);
    assert.equal(subtitleState.toggleMode, 'off');
    assert.equal(subtitleState.overlay, null, 'off must not render the subtitle overlay');
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0, 'off must not mount the overlay');
    assert.equal(await page.locator('[data-testid="watch-gloss-rail"]').count(), 1, 'the gloss window must stay available with subtitles off');
    assert.ok(await page.locator('[data-testid="watch-gloss-word"]').count() >= 2, 'the gloss window emptied when the subtitles were switched off');
    summary.screenshots.push(shot('1440-off'));
    await page.screenshot({ path: shot('1440-off') });

    // — C cycles 关闭 → 双语 → 仅英文 → 关闭, without a reload —
    await page.keyboard.press('c');
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'bilingual', null, { timeout: 5000 });
    subtitleState = await subtitleModeState(page);
    assert.equal(subtitleState.overlay, 'bilingual');
    assert.equal(subtitleState.en, true);
    assert.equal(subtitleState.zh, true);
    assert.equal(await page.evaluate(() => window.__watchPlayerNode === document.querySelector('[data-testid="video-player"]')), true, 'the C shortcut remounted the player');
    assert.ok((await overlayText(page)).includes('A short walk'), 'the C shortcut lost the current sentence');
    await page.keyboard.press('c');
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'english', null, { timeout: 5000 });
    assert.equal(await page.locator('[data-testid="watch-subtitle-zh"]').count(), 0, 'C did not hide the Chinese line in 仅英文');
    await page.keyboard.press('c');
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'off', null, { timeout: 5000 });
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0, 'C did not reach 关闭');
    await page.keyboard.press('c');
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'bilingual', null, { timeout: 5000 });
    assert.deepEqual(await subtitleModeState(page), { toggleMode: 'bilingual', stored: 'bilingual', overlay: 'bilingual', en: true, zh: true });

    // — the CC menu is keyboard operable: ArrowDown opens, arrows move, Enter
    //   selects, Esc closes without changing the preference —
    await revealWatchTopbar(page);
    await page.locator('[data-testid="watch-subtitle-toggle"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'watch-subtitle-mode-bilingual', 'the checked mode is not focused on open');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'watch-subtitle-mode-english', 'ArrowDown did not move through the CC menu');
    await page.keyboard.press('Enter');
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'detached', timeout: 5000 });
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode') === 'english', null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-testid')), 'watch-subtitle-toggle', 'selecting a mode did not return focus to the CC trigger');
    await openSubtitleMenu(page);
    await page.keyboard.press('Escape');
    await page.locator('[data-testid="watch-subtitle-menu"]').waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode')), 'english', 'Esc must close the CC menu without changing the mode');
    await chooseSubtitleMode(page, 'bilingual');
    assert.equal(await page.locator('[data-testid="watch-subtitle-zh"]').count(), 1, 'restoring 双语 did not bring the Chinese line back');

    // ═════════════════════════════════════════════════════════════════════
    // P2-16 §4.3 — favorite star on hover/focus, one-click vocabulary draft
    // ═════════════════════════════════════════════════════════════════════
    const railHint = await page.locator('[data-testid="watch-gloss-rail-hint"]').innerText();
    assert.ok(railHint.includes('30'), `the rail lost its history hint: ${railHint}`);
    assert.equal(
        await page.locator('[data-testid="watch-gloss-rail"] button:not([data-testid="watch-gloss-favorite"]):not([data-testid="watch-gloss-mastered"])').count(),
        0,
        'the rail must not show unimplemented / settings actions',
    );
    const breakfastRow = page.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    assert.equal(await breakfastRow.count(), 1, 'cue 1 has no breakfast row for the favorite check');
    const breakfastStar = breakfastRow.locator('[data-testid="watch-gloss-favorite"]');
    assert.ok(await breakfastStar.count(), 'the word row has no favorite star');
    // The star is part of the hover/focus disclosure, not permanent chrome.
    await page.mouse.move(720, 300);
    await sleep(150);
    assert.equal(
        parseFloat(await breakfastStar.evaluate((el) => getComputedStyle(el).opacity)),
        0,
        'the favorite star is visible before hover/focus',
    );
    await breakfastRow.hover();
    await page.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            const star = row?.querySelector('[data-testid="watch-gloss-favorite"]');
            return Boolean(star) && parseFloat(getComputedStyle(star).opacity) > 0.9;
        },
        null,
        { timeout: 5000 },
    );
    await breakfastStar.focus();
    assert.ok(
        parseFloat(await breakfastStar.evaluate((el) => getComputedStyle(el).opacity)) > 0.9,
        'the favorite star does not appear on keyboard focus',
    );
    assert.equal(await breakfastStar.getAttribute('data-favorited'), 'false');
    // — P2-19: the 已掌握 circle+check is a sibling of the star in the same
    //   `ml-auto` action group, revealed by the same hover/focus. It starts
    //   unchecked and names itself with the row's word. —
    const breakfastMastered = breakfastRow.locator('[data-testid="watch-gloss-mastered"]');
    assert.equal(await breakfastMastered.count(), 1, 'the word row has no 已掌握 toggle');
    assert.equal(await breakfastMastered.getAttribute('data-mastered'), 'false');
    assert.equal(await breakfastMastered.getAttribute('aria-pressed'), 'false');
    assert.match(
        await breakfastMastered.getAttribute('aria-label') ?? '',
        /breakfast/,
        'the 已掌握 aria-label does not name the word',
    );
    assert.equal(
        await breakfastMastered.locator('[data-testid="watch-gloss-mastered-indicator"]').getAttribute('data-state'),
        'unchecked',
    );
    const masteredActionGeometry = await breakfastRow.evaluate((row) => {
        const star = row.querySelector('[data-testid="watch-gloss-favorite"]');
        const check = row.querySelector('[data-testid="watch-gloss-mastered"]');
        const group = check?.parentElement ?? null;
        const box = (el) => {
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, centerY: rect.y + rect.height / 2 };
        };
        return {
            star: star ? box(star) : null,
            check: check ? box(check) : null,
            groupClass: group?.getAttribute('class') ?? '',
            groupDisplay: group ? getComputedStyle(group).display : null,
            starOpacity: star ? parseFloat(getComputedStyle(star).opacity) : null,
            checkOpacity: check ? parseFloat(getComputedStyle(check).opacity) : null,
        };
    });
    assert.ok(
        masteredActionGeometry.star && masteredActionGeometry.check,
        `star / 已掌握 box missing: ${JSON.stringify(masteredActionGeometry)}`,
    );
    assert.ok(
        masteredActionGeometry.groupClass.includes('ml-auto'),
        'the star and 已掌握 do not share the ml-auto action group',
    );
    assert.equal(masteredActionGeometry.groupDisplay, 'flex', 'the action group is not a single row');
    assert.ok(
        Math.abs(masteredActionGeometry.star.centerY - masteredActionGeometry.check.centerY) <= 1.5,
        'the 已掌握 toggle is not aligned with the star',
    );
    assert.ok(
        masteredActionGeometry.star.right <= masteredActionGeometry.check.x + 1,
        'the 已掌握 toggle is not beside the star',
    );
    assert.ok(
        masteredActionGeometry.star.height >= 31 && masteredActionGeometry.star.height <= 33,
        `the rail star is not the 32px control (${masteredActionGeometry.star.height}px)`,
    );
    assert.ok(
        masteredActionGeometry.checkOpacity > 0.9 && masteredActionGeometry.starOpacity > 0.9,
        'the action group is not revealed by row hover/focus',
    );
    await breakfastStar.click();
    await page.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-favorite"]')?.getAttribute('data-favorited') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    assert.match(
        await breakfastStar.locator('svg').getAttribute('class'),
        /fill-warning-fg/,
        'the saved star is not filled',
    );
    const favoriteDeadline = Date.now() + 5000;
    let favoritePost = null;
    while (Date.now() < favoriteDeadline && !favoritePost) {
        favoritePost = favoriteWrites.find(
            (entry) => entry.method === 'POST' && entry.body?.id === `vocab-${VIDEO_ID}-breakfast`,
        ) ?? null;
        if (!favoritePost) await sleep(50);
    }
    assert.ok(favoritePost, 'the favorite star did not POST a vocabulary favorite');
    assert.equal(favoritePost.body.type, 'vocabulary');
    assert.equal(favoritePost.body.videoId, VIDEO_ID);
    assert.equal(favoritePost.body.text, 'breakfast');
    assert.equal(favoritePost.body.translation, '早餐');
    assert.equal(favoritePost.body.time, 12, 'the favorite start must be the current block start');
    assert.equal(
        favoritePost.body.meta?.context_en,
        'A short walk before breakfast makes the whole day feel slower.',
        'the favorite lost the current-sentence context',
    );
    assert.equal(favoritePost.body.meta?.source_kind, 'video');
    assert.equal(favoritePost.body.meta?.source_ref, VIDEO_ID);
    assert.equal(favoritePost.body.meta?.source_title, 'Watch Mode Acceptance');
    summary.screenshots.push(shot('1440-gloss-favorite'));
    await page.screenshot({ path: shot('1440-gloss-favorite') });

    // — P2-09 history: cue 1 on top, cue 0 still below, no repetition —
    await waitForGlossEntries(page, 2);
    await waitForCurrentEntry(page, '1');
    assert.deepEqual(await glossBlockIds(page), ['1', '0'], 'cue 1 should sit above cue 0');
    // P2-16: current sentence full strength, history dimmed (oldest faintest).
    const historyOpacity = await page.locator('[data-testid="watch-gloss-entry"]').evaluateAll(
        (entries) => entries.map((entry) => ({
            current: entry.getAttribute('data-current'),
            opacity: parseFloat(getComputedStyle(entry).opacity),
        })),
    );
    assert.equal(historyOpacity[0].current, 'true');
    assert.equal(historyOpacity[0].opacity, 1, 'the current sentence must not be dimmed');
    assert.ok(
        historyOpacity[1].opacity < 0.75 && historyOpacity[1].opacity >= 0.3,
        `history opacity ${historyOpacity[1].opacity} is outside the .3–.75 fade band`,
    );
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'words from both sentences should remain visible');
    assert.ok(
        (await page.locator('[data-testid="watch-gloss-word"]').allInnerTexts()).some((text) => text.includes('habits')),
        'earlier word habits disappeared from the history',
    );
    const railText = await page.locator('[data-testid="watch-gloss-rail"]').innerText();
    assert.ok(!railText.includes('A short walk') && !railText.includes('Small habits'), 'sentence context is still rendered in the rail');
    assert.ok(!railText.includes('生词') && !railText.includes('语言点'), 'gloss section headings are still rendered');
    await assertGlossListChrome(page, 'watch-gloss-rail', '1440 rail');
    const cue1Scroll = await scrollMetrics(page);
    assert.equal(cue1Scroll.scrollTop, 0, 'a new sentence should leave the window at the top');

    // — seek to cue 2: the empty sentence adds NO entry and NO placeholder —
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'Nobody moves');
    await pausePlayback(page);
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="watch-gloss-entry"][data-current="true"]').length === 0,
        null,
        { timeout: 5000 },
    );
    await waitForGlossEntries(page, 2);
    assert.equal(await page.locator('[data-testid="watch-gloss-empty"]').count(), 0, 'empty sentence must not render a placeholder');
    assert.equal(await page.locator('[data-testid="watch-gloss-entry-empty"]').count(), 0, 'empty sentence must not render an entry placeholder');
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'earlier words must survive an empty sentence');
    const cue2RailText = await page.locator('[data-testid="watch-gloss-rail"]').innerText();
    assert.ok(!cue2RailText.includes('本句无生词'), 'the no-gloss placeholder text is still rendered');
    assert.ok(!cue2RailText.includes('Nobody moves'), 'the empty sentence context is still rendered');
    summary.screenshots.push(shot('1440-history'));
    await page.screenshot({ path: shot('1440-history') });

    // — revisit cue 1 and cue 0: moved to the top, never inserted twice —
    await page.keyboard.press('ArrowLeft');
    await waitForOverlay(page, 'A short walk');
    await pausePlayback(page);
    await waitForCurrentEntry(page, '1');
    assert.equal(await glossEntryCount(page), 2, 'revisiting a sentence must not duplicate it');
    assert.deepEqual(await glossBlockIds(page), ['1', '0'], 'revisited cue 1 did not move to the top');
    await page.keyboard.press('ArrowLeft');
    await waitForOverlay(page, 'Small habits');
    await pausePlayback(page);
    await waitForCurrentEntry(page, '0');
    assert.equal(await glossEntryCount(page), 2, 'revisiting cue 0 duplicated the history');
    assert.deepEqual(await glossBlockIds(page), ['0', '1'], 'revisited cue 0 did not move to the top');
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'A short walk');
    await pausePlayback(page);
    await waitForCurrentEntry(page, '1');
    assert.equal(await glossEntryCount(page), 2, 'moving forward duplicated an existing sentence');
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'history lost a word after the revisit');

    // — turn watch mode off through the floating top bar: stacked/split layout,
    //   both app chromes and the teaching panel return —
    await exitWatchMode(page);
    // P2-10: leaving the mode also leaves page fullscreen (the stub is still on).
    await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__fsStub.exits), 1, 'leaving watch mode must call exitFullscreen');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off');
    assert.equal(await page.locator('[data-testid="watch-topbar"]').count(), 0, 'the floating top bar must unmount when watch mode ends');
    assert.equal(await page.locator('[data-testid="top-bar"]').count(), 1, 'the AppShell top bar did not come back after watch mode');
    assert.equal(await page.locator('[data-testid="learning-header"]').count(), 1, 'the LearningHeader did not come back after watch mode');
    // P2-16: the App top-bar word-book count already reflects the watch star
    // (favorites are one App-owned store; no separate watch list).
    assert.equal(
        (await page.locator('[data-testid="reading-wordbook-count"]').innerText()).trim(),
        '1',
        'the App top-bar favorites count did not sync with the watch favorite',
    );
    assert.equal(await page.locator('[data-testid="watch-gloss-rail"]').count(), 0);
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0);
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 1, 'split layout not restored after watch off');
    assert.equal(await page.locator('[data-testid="right-column"] [data-testid="transcript-column"]').count(), 1, 'split transcript pane missing');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_transcript_layout')), 'split');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_split_ratio')), '60');

    // — persistence across a reload: watch mode AND the subtitle preference —
    await enterWatchMode(page);
    // Park the caption preference on 仅英文 so the reload has to restore a
    // non-default mode, not merely fall back to bilingual.
    await chooseSubtitleMode(page, 'english');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off', 'persisted watch mode must not auto-request fullscreen on reload');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'on');
    assert.equal(await page.locator('[data-testid="top-bar"]').count(), 0, 'reloading in watch mode rendered the AppShell top bar');
    assert.equal(await page.locator('[data-testid="learning-header"]').count(), 0, 'reloading in watch mode rendered the LearningHeader');
    assert.ok(await page.locator('[data-testid="watch-topbar"]').count(), 'reloading in watch mode lost the floating top bar');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_subtitle_mode')), 'english', 'the subtitle preference did not persist across a reload');
    assert.equal(await page.getAttribute('[data-testid="watch-subtitle-toggle"]', 'data-mode'), 'english', 'the reloaded top bar did not restore 仅英文');

    await seekToGlossedCue(page);
    await page.waitForFunction(
        () => document.querySelector('[data-testid="watch-gloss-word"]') !== null,
        null,
        { timeout: 10000 },
    );
    assert.equal(await page.locator('[data-testid="watch-subtitle-en"]').count(), 1, '仅英文 did not survive the reload');
    assert.equal(await page.locator('[data-testid="watch-subtitle-zh"]').count(), 0, '仅英文 showed the Chinese line after the reload');
    // Back to the default for the screenshot and the remaining checks.
    await chooseSubtitleMode(page, 'bilingual');
    assert.equal(await page.locator('[data-testid="watch-subtitle-zh"]').count(), 1, 'bilingual did not restore the Chinese line');

    // — P2-16: the favorite survived the reload (real GET), and a one-click
    //   remove takes the filled star back to empty. —
    if (!(await overlayText(page))?.includes('A short walk')) {
        await page.keyboard.press('ArrowRight');
        await waitForOverlay(page, 'A short walk');
    }
    await waitForRailText(page, '早餐');
    await pausePlayback(page);
    const persistedRow = page.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    const persistedStar = persistedRow.locator('[data-testid="watch-gloss-favorite"]');
    await persistedRow.hover();
    assert.equal(await persistedStar.getAttribute('data-favorited'), 'true', 'the favorite did not survive the reload');
    await persistedStar.click();
    await page.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-favorite"]')?.getAttribute('data-favorited') === 'false';
        },
        null,
        { timeout: 5000 },
    );
    const removeDeadline = Date.now() + 5000;
    let favoriteDelete = null;
    while (Date.now() < removeDeadline && !favoriteDelete) {
        favoriteDelete = favoriteWrites.find(
            (entry) => entry.method === 'DELETE' && entry.path.includes(`vocab-${VIDEO_ID}-breakfast`),
        ) ?? null;
        if (!favoriteDelete) await sleep(50);
    }
    assert.ok(favoriteDelete, 'the filled star did not DELETE the favorite');
    summary.screenshots.push(shot('1440'));
    await page.screenshot({ path: shot('1440') });

    // — no analysis: explicit empty state + the existing 028 entry (GET only) —
    const beforeEmptyCalls = apiRequests.filter((entry) => entry.path.includes('/api/teaching-analysis/')).length;
    await page.evaluate(() => { window.location.hash = '#/app/content/learn/youtube/acceptance-watch-empty'; });
    await page.locator('[data-testid="watch-gloss-no-analysis"]').waitFor({ state: 'visible', timeout: 20000 });
    assert.ok((await page.locator('[data-testid="watch-gloss-no-analysis"]').innerText()).includes('本片还没有词条'));
    // P2-16: the empty state is one compact explanation + the existing generate
    // entry — it must not stretch to fill the 360px rail.
    const emptyBox = await boxOf(page, 'watch-gloss-no-analysis');
    const emptyRail = await boxOf(page, 'watch-gloss-rail');
    assert.ok(emptyBox && emptyRail, 'no-analysis state / rail missing');
    assert.ok(emptyBox.height < 220, `the no-analysis state fills the rail (${emptyBox.height}px tall)`);
    assert.ok(Math.abs(emptyRail.width - 360) <= 1, 'the 360px rail changed in the no-analysis state');
    assert.equal(await page.locator('[data-testid="watch-gloss-generate"]').count(), 1, 'the no-analysis state lost the generate entry');
    await page.locator('[data-testid="watch-gloss-generate"]').click();
    const refetchDeadline = Date.now() + 10000;
    while (
        apiRequests.filter((entry) => entry.path.includes('/api/teaching-analysis/')).length <= beforeEmptyCalls
        && Date.now() < refetchDeadline
    ) {
        await sleep(100);
    }
    assert.ok(
        apiRequests.filter((entry) => entry.path.includes('/api/teaching-analysis/')).length > beforeEmptyCalls,
        'the existing 028 entry did not refetch the analysis',
    );
    await page.locator('[data-testid="watch-gloss-no-analysis"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await page.locator('[data-testid="watch-gloss-no-analysis"]').innerText()).includes('本片还没有词条'));

    // — zero new AI: every teaching-analysis request is a GET; no processing —
    const analysisCalls = apiRequests.filter((entry) => entry.path.includes('/api/teaching-analysis/'));
    assert.ok(analysisCalls.length >= 2, `expected the 028 entry to refetch, got ${analysisCalls.length}`);
    assert.deepEqual(
        analysisCalls.filter((entry) => entry.method !== 'GET'),
        [],
        'teaching-analysis must stay read-only',
    );
    const aiCalls = apiRequests.filter((entry) => /^\/api\/(process-|translate|define|quiz|course)/.test(entry.path));
    assert.deepEqual(aiCalls, [], `unexpected AI/processing calls: ${JSON.stringify(aiCalls)}`);

    // — P2-16: removing the watch favorite also rolls the App top-bar count
    //   back (same store, one source of truth). —
    await exitWatchMode(page);
    assert.equal(
        (await page.locator('[data-testid="reading-wordbook-count"]').innerText()).trim(),
        '0',
        'the App top-bar favorites count did not roll back after the watch remove',
    );

    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    summary.desktop = {
        railWidth: Math.round(rail.width * 10) / 10,
        videoColumnWidth: Math.round(videoColumn.width * 10) / 10,
        overlayBottomGap: Math.round(raisedOverlay.bottomGap * 10) / 10,
        mediaHeight: Math.round((mediaStageWatch?.height ?? 0) * 10) / 10,
        analysisRequests: analysisCalls.length,
        subtitleFontPx: { en: subtitleTypography.en.fontSize, zh: subtitleTypography.zh.fontSize },
        p2_17: {
            subtitleDock: {
                raisedBottomGap: Math.round(raisedOverlay.bottomGap * 10) / 10,
                dockedBottomGap: Math.round(dockedOverlay.bottomGap * 10) / 10,
                transitionMs: raisedOverlay.transitionMs,
                pointerRestoresRaised: 'pass',
            },
            subtitleHighlight: {
                word: cue0Highlight.highlights[0]?.text,
                wordClass: 'bg-amber-400/20 text-amber-100',
                point: cue1Highlight.highlights[0]?.text,
                pointClass: 'bg-sky-400/20 text-sky-100',
                pointWinsOverWord: cue1Highlight.highlights.length === 1,
                textPreserved: cue1Highlight.text === 'A short walk before breakfast makes the whole day feel slower.',
                injection: 'none (text slices, no dangerouslySetInnerHTML)',
            },
            glossRows: {
                wordFont1440: cue1GlossRows.wordFont,
                definitionFont1440: cue1GlossRows.definitionFont,
                wordSameLine: cue1GlossRows.wordRow?.sameLine ?? false,
                pointSameLine: cue1GlossRows.pointRow?.sameLine ?? false,
                definitionAlign: 'right',
                titleFont: glossTitleFont,
            },
        },
        fluidType: {
            normal1440: {
                en: normalType.en,
                zh: normalType.zh,
                mediaWidth: Math.round(normalType.mediaWidth * 10) / 10,
            },
            watch1440: {
                en: subtitleTypography.en.fontSize,
                zh: subtitleTypography.zh.fontSize,
                mediaWidth: Math.round(watchType.mediaWidth * 10) / 10,
            },
        },
        history: {
            accumulated: 2,
            dedupe: 'pass',
            emptySentence: 'skipped',
            currentOpacity: historyOpacity[0].opacity,
            olderOpacity: Math.round(historyOpacity[1].opacity * 100) / 100,
        },
        glossRoll: {
            title: '滚动词条',
            railWidth: Math.round(rail.width * 10) / 10,
            headerCount: '本句 1',
            currentPinned: 'top',
            currentMarker: '2px bar (no border)',
            historyFade: 'opacity .55 → .32 by age',
            sentenceContext: 'removed',
            sectionHeadings: 'removed',
            kindBadge: 'removed',
            emptyPlaceholder: 'removed',
            entryChrome: 'borderless',
        },
        favorites: {
            star: 'hover/focus on rail, always visible in drawer',
            addWrite: `${favoritePost.method} ${favoritePost.body?.id}`,
            start: favoritePost.body?.time,
            contextEn: favoritePost.body?.meta?.context_en,
            source: `${favoritePost.body?.meta?.source_kind}/${favoritePost.body?.meta?.source_ref}/${favoritePost.body?.meta?.source_title}`,
            topbarCountAfterAdd: 1,
            removeWrite: favoriteDelete ? `${favoriteDelete.method} ${favoriteDelete.path}` : 'DELETE',
            topbarCountAfterRemove: 0,
            failure: 'inline rollback (add + remove)',
            guest: 'login hint; no write, no invented words',
        },
        // P2-15: immersive shell / stage / subtitle modes / native controls.
        immersiveShell: {
            appTopbar: 'not rendered',
            learningHeader: 'not rendered',
            watchTopbar: 'floating',
            topbarButtons: topbarInitial.buttons,
            idleFadeMs: 2500,
            idleOpacity: Math.round(faded.opacity * 100) / 100,
        },
        stage: {
            stageWidth: Math.round(watchGeometry.stage.width * 10) / 10,
            stageHeight: Math.round(watchGeometry.stage.height * 10) / 10,
            videoWidth: Math.round(watchGeometry.video.width * 10) / 10,
            videoHeight: Math.round(watchGeometry.video.height * 10) / 10,
            centred: 'both axes',
            ambient: { gradient: watchGeometry.ambientGradient, blur: watchGeometry.ambientBlur },
            overflow: watchGeometry.documentWidth <= watchGeometry.viewport.width + 1 ? 'none' : 'overflow',
        },
        subtitleModes: {
            values: ['bilingual', 'english', 'off'],
            default: 'bilingual',
            key: 'yt_bilingual_watch_subtitle_mode',
            persisted: 'english allowed to survive a reload',
            cycleKey: 'C',
            nativeCaptionHint: 'visible',
            overlayOff: 'not mounted',
            playerRemountOnSwitch: 'no',
            glossWhileOff: 'available',
        },
        nativeControls: {
            youtubeControlBar: 'kept',
            nativeCcEntry: 'kept',
            customTransport: 'none',
            iframeCcState: 'never read or controlled',
        },
    };
    await desktop.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-19: the mastered toggle PATCHes the server, re-reads the
    // mastered list (not a local echo), keeps history rows in sync, survives a
    // reload, and enforces the favorite mutual exclusion. `breakfast` starts
    // with a seeded favorite so the first mark has a favorite to remove.
    // ═════════════════════════════════════════════════════════════════════
    const masteredContext = await createContext(browser, {
        watchOn: true,
        favoritesSeed: [{
            id: `vocab-${VIDEO_ID}-breakfast`,
            type: 'vocabulary',
            videoId: VIDEO_ID,
            start: 12,
            en_text: 'breakfast',
            zh_text: '早餐',
            added_at: 1763000000000,
        }],
    });
    const masteredPage = await masteredContext.newPage();
    const masteredErrors = [];
    const masteredPatches = [];
    const masteredReads = [];
    const masteredFavoriteWrites = [];
    masteredPage.on('pageerror', (error) => masteredErrors.push(String(error)));
    masteredPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/review/words') {
            if (request.method() === 'PATCH') {
                try { masteredPatches.push(request.postDataJSON()); } catch { masteredPatches.push(null); }
            } else if (url.searchParams.get('mastered') === '1') {
                masteredReads.push(url.search);
            }
        }
        if (url.pathname.startsWith('/api/favorites') && request.method() !== 'GET') {
            let body = null;
            try { body = request.postDataJSON(); } catch { body = null; }
            masteredFavoriteWrites.push({ method: request.method(), path: url.pathname, body });
        }
    });
    await openVideo(masteredPage, VIDEO_ID);
    await seekToGlossedCue(masteredPage);
    await pausePlayback(masteredPage);
    if (!(await overlayText(masteredPage))?.includes('A short walk')) {
        await masteredPage.keyboard.press('ArrowRight');
        await waitForOverlay(masteredPage, 'A short walk');
        await pausePlayback(masteredPage);
    }
    await waitForRailText(masteredPage, '早餐');
    const masteredRow = masteredPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    const masteredBtn = masteredRow.locator('[data-testid="watch-gloss-mastered"]');
    await masteredRow.hover();
    assert.equal(await masteredBtn.getAttribute('data-mastered'), 'false');
    await masteredBtn.click();
    await masteredPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    // The aria/title language flips with the pressed state, and the circle is
    // the solid success-green mastered state (not a local-only tint).
    assert.equal(await masteredBtn.getAttribute('aria-pressed'), 'true');
    assert.match(await masteredBtn.getAttribute('aria-label') ?? '', /breakfast/);
    assert.equal(
        await masteredBtn.locator('[data-testid="watch-gloss-mastered-indicator"]').getAttribute('data-state'),
        'checked',
    );
    assert.match(
        await masteredBtn.locator('[data-testid="watch-gloss-mastered-indicator"]').getAttribute('class') ?? '',
        /bg-success/,
        'the mastered circle is not solid green',
    );
    const masteredWriteDeadline = Date.now() + 8000;
    let masteredMark = null;
    let masteredUnfavorite = null;
    while (Date.now() < masteredWriteDeadline && !(masteredMark && masteredUnfavorite)) {
        masteredMark = masteredPatches.find((body) => body?.lemma === 'breakfast' && body?.mastered === true) ?? null;
        masteredUnfavorite = masteredFavoriteWrites.find(
            (entry) => entry.method === 'DELETE' && entry.path.includes(`vocab-${VIDEO_ID}-breakfast`),
        ) ?? null;
        if (!masteredMark || !masteredUnfavorite) await sleep(50);
    }
    assert.ok(masteredMark, 'the mastered toggle did not PATCH /api/review/words');
    assert.equal(masteredMark.targetLang, 'zh-CN', 'the mastered PATCH lost targetLang');
    assert.equal(masteredMark.definition, '早餐', 'the mastered PATCH lost the meaning snapshot');
    assert.ok(masteredUnfavorite, 'marking mastered did not remove the same word favorite');
    await masteredPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-favorite"]')?.getAttribute('data-favorited') === 'false';
        },
        null,
        { timeout: 5000 },
    );

    // The same shared store drives history rows: go back one sentence and the
    // previous sentence's breakfast row is still pressed.
    await masteredPage.keyboard.press('ArrowLeft');
    await waitForOverlay(masteredPage, 'Small habits');
    await pausePlayback(masteredPage);
    await waitForGlossEntries(masteredPage, 2);
    const historyMasteredRow = masteredPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    assert.equal(
        await historyMasteredRow.locator('[data-testid="watch-gloss-mastered"]').getAttribute('data-mastered'),
        'true',
        'a history row lost the mastered state',
    );
    assert.ok(masteredReads.length >= 1, 'the panel never re-read GET /api/review/words?mastered=1');

    // Reload: the mark comes back from GET ?mastered=1 (server truth), not
    // from a local mirror/optimistic row.
    await masteredPage.reload({ waitUntil: 'domcontentloaded' });
    await masteredPage.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 20000 });
    await seekToGlossedCue(masteredPage);
    await pausePlayback(masteredPage);
    if (!(await overlayText(masteredPage))?.includes('A short walk')) {
        await masteredPage.keyboard.press('ArrowRight');
        await waitForOverlay(masteredPage, 'A short walk');
        await pausePlayback(masteredPage);
    }
    await waitForRailText(masteredPage, '早餐');
    const reloadedMasteredRow = masteredPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    const reloadedMasteredBtn = reloadedMasteredRow.locator('[data-testid="watch-gloss-mastered"]');
    await reloadedMasteredRow.hover();
    await masteredPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    assert.equal(await reloadedMasteredBtn.getAttribute('aria-pressed'), 'true', 'the reload lost the mastered mark');
    summary.screenshots.push(shot('1440-gloss-mastered'));
    await masteredPage.screenshot({ path: shot('1440-gloss-mastered') });

    // Unmark: PATCH mastered=false; the removed favorite must NOT come back
    // (ADR-0001: 已掌握 is not a favorite).
    const favoritePostsBeforeUnmark = masteredFavoriteWrites.filter((entry) => entry.method === 'POST').length;
    await reloadedMasteredBtn.click();
    await masteredPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'breakfast');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'false';
        },
        null,
        { timeout: 5000 },
    );
    const unmarkDeadline = Date.now() + 8000;
    let masteredUnmark = null;
    while (Date.now() < unmarkDeadline && !masteredUnmark) {
        masteredUnmark = masteredPatches.find((body) => body?.lemma === 'breakfast' && body?.mastered === false) ?? null;
        if (!masteredUnmark) await sleep(50);
    }
    assert.ok(masteredUnmark, 'unmarking did not PATCH mastered=false');
    await sleep(300);
    assert.equal(
        await reloadedMasteredRow.locator('[data-testid="watch-gloss-favorite"]').getAttribute('data-favorited'),
        'false',
        'unmarking restored the favorite (ADR-0001 forbids it)',
    );
    assert.equal(
        masteredFavoriteWrites.filter((entry) => entry.method === 'POST').length,
        favoritePostsBeforeUnmark,
        'unmarking wrote a favorite again',
    );
    await exitWatchMode(masteredPage);
    assert.equal(
        (await masteredPage.locator('[data-testid="reading-wordbook-count"]').innerText()).trim(),
        '0',
        'the App top-bar count still counts the removed favorite',
    );
    summary.mastered = {
        patch: `${masteredMark.lemma}:${masteredMark.mastered}`,
        targetLang: masteredMark.targetLang,
        definition: masteredMark.definition,
        readBack: `${masteredReads.length} × GET ?mastered=1`,
        mutualExclusion: 'mark → DELETE favorite; unmark keeps it removed',
        reload: 'pressed from GET ?mastered=1',
        aria: 'aria-pressed / data-mastered / indicator checked',
        historyRow: 'reflected',
        inlineFailureRollback: 'covered below',
        guest: 'local table only (covered below)',
    };
    assert.deepEqual(masteredErrors, [], `mastered page errors: ${JSON.stringify(masteredErrors)}`);
    await masteredContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-16: write failures roll back inline (add AND remove), guests
    // get an inline login hint instead of an invisible rejected write.
    // ═════════════════════════════════════════════════════════════════════
    const failureContext = await createContext(browser, {
        watchOn: true,
        favoritePostStatus: 500,
        favoriteDeleteStatus: 500,
        favoritesSeed: [{
            id: `vocab-${VIDEO_ID}-habits`,
            type: 'vocabulary',
            videoId: VIDEO_ID,
            start: 8,
            en_text: 'habits',
            zh_text: '习惯',
            added_at: 1763000000000,
        }],
    });
    const failurePage = await failureContext.newPage();
    const failureErrors = [];
    const failureWrites = [];
    const failurePatches = [];
    failurePage.on('pageerror', (error) => failureErrors.push(String(error)));
    failurePage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/favorites')) {
            let body = null;
            try { body = request.postDataJSON(); } catch { body = null; }
            failureWrites.push({ method: request.method(), path: url.pathname, body });
        }
        if (url.pathname === '/api/review/words' && request.method() === 'PATCH') {
            try { failurePatches.push(request.postDataJSON()); } catch { failurePatches.push(null); }
        }
    });
    await openVideo(failurePage, VIDEO_ID);
    await seekToGlossedCue(failurePage);
    await pausePlayback(failurePage);
    if (!(await overlayText(failurePage))?.includes('Small habits')) {
        await failurePage.keyboard.press('ArrowLeft');
        await waitForOverlay(failurePage, 'Small habits');
        await pausePlayback(failurePage);
    }
    await waitForRailText(failurePage, '习惯');
    const habitsRow = failurePage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'habits' });
    const habitsStar = habitsRow.locator('[data-testid="watch-gloss-favorite"]');
    await failurePage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'habits');
            return row?.querySelector('[data-testid="watch-gloss-favorite"]')?.getAttribute('data-favorited') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    await habitsRow.hover();
    await habitsStar.click();
    const removeError = habitsRow.locator('..').locator('[data-testid="watch-gloss-favorite-error"]');
    await removeError.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await removeError.innerText()).includes('取消收藏失败'), `remove failure did not explain itself inline: ${await removeError.innerText()}`);
    assert.equal(await habitsStar.getAttribute('data-favorited'), 'true', 'a failed remove must roll the filled star back');

    await failurePage.keyboard.press('ArrowRight');
    await waitForOverlay(failurePage, 'A short walk');
    await pausePlayback(failurePage);
    await waitForRailText(failurePage, '早餐');
    const addRow = failurePage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    const addStar = addRow.locator('[data-testid="watch-gloss-favorite"]');
    await addRow.hover();
    await addStar.click();
    const addError = addRow.locator('..').locator('[data-testid="watch-gloss-favorite-error"]');
    await addError.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok((await addError.innerText()).includes('收藏失败'), `add failure did not explain itself inline: ${await addError.innerText()}`);
    assert.equal(await addStar.getAttribute('data-favorited'), 'false', 'a failed add must roll the optimistic star back');
    assert.ok(
        failureWrites.some((entry) => entry.method === 'POST') && failureWrites.some((entry) => entry.method === 'DELETE'),
        'the failure run did not exercise both favorite writes',
    );

    // — P2-19 mutual exclusion rollback: PATCH true succeeds, the favorite
    //   DELETE fails, so the mark must be undone (PATCH false) and the row must
    //   say why — never leave a word both mastered and saved. —
    const failureHabitsRow = failurePage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'habits' });
    const failureHabitsMastered = failureHabitsRow.locator('[data-testid="watch-gloss-mastered"]');
    await failureHabitsRow.hover();
    await failureHabitsMastered.click();
    const masteredError = failureHabitsRow.locator('..').locator('[data-testid="watch-gloss-mastered-error"]');
    await masteredError.waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(
        (await masteredError.innerText()).includes('没能移除该词的收藏'),
        `mutex rollback did not explain itself inline: ${await masteredError.innerText()}`,
    );
    await failurePage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'habits');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'false';
        },
        null,
        { timeout: 8000 },
    );
    assert.equal(
        await failureHabitsMastered.getAttribute('aria-pressed'),
        'false',
        'a failed favorite removal left the row looking mastered',
    );
    assert.equal(
        await failureHabitsRow.locator('[data-testid="watch-gloss-favorite"]').getAttribute('data-favorited'),
        'true',
        'a failed favorite removal must keep the seeded star',
    );
    const mutexRollbackDeadline = Date.now() + 8000;
    let mutexMark = null;
    let mutexUndo = null;
    while (Date.now() < mutexRollbackDeadline && !(mutexMark && mutexUndo)) {
        mutexMark = failurePatches.find((body) => body?.lemma === 'habits' && body?.mastered === true) ?? null;
        mutexUndo = failurePatches.find((body) => body?.lemma === 'habits' && body?.mastered === false) ?? null;
        if (!mutexMark || !mutexUndo) await sleep(50);
    }
    assert.ok(mutexMark, 'the mutex run did not PATCH mastered=true');
    assert.ok(mutexUndo, 'the failed favorite removal did not roll mastered back with PATCH false');
    summary.screenshots.push(shot('1440-gloss-mastered-rollback'));
    await failurePage.screenshot({ path: shot('1440-gloss-mastered-rollback') });
    assert.deepEqual(failureErrors, [], `favorite failure page errors: ${JSON.stringify(failureErrors)}`);
    await failureContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-19: a failed mastered PATCH rolls the visual mark back and
    // explains itself inline; no favorite is touched.
    // ═════════════════════════════════════════════════════════════════════
    const masteredFailContext = await createContext(browser, {
        watchOn: true,
        masteredPatchStatus: 500,
        // Keep the row busy long enough that the double click below proves the
        // in-flight guard / disabled state (busy 防重复) instead of racing.
        masteredPatchDelayMs: 500,
    });
    const masteredFailPage = await masteredFailContext.newPage();
    const masteredFailErrors = [];
    const masteredFailWrites = [];
    const masteredFailFavorites = [];
    masteredFailPage.on('pageerror', (error) => masteredFailErrors.push(String(error)));
    masteredFailPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/review/words' && request.method() === 'PATCH') {
            try { masteredFailWrites.push(request.postDataJSON()); } catch { masteredFailWrites.push(null); }
        }
        if (url.pathname.startsWith('/api/favorites') && request.method() !== 'GET') {
            masteredFailFavorites.push(request.method());
        }
    });
    await openVideo(masteredFailPage, VIDEO_ID);
    await seekToGlossedCue(masteredFailPage);
    await pausePlayback(masteredFailPage);
    if (!(await overlayText(masteredFailPage))?.includes('A short walk')) {
        await masteredFailPage.keyboard.press('ArrowRight');
        await waitForOverlay(masteredFailPage, 'A short walk');
        await pausePlayback(masteredFailPage);
    }
    await waitForRailText(masteredFailPage, '早餐');
    const failRow = masteredFailPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'breakfast' });
    const failMastered = failRow.locator('[data-testid="watch-gloss-mastered"]');
    await failRow.hover();
    await failMastered.click();
    // Busy 防重复: a rapid second press while the first PATCH is in flight must
    // not send a second write (the button is disabled and the ref guards).
    await failMastered.evaluate((el) => { el.click(); el.click(); });
    const failError = failRow.locator('..').locator('[data-testid="watch-gloss-mastered-error"]');
    await failError.waitFor({ state: 'visible', timeout: 5000 });
    assert.ok(
        (await failError.innerText()).includes('标记失败'),
        `a failed mastered PATCH did not explain itself inline: ${await failError.innerText()}`,
    );
    assert.equal(await failMastered.getAttribute('data-mastered'), 'false', 'a failed mastered PATCH left the row pressed');
    assert.equal(await failMastered.getAttribute('aria-pressed'), 'false');
    assert.equal(
        masteredFailWrites.filter((body) => body?.lemma === 'breakfast').length,
        1,
        `busy guard let a duplicate mastered PATCH through: ${JSON.stringify(masteredFailWrites)}`,
    );
    assert.equal(
        await failMastered.locator('[data-testid="watch-gloss-mastered-indicator"]').getAttribute('data-state'),
        'unchecked',
    );
    assert.deepEqual(
        masteredFailFavorites,
        [],
        `a failed mastered PATCH touched the favorites: ${JSON.stringify(masteredFailFavorites)}`,
    );
    assert.ok(
        masteredFailWrites.some((body) => body?.lemma === 'breakfast' && body?.mastered === true),
        'the failed run never sent the mastered PATCH',
    );
    assert.deepEqual(masteredFailErrors, [], `mastered PATCH failure page errors: ${JSON.stringify(masteredFailErrors)}`);
    summary.masteredInlineFailure = {
        patch: 'true rejected 500',
        row: 'rolled back (aria-pressed=false, indicator unchecked)',
        message: 'inline watch-gloss-mastered-error',
        favoriteTouched: false,
    };
    await masteredFailContext.close();

    // Guests get no teaching analysis at all (specs/045 §6: no guest AI call),
    // so the watch gloss surface must say 登录后查看本句词条 instead of inventing
    // stars for words that do not exist, and it must never write a favorite.
    const guestContext = await createContext(browser, { watchOn: true, guest: true });
    const guestPage = await guestContext.newPage();
    const guestErrors = [];
    const guestWrites = [];
    guestPage.on('pageerror', (error) => guestErrors.push(String(error)));
    guestPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/favorites') && request.method() !== 'GET') {
            guestWrites.push({ method: request.method(), path: url.pathname });
        }
    });
    await openVideo(guestPage, VIDEO_ID);
    await waitForRailText(guestPage, '登录后查看本句词条');
    assert.equal(await guestPage.locator('[data-testid="watch-gloss-word"]').count(), 0, 'a guest must not see invented glosses');
    assert.equal(await guestPage.locator('[data-testid="watch-gloss-favorite"]').count(), 0, 'a guest must not get favorite stars without glosses');
    await sleep(200);
    assert.deepEqual(guestWrites, [], `a guest favorite must not write: ${JSON.stringify(guestWrites)}`);
    assert.deepEqual(guestErrors, [], `guest favorite page errors: ${JSON.stringify(guestErrors)}`);
    await guestContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-19 guest: the public library payload gives a guest real gloss
    // rows; 已掌握 writes ONLY the local table (`yt_bilingual_guest_mastered_words`
    // — the same table the word book's 「我会了」 reads), never the API, and
    // survives a reload. Unmarking clears it again.
    // ═════════════════════════════════════════════════════════════════════
    const guestLibraryContext = await createContext(browser, { watchOn: true, guest: true });
    const guestLibraryPage = await guestLibraryContext.newPage();
    const guestLibraryErrors = [];
    const guestLibraryReviewCalls = [];
    guestLibraryPage.on('pageerror', (error) => guestLibraryErrors.push(String(error)));
    guestLibraryPage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/review/words') {
            guestLibraryReviewCalls.push({ method: request.method(), path: url.pathname, search: url.search });
        }
    });
    await openLibraryVideo(guestLibraryPage, LIBRARY_VIDEO_ID);
    await guestLibraryPage.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 20000 });
    await seekToGlossedCue(guestLibraryPage);
    await pausePlayback(guestLibraryPage);
    if (!(await overlayText(guestLibraryPage))?.includes('Small habits')) {
        await guestLibraryPage.keyboard.press('ArrowLeft');
        await waitForOverlay(guestLibraryPage, 'Small habits');
        await pausePlayback(guestLibraryPage);
    }
    await waitForRailText(guestLibraryPage, '习惯');
    assert.equal(
        await guestLibraryPage.evaluate(() => localStorage.getItem('yt_bilingual_guest_mastered_words')),
        null,
        'the guest mastered table did not start empty',
    );
    const guestHabitsRow = guestLibraryPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'habits' });
    const guestMastered = guestHabitsRow.locator('[data-testid="watch-gloss-mastered"]');
    await guestHabitsRow.hover();
    assert.equal(await guestMastered.getAttribute('data-mastered'), 'false');
    await guestMastered.click();
    await guestLibraryPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'habits');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    const guestTable = await guestLibraryPage.evaluate(() => JSON.parse(
        localStorage.getItem('yt_bilingual_guest_mastered_words') ?? '[]',
    ));
    assert.deepEqual(guestTable, ['habits'], `the guest table did not get the mastered word: ${JSON.stringify(guestTable)}`);
    assert.equal(await guestMastered.getAttribute('aria-pressed'), 'true');
    assert.deepEqual(
        guestLibraryReviewCalls,
        [],
        `a guest mastered write called the review API: ${JSON.stringify(guestLibraryReviewCalls)}`,
    );
    await guestLibraryPage.reload({ waitUntil: 'domcontentloaded' });
    await guestLibraryPage.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 20000 });
    await seekToGlossedCue(guestLibraryPage);
    await pausePlayback(guestLibraryPage);
    if (!(await overlayText(guestLibraryPage))?.includes('Small habits')) {
        await guestLibraryPage.keyboard.press('ArrowLeft');
        await waitForOverlay(guestLibraryPage, 'Small habits');
        await pausePlayback(guestLibraryPage);
    }
    await waitForRailText(guestLibraryPage, '习惯');
    await guestLibraryPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'habits');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    const guestReloadedRow = guestLibraryPage.locator('[data-testid="watch-gloss-word"]').filter({ hasText: 'habits' });
    summary.screenshots.push(shot('1440-gloss-mastered-guest'));
    await guestLibraryPage.screenshot({ path: shot('1440-gloss-mastered-guest') });
    await guestReloadedRow.hover();
    await guestReloadedRow.locator('[data-testid="watch-gloss-mastered"]').click();
    await guestLibraryPage.waitForFunction(
        () => {
            const rows = [...document.querySelectorAll('[data-testid="watch-gloss-word"]')];
            const row = rows.find((item) => item.getAttribute('data-word') === 'habits');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'false';
        },
        null,
        { timeout: 5000 },
    );
    assert.deepEqual(
        await guestLibraryPage.evaluate(() => JSON.parse(
            localStorage.getItem('yt_bilingual_guest_mastered_words') ?? '[]',
        )),
        [],
        'unmarking did not clear the guest mastered table',
    );
    assert.deepEqual(
        guestLibraryReviewCalls,
        [],
        `a guest mastered undo called the review API: ${JSON.stringify(guestLibraryReviewCalls)}`,
    );
    assert.deepEqual(guestLibraryErrors, [], `guest mastered page errors: ${JSON.stringify(guestLibraryErrors)}`);
    summary.masteredGuest = {
        table: 'yt_bilingual_guest_mastered_words',
        write: 'habits',
        readBack: 'survives reload',
        undo: 'cleared',
        apiCalls: 0,
    };
    await guestLibraryContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-13: payload-merged analysis glosses without the endpoint
    // ═════════════════════════════════════════════════════════════════════
    const payloadContext = await createContext(browser);
    const payloadPage = await payloadContext.newPage();
    const payloadErrors = [];
    payloadPage.on('pageerror', (error) => payloadErrors.push(String(error)));
    await openVideo(payloadPage, PAYLOAD_VIDEO_ID);
    // The history payload carries analysis.v5 + block highlights + idioms while
    // its mocked teaching-analysis endpoint is a 404, so this ruby can only
    // come from the payload transcript.
    await payloadPage.waitForFunction(
        () => {
            const block = document.querySelector('[data-testid="transcript-scroll"] [data-index="0"]');
            return Boolean(block && block.querySelector('ruby[data-gloss]'));
        },
        null,
        { timeout: 15000 },
    );
    assert.deepEqual(
        await transcriptRubyGlosses(payloadPage, 0),
        [{ word: 'habits', gloss: '习惯' }],
        'the payload block highlight did not render as ruby gloss',
    );
    assert.equal(
        await payloadPage.locator('[data-testid="teaching-notes-panel"]').count(),
        1,
        'payload analysis should not disturb the normal-layout teaching panel',
    );

    await payloadPage.locator('[data-testid="video-area"]').hover();
    await payloadPage.locator('[data-testid="watch-mode-toggle"]').click();
    await payloadPage.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 10000 });
    await payloadPage.keyboard.press('ArrowRight');
    await waitForOverlay(payloadPage, 'Small habits');
    await waitForRailText(payloadPage, '习惯');
    const payloadWord = (await payloadPage.locator('[data-testid="watch-gloss-word"]').first().innerText()).trim();
    assert.ok(
        payloadWord.includes('habits') && payloadWord.includes('习惯'),
        `rolling gloss lost the payload word: ${payloadWord}`,
    );
    // idioms/culture still come from the analysis, not from the word map.
    await payloadPage.keyboard.press('ArrowRight');
    await waitForOverlay(payloadPage, 'A short walk');
    await waitForRailText(payloadPage, '早餐前');
    const payloadPoint = (await payloadPage.locator('[data-testid="watch-gloss-language-point"]').first().innerText()).trim();
    assert.ok(
        payloadPoint.includes('before breakfast'),
        `payload idiom missing from the rolling gloss: ${payloadPoint}`,
    );
    assert.deepEqual(payloadErrors, [], `payload-analysis page errors: ${JSON.stringify(payloadErrors)}`);
    summary.screenshots.push(shot('1440-p2-13-payload'));
    await payloadPage.screenshot({ path: shot('1440-p2-13-payload') });
    summary.payloadAnalysis = {
        ruby: 'habits/习惯',
        rollingWord: 'habits/习惯',
        idiom: 'before breakfast',
        endpoint: 404,
    };
    await payloadContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-13: endpoint authority is not polluted by old payload glosses
    // ═════════════════════════════════════════════════════════════════════
    const authContext = await createContext(browser);
    const authPage = await authContext.newPage();
    const authErrors = [];
    authPage.on('pageerror', (error) => authErrors.push(String(error)));
    await openVideo(authPage, AUTHORITATIVE_VIDEO_ID);
    // Wait until the endpoint-authored gloss is on screen: from then on the
    // endpoint projection owns every block, including the ones it left empty.
    await authPage.waitForFunction(
        () => {
            const block = document.querySelector('[data-testid="transcript-scroll"] [data-index="1"]');
            const ruby = block ? block.querySelector('ruby[data-gloss]') : null;
            return ruby?.getAttribute('data-gloss') === '早餐';
        },
        null,
        { timeout: 15000 },
    );
    assert.deepEqual(
        await transcriptRubyGlosses(authPage, 0),
        [],
        'an endpoint-cleared block kept its old payload gloss',
    );
    assert.deepEqual(
        await transcriptRubyGlosses(authPage, 1),
        [{ word: 'breakfast', gloss: '早餐' }],
        'the endpoint gloss did not replace the payload gloss',
    );

    await authPage.locator('[data-testid="video-area"]').hover();
    await authPage.locator('[data-testid="watch-mode-toggle"]').click();
    await authPage.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 10000 });
    await authPage.keyboard.press('ArrowRight');
    await waitForOverlay(authPage, 'Small habits');
    await authPage.waitForFunction(
        () => document.querySelectorAll('[data-testid="watch-gloss-entry"]').length === 0,
        null,
        { timeout: 10000 },
    );
    assert.equal(
        await authPage.locator('[data-testid="watch-gloss-word"]').count(),
        0,
        'an endpoint-empty sentence still shows payload words',
    );
    await authPage.keyboard.press('ArrowRight');
    await waitForOverlay(authPage, 'A short walk');
    await waitForRailText(authPage, '早餐');
    assert.deepEqual(
        await glossBlockIds(authPage),
        ['1'],
        'the endpoint-empty sentence leaked a rolling entry',
    );
    const authWords = await authPage.locator('[data-testid="watch-gloss-word"]').allInnerTexts();
    assert.equal(authWords.length, 1, `expected one endpoint word, got ${JSON.stringify(authWords)}`);
    assert.ok(
        authWords[0].includes('breakfast') && authWords[0].includes('早餐'),
        `endpoint word missing from the rolling gloss: ${authWords[0]}`,
    );
    const authoritativeRailText = await authPage.locator('[data-testid="watch-gloss-rail"]').innerText();
    assert.ok(
        !authoritativeRailText.includes('散步'),
        'the payload word walk survived the endpoint override',
    );
    assert.deepEqual(authErrors, [], `authoritative page errors: ${JSON.stringify(authErrors)}`);
    summary.screenshots.push(shot('1440-p2-13-authoritative'));
    await authPage.screenshot({ path: shot('1440-p2-13-authoritative') });
    summary.authoritative = {
        emptyBlock: 'no ruby, no word entry',
        endpointWord: 'breakfast/早餐',
        payloadWordsDropped: ['habits', 'walk'],
    };
    await authContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1440 — P2-10 page fullscreen lifecycle (stubbed, deterministic)
    // ═════════════════════════════════════════════════════════════════════
    const fsContext = await createContext(browser);
    const fsPage = await fsContext.newPage();
    await stubFullscreen(fsPage);
    const fsErrors = [];
    const fsConsoleErrors = [];
    fsPage.on('pageerror', (error) => fsErrors.push(String(error)));
    fsPage.on('console', (message) => {
        if (message.type() === 'error') fsConsoleErrors.push(message.text());
    });
    await openVideo(fsPage, VIDEO_ID);

    const readFs = () => fsPage.evaluate(() => {
        const shell = document.querySelector('[data-testid="learning-scroll"]');
        return {
            requests: window.__fsStub.requests,
            exits: window.__fsStub.exits,
            element: document.fullscreenElement
                ? document.fullscreenElement.getAttribute('data-testid')
                : null,
            watch: shell ? shell.getAttribute('data-watch-mode') : null,
            pageFullscreen: shell ? shell.getAttribute('data-page-fullscreen') : null,
            topbar: Boolean(document.querySelector('[data-testid="watch-topbar"]')),
            entryToggle: Boolean(document.querySelector('[data-testid="watch-mode-toggle"]')),
        };
    });
    const waitFullscreen = (present) => fsPage.waitForFunction(
        (expected) => (document.fullscreenElement !== null) === expected,
        present,
        { timeout: 5000 },
    );

    // — enter watch: request inside the click gesture, targeting the shell —
    await enterWatchMode(fsPage);
    await waitFullscreen(true);
    let fsState = await readFs();
    assert.equal(fsState.requests, 1, 'entering watch mode must call requestFullscreen once');
    assert.equal(fsState.element, 'learning-scroll', 'requestFullscreen must target the watch shell');
    assert.equal(fsState.watch, 'on');
    assert.equal(fsState.pageFullscreen, 'on');
    assert.equal(fsState.topbar, true, 'the watch shell did not mount its floating top bar');
    assert.equal(fsState.entryToggle, false, 'the entry toggle must be unmounted in watch mode');
    assert.equal(await fsPage.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'retired fullscreen button must stay gone');
    assert.equal(await fsPage.locator('[data-testid="watch-topbar-exit"]').count(), 1, 'watch top bar exit must be the only watch control');
    // Only the watch shell is fullscreened: its AppShell top bar / header are
    // not part of the DOM, so the page fullscreen never captures app chrome.
    assert.equal(await fsPage.locator('[data-testid="top-bar"]').count(), 0);
    assert.equal(await fsPage.locator('[data-testid="learning-header"]').count(), 0);

    // — P2-11: under the P2-10 page-fullscreen stub the shell stays fullscreen
    // while the window (what a bigger screen is in real fullscreen) grows, so
    // the fluid subtitle must scale with the media without a JS resize listener.
    await seekToGlossedCue(fsPage);
    await pausePlayback(fsPage);
    const fsTypeBase = await subtitleType(fsPage);
    assert.ok(fsTypeBase.en, 'fullscreen subtitle missing for the fluid type check');
    await fsPage.setViewportSize({ width: 1920, height: 1080 });
    await fsPage.waitForFunction(
        (before) => {
            const el = document.querySelector('[data-testid="watch-subtitle-en"]');
            return el ? parseFloat(getComputedStyle(el).fontSize) > before : false;
        },
        fsTypeBase.en.fontSize,
        { timeout: 5000 },
    );
    const fsTypeWide = await subtitleType(fsPage);
    assert.ok(
        fsTypeWide.en.fontSize > fsTypeBase.en.fontSize,
        `fullscreen font did not grow with the media: ${fsTypeBase.en.fontSize}px → ${fsTypeWide.en.fontSize}px`,
    );
    assert.ok(fsTypeWide.en.fontSize > fsTypeWide.zh.fontSize, 'fullscreen English must stay above Chinese');
    assert.equal(
        await fsPage.evaluate(() => document.fullscreenElement?.getAttribute('data-testid')),
        'learning-scroll',
        'growing the fullscreen window must keep the shell in page fullscreen',
    );
    summary.screenshots.push(shot('1920-fullscreen'));
    await fsPage.screenshot({ path: shot('1920-fullscreen') });
    await fsPage.setViewportSize({ width: 1440, height: 900 });
    await fsPage.waitForFunction(
        (wide) => {
            const el = document.querySelector('[data-testid="watch-subtitle-en"]');
            return el ? parseFloat(getComputedStyle(el).fontSize) < wide : false;
        },
        fsTypeWide.en.fontSize,
        { timeout: 5000 },
    );

    // — P2-17: ESC / browser chrome leaves OUR page fullscreen, so the mode
    //   that requested it leaves too. The release must be the browser's (the
    //   app must not call exitFullscreen after the document already left); the
    //   layout and the entry toggle return and the preference persists off. —
    await fsPage.evaluate(() => window.__fsStub.escape());
    await waitFullscreen(false);
    await fsPage.waitForFunction(
        () => document.querySelector('[data-testid="learning-scroll"]')?.getAttribute('data-watch-mode') === 'off',
        null,
        { timeout: 5000 },
    );
    fsState = await readFs();
    assert.equal(fsState.watch, 'off', 'ESC out of our page fullscreen must leave 观影模式 (P2-17)');
    assert.equal(fsState.topbar, false, 'the floating top bar must unmount with the watch layout');
    assert.equal(fsState.entryToggle, true, 'the 观影模式 entry toggle must come back after ESC');
    assert.equal(fsState.pageFullscreen, 'off', 'page-fullscreen state did not follow the document');
    assert.equal(fsState.exits, 0, 'the app must not call exitFullscreen after the browser already exited');
    assert.equal(
        await fsPage.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')),
        'off',
        'ESC must persist 观影模式 off',
    );
    await fsPage.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });

    // — re-enter, then leave: exit is called while the shell owns fullscreen —
    await enterWatchMode(fsPage);
    await waitFullscreen(true);
    fsState = await readFs();
    assert.equal(fsState.requests, 2);
    await exitWatchMode(fsPage);
    await waitFullscreen(false);
    fsState = await readFs();
    assert.equal(fsState.exits, 1, 'leaving watch mode while fullscreen must call exitFullscreen');
    assert.equal(fsState.pageFullscreen, 'off');

    // — route change away from the video page cleans up page fullscreen —
    await enterWatchMode(fsPage);
    await waitFullscreen(true);
    await fsPage.evaluate(() => { window.location.hash = '#/app/today'; });
    await waitFullscreen(false);
    fsState = await readFs();
    assert.equal(fsState.exits, 2, 'leaving the video route must clean up page fullscreen');
    assert.equal(fsState.watch, null, 'the watch shell must be unmounted after leaving the video route');
    // P2-17: releasing fullscreen because the route unmounted is NOT an ESC
    // exit — the 观影模式 preference must survive the navigation.
    assert.equal(
        await fsPage.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')),
        'on',
        'a route change must not turn 观影模式 off (only a real fullscreen exit may)',
    );

    // — back to the video: watch mode persists, fullscreen needs a gesture —
    await openVideo(fsPage, VIDEO_ID);
    assert.equal(await fsPage.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(
        await fsPage.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'),
        'off',
        'returning to the video page must not restore fullscreen without a user gesture (and must not exit the mode)',
    );
    await exitWatchMode(fsPage);

    // — rejected request: silent, layout-only fallback —
    const beforeReject = await fsPage.evaluate(() => window.__fsStub.requests);
    await fsPage.evaluate(() => { window.__fsStub.rejectNext = true; });
    await enterWatchMode(fsPage);
    await fsPage.waitForFunction((count) => window.__fsStub.requests === count, beforeReject + 1, { timeout: 5000 });
    await fsPage.waitForFunction(
        () => document.querySelector('[data-testid="learning-scroll"]')?.getAttribute('data-watch-mode') === 'on',
        null,
        { timeout: 5000 },
    );
    await sleep(150);
    fsState = await readFs();
    assert.equal(fsState.element, null, 'a rejected request must not enter fullscreen');
    assert.equal(fsState.pageFullscreen, 'off');
    assert.equal(fsState.topbar, true, 'the rejected request must keep the watch layout');
    // P2-17: a fullscreenchange that is not a "we owned it → no fullscreen"
    // transition must not flip the mode. The rejected request never owned
    // fullscreen, so the event is a no-op (initial / never-fullscreen guard).
    await fsPage.evaluate(() => document.dispatchEvent(new Event('fullscreenchange')));
    await sleep(150);
    assert.equal(await fsPage.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on', 'a fullscreenchange without our fullscreen must not leave 观影模式');
    assert.deepEqual(fsErrors, [], `rejected fullscreen request raised a page error: ${JSON.stringify(fsErrors)}`);

    // — missing API (mobile / iframe): layout-only fallback, no requests —
    await exitWatchMode(fsPage);
    await fsPage.evaluate(() => {
        delete Element.prototype.requestFullscreen;
        delete document.exitFullscreen;
    });
    const beforeUnsupported = await fsPage.evaluate(() => window.__fsStub.requests);
    await enterWatchMode(fsPage);
    await fsPage.waitForFunction(
        () => document.querySelector('[data-testid="learning-scroll"]')?.getAttribute('data-watch-mode') === 'on',
        null,
        { timeout: 5000 },
    );
    fsState = await readFs();
    assert.equal(fsState.requests, beforeUnsupported, 'a missing Fullscreen API must not be called');
    assert.equal(fsState.element, null);
    assert.equal(fsState.pageFullscreen, 'off');
    assert.equal(fsState.topbar, true, 'the missing API must keep the watch layout');
    assert.deepEqual(fsConsoleErrors.filter((text) => /fullscreen/i.test(text)), [], 'fullscreen fallbacks must stay silent');
    assert.deepEqual(fsErrors, [], `fullscreen lifecycle raised page errors: ${JSON.stringify(fsErrors)}`);
    summary.pageFullscreen = {
        requests: fsState.requests,
        exits: fsState.exits,
        escExitsWatch: true,
        initialSyncLeavesWatch: 'untouched',
        routeChangeLeavesWatch: 'on (preference survives)',
        rejectedRequest: 'layout-only',
        missingApi: 'layout-only',
        fluidGrowth: {
            before: fsTypeBase.en.fontSize,
            after: fsTypeWide.en.fontSize,
        },
    };
    await fsContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 375 — phone: single column, no overflow, floating gloss layer
    // ═════════════════════════════════════════════════════════════════════
    const phoneContext = await createContext(browser, { width: 375, height: 812, hasTouch: true, watchOn: true });
    const phone = await phoneContext.newPage();
    const phoneErrors = [];
    const phoneMasteredPatches = [];
    phone.on('pageerror', (error) => phoneErrors.push(String(error)));
    phone.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname === '/api/review/words' && request.method() === 'PATCH') {
            try { phoneMasteredPatches.push(request.postDataJSON()); } catch { phoneMasteredPatches.push(null); }
        }
    });
    await openVideo(phone, VIDEO_ID);
    assert.equal(await phone.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(await phone.locator('[data-testid="watch-gloss-rail"]').count(), 0, 'rail must not mount below 1280');
    // P2-15 §1: the phone shell is immersive too — neither app chrome renders,
    // and the floating top bar spans the viewport.
    assert.equal(await phone.locator('[data-testid="top-bar"]').count(), 0, '375: AppShell top bar must NOT be rendered in watch mode');
    assert.equal(await phone.locator('[data-testid="learning-header"]').count(), 0, '375: LearningHeader must NOT be rendered in watch mode');
    const phoneTopbar = await watchTopbarState(phone);
    assert.ok(phoneTopbar, '375: watch top bar missing');
    assert.ok(phoneTopbar.box.y <= 1 && Math.abs(phoneTopbar.box.width - 375) < 2, `375: top bar not flush with the viewport: ${JSON.stringify(phoneTopbar.box)}`);
    // Touch activity reveals the faded bar (spec: 鼠标/触摸/键盘出现).
    await phone.waitForFunction(
        () => document.querySelector('[data-testid="watch-topbar"]')?.getAttribute('data-idle') === 'true',
        null,
        { timeout: 6000 },
    );
    // Tap the picture (not the drawer handle right below it) to reveal the bar.
    await phone.touchscreen.tap(4, 160);
    await phone.waitForFunction(
        () => document.querySelector('[data-testid="watch-topbar"]')?.getAttribute('data-idle') === 'false',
        null,
        { timeout: 5000 },
    );
    await seekToGlossedCue(phone);
    await waitForGlossWord(phone);
    // P2-17: 375 is the floor tier of the fluid gloss type — word 16px,
    // definition 14px, definition still right-aligned on the label's line.
    const phoneGlossType = await glossRowState(phone);
    assert.ok(phoneGlossType.wordRow, '375: no gloss word row to measure');
    assert.equal(phoneGlossType.wordFont, 16, `375 gloss word font ${phoneGlossType.wordFont}px is not the 16px floor`);
    assert.equal(phoneGlossType.definitionFont, 14, `375 gloss definition font ${phoneGlossType.definitionFont}px is not the 14px floor`);
    assert.ok(phoneGlossType.wordRow.sameLine, '375: the gloss definition is not on the label line');
    assert.equal(phoneGlossType.wordRow.definitionRect.textAlign, 'right', '375: the gloss definition is not right-aligned');
    assert.ok(phoneGlossType.wordRow.definitionRect.left > phoneGlossType.wordRow.labelRect.left, '375: the definition is not to the right of the word');
    // — P2-19 on the touch drawer: both row actions are always visible and the
    //   已掌握 target is ≥44px; adding it must not squeeze the row (the 16/14px
    //   single-line contract measured above still holds after the mark). —
    const phoneWordRow = phone.locator('[data-testid="watch-gloss-word"]').first();
    const phoneActionState = await phoneWordRow.evaluate((row) => {
        const box = (el) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
                x: rect.x,
                y: rect.y,
                width: rect.width,
                height: rect.height,
                right: rect.right,
                opacity: parseFloat(getComputedStyle(el).opacity),
            };
        };
        return {
            word: row.getAttribute('data-word'),
            star: box(row.querySelector('[data-testid="watch-gloss-favorite"]')),
            check: box(row.querySelector('[data-testid="watch-gloss-mastered"]')),
            label: box(row.querySelector('[data-testid="watch-gloss-word-text"]')),
            definition: box(row.querySelector('[data-testid="watch-gloss-definition"]')),
        };
    });
    assert.ok(phoneActionState.star && phoneActionState.check, `375: the row action group is missing: ${JSON.stringify(phoneActionState)}`);
    assert.ok(
        phoneActionState.check.width >= 44 && phoneActionState.check.height >= 44,
        `375: the 已掌握 touch target is ${phoneActionState.check.width}×${phoneActionState.check.height}, not ≥44px`,
    );
    assert.ok(
        phoneActionState.star.width >= 44 && phoneActionState.star.height >= 44,
        `375: the star touch target is ${phoneActionState.star.width}×${phoneActionState.star.height}, not ≥44px`,
    );
    assert.ok(
        phoneActionState.check.opacity > 0.9 && phoneActionState.star.opacity > 0.9,
        '375: the drawer actions are not always visible',
    );
    assert.ok(phoneActionState.check.right <= 375, '375: the 已掌握 target overflows the viewport');
    assert.ok(
        phoneActionState.check.x >= phoneActionState.star.right - 1,
        '375: the 已掌握 target does not sit beside the star',
    );
    const phoneMasteredBtn = phoneWordRow.locator('[data-testid="watch-gloss-mastered"]');
    await phoneMasteredBtn.click();
    await phone.waitForFunction(
        () => {
            const row = document.querySelector('[data-testid="watch-gloss-word"]');
            return row?.querySelector('[data-testid="watch-gloss-mastered"]')?.getAttribute('data-mastered') === 'true';
        },
        null,
        { timeout: 5000 },
    );
    assert.equal(await phoneMasteredBtn.getAttribute('aria-pressed'), 'true');
    const phoneMarkDeadline = Date.now() + 5000;
    let phoneMark = null;
    while (Date.now() < phoneMarkDeadline && !phoneMark) {
        phoneMark = phoneMasteredPatches.find((body) => body?.lemma === phoneActionState.word) ?? null;
        if (!phoneMark) await sleep(50);
    }
    assert.ok(phoneMark, '375: the 已掌握 toggle did not PATCH the mastered mark');
    assert.equal(phoneMark.mastered, true);
    // The row did not get squeezed: same single line, same fluid 16/14px floors.
    const phoneRowAfterMark = await glossRowState(phone);
    assert.equal(phoneRowAfterMark.wordFont, 16, `375: the mastered toggle changed the word font to ${phoneRowAfterMark.wordFont}px`);
    assert.equal(phoneRowAfterMark.definitionFont, 14, `375: the mastered toggle changed the definition font to ${phoneRowAfterMark.definitionFont}px`);
    assert.ok(phoneRowAfterMark.wordRow?.sameLine, '375: the mastered toggle pushed the definition off the label line');
    const phoneOverflowAfterMark = await phone.evaluate(() => document.documentElement.scrollWidth);
    assert.ok(phoneOverflowAfterMark <= 375 + 1, `375: the mastered toggle caused horizontal overflow (${phoneOverflowAfterMark}px)`);
    summary.screenshots.push(shot('375-gloss-mastered'));
    await phone.screenshot({ path: shot('375-gloss-mastered') });
    const overflow375 = await phone.evaluate(() => ({
        documentWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
    }));
    assert.ok(overflow375.documentWidth <= overflow375.viewport + 1, `375 horizontal overflow: ${JSON.stringify(overflow375)}`);
    // P2-09 typography at 375: English 17px above Chinese 15px, no clipping,
    // and the whole overlay stays inside the media stage.
    const phoneSubtitle = await phone.evaluate(() => {
        const read = (testId) => {
            const el = document.querySelector(`[data-testid="${testId}"]`);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return {
                fontSize: parseFloat(getComputedStyle(el).fontSize),
                clipped: el.scrollWidth > el.clientWidth + 1,
                top: rect.top,
                bottom: rect.bottom,
            };
        };
        const overlay = document.querySelector('[data-testid="watch-subtitle-overlay"]');
        const media = overlay ? overlay.parentElement : null;
        if (!overlay || !media) return null;
        const rect = overlay.getBoundingClientRect();
        const mediaRect = media.getBoundingClientRect();
        return {
            en: read('watch-subtitle-en'),
            zh: read('watch-subtitle-zh'),
            insideWidth: rect.left >= -1 && rect.right <= window.innerWidth + 1,
            insideMedia: rect.top >= mediaRect.top - 1 && rect.bottom <= mediaRect.bottom + 1,
            pointerEvents: getComputedStyle(overlay).pointerEvents,
        };
    });
    assert.ok(phoneSubtitle && phoneSubtitle.en && phoneSubtitle.zh, '375 subtitle lines missing');
    // P2-11: 375 is the narrowest tier, so the fluid clamp sits at its floors.
    assert.equal(phoneSubtitle.en.fontSize, 17, `375 English subtitle must be the 17px clamp floor, got ${phoneSubtitle.en.fontSize}px`);
    assert.equal(phoneSubtitle.zh.fontSize, 15, `375 Chinese subtitle must be the 15px clamp floor, got ${phoneSubtitle.zh.fontSize}px`);
    assert.ok(phoneSubtitle.en.fontSize > phoneSubtitle.zh.fontSize, '375 English must be larger than Chinese');
    assert.ok(phoneSubtitle.en.top < phoneSubtitle.zh.top, '375 English must sit above Chinese');
    assert.ok(!phoneSubtitle.en.clipped && !phoneSubtitle.zh.clipped, '375 subtitle text is horizontally clipped');
    assert.ok(phoneSubtitle.insideWidth && phoneSubtitle.insideMedia, '375 subtitle overlay overflows the media stage');
    assert.equal(phoneSubtitle.pointerEvents, 'none', '375 overlay must stay pointer-events-none');
    // P2-16 / specs/045 §5 at 375: the 16:9 picture is pinned to the top (not
    // vertically centred in the page), and the gloss window is a bottom drawer
    // that owns the remaining height without covering the picture or its
    // native YouTube control bar.
    const phoneTopbarBox = await boxOf(phone, 'watch-topbar');
    const phoneStageBox = await boxOf(phone, 'watch-stage');
    const phoneVideo = await boxOf(phone, 'video-area');
    const phoneDrawer = await boxOf(phone, 'watch-gloss-panel');
    const phoneScroll = await boxOf(phone, 'watch-gloss-scroll');
    const phoneAmbient = await boxOf(phone, 'watch-stage-ambient');
    assert.ok(phoneTopbarBox && phoneStageBox && phoneVideo && phoneDrawer && phoneScroll && phoneAmbient, `375: top bar / stage / video / drawer / scroll / ambient missing: ${JSON.stringify({ phoneTopbarBox, phoneStageBox, phoneVideo, phoneDrawer, phoneScroll, phoneAmbient })}`);
    assert.ok(
        Math.abs(phoneVideo.width - (375 - 16)) <= 2,
        `375: the top-pinned 16:9 picture should span the 8px-margin width, got ${phoneVideo.width}px`,
    );
    const phoneAspect = phoneVideo.width / phoneVideo.height;
    assert.ok(Math.abs(phoneAspect - 16 / 9) < 0.02, `375: the picture is not 16:9 (${phoneAspect.toFixed(3)})`);
    assert.ok(
        phoneVideo.y - phoneTopbarBox.height <= 12,
        `375: the picture is not pinned below the top bar (video y ${phoneVideo.y}, bar ${phoneTopbarBox.height})`,
    );
    assert.ok(phoneVideo.y < 812 / 2, '375: the picture header consumes more than half the page');
    assert.ok(phoneVideo.bottom <= phoneDrawer.y + 1, '375: the gloss drawer overlaps the picture (and its native controls)');
    assert.ok(
        Math.abs(phoneDrawer.bottom - 812) <= 2,
        `375: the drawer does not reach the viewport bottom (${phoneDrawer.bottom})`,
    );
    assert.ok(
        phoneDrawer.height >= 480,
        `375: the expanded drawer only owns ${phoneDrawer.height}px of the remaining height`,
    );
    assert.equal(
        await phone.getAttribute('[data-testid="watch-gloss-panel"]', 'data-open'),
        'true',
        '375: the drawer must be expanded by default',
    );
    assert.ok(phoneScroll.height > 200, `375: the drawer list is only ${phoneScroll.height}px tall`);
    assert.equal(await phone.locator('[data-testid="watch-gloss-toggle"]').count(), 0, '375: the old floating gloss pill must be gone');
    assert.ok(
        Math.abs(phoneAmbient.height - phoneStageBox.height) < 2,
        '375: the ambient layer does not fill the (now top-pinned) stage',
    );
    assert.ok(phoneStageBox.y >= phoneTopbarBox.height - 2 && phoneStageBox.bottom <= phoneDrawer.y + 1, '375: the stage must sit between the top bar and the drawer');
    const phoneHeaderCount = (await phone.locator('[data-testid="watch-gloss-count"]').innerText()).trim();
    const phoneCurrentWords = await phone.locator('[data-testid="watch-gloss-entry"][data-current="true"] [data-testid="watch-gloss-word"]').count();
    assert.equal(phoneHeaderCount, `本句 ${phoneCurrentWords}`, '375: the drawer header count does not match the current sentence');
    // The drawer is collapsible via its handle (click only; no gesture needed).
    await phone.locator('[data-testid="watch-gloss-drawer-handle"]').click();
    await phone.waitForFunction(
        () => document.querySelector('[data-testid="watch-gloss-panel"]')?.getAttribute('data-open') === 'false',
        null,
        { timeout: 5000 },
    );
    assert.equal(await phone.locator('[data-testid="watch-gloss-scroll"]').count(), 0, '375: the collapsed drawer still renders its list');
    const collapsedDrawer = await boxOf(phone, 'watch-gloss-panel');
    assert.ok(collapsedDrawer && collapsedDrawer.height <= 100, `375: the collapsed drawer is ${collapsedDrawer?.height}px tall`);
    assert.ok(collapsedDrawer.bottom >= 800, '375: the collapsed drawer lost its bottom anchor');
    summary.screenshots.push(shot('375-drawer-collapsed'));
    await phone.screenshot({ path: shot('375-drawer-collapsed') });
    await phone.locator('[data-testid="watch-gloss-drawer-handle"]').click();
    await phone.waitForFunction(
        () => document.querySelector('[data-testid="watch-gloss-panel"]')?.getAttribute('data-open') === 'true',
        null,
        { timeout: 5000 },
    );
    assert.equal(await phone.locator('[data-testid="watch-gloss-scroll"]').count(), 1, '375: expanding the drawer did not restore its list');
    // P2-15 §4 at 375: 关闭 removes the overlay while the drawer keeps working;
    // restore 双语 for the screenshot.
    await chooseSubtitleMode(phone, 'off');
    assert.equal(await phone.locator('[data-testid="watch-subtitle-overlay"]').count(), 0, '375: 关闭 must not render the overlay');
    assert.equal(await phone.locator('[data-testid="watch-gloss-panel"]').count(), 1, '375: the gloss drawer disappeared with the subtitles off');
    assert.equal(await phone.getAttribute('[data-testid="watch-gloss-panel"]', 'data-open'), 'true', '375: the drawer closed with the subtitles off');
    await chooseSubtitleMode(phone, 'bilingual');
    assert.equal(await phone.locator('[data-testid="watch-subtitle-zh"]').count(), 1, '375: 双语 did not restore the Chinese line');
    // P2-16: the drawer carries the same target design as the rail — title +
    // count, no headings / context / empty placeholder.
    assert.equal(
        (await phone.locator('[data-testid="watch-gloss-panel"] h2').innerText()).trim(),
        '滚动词条',
        '375: the drawer title is not 滚动词条',
    );
    assert.equal(await phone.locator('[data-testid="watch-gloss-panel"] h3').count(), 0, '375: drawer section headings must be gone');
    assert.equal(await phone.locator('[data-testid="watch-gloss-entry-context"]').count(), 0, '375: drawer context line must be gone');
    assert.equal(await phone.locator('[data-testid="watch-gloss-empty"]').count(), 0, '375: drawer placeholder must be gone');
    assert.ok(await phone.locator('[data-testid="watch-gloss-word"]').count() > 0, '375: the drawer has no glossed word');
    summary.screenshots.push(shot('375'));
    await phone.screenshot({ path: shot('375') });
    summary.screenshots.push(shot('375-drawer'));
    await phone.screenshot({ path: shot('375-drawer') });
    // Watch OFF on the phone restores the stacked column + teaching panel.
    await exitWatchMode(phone);
    assert.equal(await phone.locator('[data-testid="watch-topbar"]').count(), 0, '375: the floating top bar must unmount after watch off');
    assert.equal(await phone.locator('[data-testid="top-bar"]').count(), 1, '375: the AppShell top bar did not come back after watch off');
    assert.equal(await phone.locator('[data-testid="learning-header"]').count(), 1, '375: the LearningHeader did not come back after watch off');
    assert.equal(await phone.locator('[data-testid="watch-gloss-panel"]').count(), 0);
    assert.equal(await phone.locator('[data-testid="watch-subtitle-overlay"]').count(), 0);
    assert.equal(await phone.locator('[data-testid="transcript-column"]').count(), 1, 'stacked transcript column missing after watch off');
    assert.equal(await phone.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'off');
    assert.deepEqual(phoneErrors, [], `375 page errors: ${JSON.stringify(phoneErrors)}`);
    summary.phone = {
        documentWidth: overflow375.documentWidth,
        viewport: overflow375.viewport,
        subtitleFontPx: { en: phoneSubtitle.en.fontSize, zh: phoneSubtitle.zh.fontSize },
        glossFontPx: { word: phoneGlossType.wordFont, definition: phoneGlossType.definitionFont },
        video: {
            width: Math.round(phoneVideo.width * 10) / 10,
            height: Math.round(phoneVideo.height * 10) / 10,
            aspect: Math.round(phoneAspect * 1000) / 1000,
            topPinned: true,
        },
        drawer: {
            defaultOpen: true,
            expandedHeight: Math.round(phoneDrawer.height * 10) / 10,
            collapsedHeight: Math.round(collapsedDrawer.height * 10) / 10,
            coversVideo: false,
        },
        glossActions: {
            star: `${Math.round(phoneActionState.star.width)}×${Math.round(phoneActionState.star.height)} always visible`,
            mastered: `${Math.round(phoneActionState.check.width)}×${Math.round(phoneActionState.check.height)} always visible`,
            mark: `${phoneMark.lemma ?? phoneActionState.word}:${phoneMark.mastered} (PATCH)`,
            rowAfterMark: `${phoneRowAfterMark.wordFont}/${phoneRowAfterMark.definitionFont}px, same line, no overflow`,
        },
        overflow: overflow375.documentWidth <= overflow375.viewport + 1 ? 'none' : 'overflow',
    };
    await phoneContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 375 — P2-09 history: five sentences accumulate, then the scroll
    // contract (auto top until the learner scrolls by hand)
    // ═════════════════════════════════════════════════════════════════════
    const historyContext = await createContext(browser, { width: 375, height: 812, hasTouch: true, watchOn: true });
    const historyPage = await historyContext.newPage();
    const historyErrors = [];
    historyPage.on('pageerror', (error) => historyErrors.push(String(error)));
    await openVideo(historyPage, HISTORY_VIDEO_ID);

    const advanceToSentence = async (fragment) => {
        await historyPage.keyboard.press('ArrowRight');
        await waitForOverlay(historyPage, fragment, 12000);
        await pausePlayback(historyPage);
    };
    // cue 0 → cue 1 → cue 2 (empty) → cue 3 → cue 4; each cue is paused so
    // the multi-step assertions cannot race the 4s playback window.
    await advanceToSentence('Small habits');
    await advanceToSentence('A short walk');
    await advanceToSentence('Nobody moves');
    await advanceToSentence('The room stays');
    await advanceToSentence('Then the kettle');

    // P2-16: the drawer is expanded by default — no toggle to open it.
    await historyPage.locator('[data-testid="watch-gloss-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await historyPage.getAttribute('[data-testid="watch-gloss-panel"]', 'data-open'), 'true', 'history run: the drawer must start expanded');
    assert.equal(await historyPage.locator('[data-testid="watch-gloss-rail"]').count(), 0, 'history run must use the drawer variant at 375');
    await waitForGlossEntries(historyPage, 4);
    const historyInitial = await scrollMetrics(historyPage);
    assert.equal(historyInitial.scrollTop, 0, 'newest sentence should start at scrollTop 0');
    assert.ok(
        historyInitial.scrollHeight > historyInitial.clientHeight,
        `history window does not overflow (${historyInitial.scrollHeight} <= ${historyInitial.clientHeight}); scroll contract cannot be exercised`,
    );
    // P2-12: entries are ordered by block id (the sentence context is gone);
    // cue 2 is empty, so it never appears in the rolling list.
    assert.deepEqual(
        await glossBlockIds(historyPage),
        ['4', '3', '1', '0'],
        'history should be newest-first and skip the empty sentence',
    );
    // P2-16: the current sentence is full strength; every earlier sentence is
    // dimmed and the fade only gets deeper with age.
    const historyOpacities = await historyPage.locator('[data-testid="watch-gloss-entry"]').evaluateAll(
        (entries) => entries.map((entry) => parseFloat(getComputedStyle(entry).opacity)),
    );
    assert.equal(historyOpacities[0], 1, 'the current sentence must stay full strength');
    for (let index = 1; index < historyOpacities.length; index += 1) {
        assert.ok(historyOpacities[index] < 0.75, `history entry ${index} is not dimmed (${historyOpacities[index]})`);
        if (index > 1) {
            assert.ok(
                historyOpacities[index] <= historyOpacities[index - 1] + 0.001,
                'older history entries must not be brighter than newer ones',
            );
        }
    }
    assert.equal(await historyPage.locator('[data-testid="watch-gloss-empty"]').count(), 0, 'history must not contain a placeholder entry');
    assert.equal(await historyPage.locator('[data-testid="watch-gloss-entry-context"]').count(), 0, 'history must not render sentence context');
    const historyPanelText = await historyPage.locator('[data-testid="watch-gloss-panel"]').innerText();
    for (const earlier of ['保持', '早餐', '习惯']) {
        assert.ok(historyPanelText.includes(earlier), `earlier sentence missing from history: ${earlier}`);
    }
    summary.screenshots.push(shot('375-history'));
    await historyPage.screenshot({ path: shot('375-history') });
    // Scrolling down by hand turns off the auto-follow.
    await historyPage.locator('[data-testid="watch-gloss-scroll"]').evaluate((el) => {
        el.scrollTop = 120;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await historyPage.waitForFunction(
        () => (document.querySelector('[data-testid="watch-gloss-scroll"]')?.scrollTop ?? 0) > 8,
        null,
        { timeout: 5000 },
    );
    // A new sentence must not yank a reader who deliberately scrolled.
    await advanceToSentence('Steam curls');
    await waitForGlossEntries(historyPage, 5);
    const afterManualScroll = await scrollMetrics(historyPage);
    assert.ok(afterManualScroll.scrollTop > 8, `new sentence pulled the manually scrolled window back to ${afterManualScroll.scrollTop}`);
    const topAfterNew = historyPage.locator('[data-testid="watch-gloss-entry"]').first();
    assert.equal(await topAfterNew.getAttribute('data-block-id'), '5', 'new sentence is not the top entry after manual scroll');
    assert.ok((await topAfterNew.innerText()).includes('蒸汽'), 'new sentence words are missing after manual scroll');
    // P2-12: cue 5 carries the long word + long gloss; it must wrap inside the
    // 375 panel (all five entries are in the DOM, cue 5 on top).
    await assertGlossListChrome(historyPage, 'watch-gloss-panel', '375 history');

    // Back at the top by hand: auto-follow resumes on the next sentence.
    await historyPage.locator('[data-testid="watch-gloss-scroll"]').evaluate((el) => {
        el.scrollTop = 0;
        el.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await historyPage.waitForFunction(
        () => (document.querySelector('[data-testid="watch-gloss-scroll"]')?.scrollTop ?? 1) === 0,
        null,
        { timeout: 5000 },
    );
    await historyPage.keyboard.press('ArrowLeft');
    await waitForOverlay(historyPage, 'Then the kettle', 12000);
    await pausePlayback(historyPage);
    await waitForCurrentEntry(historyPage, '4');
    assert.equal(await glossEntryCount(historyPage), 5, 'revisiting a sentence in the history duplicated it');
    const afterTop = await scrollMetrics(historyPage);
    assert.equal(afterTop.scrollTop, 0, 'auto-follow did not keep the window at the top after scrolling back up');
    assert.deepEqual(historyErrors, [], `history page errors: ${JSON.stringify(historyErrors)}`);
    summary.history = {
        entries: 5,
        emptySentence: 'skipped',
        scrollHeight: historyInitial.scrollHeight,
        clientHeight: historyInitial.clientHeight,
        manualScrollTop: Math.round(afterManualScroll.scrollTop),
        autoScrollTop: afterTop.scrollTop,
        longText375: 'wrapped',
    };
    await historyContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // 1920 — P2-11 fluid type: the widest tier outgrows the 1440 watch size
    // ═════════════════════════════════════════════════════════════════════
    const wideContext = await createContext(browser, { width: 1920, height: 1080, watchOn: true });
    const widePage = await wideContext.newPage();
    const wideErrors = [];
    widePage.on('pageerror', (error) => wideErrors.push(String(error)));
    await openVideo(widePage, VIDEO_ID);
    await seekToGlossedCue(widePage);
    await pausePlayback(widePage);
    await waitForGlossWord(widePage);
    const wideType = await subtitleType(widePage);
    assert.ok(wideType.en && wideType.zh, '1920 subtitle lines missing');
    // P2-17: 1920 is the cap tier of the fluid gloss type — word 22px,
    // definition 18px — and 1440 sits strictly between 375 and 1920.
    const wideGlossType = await glossRowState(widePage);
    assert.equal(wideGlossType.wordFont, 22, `1920 gloss word font ${wideGlossType.wordFont}px is not the 22px ceiling`);
    assert.equal(wideGlossType.definitionFont, 18, `1920 gloss definition font ${wideGlossType.definitionFont}px is not the 18px ceiling`);
    assert.ok(wideGlossType.wordRow?.sameLine, '1920: the gloss definition is not on the label line');
    assert.equal(wideGlossType.wordRow?.definitionRect.textAlign, 'right', '1920: the gloss definition is not right-aligned');
    assert.ok(
        cue1GlossRows.wordFont > phoneGlossType.wordFont + 2,
        `gloss word font must grow 375 → 1440 (${phoneGlossType.wordFont}px → ${cue1GlossRows.wordFont}px)`,
    );
    assert.ok(
        wideGlossType.wordFont > cue1GlossRows.wordFont + 1,
        `gloss word font must grow 1440 → 1920 (${cue1GlossRows.wordFont}px → ${wideGlossType.wordFont}px)`,
    );
    assert.ok(
        cue1GlossRows.definitionFont > phoneGlossType.definitionFont + 1,
        `gloss definition font must grow 375 → 1440 (${phoneGlossType.definitionFont}px → ${cue1GlossRows.definitionFont}px)`,
    );
    assert.ok(
        wideGlossType.definitionFont > cue1GlossRows.definitionFont + 1,
        `gloss definition font must grow 1440 → 1920 (${cue1GlossRows.definitionFont}px → ${wideGlossType.definitionFont}px)`,
    );
    assert.ok(
        wideType.en.fontSize > subtitleTypography.en.fontSize,
        `1920 English ${wideType.en.fontSize}px must be larger than 1440 watch ${subtitleTypography.en.fontSize}px`,
    );
    assert.ok(
        wideType.zh.fontSize > subtitleTypography.zh.fontSize,
        `1920 Chinese ${wideType.zh.fontSize}px must be larger than 1440 watch ${subtitleTypography.zh.fontSize}px`,
    );
    assert.ok(wideType.en.fontSize <= 32.01, `1920 English ${wideType.en.fontSize}px exceeds the 32px cap`);
    assert.ok(wideType.zh.fontSize <= 26.01, `1920 Chinese ${wideType.zh.fontSize}px exceeds the 26px cap`);
    assert.ok(wideType.en.fontSize > wideType.zh.fontSize, '1920 English must stay above Chinese');
    assert.ok(!wideType.en.clipped && !wideType.zh.clipped, '1920 subtitle text is horizontally clipped');
    assert.ok(wideType.insideMedia && wideType.insideViewport, '1920 subtitle overlay overflows the media stage');
    // P2-15 §1/§2 at 1920: the floating top bar spans the viewport and the
    // centred ambient stage has no dead-black band or overflow.
    const wideShell = await widePage.evaluate(() => {
        const box = (id) => {
            const element = document.querySelector(`[data-testid="${id}"]`);
            if (!element) return null;
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        const bar = document.querySelector('[data-testid="watch-topbar"]');
        return {
            topbar: bar ? { x: bar.getBoundingClientRect().x, y: bar.getBoundingClientRect().y, width: bar.getBoundingClientRect().width } : null,
            topbarCount: document.querySelectorAll('[data-testid="watch-topbar"]').length,
            topBar: document.querySelectorAll('[data-testid="top-bar"]').length,
            learningHeader: document.querySelectorAll('[data-testid="learning-header"]').length,
            stage: box('watch-stage'),
            video: box('video-area'),
            ambient: box('watch-stage-ambient'),
            rail: box('watch-gloss-rail'),
            documentWidth: document.documentElement.scrollWidth,
            viewport: { width: window.innerWidth, height: window.innerHeight },
        };
    });
    assert.equal(wideShell.topbarCount, 1, '1920: watch top bar missing');
    assert.ok(wideShell.rail && Math.abs(wideShell.rail.width - 360) <= 1, '1920: the gloss rail is not 360px');
    assert.equal(wideShell.topBar, 0, '1920: AppShell top bar rendered in watch mode');
    assert.equal(wideShell.learningHeader, 0, '1920: LearningHeader rendered in watch mode');
    assert.ok(wideShell.topbar && Math.abs(wideShell.topbar.width - 1920) < 2 && wideShell.topbar.y <= 1, '1920: watch top bar is not full-width at the viewport top');
    assert.ok(
        Math.abs((wideShell.video.x + wideShell.video.width / 2) - (wideShell.stage.x + wideShell.stage.width / 2)) <= 2
        && Math.abs((wideShell.video.y + wideShell.video.height / 2) - (wideShell.stage.y + wideShell.stage.height / 2)) <= 2,
        '1920: the media is not centred on the stage',
    );
    assert.ok(wideShell.documentWidth <= wideShell.viewport.width + 1, '1920: watch layout overflows horizontally');
    assert.ok(
        Math.abs(wideShell.ambient.width - wideShell.stage.width) < 2
        && Math.abs(wideShell.ambient.height - wideShell.stage.height) < 2,
        '1920: the ambient layer does not fill the stage',
    );
    summary.screenshots.push(shot('1920'));
    await widePage.screenshot({ path: shot('1920') });
    // P2-11 follow-up: the English ceiling is 32px (2rem). A window wide enough
    // for 2cqi to exceed it must clamp there instead of growing further.
    await widePage.setViewportSize({ width: 2048, height: 1152 });
    await widePage.waitForFunction(
        () => {
            const el = document.querySelector('[data-testid="watch-subtitle-en"]');
            return el ? parseFloat(getComputedStyle(el).fontSize) > 31.5 : false;
        },
        null,
        { timeout: 5000 },
    );
    const cappedType = await subtitleType(widePage);
    assert.ok(
        Math.abs(cappedType.en.fontSize - 32) < 0.01,
        `2048 English ${cappedType.en.fontSize}px must hit the 32px ceiling`,
    );
    assert.ok(cappedType.en.fontSize > cappedType.zh.fontSize, 'capped English must stay above Chinese');
    assert.ok(!cappedType.en.clipped && !cappedType.zh.clipped, '2048 subtitle text is horizontally clipped');
    assert.deepEqual(wideErrors, [], `1920 page errors: ${JSON.stringify(wideErrors)}`);
    summary.wide = {
        mediaWidth: Math.round((wideType.mediaWidth ?? 0) * 10) / 10,
        subtitleFontPx: { en: wideType.en.fontSize, zh: wideType.zh.fontSize },
        capFontPx: cappedType.en.fontSize,
    };
    await wideContext.close();

    // ═════════════════════════════════════════════════════════════════════
    // reduced motion — the watch layers carry no animation/transition
    // ═════════════════════════════════════════════════════════════════════
    const reduceContext = await createContext(browser, { reducedMotion: 'reduce', watchOn: true });
    const reducePage = await reduceContext.newPage();
    const reduceErrors = [];
    reducePage.on('pageerror', (error) => reduceErrors.push(String(error)));
    await openVideo(reducePage, VIDEO_ID);
    await seekToGlossedCue(reducePage);
    await reducePage.waitForFunction(
        () => document.querySelector('[data-testid="watch-gloss-word"]') !== null,
        null,
        { timeout: 10000 },
    );

    const motion = await reducePage.evaluate(() => {
        const read = (el) => {
            if (!el) return null;
            const style = getComputedStyle(el);
            const durations = style.transitionDuration.split(',').map((value) => value.trim());
            const ms = durations.map((value) => value.endsWith('ms') ? parseFloat(value) : parseFloat(value) * 1000);
            return { animationName: style.animationName, maxTransitionMs: Math.max(...ms) };
        };
        return {
            prefersReduce: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
            overlay: read(document.querySelector('[data-testid="watch-subtitle-overlay"]')),
            rail: read(document.querySelector('[data-testid="watch-gloss-rail"]')),
            scroll: read(document.querySelector('[data-testid="learning-scroll"]')),
            // P2-15: the floating top bar's 2.5s fade must not animate either.
            topbar: read(document.querySelector('[data-testid="watch-topbar"]')),
        };
    });
    assert.equal(motion.prefersReduce, true);
    for (const key of ['overlay', 'rail', 'scroll', 'topbar']) {
        assert.ok(motion[key], `${key} missing for reduced-motion check`);
        assert.equal(motion[key].animationName, 'none', `${key} still animates under reduced motion`);
        assert.ok(motion[key].maxTransitionMs <= 0.02, `${key} transition ${motion[key].maxTransitionMs}ms under reduced motion`);
    }
    summary.reducedMotion = motion;
    assert.deepEqual(reduceErrors, [], `reduced-motion page errors: ${JSON.stringify(reduceErrors)}`);
    await reduceContext.close();

    summary.screenshots.forEach((path) => assert.ok(fs.existsSync(path), `screenshot missing: ${path}`));
    console.log(JSON.stringify(summary, null, 2));
} finally {
    await browser.close();
}
