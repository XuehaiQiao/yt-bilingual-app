// Playwright acceptance for specs/004 v1.1 「已掌握不标」 (mastered/ignored
// words are no longer highlighted).
//
//   A) signed-in: `GET /api/review/words?mastered=1&limit=200` feeds the shared
//      ignored-words store; marking a word mastered in the dictionary card makes
//      its inline mark disappear immediately (targeted: other above-threshold
//      words stay marked) and undo brings it back — with no new classify call.
//      A mastered word from the list is not marked on page load; a failed list
//      request degrades to "no filter" (highlights stay, reading unaffected).
//   B) guest: the card says 「忽略此词」 (not 已掌握/我会了), writes the local
//      table only (no /api/review/words GET), the mark disappears, survives a
//      reload through localStorage, and undo restores it.
//
// Updated for the unified word-list UI (commit 381440f): the word book's guest
// write path is now the expanded row action (expand → 我会了) and the undo lives
// in the 已掌握/我会了 tab's expanded row; the removed 学习/已掌握 segment is
// replaced by the real tab. The reader/highlight contract is unchanged.
//
// Every /api/** request is mocked; nothing touches :8000 or :5173.
// Run: APP_URL=http://127.0.0.1:5199/ node scripts/mastered-filter-acceptance.mjs
// Shots: /tmp/mastered-filter-*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Count executed assertions so a green run reports how many checks passed.
let assertionsPassed = 0;
for (const name of ['ok', 'equal', 'deepEqual', 'match']) {
    const original = assert[name];
    assert[name] = (...args) => {
        original(...args);
        assertionsPassed += 1;
    };
}

const BASE = process.env.APP_URL || 'http://127.0.0.1:5199/';
const SHOTS = '/tmp';
const GUEST_KEY = 'yt_bilingual_guest_mastered_words';
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
// A throwaway page that mounts the real WordPopover with the real providers,
// so the guest branch (unreachable in the app because word lookup is behind the
// AI login gate) can still be exercised and screenshotted. Deleted afterwards.
const HARNESS = path.resolve(SCRIPT_DIR, '../frontend/mastered-filter-harness.html');
const HARNESS_HTML = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <title>mastered-filter harness</title>
  <link rel="stylesheet" href="/src/index.css" />
</head>
<body style="background:#09090b">
  <div id="root"></div>
  <script type="module">
    import React from 'react';
    import { createRoot } from 'react-dom/client';
    import { AuthProvider } from '/src/lib/auth.tsx';
    import { I18nProvider } from '/src/i18n/I18nProvider.tsx';
    import { WordPopover } from '/src/components/WordPopover.tsx';
    createRoot(document.getElementById('root')).render(
      React.createElement(I18nProvider, null,
        React.createElement(AuthProvider, null,
          React.createElement(WordPopover, {
            word: 'luminous',
            context: 'The quiet morning begins with a luminous walk before breakfast.',
            x: 420,
            y: 220,
            onClose: () => {},
            onToggleFavorite: () => {},
            isFavorited: false,
            onSwitchWord: () => {},
          }))));
  </script>
</body>
</html>
`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const EN = [
    'The quiet morning begins with a luminous walk before breakfast.',
    'Cities hold a quiet cosmos inside ordinary streets and public benches.',
];
const ZH = [
    '安静的早晨从早餐前一段明亮的散步开始。',
    '城市在寻常街道与公共长椅里藏着一个安静的宇宙。',
];
const HARD_WORDS = new Set(['luminous']); // B2
const BEYOND_WORDS = new Set(['cosmos']); // C1+

// One vocabulary favorite so the word book's 我的单词 list renders a row for
// the guest write path (the only reachable entry to the shared local table for
// guests — the dictionary card is behind the AI login gate).
const FAVORITE = {
    id: 'f1',
    videoId: '',
    start: 0,
    en_text: 'luminous',
    zh_text: '/ˈluːmɪnəs/ 发光的；明亮的',
    added_at: 1763000000000,
    type: 'vocabulary',
    highlights: [],
    source_kind: 'article',
    source_ref: 'art1',
    source_title: 'Habits and Cities',
    context_en: EN[0],
    context_zh: ZH[0],
};

const state = {
    /** 'signedIn' | 'guest' — decides what /api/auth/me answers. */
    mode: 'signedIn',
    /** Lemmas in the mocked mastered list. */
    mastered: new Set(),
    /** Make the mastered-list GET fail (degradation check). */
    masteredFail: false,
    masteredFetches: 0,
    masteredUrls: [],
    guestMasteredFetches: 0,
    classifyRequests: 0,
    patchCount: 0,
};

function levelForWord(word) {
    const normalized = String(word).trim().toLowerCase();
    if (!normalized) return null;
    if (HARD_WORDS.has(normalized)) return 'B2';
    if (BEYOND_WORDS.has(normalized)) return 'C1+';
    if (normalized.length >= 11) return 'C1+';
    if (!/^[a-z][a-z'’-]*$/.test(normalized)) return null;
    return 'A1';
}

const publicWord = (lemma, mastered) => ({
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
    createdAt: Date.now(),
    mastered,
    sources: [],
});

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
    // B1 (moonwalk): B2/C1+ words are above the threshold and get marked.
    localStorage.setItem('yt_bilingual_vocab_level', 'moonwalk');
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const CORS = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

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

    // ── session + app shell ───────────────────────────────────────────────
    if (pathname === '/api/auth/me') {
        return state.mode === 'signedIn'
            ? respond({ user: { id: 'u-mf', email: 'mastered@example.com', username: 'Reader' }, isAdmin: false, guest: false })
            : respond({ user: null, guest: true });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-mf', email: 'mastered@example.com', username: 'Reader', credits: 12, memberSince: 1763000000000 },
            monthSpendUsd: 0.12,
            usageToday: { minutes: 8 },
            version: 'test',
            preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
    }
    if (pathname === '/api/favorites' && method === 'GET') return respond([FAVORITE]);
    if (pathname === '/api/models') {
        return respond({
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/report/week') {
        return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    }
    if (pathname === '/api/placement/profile') {
        return respond({
            profile: {
                cefr: 'A2–B1',
                levelBandLow: 'A2',
                levelBandHigh: 'B1',
                vocabEstimate: 2500,
                readingEstimate: null,
                confidence: 0.7,
                confidenceLabel: 'medium',
                confidenceLabelZh: '中',
                pseudoWordSuspicion: 0,
                updatedAt: 1763000000000,
                source: 'placement',
                strengths: [],
                weaknesses: [],
                advice: null,
                measuredDomains: ['vocab'],
                notMeasured: ['listening', 'speaking', 'writing'],
                preliminary: false,
                sampleSize: 32,
                disclaimer: '',
            },
            preliminary: false,
            sampleSize: 32,
            disclaimer: '',
        });
    }
    if (pathname === '/api/ability/profile') {
        return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });
    }
    if (pathname === '/api/review/stats') {
        return respond({
            targetLang: 'zh-CN', now: Date.now(), today: '2026-11-22', dueToday: 0, dueNow: 0,
            reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
            suspendedWords: 0, streakDays: 0,
        });
    }
    if (pathname === '/api/recommendations') {
        return respond({ items: [], basis: { band: 'A2–B1', source: 'default' }, preliminary: false });
    }
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/library/articles') return respond({ articles: [] });

    // ── the mastered list under test ──────────────────────────────────────
    if (pathname === '/api/review/words' && method === 'GET') {
        if (state.mode === 'guest') {
            // Guests must never ask for the server mastered list.
            state.guestMasteredFetches += 1;
            return fail(403, 'login required');
        }
        state.masteredFetches += 1;
        state.masteredUrls.push(url.search);
        if (state.masteredFail) return fail(500, 'review table unavailable');
        const words = [...state.mastered].map((lemma) => publicWord(lemma, true));
        return respond({ targetLang: 'zh-CN', now: Date.now(), total: words.length, words });
    }
    if (pathname === '/api/review/words' && method === 'PATCH') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').toLowerCase();
        state.patchCount += 1;
        if (body.mastered === true) state.mastered.add(lemma);
        else state.mastered.delete(lemma);
        return respond({ status: 'ok', word: publicWord(lemma, body.mastered === true) });
    }
    if (pathname === '/api/review/words' && method === 'POST') {
        const body = request.postDataJSON() || {};
        const lemma = String(body.lemma ?? '').toLowerCase();
        state.mastered.delete(lemma); // re-adding forces mastered=0 server-side
        return respond({ status: 'ok', word: publicWord(lemma, false) });
    }

    // ── classify + dictionary ─────────────────────────────────────────────
    if (pathname === '/api/vocabulary/classify') {
        const body = request.postDataJSON() || {};
        const items = Array.isArray(body.items) ? body.items : [];
        state.classifyRequests += 1;
        return respond({
            items: items.map((item) => {
                const text = String(item?.text ?? '');
                return { text, level: levelForWord(text), proper: false };
            }),
        });
    }
    if (pathname === '/api/define') {
        const body = request.postDataJSON() || {};
        const word = String(body.word || 'word');
        return respond({
            word,
            lemma: word.toLowerCase(),
            ipa: '/ˈluːmɪnəs/',
            pos: 'adj.',
            zh: '发光的；明亮的',
            definition_en: 'giving off light',
            example: 'A luminous morning begins with a cup of tea.',
        });
    }

    // ── article reader ────────────────────────────────────────────────────
    if (pathname === '/api/articles' && method === 'GET') {
        return respond({
            articles: [{
                articleId: 'art1',
                title: 'Habits and Cities',
                site: 'example.com',
                sourceUrl: null,
                lang: 'en',
                wordCount: EN.join(' ').split(/\s+/).length,
                createdAt: 1763000000000,
                paragraphCount: EN.length,
                progress: null,
            }],
        });
    }
    if (pathname === '/api/article/art1' && method === 'GET') {
        const paragraphs = EN.map((text, idx) => ({
            idx,
            text,
            translation: ZH[idx] ?? null,
            translationModel: 'deepseek-chat',
            translationFailed: false,
        }));
        return respond({
            articleId: 'art1',
            title: 'Habits and Cities',
            site: 'example.com',
            sourceUrl: null,
            lang: 'en',
            wordCount: EN.join(' ').split(/\s+/).length,
            createdAt: 1763000000000,
            targetLang: url.searchParams.get('targetLang') || 'zh-CN',
            paragraphs,
            progress: null,
            stats: { total: paragraphs.length, translated: paragraphs.length, untranslated: 0 },
        });
    }
    if (/^\/api\/article\/[^/]+\/progress$/.test(pathname) && method === 'PUT') {
        return respond({ articleId: 'art1', paragraphIdx: 0, updatedAt: Date.now() });
    }

    // Any unrelated background endpoint: an empty object, never a blocking 404.
    if (pathname.startsWith('/api/')) return respond({});
    return fail(404, `unmocked ${method} ${pathname}`);
});

const shot = async (name) => {
    await page.screenshot({ path: `${SHOTS}/mastered-filter-${name}.png`, fullPage: false });
    console.log(`shot: mastered-filter-${name}.png`);
};

async function waitApp() {
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 20000 });
    await sleep(250);
}

async function gotoReader() {
    await page.goto(`${BASE}#/app/content/reader/art1`, { waitUntil: 'domcontentloaded' });
    await waitApp();
    await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
}

// A same-URL `page.goto` with only a hash is a same-document navigation, so it
// would NOT reset the module-level ignored-words store or re-run the session
// bootstrap. Scenario switches that need a fresh app (new auth mode, new
// mastered list) must use a real reload.
async function goHash(hash) {
    await page.evaluate((next) => { window.location.hash = next; }, hash);
    await sleep(500);
}

async function reloadReader() {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp();
    await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
}

const highlightAttr = (testId, word) => page
    .locator(`[data-testid=${testId}] [data-word-hit="${word}"]`)
    .getAttribute('data-highlight');

async function waitHighlighted(testId, word, expected = '1') {
    await page.waitForFunction(
        ({ testId: id, word: target, expected: value }) => {
            const paragraph = document.querySelector(`[data-testid=${id}]`);
            const found = paragraph?.querySelector(`[data-word-hit="${target}"]`);
            return Boolean(found) && found.getAttribute('data-highlight') === (value === '1' ? '1' : null);
        },
        { testId, word, expected },
        { timeout: 15000 },
    );
}

async function closePopover() {
    const overlay = page.locator('[data-testid=word-popover-overlay]');
    if (await overlay.count()) {
        await overlay.click({ position: { x: 6, y: 6 } }).catch(() => {});
        await page.waitForTimeout(250);
    }
}

async function openCard(word) {
    await closePopover();
    await page.locator(`[data-testid=reader-en-0] [data-word-hit="${word}"]`).click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid=word-popover]').getByText('发光的；明亮的').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(200);
}

const masteredButtonLabel = async () => (
    await page.locator('[data-testid=word-popover-mastered]').innerText()
).trim();

// ── A) signed-in ──────────────────────────────────────────────────────────
state.mode = 'signedIn';
state.mastered = new Set();
state.masteredFail = false;

await gotoReader();
await waitHighlighted('reader-en-0', 'luminous');
await waitHighlighted('reader-en-1', 'cosmos');
assert.ok(state.masteredFetches >= 1, 'signed-in load must request the mastered list');
assert.ok(
    state.masteredUrls.every((query) => query.includes('mastered=1') && query.includes('limit=200')),
    `mastered list request must carry mastered=1 & limit=200; got ${JSON.stringify(state.masteredUrls)}`,
);
await shot('signedin-before-mark');

await openCard('luminous');
assert.equal(await masteredButtonLabel(), '我已掌握', 'signed-in label stays 我已掌握');
const classifyBeforeMark = state.classifyRequests;

await page.locator('[data-testid=word-popover-mastered]').click();
await page.waitForFunction(
    () => document.querySelector('[data-testid=reader-en-0] [data-word-hit="luminous"]')?.getAttribute('data-highlight') === null,
    null,
    { timeout: 10000 },
);
assert.equal(state.patchCount, 1, 'mastered action must PATCH the server');
assert.ok(state.mastered.has('luminous'), 'PATCH must record the mastered word');
assert.equal(await highlightAttr('reader-en-1', 'cosmos'), '1', 'other above-threshold words stay marked');
assert.equal(state.classifyRequests, classifyBeforeMark, 'marking must not re-run classify');
await sleep(150);
await shot('signedin-after-mark');

// Undo restores the mark from the same store (no reload, no re-classify).
await closePopover();
await page.locator('[data-testid=reader-en-0] [data-word-hit="luminous"]').click();
await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 10000 });
await sleep(300);
assert.equal(await masteredButtonLabel(), '撤销', 'a mastered word offers 撤销');
const classifyBeforeUndo = state.classifyRequests;
await page.locator('[data-testid=word-popover-mastered]').click();
await waitHighlighted('reader-en-0', 'luminous');
assert.ok(!state.mastered.has('luminous'), 'undo must clear the mastered word');
assert.equal(state.classifyRequests, classifyBeforeUndo, 'undo must not re-run classify');
await closePopover();

// A mastered word from the list is not marked on page load.
state.mastered = new Set(['luminous']);
const fetchesBeforeReload = state.masteredFetches;
await reloadReader();
await waitHighlighted('reader-en-1', 'cosmos');
await waitHighlighted('reader-en-0', 'luminous', '0');
assert.ok(state.masteredFetches > fetchesBeforeReload, 'each page load reads the mastered list');
await shot('signedin-unmarked-on-load');

// Failed list request: silent degradation, highlights stay (fail open).
state.masteredFail = true;
await reloadReader();
await waitHighlighted('reader-en-1', 'cosmos');
await waitHighlighted('reader-en-0', 'luminous');
assert.equal(await page.locator('[data-testid=reader-en-0] [role=alert]').count(), 0,
    'a failed mastered list must not surface an error in the reader');
await shot('signedin-list-fail-degraded');

// ── B) guest ──────────────────────────────────────────────────────────────
state.mode = 'guest';
state.masteredFail = false;
state.mastered = new Set();
state.guestMasteredFetches = 0;
await page.evaluate((key) => localStorage.removeItem(key), GUEST_KEY);

await reloadReader();
await waitHighlighted('reader-en-0', 'luminous');
await waitHighlighted('reader-en-1', 'cosmos');
assert.equal(await page.evaluate((key) => localStorage.getItem(key), GUEST_KEY), null,
    'guest table starts empty');

// Guests cannot open the dictionary card: word lookup is an AI entry, so the
// app's requireAi() shows the login overlay before the card mounts (pre-existing
// gate, unchanged by this task). The reachable guest write path for the same
// local table is the word book's 「我会了」/「撤销」 toggle; both end up in the
// shared ignored-words store, so the highlight assertion below still exercises
// the exact requirement (guest mark → mark gone, survives a reload).
await goHash('#/app/profile/vocabulary');
// Row actions live inside the expanded area (shared WordTable, 381440f).
const guestExpand = page.locator('[data-testid=vocab-mine-expand-f1]');
await guestExpand.waitFor({ state: 'visible', timeout: 20000 });
await guestExpand.click();
const guestMasterButton = page.locator('[data-testid=vocab-mine-master-f1]');
await guestMasterButton.waitFor({ state: 'visible', timeout: 20000 });
assert.equal((await guestMasterButton.innerText()).trim(), '我会了',
    'word book keeps its own guest label');
await shot('guest-wordbook-before-ignore');
await guestMasterButton.click();
await page.waitForFunction(
    (key) => (localStorage.getItem(key) ?? '').includes('luminous'),
    GUEST_KEY,
    { timeout: 10000 },
);
await shot('guest-wordbook-after-ignore');

// Back to the reader: the same local table now filters the mark.
await goHash('#/app/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
await waitHighlighted('reader-en-1', 'cosmos');
await waitHighlighted('reader-en-0', 'luminous', '0');
assert.equal(await highlightAttr('reader-en-1', 'cosmos'), '1', 'guest ignore is targeted');
assert.equal(state.guestMasteredFetches, 0, 'guests must never request the server mastered list');
await shot('guest-after-ignore');

// The guest mark survives a full reload through localStorage only.
await page.reload({ waitUntil: 'domcontentloaded' });
await waitApp();
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
await waitHighlighted('reader-en-1', 'cosmos');
await waitHighlighted('reader-en-0', 'luminous', '0');
assert.ok(
    (await page.evaluate((key) => localStorage.getItem(key), GUEST_KEY)).includes('luminous'),
    'guest table keeps the ignored word after reload',
);
assert.equal(state.guestMasteredFetches, 0, 'guest reload still makes no mastered-list request');
await shot('guest-after-reload');

// Undo from the word book puts the mark back and clears the local table. The
// marked row now lives in the 已掌握 (guest: 我会了) tab, so open that tab and
// expand the row before finding its 撤销 action.
await goHash('#/app/profile/vocabulary');
await page.locator('[data-testid=vocab-tab-mastered]').waitFor({ state: 'visible', timeout: 20000 });
assert.equal((await page.locator('[data-testid=vocab-tab-mastered]').innerText()).trim().startsWith('我会了'), true,
    'guest tab reads 我会了');
await page.locator('[data-testid=vocab-tab-mastered]').click();
await page.locator('[data-testid=vocab-mastered-list]').waitFor({ state: 'visible', timeout: 20000 });
await page.locator('[data-testid=vocab-mastered-expand-luminous]').click();
const guestUndoButton = page.locator('[data-testid=vocab-mastered-undo-luminous]');
await guestUndoButton.waitFor({ state: 'visible', timeout: 20000 });
assert.equal((await guestUndoButton.innerText()).trim(), '撤销', 'guest undo label in the word book');
await guestUndoButton.click();
await page.waitForFunction(
    (key) => !(localStorage.getItem(key) ?? '').includes('luminous'),
    GUEST_KEY,
    { timeout: 10000 },
);
await goHash('#/app/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
await waitHighlighted('reader-en-0', 'luminous');
assert.equal(state.guestMasteredFetches, 0, 'guest undo still makes no mastered-list request');
await shot('guest-after-undo');

// ── C) guest dictionary card (component harness) ──────────────────────────
// In the app a guest never reaches the card: `App.handleWordLookup` calls
// `requireAi()`, which opens the login overlay before the popover mounts
// (pre-existing M7b gate; unchanged by this task). This harness mounts the real
// WordPopover under the real providers with a mocked guest session, so the
// guest branch — 「忽略此词」 copy, local-table write, immediate label flip —
// is still verified in a browser and screenshotted.
fs.writeFileSync(HARNESS, HARNESS_HTML);
const harnessErrors = [];
try {
    const harness = await context.newPage();
    harness.on('pageerror', (error) => harnessErrors.push(String(error)));
    await harness.goto(`${BASE}mastered-filter-harness.html`, { waitUntil: 'domcontentloaded' });
    await harness.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 15000 });
    await harness.locator('[data-testid=word-popover-mastered]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal((await harness.locator('[data-testid=word-popover-mastered]').innerText()).trim(), '忽略此词',
        'guest card label is 忽略此词 (never 已掌握/我会了)');
    await harness.screenshot({ path: `${SHOTS}/mastered-filter-guest-card-before-ignore.png` });
    console.log('shot: mastered-filter-guest-card-before-ignore.png');

    // Clearing the app-side evidence first keeps this assertion about the card.
    await page.evaluate((key) => localStorage.removeItem(key), GUEST_KEY);
    await harness.locator('[data-testid=word-popover-mastered]').click();
    await harness.waitForFunction((key) => (localStorage.getItem(key) ?? '').includes('luminous'), GUEST_KEY, { timeout: 10000 });
    await harness.waitForFunction(
        () => document.querySelector('[data-testid=word-popover-mastered]')?.textContent?.trim() === '撤销忽略',
        null,
        { timeout: 10000 },
    );
    // Cross-document sync: the reader page hears the storage event and drops
    // the mark it had just restored (guest state is shared per origin).
    await waitHighlighted('reader-en-0', 'luminous', '0');
    await harness.screenshot({ path: `${SHOTS}/mastered-filter-guest-card-after-ignore.png` });
    console.log('shot: mastered-filter-guest-card-after-ignore.png');

    await harness.locator('[data-testid=word-popover-mastered]').click();
    await harness.waitForFunction(
        () => document.querySelector('[data-testid=word-popover-mastered]')?.textContent?.trim() === '忽略此词',
        null,
        { timeout: 10000 },
    );
    await waitHighlighted('reader-en-0', 'luminous');
    assert.deepEqual(harnessErrors, [], `no pageerror in the guest-card harness; got ${JSON.stringify(harnessErrors)}`);
    await harness.close();
} finally {
    fs.rmSync(HARNESS, { force: true });
}

assert.deepEqual(pageErrors, [], `no pageerror expected; got ${JSON.stringify(pageErrors)}`);

console.log('\nPASS: mastered/ignored words are filtered at the render layer');
console.log(`- checks passed: ${assertionsPassed}`);
console.log(`- mastered list fetches (signed-in): ${state.masteredFetches}`);
console.log(`- guest mastered-list fetches (must be 0): ${state.guestMasteredFetches}`);
console.log(`- classify requests: ${state.classifyRequests}; PATCH: ${state.patchCount}`);
console.log(`- shots: ${SHOTS}/mastered-filter-*.png`);

await browser.close();
