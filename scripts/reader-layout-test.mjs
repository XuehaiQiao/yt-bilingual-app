// Playwright regression for the bilingual readers (issue 2/4):
//   a) self-created article: word click opens the shared dictionary card
//   b) free-library article: same card, article provenance kept
//   c) public-domain + imported book: same card
//   d) ≥lg: EN on the left, ZH on the right, same paragraph on the same row
//   e) 375px: the old stacked order (EN above ZH), no horizontal overflow
//   f) translation hidden -> English single column, full width
//   g) progress / translation / paragraph-share regression
//
// Every /api/** request is mocked, so no backend, database or LLM is touched.
//
// Run: node scripts/reader-layout-test.mjs   (needs `npm run dev` on :5173)
// Output: /tmp/reader-layout-shots/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/reader-layout-shots';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(predicate, what, timeout = 8000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        if (predicate()) return;
        await sleep(50);
    }
    throw new Error(`timed out waiting for ${what}`);
}

// ── Fixtures ───────────────────────────────────────────────────────────────
const EN = [
    'The quiet power of small habits shapes a good morning. A short walk before breakfast makes the whole day feel slower and calmer.',
    'Cities have always been shaped by the way people move through them. A street is not only a line on a map; it is a rhythm of footsteps, bicycles and buses.',
    'Public benches are a quiet kind of infrastructure. They cost little, yet they let an elderly neighbour rest and a stranger pause.',
];
const ZH = [
    '小习惯的安静力量塑造一个美好的早晨。早餐前散一小段步，会让一整天都更慢、更平静。',
    '城市一直由人们穿行其中的方式塑造。街道不只是地图上的一条线，它还是脚步、自行车与公交的节奏。',
    '公共长椅是一种安静的基础设施。它们成本很低，却能让年长的邻居歇脚、让陌生人停一停。',
];
const IMPORTED_PARAGRAPHS = Array.from({ length: 24 }, (_, i) => (
    i === 0
        ? 'The kettle sings on the stove while the house is still asleep. A quiet morning begins with small rituals.'
        : `Paragraph ${i + 1}: a slow walk through the neighbourhood shows how ordinary streets hold a city together. Trees shade the pavement, benches invite a pause, and a crossing gives a child enough time to cross safely without running.`
));

const state = {
    readerArticles: new Map(),
    nextImport: 1,
    progressPuts: [],
    favPosts: [],
    defineCalls: 0,
    translateCalls: 0,
    lastDefine: null,
};

// art1: fully translated article (layout + regression baseline).
state.readerArticles.set('art1', {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 90,
    createdAt: 1763000000000,
    paragraphs: EN.map((text, idx) => ({ idx, text })),
    translations: { 'zh-CN': Object.fromEntries(ZH.map((text, idx) => [idx, text])) },
    progress: null,
});

const LIBRARY_ARTICLE = {
    id: 'lib1',
    title: 'A Quiet Morning',
    level: 'A2',
    wordCount: 30,
    author: 'LinguaTrek',
    license: 'CC BY-NC 4.0',
    topic: 'life',
    source: 'original',
    paragraphs: [
        { en: 'The kettle sings on the stove while the house is still asleep.', zh: '水壶在炉子上鸣叫，整座房子还在沉睡。' },
        { en: 'A short walk before breakfast makes the whole day feel slower.', zh: '早餐前散一小段步，会让一整天都慢下来。' },
    ],
};

const SERIES = {
    id: 's1',
    title: 'Test Series',
    author: 'Jane Austen',
    description: 'A public-domain series used by the reader layout test.',
    totalBooks: 1,
    availableBooks: 1,
    readableChapters: 1,
    translatedChapters: 1,
    excluded: [],
    books: [],
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
    totalChapters: 1,
    readableChapters: 1,
    translatedChapters: 1,
    publicDomainBasis: 'Published in 1813.',
    chapters: [{ n: 1, title: 'Chapter 1', titleZh: '第一章', translated: true }],
    series: SERIES,
};
const BOOK_CHAPTER = {
    bookId: 'b1',
    bookTitle: BOOK.title,
    bookTitleZh: BOOK.titleZh,
    author: BOOK.author,
    level: BOOK.level,
    license: BOOK.license,
    chapter: 1,
    chapterTitle: 'Chapter 1',
    sourceTitle: 'Pride and Prejudice',
    totalChapters: 1,
    importedChapters: 1,
    seriesId: 's1',
    seriesTitle: 'Test Series',
    source: { provider: 'gutenberg', url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt', fetchedAt: '2026-11-17T00:00:00Z', degraded: false },
    paragraphs: [
        { index: 0, en: 'It is a truth universally acknowledged, that a single man in possession of a good fortune, must be in want of a wife.', zh: '凡是有钱的单身汉，总想娶位太太，这已经成了一条举世公认的真理。' },
        { index: 1, en: 'However little known the feelings or views of such a man may be on his first entering a neighbourhood, this truth is so well fixed in the minds of the surrounding families.', zh: '这样的单身汉，每逢新搬到一个地方，四邻八舍虽然完全不了解他的性情如何、见解如何，可是既然这条真理深入人心。' },
    ],
    missingTranslations: 0,
    translated: true,
    translatedChapters: 1,
};
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
    chapters: [{ n: 1, title: 'Down the Rabbit-Hole', translated: true, translatedParagraphs: 1 }],
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
    missingTranslations: 1,
    paragraphs: [
        { index: 0, en: 'Alice was beginning to get very tired of sitting by her sister on the bank, and of having nothing to do.', zh: '爱丽丝挨着姐姐坐在河岸边，无事可做，开始觉得非常无聊。' },
        { index: 1, en: 'Once or twice she had peeped into the book her sister was reading, but it had no pictures or conversations in it.', zh: null },
    ],
    quota: { feature: 'book_import_translate', limitPerDay: 10, usedToday: 0, remainingToday: 10, day: '2026-11-17' },
};

function wordCountOf(paragraphs) {
    return paragraphs.join(' ').split(/\s+/).filter(Boolean).length;
}

function summaryOf(article) {
    return {
        articleId: article.articleId,
        title: article.title,
        site: article.site,
        sourceUrl: article.sourceUrl,
        lang: article.lang,
        wordCount: article.wordCount,
        createdAt: article.createdAt,
        paragraphCount: article.paragraphs.length,
        progress: article.progress ? { ...article.progress } : null,
    };
}

function detailOf(article, lang = 'zh-CN') {
    const translations = article.translations[lang] || {};
    const paragraphs = article.paragraphs.map(({ idx, text }) => {
        const translation = translations[idx];
        return {
            idx,
            text,
            translation: translation ?? null,
            translationModel: translation ? 'deepseek-chat' : null,
            translationFailed: false,
        };
    });
    const translated = paragraphs.filter((paragraph) => paragraph.translation).length;
    return {
        articleId: article.articleId,
        title: article.title,
        site: article.site,
        sourceUrl: article.sourceUrl,
        lang: article.lang,
        wordCount: article.wordCount,
        createdAt: article.createdAt,
        targetLang: lang,
        paragraphs,
        progress: article.progress ? { ...article.progress } : null,
        stats: { total: paragraphs.length, translated, untranslated: paragraphs.length - translated },
    };
}

// ── Browser + mocked API ───────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
    localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('dialog', (dialog) => { void dialog.accept(); });

const cors = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

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

    // ── app shell ─────────────────────────────────────────────────────────
    if (pathname === '/api/auth/me') {
        return respond({ user: { id: 'u-reader', email: 'reader@example.com' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
    }
    if (pathname === '/api/favorites' && method === 'GET') return respond([]);
    if (pathname === '/api/favorites' && method === 'POST') {
        const payload = request.postDataJSON() || {};
        state.favPosts.push(payload);
        return respond({
            favorite: {
                id: payload.id,
                videoId: payload.videoId,
                start: payload.time,
                en_text: payload.text,
                zh_text: payload.translation,
                added_at: payload.addedAt,
                type: payload.type,
                ...(payload.meta || {}),
            },
        });
    }
    if (pathname.startsWith('/api/favorites/') && method === 'DELETE') return respond({ ok: true });
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    if (pathname === '/api/placement/profile') return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
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
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });

    // ── dictionary ────────────────────────────────────────────────────────
    if (pathname === '/api/define') {
        state.defineCalls += 1;
        const body = request.postDataJSON() || {};
        state.lastDefine = body;
        return respond({
            word: body.word || 'quiet',
            ipa: '/ˈkwaɪət/',
            pos: 'adj.',
            zh: '安静的；平静的',
            definition_en: 'making very little noise',
            example: 'A quiet morning begins with a cup of tea.',
        });
    }

    // ── reading API ───────────────────────────────────────────────────────
    if (pathname === '/api/articles' && method === 'GET') {
        return respond({ articles: [...state.readerArticles.values()].map(summaryOf) });
    }
    if (pathname === '/api/article/import' && method === 'POST') {
        const body = request.postDataJSON() || {};
        const paragraphs = String(body.text || '')
            .split(/\n\s*\n/)
            .map((part) => part.trim())
            .filter(Boolean);
        const id = `imported-${state.nextImport++}`;
        const article = {
            articleId: id,
            title: body.title || 'My Pasted Article',
            site: null,
            sourceUrl: null,
            lang: 'en',
            wordCount: wordCountOf(paragraphs),
            createdAt: Date.now(),
            paragraphs: paragraphs.map((text, idx) => ({ idx, text })),
            translations: { 'zh-CN': {} },
            progress: null,
        };
        state.readerArticles.set(id, article);
        return respond({
            articleId: id,
            title: article.title,
            site: null,
            sourceUrl: null,
            lang: 'en',
            wordCount: article.wordCount,
            createdAt: article.createdAt,
            paragraphs: article.paragraphs,
            reused: false,
        });
    }
    const translateMatch = pathname.match(/^\/api\/article\/([^/]+)\/translate$/);
    if (translateMatch && method === 'POST') {
        const article = state.readerArticles.get(translateMatch[1]);
        if (!article) return fail(404, 'not found');
        state.translateCalls += 1;
        const lang = request.postDataJSON()?.targetLang === 'vi-VN' ? 'vi-VN' : 'zh-CN';
        const translations = article.translations[lang] || (article.translations[lang] = {});
        const missing = article.paragraphs.filter(({ idx }) => !translations[idx]);
        await sleep(120);
        for (const { idx } of missing) translations[idx] = `第 ${idx + 1} 段译文：用于验收的示例中文译文。`;
        return respond({
            articleId: article.articleId,
            targetLang: lang,
            status: 'done',
            total: article.paragraphs.length,
            translated: article.paragraphs.length,
            failed: 0,
            failedIndices: [],
            model: 'deepseek-chat',
            batches: missing.length > 0 ? 1 : 0,
        });
    }
    const progressMatch = pathname.match(/^\/api\/article\/([^/]+)\/progress$/);
    if (progressMatch && method === 'PUT') {
        const article = state.readerArticles.get(progressMatch[1]);
        if (!article) return fail(404, 'not found');
        const body = request.postDataJSON() || {};
        state.progressPuts.push({ articleId: article.articleId, paragraphIdx: body.paragraphIdx });
        article.progress = { paragraphIdx: body.paragraphIdx, updatedAt: Date.now() };
        return respond({ articleId: article.articleId, paragraphIdx: body.paragraphIdx, updatedAt: article.progress.updatedAt });
    }
    const articleMatch = pathname.match(/^\/api\/article\/([^/]+)$/);
    if (articleMatch && method === 'GET') {
        const article = state.readerArticles.get(articleMatch[1]);
        if (!article) return fail(404, 'not found');
        return respond(detailOf(article, url.searchParams.get('targetLang') || 'zh-CN'));
    }

    // ── free library ──────────────────────────────────────────────────────
    if (pathname === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
    if (pathname.startsWith('/api/library/videos/')) return fail(404, 'not a video');

    // ── public-domain books ───────────────────────────────────────────────
    if (pathname === '/api/books/b1') return respond(BOOK);
    if (pathname === '/api/books/b1/chapters/1') return respond(BOOK_CHAPTER);
    if (pathname === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
    if (pathname === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);

    // Unknown background endpoints (telemetry etc.) get an empty object so the
    // UI flow under test is never blocked by an unrelated request.
    if (pathname.startsWith('/api/')) return respond({});
    return fail(404, `unmocked ${method} ${pathname}`);
});

// ── Helpers ────────────────────────────────────────────────────────────────
const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
    console.log(`shot: ${name}.png`);
};

async function gotoHash(hash) {
    await closePopover();
    await page.goto(`${BASE}#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(250);
}

async function closePopover() {
    const overlay = page.locator('[data-testid=word-popover-overlay]');
    if (await overlay.count()) {
        await overlay.click({ position: { x: 6, y: 6 } }).catch(() => {});
        await page.waitForTimeout(250);
    }
}

const noOverflow = async (label) => {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
    return metrics;
};

const clickWordAndExpectCard = async (testId, label) => {
    const words = page.locator(`[data-testid=${testId}] [data-word-hit]`);
    assert.ok((await words.count()) > 0, `${label}: no clickable words`);
    await words.first().click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid=word-popover]').getByText('安静的；平静的').waitFor({ state: 'visible', timeout: 8000 });
    await sleep(450); // let the card's spring/fade settle before screenshots
    assert.ok(state.defineCalls > 0, `${label}: /api/define was not called`);
};

// ── a) self-created article (paste -> auto import -> word card) ────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid=start-mode-select]').first().selectOption('read');
// 8 paragraphs: tall enough that the scroll container actually scrolls, so
// the throttled progress PUT has a new paragraph to report.
await page.locator('[data-testid=video-url-input]').first().fill(IMPORTED_PARAGRAPHS.join('\n\n'));
await page.locator('[data-testid=start-submit]').first().click();
await page.locator('[data-testid=reader-article]').waitFor({ state: 'visible', timeout: 20000 });
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
assert.match(await page.locator('[data-testid=reader-en-0]').innerText(), /kettle sings/);
assert.equal(state.progressPuts.length > 0, false, 'no progress PUT before scrolling is required');
await shot('01-self-created-1440');

await clickWordAndExpectCard('reader-en-0', 'self-created article');
await shot('02-self-created-word-card-1440');

// Star keeps the article provenance on the saved word.
await page.locator('[data-testid=word-popover] button[title="加入生词本"]').click();
await waitFor(() => state.favPosts.length > 0, 'favorite POST');
const articleFav = state.favPosts.at(-1);
assert.equal(articleFav.meta?.source_kind, 'article', 'self-created word must be tagged as an article');
assert.equal(articleFav.meta?.source_ref, 'imported-1', 'self-created word must carry the article id');
assert.equal(articleFav.meta?.source_title, 'My Pasted Article', 'self-created word must carry the article title');
await closePopover();

// Auto-translate hint + button still work; the row flips to two columns.
await page.locator('[data-testid=reader-translation-bar]').waitFor({ state: 'visible' });
await page.locator('[data-testid=reader-translate-button]').click();
await page.locator('[data-testid=reader-translation-0]').waitFor({ state: 'visible', timeout: 15000 });
assert.equal(await page.locator('[data-testid=reader-row-0]').getAttribute('data-bilingual'), 'two-column');
assert.equal(state.translateCalls, 1);
await shot('03-self-created-two-column-1440');

// Scroll -> throttled progress save (existing behavior).
await page.evaluate(() => {
    const container = document.querySelector('[data-testid=reader-scroll]');
    if (container) container.scrollTop = container.scrollHeight;
});
await sleep(1700);
assert.ok(state.progressPuts.some((put) => put.articleId === 'imported-1'), `expected a progress PUT, got ${JSON.stringify(state.progressPuts)}`);

// ── b) free-library article: words + same card + provenance ───────────────
await gotoHash('/learn/library/lib1');
await page.locator('[data-testid=library-reader]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid=library-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await noOverflow('library 1440');
await shot('04-library-1440-two-column');
const libraryRow = await page.locator('[data-testid=library-row-0]').getAttribute('data-bilingual');
assert.equal(libraryRow, 'two-column');

await clickWordAndExpectCard('library-en-0', 'free library article');
await shot('05-library-word-card-1440');
await page.locator('[data-testid=word-popover] button[title="加入生词本"]').click();
await waitFor(() => state.favPosts.length > 1, 'library favorite POST');
const libraryFav = state.favPosts.at(-1);
assert.equal(libraryFav.meta?.source_kind, 'library_article', 'library word must be tagged as a free-library article');
assert.equal(libraryFav.meta?.source_ref, 'lib1', 'library word must carry the article id');
assert.equal(libraryFav.meta?.source_title, 'A Quiet Morning', 'library word must carry the article title');
await closePopover();

// Translation toggle still works: hidden -> single column, all -> two columns.
await page.locator('[data-testid=library-translation-hidden]').click();
await page.locator('[data-testid=library-article-translation-0]').waitFor({ state: 'hidden' });
assert.equal(await page.locator('[data-testid=library-row-0]').getAttribute('data-bilingual'), 'single-column');
await page.locator('[data-testid=library-translation-all]').click();
await page.locator('[data-testid=library-article-translation-0]').waitFor({ state: 'visible' });

// ── c) public-domain book + imported book ─────────────────────────────────
await gotoHash('/content/book/b1');
await page.locator('[data-testid=book-reader]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
assert.equal(await page.locator('[data-testid=book-row-0]').getAttribute('data-bilingual'), 'two-column');
await noOverflow('book 1440');
await shot('06-book-1440-two-column');
await clickWordAndExpectCard('book-en-0', 'public-domain book');
await shot('07-book-word-card-1440');
await closePopover();

await gotoHash('/content/imported-book/ib1');
await page.locator('[data-testid=imported-book-reader]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid=imported-book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
assert.equal(await page.locator('[data-testid=imported-book-row-0]').getAttribute('data-bilingual'), 'two-column');
await noOverflow('imported book 1440');
await shot('08-imported-book-1440-two-column');
await clickWordAndExpectCard('imported-book-en-0', 'imported book');
await shot('09-imported-book-word-card-1440');
await closePopover();

// ── d) 1440: English left / Chinese right, same row per paragraph ─────────
await gotoHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
const rows = [0, 1, 2];
const geometry = await page.evaluate((indexes) => indexes.map((idx) => {
    const en = document.querySelector(`[data-testid=reader-en-${idx}]`).getBoundingClientRect();
    const zh = document.querySelector(`[data-testid=reader-translation-${idx}]`).getBoundingClientRect();
    const row = document.querySelector(`[data-testid=reader-row-${idx}]`).getBoundingClientRect();
    return { idx, enTop: en.top, zhTop: zh.top, enLeft: en.left, zhLeft: zh.left, rowWidth: row.width, enWidth: en.width, zhWidth: zh.width };
}), rows);
for (const row of geometry) {
    assert.ok(Math.abs(row.enTop - row.zhTop) <= 2, `paragraph ${row.idx}: EN/ZH tops differ (${row.enTop} vs ${row.zhTop})`);
    assert.ok(row.enLeft < row.zhLeft, `paragraph ${row.idx}: EN must be left of ZH`);
    assert.ok(row.zhLeft - (row.enLeft + row.enWidth) >= 16, `paragraph ${row.idx}: columns overlap`);
}
const wide = await noOverflow('reader 1440 two-column');
console.log('two-column geometry:', JSON.stringify({ rows: geometry, docWidth: wide.doc }));
await shot('10-reader-1440-two-column');

// The `lg` breakpoint itself (1024px) must already be two columns.
await page.setViewportSize({ width: 1024, height: 900 });
await sleep(350);
assert.equal(await page.locator('[data-testid=reader-row-0]').getAttribute('data-bilingual'), 'two-column');
await noOverflow('reader 1024');
const lgLayout = await page.evaluate(() => {
    const en = document.querySelector('[data-testid=reader-en-0]').getBoundingClientRect();
    const zh = document.querySelector('[data-testid=reader-translation-0]').getBoundingClientRect();
    return { enLeft: en.left, zhLeft: zh.left, enTop: en.top, zhTop: zh.top };
});
assert.ok(lgLayout.enLeft < lgLayout.zhLeft, 'lg breakpoint: EN must be left of ZH');
assert.ok(Math.abs(lgLayout.enTop - lgLayout.zhTop) <= 2, 'lg breakpoint: same paragraph must share a row');
await shot('10b-reader-1024-two-column');
await page.setViewportSize({ width: 1440, height: 1000 });
await sleep(350);

// Translation column must never open the dictionary card.
await page.locator('[data-testid=reader-translation-0]').click();
await sleep(500);
assert.equal(await page.locator('[data-testid=word-popover]').count(), 0, 'translation column must not open the word card');

// Word click still works in the English column.
await clickWordAndExpectCard('reader-en-0', 'reader article');
await shot('11-reader-word-card-1440');

// Single click on a second word while the card is open retargets the card
// (no hover on touch); the card must stay open instead of only closing.
const firstCardWord = await page.locator('[data-testid=word-popover-word]').innerText();
const secondWord = page.locator('[data-testid=reader-en-2] [data-word-hit]').first();
const secondBox = await secondWord.boundingBox();
assert.ok(secondBox, 'second word has no bounding box');
await page.mouse.click(secondBox.x + secondBox.width / 2, secondBox.y + secondBox.height / 2);
await sleep(700);
assert.ok(await page.locator('[data-testid=word-popover]').isVisible(), 'clicking another word must keep the card open');
const switchedCardWord = await page.locator('[data-testid=word-popover-word]').innerText();
assert.notEqual(switchedCardWord, firstCardWord, 'the card must switch to the clicked word');
assert.match(switchedCardWord, /Public/i, `expected the second paragraph's first word, got ${switchedCardWord}`);
await shot('11b-reader-word-switch-1440');
await closePopover();

// Paragraph menu + share card regression.
await page.locator('[data-testid=reader-paragraph-0]').hover();
await page.locator('[data-testid=reader-paragraph-menu-button-0]').click();
await page.locator('[data-testid=reader-share-paragraph-0]').click();
await page.locator('[data-testid=share-card-dialog]').waitFor({ state: 'visible', timeout: 8000 });
await shot('12-reader-share-dialog-1440');
await page.locator('[data-testid=share-card-close]').click();

// ── f) translation hidden -> English single column ───────────────────────
await page.locator('[data-testid=reader-translation-hidden]').click();
await page.locator('[data-testid=reader-translation-0]').waitFor({ state: 'hidden' });
assert.equal(await page.locator('[data-testid=reader-row-0]').getAttribute('data-bilingual'), 'single-column');
const single = await page.evaluate(() => {
    const en = document.querySelector('[data-testid=reader-en-0]').getBoundingClientRect();
    const container = document.querySelector('[data-testid=reader-scroll]').getBoundingClientRect();
    return { enWidth: en.width, containerWidth: container.width };
});
assert.ok(single.enWidth > 600, `single column should use the full reading width, got ${single.enWidth}`);
await noOverflow('reader 1440 single column');
await shot('13-reader-1440-single-column');
await page.locator('[data-testid=reader-translation-all]').click();
await page.locator('[data-testid=reader-translation-0]').waitFor({ state: 'visible' });

// ── e) 375: stacked EN over ZH, still clickable ──────────────────────────
await page.setViewportSize({ width: 375, height: 812 });
await gotoHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
const mobile = await page.evaluate(() => {
    const en = document.querySelector('[data-testid=reader-en-0]').getBoundingClientRect();
    const zh = document.querySelector('[data-testid=reader-translation-0]').getBoundingClientRect();
    return { enBottom: en.bottom, enLeft: en.left, zhTop: zh.top, zhLeft: zh.left, enWidth: en.width, zhWidth: zh.width };
});
assert.ok(mobile.zhTop >= mobile.enBottom - 2, `mobile 375: translation must sit under the English paragraph (${JSON.stringify(mobile)})`);
assert.ok(Math.abs(mobile.zhLeft - mobile.enLeft) <= 2, 'mobile 375: both paragraphs share the same left edge');
await noOverflow('reader 375');
await shot('14-reader-375-stacked');
await clickWordAndExpectCard('reader-en-0', 'reader 375');
await shot('15-reader-word-card-375');
await closePopover();

await gotoHash('/learn/library/lib1');
await page.locator('[data-testid=library-en-0]').waitFor({ state: 'visible', timeout: 15000 });
const libraryMobile = await page.evaluate(() => {
    const en = document.querySelector('[data-testid=library-en-0]').getBoundingClientRect();
    const zh = document.querySelector('[data-testid=library-article-translation-0]').getBoundingClientRect();
    return { enBottom: en.bottom, zhTop: zh.top };
});
assert.ok(libraryMobile.zhTop >= libraryMobile.enBottom - 2, 'library 375: translation must stack under English');
await noOverflow('library 375');
await shot('16-library-375-stacked');

await gotoHash('/content/book/b1');
await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
const bookMobile = await page.evaluate(() => {
    const en = document.querySelector('[data-testid=book-en-0]').getBoundingClientRect();
    const zh = document.querySelector('[data-testid=book-translation-0]').getBoundingClientRect();
    return { enBottom: en.bottom, zhTop: zh.top };
});
assert.ok(bookMobile.zhTop >= bookMobile.enBottom - 2, 'book 375: translation must stack under English');
await noOverflow('book 375');
await shot('17-book-375-stacked');

// ── g) book translation toggle + chapter chrome regression ───────────────
await page.setViewportSize({ width: 1440, height: 1000 });
await gotoHash('/content/book/b1');
await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await page.locator('[data-testid=book-translation-hidden]').click();
await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'hidden' });
assert.equal(await page.locator('[data-testid=book-row-0]').getAttribute('data-bilingual'), 'single-column');
await noOverflow('book 1440 single column');
await page.locator('[data-testid=book-translation-all]').click();
await page.locator('[data-testid=book-translation-0]').waitFor({ state: 'visible' });
await page.locator('[data-testid=book-chapter-1]').waitFor({ state: 'visible' });
await page.locator('[data-testid=book-reader-series-link]').waitFor({ state: 'visible' });
// Book progress still lands in localStorage (existing behavior).
const bookProgress = await page.evaluate(() => {
  const key = Object.keys(localStorage).find((item) => item.endsWith('.books_progress'));
  return key ? localStorage.getItem(key) : null;
});
assert.ok(bookProgress && bookProgress.includes('b1'), `book progress missing: ${bookProgress}`);

assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('\n')}`);
console.log(`\nRESULT: reader layout + word lookup acceptance passed (${state.readerArticles.size} articles, ${state.favPosts.length} favorites, ${state.defineCalls} dictionary calls, ${state.translateCalls} translation calls).`);
console.log(`SHOTS: ${SHOTS}`);
await browser.close();
