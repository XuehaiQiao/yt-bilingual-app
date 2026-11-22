// P2-05A desktop layout acceptance (docs/设计-桌面布局规范.md §7).
//
// Real pages, mocked API: opens the five P2-05A routes and asserts against the
// live DOM at 1440 / 1920 / 375:
//   - 单词本: `PageContainer variant="wide"`; at 1440 the sheet is ≥1100 and the
//     toolbar and the table share the exact same width; 375 hides the desktop
//     header and never overflows; 词族 tab / 编辑 / 全选 / 导出 / 星标 / 对勾
//     testids all survive;
//   - 内容发现 / 阅读列表: `standard` (≥1100 content); search / filter row and
//     the result list keep the container width;
//   - 练习 / 我的: `standard` (1200 at 1440, 1280 at 1920) with a 2–3 column
//     card grid on desktop and one column at 375;
//   - 375 everywhere: no horizontal overflow.
// Screenshots: /tmp/p2-05a-<page>-<width>@<sha7>.png.
//
// Run: node scripts/p2-05a-layout-acceptance.mjs
// Needs `npm run dev` on http://127.0.0.1:5173 (override with APP_URL).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const CHROME =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name, width) => `/tmp/p2-05a-${name}-${width}@${HEAD}.png`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────
const FAVORITES = [
    {
        id: 'f1', videoId: 'art1', start: 0, en_text: 'quiet', zh_text: '安静的',
        added_at: 1763000006000, type: 'vocabulary', source_kind: 'article',
        source_ref: 'art1', source_title: 'Habits and Cities',
    },
    {
        id: 'f2', videoId: 'art1', start: 18, en_text: 'noticed', zh_text: '注意到',
        added_at: 1763000005000, type: 'vocabulary', source_kind: 'article',
        source_ref: 'art1', source_title: 'Habits and Cities',
    },
    {
        id: 'f3', videoId: 'b1', start: 0, en_text: 'acknowledged', zh_text: '公认的',
        added_at: 1763000004000, type: 'vocabulary', source_kind: 'book',
        source_ref: 'b1', source_title: 'Pride and Prejudice',
    },
    {
        id: 'f4', videoId: 'art1', start: 44, en_text: 'considerable', zh_text: '相当大的',
        added_at: 1763000003000, type: 'vocabulary', source_kind: 'article',
        source_ref: 'art1', source_title: 'Habits and Cities',
    },
    {
        id: 'f5', videoId: 'art1', start: 61, en_text: 'movement', zh_text: '移动',
        added_at: 1763000002000, type: 'vocabulary', source_kind: 'article',
        source_ref: 'art1', source_title: 'Habits and Cities',
    },
    {
        id: 'f6', videoId: 'b1', start: 120, en_text: 'possession', zh_text: '拥有',
        added_at: 1763000001000, type: 'vocabulary', source_kind: 'book',
        source_ref: 'b1', source_title: 'Pride and Prejudice',
    },
];

const VOCABULARY_CATALOG = [
    { id: 'cefr', label: 'CEFR 词表', count: 20, byLevel: { A1: 5, A2: 5, B1: 5, B2: 5 }, source: 'test', license: 'CC', approximate: true, available: true, version: 'v1' },
    { id: 'gre', label: 'GRE', count: 10, byLevel: { B2: 5, C1: 5 }, source: 'test', license: 'CC', approximate: true, available: true, version: 'v1' },
    { id: 'cet4', label: 'CET-4', count: 10, byLevel: { A2: 5, B1: 5 }, source: 'test', license: 'CC', approximate: true, available: true, version: 'v1' },
];

const VOCABULARY_LEVELS = {
    quiet: 'A2',
    noticed: 'B1',
    acknowledged: 'C1',
    considerable: 'B1',
    movement: 'A2',
    possession: 'B2',
};

const ARTICLE_SUMMARIES = [
    { articleId: 'art1', title: 'Habits and Cities', site: 'example.com', sourceUrl: null, lang: 'en', wordCount: 820, createdAt: 1763000000000, paragraphCount: 12, progress: null },
    { articleId: 'art2', title: 'How a River Remembers', site: 'example.org', sourceUrl: null, lang: 'en', wordCount: 640, createdAt: 1762990000000, paragraphCount: 9, progress: null },
    { articleId: 'art3', title: 'A Very Short Walk', site: null, sourceUrl: null, lang: 'en', wordCount: 210, createdAt: 1762980000000, paragraphCount: 3, progress: null },
];

const DISCOVER_RESULT = {
    queries: ['quiet habits morning routine english', 'small habits explained'],
    candidates: [
        { videoId: 'vid-1', title: 'The quiet power of small habits', channel: 'Slow English', duration: 512, thumbnail: '', level: 'B1', reason: '节奏慢、句子短，适合 B1 精听。', hasEnglishSubs: true, alreadyProcessed: false },
        { videoId: 'vid-2', title: 'How cities shape the way we move', channel: 'City Voices', duration: 743, thumbnail: '', level: 'B2', reason: '城市主题，信息密度适中。', hasEnglishSubs: true, alreadyProcessed: true },
        { videoId: 'vid-3', title: 'A morning without a phone', channel: 'Everyday Stories', duration: 388, thumbnail: '', level: 'A2', reason: '日常场景，词汇基础。', hasEnglishSubs: null, alreadyProcessed: false },
    ],
    cached: false,
    degraded: false,
    disclaimer: '候选来自 YouTube 搜索，字幕与难度为估算。',
};

const ACCOUNT_SUMMARY = {
    user: {
        id: 'u-layout',
        email: 'layout@example.com',
        username: 'layout',
        memberSince: 1763000000000,
    },
    balanceMicroUsd: 1000000,
    availableMicroUsd: 1000000,
    activeHoldsMicroUsd: 0,
    monthSpendUsd: 0,
    usageToday: { minutes: 0 },
    version: 'test',
    preliminary: false,
};

const REVIEW_STATS = {
    targetLang: 'zh-CN',
    now: Date.now(),
    today: '2026-11-23',
    dueToday: 0,
    dueNow: 0,
    reviewedToday: 0,
    reviewedWordsToday: 0,
    newWords: 0,
    newToday: 0,
    totalWords: 0,
    suspendedWords: 0,
    streakDays: 0,
};

const cors = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
});
await context.addInitScript(() => {
    try {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    } catch {
        /* about:blank has no storage access; the real pages do. */
    }
});

await context.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const pathname = new URL(request.url()).pathname;
    const respond = (data, status = 200) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            headers: cors,
            body: JSON.stringify(data),
        });
    if (pathname === '/api/auth/me') {
        return respond({
            user: { id: 'u-layout', email: 'layout@example.com', username: 'layout' },
            isAdmin: false,
            guest: false,
        });
    }
    if (pathname === '/api/user/summary') return respond(ACCOUNT_SUMMARY);
    if (pathname === '/api/account/exports') {
        return respond({
            jobs: [],
            limits: { per24h: 3, per30d: 10, ttlHours: 24, maxBytes: 104857600, concurrentJobs: 1 },
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites' && request.method() === 'GET') return respond(FAVORITES);
    if (pathname === '/api/models') {
        return respond({
            models: [
                { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' },
            ],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/report/week') {
        return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    }
    if (pathname === '/api/placement/profile') {
        return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
    }
    if (pathname === '/api/review/stats') return respond(REVIEW_STATS);
    if (pathname === '/api/review/words') {
        return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
    }
    if (pathname === '/api/recommendations') {
        return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
    }
    if (pathname === '/api/vocabulary/lists') return respond(VOCABULARY_CATALOG);
    if (pathname === '/api/vocabulary/level') return respond(VOCABULARY_LEVELS);
    if (pathname === '/api/vocabulary/seen') {
        return respond(Object.fromEntries(Object.keys(VOCABULARY_LEVELS).map((word) => [word, 1])));
    }
    if (pathname === '/api/wordlists') return respond({ lists: [] });
    if (pathname === '/api/articles' && request.method() === 'GET') {
        return respond({ articles: ARTICLE_SUMMARIES });
    }
    if (pathname === '/api/discover' && request.method() === 'POST') return respond(DISCOVER_RESULT);
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/vocabulary/classify') return respond({ items: [] });
    if (pathname.startsWith('/api/')) return respond({});
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const rect = async (testId) =>
    page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
    }, testId);

const viewportFacts = async () =>
    page.evaluate(() => {
        const main = document.querySelector('[data-testid="app-main"]');
        const mainBox = main ? main.getBoundingClientRect() : null;
        const container = document.querySelector('[data-testid="page-container"], [data-testid$="-page-container"], [data-testid$="-list-container"]');
        return {
            viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            main: mainBox ? { x: mainBox.x, width: mainBox.width } : null,
            variant: container ? container.getAttribute('data-page-variant') : null,
        };
    });

const countTracks = (tracks) =>
    String(tracks ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

const tracksOf = async (testId) =>
    page.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        if (!el) return null;
        const grid = el.parentElement;
        return grid ? getComputedStyle(grid).gridTemplateColumns : null;
    }, testId);

const assertNoOverflow = (label, facts) => {
    assert.ok(
        facts.documentWidth <= facts.viewport + 1,
        `${label}: horizontal overflow (document ${facts.documentWidth} > viewport ${facts.viewport})`,
    );
};

const openPage = async ({ url, ready }) => {
    // A fresh document per page: a hash-only change keeps the previous screen.
    await page.goto('about:blank');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}#${url}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15000 });
    for (const testId of ready) {
        await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 15000 });
    }
    await sleep(400); // fonts + media queries settle after the route mounts
};

const assertStandardWidth = async ({ name, containerId, contentId, minContent = 1100 }) => {
    const facts = await viewportFacts();
    assert.equal(facts.variant, 'standard', `${name}: container variant ${facts.variant} != standard`);
    const container = await rect(containerId);
    const content = await rect(contentId);
    assert.ok(container, `${name}: missing ${containerId}`);
    assert.ok(content, `${name}: missing ${contentId}`);
    assert.ok(container.width >= 1180, `${name} 1440: container ${container.width} < 1180`);
    assert.ok(container.width <= 1282, `${name} 1440: container ${container.width} > 1282`);
    assert.ok(content.width >= minContent, `${name} 1440: content ${content.width} < ${minContent}`);
    assertNoOverflow(`${name} 1440`, facts);
    return { container, content };
};

const at1920 = async ({ name, containerId, variant, expectWidth }) => {
    const facts = await viewportFacts();
    assert.equal(facts.variant, variant, `${name} 1920: container variant ${facts.variant} != ${variant}`);
    const container = await rect(containerId);
    assert.ok(container, `${name} 1920: missing ${containerId}`);
    if (expectWidth) {
        assert.ok(
            Math.abs(container.width - expectWidth) <= 2,
            `${name} 1920: container ${container.width} != ${expectWidth}`,
        );
        assert.ok(facts.main, `${name} 1920: missing app-main`);
        const mainCenter = facts.main.x + facts.main.width / 2;
        const containerCenter = container.x + container.width / 2;
        assert.ok(
            Math.abs(mainCenter - containerCenter) <= 2,
            `${name} 1920: container is not centered in the main area`,
        );
    } else {
        assert.ok(
            Math.abs(container.width - facts.main.width) <= 2,
            `${name} 1920: wide container ${container.width} != main area ${facts.main.width}`,
        );
    }
    assertNoOverflow(`${name} 1920`, facts);
    return container;
};

const at375 = async ({ name, containerId, contentId }) => {
    const facts = await viewportFacts();
    const container = await rect(containerId);
    const content = contentId ? await rect(contentId) : null;
    assert.ok(container, `${name} 375: missing ${containerId}`);
    assert.ok(container.width <= 375, `${name} 375: container ${container.width} > viewport`);
    if (content) {
        assert.ok(content.width <= 344, `${name} 375: content ${content.width} > 344`);
    }
    assertNoOverflow(`${name} 375`, facts);
    return { container, content };
};

const results = [];

// ── 单词本: wide sheet, toolbar/table aligned, behavior testids ──────────
{
    const name = 'vocabulary';
    await openPage({ url: '/app/profile/vocabulary', ready: ['vocab-tabs', 'vocab-mine-panel'] });
    await page.locator('[data-testid="vocab-mine-word-f1"]').waitFor({ state: 'visible', timeout: 15000 });

    // Behavior surfaces must survive the container swap.
    for (const testId of [
        'vocab-family-tab',
        'vocab-mine-star-f1',
        'vocab-mine-master-toggle-f1',
        'vocab-mine-edit',
        'vocab-export-anki',
        'vocab-export-csv',
    ]) {
        assert.equal(await page.locator(`[data-testid="${testId}"]`).count(), 1, `${name}: ${testId} missing`);
    }

    // 1440: sheet ≥1100, toolbar and table exactly as wide as the content box.
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(300);
    const facts = await viewportFacts();
    assert.equal(facts.variant, 'wide', `${name} 1440: container variant ${facts.variant} != wide`);
    const container = await rect('vocab-page-container');
    const table = await rect('vocab-mine-list');
    const toolbarWidth = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="vocab-mine-search"]');
        const toolbar = input?.parentElement?.parentElement;
        return toolbar ? toolbar.getBoundingClientRect().width : null;
    });
    const headerDisplay = await page.evaluate(() => {
        const header = document.querySelector('[data-testid="vocab-mine-header"]');
        return header ? getComputedStyle(header).display : null;
    });
    const contentWidth = container.width - 64; // lg:px-8 on both sides
    assert.ok(container.width >= 1180, `${name} 1440: container ${container.width} < 1180`);
    assert.ok(contentWidth >= 1100, `${name} 1440: content ${contentWidth} < 1100`);
    assert.ok(table, `${name} 1440: missing vocab-mine-list`);
    assert.ok(toolbarWidth != null, `${name} 1440: missing toolbar root`);
    assert.ok(
        Math.abs(table.width - contentWidth) <= 1,
        `${name} 1440: table ${table.width} != content ${contentWidth}`,
    );
    assert.ok(
        Math.abs(toolbarWidth - table.width) <= 1,
        `${name} 1440: toolbar ${toolbarWidth} != table ${table.width}`,
    );
    assert.equal(headerDisplay, 'flex', `${name} 1440: desktop table header is ${headerDisplay}`);
    assertNoOverflow(`${name} 1440`, facts);
    await page.screenshot({ path: SHOT(name, 1440) });

    // 编辑 → 全选 checkbox + row selection appear, width unchanged.
    await page.locator('[data-testid="vocab-mine-edit"]').click();
    await page.locator('[data-testid="vocab-select-all-mine"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await page.locator('[data-testid="vocab-mine-select-f1"]').count(), 1, `${name}: row checkbox missing`);
    const tableInEdit = await rect('vocab-mine-list');
    assert.ok(
        Math.abs(tableInEdit.width - contentWidth) <= 1,
        `${name}: edit mode changed the table width (${tableInEdit.width} vs ${contentWidth})`,
    );
    await page.locator('[data-testid="vocab-mine-edit"]').click();
    await sleep(150);

    // 1920: wide follows the main area, not a 1440 cap.
    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const wide1920 = await at1920({ name, containerId: 'vocab-page-container', variant: 'wide' });
    await page.screenshot({ path: SHOT(name, 1920) });
    assert.ok(wide1920.width >= 1600, `${name} 1920: sheet ${wide1920.width} < 1600`);

    // 375: single stacked list, header hidden, no overflow.
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const mobile = await at375({ name, containerId: 'vocab-page-container', contentId: 'vocab-mine-list' });
    const mobileHeader = await page.evaluate(() => {
        const header = document.querySelector('[data-testid="vocab-mine-header"]');
        return header ? getComputedStyle(header).display : null;
    });
    assert.equal(mobileHeader, 'none', `${name} 375: desktop header still ${mobileHeader}`);
    assert.ok(mobile.container.width <= 375, `${name} 375: container too wide`);
    await page.screenshot({ path: SHOT(name, 375) });

    results.push({
        name,
        variant: 'wide',
        at1440: { container: container.width, content: contentWidth, table: table.width, toolbar: toolbarWidth },
        at1920: { container: wide1920.width },
        at375: { container: mobile.container.width, table: mobile.content.width },
    });
}

// ── 内容发现: standard, search + result list keep the container width ────
{
    const name = 'discover';
    await openPage({ url: '/app/content/discover', ready: ['discover-screen', 'discover-query-input'] });
    await page.locator('[data-testid="discover-query-input"]').fill('small habits');
    await page.locator('[data-testid="discover-submit"]').click();
    await page.locator('[data-testid="discover-candidate-0"]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(300);

    const { container, content } = await assertStandardWidth({
        name,
        containerId: 'discover-page-container',
        contentId: 'discover-results',
    });
    const searchBoxWidth = await page.evaluate(() => {
        const input = document.querySelector('[data-testid="discover-query-input"]');
        const section = input?.closest('section');
        return section ? section.getBoundingClientRect().width : null;
    });
    assert.ok(searchBoxWidth != null, `${name}: missing search section`);
    assert.ok(
        Math.abs(searchBoxWidth - content.width) <= 1,
        `${name} 1440: search section ${searchBoxWidth} != results ${content.width}`,
    );
    assert.equal(await page.locator('[data-testid="discover-candidate-2"]').count(), 1, `${name}: candidates missing`);
    await page.screenshot({ path: SHOT(name, 1440) });

    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920Width = await at1920({
        name,
        containerId: 'discover-page-container',
        variant: 'standard',
        expectWidth: 1280,
    });
    await page.screenshot({ path: SHOT(name, 1920) });

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const mobile = await at375({ name, containerId: 'discover-page-container', contentId: 'discover-results' });
    await page.screenshot({ path: SHOT(name, 375) });

    results.push({
        name,
        variant: 'standard',
        at1440: { container: container.width, content: content.width, searchSection: searchBoxWidth },
        at1920: { container: at1920Width.width },
        at375: { container: mobile.container.width, content: mobile.content.width },
    });
}

// ── 阅读列表: standard list (article detail stays on the P2-04 layout) ───
{
    const name = 'reader-list';
    await openPage({ url: '/app/content/reader', ready: ['reader-screen', 'reader-list'] });
    await page.locator('[data-testid="article-row-art1"]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(300);

    const { container, content } = await assertStandardWidth({
        name,
        containerId: 'reader-list-container',
        contentId: 'reader-list',
    });
    assert.equal(await page.locator('[data-testid^="article-row-"]').count(), 3, `${name}: list rows missing`);
    await page.screenshot({ path: SHOT(name, 1440) });

    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920Width = await at1920({
        name,
        containerId: 'reader-list-container',
        variant: 'standard',
        expectWidth: 1280,
    });
    await page.screenshot({ path: SHOT(name, 1920) });

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const mobile = await at375({ name, containerId: 'reader-list-container', contentId: 'reader-list' });
    await page.screenshot({ path: SHOT(name, 375) });

    results.push({
        name,
        variant: 'standard',
        at1440: { container: container.width, content: content.width },
        at1920: { container: at1920Width.width },
        at375: { container: mobile.container.width, content: mobile.content.width },
    });
}

// ── 练习: standard + 2–3 column card grid, one column at 375 ─────────────
{
    const name = 'practice';
    await openPage({ url: '/app/practice', ready: ['practice-screen', 'practice-quiz-card'] });
    await sleep(300);

    // The grid has no testid of its own; measure it through the quiz card's parent.
    const grid = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="practice-quiz-card"]');
        const el = card?.parentElement;
        if (!el) return null;
        const box = el.getBoundingClientRect();
        return { width: box.width, tracks: getComputedStyle(el).gridTemplateColumns };
    });
    assert.ok(grid, `${name}: missing card grid`);
    assert.equal(countTracks(grid.tracks), 3, `${name} 1440: expected 3 card columns, got ${grid.tracks}`);
    assert.ok(grid.width >= 1100, `${name} 1440: grid ${grid.width} < 1100`);
    await page.screenshot({ path: SHOT(name, 1440) });

    const facts1440 = await viewportFacts();
    assert.equal(facts1440.variant, 'standard', `${name} 1440: container variant ${facts1440.variant}`);
    const container1440 = await rect('practice-page-container');
    assert.ok(container1440.width >= 1180 && container1440.width <= 1210, `${name} 1440: container ${container1440.width}`);
    assertNoOverflow(`${name} 1440`, facts1440);

    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920Width = await at1920({
        name,
        containerId: 'practice-page-container',
        variant: 'standard',
        expectWidth: 1280,
    });
    const tracks1920 = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="practice-quiz-card"]');
        return card?.parentElement ? getComputedStyle(card.parentElement).gridTemplateColumns : null;
    });
    assert.equal(countTracks(tracks1920), 3, `${name} 1920: expected 3 card columns, got ${tracks1920}`);
    await page.screenshot({ path: SHOT(name, 1920) });

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const mobile = await at375({ name, containerId: 'practice-page-container' });
    const tracks375 = await page.evaluate(() => {
        const card = document.querySelector('[data-testid="practice-quiz-card"]');
        return card?.parentElement ? getComputedStyle(card.parentElement).gridTemplateColumns : null;
    });
    assert.equal(countTracks(tracks375), 1, `${name} 375: expected one card column, got ${tracks375}`);
    await page.screenshot({ path: SHOT(name, 375) });

    results.push({
        name,
        variant: 'standard',
        at1440: { container: container1440.width, grid: grid.width, tracks: grid.tracks },
        at1920: { container: at1920Width.width, tracks: tracks1920 },
        at375: { container: mobile.container.width, tracks: tracks375 },
    });
}

// ── 我的: standard + 3-column library grid, one column at 375 ────────────
{
    const name = 'profile';
    await openPage({ url: '/app/profile', ready: ['account-screen', 'profile-wordbook-row'] });
    await sleep(300);

    const facts1440 = await viewportFacts();
    assert.equal(facts1440.variant, 'standard', `${name} 1440: container variant ${facts1440.variant}`);
    const container1440 = await rect('account-page-container');
    const libraryGrid = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="profile-wordbook-row"]');
        const el = row?.parentElement;
        if (!el) return null;
        return {
            width: el.getBoundingClientRect().width,
            tracks: getComputedStyle(el).gridTemplateColumns,
        };
    });
    assert.ok(container1440, `${name} 1440: missing account-page-container`);
    assert.ok(libraryGrid, `${name} 1440: missing library grid`);
    assert.ok(container1440.width >= 1180 && container1440.width <= 1210, `${name} 1440: container ${container1440.width}`);
    assert.ok(libraryGrid.width >= 1100, `${name} 1440: library grid ${libraryGrid.width} < 1100`);
    assert.equal(countTracks(libraryGrid.tracks), 3, `${name} 1440: expected 3 library columns, got ${libraryGrid.tracks}`);
    assertNoOverflow(`${name} 1440`, facts1440);
    await page.screenshot({ path: SHOT(name, 1440) });

    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920Width = await at1920({
        name,
        containerId: 'account-page-container',
        variant: 'standard',
        expectWidth: 1280,
    });
    await page.screenshot({ path: SHOT(name, 1920) });

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const mobile = await at375({ name, containerId: 'account-page-container' });
    const tracks375 = await page.evaluate(() => {
        const row = document.querySelector('[data-testid="profile-wordbook-row"]');
        return row?.parentElement ? getComputedStyle(row.parentElement).gridTemplateColumns : null;
    });
    assert.equal(countTracks(tracks375), 1, `${name} 375: expected one library column, got ${tracks375}`);
    await page.screenshot({ path: SHOT(name, 375) });

    results.push({
        name,
        variant: 'standard',
        at1440: { container: container1440.width, library: libraryGrid.width, tracks: libraryGrid.tracks },
        at1920: { container: at1920Width.width },
        at375: { container: mobile.container.width, tracks: tracks375 },
    });
}

assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);

console.log(
    JSON.stringify(
        {
            status: 'PASS',
            head: HEAD,
            pages: results,
        },
        null,
        2,
    ),
);

await browser.close();
