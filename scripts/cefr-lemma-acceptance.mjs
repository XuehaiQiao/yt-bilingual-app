#!/usr/bin/env node
// Playwright acceptance for specs/040-cefr-lemma-list — the read-only 「词形」
// tab (P1-02). Runs against a fully mocked backend (like the other word-book
// acceptance scripts: no :8000, no account, no AI), exercising the real UI
// against a 10,000-lemma fixture that mirrors `frequency_bands.v1.json`:
// rank order, form→lemma search, A1/A2/B1/B2/C1 anchors, alphabetical sort and
// server paging. The real endpoint + real data are covered by
// `backend/tests/test_lemma_list.py`.
//
// Covers:
//   A) 「词形（CEFR 10k）」 is the tab right after CET6; every existing tab
//      keeps its label/order (我的收藏 / 已掌握 / 短语 / CEFR / GRE / CET4 / CET6);
//   B) read-only: no star, no 已掌握 check, no 编辑/批量/导出/全选 inside the
//      panel — only search/sort/filter/pagination + row expansion;
//   C) columns lemma / phonetic / meaning / CEFR / form count / expand;
//      expanding lists every form (e.g. run → ran/running/runs);
//   D) server search matches forms (running → run, abandoned → abandon) and
//      sends `q` to `/api/vocabulary/lemma-list`;
//   E) level filter sends `level` and narrows to one band; 清除筛选 restores;
//   F) sort menu sends `sort=alpha|rank`; 字母 A→Z starts with "a";
//   G) server paging is fixed 50/页: 第 1 / 200 页, next page, jump to page 7;
//   H) empty result renders the retryable empty state (not an error);
//   I) a failed load shows the error panel and 重试 re-fetches successfully;
//   J) 375 has no horizontal overflow (list + expanded forms), 1440 screenshot.
//
// Screenshots: /tmp/p1-02-*.png
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node cefr-lemma-acceptance.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

// Count executed assertions so a green run reports how many checks passed.
let assertionsPassed = 0;
for (const name of ['ok', 'equal', 'deepEqual', 'match']) {
    const original = assert[name];
    assert[name] = (...args) => {
        original(...args);
        assertionsPassed += 1;
    };
}

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const SHOTS = '/tmp';

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

// ── 10k-lemma fixture (mirrors frequency_bands.v1.json semantics) ─────────
const BANDS = [
    [1000, 'A1'],
    [2000, 'A2'],
    [4000, 'B1'],
    [7000, 'B2'],
    [10000, 'C1'],
];
const levelForRank = (rank) => BANDS.find(([max]) => rank <= max)[1];

/** Curated rows that pin the acceptance cases to real ranks/forms. */
const CURATED = new Map([
    [1, { lemma: 'the', phonetic: 'ðə', translation: 'art. 这；那；这些', forms: [] }],
    [6, { lemma: 'a', phonetic: 'ə', translation: 'art. 一（个）', forms: [] }],
    [51, { lemma: 'say', phonetic: 'seɪ', translation: 'v. 说；讲', forms: ['said', 'says', 'saying'] }],
    [156, { lemma: 'run', phonetic: 'rʌn', translation: 'v. 跑；运行', forms: ['ran', 'running', 'runs'] }],
    [2183, { lemma: 'abandon', phonetic: 'əˈbændən', translation: 'v. 放弃，抛弃', forms: ['abandoned', 'abandoning', 'abandons'] }],
    [3001, { lemma: 'abundant', phonetic: 'əˈbʌndənt', translation: 'adj. 丰富的，充裕的', forms: ['abundantly'] }],
]);

function buildDataset() {
    const items = [];
    for (let rank = 1; rank <= 10000; rank += 1) {
        const curated = CURATED.get(rank);
        const lemma = curated?.lemma ?? `word${String(rank).padStart(5, '0')}`;
        items.push({
            lemma,
            rank,
            level: levelForRank(rank),
            phonetic: curated?.phonetic ?? '',
            translation: curated?.translation ?? `释义 ${rank}`,
            forms: curated?.forms ?? (rank % 3 === 1 ? [`${lemma}s`] : []),
        });
    }
    return items;
}

const DATASET = buildDataset();

/** The server's paging/search/level/sort contract, reduced to the fixture. */
function lemmaPage(searchParams) {
    const int = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const page = Math.max(1, int(searchParams.get('page'), 1));
    const pageSize = Math.min(200, Math.max(1, int(searchParams.get('pageSize'), 50)));
    const q = (searchParams.get('q') || '').trim().toLowerCase();
    const level = (searchParams.get('level') || '').trim().toUpperCase();
    const sort = (searchParams.get('sort') || 'rank').toLowerCase();

    let items = DATASET;
    if (level) items = items.filter((item) => item.level === level);
    if (q) {
        items = items.filter((item) => (
            item.lemma.toLowerCase().includes(q)
            || item.forms.some((form) => form.toLowerCase().includes(q))
        ));
    }
    if (sort === 'alpha') {
        items = [...items].sort((left, right) => (
            left.lemma.toLowerCase().localeCompare(right.lemma.toLowerCase())
        ));
    }
    const total = items.length;
    const start = (page - 1) * pageSize;
    return {
        items: items.slice(start, start + pageSize),
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
    };
}

function createState() {
    return {
        mode: 'guest',
        favorites: [],
        /**
         * Every `/api/vocabulary/lemma-list` request, as a plain query object.
         * The UI must never page client-side: page/pageSize/q/level/sort are
         * all asserted from these records.
         */
        lemmaRequests: [],
        /** Fail this many lemma-list requests with a 500 (retry case). */
        failLemma: 0,
    };
}

async function installMocks(context, state) {
    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const method = request.method();
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const url = new URL(request.url());
        const pathname = url.pathname;
        const respond = (data, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: CORS,
            body: JSON.stringify(data),
        });
        const fail = (status, detail) => respond({ detail }, status);

        if (pathname === '/api/auth/me') {
            return respond({ user: null, guest: true });
        }
        if (pathname === '/api/user/summary') {
            return respond({
                user: null,
                monthSpendUsd: 0,
                usageToday: { minutes: 0 },
                version: 'test',
                preliminary: false,
            });
        }
        if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
        if (pathname === '/api/shows') return respond({ shows: [] });
        if (pathname === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
                default: 'deepseek-chat',
            });
        }
        if (pathname === '/api/favorites' && method === 'GET') return respond(state.favorites);
        if (pathname === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-23', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (pathname === '/api/review/words' && method === 'GET') {
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
        }
        if (pathname === '/api/review/suspended' && method === 'GET') {
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
        }

        // ── built-in vocabulary catalog (background shell reads) ──────────
        if (pathname === '/api/vocabulary/lists') {
            const list = (id, label, count) => ({
                id, label, count, byLevel: {}, source: 'test', license: 'test',
                notice: null, approximate: false, available: true, version: '1', note: null,
            });
            return respond([
                list('cefr', 'CEFR 词表', 5000),
                list('gre', 'GRE', 3200),
                list('cet4', 'CET4', 2600),
                list('cet6', 'CET6', 1200),
            ]);
        }
        if (/^\/api\/vocabulary\/lists\/[a-z0-9-]+$/.test(pathname)) {
            return respond({ items: [], total: 0, page: 1, pageSize: 50, hasMore: false });
        }
        if (pathname === '/api/vocabulary/level') return respond({});
        if (pathname === '/api/vocabulary/seen') return respond({});

        // ── the surface under test (specs/040) ────────────────────────────
        if (pathname === '/api/vocabulary/lemma-list') {
            const params = Object.fromEntries(url.searchParams.entries());
            state.lemmaRequests.push(params);
            if (state.failLemma > 0) {
                state.failLemma -= 1;
                return fail(500, 'mock lemma-list failure');
            }
            return respond(lemmaPage(url.searchParams));
        }

        // ── custom word lists stay signed-in only; guests never call them ─
        if (pathname === '/api/wordlists') return fail(403, 'guests have no custom lists');

        // ── app-shell background reads ────────────────────────────────────
        if (pathname === '/api/recommendations') {
            return respond({ items: [], basis: { band: 'A2–B1', source: 'default' }, preliminary: false });
        }
        if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
        if (pathname === '/api/sentences/levels') return respond([]);
        if (pathname === '/api/library/articles') return respond({ articles: [] });
        if (pathname === '/api/placement/profile') return respond({ profile: null, preliminary: false });
        if (pathname === '/api/ability/profile') {
            return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });
        }
        return fail(404, `unmocked ${method} ${pathname}`);
    });
}

async function newContext(browser, state, viewport = { width: 1440, height: 1000 }) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
        if (!localStorage.getItem('yt_bilingual_ui_lang')) {
            localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        }
        if (!localStorage.getItem('yt_bilingual_target_lang')) {
            localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
        }
    });
    await installMocks(context, state);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    return { context, page, pageErrors };
}

async function gotoWordbook(page) {
    await page.goto(`${BASE}/#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vocabulary-book"]', { timeout: 15000 });
    await page.getByTestId('vocab-tabs').waitFor({ timeout: 15000 });
}

const lemmaRows = (page) => page.locator('[data-testid^="vocab-lemma-row-"]');
const lastLemmaRequest = (state) => state.lemmaRequests[state.lemmaRequests.length - 1];

async function openLemmaTab(page) {
    await page.getByTestId('vocab-lemma-tab').click();
    await page.getByTestId('vocab-lemma-panel').waitFor({ timeout: 15000 });
    await page.getByTestId('vocab-lemma-list').waitFor({ timeout: 15000 });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const state = createState();
const { context, page, pageErrors } = await newContext(browser, state);

// ── A) tab order: 词形 is the tab right after CET6 ───────────────────────
await gotoWordbook(page);
await page.getByTestId('vocab-lemma-tab').waitFor({ timeout: 15000 });
const tabOrder = await page.$$eval(
    '[data-testid="vocab-tabs"] [role="tab"][data-testid]',
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')),
);
assert.deepEqual(
    tabOrder,
    [
        'vocab-tab-mine', 'vocab-tab-mastered', 'vocab-tab-phrases',
        'vocab-tab-cefr', 'vocab-tab-gre', 'vocab-tab-cet4', 'vocab-tab-cet6',
        'vocab-lemma-tab',
    ],
    `词形 must be appended after CET6 (and before custom lists): ${tabOrder.join(' / ')}`,
);
assert.equal(
    (await page.getByTestId('vocab-tab-cet6').innerText()).split('\n')[0],
    'CET6',
    'CET6 keeps its label',
);
assert.equal(
    (await page.getByTestId('vocab-tab-cefr').innerText()).split('\n')[0],
    'CEFR 词表',
    'CEFR keeps its label',
);
const lemmaTabText = await page.getByTestId('vocab-lemma-tab').innerText();
assert.match(lemmaTabText, /词形/, 'tab label names the surface');
assert.match(lemmaTabText, /CEFR 10k/, 'tab sub-label carries CEFR 10k');

// ── B/C) read-only list: columns, paging, no write controls ─────────────
await openLemmaTab(page);
assert.equal(state.lemmaRequests.length, 1);
assert.equal(lastLemmaRequest(state).page, '1');
assert.equal(lastLemmaRequest(state).pageSize, '50', 'server paging is fixed 50/页');
assert.equal(lastLemmaRequest(state).sort, 'rank');
assert.equal(await lemmaRows(page).count(), 50);
assert.equal(await page.getByTestId('vocab-lemma-total').innerText(), '共 10,000 词');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 200 页/);
assert.equal(await page.getByTestId('vocab-lemma-word-the').innerText(), 'the');
assert.equal(await page.getByTestId('vocab-lemma-badge-the').innerText(), 'A1');
assert.equal(await page.getByTestId('vocab-lemma-forms-count-the').innerText(), '0');
assert.equal(await page.getByTestId('vocab-lemma-ipa-run').count(), 0, 'only the first page is rendered');

const panel = page.getByTestId('vocab-lemma-panel');
for (const selector of [
    '[data-testid*="star"]',
    '[data-testid*="mastered"]',
    '[data-testid*="edit"]',
    '[data-testid*="export"]',
    '[data-testid*="select"]',
    '[data-testid*="batch"]',
    '[aria-label*="收藏"]',
    '[aria-label*="已掌握"]',
    '[aria-label*="编辑"]',
    '[aria-label*="导出"]',
    '[aria-label*="全选"]',
]) {
    assert.equal(
        await panel.locator(selector).count(),
        0,
        `read-only surface must not render ${selector}`,
    );
}
assert.equal(
    (await panel.locator('button').allInnerTexts())
        .filter((text) => /收藏|已掌握|编辑|导出|批量|全选|删除/.test(text))
        .length,
    0,
    'no write-action button labels inside the lemma panel',
);
await page.screenshot({ path: `${SHOTS}/p1-02-1440.png`, fullPage: false });

// Expanding a lemma with no mapped forms says so (never a fabricated list).
await page.getByTestId('vocab-lemma-row-the').click();
await page.getByTestId('vocab-lemma-detail-the').waitFor();
assert.match(await page.getByTestId('vocab-lemma-detail-the').innerText(), /没有记录/);
await page.getByTestId('vocab-lemma-row-the').click();

// ── D) search matches forms, not just the lemma ─────────────────────────
await page.getByTestId('vocab-lemma-search').fill('running');
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-lemma-row-"]').length === 1,
    { timeout: 10000 },
);
await page.getByTestId('vocab-lemma-row-run').waitFor();
assert.equal(lastLemmaRequest(state).q, 'running');
assert.equal(await page.getByTestId('vocab-lemma-word-run').innerText(), 'run');
assert.equal(await page.getByTestId('vocab-lemma-total').innerText(), '找到 1 词');
await page.getByTestId('vocab-lemma-row-run').click();
await page.getByTestId('vocab-lemma-detail-run').waitFor();
assert.equal(await page.getByTestId('vocab-lemma-forms-count-run').innerText(), '3');
for (const form of ['ran', 'running', 'runs']) {
    assert.equal(
        await page.getByTestId(`vocab-lemma-form-run-${form}`).innerText(),
        form,
        `expanded run lists ${form}`,
    );
}
await page.screenshot({ path: `${SHOTS}/p1-02-search-1440.png`, fullPage: false });

await page.getByTestId('vocab-lemma-search').fill('abandoned');
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-lemma-word-abandon"]')),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).q, 'abandoned');
assert.equal(await page.getByTestId('vocab-lemma-word-abandon').innerText(), 'abandon');
assert.equal(await page.getByTestId('vocab-lemma-badge-abandon').innerText(), 'B1');

// ── E) level filter: one band only, 清除筛选 restores all 10k ────────────
await page.getByTestId('vocab-lemma-search-clear').click();
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-lemma-row-"]').length === 50,
    { timeout: 10000 },
);
await page.getByTestId('vocab-lemma-level-filter').click();
await page.getByTestId('vocab-lemma-level-A1').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-lemma-total"]')?.textContent || '').includes('1,000'),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).level, 'A1');
assert.equal(lastLemmaRequest(state).page, '1', 'a new filter restarts at page 1');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 20 页/);
const levelBadges = await panel
    .locator('[data-testid^="vocab-lemma-badge-"]')
    .evaluateAll((nodes) => nodes.map((node) => (node.textContent || '').trim()));
assert.ok(levelBadges.length > 0, 'A1 rows render their CEFR badge');
assert.deepEqual([...new Set(levelBadges)], ['A1'], `level filter shows A1 only: ${levelBadges.join(',')}`);
await page.screenshot({ path: `${SHOTS}/p1-02-level-1440.png`, fullPage: false });

// The filter menu stays open after picking a band (keepOpen); only reopen it
// when a previous click closed it.
if (!(await page.getByTestId('vocab-lemma-clear-filters-menu').isVisible().catch(() => false))) {
    await page.getByTestId('vocab-lemma-level-filter').click();
}
await page.getByTestId('vocab-lemma-clear-filters-menu').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-lemma-total"]')?.textContent || '').includes('10,000'),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).level, undefined, 'clearing the filter drops level');

// ── F) sort: alphabetical starts at "a"; rank restores frequency order ──
await page.getByTestId('vocab-lemma-sort').click();
await page.getByTestId('vocab-lemma-sort-alpha').click();
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-lemma-word-a"]')),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).sort, 'alpha');
assert.equal(await page.getByTestId('vocab-lemma-word-a').innerText(), 'a');
await page.getByTestId('vocab-lemma-sort').click();
await page.getByTestId('vocab-lemma-sort-rank').click();
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-lemma-word-the"]')),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).sort, 'rank');

// ── G) server paging: next page + jump (50/页, 200 pages) ───────────────
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 200 页/);
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-lemma-word-say"]')),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).page, '2');
assert.equal(await page.getByTestId('vocab-lemma-word-say').innerText(), 'say', 'rank 51 starts page 2');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 2 \/ 200 页/);

await page.getByTestId('vocab-page-jump').fill('7');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '').includes('第 7 / 200 页'),
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).page, '7');
assert.equal(await page.getByTestId('vocab-lemma-word-word00301').innerText(), 'word00301');
assert.equal(await page.getByTestId('vocab-lemma-forms-count-word00301').innerText(), '1');

// A jump past the last page clamps to 200 and disables 下一页.
await page.getByTestId('vocab-page-jump').fill('9999');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '').includes('第 200 / 200 页'),
    { timeout: 10000 },
);
await page.waitForFunction(
    () => document.querySelector('[data-testid="vocab-page-next"]')?.disabled === true,
    { timeout: 10000 },
);
assert.equal(lastLemmaRequest(state).page, '200');
assert.equal(await page.getByTestId('vocab-page-next').isDisabled(), true);

// ── H) empty result is the empty state, not an error ────────────────────
await page.getByTestId('vocab-lemma-search').fill('zzz-not-a-lemma');
await page.getByTestId('vocab-lemma-empty').waitFor({ timeout: 10000 });
assert.equal(await page.getByTestId('vocab-lemma-total').innerText(), '找到 0 词');
assert.equal(await page.getByTestId('vocab-lemma-error').count(), 0);
await page.getByTestId('vocab-lemma-search-clear').click();
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-lemma-row-"]').length === 50,
    { timeout: 10000 },
);

// ── I) load failure → error panel, 重试 re-fetches and renders ───────────
const failState = createState();
failState.failLemma = 1;
const failing = await newContext(browser, failState);
await gotoWordbook(failing.page);
await failing.page.getByTestId('vocab-lemma-tab').click();
await failing.page.getByTestId('vocab-lemma-error').waitFor({ timeout: 15000 });
assert.equal(failState.lemmaRequests.length, 1);
await failing.page.screenshot({ path: `${SHOTS}/p1-02-error-1440.png`, fullPage: false });
await failing.page.getByTestId('vocab-lemma-retry').click();
await failing.page.getByTestId('vocab-lemma-list').waitFor({ timeout: 15000 });
assert.equal(failState.lemmaRequests.length, 2);
assert.equal(await failing.page.getByTestId('vocab-lemma-word-the').innerText(), 'the');
assert.equal(failing.pageErrors.length, 0, `no page errors: ${failing.pageErrors.join(' | ')}`);
await failing.context.close();

// ── J) 375: no horizontal overflow, list + expanded forms ───────────────
const mobile = await newContext(browser, createState(), { width: 375, height: 812 });
await gotoWordbook(mobile.page);
await openLemmaTab(mobile.page);
assert.equal(await lemmaRows(mobile.page).count(), 50);
let overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
);
assert.ok(overflow <= 1, `375 lemma list must not overflow horizontally (${overflow}px)`);
await mobile.page.screenshot({ path: `${SHOTS}/p1-02-375.png`, fullPage: false });

await mobile.page.getByTestId('vocab-lemma-search').fill('running');
await mobile.page.getByTestId('vocab-lemma-row-run').waitFor({ timeout: 10000 });
await mobile.page.getByTestId('vocab-lemma-row-run').click();
await mobile.page.getByTestId('vocab-lemma-detail-run').waitFor();
assert.equal(await mobile.page.getByTestId('vocab-lemma-form-run-running').innerText(), 'running');
overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
);
assert.ok(overflow <= 1, `375 expanded forms must not overflow horizontally (${overflow}px)`);
await mobile.page.screenshot({ path: `${SHOTS}/p1-02-375-expand.png`, fullPage: false });
assert.equal(mobile.pageErrors.length, 0, `no mobile page errors: ${mobile.pageErrors.join(' | ')}`);
await mobile.context.close();

assert.equal(pageErrors.length, 0, `no desktop page errors: ${pageErrors.join(' | ')}`);
await context.close();
await browser.close();

console.log(`\nCEFR lemma tab acceptance: ${assertionsPassed} assertions passed`);
console.log(`  screenshots: ${SHOTS}/p1-02-*.png`);
