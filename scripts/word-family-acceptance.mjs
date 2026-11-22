#!/usr/bin/env node
// Playwright acceptance for specs/041-word-family-list — the read-only 「词族」
// tab (P1-05), which replaces the specs/040 「词形」tab. Runs against a fully
// mocked backend (like the other word-book acceptance scripts: no :8000, no
// account, no AI), exercising the real UI against a 120-family fixture that
// mirrors `content/wordlist/word-families.v1.json`:
// WordNet-derived families, cross-boundary members without a level, A1–C1
// levels, search over any member, server paging with the shared 20/50/100
// per-page selector (default 50) and jump-to-page.
//
// Covers:
//   A) 「词族（CEFR 10k）」 is the tab right after CET6; every existing tab keeps
//      its label/order, and the old 「词形」 tab is gone;
//   B) read-only: no star, no 已掌握 check, no 编辑/批量/导出/全选 inside the
//      panel — only search/sort/filter/pagination + row expansion;
//   C) columns head / phonetic / meaning / level set / member count / expand;
//      expanding lists every member; 10k-outside members render `—`;
//   D) server search matches any member (reflection → reflect, deciding → decide)
//      and sends `q` to /api/vocabulary/word-families;
//   E) level filter sends `level` and narrows to families containing that band;
//      清除筛选 restores;
//   F) sort menu sends `sort=alpha|rank`; 字母 A→Z starts with "abandon";
//   G) the shared pager: 20/50/100 menu, switching sends `pageSize`, restarts at
//      page 1 and recomputes 总页数/页码 (120 families → 6 at 20, 2 at 100,
//      3 at 50); next page; jump; out-of-range jump clamps;
//   H) empty result renders the retryable empty state (not an error);
//   I) a failed load shows the error panel and 重试 re-fetches successfully;
//   J) 375 has no horizontal overflow (list + expanded members), the pager stays
//      reachable, 1440/375 shots.
//
// Screenshots: /tmp/p1-05-*.png, /tmp/p1-06-page-size-menu-1440.png
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node word-family-acceptance.mjs
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

// ── 120-family fixture (mirrors word-families.v1.json semantics) ──────────
const BANDS = [
    [1000, 'A1'],
    [2000, 'A2'],
    [4000, 'B1'],
    [7000, 'B2'],
    [10000, 'C1'],
];
const levelForRank = (rank) => BANDS.find(([max]) => rank <= max)[1];

/** Curated families that pin the acceptance cases to the real audit examples. */
const CURATED = [
    {
        id: 'F0001', head: 'be', headRank: 2, headPhonetic: 'biː', headTranslation: 'v. 是；存在',
        members: [['be', 'A1', 2], ['being', 'B2', 5000]],
    },
    {
        id: 'F0002', head: 'do', headRank: 22, headPhonetic: 'duː', headTranslation: 'v. 做',
        members: [['do', 'A1', 22], ['doing', 'A1', 600]],
    },
    {
        id: 'F0003', head: 'decide', headRank: 494, headPhonetic: 'dɪˈsaɪd', headTranslation: 'v. 决定',
        members: [
            ['decide', 'A1', 494], ['decision', 'A1', 603], ['decisive', 'C1', 7294],
            ['deciding', null, null], ['decisiveness', null, null],
        ],
    },
    {
        id: 'F0004', head: 'judge', headRank: 779, headPhonetic: 'dʒʌdʒ', headTranslation: 'n./v. 法官；判断',
        members: [
            ['judge', 'A1', 779], ['judgment', 'B1', 3348], ['judicial', 'B2', 4548],
            ['judiciary', 'B2', 6756], ['judgeship', null, null], ['judging', null, null],
            ['judgmental', null, null],
        ],
    },
    {
        id: 'F0005', head: 'reflect', headRank: 1645, headPhonetic: 'rɪˈflekt', headTranslation: 'v. 反映；反思',
        members: [
            ['reflect', 'A2', 1645], ['reflection', 'B1', 3622], ['reflective', 'C1', 9839],
            ['reflectivity', null, null], ['reflector', null, null],
        ],
    },
    {
        id: 'F0006', head: 'abandon', headRank: 2183, headPhonetic: 'əˈbændən', headTranslation: 'v. 放弃',
        members: [['abandon', 'B1', 2183], ['abandonment', null, null]],
    },
];

const FILLER_COUNT = 114;

function buildFamilies() {
    const families = CURATED.map((family) => ({ ...family, members: [...family.members] }));
    for (let index = 1; index <= FILLER_COUNT; index += 1) {
        const rank = 3000 + index;
        const head = `filler${String(index).padStart(3, '0')}`;
        const level = levelForRank(rank);
        families.push({
            id: `F${String(6 + index).padStart(4, '0')}`,
            head,
            headRank: rank,
            headPhonetic: '',
            headTranslation: `释义 ${index}`,
            members: [[head, level, rank], [`${head}x`, null, null]],
        });
    }
    return families;
}

const FAMILIES = buildFamilies();
const TOTAL = FAMILIES.length; // 120

function levelsOf(members) {
    const present = new Set(members.map((member) => member[1]).filter(Boolean));
    return ['A1', 'A2', 'B1', 'B2', 'C1'].filter((level) => present.has(level));
}

/** The server's paging/search/level/sort contract, reduced to the fixture. */
function familyPage(searchParams) {
    const int = (value, fallback) => {
        const parsed = Number.parseInt(value, 10);
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const page = Math.max(1, int(searchParams.get('page'), 1));
    const pageSize = Math.min(200, Math.max(1, int(searchParams.get('pageSize'), 50)));
    const q = (searchParams.get('q') || '').trim().toLowerCase();
    const level = (searchParams.get('level') || '').trim().toUpperCase();
    const sort = (searchParams.get('sort') || 'rank').toLowerCase();

    let rows = FAMILIES;
    if (level) rows = rows.filter((family) => family.members.some((member) => member[1] === level));
    if (q) rows = rows.filter((family) => family.members.some((member) => member[0].includes(q)));
    if (sort === 'alpha') {
        rows = [...rows].sort((left, right) => left.head.localeCompare(right.head));
    } else {
        rows = [...rows].sort((left, right) => left.headRank - right.headRank);
    }
    const total = rows.length;
    const start = (page - 1) * pageSize;
    return {
        items: rows.slice(start, start + pageSize).map((family) => ({
            id: family.id,
            head: family.head,
            headRank: family.headRank,
            headLevel: family.members[0][1],
            headPhonetic: family.headPhonetic,
            headTranslation: family.headTranslation,
            levels: levelsOf(family.members),
            members: family.members.map(([lemma, memberLevel, rank]) => ({
                lemma, level: memberLevel, rank,
            })),
        })),
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
         * Every `/api/vocabulary/word-families` request, as a plain query object.
         * The UI must never page client-side: page/pageSize/q/level/sort are
         * all asserted from these records.
         */
        familyRequests: [],
        /** Fail this many word-family requests with a 500 (retry case). */
        failFamily: 0,
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

        // ── the surface under test (specs/041) ────────────────────────────
        if (pathname === '/api/vocabulary/word-families') {
            const params = Object.fromEntries(url.searchParams.entries());
            state.familyRequests.push(params);
            if (state.failFamily > 0) {
                state.failFamily -= 1;
                return fail(500, 'mock word-family failure');
            }
            return respond(familyPage(url.searchParams));
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
        if (pathname === '/api/placement/profile') {
            return respond({ profile: null, preliminary: false });
        }
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

const familyRows = (page) => page.locator('[data-testid^="vocab-family-row-"]');
const lastFamilyRequest = (state) => state.familyRequests[state.familyRequests.length - 1];

async function openFamilyTab(page) {
    await page.getByTestId('vocab-family-tab').click();
    await page.getByTestId('vocab-family-panel').waitFor({ timeout: 15000 });
    await page.getByTestId('vocab-family-list').waitFor({ timeout: 15000 });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const state = createState();
const { context, page, pageErrors } = await newContext(browser, state);

// ── A) tab order: 词族 is the tab right after CET6; old 词形 is gone ──────
await gotoWordbook(page);
await page.getByTestId('vocab-family-tab').waitFor({ timeout: 15000 });
const tabOrder = await page.$$eval(
    '[data-testid="vocab-tabs"] [role="tab"][data-testid]',
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')),
);
assert.deepEqual(
    tabOrder,
    [
        'vocab-tab-mine', 'vocab-tab-mastered', 'vocab-tab-phrases',
        'vocab-tab-cefr', 'vocab-tab-gre', 'vocab-tab-cet4', 'vocab-tab-cet6',
        'vocab-family-tab',
    ],
    `词族 must be appended after CET6 (and before custom lists): ${tabOrder.join(' / ')}`,
);
assert.equal(await page.getByTestId('vocab-lemma-tab').count(), 0, '旧「词形」tab 已移除');
for (const [testId, label] of [
    ['vocab-tab-mine', '我的收藏'],
    ['vocab-tab-mastered', '我会了'],
    ['vocab-tab-phrases', '短语'],
    ['vocab-tab-cefr', 'CEFR 词表'],
    ['vocab-tab-cet6', 'CET6'],
]) {
    assert.equal(
        (await page.getByTestId(testId).innerText()).split('\n')[0],
        label,
        `${testId} keeps its label`,
    );
}
const familyTabText = await page.getByTestId('vocab-family-tab').innerText();
assert.match(familyTabText, /词族/, 'tab label names the surface');
assert.match(familyTabText, /CEFR 10k/, 'tab sub-label carries CEFR 10k');

// ── B/C) read-only list: columns, levels, member count, no write controls ─
await openFamilyTab(page);
assert.equal(state.familyRequests.length, 1);
assert.equal(lastFamilyRequest(state).page, '1');
assert.equal(lastFamilyRequest(state).pageSize, '50', 'the pager defaults to 50/页');
assert.equal(lastFamilyRequest(state).sort, 'rank');
assert.equal(await familyRows(page).count(), 50);
assert.equal(await page.getByTestId('vocab-family-total').innerText(), '共 120 族');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 3 页/);
assert.equal(await page.getByTestId('vocab-family-word-F0001').innerText(), 'be');
assert.equal(await page.getByTestId('vocab-family-ipa-F0001').innerText(), '/biː/');
assert.equal(await page.getByTestId('vocab-family-translation-F0001').innerText(), 'v. 是；存在');
assert.equal(await page.getByTestId('vocab-family-levels-F0001').innerText(), 'A1–B2');
assert.equal(await page.getByTestId('vocab-family-members-count-F0001').innerText(), '2');
assert.equal(await page.getByTestId('vocab-family-row-F0051').count(), 0, 'only page 1 is rendered');
await page.screenshot({ path: `${SHOTS}/p1-05-1440.png`, fullPage: false });

const panel = page.getByTestId('vocab-family-panel');
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
    'no write-action button labels inside the family panel',
);

// C) expanding a family lists every member; 10k-outside members show `—`.
await page.getByTestId('vocab-family-row-F0003').click();
await page.getByTestId('vocab-family-detail-F0003').waitFor();
assert.equal(await page.getByTestId('vocab-family-members-count-F0003').innerText(), '5');
assert.equal(
    await page.getByTestId('vocab-family-member-level-F0003-decision').innerText(),
    'A1',
);
assert.equal(
    await page.getByTestId('vocab-family-member-level-F0003-deciding').innerText(),
    '—',
    '10k 外成员渲染 —，不默认 A1',
);
assert.equal(
    await page.getByTestId('vocab-family-member-level-F0003-decisiveness').innerText(),
    '—',
);
assert.match(
    await page.getByTestId('vocab-family-detail-F0003').innerText(),
    /成员（5 个）/,
);
await page.screenshot({ path: `${SHOTS}/p1-05-expand-1440.png`, fullPage: false });
await page.getByTestId('vocab-family-row-F0003').click();
assert.equal(await page.getByTestId('vocab-family-detail-F0003').count(), 0, '再次点击收起');

// ── D) search matches any member, not just the head ─────────────────────
await page.getByTestId('vocab-family-search').fill('reflection');
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-family-row-"]').length === 1,
    { timeout: 10000 },
);
await page.getByTestId('vocab-family-row-F0005').waitFor();
assert.equal(lastFamilyRequest(state).q, 'reflection');
assert.equal(await page.getByTestId('vocab-family-word-F0005').innerText(), 'reflect');
assert.equal(await page.getByTestId('vocab-family-total').innerText(), '找到 1 族');
await page.getByTestId('vocab-family-row-F0005').click();
await page.getByTestId('vocab-family-detail-F0005').waitFor();
assert.equal(
    await page.getByTestId('vocab-family-member-level-F0005-reflection').innerText(),
    'B1',
    'allowlist 边 reflect–reflection：成员命中整族',
);
await page.getByTestId('vocab-family-row-F0005').click();

await page.getByTestId('vocab-family-search').fill('deciding');
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-family-word-F0003"]')),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).q, 'deciding');
assert.equal(await page.getByTestId('vocab-family-word-F0003').innerText(), 'decide');

// ── E) level filter: families containing that band; 清除筛选 restores ─────
await page.getByTestId('vocab-family-search-clear').click();
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-family-row-"]').length === 50,
    { timeout: 10000 },
);
await page.getByTestId('vocab-family-level-filter').click();
await page.getByTestId('vocab-family-level-A1').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-family-total"]')?.textContent || '').includes('族')
        && !document.querySelector('[data-testid="vocab-family-total"]')?.textContent.includes('120'),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).level, 'A1');
assert.equal(lastFamilyRequest(state).page, '1', 'a new filter restarts at page 1');
const visibleLevels = await panel
    .locator('[data-testid^="vocab-family-row-"]')
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-family-levels') || ''));
assert.ok(visibleLevels.length > 0, 'A1 filter returns families');
assert.ok(
    visibleLevels.every((levels) => levels.split(',').includes('A1')),
    `level filter shows only families with an A1 member: ${visibleLevels.join(' | ')}`,
);
await page.screenshot({ path: `${SHOTS}/p1-05-level-1440.png`, fullPage: false });

if (!(await page.getByTestId('vocab-family-clear-filters-menu').isVisible().catch(() => false))) {
    await page.getByTestId('vocab-family-level-filter').click();
}
await page.getByTestId('vocab-family-clear-filters-menu').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-family-total"]')?.textContent || '').includes('120'),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).level, undefined, 'clearing the filter drops level');

// ── F) sort: alphabetical starts at "abandon"; rank restores frequency ──
await page.getByTestId('vocab-family-sort').click();
await page.getByTestId('vocab-family-sort-alpha').click();
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-family-word-F0006"]')),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).sort, 'alpha');
assert.equal(await page.getByTestId('vocab-family-word-F0006').innerText(), 'abandon');
await page.getByTestId('vocab-family-sort').click();
await page.getByTestId('vocab-family-sort-rank').click();
await page.waitForFunction(
    () => Boolean(document.querySelector('[data-testid="vocab-family-word-F0001"]')),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).sort, 'rank');

// ── G) shared pager: 20/50/100 menu, switching, next page + jump ────────
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 3 页/);
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 50');

// The size selector that every other word list shows is present here too.
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
assert.equal(
    await page.getByTestId('vocab-page-size-menu').locator('[data-menu-item="true"]').count(),
    3,
    '每页条数 menu offers exactly 20/50/100',
);
for (const size of [20, 50, 100]) {
    assert.equal(
        await page.getByTestId(`vocab-page-size-${size}`).innerText(),
        `每页 ${size}`,
        `menu item ${size}`,
    );
}
await page.screenshot({ path: `${SHOTS}/p1-06-page-size-menu-1440.png`, fullPage: false });

// Switch to 20/页 while on page 1: request carries pageSize=20, 120 → 6 pages.
await page.getByTestId('vocab-page-size-20').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 1 / 6 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0001"]'))
        && !document.querySelector('[data-testid="vocab-family-word-F0051"]');
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).pageSize, '20', 'the request carries the chosen pageSize');
assert.equal(lastFamilyRequest(state).page, '1');
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 20');
assert.equal(await page.getByTestId('vocab-page-jump').inputValue(), '1', 'jump input follows the reset');
assert.equal(await familyRows(page).count(), 20);
assert.equal(await page.getByTestId('vocab-page-next').isDisabled(), false);

// Switch to 100/页: 120 → 2 pages, still page 1.
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-100').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 1 / 2 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0051"]'));
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).pageSize, '100');
assert.equal(lastFamilyRequest(state).page, '1');
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 100');
assert.equal(await familyRows(page).count(), 100);
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 2 页/);

// Page 2 at 100/页 holds the remaining 20 families.
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 2 / 2 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0101"]'))
        && !document.querySelector('[data-testid="vocab-family-word-F0001"]');
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).page, '2');
assert.equal(lastFamilyRequest(state).pageSize, '100');
assert.equal(await familyRows(page).count(), 20);

// Switching size from page 2 restarts at page 1 with the new param.
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-20').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 1 / 6 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0001"]'))
        && !document.querySelector('[data-testid="vocab-family-word-F0101"]');
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).page, '1', 'a page-size change restarts at page 1');
assert.equal(lastFamilyRequest(state).pageSize, '20');
assert.equal(await page.getByTestId('vocab-page-jump').inputValue(), '1');

// Restore 50/页 for the next-page / jump cases below.
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-50').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 1 / 3 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0050"]'))
        && !document.querySelector('[data-testid="vocab-family-word-F0051"]');
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).page, '1');
assert.equal(lastFamilyRequest(state).pageSize, '50');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 1 \/ 3 页/);

// Next page: 50/页, rows 51–100.
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 2 / 3 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0051"]'))
        && !document.querySelector('[data-testid="vocab-family-word-F0001"]');
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).page, '2');
assert.equal(lastFamilyRequest(state).pageSize, '50');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 2 \/ 3 页/);
assert.equal(await familyRows(page).count(), 50);

// Jump to the last page: 20 rows, next disabled.
await page.getByTestId('vocab-page-jump').fill('3');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => {
    const status = document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '';
    return status.includes('第 3 / 3 页')
        && Boolean(document.querySelector('[data-testid="vocab-family-word-F0101"]'));
}, { timeout: 10000 });
assert.equal(lastFamilyRequest(state).page, '3');
assert.equal(lastFamilyRequest(state).pageSize, '50');
assert.match(await page.getByTestId('vocab-page-status').innerText(), /第 3 \/ 3 页/);
assert.equal(await familyRows(page).count(), 20);
assert.equal(await page.getByTestId('vocab-page-next').isDisabled(), true);

// A jump past the last page clamps to 3 and stays disabled.
await page.getByTestId('vocab-page-jump').fill('9999');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(
    () => (document.querySelector('[data-testid="vocab-page-status"]')?.textContent || '').includes('第 3 / 3 页'),
    { timeout: 10000 },
);
assert.equal(lastFamilyRequest(state).page, '3');

// ── H) empty result is the empty state, not an error ────────────────────
await page.getByTestId('vocab-family-search').fill('zzz-not-a-member');
await page.getByTestId('vocab-family-empty').waitFor({ timeout: 10000 });
assert.equal(await page.getByTestId('vocab-family-total').innerText(), '找到 0 族');
assert.equal(await page.getByTestId('vocab-family-error').count(), 0);
await page.getByTestId('vocab-family-search-clear').click();
await page.waitForFunction(
    () => document.querySelectorAll('[data-testid^="vocab-family-row-"]').length === 50,
    { timeout: 10000 },
);

// ── I) load failure → error panel, 重试 re-fetches and renders ───────────
const failState = createState();
failState.failFamily = 1;
const failing = await newContext(browser, failState);
await gotoWordbook(failing.page);
await failing.page.getByTestId('vocab-family-tab').click();
await failing.page.getByTestId('vocab-family-error').waitFor({ timeout: 15000 });
assert.equal(failState.familyRequests.length, 1);
await failing.page.screenshot({ path: `${SHOTS}/p1-05-error-1440.png`, fullPage: false });
await failing.page.getByTestId('vocab-family-retry').click();
await failing.page.getByTestId('vocab-family-list').waitFor({ timeout: 15000 });
assert.equal(failState.familyRequests.length, 2);
assert.equal(await failing.page.getByTestId('vocab-family-word-F0001').innerText(), 'be');
assert.equal(failing.pageErrors.length, 0, `no page errors: ${failing.pageErrors.join(' | ')}`);
await failing.context.close();

// ── J) 375: no horizontal overflow, list + expanded members ─────────────
const mobile = await newContext(browser, createState(), { width: 375, height: 812 });
await gotoWordbook(mobile.page);
await openFamilyTab(mobile.page);
assert.equal(await familyRows(mobile.page).count(), 50);
assert.equal(
    await mobile.page.getByTestId('vocab-page-size').isVisible(),
    true,
    '每页条数 selector stays reachable at 375',
);
assert.equal(
    await mobile.page.getByTestId('vocab-page-jump').isVisible(),
    true,
    'jump-to-page input stays reachable at 375',
);
let overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
);
assert.ok(overflow <= 1, `375 family list must not overflow horizontally (${overflow}px)`);
await mobile.page.screenshot({ path: `${SHOTS}/p1-05-375.png`, fullPage: false });

// The shared pager (size selector + page strip + jump) fits the 375 column.
await mobile.page.getByTestId('vocab-page-size').scrollIntoViewIfNeeded();
await mobile.page.screenshot({ path: `${SHOTS}/p1-06-page-size-375.png`, fullPage: false });
overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
);
assert.ok(overflow <= 1, `375 pager must not overflow horizontally (${overflow}px)`);

await mobile.page.getByTestId('vocab-family-row-F0004').click();
await mobile.page.getByTestId('vocab-family-detail-F0004').waitFor();
assert.equal(
    await mobile.page.getByTestId('vocab-family-member-level-F0004-judgeship').innerText(),
    '—',
);
overflow = await mobile.page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
);
assert.ok(overflow <= 1, `375 expanded members must not overflow horizontally (${overflow}px)`);
await mobile.page.screenshot({ path: `${SHOTS}/p1-05-375-expand.png`, fullPage: false });
assert.equal(mobile.pageErrors.length, 0, `no mobile page errors: ${mobile.pageErrors.join(' | ')}`);
await mobile.context.close();

assert.equal(pageErrors.length, 0, `no desktop page errors: ${pageErrors.join(' | ')}`);
await context.close();
await browser.close();

console.log(`\nWord family tab acceptance: ${assertionsPassed} assertions passed`);
console.log(`  screenshots: ${SHOTS}/p1-05-*.png, ${SHOTS}/p1-06-*.png`);
