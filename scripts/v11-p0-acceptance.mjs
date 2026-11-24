// P2-40 acceptance — v1.1 P0 frontend on desktop (1440).
//
// Proves, with every /api/** call mocked (no backend, DB or LLM touched):
//   1. 找回密码：login → 忘记密码 → 已发送（恒成功、不枚举邮箱）；重置链接
//      `#/login?reset=<token>` → 新密码 → 成功回登录；过期 token 给出错误且不白屏。
//   2. 邮箱验证：`#/login?verify=<token>` 成功/失败都有提示；登录态账户页的
//      「验证邮箱」横幅可重发验证邮件。
//   3. 旧登录不回归：原有登录表单仍提交、成功后进入 app shell。
//   4. 额度页：`GET /api/quota` 的 loading / error+retry / empty / ready 四态，
//      剩余量、已关闭（limit 0）、重置时间。
//   5. 反馈弹窗：分类 + 描述 + 自动 requestId，POST /api/feedback 成功回执、
//      失败保留草稿（不白屏、不误报成功）。
//   6. 首次引导：新用户 3 步 coach（桌面非阻塞）→ 完成写 localStorage →
//      刷新不再出现；「我的」可再次打开完整三步弹窗。
//   7. AI 生成标识：翻译（文章阅读器）、分析（语言点面板）、习题（模拟题库）。
// 1440 截图写入 /tmp/v11-p0-*-1440.png。
//
// Run (needs `npm run dev` on :5173):
//   node scripts/v11-p0-acceptance.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SHOTS = '/tmp';
const VIEWPORT = { width: 1440, height: 900 };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

fs.mkdirSync(SHOTS, { recursive: true });

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

// ── fixtures ───────────────────────────────────────────────────────────────
const USER = {
    id: 'u-v11',
    email: 'v11@example.com',
    username: 'V11 Tester',
    credits: 0,
    status: 'active',
    emailVerified: false,
};

const QUOTA_OK = {
    day: '2026-11-25',
    resetAt: Date.parse('2026-11-26T00:00:00+08:00'),
    features: [
        { feature: 'translate', limit: 20, used: 3, remaining: 17, source: 'default' },
        { feature: 'define', limit: 50, used: 50, remaining: 0, source: 'default' },
        { feature: 'quiz', limit: 0, used: 0, remaining: 0, source: 'default' },
        { feature: 'reading', limit: 6, used: 1, remaining: 5, source: 'override' },
    ],
};

const ARTICLE_EN_0 = 'The quiet power of small habits shapes a good morning.';
const ARTICLE_ZH_0 = '小习惯的安静力量塑造一个美好的早晨。';
const ARTICLE_EN_1 = 'A short walk before breakfast makes the day slower and calmer.';
const ARTICLE_ZH_1 = '早餐前散一小段步，会让一整天更慢、更平静。';

const ARTICLE_BASE = {
    articleId: 'art-v11',
    title: 'Habits and Cities',
    site: 'example.com',
    sourceUrl: null,
    lang: 'en',
    wordCount: 26,
    createdAt: 1763000000000,
    targetLang: 'zh-CN',
    progress: null,
    stats: { total: 2, translated: 2, untranslated: 0 },
    languagePoints: [],
};

const ARTICLE_PAYLOAD = {
    ...ARTICLE_BASE,
    paragraphs: [
        {
            idx: 0,
            text: ARTICLE_EN_0,
            translation: ARTICLE_ZH_0,
            translationModel: 'deepseek-chat',
            translationFailed: false,
            highlights: [],
        },
        {
            idx: 1,
            text: ARTICLE_EN_1,
            translation: ARTICLE_ZH_1,
            translationModel: 'deepseek-chat',
            translationFailed: false,
            highlights: [],
        },
    ],
};

const LIBRARY_VIDEO = {
    id: 'lib-v11',
    title: 'Library Habits',
    channel: 'LinguaTrek Test',
    duration: 24,
    level: 'B1',
    youtubeId: '',
    free: true,
    source: 'youtube',
    videoId: 'lib-v11',
    targetLang: 'zh-CN',
    analysisVersion: 'analysis.v5',
    idioms: [
        { blockId: 1, phrase: 'before breakfast', meaning: '早餐前', quote: 'A short walk before breakfast…' },
    ],
    culture: [],
    blocks: [
        {
            id: 0,
            start: 0,
            end: 8,
            en_text: 'The quiet power of small habits shapes a good morning.',
            zh_text: ARTICLE_ZH_0,
            highlights: [{ en_word: 'habits', zh_word: '习惯', color: '' }],
        },
        {
            id: 1,
            start: 8,
            end: 18,
            en_text: 'A short walk before breakfast makes the day slower and calmer.',
            zh_text: ARTICLE_ZH_1,
            highlights: [],
        },
    ],
};

const EXAM_TYPES = {
    types: [
        {
            id: 'cet4',
            label: 'CET-4',
            itemCount: 30,
            sessionItemCount: 10,
            description: '四级模拟',
            disclaimer: '模拟练习，不是真题。',
        },
    ],
    disclaimer: '模拟练习，不是真题。',
};

const EXAM_START = {
    sessionId: 'exam-v11',
    examType: 'cet4',
    label: 'CET-4',
    status: 'in_progress',
    resumed: false,
    startedAt: 1763000000000,
    itemCount: 1,
    totals: { vocab: 1, grammar: 0, reading: 0, all: 1 },
    instructions: '选择最合适的答案。',
    items: [
        {
            itemId: 'ex-1',
            type: 'vocab',
            band: 'B1',
            topic: 'daily life',
            prompt: 'Choose the word closest in meaning to "quiet".',
            options: ['silent', 'loud', 'angry', 'fast'],
        },
    ],
    disclaimer: '模拟练习，不是真题。',
};

const USER_SUMMARY = {
    user: {
        id: USER.id,
        email: USER.email,
        username: USER.username,
        credits: 0,
        memberSince: 1763000000000,
        status: 'active',
    },
    balanceMicroUsd: 1_000_000,
    availableMicroUsd: 1_000_000,
    monthSpendUsd: 0.5,
    usageToday: { minutes: 3 },
    version: '1.1.0',
    preliminary: false,
};

const EXPORT_LIMITS = {
    per24h: 1,
    per30d: 3,
    ttlHours: 24,
    maxBytes: 104_857_600,
    concurrentJobs: 1,
};

// ── mocked API ─────────────────────────────────────────────────────────────
/**
 * One mutable `state` per browser context decides which branch each v1.1
 * endpoint answers. Everything else is the minimum app shell surface.
 */
function createState(overrides = {}) {
    return {
        authed: false,
        quotaMode: 'ok', // ok | error | empty
        feedbackMode: 'ok', // ok | error
        resetConfirmMode: 'ok', // ok | expired | invalid
        verifyMode: 'ok', // ok | bad
        calls: {
            passwordResetRequest: [],
            passwordResetConfirm: [],
            emailVerificationRequest: 0,
            emailVerificationConfirm: [],
            feedback: [],
            logins: [],
        },
        ...overrides,
    };
}

async function installMocks(context, state) {
    await context.addInitScript(() => {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_vocab_level', 'orbit');
    });

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
        const fail = (status, detail, extra = {}) => respond({ detail, ...extra }, status);
        const body = () => {
            try {
                return request.postDataJSON() || {};
            } catch {
                return {};
            }
        };

        // ── auth ─────────────────────────────────────────────────────────
        if (pathname === '/api/auth/me') {
            if (!state.authed) return fail(401, '未登录');
            return respond({ user: { ...USER }, isAdmin: false, guest: false });
        }
        if (pathname === '/api/auth/registration') {
            return respond({
                registrationOpen: true,
                inviteSignupEnabled: true,
                inviteRequired: false,
                registrationClosed: false,
            });
        }
        if (pathname === '/api/auth/login' && method === 'POST') {
            state.calls.logins.push(body());
            state.authed = true;
            return respond({ user: { ...USER } });
        }
        if (pathname === '/api/auth/signup' && method === 'POST') {
            state.authed = true;
            return respond({ user: { ...USER } }, 201);
        }
        if (pathname === '/api/auth/logout' && method === 'POST') {
            state.authed = false;
            return respond({ ok: true });
        }
        if (pathname === '/api/auth/claim-guest') return respond({ claimed: false });

        // v1.1 account recovery (P2-38 contract).
        if (pathname === '/api/auth/password-reset/request' && method === 'POST') {
            state.calls.passwordResetRequest.push(body());
            return respond({ ok: true });
        }
        if (pathname === '/api/auth/password-reset/confirm' && method === 'POST') {
            const payload = body();
            state.calls.passwordResetConfirm.push(payload);
            if (state.resetConfirmMode === 'expired') {
                return fail(410, '重置链接已过期', { code: 'token_expired' });
            }
            if (state.resetConfirmMode === 'invalid') {
                return fail(400, '重置链接无效', { code: 'token_invalid' });
            }
            if (typeof payload.password !== 'string' || payload.password.length < 8) {
                return fail(400, '密码太短', { code: 'password_too_short' });
            }
            return respond({ ok: true });
        }
        if (pathname === '/api/auth/email-verification/request' && method === 'POST') {
            state.calls.emailVerificationRequest += 1;
            return respond({ ok: true }, 202);
        }
        if (pathname === '/api/auth/email-verification/confirm' && method === 'POST') {
            const payload = body();
            state.calls.emailVerificationConfirm.push(payload);
            if (state.verifyMode === 'bad') {
                return fail(410, '验证链接无效', { code: 'token_expired' });
            }
            return respond({ ok: true });
        }

        // ── v1.1 quota / feedback (P2-39 contract) ───────────────────────
        if (pathname === '/api/quota') {
            if (state.quotaMode === 'error') return fail(500, '额度服务暂不可用');
            if (state.quotaMode === 'empty') return respond({ day: '2026-11-25', resetAt: null, features: [] });
            return respond(QUOTA_OK);
        }
        if (pathname === '/api/feedback' && method === 'POST') {
            const payload = body();
            state.calls.feedback.push(payload);
            if (state.feedbackMode === 'error') return fail(500, '服务器内部错误');
            return respond({ ok: true, id: 'fb-v11', requestId: payload.requestId });
        }

        // ── account page ─────────────────────────────────────────────────
        if (pathname === '/api/user/summary') return respond(USER_SUMMARY);
        if (pathname === '/api/account/deletion') {
            return respond({
                status: 'active',
                dueAt: null,
                deletion: null,
                cooldownDays: 7,
                backupRetentionDays: 30,
                notice: '',
            });
        }
        if (pathname === '/api/account/exports') return respond({ jobs: [], limits: EXPORT_LIMITS });
        if (pathname === '/api/user/profile' && method === 'PATCH') {
            return respond({ user: { ...USER, username: body().username || USER.username } });
        }

        // ── app shell reads ──────────────────────────────────────────────
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
                targetLang: 'zh-CN', now: Date.now(), today: '2026-11-25', dueToday: 0, dueNow: 0,
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
            const items = Array.isArray(body().items) ? body().items : [];
            return respond({ items: items.map((item) => ({ text: item?.text ?? '', level: 'A2', proper: false })) });
        }

        // ── AI badge surfaces: article reader / library video / exam ──────
        if (pathname === '/api/articles') return respond({ articles: [{ ...ARTICLE_BASE, translated: 2 }] });
        if (pathname === '/api/article/art-v11') return respond(ARTICLE_PAYLOAD);
        if (pathname === '/api/library/videos/lib-v11') return respond(LIBRARY_VIDEO);
        if (pathname.startsWith('/api/teaching-analysis/')) {
            return respond({ idioms: [], culture: [] });
        }
        if (pathname === '/api/exam/types') return respond(EXAM_TYPES);
        if (pathname === '/api/exam/history') return respond({ sessions: [], disclaimer: '' });
        if (pathname === '/api/exam/start' && method === 'POST') return respond(EXAM_START);

        if (pathname.startsWith('/api/')) return respond({});
        return route.fulfill({ status: 404, headers: CORS, contentType: 'application/json', body: '{}' });
    });
}

async function newSession(browser, state) {
    const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
    await installMocks(context, state);
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error.stack || error)));
    return { context, page, pageErrors };
}

function assertNoPageErrors(pageErrors, label) {
    assert.deepEqual(pageErrors, [], `${label}: page must not crash (white screen)`);
}

async function shot(page, name) {
    await page.screenshot({ path: `${SHOTS}/${name}`, fullPage: false });
}

// ── browser ────────────────────────────────────────────────────────────────
const browser = await chromium.launch({ executablePath: CHROME, headless: true });

try {
    // ═══ A. account recovery, email verification, old login ═══════════════
    {
        const state = createState();
        const { context, page, pageErrors } = await newSession(browser, state);

        await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-screen]').waitFor({ timeout: 15000 });

        // Old login is intact before anything else.
        await page.locator('[data-testid=auth-email]').waitFor({ timeout: 5000 });
        await page.locator('[data-testid=auth-password]').waitFor({ timeout: 5000 });
        assert.equal(await page.locator('[data-testid=auth-submit]').isEnabled(), true);

        // 1) 忘记密码 → always-success sent state, no account enumeration.
        await page.locator('[data-testid=auth-forgot-link]').click();
        await page.locator('[data-testid=auth-recovery-email]').fill('v11@example.com');
        await page.locator('[data-testid=auth-forgot-submit]').click();
        await page.locator('[data-testid=auth-forgot-sent]').waitFor({ timeout: 10000 });
        assert.equal(state.calls.passwordResetRequest.length, 1, 'reset request must be sent once');
        assert.deepEqual(state.calls.passwordResetRequest[0], { email: 'v11@example.com' });
        const sentText = await page.locator('[data-testid=auth-forgot-sent]').innerText();
        assert.ok(sentText.includes('v11@example.com'), 'sent copy names the address');
        await shot(page, 'v11-p0-forgot-1440.png');

        await page.locator('[data-testid=auth-forgot-back]').click();
        await page.locator('[data-testid=auth-submit]').waitFor({ timeout: 5000 });

        // 2) 重置链接：token 从 URL 移入表单，成功后回到登录。
        await page.goto(`${BASE}/#/login?reset=reset-token-ok`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-reset-password]').waitFor({ timeout: 15000 });
        assert.equal(
            await page.evaluate(() => window.location.hash),
            '#/login',
            'one-time reset token must be stripped from the URL',
        );
        await page.locator('[data-testid=auth-reset-password]').fill('correct-horse');
        await page.locator('[data-testid=auth-reset-confirm]').fill('different-horse');
        await page.locator('[data-testid=auth-reset-submit]').click();
        await page.locator('[data-testid=auth-reset-error]').waitFor({ timeout: 5000 });
        assert.equal(state.calls.passwordResetConfirm.length, 0, 'mismatched passwords never hit the server');

        await page.locator('[data-testid=auth-reset-confirm]').fill('correct-horse');
        await page.locator('[data-testid=auth-reset-submit]').click();
        await page.locator('[data-testid=auth-recovery-notice]').waitFor({ timeout: 10000 });
        assert.deepEqual(state.calls.passwordResetConfirm[0], {
            token: 'reset-token-ok',
            password: 'correct-horse',
        });
        await page.locator('[data-testid=auth-email]').waitFor({ timeout: 5000 });
        await page.locator('[data-testid=auth-recovery-notice]').waitFor({ timeout: 5000 });

        // 3) 过期 token：inline error + still usable (no white screen).
        state.resetConfirmMode = 'expired';
        await page.goto(`${BASE}/#/login?reset=reset-token-expired`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-reset-password]').waitFor({ timeout: 15000 });
        await page.locator('[data-testid=auth-reset-password]').fill('correct-horse');
        await page.locator('[data-testid=auth-reset-confirm]').fill('correct-horse');
        await page.locator('[data-testid=auth-reset-submit]').click();
        await page.locator('[data-testid=auth-reset-error]').waitFor({ timeout: 10000 });
        assert.ok(
            (await page.locator('[data-testid=auth-reset-error]').innerText()).includes('过期'),
            'expired token must explain itself',
        );
        await page.locator('[data-testid=auth-screen]').waitFor({ timeout: 5000 });
        await page.locator('[data-testid=auth-reset-restart]').click();
        await page.locator('[data-testid=auth-recovery-email]').waitFor({ timeout: 5000 });

        // 4) 邮箱验证链接：成功态。
        state.resetConfirmMode = 'ok';
        await page.goto(`${BASE}/#/login?verify=verify-token-ok`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-verify-notice][data-state=success]').waitFor({ timeout: 15000 });
        assert.deepEqual(state.calls.emailVerificationConfirm[0], { token: 'verify-token-ok' });
        await shot(page, 'v11-p0-verify-1440.png');

        // 5) 邮箱验证链接：失败态 + 登录表单仍可用。
        state.verifyMode = 'bad';
        await page.goto(`${BASE}/#/login?verify=verify-token-bad`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-verify-notice][data-state=error]').waitFor({ timeout: 15000 });
        await page.locator('[data-testid=auth-email]').waitFor({ timeout: 5000 });

        // 6) 旧登录不回归：提交后进入 app shell（同一套数据接口不变）。
        state.verifyMode = 'ok';
        await page.locator('[data-testid=auth-email]').fill('v11@example.com');
        await page.locator('[data-testid=auth-password]').fill('secret123');
        await page.locator('[data-testid=auth-submit]').click();
        await page.locator('[data-testid=app-shell]').waitFor({ timeout: 20000 });
        assert.equal(state.calls.logins.length, 1, 'old login path still posts /api/auth/login');
        await page.locator('[data-testid=content-screen]').waitFor({ timeout: 15000 }).catch(() => {});

        assertNoPageErrors(pageErrors, 'recovery flows');
        await context.close();
        console.log('✓ 找回密码 / 重置 / 邮箱验证 / 旧登录');
    }

    // ═══ B. signed-in: onboarding, quota, feedback, AI badges ═════════════
    {
        const state = createState({ authed: true });
        const { context, page, pageErrors } = await newSession(browser, state);

        // 1) 首次引导：桌面非阻塞 3 步 coach，可跳过/完成后持久化。
        await page.goto(`${BASE}/#/app/today`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=app-shell]').waitFor({ timeout: 20000 });
        await page.locator('[data-testid=onboarding-coach]').waitFor({ timeout: 10000 });
        assert.equal(await page.locator('[data-testid=onboarding-coach]').getAttribute('data-step'), '1');
        await shot(page, 'v11-p0-onboarding-1440.png');
        await page.locator('[data-testid=onboarding-coach-next]').click();
        assert.equal(await page.locator('[data-testid=onboarding-coach]').getAttribute('data-step'), '2');
        await page.locator('[data-testid=onboarding-coach-next]').click();
        assert.equal(await page.locator('[data-testid=onboarding-coach]').getAttribute('data-step'), '3');
        await page.locator('[data-testid=onboarding-coach-done]').click();
        await page.locator('[data-testid=onboarding-coach]').waitFor({ state: 'detached', timeout: 5000 });
        const stored = await page.evaluate(() => localStorage.getItem('yt_bilingual_onboarding_v1'));
        assert.ok(stored && JSON.parse(stored).done === true, 'finishing the guide writes localStorage');

        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=app-shell]').waitFor({ timeout: 20000 });
        await sleep(900);
        assert.equal(
            await page.locator('[data-testid=onboarding-coach]').count(),
            0,
            'a returning learner must not see the coach again',
        );

        // 2) 额度页四态 + 邮箱验证横幅。
        state.quotaMode = 'error';
        await page.goto(`${BASE}/#/app/profile`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=quota-panel]').waitFor({ timeout: 15000 });
        await page.locator('[data-testid=quota-error]').waitFor({ timeout: 10000 });

        state.quotaMode = 'empty';
        await page.locator('[data-testid=quota-retry]').click();
        await page.locator('[data-testid=quota-empty]').waitFor({ timeout: 10000 });

        state.quotaMode = 'ok';
        await page.locator('[data-testid=quota-refresh]').click();
        await page.locator('[data-testid=quota-features]').waitFor({ timeout: 10000 });
        const translateRemaining = await page
            .locator('[data-testid=quota-feature-translate-remaining]')
            .innerText();
        assert.ok(translateRemaining.includes('17'), `translate remaining shows the server value (${translateRemaining})`);
        assert.ok(
            (await page.locator('[data-testid=quota-feature-quiz]').innerText()).includes('已关闭'),
            'limit 0 renders 已关闭, not a 0/0 bar',
        );
        assert.ok(
            (await page.locator('[data-testid=quota-reset]').innerText()).includes('重置时间'),
            'reset instant is shown',
        );
        assert.ok(
            (await page.locator('[data-testid=quota-feature-reading]').innerText()).includes('单独配置'),
            'override source is labelled',
        );
        await page.locator('[data-testid=quota-panel]').scrollIntoViewIfNeeded();
        await shot(page, 'v11-p0-quota-1440.png');

        // 3) 邮箱验证提示：未验证横幅 + 重发。
        await page.locator('[data-testid=account-email-unverified]').waitFor({ timeout: 10000 });
        await page.locator('[data-testid=account-email-verify-resend]').click();
        await page.locator('[data-testid=account-email-verify-sent]').waitFor({ timeout: 10000 });
        assert.equal(state.calls.emailVerificationRequest, 1);

        // 4) 反馈弹窗：分类 + 描述 + 自动 requestId → 成功回执。
        await page.locator('[data-testid=account-feedback]').click();
        await page.locator('[data-testid=feedback-dialog]').waitFor({ timeout: 5000 });
        const requestId = (await page.locator('[data-testid=feedback-request-id]').innerText()).trim();
        assert.ok(requestId.length >= 8, 'request id is auto-generated and visible');
        await page.locator('[data-testid=feedback-category-content]').click();
        await page.locator('[data-testid=feedback-description]').fill('第二段译文把 habits 译成了「习惯们」，请修正。');
        await page.locator('[data-testid=feedback-submit]').click();
        await page.locator('[data-testid=feedback-success]').waitFor({ timeout: 10000 });
        assert.equal(state.calls.feedback.length, 1);
        assert.equal(state.calls.feedback[0].category, 'content');
        assert.equal(state.calls.feedback[0].requestId, requestId);
        assert.ok(String(state.calls.feedback[0].description).includes('habits'));
        assert.equal(
            (await page.locator('[data-testid=feedback-success-request-id]').innerText()).trim(),
            requestId,
            'the receipt quotes the same request id',
        );
        await shot(page, 'v11-p0-feedback-1440.png');
        await page.locator('[data-testid=feedback-done]').click();
        await page.locator('[data-testid=feedback-dialog]').waitFor({ state: 'detached', timeout: 5000 });

        // 5) 失败不白屏、不误报成功：错误留在弹窗内，草稿保留。
        state.feedbackMode = 'error';
        await page.locator('[data-testid=account-feedback]').click();
        await page.locator('[data-testid=feedback-dialog]').waitFor({ timeout: 5000 });
        await page.locator('[data-testid=feedback-description]').fill('提交失败时这段文字必须保留。');
        await page.locator('[data-testid=feedback-submit]').click();
        await page.locator('[data-testid=feedback-error]').waitFor({ timeout: 10000 });
        assert.equal(await page.locator('[data-testid=feedback-success]').count(), 0, 'no fake success');
        assert.equal(
            await page.locator('[data-testid=feedback-description]').inputValue(),
            '提交失败时这段文字必须保留。',
            'draft survives a failed submit',
        );
        await page.locator('[data-testid=feedback-cancel]').click();
        await page.locator('[data-testid=feedback-dialog]').waitFor({ state: 'detached', timeout: 5000 });
        state.feedbackMode = 'ok';

        // 6) 「我的」可再次打开完整三步引导（即使已完成）。
        await page.locator('[data-testid=account-onboarding]').click();
        await page.locator('[data-testid=onboarding-dialog]').waitFor({ timeout: 5000 });
        assert.equal(await page.locator('[data-testid=onboarding-step]').getAttribute('data-step'), '1');
        await page.locator('[data-testid=onboarding-next]').click();
        await page.locator('[data-testid=onboarding-skip]').click();
        await page.locator('[data-testid=onboarding-dialog]').waitFor({ state: 'detached', timeout: 5000 });

        // 7) AI 生成标识 ×3 surfaces。
        // translation — article reader toolbar.
        await page.goto(`${BASE}/#/app/content/reader/art-v11`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=reader-en-0]').waitFor({ timeout: 20000 });
        await page.locator('[data-testid=reader-ai-translation]').waitFor({ timeout: 10000 });
        assert.ok(
            (await page.locator('[data-testid=reader-ai-translation]').innerText()).includes('AI'),
            'translation surface carries an AI badge',
        );
        await sleep(3200); // let the earlier success toast clear before the shot
        await shot(page, 'v11-p0-ai-badge-1440.png');

        // analysis — teaching-notes panel on a free-library video.
        await page.goto(`${BASE}/#/app/content/learn/library/lib-v11`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=teaching-notes-panel]').waitFor({ timeout: 25000 });
        await page.locator('[data-testid=teaching-notes-ai-badge]').waitFor({ timeout: 10000 });

        // quiz — exam practice question.
        await page.goto(`${BASE}/#/app/practice/exam`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=exam-type-cet4]').waitFor({ timeout: 20000 });
        await page.locator('[data-testid=exam-type-start-cet4]').click();
        await page.locator('[data-testid=exam-question]').waitFor({ timeout: 20000 });
        await page.locator('[data-testid=exam-ai-badge]').waitFor({ timeout: 10000 });

        assertNoPageErrors(pageErrors, 'signed-in shell');
        await context.close();
        console.log('✓ 首启引导 / 额度 / 反馈 / AI 标识');
    }

    // ═══ C. Vietnamese UI: the v1.1 surfaces are translated, not CJK ════
    {
        const state = createState();
        const context = await browser.newContext({ viewport: VIEWPORT, reducedMotion: 'reduce' });
        await installMocks(context, state);
        await context.addInitScript(() => {
            localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
            localStorage.setItem('yt_bilingual_target_lang', 'vi-VN');
        });
        const page = await context.newPage();
        const pageErrors = [];
        page.on('pageerror', (error) => pageErrors.push(String(error.stack || error)));

        const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
        await page.goto(`${BASE}/#/login?reset=vi-token`, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=auth-reset-password]').waitFor({ timeout: 15000 });
        const resetCopy = await page.locator('[data-testid=auth-reset]').innerText();
        assert.ok(resetCopy.includes('Đặt mật khẩu mới'), `vi reset title (${resetCopy.slice(0, 60)})`);
        assert.equal(CJK.test(resetCopy), false, 'vi-VN recovery copy must not contain CJK');

        state.authed = true;
        // Full reload: the hash-only goto keeps the anonymous AuthProvider state.
        await page.goto(`${BASE}/#/app/profile`, { waitUntil: 'domcontentloaded' });
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.locator('[data-testid=quota-panel]').waitFor({ timeout: 20000 });
        await page.locator('[data-testid=quota-features]').waitFor({ timeout: 10000 });
        const quotaCopy = await page.locator('[data-testid=quota-panel]').innerText();
        assert.ok(quotaCopy.includes('Hạn mức hôm nay'), 'vi quota title');
        assert.equal(CJK.test(quotaCopy), false, 'vi-VN quota copy must not contain CJK');

        await page.locator('[data-testid=account-feedback]').click();
        await page.locator('[data-testid=feedback-dialog]').waitFor({ timeout: 5000 });
        const feedbackCopy = await page.locator('[data-testid=feedback-dialog]').innerText();
        assert.ok(feedbackCopy.includes('Góp ý và báo lỗi'), 'vi feedback title');
        assert.equal(CJK.test(feedbackCopy), false, 'vi-VN feedback copy must not contain CJK');
        await page.locator('[data-testid=feedback-cancel]').click();

        assertNoPageErrors(pageErrors, 'vi-VN surfaces');
        await context.close();
        console.log('✓ 越南语界面（找回密码 / 额度 / 反馈）');
    }

    console.log(`P2-40 acceptance passed (desktop ${VIEWPORT.width}×${VIEWPORT.height}); screenshots in ${SHOTS}/v11-p0-*-1440.png`);
} finally {
    await browser.close();
}
