#!/usr/bin/env node
// Browser acceptance for P2-30 / specs/047 — admin daily quotas UI.
//
// Runs the real React console in Chromium against a stubbed backend (the
// backend contract itself is covered by backend/tests/test_quota_admin.py).
// Verified here:
//   A) new 「额度」 tab: 8 default rows with feature labels + source badges,
//      read-only budget values (no inputs), save disabled until a change;
//   B) defaults editing: only changed rows are submitted, `0` renders 关闭,
//      per-row restore submits `null` and falls back to the env value, the
//      console refresh re-reads the table;
//   C) defaults failure 400/503 stays inline, keeps the draft and can retry;
//   D) single user: debounced search calls fetchAdminUsers(limit 8), selecting
//      a user loads all 8 rows, override 0/custom saves with a required
//      reason, and clearing overrides asks first and submits `null`;
//   E) user quota inline errors: GET 404/503 + PUT 400/404/503 keep the draft;
//   F) 1440 / 375 screenshots, no page-level horizontal overflow at 375 (the
//      table wrapper owns the scroll), and vi-VN copy with no Chinese text.
//
// Screenshots: /tmp/admin-quotas-shots/
// Run: APP_URL=http://127.0.0.1:5173 node scripts/admin-quotas-acceptance.mjs
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';

let assertionsPassed = 0;
for (const name of ['ok', 'equal', 'deepEqual', 'match']) {
    const original = assert[name];
    assert[name] = (...args) => {
        original(...args);
        assertionsPassed += 1;
    };
}

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
const SHOTS = '/tmp/admin-quotas-shots';
mkdirSync(SHOTS, { recursive: true });

const ADMIN = {
    id: 'admin-e2e',
    email: 'admin@example.test',
    username: 'admin-e2e',
    credits: 0,
    status: 'active',
};

const FEATURES = [
    'translate', 'summary', 'define', 'local_show',
    'quiz', 'reading', 'analysis', 'course_generation',
];
const ENV_DEFAULTS = {
    translate: 60,
    summary: 30,
    define: 100,
    local_show: 20,
    quiz: 20,
    reading: 40,
    analysis: 10,
    course_generation: 5,
};
const FEATURE_LABELS = {
    translate: '翻译',
    summary: '总结',
    define: '词典',
    local_show: '本地剧集',
    quiz: '理解题',
    reading: '读文章',
    analysis: '教学分析',
    course_generation: '课程生成',
};

const USERS = [
    {
        id: 'user-lea',
        userId: 'user-learner',
        email: 'learner@example.test',
        username: 'learner-e2e',
        credits: 0,
        status: 'active',
        createdAt: Date.now() - 90 * 86400000,
        monthCostUsd: 0,
        eventCount: 0,
        lastActiveAt: null,
    },
    {
        id: 'user-oth',
        userId: 'user-other',
        email: 'other@example.test',
        username: 'other-e2e',
        credits: 0,
        status: 'banned',
        createdAt: Date.now() - 30 * 86400000,
        monthCostUsd: 0,
        eventCount: 0,
        lastActiveAt: null,
    },
];

const CORS_HEADERS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

function json(route, body, status = 200) {
    return route.fulfill({
        status,
        contentType: 'application/json',
        headers: { ...CORS_HEADERS, 'cache-control': 'no-store' },
        body: JSON.stringify(body),
    });
}

function createState(options = {}) {
    return {
        // Only translate is explicitly pinned to the backend; the rest inherit
        // data env/config, so the source badges cover both branches.
        storedDefaults: options.storedDefaults || { translate: 60 },
        budgets: { userDailyUsd: 0.5, globalDailyUsd: 25 },
        overrides: {},
        usedToday: {
            translate: 12,
            summary: 3,
            define: 0,
            local_show: 2,
            quiz: 0,
            reading: 5,
            analysis: 0,
            course_generation: 0,
        },
        defaultsError: null,
        userGetError: null,
        userPutError: null,
        lastDefaultsBody: null,
        lastUserBody: null,
        lastUsersQuery: null,
        quotasGets: 0,
        userGets: 0,
    };
}

function defaultLimitOf(state, feature) {
    return state.storedDefaults[feature] !== undefined
        ? state.storedDefaults[feature]
        : ENV_DEFAULTS[feature];
}

function defaultsPayload(state) {
    return {
        features: FEATURES.map((feature) => ({
            feature,
            defaultLimit: defaultLimitOf(state, feature),
            source: state.storedDefaults[feature] !== undefined ? 'default' : 'config',
        })),
        budgets: state.budgets,
    };
}

function userPayload(state, userId) {
    const row = USERS.find((candidate) => candidate.userId === userId);
    assert.ok(row, `unknown fixture user ${userId}`);
    return {
        user: {
            id: row.userId,
            email: row.email,
            username: row.username,
            status: row.status,
        },
        features: FEATURES.map((feature) => {
            const override = state.overrides[feature];
            const defaultLimit = defaultLimitOf(state, feature);
            const effectiveLimit = override === undefined ? defaultLimit : override;
            const usedToday = state.usedToday[feature] || 0;
            return {
                feature,
                defaultLimit,
                overrideLimit: override === undefined ? null : override,
                effectiveLimit,
                usedToday,
                remaining: Math.max(0, effectiveLimit - usedToday),
                source: override !== undefined
                    ? 'user_override'
                    : state.storedDefaults[feature] !== undefined
                        ? 'default'
                        : 'config',
            };
        }),
    };
}

async function installStubs(context, options = {}) {
    const state = createState(options);

    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const path = url.pathname;
        const method = request.method();

        if (method === 'OPTIONS') {
            return route.fulfill({ status: 204, headers: CORS_HEADERS });
        }

        // ── session + app shell ──────────────────────────────────────────
        if (path === '/api/auth/me') {
            return json(route, { user: { ...ADMIN }, isAdmin: true, guest: false });
        }
        if (path === '/api/auth/registration') {
            return json(route, {
                registrationOpen: true,
                inviteSignupEnabled: true,
                inviteRequired: false,
                registrationClosed: false,
            });
        }
        if (path === '/api/auth/logout') return json(route, { ok: true });
        if (path === '/api/announcement') return json(route, { announcement: null });
        if (path === '/api/user/summary') {
            return json(route, {
                balanceMicroUsd: 0,
                balanceUsd: '0.00',
                availableMicroUsd: 0,
                availableUsd: '0.00',
                activeHoldsMicroUsd: 0,
                monthSpendUsd: 0,
                monthMinutes: 0,
                credits: 0,
            });
        }

        // ── daily quotas ─────────────────────────────────────────────────
        if (path === '/api/admin/quotas' && method === 'GET') {
            state.quotasGets += 1;
            return json(route, defaultsPayload(state));
        }
        if (path === '/api/admin/quotas/defaults' && method === 'PUT') {
            const body = request.postDataJSON() || {};
            state.lastDefaultsBody = body;
            if (state.defaultsError) {
                return json(route, { detail: 'mock defaults failure' }, state.defaultsError);
            }
            const changes = {};
            for (const [feature, value] of Object.entries(body.limits || {})) {
                const from = state.storedDefaults[feature] === undefined
                    ? null
                    : state.storedDefaults[feature];
                if (value === null) delete state.storedDefaults[feature];
                else state.storedDefaults[feature] = value;
                changes[feature] = { from, to: value };
            }
            return json(route, { ...defaultsPayload(state), changes });
        }
        const userQuotaMatch = path.match(/^\/api\/admin\/quotas\/users\/([^/]+)$/);
        if (userQuotaMatch) {
            const userId = decodeURIComponent(userQuotaMatch[1]);
            if (method === 'GET') {
                state.userGets += 1;
                if (state.userGetError) {
                    return json(route, { detail: 'mock user quota failure' }, state.userGetError);
                }
                return json(route, userPayload(state, userId));
            }
            if (method === 'PUT') {
                const body = request.postDataJSON() || {};
                state.lastUserBody = body;
                if (state.userPutError) {
                    return json(route, { detail: 'mock user quota write failure' }, state.userPutError);
                }
                const before = { ...state.overrides };
                for (const [feature, value] of Object.entries(body.overrides || {})) {
                    if (value === null) delete state.overrides[feature];
                    else state.overrides[feature] = value;
                }
                return json(route, {
                    ...userPayload(state, userId),
                    changes: Object.fromEntries(
                        Object.keys(body.overrides || {}).map((feature) => [
                            feature,
                            {
                                from: before[feature] === undefined ? null : before[feature],
                                to: body.overrides[feature],
                            },
                        ]),
                    ),
                });
            }
        }

        // ── admin console reads ───────────────────────────────────────────
        if (path === '/api/admin/stats') {
            return json(route, {
                users: { total: 2, new7d: 0, activeToday: 1, guests: 0 },
                ai: { todayCostUsd: 0, monthCostUsd: 0, todayCalls: 0, todayByFeature: {} },
                jobs: { failed: 0, running: 0, pendingRetry: 0 },
                generatedAt: new Date().toISOString(),
            });
        }
        if (path === '/api/admin/usage') {
            return json(route, {
                days: 7,
                start: '',
                end: '',
                rows: [],
                daysSummary: [],
                totals: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
            });
        }
        if (path === '/api/admin/health') {
            return json(route, {
                health: {
                    status: 'ok',
                    version: 'test',
                    db: { ok: true, migrations: { current: '0031', head: '0031' } },
                    uptimeSeconds: 1,
                    time: new Date().toISOString(),
                },
                disk: { dataDir: '/tmp', sizeBytes: 0 },
                failedJobs: [],
            });
        }
        if (path === '/api/admin/settings') {
            return json(route, { maintenance_mode: false, announcement: null });
        }
        if (path === '/api/admin/invites') {
            return json(route, {
                invites: [],
                total: 0,
                limit: 20,
                offset: 0,
                hasMore: false,
                status: 'all',
                counts: { active: 0, used: 0, expired: 0, revoked: 0 },
                config: {
                    registrationOpen: true,
                    inviteSignupEnabled: true,
                    inviteRequired: false,
                    registrationClosed: false,
                },
            });
        }
        if (path === '/api/admin/deletion-requests') {
            return json(route, {
                requests: [],
                total: 0,
                limit: 20,
                offset: 0,
                hasMore: false,
                serverTime: Date.now(),
            });
        }
        if (path === '/api/admin/audit') {
            return json(route, { entries: [], total: 0, limit: 20, offset: 0, hasMore: false });
        }
        if (path === '/api/admin/users' && method === 'GET') {
            const search = (url.searchParams.get('search') || '').toLowerCase();
            const limit = Number(url.searchParams.get('limit') || '20');
            state.lastUsersQuery = { search, limit };
            const matched = USERS.filter((user) => (
                !search
                || user.email.toLowerCase().includes(search)
                || (user.username || '').toLowerCase().includes(search)
            ));
            return json(route, {
                users: matched.slice(0, limit),
                total: matched.length,
                limit,
                offset: 0,
                hasMore: false,
            });
        }
        if (path === '/api/admin/billing/summary') {
            return json(route, {
                from: null,
                to: null,
                totals: {
                    billedCostMicroUsd: 0,
                    estimatedCostUsd: 0,
                    rows: 0,
                    calls: 0,
                    inputTokens: 0,
                    outputTokens: 0,
                    unbilledRows: 0,
                    legacyRows: 0,
                    settleFailedRows: 0,
                },
                byModel: [],
                byFeature: [],
                byDay: [],
                unpricedModels: [],
                currentUnpricedModels: [],
                holds: { activeCount: 0, activeMicroUsd: 0, activeUsd: '0.00' },
                balances: {
                    usersWithBalance: 0,
                    totalMicroUsd: 0,
                    totalUsd: '0.00',
                    ledgerDeltaMicroUsd: 0,
                },
                prices: [],
            });
        }

        // Every other auxiliary request just gets an empty JSON object.
        return json(route, {});
    });

    return state;
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

async function textOf(page, testId) {
    return page.locator(`[data-testid="${testId}"]`).first().innerText();
}

async function openQuotas(page) {
    await page.goto(`${BASE}/#/app/profile/admin`);
    await page.locator('[data-testid="admin-screen"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="admin-tab-quotas"]').click();
    await page.locator('[data-testid="admin-panel-quotas"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="admin-quota-defaults-table"]').waitFor({ timeout: 15000 });
}

async function pageOverflow(page) {
    return page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
}

async function selectLearner(page, { waitForTable = true } = {}) {
    const search = page.locator('[data-testid="admin-quota-user-search"]');
    await search.fill('learner');
    await page.locator('[data-testid="admin-quota-user-option"]').first().waitFor({ timeout: 15000 });
    await page.locator('[data-testid="admin-quota-user-option"]').first().click();
    if (waitForTable) {
        await page.locator('[data-testid="admin-quota-user-table"]').waitFor({ timeout: 15000 });
    }
}

/** Click a button that fires a PUT and wait for the mocked response. */
async function clickPut(page, testId, pathPart) {
    const responsePromise = page.waitForResponse(
        (response) => response.request().method() === 'PUT' && response.url().includes(pathPart),
        { timeout: 15000 },
    );
    await page.locator(`[data-testid="${testId}"]`).click();
    return responsePromise;
}

function defaultRow(page, index) {
    return page.locator('[data-testid="admin-quota-default-row"]').nth(index);
}

function overrideRow(page, index) {
    return page.locator('[data-testid="admin-quota-user-row"]').nth(index);
}

async function waitSaved(page, testId) {
    await page.locator(`[data-testid="${testId}"]`).waitFor({ timeout: 15000 });
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

async function main() {
    const browser = await launchBrowser();
    try {
        // ── A) tab + defaults table + read-only budgets ───────────────────
        await check('A: 额度 tab — 8 default rows, source badges, read-only budgets', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openQuotas(page);

            assert.equal(await textOf(page, 'admin-tab-quotas'), '额度');
            assert.equal(await page.locator('[data-testid="admin-quota-default-row"]').count(), 8);
            assert.equal(await page.locator('[data-testid="admin-quota-default-source"]').count(), 8);
            assert.match(await defaultRow(page, 0).innerText(), /翻译/);
            assert.match(await defaultRow(page, 0).innerText(), /后台默认/);
            assert.match(await defaultRow(page, 1).innerText(), /环境变量/);

            // Budgets are display-only: values render, zero inputs exist.
            assert.equal(await textOf(page, 'admin-quota-budget-user'), '$0.50');
            assert.equal(await textOf(page, 'admin-quota-budget-global'), '$25.00');
            assert.equal(
                await page.locator('[data-testid="admin-quota-budgets"] input').count(),
                0,
                'budget card must not expose an input',
            );
            assert.equal(
                await page.locator('[data-testid="admin-quota-defaults-save"]').isDisabled(),
                true,
            );
            assert.equal(state.quotasGets >= 1, true);

            await page.waitForTimeout(600);
            await page.screenshot({ path: `${SHOTS}/1440-quotas-defaults.png` });
            await context.close();
        });

        // ── B) only changed rows, 0=关闭, restore=null, refresh ───────────
        await check('B: defaults save only changed, 0=关闭, restore submits null, refresh re-reads', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openQuotas(page);

            const translate = defaultRow(page, 0);
            const input = translate.locator('[data-testid="admin-quota-default-input"]');
            assert.equal(await input.inputValue(), '60');
            await input.fill('70');
            assert.equal(
                await page.locator('[data-testid="admin-quota-defaults-dirty"]').count(),
                1,
                'dirty indicator after typing 70',
            );
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            await waitSaved(page, 'admin-quota-defaults-saved');
            assert.deepEqual(state.lastDefaultsBody, { limits: { translate: 70 } });
            assert.equal(await input.inputValue(), '70');
            assert.match(await translate.innerText(), /后台默认/);

            // 0 disables the feature and is never shown as a bare zero.
            await input.fill('0');
            assert.equal(
                await translate.locator('[data-testid="admin-quota-default-off"]').innerText(),
                '关闭',
            );
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            await waitSaved(page, 'admin-quota-defaults-saved');
            assert.deepEqual(state.lastDefaultsBody, { limits: { translate: 0 } });
            assert.equal(await input.inputValue(), '0');

            // Per-row restore → pending → save sends null → env value returns.
            await translate.locator('[data-testid="admin-quota-default-restore"]').click();
            assert.equal(
                await translate.locator('[data-testid="admin-quota-default-revert-pending"]').count(),
                1,
                'revert-pending marker after per-row restore',
            );
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            await waitSaved(page, 'admin-quota-defaults-saved');
            assert.deepEqual(state.lastDefaultsBody, { limits: { translate: null } });
            assert.equal(await input.inputValue(), '60');
            assert.match(await translate.innerText(), /环境变量/);

            // Console refresh re-reads the defaults table from the API.
            const getsBefore = state.quotasGets;
            await page.locator('[data-testid="admin-refresh"]').click();
            await page.waitForTimeout(400);
            assert.equal(state.quotasGets, getsBefore + 1, 'refresh re-reads GET /api/admin/quotas');
            assert.equal(await input.inputValue(), '60');

            await page.waitForTimeout(400);
            await page.screenshot({ path: `${SHOTS}/1440-quotas-defaults-saved.png` });
            await context.close();
        });

        // ── C) defaults errors stay inline and can retry ─────────────────
        await check('C: defaults 400/503 inline error keeps draft, retry succeeds', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openQuotas(page);

            const summary = defaultRow(page, 1);
            const input = summary.locator('[data-testid="admin-quota-default-input"]');
            await input.fill('31');

            state.defaultsError = 400;
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            const error = page.locator('[data-testid="admin-quota-defaults-error"]');
            await error.waitFor();
            assert.match(await error.innerText(), /400/);
            await page.screenshot({ path: `${SHOTS}/1440-quotas-defaults-error.png` });
            assert.equal(await input.inputValue(), '31');
            assert.equal(await page.locator('[data-testid="admin-quota-defaults-saved"]').count(), 0);

            state.defaultsError = 503;
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            await error.waitFor();
            assert.match(await error.innerText(), /503/);
            assert.equal(await input.inputValue(), '31');

            state.defaultsError = null;
            await clickPut(page, 'admin-quota-defaults-save', '/api/admin/quotas/defaults');
            await waitSaved(page, 'admin-quota-defaults-saved');
            assert.deepEqual(state.lastDefaultsBody, { limits: { summary: 31 } });
            await context.close();
        });

        // ── D) user search, overrides, required reason, clear ────────────
        await check('D: search (limit 8) → override 0/custom → clear with confirm', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openQuotas(page);

            await page.locator('[data-testid="admin-quota-user-search"]').fill('learner');
            await page.locator('[data-testid="admin-quota-user-option"]').first().waitFor();
            assert.deepEqual(state.lastUsersQuery, { search: 'learner', limit: 8 });
            assert.equal(await page.locator('[data-testid="admin-quota-user-option"]').count(), 1);
            await page.locator('[data-testid="admin-quota-user-option"]').first().click();
            await page.locator('[data-testid="admin-quota-user-table"]').waitFor();
            assert.equal(await page.locator('[data-testid="admin-quota-user-row"]').count(), 8);
            assert.equal(state.userGets, 1);
            assert.match(await textOf(page, 'admin-quota-user-selected'), /learner-e2e/);

            const translateRow = overrideRow(page, 0);
            const summaryRow = overrideRow(page, 1);
            assert.equal(
                await translateRow.locator('[data-testid="admin-quota-user-override"]').inputValue(),
                '',
            );
            await translateRow.locator('[data-testid="admin-quota-user-override"]').fill('0');
            await summaryRow.locator('[data-testid="admin-quota-user-override"]').fill('12');

            // Saving without a reason is refused client-side (backend would 400).
            await page.locator('[data-testid="admin-quota-user-save"]').click();
            const reasonError = page.locator('[data-testid="admin-quota-user-error"]');
            await reasonError.waitFor();
            assert.match(await reasonError.innerText(), /原因/);
            assert.equal(state.lastUserBody, null);

            await page.locator('[data-testid="admin-quota-user-reason"]').fill('客服补偿');
            await clickPut(page, 'admin-quota-user-save', '/api/admin/quotas/users/');
            await waitSaved(page, 'admin-quota-user-saved');
            assert.deepEqual(state.lastUserBody, {
                overrides: { translate: 0, summary: 12 },
                reason: '客服补偿',
            });
            assert.equal(
                await translateRow.locator('[data-testid="admin-quota-user-override-off"]').innerText(),
                '关闭',
            );
            assert.match(await translateRow.innerText(), /用户覆盖/);
            assert.equal(
                await translateRow.locator('[data-testid="admin-quota-user-effective"]').innerText(),
                '关闭',
            );
            assert.equal(
                await summaryRow.locator('[data-testid="admin-quota-user-effective"]').innerText(),
                '12',
            );

            // Clearing asks first, then submits null for every existing override.
            // The reason field was cleared after the successful save; re-enter it.
            await page.locator('[data-testid="admin-quota-user-reason"]').fill('清理测试覆盖');
            await page.locator('[data-testid="admin-quota-user-clear"]').click();
            const confirm = page.locator('[data-testid="admin-quota-clear-confirm"]');
            await confirm.waitFor();
            assert.match(await confirm.innerText(), /2/);
            await clickPut(page, 'admin-quota-clear-confirm-confirm', '/api/admin/quotas/users/');
            await page
                .locator('[data-testid="admin-quota-user-saved"]', { hasText: '已清除覆盖' })
                .waitFor();
            await page
                .locator('[data-testid="admin-quota-clear-confirm"]')
                .waitFor({ state: 'detached' });
            assert.deepEqual(state.lastUserBody, {
                overrides: { translate: null, summary: null },
                reason: '清理测试覆盖',
            });
            assert.equal(
                await translateRow.locator('[data-testid="admin-quota-user-override"]').inputValue(),
                '',
            );
            // translate still has a stored default (60), so clearing the
            // override falls back to the 后台默认 layer, not env.
            assert.match(await translateRow.innerText(), /后台默认/);
            assert.equal(
                await translateRow.locator('[data-testid="admin-quota-user-effective"]').innerText(),
                '60',
            );
            assert.equal(
                await page.locator('[data-testid="admin-quota-user-saved"]').innerText(),
                '已清除覆盖，恢复继承默认',
            );

            await page.locator('[data-testid="admin-quota-user-card"]').scrollIntoViewIfNeeded();
            await page.waitForTimeout(400);
            await page.screenshot({ path: `${SHOTS}/1440-quotas-user.png` });
            await context.close();
        });

        // ── E) user quota inline errors ──────────────────────────────────
        await check('E: user GET 404/503 and PUT 400/404/503 inline errors keep draft', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openQuotas(page);

            state.userGetError = 404;
            await selectLearner(page, { waitForTable: false });
            const loadError = page.locator('[data-testid="admin-quota-user-load-error"]');
            await loadError.waitFor();
            assert.match(await loadError.innerText(), /404/);
            assert.equal(await page.locator('[data-testid="admin-quota-user-table"]').count(), 0);

            state.userGetError = 503;
            await page.locator('[data-testid="admin-quota-user-retry"]').click();
            await loadError.waitFor();
            assert.match(await loadError.innerText(), /503/);

            state.userGetError = null;
            await page.locator('[data-testid="admin-quota-user-retry"]').click();
            await page.locator('[data-testid="admin-quota-user-table"]').waitFor();

            const translateRow = overrideRow(page, 0);
            await translateRow.locator('[data-testid="admin-quota-user-override"]').fill('5');
            await page.locator('[data-testid="admin-quota-user-reason"]').fill('临时提额');

            for (const status of [400, 404, 503]) {
                state.userPutError = status;
                await clickPut(page, 'admin-quota-user-save', '/api/admin/quotas/users/');
                const writeError = page.locator('[data-testid="admin-quota-user-error"]');
                await writeError.waitFor();
                assert.match(await writeError.innerText(), new RegExp(String(status)));
                if (status === 503) {
                    await page.screenshot({ path: `${SHOTS}/1440-quotas-user-error.png` });
                }
                assert.equal(
                    await translateRow.locator('[data-testid="admin-quota-user-override"]').inputValue(),
                    '5',
                    `draft kept after ${status}`,
                );
            }

            state.userPutError = null;
            await clickPut(page, 'admin-quota-user-save', '/api/admin/quotas/users/');
            await waitSaved(page, 'admin-quota-user-saved');
            assert.deepEqual(state.lastUserBody, {
                overrides: { translate: 5 },
                reason: '临时提额',
            });
            await context.close();
        });

        // ── F) 375 layout + 1440 screenshot + vi-VN copy ─────────────────
        await check('F: 375 no page overflow + table scrolls; vi-VN has no Chinese', async () => {
            const mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
            await installStubs(mobile);
            const mobilePage = await mobile.newPage();
            await openQuotas(mobilePage);

            assert.ok(
                (await pageOverflow(mobilePage)) <= 1,
                `375 page overflow ${await pageOverflow(mobilePage)}px`,
            );
            const defaultsScrolls = await mobilePage.evaluate(() => {
                const table = document.querySelector('[data-testid="admin-quota-defaults-table"]');
                const wrapper = table?.parentElement;
                return Boolean(wrapper && wrapper.scrollWidth > wrapper.clientWidth);
            });
            assert.equal(defaultsScrolls, true, '375 defaults table should scroll inside its wrapper');

            await selectLearner(mobilePage);
            const userScrolls = await mobilePage.evaluate(() => {
                const table = document.querySelector('[data-testid="admin-quota-user-table"]');
                const wrapper = table?.parentElement;
                return Boolean(wrapper && wrapper.scrollWidth > wrapper.clientWidth);
            });
            assert.equal(userScrolls, true, '375 user table should scroll inside its wrapper');
            assert.ok((await pageOverflow(mobilePage)) <= 1);
            await mobilePage.locator('[data-testid="admin-screen"]').evaluate((el) => {
                el.scrollTo(0, 0);
            });
            await mobilePage.waitForTimeout(600);
            await mobilePage.screenshot({ path: `${SHOTS}/375-quotas-top.png` });
            await mobilePage.locator('[data-testid="admin-quota-user-card"]').scrollIntoViewIfNeeded();
            await mobilePage.waitForTimeout(300);
            await mobilePage.screenshot({ path: `${SHOTS}/375-quotas-user.png` });
            await mobile.close();

            const vi = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            await vi.addInitScript(() => {
                window.localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
            });
            await installStubs(vi);
            const viPage = await vi.newPage();
            await openQuotas(viPage);
            assert.equal(await textOf(viPage, 'admin-tab-quotas'), 'Hạn mức');
            const panelText = await viPage.locator('[data-testid="admin-panel-quotas"]').innerText();
            assert.match(panelText, /Hạn mức hàng ngày/);
            assert.equal(
                /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(panelText),
                false,
                'vi-VN panel must not contain Chinese characters',
            );
            await viPage.waitForTimeout(600);
            await viPage.screenshot({ path: `${SHOTS}/1440-quotas-vi.png` });
            await vi.close();
        });
    } finally {
        await browser.close();
    }

    console.log(`\n${assertionsPassed} assertions passed across ${checks} checks.`);
    if (failures.length > 0) {
        console.error(`\n${failures.length} check(s) failed.`);
        process.exitCode = 1;
    } else {
        console.log('admin quota acceptance: PASS');
    }
}
