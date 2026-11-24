#!/usr/bin/env node
// Browser acceptance for P2-42 / specs/048 — feedback inbox in the admin console.
//
// Runs the real React console in Chromium against a stubbed backend (the
// backend contract itself is covered by backend/tests/test_feedback.py).
// Verified here:
//   A) new 「反馈」 tab, default open filter, list columns (status / category /
//      message / user-or-guest / requestId / page / time), user vs guest rows,
//      count footer, and the 0033 "no page column" hint;
//   B) filter open / resolved / all each re-read `GET /api/admin/feedback` with
//      `status` + `limit=50`; in_progress/closed rows appear under `all`; the
//      "only the latest N" note appears when the filtered total exceeds the page;
//   C) row expansion → status open→resolved + admin note → PATCH body, saved
//      notice, list re-read and the row moving from the open to the resolved
//      filter; the saved values are visible when reopened;
//   D) note-only save on an in_progress row (no status in the PATCH body, the
//      status hint explains the blank editor) and clearing a note sends `null`;
//   E) load 503 inline error with retry, save 400/404/503 inline errors that
//      keep the draft, then a successful save;
//   F) 1440 / 375 layout (no page-level horizontal overflow, the table owns its
//      scroll) and vi-VN copy with no Chinese text.
//
// Screenshots: /tmp/admin-feedback-shots/
// Run: APP_URL=http://127.0.0.1:5173 node scripts/admin-feedback-acceptance.mjs
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
const SHOTS = '/tmp/admin-feedback-shots';
mkdirSync(SHOTS, { recursive: true });

const ADMIN = {
    id: 'admin-e2e',
    email: 'admin@example.test',
    username: 'admin-e2e',
    credits: 0,
    status: 'active',
};

const HOUR = 3600 * 1000;
const MIN = 60 * 1000;
const NOW = Date.now();

/** Newest first, mirroring `ORDER BY created_at_ms DESC, id DESC`. */
const BASE_FEEDBACK = [
    {
        id: 102,
        userId: null,
        requestId: null,
        category: 'content',
        message: '这一集的字幕把「gonna」翻译成了「去看看」，整句意思都变了。',
        contact: null,
        status: 'open',
        createdAt: NOW - 30 * MIN,
        resolvedAt: null,
        adminNote: null,
    },
    {
        id: 101,
        userId: 'user-9f8e7d6c5b4a3210',
        requestId: 'fb-101-4f0e9a2b',
        category: 'bug',
        message: '点击「精背」后一直转圈，刷新也没用。复现步骤：打开视频 → 精背 → 第 3 句。',
        contact: 'tg:@learner',
        status: 'open',
        createdAt: NOW - 2 * HOUR,
        resolvedAt: null,
        adminNote: null,
    },
    {
        id: 104,
        userId: null,
        requestId: 'fb-104-aa11bb22',
        category: 'other',
        message: '游客反馈：切换语言后部分文案没有跟着变。',
        contact: null,
        status: 'in_progress',
        createdAt: NOW - 5 * HOUR,
        resolvedAt: null,
        adminNote: null,
    },
    {
        id: 103,
        userId: 'user-1a2b3c4d5e6f7788',
        requestId: 'fb-103-91c2d3e4',
        category: 'feature',
        message: '希望支持把精背卡片导出成 Anki 牌组。',
        contact: 'learner@example.test',
        status: 'resolved',
        createdAt: NOW - 26 * HOUR,
        resolvedAt: NOW - 20 * HOUR,
        adminNote: '已记录，排期到下个版本。',
    },
    {
        id: 105,
        userId: 'user-4d5e6f7a8b9c0011',
        requestId: 'fb-105-zz99yy88',
        category: 'bug',
        message: '很久以前的问题，已随版本修复。',
        contact: null,
        status: 'closed',
        createdAt: NOW - 48 * HOUR,
        resolvedAt: NOW - 30 * HOUR,
        adminNote: '旧版本问题',
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

function createState() {
    return {
        items: BASE_FEEDBACK.map((row) => ({ ...row })),
        requests: [],
        patches: [],
        listError: null,
        patchError: null,
        /** Simulates a filtered total larger than one page (no offset API). */
        totalOverride: null,
    };
}

function sortedItems(state) {
    return [...state.items].sort(
        (left, right) => right.createdAt - left.createdAt || right.id - left.id,
    );
}

function listPayload(state, status, limit) {
    const filtered = status && status !== 'all'
        ? sortedItems(state).filter((row) => row.status === status)
        : sortedItems(state);
    return {
        items: filtered.slice(0, limit),
        total: state.totalOverride ?? filtered.length,
        limit,
        status: status && status !== 'all' ? status : null,
    };
}

async function installStubs(context) {
    const state = createState();

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

        // ── feedback inbox ───────────────────────────────────────────────
        if (path === '/api/admin/feedback' && method === 'GET') {
            const status = url.searchParams.get('status');
            const limit = Number(url.searchParams.get('limit') || '50');
            state.requests.push({ status, limit });
            if (state.listError) {
                return json(route, { detail: 'mock feedback list failure' }, state.listError);
            }
            return json(route, listPayload(state, status, limit));
        }
        const patchMatch = path.match(/^\/api\/admin\/feedback\/(\d+)$/);
        if (patchMatch && method === 'PATCH') {
            const id = Number(patchMatch[1]);
            const body = request.postDataJSON() || {};
            state.patches.push({ id, body });
            if (state.patchError) {
                return json(route, { detail: 'mock feedback update failure' }, state.patchError);
            }
            const row = state.items.find((candidate) => candidate.id === id);
            if (!row) return json(route, { detail: '反馈不存在' }, 404);
            if (!('status' in body) && !('adminNote' in body)) {
                return json(route, { detail: '请至少提供 status 或 adminNote。' }, 400);
            }
            if ('status' in body) {
                if (!['open', 'in_progress', 'resolved', 'closed'].includes(body.status)) {
                    return json(route, { detail: '不支持的处理状态' }, 400);
                }
                const wasTerminal = row.status === 'resolved' || row.status === 'closed';
                const isTerminal = body.status === 'resolved' || body.status === 'closed';
                if (isTerminal && !wasTerminal) row.resolvedAt = Date.now();
                else if (!isTerminal) row.resolvedAt = null;
                row.status = body.status;
            }
            if ('adminNote' in body) {
                if (body.adminNote !== null && typeof body.adminNote !== 'string') {
                    return json(route, { detail: '备注不合法' }, 400);
                }
                row.adminNote = body.adminNote;
            }
            return json(route, { ...row });
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
                    db: { ok: true, migrations: { current: '0033', head: '0033' } },
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
        if (path === '/api/admin/users') {
            return json(route, { users: [], total: 0, limit: 20, offset: 0, hasMore: false });
        }
        if (path === '/api/admin/quotas') {
            return json(route, { features: [], budgets: { userDailyUsd: 0, globalDailyUsd: 0 } });
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

async function openFeedback(page) {
    await page.goto(`${BASE}/#/app/profile/admin`);
    await page.locator('[data-testid="admin-screen"]').waitFor({ timeout: 20000 });
    await page.locator('[data-testid="admin-tab-feedback"]').click();
    await page.locator('[data-testid="admin-panel-feedback"]').waitFor({ timeout: 15000 });
    await page.locator('[data-testid="admin-feedback-card"]').waitFor({ timeout: 15000 });
}

async function pageOverflow(page) {
    return page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
}

function feedbackRow(page, id) {
    return page.locator(`[data-testid="admin-feedback-row"][data-row-id="${id}"]`);
}

async function clickFilter(page, value) {
    const selector = `[data-testid="admin-feedback-filter-${value}"]`;
    await page.locator(selector).click();
    await page.waitForFunction(
        (sel) => document.querySelector(sel)?.getAttribute('aria-checked') === 'true',
        selector,
        { timeout: 10000 },
    );
}

async function waitRows(page, count) {
    await page.waitForFunction(
        (expected) => document.querySelectorAll('[data-testid="admin-feedback-row"]').length === expected,
        count,
        { timeout: 15000 },
    );
}

async function expandRow(page, id) {
    await feedbackRow(page, id).locator('[data-testid="admin-feedback-toggle"]').click();
    await page.locator('[data-testid="admin-feedback-detail"]').waitFor({ timeout: 10000 });
}

/** Click a save button and wait for the mocked PATCH response. */
async function clickSave(page) {
    const responsePromise = page.waitForResponse(
        (response) => response.request().method() === 'PATCH'
            && response.url().includes('/api/admin/feedback/'),
        { timeout: 15000 },
    );
    await page.locator('[data-testid="admin-feedback-save"]').click();
    return responsePromise;
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

async function main() {
    const browser = await launchBrowser();
    try {
        // ── A) tab + default open filter + list columns ──────────────────
        await check('A: 反馈 tab, open filter, list columns, user vs guest', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openFeedback(page);

            assert.equal(await textOf(page, 'admin-tab-feedback'), '反馈');
            assert.equal(
                await page.locator('[data-testid="admin-feedback-filter-open"]').getAttribute('aria-checked'),
                'true',
                'open is the default filter',
            );
            await waitRows(page, 2);
            assert.deepEqual(state.requests[0], { status: 'open', limit: 50 });

            const guest = feedbackRow(page, 102);
            assert.match(await guest.innerText(), /游客/);
            assert.match(await guest.innerText(), /内容问题/);
            assert.match(await guest.innerText(), /gonna/);
            assert.equal(await guest.locator('[data-testid="admin-feedback-request-id"]').innerText(), '无编号');
            assert.equal(await guest.locator('[data-testid="admin-feedback-page"]').innerText(), '未记录');
            assert.equal(await guest.locator('[data-testid="admin-feedback-status"]').innerText(), '待处理');

            const userRow = feedbackRow(page, 101);
            assert.match(await userRow.innerText(), /用户/);
            assert.match(await userRow.innerText(), /user-9f8/);
            assert.match(await userRow.innerText(), /功能异常/);
            assert.equal(
                await userRow.locator('[data-testid="admin-feedback-request-id"]').innerText(),
                'fb-101-4f0e9a2b',
            );
            assert.equal(
                await userRow.locator('[data-testid="admin-feedback-page"]').innerText(),
                '未记录',
            );
            assert.match(
                await userRow.locator('[data-testid="admin-feedback-time"]').innerText(),
                /\d/,
                'submitted time is localized and non-empty',
            );

            assert.equal(await textOf(page, 'admin-feedback-count'), '显示 2 条，共 2 条');
            assert.match(await textOf(page, 'admin-feedback-card'), /数据表没有该列/);

            await page.screenshot({ path: `${SHOTS}/1440-feedback-list.png` });
            await context.close();
        });

        // ── B) filters open/resolved/all + limit note ────────────────────
        await check('B: open/resolved/all refetch with status+limit, other statuses under all', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openFeedback(page);
            await waitRows(page, 2);

            await clickFilter(page, 'resolved');
            await waitRows(page, 1);
            const resolvedRow = page.locator('[data-testid="admin-feedback-row"]').first();
            assert.match(await resolvedRow.innerText(), /已处理/);
            assert.match(await resolvedRow.innerText(), /功能建议/);
            assert.equal(await textOf(page, 'admin-feedback-count'), '显示 1 条，共 1 条');

            await clickFilter(page, 'all');
            await waitRows(page, 5);
            const allText = await page.locator('[data-testid="admin-feedback-table"]').innerText();
            assert.match(allText, /处理中/);
            assert.match(allText, /已关闭/);
            assert.match(allText, /游客/);
            assert.equal(await textOf(page, 'admin-feedback-count'), '显示 5 条，共 5 条');

            await clickFilter(page, 'open');
            await waitRows(page, 2);

            // Dev StrictMode mounts the panel effect twice, so the initial
            // filter can be read twice; assert the tail instead of the exact list.
            const statuses = state.requests.map((entry) => entry.status);
            assert.equal(statuses[0], 'open');
            assert.deepEqual(statuses.slice(-3), ['resolved', 'all', 'open']);
            assert.equal(
                statuses.every((status) => ['open', 'resolved', 'all'].includes(status)),
                true,
            );
            assert.equal(state.requests.every((entry) => entry.limit === 50), true);

            // Filtered total > page size (the API has no offset) → hint appears.
            state.totalOverride = 120;
            await page.locator('[data-testid="admin-feedback-refresh"]').click();
            await page.locator('[data-testid="admin-feedback-limit-note"]').waitFor();
            assert.equal(await textOf(page, 'admin-feedback-count'), '显示 2 条，共 120 条');
            assert.match(
                await textOf(page, 'admin-feedback-limit-note'),
                /最近 50 条/,
            );
            await context.close();
        });

        // ── C) resolve + note, list re-read, values survive reopen ───────
        await check('C: resolve open row with note → PATCH body, saved notice, row moves filter', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openFeedback(page);
            await waitRows(page, 2);

            await expandRow(page, 101);
            const detail = page.locator('[data-testid="admin-feedback-detail"]');
            assert.match(await detail.innerText(), /复现步骤/);
            assert.match(await detail.innerText(), /tg:@learner/);
            assert.match(await detail.innerText(), /user-9f8e7d6c5b4a3210/);
            assert.equal(
                await page.locator('[data-testid="admin-feedback-status-editor"] [role="radio"][aria-checked="true"]').innerText(),
                '待处理',
                'open row starts with open selected',
            );
            assert.equal(
                await page.locator('[data-testid="admin-feedback-save"]').isDisabled(),
                true,
                'save disabled until a draft changes',
            );
            assert.equal(
                await page.locator('[data-testid="admin-feedback-status-hint"]').count(),
                0,
            );

            await page.locator('[data-testid="admin-feedback-status-resolved"]').click();
            await page.locator('[data-testid="admin-feedback-note"]').fill('已确认是回归，修复中。');
            assert.equal(await page.locator('[data-testid="admin-feedback-dirty"]').count(), 1);
            assert.equal(await page.locator('[data-testid="admin-feedback-save"]').isDisabled(), false);
            await page.locator('[data-testid="admin-feedback-detail"]').evaluate((el) => {
                el.scrollIntoView({ block: 'center' });
            });
            await page.waitForTimeout(300);
            await page.screenshot({ path: `${SHOTS}/1440-feedback-detail.png` });

            await clickSave(page);
            await page.locator('[data-testid="admin-feedback-saved"]').waitFor({ timeout: 15000 });
            assert.deepEqual(state.patches[0], {
                id: 101,
                body: { status: 'resolved', adminNote: '已确认是回归，修复中。' },
            });
            assert.match(await textOf(page, 'admin-feedback-saved'), /#101/);
            // The refresh after saving drops the row from the open filter.
            await waitRows(page, 1);
            assert.equal(await feedbackRow(page, 101).count(), 0);
            assert.equal(await textOf(page, 'admin-feedback-count'), '显示 1 条，共 1 条');

            // Reopen from the resolved filter: both values persisted.
            await clickFilter(page, 'resolved');
            await waitRows(page, 2);
            await expandRow(page, 101);
            assert.equal(
                await page.locator('[data-testid="admin-feedback-status-editor"] [role="radio"][aria-checked="true"]').innerText(),
                '已处理',
            );
            assert.equal(
                await page.locator('[data-testid="admin-feedback-note"]').inputValue(),
                '已确认是回归，修复中。',
            );
            await context.close();
        });

        // ── D) note-only save (in_progress) + clearing a note ────────────
        await check('D: note-only PATCH on in_progress row; clearing sends null', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openFeedback(page);
            await clickFilter(page, 'all');
            await waitRows(page, 5);

            await expandRow(page, 104);
            assert.equal(
                await page.locator('[data-testid="admin-feedback-status-editor"] [role="radio"][aria-checked="true"]').count(),
                0,
                'in_progress row has no preselectable binary status',
            );
            assert.match(await textOf(page, 'admin-feedback-status-hint'), /处理中/);
            await page.locator('[data-testid="admin-feedback-note"]').fill('后台已转处理中');
            assert.equal(
                await textOf(page, 'admin-feedback-note-count'),
                '7 / 2000 字',
            );
            await clickSave(page);
            await page.locator('[data-testid="admin-feedback-saved"]').waitFor();
            assert.deepEqual(state.patches[0], { id: 104, body: { adminNote: '后台已转处理中' } });
            assert.equal(
                state.items.find((row) => row.id === 104)?.status,
                'in_progress',
                'note-only save must not rewrite the status',
            );

            await expandRow(page, 103);
            assert.equal(
                await page.locator('[data-testid="admin-feedback-note"]').inputValue(),
                '已记录，排期到下个版本。',
            );
            await page.locator('[data-testid="admin-feedback-note"]').fill('');
            assert.equal(await page.locator('[data-testid="admin-feedback-save"]').isDisabled(), false);
            await clickSave(page);
            await page.locator('[data-testid="admin-feedback-saved"]').waitFor();
            assert.deepEqual(state.patches[1], { id: 103, body: { adminNote: null } });
            assert.equal(state.items.find((row) => row.id === 103)?.adminNote, null);
            await context.close();
        });

        // ── E) load + save errors stay inline and retryable ──────────────
        await check('E: GET 503 retry; PATCH 400/404/503 keep draft; retry succeeds', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            state.listError = 503;
            const page = await context.newPage();
            await openFeedback(page);

            const loadError = page.locator('[data-testid="admin-feedback-load-error"]');
            await loadError.waitFor({ timeout: 15000 });
            assert.match(await loadError.innerText(), /数据表未就绪/);
            assert.equal(await page.locator('[data-testid="admin-feedback-table"]').count(), 0);
            assert.equal(await page.locator('[data-testid="admin-feedback-empty"]').count(), 0);
            await page.screenshot({ path: `${SHOTS}/1440-feedback-load-error.png` });

            state.listError = null;
            await page.locator('[data-testid="admin-feedback-load-error-retry"]').click();
            await waitRows(page, 2);
            assert.equal(await loadError.count(), 0);

            await expandRow(page, 101);
            await page.locator('[data-testid="admin-feedback-note"]').fill('回归备注');
            for (const [status, pattern] of [[400, /不合法/], [404, /不存在/], [503, /暂不可用/]]) {
                state.patchError = status;
                await clickSave(page);
                const saveError = page.locator('[data-testid="admin-feedback-error"]');
                await saveError.waitFor();
                assert.match(await saveError.innerText(), pattern);
                assert.equal(
                    await page.locator('[data-testid="admin-feedback-note"]').inputValue(),
                    '回归备注',
                    `draft kept after ${status}`,
                );
                if (status === 503) {
                    await page.screenshot({ path: `${SHOTS}/1440-feedback-save-error.png` });
                }
            }

            state.patchError = null;
            await clickSave(page);
            await page.locator('[data-testid="admin-feedback-saved"]').waitFor();
            assert.deepEqual(state.patches.at(-1), { id: 101, body: { adminNote: '回归备注' } });
            await context.close();
        });

        // ── F) empty state switches filter; 1440/375 layout; vi-VN copy ──
        await check('F: empty state → 全部; 1440/375 no page overflow; vi-VN no Chinese', async () => {
            const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            const state = await installStubs(context);
            const page = await context.newPage();
            await openFeedback(page);
            await waitRows(page, 2);

            assert.ok((await pageOverflow(page)) <= 1, '1440 no page overflow');

            // Empty open filter: resolve both open rows, then the real heading +
            // one next action render (never an error as an empty state).
            await expandRow(page, 102);
            await page.locator('[data-testid="admin-feedback-note"]').fill('游客内容问题');
            await page.locator('[data-testid="admin-feedback-status-resolved"]').click();
            await clickSave(page);
            await waitRows(page, 1);

            await expandRow(page, 101);
            await page.locator('[data-testid="admin-feedback-status-resolved"]').click();
            await clickSave(page);
            await waitRows(page, 0);
            const empty = page.locator('[data-testid="admin-feedback-empty"]');
            await empty.waitFor();
            assert.match(await empty.innerText(), /没有待处理的反馈/);
            await page.screenshot({ path: `${SHOTS}/1440-feedback-empty.png` });

            await page.locator('[data-testid="admin-feedback-empty-show-all"]').click();
            await waitRows(page, 5);
            assert.equal(await page.locator('[data-testid="admin-feedback-empty"]').count(), 0);
            await context.close();

            const mobile = await browser.newContext({ viewport: { width: 375, height: 812 } });
            await installStubs(mobile);
            const mobilePage = await mobile.newPage();
            await openFeedback(mobilePage);
            await waitRows(mobilePage, 2);
            assert.ok(
                (await pageOverflow(mobilePage)) <= 1,
                `375 page overflow ${await pageOverflow(mobilePage)}px`,
            );
            const tableScrolls = await mobilePage.evaluate(() => {
                const table = document.querySelector('[data-testid="admin-feedback-table"]');
                const wrapper = table?.parentElement;
                return Boolean(wrapper && wrapper.scrollWidth > wrapper.clientWidth);
            });
            assert.equal(tableScrolls, true, '375 table scrolls inside its wrapper');
            await mobilePage.screenshot({ path: `${SHOTS}/375-feedback-list.png` });
            await mobile.close();

            const vi = await browser.newContext({ viewport: { width: 1440, height: 900 } });
            await vi.addInitScript(() => {
                window.localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
            });
            await installStubs(vi);
            const viPage = await vi.newPage();
            await openFeedback(viPage);
            await waitRows(viPage, 2);
            assert.equal(await textOf(viPage, 'admin-tab-feedback'), 'Phản hồi');
            const panelText = await viPage.locator('[data-testid="admin-panel-feedback"]').innerText();
            assert.match(panelText, /Phản hồi và báo lỗi/);
            // User-submitted bodies keep their own language (a Chinese learner's
            // report is data, not UI copy), so strip the message cells before
            // checking that the chrome itself has no Chinese characters.
            const messageTexts = await viPage
                .locator('[data-testid="admin-feedback-message"]')
                .allInnerTexts();
            let chromeText = panelText;
            for (const text of messageTexts) chromeText = chromeText.split(text).join('');
            assert.equal(
                /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(chromeText),
                false,
                'vi-VN panel chrome must not contain Chinese characters',
            );
            // The shared tab indicator springs from the previous tab; let it settle.
            await viPage.waitForTimeout(700);
            await viPage.screenshot({ path: `${SHOTS}/1440-feedback-vi.png` });
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
        console.log('admin feedback acceptance: PASS');
    }
}
