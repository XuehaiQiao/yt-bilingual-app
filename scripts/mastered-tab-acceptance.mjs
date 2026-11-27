// Playwright acceptance for specs/005 §v1.1 「已掌握 is its own word-list tab」,
// updated for the unified word-list UI (commit 381440f, specs/005 §统一词表 UI).
//
//   A) signed-in: tab order 我的收藏 / 已掌握 / 短语 / CEFR / GRE / CET4 / CET6;
//      no in-page 学习/已掌握 segment; 我的收藏 is the favorites list itself
//      (only `luminous`) — the mastered lemmas are not favorites at all.
//   B) 已掌握 renders the shared WordTable: 单词 / 音标 / 中文释义 / CEFR cells.
//      Its only source is GET /api/review/words?mastered=1: the meaning comes
//      from the `definition` snapshot (`—` when absent), the phonetic cell is
//      never fed by a favorite, and the star is a DISABLED control — 已掌握 is
//      not a favorite (ADR-0001). CEFR comes from a mocked /level (null → C1+).
//   C) hide-Chinese removes every meaning cell; the legacy per-row tap-to-reveal
//      no longer exists on 已掌握 (only the list/custom surfaces wire row
//      activation), so the reveal contract is asserted on the GRE list in §I.
//   D) shared pager: 50/page default, 每页 20/50/100 menu, page strip and 跳至
//      input (60 mocked rows → 2 pages at 50, 3 at 20).
//   E) the pressed 已掌握 circle toggle is the undo control (P0-10 — no
//      expanded text action; P0-12 — same circle+check shape, success-filled
//      when mastered and hollow when not); it PATCHes mastered=false and the
//      row leaves the tab, but the word does NOT come back to 我的收藏 (undo
//      never refills the favorite, specs/005 §已掌握与收藏互斥) and the count
//      stays 1.
//   F) first-load failure shows an error panel with retry (never the empty
//      state); a failed refresh keeps stale rows (IX-01); retry recovers.
//   G) guest: the tab is 「我会了」, fed by the local table only (no review GET),
//      undo (the pressed check) writes the local table.
//   H) 375px: no horizontal overflow.
//   I) the GRE list still renders through the same WordTable.
//
// P0-14: 已掌握 also has an explicit edit mode. Non-edit state renders no
// checkbox; 编辑 shows the leading checkbox + 取消已掌握 batch bar, and 完成 or a
// tab switch exits and clears the selection (§E2 / §H).
// P0-15: §E3 covers the client-paged tri-state 全选 across both 50/page pages
// (57 rows), indeterminate + 清除选择, and a cross-page 取消已掌握 batch whose
// page-2 row is no longer rendered. §H repeats 全选 at 375.
//
// Every /api/** request is mocked; nothing touches :8000 or the real backend.
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node mastered-tab-acceptance.mjs
// Shots: /tmp/mastered-tab-*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Count executed assertions so a green run reports how many checks passed.
let assertionsPassed = 0;
for (const name of ['ok', 'equal', 'deepEqual', 'match']) {
    const original = assert[name];
    assert[name] = (...args) => {
        original(...args);
        assertionsPassed += 1;
    };
}

const BASE = process.env.APP_URL || 'http://localhost:5199/';
const SHOTS = '/tmp';
const GUEST_KEY = 'yt_bilingual.v2.guest.guest_mastered_words';

const MASTERED_BASE = ['abundant', 'meticulous', 'reluctant'];
// 60 rows total → two 50/page pages (the last page shows the remainder).
const FILLER = Array.from({ length: 57 }, (_, index) => `word${String(index + 1).padStart(2, '0')}`);
const ALL_MASTERED = [...MASTERED_BASE, ...FILLER];
// P0-16: distinct 加入时间 values whose order differs from alphabetical, so the
// default `added` sort is proven by row order (not by a coincidental alpha order).
const BASE_CREATED_AT = {
    abundant: 1763100003000,
    reluctant: 1763100002000,
    meticulous: 1763100001000,
};
const fillerCreatedAt = (index) => 1763000000000 - index * 1000;

// 已掌握 and 我的收藏 are two independent lists (ADR-0001). Only `luminous` is
// a vocabulary favorite; no mastered lemma appears in FAVORITES, so their row
// meaning can only come from the `word_states.definition` snapshot returned by
// GET /api/review/words?mastered=1 (never from a favorite).
const MASTERED_DEFINITIONS = {
    abundant: '丰富的；充裕的',
    reluctant: '不情愿的；勉强的',
    // meticulous stays undefined: no snapshot → the meaning cell reads `—`.
};

const FAVORITES = [
    {
        id: 'fav-luminous',
        type: 'vocabulary',
        en_text: 'luminous',
        zh_text: '/ˈluːmɪnəs/ 发光的；明亮的',
        added_at: 1763100000000,
        videoId: 'vid-luminous',
        start: 5,
        source_kind: 'video',
        source_ref: 'vid-luminous',
        source_title: 'Habits and Cities',
    },
];

const LEVELS = {
    abundant: 'B2',
    reluctant: 'A1',
    luminous: 'B1',
    // meticulous stays null on purpose: the API returns null for unknown words.
};

const state = {
    mode: 'signedIn', // 'signedIn' | 'guest'
    mastered: [...ALL_MASTERED],
    masteredFail: false,
    /** Lemma whose PATCH fails (P0-14 failed-batch retention case). */
    failMastered: null,
    masteredFetches: 0,
    masteredUrls: [],
    guestMasteredFetches: 0,
    patches: [],
    // Any favorite write (POST /api/favorites, DELETE /api/favorites/:id).
    // The 已掌握 star must never produce one: 已掌握 is not a favorite.
    favoriteWrites: [],
    levelCalls: [],
};

const publicWord = (lemma, mastered, createdAt = Date.now()) => ({
    id: `w-${lemma}`,
    lemma,
    targetLang: 'zh-CN',
    state: 'new',
    dueAt: Date.now(),
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    failStreak: 0,
    lastReviewedAt: null,
    createdAt,
    mastered,
    definition: MASTERED_DEFINITIONS[lemma] ?? null,
    sources: [],
});

function levelForWord(word) {
    return LEVELS[String(word).trim().toLowerCase()] ?? null;
}

const CORS = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
});
await context.addInitScript(() => {
    if (!localStorage.getItem('yt_bilingual_ui_lang')) {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    }
    if (!localStorage.getItem('yt_bilingual_target_lang')) {
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    }
});

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

    // ── session + app shell ──────────────────────────────────────────────
    if (pathname === '/api/auth/me') {
        return state.mode === 'signedIn'
            ? respond({ user: { id: 'u-mt', email: 'mastered@example.com', username: 'Reader' }, isAdmin: false, guest: false })
            : respond({ user: null, guest: true });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-mt', email: 'mastered@example.com', username: 'Reader', credits: 12, memberSince: 1763000000000 },
            monthSpendUsd: 0.12,
            usageToday: { minutes: 8 },
            version: 'test',
            preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
    }
    if (pathname === '/api/favorites' && method === 'GET') return respond(FAVORITES);
    // 已掌握 is not a favorite: any favorite write from this screen is a bug.
    if (pathname === '/api/favorites' && method !== 'GET') {
        state.favoriteWrites.push(`${method} ${pathname}`);
        return fail(500, 'favorites must not be written from the mastered tab');
    }
    if (/^\/api\/favorites\/[^/]+$/.test(pathname)) {
        state.favoriteWrites.push(`${method} ${pathname}`);
        return fail(500, 'favorites must not be written from the mastered tab');
    }
    if (pathname === '/api/models') {
        return respond({
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/review/stats') {
        return respond({
            targetLang: 'zh-CN', now: Date.now(), today: '2026-11-22', dueToday: 0, dueNow: 0,
            reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
            suspendedWords: 0, streakDays: 0,
        });
    }
    if (pathname === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B1', source: 'default' }, preliminary: false });
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/library/articles') return respond({ articles: [] });
    if (pathname === '/api/placement/profile') return respond({ profile: null, preliminary: false });
    if (pathname === '/api/ability/profile') return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });

    // ── the mastered list under test ─────────────────────────────────────
    const isReviewWords = pathname === '/api/review/words';
    if (isReviewWords && method === 'GET') {
        if (state.mode === 'guest') {
            // Guests must never ask for the server mastered list.
            state.guestMasteredFetches += 1;
            return fail(403, 'login required');
        }
        assert.equal(url.searchParams.get('mastered'), '1', 'GET /api/review/words must ask for mastered=1');
        assert.equal(url.searchParams.get('limit'), '200');
        state.masteredFetches += 1;
        state.masteredUrls.push(url.search);
        if (state.masteredFail) return fail(500, 'review table unavailable');
        const words = state.mastered.map((lemma, index) => publicWord(
            lemma,
            true,
            BASE_CREATED_AT[lemma] ?? fillerCreatedAt(index),
        ));
        return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
    }
    if (isReviewWords && method === 'PATCH') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').toLowerCase();
        state.patches.push({ lemma, mastered: body.mastered });
        if (state.failMastered && lemma === state.failMastered) {
            return fail(500, 'mastered write failed');
        }
        if (body.mastered === true) state.mastered = [...new Set([...state.mastered, lemma])];
        else state.mastered = state.mastered.filter((word) => word !== lemma);
        return respond({ status: 'ok', word: publicWord(lemma, body.mastered === true) });
    }
    if (isReviewWords && method === 'POST') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').toLowerCase();
        state.mastered = state.mastered.filter((word) => word !== lemma);
        return respond({ status: 'ok', word: publicWord(lemma, false) });
    }

    // ── vocabulary catalog + levels ──────────────────────────────────────
    if (pathname === '/api/vocabulary/lists' && method === 'GET') {
        const list = (id, label, count, extra = {}) => ({
            id, label, count, byLevel: {}, source: 'test', license: 'test',
            notice: null, approximate: false, available: true, version: '1', note: null, ...extra,
        });
        return respond([
            list('cefr', 'CEFR 词表', 5000, { byLevel: { A1: 1000, A2: 1000, B1: 1000, B2: 1000, C1: 1000 }, approximate: true }),
            list('gre', 'GRE', 3200),
            list('cet4', 'CET4', 2600),
            list('cet6', 'CET6', 1200),
            list('phrases', '短语', 570),
        ]);
    }
    const listPage = pathname.match(/^\/api\/vocabulary\/lists\/([a-z0-9-]+)$/);
    if (listPage && method === 'GET') {
        const items = listPage[1] === 'gre'
            ? [
                { word: 'abundant', phonetic: '/əˈbʌndənt/', translation: '丰富的；充裕的', cefrLevel: 'B2' },
                { word: 'brisk', phonetic: '/brɪsk/', translation: '轻快的', cefrLevel: 'B1' },
                { word: 'candid', phonetic: '', translation: '', cefrLevel: '' },
            ]
            : [];
        return respond({
            items,
            total: items.length,
            page: Number(url.searchParams.get('page') || 1),
            pageSize: Number(url.searchParams.get('pageSize') || 50),
            hasMore: false,
        });
    }
    if (pathname === '/api/vocabulary/level' && method === 'GET') {
        const words = (url.searchParams.get('words') || '').split(',').filter(Boolean);
        state.levelCalls.push(words);
        return respond(Object.fromEntries(words.map((word) => [word, levelForWord(word)])));
    }
    if (pathname === '/api/vocabulary/seen' && method === 'GET') return respond({});
    // Custom lists are empty for this fixture; the unified book asks on mount.
    if (pathname === '/api/wordlists' && method === 'GET') return respond({ lists: [] });

    return fail(404, `unmocked ${method} ${pathname}`);
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const shot = async (name) => {
    await page.screenshot({ path: `${SHOTS}/mastered-tab-${name}.png`, fullPage: false });
};

/** P0-16: download one export and read the file Playwright saved. */
const grabDownload = async (locator) => {
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        locator.click(),
    ]);
    const path = await download.path();
    assert.ok(path, 'export produced a file');
    const raw = readFileSync(path, 'utf8');
    return {
        filename: download.suggestedFilename(),
        hasBom: raw.startsWith('\uFEFF'),
        text: raw.replace(/^\uFEFF/, ''),
    };
};
const stamp = () => {
    const d = new Date();
    return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
};

async function gotoWordbook() {
    await page.goto(`${BASE}#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vocabulary-book"]', { timeout: 15000 });
    await page.getByTestId('vocab-tabs').waitFor({ timeout: 15000 });
}

const rowTexts = async (testId) => page.$$eval(
    `[data-testid="${testId}"]`,
    (nodes) => nodes.map((node) => node.textContent.trim()),
);

// ── A) tab order, labels, no in-page group switch ────────────────────────
await gotoWordbook();
const tabOrder = await page.$$eval(
    '[role="tab"][data-testid^="vocab-tab-"]',
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')),
);
assert.deepEqual(
    tabOrder,
    ['vocab-tab-mine', 'vocab-tab-mastered', 'vocab-tab-phrases', 'vocab-tab-cefr', 'vocab-tab-gre', 'vocab-tab-cet4', 'vocab-tab-cet6'],
    `tab order: ${tabOrder.join(' / ')}`,
);
assert.equal((await page.getByTestId('vocab-tab-mastered').innerText()).startsWith('已掌握'), true,
    'signed-in mastered tab must read 已掌握');
assert.equal((await page.getByTestId('vocab-tab-mine').innerText()).startsWith('我的收藏'), true,
    'the favorites surface is called 我的收藏 (P0-10)');
assert.equal(await page.getByTestId('vocab-mine-group').count(), 0, 'the in-page group segment must be gone');
assert.equal(await page.getByTestId('vocab-group-mastered').count(), 0, 'the in-page group segment must be gone');
// 我的收藏 is the favorites list itself (ADR-0001) — no subtraction, no
// read-time mastery filter. The fixture has exactly one favorite, `luminous`:
// the mastered lemmas are not favorites at all, which is why they are absent.
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
assert.equal(await page.$$eval('[data-testid^="vocab-mine-word-"]', (nodes) => nodes.length), 1,
    '我的收藏 lists exactly the one fixture favorite (not a filtered set)');
const mineWords = await rowTexts('vocab-mine-word-fav-luminous').catch(() => []);
assert.equal(mineWords.length > 0, true, 'the single favorite is listed in 我的收藏');
assert.equal(await page.getByTestId('vocab-mine-word-fav-abundant').count(), 0,
    'a mastered word is not a favorite, so it never shows in 我的收藏');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 1 词');
// P0-10: the favorites row carries the 已掌握 circle toggle (unpressed;
// luminous is not mastered) next to the star. P0-12: the toggle is a circle +
// check, never a naked check — the unpressed state is a hollow neutral ring.
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-luminous').count(), 1);
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-luminous').getAttribute('aria-pressed'), 'false');
const mineIndicator = page.getByTestId('vocab-mine-master-toggle-fav-luminous-indicator');
assert.equal(await mineIndicator.count(), 1, 'the my-favorites toggle renders the circle indicator');
assert.equal(await mineIndicator.getAttribute('data-state'), 'unchecked');
const mineIndicatorClass = (await mineIndicator.getAttribute('class')) ?? '';
assert.match(mineIndicatorClass, /rounded-full/, 'the mastered toggle is a circle');
assert.match(mineIndicatorClass, /border-line-strong/, 'the unmastered circle is a line-token ring');
assert.match(mineIndicatorClass, /text-fg-muted/, 'the unmastered check is neutral grey');
assert.doesNotMatch(mineIndicatorClass, /\bbg-success\b/, 'an unmastered circle is hollow');
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-luminous').locator(':scope > svg').count(), 0,
    'the check is never rendered naked outside the circle');
await shot('mine-tab');

// ── B) 已掌握 table: definition snapshot, no favorite enrichment, no star ──
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.getByTestId('vocab-mastered-loading').count(), 0);
// The list is driven only by GET /api/review/words?mastered=1.
assert.equal(state.masteredFetches > 0, true, '已掌握 is loaded from GET /api/review/words');
assert.deepEqual(
    Array.from(new Set(state.masteredUrls.map((search) => new URLSearchParams(search).get('mastered')))),
    ['1'],
    'every mastered read asks for mastered=1',
);
const headerCells = (await page.$$eval('[data-testid="vocab-mastered-header"] span', (nodes) => (
    nodes.map((node) => node.textContent.trim()).filter(Boolean)
)));
assert.deepEqual(headerCells, ['单词', '音标', '中文释义', 'CEFR'], `table header: ${headerCells.join(' | ')}`);
assert.doesNotMatch(await page.getByTestId('vocab-mastered-header').innerText(), /次数/,
    '已掌握 has no ×N column');
const firstPageRows = await page.$$eval('[data-testid="vocab-mastered-row"]', (nodes) => nodes.length);
assert.equal(firstPageRows, 50, `page 1 shows 50 rows, saw ${firstPageRows}`);
const abundantWord = await page.getByTestId('vocab-mastered-word-abundant').innerText();
assert.equal(abundantWord, 'abundant', 'the review lemma wins — there is no favorite casing');
const abundantIpa = (await page.getByTestId('vocab-mastered-ipa-abundant').innerText()).trim();
assert.equal(abundantIpa, '', 'the phonetic cell is never fed by a favorite');
const abundantMeaning = await page.getByTestId('vocab-mastered-translation-abundant').innerText();
assert.equal(abundantMeaning, '丰富的；充裕的', 'meaning comes from the definition snapshot');
const abundantLevel = await page.getByTestId('vocab-mastered-level-abundant').innerText();
assert.equal(abundantLevel, 'B2', 'CEFR comes from the batched /level call');
// A definition-only snapshot: meaning set, phonetic still empty.
const reluctantIpa = (await page.getByTestId('vocab-mastered-ipa-reluctant').innerText()).trim();
assert.equal(reluctantIpa, '', 'a definition-only snapshot renders an empty phonetic cell');
const reluctantMeaning = await page.getByTestId('vocab-mastered-translation-reluctant').innerText();
assert.equal(reluctantMeaning, '不情愿的；勉强的');
// No definition at all: empty IPA, `—` meaning, null level → C1+.
const meticulousIpa = (await page.getByTestId('vocab-mastered-ipa-meticulous').innerText()).trim();
const meticulousMeaning = await page.getByTestId('vocab-mastered-translation-meticulous').innerText();
const meticulousLevel = await page.getByTestId('vocab-mastered-level-meticulous').innerText();
assert.deepEqual([meticulousIpa, meticulousMeaning, meticulousLevel], ['', '—', 'C1+']);
// None of the 50 visible rows may borrow a phonetic from a favorite: there is
// no favorite for any of them, and all definitions are meaning-only.
const nonEmptyIpas = await page.$$eval(
    '[data-testid^="vocab-mastered-ipa-"]',
    (nodes) => nodes.map((node) => node.textContent.trim()).filter(Boolean),
);
assert.deepEqual(nonEmptyIpas, [], `mastered phonetics must stay empty: ${nonEmptyIpas.join(' | ')}`);
assert.ok(state.levelCalls.flat().includes('meticulous'), 'mastered words go through the batched /level call');
// 已掌握 is not a favorite: the star is disabled, unfilled, and writes nothing.
const masteredStar = page.getByTestId('vocab-mastered-star-abundant');
assert.equal(await masteredStar.isDisabled(), true, 'the 已掌握 star is a disabled control (not a favorite)');
assert.equal(await masteredStar.getAttribute('aria-pressed'), 'false', 'the 已掌握 star must never render as 已收藏');
assert.match(await masteredStar.getAttribute('aria-label'), /已掌握，不是收藏/);
// P0-10: every 已掌握 row carries a pressed check as its undo control, and the
// expanded text action is gone.
const masteredCheck = page.getByTestId('vocab-mastered-master-toggle-abundant');
assert.equal(await masteredCheck.count(), 1, '已掌握 rows carry the check');
assert.equal(await masteredCheck.getAttribute('aria-pressed'), 'true', 'the check is pressed on 已掌握 rows');
assert.match(await masteredCheck.getAttribute('aria-label'), /取消已掌握 abundant/);
// P0-12: pressed = the same circle, filled with the success token.
const masteredIndicator = page.getByTestId('vocab-mastered-master-toggle-abundant-indicator');
assert.equal(await masteredIndicator.count(), 1, '已掌握 rows render one circle indicator');
assert.equal(await masteredIndicator.getAttribute('data-state'), 'checked');
const masteredIndicatorClass = (await masteredIndicator.getAttribute('class')) ?? '';
assert.match(masteredIndicatorClass, /rounded-full/, 'the mastered state keeps the circle shape');
assert.match(masteredIndicatorClass, /bg-success\/15/, 'the mastered circle is filled success');
assert.match(masteredIndicatorClass, /border-success\/40/, 'the mastered circle uses the success border');
assert.match(masteredIndicatorClass, /text-success-fg/, 'the mastered check is green');
assert.equal(await masteredIndicator.locator('svg').count(), 1,
    'the check glyph lives inside the circle');
assert.equal(await page.getByTestId('vocab-mastered-undo-abundant').count(), 0,
    'the old 撤销 text action is removed (P0-10)');
// Native click on a disabled control dispatches no event — and even if it
// did, 已掌握 has no favorite write path. Assert no request escaped either way.
await masteredStar.evaluate((element) => element.click());
await page.waitForTimeout(300);
assert.deepEqual(state.favoriteWrites, [], 'clicking the 已掌握 star must not POST/DELETE a favorite');
assert.deepEqual(state.patches, [], 'clicking the 已掌握 star must not PATCH a mastery mark');
await shot('mastered-table');

// ── B1b) P1-22 手风琴：已掌握同一时刻只展开一行 ──────────────────────────
// 展开另一行 → 上一行自动收起；再点同一行 → 收起；切 tab 清空。
const masteredExpand = (key) => page.getByTestId(`vocab-mastered-expand-${key}`);
await masteredExpand('abundant').click();
await page.waitForSelector('[data-testid="vocab-mastered-detail-abundant"]');
await masteredExpand('reluctant').click();
await page.waitForSelector('[data-testid="vocab-mastered-detail-reluctant"]');
assert.equal(await page.getByTestId('vocab-mastered-detail-abundant').count(), 0,
    '展开另一行时，上一行自动收起');
assert.equal(await page.locator('[data-testid^="vocab-mastered-detail-"]').count(), 1,
    '已掌握同一时刻只有一行展开');
await masteredExpand('reluctant').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-detail-"]').length === 0);
assert.equal(await masteredExpand('reluctant').evaluate((el) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') ?? null), 'false',
    '再点同一行收起');
await masteredExpand('abundant').click();
await page.waitForSelector('[data-testid="vocab-mastered-detail-abundant"]');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 50);
assert.equal(await page.locator('[data-testid^="vocab-mastered-detail-"]').count(), 0,
    '切 tab 清空已掌握展开');
await shot('mastered-accordion');

// ── B2) P0-16 default sort: 加入时间 (createdAt new → old, tie by word) ────
// The fixture's created order differs from alphabetical, so this proves the
// default reads `createdAt` from GET /api/review/words rather than sorting by
// word. The 已掌握 menu offers all three orders and shows the current value.
const masteredFirstWords = async () => (
    await page.$$eval('[data-testid^="vocab-mastered-word-"]',
        (nodes) => nodes.slice(0, 3).map((node) => node.textContent.trim()))
);
assert.deepEqual(await masteredFirstWords(), ['abundant', 'reluctant', 'meticulous'],
    '已掌握 defaults to 加入时间, newest first');
const masteredSortLabel = await page.getByTestId('vocab-mastered-sort').innerText();
assert.match(masteredSortLabel, /加入时间/, `已掌握 sort trigger shows the current value: ${masteredSortLabel}`);
await page.getByTestId('vocab-mastered-sort').click();
await page.getByTestId('vocab-mastered-sort-menu').waitFor();
assert.equal(await page.locator('[role="menuitemradio"]').count(), 3,
    '已掌握 sort menu: 加入时间 / 字母 A→Z / 难度');
assert.equal(await page.getByTestId('vocab-mastered-sort-added').count(), 1,
    'the 已掌握 menu carries the 加入时间 item');
await page.getByTestId('vocab-mastered-sort-alpha').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-mastered-sort"]')?.textContent?.includes('字母'));
assert.deepEqual(await masteredFirstWords(), ['abundant', 'meticulous', 'reluctant'],
    '字母 A→Z remains available');
await page.getByTestId('vocab-mastered-sort').click();
await page.getByTestId('vocab-mastered-sort-menu').waitFor();
await page.getByTestId('vocab-mastered-sort-added').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-mastered-sort"]')?.textContent?.includes('加入时间'));
assert.deepEqual(await masteredFirstWords(), ['abundant', 'reluctant', 'meticulous'],
    'switching back to 加入时间 restores the createdAt order');

// Page size / strip / jump input live in one shared pager.
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 60 词', 'the header total follows 已掌握');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 60 词');
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-20').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 20);
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 20');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 3 页');
await page.getByTestId('vocab-page-jump').fill('3');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 20
    && document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 3 / 3 页');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 3 / 3 页');
await shot('mastered-page3-jump');
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-50').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 50);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页',
    'a page-size change restarts at page 1');
await page.getByTestId('vocab-page-2').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 10);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 2 / 2 页');
await shot('mastered-page2');
await page.getByTestId('vocab-page-prev').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 50);

// ── B3) P0-16 export: word / definition / level, current sort, all 60 rows ─
// 已掌握 is client paged; the export must include both pages, follow the
// current sort, keep missing definitions empty, and name the file after the list.
assert.equal(await page.getByTestId('vocab-mastered-export-tsv').isVisible(), true,
    '已掌握 toolbar has the TSV export');
assert.equal(await page.getByTestId('vocab-mastered-export-csv').isVisible(), true,
    '已掌握 toolbar has the CSV export');
const masteredCsv = await grabDownload(page.getByTestId('vocab-mastered-export-csv'));
assert.equal(masteredCsv.hasBom, true, 'the export carries a UTF-8 BOM');
assert.equal(masteredCsv.filename, `lingua-nova-mastered-${stamp()}.csv`);
const masteredCsvLines = masteredCsv.text.split('\n');
assert.equal(masteredCsvLines[0], '"单词","释义","等级"', 'CSV columns: word / definition / level');
assert.equal(masteredCsvLines.length, 61, 'CSV = header + all 60 mastered rows (both client pages)');
assert.equal(masteredCsvLines[1], '"abundant","丰富的；充裕的","B2"',
    'the export follows the current 加入时间 sort');
const meticulousLine = masteredCsvLines.find((line) => line.startsWith('"meticulous"'));
assert.equal(meticulousLine, '"meticulous","","C1+"',
    'a missing definition exports as an empty cell, level is the badge value');
const masteredTsv = await grabDownload(page.getByTestId('vocab-mastered-export-tsv'));
assert.equal(masteredTsv.filename, `lingua-nova-mastered-${stamp()}.tsv`);
const masteredTsvLines = masteredTsv.text.split('\n');
assert.equal(masteredTsvLines.length, 60, 'TSV is headerless and holds all 60 rows');
assert.equal(masteredTsvLines[0], 'abundant\t丰富的；充裕的\tB2',
    'TSV columns: word / definition / level, current sort first');
await page.screenshot({ path: `${SHOTS}/p0-16-1440-mastered-export.png`, fullPage: false });

// ── C) hide-Chinese removes the shared meaning column ────────────────────
await page.getByTestId('vocab-hide-toggle').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-translation-"]').length === 0);
assert.match(await page.getByTestId('vocab-mastered-panel').innerText(), /点击任意一行可临时查看释义/);
await shot('mastered-hide-chinese');
await page.getByTestId('vocab-hide-toggle').click(); // switch Chinese back on
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-translation-"]').length === 50);

// ── E) undo: the pressed row check, optimistic removal, NO favorite refill ─
// The row is not expanded: the check is a default-row control (P0-10).
const undoAction = page.getByTestId('vocab-mastered-master-toggle-abundant');
assert.equal(await undoAction.getAttribute('aria-pressed'), 'true');
assert.equal(await undoAction.getAttribute('aria-label'), '取消已掌握 abundant');
const undoIndicator = page.getByTestId('vocab-mastered-master-toggle-abundant-indicator');
assert.equal(await undoIndicator.locator('svg').count(), 1,
    'the pressed toggle keeps its check inside the circle');
assert.equal(await undoAction.locator(':scope > svg').count(), 0,
    'the undo control never renders a naked check icon');
await undoAction.click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="abundant"]'));
assert.deepEqual(state.patches.at(-1), { lemma: 'abundant', mastered: false },
    `PATCH body: ${JSON.stringify(state.patches.at(-1))}`);
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 59 词');
// Undo only clears `word_states.mastered` (specs/005 §已掌握与收藏互斥). It
// must not refill the favorite: 我的收藏 still holds exactly `luminous` and its
// count stays 1 — the undone word does not come back.
assert.deepEqual(state.favoriteWrites, [], 'undoing mastered must not POST a favorite');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 1 词',
    'undoing mastered must not change the favorites count');
assert.equal(await page.getByTestId('vocab-mine-word-fav-luminous').count(), 1);
assert.equal(await page.getByTestId('vocab-mine-word-fav-abundant').count(), 0,
    'the undone word must not return to 我的收藏');
await shot('mastered-undone-stays-out-of-mine');

// ── E2) P0-14 edit mode: 取消已掌握 in a batch ──────────────────────────
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]').count(), 0,
    'the default 已掌握 state renders no checkbox');
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0);
await page.getByTestId('vocab-mastered-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal((await page.getByTestId('vocab-mastered-edit').innerText()).trim(), '完成',
    'the toolbar button flips to 完成 while editing');
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]').count(), 50,
    'one checkbox per visible row (50/page)');
assert.equal(await page.getByTestId('vocab-mastered-master-toggle-meticulous').isDisabled(), true,
    'the row check is disabled while editing');
// Row click toggles the selection; the row does not expand.
await page.locator('[data-testid="vocab-mastered-row"][data-word="meticulous"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 1');
assert.equal(await page.locator('[data-testid="vocab-mastered-detail-meticulous"]').count(), 0,
    'editing disables row expansion');
await page.locator('[data-testid="vocab-mastered-row"][data-word="meticulous"]').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
// Batch 取消已掌握: PATCH mastered=false, the row leaves, the selection empties.
await page.getByTestId('vocab-mastered-select-meticulous').check();
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="meticulous"]'));
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
assert.deepEqual(state.patches.at(-1), { lemma: 'meticulous', mastered: false });
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 58 词');
// A failed row stays selected with its inline error + 「N 项失败」 summary.
state.failMastered = 'reluctant';
await page.getByTestId('vocab-mastered-select-reluctant').check();
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForSelector('[data-testid="vocab-mastered-edit-error-reluctant"]');
assert.equal(await page.locator('[data-testid="vocab-mastered-row"][data-word="reluctant"]').count(), 1,
    'the failed row is rolled back into the table');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 1');
assert.match(await page.getByTestId('vocab-edit-summary').innerText(), /1 项失败/);
state.failMastered = null;
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="reluctant"]'));
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 57 词');
await page.screenshot({ path: `${SHOTS}/p0-14-1440-mastered-edit.png` });
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]').count(), 0,
    '完成 exits edit mode and clears the selection');

// ── E3) P0-15 select-all across the two client-paged 已掌握 pages ─────────
// 57 remaining mastered rows → two 50/page pages; 全选 selects all 57, not the
// visible page. 已掌握 is client paged, so the selection is synchronous.
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-select-"]').length === 0);
await page.getByTestId('vocab-mastered-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
const masteredSelectAll = page.getByTestId('vocab-select-all-mastered');
assert.equal(await masteredSelectAll.count(), 1, 'editing renders the header select-all checkbox');
assert.equal(await masteredSelectAll.isChecked(), false, 'default: nothing selected');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0');
assert.equal((await page.getByTestId('vocab-edit-result-total').innerText()).trim(), '结果 57');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');

await masteredSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 57');
assert.equal(await masteredSelectAll.isChecked(), true);
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]:checked').count(), 50,
    'all 50 visible rows are checked after 全选');
await page.screenshot({ path: `${SHOTS}/p0-15-1440-mastered-select-all.png`, fullPage: false });

// The selection spans the client pages: page 2's 7 rows are checked too.
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 2 / 2 页');
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]:checked').count(), 7,
    'the second page reflects the cross-page selection');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 57');

// Partial selection → indeterminate; a second header activation selects all.
await page.getByTestId('vocab-mastered-select-word51').uncheck();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 56');
assert.equal(await masteredSelectAll.isChecked(), false);
assert.equal(await masteredSelectAll.evaluate((el) => el.indeterminate), true,
    'a partial selection renders the header indeterminate');
await masteredSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 57');
assert.equal(await masteredSelectAll.evaluate((el) => el.indeterminate), false);

// Fully selected + a second activation = clear; edit mode stays on.
await masteredSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');

// Cross-page batch: select one row on page 2, page back, select one on page 1,
// then 取消已掌握. Both rows run even though page 1 is the only rendered page.
await page.getByTestId('vocab-mastered-select-word51').check();
await page.getByTestId('vocab-page-jump').fill('1');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 1 / 2 页');
await page.getByTestId('vocab-mastered-select-word01').check();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 2');
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
const masteredBatchLeaves = state.patches.slice(-2).map((patch) => patch.lemma).sort();
assert.deepEqual(masteredBatchLeaves, ['word01', 'word51'],
    'the batch wrote both the rendered page-1 row and the unrendered page-2 row');
assert.ok(state.patches.slice(-2).every((patch) => patch.mastered === false));
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 55 词');
// The batch success toast sits over the sticky bar; dispatch the click
// directly so the DOM handler still runs (the toast is transient UI).
await page.getByTestId('vocab-edit-done').evaluate((el) => el.click());
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.getByTestId('vocab-select-all-mastered').count(), 0,
    'non-edit state renders no select-all checkbox at all');

// ── I) the built-in list still renders through the shared table ──────────
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
assert.equal(await page.getByTestId('vocab-list-row').count(), 3, 'GRE rows come from the shared WordTable');
assert.equal(await page.getByTestId('vocab-list-word').first().innerText(), 'abundant');
assert.equal(await page.getByTestId('vocab-list-translation').nth(1).innerText(), '轻快的');
assert.equal(await page.getByTestId('vocab-list-level').last().innerText(), '—');
// P0-10 §2/§4: the fixed list carries the check beside the star. abundant was
// unmastered in §E, so its row starts neutral; marking it (the check is the
// only mastery control) tints the row green and disables the star.
const listCheck = page.getByTestId('vocab-list-master-toggle-gre:abundant');
const listTone = () => page.locator('[data-testid="vocab-list-row"][data-word="abundant"]')
    .first().evaluate((el) => el.parentElement?.className ?? '');
assert.equal(await listCheck.getAttribute('aria-pressed'), 'false');
assert.doesNotMatch(await listTone(), /bg-(success|warning)\/10/, 'a neutral list row has no tint');
await listCheck.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-master-toggle-gre:abundant"]')?.getAttribute('aria-pressed') === 'true');
assert.deepEqual(state.patches.at(-1), { lemma: 'abundant', mastered: true });
assert.match(await listCheck.getAttribute('aria-label'), /取消已掌握 abundant/);
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').isDisabled(), true);
assert.match(await listTone(), /bg-success\/10/, 'a mastered fixed-list row is tinted success');
await shot('gre-list');
await listCheck.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-master-toggle-gre:abundant"]')?.getAttribute('aria-pressed') === 'false');
assert.doesNotMatch(await listTone(), /bg-(success|warning)\/10/, 'unmarking clears the tint');
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.getByTestId('vocab-list-translation').count(), 0, 'hide-Chinese still works on the list');
await page.locator('[data-testid="vocab-list-row"]').first().click();
assert.equal(await page.getByTestId('vocab-list-translation').count(), 1, 'tapping a list row reveals one translation');
await page.getByTestId('vocab-hide-toggle').click();

// ── F) first-load failure is an error panel with retry, never empty ──────
state.mastered = [...ALL_MASTERED];
state.masteredFail = true;
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="vocab-tabs"]');
// 我的收藏 opens first and reports the failed mastered read inline (stale data
// would otherwise be mislabelled as learning).
await page.waitForSelector('[data-testid="vocab-mastered-stale"]');
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-error"]');
assert.equal(await page.getByTestId('vocab-mastered-empty').count(), 0, 'a failed GET is not an empty state');
assert.equal(await page.getByTestId('vocab-mastered-list').count(), 0);
assert.equal(await page.getByTestId('vocab-tab-count-mastered').count(), 0, 'unknown mastered count is not rendered as 0');
// 我的收藏 is the favorites list: its count is always known (1) and never
// derived from the mastered set, so a failed mastered read cannot inflate it.
assert.equal(await page.getByTestId('vocab-tab-count-mine').innerText(), '1',
    'the 我的收藏 count is the favorites length, independent of the mastered read');
await shot('mastered-error');
state.masteredFail = false;
await page.getByTestId('vocab-mastered-retry').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.getByTestId('vocab-mastered-empty').count(), 0);
assert.equal(await page.getByTestId('vocab-mastered-row').count(), 50);

// A failed refresh after a success keeps the stale rows + inline retry (IX-01).
state.masteredFail = true;
await page.getByTestId('vocab-tab-mine').click();
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-stale"]');
assert.equal(await page.getByTestId('vocab-mastered-row').count(), 50, 'stale rows survive a failed refresh');
state.masteredFail = false;
await page.getByTestId('vocab-tab-mine').click();
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
await page.getByTestId('vocab-mastered-stale').waitFor({ state: 'detached' }).catch(() => {});
assert.equal(await page.getByTestId('vocab-mastered-stale').count(), 0, 'a successful refetch clears the stale warning');

// ── H) 375px: single column, no horizontal overflow ─────────────────────
await page.setViewportSize({ width: 375, height: 812 });
await page.waitForTimeout(200);
const overflow = await page.evaluate(() => {
    const doc = document.documentElement;
    const book = document.querySelector('[data-testid="vocabulary-book"]');
    return {
        docScroll: doc.scrollWidth - doc.clientWidth,
        bookScroll: book ? book.scrollWidth - book.clientWidth : 0,
        rows: document.querySelectorAll('[data-testid="vocab-mastered-row"]').length,
    };
});
assert.ok(overflow.docScroll <= 0, `375px horizontal overflow: ${overflow.docScroll}px`);
assert.ok(overflow.bookScroll <= 0, `375px word-book overflow: ${overflow.bookScroll}px`);
assert.ok(overflow.rows > 0);
await shot('mastered-375');
assert.equal(await page.getByTestId('vocab-mastered-export-tsv').isVisible(), true,
    'P0-16: the 已掌握 export stays reachable at 375');
await page.screenshot({ path: `${SHOTS}/p0-16-375-mastered-export.png`, fullPage: false });
// P0-14 at 375: 编辑 opens the checkbox column without horizontal overflow.
await page.getByTestId('vocab-mastered-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
await page.getByTestId('vocab-mastered-select-meticulous').check();
await page.screenshot({ path: `${SHOTS}/p0-14-375-mastered-edit.png`, fullPage: false });
const editOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
});
assert.ok(editOverflow <= 0, `375px overflow while editing 已掌握: ${editOverflow}px`);
// P0-15 at 375: the compact select-all selects every filtered mastered row
// (60 here, across the client pages) without overflowing.
await page.getByTestId('vocab-select-all-mastered-mobile').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 60');
assert.equal((await page.getByTestId('vocab-edit-result-total').innerText()).trim(), '结果 60');
assert.equal(await page.getByTestId('vocab-select-all-mastered-mobile').isChecked(), true);
await page.screenshot({ path: `${SHOTS}/p0-15-375-mastered-select-all.png`, fullPage: false });
const selectAllOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
});
assert.ok(selectAllOverflow <= 0, `375px overflow after select-all 已掌握: ${selectAllOverflow}px`);
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
await page.setViewportSize({ width: 1440, height: 1000 });

// ── G) guest: 「我会了」 tab fed only by the local table ──────────────────
const guestContext = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    reducedMotion: 'reduce',
});
await guestContext.addInitScript((key) => {
    if (!localStorage.getItem('yt_bilingual_ui_lang')) {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    }
    if (!localStorage.getItem('yt_bilingual_target_lang')) {
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    }
    localStorage.setItem(key, JSON.stringify(['abundant', 'meticulous']));
}, GUEST_KEY);
await guestContext.route('**/api/**', async (route) => {
    // Reuse the signed-in mock table but in guest mode.
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    const pathname = url.pathname;
    const respond = (data, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data),
    });
    if (pathname === '/api/auth/me') return respond({ user: null, guest: true });
    if (pathname === '/api/favorites' && request.method() === 'GET') return respond(FAVORITES);
    if (pathname === '/api/vocabulary/lists' && request.method() === 'GET') {
        const list = (id, label, count, extra = {}) => ({
            id, label, count, byLevel: {}, source: 'test', license: 'test',
            notice: null, approximate: false, available: true, version: '1', note: null, ...extra,
        });
        return respond([
            list('cefr', 'CEFR 词表', 5000, { byLevel: { A1: 1000 } }),
            list('gre', 'GRE', 3200), list('cet4', 'CET4', 2600),
            list('cet6', 'CET6', 1200), list('phrases', '短语', 570),
        ]);
    }
    if (pathname === '/api/vocabulary/level' && request.method() === 'GET') {
        const words = (url.searchParams.get('words') || '').split(',').filter(Boolean);
        return respond(Object.fromEntries(words.map((word) => [word, levelForWord(word)])));
    }
    if (pathname === '/api/review/words' && request.method() === 'GET') {
        state.guestMasteredFetches += 1;
        return respond({ detail: 'login required' }, 403);
    }
    if (pathname === '/api/wordlists' && request.method() === 'GET') return respond({ lists: [] });
    if (pathname === '/api/user/summary' || pathname === '/api/history' || pathname === '/api/subscriptions'
        || pathname === '/api/shows' || pathname === '/api/models' || pathname === '/api/recommendations'
        || pathname === '/api/content/difficulty/batch' || pathname === '/api/sentences/levels'
        || pathname === '/api/library/articles' || pathname === '/api/placement/profile'
        || pathname === '/api/ability/profile' || pathname === '/api/review/stats'
        || pathname === '/api/vocabulary/seen') {
        return respond(pathname === '/api/shows' ? { shows: [] } : pathname === '/api/models' ? { models: [], default: null } : []);
    }
    return respond({ detail: `unmocked ${pathname}` }, 404);
});
const guestPage = await guestContext.newPage();
await guestPage.goto(`${BASE}#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
await guestPage.waitForSelector('[data-testid="vocab-tabs"]');
const guestLabel = await guestPage.getByTestId('vocab-tab-mastered').innerText();
assert.equal(guestLabel.startsWith('我会了'), true, `guest tab label: ${guestLabel}`);
assert.equal(state.guestMasteredFetches, 0, 'guests must never request the server mastered list');
await guestPage.getByTestId('vocab-tab-mastered').click();
await guestPage.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await guestPage.getByTestId('vocab-mastered-row').count(), 2);
// Guest rows come from the local 「我会了」 table only: no favorite record
// enriches them (the fixture has none for these lemmas), so the lemma casing
// and the empty IPA / `—` meaning are the local-table defaults.
const guestAbundantWord = await guestPage.getByTestId('vocab-mastered-word-abundant').innerText();
assert.equal(guestAbundantWord, 'abundant', 'guest rows come from the local table, not favorites');
assert.equal((await guestPage.getByTestId('vocab-mastered-ipa-abundant').innerText()).trim(), '');
assert.equal(await guestPage.getByTestId('vocab-mastered-translation-abundant').innerText(), '—');
await guestPage.screenshot({ path: `${SHOTS}/mastered-tab-guest-1440.png` });
// P0-14: a guest may batch-undo the local 「我会了」 table (no login wall, no
// server PATCH): the batch runner's guest exception is only for this surface.
await guestPage.getByTestId('vocab-mastered-edit').click();
await guestPage.getByTestId('vocab-edit-bar').waitFor();
await guestPage.getByTestId('vocab-mastered-select-meticulous').check();
await guestPage.getByTestId('vocab-edit-unmaster').click();
await guestPage.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 1);
assert.equal(await guestPage.getByTestId('vocab-mastered-total').innerText(), '共 1 词');
await guestPage.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
assert.equal(await guestPage.getByTestId('guest-auth-overlay').count(), 0,
    'a guest local-table batch must not open the login overlay');
const guestTable = await guestPage.evaluate((key) => localStorage.getItem(key), GUEST_KEY);
assert.deepEqual(JSON.parse(guestTable), ['abundant'], `guest local table: ${guestTable}`);
await guestPage.getByTestId('vocab-edit-done').click();
await guestPage.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
await guestPage.screenshot({ path: `${SHOTS}/mastered-tab-guest-undo-1440.png` });
// The single-row check still works for the last guest word and leaves the
// success+empty state (not an error).
await guestPage.getByTestId('vocab-mastered-master-toggle-abundant').click();
await guestPage.waitForSelector('[data-testid="vocab-mastered-empty"]');
assert.equal(await guestPage.evaluate((key) => localStorage.getItem(key), GUEST_KEY), '[]');
assert.equal(await guestPage.getByTestId('vocab-mastered-list').count(), 0);
await guestPage.screenshot({ path: `${SHOTS}/mastered-tab-guest-empty-1440.png` });
// 我的收藏 still lists the guest learning row and the guest undo never refills
// the favorites.
await guestPage.getByTestId('vocab-tab-mine').click();
await guestPage.waitForSelector('[data-testid="vocab-mine-list"]');
await guestPage.getByTestId('vocab-mine-word-fav-luminous').waitFor({ timeout: 5000 });
assert.equal(await guestPage.getByTestId('vocab-mine-total').innerText(), '共 1 词',
    'guest 我会了 undo does not refill 我的收藏');
assert.equal(await guestPage.getByTestId('vocab-mine-word-fav-abundant').count(), 0);

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);

await guestContext.close();
await context.close();
await browser.close();

console.log('mastered-tab acceptance: PASS');
console.log(`  checks passed: ${assertionsPassed}`);
console.log(`signed-in: tabs=${tabOrder.length} masteredFetches=${state.masteredFetches} levelCalls=${state.levelCalls.length} patches=${JSON.stringify(state.patches)} favoriteWrites=${state.favoriteWrites.length} guestServerFetches=${state.guestMasteredFetches}`);
