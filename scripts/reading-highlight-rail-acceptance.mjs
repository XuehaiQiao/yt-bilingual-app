// Acceptance check for specs/042 (reading right rail = this page's highlighted
// words + one-click favorite).
//
// Real React readers, fully mocked API. Per reader (imported article / free
// library article / public-domain book / imported book):
//   - the rail title is 「本页标亮」 and the count is the number of unique marks;
//   - the old word-book list is gone from the rail (but the top-bar word-book
//     chip and its count stay — that is the shared favorite surface);
//   - rows show word / CEFR badge / analysis gloss (`—` when missing);
//   - the star saves via App's optimistic path (POST payload carries
//     type=vocabulary, id=vocab-<ref>-<word>, videoId/start and source_*),
//     the top-bar count moves immediately, and a second click removes it;
//   - a failed POST rolls the star back and shows the inline error;
//   - guests get the login prompt instead of a write;
//   - turning the switch off / a page with no marks shows the explicit empty
//     state and lists no words.
// Screenshots at 1440 and 375 for all four pages.
//
// Run (needs `npm run dev` on :5173; Playwright lives in scripts/node_modules):
//   node scripts/reading-highlight-rail-acceptance.mjs
//   APP_URL=http://127.0.0.1:5174 node scripts/reading-highlight-rail-acceptance.mjs
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name, kind, width) => `/tmp/reading-highlight-rail-${name}-${kind}-${width}@${HEAD}.png`;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── fixtures ───────────────────────────────────────────────────────────────
// Every page uses its own marked words so the expected rail is unambiguous.
// `orbit` (A2) is the slider's default; B2/C1 are above it, A1 is not.
const CLASSIFY_LEVELS = {
    quiet: 'B2',
    rhythm: 'C1',
    pace: 'B2',
    kettle: 'B2',
    softly: 'C1',
    window: 'B2',
    carriage: 'B2',
    governess: 'C1',
    ballroom: 'B2',
    rabbit: 'B2',
    curious: 'C1',
    hole: 'B2',
};

const ARTICLE_DETAIL = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 40,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    // Must equal the slider id the reader was opened at (`highlight.level` is
    // the VocabLevelId, not a CEFR label), or the payload analysis is treated
    // as belonging to another level and is dropped.
    analysisLevel: 'orbit',
    analysisUnavailableReason: null,
    analysisUsed: null,
    analysisLimit: null,
    analysisResetAt: null,
    idioms: [],
    culture: [],
    paragraphs: [
        {
            idx: 0,
            text: 'The quiet river carries a gentle rhythm through the old city.',
            translation: '安静的河流带着轻柔的节奏穿过老城。',
            translationModel: 'deepseek-chat',
            translationFailed: false,
            // `parseParagraph` reads the analysis `highlights` array (glosses
            // are keyed by en_word there), not a pre-keyed object.
            highlights: [
                { en_word: 'quiet', zh_word: '安静的', color: '#f59e0b' },
                { en_word: 'rhythm', zh_word: '节奏', color: '#f59e0b' },
            ],
        },
        {
            idx: 1,
            text: 'A quiet street keeps its own pace after the rain.',
            translation: '雨后的安静街道保持着自己的节奏。',
            translationModel: 'deepseek-chat',
            translationFailed: false,
            highlights: [],
        },
    ],
    progress: null,
    stats: { total: 2, translated: 2, untranslated: 0 },
};

const ARTICLE_SUMMARY = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 40,
    createdAt: 1763000000000,
    paragraphCount: 2,
    progress: null,
};

const LIBRARY_ARTICLE = {
    id: 'lib1',
    title: 'A Quiet Morning',
    level: 'A2',
    wordCount: 24,
    author: 'LinguaTrek',
    license: 'CC BY-NC 4.0',
    topic: 'life',
    source: 'original',
    // The free-library payload merges analysis inline (specs/028 × 024): the
    // top-level idioms/culture marks the analysis as attached, the per-paragraph
    // `highlights` arrays carry the contextual glosses.
    analysisLevel: 'orbit',
    analysisVersion: 'v1',
    targetLang: 'zh-CN',
    idioms: [{ blockId: 0, phrase: 'sings softly', meaning: '轻声鸣唱', kind: 'idiom' }],
    culture: [],
    paragraphs: [
        {
            en: 'The kettle sings softly while the house is silent.',
            zh: '水壶轻声鸣唱，整座房子一片寂静。',
            highlights: [{ en_word: 'kettle', zh_word: '水壶', color: '#f59e0b' }],
        },
        {
            en: 'A narrow window opens onto the garden.',
            zh: '一扇窄窗朝向花园。',
            highlights: [{ en_word: 'window', zh_word: '窗户', color: '#f59e0b' }],
        },
    ],
};

const BOOK = {
    id: 'b1',
    seriesId: 's1',
    title: 'Pride and Prejudice',
    titleZh: '傲慢与偏见',
    author: 'Jane Austen',
    year: 1813,
    level: 'B1',
    status: 'available',
    source: 'Project Gutenberg',
    license: 'Public domain',
    sourceUrl: 'https://www.gutenberg.org/ebooks/1342',
    totalChapters: 2,
    readableChapters: 2,
    translatedChapters: 2,
    publicDomainBasis: 'Published in 1813.',
    chapters: [
        { n: 1, title: 'Chapter 1', titleZh: '第一章', translated: true },
        { n: 2, title: 'Chapter 2', titleZh: '第二章', translated: true },
    ],
    series: {
        id: 's1', title: 'Test Series', author: 'Jane Austen', description: 'test',
        totalBooks: 1, availableBooks: 1, readableChapters: 2, translatedChapters: 2,
        excluded: [], books: [],
    },
};

function bookChapter(n) {
    const paragraphs = n === 1
        ? [
            { index: 0, en: 'The carriage stopped before the white house.', zh: '马车停在白房子前。', highlights: [{ en_word: 'carriage', zh_word: '马车', color: '#f59e0b' }] },
            { index: 1, en: 'A governess waited in the hall.', zh: '一位家庭教师在门厅等候。', highlights: [{ en_word: 'governess', zh_word: '家庭教师', color: '#f59e0b' }] },
            { index: 2, en: 'The ballroom doors stood open.', zh: '舞厅的门敞开着。', highlights: [] },
        ]
        : [
            { index: 0, en: 'Chapter two begins with a letter.', zh: '第二章从一封信开始。', highlights: [] },
        ];
    return {
        bookId: 'b1',
        bookTitle: BOOK.title,
        bookTitleZh: BOOK.titleZh,
        author: BOOK.author,
        level: BOOK.level,
        license: BOOK.license,
        chapter: n,
        chapterTitle: `Chapter ${n}`,
        sourceTitle: BOOK.title,
        totalChapters: 2,
        importedChapters: 2,
        seriesId: 's1',
        seriesTitle: 'Test Series',
        source: { provider: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt', fetchedAt: '2026-11-17T00:00:00Z', degraded: false },
        paragraphs,
        missingTranslations: 0,
        translationStatus: 'cached',
        translated: true,
        translatedChapters: 2,
        idioms: [],
        culture: [],
        analysisLevel: 'B1',
    };
}

const IMPORTED_BOOK = {
    bookId: 'ib1',
    sourceType: 'gutenberg',
    source: { provider: 'gutenberg', url: 'https://www.gutenberg.org/ebooks/11' },
    sourceUrl: 'https://www.gutenberg.org/ebooks/11',
    externalId: '11',
    title: 'Alice in Wonderland',
    author: 'Lewis Carroll',
    language: 'en',
    chapterCount: 1,
    translatedChapters: 1,
    targetLang: 'zh-CN',
    createdAt: 1763000000000,
    updatedAt: 1763000000000,
    chapters: [{ n: 1, title: 'Down the Rabbit-Hole', translated: true, translatedParagraphs: 2 }],
};

const IMPORTED_CHAPTER = {
    bookId: 'ib1',
    title: 'Alice in Wonderland',
    author: 'Lewis Carroll',
    sourceType: 'gutenberg',
    source: { provider: 'gutenberg', url: 'https://www.gutenberg.org/ebooks/11', fetchedAt: '2026-11-17T00:00:00Z', degraded: false },
    sourceUrl: 'https://www.gutenberg.org/ebooks/11',
    chapter: 1,
    chapterTitle: 'Down the Rabbit-Hole',
    chapterCount: 1,
    targetLang: 'zh-CN',
    translated: true,
    translatedChapters: 1,
    missingTranslations: 0,
    languagePoints: [{ blockId: 0, text: 'Rabbit-Hole', meaning: '兔子洞', kind: 'culture' }],
    idioms: [],
    culture: [],
    analysisLevel: 'B1',
    paragraphs: [
        { index: 0, en: 'The rabbit ran across the green field.', zh: '兔子跑过绿色的田野。', glosses: { rabbit: '兔子' } },
        { index: 1, en: 'A curious hole opened under the hedge.', zh: '树篱下出现了一个奇怪的洞。', glosses: { hole: '洞' } },
    ],
    quota: { feature: 'book_import_translate', limitPerDay: 10, usedToday: 0, remainingToday: 10, day: '2026-11-23' },
};

// ── mocked backend ─────────────────────────────────────────────────────────
const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

/**
 * One isolated backend per browser context: `favorites` survives page
 * navigations (like the real store) and `lastAdd` exposes the POST payload.
 */
function makeBackend({ guest = false } = {}) {
    return {
        guest,
        classify: 'normal',
        failAdd: false,
        favorites: [],
        adds: 0,
        removes: [],
        lastAdd: null,
    };
}

async function mockApi(context, backend) {
    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const method = request.method();
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
        const url = new URL(request.url());
        const path = url.pathname;
        const respond = (data, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: CORS,
            body: JSON.stringify(data),
        });

        if (path === '/api/auth/me') {
            return backend.guest
                ? respond({ guest: true, user: null, isAdmin: false })
                : respond({ guest: false, isAdmin: false, user: { id: 'u-rail', email: 'rail@example.com' } });
        }
        if (path === '/api/favorites' && method === 'GET') return respond(backend.favorites);
        if (path === '/api/favorites' && method === 'POST') {
            backend.adds += 1;
            if (backend.failAdd) return respond({ detail: 'mock write failure' }, 500);
            const body = request.postDataJSON() || {};
            backend.lastAdd = body;
            const stored = {
                id: body.id,
                videoId: body.videoId,
                start: body.time,
                en_text: body.text,
                zh_text: body.translation,
                added_at: body.addedAt,
                type: body.type,
                ...(body.meta || {}),
            };
            backend.favorites = backend.favorites.filter((item) => item.id !== stored.id);
            backend.favorites.push(stored);
            return respond({ favorite: stored });
        }
        if (path.startsWith('/api/favorites/') && method === 'DELETE') {
            const id = decodeURIComponent(path.slice('/api/favorites/'.length));
            backend.removes.push(id);
            backend.favorites = backend.favorites.filter((item) => item.id !== id);
            return respond({});
        }

        if (path === '/api/history' || path === '/api/subscriptions') return respond([]);
        if (path === '/api/shows') return respond({ shows: [] });
        if (path === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
                default: 'deepseek-chat',
            });
        }
        if (path === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
        if (path === '/api/placement/profile') return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
        if (path === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-23', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (path === '/api/review/words') return respond({ words: [], total: 0 });
        if (path === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
        if (path === '/api/content/difficulty/batch') return respond({ items: [] });
        if (path === '/api/vocabulary/classify') {
            const body = request.postDataJSON() || {};
            const allLow = backend.classify === 'all-a1';
            return respond({
                items: (body.items || []).map((item) => {
                    const text = typeof item.text === 'string' ? item.text : '';
                    const level = allLow ? 'A1' : (CLASSIFY_LEVELS[text.toLowerCase()] ?? 'A1');
                    return { text, level, proper: false };
                }),
            });
        }
        if (path === '/api/articles' && method === 'GET') return respond({ articles: [ARTICLE_SUMMARY] });
        if (path === '/api/article/art1') return respond(ARTICLE_DETAIL);
        if (path.match(/^\/api\/article\/art1\/(progress|translate)$/)) return respond({ ok: true, status: 'done' });
        if (path === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
        if (path === '/api/books/b1') return respond(BOOK);
        if (path === '/api/books/b1/chapters/1') return respond(bookChapter(1));
        if (path === '/api/books/b1/chapters/2') return respond(bookChapter(2));
        if (path === '/api/books/b1/progress' && method === 'PUT') return respond({ ok: true });
        if (path === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
        if (path === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);
        if (path === '/api/books/imported/ib1/progress' && method === 'PUT') return respond({ ok: true });
        if (path.startsWith('/api/')) return respond({});
        return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    });
}

async function newPage(browser, backend, { viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
        try {
            localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
            localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
            localStorage.setItem('yt_bilingual_vocab_level', 'orbit');
            localStorage.removeItem('yt_bilingual_reading_highlight');
        } catch {
            /* about:blank has no storage; real pages are covered next navigation. */
        }
    });
    await mockApi(context, backend);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return { context, page, errors };
}

// ── small async helpers ───────────────────────────────────────────────────
async function waitForNode(predicate, label, timeout = 10000) {
    const startedAt = Date.now();
    let lastError = null;
    while (Date.now() - startedAt < timeout) {
        try {
            if (await predicate()) return;
        } catch (error) {
            lastError = error;
        }
        await sleep(50);
    }
    throw new Error(`${label} timed out${lastError ? `: ${lastError}` : ''}`);
}

async function waitForAttr(page, selector, attr, value, label) {
    await page.waitForFunction(
        ({ selector: sel, attr: name, value: want }) =>
            document.querySelector(sel)?.getAttribute(name) === want,
        { selector, attr, value },
        { timeout: 10000 },
    ).catch(() => { throw new Error(`${label} timed out`); });
}

async function waitForText(page, selector, value, label) {
    await page.waitForFunction(
        ({ selector: sel, value: want }) =>
            (document.querySelector(sel)?.textContent ?? '').trim() === want,
        { selector, value },
        { timeout: 10000 },
    ).catch(() => { throw new Error(`${label} timed out`); });
}

const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

/** Screenshots must show the rail, not a leftover toast from the previous click. */
async function clearToasts(page) {
    const closers = page.locator('[data-testid="toast-close"]');
    for (let attempt = 0; attempt < 4; attempt += 1) {
        if ((await closers.count()) === 0) return;
        await closers.first().click({ timeout: 1000 }).catch(() => {});
        await sleep(120);
    }
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="toast"]').length === 0,
        null,
        { timeout: 6000 },
    ).catch(() => {});
}

async function openRoute(page, hash, ready) {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator(ready).waitFor({ state: 'visible', timeout: 20000 });
}

// ── per-page acceptance ───────────────────────────────────────────────────
const PAGES = [
    {
        name: 'reader',
        prefix: 'reader',
        hash: '/content/reader/art1',
        ready: '[data-testid="reader-en-0"]',
        sourceKind: 'article',
        ref: 'art1',
        sourceTitle: 'Habits and Cities',
        expected: [
            { word: 'quiet', level: 'B2', gloss: '安静的' },
            { word: 'rhythm', level: 'C1', gloss: '节奏' },
            { word: 'pace', level: 'B2', gloss: '—' },
        ],
    },
    {
        name: 'library',
        prefix: 'library',
        hash: '/learn/library/lib1',
        ready: '[data-testid="library-en-0"]',
        sourceKind: 'library_article',
        ref: 'lib1',
        sourceTitle: 'A Quiet Morning',
        expected: [
            { word: 'kettle', level: 'B2', gloss: '水壶' },
            { word: 'softly', level: 'C1', gloss: '—' },
            { word: 'window', level: 'B2', gloss: '窗户' },
        ],
    },
    {
        name: 'book',
        prefix: 'book',
        hash: '/content/book/b1',
        ready: '[data-testid="book-en-0"]',
        sourceKind: 'book',
        ref: 'b1',
        sourceTitle: 'Pride and Prejudice',
        expected: [
            { word: 'carriage', level: 'B2', gloss: '马车' },
            { word: 'governess', level: 'C1', gloss: '家庭教师' },
            { word: 'ballroom', level: 'B2', gloss: '—' },
        ],
    },
    {
        name: 'imported-book',
        prefix: 'imported-book',
        hash: '/content/imported-book/ib1',
        ready: '[data-testid="imported-book-en-0"]',
        sourceKind: 'imported_book',
        ref: 'ib1',
        sourceTitle: 'Alice in Wonderland',
        expected: [
            { word: 'rabbit', level: 'B2', gloss: '兔子' },
            { word: 'curious', level: 'C1', gloss: '—' },
            { word: 'hole', level: 'B2', gloss: '洞' },
        ],
    },
];

const results = [];

async function checkPage(browser) {
    const backend = makeBackend();
    const { context, page, errors } = await newPage(browser, backend);
    const screenshots = [];

    for (const entry of PAGES) {
        const { name, prefix, hash, ready, expected, sourceKind, ref, sourceTitle } = entry;
        // Each page starts from an empty store (the loop removes what it added),
        // but reset the counters so every assertion is per-page.
        backend.adds = 0;
        backend.removes = [];
        backend.lastAdd = null;
        await page.setViewportSize({ width: 1440, height: 1000 });
        await openRoute(page, hash, ready);

        const rail = page.locator(`[data-testid="${prefix}-rail-highlighted"]`);
        await rail.waitFor({ state: 'visible', timeout: 15000 });

        // First word marks classify finished; the rail orders by first appearance.
        const firstWord = expected[0].word;
        await page.locator(`[data-testid="${prefix}-rail-word-${firstWord}"]`)
            .waitFor({ state: 'visible', timeout: 20000 });
        await sleep(150);

        // ── title / count / no word-book list ─────────────────────────────
        assert.equal(clean(await rail.locator('h3').first().innerText()), '本页标亮', `${name}: rail title`);
        assert.equal(
            clean(await page.locator(`[data-testid="${prefix}-rail-count"]`).innerText()),
            `共 ${expected.length} 个标亮词`,
            `${name}: unique highlighted count`,
        );
        const railText = await rail.innerText();
        assert.ok(!railText.includes('单词本'), `${name}: rail still contains the word-book title`);
        assert.ok(!railText.includes('我的收藏'), `${name}: rail still contains the saved-words list`);
        assert.equal(
            await rail.locator('li[data-word]').count(),
            expected.length,
            `${name}: rendered row count`,
        );

        const rows = await rail.locator('li[data-word]').evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('data-word')));
        assert.deepEqual(rows, expected.map((item) => item.word), `${name}: row order`);

        // ── word / level / gloss ──────────────────────────────────────────
        for (const item of expected) {
            assert.equal(
                clean(await page.locator(`[data-testid="${prefix}-rail-level-${item.word}"]`).innerText()),
                item.level,
                `${name}: level of ${item.word}`,
            );
            assert.equal(
                clean(await page.locator(`[data-testid="${prefix}-rail-gloss-${item.word}"]`).innerText()),
                item.gloss,
                `${name}: gloss of ${item.word}`,
            );
        }

        const countLocator = page.locator('[data-testid="reading-wordbook-count"]');
        const star = page.locator(`[data-testid="${prefix}-rail-star-${firstWord}"]`);
        assert.equal(await star.getAttribute('aria-pressed'), 'false', `${name}: star starts hollow`);
        assert.equal(clean(await countLocator.innerText()), '0', `${name}: top-bar count starts at 0`);

        // ── one-click favorite → App optimistic path ──────────────────────
        await star.click();
        await waitForAttr(page, `[data-testid="${prefix}-rail-star-${firstWord}"]`, 'aria-pressed', 'true', `${name}: star filled`);
        await waitForText(page, '[data-testid="reading-wordbook-count"]', '1', `${name}: top-bar count +1`);
        await waitForNode(() => backend.favorites.length === 1, `${name}: mock favorite stored`);
        assert.equal(backend.adds, 1, `${name}: exactly one POST`);

        const draft = backend.lastAdd;
        const firstGloss = expected[0].gloss === '—' ? '' : expected[0].gloss;
        assert.deepEqual(
            {
                id: draft.id,
                type: draft.type,
                videoId: draft.videoId,
                time: draft.time,
                text: draft.text,
                translation: draft.translation,
            },
            {
                id: `vocab-${ref}-${firstWord}`,
                type: 'vocabulary',
                videoId: ref,
                time: 0,
                text: firstWord,
                translation: firstGloss,
            },
            `${name}: favorite draft`,
        );
        assert.equal(draft.meta.source_kind, sourceKind, `${name}: source_kind`);
        assert.equal(draft.meta.source_ref, ref, `${name}: source_ref`);
        assert.equal(draft.meta.source_title, sourceTitle, `${name}: source_title`);

        // ── evidence: filled star + top-bar count (add path is toast-free) ──
        await clearToasts(page);
        const fullShot = SHOT(name, 'page', 1440);
        await page.screenshot({ path: fullShot });
        const railShot1440 = SHOT(name, 'rail', 1440);
        await rail.screenshot({ path: railShot1440 });
        screenshots.push(fullShot, railShot1440);

        // ── 375: rail stacks below, no horizontal overflow ────────────────
        await page.setViewportSize({ width: 375, height: 812 });
        await sleep(350);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
        assert.ok(!overflow, `${name} 375: horizontal overflow`);
        await clearToasts(page);
        const railShot375 = SHOT(name, 'rail', 375);
        await rail.screenshot({ path: railShot375 });
        screenshots.push(railShot375);

        // ── star again = cancel ───────────────────────────────────────────
        await page.setViewportSize({ width: 1440, height: 1000 });
        await star.click();
        await waitForAttr(page, `[data-testid="${prefix}-rail-star-${firstWord}"]`, 'aria-pressed', 'false', `${name}: star hollow again`);
        await waitForText(page, '[data-testid="reading-wordbook-count"]', '0', `${name}: top-bar count -1`);
        await waitForNode(() => backend.removes.length === 1, `${name}: mock DELETE`);
        assert.deepEqual(backend.removes, [`vocab-${ref}-${firstWord}`], `${name}: DELETE id`);
        await waitForNode(() => backend.favorites.length === 0, `${name}: mock favorite removed`);

        results.push({ name, rows: expected.length, screenshots: [fullShot, railShot1440, railShot375] });
    }

    // ── failure: inline error + rollback (reader page) ────────────────────
    await page.setViewportSize({ width: 1440, height: 1000 });
    await openRoute(page, '/content/reader/art1', '[data-testid="reader-en-0"]');
    await page.locator('[data-testid="reader-rail-word-quiet"]').waitFor({ state: 'visible', timeout: 20000 });
    await sleep(150);
    backend.failAdd = true;
    await page.locator('[data-testid="reader-rail-star-rhythm"]').click();
    await page.locator('[data-testid="reader-rail-error-rhythm"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(clean(await page.locator('[data-testid="reader-rail-error-rhythm"]').innerText()), '收藏失败，请重试');
    assert.equal(await page.locator('[data-testid="reader-rail-star-rhythm"]').getAttribute('aria-pressed'), 'false', 'failure: star rolled back');
    assert.equal(clean(await page.locator('[data-testid="reading-wordbook-count"]').innerText()), '0', 'failure: top-bar count unchanged');
    assert.equal(backend.favorites.length, 0, 'failure: nothing stored');

    // Retry succeeds and clears the inline error.
    backend.failAdd = false;
    await page.locator('[data-testid="reader-rail-star-rhythm"]').click();
    await waitForAttr(page, '[data-testid="reader-rail-star-rhythm"]', 'aria-pressed', 'true', 'retry: star filled');
    await waitForText(page, '[data-testid="reading-wordbook-count"]', '1', 'retry: top-bar count');
    assert.equal(await page.locator('[data-testid="reader-rail-error-rhythm"]').count(), 0, 'retry: inline error cleared');
    await page.locator('[data-testid="reader-rail-star-rhythm"]').click();
    await waitForText(page, '[data-testid="reading-wordbook-count"]', '0', 'cleanup: top-bar count');
    results.push({ failure: 'inline error + rollback + retry' });

    // ── empty state 1: switch off ─────────────────────────────────────────
    await page.locator('[data-testid="reader-highlight-toggle"]').click();
    await waitForAttr(page, '[data-testid="reader-highlight-toggle"]', 'data-enabled', '0', 'toggle off');
    await page.locator('[data-testid="reader-rail-empty-off"]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(
        clean(await page.locator('[data-testid="reader-rail-count"]').innerText()),
        '共 0 个标亮词',
        'off: count is zero',
    );
    assert.equal(await page.locator('[data-testid="reader-rail-highlighted"] li[data-word]').count(), 0, 'off: no word rows');
    await clearToasts(page);
    const offShot = SHOT('reader', 'empty-off', 1440);
    await page.locator('[data-testid="reader-rail-highlighted"]').screenshot({ path: offShot });
    screenshots.push(offShot);
    await page.locator('[data-testid="reader-highlight-toggle"]').click();
    await waitForAttr(page, '[data-testid="reader-highlight-toggle"]', 'data-enabled', '1', 'toggle on');
    await page.locator('[data-testid="reader-rail-word-quiet"]').waitFor({ state: 'visible', timeout: 10000 });
    results.push({ emptyState: 'switch off' });

    // ── empty state 2: switched on, but no word above the threshold ──────
    backend.classify = 'all-a1';
    await openRoute(page, '/content/reader/art1', '[data-testid="reader-en-0"]');
    await page.locator('[data-testid="reader-rail-empty"]').waitFor({ state: 'visible', timeout: 10000 });
    await sleep(400); // let the classify response land; the state must persist
    assert.equal(await page.locator('[data-testid="reader-rail-empty"]').count(), 1, 'empty: explicit empty state');
    assert.equal(await page.locator('[data-testid="reader-rail-highlighted"] li[data-word]').count(), 0, 'empty: no word rows');
    assert.equal(
        clean(await page.locator('[data-testid="reader-rail-count"]').innerText()),
        '共 0 个标亮词',
        'empty: count is zero',
    );
    await clearToasts(page);
    const emptyShot = SHOT('reader', 'empty', 1440);
    await page.locator('[data-testid="reader-rail-highlighted"]').screenshot({ path: emptyShot });
    screenshots.push(emptyShot);
    results.push({ emptyState: 'no highlighted words' });

    assert.deepEqual(errors, [], `page errors: ${JSON.stringify(errors)}`);

    // ── guest gate: prompt login, never write ────────────────────────────
    const guestBackend = makeBackend({ guest: true });
    const guest = await newPage(browser, guestBackend);
    await openRoute(guest.page, '/content/reader/art1', '[data-testid="reader-en-0"]');
    await guest.page.locator('[data-testid="reader-rail-word-quiet"]').waitFor({ state: 'visible', timeout: 20000 });
    await sleep(150);
    assert.equal(
        clean(await guest.page
            .locator('[data-testid="reader-rail-star-quiet"]')
            .locator('xpath=..')
            .getAttribute('title')),
        '登录后可收藏',
        'guest: star explains the login gate',
    );
    await guest.page.locator('[data-testid="reader-rail-star-quiet"]').click();
    await guest.page.locator('[data-testid="guest-auth-overlay"]').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(guestBackend.adds, 0, 'guest: no favorite POST');
    assert.equal(guestBackend.favorites.length, 0, 'guest: nothing stored');
    assert.equal(clean(await guest.page.locator('[data-testid="reading-wordbook-count"]').innerText()), '0', 'guest: count unchanged');
    const guestShot = SHOT('reader', 'guest-gate', 1440);
    await guest.page.screenshot({ path: guestShot });
    results.push({ guestGate: 'login prompt, no write', screenshots: [guestShot] });
    await guest.context.close();

    await context.close();
    return screenshots;
}

// ── run ────────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const screenshots = await checkPage(browser);
await browser.close();

console.log(JSON.stringify({ status: 'PASS', head: HEAD, pages: results, screenshots }, null, 2));
