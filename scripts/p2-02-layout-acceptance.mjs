// P2-02 desktop layout acceptance (docs/设计-桌面布局规范.md §7).
//
// Real page, mocked API: opens the weekly report route, then asserts against
// the actual DOM at 1440 / 1920 / 375:
//   - 1440: standard container content ≥ 1100px, ≥xl two-column grid
//     (minmax(0,1fr) + 320px rail), no horizontal overflow;
//   - 1920: container stays at the 1280px standard measure, still two columns;
//   - 375: single column, rail stacks below the main column, no overflow.
// Screenshots: /tmp/p2-02-report-1440@<sha7>.png (and 1920 / 375).
//
// Run: node scripts/p2-02-layout-acceptance.mjs
// Needs `npm run dev` on http://127.0.0.1:5173 (override with APP_URL).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name) => `/tmp/p2-02-${name}@${HEAD}.png`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

const REPORT = {
    version: 1,
    weekStart: '2026-11-16',
    weekEnd: '2026-11-23',
    timezone: 'Asia/Shanghai',
    generatedAt: Date.parse('2026-11-23T05:30:00Z'),
    numbers: { passiveMinutes: 312, reviewedWords: 84, quizAccuracy: 0.857 },
    fact: '你本周有 312 分钟被动学习，集中在晚上 9 点以后；正确率比上周高 4 个百分点。',
    nextStep: '明天先复习 12 个到期词，再回到昨晚那个 12:34 的句子。',
    evidence: {
        source: 'watch',
        contentRef: 'youtube::acceptance-video',
        kind: 'video',
        targetLang: 'zh-CN',
        start: 754,
        end: 759,
        startMs: 754000,
        endMs: 759000,
        durationSeconds: 1500,
        sentence: 'Small habits quietly shape the way a whole day feels.',
        occurredAt: Date.parse('2026-11-22T13:30:00Z'),
    },
    streakDays: 6,
    quiz: { attempts: 28, correct: 24 },
    words: { new: 41, reviewed: 84, dueTomorrow: 12 },
};

const cors = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
    localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
});

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
        return respond({ user: { id: 'u-layout', email: 'layout@example.com' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/report/week') return respond(REPORT);
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites') return respond([]);
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
    if (pathname === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: true });
    if (pathname.startsWith('/api/')) return respond({});
    return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const metrics = () => page.evaluate(() => {
    const box = (testId) => {
        const el = document.querySelector(`[data-testid="${testId}"]`);
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    };
    const grid = document.querySelector('[data-testid="report-grid"]');
    const container = document.querySelector('[data-testid="page-container"]');
    const railEl = document.querySelector('[data-testid="report-rail"]');
    return {
        viewport: window.innerWidth,
        documentWidth: document.documentElement.scrollWidth,
        container: container ? (() => { const r = container.getBoundingClientRect(); return { width: r.width, x: r.x, variant: container.getAttribute('data-page-variant') }; })() : null,
        grid: box('report-grid'),
        gridTracks: grid ? getComputedStyle(grid).gridTemplateColumns : null,
        main: box('page-grid-main'),
        rail: box('report-rail'),
        railPosition: railEl ? getComputedStyle(railEl).position : null,
    };
});

const assertNoOverflow = (label, data) => {
    assert.ok(
        data.documentWidth <= data.viewport + 1,
        `${label}: horizontal overflow (document ${data.documentWidth} > viewport ${data.viewport})`,
    );
};

const countTracks = (tracks) => String(tracks ?? '').trim().split(/\s+/).filter(Boolean).length;

// ── load the real page (mocked API) ───────────────────────────────────────
await page.goto(`${BASE}#/app/today/report`, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid="report-fact"]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid="report-evidence"]').waitFor({ state: 'visible', timeout: 10000 });
await sleep(400); // let fonts + the xl media query settle

assert.equal(await page.locator('[data-testid="report-screen"]').count(), 1, 'report screen missing');
assert.equal(await page.locator('[data-testid="report-number-passive"]').innerText(), '312');
assert.equal(await page.locator('[data-testid="report-number-accuracy"]').innerText(), '85.7%');
assert.equal(await page.locator('[data-testid="report-week-range"]').count(), 1);
assert.equal(await page.locator('[data-testid="report-rail"]').count(), 1);

// ── 1440: standard container ≥1100 + two columns ──────────────────────────
await page.setViewportSize({ width: 1440, height: 900 });
await sleep(300);
const at1440 = await metrics();
await page.screenshot({ path: SHOT('report-1440') });
assertNoOverflow('1440', at1440);
assert.equal(at1440.container?.variant, 'standard');
assert.ok(at1440.container.width >= 1100, `1440: container ${at1440.container.width} < 1100`);
assert.ok(at1440.grid.width >= 1100, `1440: content ${at1440.grid.width} < 1100`);
assert.equal(countTracks(at1440.gridTracks), 2, `1440: expected two tracks, got ${at1440.gridTracks}`);
assert.ok(Math.abs(at1440.rail.width - 320) <= 1, `1440: rail width ${at1440.rail.width} != 320`);
assert.equal(at1440.railPosition, 'sticky', `1440: rail position ${at1440.railPosition} != sticky`);
assert.ok(at1440.rail.x >= at1440.main.x + at1440.main.width, '1440: rail is not to the right of the main column');
assert.ok(at1440.rail.y <= at1440.main.y + 1, '1440: rail does not start on the main row');

// ── 1920: container stays at 1280, still two columns ──────────────────────
await page.setViewportSize({ width: 1920, height: 900 });
await sleep(300);
const at1920 = await metrics();
await page.screenshot({ path: SHOT('report-1920') });
assertNoOverflow('1920', at1920);
assert.ok(Math.abs(at1920.container.width - 1280) <= 2, `1920: container ${at1920.container.width} != 1280`);
assert.equal(countTracks(at1920.gridTracks), 2, `1920: expected two tracks, got ${at1920.gridTracks}`);
assert.ok(Math.abs(at1920.rail.width - 320) <= 1, `1920: rail width ${at1920.rail.width} != 320`);
assert.equal(at1920.railPosition, 'sticky', `1920: rail position ${at1920.railPosition} != sticky`);
assert.ok(at1920.rail.x > at1920.main.x + at1920.main.width, '1920: rail is not to the right of the main column');

// ── 375: single column, rail stacked below, no overflow ───────────────────
await page.setViewportSize({ width: 375, height: 812 });
await sleep(300);
const at375 = await metrics();
await page.screenshot({ path: SHOT('report-375') });
assertNoOverflow('375', at375);
assert.equal(countTracks(at375.gridTracks), 1, `375: expected one track, got ${at375.gridTracks}`);
assert.ok(at375.container.width <= 375, `375: container ${at375.container.width} wider than viewport`);
assert.ok(at375.rail.y >= at375.main.y + at375.main.height - 1, '375: rail did not stack below the main column');
assert.ok(Math.abs(at375.rail.x - at375.main.x) <= 1, '375: rail is not full-width in the single column');
assert.equal(at375.railPosition, 'static', `375: rail position ${at375.railPosition} != static`);

assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);

console.log(JSON.stringify({
    status: 'PASS',
    head: HEAD,
    screenshots: [SHOT('report-1440'), SHOT('report-1920'), SHOT('report-375')],
    at1440: {
        containerWidth: at1440.container.width,
        contentWidth: at1440.grid.width,
        tracks: at1440.gridTracks,
        railWidth: at1440.rail.width,
        railPosition: at1440.railPosition,
    },
    at1920: {
        containerWidth: at1920.container.width,
        contentWidth: at1920.grid.width,
        tracks: at1920.gridTracks,
        railWidth: at1920.rail.width,
        railPosition: at1920.railPosition,
    },
    at375: {
        containerWidth: at375.container.width,
        tracks: at375.gridTracks,
        railTop: at375.rail.y,
        mainBottom: at375.main.y + at375.main.height,
        railPosition: at375.railPosition,
    },
}, null, 2));

await browser.close();
