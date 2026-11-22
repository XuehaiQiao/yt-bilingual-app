// Playwright acceptance for the word book v1.2 daily-use layer, updated for
// the unified word-list UI (commit 381440f, specs/005 §统一词表 UI).
//
// The UI now has ONE table/toolbar/pager for all five surfaces, so this script
// asserts the shared contract instead of the old per-surface controls:
//   - 我的收藏 search (200ms debounce), menu-driven 排序 (menuitemradio) and
//     筛选 (multi-select groups, keepOpen + 清除筛选), client paging with the
//     每页 20/50/100 selector and the 跳至 input;
//   - the shared row: 原词 / 音标 / 释义 / 发音 / CEFR / 星标 / 已掌握圆形勾选 / 展开,
//     with ×N only in 我的收藏; 已掌握 is the row circle toggle (P0-10/P0-12) on
//     every surface — the expanded area never carries a mastered text action;
//   - star = the ONE favorite toggle on every surface (POST /api/favorites on a
//     list/phrase row, DELETE when unstarring); the expanded area never carries
//     a save action — no 「加入我的单词」 and no 「已加入」 disabled variant, in
//     ANY favorite state — and no second 取消收藏 entry; failures roll back,
//     toast and never fake a saved row; rapid clicks stay idempotent;
//   - 我的收藏 = the favorites list itself (60 fixtures; count = length) and
//     已掌握 = `word_states.mastered=1` (10 disjoint fixtures) — ADR-0001, no
//     `favorites − mastered` subtraction anywhere;
//   - 已掌握 rows: undo via the row check, star disabled/never filled;
//   - fixed word lists tint their rows (mastered bg-success/10, favorited
//     bg-warning/10) while 我的收藏 / 已掌握 keep the plain surface;
//   - no 「加入我的单词」 on built-in list / phrase / 我的收藏 rows, favorited or
//     not (P0-09: the star is the only favorite switch; custom-list coverage
//     lives in custom-wordlists-acceptance.mjs); 加入复习 stays hidden (review
//     UI paused), phrase filters, guest login gate at the star write entry.
//
// REMOVED SURFACES (kept out of this script on purpose): the old 状态 chips, the
// expanded-area 加入我的单词 action (P0-09 — the star is the only favorite
// switch, in any favorite state), the expanded-area 取消收藏/删除 row action
// (P0-03) and, since P0-10, every expanded-area 我已掌握/已掌握 text action
// (the row check replaced it).
// P0-14 replaced the old always-on bulk bar with an explicit edit mode on every
// list: 编辑 reveals the checkbox column + the bottom bar, 完成/tab switch exits
// and clears the selection; §E2 covers the full operation matrix. Nothing here
// weakens an assertion: non-edit state is asserted to have no checkbox, and no
// review POST/state read may fire.
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
// 我的收藏 is the favorites list itself and 已掌握 is `word_states.mastered=1`
// (ADR-0001): two DISJOINT lists — 60 favorites (w000…w059) plus 10 mastered
// words (w060…w069) that are never favorites too. Every count below is the
// favorites length; no fixture overlaps, so a subtraction would be invisible
// and is deliberately not modelled.
const MINE = Array.from({ length: 60 }, (_, i) => `w${String(i).padStart(3, '0')}`);
const MASTERED = Array.from({ length: 10 }, (_, i) => `w${String(60 + i).padStart(3, '0')}`); // w060…w069
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

    // ── favorites: star toggles are the only favorite switch ───────────────
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
/** Class of the row container (the tested element is the inner grid row). */
const rowTone = (selector) => page.locator(selector).first()
    .evaluate((el) => el.parentElement?.className ?? '');

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
/** Wait for the edit bar's 已选 N label (batch writes settle asynchronously). */
const waitSelected = (expected) => page.waitForFunction((value) => (
    document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === value
), expected);

// ═══ A) 我的收藏: search, 排序菜单, 筛选菜单, 每页条数 + 跳页 ═══════════════
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length > 0);

let rows = await rowCount('vocab-mine-toggle-');
assert.equal(rows, 50, `我的收藏 page 1 must show 50 rows, saw ${rows}`);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 60 词');
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 60 词');
assert.equal(await page.getByTestId('vocab-tab-count-mine').innerText(), '60');
// P0-10 §3: the surface is called 我的收藏 (zh); the route/tab id stay `mine`.
assert.equal((await page.getByTestId('vocab-tab-mine').innerText()).startsWith('我的收藏'), true,
    'tab 显示名必须改为 我的收藏');
// 已掌握 is its own list (10 fixture words, none of them a favorite).
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-tab-count-mastered"]')?.textContent === '10');
assert.equal(await page.getByTestId('vocab-tab-count-mastered').innerText(), '10',
    '已掌握 count is the mastered list length, not a favorites intersection');
await shot('1440-mine');

// 状态 chips stay gone (REVIEW_UI_ENABLED=false): the group and every read are
// asserted absent, so a paused review surface can never leak back in.
assert.equal(await page.getByTestId('vocab-state-filter').count(), 0,
    'the 状态 filter group must be hidden while the review UI is paused');
for (const id of ['vocab-state-all', 'vocab-state-new', 'vocab-state-learning', 'vocab-state-review', 'vocab-state-suspended']) {
    assert.equal(await page.getByTestId(id).count(), 0, `state chip ${id} must be hidden`);
}
assert.deepEqual(state.stateRequests, [], 'the screen must not call GET /api/review/words?state=');

// Shared row structure: 原词 / 音标 / 释义 / 发音 / 等级 / 星标 / 对勾 / ×N / 展开.
const firstId = 'fav-w059';
for (const suffix of ['word', 'ipa', 'meaning', 'speak', 'level', 'star', 'seen', 'expand']) {
    assert.equal(await page.getByTestId(`vocab-mine-${suffix}-${firstId}`).count(), 1,
        `我的收藏 row needs the ${suffix} control`);
}
assert.equal((await page.getByTestId(`vocab-mine-word-${firstId}`).innerText()).trim(), 'w059');
assert.equal((await page.getByTestId(`vocab-mine-ipa-${firstId}`).innerText()).trim(), '/ˈtest59/');
assert.equal((await page.getByTestId(`vocab-mine-meaning-${firstId}`).innerText()).trim(), '释义59');
assert.equal((await page.getByTestId(`vocab-mine-seen-${firstId}`).innerText()).trim(), '×0');
assert.equal(await page.getByTestId(`vocab-mine-star-${firstId}`).getAttribute('aria-pressed'), 'true');
// P0-12: the 已掌握 control is a circle+check toggle, never a naked check.
// Unmastered = hollow neutral ring; the shared IconButton keeps the 44px
// coarse-pointer target, aria-pressed and the aria-label.
const mineCheck = page.getByTestId(`vocab-mine-master-toggle-${firstId}`);
assert.equal(await mineCheck.getAttribute('aria-pressed'), 'false');
assert.equal(await mineCheck.getAttribute('aria-label'), '已掌握 w059');
const mineIndicator = page.getByTestId(`vocab-mine-master-toggle-${firstId}-indicator`);
assert.equal(await mineIndicator.count(), 1, 'the toggle renders one circle indicator');
assert.equal(await mineIndicator.getAttribute('data-state'), 'unchecked');
assert.equal(await mineCheck.locator(':scope > svg').count(), 0,
    'no naked check icon sits outside the circle');
assert.equal(await mineIndicator.locator('svg').count(), 1,
    'the check glyph lives inside the circle');
const mineIndicatorClass = (await mineIndicator.getAttribute('class')) ?? '';
assert.match(mineIndicatorClass, /rounded-full/, 'the mastered toggle is a circle');
assert.match(mineIndicatorClass, /border-line-strong/, 'the unmastered circle uses the line token');
assert.match(mineIndicatorClass, /text-fg-muted/, 'the unmastered check stays neutral grey');
assert.doesNotMatch(mineIndicatorClass, /\bbg-success\b/, 'an unmastered circle has no success fill');
assert.match(mineIndicatorClass, /group-hover\/mastered:bg-state-hover/,
    'the unmastered circle has a hover affordance');
assert.match(mineIndicatorClass, /group-hover\/mastered:text-fg-strong/,
    'hover lifts the neutral check tone');
await page.screenshot({ path: `${SHOTS}/p0-12-1440-mine-unmastered.png` });
assert.doesNotMatch(await rowTone(`[data-testid="vocab-mine-toggle-${firstId}"]`), /bg-(success|warning)\/10/,
    '我的收藏 rows never get a state tint');
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

// ═══ B) 我的收藏 row controls: check / star / expand ═════════════════════
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
assert.equal(await page.locator('[data-testid$="-add-mine"]').count(), 0,
    '我的收藏 rows never render 加入我的单词 (any state)');
// P0-10 §1/§2: 已掌握 is the default-row check; the expanded area carries no
// text mastered action any more.
assert.equal(await page.getByTestId('vocab-mine-master-fav-w000').count(), 0,
    'the expanded area no longer renders a 我已掌握 text action');
assert.doesNotMatch(await page.getByTestId('vocab-mine-detail-fav-w000').innerText(),
    /我已掌握|取消已掌握|标为已掌握/,
    'the expanded area must not carry any text mastered action');
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-w000').count(), 1,
    'the default row carries the 已掌握 check');
assert.equal(await page.getByTestId('vocab-mine-expand-fav-w000').evaluate((el) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') ?? null), 'true');
await shot('1440-mine-expanded');
await page.screenshot({ path: `${SHOTS}/p0-10-1440-mine.png` });

// 标为已掌握 = the row check: PATCH; the row leaves 我的收藏 for 已掌握.
await page.getByTestId('vocab-mine-master-toggle-fav-w000').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w000"]').length === 0);
await waitFor(() => state.patches.some((item) => item.lemma === 'w000' && item.mastered === true), 15000, 'master PATCH');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 59 词');
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 59 词');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-tab-count-mastered"]')?.textContent === '11');
assert.equal(await page.getByTestId('vocab-tab-count-mastered').innerText(), '11',
    'marking mastered adds one to the independent 已掌握 list');
await shot('1440-mine-mastered');

// Undo from 已掌握: the pressed circle check PATCHes mastered=false and the
// word leaves the tab — the expanded area is not needed.
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
const masteredCheck = page.getByTestId('vocab-mastered-master-toggle-w000');
assert.equal(await masteredCheck.getAttribute('aria-pressed'), 'true',
    '已掌握 rows render a pressed check');
const masteredIndicator = page.getByTestId('vocab-mastered-master-toggle-w000-indicator');
assert.equal(await masteredIndicator.count(), 1, 'the pressed state keeps the circle shape');
assert.equal(await masteredIndicator.getAttribute('data-state'), 'checked');
assert.equal(await masteredCheck.locator(':scope > svg').count(), 0,
    'no naked check icon in the pressed state either');
assert.equal(await masteredIndicator.locator('svg').count(), 1);
const masteredIndicatorClass = (await masteredIndicator.getAttribute('class')) ?? '';
assert.match(masteredIndicatorClass, /rounded-full/, 'the mastered state is the same circle');
assert.match(masteredIndicatorClass, /bg-success\/15/, 'the mastered circle carries the success fill');
assert.match(masteredIndicatorClass, /border-success\/40/, 'the mastered circle uses the success border');
assert.match(masteredIndicatorClass, /text-success-fg/, 'the mastered check is green');
assert.doesNotMatch(masteredIndicatorClass, /text-fg-muted/,
    'the mastered check is no longer neutral grey');
await page.screenshot({ path: `${SHOTS}/p0-12-1440-mastered-toggle.png` });
assert.equal(await page.getByTestId('vocab-mastered-undo-w000').count(), 0,
    'the old 撤销 text action must be gone');
await masteredCheck.click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="w000"]'));
assert.deepEqual(state.patches.at(-1), { lemma: 'w000', mastered: false });
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-tab-count-mastered"]')?.textContent === '10');
assert.equal(await page.getByTestId('vocab-tab-count-mastered').innerText(), '10',
    'undoing the mark removes it from 已掌握');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
// 撤销已掌握 does NOT bring the word back to 我的收藏: mastering removed the
// favorite, and specs/005 §已掌握与收藏互斥 keeps it un-favorited.
await openMenu('vocab-mine-sort', 'vocab-mine-sort-menu');
await pickMenuItem('vocab-sort-alpha');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 59 词',
    'the unmastered word stays out of 我的收藏 (no favorite restore)');
assert.equal(await page.getByTestId('vocab-mine-word-fav-w000').count(), 0,
    'w000 must not reappear in 我的收藏');

// 星标 = the one and only 取消收藏 entry on 我的收藏: DELETE + the row leaves
// the list, so the count drops by one (the list itself is the source).
await page.getByTestId('vocab-mine-star-fav-w010').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w010"]').length === 0);
await waitFor(() => state.deletes.includes('fav-w010'), 15000, 'favorite DELETE');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 58 词');

// The expanded area has NO 取消收藏/删除 action (P0-03 removed the duplicate
// entry): it carries 完整释义 / 来源 only, and the row star stays the sole
// cancel affordance. Absence is the contract — nothing is commented out.
await page.getByTestId('vocab-mine-expand-fav-w011').click();
await page.waitForSelector('[data-testid="vocab-mine-detail-fav-w011"]');
assert.equal(await page.getByTestId('vocab-mine-master-fav-w011').count(), 0,
    'the expanded area stopped carrying 已掌握');
assert.equal(await page.locator('[data-testid^="vocab-mine-delete-"]').count(), 0,
    'the expanded area must not render a second 取消收藏/删除 action');
assert.doesNotMatch(await page.getByTestId('vocab-mine-detail-fav-w011').innerText(),
    /取消收藏|我已掌握|标为已掌握/,
    'the expanded area keeps 完整释义/来源, never 取消收藏 or a mastered action');
const cancelStar = page.getByTestId('vocab-mine-star-fav-w011');
assert.equal(await cancelStar.getAttribute('aria-label'), '取消收藏 w011',
    'the row star is the only cancel entry');
assert.equal(await cancelStar.getAttribute('aria-pressed'), 'true');
await cancelStar.click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w011"]').length === 0);
await waitFor(() => state.deletes.includes('fav-w011'), 15000, 'star DELETE');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 57 词');

// Row-level failures stay retryable (never a fake success).
state.failMastered = 'w012';
await page.getByTestId('vocab-mine-master-toggle-fav-w012').click();
await page.waitForSelector('[data-testid="vocab-mine-error-fav-w012"]');
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w012').count(), 1, 'a failed master keeps the row');
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-w012').getAttribute('aria-pressed'), 'false',
    'a failed master must not paint a pressed check');
await page.screenshot({ path: `${SHOTS}/p0-10-1440-mine-master-failed.png` });
await shot('1440-mine-master-failed');
state.failMastered = null;
await page.getByTestId('vocab-mine-master-toggle-fav-w012').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w012"]').length === 0);
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-error-fav-w012"]').length === 0);

// A failed 取消收藏 is still the star: App removes optimistically, rolls the
// row back and reports the failure; the row/count never fake a deletion.
state.failDelete = 'fav-w013';
const deletesBeforeFail = state.deletes.length;
await page.getByTestId('vocab-mine-star-fav-w013').click();
await waitFor(() => state.deletes.length > deletesBeforeFail, 15000, 'failed DELETE attempt');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w013"]').length === 1);
const deleteErrorToast = page.locator('[data-testid="toast"]', { hasText: 'delete failed' });
await deleteErrorToast.first().waitFor({ timeout: 5000 });
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 56 词',
    'a failed 取消收藏 rolls the count back');
await shot('1440-mine-delete-failed');
state.failDelete = null;
await page.getByTestId('vocab-mine-star-fav-w013').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w013"]').length === 0);
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-mine-total"]')?.textContent === '共 55 词');

// P0-14: the default state has no checkbox column and no action bar; 编辑 is
// the only entry into selection. No review write may fire from 我的收藏.
assert.equal(await page.getByTestId('vocab-mine-edit').isVisible(), true);
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    'the default 我的收藏 state must not render any checkbox');
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0,
    'the batch bar only exists while editing');
assert.deepEqual(state.reviewPosts, [], '我的收藏 must never POST a review word');

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
// The indicator span reuses the toggle prefix; the button itself is the
// control (no data-testid ending in -indicator).
const masteredFirstToggle = masteredFirst.locator(
    '[data-testid^="vocab-mastered-master-toggle-"]:not([data-testid$="-indicator"])',
);
assert.equal(await masteredFirstToggle.count(), 1,
    '已掌握 rows carry the pressed check as their undo control');
assert.equal(await masteredFirst.getByTestId(/^vocab-mastered-expand-/).count(), 1);
assert.equal(await masteredFirstToggle.first().getAttribute('aria-pressed'), 'true');
assert.doesNotMatch(await rowTone('[data-testid="vocab-mastered-row"]'), /bg-(success|warning)\/10/,
    '已掌握 rows never get a state tint');
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

// ═══ D) 内置词表 (GRE): shared table + star-only favorite toggle ════════
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
// P0-10 §2: the 已掌握 check sits beside the star on every built-out row.
assert.equal(await page.locator('[data-testid^="vocab-list-master-toggle-"]:not([data-testid$="-indicator"])').count(), 3,
    'every built-in list row carries the 已掌握 check');
assert.equal(await page.getByTestId('vocab-list-master-toggle-gre:abundant').getAttribute('aria-pressed'), 'false');
assert.equal(await page.getByTestId('vocab-list-master-toggle-gre:abundant').getAttribute('aria-label'), '已掌握 abundant');
// §4: no state → no tint.
assert.doesNotMatch(await rowTone('[data-testid="vocab-list-row"][data-word="abundant"]'), /bg-(success|warning)\/10/,
    'a word with no state keeps the default row surface');
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

// P0-09: no 「加入我的单词」 on any word-list row, favorited or not — the star is
// the only favorite switch. The UNFAVORITED state is asserted first: no action,
// no disabled 「已加入」 variant, just 完整释义 / 来源 / 已掌握.
await page.getByTestId('vocab-list-expand-gre:abundant').click();
await page.waitForSelector('[data-testid="vocab-list-detail-gre:abundant"]');
assert.equal(await page.getByTestId('gre:abundant-add-mine').count(), 0,
    '未收藏的列表行不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:abundant').innerText(), /加入我的单词|已加入/,
    'the expanded area must not carry a favorite action in the unfavorited state');
assert.equal(await page.getByTestId('gre:abundant-add-review').count(), 0,
    '加入复习 must be hidden on built-in list rows while the review UI is paused');
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').getAttribute('aria-pressed'), 'false');
const postsBefore = state.favoritePosts.length;
// Two clicks in the same tick: the star's busy guard must keep a rapid double
// click to ONE POST (already-favorited rows have no second POST path at all).
await page.getByTestId('vocab-list-star-gre:abundant').evaluate((el) => { el.click(); el.click(); });
await waitFor(() => state.favoritePosts.length >= postsBefore + 1, 15000, 'star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:abundant"]')?.getAttribute('aria-pressed') === 'true');
await page.waitForTimeout(400);
assert.equal(state.favoritePosts.length, postsBefore + 1, 'a double click still sends exactly one POST');
assert.equal(state.deletes.includes('vocab-fav-abundant'), false, 'a double click must not turn into a DELETE');
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').getAttribute('aria-pressed'), 'true');
const minePost = state.favoritePosts.at(-1);
assert.equal(minePost.id, 'vocab-fav-abundant');
assert.equal(minePost.meta.source_kind, 'wordlist', `meta: ${JSON.stringify(minePost.meta)}`);
assert.equal(minePost.meta.source_ref, 'gre');
assert.equal(minePost.meta.source_title, 'GRE');
assert.equal(minePost.text, 'abundant');
assert.equal(minePost.translation, '/əˈbʌndənt/ 丰富的；充裕的');
// FAVORITED state: still no save action anywhere in the expanded row.
assert.equal(await page.getByTestId('gre:abundant-add-mine').count(), 0,
    '已收藏的列表行也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:abundant').innerText(), /加入我的单词|已加入/,
    'the expanded area must not carry a favorite action in the favorited state');
// P0-10 §4: a favorited row on a fixed word list gets the warning tint.
assert.match(await rowTone('[data-testid="vocab-list-row"][data-word="abundant"]'), /bg-warning\/10/,
    'a favorited built-in list row is tinted warning');
// P0-10 §1: the expanded area carries no mastered text action either.
assert.equal(await page.getByTestId('gre:abundant-master').count(), 0,
    'the old 标为已掌握 text action must be gone from the expanded area');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:abundant').innerText(),
    /我已掌握|标为已掌握|取消已掌握/,
    'the expanded area must not carry a mastered text action');

// A failed star POST rolls the optimistic fill back and toasts; no fake solid
// star and still no 加入我的单词 action to fall back on (the star is the retry).
state.failFavoritePost = 'candid';
await page.getByTestId('vocab-list-expand-gre:candid').click();
await page.waitForSelector('[data-testid="vocab-list-detail-gre:candid"]');
const postsBeforeFail = state.favoritePosts.length;
await page.getByTestId('vocab-list-star-gre:candid').click();
await waitFor(() => state.favoritePosts.length > postsBeforeFail, 15000, 'failed star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:candid"]')?.getAttribute('aria-pressed') === 'false');
const addErrorToast = page.locator('[data-testid="toast"]', { hasText: 'favorites write failed' });
await addErrorToast.first().waitFor({ timeout: 5000 });
assert.equal(await page.getByTestId('vocab-list-star-gre:candid').getAttribute('aria-pressed'), 'false',
    'a failed star POST must not leave a fake solid star');
assert.equal(await page.getByTestId('gre:candid-add-mine').count(), 0,
    'a failed write still must not grow a 加入我的单词 action');
await shot('1440-gre-add-failed');
state.failFavoritePost = null;
const postsBeforeRetry = state.favoritePosts.length;
await page.getByTestId('vocab-list-star-gre:candid').click();
await waitFor(() => state.favoritePosts.length > postsBeforeRetry, 15000, 'retry star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:candid"]')?.getAttribute('aria-pressed') === 'true');
await page.waitForTimeout(400);
assert.equal(await page.getByTestId('vocab-list-star-gre:candid').getAttribute('aria-pressed'), 'true',
    'the retried star POST saves the word');
assert.equal(await page.getByTestId('gre:candid-add-mine').count(), 0,
    'a successful star POST must not leave a 加入我的单词 action behind');
await shot('1440-gre-star-only');

// P0-10: the row check marks mastered on a fixed word list. candid is
// favorited here: marking mastered PATCHes, removes the favorite (mutual
// exclusion), tints the row success and disables the star. Unchecking only
// clears the mark — it never refills the favorite (ADR-0001).
await page.getByTestId('vocab-list-master-toggle-gre:candid').click();
await waitFor(() => state.patches.some((item) => item.lemma === 'candid' && item.mastered === true), 15000, 'mastered PATCH');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-master-toggle-gre:candid"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(await page.getByTestId('vocab-list-master-toggle-gre:candid').getAttribute('aria-label'),
    '取消已掌握 candid', 'the pressed check names the undo action');
const listIndicator = page.getByTestId('vocab-list-master-toggle-gre:candid-indicator');
assert.equal(await listIndicator.getAttribute('data-state'), 'checked',
    'the fixed-list toggle switches to the pressed circle');
const listIndicatorClass = (await listIndicator.getAttribute('class')) ?? '';
assert.match(listIndicatorClass, /rounded-full/);
assert.match(listIndicatorClass, /bg-success\/15/);
assert.match(listIndicatorClass, /text-success-fg/);
assert.match(await rowTone('[data-testid="vocab-list-row"][data-word="candid"]'), /bg-success\/10/,
    'a mastered built-in list row is tinted success');
assert.equal(await page.getByTestId('vocab-list-star-gre:candid').isDisabled(), true,
    'a mastered row disables its star');
assert.equal(state.deletes.includes('vocab-fav-candid'), true,
    'marking mastered removes the favorite (specs/005 §已掌握与收藏互斥)');
await page.screenshot({ path: `${SHOTS}/p0-10-1440-mastered-row.png` });
await page.getByTestId('vocab-list-master-toggle-gre:candid').click();
await waitFor(() => state.patches.at(-1)?.lemma === 'candid' && state.patches.at(-1)?.mastered === false, 15000, 'unmastered PATCH');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-master-toggle-gre:candid"]')?.getAttribute('aria-pressed') === 'false');
assert.doesNotMatch(await rowTone('[data-testid="vocab-list-row"][data-word="candid"]'), /bg-(success|warning)\/10/,
    'unmarking clears the tint');
assert.equal(await page.getByTestId('vocab-list-star-gre:candid').isDisabled(), false,
    'unmarking re-enables the star');
assert.equal(await page.getByTestId('vocab-list-star-gre:candid').getAttribute('aria-pressed'), 'false',
    'undoing mastered never refills the favorite');
assert.equal(state.deletes.filter((id) => id === 'vocab-fav-candid').length, 1);

// A failed favorite removal rolls the mastered mark back and shows the inline
// row error; the row keeps its favorite tint and an unpressed check.
state.failDelete = 'vocab-fav-abundant';
const patchesBeforeRollback = state.patches.length;
await page.getByTestId('vocab-list-master-toggle-gre:abundant').click();
await page.waitForSelector('[data-testid="vocab-list-error-abundant"]');
assert.equal(state.patches.length, patchesBeforeRollback + 2,
    'a failed favorite removal rolls the mark back (PATCH true → PATCH false)');
assert.deepEqual(state.patches.slice(-2).map((item) => item.mastered), [true, false]);
assert.equal(await page.getByTestId('vocab-list-master-toggle-gre:abundant').getAttribute('aria-pressed'), 'false',
    'a rolled-back mark keeps the check unpressed');
assert.match(await rowTone('[data-testid="vocab-list-row"][data-word="abundant"]'), /bg-warning\/10/,
    'the favorite (and its tint) survives the rollback');
state.failDelete = null;

// Star toggles the favorite from a list row: POST then DELETE, and the
// expanded area has no 加入我的单词 in either state (P0-09 removed the action;
// it does not come back when the word is unstarred).
await page.getByTestId('vocab-list-star-gre:brisk').click();
await waitFor(() => state.favoritePosts.some((item) => item.text === 'brisk'), 15000, 'star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:brisk"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-pressed'), 'true');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-label'), '取消收藏 brisk');
const briskPost = state.favoritePosts.find((item) => item.text === 'brisk');
assert.equal(briskPost.meta.source_kind, 'wordlist');
assert.equal(briskPost.meta.source_ref, 'gre');
await page.getByTestId('vocab-list-expand-gre:brisk').click();
await page.waitForSelector('[data-testid="vocab-list-detail-gre:brisk"]');
assert.equal(await page.getByTestId('gre:brisk-add-mine').count(), 0,
    '已收藏的列表行不得渲染 加入我的单词');
await page.getByTestId('vocab-list-star-gre:brisk').click();
await waitFor(() => state.deletes.includes('vocab-fav-brisk'), 15000, 'star DELETE');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:brisk"]')?.getAttribute('aria-pressed') === 'false');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-pressed'), 'false');
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-label'), '收藏 brisk');
assert.equal(await page.getByTestId('gre:brisk-add-mine').count(), 0,
    '取消收藏后也不得重新出现 加入我的单词 (P0-09: star is the only switch)');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:brisk').innerText(), /加入我的单词|已加入/,
    'unstarring must not resurrect the removed favorite action');

// Speaker on a list row.
await page.getByTestId('gre:candid-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('candid'));

// 加入复习 stays hidden and nothing reaches the review API.
assert.equal(await page.getByTestId('gre:abundant-add-review').count(), 0);
assert.equal(await page.getByTestId('gre:brisk-add-review').count(), 0);
assert.deepEqual(state.reviewPosts, [], 'list rows must never POST a review word');

// ═══ E) 短语: filter menu + star-only favorite + expanded detail ════════
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
assert.equal(await page.getByTestId('phrase-row').count(), 2);
assert.equal(await page.getByTestId('phrase-total').innerText(), '共 2 条短语');
// P0-10 §2/§4: the shared row carries the check on phrase rows too; no state
// means no tint.
assert.equal(await page.getByTestId('phrase:p1-master-toggle').count(), 1);
assert.equal(await page.getByTestId('phrase:p1-master-toggle').getAttribute('aria-pressed'), 'false');
assert.doesNotMatch(await rowTone('[data-testid="phrase-row"][data-word="give up"]'), /bg-(success|warning)\/10/);
await shot('1440-phrases');

await openMenu('phrase-filter', 'phrase-filter-menu');
assert.equal(await page.getByTestId('phrase-level-all').getAttribute('aria-checked'), 'true');
await page.getByTestId('phrase-level-B1').click(); // keepOpen
await page.waitForFunction(() => document.querySelectorAll('[data-testid="phrase-row"]').length === 1);
assert.match(await page.getByTestId('phrase-filter').innerText(), /筛选：B1/);
await shot('1440-phrases-filtered');
await pickMenuItem('phrase-clear-filters-menu');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="phrase-row"]').length === 2);

// Phrase detail expands on row click (no hide-Chinese here) and never carries
// 加入我的单词 (P0-09: the star is the only favorite switch); 加入复习 stays
// hidden while the review UI is paused.
await page.getByTestId('phrase-row').first().click();
await page.waitForSelector('[data-testid="phrase-detail-p1"]');
assert.equal(await page.getByTestId('phrase:p1-add-mine').count(), 0,
    '未收藏的短语行不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('phrase-detail-p1').innerText(), /加入我的单词|已加入/,
    'the unfavorited phrase detail carries 例句/来源 only');
assert.equal(await page.getByTestId('phrase:p1-add-review').count(), 0,
    '加入复习 must be hidden on phrase rows');
assert.match(await page.getByTestId('phrase-example').innerText(), /Never give up/);
assert.equal(await page.getByTestId('phrase-source').count(), 1);
const phrasePostsBefore = state.favoritePosts.length;
await page.getByTestId('phrase:p1-star').click();
await waitFor(() => state.favoritePosts.length > phrasePostsBefore, 15000, 'phrase star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p1-star"]')?.getAttribute('aria-pressed') === 'true');
const phrasePost = state.favoritePosts.at(-1);
assert.equal(phrasePost.meta.source_kind, 'wordlist');
assert.equal(phrasePost.meta.source_ref, 'phrases');
assert.equal(phrasePost.text, 'give up');
assert.match(await rowTone('[data-testid="phrase-row"][data-word="give up"]'), /bg-warning\/10/,
    'a favorited phrase row is tinted warning');
assert.equal(await page.getByTestId('phrase:p1-master-toggle').count(), 1,
    'phrase rows keep the check beside the star');
assert.doesNotMatch(await page.getByTestId('phrase-detail-p1').innerText(),
    /我已掌握|标为已掌握/,
    'the expanded phrase detail has no mastered text action');
assert.equal(await page.getByTestId('phrase:p1-add-mine').count(), 0,
    '已收藏的短语行也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('phrase-detail-p1').innerText(), /加入我的单词|已加入/,
    'the favorited phrase detail still carries no favorite action');
await page.getByTestId('phrase:p1-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('give up'));
await page.getByTestId('phrase:p2-star').click();
await waitFor(() => state.favoritePosts.some((item) => item.text === 'on the fence'), 15000, 'phrase star POST');
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p2-star"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(await page.getByTestId('phrase:p2-star').getAttribute('aria-label'), '取消收藏 on the fence');
assert.equal(await page.getByTestId('phrase:p2-add-mine').count(), 0,
    '已收藏的短语行不得渲染 加入我的单词');
// Expand the starred phrase row too: the missing action is not a hidden
// placeholder, the expanded area carries the detail only.
await page.locator('[data-testid="phrase-row"]').nth(1).click();
await page.waitForSelector('[data-testid="phrase-detail-p2"]');
assert.equal(await page.getByTestId('phrase:p2-add-mine').count(), 0,
    '已收藏的短语行（展开后）不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('phrase-detail-p2').innerText(), /加入我的单词|已加入/,
    'the expanded phrase detail must not render a favorite action');
await shot('1440-phrases-added');

// ═══ E2) P0-14 edit mode: every list has 编辑 / checkbox / batch actions ═
// Non-edit state renders no checkboxes anywhere; 编辑 opens the leading
// checkbox column + the sticky bar and disables the row star/check so a batch
// cannot accidentally write through a row control.

// ── 我的收藏 matrix: 取消收藏 / 标为已掌握 ───────────────────────────────
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
assert.equal(await page.getByTestId('vocab-mine-edit').isVisible(), true);
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    '我的收藏 renders no checkboxes before 编辑');
await page.getByTestId('vocab-mine-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal((await page.getByTestId('vocab-mine-edit').innerText()).trim(), '完成');
await waitSelected('已选 0');
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 50,
    'editing prepends one checkbox to every visible row');
assert.equal(await page.getByTestId('vocab-mine-star-fav-w020').isDisabled(), true,
    'the star is disabled while editing (never a row write from a batch tap)');
assert.equal(await page.getByTestId('vocab-mine-master-toggle-fav-w020').isDisabled(), true,
    'the mastered check is disabled while editing');
// Row click toggles the selection instead of expanding.
await page.locator('[data-testid="vocab-mine-toggle-fav-w020"]').click();
await waitSelected('已选 1');
assert.equal(await page.getByTestId('vocab-mine-detail-fav-w020').count(), 0,
    'the row does not expand while editing');
await page.locator('[data-testid="vocab-mine-toggle-fav-w020"]').click();
await waitSelected('已选 0');
await page.getByTestId('vocab-mine-select-fav-w020').check();
await page.getByTestId('vocab-mine-select-fav-w021').check();
await waitSelected('已选 2');
await page.screenshot({ path: `${SHOTS}/p0-14-1440-mine-edit.png`, fullPage: false });
const mineDeletesBefore = state.deletes.length;
await page.getByTestId('vocab-edit-unfavorite').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w020"]').length === 0
    && document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w021"]').length === 0);
assert.equal(state.deletes.includes('fav-w020') && state.deletes.includes('fav-w021'), true);
assert.equal(state.deletes.length, mineDeletesBefore + 2);
await waitSelected('已选 0');

// 标为已掌握: PATCH + DELETE the favorite, and the independent 已掌握 list grows.
await page.getByTestId('vocab-mine-select-fav-w022').check();
await page.getByTestId('vocab-edit-master').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w022"]').length === 0);
await waitFor(() => state.patches.some((item) => item.lemma === 'w022' && item.mastered === true), 15000, 'batch master PATCH');
assert.equal(state.deletes.includes('fav-w022'), true,
    'marking mastered removes the favorite (mutual exclusion)');
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-tab-count-mastered"]')?.textContent === '12');
await waitSelected('已选 0');

// A rapid double click submits the batch exactly once (synchronous guard).
await page.getByTestId('vocab-mine-select-fav-w025').check();
await page.getByTestId('vocab-edit-unfavorite').evaluate((el) => { el.click(); el.click(); });
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w025"]').length === 0);
await waitSelected('已选 0');
assert.equal(state.deletes.filter((id) => id === 'fav-w025').length, 1,
    'a double click must not send a second batch');

// A failed unfavorite keeps the row + selection and shows the inline error +
// 「N 项失败」 summary; a retry clears both.
state.failDelete = 'fav-w023';
await page.getByTestId('vocab-mine-select-fav-w023').check();
await page.getByTestId('vocab-edit-unfavorite').click();
await page.waitForSelector('[data-testid="vocab-mine-edit-error-fav-w023"]');
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w023').count(), 1,
    'the failed row is not removed');
await waitSelected('已选 1');
assert.match(await page.getByTestId('vocab-edit-summary').innerText(), /1 项失败/);
state.failDelete = null;
await page.getByTestId('vocab-edit-unfavorite').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w023"]').length === 0);
assert.equal(await page.getByTestId('vocab-mine-edit-error-fav-w023').count(), 0,
    'a successful retry clears the row error');
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    '完成 exits edit mode and clears the checkboxes');

// ── 已掌握 matrix: 取消已掌握 ────────────────────────────────────────────
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]').count(), 0);
await page.getByTestId('vocab-mastered-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal(await page.locator('[data-testid^="vocab-mastered-select-"]').count(), 12,
    '已掌握 prepends one checkbox per row while editing');
await page.getByTestId('vocab-mastered-select-w060').check();
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="w060"]'));
assert.deepEqual(state.patches.at(-1), { lemma: 'w060', mastered: false });
await waitSelected('已选 0');
// Failure retention for 取消已掌握: the optimistic row returns with an error.
state.failMastered = 'w061';
await page.getByTestId('vocab-mastered-select-w061').check();
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForSelector('[data-testid="vocab-mastered-edit-error-w061"]');
assert.equal(await page.locator('[data-testid="vocab-mastered-row"][data-word="w061"]').count(), 1,
    'a failed 取消已掌握 rolls the row back');
await waitSelected('已选 1');
assert.match(await page.getByTestId('vocab-edit-summary').innerText(), /1 项失败/);
state.failMastered = null;
await page.getByTestId('vocab-edit-unmaster').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-mastered-row"][data-word="w061"]'));
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });

// ── 内置词表 matrix: 加入收藏 / 标为已掌握 ──────────────────────────────
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
assert.equal(await page.locator('[data-testid^="vocab-list-select-"]').count(), 0);
await page.getByTestId('vocab-list-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal(await page.locator('[data-testid^="vocab-list-select-"]').count(), 3);
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').isDisabled(), true);
await page.getByTestId('vocab-list-select-gre:brisk').check();
await page.getByTestId('vocab-edit-favorite').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:brisk"]')?.getAttribute('aria-pressed') === 'true');
await waitSelected('已选 0');
// Failed 加入收藏 keeps the row selected + inline error; retry succeeds.
state.failFavoritePost = 'candid';
await page.getByTestId('vocab-list-select-gre:candid').check();
await page.getByTestId('vocab-edit-favorite').click();
await page.waitForSelector('[data-testid="vocab-list-edit-error-gre:candid"]');
await waitSelected('已选 1');
assert.match(await page.getByTestId('vocab-edit-summary').innerText(), /1 项失败/);
state.failFavoritePost = null;
await page.getByTestId('vocab-edit-favorite').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:candid"]')?.getAttribute('aria-pressed') === 'true');
await waitSelected('已选 0');
// 标为已掌握 from the list: PATCH + DELETE the favorite just created.
await page.getByTestId('vocab-list-select-gre:candid').check();
await page.getByTestId('vocab-edit-master').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-master-toggle-gre:candid"]')?.getAttribute('aria-pressed') === 'true');
await waitFor(() => state.patches.at(-1)?.lemma === 'candid' && state.patches.at(-1)?.mastered === true, 15000, 'batch list master');
assert.equal(state.deletes.includes('vocab-fav-candid'), true);
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
// Restore the 375 fixture contrast: brisk is un-starred again through its row
// star (the batch only needed to prove the write path).
await page.getByTestId('vocab-list-star-gre:brisk').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-list-star-gre:brisk"]')?.getAttribute('aria-pressed') === 'false');
await waitFor(() => state.deletes.includes('vocab-fav-brisk'), 15000, 'brisk unstar');

// ── 短语 matrix: 加入收藏 / 标为已掌握 ──────────────────────────────────
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
// p2 starts favorited by §E: unstar it through the row star first.
await page.getByTestId('phrase:p2-star').click();
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p2-star"]')?.getAttribute('aria-pressed') === 'false');
await page.getByTestId('vocab-phrases-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal(await page.locator('[data-testid^="phrase-select-"]').count(), 2);
await page.screenshot({ path: `${SHOTS}/p0-14-1440-phrases-edit.png`, fullPage: false });
await page.getByTestId('phrase-select-p2').check();
await page.getByTestId('vocab-edit-favorite').click();
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p2-star"]')?.getAttribute('aria-pressed') === 'true');
await waitSelected('已选 0');
const phrasePostBatch = state.favoritePosts.at(-1);
assert.equal(phrasePostBatch.meta.source_kind, 'wordlist');
assert.equal(phrasePostBatch.meta.source_ref, 'phrases');
// Failed 标为已掌握 stays selected; the retry PATCHes then deletes the favorite.
state.failMastered = 'on the fence';
await page.getByTestId('phrase-select-p2').check();
await page.getByTestId('vocab-edit-master').click();
await page.waitForSelector('[data-testid="phrase-edit-error-p2"]');
await waitSelected('已选 1');
state.failMastered = null;
await page.getByTestId('vocab-edit-master').click();
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p2-master-toggle"]')?.getAttribute('aria-pressed') === 'true');
await page.getByTestId('phrase-select-p1').check();
await page.getByTestId('vocab-edit-master').click();
await page.waitForFunction(() => document.querySelector('[data-testid="phrase:p1-master-toggle"]')?.getAttribute('aria-pressed') === 'true');
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });

// Switching tabs exits edit mode and clears the selection.
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.getByTestId('vocab-mine-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
await page.getByTestId('vocab-mine-select-fav-w030').check();
await waitSelected('已选 1');
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0, 'switching tabs exits edit mode');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
assert.equal((await page.getByTestId('vocab-mine-edit').innerText()).trim(), '编辑');
assert.equal((await page.getByTestId('vocab-edit-bar').count()), 0);
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    'the selection is cleared on the next tab visit');

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
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0, 'no batch bar before 编辑 at 375 either');
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    '375 default state has no checkboxes');
await page.getByTestId('vocab-mine-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
await page.screenshot({ path: `${SHOTS}/p0-14-375-mine-edit.png`, fullPage: false });
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').first().isVisible(), true,
    'the edit checkbox stays reachable at 375');
const editBarOverflow = await page.evaluate(() => {
    const doc = document.documentElement;
    return doc.scrollWidth - doc.clientWidth;
});
assert.ok(editBarOverflow <= 0, `375px horizontal overflow while editing: ${editBarOverflow}px`);
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal((await page.getByTestId('vocab-tab-mine').innerText()).startsWith('我的收藏'), true);
assert.equal(await page.locator('[data-testid^="vocab-mine-master-toggle-"]:not([data-testid$="-indicator"])').first().isVisible(), true,
    'the 已掌握 check stays reachable at 375');
await shot('375-mine');
await page.screenshot({ path: `${SHOTS}/p0-10-375-mine.png` });
await page.screenshot({ path: `${SHOTS}/p0-12-375-mine-unmastered.png` });
// The 已掌握 tab shows the pressed (green) circle at 375 without touching state.
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
await page.screenshot({ path: `${SHOTS}/p0-12-375-mastered-toggle.png` });
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
assert.equal(await page.getByTestId('vocab-list-master-toggle-gre:abundant').isVisible(), true,
    'the list-row check stays reachable at 375');
assert.match(await rowTone('[data-testid="vocab-list-row"][data-word="abundant"]'), /bg-warning\/10/);
await page.screenshot({ path: `${SHOTS}/p0-10-375-gre.png` });
// A fresh GET /api/favorites backs this reload: abundant is favorited, brisk is
// not — NEITHER state renders 加入我的单词 at 375 (the star is the only switch).
await page.getByTestId('vocab-list-expand-gre:abundant').click();
await page.waitForSelector('[data-testid="vocab-list-detail-gre:abundant"]');
assert.equal(await page.getByTestId('gre:abundant-add-mine').count(), 0,
    '已收藏的列表行不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:abundant').innerText(), /加入我的单词|已加入/);
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').getAttribute('aria-pressed'), 'true');
await page.getByTestId('vocab-list-expand-gre:brisk').click();
await page.waitForSelector('[data-testid="vocab-list-detail-gre:brisk"]');
assert.equal(await page.getByTestId('gre:brisk-add-mine').count(), 0,
    '未收藏的列表行也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-list-detail-gre:brisk').innerText(), /加入我的单词|已加入/);
assert.equal(await page.getByTestId('vocab-list-star-gre:brisk').getAttribute('aria-pressed'), 'false');
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
await page.getByTestId('vocab-list-star-gre:abundant').click();
await page.waitForSelector('[data-testid="guest-auth-overlay"]', { timeout: 10000 });
assert.equal(state.favoritePosts.length, guestPostsBefore, 'the guest gate must not POST a favorite');
assert.equal(await page.getByTestId('vocab-list-star-gre:abundant').getAttribute('aria-pressed'), 'false',
    'the guest star must not pretend the word was saved');
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
