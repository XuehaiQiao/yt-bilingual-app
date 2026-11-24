// P0-04 + P2-32 acceptance: article analysis is async, visible and retryable.
//
// Proves the article reader paints the body before the language layer and no
// longer turns a failed analysis into an empty state:
//   1. opening the article sends `GET /api/article/{id}` WITHOUT `level`, so
//      the body is readable while the level-scoped analysis request is still
//      pending (the mocked analysis response is held until the test releases it);
//   2. `analysisUnavailableReason=quota_exceeded` (used/limit) from the
//      background analysis renders a non-blocking inline hint
//      ("今日分析额度已用完（30/30），明天 0 点恢复") with a retry button; the
//      English body and word lookup keep working;
//   3. clicking retry fires exactly one new level-scoped request and the hint
//      disappears once the analysis arrives (ruby appears);
//   4. `model_error` shows different copy than the quota failure;
//   5. a 403 on retry is still the sign-in hint, not an analysis error, and the
//      body stays readable;
//   6. successful background analysis shows no hint at all.
//
// Every /api/** call is mocked; no backend/database/LLM is touched.
//
// Run (needs `npm run dev` on :5173):
//   node scripts/p0-04-analysis-acceptance.mjs
// Screenshots: /tmp/p0-04-*.png
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = '/tmp';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(SHOTS, { recursive: true });

// ── fixtures ───────────────────────────────────────────────────────────────
const EN_0 = 'The quiet power of small habits shapes a good morning.';
const ZH_0 = '小习惯的安静力量塑造一个美好的早晨。';
const EN_1 = 'A short walk before breakfast makes the whole day feel slower and calmer.';
const ZH_1 = '早餐前散一小段步，会让一整天都更慢、更平静。';

const paragraphs = () => [
    {
        idx: 0,
        text: EN_0,
        translation: ZH_0,
        translationModel: 'deepseek-chat',
        translationFailed: false,
        highlights: [],
    },
    {
        idx: 1,
        text: EN_1,
        translation: ZH_1,
        translationModel: 'deepseek-chat',
        translationFailed: false,
        highlights: [],
    },
];

const ARTICLE_BASE = {
    articleId: 'art1',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 30,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    progress: null,
    stats: { total: 2, translated: 2, untranslated: 0 },
    languagePoints: [],
};

const QUOTA_PAYLOAD = {
    ...ARTICLE_BASE,
    paragraphs: paragraphs(),
    analysisUnavailableReason: 'quota_exceeded',
    analysisUsed: 30,
    analysisLimit: 30,
    analysisResetAt: '2026-11-23T00:00:00+08:00',
};

// P2-32: opening the article asks for the body only (`level` absent). The
// level-scoped analysis then arrives from a second, background request.
const BODY_PLAIN = {
    ...ARTICLE_BASE,
    paragraphs: paragraphs(),
    stats: { total: 2, translated: 2, untranslated: 0 },
};

const MODEL_PAYLOAD = {
    ...ARTICLE_BASE,
    paragraphs: paragraphs(),
    analysisUnavailableReason: 'model_error',
};

const OK_PAYLOAD = {
    ...ARTICLE_BASE,
    paragraphs: paragraphs(),
    analysisLevel: 'orbit',
    analysisVersion: 'analysis.v5',
    idioms: [{ blockId: 0, phrase: 'quiet power', meaning: '安静的力量', quote: EN_0 }],
    culture: [],
};

const SUMMARY = {
    articleId: 'art1',
    title: ARTICLE_BASE.title,
    site: ARTICLE_BASE.site,
    sourceUrl: null,
    lang: 'en',
    wordCount: 30,
    createdAt: ARTICLE_BASE.createdAt,
    paragraphCount: 2,
    progress: null,
};

// ── browser + mocked API ───────────────────────────────────────────────────
function installSpeechStub() {
    const state = { voices: [], current: null };
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
    const synth = {
        speaking: false,
        pending: false,
        paused: false,
        getVoices: () => state.voices,
        addEventListener: () => {},
        removeEventListener: () => {},
        speak: () => {},
        cancel: () => {},
        pause: () => {},
        resume: () => {},
    };
    Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: synth });
}

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const cors = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

/** One mocked reader session; `scenario` decides the article response. */
async function openArticle(scenario) {
    const context = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        reducedMotion: 'reduce',
    });
    await context.addInitScript(installSpeechStub);
    await context.addInitScript(() => {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_vocab_level', 'orbit');
        localStorage.setItem('yt_bilingual_reading_highlight', '1');
        localStorage.setItem('yt_bilingual_language_points', '1');
    });

    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    const articleRequests = [];
    let analysisResponses = 0;
    let defineCalls = 0;
    // `scenario.mode` starts at scenario.initial and advances on every retry.
    let mode = scenario.initial;
    // P2-32: hold the level-scoped analysis response until the body is visibly
    // on screen, so "body first" is proven instead of timing-dependent.
    let released = false;
    let releaseGate;
    const gate = new Promise((resolve) => { releaseGate = resolve; });
    const releaseAnalysis = () => {
        released = true;
        releaseGate();
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

        // ── app shell ─────────────────────────────────────────────────────
        if (pathname === '/api/auth/me') {
            return respond({
                user: { id: 'u-p004', email: 'p004@example.com' },
                isAdmin: false,
                guest: false,
            });
        }
        if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
        if (pathname === '/api/shows') return respond({ shows: [] });
        if (pathname === '/api/favorites' && method === 'GET') return respond([]);
        if (pathname === '/api/favorites' && method === 'POST') return respond({ favorite: { id: 'f1' } });
        if (pathname === '/api/sentences/levels') return respond([]);
        if (pathname === '/api/models') {
            return respond({
                models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }],
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
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-22', dueToday: 0, dueNow: 0,
                reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0,
                suspendedWords: 0, streakDays: 0,
            });
        }
        if (pathname === '/api/review/words') {
            return respond({ targetLang: 'zh-CN', now: Date.now(), total: 0, words: [] });
        }
        if (pathname === '/api/recommendations') {
            return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
        }
        if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
        if (pathname === '/api/vocabulary/classify') {
            const body = request.postDataJSON() || {};
            const items = Array.isArray(body.items) ? body.items : [];
            return respond({
                items: items.map((item) => {
                    const text = String(item?.text ?? '');
                    const level = text.toLowerCase() === 'habits' ? 'C1' : 'A1';
                    return { text, level, proper: false };
                }),
            });
        }
        if (pathname === '/api/define') {
            defineCalls += 1;
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

        // ── the article under test ────────────────────────────────────────
        if (pathname === '/api/articles' && method === 'GET') {
            return respond({ articles: [SUMMARY] });
        }
        if (pathname === '/api/article/art1' && method === 'GET') {
            const level = url.searchParams.get('level');
            const requestMode = mode;
            articleRequests.push({
                level,
                targetLang: url.searchParams.get('targetLang'),
                mode: requestMode,
            });
            // First paint: no level, no analysis — the body must render now.
            if (!level) return respond(BODY_PLAIN);
            // 8s safety net: a failed assertion must not leave this route hanging.
            if (!released) await Promise.race([gate, sleep(8000)]);
            analysisResponses += 1;
            if (requestMode === 'quota') return respond(QUOTA_PAYLOAD);
            if (requestMode === 'model') return respond(MODEL_PAYLOAD);
            if (requestMode === 'login') return fail(403, '需要登录才能继续（会话可能已过期），请重新登录后重试。');
            return respond(OK_PAYLOAD);
        }

        if (pathname.startsWith('/api/')) return respond({});
        return fail(404, `unmocked ${method} ${pathname}`);
    });

    await page.goto(`${BASE}#/app/content/reader/art1`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=app-shell]').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible', timeout: 15000 });

    // React StrictMode dev double-mounts the screen, so settle before counting.
    const settle = async () => {
        let last = -1;
        for (let i = 0; i < 10; i += 1) {
            if (articleRequests.length === last) return articleRequests.length;
            last = articleRequests.length;
            await sleep(300);
        }
        return articleRequests.length;
    };
    await settle();

    const bodyRequests = articleRequests.filter((request) => request.level === null);
    const analysisRequests = articleRequests.filter((request) => request.level === 'orbit');
    assert.ok(
        bodyRequests.length >= 1 && bodyRequests.length <= 2,
        `${scenario.name}: expected 1-2 body requests, got ${bodyRequests.length}`,
    );
    assert.ok(
        analysisRequests.length >= 1 && analysisRequests.length <= 2,
        `${scenario.name}: expected 1-2 background analysis requests, got ${analysisRequests.length}`,
    );
    assert.equal(
        articleRequests[0].level,
        null,
        `${scenario.name}: the article body must be requested without an analysis level`,
    );
    // P2-32: the analysis response is still held by the mocked route. The body
    // is already readable, which proves the first paint never waits on it.
    assert.equal(
        analysisResponses,
        0,
        `${scenario.name}: analysis responded before the test released it`,
    );
    assert.ok(
        (await page.locator('[data-testid=reader-en-0]').innerText()).includes('quiet power'),
        `${scenario.name}: body text missing while analysis is pending`,
    );
    releaseAnalysis();

    const shot = async (name) => {
        await page.screenshot({ path: `${SHOTS}/${name}.png` });
        console.log(`shot: ${name}.png`);
    };

    return {
        page,
        context,
        shot,
        articleRequests,
        get analysisRequests() {
            return articleRequests.filter((request) => request.level === 'orbit');
        },
        openCount: analysisRequests.length,
        get defineCalls() { return defineCalls; },
        advance(nextMode) { mode = nextMode; },
        async close() {
            assert.deepEqual(pageErrors, [], `${scenario.name}: page errors: ${pageErrors.join(' | ')}`);
            await context.close();
        },
    };
}

const hint = (page) => page.locator('[data-testid=reader-analysis-unavailable]');
const retryButton = (page) => page.locator('[data-testid=reader-analysis-retry]');

// ── 1. quota failure: hint + body/word lookup, retry → success ─────────────
{
    const session = await openArticle({ name: 'quota', initial: 'quota' });
    const { page } = session;
    const first = await hint(page).innerText();
    assert.ok(
        first.includes('30/30') && first.includes('明天 0 点恢复'),
        `quota hint copy wrong: ${first}`,
    );
    assert.ok(!first.includes('语言点生成失败'), `quota hint leaked model copy: ${first}`);
    assert.equal(
        await page.locator('[data-testid=reader-analysis-login]').count(),
        0,
        'quota failure must not be a sign-in hint',
    );
    // Body still readable: English + translation both visible.
    assert.ok((await page.locator('[data-testid=reader-en-0]').innerText()).includes('quiet power'));
    await page.locator('[data-testid=reader-translation-0]').waitFor({ state: 'visible' });
    assert.equal(await page.locator('[data-testid=reader-error]').count(), 0, 'body must not show an error panel');

    // Word lookup keeps working while the layer is unavailable.
    await page.locator('[data-testid=reader-en-0] [data-word-hit]').first().click();
    await page.locator('[data-testid=word-popover]').waitFor({ state: 'visible', timeout: 8000 });
    assert.ok(session.defineCalls > 0, 'word lookup did not reach /api/define');
    await page.locator('[data-testid=word-popover-overlay]').click({ position: { x: 4, y: 4 } }).catch(() => {});
    await sleep(300);
    await session.shot('p0-04-quota-hint');

    // Retry → exactly one new analysis request; hint disappears, ruby arrives.
    session.advance('ok');
    await retryButton(page).click();
    await page.waitForFunction(
        () => !document.querySelector('[data-testid=reader-analysis-unavailable]'),
        undefined,
        { timeout: 10000 },
    );
    await sleep(300);
    const afterRetry = session.analysisRequests;
    assert.equal(
        afterRetry.length,
        session.openCount + 1,
        `retry must fire exactly one new analysis request (open ${session.openCount}, now ${afterRetry.length})`,
    );
    assert.equal(afterRetry[afterRetry.length - 1].level, 'orbit', 'retry dropped the level parameter');
    assert.ok(
        session.analysisRequests.every((request) => request.level === 'orbit'),
        'every background analysis request must carry the current level',
    );
    await page.locator('[data-testid=reader-en-0] [data-language-point]').first().waitFor({
        state: 'visible',
        timeout: 10000,
    });
    const bodyText = await page.locator('[data-testid=reader-en-0]').innerText();
    assert.ok(bodyText.includes('quiet power'), 'article body disappeared after retry');
    await session.shot('p0-04-quota-retry-ok');
    await session.close();
}

// ── 2. model failure: different copy, no quota figures ─────────────────────
{
    const session = await openArticle({ name: 'model', initial: 'model' });
    const { page } = session;
    const text = await hint(page).innerText();
    assert.ok(text.includes('语言点生成失败'), `model hint copy wrong: ${text}`);
    assert.ok(!text.includes('30/30'), `model hint leaked quota copy: ${text}`);
    assert.ok(await retryButton(page).isVisible(), 'model failure must be retryable');
    await session.shot('p0-04-model-error');
    await session.close();
}

// ── 3. 403 on retry → sign-in hint, not an analysis error ─────────────────
{
    const session = await openArticle({ name: 'retry-403', initial: 'quota' });
    const { page } = session;
    await hint(page).waitFor({ state: 'visible', timeout: 10000 });
    session.advance('login');
    await retryButton(page).click();
    await page.locator('[data-testid=reader-analysis-login]').waitFor({
        state: 'visible',
        timeout: 10000,
    });
    assert.equal(await hint(page).count(), 0, '403 retry must not render the analysis-failure hint');
    assert.ok(
        (await page.locator('[data-testid=reader-analysis-login]').innerText()).includes('登录'),
        '403 retry should show the sign-in copy',
    );
    await page.locator('[data-testid=reader-en-0]').waitFor({ state: 'visible' });
    await session.shot('p0-04-retry-403-login');
    await session.close();
}

// ── 4. success payload: no hint at all ────────────────────────────────────
{
    const session = await openArticle({ name: 'success', initial: 'ok' });
    const { page } = session;
    assert.equal(await hint(page).count(), 0, 'successful analysis must not show a failure hint');
    assert.equal(await retryButton(page).count(), 0, 'successful analysis must not show retry');
    await page.locator('[data-testid=reader-en-0] [data-language-point]').first().waitFor({
        state: 'visible',
        timeout: 10000,
    });
    await sleep(600);
    assert.ok(
        session.analysisRequests.length <= 2,
        `success payload must not refetch analysis (got ${session.analysisRequests.length} analysis requests)`,
    );
    await session.shot('p0-04-success-no-hint');
    await session.close();
}

await browser.close();
console.log('\nP0-04 + P2-32 reading analysis acceptance: PASS');
