// P2-03 desktop layout acceptance (docs/设计-桌面布局规范.md §7).
//
// Real pages, mocked API: opens the three A-group routes (ability / exam /
// placement) and asserts against the actual DOM at 1440 / 1920 / 375:
//   - 1440: standard container content ≥ 1100px, ≥xl two-column grid
//     (minmax(0,1fr) + 320px rail), no horizontal overflow;
//   - 1920: container stays at the 1280px standard measure, still two columns;
//   - 375: single column, rail stacks below the main column, no overflow.
// Placement is checked in both its intro and saved-profile states, because the
// rail carries the entry actions in the latter.
// Screenshots: /tmp/p2-03-<page>-<width>@<sha7>.png.
//
// Run: node scripts/p2-03-layout-acceptance.mjs
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
const SHOT = (name) => `/tmp/p2-03-${name}@${HEAD}.png`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────
const PLACEMENT_PROFILE = {
    cefr: 'A2–B1',
    levelBandLow: 'A2',
    levelBandHigh: 'B1',
    vocabEstimate: 2200,
    readingEstimate: 'insufficient',
    confidence: 0.55,
    confidenceLabel: 'medium',
    confidenceLabelZh: '中等',
    pseudoWordSuspicion: 0.05,
    updatedAt: Date.parse('2026-11-22T09:00:00Z'),
    source: 'placement',
    strengths: ['词汇识别'],
    weaknesses: ['阅读'],
    advice: '先补阅读，再回到词汇复习。',
    measuredDomains: ['vocabulary'],
    notMeasured: ['reading', 'listening', 'speaking', 'writing'],
    preliminary: true,
    sampleSize: 24,
    disclaimer: '定位测只给区间，不是考试分数。',
};

const PLACEMENT_PROFILE_RESPONSE = {
    profile: PLACEMENT_PROFILE,
    preliminary: true,
    sampleSize: 24,
    disclaimer: '定位测只给区间，不是考试分数。',
};

const ABILITY_PROFILE = {
    preliminary: false,
    sampleSize: 40,
    updatedAt: Date.parse('2026-11-23T02:00:00Z'),
    disclaimer: '这是基于有限证据的 CEFR 对齐估计，不是官方 CEFR 认证。',
    vocabulary: {
        status: 'uncalibrated',
        cefr: 'B1',
        low: 'A2',
        high: 'B1',
        label: 'A2–B1',
        evidenceCount: 40,
        lastEvidenceAt: Date.parse('2026-11-22T10:00:00Z'),
        evidenceStrength: 'medium',
        estimate: { low: 1800, high: 2600, unit: 'lemma' },
        note: '有 40 道题，单次结果，重测可能变 1 带。',
        stale: false,
    },
    composite: { label: 'A2–B1' },
    skills: {
        listening: { status: 'not_measured', note: '行为证据不足。' },
        reading: { status: 'insufficient', items: 8, note: '证据不足。' },
        speaking: { status: 'not_measured' },
        writing: { status: 'self_report', selfReport: { band: 'B1', caveat: '自评不构成测量。' } },
    },
    canDo: {
        level: 'B1',
        note: '未测技能只列通用描述。',
        bySkill: {
            listening: [{ text: '能听懂熟悉话题的要点。', basis: 'cefr-aligned', source: 'CEFR' }],
            reading: [{ text: '能读懂短篇说明文。' }],
            speaking: [{ text: '能就日常话题简单交流。' }],
            writing: [{ text: '能写简短邮件。' }],
        },
    },
    evidence: [
        {
            id: 'e1',
            skill: 'vocabulary',
            type: 'placement_answer',
            observedAt: Date.parse('2026-11-22T10:00:00Z'),
            band: 'A2–B1',
        },
        {
            id: 'e2',
            skill: 'reading',
            type: 'placement_answer',
            observedAt: Date.parse('2026-11-21T10:00:00Z'),
            band: 'A2–B1',
        },
    ],
};

const EXAM_TYPES = {
    types: [
        {
            id: 'cet4',
            label: 'CET-4 风格练习',
            itemCount: 30,
            sessionItemCount: 10,
            description: '10 道自编题（词汇 / 语法 / 阅读）。',
            disclaimer: '自编题，非真题。',
        },
    ],
    disclaimer: '自编题，非真题；只做题型练习，不报分、不预测成绩。',
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
            user: { id: 'u-layout', email: 'layout@example.com' },
            isAdmin: false,
            guest: false,
        });
    }
    if (pathname === '/api/ability/profile') return respond(ABILITY_PROFILE);
    if (pathname === '/api/ability/can-do') return respond({ items: [] });
    if (pathname === '/api/exam/types') return respond(EXAM_TYPES);
    if (pathname === '/api/exam/history') return respond({ sessions: [], limit: 20, disclaimer: '' });
    if (pathname === '/api/placement/profile') return respond(PLACEMENT_PROFILE_RESPONSE);
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites') return respond([]);
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({
            models: [
                {
                    id: 'deepseek-chat',
                    name: 'DeepSeek Chat',
                    provider: 'deepseek',
                    available: true,
                    quotaInfo: '',
                },
            ],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/review/stats') {
        return respond({
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
        });
    }
    if (pathname === '/api/recommendations') {
        return respond({
            items: [],
            basis: { band: 'A2–B2', source: 'default' },
            preliminary: true,
        });
    }
    if (pathname.startsWith('/api/')) return respond({});
    return route.fulfill({
        status: 404,
        headers: cors,
        contentType: 'application/json',
        body: '{}',
    });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const metrics = (prefix, screenTestId) =>
    page.evaluate(
        ({ prefix, screenTestId }) => {
            const root = document.querySelector(`[data-testid="${screenTestId}"]`);
            const box = (testId) => {
                const el = root?.querySelector(`[data-testid="${testId}"]`);
                if (!el) return null;
                const rect = el.getBoundingClientRect();
                return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
            };
            const container = root?.querySelector('[data-testid="page-container"]');
            const grid = root?.querySelector(`[data-testid="${prefix}-grid"]`);
            const railEl = root?.querySelector(`[data-testid="${prefix}-rail"]`);
            return {
                viewport: window.innerWidth,
                documentWidth: document.documentElement.scrollWidth,
                container: container
                    ? (() => {
                          const rect = container.getBoundingClientRect();
                          return {
                              width: rect.width,
                              x: rect.x,
                              variant: container.getAttribute('data-page-variant'),
                          };
                      })()
                    : null,
                grid: box(`${prefix}-grid`),
                gridTracks: grid ? getComputedStyle(grid).gridTemplateColumns : null,
                main: box('page-grid-main'),
                rail: box(`${prefix}-rail`),
                railPosition: railEl ? getComputedStyle(railEl).position : null,
            };
        },
        { prefix, screenTestId },
    );

const assertNoOverflow = (label, data) => {
    assert.ok(
        data.documentWidth <= data.viewport + 1,
        `${label}: horizontal overflow (document ${data.documentWidth} > viewport ${data.viewport})`,
    );
};

const countTracks = (tracks) =>
    String(tracks ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

const assertPage = async ({ name, screenTestId, prefix, url, ready }) => {
    // Each page gets a fresh document: a hash-only change would keep the
    // previously mounted screen (its phase is initialized from props once).
    await page.goto('about:blank');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}${url}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15000 });
    for (const testId of ready) {
        await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 15000 });
    }
    await page.locator(`[data-testid="${prefix}-rail"]`).waitFor({ state: 'visible', timeout: 10000 });
    await sleep(400); // fonts + the xl media query

    // ── 1440: standard container ≥1100 + two columns ──────────────────────
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(300);
    const at1440 = await metrics(prefix, screenTestId);
    await page.screenshot({ path: SHOT(`${name}-1440`) });
    assertNoOverflow(`${name} 1440`, at1440);
    assert.ok(at1440.container, `${name} 1440: missing page container`);
    assert.equal(at1440.container.variant, 'standard', `${name} 1440: container variant`);
    assert.ok(
        at1440.grid.width >= 1100,
        `${name} 1440: content ${at1440.grid?.width} < 1100`,
    );
    assert.equal(
        countTracks(at1440.gridTracks),
        2,
        `${name} 1440: expected two tracks, got ${at1440.gridTracks}`,
    );
    assert.ok(
        Math.abs(at1440.rail.width - 320) <= 1,
        `${name} 1440: rail width ${at1440.rail.width} != 320`,
    );
    assert.equal(
        at1440.railPosition,
        'sticky',
        `${name} 1440: rail position ${at1440.railPosition} != sticky`,
    );
    assert.ok(
        at1440.rail.x >= at1440.main.x + at1440.main.width,
        `${name} 1440: rail is not to the right of the main column`,
    );
    assert.ok(
        at1440.rail.y <= at1440.main.y + 1,
        `${name} 1440: rail does not start on the main row`,
    );

    // ── 1920: container stays at 1280, still two columns ──────────────────
    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920 = await metrics(prefix, screenTestId);
    await page.screenshot({ path: SHOT(`${name}-1920`) });
    assertNoOverflow(`${name} 1920`, at1920);
    assert.ok(
        Math.abs(at1920.container.width - 1280) <= 2,
        `${name} 1920: container ${at1920.container.width} != 1280`,
    );
    assert.equal(
        countTracks(at1920.gridTracks),
        2,
        `${name} 1920: expected two tracks, got ${at1920.gridTracks}`,
    );
    assert.ok(
        Math.abs(at1920.rail.width - 320) <= 1,
        `${name} 1920: rail width ${at1920.rail.width} != 320`,
    );
    assert.equal(
        at1920.railPosition,
        'sticky',
        `${name} 1920: rail position ${at1920.railPosition} != sticky`,
    );
    assert.ok(
        at1920.rail.x > at1920.main.x + at1920.main.width,
        `${name} 1920: rail is not to the right of the main column`,
    );

    // ── 375: single column, rail stacked below, no overflow ───────────────
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const at375 = await metrics(prefix, screenTestId);
    await page.screenshot({ path: SHOT(`${name}-375`) });
    assertNoOverflow(`${name} 375`, at375);
    assert.equal(
        countTracks(at375.gridTracks),
        1,
        `${name} 375: expected one track, got ${at375.gridTracks}`,
    );
    assert.ok(
        at375.container.width <= 375,
        `${name} 375: container ${at375.container.width} wider than viewport`,
    );
    assert.ok(
        at375.rail.y >= at375.main.y + at375.main.height - 1,
        `${name} 375: rail did not stack below the main column`,
    );
    assert.ok(
        Math.abs(at375.rail.x - at375.main.x) <= 1,
        `${name} 375: rail is not full-width in the single column`,
    );
    assert.equal(
        at375.railPosition,
        'static',
        `${name} 375: rail position ${at375.railPosition} != static`,
    );

    return {
        name,
        screenshots: [SHOT(`${name}-1440`), SHOT(`${name}-1920`), SHOT(`${name}-375`)],
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
    };
};

const pages = [
    {
        name: 'ability',
        screenTestId: 'ability-screen',
        prefix: 'ability',
        url: '#/app/profile/ability',
        ready: ['ability-summary', 'ability-rail-slot'],
    },
    {
        name: 'exam',
        screenTestId: 'exam-screen',
        prefix: 'exam',
        url: '#/app/practice/exam',
        ready: ['exam-type-cet4', 'exam-rail-slot'],
    },
    {
        name: 'placement-intro',
        screenTestId: 'placement-screen',
        prefix: 'placement',
        url: '#/app/practice/placement',
        ready: ['placement-intro', 'placement-rail-slot'],
    },
    {
        name: 'placement-profile',
        screenTestId: 'placement-screen',
        prefix: 'placement',
        url: '#/app/practice/placement?view=profile',
        ready: ['placement-profile', 'placement-profile-cefr'],
    },
];

const results = [];
for (const entry of pages) {
    results.push(await assertPage(entry));
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
