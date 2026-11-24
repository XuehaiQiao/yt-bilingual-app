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
//      click gesture, leaving watch mode calls `exitFullscreen()`, an ESC-style
//      browser exit keeps the watch layout and only syncs `data-page-fullscreen`,
//      a rejected/missing Fullscreen API degrades to the layout silently, and a
//      route change cleans up the page fullscreen (all via a page-side stub).
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
//      entry — no custom transport/progress bar is added and the subtitle scrim
//      clears the bottom strip those controls live in.
//  14. P2-10 / P2-11 / P2-12 / P2-13 keep their previous coverage verbatim
//      (only the watch toggle → top-bar exit selector moved).
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

    await context.route('**/api/**', (route) => {
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

    // — geometry: the overlay clears the player controls and lets clicks pass —
    const overlayRect = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="watch-subtitle-overlay"]');
        const parent = el ? el.parentElement : null;
        if (!el || !parent) return null;
        const a = el.getBoundingClientRect();
        const p = parent.getBoundingClientRect();
        return {
            bottomGap: p.bottom - a.bottom,
            parentHeight: p.height,
            pointerEvents: getComputedStyle(el).pointerEvents,
        };
    });
    assert.ok(overlayRect, 'overlay geometry missing');
    assert.equal(overlayRect.pointerEvents, 'none', 'overlay must never intercept clicks');
    assert.ok(
        overlayRect.bottomGap >= overlayRect.parentHeight * 0.12 - 1,
        `overlay sits ${overlayRect.bottomGap}px from the bottom (<12% of ${overlayRect.parentHeight})`,
    );
    const overlay = await boxOf(page, 'watch-subtitle-overlay');
    // P2-15 §3: the YouTube embed keeps its native control bar and native CC
    // entry. The watch shell adds no transport UI of its own, and the subtitle
    // scrim must clear the bottom strip those native controls live in.
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
        overlay.bottom <= mediaBox.bottom - 0.12 * mediaBox.height + 1,
        'the subtitle scrim intrudes into the bottom strip where the native controls live',
    );

    // — gloss rail content matches the analysis for cue 0 —
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 1);
    assert.ok((await page.locator('[data-testid="watch-gloss-word"]').first().innerText()).includes('habits'));
    assert.ok((await page.locator('[data-testid="watch-gloss-word"]').first().innerText()).includes('习惯'));
    assert.equal(await page.locator('[data-testid="watch-gloss-language-point"]').count(), 0, 'cue 0 has no language point');
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
        await page.locator('[data-testid="watch-gloss-rail"] button:not([data-testid="watch-gloss-favorite"])').count(),
        0,
        'the rail must not show unimplemented ✓ / settings actions',
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
        overlayBottomGap: Math.round(overlayRect.bottomGap * 10) / 10,
        mediaHeight: Math.round((mediaStageWatch?.height ?? 0) * 10) / 10,
        analysisRequests: analysisCalls.length,
        subtitleFontPx: { en: subtitleTypography.en.fontSize, zh: subtitleTypography.zh.fontSize },
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
    failurePage.on('pageerror', (error) => failureErrors.push(String(error)));
    failurePage.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/favorites')) {
            let body = null;
            try { body = request.postDataJSON(); } catch { body = null; }
            failureWrites.push({ method: request.method(), path: url.pathname, body });
        }
    });
    await openVideo(failurePage, VIDEO_ID);
    await seekToGlossedCue(failurePage);
    await pausePlayback(failurePage);
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
    assert.deepEqual(failureErrors, [], `favorite failure page errors: ${JSON.stringify(failureErrors)}`);
    await failureContext.close();

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

    // — ESC / browser chrome leaves fullscreen: the watch layout survives —
    await fsPage.evaluate(() => window.__fsStub.escape());
    await waitFullscreen(false);
    fsState = await readFs();
    assert.equal(fsState.watch, 'on', 'a browser-initiated fullscreen exit must keep the watch layout');
    assert.equal(fsState.topbar, true, 'a browser-initiated fullscreen exit must keep the floating top bar');
    assert.equal(fsState.pageFullscreen, 'off', 'page-fullscreen state did not follow the document');
    assert.equal(fsState.exits, 0, 'the app must not call exitFullscreen after the browser already exited');

    // — leaving watch after ESC only restores the layout (no spurious exit) —
    await exitWatchMode(fsPage);
    fsState = await readFs();
    assert.equal(fsState.watch, 'off');
    assert.equal(fsState.exits, 0, 'leaving the watch layout out of fullscreen must not call exitFullscreen');
    assert.equal(fsState.topbar, false, 'the floating top bar must unmount after leaving watch mode');

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

    // — back to the video: watch mode persists, fullscreen needs a gesture —
    await openVideo(fsPage, VIDEO_ID);
    assert.equal(await fsPage.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(
        await fsPage.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'),
        'off',
        'returning to the video page must not restore fullscreen without a user gesture',
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
        escKeepsWatchLayout: true,
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
    phone.on('pageerror', (error) => phoneErrors.push(String(error)));
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
    const wideType = await subtitleType(widePage);
    assert.ok(wideType.en && wideType.zh, '1920 subtitle lines missing');
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
