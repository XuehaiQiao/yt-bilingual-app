// P2-04 desktop layout acceptance (docs/设计-桌面布局规范.md §7).
//
// Real pages, mocked API: opens the six reading routes and asserts against the
// live DOM at 1440 / 1920 / 375:
//   - 1440: reading container 1200, content ≥ 1100, ≥xl two-column grid
//     (minmax(0,1fr) + 320px rail), body capped at 68ch, no overflow;
//   - 1920: container stays at the 1200px reading measure and is centered,
//     still two columns, rail still 320;
//   - 375: one column, rail stacks below, no horizontal overflow.
// It also checks the rail actually carries the page's own panel: language
// points / vocabulary / chapter index for the readers, progress / hints for
// the sentence pack, and the outline for the course.
// Screenshots: /tmp/p2-04-<page>-<width>@<sha7>.png.
//
// Run: node scripts/p2-04-layout-acceptance.mjs
// Needs `npm run dev` on http://127.0.0.1:5173 (override with APP_URL).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const CHROME =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name, width) => `/tmp/p2-04-${name}-${width}@${HEAD}.png`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────
const ARTICLE_SENTENCES = [
    'The quiet power of small habits shapes a good morning. A short walk before breakfast makes the whole day feel slower.',
    'Cities have always been shaped by the way people move through them. A street is not only a line on a map.',
];

const ARTICLE_DETAIL = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 60,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    analysisLevel: 'B1',
    analysisUnavailableReason: null,
    analysisUsed: null,
    analysisLimit: null,
    analysisResetAt: null,
    idioms: [
        { blockId: 0, phrase: 'the quiet power of small habits', meaning: '小习惯的安静力量' },
    ],
    culture: [],
    paragraphs: ARTICLE_SENTENCES.map((text, idx) => ({
        idx,
        text,
        translation: `第 ${idx + 1} 段示例译文。`,
        translationModel: 'deepseek-chat',
        translationFailed: false,
        glosses: {},
    })),
    progress: null,
    stats: { total: ARTICLE_SENTENCES.length, translated: ARTICLE_SENTENCES.length, untranslated: 0 },
};

const ARTICLE_SUMMARY = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 60,
    createdAt: 1763000000000,
    paragraphCount: ARTICLE_SENTENCES.length,
    progress: null,
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
    analysisLevel: 'B1',
    targetLang: 'zh-CN',
    analysisVersion: 'v1',
    idioms: [
        { blockId: 0, phrase: 'a quiet morning', meaning: '安静的早晨', quote: 'A Quiet Morning' },
    ],
    culture: [],
    paragraphs: [
        {
            en: 'The kettle sings on the stove while the house is still asleep. Nobody moves yet.',
            zh: '水壶在炉子上鸣叫，整座房子还在沉睡。',
        },
        {
            en: 'A short walk before breakfast makes the whole day feel slower.',
            zh: '早餐前散一小段步，会让一整天都慢下来。',
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
        id: 's1',
        title: 'Test Series',
        author: 'Jane Austen',
        description: 'test',
        totalBooks: 1,
        availableBooks: 1,
        readableChapters: 2,
        translatedChapters: 2,
        excluded: [],
        books: [],
    },
};

function bookChapter(n) {
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
        source: {
            provider: 'gutenberg',
            url: 'https://www.gutenberg.org/cache/epub/1342/pg1342.txt',
            fetchedAt: '2026-11-17T00:00:00Z',
            degraded: false,
        },
        paragraphs: [
            {
                index: 0,
                en: 'It is a truth universally acknowledged that a single man in possession of a good fortune must be in want of a wife.',
                zh: '凡是有钱的单身汉，总想娶位太太，这已经成了一条举世公认的真理。',
                glosses: {},
            },
        ],
        missingTranslations: 0,
        translationStatus: 'cached',
        translated: true,
        translatedChapters: 2,
        idioms: n === 1
            ? [{ blockId: 0, phrase: 'a truth universally acknowledged', meaning: '举世公认的真理' }]
            : [],
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
    chapters: [{ n: 1, title: 'Down the Rabbit-Hole', translated: true, translatedParagraphs: 1 }],
};

const IMPORTED_CHAPTER = {
    bookId: 'ib1',
    title: 'Alice in Wonderland',
    author: 'Lewis Carroll',
    sourceType: 'gutenberg',
    source: {
        provider: 'gutenberg',
        url: 'https://www.gutenberg.org/ebooks/11',
        fetchedAt: '2026-11-17T00:00:00Z',
        degraded: false,
    },
    sourceUrl: 'https://www.gutenberg.org/ebooks/11',
    chapter: 1,
    chapterTitle: 'Down the Rabbit-Hole',
    chapterCount: 1,
    targetLang: 'zh-CN',
    translated: true,
    translatedChapters: 1,
    missingTranslations: 0,
    languagePoints: [{ blockId: 0, text: 'Rabbit-Hole', meaning: '兔子洞', kind: 'culture' }],
    analysisLevel: 'B1',
    paragraphs: [
        {
            index: 0,
            en: 'Alice was beginning to get very tired of sitting by her sister. She had nothing to do.',
            zh: '爱丽丝挨着姐姐坐在河岸边，无事可做。',
            glosses: {},
        },
    ],
    quota: {
        feature: 'book_import_translate',
        limitPerDay: 10,
        usedToday: 0,
        remainingToday: 10,
        day: '2026-11-17',
    },
};

const SENTENCE_LEVELS = [{ id: 1, title: 'Level 1', subtitle: 'Everyday', count: 2, days: 2 }];
const SENTENCE_LEVEL = {
    ...SENTENCE_LEVELS[0],
    sentences: [
        { d: 1, n: 1, cat: 'think', zh: '小步走一走。', seg: ['A short walk helps you think.'] },
        { d: 2, n: 2, cat: 'daily', zh: '先喝水。', seg: ['Drink some water first.'] },
    ],
};

const COURSE_LESSON = {
    id: 'ocean-noise-12min',
    version: 1,
    title: 'Why the ocean is getting louder',
    titleZh: '为什么海洋越来越吵',
    level: 'B1',
    durationMinutes: 12,
    goal: '能说明一种危害，并给出一条可行的办法。',
    steps: [
        { id: 'S0', type: 'intro', title: '导入', body: '先看一段真实的海洋录音。', bullets: ['注意船与声呐的声音。'] },
        {
            id: 'S1',
            type: 'words',
            title: '关键词',
            points: [{ id: 'w1', kind: 'word', word: 'noise', meaning: '噪音', cefr: 'B1' }],
        },
        {
            id: 'S2',
            type: 'read',
            title: '阅读',
            paragraphs: [{ en: 'The ocean is louder than it was a century ago.', zh: '海洋比一个世纪前更吵了。' }],
            questions: [{
                id: 'q1',
                prompt: 'What makes the ocean louder?',
                options: [{ id: 'A', text: 'Ship traffic' }, { id: 'B', text: 'Cold water' }],
            }],
        },
        { id: 'S3', type: 'output', title: '产出', prompt: '用英文写 2–5 句。', rubric: ['一条危害', '一条办法'] },
    ],
};

const COURSE_ATTEMPT = {
    attemptId: 'att1',
    status: 'in_progress',
    currentStepId: 'S0',
    answers: {},
    output: '',
    startedAt: Date.now(),
    score: null,
    total: null,
    completedAt: null,
};

const FAVORITES = [
    {
        id: 'f1',
        videoId: 'art1',
        start: 0,
        en_text: 'quiet',
        zh_text: '安静的',
        added_at: 1763000000000,
        type: 'vocabulary',
        source_kind: 'article',
        source_ref: 'art1',
        source_title: 'Habits and Cities',
    },
    {
        id: 'f2',
        videoId: 'b1',
        start: 0,
        en_text: 'acknowledged',
        zh_text: '公认的',
        added_at: 1763000001000,
        type: 'vocabulary',
        source_kind: 'book',
        source_ref: 'b1',
        source_title: 'Pride and Prejudice',
    },
];

const cors = {
    'access-control-allow-origin': BASE.replace(/\/$/, ''),
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
});
await context.addInitScript(() => {
    try {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    } catch {
        /* about:blank has no storage access; the real pages do. */
    }
});

await context.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const pathname = new URL(request.url()).pathname;
    const respond = (data, status = 200) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            headers: cors,
            body: JSON.stringify(data),
        });
    if (pathname === '/api/auth/me') {
        return respond({
            user: { id: 'u-layout', email: 'layout@example.com' },
            isAdmin: false,
            guest: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites' && request.method() === 'GET') return respond(FAVORITES);
    if (pathname === '/api/models') {
        return respond({
            models: [
                { id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' },
            ],
            default: 'deepseek-chat',
        });
    }
    if (pathname === '/api/report/week') {
        return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    }
    if (pathname === '/api/placement/profile') {
        return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
    }
    if (pathname === '/api/review/stats') {
        return respond({
            targetLang: 'zh-CN',
            now: Date.now(),
            today: '2026-11-23',
            dueToday: 0,
            dueNow: 0,
            reviewedToday: 0,
            reviewedWordsToday: 0,
            newWords: 0,
            newToday: 0,
            totalWords: 0,
            suspendedWords: 0,
            streakDays: 0,
        });
    }
    if (pathname === '/api/review/words') return respond({ words: [], total: 0 });
    if (pathname === '/api/recommendations') {
        return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
    }
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/vocabulary/classify') return respond({ items: [] });
    if (pathname === '/api/articles' && request.method() === 'GET') {
        return respond({ articles: [ARTICLE_SUMMARY] });
    }
    if (pathname === '/api/article/art1') return respond(ARTICLE_DETAIL);
    if (pathname.match(/^\/api\/article\/art1\/(progress|translate)$/)) {
        return respond({ ok: true, status: 'done' });
    }
    if (pathname === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
    if (pathname === '/api/books/b1') return respond(BOOK);
    if (pathname === '/api/books/b1/chapters/1') return respond(bookChapter(1));
    if (pathname === '/api/books/b1/chapters/2') return respond(bookChapter(2));
    if (pathname === '/api/books/b1/progress' && request.method() === 'PUT') return respond({ ok: true });
    if (pathname === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
    if (pathname === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);
    if (pathname === '/api/sentences/levels') return respond(SENTENCE_LEVELS);
    if (pathname === '/api/sentences/level/1') return respond(SENTENCE_LEVEL);
    if (pathname === '/api/course/lessons/ocean-noise-12min') return respond(COURSE_LESSON);
    if (pathname === '/api/course/attempts' && request.method() === 'POST') {
        return respond(COURSE_ATTEMPT);
    }
    if (pathname.startsWith('/api/course/')) return respond({ ok: true });
    if (pathname.startsWith('/api/')) return respond({});
    return route.fulfill({
        status: 404,
        headers: cors,
        contentType: 'application/json',
        body: '{}',
    });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

const metrics = (prefix) =>
    page.evaluate((prefix) => {
        const box = (testId) => {
            const el = document.querySelector(`[data-testid="${testId}"]`);
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const container = document.querySelector(`[data-testid="${prefix}-layout"]`);
        const grid = document.querySelector(`[data-testid="${prefix}-grid"]`);
        const railEl = document.querySelector(`[data-testid="${prefix}-rail"]`);
        return {
            viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            container: container
                ? (() => {
                      const rect = container.getBoundingClientRect();
                      return {
                          width: rect.width,
                          x: rect.x,
                          variant: container.getAttribute('data-page-variant'),
                      };
                  })()
                : null,
            grid: box(`${prefix}-grid`),
            gridTracks: grid ? getComputedStyle(grid).gridTemplateColumns : null,
            main: box(`${prefix}-body`),
            rail: box(`${prefix}-rail`),
            railPosition: railEl ? getComputedStyle(railEl).position : null,
        };
    }, prefix);

const assertNoOverflow = (label, data) => {
    assert.ok(
        data.documentWidth <= data.viewport + 1,
        `${label}: horizontal overflow (document ${data.documentWidth} > viewport ${data.viewport})`,
    );
};

const countTracks = (tracks) =>
    String(tracks ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;

const assertRailContent = async (prefix, railIds) => {
    for (const id of railIds) {
        assert.equal(
            await page.locator(`[data-testid="${id}"]`).count(),
            1,
            `${prefix}: rail panel ${id} missing`,
        );
    }
};

const assertPage = async ({ name, prefix, url, ready, railIds }) => {
    // A fresh document per page: a hash-only change keeps the previous screen.
    await page.goto('about:blank');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}#${url}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid="app-shell"]').waitFor({ state: 'visible', timeout: 15000 });
    for (const testId of ready) {
        await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 15000 });
    }
    await page.locator(`[data-testid="${prefix}-rail"]`).waitFor({ state: 'visible', timeout: 10000 });
    await assertRailContent(prefix, railIds);
    await sleep(400); // fonts + the xl media query

    // ── 1440: reading container, content ≥1100, two columns, 68ch body ─────
    await page.setViewportSize({ width: 1440, height: 900 });
    await sleep(300);
    const at1440 = await metrics(prefix);
    await page.screenshot({ path: SHOT(name, 1440) });
    assertNoOverflow(`${name} 1440`, at1440);
    assert.ok(at1440.container, `${name} 1440: missing reading layout container`);
    assert.equal(at1440.container.variant, 'reading', `${name} 1440: container variant`);
    assert.ok(
        at1440.container.width >= 1180,
        `${name} 1440: container ${at1440.container.width} < 1180`,
    );
    assert.ok(at1440.grid.width >= 1100, `${name} 1440: content ${at1440.grid?.width} < 1100`);
    assert.equal(
        countTracks(at1440.gridTracks),
        2,
        `${name} 1440: expected two tracks, got ${at1440.gridTracks}`,
    );
    assert.ok(
        Math.abs(at1440.rail.width - 320) <= 1,
        `${name} 1440: rail width ${at1440.rail.width} != 320`,
    );
    assert.equal(
        at1440.railPosition,
        'sticky',
        `${name} 1440: rail position ${at1440.railPosition} != sticky`,
    );
    assert.ok(
        at1440.rail.x >= at1440.main.x + at1440.main.width - 1,
        `${name} 1440: rail is not to the right of the body column`,
    );
    assert.ok(
        at1440.rail.y <= at1440.main.y + 1,
        `${name} 1440: rail does not start on the main row`,
    );
    assert.ok(
        at1440.main.width >= 600 && at1440.main.width <= 720,
        `${name} 1440: body column ${at1440.main.width} outside the 68ch measure`,
    );
    assert.ok(
        at1440.main.x >= at1440.grid.x - 1
            && at1440.main.x + at1440.main.width <= at1440.grid.x + at1440.grid.width + 1,
        `${name} 1440: body column escapes the grid`,
    );

    // ── 1920: container stays 1200 and centered, still two columns ────────
    await page.setViewportSize({ width: 1920, height: 900 });
    await sleep(300);
    const at1920 = await metrics(prefix);
    await page.screenshot({ path: SHOT(name, 1920) });
    assertNoOverflow(`${name} 1920`, at1920);
    assert.ok(
        Math.abs(at1920.container.width - 1200) <= 2,
        `${name} 1920: container ${at1920.container.width} != 1200`,
    );
    assert.ok(
        Math.abs(at1920.container.x - (at1920.viewport - 1200) / 2) <= 2,
        `${name} 1920: container x ${at1920.container.x} is not centered`,
    );
    assert.equal(
        countTracks(at1920.gridTracks),
        2,
        `${name} 1920: expected two tracks, got ${at1920.gridTracks}`,
    );
    assert.ok(
        Math.abs(at1920.rail.width - 320) <= 1,
        `${name} 1920: rail width ${at1920.rail.width} != 320`,
    );
    assert.ok(
        at1920.main.width >= 600 && at1920.main.width <= 720,
        `${name} 1920: body column ${at1920.main.width} outside the 68ch measure`,
    );

    // ── 375: single column, rail below, no overflow ───────────────────────
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    const at375 = await metrics(prefix);
    await page.screenshot({ path: SHOT(name, 375) });
    assertNoOverflow(`${name} 375`, at375);
    assert.equal(
        countTracks(at375.gridTracks),
        1,
        `${name} 375: expected one track, got ${at375.gridTracks}`,
    );
    assert.ok(
        at375.container.width <= 375,
        `${name} 375: container ${at375.container.width} wider than viewport`,
    );
    assert.ok(
        at375.rail.y >= at375.main.y + at375.main.height - 1,
        `${name} 375: rail did not stack below the body column`,
    );
    assert.ok(
        Math.abs(at375.rail.x - at375.main.x) <= 1,
        `${name} 375: rail is not full-width in the single column`,
    );
    assert.equal(
        at375.railPosition,
        'static',
        `${name} 375: rail position ${at375.railPosition} != static`,
    );
    assert.ok(
        at375.main.width <= 375 && at375.main.width > 250,
        `${name} 375: body column ${at375.main.width} out of range`,
    );

    return {
        name,
        screenshots: [SHOT(name, 1440), SHOT(name, 1920), SHOT(name, 375)],
        at1440: {
            containerWidth: at1440.container.width,
            contentWidth: at1440.grid.width,
            bodyWidth: at1440.main.width,
            tracks: at1440.gridTracks,
            railWidth: at1440.rail.width,
            railPosition: at1440.railPosition,
        },
        at1920: {
            containerWidth: at1920.container.width,
            containerX: at1920.container.x,
            bodyWidth: at1920.main.width,
            tracks: at1920.gridTracks,
            railWidth: at1920.rail.width,
        },
        at375: {
            containerWidth: at375.container.width,
            tracks: at375.gridTracks,
            railTop: at375.rail.y,
            mainBottom: at375.main.y + at375.main.height,
            railPosition: at375.railPosition,
        },
    };
};

const pages = [
    {
        name: 'reader',
        prefix: 'reader',
        url: '/content/reader/art1',
        ready: ['reader-en-0', 'reader-rail-language-points'],
        railIds: ['reader-rail-toc', 'reader-rail-language-points', 'reader-rail-vocabulary'],
    },
    {
        name: 'library',
        prefix: 'library',
        url: '/learn/library/lib1',
        ready: ['library-en-0', 'library-rail-language-points'],
        railIds: ['library-rail-toc', 'library-rail-language-points', 'library-rail-vocabulary'],
    },
    {
        name: 'book',
        prefix: 'book',
        url: '/content/book/b1',
        ready: ['book-en-0', 'book-rail-language-points'],
        railIds: ['book-rail-chapters', 'book-rail-language-points', 'book-rail-vocabulary'],
    },
    {
        name: 'imported-book',
        prefix: 'imported-book',
        url: '/content/imported-book/ib1',
        ready: ['imported-book-en-0', 'imported-book-rail-language-points'],
        railIds: [
            'imported-book-rail-chapters',
            'imported-book-rail-language-points',
            'imported-book-rail-vocabulary',
        ],
    },
    {
        name: 'sentences',
        prefix: 'sentences',
        url: '/content/sentences/1',
        ready: ['sentences-rail-progress', 'share-sentence-1-1'],
        railIds: ['sentences-rail-progress', 'sentences-rail-hints'],
    },
    {
        name: 'course',
        prefix: 'course',
        url: '/app/today/lesson/ocean-noise-12min',
        ready: ['course-step-count', 'course-rail-outline'],
        railIds: ['course-rail-outline'],
    },
];

const results = [];
for (const entry of pages) {
    results.push(await assertPage(entry));
}

assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);

console.log(
    JSON.stringify(
        {
            status: 'PASS',
            head: HEAD,
            pages: results,
        },
        null,
        2,
    ),
);

await browser.close();
