// Playwright acceptance for the two 2026-11-17 frontend requests:
//   ① public-domain book: first open of an untranslated chapter auto-calls
//     POST /api/books/{id}/chapters/{n}/translate, shows progress, then renders
//     the returned translation without a reload; cached chapters never POST;
//     a failed translation shows a reason + retry; partial chapters auto-fill;
//     the manual 「翻译本章」 entry stays available for retry/backfill.
//   ② the CEFR vocabulary axis moved from the content page into 我的 · 设置
//     (replacing the old read-only 词汇水平 row); the pick persists to
//     localStorage immediately.
//
// Every /api/** request is mocked, so no backend, database or LLM is touched.
//
// Run: node scripts/cefr-autotranslate-test.mjs   (needs `npm run dev` on :5173)
// Output: /tmp/cefr-autotranslate-shots/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/cefr-autotranslate-shots';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fixtures ───────────────────────────────────────────────────────────────
const EN = [
    'The quiet power of small habits shapes a good morning. A short walk before breakfast makes the whole day feel slower and calmer.',
    'Cities have always been shaped by the way people move through them. A street is not only a line on a map; it is a rhythm of footsteps, bicycles and buses.',
];
const ZH = [
    '小习惯的安静力量塑造一个美好的早晨。早餐前散一小段步，会让一整天都更慢、更平静。',
    '城市一直由人们穿行其中的方式塑造。街道不只是地图上的一条线，它还是脚步、自行车与公交的节奏。',
];
const VI = [
    'Sức mạnh lặng lẽ của những thói quen nhỏ tạo nên một buổi sáng tốt lành. Một vòng đi dạo ngắn trước bữa sáng khiến cả ngày trôi chậm và bình yên hơn.',
    'Các thành phố luôn được định hình bởi cách con người đi qua chúng. Một con phố không chỉ là một đường nét trên bản đồ.',
];

const SERIES = {
    id: 's1',
    title: 'Test Series',
    author: 'Jane Austen',
    description: 'A public-domain series used by the auto-translate acceptance test.',
    totalBooks: 4,
    availableBooks: 4,
    readableChapters: 4,
    translatedChapters: 1,
    excluded: [],
    books: [],
};

const BOOK_BASE = {
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
    totalChapters: 1,
    readableChapters: 1,
    publicDomainBasis: 'Published in 1813.',
};

/** zh state of the chapter as the mocked GET returns it. */
const CHAPTER_SPECS = {
    // b1: completely untranslated -> auto translate on first open.
    b1: { status: 'missing', zh: [null, null], delay: 1200 },
    // b2: complete shared cache -> no POST.
    b2: { status: 'cached', zh: ZH, delay: 0 },
    // b3: the first POST fails with 502, the retry succeeds.
    b3: { status: 'missing', zh: [null, null], delay: 300, failFirst: true },
    // b4: one paragraph already translated -> partial triggers the backfill.
    b4: { status: 'partial', zh: [ZH[0], null], delay: 900 },
};

// b5: two chapters, cached then missing -> switching chapters re-evaluates.
const MULTI_SPECS = {
    b5: {
        1: { status: 'cached', zh: ZH, delay: 0 },
        2: { status: 'missing', zh: [null, null], delay: 700 },
    },
};

function chapterSpec(bookId, n) {
    if (MULTI_SPECS[bookId]) return MULTI_SPECS[bookId][n] ?? null;
    return n === 1 ? CHAPTER_SPECS[bookId] ?? null : null;
}

function bookDetail(id, specs) {
    const entries = Object.entries(specs).map(([n, spec]) => ({
        n: Number(n),
        title: `Chapter ${n}`,
        titleZh: `第 ${n} 章`,
        translated: spec.status === 'cached',
    }));
    return {
        ...BOOK_BASE,
        id,
        totalChapters: entries.length,
        readableChapters: entries.length,
        translatedChapters: entries.filter((entry) => entry.translated).length,
        series: SERIES,
        chapters: entries,
    };
}

function chapterPayload(id, n, spec) {
    const zh = spec.zh;
    const missing = zh.filter((value) => !value).length;
    return {
        bookId: id,
        bookTitle: BOOK_BASE.title,
        bookTitleZh: BOOK_BASE.titleZh,
        author: BOOK_BASE.author,
        level: BOOK_BASE.level,
        license: BOOK_BASE.license,
        chapter: n,
        chapterTitle: `Chapter ${n}`,
        sourceTitle: BOOK_BASE.title,
        totalChapters: Object.keys(MULTI_SPECS[id] ?? { 1: 1 }).length,
        importedChapters: Object.keys(MULTI_SPECS[id] ?? { 1: 1 }).length,
        seriesId: SERIES.id,
        seriesTitle: SERIES.title,
        translationStatus: spec.status,
        translationSource: spec.status === 'cached' ? 'cache' : 'none',
        source: {
            provider: 'gutenberg',
            url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
            fetchedAt: '2026-11-17T00:00:00Z',
            degraded: false,
        },
        paragraphs: EN.map((en, index) => ({ index, en, zh: zh[index] ?? null })),
        missingTranslations: missing,
        translated: spec.status === 'cached',
        translatedChapters: spec.status === 'cached' ? 1 : 0,
    };
}

function translatedChapterPayload(id, n, lang) {
    const translated = lang === 'vi-VN' ? VI : ZH;
    return {
        ...chapterPayload(id, n, { status: 'cached', zh: translated }),
        cached: false,
        status: 'done',
        targetLang: lang,
        translatedParagraphs: translated.length,
        failedParagraphs: 0,
        failedIndices: [],
        model: 'deepseek-chat',
        batches: 1,
    };
}

// ── Browser + mocked API ───────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const cors = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

async function newPage(viewport, lang = 'zh-CN') {
    const context = await browser.newContext({
        viewport,
        deviceScaleFactor: 1,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
    });
    await context.addInitScript((uiLang) => {
        localStorage.setItem('yt_bilingual_ui_lang', uiLang);
        localStorage.setItem('yt_bilingual_target_lang', uiLang);
    }, lang);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));

    const state = { posts: [], failCounts: {}, defineCalls: 0 };

    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const method = request.method();
        if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
        const url = new URL(request.url());
        const pathname = url.pathname;
        const respond = (data, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            headers: cors,
            body: JSON.stringify(data),
        });
        const fail = (status, detail) => respond({ detail }, status);

        // ── app shell / content page background data ──────────────────────
        if (pathname === '/api/auth/me') return respond({ guest: true, isAdmin: false });
        if (pathname === '/api/history') return respond([]);
        if (pathname === '/api/subscriptions') return respond([]);
        if (pathname === '/api/favorites' && method === 'GET') return respond([]);
        if (pathname === '/api/shows') return respond({ shows: [] });
        if (pathname === '/api/sentences/levels') return respond([]);
        if (pathname === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
                default: 'deepseek-chat',
            });
        }
        if (pathname === '/api/channel-updates') return respond({ updates: [] });
        if (pathname === '/api/report/week') {
            return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
        }
        if (pathname === '/api/placement/profile') {
            return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
        }
        if (pathname === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-17', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (pathname === '/api/recommendations') {
            return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
        }
        if (pathname === '/api/library') {
            return respond({ videos: [], articles: [], counts: { videos: 0, articles: 0 } });
        }
        if (pathname === '/api/books') {
            return respond({
                series: [],
                counts: { series: 0, books: 0, availableBooks: 0, readableChapters: 0, translatedChapters: 0 },
            });
        }
        if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });

        // ── dictionary (reading-word regression only) ─────────────────────
        if (pathname === '/api/define') {
            state.defineCalls += 1;
            const body = request.postDataJSON() || {};
            return respond({
                word: body.word || 'quiet',
                ipa: '/ˈkwaɪət/',
                pos: 'adj.',
                zh: '安静的；平静的',
                definition_en: 'making very little noise',
                example: 'A quiet morning begins with a cup of tea.',
            });
        }

        // ── public-domain books ───────────────────────────────────────────
        const translateMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)\/translate$/);
        if (translateMatch && method === 'POST') {
            const [, bookId, n] = translateMatch;
            const spec = chapterSpec(bookId, Number(n));
            if (!spec) return fail(404, 'not found');
            const body = request.postDataJSON() || {};
            state.posts.push({ bookId, n: Number(n), targetLang: body.targetLang });
            if (spec.failFirst && !state.failCounts[bookId]) {
                state.failCounts[bookId] = 1;
                await sleep(250);
                return fail(502, '模型没有返回可用译文');
            }
            await sleep(spec.delay);
            return respond(translatedChapterPayload(bookId, Number(n), body.targetLang === 'vi-VN' ? 'vi-VN' : 'zh-CN'));
        }

        const chapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)$/);
        if (chapterMatch && method === 'GET') {
            const [, bookId, n] = chapterMatch;
            const spec = chapterSpec(bookId, Number(n));
            if (!spec) return fail(404, 'not found');
            return respond(chapterPayload(bookId, Number(n), spec));
        }

        const detailMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
        if (detailMatch && method === 'GET') {
            const [, bookId] = detailMatch;
            const specs = MULTI_SPECS[bookId]
                ?? (CHAPTER_SPECS[bookId] ? { 1: CHAPTER_SPECS[bookId] } : null);
            if (!specs) return fail(404, 'not found');
            return respond(bookDetail(bookId, specs));
        }

        // Unknown background endpoints (telemetry etc.) get an empty object so
        // the flow under test is never blocked by an unrelated request.
        if (pathname.startsWith('/api/')) return respond({});
        return fail(404, `unmocked ${method} ${pathname}`);
    });

    return { context, page, state, pageErrors };
}

const shot = async (page, name) => {
    await page.screenshot({ path: `${SHOTS}/${name}.png` });
    console.log(`shot: ${name}.png`);
};

async function gotoHash(page, hash) {
    await page.goto(`${BASE}#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(250);
}

async function noOverflow(page, label) {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
    return metrics;
}

// ── a) untranslated chapter: auto POST + progress + render, exactly once ───
{
    const { context, page, state, pageErrors } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/content/book/b1');
    await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
    const progress = page.locator('[data-testid=book-auto-translate-progress]');
    await progress.waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await progress.innerText(), /首次翻译中/, 'progress copy must explain the first translation');
    assert.match(await progress.innerText(), /30 秒/, 'progress copy must state the ~30s expectation');
    await shot(page, '06-auto-translate-progress-1440');

    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await page.locator('[data-testid=book-translation-0]').innerText(), /小习惯的安静力量/);
    assert.equal(state.posts.length, 1, `auto translate must POST exactly once, got ${state.posts.length}`);
    assert.equal(state.posts[0].bookId, 'b1');
    assert.equal(state.posts[0].targetLang, 'zh-CN', 'POST must carry the target language');
    await progress.waitFor({ state: 'hidden', timeout: 5000 });
    await sleep(900);
    assert.equal(state.posts.length, 1, 're-render/StrictMode must not fire a second auto POST');
    assert.equal(
        await page.locator('[data-testid=book-row-0]').getAttribute('data-bilingual'),
        'two-column',
        'the auto translation must render in the bilingual layout without a reload',
    );
    await noOverflow(page, 'auto-translate reader 1440');
    await shot(page, '07-auto-translate-done-1440');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

// ── b) cached chapter: no POST; existing translation toggle + lookup work ──
{
    const { context, page, state, pageErrors } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/content/book/b2');
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(900);
    assert.equal(state.posts.length, 0, 'a cached chapter must never call POST translate');
    assert.equal(await page.locator('[data-testid=book-auto-translate-progress]').count(), 0);
    assert.equal(await page.locator('[data-testid=book-translate-chapter]').count(), 0,
        'the manual button is only for missing/partial chapters');

    // Existing translation toggle still works (regression).
    await page.locator('[data-testid=book-translation-hidden]').click();
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'hidden' });
    assert.equal(
        await page.locator('[data-testid=book-row-0]').getAttribute('data-bilingual'),
        'single-column',
    );
    await page.locator('[data-testid=book-translation-all]').click();
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible' });

    // Existing word lookup still works (regression).
    const words = page.locator('[data-testid=book-en-0] [data-word-hit]');
    assert.ok((await words.count()) > 0, 'book English paragraph must stay clickable');
    await words.first().click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(state.defineCalls > 0, 'word lookup must still call /api/define');
    // The card has no Escape binding; its full-screen click-away layer closes it.
    await page.locator('[data-testid=word-popover-overlay]').click({ position: { x: 6, y: 6 } });
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'hidden', timeout: 5000 });

    await noOverflow(page, 'cached reader 1440');
    await shot(page, '08-cached-no-post-1440');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

// ── c) translation failure: reason + retry, reading never blocked ──────────
{
    const { context, page, state, pageErrors } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/content/book/b3');
    await page.locator('[data-testid=book-translate-error]').waitFor({ state: 'visible', timeout: 15000 });
    assert.match(await page.locator('[data-testid=book-translate-error]').innerText(), /翻译失败/);
    assert.equal(await page.locator('[data-testid=book-en-0]').isVisible(), true,
        'a failed translation must not block the English source');
    assert.equal(state.posts.length, 1);
    await shot(page, '09-translate-failed-1440');

    await page.locator('[data-testid=book-translate-retry]').click();
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(state.posts.length, 2, 'retry must call POST translate again');
    await page.locator('[data-testid=book-translate-error]').waitFor({ state: 'hidden', timeout: 5000 });
    assert.match(await page.locator('[data-testid=book-translation-0]').innerText(), /小习惯的安静力量/);
    await shot(page, '10-translate-retry-done-1440');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

// ── d) partial chapter auto-backfills and never locks the reader ──────────
{
    const { context, page, state } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/content/book/b4');
    await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid=book-auto-translate-progress]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(state.posts.length, 1, 'partial chapters must auto-fill missing paragraphs');
    assert.match(await page.locator('[data-testid=book-translation-0]').innerText(), /小习惯的安静力量/,
        'the already translated paragraph stays readable while the rest is pending');
    await page.locator('[data-testid=book-translation-1]').waitFor({ state: 'visible', timeout: 15000 });
    await context.close();
}

// ── d2) chapter switch: cached first, then a missing chapter auto-translates ─
{
    const { context, page, state } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/content/book/b5');
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(600);
    assert.equal(state.posts.length, 0, 'the cached first chapter must not POST');

    await page.locator('[data-testid=book-chapter-2]').click();
    await page.locator('[data-testid=book-auto-translate-progress]').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(state.posts.length, 1, 'switching to an untranslated chapter must re-evaluate and POST');
    assert.equal(state.posts[0].n, 2, 'the POST must target the newly selected chapter');
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await page.locator('[data-testid=book-chapter-2]').getAttribute('aria-current'), 'page');
    await noOverflow(page, 'chapter switch 1440');
    await shot(page, '14-chapter-switch-auto-1440');
    await context.close();
}

// ── e) content page: axis gone, continue card stays ────────────────────────
for (const [viewport, name] of [
    [{ width: 1440, height: 1000 }, '01-content-no-cefr-1440'],
    [{ width: 375, height: 812 }, '02-content-no-cefr-375'],
]) {
    const { context, page, pageErrors } = await newPage(viewport);
    await gotoHash(page, '/content');
    await page.locator('[data-testid=content-screen]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid=content-rail-continue]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid=vocab-axis]').count(), 0,
        `content page must not render the CEFR axis (${viewport.width}px)`);
    await noOverflow(page, `content ${viewport.width}`);
    await shot(page, name);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

// ── f) 我的 · 设置: inline axis, immediate localStorage save ───────────────
for (const [viewport, name] of [
    [{ width: 1440, height: 1000 }, '03-profile-cefr-1440'],
    [{ width: 375, height: 812 }, '04-profile-cefr-375'],
]) {
    const { context, page, pageErrors } = await newPage(viewport);
    await gotoHash(page, '/profile');
    const block = page.locator('[data-testid=account-vocab-level]');
    await block.waitFor({ state: 'visible', timeout: 15000 });
    await block.scrollIntoViewIfNeeded();
    await page.locator('[data-testid=vocab-axis]').waitFor({ state: 'visible' });
    assert.match(await block.innerText(), /高亮难度/, 'the settings block must carry the highlight-difficulty title');
    assert.equal(await block.locator('[data-testid=account-vocab-current]').innerText(), 'A2',
        'the default saved level is A2');
    await noOverflow(page, `profile ${viewport.width}`);
    await shot(page, name);
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

{
    const { context, page } = await newPage({ width: 1440, height: 1000 });
    await gotoHash(page, '/profile');
    const block = page.locator('[data-testid=account-vocab-level]');
    await block.waitFor({ state: 'visible', timeout: 15000 });
    await block.scrollIntoViewIfNeeded();
    await page.locator('[data-testid=vocab-axis-stop-C1]').click();
    await page.locator('[data-testid=account-vocab-current]').filter({ hasText: 'C1' })
        .waitFor({ state: 'visible', timeout: 5000 });
    const stored = await page.evaluate(() => localStorage.getItem('yt_bilingual_vocab_level'));
    assert.equal(stored, 'deep-space', `CEFR pick must persist immediately, got ${stored}`);
    await page.getByText('已保存', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid=vocab-axis-tagline]').waitFor({ state: 'visible' });
    await sleep(600); // AnimatePresence swaps the band description
    assert.match(await page.locator('[data-testid=vocab-axis-tagline]').innerText(), /只标亮高于 C1 的词/,
        'the selected band description must follow the pick');
    await noOverflow(page, 'profile picked 1440');
    await shot(page, '05-profile-cefr-picked-1440');
    await context.close();
}

// ── g) Vietnamese UI: the auto POST carries the Vietnamese target ─────────
{
    const { context, page, state, pageErrors } = await newPage({ width: 1440, height: 1000 }, 'vi-VN');
    await gotoHash(page, '/content/book/b1');
    await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
    const progress = page.locator('[data-testid=book-auto-translate-progress]');
    await progress.waitFor({ state: 'visible', timeout: 5000 });
    assert.match(await progress.innerText(), /Đang dịch lần đầu/, 'Vietnamese progress copy must be used');
    await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(state.posts.length, 1);
    assert.equal(state.posts[0].targetLang, 'vi-VN', 'POST must carry the current target language');
    assert.match(await page.locator('[data-testid=book-translation-0]').innerText(), /Sức mạnh lặng lẽ/);
    await noOverflow(page, 'vi reader 1440');
    await shot(page, '11-vi-auto-translate-1440');
    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    await context.close();
}

await browser.close();
console.log(`\nAll CEFR/auto-translate checks passed. Screenshots: ${SHOTS}`);
