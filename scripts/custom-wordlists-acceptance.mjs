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
//   D) row actions: NO 加入我的单词 in any favorite state (P0-09 — the row star
//      is the only favorite switch; POST/DELETE + source_kind=wordlist, no local
//      已加入 mirror); 标为已掌握 (PATCH); 加入复习 stays hidden while the
//      review UI is paused;
//   E) server-side search + 50/page pagination;
//   F) 删除词表 asks first (cancel keeps it), confirms, deletes the table only;
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
// rows now carry the shared WordTable controls (star / expand), row actions live
// inside the expanded area, paging uses the shared 每页 20/50/100 + 跳至 pager,
// and the edit mode (勾选删除) + 重命名 live on the custom list itself. Sections
// D–F were rewritten accordingly; the import wizard, review-route fallback,
// guest gate and 375px cases are unchanged.
//
// Screenshots: /tmp/custom-wordlists-*.png
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node custom-wordlists-acceptance.mjs
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
                list.items = list.items.filter((item) => !ids.includes(item.id));
                return respond({ deleted: ids.length, itemCount: list.items.length });
            }
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
assert.equal(await page.getByTestId('wl-1:abundant-add-mine').count(), 0,
    '已收藏的行也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-abundant').innerText(), /加入我的单词|已加入/,
    'the favorited expanded row still carries no favorite action');
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

// 标为已掌握 on a custom row: PATCH with the list as contentRef.
await page.getByTestId('vocab-custom-expand-candid').click();
await page.getByTestId('wl-1:candid-master').click();
await page.waitForFunction(() => document.querySelector('[data-testid="wl-1:candid-master"]')?.textContent?.includes('已掌握'));
assert.equal(state.masteredPatches.length, 1);
assert.equal(state.masteredPatches[0].mastered, true);
assert.equal(state.masteredPatches[0].lemma, 'candid');
assert.equal(state.masteredPatches[0].source.contentRef, 'wl-1');

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

await page.getByTestId('vocab-tab-custom-wl-2').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50);
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

// ── F) edit mode (勾选删除) + 重命名 + delete-table menu ─────────────────
// Editing exists only on a custom list: no edit entry on 我的单词 / 已掌握 /
// 内置词表 / 短语.
await page.getByTestId('vocab-tab-mine').click();
await page.waitForSelector('[data-testid="vocab-mine-panel"]');
assert.equal(await page.getByTestId('vocab-custom-edit').count(), 0, 'no edit mode outside a custom list');
assert.equal(await page.getByTestId('vocab-custom-edit-bar').count(), 0);
await page.getByTestId('vocab-tab-gre').click();
// This fixture's built-in list is empty, so the GRE tab renders the empty state.
await page.waitForSelector('[data-testid="vocab-empty"]');
assert.equal(await page.getByTestId('vocab-custom-edit').count(), 0);
await page.getByTestId('vocab-tab-custom-wl-1').click();
await page.getByTestId('vocab-custom-list').waitFor();
assert.equal(await page.getByTestId('vocab-custom-edit').isVisible(), true);
await page.getByTestId('vocab-custom-edit').click();
await page.getByTestId('vocab-custom-edit-bar').waitFor();
assert.equal(await page.getByTestId('vocab-custom-edit').count(), 0, 'edit mode replaces the 编辑 button');
assert.equal((await page.getByTestId('vocab-custom-selected').innerText()).trim(), '已选 0');
assert.equal(await page.locator('[data-testid^="vocab-custom-select-"]').count(), 2,
    'edit mode adds one checkbox per row');
await page.getByTestId('vocab-custom-select-it-abundant').check();
assert.equal((await page.getByTestId('vocab-custom-selected').innerText()).trim(), '已选 1');
await page.screenshot({ path: `${SHOTS}/custom-wordlists-edit-mode-1440.png`, fullPage: false });
await page.getByTestId('vocab-custom-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
assert.match(await page.getByTestId('vocab-custom-items-delete').innerText(), /删除选中的 1 个词条/);
assert.match(await page.getByTestId('vocab-custom-items-delete').innerText(), /只从这张词表删除/);
await page.getByTestId('vocab-custom-items-delete-cancel').click();
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden' });
assert.equal(state.itemDeletes.length, 0, 'cancel keeps the selected row');
assert.equal(await page.locator('[data-testid^="vocab-custom-row"]').count(), 2);
await page.getByTestId('vocab-custom-edit-delete').click();
await page.getByTestId('vocab-custom-items-delete').waitFor();
await page.getByTestId('vocab-custom-items-delete-confirm').click();
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 1);
await page.getByTestId('vocab-custom-items-delete').waitFor({ state: 'hidden', timeout: 5000 });
assert.equal(state.itemDeletes.length, 1);
assert.equal(state.itemDeletes[0].id, 'wl-1');
assert.deepEqual(state.itemDeletes[0].ids, ['it-abundant']);
assert.equal(await page.getByTestId('vocab-tab-count-custom-wl-1').innerText(), '1');
assert.equal(state.favorites.length, 1, 'deleting a row keeps its saved favorite');
await page.getByTestId('vocab-custom-edit-done').click();
await page.getByTestId('vocab-custom-edit-bar').waitFor({ state: 'detached' });
assert.equal(await page.getByTestId('vocab-custom-edit').isVisible(), true);

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

// Delete-table menu: cancel keeps it, confirm deletes the table only.
await page.getByTestId('vocab-custom-menu-trigger').click();
await page.getByTestId('vocab-custom-menu').waitFor();
await page.getByTestId('vocab-custom-delete').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor();
assert.match(await page.getByTestId('vocab-custom-delete-confirm').innerText(), /只会删除这个词表/);
await page.getByTestId('vocab-custom-delete-confirm-cancel').click();
await page.getByTestId('vocab-custom-delete-confirm').waitFor({ state: 'hidden' });
assert.equal(state.deletes.length, 0);
assert.equal(await page.getByTestId('vocab-tab-custom-wl-1').count(), 1);

await page.getByTestId('vocab-custom-menu-trigger').click();
await page.getByTestId('vocab-custom-menu').waitFor();
await page.getByTestId('vocab-custom-delete').click();
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
// No 加入我的单词 at 375 either (unfavorited wl-2 row): the star is the only
// favorite switch on every surface and viewport.
await page.getByTestId('vocab-custom-expand-word001').click();
await page.getByTestId('vocab-custom-detail-word001').waitFor();
assert.equal(await page.getByTestId('wl-2:word001-add-mine').count(), 0,
    '未收藏的自定义词表行在 375 也不得渲染 加入我的单词');
assert.doesNotMatch(await page.getByTestId('vocab-custom-detail-word001').innerText(), /加入我的单词|已加入/);
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
console.log(`  checks passed: ${assertionsPassed}`);
console.log(`  wordlists fetched: ${state.wordlistCalls} · imports: ${state.importBodies.length}`);
console.log(`  deletes: ${state.deletes.join(', ')} · review POSTs: ${state.reviewPosts.length} · review queue calls: ${state.queueCalls} · define calls: ${state.defineCalls}`);
console.log(`  screenshots: ${SHOTS}/custom-wordlists-*.png`);
