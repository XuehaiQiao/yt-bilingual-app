// Acceptance check for P1-16: one word-book entry in the top bar.
//
// What it proves, against the real React shell + mocked API:
//   - reading / free-library-video / local-video pages show the same top-bar
//     word-book chip (testid `topbar-wordbook`) and count as the browsing
//     pages, and none of those pages keeps an in-page entry
//     (`reading-wordbook` / `learning-wordbook`);
//   - the chip lives inside `top-bar` and keeps the same 36px height on every
//     page (one component, one place);
//   - clicking it opens `#/app/<tab>/vocabulary` (the shared word-book route),
//     and the count matches App's favorites (one vocabulary favorite);
//   - the reading page's count hook is the same chip (`reading-wordbook-count`
//     was the P1-15 script's top-bar hook; it must stay resolvable);
//   - 375: no horizontal overflow; the local-video page (not a sub view) keeps
//     the chip on mobile; screenshots at 1440 and 375 per page.
//
// Run (needs `npm run dev` on :5173, local-video fixtures under /tmp):
//   node scripts/topbar-wordbook-acceptance.mjs
//   APP_URL=http://127.0.0.1:5174 node scripts/topbar-wordbook-acceptance.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name, width) => `/tmp/topbar-wordbook-${name}-${width}@${HEAD}.png`;
const VIDEO = process.env.LOCAL_VIDEO || '/tmp/flower.mp4';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

assert.ok(fs.existsSync(VIDEO), `missing fixture video: ${VIDEO}`);
const VIDEO_BASE64 = fs.readFileSync(VIDEO).toString('base64');
const VIDEO_SIZE = fs.statSync(VIDEO).size;
const VIDEO_LAST_MODIFIED = 1763000000000;

// ── fixtures ───────────────────────────────────────────────────────────────
const VOCAB_FAVORITE = {
    id: 'vocab-art1-quiet',
    type: 'vocabulary',
    videoId: 'art1',
    start: 0,
    en_text: 'quiet',
    zh_text: '安静的',
    added_at: 1763000000000,
    source_kind: 'article',
    source_ref: 'art1',
    source_title: 'Habits and Cities',
};

const ARTICLE_DETAIL = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 2,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    analysisLevel: 'orbit',
    analysisUnavailableReason: null,
    analysisUsed: null,
    analysisLimit: null,
    analysisResetAt: null,
    idioms: [],
    culture: [],
    paragraphs: [
        {
            idx: 0,
            text: 'The quiet river carries a gentle rhythm through the old city.',
            translation: '安静的河流带着轻柔的节奏穿过老城。',
            translationModel: 'deepseek-chat',
            translationFailed: false,
            highlights: [
                { en_word: 'quiet', zh_word: '安静的', color: '#f59e0b' },
                { en_word: 'rhythm', zh_word: '节奏', color: '#f59e0b' },
            ],
        },
    ],
    progress: null,
    stats: { total: 1, translated: 1, untranslated: 0 },
};

const ARTICLE_SUMMARY = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 2,
    createdAt: 1763000000000,
    paragraphCount: 1,
    progress: null,
};

const LIBRARY_VIDEO = {
    id: 'lv1',
    title: 'A Quiet Morning',
    channel: 'LinguaTrek',
    duration: 30,
    level: 'A2',
    youtubeId: 'dQw4w9WgXcQ',
    free: true,
    source: 'original',
    blocks: [
        { id: 0, start: 0, end: 3, en_text: 'The quiet river flows.', zh_text: '安静的河流。', highlights: [] },
        { id: 1, start: 3, end: 6, en_text: 'A gentle rhythm follows.', zh_text: '轻柔的节奏随之而来。', highlights: [] },
    ],
};

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

/** One isolated store per context: the favorites array is App's source. */
function makeBackend() {
    return { favorites: [VOCAB_FAVORITE] };
}

async function mockApi(context, backend) {
    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const method = request.method();
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const path = new URL(request.url()).pathname;
        const respond = (data, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: CORS,
            body: JSON.stringify(data),
        });

        if (path === '/api/auth/me') {
            return respond({
                guest: false,
                isAdmin: false,
                user: { id: 'u-topbar', email: 'topbar@example.com', username: 'TopBar' },
            });
        }
        if (path === '/api/favorites' && method === 'GET') return respond(backend.favorites);
        if (path === '/api/history' || path === '/api/subscriptions') return respond([]);
        if (path === '/api/sentences/levels') return respond([]);
        if (path === '/api/shows') return respond({ shows: [] });
        if (path === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
                default: 'deepseek-chat',
            });
        }
        if (path === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
        if (path === '/api/placement/profile') return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
        if (path === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-23', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (path === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
        if (path === '/api/content/difficulty/batch') return respond({ items: [] });
        if (path === '/api/vocabulary/classify') {
            const body = request.postDataJSON() || {};
            return respond({
                items: (body.items || []).map((item) => ({
                    text: typeof item.text === 'string' ? item.text : '',
                    level: 'B2',
                    proper: false,
                })),
            });
        }
        if (path === '/api/articles' && method === 'GET') return respond({ articles: [ARTICLE_SUMMARY] });
        if (path === '/api/article/art1') return respond(ARTICLE_DETAIL);
        if (path === '/api/library/videos/lv1') return respond(LIBRARY_VIDEO);
        if (path.startsWith('/api/vocabulary/')) return respond({});
        if (path === '/api/review/words' || path.startsWith('/api/review/')) return respond({ words: [], total: 0 });
        if (path.startsWith('/api/')) return respond({});
        return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    });
}

async function newPage(browser, backend, { viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
        try {
            localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
            localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
            localStorage.setItem('yt_bilingual_vocab_level', 'orbit');
            localStorage.removeItem('yt_bilingual_reading_highlight');
        } catch {
            /* about:blank has no storage; the real document is covered next. */
        }
    });
    await mockApi(context, backend);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return { context, page, errors };
}

// ── helpers ───────────────────────────────────────────────────────────────
const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

async function waitForText(page, selector, value, label) {
    await page.waitForFunction(
        ({ selector: sel, value: want }) =>
            (document.querySelector(sel)?.textContent ?? '').trim() === want,
        { selector, value },
        { timeout: 10000 },
    ).catch(() => { throw new Error(`${label} timed out`); });
}

async function noOverflow(page, label) {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
}

async function openRoute(page, hash, ready) {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator(ready).waitFor({ state: 'visible', timeout: 20000 });
    await sleep(250);
}

/** The one shared chip: inside the top bar, visible, count from App favorites. */
async function assertTopbarChip(page, label, expectedCount) {
    const chip = page.locator('[data-testid="top-bar"] [data-testid="topbar-wordbook"]');
    await chip.waitFor({ state: 'visible', timeout: 10000 });
    const count = page.locator('[data-testid="top-bar"] [data-testid="reading-wordbook-count"]');
    await count.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(clean(await count.innerText()), String(expectedCount), `${label}: count`);
    assert.equal(
        clean(await chip.getAttribute('aria-label')),
        `单词本 (${expectedCount})`,
        `${label}: aria-label carries the count`,
    );
    const box = await chip.boundingBox();
    assert.ok(box, `${label}: chip has a box`);
    assert.equal(Math.round(box.height), 36, `${label}: chip height matches the shell recipe`);
    return box;
}

async function assertNoInPageEntry(page, label) {
    assert.equal(await page.locator('[data-testid="reading-wordbook"]').count(), 0, `${label}: no reader header chip`);
    assert.equal(await page.locator('[data-testid="learning-wordbook"]').count(), 0, `${label}: no learning header chip`);
}

async function assertOpensWordbook(page, label, expectedHash) {
    await page.locator('[data-testid="topbar-wordbook"]').click();
    await page.locator('[data-testid="vocabulary-book"]').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(
        (want) => window.location.hash === want,
        expectedHash,
        { timeout: 10000 },
    ).catch(() => { throw new Error(`${label}: route is ${page.url()} after the chip click`); });
    assert.equal(await page.locator('[data-testid="top-bar"] [data-testid="reading-wordbook-count"]').innerText(), '1', `${label}: count persists on the word-book page`);
}

async function shot(page, name, width) {
    const file = SHOT(name, width);
    await page.screenshot({ path: file });
    return file;
}

async function installMockHandle(page) {
    await page.evaluate(({ base64, lastModified }) => {
        window.__mockState = {
            bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
            lastModified,
        };
        // Methods live on the prototype on purpose: IndexedDB structured clone
        // keeps own props, exactly like a real file handle.
        class MockFileHandle {
            constructor() {
                this.kind = 'file';
                this.name = 'flower.mp4';
                this.lastModified = lastModified;
            }
            async queryPermission() { return 'granted'; }
            async requestPermission() { return 'granted'; }
            async getFile() {
                return new File([window.__mockState.bytes], this.name, {
                    type: 'video/mp4',
                    lastModified: window.__mockState.lastModified,
                });
            }
        }
        window.showOpenFilePicker = async () => [new MockFileHandle()];
    }, { base64: VIDEO_BASE64, lastModified: VIDEO_LAST_MODIFIED });
}

// ── scenarios ─────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const screenshots = [];
const results = [];

try {
    // 1) Reading page: top-bar chip, no in-page entry, click → word book.
    {
        const backend = makeBackend();
        const { context, page, errors } = await newPage(browser, backend);
        await openRoute(page, '/app/content/reader/art1', '[data-testid="reader-en-0"]');

        const box = await assertTopbarChip(page, 'reader', 1);
        await assertNoInPageEntry(page, 'reader');
        assert.equal(
            await page.locator('[data-testid="top-bar"] [data-testid="reading-wordbook-count"]').innerText(),
            '1',
            'reader: P1-15 count hook resolves inside the top bar',
        );

        const desktop = await shot(page, 'reader', 1440);
        screenshots.push(desktop);
        await assertOpensWordbook(page, 'reader', '#/app/content/vocabulary');

        await openRoute(page, '/app/content/reader/art1', '[data-testid="reader-en-0"]');
        await page.setViewportSize({ width: 375, height: 812 });
        await sleep(350);
        await noOverflow(page, 'reader 375');
        await assertNoInPageEntry(page, 'reader 375');
        const mobile = await shot(page, 'reader', 375);
        screenshots.push(mobile);

        assert.deepEqual(errors, [], `reader page errors: ${JSON.stringify(errors)}`);
        results.push({ page: 'reader', count: 1, chipHeight: Math.round(box.height), screenshots: [desktop, mobile] });
        await context.close();
    }

    // 2) Video task page (free library video): same chip, no LearningHeader chip.
    {
        const backend = makeBackend();
        const { context, page, errors } = await newPage(browser, backend);
        await openRoute(page, '/app/content/learn/library/lv1', '[data-testid="learning-header"]');

        await assertTopbarChip(page, 'video', 1);
        await assertNoInPageEntry(page, 'video');
        const desktop = await shot(page, 'video', 1440);
        screenshots.push(desktop);
        await assertOpensWordbook(page, 'video', '#/app/content/vocabulary');

        assert.deepEqual(errors, [], `video page errors: ${JSON.stringify(errors)}`);
        results.push({ page: 'video', count: 1, screenshots: [desktop] });
        await context.close();
    }

    // 3) Local video: the page's own LearningHeader no longer owns the entry;
    //    the AppShell chip stays visible (this view is not a sub route, so it
    //    also keeps the chip at 375).
    {
        const backend = makeBackend();
        const { context, page, errors } = await newPage(browser, backend);
        await page.goto(`${BASE}/#/app/content`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid="content-materials"]').waitFor({ state: 'visible', timeout: 20000 });
        await installMockHandle(page);
        await page.locator('[data-testid="local-video-open"]').click();
        await page.locator('[data-testid="local-video-player"]').waitFor({ state: 'visible', timeout: 15000 });
        await page.waitForFunction(() => {
            const video = document.querySelector('[data-testid="local-video-player"]');
            return video && video.readyState >= 2;
        }, undefined, { timeout: 15000 });
        await sleep(300);

        await assertTopbarChip(page, 'local-video', 1);
        await assertNoInPageEntry(page, 'local-video');
        const desktop = await shot(page, 'local-video', 1440);
        screenshots.push(desktop);

        await page.setViewportSize({ width: 375, height: 812 });
        await sleep(350);
        await assertTopbarChip(page, 'local-video 375', 1);
        await noOverflow(page, 'local-video 375');
        const mobile = await shot(page, 'local-video', 375);
        screenshots.push(mobile);

        await page.setViewportSize({ width: 1440, height: 1000 });
        await sleep(250);
        await assertOpensWordbook(page, 'local-video', '#/app/content/vocabulary');

        assert.deepEqual(errors, [], `local-video page errors: ${JSON.stringify(errors)}`);
        results.push({ page: 'local-video', count: 1, screenshots: [desktop, mobile] });
        await context.close();
    }

    console.log(JSON.stringify({ status: 'PASS', head: HEAD, results, screenshots }, null, 2));
} finally {
    await browser.close();
}
