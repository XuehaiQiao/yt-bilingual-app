// Playwright acceptance for the word book v1.2 daily-use layer
// (specs/005 §v1.2): row TTS, 我的单词 search + 状态 chips, built-in list /
// phrase 加入我的单词 + 加入复习, multi-select bulk actions, 字母 sort + 50/page,
// guest gating and the "state endpoint missing → hide the group" degradation.
//
// Every /api/** request is mocked; nothing touches :8000 or :5173.
// Run (the script needs a directory where `playwright` resolves, e.g. a
// node_modules symlink or the npx cache):
//   cd /tmp/wb-ux && APP_URL=http://localhost:5199/ node \
//     /Users/piece/Desktop/Me/EnglishLearning/yt-bilingual-app/scripts/wordbook-v12-acceptance.mjs
// Shots: /tmp/wb-ux-*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

const BASE = process.env.APP_URL || 'http://127.0.0.1:5199/';
const SHOTS = '/tmp';

// ── fixtures ────────────────────────────────────────────────────────────────
const MINE = Array.from({ length: 70 }, (_, i) => `w${String(i).padStart(3, '0')}`);
const MASTERED = MINE.slice(60); // w060…w069
const WORD_STATE = {};
MINE.slice(0, 10).forEach((word) => { WORD_STATE[word] = 'new'; });
MINE.slice(10, 20).forEach((word) => { WORD_STATE[word] = 'learning'; });
MINE.slice(20, 25).forEach((word) => { WORD_STATE[word] = 'review'; });
MINE.slice(25, 28).forEach((word) => { WORD_STATE[word] = 'suspended'; });

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
    /** 404/403 → the state chip group must hide instead of erroring. */
    stateFail: 0,
    /** Word whose POST /api/favorites fails (inline retryable error). */
    failFavoritePost: null,
    /** Favorite id whose DELETE fails (bulk summary keeps the row). */
    failDelete: null,
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

    // ── favorites: single-row writes used by 加入我的单词 / 批量删除 ────────
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

    // ── review words: mastered list (v1.1) + state filter (v1.2) ─────────
    if (pathname === '/api/review/words' && method === 'GET') {
        if (state.mode === 'guest') return fail(403, 'login required');
        const masteredParam = url.searchParams.get('mastered');
        const stateParam = url.searchParams.get('state');
        if (masteredParam === '1') {
            const words = state.mastered.map((lemma) => publicWord(lemma, { mastered: true }));
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
        }
        if (stateParam) {
            state.stateRequests.push(stateParam);
            if (state.stateFail) return fail(state.stateFail, 'state filter unavailable');
            const wanted = new Set(stateParam.split(',').map((item) => item.trim().toLowerCase()));
            const words = Object.entries(WORD_STATE)
                .filter(([, value]) => wanted.has(value))
                .map(([lemma]) => publicWord(lemma));
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
        }
        const words = Object.keys(WORD_STATE).map((lemma) => publicWord(lemma));
        return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
    }
    if (pathname === '/api/review/words' && method === 'POST') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').trim();
        state.reviewPosts.push({ lemma, source: body.source ?? null });
        if (!(lemma in WORD_STATE)) WORD_STATE[lemma] = 'new';
        return respond({ status: 'ok', created: true, word: publicWord(lemma) });
    }
    if (pathname === '/api/review/words' && method === 'PATCH') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').trim();
        state.patches.push({ lemma, mastered: body.mastered });
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
        return respond({ items: PHRASES, total: PHRASES.length, page: 1, pageSize: 50, hasMore: false });
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

    // specs/038: the word book fetches the account's custom lists on mount.
    // These fixtures predate the feature, so it is an empty catalog here.
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

async function gotoWordbook() {
    await page.goto(`${BASE}#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
    // A hash-only goto is same-document; force a real mount so per-mount reads
    // (状态 chips, mastered list) run again for the current mock state.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="vocabulary-book"]', { timeout: 20000 });
    await page.getByTestId('vocab-tabs').waitFor({ timeout: 20000 });
}
const rowWords = async (prefix) => page.$$eval(
    `[data-testid^="${prefix}-word-"]`,
    (nodes) => nodes.map((node) => node.textContent.trim()),
);

// ═══ A) 我的单词: search, 状态 chips, 字母 sort, 50/page ═══════════════════
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await page.waitForSelector('[data-testid="vocab-state-filter"]');

let rows = await page.$$eval('[data-testid^="vocab-mine-toggle-"]', (nodes) => nodes.length);
assert.equal(rows, 50, `我的单词 page 1 must show 50 rows, saw ${rows}`);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');
assert.equal(await page.getByTestId('vocab-mine-total').innerText(), '共 60 词');
await shot('1440-mine');

// 状态 chips: 全部/新词/学习中/复习中/已暂停, data from ?state=
for (const id of ['vocab-state-all', 'vocab-state-new', 'vocab-state-learning', 'vocab-state-review', 'vocab-state-suspended']) {
    assert.equal(await page.getByTestId(id).count(), 1, `state chip ${id} missing`);
}
assert.ok(state.stateRequests.length >= 1, 'the screen must call GET /api/review/words?state=');
assert.match(state.stateRequests[0], /new/, `state param: ${state.stateRequests[0]}`);
assert.match(state.stateRequests[0], /suspended/, `state param: ${state.stateRequests[0]}`);
await page.getByTestId('vocab-state-new').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 10);
await page.getByTestId('vocab-state-learning').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 10);
await page.getByTestId('vocab-state-review').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 5);
await shot('1440-mine-state-review');
await page.getByTestId('vocab-state-suspended').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 3);
await page.getByTestId('vocab-state-all').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);

// 行内发音: local speech synthesis, no AI request.
const firstSpeak = await page.$$eval('[data-testid^="vocab-mine-speak-"]', (nodes) => nodes[0].getAttribute('data-testid'));
const firstWord = await page.$$eval('[data-testid^="vocab-mine-word-"]', (nodes) => nodes[0].textContent.trim());
await page.getByTestId(firstSpeak).click();
await page.waitForFunction(() => (window.__spoken || []).length > 0);
assert.equal((await spoken()).at(-1), firstWord, 'the row speaker speaks the English word');
assert.equal(await page.getByTestId(firstSpeak).locator('svg').count(), 1, 'ghost icon recipe renders one Volume2 icon');

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
await page.getByTestId('vocab-mine-clear-filters').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);

// 字母 A→Z sort + paging reset.
await page.getByTestId('vocab-sort-alpha').click();
await page.waitForFunction(() => {
    const first = document.querySelector('[data-testid^="vocab-mine-word-"]');
    return first && first.textContent.trim() === 'w000';
});
await page.getByTestId('vocab-page-2').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 10);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 2 / 2 页');
await page.getByTestId('vocab-state-review').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 5);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 1 页',
    'a filter change must return to page 1');
await page.getByTestId('vocab-state-all').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-mine-toggle-"]').length === 50);

// ═══ B) 批量操作 (我的单词) ══════════════════════════════════════════════
await page.getByTestId('vocab-mine-select-fav-w000').check();
await page.getByTestId('vocab-mine-select-fav-w001').check();
await page.getByTestId('vocab-mine-select-fav-w002').check();
assert.equal(await page.getByTestId('vocab-mine-selected').innerText(), '已选 3 项');
await shot('1440-mine-bulk-selected');
await page.getByTestId('vocab-mine-bulk-master').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w000"]').length === 0);
await waitFor(() => state.patches.length >= 3, 15000, 'bulk master PATCHes');
assert.deepEqual(
    state.patches.filter((item) => item.mastered === true).map((item) => item.lemma).sort(),
    ['w000', 'w001', 'w002'],
    `bulk PATCH mastered: ${JSON.stringify(state.patches)}`,
);
assert.equal(await page.getByTestId('vocab-mine-selected').innerText(), '已选 0 项');
await shot('1440-mine-bulk-mastered');

// 批量加入复习
await page.getByTestId('vocab-mine-select-fav-w003').check();
await page.getByTestId('vocab-mine-select-fav-w004').check();
await page.getByTestId('vocab-mine-bulk-review').click();
await waitFor(() => state.reviewPosts.length >= 2, 15000, 'bulk review POSTs');
// 批量删除 (确认对话框 + 逐条 DELETE)
await page.getByTestId('vocab-mine-select-fav-w010').check();
await page.getByTestId('vocab-mine-select-fav-w011').check();
await page.getByTestId('vocab-mine-bulk-delete').click();
await page.waitForSelector('[data-testid="vocab-bulk-delete"]');
assert.match(await page.getByTestId('vocab-bulk-delete').innerText(), /删除 2 条收藏/);
await shot('1440-mine-bulk-delete-confirm');
await page.getByTestId('vocab-bulk-delete-confirm').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mine-toggle-fav-w010"]').length === 0);
await page.getByTestId('vocab-bulk-delete').waitFor({ state: 'detached', timeout: 8000 });
assert.ok(state.deletes.includes('fav-w010') && state.deletes.includes('fav-w011'));

// 逐条失败: the failing row stays selected + inline summary (no fake success).
state.failDelete = 'fav-w012';
await page.getByTestId('vocab-mine-select-fav-w012').check();
await page.getByTestId('vocab-mine-select-fav-w013').check();
await page.getByTestId('vocab-mine-bulk-delete').click();
await page.getByTestId('vocab-bulk-delete-confirm').click();
await page.waitForSelector('[data-testid="vocab-mine-bulk-summary"]', { timeout: 15000 });
const summary = await page.getByTestId('vocab-mine-bulk-summary').innerText();
assert.match(summary, /1 项失败/);
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w012').count(), 1, 'the failed row stays in the list');
assert.equal(await page.getByTestId('vocab-mine-select-fav-w012').isChecked(), true, 'the failed row stays selected');
assert.equal(await page.getByTestId('vocab-mine-toggle-fav-w013').count(), 0, 'the successful row is gone');
await shot('1440-mine-bulk-failed');
state.failDelete = null;

// ═══ C) 已掌握 tab: selection + bulk 撤销 + delete ══════════════════════
await page.getByTestId('vocab-tab-mastered').click();
await page.waitForSelector('[data-testid="vocab-mastered-list"]');
await page.waitForSelector('[data-testid="vocab-mastered-bulk"]');
assert.ok(await page.getByTestId('vocab-mastered-select-w060').count() === 1);
await page.getByTestId('vocab-mastered-select-w060').check();
await page.getByTestId('vocab-mastered-select-w061').check();
assert.equal(await page.getByTestId('vocab-mastered-selected').innerText(), '已选 2 项');
await shot('1440-mastered-bulk');
await page.getByTestId('vocab-mastered-bulk-unmaster').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-mastered-undo-w060"]').length === 0);
assert.ok(
    state.patches.filter((item) => item.mastered === false).map((item) => item.lemma).includes('w060'),
    'bulk un-master must PATCH mastered=false',
);
// mastered row speaker
await page.getByTestId('vocab-mastered-w062-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('w062'));

// ═══ D) 内置词表: speaker + 加入我的单词 + 加入复习 ══════════════════════
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
assert.equal(await page.getByTestId('vocab-list-row').count(), 3);
await shot('1440-gre-list');
assert.equal(await page.getByTestId('gre:abundant-speak').count(), 1, 'list rows need a 朗读 button');
const postsBefore = state.favoritePosts.length;
await page.getByTestId('gre:abundant-add-mine').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="gre:abundant-add-mine"]');
    return button && button.textContent.includes('已加入');
});
const minePost = state.favoritePosts.at(-1);
assert.equal(state.favoritePosts.length, postsBefore + 1);
assert.equal(minePost.meta.source_kind, 'wordlist', `meta: ${JSON.stringify(minePost.meta)}`);
assert.equal(minePost.meta.source_ref, 'gre');
assert.equal(minePost.meta.source_title, 'GRE');
assert.equal(minePost.text, 'abundant');
assert.equal(minePost.translation, '/əˈbʌndənt/ 丰富的；充裕的');
assert.equal(await page.getByTestId('gre:abundant-add-mine').isDisabled(), true, '已加入 is idempotent (disabled)');
// clicking again must not POST
await page.getByTestId('gre:abundant-add-mine').click({ force: true }).catch(() => {});
assert.equal(state.favoritePosts.length, postsBefore + 1, 'the added row never re-posts');
// 加入复习 on a list row
await page.getByTestId('gre:brisk-add-review').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="gre:brisk-add-review"]');
    return button && button.textContent.includes('已在复习');
});
assert.deepEqual(state.reviewPosts.at(-1), { lemma: 'brisk', source: { contentRef: 'gre' } },
    `review POST body: ${JSON.stringify(state.reviewPosts.at(-1))}`);
// speaker on a list row
await page.getByTestId('gre:candid-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('candid'));
// inline failure + retry (the failure must not look like success)
state.failFavoritePost = 'candid';
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
await shot('1440-gre-added');

// ═══ E) 短语 tab: speaker + 加入我的单词 + 加入复习 ══════════════════════
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
await shot('1440-phrases');
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
await page.getByTestId('phrase:p2-add-review').click();
await page.waitForFunction(() => {
    const button = document.querySelector('[data-testid="phrase:p2-add-review"]');
    return button && button.textContent.includes('已在复习');
});
assert.equal(state.reviewPosts.at(-1).lemma, 'on the fence');
await page.getByTestId('phrase:p1-speak').click();
await page.waitForFunction(() => (window.__spoken || []).includes('give up'));

// ═══ F) 状态接口 403/404 → 整组隐藏（不回退成错误） ═══════════════════════
for (const status of [404, 403]) {
    state.stateFail = status;
    await gotoWordbook();
    await page.getByTestId('vocab-tab-mine').click();
    await page.waitForSelector('[data-testid="vocab-mine-list"]');
    await page.waitForTimeout(300);
    assert.equal(await page.getByTestId('vocab-state-filter').count(), 0,
        `HTTP ${status} must hide the whole 状态 group`);
}
state.stateFail = 0;
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-state-filter"]');

// ═══ G) 375px: no horizontal overflow, chips/bulk/actions visible ════════
await page.setViewportSize({ width: 375, height: 812 });
await gotoWordbook();
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-state-filter"]');
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
assert.ok(overflow <= 0, `375px horizontal overflow: ${overflow}px`);
await page.getByTestId('vocab-mine-select-fav-w020').check();
await page.getByTestId('vocab-mine-select-fav-w021').check();
await shot('375-mine-bulk');
await page.getByTestId('vocab-mine-bulk-clear').click();
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
await shot('375-gre-list');
await page.getByTestId('vocab-tab-phrases').click();
await page.waitForSelector('[data-testid="phrase-list"]');
await shot('375-phrases');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-list"]');
await shot('375-mine');
await page.setViewportSize({ width: 1440, height: 1000 });

// ═══ H) 游客: 无状态筛选, 加入入口走登录门禁 ═════════════════════════════
state.mode = 'guest';
await page.goto(`${BASE}#/app/profile/vocabulary`, { waitUntil: 'domcontentloaded' });
await page.evaluate(() => { localStorage.removeItem('yt_bilingual_guest_mastered_words'); });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="vocabulary-book"]');
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
await page.waitForTimeout(400);
assert.equal(await page.getByTestId('vocab-state-filter').count(), 0, 'guests never see the 状态 group');
const guestPostsBefore = state.favoritePosts.length;
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-word-list"]');
await page.getByTestId('gre:abundant-add-mine').click();
await page.waitForSelector('[data-testid="guest-auth-overlay"]', { timeout: 10000 });
assert.equal(state.favoritePosts.length, guestPostsBefore, 'the guest gate must not POST a favorite');
await shot('1440-guest-gate');
state.mode = 'signedIn';

// ── cleanup ────────────────────────────────────────────────────────────────
assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join('\n')}`);
assert.deepEqual(state.unmocked, [], `unmocked API calls: ${state.unmocked.join('\n')}`);
await browser.close();
console.log('PASS · wb-ux acceptance');
console.log('  state requests:', state.stateRequests.length);
console.log('  favorite posts:', state.favoritePosts.length);
console.log('  review posts:', state.reviewPosts.length);
console.log('  patches:', state.patches.length, ' deletes:', state.deletes.length);
console.log('  speech assertions: passed');
