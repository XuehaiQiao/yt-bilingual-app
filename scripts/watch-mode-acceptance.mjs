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
//   5. watch OFF restores the previous stacked/split layout + teaching panel;
//   6. reduced-motion: the overlay/rail carry no animation or transition;
//   7. 1440 and 375 screenshots, no horizontal overflow at 375.
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
const HISTORY_FILE = `${VIDEO_ID}_zh-CN.json`;
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

const HISTORY_ITEMS = [
    { videoId: VIDEO_ID, filename: HISTORY_FILE, title: METADATA.title, channel: METADATA.channel },
    { videoId: EMPTY_VIDEO_ID, filename: EMPTY_HISTORY_FILE, title: 'No Analysis Clip', channel: METADATA.channel },
];

const videoPayload = (videoId, blocks) => ({
    videoId,
    metadata: { ...METADATA, title: videoId === VIDEO_ID ? METADATA.title : 'No Analysis Clip' },
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
        if (pathname === `/api/history/${EMPTY_HISTORY_FILE}`) return respond(videoPayload(EMPTY_VIDEO_ID, EMPTY_BLOCKS));
        if (pathname === `/api/teaching-analysis/${VIDEO_ID}`) return respond(ANALYSIS);
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

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const summary = { status: 'PASS', head: HEAD, screenshots: [] };

try {
    // ═════════════════════════════════════════════════════════════════════
    // 1440 — full flow: off → on → layout/subtitle/gloss → off → persist
    // ═════════════════════════════════════════════════════════════════════
    const desktop = await createContext(browser);
    const page = await desktop.newPage();
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
    assert.equal(await page.locator('[data-testid="teaching-notes-panel"]').count(), 1, 'teaching panel missing before watch mode');
    assert.equal(await page.locator('[data-testid="split-divider"]').count(), 1, 'split layout not restored on load');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_watch_mode')), 'off');

    // — turn watch mode on from the player toolbar —
    await page.locator('[data-testid="video-area"]').hover();
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'on', null, { timeout: 5000 });
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
    assert.ok(zhBox && enBox && zhBox.y < enBox.y, 'Chinese must sit above English');
    // Chinese-first text order in the DOM as well.
    const order = await page.evaluate(() => {
        const zh = document.querySelector('[data-testid="watch-subtitle-zh"]');
        const en = document.querySelector('[data-testid="watch-subtitle-en"]');
        return Boolean(zh && en && (zh.compareDocumentPosition(en) & Node.DOCUMENT_POSITION_FOLLOWING));
    });
    assert.ok(order, 'DOM order is not Chinese-then-English');

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
    const controlBoxes = await Promise.all([
        boxOf(page, 'watch-mode-toggle'),
        boxOf(page, 'video-fullscreen-toggle'),
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
    assert.equal(await page.locator('[data-testid="watch-gloss-language-point"]').count(), 1);
    const pointText = await page.locator('[data-testid="watch-gloss-language-point"]').first().innerText();
    assert.ok(pointText.includes('before breakfast') && pointText.includes('早餐前'), `language point mismatch: ${pointText}`);

    // — seek to cue 2: overlay follows, gloss shows the explicit empty state —
    await page.keyboard.press('ArrowRight');
    await waitForOverlay(page, 'Nobody moves');
    await page.locator('[data-testid="watch-gloss-empty"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok((await page.locator('[data-testid="watch-gloss-empty"]').innerText()).includes('本句无生词'));

    // — turn watch mode off: stacked/split layout + teaching panel return —
    await page.locator('[data-testid="watch-mode-toggle"]').click();
    await page.waitForFunction(() => localStorage.getItem('yt_bilingual_watch_mode') === 'off', null, { timeout: 5000 });
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
    };
    await desktop.close();

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
    summary.phone = { documentWidth: overflow375.documentWidth, viewport: overflow375.viewport };
    await phoneContext.close();

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
