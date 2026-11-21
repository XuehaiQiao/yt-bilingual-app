#!/usr/bin/env node
// Desktop acceptance for the TESTING_REPORT high-priority fixes.
//
// Runs the real React UI in Chromium against a fully stubbed backend. Covered:
//   1. guest pre-hint on the Content and Today composers (visible before the
//      click; public/cached content is still browsable);
//   2. SSE auto-reconnect: a stream that closes before `done` reconnects with
//      the recorded jobId + cursor, then finishes; 402/403/429 and a user stop
//      never produce another request;
//   3. processing-failure recovery panel: readable reason + retry / change
//      content, retry actually restarts the same URL;
//   4. WordPopover lookup retry after a failed /api/define;
//   5. favorite add/remove gives a success toast and an aria-pressed state;
//   6. PWA install button only appears on the third recorded visit;
//   7. cover images carry loading="lazy" + decoding="async" (checked in the
//      cached-video history card and the free-library card).
//
// No real AI call is made. Screenshots: /tmp/desktop-fixes-shots/
// Run: APP_URL=http://127.0.0.1:5173 npm run check:desktop-fixes
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
const SHOTS = '/tmp/desktop-fixes-shots';
mkdirSync(SHOTS, { recursive: true });

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=desktop-fixes-e2e';
const LIBRARY_ARTICLE_ID = 'ocean-noise-e2e';
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
    metadata: { title: 'Cached video', channel: 'Cached channel', thumbnail: 'https://img.example.test/cached.jpg', is_local_subtitle: false },
    model: 'e2e-model',
    modelName: 'E2E Model',
    studyCount: 1,
    updatedAt: Date.now(),
    mtime: null,
};
const CACHED_PAYLOAD = {
    videoId: 'cached-e2e',
    metadata: { title: 'Cached video', channel: 'Cached channel', thumbnail: 'https://img.example.test/cached.jpg' },
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

function metaBlock(id, start, en, zh) {
    return { id, start, end: start + 2, en_text: en, zh_text: zh, highlights: [] };
}

function sseEvent(event, data) {
    return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamMeta({ jobId = 'job-e2e', blocks, cursor = 0, total = blocks.length, resumed = false } = {}) {
    return sseEvent('meta', {
        videoId: 'desktop-fixes-e2e',
        metadata: { title: 'Desktop fixes e2e', channel: 'E2E channel' },
        blocks,
        cached: false,
        resumed,
        jobId,
        cursor,
        total,
        targetLang: 'zh-CN',
    });
}

function streamBatch({ jobId = 'job-e2e', blocks, cursor = 1, total = 2 }) {
    return sseEvent('batch', {
        blocks,
        progress: { done: cursor, total },
        cursor,
        total,
        jobId,
    });
}

function streamDone({ jobId = 'job-e2e', cursor = 2, total = 2 } = {}) {
    return sseEvent('done', { cached: false, jobId, cursor, total });
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

async function sse(route, chunks, { delayMs = 0 } = {}) {
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    const origin = route.request().headers().origin || BASE;
    return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'cache-control': 'no-store',
        },
        body: chunks.join(''),
    });
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
        console.error(`ERR  ${name}: ${error.stack || error.message}`);
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

/**
 * Install the API double. `processPlan[i]` decides what the i-th
 * `/api/process-video-stream` call returns; `definePlan` does the same for
 * `/api/define`.
 */
async function installStubs(context, options = {}) {
    const state = {
        user: options.user ?? null,
        processCalls: 0,
        processBodies: [],
        defineCalls: 0,
        estimateCalls: 0,
        aiRequests: [],
        processPlan: options.processPlan ?? [],
        definePlan: options.definePlan ?? [],
        history: options.history ?? [CACHED_VIDEO],
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

        if (
            path === '/api/process-video-stream'
            || path === '/api/estimate-cost'
            || path === '/api/define'
        ) {
            state.aiRequests.push(`${method} ${path}`);
        }

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
        if (path === '/api/auth/logout') return json(route, { ok: true });

        if (path === '/api/estimate-cost') {
            state.estimateCalls += 1;
            // Deliberately fail: EstimateDialog's documented fallback starts
            // processing immediately, which keeps this script on the stream.
            return json(route, { detail: 'estimate unavailable' }, 500);
        }

        if (path === '/api/process-video-stream') {
            state.processCalls += 1;
            state.processBodies.push(request.postDataJSON() || {});
            const handler = state.processPlan[state.processCalls - 1] || state.processPlan.at(-1);
            if (handler) return handler(route, request);
            return json(route, { ok: true });
        }

        if (path === '/api/define') {
            state.defineCalls += 1;
            const handler = state.definePlan[state.defineCalls - 1] || state.definePlan.at(-1);
            if (handler) return handler(route, request);
            return json(route, {
                word: 'ocean',
                lemma: 'ocean',
                ipa: '/ˈoʊʃən/',
                pos: 'n.',
                zh: '海洋',
            });
        }

        if (path === '/api/favorites') {
            if (method === 'POST') {
                const payload = request.postDataJSON() || {};
                return json(route, {
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
            return json(route, []);
        }
        if (path.startsWith('/api/favorites/') && method === 'DELETE') {
            return json(route, { ok: true });
        }

        if (path === '/api/history') return json(route, state.history);
        if (path === `/api/history/${CACHED_VIDEO.filename}`) return json(route, CACHED_PAYLOAD);
        if (path === '/api/subscriptions') return json(route, []);
        if (path === '/api/report/week') {
            return json(route, { numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
        }
        if (path === '/api/models') return json(route, { models: [], default: null });
        if (path === '/api/review/stats') {
            return json(route, { dueNow: 0, dueToday: 0, newWords: 0, reviewedToday: 0 });
        }
        if (path === '/api/placement/profile') return json(route, { profile: null });
        if (path === '/api/recommendations') {
            return json(route, { items: [], basis: { band: 'A2', source: 'default' }, preliminary: false });
        }
        if (path === '/api/shows') return json(route, { shows: [] });
        if (path === '/api/sentences/levels') return json(route, []);
        if (path === '/api/blog/posts') return json(route, { posts: [], count: 0 });
        if (path === '/api/channel-updates') return json(route, { updates: [] });
        if (path === '/api/events') return json(route, { ok: true });
        if (path === '/api/announcement') return json(route, { announcement: null });
        if (path === '/api/books') {
            return json(route, {
                series: [],
                counts: { series: 0, books: 0, availableBooks: 0, readableChapters: 0, translatedChapters: 0 },
            });
        }
        if (path === '/api/library') {
            return json(route, {
                videos: [],
                articles: [{
                    id: LIBRARY_ARTICLE_ID,
                    title: 'Ocean Noise',
                    level: 'B1',
                    wordCount: 6,
                }],
                counts: { videos: 0, articles: 1 },
            });
        }
        if (path === `/api/library/articles/${LIBRARY_ARTICLE_ID}`) return json(route, LIBRARY_ARTICLE);
        if (path === `/api/library/videos/${LIBRARY_ARTICLE_ID}`) return json(route, { detail: 'not a video' }, 404);
        if (path === '/api/user/summary') {
            return json(route, { code: 'login_required', detail: 'login required' }, 403);
        }
        if (path === '/api/account' || path === '/api/account/summary') {
            return json(route, { code: 'login_required', detail: 'login required' }, 403);
        }

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

async function submitYoutubeUrl(page) {
    await openContent(page);
    const input = page.locator('[data-testid="video-url-input"]').first();
    await input.waitFor({ timeout: 15000 });
    await input.fill(YOUTUBE_URL);
    await page.locator('[data-testid="start-submit"]').first().click();
}

async function waitForLearning(page) {
    await page.locator('[data-testid="learning-scroll"]').waitFor({ timeout: 20000 });
}

async function waitForReconnectBanner(page) {
    const banner = page.locator('[data-testid="stream-reconnect-banner"]');
    await banner.waitFor({ timeout: 5000 });
    return banner;
}

async function dispatchInstallPrompt(page) {
    await page.evaluate(() => {
        const event = new Event('beforeinstallprompt');
        event.prompt = () => Promise.resolve();
        event.userChoice = Promise.resolve({ outcome: 'dismissed', platform: 'web' });
        window.dispatchEvent(event);
        return true;
    });
}

async function checkGuestPreHint(browser) {
    const { context, state } = await newContext(browser);
    const page = await context.newPage();
    await openContent(page);

    const notice = page.locator('[data-testid="guest-ai-notice"]');
    await notice.waitFor({ timeout: 10000 });
    const noticeText = await notice.innerText();
    assert.match(noticeText, /登录后/, 'guest notice must say AI requires login before the click');
    assert.equal(await page.locator('[data-testid="guest-ai-login"]').count(), 1);
    assert.equal(
        await page.locator('[data-testid="video-url-input"]').first().isEnabled(),
        true,
        'guest input must stay usable for public/cached browsing',
    );
    assert.equal(state.processCalls, 0, 'no processing request may start without a click');
    assert.equal(state.estimateCalls, 0, 'no estimate request may start before the guest clicks');

    await page.locator('[data-testid="guest-ai-login"]').click();
    await page.locator('[data-testid="guest-auth-overlay"]').waitFor({ timeout: 8000 });
    assert.equal(state.processCalls, 0, 'opening login must not call AI');
    await page.screenshot({ path: `${SHOTS}/guest-pre-hint.png` });
    await context.close();
}

async function checkGuestPreHintToday(browser) {
    // No history: Today renders its primary composer. The pre-hint must be
    // wired there too (not only after the submit attempt).
    const { context, state } = await newContext(browser, { history: [] });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/app/today`);
    await page.locator('[data-testid="today-screen"]').waitFor({ timeout: 20000 });
    const notice = page.locator('[data-testid="guest-ai-notice"]');
    await notice.waitFor({ timeout: 15000 });
    assert.match(await notice.innerText(), /登录后/);
    assert.equal(await page.locator('[data-testid="guest-ai-login"]').count(), 1);
    assert.equal(state.processCalls, 0);
    await page.screenshot({ path: `${SHOTS}/guest-pre-hint-today.png` });
    await context.close();
}

async function checkAutoReconnect(browser) {
    const firstBlocks = [
        metaBlock(0, 0, 'First line.', '[未翻译]'),
        metaBlock(1, 2, 'Second line.', '[未翻译]'),
    ];
    const doneBlocks = [
        metaBlock(0, 0, 'First line.', '第一句。'),
        metaBlock(1, 2, 'Second line.', '第二句。'),
    ];
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => sse(route, [
                streamMeta({ blocks: firstBlocks }),
                streamBatch({ blocks: [doneBlocks[0]] }),
            ]),
            (route) => sse(route, [
                streamMeta({ blocks: doneBlocks, cursor: 1, resumed: true }),
                streamBatch({ blocks: [doneBlocks[1]], cursor: 2 }),
                sseEvent('summary', { summary: 'Restored summary.' }),
                streamDone(),
            ], { delayMs: 250 }),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    await waitForLearning(page);
    const banner = await waitForReconnectBanner(page);
    assert.match(await banner.innerText(), /重连/, 'readable reconnect status is shown');

    await page.getByText('Second line.', { exact: false }).waitFor({ timeout: 10000 });
    // The terminal event clears the reconnect state.
    await page.locator('[data-testid="stream-reconnect-banner"]').waitFor({ state: 'detached', timeout: 10000 });
    assert.equal(state.processCalls, 2, 'exactly one automatic reconnect');
    assert.equal(state.processBodies[0].jobId, undefined, 'first request is not a resume');
    assert.equal(state.processBodies[1].jobId, 'job-e2e', 'reconnect resumes the same job');
    assert.equal(state.processBodies[1].from, 1, 'reconnect resumes from the recorded cursor');
    assert.equal(
        await page.locator('[data-lookup-context]').count(),
        2,
        'resumed blocks replace by id instead of being inserted twice',
    );
    await page.screenshot({ path: `${SHOTS}/sse-reconnect.png` });
    await context.close();
}

async function checkNoRetryOn429(browser) {
    const blocks = [
        metaBlock(0, 0, 'First line.', '[未翻译]'),
        metaBlock(1, 2, 'Second line.', '[未翻译]'),
    ];
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => sse(route, [
                streamMeta({ blocks }),
                streamBatch({ blocks: [{ ...blocks[0], zh_text: '第一句。' }] }),
            ]),
            (route) => json(route, { code: 'quota_exceeded', detail: 'quota exceeded' }, 429),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    // 429 keeps its dedicated quota copy (toast), not the generic panel.
    const toast = page.locator('[data-testid="toast"]', { hasText: '配额' }).first();
    await toast.waitFor({ timeout: 10000 });
    const toastText = await toast.innerText();
    assert.doesNotMatch(toastText, /429|HTTP/, 'no technical status in the quota copy');
    assert.equal(await page.locator('[data-testid="process-failure-panel"]').count(), 0);
    assert.equal(state.processCalls, 2, '429 must not be retried');
    await page.waitForTimeout(1500);
    assert.equal(state.processCalls, 2, 'no extra retry after a 429');
    await page.screenshot({ path: `${SHOTS}/no-retry-429.png` });
    await context.close();
}

async function checkNoRetryOn402(browser) {
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => json(route, {
                code: 'insufficient_balance',
                detail: '余额不足，请联系管理员充值。',
                balanceMicroUsd: 20000,
                availableMicroUsd: 20000,
                requiredMicroUsd: 10000,
            }, 402),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    // 402 keeps the existing shortfall banner + localized toast; it is a
    // dedicated billing state, never a retryable stream failure.
    const banner = page.locator('[data-testid="insufficient-balance-banner"]');
    await banner.waitFor({ timeout: 10000 });
    assert.match(await banner.innerText(), /余额不足/, '402 shows the original balance prompt');
    const toast = page.locator('[data-testid="toast"]', { hasText: '余额不足' }).first();
    await toast.waitFor({ timeout: 10000 });
    assert.equal(state.processCalls, 1, '402 must not be retried');
    assert.equal(
        await page.locator('[data-testid="stream-reconnect-banner"]').count(),
        0,
        '402 must not start a reconnect',
    );
    assert.equal(await page.locator('[data-testid="process-failure-panel"]').count(), 0);
    await page.waitForTimeout(1500);
    assert.equal(state.processCalls, 1, 'no retry arrives after the 402');
    assert.equal(await page.locator('[data-testid="stream-reconnect-banner"]').count(), 0);
    await page.screenshot({ path: `${SHOTS}/no-retry-402.png` });
    await context.close();
}

async function checkNoRetryOn403(browser) {
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => json(route, { code: 'login_required', detail: 'login required' }, 403),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    // 403 keeps the existing readable login prompt; it must not retry or sign
    // the current session out.
    const toast = page.locator('[data-testid="toast"]', { hasText: '需要登录' }).first();
    await toast.waitFor({ timeout: 10000 });
    assert.doesNotMatch(await toast.innerText(), /403|HTTP/, 'no technical status in the login copy');
    assert.equal(await page.locator('[data-testid="auth-screen"]').count(), 0, '403 must not sign out');
    assert.equal(state.processCalls, 1, '403 must not be retried');
    assert.equal(
        await page.locator('[data-testid="stream-reconnect-banner"]').count(),
        0,
        '403 must not start a reconnect',
    );
    assert.equal(await page.locator('[data-testid="process-failure-panel"]').count(), 0);
    await page.waitForTimeout(1500);
    assert.equal(state.processCalls, 1, 'no retry arrives after the 403');
    assert.equal(await page.locator('[data-testid="stream-reconnect-banner"]').count(), 0);
    await page.screenshot({ path: `${SHOTS}/no-retry-403.png` });
    await context.close();
}

async function checkUserCancelStopsRetry(browser) {
    const blocks = [
        metaBlock(0, 0, 'First line.', '[未翻译]'),
        metaBlock(1, 2, 'Second line.', '[未翻译]'),
    ];
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => sse(route, [
                streamMeta({ blocks }),
                streamBatch({ blocks: [{ ...blocks[0], zh_text: '第一句。' }] }),
            ]),
            // Hold the reconnect request long enough for the stop click to
            // abort it; the client must not start a third request afterwards.
            (route) => sse(route, [
                streamMeta({ blocks, cursor: 1, resumed: true }),
                streamDone({ cursor: 2 }),
            ], { delayMs: 1500 }),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    await waitForLearning(page);
    await waitForReconnectBanner(page);
    // Wait until the single reconnect has started, then stop it.
    await page.waitForTimeout(1100);
    await page.locator('[data-testid="translation-stop"]').click();
    await page.waitForTimeout(1800);
    assert.equal(state.processCalls, 2, 'a user stop must not trigger another retry');
    assert.equal(
        await page.locator('[data-testid="process-failure-panel"]').count(),
        0,
        'a user stop is not a processing failure',
    );
    await page.screenshot({ path: `${SHOTS}/user-cancel.png` });
    await context.close();
}

async function checkSseFailureDetail(browser) {
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => sse(route, [
                sseEvent('error', {
                    detail: '该视频无字幕，本地转写也失败了:Traceback (most recent call last): ModuleNotFoundError: faster_whisper',
                    targetLang: 'zh-CN',
                }),
            ]),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    const panel = page.locator('[data-testid="process-failure-panel"]');
    await panel.waitFor({ timeout: 10000 });
    const text = await panel.innerText();
    assert.match(text, /无字幕/, 'the readable SSE reason survives in the panel');
    assert.doesNotMatch(text, /Traceback|ModuleNotFoundError|faster_whisper|pip|HTTP/,
        'technical ASR details are stripped from the panel');
    assert.equal(await page.locator('[data-testid="process-failure-retry"]').count(), 1);
    assert.equal(await page.getByText('更换内容', { exact: true }).count(), 1);
    assert.equal(state.processCalls, 1, 'a terminal SSE error is not retried');
    await page.screenshot({ path: `${SHOTS}/sse-failure-detail.png` });
    await context.close();
}

async function checkFailureRecovery(browser) {
    const blocks = [metaBlock(0, 0, 'Recovered line.', '恢复成功。')];
    const { context, state } = await newContext(browser, {
        user: USER,
        processPlan: [
            (route) => json(route, { detail: 'upstream unavailable' }, 500),
            (route) => sse(route, [
                streamMeta({ blocks, jobId: 'job-recovered' }),
                sseEvent('done', { cached: false, jobId: 'job-recovered', cursor: 1, total: 1 }),
            ]),
        ],
    });
    const page = await context.newPage();
    await submitYoutubeUrl(page);
    const panel = page.locator('[data-testid="process-failure-panel"]');
    await panel.waitFor({ timeout: 10000 });
    const text = await panel.innerText();
    assert.match(text, /处理失败/, 'readable failure heading');
    assert.doesNotMatch(text, /500|HTTP|upstream/, 'no technical server terms');
    assert.equal(await page.locator('[data-testid="process-failure-retry"]').count(), 1);
    assert.equal(await page.getByText('更换内容', { exact: true }).count(), 1);
    assert.equal(state.processCalls, 1, 'a pre-job failure cannot be auto-resumed');

    await page.locator('[data-testid="process-failure-retry"]').click();
    await waitForLearning(page);
    await page.getByText('Recovered line.').waitFor({ timeout: 10000 });
    assert.equal(state.processCalls, 2, 'retry starts exactly one new request');
    await page.screenshot({ path: `${SHOTS}/failure-recovery.png` });
    await context.close();
}

async function checkDictionaryRetry(browser) {
    // StrictMode mounts the popover effect twice in dev, so the stub fails
    // every lookup until the retry switches the plan to success.
    const failDefine = (route) => json(route, { detail: 'lookup unavailable' }, 500);
    const successDefine = (route) => json(route, {
        word: 'ocean',
        lemma: 'ocean',
        ipa: '/ˈoʊʃən/',
        pos: 'n.',
        zh: '海洋',
        definition_en: 'the sea',
    });
    const { context, state } = await newContext(browser, {
        user: USER,
        definePlan: [failDefine],
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/app/content/learn/library/${LIBRARY_ARTICLE_ID}`);
    await page.locator('[data-testid="library-en-0"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="library-en-0"] [data-word-hit]').first().click();
    await page.locator('[data-testid="word-popover"]').waitFor({ timeout: 10000 });
    await page.locator('[data-testid="word-popover-error"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-testid="word-popover-retry"]').count(), 1);
    const callsBeforeRetry = state.defineCalls;

    state.definePlan[0] = successDefine;
    await page.locator('[data-testid="word-popover-retry"]').click();
    await page.locator('[data-testid="word-popover"]').getByText('海洋', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(state.defineCalls, callsBeforeRetry + 1, 'retry re-runs exactly one dictionary lookup');
    assert.equal(await page.locator('[data-testid="word-popover-error"]').count(), 0);
    await page.screenshot({ path: `${SHOTS}/dictionary-retry.png` });
    await context.close();
}

async function checkFavoriteFeedback(browser) {
    const { context } = await newContext(browser, { user: USER });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/app/content/learn/youtube/cached-e2e`);
    await waitForLearning(page);
    const star = page.locator('[data-testid="favorite-toggle"]').first();
    await star.waitFor({ timeout: 15000 });
    await star.hover();
    await star.click();
    await page.getByText('已加入生词本', { exact: true }).first().waitFor({ timeout: 8000 });
    assert.equal(await star.getAttribute('aria-pressed'), 'true', 'favorite icon exposes the saved state');
    // The toast is deduped by key; a second add cannot stack another copy.
    assert.equal(await page.getByText('已加入生词本', { exact: true }).count(), 1);

    await star.click();
    await page.getByText('已移出生词本', { exact: true }).first().waitFor({ timeout: 8000 });
    assert.equal(await star.getAttribute('aria-pressed'), 'false');
    await page.screenshot({ path: `${SHOTS}/favorite-feedback.png` });
    await context.close();
}

async function checkPwaThirdVisit(browser) {
    const { context } = await newContext(browser);
    const page = await context.newPage();
    const gotoProfile = async () => {
        await page.goto(`${BASE}/#/app/profile`);
        await page.locator('[data-testid="account-settings"]').waitFor({ timeout: 20000 });
        await dispatchInstallPrompt(page);
        await page.waitForTimeout(200);
    };

    await gotoProfile();
    assert.equal(await page.locator('[data-testid="install-button"]').count(), 0, 'first visit: no install ask');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_visit_count')), '1');

    await page.reload();
    await page.locator('[data-testid="account-settings"]').waitFor({ timeout: 20000 });
    await dispatchInstallPrompt(page);
    await page.waitForTimeout(200);
    assert.equal(await page.locator('[data-testid="install-button"]').count(), 0, 'second visit: still hidden');
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_visit_count')), '2');

    await page.reload();
    await page.locator('[data-testid="account-settings"]').waitFor({ timeout: 20000 });
    await dispatchInstallPrompt(page);
    await page.locator('[data-testid="install-button"]').waitFor({ timeout: 5000 });
    assert.equal(await page.evaluate(() => localStorage.getItem('yt_bilingual_visit_count')), '3');
    assert.equal(await page.locator('[data-testid="install-button"]').count(), 1, 'third visit: install entry appears');
    await page.screenshot({ path: `${SHOTS}/pwa-third-visit.png` });
    await context.close();
}

async function checkLazyImages(browser) {
    const { context } = await newContext(browser, { user: USER });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/app/content`);
    await page.locator('[data-testid="content-screen"]').waitFor({ timeout: 20000 });
    // The cached-history cover in the Content rail.
    const railThumb = page.locator('[data-testid="content-rail-continue"] img').first();
    await railThumb.waitFor({ timeout: 10000 });
    assert.equal(await railThumb.getAttribute('loading'), 'lazy');
    assert.equal(await railThumb.getAttribute('decoding'), 'async');

    // The same cover on the Today "continue" card.
    await page.goto(`${BASE}/#/app/today`);
    await page.locator('[data-testid="today-workbench"]').waitFor({ timeout: 20000 });
    const todayThumb = page.locator('[data-testid="today-workbench"] img').first();
    await todayThumb.waitFor({ timeout: 10000 });
    assert.equal(await todayThumb.getAttribute('loading'), 'lazy');
    assert.equal(await todayThumb.getAttribute('decoding'), 'async');
    await context.close();
}

async function main() {
    const browser = await launchBrowser();
    try {
        await check('guest pre-hint on Content', () => checkGuestPreHint(browser));
        await check('guest pre-hint on Today', () => checkGuestPreHintToday(browser));
        await check('SSE auto-reconnect resumes job + cursor', () => checkAutoReconnect(browser));
        await check('429 is not retried', () => checkNoRetryOn429(browser));
        await check('402 insufficient_balance is not retried', () => checkNoRetryOn402(browser));
        await check('403 login_required is not retried', () => checkNoRetryOn403(browser));
        await check('user stop cancels reconnect', () => checkUserCancelStopsRetry(browser));
        await check('SSE failure keeps the readable reason + recovery actions', () => checkSseFailureDetail(browser));
        await check('processing failure offers retry / change content', () => checkFailureRecovery(browser));
        await check('dictionary lookup retry', () => checkDictionaryRetry(browser));
        await check('favorite feedback toast + state', () => checkFavoriteFeedback(browser));
        await check('PWA install appears on third visit', () => checkPwaThirdVisit(browser));
        await check('cover images lazy-load', () => checkLazyImages(browser));
    } finally {
        await browser.close();
    }
    if (failures.length > 0) {
        console.error(`\n${failures.length}/${checks} check(s) failed:`);
        for (const failure of failures) console.error(` - ${failure}`);
        process.exit(1);
    }
    console.log(`\nAll ${checks} desktop-fix checks passed.`);
}

await main();
