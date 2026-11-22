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
//   D) row actions: 加入我的单词 (meta.source_kind=wordlist), 加入复习
//      (definition snapshot), 标为已掌握 (PATCH);
//   E) server-side search + 50/page pagination;
//   F) 删除词表 asks first (cancel keeps it), confirms, deletes the table only;
//   G) 全部加入复习（N） asks first and posts every word with its snapshot;
//   H) review card with a queue `definition` shows it without calling
//      /api/define; a card without one still falls back to /api/define;
//   I) guest entry opens the login overlay and never calls /api/wordlists;
//   J) 375 has no horizontal overflow.
//
// Screenshots: /tmp/custom-wordlists-*.png
// Run: APP_URL=http://127.0.0.1:5173 node scripts/custom-wordlists-acceptance.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';

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
        word: `${prefix}${String(n).padStart(3, '0')}`,
        translation: `释义 ${n}`,
        phonetic: `/wɜːd${n}/`,
        cefr: ['A2', 'B1', 'B2', 'C1'][n % 4],
        example: `This is example sentence number ${n}.`,
    };
});

const ABUNDANT = {
    word: 'abundant',
    translation: '丰富的；充裕的',
    phonetic: '/əˈbʌndənt/',
    cefr: 'B2',
    example: 'The region has abundant rainfall.',
};
const CANDID = {
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
        ],
        favorites: [],
        reviewPosts: [],
        masteredPatches: [],
        defineCalls: 0,
        wordlistCalls: 0,
        importBodies: [],
        deletes: [],
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
        const pageMatch = pathname.match(/^\/api\/wordlists\/([^/]+)$/);
        if (pageMatch) {
            const id = decodeURIComponent(pageMatch[1]);
            const list = state.lists.find((entry) => entry.id === id);
            if (!list) return fail(404, 'wordlist not found');
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

// B0e) >5000 rows is rejected before the preview/upload.
const tooMany = ['word', ...Array.from({ length: 5001 }, (_, index) => `word${index}`)].join('\n');
await page.getByTestId('wordlist-import-file').setInputFiles({
    name: 'huge-rows.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(tooMany, 'utf8'),
});
await page.locator('[role="alert"]', { hasText: '超过 5000 行' }).waitFor({ timeout: 10000 });
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

// ── D) row actions on a pre-existing custom list ────────────────────────
await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.getByTestId('vocab-custom-list').waitFor();
const ROW = 'wl-1:abundant';

await page.getByTestId(`${ROW}-add-mine`).click();
await page.waitForFunction(() => document.querySelector('[data-testid="wl-1:abundant-add-mine"]')?.textContent?.includes('已加入'));
assert.equal(state.favorites.length, 1);
assert.equal(state.favorites[0].source_kind, 'wordlist');
assert.equal(state.favorites[0].source_ref, 'wl-1');
assert.equal(state.favorites[0].source_title, '旅行词汇');
assert.equal(state.favorites[0].example, 'The region has abundant rainfall.');
assert.equal(state.favorites[0].zh_text, '/əˈbʌndənt/ 丰富的；充裕的');

// specs/038 (2026-11-22): the review UI is paused, so the custom-list surface
// hides 加入复习 / 全部加入复习 while keeping the API + definition snapshot.
assert.equal(await page.getByTestId(`${ROW}-add-review`).count(), 0);
assert.equal(await page.getByTestId('vocab-custom-add-all').count(), 0);

await page.getByTestId(`${ROW}-master`).click();
await page.waitForFunction(() => document.querySelector('[data-testid="wl-1:abundant-master"]')?.textContent?.includes('已掌握'));
assert.equal(state.masteredPatches.length, 1);
assert.equal(state.masteredPatches[0].mastered, true);
assert.equal(state.masteredPatches[0].source.contentRef, 'wl-1');

// ── D2) 隐藏中文 reuses the shared WordTable behavior ────────────────────
assert.equal(await page.locator('[data-testid="vocab-custom-translation"]').count(), 2);
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.locator('[data-testid="vocab-custom-translation"]').count(), 0);
await page.locator('[data-testid="vocab-custom-row"]').first().click();
assert.equal(await page.locator('[data-testid="vocab-custom-translation"]').count(), 1);
await page.getByTestId('vocab-hide-toggle').click();
assert.equal(await page.locator('[data-testid="vocab-custom-translation"]').count(), 2);

// ── E) server-side search + 50/page pagination ──────────────────────────
await page.getByTestId('vocab-custom-search').fill('abund');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
assert.equal(await page.$$eval('[data-testid="vocab-custom-row"]', (rows) => rows.length), 1);
await page.getByTestId('vocab-custom-search-clear').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 2);

await page.getByTestId('vocab-tab-custom-wl-2').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50);
assert.equal(await page.$$eval('[data-testid="vocab-custom-row"]', (rows) => rows.length), 50);
await page.getByTestId('vocab-page-next').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 10);
assert.equal(await page.getByTestId('vocab-page-status').innerText(), '第 2 / 2 页');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-1440.png`, fullPage: false });

// ── F) delete asks first; cancel keeps the table, confirm deletes it ─────
await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.getByTestId('vocab-custom-delete').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor();
assert.match(await page.getByTestId('vocab-custom-delete-confirm').innerText(), /只会删除这个词表/);
await page.getByTestId('vocab-custom-delete-confirm-cancel').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor({ state: 'hidden' });
assert.equal(state.deletes.length, 0);
assert.equal(await page.getByTestId('vocab-tab-custom-wl-1').count(), 1);

await page.getByTestId('vocab-custom-delete').click();
await page.getByTestId('vocab-custom-delete-confirm-confirm').click();
await page.waitForFunction(() => !document.querySelector('[data-testid="vocab-tab-custom-wl-1"]'));
assert.deepEqual(state.deletes, ['wl-1']);
assert.equal(await page.getByTestId('vocab-tab-mine').getAttribute('aria-selected'), 'true');
assert.equal(state.favorites.length, 1, 'deleting a table keeps saved favorites');
assert.equal(state.reviewPosts.length, 0);

// ── G) review card (engine retained): snapshot wins, no /api/define ─────
await page.goto(`${BASE}/#/app/practice/review`, { waitUntil: 'domcontentloaded' });
await page.getByTestId('review-card').waitFor({ timeout: 15000 });
assert.equal(await page.getByTestId('review-word').innerText(), 'abundant');
await page.getByTestId('review-reveal').click();
await page.getByTestId('review-definition-zh').waitFor();
assert.equal(await page.getByTestId('review-definition-zh').innerText(), '词表快照：丰富的；充裕的');
assert.equal(state.defineCalls, 0, 'a word-list snapshot must not call /api/define');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-review-1440.png`, fullPage: false });

// Second card has no snapshot → the existing /api/define path still works.
await page.getByTestId('review-rating-good').click();
await page.waitForFunction(() => document.querySelector('[data-testid="review-word"]')?.textContent === 'candid');
await page.getByTestId('review-reveal').click();
await page.getByTestId('review-definition-zh').waitFor();
assert.equal(state.defineCalls, 1);
assert.equal(await page.getByTestId('review-definition-zh').innerText(), '来自词典的释义');

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
await page.screenshot({ path: `${SHOTS}/custom-wordlists-375.png`, fullPage: false });

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
console.log(`  wordlists fetched: ${state.wordlistCalls} · imports: ${state.importBodies.length}`);
console.log(`  deletes: ${state.deletes.join(', ')} · review POSTs: ${state.reviewPosts.length} · define calls: ${state.defineCalls}`);
console.log(`  screenshots: ${SHOTS}/custom-wordlists-*.png`);
