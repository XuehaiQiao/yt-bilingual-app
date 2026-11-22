// Playwright acceptance for the word book v1.2 daily-use layer, updated for
// the unified word-list UI (commit 381440f, specs/005 §统一词表 UI).
//
// The UI now has ONE table/toolbar/pager for all five surfaces, so this script
// asserts the shared contract instead of the old per-surface controls:
//   - 我的单词 search (200ms debounce), menu-driven 排序 (menuitemradio) and
//     筛选 (multi-select groups, keepOpen + 清除筛选), client paging with the
//     每页 20/50/100 selector and the 跳至 input;
//   - the shared row: 原词 / 音标 / 释义 / 发音 / CEFR / 星标 / 展开, with ×N
//     only in 我的单词; row actions live inside the expanded area;
//   - star = favorite toggle (POST /api/favorites on a list row, DELETE when
//     unstarring); inline retryable errors on add/delete/mastered failures;
//   - 已掌握 rows, undo via the expanded action, star re-adds a favorite;
//   - built-in list / phrase 加入我的单词 + 加入复习 stays hidden (review UI
//     paused), phrase filters, guest login gate at the write entry.
//
// REMOVED SURFACES (kept out of this script on purpose): the old 状态 chips and
// the multi-select bulk bar (标为已掌握 / 删除 / 加入复习). specs/013 paused the
// review UI, and 381440f replaced bulk selection with per-row expanded actions
// plus 勾选删除 in the custom-wordlist edit mode only (covered by
// custom-wordlists-acceptance.mjs). Nothing here weakens an assertion: every
// removed control is asserted ABSENT instead, and no review POST/state read may
// fire.
//
// Every /api/** request is mocked; nothing touches :8000 or :5173.
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node wordbook-v12-acceptance.mjs
// Shots: /tmp/wb-ux-*.png
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

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const SHOTS = '/tmp';

// ── fixtures ────────────────────────────────────────────────────────────────
const MINE = Array.from({ length: 70 }, (_, i) => `w${String(i).padStart(3, '0')}`);
const MASTERED = MINE.slice(60); // w060…w069
const WORD_STATE = {};
MINE.slice(0, 10).forEach((word) => { WORD_STATE[word] = 'new'; });

const T0 = 1763000000000;
let favorites = MINE.map((word, i) => ({
    id: `fav-${word}`,
    type: 'vocabulary',
    en_text: word,
    zh_text: `/ˈtest${i}/ 释义${i}`,
    added_at: T0 + i * 1000,
    videoId: 'vid-fixture',
    start: i,
    source_kind: 'video',
    source_ref: 'vid-fixture',
    source_title: 'Fixture Video',
}));

const GRE_ITEMS = [
    { word: 'abundant', phonetic: '/əˈbʌndənt/', translation: '丰富的；充裕的', cefrLevel: 'B2' },
    { word: 'brisk', phonetic: '/brɪsk/', translation: '轻快的', cefrLevel: 'B1' },
    { word: 'candid', phonetic: '', translation: '', cefrLevel: '' },
];
const PHRASES = [
    { id: 'p1', headword: 'give up', type: 'phrasal_verb', cefr: 'A2', translation: '放弃', example: 'Never give up.', source: 'curated' },
    { id: 'p2', headword: 'on the fence', type: 'idiom', cefr: 'B1', translation: '犹豫不决', example: 'He is on the fence.', source: 'curated' },
];

const state = {
    mode: 'signedIn', // 'signedIn' | 'guest'
    mastered: [...MASTERED],
    /** Lemma whose POST /api/favorites fails (inline retryable error). */
    failFavoritePost: null,
    /** Favorite id whose DELETE fails. */
    failDelete: null,
    /** Lemma whose PATCH mastered=true fails. */
    failMastered: null,
    /** 404/403 for the mastered list (kept from the old chips scenario). */
    stateFail: 0,
    favoritePosts: [],
    reviewPosts: [],
    patches: [],
    deletes: [],
    stateRequests: [],
    unmocked: [],
};

const publicWord = (lemma, extra = {}) => ({
    id: `w-${lemma}`,
    lemma,
    targetLang: 'zh-CN',
    state: WORD_STATE[lemma] || 'new',
    dueAt: Date.now(),
    stability: null,
    difficulty: null,
    reps: 0,
    lapses: 0,
    failStreak: 0,
    lastReviewedAt: null,
    createdAt: T0,
    mastered: state.mastered.includes(lemma),
    sources: [],
    ...extra,
});

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
    if (!localStorage.getItem('yt_bilingual_ui_lang')) localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    if (!localStorage.getItem('yt_bilingual_target_lang')) localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    // Spy on TTS: the row button must speak locally (no AI request).
    window.__spoken = [];
    try {
        const synth = window.speechSynthesis;
        if (synth) {
            synth.speak = (utterance) => { window.__spoken.push(utterance?.text ?? ''); };
            synth.cancel = () => {};
        }
    } catch { /* ignore */ }
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
            ? respond({ user: { id: 'u-wb', email: 'wb@example.com', username: 'Reader' }, isAdmin: false, guest: false })
            : respond({ user: null, guest: true });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-wb', email: 'wb@example.com', username: 'Reader', credits: 12, memberSince: T0 },
            monthSpendUsd: 0.12,
            usageToday: { minutes: 8 },
            version: 'test',
            preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
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
    if (pathname === '/api/events' && method === 'POST') return respond({ status: 'ok' });
    if (pathname === '/api/auth/registration' && method === 'GET') {
        return respond({ registrationClosed: false, inviteRequired: false, mode: 'open' });
    }
    if (pathname === '/api/ability/profile') return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });

    // ── favorites: star toggles + 加入我的单词 ──────────────────────────────
    if (pathname === '/api/favorites' && method === 'GET') {
        return respond(state.mode === 'signedIn' ? favorites : []);
    }
    if (pathname === '/api/favorites' && method === 'POST') {
        const body = request.postDataJSON() || {};
        state.favoritePosts.push(body);
        const word = String(body.text ?? '');
        if (state.failFavoritePost && word === state.failFavoritePost) {
            return fail(500, 'favorites write failed');
        }
        const stored = {
            id: body.id || `fav-${word}`,
            type: 'vocabulary',
            en_text: word,
            zh_text: String(body.translation ?? ''),
            added_at: Number(body.addedAt ?? Date.now()),
            videoId: String(body.videoId ?? ''),
            start: Number(body.time ?? 0),
            ...(body.meta || {}),
        };
        if (!favorites.some((fav) => fav.id === stored.id)) favorites = [stored, ...favorites];
        return respond({ status: 'ok', created: true, favorite: stored }, 201);
    }
    if (pathname.startsWith('/api/favorites/') && method === 'DELETE') {
        const id = decodeURIComponent(pathname.replace('/api/favorites/', ''));
        state.deletes.push(id);
        if (state.failDelete && id === state.failDelete) return fail(500, 'delete failed');
        favorites = favorites.filter((fav) => fav.id !== id);
        return respond({ status: 'ok', deleted: true, id });
    }

    // ── review words: mastered list (never the 状态 filter while paused) ───
    if (pathname === '/api/review/words' && method === 'GET') {
        if (state.mode === 'guest') return fail(403, 'login required');
        const masteredParam = url.searchParams.get('mastered');
        const stateParam = url.searchParams.get('state');
        if (masteredParam === '1') {
            const words = state.mastered.map((lemma) => publicWord(lemma, { mastered: true }));
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
        }
        if (stateParam) {
            // The paused review UI must never send this read.
            state.stateRequests.push(stateParam);
            if (state.stateFail) return fail(state.stateFail, 'state filter unavailable');
        }
        return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
    }
    if (pathname === '/api/review/words' && method === 'POST') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').trim();
        state.reviewPosts.push({ lemma, source: body.source ?? null });
        return respond({ status: 'ok', created: true, word: publicWord(lemma) });
    }
    if (pathname === '/api/review/words' && method === 'PATCH') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').trim();
        state.patches.push({ lemma, mastered: body.mastered });
        if (state.failMastered && lemma === state.failMastered) return fail(500, 'mastered write failed');
        if (body.mastered === true) state.mastered = [...new Set([...state.mastered, lemma])];
        else state.mastered = state.mastered.filter((word) => word !== lemma);
        return respond({ status: 'ok', word: publicWord(lemma, { mastered: body.mastered === true }) });
    }

    // ── vocabulary catalog / lists / phrases / level / seen ─────────────
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
        const items = listPage[1] === 'gre' ? GRE_ITEMS : [];
        return respond({
            items,
            total: items.length,
            page: Number(url.searchParams.get('page') || 1),
            pageSize: Number(url.searchParams.get('pageSize') || 50),
            hasMore: false,
        });
    }
    if (pathname === '/api/vocabulary/phrases' && method === 'GET') {
        const level = url.searchParams.get('level');
        const type = url.searchParams.get('type');
        const q = (url.searchParams.get('q') || '').trim().toLowerCase();
        const items = PHRASES.filter((phrase) => (
            (!level || phrase.cefr === level)
            && (!type || phrase.type === type)
            && (!q || phrase.headword.toLowerCase().includes(q) || phrase.translation.includes(q))
        ));
        return respond({ items, total: items.length, page: 1, pageSize: 50, hasMore: false });
    }
    if (pathname.startsWith('/api/vocabulary/phrases/') && method === 'GET') {
        const id = pathname.split('/').pop();
        const item = PHRASES.find((phrase) => phrase.id === id) || PHRASES[0];
        return respond({ ...item, license: 'test', notes: '用法笔记' });
    }
    if (pathname === '/api/vocabulary/level' && method === 'GET') {
        const words = (url.searchParams.get('words') || '').split(',').filter(Boolean);
        return respond(Object.fromEntries(words.map((word) => [word, word.startsWith('w0') ? 'A1' : 'B2'])));
    }
    if (pathname === '/api/vocabulary/seen' && method === 'GET') return respond({});

    if (pathname === '/api/wordlists' && method === 'GET') return respond({ lists: [] });

    state.unmocked.push(`${method} ${pathname}`);
    return fail(404, `unmocked ${method} ${pathname}`);
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const shot = async (name) => {
    await page.screenshot({ path: `${SHOTS}/wb-ux-${name}.png`, fullPage: false });
};
const spoken = async () => page.evaluate(() => window.__spoken ?? []);
const waitFor = async (fn, timeout = 15000, label = 'condition') => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        if (await fn()) return;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`timeout waiting for ${label}`);
};
const rowCount = (prefix) => page.locator(`[data-testid^="${prefix}"]`).count();

async function gotoWordbook() {
    await page.goto(`${BASE}#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
    // A hash-only goto is same-document; force a real mount so per-mount reads
    // (mastered list) run again for the current mock state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vocabulary-book"]', { timeout: 20000 });
    await page.getByTestId('vocab-tabs').waitFor({ timeout: 20000 });
}

/** Open one Menu trigger and wait for its popup (menu testid is optional). */
async function openMenu(triggerTestId, menuTestId) {
    await page.getByTestId(triggerTestId).click();
    if (menuTestId) await page.getByTestId(menuTestId).waitFor({ state: 'visible', timeout: 5000 });
    else await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
}

/** Choose one menu item; menus without keepOpen close themselves. */
async function pickMenuItem(testId, { staysOpen = false } = {}) {
    await page.getByTestId(testId).click();
    if (!staysOpen) {
        await page.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    }
}

async function closeMenu() {
    await page.keyboard.press('Escape');
    await page.locator('[role="menu"]').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
}

const firstWord = async (prefix = 'vocab-mine-word-') => (
    await page.locator(`[data-testid^="${prefix}"]`).first().innerText()
).trim();

// ═══ A) 我的单词: search, 排序菜单, 筛选菜单, 每页条数 + 跳页 ═══════════════
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length > 0);

let rows = await rowCount('vocab-mine-toggle-');
assert.equal(rows, 50, `我的单词 page 1 must show 50 rows, saw ${rows}`);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 60 词');
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 60 词');
assert.equal(await page.getByTestId('vocab-tab-count-mine').innerText(), '60');
await shot('1440-mine');

// 状态 chips stay gone (REVIEW_UI_ENABLED=false): the group and every read are
// asserted absent, so a paused review surface can never leak back in.
assert.equal(await page.getByTestId('vocab-state-filter').count(), 0,
    'the 状态 filter group must be hidden while the review UI is paused');
for (const id of ['vocab-state-all', 'vocab-state-new', 'vocab-state-learning', 'vocab-state-review', 'vocab-state-suspended']) {
    assert.equal(await page.getByTestId(id).count(), 0, `state chip ${id} must be hidden`);
}
assert.deepEqual(state.stateRequests, [], 'the screen must not call GET /api/review/words?state=');

// Shared row structure: 原词 / 音标 / 释义 / 发音 / 等级 / 星标 / ×N / 展开.
const firstId = 'fav-w059';
for (const suffix of ['word', 'ipa', 'meaning', 'speak', 'level', 'star', 'seen', 'expand']) {
    assert.equal(await page.getByTestId(`vocab-mine-${suffix}-${firstId}`).count(), 1,
        `我的单词 row needs the ${suffix} control`);
}
assert.equal((await page.getByTestId(`vocab-mine-word-${firstId}`).innerText()).trim(), 'w059');
assert.equal((await page.getByTestId(`vocab-mine-ipa-${firstId}`).innerText()).trim(), '/ˈtest59/');
assert.equal((await page.getByTestId(`vocab-mine-meaning-${firstId}`).innerText()).trim(), '释义59');
assert.equal((await page.getByTestId(`vocab-mine-seen-${firstId}`).innerText()).trim(), '×0');
assert.equal(await page.getByTestId(`vocab-mine-star-${firstId}`).getAttribute('aria-pressed'), 'true');
assert.equal(await page.getByTestId(`vocab-mine-expand-${firstId}`).evaluate((el) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') ?? null), 'false');

// 行内发音: local speech synthesis, no AI request.
await page.getByTestId(`vocab-mine-speak-${firstId}`).click();
await page.waitForFunction(() => (window.__spoken || []).length > 0);
assert.equal((await spoken()).at(-1), 'w059', 'the row speaker speaks the English word');
assert.equal(await page.getByTestId(`vocab-mine-speak-${firstId}`).locator('svg').count(), 1,
    'the ghost icon recipe renders one Volume2 icon');

// Search (200ms debounce) + clear + empty state.
await page.getByTestId('vocab-mine-search').fill('w00');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 10);
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '找到 10 词');
await shot('1440-mine-search');
await page.getByTestId('vocab-mine-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);
await page.getByTestId('vocab-mine-search').fill('zzzz-nothing');
await page.waitForSelector('[data-testid="vocab-mine-filtered-empty"]');
await shot('1440-mine-search-empty');
await page.getByTestId('vocab-mine-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);

// 排序 is a menu now: trigger → menuitemradio → the label follows the choice.
await openMenu('vocab-mine-sort', 'vocab-mine-sort-menu');
assert.equal(await page.locator('[role="menuitemradio"]').count(), 4, 'sort menu has four radio options');
assert.equal(await page.getByTestId('vocab-sort-added').getAttribute('aria-checked'), 'true');
await pickMenuItem('vocab-sort-alpha');
await page.waitForFunction(() => {
    const first = document.querySelector('[data-testid^="vocab-mine-word-"]');
    return first && first.textContent.trim() === 'w000';
});
assert.match(await page.getByTestId('vocab-mine-sort').innerText(), /字母 A→Z/);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页',
    'a sort change returns to page 1');

// 筛选 is a menu with grouped multi-select options; 清除筛选 lives in the menu
// and in the toolbar while a filter is active.
await openMenu('vocab-mine-filter', 'vocab-mine-filter-menu');
const filterMenuText = await page.getByTestId('vocab-mine-filter-menu').innerText();
for (const heading of ['类型', '来源', '等级']) {
    assert.match(filterMenuText, new RegExp(heading), `filter menu needs the ${heading} section`);
}
await page.getByTestId('vocab-filter-type-phrase').click(); // keepOpen
assert.equal(await page.getByTestId('vocab-filter-type-phrase').getAttribute('aria-checked'), 'true');
assert.match(await page.getByTestId('vocab-mine-filter').innerText(), /筛选：短语/);
assert.equal(await page.getByTestId('vocab-mine-filtered-empty').count(), 1, 'no phrase favorite → filtered empty');
assert.equal(await page.getByTestId('vocab-mine-clear-filters').count(), 1, 'active filter exposes 清除筛选');
await shot('1440-mine-filtered-empty');
await pickMenuItem('vocab-mine-clear-filters-menu');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);
assert.equal(await page.getByTestId('vocab-mine-clear-filters').count(), 0);

// 每页 20/50/100 + 跳至 input. A size change resets every list to page 1.
await openMenu('vocab-page-size', 'vocab-page-size-menu');
assert.equal(await page.locator('[role="menuitemradio"]').count(), 3, 'pager offers 20 / 50 / 100');
await pickMenuItem('vocab-page-size-20');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 20);
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 20');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 3 页');
await page.getByTestId('vocab-page-jump').fill('2');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 2 / 3 页');
assert.equal(await firstWord(), 'w020', 'jump to page 2 shows the second 20-word slice');
await shot('1440-mine-page-size-jump');

// A filter/search change always restarts at page 1.
await page.getByTestId('vocab-mine-search').fill('w00');
await page.waitForFunction(() => {
    const node = document.querySelector('[data-testid="vocab-page-status"]');
    return node && node.textContent.includes('第 1 / 1 页');
});
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 1 页',
    'a filter change must return to page 1');
await page.getByTestId('vocab-mine-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 20);
await openMenu('vocab-page-size', 'vocab-page-size-menu');
await pickMenuItem('vocab-page-size-50');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);

// ═══ B) 我的单词 row actions: expand → master / delete / star ════════════
await openMenu('vocab-mine-sort', 'vocab-mine-sort-menu');
await pickMenuItem('vocab-sort-alpha');
await page.waitForFunction(() => {
    const first = document.querySelector('[data-testid^="vocab-mine-word-"]');
    return first && first.textContent.trim() === 'w000';
});
await page.getByTestId('vocab-mine-expand-fav-w000').click();
await page.waitForSelector('[data-testid="vocab-mine-detail-fav-w000"]');
assert.equal((await page.getByTestId('vocab-mine-full-fav-w000').innerText()).trim(), '释义0');
assert.equal(await page.getByTestId('vocab-mine-source-fav-w000').count(), 1);
assert.equal(await page.getByTestId('vocab-mine-added-fav-w000').count(), 1);
assert.equal(await page.getByTestId('vocab-mine-expand-fav-w000').evaluate((el) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') ?? null), 'true');
await shot('1440-mine-expanded');

// 标为已掌握: row action PATCHes and the row moves to 已掌握.
await page.getByTestId('vocab-mine-master-fav-w000').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w000"]').length === 0);
await waitFor(() => state.patches.some((item) => item.lemma === 'w000' && item.mastered === true), 15000, 'master PATCH');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 59 词');
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 59 词');
await shot('1440-mine-mastered');

// Undo from 已掌握: expand the row, 撤销 PATCHes mastered=false and the word
// comes back to 我的单词.
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
await page.getByTestId('vocab-mastered-expand-w000').click();
await page.waitForSelector('[data-testid="vocab-mastered-detail-w000"]');
await page.getByTestId('vocab-mastered-undo-w000').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="w000"]'));
assert.deepEqual(state.patches.at(-1), { lemma: 'w000', mastered: false });
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
// 撤销已掌握 does NOT bring the word back to 我的单词: mastering removed the
// favorite, and specs/005 §已掌握与收藏互斥 keeps it un-favorited.
await openMenu('vocab-mine-sort', 'vocab-mine-sort-menu');
await pickMenuItem('vocab-sort-alpha');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 59 词',
    'the unmastered word stays out of 我的单词 (no favorite restore)');
assert.equal(await page.getByTestId('vocab-mine-word-fav-w000').count(), 0,
    'w000 must not reappear in 我的单词');

// 星标 = 取消收藏 on 我的单词: DELETE + the row leaves the list.
await page.getByTestId('vocab-mine-star-fav-w010').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w010"]').length === 0);
await waitFor(() => state.deletes.includes('fav-w010'), 15000, 'favorite DELETE');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 58 词');

// 删除 one row from the expanded area (no bulk bar any more).
await page.getByTestId('vocab-mine-expand-fav-w011').click();
await page.getByTestId('vocab-mine-delete-fav-w011').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w011"]').length === 0);
await waitFor(() => state.deletes.includes('fav-w011'), 15000, 'row DELETE');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 57 词');

// Row-level failures stay retryable (never a fake success).
state.failMastered = 'w012';
await page.getByTestId('vocab-mine-expand-fav-w012').click();
await page.getByTestId('vocab-mine-master-fav-w012').click();
await page.waitForSelector('[data-testid="vocab-mine-error-fav-w012"]');
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w012').count(), 1, 'a failed master keeps the row');
await shot('1440-mine-master-failed');
state.failMastered = null;
await page.getByTestId('vocab-mine-master-fav-w012').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w012"]').length === 0);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-error-fav-w012"]').length === 0);

state.failDelete = 'fav-w013';
await page.getByTestId('vocab-mine-expand-fav-w013').click();
await page.getByTestId('vocab-mine-delete-fav-w013').click();
await page.waitForSelector('[data-testid="vocab-mine-error-fav-w013"]');
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w013').count(), 1, 'a failed delete keeps the row');
await shot('1440-mine-delete-failed');
state.failDelete = null;
await page.getByTestId('vocab-mine-delete-fav-w013').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w013"]').length === 0);

// The removed bulk bar is asserted ABSENT (selection now lives only in the
// custom-wordlist edit mode) and no review write may fire from 我的单词.
for (const id of ['vocab-mine-select-fav-w000', 'vocab-mine-selected', 'vocab-mine-bulk-master', 'vocab-mine-bulk-delete', 'vocab-mine-bulk-review']) {
    assert.equal(await page.getByTestId(id).count(), 0, `removed bulk control ${id} must not render`);
}
assert.deepEqual(state.reviewPosts, [], '我的单词 must never POST a review word');

// ═══ C) 已掌握: shared row structure + star + search ═════════════════════
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.getByTestId('vocab-mastered-row').count(), 11,
    'ten fixture words plus w012 mastered above');
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '共 11 词');
assert.equal(await page.getByTestId('vocab-tab-count-mastered').innerText(), '11');
const masteredFirst = page.locator('[data-testid="vocab-mastered-row"]').first();
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-word-/).count(), 1);
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-ipa-/).count(), 1);
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-translation-/).count(), 1);
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-level-/).count(), 1);
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-star-/).count(), 1);
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-expand-/).count(), 1);
assert.equal(await page.locator('[data-testid^="vocab-mastered-seen-"]').count(), 0,
    '已掌握 rows have no ×N column');
const headerText = await page.getByTestId('vocab-mastered-header').innerText();
for (const label of ['单词', '音标', '中文释义', 'CEFR']) {
    assert.match(headerText, new RegExp(label), `mastered header needs ${label}`);
}
assert.doesNotMatch(headerText, /次数/, '已掌握 header must not render the ×N column');
await shot('1440-mastered');

// 已掌握 star is disabled: mastered is not a favorite (specs/005 §互斥).
const masteredStar = page.getByTestId('vocab-mastered-star-w061');
assert.equal(await masteredStar.isDisabled(), true, 'mastered star must be disabled');
assert.match((await masteredStar.getAttribute('aria-label')) ?? '', /已掌握/, 'mastered star explains why');
const masteredDeletesBefore = state.deletes.length;
const masteredPostsBefore = state.favoritePosts.length;
await masteredStar.click({ force: true }).catch(() => {});
await page.waitForTimeout(250);
assert.equal(state.deletes.length, masteredDeletesBefore, 'mastered star must not DELETE a favorite');
assert.equal(state.favoritePosts.length, masteredPostsBefore, 'mastered star must not POST a favorite');
assert.equal(await page.getByTestId('vocab-mastered-row').count(), 11, 'row stays mastered');

// 搜索 + 排序菜单 on 已掌握.
await page.getByTestId('vocab-mastered-search').fill('w069');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 1);
assert.equal(await page.getByTestId('vocab-mastered-total').innerText(), '找到 1 词');
await page.getByTestId('vocab-mastered-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-row"]').length === 11);
await openMenu('vocab-mastered-sort', 'vocab-mastered-sort-menu');
assert.equal(await page.locator('[role="menuitemradio"]').count(), 2);
await pickMenuItem('vocab-mastered-sort-level');
assert.match(await page.getByTestId('vocab-mastered-sort').innerText(), /难度/);
await openMenu('vocab-mastered-sort', 'vocab-mastered-sort-menu');
await pickMenuItem('vocab-mastered-sort-alpha');

// 隐藏中文 hides the meaning cells (shared WordTable behaviour); 已掌握 rows
// have no per-row reveal, so this section only asserts the hide/show toggle.
await page.getByTestId('vocab-hide-toggle').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-translation-"]').length === 0);
assert.match(await page.getByTestId('vocab-mastered-panel').innerText(), /点击任意一行可临时查看释义/);
await page.getByTestId('vocab-hide-toggle').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mastered-translation-"]').length === 11);

// ═══ D) 内置词表 (GRE): shared table + 加入我的单词 + star ══════════════
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
assert.equal(await page.getByTestId('vocab-list-row').count(), 3);
assert.equal(await page.getByTestId('vocab-total').first().innerText(), '共 3 词');
assert.equal(await page.getByTestId('vocab-list-word').first().innerText(), 'abundant');
assert.equal(await page.getByTestId('vocab-list-translation').nth(1).innerText(), '轻快的');
assert.equal(await page.getByTestId('vocab-list-level').last().innerText(), '—');
for (const suffix of ['word', 'ipa', 'translation', 'level']) {
    assert.equal(await page.getByTestId(`vocab-list-${suffix}`).count(), 3,
        `GRE rows need one ${suffix} cell each`);
}
assert.equal(await page.getByTestId('vocab-list-seen').count(), 0,
    'built-in lists must not render the ×N column');
await openMenu('vocab-level-filter', 'vocab-level-filter-menu');
assert.equal(await page.locator('[role="menuitemradio"]').count() >= 3, true);
await closeMenu();
await shot('1440-gre-list');

// 隐藏中文 + tap-to-reveal one row (shared WordTable contract).
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.getByTestId('vocab-list-translation').count(), 0,
    'hide-Chinese removes every translation cell');
await page.locator('[data-testid="vocab-list-row"]').first().click();
assert.equal(await page.getByTestId('vocab-list-translation').count(), 1,
    'tapping one list row reveals just that translation');
assert.equal(await page.getByTestId('vocab-list-translation').innerText(), '丰富的；充裕的');
await page.locator('[data-testid="vocab-list-row"]').first().click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-list-translation"]').length === 0);
await page.getByTestId('vocab-hide-toggle').click(); // Chinese back on

// 加入我的单词 sits in the expanded area (no per-row button any more).
await page.getByTestId('vocab-list-expand-gre:abundant').click();
await page.waitForSelector('[data-testid="gre:abundant-add-mine"]');
assert.equal(await page.getByTestId('gre:abundant-add-review').count(), 0,
    '加入复习 must be hidden on built-in list rows while the review UI is paused');
const postsBefore = state.favoritePosts.length;
await page.getByTestId('gre:abundant-add-mine').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="gre:abundant-add-mine"]');
    return button && button.textContent.includes('已加入');
});
assert.equal(state.favoritePosts.length, postsBefore + 1);
const minePost = state.favoritePosts.at(-1);
assert.equal(minePost.meta.source_kind, 'wordlist', `meta: ${JSON.stringify(minePost.meta)}`);
assert.equal(minePost.meta.source_ref, 'gre');
assert.equal(minePost.meta.source_title, 'GRE');
assert.equal(minePost.text, 'abundant');
assert.equal(minePost.translation, '/əˈbʌndənt/ 丰富的；充裕的');
assert.equal(await page.getByTestId('gre:abundant-add-mine').isDisabled(), true, '已加入 is idempotent (disabled)');
await page.getByTestId('gre:abundant-add-mine').click({ force: true }).catch(() => {});
assert.equal(state.favoritePosts.length, postsBefore + 1, 'the added row never re-posts');

// A failed add stays retryable and leaves an inline error, not a fake 已加入.
state.failFavoritePost = 'candid';
await page.getByTestId('vocab-list-expand-gre:candid').click();
await page.getByTestId('gre:candid-add-mine').click();
await page.waitForSelector('[data-testid="vocab-list-error-candid"]');
assert.equal(await page.getByTestId('gre:candid-add-mine').isDisabled(), false, 'a failed add stays retryable');
await shot('1440-gre-add-failed');
state.failFavoritePost = null;
await page.getByTestId('gre:candid-add-mine').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="gre:candid-add-mine"]');
    return button && button.textContent.includes('已加入');
});
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-list-error-candid"]').length === 0);

// Star toggles the favorite from a list row: POST then DELETE.
await page.getByTestId('vocab-list-star-gre:brisk').click();
await waitFor(() => state.favoritePosts.some((item) => item.text === 'brisk'), 15000, 'star POST');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-pressed'), 'true');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-label'), '取消收藏 brisk');
const briskPost = state.favoritePosts.find((item) => item.text === 'brisk');
assert.equal(briskPost.meta.source_kind, 'wordlist');
assert.equal(briskPost.meta.source_ref, 'gre');
await page.getByTestId('vocab-list-star-gre:brisk').click();
await waitFor(() => state.deletes.includes('vocab-fav-brisk'), 15000, 'star DELETE');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-pressed'), 'false');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-label'), '收藏 brisk');

// Speaker on a list row.
await page.getByTestId('gre:candid-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('candid'));

// 加入复习 stays hidden and nothing reaches the review API.
assert.equal(await page.getByTestId('gre:abundant-add-review').count(), 0);
assert.equal(await page.getByTestId('gre:brisk-add-review').count(), 0);
assert.deepEqual(state.reviewPosts, [], 'list rows must never POST a review word');

// ═══ E) 短语: filter menu + expanded 加入我的单词 + star ═════════════════
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
assert.equal(await page.getByTestId('phrase-row').count(), 2);
assert.equal(await page.getByTestId('phrase-total').innerText(), '共 2 条短语');
await shot('1440-phrases');

await openMenu('phrase-filter', 'phrase-filter-menu');
assert.equal(await page.getByTestId('phrase-level-all').getAttribute('aria-checked'), 'true');
await page.getByTestId('phrase-level-B1').click(); // keepOpen
await page.waitForFunction(() => document.querySelectorAll('[data-testid="phrase-row"]').length === 1);
assert.match(await page.getByTestId('phrase-filter').innerText(), /筛选：B1/);
await shot('1440-phrases-filtered');
await pickMenuItem('phrase-clear-filters-menu');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="phrase-row"]').length === 2);

// Phrase detail expands on row click (no hide-Chinese here) and carries the
// add-to-mine action; 加入复习 stays hidden while the review UI is paused.
await page.getByTestId('phrase-row').first().click();
await page.waitForSelector('[data-testid="phrase:p1-add-mine"]');
assert.equal(await page.getByTestId('phrase:p1-add-review').count(), 0,
    '加入复习 must be hidden on phrase rows');
assert.match(await page.getByTestId('phrase-example').innerText(), /Never give up/);
assert.equal(await page.getByTestId('phrase-source').count(), 1);
const phrasePostsBefore = state.favoritePosts.length;
await page.getByTestId('phrase:p1-add-mine').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="phrase:p1-add-mine"]');
    return button && button.textContent.includes('已加入');
});
const phrasePost = state.favoritePosts.at(-1);
assert.equal(state.favoritePosts.length, phrasePostsBefore + 1);
assert.equal(phrasePost.meta.source_kind, 'wordlist');
assert.equal(phrasePost.meta.source_ref, 'phrases');
assert.equal(phrasePost.text, 'give up');
await page.getByTestId('phrase:p1-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('give up'));
await page.getByTestId('phrase:p2-star').click();
await waitFor(() => state.favoritePosts.some((item) => item.text === 'on the fence'), 15000, 'phrase star POST');
assert.equal(await page.getByTestId('phrase:p2-star').getAttribute('aria-label'), '取消收藏 on the fence');
await shot('1440-phrases-added');

// ═══ F) 状态接口 403/404 → nothing to degrade while the chips are gone ═══
for (const status of [404, 403]) {
    state.stateFail = status;
    await gotoWordbook();
    await page.getByTestId('vocab-tab-mine').click();
    await page.waitForSelector('[data-testid="vocab-mine-list"]');
    await page.waitForTimeout(200);
    assert.equal(await page.getByTestId('vocab-state-filter').count(), 0,
        `HTTP ${status}: the paused 状态 group must stay hidden`);
}
state.stateFail = 0;
assert.deepEqual(state.stateRequests, [], 'no ?state= read may fire, even with a failing endpoint');

// ═══ G) 375px: no horizontal overflow, shared toolbar/pager reachable ════
await page.setViewportSize({ width: 375, height: 812 });
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length > 0);
assert.equal(await page.getByTestId('vocab-state-filter').count(), 0,
    'the paused 状态 group must stay hidden at 375 too');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 0, `375px horizontal overflow: ${overflow}px`);
assert.equal(await page.getByTestId('vocab-mine-sort').isVisible(), true, '排序 must stay reachable at 375');
assert.equal(await page.getByTestId('vocab-mine-filter').isVisible(), true, '筛选 must stay reachable at 375');
assert.equal(await page.getByTestId('vocab-page-size').isVisible(), true, '每页条数 must stay reachable at 375');
assert.equal(await page.getByTestId('vocab-page-jump').isVisible(), true, '跳页 must stay reachable at 375');
assert.equal(await page.getByTestId('vocab-mine-bulk-master').count(), 0, 'no bulk bar at 375 either');
await shot('375-mine');
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
await page.getByTestId('vocab-list-expand-gre:abundant').click();
assert.equal(await page.getByTestId('gre:abundant-add-mine').isVisible(), true, 'row action reachable at 375');
await shot('375-gre-list');
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
await shot('375-phrases');
await page.setViewportSize({ width: 1440, height: 1000 });

// ═══ H) 游客: no state chips, write entries go through the login gate ════
state.mode = 'guest';
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
await page.waitForTimeout(400);
assert.equal(await page.getByTestId('vocab-state-filter').count(), 0, 'guests never see the 状态 group');
const guestPostsBefore = state.favoritePosts.length;
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
await page.getByTestId('vocab-list-expand-gre:abundant').click();
await page.getByTestId('gre:abundant-add-mine').click();
await page.waitForSelector('[data-testid="guest-auth-overlay"]', { timeout: 10000 });
assert.equal(state.favoritePosts.length, guestPostsBefore, 'the guest gate must not POST a favorite');
await shot('1440-guest-gate');
state.mode = 'signedIn';

// ── cleanup ────────────────────────────────────────────────────────────────
assert.equal(state.reviewPosts.length, 0, 'the word book must never POST a review word');
assert.deepEqual(state.stateRequests, [], 'the 状态 read must never fire');
assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
assert.deepEqual(state.unmocked, [], `unmocked API calls: ${state.unmocked.join('\n')}`);
await browser.close();
console.log('PASS · wb-ux acceptance');
console.log(`  checks passed: ${assertionsPassed}`);
console.log('  state requests:', state.stateRequests.length);
console.log('  favorite posts:', state.favoritePosts.length, ' deletes:', state.deletes.length);
console.log('  review posts:', state.reviewPosts.length, '(review UI paused)');
console.log('  patches:', state.patches.length);
console.log('  screenshots: /tmp/wb-ux-*.png');
