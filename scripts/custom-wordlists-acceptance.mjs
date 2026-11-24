#!/usr/bin/env node
// Playwright acceptance for specs/038-custom-wordlists (frontend).
//
// Covers, against a fully mocked backend (no :8000, no real account):
//   A) custom word-list tabs appear after every built-in tab, in order;
//   B) the three-step import wizard: drag/pick file → header+delimiter
//      auto-detect → column mapping → preview of 5 rows → live
//      「共 N 行 · 有效 M · 跳过 K」 stats with the first skip reasons →
//      automatic `(2)` name on a collision → POST /api/wordlists/import;
//   C) the new tab appears, becomes active and renders its rows;
//   D) row controls: NO 加入我的单词 in any favorite state (P0-09 — the row star
//      is the only favorite switch; POST/DELETE + source_kind=wordlist, no local
//      已加入 mirror); the 已掌握 check is the only mastery toggle (P0-10:
//      icon-only PATCH, favorite removal + rollback, green/amber row tint);
//      the fixed-list row is tinted by state; 加入复习 stays hidden while the
//      review UI is paused;
//   E) server-side search + 50/page pagination;
//   F) 删除词表 asks first (cancel keeps it), confirms, deletes the table only;
//      P2-29 adds the explicit Trash2 quick-delete beside ⋯ and asserts both
//      entries open the same confirm;
//   F2) P2-29 legacy CEFR: opening an old list auto-backfills blanks once and
//      reloads (existing values kept, C1+ stays blank, no loop on re-open);
//   G) 全部加入复习（N） is hidden: no bulk button, no review POST;
//   H) review UI paused (specs/013 2026-11-22): a direct #/app/practice/review
//      link falls back to #/app/practice, no review card, no queue request;
//   I) guest entry opens the login overlay and never calls /api/wordlists;
//   J) 375 has no horizontal overflow.
//
// Review UI 暂停启用（specs/013 2026-11-22）：REVIEW_UI_ENABLED=false hides every
// review surface; the FSRS engine, endpoints and the `definition` snapshot stay
// in the product. The old 复习卡 definition-priority case can no longer be
// exercised through the UI, so §H asserts the deep-link fallback instead.
//
// Updated for the unified word-list UI (commit 381440f, specs/005 §统一词表 UI):
// rows now carry the shared WordTable controls (star / 已掌握 check / expand),
// the expanded area only keeps the paused 加入复习 action, paging uses the
// shared 每页 20/50/100 + 跳至 pager,
// and the edit mode (勾选删除) + 重命名 live on the custom list itself. Sections
// D–F were rewritten accordingly; the import wizard, review-route fallback,
// guest gate and 375px cases are unchanged.
// P0-15: §E2 selects all 60 items of wl-2 across its two client pages, checks
// indeterminate + clear, and runs a cross-page 删除词条 batch (the first page is
// no longer rendered); §J repeats 全选 at 375.
//
// Screenshots: /tmp/custom-wordlists-*.png
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node custom-wordlists-acceptance.mjs
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

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const SHOTS = '/tmp';

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const USER = { id: 'u-wl', email: 'wordlists@example.test', username: 'Wordlister', credits: 12 };

const makeItems = (prefix, count, start = 1) => Array.from({ length: count }, (_, index) => {
    const n = start + index;
    return {
        id: `it-${prefix}-${n}`,
        word: `${prefix}${String(n).padStart(3, '0')}`,
        translation: `释义 ${n}`,
        phonetic: `/wɜːd${n}/`,
        cefr: ['A2', 'B1', 'B2', 'C1'][n % 4],
        example: `This is example sentence number ${n}.`,
    };
});

const ABUNDANT = {
    id: 'it-abundant',
    word: 'abundant',
    translation: '丰富的；充裕的',
    phonetic: '/əˈbʌndənt/',
    cefr: 'B2',
    example: 'The region has abundant rainfall.',
};
const CANDID = {
    id: 'it-candid',
    word: 'candid',
    translation: '坦率的',
    phonetic: '/ˈkændɪd/',
    cefr: 'B1',
    example: 'She gave a candid answer.',
};

function word(lemma, definition, index = 0) {
    return {
        id: `w-${lemma}-${index}`,
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
        createdAt: Date.now(),
        mastered: false,
        sources: [],
        definition,
    };
}

function createState() {
    return {
        mode: 'signedIn',
        lists: [
            { id: 'wl-1', name: '旅行词汇', createdAt: 1763000000000, items: [ABUNDANT, CANDID] },
            { id: 'wl-2', name: '大词表', createdAt: 1763000100000, items: makeItems('word', 60) },
            { id: 'wl-3', name: 'My words', createdAt: 1763000200000, items: [{ ...CANDID, word: 'lucid', translation: '清晰的' }] },
            // P2-29: imported before auto-CEFR — two blank rows, one C1+ (stays blank).
            {
                id: 'wl-4',
                name: '旧词表',
                createdAt: 1763000300000,
                items: [
                    { id: 'it-old-abandon', word: 'abandon', translation: '放弃', phonetic: null, cefr: null, example: null },
                    { id: 'it-old-the', word: 'the', translation: '这', phonetic: null, cefr: null, example: null },
                    { id: 'it-old-candid', word: 'candid', translation: '坦率的', phonetic: null, cefr: 'A2', example: null },
                    { id: 'it-old-sesquipedalian', word: 'sesquipedalian', translation: '冗长的', phonetic: null, cefr: null, example: null },
                ],
            },
        ],
        favorites: [],
        favoriteDeletes: [],
        reviewPosts: [],
        masteredPatches: [],
        defineCalls: 0,
        queueCalls: 0,
        wordlistCalls: 0,
        importBodies: [],
        deletes: [],
        renames: [],
        itemDeletes: [],
        /** P2-29: `{id,updated}` per POST /backfill-cefr call. */
        backfillCalls: [],
        /** Item id whose DELETE fails (partial batch failure case). */
        failItemDelete: null,
        reviewQueue: null,
    };
}

function listMeta(list) {
    return {
        id: list.id,
        name: list.name,
        itemCount: list.items.length,
        createdAt: list.createdAt,
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
            return state.mode === 'signedIn'
                ? respond({ user: USER, isAdmin: false, guest: false })
                : respond({ user: null, guest: true });
        }
        if (pathname === '/api/user/summary') {
            return respond({
                user: { ...USER, memberSince: 1763000000000 },
                monthSpendUsd: 0.12,
                usageToday: { minutes: 8 },
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
        if (pathname.startsWith('/api/favorites/') && method === 'DELETE') {
            const id = decodeURIComponent(pathname.replace('/api/favorites/', ''));
            state.favoriteDeletes.push(id);
            state.favorites = state.favorites.filter((fav) => fav.id !== id);
            return respond({ status: 'ok', deleted: true, id });
        }
        if (pathname === '/api/favorites' && method === 'POST') {
            const body = request.postDataJSON() || {};
            const meta = body.meta || {};
            const favorite = {
                id: body.id,
                type: body.type || 'vocabulary',
                videoId: body.videoId,
                start: body.time || 0,
                en_text: body.text,
                zh_text: body.translation,
                added_at: body.addedAt,
                ...meta,
            };
            state.favorites.push(favorite);
            return respond({ favorite }, 201);
        }
        if (pathname === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-22', dueToday: 1, dueNow: 1,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 1, newToday: 1, totalWords: 2,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (pathname === '/api/review/words' && method === 'GET') {
            // 状态 filter + 已掌握 reads: both are empty for a word-list-only deck.
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
        }
        if (pathname === '/api/review/words' && method === 'POST') {
            const body = request.postDataJSON() || {};
            state.reviewPosts.push(body);
            return respond({ status: 'ok', created: true, word: word(body.lemma, body.definition ?? null) });
        }
        if (pathname === '/api/review/words' && method === 'PATCH') {
            const body = request.postDataJSON() || {};
            state.masteredPatches.push(body);
            return respond({ status: 'ok', word: { ...word(body.lemma, null), mastered: body.mastered === true } });
        }
        if (pathname === '/api/review/queue' && method === 'GET') {
            state.queueCalls += 1;
            const items = state.reviewQueue || [
                word('abundant', '词表快照：丰富的；充裕的', 0),
                word('candid', null, 1),
            ];
            return respond({
                targetLang: 'zh-CN',
                now: Date.now(),
                limit: 20,
                newLimit: 10,
                counts: { due: 1, new: items.length - 1, total: items.length },
                due: [items[0]],
                new: items.slice(1),
                items,
            });
        }
        if (pathname === '/api/review/answer' && method === 'POST') {
            const body = request.postDataJSON() || {};
            return respond({
                status: 'ok',
                word: word(body.lemma, null),
                suspended: false,
                autoSuspended: false,
                dueAt: Date.now() + 86400000,
            });
        }
        if (pathname === '/api/review/suspended' && method === 'GET') {
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
        }
        if (pathname === '/api/define' && method === 'POST') {
            state.defineCalls += 1;
            const body = request.postDataJSON() || {};
            return respond({
                word: body.word,
                ipa: '/ˈkændɪd/',
                pos: 'adj',
                pos_label: '形容词',
                zh: '来自词典的释义',
                definition_en: 'open and honest',
                example: 'A candid remark.',
            });
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
            return respond({
                items: [], total: 0, page: 1, pageSize: 50, hasMore: false,
            });
        }
        if (pathname === '/api/vocabulary/level') return respond({});
        if (pathname === '/api/vocabulary/seen') return respond({});

        // ── custom word lists under test (specs/038 §5) ───────────────────
        if (pathname === '/api/wordlists' && method === 'GET') {
            state.wordlistCalls += 1;
            return respond({ lists: state.lists.map(listMeta) });
        }
        if (pathname === '/api/wordlists' && method === 'POST') {
            // Not part of the contract; the wizard uses /import.
            return fail(404, 'use /api/wordlists/import');
        }
        if (pathname === '/api/wordlists/import' && method === 'POST') {
            const body = request.postDataJSON() || {};
            state.importBodies.push(body);
            const list = {
                id: 'wl-imported',
                name: String(body.name || ''),
                createdAt: Date.now(),
                items: (body.items || []).map((item) => ({
                    word: item.word,
                    translation: item.translation ?? null,
                    phonetic: item.phonetic ?? null,
                    cefr: item.cefr ?? null,
                    example: item.example ?? null,
                })),
            };
            state.lists.push(list);
            return respond({ list: listMeta(list), skipped: 0 }, 201);
        }
        const itemsMatch = pathname.match(/^\/api\/wordlists\/([^/]+)\/items$/);
        if (itemsMatch) {
            const id = decodeURIComponent(itemsMatch[1]);
            const list = state.lists.find((entry) => entry.id === id);
            if (!list) return fail(404, 'wordlist not found');
            if (method === 'DELETE') {
                const body = request.postDataJSON() || {};
                const ids = Array.isArray(body.itemIds) ? body.itemIds : [];
                state.itemDeletes.push({ id, ids });
                if (state.failItemDelete && ids.includes(state.failItemDelete)) {
                    return fail(500, 'items delete failed');
                }
                list.items = list.items.filter((item) => !ids.includes(item.id));
                return respond({ deleted: ids.length, itemCount: list.items.length });
            }
        }
        // P2-29: CEFR backfill — fills blank rows, never overwrites, leaves
        // C1+ (here sesquipedalian) blank so the auto call stays one-shot.
        const backfillMatch = pathname.match(/^\/api\/wordlists\/([^/]+)\/backfill-cefr$/);
        if (backfillMatch && method === 'POST') {
            const id = decodeURIComponent(backfillMatch[1]);
            const list = state.lists.find((entry) => entry.id === id);
            if (!list) return fail(404, 'wordlist not found');
            const levels = { abandon: 'B1', the: 'A1' };
            let updated = 0;
            for (const item of list.items) {
                if (!item.cefr && levels[item.word]) {
                    item.cefr = levels[item.word];
                    updated += 1;
                }
            }
            state.backfillCalls.push({ id, updated });
            const remaining = list.items.filter((item) => !item.cefr).length;
            return respond({ updated, total: list.items.length, remaining });
        }
        const pageMatch = pathname.match(/^\/api\/wordlists\/([^/]+)$/);
        if (pageMatch) {
            const id = decodeURIComponent(pageMatch[1]);
            const list = state.lists.find((entry) => entry.id === id);
            if (!list) return fail(404, 'wordlist not found');
            if (method === 'PATCH') {
                const body = request.postDataJSON() || {};
                const name = String(body.name ?? '').trim();
                if (!name) return fail(400, 'name required');
                list.name = name;
                state.renames.push({ id, name });
                return respond({ list: listMeta(list) });
            }
            if (method === 'DELETE') {
                state.deletes.push(id);
                state.lists = state.lists.filter((entry) => entry.id !== id);
                return respond({ status: 'ok', deleted: true });
            }
            if (method === 'GET') {
                const page = Math.max(1, Number(url.searchParams.get('page') || 1));
                const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
                const q = (url.searchParams.get('q') || '').trim().toLowerCase();
                const filtered = q
                    ? list.items.filter((item) => (
                        item.word.toLowerCase().includes(q)
                        || String(item.translation || '').toLowerCase().includes(q)
                    ))
                    : list.items;
                const start = (page - 1) * pageSize;
                return respond({
                    id: list.id,
                    name: list.name,
                    items: filtered.slice(start, start + pageSize),
                    total: filtered.length,
                    page,
                    pageSize,
                    hasMore: start + pageSize < filtered.length,
                });
            }
        }

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

/** Class of the row container (the tested element is the inner grid row). */
const rowTone = (page, word, testId = 'vocab-custom-row') => page
    .locator(`[data-testid="${testId}"][data-word="${word}"]`)
    .first()
    .evaluate((el) => el.parentElement?.className ?? '');

/** P0-16: download one export and read the file Playwright saved. */
const grabDownload = async (page, testId) => {
    const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: 15000 }),
        page.getByTestId(testId).click(),
    ]);
    const path = await download.path();
    assert.ok(path, `${testId} produced a file`);
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

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const state = createState();
const { context, page, pageErrors } = await newContext(browser, state);

// ── A) tab order: custom lists appended after every built-in tab ─────────
await gotoWordbook(page);
await page.getByTestId('vocab-tab-custom-wl-1').waitFor({ timeout: 15000 });
const tabOrder = await page.$$eval(
    '[role="tab"][data-testid^="vocab-tab-"]',
    (nodes) => nodes.map((node) => node.getAttribute('data-testid')),
);
assert.deepEqual(
    tabOrder,
    [
        'vocab-tab-mine', 'vocab-tab-mastered', 'vocab-tab-phrases',
        'vocab-tab-cefr', 'vocab-tab-gre', 'vocab-tab-cet4', 'vocab-tab-cet6',
        'vocab-tab-custom-wl-1', 'vocab-tab-custom-wl-2', 'vocab-tab-custom-wl-3',
        'vocab-tab-custom-wl-4',
    ],
    `custom tabs must follow the built-in tabs: ${tabOrder.join(' / ')}`,
);
assert.ok(state.wordlistCalls >= 1, 'the catalog must be fetched');
assert.equal(
    (await page.getByTestId('vocab-tab-custom-wl-1').innerText()).startsWith('旅行词汇'),
    true,
    'a custom tab shows its name',
);
assert.equal(await page.getByTestId('vocab-tab-count-custom-wl-1').innerText(), '2');
// P0-10 §3: the favorites surface is called 我的收藏 (route/tab id stays `mine`).
assert.equal((await page.getByTestId('vocab-tab-mine').innerText()).startsWith('我的收藏'), true);

// ── B) import wizard: file → map/preview/stats → name/confirm ────────────
await page.getByTestId('vocab-import-button').click();
await page.getByTestId('wordlist-import-dialog').waitFor();
assert.equal(await page.getByTestId('wordlist-import-steps').isVisible(), true);

// B0) client-side limits are enforced before reading/uploading: >2 MB file…
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'huge.csv',
    mimeType: 'text/csv',
    buffer: Buffer.alloc(2 * 1024 * 1024 + 1, 0x61),
});
await page.locator('[role="alert"]', { hasText: '超过 2 MB' }).waitFor({ timeout: 5000 });
assert.equal(state.importBodies.length, 0);

// …and a file whose rows are mostly not English is blocked at step 2.
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'not-words.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('word,translation\n中文,一\n日本語,二\n', 'utf8'),
});
await page.getByTestId('wordlist-import-blocked').waitFor({ timeout: 10000 });
assert.match(await page.getByTestId('wordlist-import-blocked').innerText(), /不是英文词表/);
assert.equal(await page.getByTestId('wordlist-import-next').isDisabled(), true);
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-browse').waitFor();

// B0b) cancel has zero side effects; the wizard resets on the next open.
await page.getByTestId('wordlist-import-cancel').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });
assert.equal(state.importBodies.length, 0);
await page.getByTestId('vocab-import-button').click();
await page.getByTestId('wordlist-import-dialog').waitFor();

// B0c) TSV + Tab detection (the Anki plain-text path).
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'anki.tsv',
    mimeType: 'text/tab-separated-values',
    buffer: Buffer.from('word\ttranslation\ncandid\t坦率的\n', 'utf8'),
});
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 10000 });
assert.match(await page.getByTestId('wordlist-import-dialog').innerText(), /分隔符：制表符（Tab）/);
assert.equal(await page.getByTestId('wordlist-import-map-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-map-translation').inputValue(), '1');
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-browse').waitFor();

// B0d) RFC 4180: a newline inside a quoted field is part of the value, not a
// new row (one data record, one valid entry).
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'quoted.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('word,translation\n"lucid","清晰的\n释义"\n', 'utf8'),
});
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 10000 });
assert.equal(
    await page.getByTestId('wordlist-import-stats').innerText(),
    '共 1 行 · 有效 1 · 跳过 0',
);
assert.match(await page.getByTestId('wordlist-import-dialog').innerText(), /清晰的\s*释义/);
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-browse').waitFor();

// B0e) >10000 rows is rejected before the preview/upload.
const tooMany = ['word', ...Array.from({ length: 10001 }, (_, index) => `word${index}`)].join('\n');
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'huge-rows.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(tooMany, 'utf8'),
});
await page.locator('[role="alert"]', { hasText: '超过 10000 行' }).waitFor({ timeout: 10000 });
assert.equal(state.importBodies.length, 0);
assert.equal(await page.getByTestId('wordlist-import-importing').count(), 0);

const CSV = [
    'word,translation,phonetic,cefr,example',
    '"abundant","丰富的, 充裕的","/əˈbʌndənt/","B2","The region has abundant rainfall."',
    ',空释义,,,,',
    '中文释义,,,,',
    'abundant,重复释义,,,,',
    "don't,不要,,,",
].join('\n');
// The final upload goes through the drag/drop path (the file-picker path is
// already covered by the TSV / invalid-file steps above).
await page.evaluate(({ fileName, body }) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([body], fileName, { type: 'text/csv' }));
    const zone = document.querySelector('[data-testid="wordlist-import-dropzone"]');
    for (const type of ['dragenter', 'dragover', 'drop']) {
        zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
    }
}, { fileName: 'My words.csv', body: CSV });
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 10000 });

// Auto header + column mapping.
assert.equal(await page.getByTestId('wordlist-import-map-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-map-translation').inputValue(), '1');
assert.equal(await page.getByTestId('wordlist-import-map-phonetic').inputValue(), '2');
assert.equal(await page.getByTestId('wordlist-import-map-cefr').inputValue(), '3');
assert.equal(await page.getByTestId('wordlist-import-map-example').inputValue(), '4');
assert.match(await page.getByTestId('wordlist-import-header-note').innerText(), /已识别表头/);

// Preview shows the first 5 rows (mapped columns).
assert.equal(await page.getByTestId('wordlist-import-preview-title').count(), 1);
assert.match(await page.getByTestId('wordlist-import-file-name').innerText(), /My words\.csv/);

// Live stats: 5 data rows, 2 valid, 3 skipped, with per-row reasons.
const statsText = await page.getByTestId('wordlist-import-stats').innerText();
assert.match(statsText, /共\s*5\s*行/);
assert.match(statsText, /有效\s*2/);
assert.match(statsText, /跳过\s*3/);
const skipText = await page.getByTestId('wordlist-import-dialog').innerText();
assert.match(skipText, /第 3 行：单词为空/);
assert.match(skipText, /第 4 行：不是英文单词/);
assert.match(skipText, /第 5 行：与前面的词重复/);
await page.screenshot({ path: `${SHOTS}/custom-wordlists-wizard-1440.png`, fullPage: false });

// Step 3: same-name collision gets the automatic "(2)" suffix.
await page.getByTestId('wordlist-import-next').click();
await page.getByTestId('wordlist-import-name').waitFor();
assert.equal(await page.getByTestId('wordlist-import-name').inputValue(), 'My words');
assert.match(await page.getByTestId('wordlist-import-rename').innerText(), /My words \(2\)/);
assert.match(await page.getByTestId('wordlist-import-summary').innerText(), /2 个词/);
await page.getByTestId('wordlist-import-submit').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden', timeout: 10000 });
assert.equal(state.importBodies.length, 1);
const importBody = state.importBodies[0];
assert.equal(importBody.name, 'My words (2)');
assert.equal(importBody.filename, 'My words.csv');
assert.equal(importBody.items.length, 2);
assert.equal(importBody.items[0].word, 'abundant');
assert.equal(importBody.items[0].translation, '丰富的, 充裕的');
assert.equal(importBody.items[1].word, "don't");

// ── C) the new tab appears at the end and becomes active ─────────────────
await page.getByTestId('vocab-tab-custom-wl-imported').waitFor({ timeout: 10000 });
assert.equal(
    await page.getByTestId('vocab-tab-custom-wl-imported').getAttribute('aria-selected'),
    'true',
);
assert.equal(await page.$$eval('[data-testid="vocab-custom-row"]', (rows) => rows.length), 2);

// ── C2) P2-29 legacy CEFR backfill: opening an old list fills blanks once ──
// The list was imported before auto-CEFR (two blanks). Opening it must POST
// /backfill-cefr once, reload, and show the new badges. A null CEFR means the
// word is outside the 10k list (= C1+) and must render as a C1+ badge.
const backfillBefore = state.backfillCalls.length;
await page.getByTestId('vocab-tab-custom-wl-4').click();
await page.getByTestId('vocab-custom-list').waitFor();
await page.waitForFunction(() => (
    document.querySelector('[data-testid="vocab-custom-level-abandon"]')?.textContent?.trim() === 'B1'
), null, { timeout: 10000 });
assert.equal(await page.getByTestId('vocab-custom-level-the').innerText(), 'A1');
assert.equal(await page.getByTestId('vocab-custom-level-candid').innerText(), 'A2',
    'an existing CEFR is kept even when the frequency table would say B1');
assert.equal(await page.getByTestId('vocab-custom-level-sesquipedalian').innerText(), 'C1+',
    'a null CEFR (outside the 10k list) renders as C1+, never —');
assert.equal(await page.getByTestId('vocab-custom-level-sesquipedalian').getAttribute('title'),
    '不在词表（C1+）');
assert.deepEqual(state.backfillCalls.slice(backfillBefore), [{ id: 'wl-4', updated: 2 }],
    'the auto backfill runs exactly once for the opened legacy list');
// Re-opening the same list must not fire a second auto backfill (ref marker).
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
await page.getByTestId('vocab-tab-custom-wl-4').click();
await page.getByTestId('vocab-custom-list').waitFor();
await page.waitForTimeout(400);
assert.equal(state.backfillCalls.length, backfillBefore + 1,
    'the one-shot marker prevents a C1+ row from looping the auto call');

// P2-29: C1+ is a first-class level on custom lists — level filter includes it.
await page.getByTestId('vocab-custom-filter').click();
await page.getByTestId('vocab-custom-filter-menu').waitFor();
assert.equal(await page.getByTestId('vocab-custom-level-c1plus').count(), 1,
    'the custom level filter offers C1+');
await page.getByTestId('vocab-custom-level-c1plus').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
assert.equal(await page.getByTestId('vocab-custom-row').getAttribute('data-word'), 'sesquipedalian',
    'the C1+ filter shows exactly the words without an A1–C1 match');
// The active-filter clear chip resets it (and proves C1+ is a normal filter).
await page.getByTestId('vocab-custom-clear-filters').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 4);
assert.equal(await page.getByTestId('vocab-custom-clear-filters').count(), 0,
    'clearing the filter removes the clear chip');

// Sorting by level puts C1+ after C1 (A1 → A2 → B1 → C1 → C1+).
await page.getByTestId('vocab-custom-sort').click();
await page.getByTestId('vocab-custom-sort-menu').waitFor();
await page.getByTestId('vocab-custom-sort-level').click();
await page.waitForFunction(() => (
    document.querySelector('[data-testid="vocab-custom-row"]')?.getAttribute('data-word') === 'the'
));
assert.deepEqual(
    await page.$$eval('[data-testid="vocab-custom-row"]', (rows) => rows.map((row) => row.getAttribute('data-word'))),
    ['the', 'candid', 'abandon', 'sesquipedalian'],
    'level sort keeps C1+ last',
);
// The export prints the same C1+ label (null rows are not left blank).
const cefrCsv = await grabDownload(page, 'vocab-custom-export-csv');
const cefrLine = cefrCsv.text.split('\n').find((line) => line.startsWith('"sesquipedalian"'));
assert.ok(cefrLine && cefrLine.endsWith('"C1+"'), `the C1+ export cell is C1+: ${cefrLine}`);
await page.getByTestId('vocab-custom-sort').click();
await page.getByTestId('vocab-custom-sort-menu').waitFor();
await page.getByTestId('vocab-custom-sort-alpha').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 4);
await page.screenshot({ path: `${SHOTS}/p2-29-cefr-backfill-1440.png`, fullPage: false });

// ── D) star-only favorite + 标为已掌握 on a custom list (shared WordTable) ─
await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.getByTestId('vocab-custom-list').waitFor();

// The shared row: 原词 / 音标 / 释义 / 发音 / 等级 / 星标 / 展开. No ×N column.
for (const [suffix, text] of [
    ['word-abundant', 'abundant'],
    ['ipa-abundant', '/əˈbʌndənt/'],
    ['translation-abundant', '丰富的；充裕的'],
    ['level-abundant', 'B2'],
]) {
    assert.equal((await page.getByTestId(`vocab-custom-${suffix}`).innerText()).trim(), text);
}
assert.equal(await page.locator('[data-testid^="vocab-custom-seen-"]').count(), 0,
    'custom lists must not render the ×N column');
assert.equal(await page.getByTestId('vocab-custom-star-abundant').getAttribute('aria-pressed'), 'false');
// P0-10 §2: every custom-list row carries the 已掌握 check beside the star;
// with no state the row keeps the default surface.
assert.equal(await page.getByTestId('vocab-custom-master-toggle-abundant').count(), 1);
assert.equal(await page.getByTestId('vocab-custom-master-toggle-abundant').getAttribute('aria-pressed'), 'false');
assert.equal(await page.getByTestId('vocab-custom-master-toggle-abundant').getAttribute('aria-label'), '已掌握 abundant');
assert.doesNotMatch(await rowTone(page, 'abundant'), /bg-(success|warning)\/10/,
    'a word with no state keeps the default row surface');

// P0-09: the expanded area never carries 加入我的单词 — marked words, unmarked
// words, any state (the star is the only favorite switch). No disabled 「已加入」
// variant either; just 完整释义 / 来源 / 等级.
await page.getByTestId('vocab-custom-expand-abundant').click();
await page.getByTestId('vocab-custom-detail-abundant').waitFor();
assert.equal(await page.getByTestId('wl-1:abundant-add-mine').count(), 0,
    '未收藏的自定义词表行不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-abundant').innerText(), /加入我的单词|已加入/,
    'the unfavorited expanded row carries no favorite action');
assert.equal(await page.getByTestId('wl-1:abundant-add-review').count(), 0,
    '加入复习 must be hidden on a custom-list row while the review UI is paused');

// Star = the only favorite toggle. Two clicks in the same tick must POST once
// (the busy guard disables the star after the first click) and must not turn
// into a DELETE.
const postsBefore = state.favorites.length;
await page.getByTestId('vocab-custom-star-abundant').evaluate((el) => { el.click(); el.click(); });
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-star-abundant"]')?.getAttribute('aria-pressed') === 'true');
await page.waitForTimeout(400);
assert.equal(state.favorites.length, postsBefore + 1, 'a double click still sends exactly one POST');
assert.equal(state.favoriteDeletes.length, 0, 'a double click must not turn into a DELETE');
assert.equal(await page.getByTestId('vocab-custom-star-abundant').getAttribute('aria-pressed'), 'true');
// P0-10 §4: a favorited custom-list row is tinted warning.
assert.match(await rowTone(page, 'abundant'), /bg-warning\/10/,
    'a favorited custom-list row is tinted warning');
assert.equal(await page.getByTestId('wl-1:abundant-add-mine').count(), 0,
    '已收藏的行也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-abundant').innerText(), /加入我的单词|已加入/,
    'the favorited expanded row still carries no favorite action');

// P1-22 手风琴：展开另一行 → 上一行自动收起；再点当前行 → 收起。
await page.getByTestId('vocab-custom-expand-candid').click();
await page.getByTestId('vocab-custom-detail-candid').waitFor();
assert.equal(await page.getByTestId('vocab-custom-detail-abundant').count(), 0,
    '展开另一行时，上一行自动收起');
assert.equal(await page.locator('[data-testid^="vocab-custom-detail-"]').count(), 1,
    '自定义词表同一时刻只有一行展开');
await page.getByTestId('vocab-custom-expand-candid').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-custom-detail-"]').length === 0);
assert.equal(await page.getByTestId('vocab-custom-expand-candid').evaluate((el) => el.closest('[aria-expanded]')?.getAttribute('aria-expanded') ?? null), 'false',
    '再点同一行收起');
const savedAbundant = state.favorites.find((fav) => fav.en_text === 'abundant');
assert.equal(savedAbundant.id, 'vocab-fav-abundant');
assert.equal(savedAbundant.source_kind, 'wordlist');
assert.equal(savedAbundant.source_ref, 'wl-1');
assert.equal(savedAbundant.source_title, '旅行词汇');
assert.equal(savedAbundant.example, 'The region has abundant rainfall.');
assert.equal(savedAbundant.zh_text, '/əˈbʌndənt/ 丰富的；充裕的');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-star-only-1440.png`, fullPage: false });

// Star = DELETE on unstar (mock favorites list is the server record).
await page.getByTestId('vocab-custom-star-candid').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-star-candid"][aria-pressed="true"]').length === 1);
assert.equal(state.favorites.length, 2);
const starred = state.favorites.find((fav) => fav.en_text === 'candid');
assert.equal(starred.source_ref, 'wl-1');
assert.equal(starred.example, 'She gave a candid answer.');
await page.getByTestId('vocab-custom-star-candid').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-star-candid"][aria-pressed="false"]').length === 1);
assert.equal(state.favorites.length, 1, 'unstarring removes the favorite record');
assert.equal(state.favoriteDeletes.length, 1, 'unstarring DELETEs the favorite');
assert.equal(state.favoriteDeletes[0], 'vocab-fav-candid');
assert.doesNotMatch(await rowTone(page, 'candid'), /bg-(success|warning)\/10/,
    'unstarring clears the tint');

// P0-10: the row check is the only 已掌握 toggle (PATCH with the list as
// contentRef); the expanded text action is gone. Marking tints the row green
// and disables the star; unchecking clears both and refills no favorite.
await page.getByTestId('vocab-custom-expand-candid').click();
await page.getByTestId('vocab-custom-detail-candid').waitFor();
assert.equal(await page.getByTestId('wl-1:candid-master').count(), 0,
    'the expanded area no longer carries a mastered text action');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-candid').innerText(),
    /我已掌握|标为已掌握|取消已掌握/,
    'no text mastered action in the expanded area (P0-10)');
const candidCheck = page.getByTestId('vocab-custom-master-toggle-candid');
assert.equal(await candidCheck.getAttribute('aria-pressed'), 'false');
await candidCheck.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-master-toggle-candid"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(state.masteredPatches.length, 1);
assert.equal(state.masteredPatches[0].mastered, true);
assert.equal(state.masteredPatches[0].lemma, 'candid');
assert.equal(state.masteredPatches[0].source.contentRef, 'wl-1');
assert.equal(await page.getByTestId('vocab-custom-master-toggle-candid').getAttribute('aria-label'),
    '取消已掌握 candid');
assert.match(await rowTone(page, 'candid'), /bg-success\/10/,
    'a mastered custom-list row is tinted success');
assert.equal(await page.getByTestId('vocab-custom-star-candid').isDisabled(), true,
    'a mastered row disables its star');
await page.screenshot({ path: `${SHOTS}/p0-10-1440-custom-mastered.png`, fullPage: false });
// Pressed check → unmark: the row loses the tint, the star returns, no favorite.
await candidCheck.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-master-toggle-candid"]')?.getAttribute('aria-pressed') === 'false');
await page.waitForTimeout(200);
assert.equal(state.masteredPatches.length, 2, 'unchecking sends the second PATCH');
assert.equal(state.masteredPatches[1].mastered, false);
assert.equal(await page.getByTestId('vocab-custom-star-candid').isDisabled(), false);
assert.doesNotMatch(await rowTone(page, 'candid'), /bg-(success|warning)\/10/,
    'unmarking clears the tint');
assert.equal(state.favoriteDeletes.length, 1, 'unmarking never refills the favorite');

// ── D2) 隐藏中文 reuses the shared WordTable behavior ────────────────────
assert.equal(await page.locator('[data-testid^="vocab-custom-translation-"]').count(), 2);
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.locator('[data-testid^="vocab-custom-translation-"]').count(), 0);
await page.locator('[data-testid="vocab-custom-row"]').first().click();
assert.equal(await page.locator('[data-testid^="vocab-custom-translation-"]').count(), 1);
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.locator('[data-testid^="vocab-custom-translation-"]').count(), 2);

// ── E) client search + shared pager (每页 20/50/100 + 跳至) ──────────────
await page.getByTestId('vocab-custom-search').fill('abund');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
assert.equal(await page.getByTestId('vocab-custom-total').innerText(), '找到 1 词');
await page.getByTestId('vocab-custom-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 2);

// P1-22：切 tab 清空展开。§D2 的行点击（隐藏中文）已经把 abundant 展开且
// 仍在单开状态里；先确认它，再收起/重开一次，最后用切 tab 验证清空。
assert.equal(await page.getByTestId('vocab-custom-detail-abundant').count(), 1,
    'D2 展开的行保持在单开手风琴里');
await page.getByTestId('vocab-custom-expand-abundant').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid^="vocab-custom-detail-"]').length === 0);
await page.getByTestId('vocab-custom-expand-abundant').click();
await page.getByTestId('vocab-custom-detail-abundant').waitFor();
await page.getByTestId('vocab-tab-custom-wl-2').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50);
assert.equal(await page.locator('[data-testid^="vocab-custom-detail-"]').count(), 0,
    '切 tab 清空展开');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 2 页');
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-20').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 20);
assert.equal(await page.getByTestId('vocab-page-size').innerText(), '每页 20');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 1 / 3 页');
await page.getByTestId('vocab-page-jump').fill('2');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 20
    && document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 2 / 3 页');
await page.getByTestId('vocab-page-size').click();
await page.getByTestId('vocab-page-size-menu').waitFor();
await page.getByTestId('vocab-page-size-50').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50);
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 10);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 2 / 2 页');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-1440.png`, fullPage: false });

// ── E1b) P0-16 export: word / phonetic / translation / level, current view ─
// wl-2 has 60 items in two client pages; exporting from page 2 must still write
// all 60, and the current search must narrow the file. Non-ASCII list names
// fall back to the list id in the file name (`custom-wl-2`).
assert.equal(await page.getByTestId('vocab-custom-export-tsv').isVisible(), true,
    '自定义词表 toolbar has the TSV export');
assert.equal(await page.getByTestId('vocab-custom-export-csv').isVisible(), true,
    '自定义词表 toolbar has the CSV export');
const customCsv = await grabDownload(page, 'vocab-custom-export-csv');
assert.equal(customCsv.hasBom, true, 'the export carries a UTF-8 BOM');
assert.equal(customCsv.filename, `lingua-nova-custom-wl-2-${stamp()}.csv`);
const customCsvLines = customCsv.text.split('\n');
assert.equal(customCsvLines[0], '"单词","音标","中文释义","等级"',
    'CSV columns: word / phonetic / translation / level');
assert.equal(customCsvLines.length, 61, 'CSV = header + all 60 items (both client pages)');
assert.equal(customCsvLines[1], '"word001","/wɜːd1/","释义 1","B1"',
    'the export follows the current alphabetical order');
const customTsv = await grabDownload(page, 'vocab-custom-export-tsv');
assert.equal(customTsv.filename, `lingua-nova-custom-wl-2-${stamp()}.tsv`);
const customTsvLines = customTsv.text.split('\n');
assert.equal(customTsvLines.length, 60, 'TSV is headerless and holds all 60 items');
assert.equal(customTsvLines[0], 'word001\t/wɜːd1/\t释义 1\tB1');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="toast"]').length === 0,
    null, { timeout: 12000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/p0-16-1440-custom-export.png`, fullPage: false });
// The export respects the current custom search.
await page.getByTestId('vocab-custom-search').fill('word060');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
const filteredCustomCsv = await grabDownload(page, 'vocab-custom-export-csv');
assert.equal(filteredCustomCsv.text.split('\n').length, 2,
    'the custom export follows the current search');
await page.getByTestId('vocab-custom-search-clear').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-total"]')?.textContent === '共 60 词');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50);
// E2 starts from page 2 (the search above restarted at page 1).
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 2 / 2 页'
    && document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 10);

// ── E2) P0-15 select-all across the two client-paged custom-list pages ────
// wl-2 holds 60 items → two 50/page pages. 全选 must select all 60, not the
// visible 10 on page 2; the selection then survives paging and a cross-page
// batch must operate on the unrendered row too.
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]').count(), 0,
    'non-edit custom list renders no row checkboxes');
await page.getByTestId('vocab-custom-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
const customSelectAll = page.getByTestId('vocab-select-all-custom');
assert.equal(await customSelectAll.count(), 1, 'editing renders the header select-all checkbox');
assert.equal(await customSelectAll.isChecked(), false, 'default: nothing selected');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0');
assert.equal((await page.getByTestId('vocab-edit-result-total').innerText()).trim(), '结果 60');
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 2 / 2 页');

await customSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 60');
assert.equal(await customSelectAll.isChecked(), true);
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]:checked').count(), 10,
    'all 10 visible rows on page 2 are checked');
await page.screenshot({ path: `${SHOTS}/p0-15-1440-custom-select-all.png`, fullPage: false });

// Page 1 reflects the same cross-page selection; the count stays 60.
await page.getByTestId('vocab-page-jump').fill('1');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 1 / 2 页');
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]:checked').count(), 50);
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 60');

// Partial → indeterminate; header again → all; header again (all) → clear.
await page.getByTestId('vocab-custom-select-it-word-1').uncheck();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 59');
assert.equal(await customSelectAll.isChecked(), false);
assert.equal(await customSelectAll.evaluate((el) => el.indeterminate), true,
    'a partial selection renders the header indeterminate');
await customSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 60');
assert.equal(await customSelectAll.evaluate((el) => el.indeterminate), false);
await customSelectAll.click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');

// Cross-page batch: 删除词条 for one row on page 1 and one row on page 2.
// After paging back to page 1 only that page is rendered, so the page-2 item
// proves the key→row map (not the DOM) drives the batch.
await page.getByTestId('vocab-custom-select-it-word-2').check();
await page.getByTestId('vocab-page-jump').fill('2');
await page.getByTestId('vocab-page-jump-go').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-page-status"]')?.textContent === '第 2 / 2 页');
await page.getByTestId('vocab-custom-select-it-word-60').check();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 2');
await page.getByTestId('vocab-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
assert.match(await page.getByTestId('vocab-custom-items-delete').innerText(), /删除选中的 2 个词条/);
await page.getByTestId('vocab-custom-items-delete-confirm').click();
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden', timeout: 10000 });
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 0');
assert.deepEqual(state.itemDeletes.slice(-2).flatMap((entry) => entry.ids),
    ['it-word-2', 'it-word-60'],
    'the batch deleted both the earlier page and the currently rendered page');
assert.equal((await page.getByTestId('vocab-tab-count-custom-wl-2').innerText()).trim(), '58');
assert.equal((await page.getByTestId('vocab-edit-result-total').innerText()).trim(), '结果 58');
// The success toast covers the sticky bar; dispatch the click directly.
await page.getByTestId('vocab-edit-done').evaluate((el) => el.click());
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.getByTestId('vocab-select-all-custom').count(), 0,
    'non-edit state renders no select-all checkbox at all');

// ── F) edit mode on every list + 自定义词表 matrix + 重命名 + delete-table ──
// P0-14: every word list exposes 编辑, but the checkboxes only exist while
// editing. 自定义词表 adds 删除词条 (ConfirmDialog) to 加入收藏 / 标为已掌握.
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
assert.equal(await page.getByTestId('vocab-mine-edit').isVisible(), true,
    '我的收藏 also exposes 编辑');
assert.equal(await page.locator('[data-testid^="vocab-mine-select-"]').count(), 0,
    'the default (non-edit) state renders no checkboxes');
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0);
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-empty"]');
assert.equal(await page.getByTestId('vocab-list-edit').isVisible(), true,
    '内置词表 exposes 编辑 even on its empty state');
assert.equal(await page.locator('[data-testid^="vocab-list-select-"]').count(), 0);

await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.getByTestId('vocab-custom-list').waitFor();
assert.equal(await page.getByTestId('vocab-custom-edit').isVisible(), true);
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]').count(), 0,
    'the custom list hides its checkboxes until 编辑');
await page.getByTestId('vocab-custom-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
assert.equal((await page.getByTestId('vocab-custom-edit').innerText()).trim(), '完成',
    'the toolbar button switches to 完成');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0');
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]').count(), 2,
    'edit mode adds one checkbox per row');
// Clicking the row toggles the selection and never expands it.
await page.locator('[data-testid="vocab-custom-row"][data-word="candid"]').click();
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 1');
assert.equal(await page.getByTestId('vocab-custom-detail-candid').count(), 0,
    'row click selects instead of expanding while editing');
assert.equal(await page.getByTestId('vocab-custom-star-candid').isDisabled(), true,
    'the star is disabled while editing');
assert.equal(await page.getByTestId('vocab-custom-master-toggle-candid').isDisabled(), true,
    'the mastered check is disabled while editing');
await page.locator('[data-testid="vocab-custom-row"][data-word="candid"]').click();
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0');
await page.screenshot({ path: `${SHOTS}/p0-14-custom-edit-1440.png`, fullPage: false });

// 加入收藏 runs row by row; the selection clears on success.
await page.getByTestId('vocab-custom-select-it-candid').check();
const customFavBefore = state.favorites.length;
await page.getByTestId('vocab-edit-favorite').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-star-candid"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(state.favorites.length, customFavBefore + 1);
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0',
    'a successful batch row leaves the selection');
const customFav = state.favorites.find((fav) => fav.en_text === 'candid');
assert.equal(customFav.source_kind, 'wordlist');
assert.equal(customFav.source_ref, 'wl-1');
assert.equal(customFav.source_title, '旅行词汇');

// 标为已掌握 runs row by row: PATCH + favorite removal (mutual exclusion).
await page.getByTestId('vocab-custom-select-it-candid').check();
await page.getByTestId('vocab-edit-master').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-custom-master-toggle-candid"]')?.getAttribute('aria-pressed') === 'true');
assert.equal(state.masteredPatches.at(-1).mastered, true);
assert.match(await rowTone(page, 'candid'), /bg-success\/10/);
assert.equal(await page.getByTestId('vocab-custom-star-candid').getAttribute('aria-pressed'), 'false');
assert.equal(state.favoriteDeletes.includes('vocab-fav-candid'), true,
    'marking mastered removes the batch-created favorite');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 0');

// 删除词条 needs the ConfirmDialog and executes per row: a failed row stays
// selected with its own error and the bar reports 「N 项失败」.
await page.getByTestId('vocab-custom-select-it-abundant').check();
await page.getByTestId('vocab-custom-select-it-candid').check();
state.failItemDelete = 'it-abundant';
const itemDeletesBefore = state.itemDeletes.length;
await page.getByTestId('vocab-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
assert.match(await page.getByTestId('vocab-custom-items-delete').innerText(), /删除选中的 2 个词条/);
assert.match(await page.getByTestId('vocab-custom-items-delete').innerText(), /只从这张词表删除/);
await page.getByTestId('vocab-custom-items-delete-cancel').click();
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden' });
assert.equal(state.itemDeletes.length, itemDeletesBefore, 'cancel keeps both selected rows');
await page.getByTestId('vocab-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
await page.getByTestId('vocab-custom-items-delete-confirm').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden', timeout: 5000 });
assert.deepEqual(
    state.itemDeletes.slice(itemDeletesBefore).map((entry) => entry.ids).flat(),
    ['it-abundant', 'it-candid'],
);
assert.equal(await page.getByTestId('vocab-custom-edit-error-it-abundant').count(), 1,
    'the failed row keeps its inline error');
assert.equal(await page.getByTestId('vocab-edit-summary').innerText(), '1 项失败，失败项仍在已选中。');
assert.equal((await page.getByTestId('vocab-edit-selected').innerText()).trim(), '已选 1',
    'the failed row stays selected');
assert.equal(await page.getByTestId('vocab-tab-count-custom-wl-1').innerText(), '1',
    'the tab count follows the itemCount returned by the server');
state.failItemDelete = null;
await page.getByTestId('vocab-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
await page.getByTestId('vocab-custom-items-delete-confirm').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-custom-row"]'));
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden', timeout: 5000 });
assert.equal(await page.getByTestId('vocab-tab-count-custom-wl-1').count(), 0,
    'a zero itemCount renders no tab badge');
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 0 词');
assert.equal(await page.getByTestId('vocab-edit-summary').count(), 0,
    'a clean retry clears the failure summary');
assert.equal(state.favorites.length, 1, 'deleting rows keeps the saved favorite');

// 完成 exits editing and clears the selection; switching tabs does the same.
await page.getByTestId('vocab-edit-done').click();
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.getByTestId('vocab-custom-edit').isVisible(), true);
await page.getByTestId('vocab-custom-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
await page.getByTestId('vocab-tab-gre').click();
await page.waitForSelector('[data-testid="vocab-empty"]');
await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.waitForSelector('[data-testid="vocab-custom-empty"]');
assert.equal(await page.getByTestId('vocab-edit-bar').count(), 0, 'switching tabs exits edit mode');
assert.equal((await page.getByTestId('vocab-custom-edit').innerText()).trim(), '编辑');
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]').count(), 0);

// 重命名 from the list menu: the tab label follows the PATCH response.
await page.getByTestId('vocab-custom-menu-trigger').click();
await page.getByTestId('vocab-custom-menu').waitFor();
await page.getByTestId('vocab-custom-rename').click();
await page.getByTestId('vocab-custom-rename-dialog').waitFor();
assert.equal(await page.getByTestId('vocab-custom-rename-input').inputValue(), '旅行词汇');
await page.getByTestId('vocab-custom-rename-input').fill('旅行词汇 2');
await page.getByTestId('vocab-custom-rename-save').click();
await page.getByTestId('vocab-custom-rename-dialog').waitFor({ state: 'hidden', timeout: 10000 });
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-tab-custom-wl-1"]')?.textContent?.includes('旅行词汇 2'));
assert.deepEqual(state.renames, [{ id: 'wl-1', name: '旅行词汇 2' }]);

// P2-29: manual 「补全等级」 menu item hits the endpoint (no blanks here → 0).
await page.getByTestId('vocab-custom-menu-trigger').click();
await page.getByTestId('vocab-custom-menu').waitFor();
await page.getByTestId('vocab-custom-backfill').click();
await page.waitForTimeout(400);
assert.equal(state.backfillCalls.at(-1).id, 'wl-1');
assert.equal(state.backfillCalls.at(-1).updated, 0);

// P2-29: the explicit Trash2 button next to ⋯ is the quick delete entry. It
// shares the confirm; the ⋯ menu item stays too (both open one dialog).
const quickDelete = page.getByTestId('vocab-custom-delete-quick');
assert.equal(await quickDelete.isVisible(), true);
assert.equal(await quickDelete.getAttribute('aria-label'), '删除词表');
assert.equal(await quickDelete.getAttribute('title'), '删除词表');
await page.screenshot({ path: `${SHOTS}/p2-29-delete-cefr-1440.png`, fullPage: false });
await quickDelete.click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor();
assert.match(await page.getByTestId('vocab-custom-delete-confirm').innerText(), /只会删除这个词表/);
await page.getByTestId('vocab-custom-delete-confirm-cancel').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor({ state: 'hidden' });
assert.equal(state.deletes.length, 0);
assert.equal(await page.getByTestId('vocab-tab-custom-wl-1').count(), 1);

// The ⋯ menu keeps the delete item; cancel keeps the table.
await page.getByTestId('vocab-custom-menu-trigger').click();
await page.getByTestId('vocab-custom-menu').waitFor();
assert.equal(await page.getByTestId('vocab-custom-delete').isVisible(), true);
await page.getByTestId('vocab-custom-delete').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor();
await page.getByTestId('vocab-custom-delete-confirm-cancel').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor({ state: 'hidden' });
assert.equal(state.deletes.length, 0);

// Confirm through the quick button: the table disappears, 我的收藏 is active.
await quickDelete.click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor();
await page.getByTestId('vocab-custom-delete-confirm-confirm').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-tab-custom-wl-1"]'));
assert.deepEqual(state.deletes, ['wl-1']);
assert.equal(await page.getByTestId('vocab-tab-mine').getAttribute('aria-selected'), 'true');
assert.equal(state.favorites.length, 1, 'deleting a table keeps saved favorites');
assert.equal(state.reviewPosts.length, 0);

// ── G) 全部加入复习（N） hidden (review UI paused) ──────────────────────
// The bulk button lived on the custom-list page header. It must not exist on
// any surface while REVIEW_UI_ENABLED=false, and no row may post a review word.
await page.getByTestId('vocab-tab-custom-wl-2').click();
await page.getByTestId('vocab-custom-list').waitFor();
assert.equal(await page.getByTestId('vocab-custom-add-all').count(), 0,
    '全部加入复习（N） must be hidden on a custom list while the review UI is paused');
assert.equal(state.reviewPosts.length, 0, 'no custom-list row may POST to /api/review/words');

// ── H) review UI paused (specs/013 2026-11-22): deep link falls back ──────
// ReviewScreen may not mount from a URL either: #/app/practice/review is
// rewritten to the tab root (no blank page) and never fetches the queue. The
// old 复习卡 definition-priority case needs the hidden screen, so it is gone;
// the snapshot/`definition` contract stays covered by the backend tests.
await page.goto(`${BASE}/#/app/practice/review`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('practice-screen').waitFor({ timeout: 15000 });
await page.waitForFunction(() => location.hash === '#/app/practice', null, { timeout: 10000 });
assert.equal(await page.getByTestId('review-card').count(), 0, 'a paused review route must not render a review card');
assert.equal(state.queueCalls, 0, 'a paused review route must never request /api/review/queue');
assert.equal(await page.getByTestId('practice-screen').isVisible(), true, 'the fallback must render the practice tab');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-review-route-1440.png`, fullPage: false });

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);

// ── J) 375: no horizontal overflow, custom tab + wizard usable ──────────
await page.setViewportSize({ width: 375, height: 812 });
await gotoWordbook(page);
await page.getByTestId('vocab-tab-custom-wl-2').click();
await page.getByTestId('vocab-custom-list').waitFor();
const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: window.innerWidth,
}));
assert.ok(overflow.doc <= overflow.view + 1, `document overflows horizontally: ${JSON.stringify(overflow)}`);
assert.ok(overflow.body <= overflow.view + 1, `body overflows horizontally: ${JSON.stringify(overflow)}`);
assert.equal(await page.getByTestId('vocab-custom-delete-quick').isVisible(), true,
    'P2-29: the quick delete keeps the header usable at 375');
assert.equal(await page.getByTestId('vocab-custom-export-tsv').isVisible(), true,
    'P0-16: the custom export stays reachable at 375');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="toast"]').length === 0,
    null, { timeout: 12000 }).catch(() => {});
await page.screenshot({ path: `${SHOTS}/p2-29-delete-cefr-375.png`, fullPage: false });
await page.screenshot({ path: `${SHOTS}/p0-16-375-custom-export.png`, fullPage: false });
// P0-15 at 375: the compact select-all selects every filtered custom item
// (58 after the cross-page delete in §E2) without overflowing.
await page.getByTestId('vocab-custom-edit').click();
await page.getByTestId('vocab-edit-bar').waitFor();
await page.getByTestId('vocab-select-all-custom-mobile').click();
await page.waitForFunction(() => document.querySelector('[data-testid="vocab-edit-selected"]')?.textContent?.trim() === '已选 58');
assert.equal((await page.getByTestId('vocab-edit-result-total').innerText()).trim(), '结果 58');
assert.equal(await page.getByTestId('vocab-select-all-custom-mobile').isChecked(), true);
await page.screenshot({ path: `${SHOTS}/p0-15-375-custom-select-all.png`, fullPage: false });
const selectAllOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
}));
assert.ok(selectAllOverflow.doc <= selectAllOverflow.view + 1,
    `375 select-all overflows horizontally: ${JSON.stringify(selectAllOverflow)}`);
await page.getByTestId('vocab-edit-done').evaluate((el) => el.click());
await page.getByTestId('vocab-edit-bar').waitFor({ state: 'detached' });
// No 加入我的单词 at 375 either (unfavorited wl-2 row): the star is the only
// favorite switch on every surface and viewport.
await page.getByTestId('vocab-custom-expand-word001').click();
await page.getByTestId('vocab-custom-detail-word001').waitFor();
assert.equal(await page.getByTestId('wl-2:word001-add-mine').count(), 0,
    '未收藏的自定义词表行在 375 也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-word001').innerText(), /加入我的单词|已加入/);
// P0-10: the 已掌握 check stays reachable at 375, beside the star.
assert.equal(await page.getByTestId('vocab-custom-master-toggle-word001').isVisible(), true);
assert.doesNotMatch(await rowTone(page, 'word001'), /bg-(success|warning)\/10/);
await page.screenshot({ path: `${SHOTS}/custom-wordlists-375.png`, fullPage: false });
await page.screenshot({ path: `${SHOTS}/p0-10-375-custom.png`, fullPage: false });

// The wizard is usable at 375 too (dialog body scrolls, no page overflow).
await page.getByTestId('vocab-import-button').click();
await page.getByTestId('wordlist-import-dialog').waitFor();
const wizardOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
}));
assert.ok(wizardOverflow.doc <= wizardOverflow.view + 1, `wizard overflows at 375: ${JSON.stringify(wizardOverflow)}`);
await page.screenshot({ path: `${SHOTS}/custom-wordlists-wizard-375.png`, fullPage: false });
await page.getByTestId('wordlist-import-cancel').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });

// Guest: the entry opens the login overlay and never touches /api/wordlists.
const guestState = createState();
guestState.mode = 'guest';
const guest = await newContext(browser, guestState, { width: 375, height: 812 });
await gotoWordbook(guest.page);
assert.equal(await guest.page.locator('[data-testid^="vocab-tab-custom-"]').count(), 0);
await guest.page.getByTestId('vocab-import-button').click();
await guest.page.getByTestId('guest-auth-overlay').waitFor({ timeout: 10000 });
assert.equal(guestState.wordlistCalls, 0, 'guests must not call /api/wordlists');
assert.equal(await guest.page.getByTestId('wordlist-import-dialog').count(), 0);
await guest.page.screenshot({ path: `${SHOTS}/custom-wordlists-guest-375.png`, fullPage: false });
assert.deepEqual(guest.pageErrors, [], `guest page errors: ${guest.pageErrors.join(' | ')}`);

// ── K) 10-list cap is pre-checked on the client before the wizard opens ──
const limitState = createState();
limitState.lists = Array.from({ length: 10 }, (_, index) => ({
    id: `limit-${index}`,
    name: `Limit ${index}`,
    createdAt: 1763000000000 + index,
    items: [{ ...ABUNDANT, word: `limitword${index}` }],
}));
const limit = await newContext(browser, limitState);
await gotoWordbook(limit.page);
await limit.page.getByTestId('vocab-tab-custom-limit-9').waitFor({ timeout: 10000 });
await limit.page.getByTestId('vocab-import-button').click();
await limit.page.locator('[data-testid="toast"]', { hasText: '最多只能有 10 个自定义词表' }).waitFor({ timeout: 5000 });
assert.equal(await limit.page.getByTestId('wordlist-import-dialog').count(), 0);
assert.deepEqual(limit.pageErrors, []);

await context.close();
await guest.context.close();
await limit.context.close();
await browser.close();
console.log('custom-wordlists acceptance: PASS');
console.log(`  checks passed: ${assertionsPassed}`);
console.log(`  wordlists fetched: ${state.wordlistCalls} · imports: ${state.importBodies.length}`);
console.log(`  deletes: ${state.deletes.join(', ')} · review POSTs: ${state.reviewPosts.length} · review queue calls: ${state.queueCalls} · define calls: ${state.defineCalls}`);
console.log(`  CEFR backfill calls: ${state.backfillCalls.map((call) => `${call.id}:${call.updated}`).join(', ') || 'none'}`);
console.log(`  screenshots: ${SHOTS}/custom-wordlists-*.png`);
