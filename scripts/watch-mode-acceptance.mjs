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
//   4. the gloss rail shows the same words/language points the analysis gives
//      the transcript, has an explicit empty state per sentence and a
//      no-analysis state that reuses the existing 028 GET (no new AI: every
//      teaching-analysis request in the run is a GET, no process/translate
//      calls are made);
//   4b. P2-09 typography: English is the primary line (17px) above the Chinese
//       support line (15px); 1440 and 375 stay inside the media stage without
//       horizontal clipping;
//   4c. P2-09 history: the gloss window keeps earlier sentences under the
//       current one (5 sentences driven by seek), a revisited block moves to
//       the top instead of duplicating, an empty sentence keeps the backlog
//       and shows 本句无生词 on top, and the window auto-scrolls to the top
//       until the learner scrolls down by hand;
//   5. watch OFF restores the previous stacked/split layout + teaching panel;
//   6. reduced-motion: the overlay/rail carry no animation or transition;
//   7. 1440 and 375 screenshots, no horizontal overflow at 375.
//   8. P2-10 page fullscreen: the retired player fullscreen button is gone; the
//      watch toggle calls `requestFullscreen()` on the learning shell inside the
//      click gesture, leaving watch mode calls `exitFullscreen()`, an ESC-style
//      browser exit keeps the watch layout and only syncs `data-page-fullscreen`,
//      a rejected/missing Fullscreen API degrades to the layout silently, and a
//      route change cleans up the page fullscreen (all via a page-side stub).
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

// ── fixtures ───────────────────────────────────────────────────────────────
const VIDEO_ID = 'acceptance-watch';
const EMPTY_VIDEO_ID = 'acceptance-watch-empty';
const HISTORY_VIDEO_ID = 'acceptance-watch-history';
const HISTORY_FILE = `${VIDEO_ID}_zh-CN.json`;
const HISTORY_VIDEO_FILE = `${HISTORY_VIDEO_ID}_zh-CN.json`;
const EMPTY_HISTORY_FILE = `${EMPTY_VIDEO_ID}_zh-CN.json`;

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
        en_text: 'Steam curls up toward the window.',
        zh_text: '蒸汽朝窗户升起。',
        highlights: [],
    },
];

const METADATA = {
    title: 'Watch Mode Acceptance',
    channel: 'LinguaTrek Test',
    channel_url: 'https://www.youtube.com/@linguatrek-test',
    duration: 24,
};

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
        ],
        1: [
            { en_word: 'breakfast', zh_word: '早餐', color: '' },
            { en_word: 'walk', zh_word: '散步', color: '' },
        ],
        3: [
            { en_word: 'stays', zh_word: '保持', color: '' },
            { en_word: 'still', zh_word: '静止', color: '' },
        ],
        4: [
            { en_word: 'kettle', zh_word: '水壶', color: '' },
            { en_word: 'sing', zh_word: '鸣叫', color: '' },
        ],
        5: [
            { en_word: 'steam', zh_word: '蒸汽', color: '' },
            { en_word: 'curls', zh_word: '卷曲', color: '' },
        ],
    },
};

const HISTORY_ITEMS = [
    { videoId: VIDEO_ID, filename: HISTORY_FILE, title: METADATA.title, channel: METADATA.channel },
    { videoId: HISTORY_VIDEO_ID, filename: HISTORY_VIDEO_FILE, title: 'History Clip', channel: METADATA.channel },
    { videoId: EMPTY_VIDEO_ID, filename: EMPTY_HISTORY_FILE, title: 'No Analysis Clip', channel: METADATA.channel },
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
            return respond({ user: { id: 'u-watch', email: 'watch@example.com' }, isAdmin: false, guest: false });
        }
        if (pathname === '/api/auth/registration') {
            return respond({ registrationOpen: false, inviteSignupEnabled: true, inviteRequired: true, registrationClosed: false });
        }
        if (pathname === '/api/history') return respond(HISTORY_ITEMS);
        if (pathname === `/api/history/${HISTORY_FILE}`) return respond(videoPayload(VIDEO_ID, BLOCKS));
        if (pathname === `/api/history/${HISTORY_VIDEO_FILE}`) return respond(videoPayload(HISTORY_VIDEO_ID, HISTORY_BLOCKS, 'History Clip'));
        if (pathname === `/api/history/${EMPTY_HISTORY_FILE}`) return respond(videoPayload(EMPTY_VIDEO_ID, EMPTY_BLOCKS));
        if (pathname === `/api/teaching-analysis/${VIDEO_ID}`) return respond(ANALYSIS);
        if (pathname === `/api/teaching-analysis/${HISTORY_VIDEO_ID}`) return respond(HISTORY_ANALYSIS);
        if (pathname === `/api/teaching-analysis/${EMPTY_VIDEO_ID}`) {
            return respond({ detail: 'NOT_FOUND' }, 404);
        }
        if (pathname === '/api/favorites') return respond([]);
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
    await page.locator('[data-testid="watch-mode-toggle"]').waitFor({ state: 'attached', timeout: 20000 });
}

const boxOf = (page, testId) => page.evaluate((id) => {
    const element = document.querySelector(`[data-testid="${id}"]`);
    if (!element) return null;
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, bottom: rect.bottom };
}, testId);

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
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/api/')) apiRequests.push({ method: request.method(), path: url.pathname });
    });

    await openVideo(page, VIDEO_ID);

    // — toggle OFF is the default even with a split layout stored —
    assert.equal(await page.getAttribute('[data-testid="watch-mode-toggle"]', 'aria-pressed'), 'false');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'off');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off');
    assert.equal(await page.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'the player must not render a standalone fullscreen button');
    assert.equal(await page.locator('[data-testid="watch-mode-toggle"]').count(), 1, 'the watch toggle must be the only watch control');
    assert.equal(await page.locator('[data-testid="teaching-notes-panel"]').count(), 1, 'teaching panel missing before watch mode');
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 1, 'split layout not restored on load');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'off');

    // — turn watch mode on from the player toolbar —
    await page.locator('[data-testid="video-area"]').hover();
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'on', null, { timeout: 5000 });
    // P2-10: the same click requests page fullscreen on the watch shell.
    await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__fsStub.requests), 1, 'entering watch mode must request page fullscreen');
    assert.equal(await page.evaluate(() => window.__fsStub.requestedTestId), 'learning-scroll', 'fullscreen must target the watch shell');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'on');
    assert.equal(await page.getAttribute('[data-testid="watch-mode-toggle"]', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(await page.locator('[data-testid="teaching-notes-panel"]').count(), 0, 'teaching panel must NOT be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="summary-panel"]').count(), 0, 'summary panel must not be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="transcript-column"]').count(), 0, 'transcript column must not be mounted in watch mode');
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 0, 'split divider must not be mounted in watch mode');
    // The toggle must not reset the other two layout preferences.
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_transcript_layout')), 'split');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_split_ratio')), '60');

    // — the ≥1280 gloss window is a fixed right rail, 320–360 wide —
    const rail = await boxOf(page, 'watch-gloss-rail');
    assert.ok(rail, 'gloss rail missing at 1440');
    assert.ok(rail.width >= 320 && rail.width <= 360, `rail width ${rail.width} outside 320–360`);
    const videoColumn = await boxOf(page, 'video-column');
    const shell = await boxOf(page, 'learning-scroll');
    assert.ok(videoColumn && shell, 'video column / shell missing');
    assert.ok(Math.abs((videoColumn.x || 0) - (shell.x || 0)) < 2, 'video column should start at the shell edge');
    assert.ok(Math.abs(shell.width - (videoColumn.width + rail.width)) < 2, `shell ${shell.width} != media ${videoColumn.width} + rail ${rail.width}`);
    assert.ok(rail.x >= videoColumn.x + videoColumn.width - 2, 'rail is not to the right of the media');
    assert.ok(Math.abs(shell.x + shell.width - (rail.x + rail.width)) < 2, 'rail does not end at the shell edge');
    const mediaStageWatch = await boxOf(page, 'video-area');
    assert.ok((mediaStageWatch?.height ?? 0) > 900 * 0.62 * 0.9, 'watch mode did not enlarge the media stage');

    // — before the first cue there is no current sentence → overlay hidden —
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0, 'overlay should hide with no current sentence');

    // — ArrowRight from "before the first cue" jumps to cue 0 —
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'Small habits');
    await waitForRailText(page, '习惯');
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
    // P2-10 retired the standalone fullscreen control: the watch toggle is the
    // only player control the overlay has to clear.
    assert.equal(await page.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'retired fullscreen button is still mounted');
    const controlBoxes = await Promise.all([
        boxOf(page, 'watch-mode-toggle'),
    ]);
    assert.ok(controlBoxes.every(Boolean), 'player controls missing');
    const overlapsControls = controlBoxes.some((controls) => (
        overlay.x < controls.x + controls.width
        && overlay.x + overlay.width > controls.x
        && overlay.y < controls.y + controls.height
        && overlay.y + overlay.height > controls.y
    ));
    assert.ok(!overlapsControls, 'subtitle overlay overlaps the player controls');

    // — gloss rail content matches the analysis for cue 0 —
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 1);
    assert.ok((await page.locator('[data-testid="watch-gloss-word"]').first().innerText()).includes('habits'));
    assert.ok((await page.locator('[data-testid="watch-gloss-word"]').first().innerText()).includes('习惯'));
    assert.equal(await page.locator('[data-testid="watch-gloss-language-point"]').count(), 0, 'cue 0 has no language point');

    // — the overlay follows playback into cue 1 (no seek) —
    await waitForOverlay(page, 'A short walk', 12000);
    await waitForRailText(page, '早餐', 12000);
    await pausePlayback(page);
    assert.equal(await page.locator('[data-testid="watch-gloss-language-point"]').count(), 1);
    const pointText = await page.locator('[data-testid="watch-gloss-language-point"]').first().innerText();
    assert.ok(pointText.includes('before breakfast') && pointText.includes('早餐前'), `language point mismatch: ${pointText}`);

    // — P2-09 history: cue 1 on top, cue 0 still below, no repetition —
    await waitForGlossEntries(page, 2);
    const cue1Entries = page.locator('[data-testid="watch-gloss-entry"]');
    assert.equal(await cue1Entries.first().getAttribute('data-current'), 'true', 'newest sentence is not marked current');
    assert.ok((await cue1Entries.first().innerText()).includes('A short walk'), 'newest sentence is not on top');
    const cue1Contexts = await page.locator('[data-testid="watch-gloss-entry-context"]').allInnerTexts();
    assert.ok(cue1Contexts[0].includes('A short walk'), `top context is not cue 1: ${JSON.stringify(cue1Contexts)}`);
    assert.ok(cue1Contexts[1]?.includes('Small habits'), `previous sentence missing below: ${JSON.stringify(cue1Contexts)}`);
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'words from both sentences should remain visible');
    assert.ok(
        (await page.locator('[data-testid="watch-gloss-word"]').allInnerTexts()).some((text) => text.includes('habits')),
        'earlier word habits disappeared from the history',
    );
    const cue1Scroll = await scrollMetrics(page);
    assert.equal(cue1Scroll.scrollTop, 0, 'a new sentence should leave the window at the top');

    // — seek to cue 2: overlay follows, gloss shows the explicit empty state on top —
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'Nobody moves');
    await pausePlayback(page);
    await page.locator('[data-testid="watch-gloss-empty"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await page.locator('[data-testid="watch-gloss-empty"]').innerText()).includes('本句无生词'));
    await waitForGlossEntries(page, 3);
    const cue2Entries = page.locator('[data-testid="watch-gloss-entry"]');
    assert.equal(await cue2Entries.first().getAttribute('data-current'), 'true');
    const cue2Top = await cue2Entries.first().innerText();
    assert.ok(cue2Top.includes('Nobody moves') && cue2Top.includes('本句无生词'), `empty sentence is not the top entry: ${cue2Top}`);
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'earlier words must survive an empty sentence');
    summary.screenshots.push(shot('1440-history'));
    await page.screenshot({ path: shot('1440-history') });

    // — revisit cue 1 and cue 0: moved to the top, never inserted twice —
    await page.keyboard.press('ArrowLeft');
    await waitForOverlay(page, 'A short walk');
    await pausePlayback(page);
    await page.waitForFunction(() => {
        const first = document.querySelector('[data-testid="watch-gloss-entry"]');
        return first?.getAttribute('data-current') === 'true' && (first.textContent || '').includes('A short walk');
    }, null, { timeout: 10000 });
    assert.equal(await glossEntryCount(page), 2, 'revisiting a sentence must not duplicate it');
    await page.keyboard.press('ArrowLeft');
    await waitForOverlay(page, 'Small habits');
    await pausePlayback(page);
    await page.waitForFunction(() => {
        const first = document.querySelector('[data-testid="watch-gloss-entry"]');
        return first?.getAttribute('data-current') === 'true' && (first.textContent || '').includes('Small habits');
    }, null, { timeout: 10000 });
    assert.equal(await glossEntryCount(page), 2, 'revisiting cue 0 duplicated the history');
    const revisitContexts = await page.locator('[data-testid="watch-gloss-entry-context"]').allInnerTexts();
    assert.equal(revisitContexts.filter((text) => text.includes('Small habits')).length, 1, 'revisited sentence duplicated');
    assert.ok(revisitContexts[0].includes('Small habits'), 'revisited sentence did not move to the top');
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'A short walk');
    await pausePlayback(page);
    await page.waitForFunction(() => {
        const first = document.querySelector('[data-testid="watch-gloss-entry"]');
        return first?.getAttribute('data-current') === 'true' && (first.textContent || '').includes('A short walk');
    }, null, { timeout: 10000 });
    assert.equal(await glossEntryCount(page), 2, 'moving forward duplicated an existing sentence');
    assert.equal(await page.locator('[data-testid="watch-gloss-word"]').count(), 2, 'history lost a word after the revisit');

    // — turn watch mode off: stacked/split layout + teaching panel return —
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'off', null, { timeout: 5000 });
    // P2-10: leaving the mode also leaves page fullscreen (the stub is still on).
    await page.waitForFunction(() => document.fullscreenElement === null, null, { timeout: 5000 });
    assert.equal(await page.evaluate(() => window.__fsStub.exits), 1, 'leaving watch mode must call exitFullscreen');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off');
    await page.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.locator('[data-testid="watch-gloss-rail"]').count(), 0);
    assert.equal(await page.locator('[data-testid="watch-subtitle-overlay"]').count(), 0);
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 1, 'split layout not restored after watch off');
    assert.equal(await page.locator('[data-testid="right-column"] [data-testid="transcript-column"]').count(), 1, 'split transcript pane missing');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_transcript_layout')), 'split');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_split_ratio')), '60');

    // — persistence across a reload —
    await page.locator('[data-testid="video-area"]').hover();
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'on');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="watch-gloss-rail"]').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-watch-mode'), 'on');
    assert.equal(await page.getAttribute('[data-testid="watch-mode-toggle"]', 'aria-pressed'), 'true');
    assert.equal(await page.getAttribute('[data-testid="learning-scroll"]', 'data-page-fullscreen'), 'off', 'persisted watch mode must not auto-request fullscreen on reload');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'on');

    await seekToGlossedCue(page);
    await page.waitForFunction(
        () => document.querySelector('[data-testid="watch-gloss-word"]') !== null,
        null,
        { timeout: 10000 },
    );
    summary.screenshots.push(shot('1440'));
    await page.screenshot({ path: shot('1440') });

    // — no analysis: explicit empty state + the existing 028 entry (GET only) —
    const beforeEmptyCalls = apiRequests.filter((entry) => entry.path.includes('/api/teaching-analysis/')).length;
    await page.evaluate(() => { window.location.hash = '#/app/content/learn/youtube/acceptance-watch-empty'; });
    await page.locator('[data-testid="watch-gloss-no-analysis"]').waitFor({ state: 'visible', timeout: 20000 });
    assert.ok((await page.locator('[data-testid="watch-gloss-no-analysis"]').innerText()).includes('本片还没有词条'));
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

    assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);
    summary.desktop = {
        railWidth: Math.round(rail.width * 10) / 10,
        videoColumnWidth: Math.round(videoColumn.width * 10) / 10,
        overlayBottomGap: Math.round(overlayRect.bottomGap * 10) / 10,
        mediaHeight: Math.round((mediaStageWatch?.height ?? 0) * 10) / 10,
        analysisRequests: analysisCalls.length,
        subtitleFontPx: { en: subtitleTypography.en.fontSize, zh: subtitleTypography.zh.fontSize },
        history: { accumulated: 2, dedupe: 'pass' },
    };
    await desktop.close();

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
        const toggle = document.querySelector('[data-testid="watch-mode-toggle"]');
        return {
            requests: window.__fsStub.requests,
            exits: window.__fsStub.exits,
            element: document.fullscreenElement
                ? document.fullscreenElement.getAttribute('data-testid')
                : null,
            watch: shell ? shell.getAttribute('data-watch-mode') : null,
            pageFullscreen: shell ? shell.getAttribute('data-page-fullscreen') : null,
            pressed: toggle ? toggle.getAttribute('aria-pressed') : null,
        };
    });
    const waitFullscreen = (present) => fsPage.waitForFunction(
        (expected) => (document.fullscreenElement !== null) === expected,
        present,
        { timeout: 5000 },
    );

    // — enter watch: request inside the click gesture, targeting the shell —
    await fsPage.locator('[data-testid="video-area"]').hover();
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await waitFullscreen(true);
    let fsState = await readFs();
    assert.equal(fsState.requests, 1, 'entering watch mode must call requestFullscreen once');
    assert.equal(fsState.element, 'learning-scroll', 'requestFullscreen must target the watch shell');
    assert.equal(fsState.watch, 'on');
    assert.equal(fsState.pageFullscreen, 'on');
    assert.equal(fsState.pressed, 'true');
    assert.equal(await fsPage.locator('[data-testid="video-fullscreen-toggle"]').count(), 0, 'retired fullscreen button must stay gone');
    assert.equal(await fsPage.locator('[data-testid="watch-mode-toggle"]').count(), 1, 'watch toggle must be the only watch control');

    // — ESC / browser chrome leaves fullscreen: the watch layout survives —
    await fsPage.evaluate(() => window.__fsStub.escape());
    await waitFullscreen(false);
    fsState = await readFs();
    assert.equal(fsState.watch, 'on', 'a browser-initiated fullscreen exit must keep the watch layout');
    assert.equal(fsState.pressed, 'true', 'a browser-initiated fullscreen exit must not toggle watch mode off');
    assert.equal(fsState.pageFullscreen, 'off', 'page-fullscreen state did not follow the document');
    assert.equal(fsState.exits, 0, 'the app must not call exitFullscreen after the browser already exited');

    // — leaving watch after ESC only restores the layout (no spurious exit) —
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await fsPage.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    fsState = await readFs();
    assert.equal(fsState.watch, 'off');
    assert.equal(fsState.exits, 0, 'leaving the watch layout out of fullscreen must not call exitFullscreen');

    // — re-enter, then leave: exit is called while the shell owns fullscreen —
    await fsPage.locator('[data-testid="video-area"]').hover();
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await waitFullscreen(true);
    fsState = await readFs();
    assert.equal(fsState.requests, 2);
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await waitFullscreen(false);
    await fsPage.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    fsState = await readFs();
    assert.equal(fsState.exits, 1, 'leaving watch mode while fullscreen must call exitFullscreen');
    assert.equal(fsState.pageFullscreen, 'off');

    // — route change away from the video page cleans up page fullscreen —
    await fsPage.locator('[data-testid="video-area"]').hover();
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
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
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await fsPage.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });

    // — rejected request: silent, layout-only fallback —
    const beforeReject = await fsPage.evaluate(() => window.__fsStub.requests);
    await fsPage.evaluate(() => { window.__fsStub.rejectNext = true; });
    await fsPage.locator('[data-testid="video-area"]').hover();
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
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
    assert.equal(fsState.pressed, 'true', 'the rejected request must keep the watch layout');
    assert.deepEqual(fsErrors, [], `rejected fullscreen request raised a page error: ${JSON.stringify(fsErrors)}`);

    // — missing API (mobile / iframe): layout-only fallback, no requests —
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await fsPage.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    await fsPage.evaluate(() => {
        delete Element.prototype.requestFullscreen;
        delete document.exitFullscreen;
    });
    const beforeUnsupported = await fsPage.evaluate(() => window.__fsStub.requests);
    await fsPage.locator('[data-testid="video-area"]').hover();
    await fsPage.locator('[data-testid="watch-mode-toggle"]').click();
    await fsPage.waitForFunction(
        () => document.querySelector('[data-testid="learning-scroll"]')?.getAttribute('data-watch-mode') === 'on',
        null,
        { timeout: 5000 },
    );
    fsState = await readFs();
    assert.equal(fsState.requests, beforeUnsupported, 'a missing Fullscreen API must not be called');
    assert.equal(fsState.element, null);
    assert.equal(fsState.pageFullscreen, 'off');
    assert.equal(fsState.pressed, 'true', 'the missing API must keep the watch layout');
    assert.deepEqual(fsConsoleErrors.filter((text) => /fullscreen/i.test(text)), [], 'fullscreen fallbacks must stay silent');
    assert.deepEqual(fsErrors, [], `fullscreen lifecycle raised page errors: ${JSON.stringify(fsErrors)}`);
    summary.pageFullscreen = {
        requests: fsState.requests,
        exits: fsState.exits,
        escKeepsWatchLayout: true,
        rejectedRequest: 'layout-only',
        missingApi: 'layout-only',
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
    assert.ok(phoneSubtitle.en.fontSize >= 17, `375 English subtitle ${phoneSubtitle.en.fontSize}px < 17px`);
    assert.ok(phoneSubtitle.zh.fontSize >= 15, `375 Chinese subtitle ${phoneSubtitle.zh.fontSize}px < 15px`);
    assert.ok(phoneSubtitle.en.top < phoneSubtitle.zh.top, '375 English must sit above Chinese');
    assert.ok(!phoneSubtitle.en.clipped && !phoneSubtitle.zh.clipped, '375 subtitle text is horizontally clipped');
    assert.ok(phoneSubtitle.insideWidth && phoneSubtitle.insideMedia, '375 subtitle overlay overflows the media stage');
    assert.equal(phoneSubtitle.pointerEvents, 'none', '375 overlay must stay pointer-events-none');
    // Collapsed: the subtitle window is visible and the floating gloss entry
    // sits on the media without covering it.
    summary.screenshots.push(shot('375'));
    await phone.screenshot({ path: shot('375') });
    // Expanded: the <1280 floating gloss layer (D1-1) carries the same words.
    await phone.locator('[data-testid="watch-gloss-toggle"]').click();
    await phone.locator('[data-testid="watch-gloss-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    const phoneWord = (await phone.locator('[data-testid="watch-gloss-word"]').first().innerText()).trim();
    assert.ok(phoneWord.length > 0, 'floating gloss window has no glossed word');
    summary.screenshots.push(shot('375-gloss'));
    await phone.screenshot({ path: shot('375-gloss') });
    // Watch OFF on the phone restores the stacked column + teaching panel.
    await phone.locator('[data-testid="watch-mode-toggle"]').click();
    await phone.locator('[data-testid="teaching-notes-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await phone.locator('[data-testid="watch-gloss-toggle"]').count(), 0);
    assert.equal(await phone.locator('[data-testid="watch-subtitle-overlay"]').count(), 0);
    assert.equal(await phone.locator('[data-testid="transcript-column"]').count(), 1, 'stacked transcript column missing after watch off');
    assert.equal(await phone.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'off');
    assert.deepEqual(phoneErrors, [], `375 page errors: ${JSON.stringify(phoneErrors)}`);
    summary.phone = {
        documentWidth: overflow375.documentWidth,
        viewport: overflow375.viewport,
        subtitleFontPx: { en: phoneSubtitle.en.fontSize, zh: phoneSubtitle.zh.fontSize },
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

    await historyPage.locator('[data-testid="watch-gloss-toggle"]').click();
    await historyPage.locator('[data-testid="watch-gloss-panel"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await historyPage.locator('[data-testid="watch-gloss-rail"]').count(), 0, 'history run must use the floating variant at 375');
    await waitForGlossEntries(historyPage, 4);
    const historyInitial = await scrollMetrics(historyPage);
    assert.equal(historyInitial.scrollTop, 0, 'newest sentence should start at scrollTop 0');
    assert.ok(
        historyInitial.scrollHeight > historyInitial.clientHeight,
        `history window does not overflow (${historyInitial.scrollHeight} <= ${historyInitial.clientHeight}); scroll contract cannot be exercised`,
    );
    const historyContexts = await historyPage.locator('[data-testid="watch-gloss-entry-context"]').allInnerTexts();
    assert.ok(historyContexts[0].includes('Then the kettle'), `newest sentence is not on top: ${JSON.stringify(historyContexts)}`);
    for (const earlier of ['The room stays', 'A short walk', 'Small habits']) {
        assert.ok(historyContexts.some((text) => text.includes(earlier)), `earlier sentence missing from history: ${earlier}`);
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
    const topAfterNew = await historyPage.locator('[data-testid="watch-gloss-entry"]').first().innerText();
    assert.ok(topAfterNew.includes('Steam curls'), 'new sentence is not the top entry after manual scroll');

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
    await historyPage.waitForFunction(() => {
        const first = document.querySelector('[data-testid="watch-gloss-entry"]');
        return first?.getAttribute('data-current') === 'true' && (first.textContent || '').includes('Then the kettle');
    }, null, { timeout: 10000 });
    assert.equal(await glossEntryCount(historyPage), 5, 'revisiting a sentence in the history duplicated it');
    const afterTop = await scrollMetrics(historyPage);
    assert.equal(afterTop.scrollTop, 0, 'auto-follow did not keep the window at the top after scrolling back up');
    assert.deepEqual(historyErrors, [], `history page errors: ${JSON.stringify(historyErrors)}`);
    summary.history = {
        entries: 5,
        scrollHeight: historyInitial.scrollHeight,
        clientHeight: historyInitial.clientHeight,
        manualScrollTop: Math.round(afterManualScroll.scrollTop),
        autoScrollTop: afterTop.scrollTop,
    };
    await historyContext.close();

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
        };
    });
    assert.equal(motion.prefersReduce, true);
    for (const key of ['overlay', 'rail', 'scroll']) {
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
