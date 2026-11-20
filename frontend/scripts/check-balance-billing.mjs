#!/usr/bin/env node
// Browser acceptance for M3b — balance / AI-cost frontend (specs/034).
//
// Runs the real React UI in Chromium against a stubbed backend (the M3a
// backend contract itself is covered by backend/tests/test_balance_billing.py).
// Verified here:
//   a) account balance card: available / book / active holds / month AI spend
//      / legacy credits, the $2 intro + "contact admin" + no-withdrawal copy;
//   b) zero balance, overrun (negative) and exact µUSD formatting;
//   c) 402 on an AI call: readable shortfall banner + account-page entry,
//      no logout, no 401 flow, no "server error";
//   d) 429 keeps the quota copy and does not show the 402 banner;
//   e) admin users list balance + legacy marker; adjust dialog validation,
//      credit, debit, 400/402/409 readable errors, refresh of list + ledger;
//   f) ledger shows time/kind/amount/balance-after/reason/operator, never the
//      idempotency key;
//   g) billing summary: range query, billed µUSD/USD, tokens, unbilled/legacy/
//      settle_failed, holds, balances reconciliation, unpriced model notice,
//      price table;
//   h) 375 / 1440 no page-level horizontal overflow; zh-CN / vi-VN copy.
//
// Screenshots: /tmp/balance-billing-shots/
// Run: APP_URL=http://127.0.0.1:5173 npm run check:balance
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
const SHOTS = '/tmp/balance-billing-shots';
mkdirSync(SHOTS, { recursive: true });

const YOUTUBE_URL = 'https://www.youtube.com/watch?v=balance-billing-e2e';
const DAY = 24 * 60 * 60 * 1000;

const ACTIVE_USER = {
  id: 'user-e2e',
  email: 'learner@example.test',
  username: 'learner-e2e',
  credits: 12,
  status: 'active',
};
const ADMIN_USER = {
  id: 'admin-e2e',
  email: 'admin@example.test',
  username: 'admin-e2e',
  credits: 0,
  status: 'active',
};

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

function accountSummary(mode) {
  if (mode === 'zero') {
    return {
      user: { ...ACTIVE_USER, memberSince: Date.now() - 90 * DAY },
      balanceMicroUsd: 0,
      balanceUsd: '0.00',
      availableMicroUsd: 0,
      availableUsd: '0.00',
      activeHoldsMicroUsd: 0,
      creditsLegacy: 0,
      monthSpendUsd: 0,
      usageToday: { minutes: 0 },
      version: 'e2e',
      preliminary: false,
    };
  }
  if (mode === 'negative') {
    return {
      user: { ...ACTIVE_USER, memberSince: Date.now() - 90 * DAY },
      balanceMicroUsd: -500000,
      balanceUsd: '-0.50',
      availableMicroUsd: -500000,
      availableUsd: '-0.50',
      activeHoldsMicroUsd: 0,
      creditsLegacy: 12,
      monthSpendUsd: 0.00372,
      usageToday: { minutes: 12.5 },
      version: 'e2e',
      preliminary: false,
    };
  }
  return {
    user: { ...ACTIVE_USER, memberSince: Date.now() - 90 * DAY },
    balanceMicroUsd: 2000000,
    balanceUsd: '2.00',
    availableMicroUsd: 1850000,
    availableUsd: '1.85',
    activeHoldsMicroUsd: 150000,
    creditsLegacy: 12,
    monthSpendUsd: 0.00372,
    usageToday: { minutes: 12.5 },
    version: 'e2e',
    preliminary: false,
  };
}

function makeSummary(from, to) {
  return {
    from: from ?? null,
    to: to ?? null,
    totals: {
      rows: 42,
      calls: 40,
      inputTokens: 120000,
      outputTokens: 30000,
      billedCostMicroUsd: 30210,
      billedCostUsd: '0.03021',
      estimatedCostUsd: 0.0372,
      unbilledRows: 3,
      legacyRows: 2,
      settleFailedRows: 1,
    },
    byDay: [
      { key: '2026-11-20', costMicroUsd: 30210, calls: 40, rows: 42, unbilledRows: 3 },
      { key: '2026-11-19', costMicroUsd: 0, calls: 0, rows: 2, unbilledRows: 2 },
    ],
    byModel: [
      {
        key: 'deepseek-chat',
        modelId: 'deepseek-chat',
        provider: 'DeepSeek',
        costMicroUsd: 30000,
        calls: 38,
        rows: 40,
        unbilledRows: 0,
      },
      {
        key: 'qwen-flash',
        modelId: 'qwen-flash',
        provider: 'Alibaba',
        costMicroUsd: 210,
        calls: 2,
        rows: 2,
        unbilledRows: 2,
      },
    ],
    byFeature: [
      { key: 'translate', costMicroUsd: 30000, calls: 38, rows: 40, unbilledRows: 1 },
      { key: 'define', costMicroUsd: 210, calls: 2, rows: 2, unbilledRows: 2 },
    ],
    unpricedModels: ['qwen-flash', 'gemini-3.5-flash-lite'],
    holds: { activeCount: 2, activeMicroUsd: 120000, activeUsd: '0.12' },
    balances: {
      usersWithBalance: 3,
      totalMicroUsd: 9000000,
      totalUsd: '9.00',
      ledgerDeltaMicroUsd: 9000000,
    },
    prices: [
      {
        modelId: 'deepseek-chat',
        provider: 'DeepSeek',
        inputMicroUsdPerMtok: 300000,
        outputMicroUsdPerMtok: 1200000,
        priceVersion: '2026-11-20.official.1',
        sourceKind: 'official_page',
        sourceRef: 'https://api-docs.deepseek.com/quick_start/pricing',
        verifiedAtMs: Date.now() - DAY,
      },
    ],
  };
}

function adminStats() {
  return {
    users: { total: 1, new7d: 1, activeToday: 1, guests: 0 },
    ai: { todayCostUsd: 0.03021, monthCostUsd: 0.03021, todayCalls: 40, todayByFeature: {} },
    jobs: { failed: 0, running: 0, pendingRetry: 0 },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Install the API double for one browser context.
 * `options.summaryMode`: positive | zero | negative.
 * `options.aiMode`: ok | insufficient | quota.
 */
async function installStubs(context, options = {}) {
  const now = Date.now();
  const state = {
    user: options.admin ? { ...ADMIN_USER } : { ...ACTIVE_USER },
    isAdmin: options.admin === true,
    summaryMode: options.summaryMode || 'positive',
    aiMode: options.aiMode || 'ok',
    logoutCalls: 0,
    lastAdjustBody: null,
    lastBillingQuery: null,
    lastLedgerQuery: null,
    nextAdjustError: null,
    ledger: [
      {
        id: 'bl-ai_settle-e2e',
        kind: 'ai_settle',
        deltaMicroUsd: -3720,
        deltaUsd: '-0.00372',
        balanceAfterMicroUsd: 1996280,
        balanceAfterUsd: '1.99628',
        refType: 'ai_usage',
        refId: 'au-secret-ref',
        reason: null,
        actorId: null,
        idempotencyKey: 'SECRET-KEY-AI-SETTLE',
        createdAtMs: now - 60 * 60 * 1000,
      },
      {
        id: 'bl-signup_bonus-user-e2e',
        kind: 'signup_bonus',
        deltaMicroUsd: 2000000,
        deltaUsd: '2.00',
        balanceAfterMicroUsd: 2000000,
        balanceAfterUsd: '2.00',
        refType: 'user',
        refId: 'user-e2e',
        reason: '内测赠送',
        actorId: null,
        idempotencyKey: 'SECRET-KEY-SIGNUP',
        createdAtMs: now - 2 * DAY,
      },
    ],
    users: [
      {
        id: 'user-e2e'.slice(0, 8),
        userId: 'user-e2e',
        email: 'learner@example.test',
        username: 'learner-e2e',
        credits: 12,
        balanceMicroUsd: 2000000,
        balanceUsd: '2.00',
        status: 'active',
        createdAt: now - 90 * DAY,
        monthCostUsd: 0.00372,
        eventCount: 5,
        lastActiveAt: now - 60 * 60 * 1000,
      },
      {
        id: 'user-other',
        userId: 'user-other',
        email: 'other@example.test',
        username: null,
        credits: 0,
        balanceMicroUsd: 0,
        balanceUsd: '0.00',
        status: 'banned',
        createdAt: now - 30 * DAY,
        monthCostUsd: 0,
        eventCount: 0,
        lastActiveAt: null,
      },
    ],
  };

  const balance = () => {
    const row = state.users[0];
    return {
      balanceMicroUsd: row.balanceMicroUsd,
      balanceUsd: row.balanceUsd,
      availableMicroUsd: row.balanceMicroUsd,
      availableUsd: row.balanceUsd,
      activeHoldsMicroUsd: 0,
    };
  };

  await context.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === 'POST' || method === 'PUT' || method === 'PATCH'
      ? request.postDataJSON() || {}
      : {};

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

    // ── session ──────────────────────────────────────────────────────────
    if (path === '/api/auth/me') return json(route, { user: state.user, isAdmin: state.isAdmin });
    if (path === '/api/auth/registration') {
      return json(route, {
        registrationOpen: true,
        inviteSignupEnabled: true,
        inviteRequired: false,
        registrationClosed: false,
      });
    }
    if (path === '/api/auth/logout') {
      state.logoutCalls += 1;
      return json(route, { ok: true });
    }

    // ── account page ─────────────────────────────────────────────────────
    if (path === '/api/user/summary') return json(route, accountSummary(state.summaryMode));
    if (path === '/api/account/deletion' && method === 'GET') {
      return json(route, {
        status: 'active',
        dueAt: null,
        deletion: null,
        cooldownDays: 7,
        backupRetentionDays: 30,
        notice: '7 天冷静期',
      });
    }
    if (path === '/api/account/exports') {
      return json(route, {
        jobs: [],
        limits: { per24h: 1, per30d: 3, ttlHours: 24, maxBytes: 200 * 1024 * 1024, concurrentJobs: 1 },
      });
    }

    // ── AI call behind the home composer: 402 / 429 / success ────────────
    if (path === '/api/process-video-stream' || path === '/api/process-video') {
      if (state.aiMode === 'insufficient') {
        return json(route, {
          detail: '余额不足，请联系管理员充值。（可用 0.02 USD，本次需要 0.01 USD）',
          code: 'insufficient_balance',
          balanceMicroUsd: 20000,
          availableMicroUsd: 20000,
          requiredMicroUsd: 10000,
          topup: 'admin',
        }, 402);
      }
      if (state.aiMode === 'insufficient-sse') {
        // Stream already started (HTTP 200): the backend can only signal the
        // shortfall through the SSE `error` event's stable `code`.
        const origin = request.headers().origin || BASE;
        const payload = JSON.stringify({
          detail: '余额不足，请联系管理员充值。',
          code: 'insufficient_balance',
          balanceMicroUsd: 20000,
          availableMicroUsd: 20000,
          requiredMicroUsd: 10000,
          topup: 'admin',
          targetLang: 'zh-CN',
        });
        return route.fulfill({
          status: 200,
          contentType: 'text/event-stream',
          headers: {
            'access-control-allow-origin': origin,
            'access-control-allow-credentials': 'true',
            'cache-control': 'no-store',
          },
          body: `event: error\ndata: ${payload}\n\n`,
        });
      }
      if (state.aiMode === 'quota') {
        return json(route, {
          detail: '今日 AI 额度已用完（翻译：已用 60/60，本次需 1），明天 0 点恢复；复习与本地词典不受影响。',
        }, 429, { 'retry-after': '3600' });
      }
      return json(route, {});
    }

    // ── admin: reads needed by every console tab ────────────────────────
    if (path === '/api/admin/stats') return json(route, adminStats());
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
          version: 'e2e',
          db: { ok: true, migrations: { current: '0025', head: '0025' } },
          uptimeSeconds: 1,
          time: new Date().toISOString(),
        },
        disk: { dataDir: '/tmp', sizeBytes: 0 },
        failedJobs: [],
      });
    }
    if (path === '/api/admin/settings') return json(route, { maintenance_mode: false, announcement: null });
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
      return json(route, { requests: [], total: 0, limit: 20, offset: 0, hasMore: false, serverTime: Date.now() });
    }
    if (path === '/api/admin/audit') {
      return json(route, { entries: [], total: 0, limit: 20, offset: 0, hasMore: false });
    }

    // ── admin: users list ────────────────────────────────────────────────
    if (path === '/api/admin/users' && method === 'GET') {
      return json(route, {
        users: state.users,
        total: state.users.length,
        limit: 20,
        offset: 0,
        hasMore: false,
      });
    }

    // ── admin: balance adjustment ────────────────────────────────────────
    if (/^\/api\/admin\/users\/[^/]+\/balance$/.test(path) && method === 'POST') {
      state.lastAdjustBody = body;
      if (state.nextAdjustError) {
        const error = state.nextAdjustError;
        state.nextAdjustError = null;
        return json(route, error.body, error.status);
      }
      if (typeof body.amountUsd !== 'string' || !/^\d+(\.\d{1,6})?$/.test(body.amountUsd)) {
        return json(route, { detail: '金额格式不正确。' }, 400);
      }
      const micro = Math.round(Number(body.amountUsd) * 1_000_000);
      const row = state.users[0];
      const debit = body.direction === 'debit';
      if (debit && micro > row.balanceMicroUsd) {
        return json(route, { detail: '扣减后余额会变成负数。' }, 400);
      }
      const delta = debit ? -micro : micro;
      row.balanceMicroUsd += delta;
      row.balanceUsd = formatRowsUsd(row.balanceMicroUsd);
      const entry = {
        id: `bl-manual-${state.ledger.length}`,
        kind: debit ? 'admin_deduct' : 'admin_topup',
        deltaMicroUsd: delta,
        deltaUsd: formatRowsUsd(delta),
        balanceAfterMicroUsd: row.balanceMicroUsd,
        balanceAfterUsd: row.balanceUsd,
        refType: 'manual',
        refId: null,
        reason: String(body.reason || ''),
        actorId: 'admin-e2e',
        idempotencyKey: body.idempotencyKey || null,
        createdAtMs: Date.now(),
      };
      state.ledger.unshift(entry);
      return json(route, {
        userId: row.userId,
        ledgerId: entry.id,
        kind: entry.kind,
        deltaMicroUsd: delta,
        replayed: false,
        ...balance(),
      });
    }

    // ── admin: ledger ────────────────────────────────────────────────────
    if (/^\/api\/admin\/users\/[^/]+\/ledger$/.test(path) && method === 'GET') {
      const limit = Number(url.searchParams.get('limit') || 50);
      const offset = Number(url.searchParams.get('offset') || 0);
      state.lastLedgerQuery = { limit, offset, userId: path.split('/')[4] };
      const entries = state.ledger.slice(offset, offset + limit);
      return json(route, {
        user: {
          id: state.users[0].userId,
          email: state.users[0].email,
          username: state.users[0].username,
          status: state.users[0].status,
        },
        ...balance(),
        entries,
        total: state.ledger.length,
        limit,
        offset,
      });
    }

    // ── admin: billing summary ───────────────────────────────────────────
    if (path === '/api/admin/billing/summary' && method === 'GET') {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      state.lastBillingQuery = { from, to };
      const summary = makeSummary(from, to);
      if (state.badReconcile) {
        summary.balances.ledgerDeltaMicroUsd = 8999000;
      }
      return json(route, summary);
    }

    // ── app-shell dependencies of the home / account screens ─────────────
    if (path === '/api/subscriptions' || path === '/api/history' || path === '/api/favorites') {
      return json(route, []);
    }
    if (path === '/api/models') return json(route, { models: [], default: null });
    if (path === '/api/review/stats') {
      return json(route, { dueNow: 0, dueToday: 0, newWords: 0, reviewedToday: 0 });
    }
    if (path === '/api/user/ability') return json(route, { profile: null });
    if (path === '/api/announcement') return json(route, { announcement: null });
    if (path === '/api/estimate-cost') {
      return json(route, {
        videoId: 'balance-billing-e2e',
        metadata: { title: 'e2e', channel: 'e2e', thumbnail: null },
        transcriptStats: { wordCount: 1, estimatedInputTokens: 1, estimatedOutputTokens: 1 },
        models: [],
      });
    }
    return json(route, {});
  });

  return state;
}

function formatRowsUsd(micro) {
  const negative = micro < 0;
  const abs = Math.abs(micro);
  const whole = Math.floor(abs / 1_000_000);
  let frac = String(abs % 1_000_000).padStart(6, '0').replace(/0+$/, '');
  if (frac.length < 2) frac = frac.padEnd(2, '0');
  return `${negative ? '-' : ''}${whole}.${frac}`;
}

async function openProfile(page) {
  await page.goto(`${BASE}/#/app/profile`);
  await page.locator('[data-testid="account-screen"]').waitFor({ timeout: 20000 });
}

async function dismissToasts(page) {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const close = page.locator('[data-testid="toast-close"]').first();
    if (await close.count() === 0) return;
    await close.click().catch(() => {});
    await page.waitForTimeout(80);
  }
}

async function textOf(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).first().innerText();
}

async function pageOverflow(page) {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await pageOverflow(page);
  assert.ok(overflow <= 1, `${label}: page-level horizontal overflow ${overflow}px`);
}

async function submitHomeUrl(page) {
  await page.goto(`${BASE}/#/app/today`);
  await page.locator('[data-testid="app-shell"]').waitFor({ timeout: 20000 });
  const input = page.locator('#video-url').first();
  await input.waitFor({ timeout: 15000 });
  await input.fill(YOUTUBE_URL);
  await page.locator('[data-testid="start-submit"]').first().click();
  // The home composer estimates first, then shows the confirm dialog; the AI
  // call (and its 402/429) happens only after confirming.
  const modal = page.locator('[data-testid="estimate-modal"]');
  await modal.waitFor({ timeout: 15000 });
  await modal.locator('button').last().click();
}

async function openAdminConsole(page) {
  await page.goto(`${BASE}/#/app/profile/admin`);
  await page.locator('[data-testid="admin-screen"]').waitFor({ timeout: 20000 });
  await page.locator('[data-testid="admin-tab-users"]').waitFor();
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const browser = await launchBrowser();
  try {
    // ── a) account balance card (positive + holds + legacy) ─────────────
    await check('account balance: available/book/holds/month spend/legacy + top-up note', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { summaryMode: 'positive' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-balance"]').waitFor();

      assert.equal(await textOf(page, 'account-balance-available'), '$1.85');
      assert.match(await textOf(page, 'account-balance-book'), /\$2\.00/);
      assert.match(await textOf(page, 'account-balance-holds'), /\$0\.15/);
      assert.match(await textOf(page, 'account-month-spend'), /\$0\.0037/);
      assert.match(await textOf(page, 'account-today-minutes'), /12\.5/);
      const note = await textOf(page, 'account-balance-note');
      assert.match(note, /\$2\.00/, 'note must state the $2.00 intro grant');
      assert.match(note, /管理员/);
      assert.match(note, /不可购买/);
      assert.match(note, /提现/);
      assert.match(note, /没有支付或自助充值/);
      const legacy = await textOf(page, 'account-balance-legacy');
      assert.match(legacy, /历史演示额度/);
      assert.match(legacy, /12/);
      assert.match(legacy, /冻结/);
      assert.equal(await page.locator('[data-testid="account-credits"]').count(), 0,
        'the old credits amount must not be the primary balance anymore');
      await page.locator('[data-testid="account-balance"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-balance.png` });
      assert.equal(state.logoutCalls, 0);
      await context.close();
    });

    // ── b) zero + negative/overrun + exact µUSD ─────────────────────────
    await check('account balance: zero and negative (overrun) states are explicit', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { summaryMode: 'zero' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-balance-low"]').waitFor();
      assert.equal(await textOf(page, 'account-balance-available'), '$0.00');
      assert.match(await textOf(page, 'account-balance-low'), /余额为 \$0\.00/);
      assert.match(await textOf(page, 'account-balance-low'), /402/);
      await page.locator('[data-testid="account-balance"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-balance-zero.png` });

      await context.close();

      // Negative book balance: overrun copy, red styling, exact -$0.50.
      const negativeContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(negativeContext, { summaryMode: 'negative' });
      const negativePage = await negativeContext.newPage();
      await openProfile(negativePage);
      await negativePage.locator('[data-testid="account-balance"]').waitFor();
      assert.equal(await textOf(negativePage, 'account-balance-available'), '-$0.50');
      assert.equal(await textOf(negativePage, 'account-balance-book'), '-$0.50');
      assert.equal(
        await negativePage.locator('[data-testid="account-balance"]').getAttribute('data-negative'),
        'true',
      );
      assert.match(await textOf(negativePage, 'account-balance-low'), /余额为负/);
      assert.match(await textOf(negativePage, 'account-balance-low'), /超过/);
      await negativePage.locator('[data-testid="account-balance"]').scrollIntoViewIfNeeded();
      await negativePage.screenshot({ path: `${SHOTS}/1440-account-balance-negative.png` });
      await negativeContext.close();
    });

    // ── c) 402: readable banner + account link, no logout ──────────────
    await check('402 AI call: readable shortfall banner, account entry, no logout / no server error', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { aiMode: 'insufficient' });
      const page = await context.newPage();
      await submitHomeUrl(page);
      const banner = page.locator('[data-testid="insufficient-balance-banner"]');
      await banner.waitFor({ timeout: 15000 });
      const bannerText = await banner.innerText();
      assert.match(bannerText, /余额不足/);
      assert.match(bannerText, /\$0\.02/, 'banner must show the available balance');
      assert.match(bannerText, /\$0\.01/, 'banner must show the required amount');
      assert.match(bannerText, /联系管理员充值/);
      assert.doesNotMatch(bannerText, /服务器错误/);
      assert.equal(state.logoutCalls, 0, '402 must not trigger logout');
      assert.equal(await page.locator('[data-testid="auth-screen"]').count(), 0,
        '402 must not send the user back to the auth screen');
      const toast = page.locator('[data-testid="toast"]', { hasText: '余额不足' }).first();
      await toast.waitFor({ timeout: 10000 });
      assert.doesNotMatch(await toast.innerText(), /HTTP 402/);
      await page.screenshot({ path: `${SHOTS}/1440-insufficient-banner.png` });

      await page.locator('[data-testid="insufficient-balance-banner-action"]').click();
      await page.locator('[data-testid="account-screen"]').waitFor({ timeout: 15000 });
      await page.locator('[data-testid="account-balance"]').waitFor();
      assert.equal(await page.locator('[data-testid="insufficient-balance-banner"]').count(), 0,
        'the account page replaces the banner');
      await context.close();
    });

    // ── d) 429 keeps quota copy, no 402 banner ──────────────────────────
    await check('429 AI call: quota copy stays, no 402 banner, no server-error text', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { aiMode: 'quota' });
      const page = await context.newPage();
      await submitHomeUrl(page);
      const toast = page.locator('[data-testid="toast"]', { hasText: '额度已用完' }).first();
      await toast.waitFor({ timeout: 15000 });
      const toastText = await toast.innerText();
      assert.match(toastText, /翻译：已用 60\/60/);
      assert.match(toastText, /明天 0 点恢复/);
      assert.doesNotMatch(toastText, /服务器错误/);
      assert.equal(await page.locator('[data-testid="insufficient-balance-banner"]').count(), 0,
        '429 must not show the insufficient-balance banner');
      await page.screenshot({ path: `${SHOTS}/1440-quota-429.png` });
      await context.close();
    });

    // ── d2) 402 inside an already-open SSE stream ──────────────────────
    await check('402 SSE error event: banner + readable toast, no logout', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { aiMode: 'insufficient-sse' });
      const page = await context.newPage();
      await submitHomeUrl(page);
      const banner = page.locator('[data-testid="insufficient-balance-banner"]');
      await banner.waitFor({ timeout: 15000 });
      const bannerText = await banner.innerText();
      assert.match(bannerText, /余额不足/);
      assert.match(bannerText, /\$0\.02/);
      assert.match(bannerText, /\$0\.01/);
      const toast = page.locator('[data-testid="toast"]', { hasText: '余额不足' }).first();
      await toast.waitFor({ timeout: 10000 });
      assert.equal(state.logoutCalls, 0);
      assert.equal(await page.locator('[data-testid="auth-screen"]').count(), 0);
      await page.screenshot({ path: `${SHOTS}/1440-insufficient-sse.png` });
      await context.close();
    });

    // ── e) admin adjust balance: validation, credit, debit, errors ─────
    await check('admin adjust balance: validation, credit, debit, 400/402/409 readable, list refresh', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { admin: true });
      const page = await context.newPage();
      await openAdminConsole(page);
      await page.locator('[data-testid="admin-tab-users"]').click();
      await page.locator('[data-testid="admin-user-row"]').first().waitFor();
      assert.equal(await textOf(page, 'admin-user-balance'), '$2.00');
      assert.match(await textOf(page, 'admin-user-legacy-credits'), /旧额 12/);

      await page.locator('[data-testid="admin-user-balance-adjust"]').first().click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor();
      assert.match(await textOf(page, 'admin-balance-book'), /\$2\.00/);
      assert.match(await textOf(page, 'admin-balance-idempotency'), /[a-f0-9-]{8,}/i);

      // Empty amount → client validation.
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.locator('[data-testid="admin-balance-error"]').waitFor();
      assert.match(await textOf(page, 'admin-balance-error'), /金额/);

      // 7 decimals → rejected before the request.
      await page.locator('[data-testid="admin-balance-amount"]').fill('2.0000001');
      await page.locator('[data-testid="admin-balance-reason"]').fill('e2e top-up');
      await page.locator('[data-testid="admin-balance-submit"]').click();
      assert.match(await textOf(page, 'admin-balance-error'), /6 位/);
      assert.equal(state.lastAdjustBody, null, 'invalid amount must not reach the API');

      // Debit larger than the balance → negative-balance guard.
      await page.locator('[data-testid="admin-balance-direction-debit"]').click();
      await page.locator('[data-testid="admin-balance-amount"]').fill('10');
      await page.locator('[data-testid="admin-balance-submit"]').click();
      assert.match(await textOf(page, 'admin-balance-error'), /不能为负/);
      assert.equal(state.lastAdjustBody, null);

      // Backend 400 → readable localized error.
      await page.locator('[data-testid="admin-balance-direction-credit"]').click();
      await page.locator('[data-testid="admin-balance-amount"]').fill('2.5');
      state.nextAdjustError = { status: 400, body: { detail: '金额必须大于 0。' } };
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.locator('[data-testid="admin-balance-error"]').waitFor();
      const e400 = await textOf(page, 'admin-balance-error');
      assert.match(e400, /拒绝/);
      assert.doesNotMatch(e400, /服务器错误/);

      // Backend 402 → readable localized error.
      state.nextAdjustError = {
        status: 402,
        body: { detail: '余额不足', code: 'insufficient_balance', availableMicroUsd: 0, requiredMicroUsd: 1 },
      };
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-balance-error"]')?.textContent?.includes('超出限制'),
      );
      assert.match(await textOf(page, 'admin-balance-error'), /余额不足或金额超出限制/);

      // Backend 409 → readable conflict copy.
      state.nextAdjustError = { status: 409, body: { detail: '幂等键冲突。' } };
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-balance-error"]')?.textContent?.includes('幂等键冲突'),
      );
      assert.match(await textOf(page, 'admin-balance-error'), /幂等键冲突/);

      // Success (credit $2.50) → row refreshes to $4.50 and one ledger entry.
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor({ state: 'detached', timeout: 15000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-user-balance"]')?.textContent?.includes('$4.50'),
      );
      assert.equal(state.users[0].balanceMicroUsd, 4500000);
      assert.equal(state.lastAdjustBody.amountUsd, '2.5');
      assert.equal(state.lastAdjustBody.direction, 'credit');
      assert.equal(state.lastAdjustBody.reason, 'e2e top-up');
      assert.match(String(state.lastAdjustBody.idempotencyKey), /^[0-9a-f-]{36}$/i,
        'frontend must send a UUID idempotency key');
      await dismissToasts(page);
      await page.screenshot({ path: `${SHOTS}/1440-admin-users-balance.png` });

      // Debit $0.50 → $4.00.
      await page.locator('[data-testid="admin-user-balance-adjust"]').first().click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor();
      await page.locator('[data-testid="admin-balance-direction-debit"]').click();
      await page.locator('[data-testid="admin-balance-amount"]').fill('0.5');
      await page.locator('[data-testid="admin-balance-reason"]').fill('e2e correction');
      await page.locator('[data-testid="admin-balance-submit"]').click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor({ state: 'detached', timeout: 15000 });
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-user-balance"]')?.textContent?.includes('$4.00'),
      );
      assert.equal(state.lastAdjustBody.direction, 'debit');
      assert.equal(state.users[0].balanceMicroUsd, 4000000);

      // Ledger: newest first, localized kinds, operator prefix, no idempotency key.
      await page.locator('[data-testid="admin-user-ledger"]').first().click();
      await page.locator('[data-testid="admin-ledger-dialog"]').waitFor();
      await page.waitForTimeout(350);
      const ledgerText = await page.locator('[data-testid="admin-ledger-dialog"]').innerText();
      assert.match(ledgerText, /管理员充值/);
      assert.match(ledgerText, /管理员扣减/);
      assert.match(ledgerText, /AI 调用结算/);
      assert.match(ledgerText, /开户赠送/);
      assert.match(ledgerText, /e2e top-up/);
      assert.match(ledgerText, /e2e correction/);
      assert.match(ledgerText, /admin-e2/);
      assert.doesNotMatch(ledgerText, /SECRET-KEY/, 'idempotency keys must not render');
      assert.match(await textOf(page, 'admin-ledger-available'), /\$4\.00/);
      assert.match(await textOf(page, 'admin-ledger-page'), /共/);
      await dismissToasts(page);
      await page.screenshot({ path: `${SHOTS}/1440-admin-ledger.png` });
      await page.locator('[data-testid="admin-ledger-close"]').click();
      await page.locator('[data-testid="admin-ledger-dialog"]').waitFor({ state: 'detached' });

      // The balance dialog shows the admin-only top-up notice.
      await page.locator('[data-testid="admin-user-balance-adjust"]').first().click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor();
      await page.waitForTimeout(350);
      const dialogText = await page.locator('[data-testid="admin-balance-dialog"]').innerText();
      assert.match(dialogText, /用户不能自助充值/);
      assert.match(dialogText, /不可购买或提现/);
      await dismissToasts(page);
      await page.screenshot({ path: `${SHOTS}/1440-admin-balance-dialog.png` });
      await page.locator('[data-testid="admin-balance-cancel"]').click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor({ state: 'detached' });
      await context.close();
    });

    // ── e2) ledger pagination: 50/page, prev/next, no key leakage ─────
    await check('admin ledger pagination: 50 per page, next page offset, total stays', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { admin: true });
      // 55 entries exercises page 2 (50 + 5).
      state.ledger = Array.from({ length: 55 }, (_, index) => ({
        id: `bl-bulk-${index}`,
        kind: index % 2 === 0 ? 'admin_topup' : 'ai_settle',
        deltaMicroUsd: index % 2 === 0 ? 1000 : -100,
        deltaUsd: index % 2 === 0 ? '0.001' : '-0.0001',
        balanceAfterMicroUsd: 2000000 - index * 100,
        balanceAfterUsd: '2.00',
        refType: 'manual',
        refId: null,
        reason: `bulk ${index}`,
        actorId: index % 2 === 0 ? 'admin-e2e' : null,
        idempotencyKey: `SECRET-BULK-${index}`,
        createdAtMs: Date.now() - index * 1000,
      }));
      const page = await context.newPage();
      await openAdminConsole(page);
      await page.locator('[data-testid="admin-tab-users"]').click();
      await page.locator('[data-testid="admin-user-row"]').first().waitFor();
      await page.locator('[data-testid="admin-user-ledger"]').first().click();
      await page.locator('[data-testid="admin-ledger-dialog"]').waitFor();
      await page.waitForTimeout(300);
      assert.equal(await page.locator('[data-testid="admin-ledger-row"]').count(), 50);
      assert.match(await textOf(page, 'admin-ledger-page'), /1–50/);
      assert.match(await textOf(page, 'admin-ledger-page'), /55/);
      assert.deepEqual(state.lastLedgerQuery, { limit: 50, offset: 0, userId: 'user-e2e' });
      assert.equal(await page.locator('[data-testid="admin-ledger-prev"]').isDisabled(), true);
      await page.locator('[data-testid="admin-ledger-next"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-ledger-page"]')?.textContent?.includes('51–55'),
      );
      assert.equal(await page.locator('[data-testid="admin-ledger-row"]').count(), 5);
      assert.deepEqual(state.lastLedgerQuery, { limit: 50, offset: 50, userId: 'user-e2e' });
      assert.equal(await page.locator('[data-testid="admin-ledger-next"]').isDisabled(), true);
      const ledgerText = await page.locator('[data-testid="admin-ledger-dialog"]').innerText();
      assert.doesNotMatch(ledgerText, /SECRET-BULK/, 'idempotency keys must not render');
      await page.screenshot({ path: `${SHOTS}/1440-admin-ledger-page2.png` });
      await context.close();
    });

    // ── f) billing summary: range + money + unpriced + prices ──────────
    await check('admin billing summary: range, µUSD/USD costs, unbilled/legacy/settle_failed, unpriced, prices', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { admin: true });
      const page = await context.newPage();
      await openAdminConsole(page);
      await page.locator('[data-testid="admin-tab-billing"]').click();
      await page.locator('[data-testid="admin-panel-billing"]').waitFor();
      await page.locator('[data-testid="admin-billing-billed"]').waitFor();

      assert.equal(await textOf(page, 'admin-billing-billed'), '$0.03021');
      assert.equal(state.lastBillingQuery !== null, true);
      assert.match(await textOf(page, 'admin-billing-rows'), /42/);
      assert.equal(await textOf(page, 'admin-billing-input-tokens'), '120,000');
      assert.equal(await textOf(page, 'admin-billing-output-tokens'), '30,000');
      assert.equal(await textOf(page, 'admin-billing-unbilled'), '3');
      assert.match(await textOf(page, 'admin-billing-unbilled'), /3/);
      assert.equal(await textOf(page, 'admin-billing-settle-failed'), '1');
      assert.match(await textOf(page, 'admin-billing-holds'), /\$0\.12/);
      assert.match(await textOf(page, 'admin-billing-balances'), /\$9\.00/);
      assert.equal(
        await page.locator('[data-testid="admin-billing-reconcile"]').getAttribute('data-ok'),
        'true',
      );
      assert.match(await textOf(page, 'admin-billing-reconcile'), /对账通过/);
      const unpriced = await textOf(page, 'admin-billing-unpriced');
      assert.match(unpriced, /qwen-flash/);
      assert.match(unpriced, /gemini-3\.5-flash-lite/);
      assert.match(unpriced, /不扣余额/);
      assert.match(await textOf(page, 'admin-billing-models'), /deepseek-chat/);
      assert.match(await textOf(page, 'admin-billing-models'), /DeepSeek/);
      assert.match(await textOf(page, 'admin-billing-models'), /\$0\.03/);
      assert.match(await textOf(page, 'admin-billing-features'), /翻译/);
      assert.match(await textOf(page, 'admin-billing-prices'), /2026-11-20\.official\.1/);
      assert.match(await textOf(page, 'admin-billing-topup-note'), /用户不能自助充值/);

      // Date range is applied to the next request.
      await page.locator('[data-testid="admin-billing-from"]').fill('2026-11-01');
      await page.locator('[data-testid="admin-billing-to"]').fill('2026-11-20');
      await page.locator('[data-testid="admin-billing-apply"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-billing-range"]')?.textContent?.includes('2026-11-01'),
      );
      assert.deepEqual(state.lastBillingQuery, { from: '2026-11-01', to: '2026-11-20' });

      // Mismatched ledger total → visible reconciliation warning.
      state.badReconcile = true;
      await page.locator('[data-testid="admin-billing-apply"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="admin-billing-reconcile"]')?.getAttribute('data-ok') === 'false',
      );
      assert.match(await textOf(page, 'admin-billing-reconcile'), /相差 \$0\.001/);

      await page.locator('[data-testid="admin-screen"]').evaluate((element) => { element.scrollTop = 0; });
      await page.waitForTimeout(350);
      await page.screenshot({ path: `${SHOTS}/1440-admin-billing.png` });
      await context.close();
    });

    // ── g) 375px layout ─────────────────────────────────────────────────
    await check('375px: account, admin users, balance dialog, ledger and billing have no page overflow', async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await installStubs(context, { admin: true });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-balance"]').waitFor();
      await assertNoHorizontalOverflow(page, '375 account');
      await page.locator('[data-testid="account-balance"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/375-account-balance.png` });

      await openAdminConsole(page);
      await page.locator('[data-testid="admin-tab-users"]').click();
      await page.locator('[data-testid="admin-user-row"]').first().waitFor();
      await assertNoHorizontalOverflow(page, '375 admin users');
      await page.screenshot({ path: `${SHOTS}/375-admin-users-balance.png` });

      await page.locator('[data-testid="admin-user-balance-adjust"]').first().click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor();
      await page.waitForTimeout(350);
      const balanceBox = await page.locator('[data-testid="admin-balance-dialog"]').boundingBox();
      assert.ok(balanceBox && balanceBox.x >= 0 && balanceBox.width <= 375,
        `balance dialog should fit 375px: ${JSON.stringify(balanceBox)}`);
      await assertNoHorizontalOverflow(page, '375 balance dialog');
      await page.screenshot({ path: `${SHOTS}/375-admin-balance-dialog.png` });
      await page.locator('[data-testid="admin-balance-cancel"]').click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor({ state: 'detached' });

      await page.locator('[data-testid="admin-user-ledger"]').first().click();
      await page.locator('[data-testid="admin-ledger-dialog"]').waitFor();
      await page.waitForTimeout(350);
      const ledgerBox = await page.locator('[data-testid="admin-ledger-dialog"]').boundingBox();
      assert.ok(ledgerBox && ledgerBox.x >= 0 && ledgerBox.width <= 375,
        `ledger dialog should fit 375px: ${JSON.stringify(ledgerBox)}`);
      await assertNoHorizontalOverflow(page, '375 ledger dialog');
      await page.screenshot({ path: `${SHOTS}/375-admin-ledger.png` });
      await page.locator('[data-testid="admin-ledger-close"]').click();
      await page.locator('[data-testid="admin-ledger-dialog"]').waitFor({ state: 'detached' });

      await page.locator('[data-testid="admin-tab-billing"]').click();
      await page.locator('[data-testid="admin-billing-billed"]').waitFor();
      await assertNoHorizontalOverflow(page, '375 admin billing');
      await page.waitForTimeout(450);
      await page.screenshot({ path: `${SHOTS}/375-admin-billing.png` });
      await context.close();
    });

    // ── h) vi-VN copy (account, 402, admin dialogs, billing) ────────────
    await check('vi-VN: account, 402 banner, adjust dialog and billing copy are translated', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        window.localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
      });
      await installStubs(context, { admin: true, aiMode: 'insufficient', summaryMode: 'positive' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-balance"]').waitFor();
      const balanceText = await page.locator('[data-testid="account-balance"]').innerText();
      assert.match(balanceText, /Số dư khả dụng/);
      assert.match(balanceText, /Số dư sổ/);
      assert.match(balanceText, /Quà dùng thử/);
      assert.match(balanceText, /quản trị viên/);
      assert.doesNotMatch(balanceText, /[\u4e00-\u9fff]/, 'vi account balance must not fall back to Chinese');
      await page.locator('[data-testid="account-balance"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-balance-vi.png` });

      // 402 banner in Vietnamese.
      await submitHomeUrl(page);
      const banner = page.locator('[data-testid="insufficient-balance-banner"]');
      await banner.waitFor({ timeout: 15000 });
      const bannerText = await banner.innerText();
      assert.match(bannerText, /Không đủ số dư/);
      assert.match(bannerText, /quản trị viên/);
      assert.doesNotMatch(bannerText, /[\u4e00-\u9fff]/, 'vi 402 banner must not fall back to Chinese');
      const toast = page.locator('[data-testid="toast"]', { hasText: 'Không đủ số dư' }).first();
      await toast.waitFor({ timeout: 10000 });
      assert.doesNotMatch(await toast.innerText(), /[\u4e00-\u9fff]/);
      await page.screenshot({ path: `${SHOTS}/1440-insufficient-banner-vi.png` });

      // Admin: translated balance dialog + billing labels, no Chinese fallback.
      await openAdminConsole(page);
      await page.locator('[data-testid="admin-tab-users"]').click();
      await page.locator('[data-testid="admin-user-row"]').first().waitFor();
      await page.locator('[data-testid="admin-user-balance-adjust"]').first().click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor();
      const dialogText = await page.locator('[data-testid="admin-balance-dialog"]').innerText();
      assert.match(dialogText, /Điều chỉnh số dư/);
      assert.match(dialogText, /Số tiền \(USD\)/);
      assert.match(dialogText, /Xác nhận điều chỉnh/);
      assert.match(dialogText, /người dùng không thể tự nạp/i);
      assert.doesNotMatch(dialogText, /[\u4e00-\u9fff]/, 'vi balance dialog must not fall back to Chinese');
      await page.screenshot({ path: `${SHOTS}/1440-admin-balance-dialog-vi.png` });
      await page.locator('[data-testid="admin-balance-cancel"]').click();
      await page.locator('[data-testid="admin-balance-dialog"]').waitFor({ state: 'detached' });

      await page.locator('[data-testid="admin-tab-billing"]').click();
      await page.locator('[data-testid="admin-billing-billed"]').waitFor();
      await page.waitForTimeout(350);
      const billingText = await page.locator('[data-testid="admin-panel-billing"]').innerText();
      assert.match(billingText, /Chi phí thực trừ/);
      assert.match(billingText, /Mô hình chưa có giá/);
      assert.match(billingText, /Bảng giá hiện tại/);
      assert.doesNotMatch(billingText, /[\u4e00-\u9fff]/, 'vi billing panel must not fall back to Chinese');
      await page.locator('[data-testid="admin-screen"]').evaluate((element) => { element.scrollTop = 0; });
      await page.screenshot({ path: `${SHOTS}/1440-admin-billing-vi.png` });
      await context.close();
    });
  } finally {
    await browser.close();
  }

  console.log(`\n${checks - failures.length}/${checks} checks passed; screenshots: ${SHOTS}`);
  if (failures.length) {
    throw new Error(`${failures.length} check(s) failed:\n${failures.join('\n')}`);
  }
}
