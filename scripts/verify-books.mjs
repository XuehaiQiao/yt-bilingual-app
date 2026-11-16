// Playwright verification for the public-domain book library (frontend).
//
// Usage:
//   APP_URL=http://127.0.0.1:5199 node verify-books.mjs
//
// Everything is mocked at the network layer, so this runs without the backend
// and without network access:
//   - 3 series (Oz / Peter Rabbit / Alice) and 39 books;
//   - chapter switch, translation toggle, word lookup;
//   - guest access (no login), 375px layout, zh-CN + vi-VN UI.
//
// Screenshots are written to /tmp/books-shots/.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5199').replace(/\/+$/, '');
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/books-shots';
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const BOOK = {
    id: 'oz-the-wonderful-wizard-of-oz',
    seriesId: 'oz',
    title: 'The Wonderful Wizard of Oz',
    titleZh: '绿野仙踪',
    author: 'L. Frank Baum',
    year: 1900,
    level: 'B1',
    status: 'available',
    source: 'Project Gutenberg',
    license: 'Public domain in the US',
    sourceUrl: 'https://www.gutenberg.org/cache/epub/55/pg55.txt',
    catalogUrl: 'https://www.gutenberg.org/ebooks/55',
    totalChapters: 24,
    readableChapters: 6,
};

const PETER = {
    ...BOOK,
    id: 'pr-the-tale-of-peter-rabbit',
    seriesId: 'peter-rabbit',
    title: 'The Tale of Peter Rabbit',
    titleZh: '彼得兔的故事',
    author: 'Beatrix Potter',
    year: 1902,
    level: 'A2',
    totalChapters: 1,
    readableChapters: 1,
};

const BOOKS = [
    BOOK,
    ...Array.from({ length: 13 }, (_, index) => ({
        ...BOOK,
        id: `oz-coming-${index + 2}`,
        title: `Oz Book ${index + 2}`,
        titleZh: `奥兹国故事 ${index + 2}`,
        year: 1900 + index + 2,
        status: 'coming_soon',
        totalChapters: 0,
        readableChapters: 0,
    })),
    PETER,
    ...Array.from({ length: 20 }, (_, index) => ({
        ...PETER,
        id: `pr-coming-${index + 1}`,
        title: `Peter Rabbit Tale ${index + 1}`,
        titleZh: `彼得兔故事 ${index + 1}`,
        year: 1902 + index,
        status: 'coming_soon',
        totalChapters: 0,
        readableChapters: 0,
    })),
    {
        ...BOOK,
        id: 'alice-alices-adventures-in-wonderland',
        seriesId: 'alice',
        title: "Alice's Adventures in Wonderland",
        titleZh: '爱丽丝梦游仙境',
        author: 'Lewis Carroll',
        year: 1865,
        totalChapters: 12,
        readableChapters: 6,
    },
    {
        ...BOOK,
        id: 'alice-through-the-looking-glass',
        seriesId: 'alice',
        title: 'Through the Looking-Glass',
        titleZh: '爱丽丝镜中奇遇记',
        author: 'Lewis Carroll',
        year: 1871,
        level: 'B2',
        status: 'coming_soon',
        totalChapters: 0,
        readableChapters: 0,
    },
];

const SERIES = [
    {
        id: 'oz',
        title: 'Oz 系列',
        author: 'L. Frank Baum',
        description: '14 本奥兹国故事，同一批角色反复出现。',
        totalBooks: 14,
        availableBooks: 1,
        readableChapters: 6,
        books: BOOKS.filter((book) => book.seriesId === 'oz'),
    },
    {
        id: 'peter-rabbit',
        title: 'Peter Rabbit 系列',
        author: 'Beatrix Potter',
        description: '23 个英国乡村小故事。',
        totalBooks: 23,
        availableBooks: 3,
        readableChapters: 3,
        books: BOOKS.filter((book) => book.seriesId === 'peter-rabbit'),
    },
    {
        id: 'alice',
        title: 'Alice 系列',
        author: 'Lewis Carroll',
        description: '两本爱丽丝故事。',
        totalBooks: 2,
        availableBooks: 1,
        readableChapters: 6,
        books: BOOKS.filter((book) => book.seriesId === 'alice'),
    },
];

const INDEX = {
    series: SERIES,
    counts: { series: 3, books: 39, availableBooks: 5, readableChapters: 15 },
};

const CHAPTERS = {
    1: {
        chapter: 1,
        chapterTitle: '旋风来了',
        sourceTitle: 'The Cyclone',
        paragraphs: [
            { index: 0, en: 'Dorothy lived in Kansas with Uncle Henry.', zh: '多萝西和亨利叔叔住在堪萨斯。' },
            { index: 1, en: 'The house had four walls and a roof.', zh: '房子有四堵墙和一个屋顶。' },
        ],
    },
    2: {
        chapter: 2,
        chapterTitle: '与芒奇金人的会面',
        sourceTitle: 'The Council with the Munchkins',
        paragraphs: [
            { index: 0, en: 'A group of little people came near.', zh: '一群小人儿走了过来。' },
            { index: 1, en: 'They thanked Dorothy for the house.', zh: '他们感谢多萝西带来了房子。' },
        ],
    },
};

function chapterPayload(n) {
    const chapter = CHAPTERS[n];
    return {
        ...BOOK,
        ...chapter,
        bookTitle: BOOK.title,
        bookTitleZh: BOOK.titleZh,
        author: BOOK.author,
        level: BOOK.level,
        license: BOOK.license,
        totalChapters: BOOK.totalChapters,
        importedChapters: BOOK.readableChapters,
        seriesId: 'oz',
        seriesTitle: 'Oz 系列',
        translationMeta: { promptVersion: 'books-zh.v1', model: 'mock' },
        source: {
            provider: 'Project Gutenberg',
            url: 'https://www.gutenberg.org/ebooks/55',
            fetchedAt: '2026-11-17T00:00:00Z',
            degraded: false,
        },
        paragraphs: chapter.paragraphs,
        missingTranslations: 0,
    };
}

async function installMocks(page, options = {}) {
    // One handler keeps route precedence deterministic: Playwright's glob
    // routes are easy to get wrong when a detail route also matches chapters.
    await page.route('**/api/**', async (route) => {
        const url = new URL(route.request().url());
        const pathname = url.pathname;
        const fulfill = (payload, status = 200) => route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(payload),
        });

        if (pathname === '/api/auth/me') {
            await fulfill({ user: null, guest: true });
            return;
        }
        if (pathname === '/api/models') {
            await fulfill({ models: [] });
            return;
        }
        if (pathname === '/api/library') {
            await fulfill({ videos: [], articles: [] });
            return;
        }
        if (pathname === '/api/sentences/levels') {
            await fulfill([]);
            return;
        }
        if (pathname === '/api/favorites') {
            await fulfill([]);
            return;
        }
        if (pathname === '/api/subscriptions') {
            await fulfill([]);
            return;
        }
        if (pathname === '/api/placement/profile') {
            await fulfill({ profile: null });
            return;
        }
        if (pathname === '/api/recommendations') {
            await fulfill({
                items: [],
                basis: { band: 'A2–B1', source: 'default' },
                preliminary: false,
            });
            return;
        }
        if (pathname === '/api/shows') {
            await fulfill({ shows: [] });
            return;
        }
        if (pathname === '/api/define') {
            const body = route.request().postDataJSON();
            await fulfill({
                word: body?.word || 'Dorothy',
                lemma: 'dorothy',
                ipa: '/ˈdɒrəθi/',
                zh: '多萝西（测试释义）',
                definition_en: 'a mocked definition',
                senses: [{ pos: 'n.', zh: '多萝西（测试释义）', definition_en: 'a mocked definition' }],
            });
            return;
        }
        if (pathname === '/api/books') {
            await fulfill(INDEX);
            return;
        }
        const chapterMatch = pathname.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)$/);
        if (chapterMatch) {
            if (options.failChapters) {
                await fulfill({ detail: '公版源暂时不可用' }, 503);
                return;
            }
            await fulfill(chapterPayload(Number(chapterMatch[2])));
            return;
        }
        const bookMatch = pathname.match(/^\/api\/books\/([^/]+)$/);
        if (bookMatch) {
            const id = decodeURIComponent(bookMatch[1]);
            const book = BOOKS.find((item) => item.id === id);
            if (!book) {
                await fulfill({ detail: 'missing' }, 404);
                return;
            }
            await fulfill({
                ...book,
                series: SERIES.find((item) => item.id === book.seriesId),
                chapters: book.status === 'available'
                    ? Object.keys(CHAPTERS).map((key) => ({ n: Number(key), title: CHAPTERS[key].chapterTitle }))
                    : [],
            });
            return;
        }
        await fulfill({});
    });
}

async function enterContent(page) {
    await page.goto(`${BASE}/#/content`, { waitUntil: 'networkidle' });
    // Fresh visitor: the welcome/auth gates may appear before the shell.
    const welcome = page.getByTestId('welcome-enter');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForTimeout(400);
    }
    const guest = page.getByTestId('auth-guest-continue');
    if (await guest.count()) {
        await guest.click();
        await page.waitForTimeout(400);
    }
    await page.getByTestId('books-section').waitFor({ state: 'visible', timeout: 20000 });
}

const browser = await chromium.launch({ channel: CHANNEL, headless: true }).catch(() =>
    chromium.launch({ headless: true }),
);
try {
    // ── Desktop zh-CN: series list → reader → chapter switch → toggle → word ──
    const desktop = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const page = await desktop.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    await installMocks(page);
    await enterContent(page);

    const sectionText = await page.getByTestId('books-section').innerText();
    assert.ok(sectionText.includes('公版书'), 'books section title is rendered');
    assert.ok(sectionText.includes('3 个系列'), 'three series are grouped');
    for (const series of SERIES) {
        assert.equal(
            await page.getByTestId(`book-series-${series.id}`).count(),
            1,
            `series ${series.id} is rendered`,
        );
        const text = await page.getByTestId(`book-series-${series.id}`).innerText();
        assert.ok(text.includes(series.title), `series ${series.id} has its title`);
        assert.ok(text.includes(String(series.totalBooks)), `series ${series.id} shows total books`);
    }
    await page.getByTestId('books-section').scrollIntoViewIfNeeded();
    await page.getByTestId('books-section').screenshot({ path: path.join(SHOT_DIR, 'books-section.png') });

    // Series page: same-series books + coming soon.
    await page.getByTestId('book-series-link-oz').click();
    await page.getByTestId('book-series-screen').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('book-series-coming-soon').waitFor({ state: 'visible', timeout: 10000 });
    const seriesText = await page.getByTestId('book-series-screen').innerText();
    assert.ok(seriesText.includes('即将上线'), 'series page lists coming-soon books');
    assert.ok(seriesText.includes('词汇复现'), 'series page explains vocabulary repetition');
    assert.equal(await page.getByTestId('book-series-soon-oz-coming-2').count(), 1);
    await page.getByTestId('book-series-screen').screenshot({ path: path.join(SHOT_DIR, 'series-desktop.png') });
    await page.getByTestId('book-series-back').click();

    // Reader: open, switch chapters, toggle translation.
    await page.getByTestId('book-card-oz-the-wonderful-wizard-of-oz').click();
    await page.getByTestId('book-detail-title').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByTestId('book-paragraph-0').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByTestId('book-detail-title').innerText(), '绿野仙踪');
    assert.equal(await page.locator('[data-testid^="book-chapter-"]').count(), 2);
    assert.equal(await page.getByTestId('book-translation-0').innerText(), '多萝西和亨利叔叔住在堪萨斯。');
    await page.screenshot({ path: path.join(SHOT_DIR, 'reader-desktop.png') });

    await page.getByTestId('book-chapter-2').click();
    await page.getByText('一群小人儿走了过来。').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByText('A group of little people came near.').count(), 1);

    await page.getByTestId('book-translation-hidden').click();
    assert.equal(await page.getByTestId('book-translation-0').count(), 0, 'translations hide');
    await page.getByTestId('book-translation-all').click();
    assert.equal(await page.getByTestId('book-translation-0').count(), 1, 'translations show again');

    // Progress is local-only: the chapter survives a reload.
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByTestId('book-paragraph-0').waitFor({ state: 'visible', timeout: 15000 });
    await page.getByText('一群小人儿走了过来。').waitFor({ state: 'visible', timeout: 10000 });
    assert.ok(page.url().includes('#/content/book/oz-the-wonderful-wizard-of-oz'));

    // Word lookup reuses the app-wide dictionary card.
    await page.locator('[data-testid="book-paragraph-0"] [data-word-hit]').first().click();
    await page.getByText('多萝西（测试释义）').waitFor({ state: 'visible', timeout: 10000 });
    await page.screenshot({ path: path.join(SHOT_DIR, 'reader-wordlookup.png') });
    assert.deepEqual(pageErrors, [], 'no uncaught page errors');

    // ── 375px: no horizontal document overflow; series + reader usable ──
    const mobile = await browser.newContext({
        viewport: { width: 375, height: 812 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const mobilePage = await mobile.newPage();
    await installMocks(mobilePage);
    await enterContent(mobilePage);
    await mobilePage.getByTestId('books-section').scrollIntoViewIfNeeded();
    await mobilePage.getByTestId('books-section').screenshot({ path: path.join(SHOT_DIR, 'books-section-375.png') });
    const overflow = await mobilePage.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
    }));
    assert.ok(overflow.scrollWidth <= overflow.clientWidth + 1, `375px overflow: ${JSON.stringify(overflow)}`);
    await mobilePage.getByTestId('book-card-oz-the-wonderful-wizard-of-oz').click();
    await mobilePage.getByTestId('book-paragraph-0').waitFor({ state: 'visible', timeout: 10000 });
    await mobilePage.screenshot({ path: path.join(SHOT_DIR, 'reader-375.png') });

    // ── Source failure: explicit retry state, never a blank reading pane ──
    const failing = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const failingPage = await failing.newPage();
    await installMocks(failingPage, { failChapters: true });
    await failingPage.goto(`${BASE}/#/content/book/oz-the-wonderful-wizard-of-oz`, { waitUntil: 'networkidle' });
    await failingPage.getByTestId('book-chapter-error').waitFor({ state: 'visible', timeout: 15000 });
    const failureText = await failingPage.getByTestId('book-chapter-error').innerText();
    assert.ok(failureText.includes('公版源暂时不可用'), 'source failure copy is rendered');
    assert.ok(failureText.includes('重试'), 'source failure offers retry');
    await failingPage.screenshot({ path: path.join(SHOT_DIR, 'reader-source-error.png') });

    // ── vi-VN: UI strings switch language; guest can still read ──
    const vietnamese = await browser.newContext({
        viewport: { width: 390, height: 844 },
        colorScheme: 'dark',
        locale: 'vi-VN',
    });
    await vietnamese.addInitScript(() => localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN'));
    const viPage = await vietnamese.newPage();
    await installMocks(viPage);
    await enterContent(viPage);
    const viText = await viPage.getByTestId('books-section').innerText();
    assert.ok(viText.includes('Sách công cộng'), 'vi UI renders the books title');
    assert.ok(viText.includes('bộ'), 'vi UI renders series counts');
    await viPage.getByTestId('books-section').scrollIntoViewIfNeeded();
    await viPage.getByTestId('books-section').screenshot({ path: path.join(SHOT_DIR, 'books-section-vi.png') });
    await viPage.getByTestId('book-card-oz-the-wonderful-wizard-of-oz').click();
    await viPage.getByTestId('book-paragraph-0').waitFor({ state: 'visible', timeout: 10000 });
    const viReader = (await viPage.getByTestId('book-reader').textContent()) || '';
    assert.ok(viReader.includes('Về trang nội dung'), 'vi reader toolbar is localized');
    assert.equal(
        await viPage.getByTestId('book-translation-toggle').getAttribute('aria-label'),
        'Hiển thị bản dịch',
        'vi translation toggle is localized',
    );
    await viPage.screenshot({ path: path.join(SHOT_DIR, 'reader-vi.png') });

    console.log(`books verification passed; screenshots: ${SHOT_DIR}`);
} finally {
    await browser.close();
}
