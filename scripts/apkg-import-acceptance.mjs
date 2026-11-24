#!/usr/bin/env node
// Playwright acceptance for specs/046-apkg-import (frontend only).
//
// Everything is mocked (no :8000, no real account, no real Anki package): the
// browser never sees the backend contract, only the spec §2 JSON, so this runs
// before/without the parallel P2-23 backend merge.
//
// Covers:
//   A) a 30 MB `.apkg` passes the client-side 50 MB gate, uploads through
//      `POST /api/wordlists/apkg-parse` (multipart `file`) and opens the APKG
//      config step with the real-deck shape: 7512 notes (single deck/model,
//      fields 单词/音标/解释/例句) → 4-step indicator;
//   B) defaults: largest deck (7527), most-used model (7512), word=单词,
//      translation=解释, phonetic=音标; filtered/pagetotal/skipped-model stats
//      and the first-5 preview;
//   C) deck switch + model switch + field switch reset the dependent selects
//      and the stats/preview;
//   D) 下一步 converts the selected notes into the existing two/three-column
//      map step (7512 rows, no 5000 truncation) and confirm → one
//      `POST /api/wordlists/import` with all 7512 items, success toast + tab;
//   E) truncated response (10000 notes) shows the truncation banner;
//   F) 400 invalid APKG / 200 empty notes / 413 / 403 / 503 error copy;
//   G) >50 MB is rejected client-side before any upload call;
//   H) CSV regression: the text path keeps its 3-step indicator and imports;
//   I) 375 has no horizontal overflow on the config step; 1440 + 375 shots.
//
// Screenshots: /tmp/apkg-import-*.png
// Run: cd scripts && APP_URL=http://127.0.0.1:5173/ node apkg-import-acceptance.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';

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
/** Evidence binds the checked-out HEAD, like every UI-acceptance script. */
const HEAD = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();
const shot = (name) => `${SHOTS}/apkg-import-${name}@${HEAD}.png`;

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const USER = { id: 'u-apkg', email: 'apkg@example.test', username: 'ApkgUser', credits: 12 };

// ── synthetic Anki response, shaped like spec §2 ────────────────────────────
const GRE_TOTAL = 7512;
const GRE_DECK_NOTES = 7527; // 7512 Basic + 15 Cloze
const EXTRA_DECK_NOTES = 120;
const ALL_NOTES = GRE_DECK_NOTES + EXTRA_DECK_NOTES; // 7647
const TRUNCATED_NOTES = 10000;

const BASIC_MODEL = {
    id: 'model-basic',
    name: 'Basic',
    fields: ['单词', '音标', '解释', '例句'],
};
const CLOZE_MODEL = {
    id: 'model-cloze',
    name: 'Cloze',
    fields: ['Text', 'Extra'],
};

/**
 * The wizard applies the real English-word rule (letters only, no digits), so
 * synthetic notes need letter-only unique words: 1 → worda, 26 → wordz,
 * 27 → wordaa … 7512 stays unique below 26^3.
 */
function alphaWord(index) {
    let n = index;
    let suffix = '';
    while (n > 0) {
        n -= 1;
        suffix = String.fromCharCode(97 + (n % 26)) + suffix;
        n = Math.floor(n / 26);
    }
    return `word${suffix}`;
}

function buildMainPayload() {
    const notes = [];
    for (let index = 1; index <= GRE_TOTAL; index += 1) {
        notes.push({
            deckId: 'deck-gre',
            modelId: 'model-basic',
            fields: [
                alphaWord(index),
                `/wɜːd${index}/`,
                `释义 ${index}`,
                `This is example sentence number ${index}.`,
            ],
        });
    }
    for (let index = 1; index <= 15; index += 1) {
        notes.push({
            deckId: 'deck-gre',
            modelId: 'model-cloze',
            fields: [`cloze${alphaWord(index).slice(4)}`, `填空释义 ${index}`],
        });
    }
    for (let index = 1; index <= EXTRA_DECK_NOTES; index += 1) {
        notes.push({
            deckId: 'deck-extra',
            modelId: 'model-basic',
            fields: [
                `travel${alphaWord(index).slice(4)}`,
                `/ˈtrævəl${index}/`,
                `旅行释义 ${index}`,
                `Travel example ${index}.`,
            ],
        });
    }
    return {
        fileName: 'GRE.apkg',
        decks: [
            { id: 'deck-gre', name: 'GRE 3000', noteCount: GRE_DECK_NOTES },
            { id: 'deck-extra', name: '旅行', noteCount: EXTRA_DECK_NOTES },
        ],
        models: [BASIC_MODEL, CLOZE_MODEL],
        notes,
        total: ALL_NOTES,
        truncated: false,
    };
}

function buildTruncatedPayload() {
    const notes = Array.from({ length: TRUNCATED_NOTES }, (_, offset) => {
        const index = offset + 1;
        return {
            deckId: 'deck-gre',
            modelId: 'model-basic',
            fields: [
                alphaWord(index),
                `/wɜːd${index}/`,
                `释义 ${index}`,
                `Example ${index}.`,
            ],
        };
    });
    return {
        fileName: 'huge.apkg',
        decks: [{ id: 'deck-gre', name: 'GRE 3000', noteCount: TRUNCATED_NOTES }],
        models: [BASIC_MODEL],
        notes,
        total: TRUNCATED_NOTES,
        truncated: true,
    };
}

function createState() {
    return {
        lists: [],
        importBodies: [],
        apkgCalls: 0,
        /** Which parse response the mock answers next (see `apkgPayload`). */
        apkgMode: 'main',
        /** Rewrite the uploaded file name in the response (default GRE.apkg). */
        apkgResponseName: null,
        mainPayload: null,
        truncatedPayload: null,
        wordlistPageCalls: 0,
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

function apkgPayload(state) {
    switch (state.apkgMode) {
    case 'truncated':
        if (!state.truncatedPayload) state.truncatedPayload = buildTruncatedPayload();
        return { status: 200, body: state.truncatedPayload };
    case 'invalid':
        return { status: 400, body: { detail: 'not an apkg / unsupported collection' } };
    case 'no-notes':
        return {
            status: 200,
            body: {
                fileName: 'empty.apkg', decks: [], models: [], notes: [], total: 0, truncated: false,
            },
        };
    case 'server-413':
        return { status: 413, body: { detail: 'file too large' } };
    case 'forbidden':
        return { status: 403, body: { detail: 'login required' } };
    case 'unavailable':
        return { status: 503, body: { detail: 'apkg parser unavailable' } };
    default:
        if (!state.mainPayload) state.mainPayload = buildMainPayload();
        return {
            status: 200,
            body: state.apkgResponseName
                ? { ...state.mainPayload, fileName: state.apkgResponseName }
                : state.mainPayload,
        };
    }
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

        if (pathname === '/api/auth/me') return respond({ user: USER, isAdmin: false, guest: false });
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
        if (pathname === '/api/favorites' && method === 'GET') return respond([]);
        if (pathname === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-24', dueToday: 0, dueNow: 0,
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
            ]);
        }
        if (/^\/api\/vocabulary\/lists\/[a-z0-9-]+$/.test(pathname)) {
            return respond({ items: [], total: 0, page: 1, pageSize: 50, hasMore: false });
        }
        if (pathname === '/api/vocabulary/level') return respond({});
        if (pathname === '/api/vocabulary/seen') return respond({});

        // ── the APKG parser + custom word lists under test ────────────────
        if (pathname === '/api/wordlists/apkg-parse' && method === 'POST') {
            state.apkgCalls += 1;
            const { status, body } = apkgPayload(state);
            return respond(body, status);
        }
        if (pathname === '/api/wordlists' && method === 'GET') {
            return respond({ lists: state.lists.map(listMeta) });
        }
        if (pathname === '/api/wordlists/import' && method === 'POST') {
            const body = request.postDataJSON() || {};
            state.importBodies.push(body);
            const list = {
                id: `wl-apkg-${state.lists.length + 1}`,
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
        if (pageMatch && method === 'GET') {
            const id = decodeURIComponent(pageMatch[1]);
            const list = state.lists.find((entry) => entry.id === id);
            if (!list) return fail(404, 'wordlist not found');
            state.wordlistPageCalls += 1;
            const page = Math.max(1, Number(url.searchParams.get('page') || 1));
            const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get('pageSize') || 50)));
            const start = (page - 1) * pageSize;
            return respond({
                id: list.id,
                name: list.name,
                items: list.items.slice(start, start + pageSize),
                total: list.items.length,
                page,
                pageSize,
                hasMore: start + pageSize < list.items.length,
            });
        }
        if (pathname.startsWith('/api/wordlists/') && method === 'DELETE') {
            return respond({ status: 'ok', deleted: true });
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
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
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

async function openImport(page) {
    await page.getByTestId('vocab-import-button').click();
    await page.getByTestId('wordlist-import-dialog').waitFor({ timeout: 10000 });
}

/** Upload through the hidden file input (the wizard's browse path). */
async function uploadFile(page, { name, buffer, mimeType = 'application/octet-stream' }) {
    await page.getByTestId('wordlist-import-file').setInputFiles({ name, mimeType, buffer });
}

/** Upload through drag/drop with a file built inside the page (no CDP copy). */
async function dropFile(page, name, bytes) {
    await page.evaluate(({ fileName, size }) => {
        const dataTransfer = new DataTransfer();
        const content = new Uint8Array(size);
        content[0] = 0x50;
        dataTransfer.items.add(new File([content], fileName, { type: 'application/octet-stream' }));
        const zone = document.querySelector('[data-testid="wordlist-import-dropzone"]');
        for (const type of ['dragenter', 'dragover', 'drop']) {
            zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
        }
    }, { fileName: name, size: bytes });
}

async function waitApkgStep(page) {
    await page.getByTestId('wordlist-import-apkg-deck').waitFor({ timeout: 30000 });
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const state = createState();
const { context, page, pageErrors } = await newContext(browser, state);

await gotoWordbook(page);

// ── A+B) 30 MB real-deck APKG → config step defaults ────────────────────────
await openImport(page);
assert.equal(
    await page.locator('[data-testid="wordlist-import-steps"] li').count(),
    3,
    'a text file starts with the 3-step indicator',
);
await uploadFile(page, {
    name: 'GRE.apkg',
    buffer: Buffer.alloc(30 * 1024 * 1024, 0x50),
});
await waitApkgStep(page);
assert.equal(state.apkgCalls, 1, 'the .apkg is uploaded to /api/wordlists/apkg-parse');
assert.equal(
    await page.locator('[data-testid="wordlist-import-steps"] li').count(),
    4,
    'an APKG gets the 4-step indicator (file/apkg/map/confirm)',
);
assert.match(await page.getByTestId('wordlist-import-steps').innerText(), /配置牌组/);
assert.match(await page.getByTestId('wordlist-import-apkg-file-name').innerText(), /GRE\.apkg/);
assert.equal(await page.getByTestId('wordlist-import-apkg-total').innerText(), '共 7,647 条笔记');

// Defaults: biggest deck, its most-used model, 单词/解释/音标 from field names.
assert.equal(await page.getByTestId('wordlist-import-apkg-deck').inputValue(), 'deck-gre');
assert.equal(await page.getByTestId('wordlist-import-apkg-model').inputValue(), 'model-basic');
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-apkg-translation').inputValue(), '2');
assert.equal(await page.getByTestId('wordlist-import-apkg-phonetic').inputValue(), '1');
assert.match(
    await page.getByTestId('wordlist-import-apkg-deck').innerText(),
    /GRE 3000（7,527 条）/,
);
assert.match(
    await page.getByTestId('wordlist-import-apkg-translation').innerText(),
    /解释/,
);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-stats').innerText(),
    '本牌组 7,527 条 · 将导入 7,512 条',
);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-skipped').innerText(),
    '已跳过其他牌组 120 条、其他笔记类型 15 条',
);
assert.equal(await page.getByTestId('wordlist-import-apkg-truncated').count(), 0);

// First-5 preview follows the mapped fields.
const apkgPreview = await page.getByTestId('wordlist-import-dialog').innerText();
assert.match(apkgPreview, new RegExp(alphaWord(1)));
assert.match(apkgPreview, /\/wɜːd1\//);
assert.match(apkgPreview, /释义 1/);
assert.equal(await page.getByTestId('wordlist-import-apkg-preview-title').innerText(), '前 5 条预览');
await page.screenshot({ path: shot('config-1440'), fullPage: false });

// ── C) deck / model / field switches ────────────────────────────────────────
await page.getByTestId('wordlist-import-apkg-deck').selectOption('deck-extra');
assert.equal(await page.getByTestId('wordlist-import-apkg-model').inputValue(), 'model-basic');
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-apkg-translation').inputValue(), '2');
assert.equal(await page.getByTestId('wordlist-import-apkg-phonetic').inputValue(), '1');
assert.equal(
    await page.getByTestId('wordlist-import-apkg-stats').innerText(),
    '本牌组 120 条 · 将导入 120 条',
);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-skipped').innerText(),
    '已跳过其他牌组 7,527 条、其他笔记类型 0 条',
);
assert.match(await page.getByTestId('wordlist-import-dialog').innerText(), new RegExp(`travel${alphaWord(1).slice(4)}`));

await page.getByTestId('wordlist-import-apkg-deck').selectOption('deck-gre');
await page.getByTestId('wordlist-import-apkg-model').selectOption('model-cloze');
// A model without a Chinese/English "meaning" field name: word = first field,
// translation = the next remaining field, phonetic = 不使用.
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-apkg-translation').inputValue(), '1');
assert.equal(await page.getByTestId('wordlist-import-apkg-phonetic').inputValue(), '');
assert.equal(
    await page.getByTestId('wordlist-import-apkg-stats').innerText(),
    '本牌组 7,527 条 · 将导入 15 条',
);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-skipped').innerText(),
    '已跳过其他牌组 120 条、其他笔记类型 7,512 条',
);
assert.match(await page.getByTestId('wordlist-import-dialog').innerText(), new RegExp(`cloze${alphaWord(1).slice(4)}`));

// Switching 「释义字段」 to 「不使用」 and back keeps the field mapping editable.
await page.getByTestId('wordlist-import-apkg-translation').selectOption('');
assert.equal(await page.getByTestId('wordlist-import-apkg-translation').inputValue(), '');
await page.getByTestId('wordlist-import-apkg-translation').selectOption('1');
// Back to the 4-field model: defaults reset, and a field already mapped to
// another role is not selectable (音标 is the phonetic field).
await page.getByTestId('wordlist-import-apkg-model').selectOption('model-basic');
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-apkg-translation').inputValue(), '2');
assert.equal(
    await page.getByTestId('wordlist-import-apkg-word').evaluate((el) => el.querySelector('option[value="1"]').disabled),
    true,
    'a field already mapped to phonetic cannot be picked as the word too',
);
// 例句 (3) is free, so the word field can move there and back.
await page.getByTestId('wordlist-import-apkg-word').selectOption('3');
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '3');
await page.getByTestId('wordlist-import-apkg-word').selectOption('0');
assert.equal(await page.getByTestId('wordlist-import-apkg-word').inputValue(), '0');

// ── D) 7512 rows → map → confirm → import (no 5000 truncation) ──────────────
await page.getByTestId('wordlist-import-next').click();
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 15000 });
assert.equal(
    await page.locator('[data-testid="wordlist-import-steps"] li').count(),
    4,
    'the APKG map step keeps the 4-step indicator',
);
assert.equal(await page.getByTestId('wordlist-import-map-word').inputValue(), '0');
assert.equal(await page.getByTestId('wordlist-import-map-translation').inputValue(), '1');
assert.equal(await page.getByTestId('wordlist-import-map-phonetic').inputValue(), '2');
assert.match(await page.getByTestId('wordlist-import-apkg-map-note').innerText(), /GRE 3000 · Basic/);
assert.equal(
    await page.getByTestId('wordlist-import-stats').innerText(),
    '共 7,512 行 · 有效 7,512 · 跳过 0',
);
await page.screenshot({ path: shot('map-1440'), fullPage: false });

await page.getByTestId('wordlist-import-next').click();
await page.getByTestId('wordlist-import-name').waitFor({ timeout: 10000 });
assert.equal(await page.getByTestId('wordlist-import-name').inputValue(), 'GRE');
assert.match(
    await page.getByTestId('wordlist-import-summary').innerText(),
    /将导入 7,512 个词到「GRE」/,
);
assert.equal(
    await page.getByTestId('wordlist-import-submit').innerText(),
    '导入 7,512 个词',
);
await page.screenshot({ path: shot('confirm-1440'), fullPage: false });

await page.getByTestId('wordlist-import-submit').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden', timeout: 30000 });
assert.equal(state.importBodies.length, 1);
const importBody = state.importBodies[0];
assert.equal(importBody.name, 'GRE');
assert.equal(importBody.filename, 'GRE.apkg');
assert.equal(importBody.items.length, 7512);
assert.deepEqual(importBody.items[0], {
    word: alphaWord(1),
    translation: '释义 1',
    phonetic: '/wɜːd1/',
});
assert.equal(importBody.items.at(-1).word, alphaWord(GRE_TOTAL));
assert.equal(state.lists[0].items.length, 7512);
assert.match(await page.locator('[data-testid="toast"]', { hasText: '已导入「GRE」' }).innerText(), /7,512 个词/);
await page.getByTestId('vocab-tab-custom-wl-apkg-1').waitFor({ timeout: 10000 });
assert.equal(
    await page.getByTestId('vocab-tab-custom-wl-apkg-1').getAttribute('aria-selected'),
    'true',
);
assert.equal((await page.getByTestId('vocab-tab-count-custom-wl-apkg-1').innerText()).trim(), '7,512');
await page.waitForFunction(() => document.querySelectorAll('[data-testid="vocab-custom-row"]').length === 50, null, { timeout: 15000 });
// The client full-load loop must reach all 7512 items (≥38 pages of 200), so
// the header total is 7512 — not the old 5000-item loop cap.
assert.ok(state.wordlistPageCalls >= 38, `the whole list is fetched: ${state.wordlistPageCalls} pages`);
assert.equal(await page.getByTestId('vocab-total').innerText(), '共 7,512 词');
await page.screenshot({ path: shot('list-1440'), fullPage: false });

// ── E) truncated parse shows the banner (10000 notes) ──────────────────────
state.apkgMode = 'truncated';
await openImport(page);
await uploadFile(page, {
    name: 'huge.apkg',
    buffer: Buffer.alloc(1024 * 1024, 0x50),
});
await waitApkgStep(page);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-truncated').count(),
    1,
    'a truncated parse renders the 10000-note banner',
);
assert.match(await page.getByTestId('wordlist-import-apkg-truncated').innerText(), /超过 10,000 条/);
assert.equal(
    await page.getByTestId('wordlist-import-apkg-stats').innerText(),
    '本牌组 10,000 条 · 将导入 10,000 条',
);
assert.equal(await page.getByTestId('wordlist-import-apkg-file-name').innerText(), 'huge.apkg');
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-cancel').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });

// ── F) parse failures: 400 / empty / 413 / 403 / 503 ───────────────────────
async function expectApkgError(mode, name, pattern, expectedCalls) {
    state.apkgMode = mode;
    await openImport(page);
    await uploadFile(page, { name, buffer: Buffer.alloc(2048, 0x50) });
    const alert = page.locator('[role="alert"]', { hasText: pattern });
    await alert.waitFor({ timeout: 15000 });
    assert.equal(await page.getByTestId('wordlist-import-apkg-deck').count(), 0,
        `${mode}: a failed parse keeps the wizard on the file step`);
    assert.equal(state.apkgCalls, expectedCalls, `${mode}: exactly one parse attempt`);
    await page.getByTestId('wordlist-import-cancel').click();
    await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });
}

let expectedApkgCalls = state.apkgCalls;
for (const [mode, name, pattern] of [
    ['invalid', 'broken.apkg', '无法解析这个 APKG'],
    ['no-notes', 'empty.apkg', '没有可导入的笔记'],
    ['server-413', 'oversize.apkg', 'APKG 文件超过 50 MB'],
    ['forbidden', 'guest.apkg', '登录状态已失效'],
    ['unavailable', 'later.apkg', 'APKG 解析暂时不可用'],
]) {
    expectedApkgCalls += 1;
    await expectApkgError(mode, name, pattern, expectedApkgCalls);
}

// ── G) the 50 MB client gate blocks before any upload ─────────────────────
await openImport(page);
const apkgCallsBeforeOversize = state.apkgCalls;
await dropFile(page, 'too-big.apkg', 50 * 1024 * 1024 + 1);
await page.locator('[role="alert"]', { hasText: 'APKG 文件超过 50 MB' }).waitFor({ timeout: 15000 });
assert.equal(state.apkgCalls, apkgCallsBeforeOversize, 'a >50 MB APKG never reaches the backend');
assert.equal(await page.getByTestId('wordlist-import-apkg-deck').count(), 0);
await page.getByTestId('wordlist-import-cancel').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });

// ── H) CSV regression: the text path keeps 3 steps and still imports ───────
state.apkgMode = 'main';
await openImport(page);
await uploadFile(page, {
    name: 'regression.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('word,translation\nabundant,丰富的\ncandid,坦率的\n', 'utf8'),
});
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 15000 });
assert.equal(
    await page.locator('[data-testid="wordlist-import-steps"] li').count(),
    3,
    'CSV keeps the 3-step indicator',
);
assert.equal(await page.getByTestId('wordlist-import-map-word').inputValue(), '0');
assert.equal(
    await page.getByTestId('wordlist-import-stats').innerText(),
    '共 2 行 · 有效 2 · 跳过 0',
);
assert.equal(await page.getByTestId('wordlist-import-apkg-map-note').count(), 0);
await page.getByTestId('wordlist-import-next').click();
await page.getByTestId('wordlist-import-name').waitFor();
assert.equal(await page.getByTestId('wordlist-import-name').inputValue(), 'regression');
await page.getByTestId('wordlist-import-submit').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden', timeout: 15000 });
assert.equal(state.importBodies.length, 2);
assert.deepEqual(state.importBodies[1].items, [
    { word: 'abundant', translation: '丰富的' },
    { word: 'candid', translation: '坦率的' },
]);
assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);

// ── I) 375: APKG config step fits, screenshots for both breakpoints ────────
// Let the welcome/import toast clear so the 375 shot shows only the wizard.
await page.waitForFunction(() => document.querySelectorAll('[data-testid="toast"]').length === 0,
    null, { timeout: 12000 }).catch(() => {});
await page.setViewportSize({ width: 375, height: 812 });
await gotoWordbook(page);
await openImport(page);
await uploadFile(page, {
    name: 'GRE.apkg',
    buffer: Buffer.alloc(1024 * 1024, 0x50),
});
await waitApkgStep(page);
const overflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    body: document.body.scrollWidth,
    view: window.innerWidth,
}));
assert.ok(overflow.doc <= overflow.view + 1, `document overflows horizontally: ${JSON.stringify(overflow)}`);
assert.ok(overflow.body <= overflow.view + 1, `body overflows horizontally: ${JSON.stringify(overflow)}`);
assert.equal(await page.getByTestId('wordlist-import-apkg-deck').isVisible(), true);
assert.equal(await page.getByTestId('wordlist-import-apkg-preview-title').isVisible(), true);
assert.match(await page.getByTestId('wordlist-import-apkg-stats').innerText(), /将导入 7,512 条/);
await page.screenshot({ path: shot('375'), fullPage: false });
await page.getByTestId('wordlist-import-next').click();
await page.getByTestId('wordlist-import-map-word').waitFor({ timeout: 15000 });
const mapOverflow = await page.evaluate(() => ({
    doc: document.documentElement.scrollWidth,
    view: window.innerWidth,
}));
assert.ok(mapOverflow.doc <= mapOverflow.view + 1, `map step overflows at 375: ${JSON.stringify(mapOverflow)}`);
// map → apkg → file, then cancel (the APKG step has no cancel of its own).
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-back').click();
await page.getByTestId('wordlist-import-cancel').click();
await page.getByTestId('wordlist-import-dialog').waitFor({ state: 'hidden' });

assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);

await context.close();
await browser.close();
console.log('apkg-import acceptance: PASS');
console.log(`  checks passed: ${assertionsPassed}`);
console.log(`  apkg parses: ${state.apkgCalls} · imports: ${state.importBodies.length} · imported items: ${state.importBodies[0]?.items.length ?? 0}`);
console.log(`  screenshots: ${SHOTS}/apkg-import-*.png`);
