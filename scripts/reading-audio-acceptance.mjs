// Acceptance check for specs/037 (reading audio / shadowing).
//
// Runs the real React readers against a fully mocked backend and a mocked
// `speechSynthesis` (the engine's `onend` is driven by the test, so the state
// machine is deterministic — no real voice is used).
//
// Covered:
//   1. sentence splitter: abbreviations (Mr./Dr./U.S./e.g.), quotes, ellipsis;
//   2. continuous mode: a finished sentence advances automatically, and the
//      highlight follows — including across a paragraph boundary;
//   3. shadow mode: one sentence then a pause with 「再听一遍 / 下一句」;
//   4. rate change re-reads the current sentence at the new rate, and the
//      stale `onend` fired by `cancel()` does not double-advance;
//   5. keyboard Space / ← / → (and not intercepted inside a text field);
//   6. close + chapter switch stop the voice immediately;
//   7. missing English voice: bar disabled with an explicit message;
//   8. word clicks and language-point ruby keep working while the bar is open;
//   9. 1440 and 375 screenshots, no horizontal overflow at 375.
//
// Run (needs `npm run dev` on :5173; Playwright lives in scripts/node_modules):
//   node scripts/reading-audio-acceptance.mjs
//   APP_URL=http://127.0.0.1:5174 node scripts/reading-audio-acceptance.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const SHOTS = '/tmp';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(SHOTS, { recursive: true });

// ── fixtures ───────────────────────────────────────────────────────────────
const BOOK_SENTENCES = [
    [
        'Mr. Smith met Dr. Jones at the U.S. Army base, e.g. in Texas.',
        'They talked for an hour about the weather.',
    ],
    [
        '"Go home," she said quietly.',
        'He left without a word... Then the lamp went out.',
        'Nobody moved after that.',
    ],
    ['A short walk before breakfast makes the whole day feel slower.'],
];
const BOOK_ZH = ['史密斯先生在得克萨斯州的美国陆军基地见到了琼斯博士。', '他们聊了一个小时的天气。'];

const ARTICLE_SENTENCES = [
    [
        'The quiet power of small habits shapes a good morning.',
        'A short walk before breakfast makes the whole day slower.',
    ],
    [
        'Cities have always been shaped by the way people move through them.',
        'A street is not only a line on a map; it is a rhythm of footsteps and buses.',
    ],
];
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
    const paragraphs = n === 1 ? BOOK_SENTENCES : [['Chapter two begins here.', 'And it ends here.']];
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
        paragraphs: paragraphs.map((sentences, index) => ({
            index,
            en: sentences.join(' '),
            zh: n === 1 ? (BOOK_ZH[index] ?? '示例译文。') : '示例译文。',
            glosses: {},
        })),
        missingTranslations: 0,
        translationStatus: 'cached',
        translated: true,
        translatedChapters: 2,
        // The book API carries language points as two raw lists (see
        // `asBookChapter` in lib/books.ts): idioms `{phrase, meaning}` and
        // culture `{term, note}`.
        idioms: [],
        culture: n === 1 ? [{ blockId: 0, term: 'Mr. Smith', note: '史密斯先生' }] : [],
        analysisLevel: 'B1',
    };
}

const ARTICLE_DETAIL = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 120,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    analysisLevel: 'B1',
    idioms: [{ blockId: 1, phrase: 'a rhythm of footsteps', meaning: '脚步的节奏' }],
    culture: [],
    paragraphs: ARTICLE_SENTENCES.map((sentences, idx) => ({
        idx,
        text: sentences.join(' '),
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
    wordCount: 120,
    createdAt: 1763000000000,
    paragraphCount: ARTICLE_SENTENCES.length,
    progress: null,
};


// ── extra surfaces (library article / imported book / sentence pack) ───────
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
        { en: 'The kettle sings on the stove while the house is still asleep. Nobody moves yet.', zh: '水壶在炉子上鸣叫，整座房子还在沉睡。' },
        { en: 'A short walk before breakfast makes the whole day feel slower.', zh: '早餐前散一小段步，会让一整天都慢下来。' },
    ],
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
    missingTranslations: 0,
    idioms: [],
    culture: [],
    paragraphs: [
        { index: 0, en: 'Alice was beginning to get very tired of sitting by her sister. She had nothing to do.', zh: '爱丽丝挨着姐姐坐在河岸边，无事可做。' },
        { index: 1, en: 'Once or twice she had peeped into the book her sister was reading.', zh: '她偷偷看了姐姐在读的那本书。' },
    ],
    quota: { feature: 'book_import_translate', limitPerDay: 10, usedToday: 0, remainingToday: 10, day: '2026-11-17' },
};

const SENTENCE_LEVELS = [{ id: 1, title: 'Level 1', subtitle: 'Everyday', count: 2, days: 1 }];
const SENTENCE_LEVEL = {
    ...SENTENCE_LEVELS[0],
    sentences: [
        { d: 1, n: 1, cat: 'think', zh: '小步走一走。', seg: ['A short walk helps you think. Then the day opens up.'] },
        { d: 1, n: 2, cat: 'daily', zh: '先喝水。', seg: ['Drink some water first.'] },
    ],
};

// ── speechSynthesis stub (installed before the app boots) ──────────────────
function installSpeechStub({ englishVoices }) {
    const voices = englishVoices
        ? [
            { name: 'Mock English', lang: 'en-US', default: true, localService: true, voiceURI: 'mock-en' },
            { name: 'Mock Vietnamese', lang: 'vi-VN', default: false, localService: true, voiceURI: 'mock-vi' },
        ]
        : [{ name: 'Mock Vietnamese', lang: 'vi-VN', default: true, localService: true, voiceURI: 'mock-vi' }];

    const state = {
        voices,
        current: null,
        log: [],
        cancels: 0,
        scrolls: [],
    };
    window.__tts = state;

    class MockUtterance {
        constructor(text) {
            this.text = text;
            this.lang = '';
            this.rate = 1;
            this.voice = null;
            this.onend = null;
            this.onerror = null;
        }
    }
    window.SpeechSynthesisUtterance = MockUtterance;

    const listeners = new Map();
    const synth = {
        speaking: false,
        pending: false,
        paused: false,
        getVoices: () => state.voices,
        addEventListener: (type, handler) => {
            if (!listeners.has(type)) listeners.set(type, new Set());
            listeners.get(type).add(handler);
        },
        removeEventListener: (type, handler) => {
            listeners.get(type)?.delete(handler);
        },
        speak: (utterance) => {
            state.current = utterance;
            state.log.push({ kind: 'speak', text: utterance.text, rate: utterance.rate, lang: utterance.lang });
        },
        cancel: () => {
            const previous = state.current;
            state.current = null;
            state.cancels += 1;
            state.log.push({ kind: 'cancel' });
            // Chrome still delivers `onend` after `cancel()`; the hook must
            // ignore this stale callback unless its generation matches.
            if (previous) {
                window.setTimeout(() => {
                    try {
                        previous.onend?.(new window.Event('end'));
                    } catch {
                        /* ignore */
                    }
                }, 0);
            }
        },
        pause: () => {},
        resume: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });

    // Finish the live utterance the way the real engine does.
    window.__ttsFinish = (error) => {
        const utterance = state.current;
        if (!utterance) return null;
        state.current = null;
        state.log.push({ kind: 'end', text: utterance.text });
        if (error) utterance.onerror?.({ error });
        else utterance.onend?.();
        return utterance.text;
    };

    // Record (do not skip) programmatic scrolling so reduced-motion can be
    // asserted: the hook must ask for `auto` when the OS asks for less motion.
    const nativeScroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function scrollIntoView(options) {
        state.scrolls.push(options && typeof options === 'object' ? options.behavior : 'undefined');
        return nativeScroll.call(this, options);
    };
}

// ── app shell / reader API stubs ───────────────────────────────────────────
const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

async function mockApi(context) {
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
            return respond({ user: { id: 'u-audio', email: 'audio@example.com' }, isAdmin: false, guest: false });
        }
        if (path === '/api/history' || path === '/api/subscriptions') return respond([]);
        if (path === '/api/shows') return respond({ shows: [] });
        if (path === '/api/favorites' && method === 'GET') return respond([]);
        if (path === '/api/models') {
            return respond({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }], default: 'deepseek-chat' });
        }
        if (path === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
        if (path === '/api/placement/profile') return respond({ profile: null, preliminary: true, sampleSize: 0, disclaimer: '' });
        if (path === '/api/review/stats') {
            return respond({
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-17', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (path === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
        if (path === '/api/content/difficulty/batch') return respond({ items: [] });
        if (path === '/api/vocabulary/classify') {
            const body = request.postDataJSON() || {};
            // A1 = below the B1 threshold, so the difficulty layer paints
            // nothing and the active-sentence highlight stays readable in the
            // screenshots (the layer itself is exercised by its own check).
            return respond({ items: (body.items || []).map((item) => ({ text: item.text, level: 'A1', proper: false })) });
        }
        if (path === '/api/review/words') return respond({ words: [], total: 0 });
        if (path === '/api/define') {
            const body = request.postDataJSON() || {};
            return respond({
                word: body.word || 'quiet', ipa: '/ˈkwaɪət/', pos: 'adj.',
                zh: '安静的；平静的', definition_en: 'making very little noise',
                example: 'A quiet morning begins with a cup of tea.',
            });
        }
        if (path === '/api/library/articles/lib1') return respond(LIBRARY_ARTICLE);
        if (path === '/api/books/imported/ib1') return respond(IMPORTED_BOOK);
        if (path === '/api/books/imported/ib1/chapters/1') return respond(IMPORTED_CHAPTER);
        if (path === '/api/sentences/levels') return respond(SENTENCE_LEVELS);
        if (path === '/api/sentences/level/1') return respond(SENTENCE_LEVEL);
        if (path === '/api/books/b1') return respond(BOOK);
        if (path === '/api/books/b1/chapters/1') return respond(bookChapter(1));
        if (path === '/api/books/b1/chapters/2') return respond(bookChapter(2));
        if (path === '/api/books/b1/progress' && method === 'PUT') return respond({ ok: true });
        if (path === '/api/articles' && method === 'GET') return respond({ articles: [ARTICLE_SUMMARY] });
        if (path === '/api/article/art1') return respond(ARTICLE_DETAIL);
        if (path.match(/^\/api\/article\/art1\/(progress|translate)$/)) return respond({ ok: true, status: 'done' });
        if (path.startsWith('/api/')) return respond({});
        return route.fulfill({ status: 404, headers: CORS, body: '{}' });
    });
}

async function newPage(browser, { englishVoices = true, reducedMotion = 'no-preference' } = {}) {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        reducedMotion,
    });
    await context.addInitScript(installSpeechStub, { englishVoices });
    await context.addInitScript(() => {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
        // Only the first document of the context starts from defaults: a reload
        // must be able to observe the persisted rate/mode.
        if (!sessionStorage.getItem('__reading_audio_test_boot')) {
            sessionStorage.setItem('__reading_audio_test_boot', '1');
            localStorage.removeItem('yt_bilingual_reading_audio_rate');
            localStorage.removeItem('yt_bilingual_reading_audio_mode');
        }
    });
    await mockApi(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(String(error)));
    return { context, page, errors };
}

async function gotoHash(page, hash) {
    await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 20000 });
    await sleep(200);
}

const ttsState = (page) => page.evaluate(() => ({
    current: window.__tts.current ? window.__tts.current.text : null,
    cancels: window.__tts.cancels,
    log: window.__tts.log.map((entry) => ({ ...entry })),
    scrolls: [...window.__tts.scrolls],
}));

const finished = (page, error) => page.evaluate((err) => window.__ttsFinish(err), error);

const activeSentence = (page) => page.evaluate(() => {
    const node = document.querySelector('[data-audio-sentence][data-audio-active="1"]');
    if (!node) return null;
    // Ruby annotations are rendered inside the sentence; reading the base text
    // means stripping the <rt> glosses first.
    const clone = node.cloneNode(true);
    clone.querySelectorAll('rt').forEach((rt) => rt.remove());
    const paragraph = node.closest('[data-testid^="book-en-"]') || node.closest('[data-testid^="reader-en-"]');
    return { text: clone.textContent, paragraph: paragraph?.dataset?.testid ?? null };
});

const barState = (page) => page.locator('[data-reading-audio-bar]').getAttribute('data-state');

async function run() {
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    const results = [];
    const log = (line) => {
        results.push(line);
        console.log(line);
    };

    // ── 0. splitter unit checks (through the dev server's TS transform) ────
    {
        const { context, page, errors } = await newPage(browser);
        await gotoHash(page, '/content/book/b1');
        const split = await page.evaluate(async () => {
            const module = await import('/src/lib/sentenceSplit.ts');
            const cases = {
                abbreviations: module.splitSentences('Mr. Smith met Dr. Jones at the U.S. Army base, e.g. in Texas. They talked.').map((s) => s.text),
                quotes: module.splitSentences('"Go home," she said. He left.').map((s) => s.text),
                ellipsis: module.splitSentences('He waited... Then the lamp went out. Nobody moved.').map((s) => s.text),
                initials: module.splitSentences('J. K. Rowling wrote it. It sold well.').map((s) => s.text),
                decimals: module.splitSentences('It cost 3.50 today. Tomorrow it will change.').map((s) => s.text),
                offsets: module.splitSentences('A. B')
                    .map((s) => 'A. B'.slice(s.start, s.end) === s.text),
            };
            return cases;
        });
        assert.deepEqual(split.abbreviations, [
            'Mr. Smith met Dr. Jones at the U.S. Army base, e.g. in Texas.',
            'They talked.',
        ]);
        assert.deepEqual(split.quotes, ['"Go home," she said.', 'He left.']);
        assert.deepEqual(split.ellipsis, ['He waited...', 'Then the lamp went out.', 'Nobody moved.']);
        assert.deepEqual(split.initials, ['J. K. Rowling wrote it.', 'It sold well.']);
        assert.deepEqual(split.decimals, ['It cost 3.50 today.', 'Tomorrow it will change.']);
        assert.deepEqual(split.offsets, [true]);
        log(`PASS splitter: abbreviations/quotes/ellipsis/initials/decimals (${split.abbreviations.length}+ spans)`);
        assert.deepEqual(errors, []);
        await context.close();
    }

    // ── 1. public-domain book: continuous, shadow, rate, keyboard ──────────
    const { context, page, errors } = await newPage(browser);
    await gotoHash(page, '/content/book/b1');
    await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 20000 });

    const wordsBefore = await page.locator('[data-testid=book-en-0] [data-word-hit]').count();
    await page.locator('[data-testid=book-audio-trigger]').click();
    await page.locator('[data-testid=book-audio-bar]').waitFor({ state: 'visible', timeout: 8000 });
    assert.equal(await barState(page), 'idle', 'bar opens idle');
    assert.match(await page.locator('[data-testid=book-audio-status]').innerText(), /第 1 段 · 第 1 句/);
    const wordsAfter = await page.locator('[data-testid=book-en-0] [data-word-hit]').count();
    assert.equal(wordsAfter, wordsBefore, 'opening the bar must not change the word DOM');
    assert.equal(await page.locator('[data-testid=book-en-0] ruby[data-language-point]').count() > 0, true, 'language-point ruby still renders');
    const first = await activeSentence(page);
    assert.match(first.text, /Mr\. Smith met Dr\. Jones/, `first sentence highlighted, got ${first.text}`);
    // Splitting into sentences must not change a single character of the
    // paragraph (same text, same order — only inline wrappers are added).
    const renderedParagraph = await page.evaluate(() => {
        const node = document.querySelector('[data-testid=book-en-0]');
        const clone = node.cloneNode(true);
        clone.querySelectorAll('rt').forEach((rt) => rt.remove());
        return clone.textContent;
    });
    assert.equal(renderedParagraph, BOOK_SENTENCES[0].join(' '), 'paragraph text/order must be untouched by the sentence wrappers');
    log(`PASS book: trigger opens bar, first sentence highlighted, ${wordsAfter} word hits + ruby intact`);

    // Continuous: play, then let the engine finish; it must advance by itself.
    await page.locator('[data-testid=book-audio-toggle]').click();
    await sleep(80);
    let state = await ttsState(page);
    assert.equal(await barState(page), 'playing');
    assert.match(state.log.at(-1).text, /Mr\. Smith met Dr\. Jones/);
    assert.equal(state.log.at(-1).rate, 1);
    assert.equal(state.log.at(-1).lang, 'en-US');
    assert.equal(state.log.at(-1).kind, 'speak');

    await finished(page);
    await sleep(80);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /They talked for an hour/, 'continuous advances automatically');
    const second = await activeSentence(page);
    assert.match(second.text, /They talked for an hour/, 'highlight follows the spoken sentence');
    assert.equal(second.paragraph, 'book-en-0');

    // … and across the paragraph boundary.
    await finished(page);
    await sleep(120);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /"Go home," she said quietly/, 'continuous crosses into the next paragraph');
    const third = await activeSentence(page);
    assert.equal(third.paragraph, 'book-en-1');
    assert.match(await page.locator('[data-testid=book-audio-status]').innerText(), /第 2 段 · 第 1 句/);
    // The bar reserves space at the bottom of the reading pane.
    const padding = await page.evaluate(() => {
        const container = document.querySelector('[data-testid=book-reader-scroll] > div');
        return container ? Number.parseFloat(getComputedStyle(container).paddingBottom) : 0;
    });
    assert.ok(padding > 40, `reading pane should reserve bottom padding for the bar, got ${padding}`);
    log(`PASS book continuous: auto-next sentence, cross-paragraph, highlight + status + ${padding}px bottom inset`);

    // Stale `onend` after cancel must not advance twice: switching the rate
    // cancels (the mock fires the cancelled utterance's onend) and re-reads the
    // same sentence.
    const beforeRate = (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').length;
    await page.locator('[data-testid=book-audio-rate]').click();
    await page.locator('[data-testid="book-audio-rate-1.5"]').click();
    await sleep(200); // let the stale onend from cancel() land
    state = await ttsState(page);
    const speaksAfterRate = state.log.filter((entry) => entry.kind === 'speak');
    assert.equal(speaksAfterRate.length, beforeRate + 1, 'rate change must speak exactly once (no cancel/onend double-advance)');
    assert.equal(speaksAfterRate.at(-1).rate, 1.5, 'new rate applies to the current sentence');
    assert.match(speaksAfterRate.at(-1).text, /"Go home," she said quietly/, 'rate change re-reads the SAME sentence');
    assert.equal((await page.locator('[data-testid=book-audio-rate]').innerText()).trim(), '1.5×');
    const storedRate = await page.evaluate(() => localStorage.getItem('yt_bilingual_reading_audio_rate'));
    assert.equal(storedRate, '1.5', 'rate is remembered');
    log('PASS rate: current sentence re-read at 1.5×, stale cancel-onend ignored, localStorage persisted');

    // Shadow mode: one sentence, then a wait with 再听一遍 / 下一句.
    await page.locator('[data-testid=book-audio-mode]').click();
    assert.equal(await page.locator('[data-testid=book-audio-bar]').getAttribute('data-mode'), 'shadow');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_reading_audio_mode')), 'shadow');
    const speaksBeforeShadowEnd = (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').length;
    await finished(page);
    await sleep(120);
    assert.equal(await barState(page), 'waiting', 'shadow mode pauses after one sentence');
    const speaksInWait = (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').length;
    assert.equal(speaksInWait, speaksBeforeShadowEnd, 'shadow mode must not auto-advance');
    await page.locator('[data-testid=book-audio-waiting-actions]').waitFor({ state: 'visible' });
    const waitText = await activeSentence(page);
    await page.locator('[data-testid=book-audio-next-hint]').click();
    await sleep(120);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /He left without a word/, '跟读「下一句」speaks the next sentence');
    assert.equal(await barState(page), 'playing');
    await finished(page);
    await sleep(120);
    assert.equal(await barState(page), 'waiting');
    const replaySubject = (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').at(-1).text;
    await page.locator('[data-testid=book-audio-replay]').click();
    await sleep(120);
    state = await ttsState(page);
    assert.equal(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, replaySubject, '跟读「再听一遍」repeats the same sentence');
    assert.equal(waitText.text, '"Go home," she said quietly.', 'the shadow unit is the sentence that just ended');
    log('PASS shadow: one sentence then waiting state, 下一句 / 再听一遍 both work, no auto-advance');

    // Keyboard: Space toggles, ← / → move; a text field keeps its keys.
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await sleep(120);
    assert.equal(await barState(page), 'paused', 'Space pauses');
    await page.keyboard.press('Space');
    await sleep(120);
    assert.equal(await barState(page), 'playing', 'Space resumes');
    const cancelCount = (await ttsState(page)).cancels;
    await page.keyboard.press('ArrowRight');
    await sleep(120);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /Then the lamp went out/, '→ moves to the next sentence');
    await page.keyboard.press('ArrowLeft');
    await sleep(120);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /He left without a word/, '← moves back');
    assert.ok((await ttsState(page)).cancels > cancelCount);
    await page.evaluate(() => {
        const input = document.createElement('input');
        input.id = 'audio-keyboard-guard';
        document.body.appendChild(input);
        input.focus();
    });
    const beforeFieldSpace = (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').length;
    await page.keyboard.press('Space');
    await sleep(120);
    assert.equal(
        (await ttsState(page)).log.filter((entry) => entry.kind === 'speak').length,
        beforeFieldSpace,
        'Space inside a text field must not start playback',
    );
    await page.evaluate(() => document.getElementById('audio-keyboard-guard')?.remove());
    log('PASS keyboard: Space pause/play, ←/→ previous/next, text field keeps Space');

    // Screenshots (bar open, active sentence highlighted).
    await page.keyboard.press('Space'); // resume
    await sleep(400);
    await page.screenshot({ path: `${SHOTS}/reading-audio-book-1440.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    await page.screenshot({ path: `${SHOTS}/reading-audio-book-375.png` });
    const overflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(overflow.doc <= overflow.inner + 1, `375px must not scroll horizontally: ${JSON.stringify(overflow)}`);
    const barBox = await page.locator('[data-testid=book-audio-bar] > div').boundingBox();
    assert.ok(barBox.width <= 375, `bar must fit 375px, got ${barBox.width}`);
    log(`PASS 375: no horizontal overflow, bar width ${Math.round(barBox.width)}px; screenshots written`);

    // Chapter switch stops the voice immediately.
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('[data-testid=book-next-chapter]').click();
    await page.waitForFunction(
        () => document.querySelector('[data-testid=book-en-0]')?.textContent?.includes('Chapter two begins here'),
        undefined,
        { timeout: 20000 },
    );
    await sleep(200);
    state = await ttsState(page);
    assert.equal(state.current, null, 'chapter switch must cancel the utterance');
    assert.equal(await barState(page), 'idle', 'chapter switch resets the bar to idle');
    assert.equal(await page.locator('[data-audio-sentence][data-audio-active="1"]').count(), 0, 'no highlight left after the switch');
    log('PASS chapter switch: voice cancelled, bar idle, highlight cleared');

    // Close stops everything and hides the bar.
    await page.locator('[data-testid=book-audio-toggle]').click();
    await sleep(80);
    assert.notEqual((await ttsState(page)).current, null);
    await page.locator('[data-testid=book-audio-close]').click();
    await page.locator('[data-testid=book-audio-bar]').waitFor({ state: 'hidden' });
    assert.equal((await ttsState(page)).current, null, 'closing the bar cancels the utterance');
    log('PASS close: bar hidden + speech cancelled');

    // Rate and mode survive a reload (specs/037 §1.3); the position does not.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-testid=book-audio-trigger]').click();
    const reopened = page.locator('[data-testid=book-audio-bar]');
    await reopened.waitFor({ state: 'visible' });
    assert.equal(await reopened.getAttribute('data-rate'), '1.5', 'rate survives a reload');
    assert.equal(await reopened.getAttribute('data-mode'), 'shadow', 'mode survives a reload');
    assert.equal((await page.locator('[data-testid=book-audio-rate]').innerText()).trim(), '1.5×');
    assert.equal(await barState(page), 'idle', 'a reload must not auto-play');
    log('PASS reload: rate 1.5× + shadow mode restored from localStorage, playback stays idle');
    await page.locator('[data-testid=book-audio-close]').click();
    await reopened.waitFor({ state: 'hidden' });

    // Word lookup still works with the audio bar open (ruby + click).
    await page.locator('[data-testid=book-audio-trigger]').click();
    await page.locator('[data-testid=book-audio-bar]').waitFor({ state: 'visible' });
    await page.locator('[data-testid=book-en-0] [data-word-hit]').first().click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 8000 });
    await page.getByText('安静的；平静的').first().waitFor({ state: 'visible', timeout: 8000 });
    log('PASS word lookup: click still opens the dictionary card while the bar is open');
    await page.keyboard.press('Escape').catch(() => {});
    assert.deepEqual(errors, []);

    // ── 2. article reader: sentence highlight + ruby coexistence ───────────
    await gotoHash(page, '/content/reader/art1');
    await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-testid=reader-audio-trigger]').click();
    await page.locator('[data-testid=reader-audio-bar]').waitFor({ state: 'visible' });
    await page.locator('[data-testid=reader-audio-toggle]').click();
    await sleep(120);
    state = await ttsState(page);
    assert.match(state.log.filter((entry) => entry.kind === 'speak').at(-1).text, /The quiet power of small habits/);
    assert.match((await activeSentence(page)).text, /The quiet power of small habits/);
    const ruby = await page.locator('[data-testid=reader-en-1] ruby[data-language-point]').count();
    assert.ok(ruby > 0, 'article language-point ruby renders under the audio wrapper');
    await sleep(400);
    await page.screenshot({ path: `${SHOTS}/reading-audio-article-1440.png` });
    await page.setViewportSize({ width: 375, height: 812 });
    await sleep(300);
    await page.screenshot({ path: `${SHOTS}/reading-audio-article-375.png` });
    const articleOverflow = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(articleOverflow.doc <= articleOverflow.inner + 1, `article 375 overflow: ${JSON.stringify(articleOverflow)}`);
    await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur());
    await page.keyboard.press('Space');
    await sleep(100);
    assert.equal(await barState(page), 'paused');
    log('PASS article reader: continuous reading, active sentence highlight, language-point ruby intact, 375 clean');
    await context.close();

    // ── 3. reduced motion: programmatic scroll asks for `auto` ─────────────
    {
        const reduced = await newPage(browser, { reducedMotion: 'reduce' });
        await gotoHash(reduced.page, '/content/book/b1');
        await reduced.page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 20000 });
        await reduced.page.locator('[data-testid=book-audio-trigger]').click();
        await reduced.page.locator('[data-testid=book-audio-toggle]').click();
        await finished(reduced.page);
        await sleep(250);
        const scrolls = (await ttsState(reduced.page)).scrolls;
        assert.ok(scrolls.length > 0, 'active sentence change should scroll it into view');
        assert.ok(scrolls.every((behavior) => behavior === 'auto'), `reduced motion must use auto scroll, got ${JSON.stringify(scrolls)}`);
        log(`PASS reduced motion: ${scrolls.length} scrollIntoView calls all use behavior "auto"`);
        await reduced.context.close();
    }

    // ── 4. no English voice: bar disabled + explicit message ───────────────
    {
        const missing = await newPage(browser, { englishVoices: false });
        await gotoHash(missing.page, '/content/book/b1');
        await missing.page.locator('[data-testid=book-en-0]').waitFor({ state: 'visible', timeout: 20000 });
        await missing.page.locator('[data-testid=book-audio-trigger]').click();
        await missing.page.locator('[data-testid=book-audio-bar]').waitFor({ state: 'visible' });
        assert.equal(await barState(missing.page), 'unsupported');
        const message = await missing.page.locator('[data-testid=book-audio-status]').innerText();
        assert.match(message, /没有可用的英文语音/, `explicit message expected, got ${message}`);
        assert.equal(await missing.page.locator('[data-testid=book-audio-toggle]').isDisabled(), true, 'play must be disabled');
        assert.equal(await missing.page.locator('[data-testid=book-audio-mode]').isDisabled(), true, 'shadow switch must be disabled');
        assert.equal((await ttsState(missing.page)).log.filter((entry) => entry.kind === 'speak').length, 0, 'nothing is spoken');
        await missing.page.setViewportSize({ width: 375, height: 812 });
        await sleep(200);
        await missing.page.screenshot({ path: `${SHOTS}/reading-audio-unsupported-375.png` });
        log('PASS no-English-voice: bar disabled, explicit message, nothing spoken silently');
        await missing.context.close();
    }


    // ── 5. remaining surfaces: library article / imported book / sentence pack
    {
        const extra = await newPage(browser);
        const { page: p2 } = extra;
        const checkSurface = async (hash, readerTestId, triggerTestId, prefix, firstText) => {
            await gotoHash(p2, hash);
            await p2.locator(`[data-testid=${readerTestId}]`).waitFor({ state: 'visible', timeout: 20000 });
            await p2.locator(`[data-testid=${triggerTestId}]`).click();
            await p2.locator(`[data-testid=${prefix}-bar]`).waitFor({ state: 'visible', timeout: 8000 });
            await p2.locator(`[data-testid=${prefix}-toggle]`).click();
            await sleep(150);
            const state = await ttsState(p2);
            const last = state.log.filter((entry) => entry.kind === 'speak').at(-1);
            assert.ok(last && firstText.test(last.text), `${prefix}: expected a speak of ${firstText}, got ${last && last.text}`);
            assert.equal(await barState(p2), 'playing');
            await finished(p2);
            await sleep(150);
            const after = (await ttsState(p2)).log.filter((entry) => entry.kind === 'speak').at(-1);
            assert.notEqual(after.text, last.text, `${prefix}: continuous mode must advance`);
            await p2.locator(`[data-testid=${prefix}-close]`).click();
            await p2.locator(`[data-testid=${prefix}-bar]`).waitFor({ state: 'hidden' });
            log(`PASS ${prefix}: bar + continuous advance + close on ${hash}`);
        };

        await checkSurface('/learn/library/lib1', 'library-reader', 'library-audio-trigger', 'library-audio', /The kettle sings/);
        await checkSurface('/content/imported-book/ib1', 'imported-book-reader', 'imported-book-audio-trigger', 'imported-book-audio', /Alice was beginning/);
        await checkSurface('/content/sentences/1', 'sentences-toolbar', 'sentences-audio-trigger', 'sentences-audio', /A short walk helps/);
        // Sentence packs keep their own per-row speaker button (specs/037 §5).
        const rowSpeakers = await p2.locator('button[title="朗读"]').count();
        assert.ok(rowSpeakers > 0, 'the sentence-pack per-row speaker button must be kept (specs/037 §5)');
        assert.deepEqual(extra.errors, []);
        await extra.context.close();
    }

    await browser.close();
    console.log('\nALL PASS');
    console.log(`SHOTS: ${SHOTS}/reading-audio-*.png`);
}

run().catch((error) => {
    console.error('FAILED:', error);
    process.exit(1);
});
