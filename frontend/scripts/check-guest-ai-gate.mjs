#!/usr/bin/env node
// Browser acceptance for M7b — "guests can never trigger AI; every AI entry
// signs in first".
//
// Runs the real React UI in Chromium against a fully stubbed backend (M7a's
// 403 `{code:"login_required"}` contract is served by the stubs). Verified:
//   a) guest "start learning" on the content page → login overlay, and never
//      `/api/estimate-cost` or `/api/process-video-stream`;
//   b) guest word lookup → login overlay, never `/api/define`;
//   c) guest local-video AI button → login overlay, never
//      `/api/local-video/process`;
//   d) guest public-domain "translate chapter" → login overlay, never the
//      translate endpoint (and no automatic translation on chapter open);
//   e) those same entries still work for a signed-in user (estimate modal,
//      dictionary popover) — the gate is guest-only;
//   f) a signed-in 403 `login_required` (session anomaly) shows readable copy,
//      never signs out and never falls through to processing;
//   g) `model_unpriced` → "contact admin" copy, `quota_exceeded` → quota copy;
//   h) guest still reads public text (library article / public-domain book) —
//      the gate does not hide non-AI content;
//   i) 375 / 1440 in zh-CN / vi-VN: no page-level horizontal overflow, and the
//      existing full-screen login overlay stays inside the viewport.
//
// Screenshots: /tmp/guest-ai-gate-shots/
// Run: APP_URL=http://127.0.0.1:5173 npm run check:guest-ai
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
const SHOTS = '/tmp/guest-ai-gate-shots';
mkdirSync(SHOTS, { recursive: true });

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=guest-ai-gate-e2e';
const LIBRARY_ARTICLE_ID = 'ocean-noise-e2e';
const BOOK_ID = 'alice-e2e';
const USER = {
    id: 'user-e2e',
    email: 'learner@example.test',
    username: 'learner-e2e',
    credits: 12,
    status: 'active',
};

const CACHED_VIDEO = {
    filename: 'cached-e2e.json',
    videoId: 'cached-e2e',
    metadata: { title: 'Cached video', channel: 'Cached channel', is_local_subtitle: false },
    model: 'e2e-model',
    modelName: 'E2E Model',
    studyCount: 1,
    updatedAt: Date.now(),
    mtime: null,
};

const CACHED_PAYLOAD = {
    videoId: 'cached-e2e',
    metadata: { title: 'Cached video', channel: 'Cached channel' },
    summary: 'A cached bilingual summary.',
    transcript: [
        {
            id: 0,
            start: 0,
            end: 3,
            en_text: 'Cached English subtitle.',
            zh_text: '缓存的中文字幕。',
            highlights: [],
        },
    ],
};

const SRT = [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    'The ocean is deep and quiet.',
    '',
    '2',
    '00:00:02,000 --> 00:00:04,000',
    'A boat drifts on the water.',
    '',
].join('\n');

const LIBRARY_ARTICLE = {
    id: LIBRARY_ARTICLE_ID,
    title: 'Ocean Noise',
    level: 'B1',
    wordCount: 6,
    author: 'LinguaTrek',
    license: 'CC BY 4.0',
    source: 'original',
    paragraphs: [
        { en: 'The ocean is deep and quiet.', zh: '海洋深邃而安静。' },
    ],
};

function bookSummary() {
    return {
        id: BOOK_ID,
        seriesId: 'series-e2e',
        title: 'Alice in Wonderland',
        titleZh: '爱丽丝梦游仙境',
        author: 'Lewis Carroll',
        year: 1865,
        level: 'B1',
        status: 'available',
        source: 'gutenberg',
        license: 'Public domain',
        sourceUrl: 'https://www.gutenberg.org/ebooks/11',
        totalChapters: 1,
        readableChapters: 1,
        translatedChapters: 0,
        publicDomainBasis: 'Published in 1865; public domain worldwide.',
    };
}

function bookDetail() {
    const summary = bookSummary();
    return {
        ...summary,
        series: {
            id: 'series-e2e',
            title: 'Children Classics',
            author: 'Various',
            description: 'Public-domain children classics.',
            totalBooks: 1,
            availableBooks: 1,
            readableChapters: 1,
            translatedChapters: 0,
            excluded: [],
            books: [summary],
        },
        chapters: [{ n: 1, title: 'Down the Rabbit-Hole', titleZh: null, translated: false }],
    };
}

function bookChapter() {
    return {
        bookId: BOOK_ID,
        bookTitle: 'Alice in Wonderland',
        bookTitleZh: '爱丽丝梦游仙境',
        author: 'Lewis Carroll',
        level: 'B1',
        license: 'Public domain',
        chapter: 1,
        chapterTitle: 'Down the Rabbit-Hole',
        sourceTitle: 'Alice in Wonderland',
        totalChapters: 1,
        importedChapters: 0,
        seriesId: 'series-e2e',
        seriesTitle: 'Children Classics',
        translationStatus: 'missing',
        source: {
            provider: 'gutenberg',
            url: 'https://www.gutenberg.org/ebooks/11',
            fetchedAt: new Date().toISOString(),
            degraded: false,
        },
        paragraphs: [{ index: 0, en: 'The sea was calm.', zh: null }],
        missingTranslations: 1,
        translated: false,
        translatedChapters: 0,
        languagePoints: [],
        analysisLevel: null,
    };
}

function estimation() {
    return {
        videoId: 'guest-ai-gate-e2e',
        metadata: { title: 'e2e video', channel: 'e2e channel', thumbnail: null },
        transcriptStats: { wordCount: 10, estimatedInputTokens: 10, estimatedOutputTokens: 10 },
        models: [
            {
                id: 'e2e-model',
                name: 'E2E Model',
                provider: 'Test',
                available: true,
                quotaInfo: 'e2e',
                estimatedCost: 0.001,
            },
        ],
    };
}

const failures = [];
let checks = 0;

async function check(name, fn) {
    checks += 1;
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (error) {
        failures.push(`${name}: ${error.message}`);
        console.error(`ERR  ${name}: ${error.message}`);
    }
}

async function launchBrowser() {
    try {
        return await chromium.launch({ headless: true });
    } catch (error) {
        if (!CHROME_FALLBACK) {
            throw new Error(
                'Playwright Chromium is not installed and no system Chrome found. '
                + `Set PLAYWRIGHT_CHROMIUM_EXECUTABLE. (${error.message.split('\n')[0]})`,
            );
        }
        return chromium.launch({ headless: true, executablePath: CHROME_FALLBACK });
    }
}

function json(route, body, status = 200, extraHeaders = {}) {
    const origin = route.request().headers().origin || BASE;
    return route.fulfill({
        status,
        contentType: 'application/json',
        headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'cache-control': 'no-store',
            ...extraHeaders,
        },
        body: JSON.stringify(body),
    });
}

/** AI paths this gate promises will never be requested by a guest. */
function isAiPath(path) {
    return (
        path === '/api/estimate-cost'
        || path === '/api/process-video'
        || path === '/api/process-video-stream'
        || path === '/api/process-subtitle'
        || path === '/api/define'
        || path === '/api/local-video/process'
        || path === '/api/article/import'
        || path === '/api/discover'
        || path.startsWith('/api/lesson/')
        || path === '/api/course/generate'
        || path.startsWith('/api/teaching-analysis')
        || /^\/api\/books\/[^/]+\/chapters\/[^/]+\/translate$/.test(path)
        || /^\/api\/books\/imported\/[^/]+\/chapters\/[^/]+\/translate$/.test(path)
        || /^\/api\/articles\/[^/]+\/translate$/.test(path)
    );
}

/**
 * Install the API double. `user: null` = guest (`/api/auth/me` → `{guest:true}`).
 * `processStatus` / `estimateStatus` force a stable M7a/M3b error on that call.
 */
async function installStubs(context, options = {}) {
    const state = {
        user: options.user ?? null,
        aiRequests: [],
        estimateCalls: 0,
        processCalls: 0,
        defineCalls: 0,
        localVideoCalls: 0,
        processSubtitleCalls: 0,
        bookTranslateCalls: 0,
        logoutCalls: 0,
        estimateStatus: options.estimateStatus ?? 200,
        processStatus: options.processStatus ?? 200,
    };

    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();

        if (method === 'OPTIONS') {
            const origin = request.headers().origin || BASE;
            return route.fulfill({
                status: 204,
                headers: {
                    'access-control-allow-origin': origin,
                    'access-control-allow-credentials': 'true',
                    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
                    'access-control-allow-headers': 'content-type,x-api-key',
                },
            });
        }

        if (isAiPath(path)) state.aiRequests.push(`${method} ${path}`);

        // ── session ──────────────────────────────────────────────────────
        if (path === '/api/auth/me') {
            return json(route, state.user ? { user: state.user, isAdmin: false } : { guest: true });
        }
        if (path === '/api/auth/registration') {
            return json(route, {
                registrationOpen: false,
                inviteSignupEnabled: true,
                inviteRequired: true,
                registrationClosed: false,
            });
        }
        if (path === '/api/auth/logout') {
            state.logoutCalls += 1;
            return json(route, { ok: true });
        }

        // ── AI entry points under test ───────────────────────────────────
        if (path === '/api/estimate-cost') {
            state.estimateCalls += 1;
            if (state.estimateStatus !== 200) {
                return json(route, {
                    code: state.estimateStatus === 403 ? 'login_required' : 'error',
                    detail: '需要登录才能继续。',
                }, state.estimateStatus);
            }
            return json(route, estimation());
        }
        if (path === '/api/process-video-stream' || path === '/api/process-video') {
            state.processCalls += 1;
            if (state.processStatus === 503) {
                return json(route, {
                    code: 'model_unpriced',
                    detail: 'model unpriced',
                }, 503);
            }
            if (state.processStatus === 429) {
                return json(route, { code: 'quota_exceeded', detail: 'quota exceeded' }, 429);
            }
            if (state.processStatus === 403) {
                return json(route, { code: 'login_required', detail: 'login required' }, 403);
            }
            return json(route, { ok: true });
        }
        if (path === '/api/define') {
            state.defineCalls += 1;
            return json(route, {
                word: 'ocean',
                lemma: 'ocean',
                ipa: '/ˈoʊʃən/',
                pos: 'n.',
                zh: '海洋',
            });
        }
        if (path === '/api/local-video/process') {
            state.localVideoCalls += 1;
            return json(route, {
                code: 'login_required',
                detail: 'login required',
            }, 403);
        }
        if (path === '/api/process-subtitle') {
            state.processSubtitleCalls += 1;
            return json(route, { code: 'login_required', detail: 'login required' }, 403);
        }

        // ── public-domain books ─────────────────────────────────────────
        const bookChapterMatch = path.match(/^\/api\/books\/([^/]+)\/chapters\/(\d+)(\/translate)?$/);
        if (bookChapterMatch) {
            const isTranslate = Boolean(bookChapterMatch[3]);
            if (isTranslate) {
                state.bookTranslateCalls += 1;
                return json(route, { code: 'login_required', detail: 'login required' }, 403);
            }
            return json(route, bookChapter());
        }
        if (path === `/api/books/${BOOK_ID}`) return json(route, bookDetail());
        if (path === '/api/books') {
            return json(route, {
                series: [],
                counts: {
                    series: 0,
                    books: 0,
                    availableBooks: 0,
                    readableChapters: 0,
                    translatedChapters: 0,
                },
            });
        }

        // ── free library ────────────────────────────────────────────────
        if (path === `/api/library/videos/${LIBRARY_ARTICLE_ID}`) {
            return json(route, { detail: 'not a video' }, 404);
        }
        if (path === `/api/library/articles/${LIBRARY_ARTICLE_ID}`) {
            return json(route, LIBRARY_ARTICLE);
        }
        if (path === '/api/library') {
            return json(route, {
                videos: [],
                articles: [{ id: LIBRARY_ARTICLE_ID, title: 'Ocean Noise', level: 'B1', wordCount: 6 }],
                counts: { videos: 0, articles: 1 },
            });
        }

        // ── app-shell dependencies (non-AI) ─────────────────────────────
        if (path === '/api/subscriptions') {
            return json(route, method === 'PUT' ? { ok: true } : []);
        }
        if (path === '/api/favorites') return json(route, []);
        if (path === '/api/history') {
            return json(route, method === 'DELETE' ? { ok: true } : [CACHED_VIDEO]);
        }
        if (path === `/api/history/${CACHED_VIDEO.filename}`) {
            return json(route, CACHED_PAYLOAD);
        }
        if (path.startsWith('/api/history/')) {
            // No cached local episode in this stub: the guest path must stop at
            // the login prompt instead of falling into /api/process-subtitle.
            return json(route, { detail: 'History file not found' }, 404);
        }
        if (path === '/api/report/week') {
            return json(route, {
                numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null },
            });
        }
        if (path === '/api/models') return json(route, { models: [], default: null });
        if (path === '/api/review/stats') {
            return json(route, { dueNow: 0, dueToday: 0, newWords: 0, reviewedToday: 0 });
        }
        if (path === '/api/placement/profile') return json(route, { profile: null });
        if (path === '/api/recommendations') {
            return json(route, { items: [], basis: { band: 'A2', source: 'default' }, preliminary: false });
        }
        if (path === '/api/shows') {
            return json(route, {
                shows: [{
                    id: 'show-e2e',
                    title: 'E2E Show',
                    title_zh: 'E2E 剧集',
                    thumbnail: '',
                    seasons_available: { 1: 1 },
                    total_episodes: 1,
                }],
            });
        }
        if (path === '/api/shows/show-e2e/seasons') {
            return json(route, { seasons: [{ season: 1, episode_count: 1, episodes: [1] }] });
        }
        if (path === '/api/shows/show-e2e/processed') return json(route, { processed: [] });
        if (path === '/api/sentences/levels') return json(route, []);
        if (path === '/api/blog/posts') return json(route, { posts: [], count: 0 });
        if (path === '/api/channel-updates') return json(route, { updates: [] });
        if (path === '/api/events') return json(route, { ok: true });
        if (path === '/api/announcement') return json(route, { announcement: null });

        return json(route, {});
    });

    return state;
}

async function newContext(browser, options = {}) {
    const context = await browser.newContext({
        viewport: options.viewport || { width: 1440, height: 900 },
        locale: 'zh-CN',
    });
    const language = options.language || 'zh-CN';
    await context.addInitScript((lang) => {
        try {
            localStorage.setItem('yt_bilingual_ui_lang', lang);
        } catch {
            // Storage can be unavailable before navigation; the default is fine.
        }
    }, language);
    const state = await installStubs(context, options);
    return { context, state };
}

async function openContent(page) {
    await page.goto(`${BASE}/#/app/content`);
    await page.locator('[data-testid="content-screen"]').waitFor({ timeout: 20000 });
}

async function waitForGuestLogin(page) {
    await page.locator('[data-testid="guest-auth-overlay"]').waitFor({ timeout: 8000 });
}

async function assertNoOverflow(page, label) {
    const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    assert.ok(overflow <= 1, `${label}: page-level horizontal overflow ${overflow}px`);
}

async function submitContentUrl(page) {
    await openContent(page);
    const input = page.locator('[data-testid="video-url-input"]').first();
    await input.waitFor({ timeout: 15000 });
    await input.fill(YOUTUBE_URL);
    await page.locator('[data-testid="start-submit"]').first().click();
}

async function openLibraryArticle(page) {
    await page.goto(`${BASE}/#/app/content/learn/library/${LIBRARY_ARTICLE_ID}`);
    await page.locator('[data-testid="library-en-0"]').waitFor({ timeout: 20000 });
}

async function checkDictionaryForGuest(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await openLibraryArticle(page);
    // The public text is readable; only the AI lookup is gated.
    assert.match(await page.locator('[data-testid="library-en-0"]').innerText(), /ocean/i);
    await page.locator('[data-testid="library-en-0"] [data-word-hit]').first().click();
    await waitForGuestLogin(page);
    assert.equal(state.defineCalls, 0, 'guest word lookup must not call /api/define');
    assert.equal(await page.locator('[data-testid="word-popover"]').count(), 0);
    await page.screenshot({ path: `${SHOTS}/guest-word-login.png` });
    await context.close();
}

async function checkLocalVideoForGuest(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await openContent(page);
    await page.locator('[data-testid="local-video-input"]').setInputFiles([
        {
            name: 'episode.mp4',
            mimeType: 'video/mp4',
            buffer: Buffer.from('e2e-not-a-real-video'),
        },
        {
            name: 'episode.srt',
            mimeType: 'application/x-subrip',
            buffer: Buffer.from(SRT),
        },
    ]);
    const analyze = page.locator('[data-testid="local-video-analyze"]');
    await analyze.waitFor({ timeout: 15000 });
    await analyze.click();
    await waitForGuestLogin(page);
    assert.equal(
        state.localVideoCalls,
        0,
        'guest local-video AI must not call /api/local-video/process',
    );
    await page.screenshot({ path: `${SHOTS}/guest-local-video-login.png` });
    await context.close();
}

async function checkCachedVideoForGuest(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    // A cached learning route restores from /api/history only: no estimate, no
    // processing, no AI. This is the "guests may still watch what exists" half.
    await page.goto(`${BASE}/#/app/content/learn/youtube/cached-e2e`);
    await page.locator('[data-testid="learning-scroll"]').waitFor({ timeout: 20000 });
    assert.match(await page.locator('body').innerText(), /Cached English subtitle\./);
    assert.equal(state.estimateCalls, 0);
    assert.equal(state.processCalls, 0);
    assert.deepEqual(state.aiRequests, []);
    await page.screenshot({ path: `${SHOTS}/guest-cached-video.png` });
    await context.close();
}

async function checkLocalEpisodeForGuest(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await openContent(page);
    const show = page.locator('[data-testid="local-show-card-show-e2e"]');
    await show.waitFor({ timeout: 15000 });
    await show.click();
    await page.locator('[data-testid="show-season-1"]').click();
    await page.getByRole('button', { name: 'E01' }).click();
    await waitForGuestLogin(page);
    assert.equal(
        state.processSubtitleCalls,
        0,
        'guest local episode must not call /api/process-subtitle',
    );
    await page.screenshot({ path: `${SHOTS}/guest-local-episode-login.png` });
    await context.close();
}

async function checkBookTranslationForGuest(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await page.goto(`${BASE}/#/app/content/book/${BOOK_ID}`);
    const translate = page.locator('[data-testid="book-translate-chapter"]');
    await translate.waitFor({ timeout: 20000 });
    // Opening an untranslated chapter must not auto-translate for a guest.
    await page.waitForTimeout(500);
    assert.equal(
        state.bookTranslateCalls,
        0,
        'guest chapter open must not auto-translate',
    );
    assert.match(await page.locator('body').innerText(), /The sea was calm\./);
    assert.equal(await page.locator('[data-testid="book-guest-translate-hint"]').count(), 1);
    await translate.click();
    await waitForGuestLogin(page);
    assert.equal(
        state.bookTranslateCalls,
        0,
        'guest translate button must not call the translate endpoint',
    );
    await page.screenshot({ path: `${SHOTS}/guest-book-login.png` });
    await context.close();
}

async function checkSignedInEstimatesStillWork(browser) {
    const { context, state } = await newContext(browser, { user: USER });
    const page = await context.newPage();
    await submitContentUrl(page);
    await page.locator('[data-testid="estimate-modal"]').waitFor({ timeout: 10000 });
    assert.equal(state.estimateCalls, 1, 'signed-in estimate must reach the backend');
    assert.equal(await page.locator('[data-testid="guest-auth-overlay"]').count(), 0);
    await page.screenshot({ path: `${SHOTS}/signed-in-estimate.png` });
    await context.close();
}

async function checkSignedInDictionaryStillWorks(browser) {
    const { context, state } = await newContext(browser, { user: USER });
    const page = await context.newPage();
    await openLibraryArticle(page);
    await page.locator('[data-testid="library-en-0"] [data-word-hit]').first().click();
    const popover = page.locator('[data-testid="word-popover"]');
    await popover.waitFor({ timeout: 10000 });
    assert.match(await popover.innerText(), /海洋/);
    // React StrictMode double-invokes effects in dev, so the un-gated popover
    // may fetch the definition twice; what matters is that the request fired.
    assert.ok(state.defineCalls >= 1, 'signed-in word lookup must reach /api/define');
    assert.equal(await page.locator('[data-testid="guest-auth-overlay"]').count(), 0);
    await context.close();
}

async function checkSignedInLoginRequiredIsReadable(browser) {
    const { context, state } = await newContext(browser, { user: USER, estimateStatus: 403 });
    const page = await context.newPage();
    await submitContentUrl(page);
    await page.locator('[data-testid="toast"]').filter({ hasText: '需要登录' }).first()
        .waitFor({ timeout: 8000 });
    assert.equal(state.estimateCalls, 1);
    // The gate must not fall through to processing and must never sign out.
    assert.equal(state.processCalls, 0, '403 login_required must not fall through to process');
    assert.equal(state.logoutCalls, 0, '403 login_required must not log the user out');
    await context.close();
}

async function checkProcessErrorCopy(browser, status, expectedText, label) {
    const { context, state } = await newContext(browser, { user: USER, processStatus: status });
    const page = await context.newPage();
    await submitContentUrl(page);
    await page.locator('[data-testid="estimate-modal"]').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '确认并开始' }).click();
    await page.locator('[data-testid="toast"]').filter({ hasText: expectedText }).first()
        .waitFor({ timeout: 10000 });
    assert.equal(state.processCalls, 1, `${label}: the signed-in request must be sent`);
    assert.equal(state.logoutCalls, 0, `${label}: billing/code errors never log out`);
    assert.equal(
        await page.locator('[data-testid="processing-overlay"]').count(),
        0,
        `${label}: processing overlay must close after the error`,
    );
    await context.close();
}

async function checkPublicPagesStillOpen(browser) {
    const { context } = await newContext(browser);
    const page = await context.newPage();
    const pages = [
        ['#/blog', '[data-testid="public-blog-screen"]'],
        ['#/pricing', '[data-testid="pricing-title"]'],
        ['#/resources', '[data-testid="resources-title"]'],
        ['#/privacy', '[data-testid="legal-title"]'],
        ['#/terms', '[data-testid="legal-title"]'],
    ];
    for (const [hash, selector] of pages) {
        await page.goto(`${BASE}/${hash}`);
        await page.locator(selector).waitFor({ timeout: 15000 });
    }
    await context.close();
}

async function checkOverflow(browser, language, width) {
    const { context } = await newContext(browser, {
        language,
        viewport: { width, height: width === 375 ? 812 : 900 },
    });
    const page = await context.newPage();
    await openContent(page);
    await page.waitForTimeout(350);
    await assertNoOverflow(page, `${language} ${width}px content`);
    if (width === 375) {
        await submitContentUrl(page);
        await waitForGuestLogin(page);
        await assertNoOverflow(page, `${language} 375px auth overlay`);
        await page.screenshot({ path: `${SHOTS}/guest-${language}-375.png` });
    } else {
        await page.screenshot({ path: `${SHOTS}/guest-${language}-1440.png` });
    }
    await context.close();
}

function checkDictionaryCopyInBothLanguages() {
    // check:i18n enforces key parity; this pins the four M7b/user-facing codes
    // so a future rename cannot silently drop them from one dictionary.
    const read = (code) => JSON.parse(
        readFileSync(new URL(`../src/i18n/${code}.json`, import.meta.url), 'utf8'),
    );
    const zh = read('zh-CN');
    const vi = read('vi-VN');
    for (const key of [
        'guest.aiLoginRequired',
        'errors.loginRequired',
        'errors.modelUnpriced',
        'errors.quotaExceeded',
        'books.reader.loginRequired',
        'books.reader.guestTranslateHint',
    ]) {
        assert.ok(zh[key], `zh-CN missing ${key}`);
        assert.ok(vi[key], `vi-VN missing ${key}`);
    }
}

async function main() {
    const browser = await launchBrowser();
    try {
        // Guest gates: entry point → existing login overlay, zero AI requests.
        await check('guest content start → login, no estimate/process request', async () => {
            const { context, state } = await newContext(browser);
            const page = await context.newPage();
            await submitContentUrl(page);
            await waitForGuestLogin(page);
            assert.equal(state.estimateCalls, 0, 'guest start must not call /api/estimate-cost');
            assert.equal(state.processCalls, 0, 'guest start must not call processing');
            assert.deepEqual(state.aiRequests, []);
            await page.screenshot({ path: `${SHOTS}/guest-content-login.png` });
            await context.close();
        });

        await check('guest word lookup → login, no /api/define', () => checkDictionaryForGuest(browser));
        await check('guest can still watch cached subtitles/summary', () => checkCachedVideoForGuest(browser));
        await check('guest local-video AI → login, no /api/local-video/process', () => checkLocalVideoForGuest(browser));
        await check('guest local episode → login, no /api/process-subtitle', () => checkLocalEpisodeForGuest(browser));
        await check('guest public-domain translation → login, no auto-translate', () => checkBookTranslationForGuest(browser));

        // Signed-in regression: the same entries remain active.
        await check('signed-in estimate still opens the confirmation modal', () => checkSignedInEstimatesStillWork(browser));
        await check('signed-in dictionary still opens the word popover', () => checkSignedInDictionaryStillWorks(browser));

        // Error copy / no logout.
        await check('signed-in 403 login_required is readable and not a logout', () => checkSignedInLoginRequiredIsReadable(browser));
        await check('signed-in model_unpriced asks to contact the admin', () => checkProcessErrorCopy(
            browser,
            503,
            '联系管理员补价',
            'model_unpriced',
        ));
        await check('signed-in quota_exceeded shows the quota copy', () => checkProcessErrorCopy(
            browser,
            429,
            '今日 AI 配额已用完',
            'quota_exceeded',
        ));
        await check('M7b copy exists in zh-CN and vi-VN', async () => checkDictionaryCopyInBothLanguages());

        // Requirement 4: the public site is not part of the gate.
        await check('public blog / pricing / resources / legal stay open to guests', () => checkPublicPagesStillOpen(browser));

        // Layout: 375 / 1440 × zh-CN / vi-VN, content and full-screen login.
        for (const language of ['zh-CN', 'vi-VN']) {
            for (const width of [375, 1440]) {
                await check(`${language} ${width}px has no horizontal overflow`, () => checkOverflow(browser, language, width));
            }
        }
    } finally {
        await browser.close();
    }

    if (failures.length > 0) {
        console.error(`\n${failures.length} of ${checks} checks failed:`);
        failures.forEach((failure) => console.error(` - ${failure}`));
        process.exitCode = 1;
    } else {
        console.log(`\nGuest AI gate OK: ${checks} checks passed. Screenshots: ${SHOTS}`);
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
