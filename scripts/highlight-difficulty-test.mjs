// Playwright acceptance for the 2026-11-17 reading-highlight request:
//   ① 我的 page: the slider is now 「高亮难度」 and the copy says it only
//     decides which words get marked (not an ability rating / not used for
//     recommendations);
//   ② first run seeds the slider from the ability profile's high band
//     (A2–B1 → B1 / moonwalk), once — an existing saved value is never
//     overwritten;
//   ③ articles, free-library articles, public-domain books and imported books
//     mark words above the threshold with the same logic, each reader has a
//     persisted 「标亮生词」 switch, level changes re-run the threshold, the
//     lookup API failing fails silently (reading + word lookup keep working),
//     and repeated words are cached instead of re-requested.
//
// Every /api/** request is mocked, so no backend, database or LLM is touched.
//
// Run: node scripts/highlight-difficulty-test.mjs   (needs `npm run dev` on :5173)
// Output: /tmp/highlight-shots/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const SHOTS = '/tmp/highlight-shots';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ── Fixtures ───────────────────────────────────────────────────────────────
// A 3-paragraph article: paragraph 0 carries one B2 word, paragraph 1 one C1+
// word, paragraph 2 adds enough distinct words to force more than one
// /api/vocabulary/classify batch (the client sends ≤100 tokens per request;
// the endpoint itself accepts ≤200).
const FILLER = Array.from({ length: 130 }, (_, i) => {
    const a = 'abcdefghijklmnopqrstuvwxyz'[i % 26];
    const b = 'abcdefghijklmnopqrstuvwxyz'[Math.floor(i / 26) % 26];
    return `w${a}${b}`;
});
const EN = [
    'The quiet morning begins with a luminous walk before breakfast.',
    'Cities hold a quiet cosmos inside ordinary streets and public benches.',
    `A short walk makes the whole day feel calmer. ${FILLER.join(' ')}`,
];
const ZH = [
    '安静的早晨从早餐前一段明亮的散步开始。',
    '城市在寻常街道与公共长椅里藏着一个安静的宇宙。',
    '短短一段散步会让一整天更平静。',
];
const LIBRARY_EN = [
    'The kettle sings while a luminous morning begins.',
    'A short walk through the neighbourhood makes the day feel slower.',
];
const LIBRARY_ZH = [
    '水壶在鸣叫，明亮的早晨开始了。',
    '在附近散一段步，会让这一天慢下来。',
];
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

const HARD_WORDS = new Set(['luminous']); // B2
const BEYOND_WORDS = new Set(['cosmos']); // C1+

const SERIES = {
    id: 's1',
    title: 'Test Series',
    author: 'Jane Austen',
    description: 'A public-domain series used by the highlight acceptance test.',
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
const READER_ARTICLE = {
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
};

const state = {
    placementHigh: 'B1',
    placementLow: 'A2',
    levelApiFail: false,
    levelRequests: 0,
    levelRequestSizes: [],
    levelledWords: new Set(),
};

const CORS = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

// Mocked word → level: `luminous` is B2, `cosmos` is C1+, long unknown words
// are C1+ (the backend's contract for a valid word outside the frequency
// list), everything else A1. C2 is never returned (the client treats C2 as the
// highest threshold and marks nothing extra).
function levelForWord(word) {
    const normalized = String(word).trim().toLowerCase();
    if (!normalized) return null;
    if (HARD_WORDS.has(normalized)) return 'B2';
    if (BEYOND_WORDS.has(normalized)) return 'C1+';
    if (normalized.length >= 11) return 'C1+';
    if (!/^[a-z][a-z'’-]*$/.test(normalized)) return null;
    return 'A1';
}

// ── Browser + mocked API ───────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
    // Defaults only: later tests may switch the UI language and reload.
    if (!localStorage.getItem('yt_bilingual_ui_lang')) {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    }
    if (!localStorage.getItem('yt_bilingual_target_lang')) {
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    }
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
        status,
        contentType: 'application/json',
        headers: CORS,
        body: JSON.stringify(data),
    });
    const fail = (status, detail) => respond({ detail }, status);

    // ── app shell ─────────────────────────────────────────────────────────
    if (pathname === '/api/auth/me') {
        return respond({ user: { id: 'u-highlight', email: 'highlight@example.com', username: 'Reader' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-highlight', email: 'highlight@example.com', username: 'Reader', credits: 12, memberSince: 1763000000000 },
            monthSpendUsd: 0.12,
            usageToday: { minutes: 8 },
            version: 'test',
            preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions' || pathname === '/api/shows') {
        return respond(pathname === '/api/shows' ? { shows: [] } : []);
    }
    if (pathname === '/api/favorites' && method === 'GET') return respond([]);
    if (pathname === '/api/favorites' && method === 'POST') return respond({ favorite: { id: 'fav-1' } });
    if (pathname.startsWith('/api/favorites/') && method === 'DELETE') return respond({ ok: true });
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({
            models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    if (pathname === '/api/placement/profile') {
        return respond({
            profile: {
                cefr: `${state.placementLow}–${state.placementHigh}`,
                levelBandLow: state.placementLow,
                levelBandHigh: state.placementHigh,
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
        return respond({ status: 'ok', vocabulary: { cefr: state.placementHigh, low: state.placementLow, high: state.placementHigh, label: `${state.placementLow}–${state.placementHigh}` } });
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
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });

    // ── highlight classification under test ──────────────────────────────
    // The reader now calls POST /api/vocabulary/classify (level + proper
    // noun). Mocked words are lowercase or sentence-start capitals, so
    // `proper: false` is enough for this fixture; the real rule lives in
    // backend/word_rules.py and is covered by backend pytest.
    if (pathname === '/api/vocabulary/classify') {
        const body = request.postDataJSON() || {};
        const items = Array.isArray(body.items) ? body.items : [];
        state.levelRequests += 1;
        state.levelRequestSizes.push(items.length);
        if (state.levelApiFail) return fail(500, 'classification unavailable');
        return respond({
            items: items.map((item) => {
                const text = String(item?.text ?? '');
                state.levelledWords.add(text.toLowerCase());
                return { text, level: levelForWord(text), proper: false };
            }),
        });
    }

    // ── dictionary ────────────────────────────────────────────────────────
    if (pathname === '/api/define') {
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

    // ── reading API ───────────────────────────────────────────────────────
    if (pathname === '/api/articles' && method === 'GET') {
        return respond({ articles: [READER_ARTICLE].map((article) => ({
            articleId: article.articleId,
            title: article.title,
            site: article.site,
            sourceUrl: article.sourceUrl,
            lang: article.lang,
            wordCount: article.wordCount,
            createdAt: article.createdAt,
            paragraphCount: article.paragraphs.length,
            progress: null,
        })) });
    }
    if (pathname === '/api/article/art1' && method === 'GET') {
        const translations = READER_ARTICLE.translations[url.searchParams.get('targetLang') || 'zh-CN'] || {};
        const paragraphs = READER_ARTICLE.paragraphs.map(({ idx, text }) => ({
            idx,
            text,
            translation: translations[idx] ?? null,
            translationModel: translations[idx] ? 'deepseek-chat' : null,
            translationFailed: false,
        }));
        const translated = paragraphs.filter((paragraph) => paragraph.translation).length;
        return respond({
            articleId: READER_ARTICLE.articleId,
            title: READER_ARTICLE.title,
            site: READER_ARTICLE.site,
            sourceUrl: READER_ARTICLE.sourceUrl,
            lang: READER_ARTICLE.lang,
            wordCount: READER_ARTICLE.wordCount,
            createdAt: READER_ARTICLE.createdAt,
            targetLang: url.searchParams.get('targetLang') || 'zh-CN',
            paragraphs,
            progress: null,
            stats: { total: paragraphs.length, translated, untranslated: paragraphs.length - translated },
        });
    }
    if (/^\/api\/article\/[^/]+\/progress$/.test(pathname) && method === 'PUT') {
        return respond({ articleId: 'art1', paragraphIdx: 0, updatedAt: Date.now() });
    }
    if (/^\/api\/article\/[^/]+\/translate$/.test(pathname) && method === 'POST') {
        return respond({ articleId: 'art1', targetLang: 'zh-CN', status: 'done', total: 3, translated: 3, failed: 0, failedIndices: [], model: 'deepseek-chat', batches: 0 });
    }

    // ── free library ──────────────────────────────────────────────────────
    if (pathname === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
    if (pathname.startsWith('/api/library/videos/')) return fail(404, 'not a video');

    // ── public-domain + imported books ────────────────────────────────────
    if (pathname === '/api/books/b1') return respond(BOOK);
    if (pathname === '/api/books/b1/chapters/1') return respond(bookChapter());
    if (/^\/api\/books\/b1\/chapters\/1\/translate$/.test(pathname) && method === 'POST') {
        return respond(bookChapter());
    }
    if (pathname === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
    if (pathname === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);
    if (/^\/api\/books\/imported\/ib1\/chapters\/1\/translate$/.test(pathname) && method === 'POST') {
        return respond(IMPORTED_CHAPTER);
    }

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

async function waitApp() {
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
    await sleep(250);
}

async function gotoHash(hash) {
    await page.goto(`${BASE}#${hash}`, { waitUntil: 'domcontentloaded' });
    await waitApp();
}

const noOverflow = async (label) => {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
    return metrics;
};

async function setHash(hash) {
    await page.evaluate((next) => { window.location.hash = next; }, hash);
    await sleep(300);
}

async function closePopover() {
    const overlay = page.locator('[data-testid=word-popover-overlay]');
    if (await overlay.count()) {
        await overlay.click({ position: { x: 6, y: 6 } }).catch(() => {});
        await page.waitForTimeout(250);
    }
}

/** Wait until a specific word in a paragraph carries the amber mark. */
async function waitHighlighted(testId, word) {
    await page.waitForFunction(
        ({ testId: id, word: target }) => {
            const paragraph = document.querySelector(`[data-testid=${id}]`);
            if (!paragraph) return false;
            const found = paragraph.querySelector(`[data-word-hit="${target}"]`);
            return Boolean(found && found.getAttribute('data-highlight') === '1');
        },
        { testId, word },
        { timeout: 10000 },
    );
}

async function waitNoHighlights(testId) {
    await page.waitForFunction(
        (id) => {
            const paragraph = document.querySelector(`[data-testid=${id}]`);
            return Boolean(paragraph) && paragraph.querySelectorAll('[data-highlight]').length === 0;
        },
        testId,
        { timeout: 10000 },
    );
}

const highlightedWords = async (testId) => page.evaluate((id) => (
    Array.from(document.querySelectorAll(`[data-testid=${id}] [data-highlight]`))
        .map((element) => element.getAttribute('data-word-hit'))
), testId);

async function clickWordAndExpectCard(testId, word) {
    await page.locator(`[data-testid=${testId}] [data-word-hit="${word}"]`).click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 8000 });
    await page.locator('[data-testid=word-popover]').getByText('安静的；平静的').waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(true, `${testId}: dictionary card opened for ${word}`);
    await sleep(350);
}

async function clickAxisStop(label) {
    await page.locator(`[data-testid=vocab-axis-stop-${label}]`).click();
    await page.waitForFunction(
        (expected) => localStorage.getItem('yt_bilingual_vocab_level') === expected,
        { A1: 'liftoff', A2: 'orbit', B1: 'moonwalk', B2: 'interstellar', C1: 'deep-space', C2: 'supernova' }[label],
        { timeout: 8000 },
    );
}

// ── a) 我的 copy + b) first-run seed from A2–B1 ────────────────────────────
await page.goto(BASE, { waitUntil: 'domcontentloaded' });
await waitApp();
// The top-level seeding effect runs once the placement profile resolves; it
// must already be applied before any article/video is opened.
await page.waitForFunction(
    () => localStorage.getItem('yt_bilingual_vocab_level') === 'moonwalk',
    null,
    { timeout: 10000 },
);

await setHash('#/profile');
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 15000 });
await page.waitForFunction(
    () => document.querySelector('[data-testid=account-vocab-current]')?.textContent?.trim() === 'B1',
    null,
    { timeout: 8000 },
);
const vocabPanel = page.locator('[data-testid=account-vocab-level]');
const panelText = await vocabPanel.innerText();
assert.match(panelText, /高亮难度/, 'settings title must be 高亮难度');
assert.match(panelText, /只决定哪些词被标亮/, 'settings hint must explain what it affects');
assert.match(panelText, /不是能力评级/, 'settings hint must deny being an ability rating');
assert.match(panelText, /不影响内容推荐/, 'settings hint must deny affecting recommendations');
assert.match(await page.locator('[data-testid=vocab-axis-tagline]').innerText(), /只标亮高于 B1 的词/);
assert.equal(await page.locator('[data-testid=account-vocab-current]').innerText(), 'B1');
assert.equal(await page.locator('text=你的英语水平（CEFR）').count(), 0, 'old title must be gone');
await shot('01-profile-highlight-copy-1440');
await shot('02-profile-seeded-b1-1440');

// ── c) an existing saved value is never overwritten by the profile ────────
await page.evaluate(() => localStorage.setItem('yt_bilingual_vocab_level', 'interstellar'));
await page.reload({ waitUntil: 'domcontentloaded' });
await waitApp();
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(900); // let the placement profile resolve and the seed effect run
assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_vocab_level')), 'interstellar',
    'a saved B2 choice must not be replaced by the profile band');
await page.waitForFunction(
    () => document.querySelector('[data-testid=account-vocab-current]')?.textContent?.trim() === 'B2',
    null,
    { timeout: 8000 },
);
await shot('03-profile-saved-not-overwritten-1440');

// ── d) article highlights at B1 + word lookup still works ─────────────────
await page.evaluate(() => localStorage.setItem('yt_bilingual_vocab_level', 'moonwalk'));
await gotoHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await waitHighlighted('reader-en-0', 'luminous');
assert.equal(
    await page.locator('[data-testid=reader-en-0] [data-word-hit="morning"]').getAttribute('data-highlight'),
    null,
    'A1 words must not be marked at B1',
);
assert.equal(
    await page.locator('[data-testid=reader-en-1] [data-word-hit="cosmos"]').getAttribute('data-highlight'),
    '1',
    'C1+ words must be marked at B1',
);
assert.ok(state.levelRequestSizes.length >= 2, `expected >1 batched classify calls, got ${state.levelRequestSizes.length}`);
assert.ok(state.levelRequestSizes.every((size) => size <= 100), `batches must be ≤100 tokens: ${state.levelRequestSizes}`);
const readerToggle = page.locator('[data-testid=reader-highlight-toggle]');
assert.equal(await readerToggle.getAttribute('data-enabled'), '1');
assert.match(await readerToggle.getAttribute('title'), /B1/);
const levelRequestsAfterFirstPaint = state.levelRequests;
await noOverflow('article 1440');
await shot('04-article-highlight-1440');

await page.setViewportSize({ width: 375, height: 812 });
await sleep(300);
await noOverflow('article 375');
await shot('04b-article-highlight-375');
await page.setViewportSize({ width: 1440, height: 1000 });
await sleep(300);

// Highlighted words remain clickable for dictionary lookup.
await clickWordAndExpectCard('reader-en-0', 'luminous');
await shot('05-article-word-card-1440');
await closePopover();

// Same-word caching: leave and re-enter without a full reload; every word is
// already cached, so the lookup endpoint must not be touched again.
await setHash('#/profile');
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 10000 });
await setHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await waitHighlighted('reader-en-0', 'luminous');
assert.equal(state.levelRequests, levelRequestsAfterFirstPaint,
    `re-entering the same text must reuse cached classifications (${state.levelRequests} vs ${levelRequestsAfterFirstPaint})`);
await shot('05b-article-cached-reentry-1440');

// ── e) the switch is persisted (off → refresh → still off) ────────────────
await readerToggle.click();
assert.equal(await readerToggle.getAttribute('data-enabled'), '0');
assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_reading_highlight')), '0');
await page.waitForFunction(() => document.querySelectorAll('[data-testid=reader-en-0] [data-highlight]').length === 0, null, { timeout: 8000 });
assert.equal((await highlightedWords('reader-en-0')).length, 0);
await shot('06-article-toggle-off-1440');
await clickWordAndExpectCard('reader-en-0', 'luminous');
await closePopover();

await page.reload({ waitUntil: 'domcontentloaded' });
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(600);
assert.equal(await page.locator('[data-testid=reader-highlight-toggle]').getAttribute('data-enabled'), '0',
    'the off switch must survive a refresh');
assert.equal((await highlightedWords('reader-en-0')).length, 0);
await shot('06b-article-toggle-off-refresh-1440');
// Re-enable for the remaining checks.
await page.locator('[data-testid=reader-highlight-toggle]').click();
await waitHighlighted('reader-en-0', 'luminous');

// ── f) changing the level recomputes the threshold ────────────────────────
await setHash('#/profile');
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 10000 });
await clickAxisStop('C1');
assert.equal(await page.locator('[data-testid=account-vocab-current]').innerText(), 'C1');
await setHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await waitHighlighted('reader-en-1', 'cosmos');
assert.equal(
    await page.locator('[data-testid=reader-en-0] [data-word-hit="luminous"]').getAttribute('data-highlight'),
    null,
    'at C1 a B2 word must no longer be marked',
);
assert.match(await page.locator('[data-testid=reader-highlight-toggle]').getAttribute('title'), /C1/);
await shot('07-article-level-c1-1440');

await setHash('#/profile');
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 10000 });
await clickAxisStop('C2');
await setHash('/content/reader/art1');
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(900);
assert.equal((await highlightedWords('reader-en-0')).length, 0, 'C2 is the top stop: nothing extra is marked');
assert.equal(await page.locator('[data-testid=vocab-axis-tagline]').count(), 0); // reader page has no axis
await shot('08-article-level-c2-1440');

// Back to B1 for the four-reader matrix.
await setHash('#/profile');
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 10000 });
await clickAxisStop('B1');
// Level-switch toasts live 6s; let the stack clear so the reader screenshots
// show the page, not three「已保存」cards.
await sleep(6200);

// ── d) free library / public-domain book / imported book ──────────────────
const READERS = [
    {
        name: 'library',
        hash: '/learn/library/lib1',
        ready: '[data-testid=library-en-0]',
        first: 'library-en-0',
        hard: 'luminous',
        toggle: 'library-highlight-toggle',
        word: 'luminous',
        easy: 'morning',
    },
    {
        name: 'book',
        hash: '/content/book/b1',
        ready: '[data-testid=book-en-0]',
        first: 'book-en-0',
        hard: 'luminous',
        toggle: 'book-highlight-toggle',
        word: 'luminous',
        easy: 'truth',
    },
    {
        name: 'imported-book',
        hash: '/content/imported-book/ib1',
        ready: '[data-testid=imported-book-en-0]',
        first: 'imported-book-en-0',
        hard: 'luminous',
        toggle: 'imported-book-highlight-toggle',
        word: 'luminous',
        easy: 'beginning',
    },
];
for (const reader of READERS) {
    await gotoHash(reader.hash);
    await page.locator(reader.ready).waitFor({ state: 'visible', timeout: 15000 });
    await waitHighlighted(reader.first, reader.hard);
    assert.equal(
        await page.locator(`[data-testid=${reader.first}] [data-word-hit="${reader.easy}"]`).first().getAttribute('data-highlight'),
        null,
        `${reader.name}: A1 word (${reader.easy}) must not be marked`,
    );
    const toggle = page.locator(`[data-testid=${reader.toggle}]`);
    assert.equal(await toggle.getAttribute('data-enabled'), '1', `${reader.name}: switch defaults on`);
    await noOverflow(`${reader.name} 1440`);
    await shot(`09-${reader.name}-highlight-1440`);
    await clickWordAndExpectCard(reader.first, reader.word);
    await shot(`09b-${reader.name}-word-card-1440`);
    await closePopover();

    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(250);
    await noOverflow(`${reader.name} 375`);
    await shot(`10-${reader.name}-highlight-375`);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await sleep(250);
}

// ── h) lookup failure is silent and never blocks reading ──────────────────
state.levelApiFail = true;
// Force a full document load: a hash-only navigation would keep the module
// cache warm and legitimately skip the (failing) lookup.
await page.goto(`${BASE}?level-api-fail=${Date.now()}#/content/reader/art1`, { waitUntil: 'domcontentloaded' });
await waitApp();
await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });
await sleep(900);
assert.equal((await highlightedWords('reader-en-0')).length, 0, 'failed lookup must show no highlight');
assert.ok((await page.locator('[data-testid=reader-en-0] [data-word-hit]').count()) > 0, 'text must still be readable/clickable');
await clickWordAndExpectCard('reader-en-0', 'quiet');
await closePopover();
await shot('11-api-failure-silent-1440');
state.levelApiFail = false;

// ── a) Vietnamese copy ────────────────────────────────────────────────────
await page.evaluate(() => localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN'));
// The UI language is read when the provider mounts; reload the document so
// the Vietnamese dictionary is active.
await page.goto(`${BASE}?lang=vi#/profile`, { waitUntil: 'domcontentloaded' });
await waitApp();
await page.locator('[data-testid=account-vocab-level]').waitFor({ state: 'visible', timeout: 15000 });
const viPanel = await page.locator('[data-testid=account-vocab-level]').innerText();
assert.match(viPanel, /Độ khó tô sáng/, 'Vietnamese title must be localized');
assert.match(viPanel, /không phải đánh giá năng lực/, 'Vietnamese hint must deny being an ability rating');
assert.match(viPanel, /không ảnh hưởng đến gợi ý nội dung/, 'Vietnamese hint must deny affecting recommendations');
await shot('12-profile-vi-highlight-copy-1440');
await page.evaluate(() => localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN'));

assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join('\n')}`);
console.log(`\nRESULT: highlight difficulty acceptance passed (${state.levelRequests} classify requests, batches ${JSON.stringify(state.levelRequestSizes)}).`);
console.log(`SHOTS: ${SHOTS}`);
await browser.close();
