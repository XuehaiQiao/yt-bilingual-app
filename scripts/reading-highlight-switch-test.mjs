// Focused acceptance for the 2026-11-19 `ReadingHighlightToggle` migration to
// the shared `ui/Switch`:
//   ① every reader (free library article / public-domain book / imported book)
//      has exactly one role=switch whose aria-checked mirrors data-enabled=1|0;
//   ② it keeps the old testid, title hint and amber selected pill;
//   ③ clicking the old testid element (now the label around the switch) toggles
//      exactly once, and Space / Enter work while the switch itself has focus;
//   ④ the choice persists through a reload (localStorage contract unchanged);
//   ⑤ 1440 and 375 screenshots, no horizontal overflow.
//
// Every /api/** request is mocked, so no backend, database or LLM is touched.
//
// Run: node scripts/reading-highlight-switch-test.mjs   (needs `npm run dev` on :5173)
// Output: /tmp/switch-shots/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/switch-shots';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HIGHLIGHT_KEY = 'yt_bilingual_reading_highlight';

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fixtures (same shape as scripts/highlight-difficulty-test.mjs) ────────
const LIBRARY_EN = [
    'The kettle sings while a luminous morning begins.',
    'A short walk through the neighbourhood makes the day feel slower.',
];
const LIBRARY_ZH = ['水壶在鸣叫，明亮的早晨开始了。', '在附近散一段步，会让这一天慢下来。'];
const BOOK_EN = [
    'It is a truth universally acknowledged that a luminous fortune must be in want of a wife.',
    'However little known the cosmos of such a man may be, the surrounding families remain calm.',
];
const BOOK_ZH = [
    '这是一条举世公认的真理：一个明亮的财富必定想要一位妻子。',
    '无论这样一个人内心的宇宙多么不为人知，周围的家庭依然平静。',
];
const IMPORTED_EN = [
    'Alice was beginning to get very tired of sitting by her sister near a luminous bank.',
    'Once or twice she had peeped into the cosmos her sister was reading.',
];
const IMPORTED_ZH = [
    '爱丽丝挨着姐姐坐在明亮的河岸边，开始觉得非常无聊。',
    '她有一两次偷看姐姐正在读的那个宇宙。',
];

const SERIES = {
    id: 's1',
    title: 'Test Series',
    author: 'Jane Austen',
    description: 'A public-domain series used by the switch acceptance test.',
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
const bookChapter = () => ({
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
    paragraphs: BOOK_EN.map((en, index) => ({ index, en, zh: BOOK_ZH[index] })),
    missingTranslations: 0,
    translated: true,
    translatedChapters: 1,
});
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
    paragraphs: IMPORTED_EN.map((en, index) => ({ index, en, zh: IMPORTED_ZH[index] })),
    quota: { feature: 'book_import_translate', limitPerDay: 10, usedToday: 0, remainingToday: 10, day: '2026-11-17' },
};
const LIBRARY_ARTICLE = {
    id: 'lib1',
    title: 'A Quiet Morning',
    level: 'A2',
    wordCount: 30,
    author: 'LinguaTrek',
    license: 'CC BY-NC 4.0',
    topic: 'life',
    source: 'original',
    paragraphs: LIBRARY_EN.map((en, index) => ({ en, zh: LIBRARY_ZH[index] })),
};

const CORS = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
    if (!localStorage.getItem('yt_bilingual_ui_lang')) localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    if (!localStorage.getItem('yt_bilingual_target_lang')) localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('dialog', (dialog) => { void dialog.accept(); });

await context.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const url = new URL(request.url());
    const pathname = url.pathname;
    const respond = (data, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data),
    });

    if (pathname === '/api/auth/me') {
        return respond({ user: { id: 'u-switch', email: 'switch@example.com', username: 'Reader' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-switch', email: 'switch@example.com', username: 'Reader', credits: 12, memberSince: 1763000000000 },
            monthSpendUsd: 0.12, usageToday: { minutes: 8 }, version: 'test', preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
    }
    if (pathname === '/api/favorites') return respond([]);
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }], default: 'deepseek-chat' });
    }
    if (pathname === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    if (pathname === '/api/placement/profile') {
        return respond({ profile: { cefr: 'A2–B1', levelBandLow: 'A2', levelBandHigh: 'B1', vocabEstimate: 2500, readingEstimate: null, confidence: 0.7, confidenceLabel: 'medium', confidenceLabelZh: '中', pseudoWordSuspicion: 0, updatedAt: 1763000000000, source: 'placement', strengths: [], weaknesses: [], advice: null, measuredDomains: ['vocab'], notMeasured: ['listening', 'speaking', 'writing'], preliminary: false, sampleSize: 32, disclaimer: '' }, preliminary: false, sampleSize: 32, disclaimer: '' });
    }
    if (pathname === '/api/ability/profile') {
        return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });
    }
    if (pathname === '/api/review/stats') {
        return respond({ targetLang: 'zh-CN', now: Date.now(), today: '2026-11-17', dueToday: 0, dueNow: 0, reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0, suspendedWords: 0, streakDays: 0 });
    }
    if (pathname === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });

    // Words rendered by the readers: everything is A1 so no highlight work can
    // interfere with the switch assertions.
    if (pathname === '/api/vocabulary/level') {
        const words = (url.searchParams.get('words') || '').split(',').map((word) => word.trim()).filter(Boolean);
        return respond(Object.fromEntries(words.map((word) => [word, 'A1'])));
    }

    if (pathname === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
    if (pathname === '/api/books/b1') return respond(BOOK);
    if (pathname === '/api/books/b1/chapters/1') return respond(bookChapter());
    if (pathname === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
    if (pathname === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);

    if (pathname.startsWith('/api/')) return respond({});
    return respond({ detail: `unmocked ${method} ${pathname}` }, 404);
});

const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
    console.log(`shot: ${name}.png`);
};

async function gotoHash(hash) {
    await page.goto(`${BASE}#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(350);
}

const noOverflow = async (label) => {
    const metrics = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, inner: window.innerWidth }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
};

const READERS = [
    { name: 'library', hash: '/learn/library/lib1', ready: '[data-testid=library-en-0]', toggle: 'library-highlight-toggle' },
    { name: 'book', hash: '/content/book/b1', ready: '[data-testid=book-en-0]', toggle: 'book-highlight-toggle' },
    { name: 'imported-book', hash: '/content/imported-book/ib1', ready: '[data-testid=imported-book-en-0]', toggle: 'imported-book-highlight-toggle' },
];

for (const reader of READERS) {
    await gotoHash(reader.hash);
    await page.locator(reader.ready).waitFor({ state: 'visible', timeout: 15000 });
    await sleep(500);

    const pill = page.locator(`[data-testid=${reader.toggle}]`);
    assert.equal(await pill.count(), 1, `${reader.name}: exactly one toggle testid`);
    const switches = pill.locator('[role=switch]');
    assert.equal(await switches.count(), 1, `${reader.name}: the toggle owns exactly one role=switch`);
    assert.equal(await page.locator('[role=switch]').count(), 1, `${reader.name}: the screen has exactly one switch`);
    assert.equal(await switches.getAttribute('aria-checked'), 'true', `${reader.name}: starts on`);
    assert.equal(await pill.getAttribute('data-enabled'), '1', `${reader.name}: data-enabled mirrors on`);
    assert.ok((await switches.getAttribute('aria-label'))?.length, `${reader.name}: switch has an aria-label`);
    assert.match(await pill.getAttribute('title'), /B1/, `${reader.name}: hint keeps the level label`);
    assert.equal(await pill.evaluate((el) => getComputedStyle(el).backgroundColor), 'rgba(251, 191, 36, 0.1)', `${reader.name}: amber selected pill`);

    // ① Clicking the old testid element toggles exactly once (state flips).
    await pill.click();
    assert.equal(await pill.getAttribute('data-enabled'), '0', `${reader.name}: one label click flips the switch off`);
    assert.equal(await switches.getAttribute('aria-checked'), 'false', `${reader.name}: aria-checked follows`);
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), HIGHLIGHT_KEY), '0', `${reader.name}: off is persisted`);
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).count(), 1, `${reader.name}: no duplicate testid after render`);

    // ② Persisted through a reload.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator(reader.ready).waitFor({ state: 'visible', timeout: 15000 });
    await sleep(500);
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '0', `${reader.name}: off survives reload`);

    // ③ Keyboard: the shared switch is a native button (Space / Enter).
    const switchButton = page.locator(`[data-testid=${reader.toggle}] [role=switch]`);
    await switchButton.focus();
    await page.keyboard.press('Space');
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '1', `${reader.name}: Space turns it on`);
    await page.keyboard.press('Enter');
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '0', `${reader.name}: Enter turns it off`);

    // Leave it on for the screenshot (matches the default-on product state).
    await page.locator(`[data-testid=${reader.toggle}]`).click();
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '1');

    // ④ Clicking the switch itself must flip exactly once (no label
    // double-activation: data-enabled has to match aria-checked each time).
    await switchButton.click();
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '0', `${reader.name}: one switch click flips it off`);
    assert.equal(await switchButton.getAttribute('aria-checked'), 'false', `${reader.name}: aria-checked stays in sync`);
    await switchButton.click();
    assert.equal(await page.locator(`[data-testid=${reader.toggle}]`).getAttribute('data-enabled'), '1', `${reader.name}: one switch click flips it on`);

    await noOverflow(`${reader.name} 1440`);
    await shot(`switch-${reader.name}-1440`);

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(400);
    await noOverflow(`${reader.name} 375`);
    await shot(`switch-${reader.name}-375`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sleep(300);
}

assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('\n')}`);
console.log('\nRESULT: reading-highlight switch acceptance passed (3 readers, click/keyboard/persist/375).');
console.log(`SHOTS: ${SHOTS}`);
await browser.close();
