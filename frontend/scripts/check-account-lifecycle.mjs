#!/usr/bin/env node
// Browser acceptance for M2b — account deletion / data export frontend UI
// (specs/033, backend M2a).
//
// Runs the real React UI in Chromium against a stubbed API (no backend, no
// seeded database, no real password). The backend contract itself is covered by
// backend/tests/test_account_lifecycle.py + test_account_export.py; here we
// verify the UI wires it correctly:
//   a) account page "数据与账号": export password confirm → queued → ready →
//      download with the one-time token → delete temp file;
//   b) readable failures: 429 Retry-After, 409 export busy, network error,
//      410 expired download, wrong password — never "服务器错误";
//   c) delete dialog: cancel / field validation / wrong password / success
//      (session cleared + auth screen, no white page);
//   d) cooldown: pending card with due date, cancel flow, export still allowed;
//   e) pending account elsewhere: restricted banner on the app shell + a
//      readable business-403 toast, and the banner routes to the account page;
//   f) admin console: deletion requests list (masked user), forced execute with
//      reason + DELETE + second confirmation, audit list;
//   g) 375 / 1440 layout without page-level horizontal overflow;
//   h) zh-CN / vi-VN copy for the key legal boundaries.
//
// Screenshots: /tmp/account-lifecycle-shots/
// Run: APP_URL=http://localhost:5173 npm run check:account
import assert from 'node:assert/strict';
import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const BASE = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
const SHOTS = '/tmp/account-lifecycle-shots';
mkdirSync(SHOTS, { recursive: true });

const PASSWORD = 'correct-horse-battery';
const YOUTUBE_URL = 'https://www.youtube.com/watch?v=account-lifecycle-e2e';
const REGISTRATION = {
  registrationOpen: false,
  inviteSignupEnabled: true,
  inviteRequired: true,
  registrationClosed: false,
};

const ACTIVE_USER = {
  id: 'user-e2e',
  email: 'learner@example.test',
  username: 'learner-e2e',
  credits: 12,
  status: 'active',
};
const PENDING_USER = { ...ACTIVE_USER, status: 'deletion_pending' };
const ADMIN_USER = {
  id: 'admin-e2e',
  email: 'admin@example.test',
  username: 'admin-e2e',
  credits: 0,
  status: 'active',
};

const DAY = 24 * 60 * 60 * 1000;
const LIMITS = { per24h: 1, per30d: 3, ttlHours: 24, maxBytes: 200 * 1024 * 1024, concurrentJobs: 1 };

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

function json(route, body, status = 200) {
  const origin = route.request().headers().origin || BASE;
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  });
}

function lifecycleError(route, status, code, detail, extra = {}) {
  const origin = route.request().headers().origin || BASE;
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers: {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'cache-control': 'no-store',
      ...(extra.retryAfter ? { 'retry-after': String(extra.retryAfter) } : {}),
    },
    body: JSON.stringify({ detail, code, ...extra }),
  });
}

function pendingDeletionState() {
  const requestedAt = Date.now() - DAY;
  const dueAt = Date.now() + 6 * DAY;
  return {
    status: 'deletion_pending',
    dueAt,
    deletion: {
      id: 'del-e2e-pending',
      status: 'pending',
      requestedAt,
      dueAt,
      verifiedVia: 'session_password',
      reason: null,
      completedAt: null,
      counts: null,
      error: null,
    },
    cooldownDays: 7,
    backupRetentionDays: 30,
    notice: '7 天冷静期',
  };
}

function activeDeletionState() {
  return {
    status: 'active',
    dueAt: null,
    deletion: null,
    cooldownDays: 7,
    backupRetentionDays: 30,
    notice: '7 天冷静期',
  };
}

function emptyAdminPayload(path) {
  if (path === '/api/admin/stats') {
    return {
      users: { total: 1, new7d: 1, activeToday: 1, guests: 0 },
      ai: { todayCostUsd: 0, monthCostUsd: 0, todayCalls: 0, todayByFeature: {} },
      jobs: { failed: 0, running: 0, pendingRetry: 0 },
      generatedAt: new Date().toISOString(),
    };
  }
  if (path === '/api/admin/usage') {
    return {
      days: 7,
      start: '',
      end: '',
      rows: [],
      daysSummary: [],
      totals: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
    };
  }
  if (path === '/api/admin/health') {
    return {
      health: {
        status: 'ok',
        version: 'e2e',
        db: { ok: true, migrations: { current: '0024', head: '0024' } },
        uptimeSeconds: 1,
        time: new Date().toISOString(),
      },
      disk: { dataDir: '/tmp', sizeBytes: 0 },
      failedJobs: [],
    };
  }
  if (path === '/api/admin/settings') return { maintenance_mode: false, announcement: null };
  if (path === '/api/admin/users') {
    return { users: [], total: 0, limit: 20, offset: 0, hasMore: false };
  }
  if (path === '/api/admin/invites') {
    return {
      invites: [],
      total: 0,
      limit: 20,
      offset: 0,
      hasMore: false,
      status: 'all',
      counts: { active: 0, used: 0, expired: 0, revoked: 0 },
      config: REGISTRATION,
    };
  }
  return null;
}

/**
 * Install the API double for one browser context.
 * `mode`: 'active' | 'pending'; `admin` additionally enables the console.
 */
async function installStubs(context, { mode = 'active', admin = false } = {}) {
  const now = Date.now();
  const state = {
    user: mode === 'pending' ? { ...PENDING_USER } : { ...ACTIVE_USER },
    isAdmin: admin,
    sessionRevoked: false,
    deletion: mode === 'pending' ? pendingDeletionState() : activeDeletionState(),
    exports: [],
    exportSeq: 0,
    tokens: new Map(),
    downloads: [],
    deletionSubmissions: 0,
    rateLimitNext: false,
    passwordRateLimitNext: false,
    busyNext: false,
    expireDownload: false,
    failListOnce: false,
    adminDeletions: [
      {
        id: 'del-e2e-due',
        status: 'pending',
        requestedAt: now - 8 * DAY,
        dueAt: now - DAY,
        verifiedVia: 'session_password',
        reason: 'moving on',
        completedAt: null,
        counts: null,
        error: null,
        userIdHash: 'a'.repeat(64),
        operatorId: null,
        overdue: true,
        user: {
          userId: 'user-second',
          email: 'second.person@example.test',
          username: 'second-person',
          status: 'deletion_pending',
        },
      },
      {
        id: 'del-e2e-not-due',
        status: 'pending',
        requestedAt: now - DAY,
        dueAt: now + 6 * DAY,
        verifiedVia: 'session_password',
        reason: null,
        completedAt: null,
        counts: null,
        error: null,
        userIdHash: 'b'.repeat(64),
        operatorId: null,
        overdue: false,
        user: {
          userId: 'user-third',
          email: 'third.person@example.test',
          username: 'third-person',
          status: 'deletion_pending',
        },
      },
      {
        id: 'del-e2e-done',
        status: 'completed',
        requestedAt: now - 10 * DAY,
        dueAt: now - 3 * DAY,
        verifiedVia: 'session_password',
        reason: null,
        completedAt: now - 3 * DAY,
        counts: { users: 1 },
        error: null,
        userIdHash: 'c'.repeat(64),
        operatorId: 'admin-e2e',
        overdue: false,
        user: null,
      },
    ],
    audit: [
      {
        id: 2147480000,
        actorId: 'admin-e2e',
        action: 'account.deletion.execute.completed',
        targetType: 'deletion_request',
        targetId: 'del-e2e-done',
        detail: { reason: 'support ticket #42', force: false },
        requestId: 'req-e2e',
        createdAt: now - 3 * DAY,
      },
      {
        id: 2147479999,
        actorId: 'learner-e2e',
        action: 'account.export.request',
        targetType: 'export_job',
        targetId: 'exp-e2e-old',
        detail: null,
        requestId: null,
        createdAt: now - 2 * DAY,
      },
    ],
  };

  const makeReady = (jobId) => {
    const job = state.exports.find((item) => item.id === jobId);
    if (!job) return;
    job.status = 'ready';
    job.completedAt = Date.now();
    job.expiresAt = Date.now() + DAY;
    job.sizeBytes = 2048;
    job.downloadable = true;
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
    if (path === '/api/auth/me') {
      if (state.sessionRevoked) return json(route, { detail: '未登录', code: 'auth_required' }, 401);
      return json(route, { user: state.user, isAdmin: state.isAdmin });
    }
    if (path === '/api/auth/registration') return json(route, REGISTRATION);
    if (path === '/api/auth/logout') return json(route, { ok: true });

    // ── account lifecycle ────────────────────────────────────────────────
    if (path === '/api/account/deletion' && method === 'GET') {
      if (state.sessionRevoked) return lifecycleError(route, 401, 'auth_required', '未登录。');
      return json(route, state.deletion);
    }
    if (path === '/api/account/deletion' && method === 'POST') {
      if (body.confirm !== 'DELETE') {
        return lifecycleError(route, 400, 'confirmation_invalid', '用户名或确认词不正确。');
      }
      if (body.password !== PASSWORD) {
        return lifecycleError(route, 401, 'password_invalid', '密码不正确。');
      }
      if (state.deletion.status === 'deletion_pending') {
        return lifecycleError(route, 409, 'deletion_already_pending', '删除申请已在冷静期中。');
      }
      const dueAt = Date.now() + 7 * DAY;
      state.deletion = {
        ...pendingDeletionState(),
        dueAt,
        deletion: {
          ...pendingDeletionState().deletion,
          id: 'del-e2e-submitted',
          requestedAt: Date.now(),
          dueAt,
        },
      };
      state.user = { ...state.user, status: 'deletion_pending' };
      state.deletionSubmissions += 1;
      // Backend revokes every session and clears the cookie in this response.
      state.sessionRevoked = true;
      return json(route, {
        status: 'deletion_pending',
        requestedAt: Date.now(),
        dueAt,
        sessionsRevoked: true,
        cooldownDays: 7,
        backupRetentionDays: 30,
        deletion: state.deletion.deletion,
      }, 202);
    }
    if (path === '/api/account/deletion/cancel' && method === 'POST') {
      if (state.passwordRateLimitNext) {
        state.passwordRateLimitNext = false;
        return lifecycleError(
          route,
          429,
          'password_rate_limited',
          '密码错误次数过多，请稍后再试。',
          { retryAfter: 60 },
        );
      }
      if (body.password !== PASSWORD) {
        return lifecycleError(route, 401, 'password_invalid', '密码不正确。');
      }
      if (state.deletion.status !== 'deletion_pending') {
        return lifecycleError(route, 409, 'deletion_not_pending', '当前没有可取消的删除申请。');
      }
      state.deletion = activeDeletionState();
      state.user = { ...state.user, status: 'active' };
      return json(route, { status: 'active', cancelledAt: Date.now(), cooldownDays: 7, backupRetentionDays: 30 });
    }
    if (path === '/api/account/exports' && method === 'GET') {
      if (state.failListOnce) {
        state.failListOnce = false;
        return route.abort('failed');
      }
      return json(route, { jobs: state.exports, limits: LIMITS });
    }
    if (path === '/api/account/export' && method === 'POST') {
      if (body.password !== PASSWORD) {
        return lifecycleError(route, 401, 'password_invalid', '密码不正确。');
      }
      if (state.rateLimitNext) {
        state.rateLimitNext = false;
        return lifecycleError(
          route,
          429,
          'export_rate_limited',
          '24 小时内只能导出 1 次，请稍后再试。',
          { retryAfter: 120, window: '24h' },
        );
      }
      if (state.busyNext) {
        state.busyNext = false;
        return lifecycleError(route, 409, 'export_busy', '已有导出任务正在生成，请稍后重试。');
      }
      const jobId = `exp-e2e-${state.exportSeq += 1}`;
      const token = `TOKEN-${jobId}`;
      state.tokens.set(jobId, token);
      const job = {
        id: jobId,
        status: 'queued',
        requestedAt: Date.now(),
        completedAt: null,
        expiresAt: now + DAY,
        sizeBytes: null,
        downloadedAt: null,
        error: null,
        downloadable: false,
      };
      state.exports.unshift(job);
      setTimeout(() => makeReady(jobId), 350);
      return json(route, {
        jobId,
        status: 'queued',
        requestedAt: job.requestedAt,
        expiresAt: job.expiresAt,
        downloadToken: token,
        downloadPath: `/api/account/export/${jobId}?token=${token}`,
        limits: LIMITS,
      }, 202);
    }
    const exportFileMatch = path.match(/^\/api\/account\/export\/([^/]+)$/);
    if (exportFileMatch && method === 'GET') {
      const jobId = exportFileMatch[1];
      const token = url.searchParams.get('token');
      state.downloads.push(request.url());
      if (state.expireDownload) {
        state.expireDownload = false;
        const job = state.exports.find((item) => item.id === jobId);
        if (job) {
          job.status = 'expired';
          job.downloadable = false;
        }
        return lifecycleError(route, 410, 'export_expired', '导出文件已过期。');
      }
      if (token !== state.tokens.get(jobId)) {
        return lifecycleError(route, 403, 'export_token_invalid', '缺少或错误的下载 token。');
      }
      const origin = request.headers().origin || BASE;
      return route.fulfill({
        status: 200,
        contentType: 'application/zip',
        headers: {
          'access-control-allow-origin': origin,
          'access-control-allow-credentials': 'true',
          'cache-control': 'no-store',
        },
        body: Buffer.from('PK\u0003\u0004linguatrek-e2e-zip'),
      });
    }
    if (exportFileMatch && method === 'DELETE') {
      const jobId = exportFileMatch[1];
      const job = state.exports.find((item) => item.id === jobId);
      if (job) {
        job.status = 'expired';
        job.downloadable = false;
      }
      return json(route, { ok: true, status: 'expired' });
    }

    // ── admin lifecycle ──────────────────────────────────────────────────
    if (path === '/api/admin/deletion-requests' && method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      const rows = status === 'all'
        ? state.adminDeletions
        : state.adminDeletions.filter((row) => row.status === status);
      return json(route, {
        requests: rows,
        total: rows.length,
        limit: 20,
        offset: 0,
        hasMore: false,
        serverTime: Date.now(),
      });
    }
    const executeMatch = path.match(/^\/api\/admin\/deletion-requests\/([^/]+)\/execute$/);
    if (executeMatch && method === 'POST') {
      const target = state.adminDeletions.find((row) => row.id === executeMatch[1]);
      if (!target) return lifecycleError(route, 404, 'deletion_not_found', '删除申请不存在。');
      if (body.confirm !== 'DELETE') {
        return lifecycleError(route, 400, 'confirmation_invalid', '请输入确认词 DELETE。');
      }
      if (!String(body.reason || '').trim()) {
        return lifecycleError(route, 400, 'invalid_reason', '执行原因需要 1–200 个字符。');
      }
      if (!target.overdue && body.force !== true) {
        return lifecycleError(route, 409, 'deletion_not_due', '冷静期尚未结束。');
      }
      target.status = 'completed';
      target.completedAt = Date.now();
      target.operatorId = 'admin-e2e';
      target.user = null;
      state.audit.unshift({
        id: Date.now(),
        actorId: 'admin-e2e',
        action: 'account.deletion.execute.completed',
        targetType: 'deletion_request',
        targetId: target.id,
        detail: { reason: body.reason, force: body.force === true },
        requestId: 'req-execute',
        createdAt: Date.now(),
      });
      return json(route, {
        status: 'completed',
        userIdHash: target.userIdHash,
        counts: { users: 1 },
        request: { id: target.id, status: 'completed' },
      });
    }
    if (path === '/api/admin/audit' && method === 'GET') {
      return json(route, {
        entries: state.audit,
        total: state.audit.length,
        limit: 20,
        offset: 0,
        hasMore: false,
      });
    }

    // ── account page / shell dependencies ────────────────────────────────
    if (path === '/api/user/summary') {
      if (state.user.status === 'deletion_pending') {
        return lifecycleError(
          route,
          403,
          'account_pending_deletion',
          '账号正在删除冷静期，仅可取消删除或导出数据。',
        );
      }
      return json(route, {
        user: { ...state.user, memberSince: now - 90 * DAY },
        monthSpendUsd: 0.42,
        usageToday: { minutes: 12.5 },
        version: 'e2e',
        preliminary: false,
      });
    }
    if (path === '/api/subscriptions' || path === '/api/history' || path === '/api/favorites') {
      return json(route, []);
    }
    if (path === '/api/estimate-cost') {
      if (state.user.status === 'deletion_pending') {
        return lifecycleError(
          route,
          403,
          'account_pending_deletion',
          '账号正在删除冷静期，仅可取消删除或导出数据。',
        );
      }
      return json(route, {
        videoId: 'account-lifecycle-e2e',
        metadata: { title: 'e2e', channel: 'e2e', thumbnail: null },
        transcriptStats: { wordCount: 1, estimatedInputTokens: 1, estimatedOutputTokens: 1 },
        models: [],
      });
    }
    if (path === '/api/process-video-stream' || path === '/api/process-video') {
      if (state.user.status === 'deletion_pending') {
        return lifecycleError(
          route,
          403,
          'account_pending_deletion',
          '账号正在删除冷静期，仅可取消删除或导出数据。',
        );
      }
      return json(route, {});
    }
    if (path === '/api/models') return json(route, { models: [], default: null });
    if (path === '/api/review/stats') {
      return json(route, { dueNow: 0, dueToday: 0, newWords: 0, reviewedToday: 0 });
    }
    if (path === '/api/user/ability') return json(route, { profile: null });
    if (path === '/api/announcement') return json(route, { announcement: null });

    const adminPayload = admin ? emptyAdminPayload(path) : null;
    if (adminPayload) return json(route, adminPayload);

    // Everything else is an auxiliary app-shell request; answer an empty object.
    return json(route, {});
  });

  return state;
}

async function openProfile(page) {
  await page.goto(`${BASE}/#/app/profile`);
  await page.locator('[data-testid="account-screen"]').waitFor({ timeout: 20000 });
}

async function openExportDialog(page) {
  await page.locator('[data-testid="account-export-create"]').click();
  await page.locator('[data-testid="account-export-dialog"]').waitFor();
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  const browser = await launchBrowser();
  try {
    // ── a) export happy path ────────────────────────────────────────────
    await check('account export: password confirm → ready → token download → delete temp file', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { mode: 'active' });
      const page = await context.newPage();

      await openProfile(page);
      await page.locator('[data-testid="account-data"]').waitFor();
      await page.locator('[data-testid="account-export-empty"]').waitFor();
      const legal = await textOf(page, 'account-data-legal');
      assert.match(legal, /7 天/, 'legal copy must state the 7-day cooldown');
      assert.match(legal, /30 天/, 'legal copy must state the 30-day backup tail');
      assert.match(legal, /24 小时/, 'legal copy must state the 24h export lifetime');
      assert.match(legal, /找回密码/, 'legal copy must state the manual password recovery');
      await page.locator('[data-testid="account-data"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-data.png` });

      await openExportDialog(page);
      await page.screenshot({ path: `${SHOTS}/1440-account-export-dialog.png` });
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-error"]').waitFor();
      assert.match(await textOf(page, 'account-export-error'), /请输入登录密码/);

      await page.locator('[data-testid="account-export-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-dialog"]').waitFor({ state: 'detached' });
      await page.locator('[data-testid="account-export-row"]').first().waitFor();
      await page.locator('[data-testid="account-export-row"][data-status="ready"]')
        .waitFor({ timeout: 15000 });

      const token = state.tokens.get('exp-e2e-1');
      assert.ok(token, 'stub should have issued a token');
      await page.locator('[data-testid="account-export-download"]').click();
      await page.waitForTimeout(600);
      assert.equal(state.downloads.length, 1, 'download should hit the export endpoint once');
      assert.match(state.downloads[0], new RegExp(`token=${token}`), 'download must carry the one-time token');
      await page.locator('[data-testid="account-export-row"]').first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-export-ready.png` });

      await page.locator('[data-testid="account-export-delete"]').click();
      await page.locator('[data-testid="account-export-row"][data-status="expired"]')
        .waitFor({ timeout: 10000 });
      await page.screenshot({ path: `${SHOTS}/1440-account-export-deleted.png` });
      await context.close();
    });

    // ── b) readable export failures ─────────────────────────────────────
    await check('account export errors: 429 Retry-After, 409 busy, network, 410 expired are readable', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { mode: 'active' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-export-empty"]').waitFor();

      state.rateLimitNext = true;
      await openExportDialog(page);
      await page.locator('[data-testid="account-export-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-error"]').waitFor();
      const rateLimited = await textOf(page, 'account-export-error');
      assert.match(rateLimited, /后重试/, `429 copy should mention when to retry: ${rateLimited}`);
      assert.match(rateLimited, /分钟/, `Retry-After 120s should render as minutes: ${rateLimited}`);
      assert.doesNotMatch(rateLimited, /服务器错误/);
      await page.screenshot({ path: `${SHOTS}/1440-account-export-rate-limited.png` });
      await page.locator('[data-testid="account-export-cancel"]').click();
      await page.locator('[data-testid="account-export-dialog"]').waitFor({ state: 'detached' });

      state.busyNext = true;
      await openExportDialog(page);
      await page.locator('[data-testid="account-export-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-error"]').waitFor();
      assert.match(await textOf(page, 'account-export-error'), /已有导出任务正在生成/);
      await page.locator('[data-testid="account-export-cancel"]').click();
      await page.locator('[data-testid="account-export-dialog"]').waitFor({ state: 'detached' });

      state.failListOnce = true;
      await page.locator('[data-testid="account-export-refresh"]').click();
      await page.locator('[data-testid="account-export-load-error"]').waitFor({ timeout: 10000 });
      assert.match(await textOf(page, 'account-export-load-error'), /网络连接失败/);
      await page.locator('[data-testid="account-export-load-error"]')
        .locator('xpath=..')
        .locator('button')
        .click();
      await page.locator('[data-testid="account-export-empty"]').waitFor({ timeout: 10000 });

      // Failed status is rendered with a readable message, not a raw server error.
      await openExportDialog(page);
      await page.locator('[data-testid="account-export-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-row"][data-status="ready"]')
        .waitFor({ timeout: 15000 });
      state.exports[0].status = 'failed';
      state.exports[0].downloadable = false;
      state.exports[0].error = 'internal boom';
      await page.locator('[data-testid="account-export-refresh"]').click();
      await page.locator('[data-testid="account-export-row"][data-status="failed"]')
        .waitFor({ timeout: 10000 });
      assert.match(
        await page.locator('[data-testid="account-export-row"][data-status="failed"]').innerText(),
        /导出生成失败/,
      );
      await page.locator('[data-testid="account-export-refresh"]').click();

      // Expired download: a fresh job is ready, then the file disappears.
      await openExportDialog(page);
      await page.locator('[data-testid="account-export-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-export-submit"]').click();
      await page.locator('[data-testid="account-export-row"][data-status="ready"]')
        .waitFor({ timeout: 15000 });
      state.expireDownload = true;
      await page.locator('[data-testid="account-export-download"]').click();
      await page.locator('[data-testid="account-export-action-error"]').waitFor({ timeout: 10000 });
      assert.match(await textOf(page, 'account-export-action-error'), /已过期/);
      assert.doesNotMatch(await textOf(page, 'account-export-action-error'), /服务器错误/);
      await context.close();
    });

    // ── c) delete dialog ────────────────────────────────────────────────
    await check('delete dialog: cancel, client validation, wrong password, success clears the session', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { mode: 'active' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-delete-card"]').waitFor();

      await page.locator('[data-testid="account-delete-open"]').click();
      await page.locator('[data-testid="account-delete-dialog"]').waitFor();
      await page.locator('[data-testid="account-delete-submit"]').click();
      await page.locator('[data-testid="account-delete-error"]').waitFor();
      assert.match(await textOf(page, 'account-delete-error'), /请输入登录密码/);
      await page.locator('[data-testid="account-delete-cancel"]').click();
      await page.locator('[data-testid="account-delete-dialog"]').waitFor({ state: 'detached' });
      assert.equal(state.deletionSubmissions, 0, 'cancel must not submit');

      await page.locator('[data-testid="account-delete-open"]').click();
      await page.locator('[data-testid="account-delete-dialog"]').waitFor();
      const dialogText = await page.locator('[data-testid="account-delete-dialog"]').innerText();
      assert.match(dialogText, /7 天/, 'dialog must state the 7-day cooldown');
      assert.match(dialogText, /30 天/, 'dialog must state the 30-day backup tail');
      assert.match(dialogText, /不可恢复/, 'dialog must state irreversibility');
      assert.match(dialogText, /没有邮箱验证/, 'dialog must state there is no email verification');

      await page.locator('[data-testid="account-delete-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-delete-username"]').fill('wrong-name');
      await page.locator('[data-testid="account-delete-confirm"]').fill('DELETE');
      await page.locator('[data-testid="account-delete-submit"]').click();
      await page.locator('[data-testid="account-delete-error"]').waitFor();
      assert.match(await textOf(page, 'account-delete-error'), /用户名不正确/);

      await page.locator('[data-testid="account-delete-username"]').fill('learner-e2e');
      await page.locator('[data-testid="account-delete-confirm"]').fill('delete');
      await page.locator('[data-testid="account-delete-submit"]').click();
      await page.locator('[data-testid="account-delete-error"]').waitFor();
      assert.match(await textOf(page, 'account-delete-error'), /确认词必须是 DELETE/);
      await page.screenshot({ path: `${SHOTS}/1440-account-delete-dialog.png` });

      await page.locator('[data-testid="account-delete-confirm"]').fill('DELETE');
      await page.locator('[data-testid="account-delete-password"]').fill('wrong-password');
      await page.locator('[data-testid="account-delete-submit"]').click();
      await page.locator('[data-testid="account-delete-error"]').waitFor();
      assert.match(await textOf(page, 'account-delete-error'), /密码不正确/);
      assert.equal(state.deletionSubmissions, 0, 'a wrong password must not submit');

      await page.locator('[data-testid="account-delete-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-delete-reason"]').fill('e2e cleanup');
      await page.locator('[data-testid="account-delete-submit"]').click();
      await page.locator('[data-testid="auth-screen"]').waitFor({ timeout: 15000 });
      assert.equal(state.deletionSubmissions, 1, 'successful submit should hit the API once');
      assert.equal(state.sessionRevoked, true, 'the backend revokes the session on submit');
      await page.screenshot({ path: `${SHOTS}/1440-account-delete-signed-out.png`, fullPage: true });
      await context.close();
    });

    // ── d) pending account page ─────────────────────────────────────────
    await check('cooldown page: due date card, export still available, cancel restores the account', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const state = await installStubs(context, { mode: 'pending' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-pending-card"]').waitFor();
      assert.match(await textOf(page, 'account-pending-due'), /预计删除时间/);
      assert.equal(
        await page.locator('[data-testid="account-delete-card"]').count(),
        0,
        'the delete entry must be hidden while a request is pending',
      );
      assert.equal(
        await page.locator('[data-testid="account-pending-banner"]').count(),
        0,
        'the account page uses its own card instead of the global banner',
      );
      await page.locator('[data-testid="account-export-card"]').waitFor();
      assert.match(await textOf(page, 'account-export-pending-note'), /仅可取消删除或导出数据/);
      await page.screenshot({ path: `${SHOTS}/1440-account-pending.png`, fullPage: true });

      await page.locator('[data-testid="account-pending-cancel-open"]').click();
      await page.locator('[data-testid="account-pending-cancel-dialog"]').waitFor();
      await page.locator('[data-testid="account-pending-cancel-password"]').fill('wrong-password');
      await page.locator('[data-testid="account-pending-cancel-submit"]').click();
      await page.locator('[data-testid="account-pending-cancel-error"]').waitFor();
      assert.match(await textOf(page, 'account-pending-cancel-error'), /密码不正确/);

      state.passwordRateLimitNext = true;
      await page.locator('[data-testid="account-pending-cancel-submit"]').click();
      await page.waitForFunction(
        () => document.querySelector('[data-testid="account-pending-cancel-error"]')?.textContent?.includes('后重试'),
      );
      assert.match(await textOf(page, 'account-pending-cancel-error'), /1 分钟后重试/);

      await page.locator('[data-testid="account-pending-cancel-password"]').fill(PASSWORD);
      await page.locator('[data-testid="account-pending-cancel-submit"]').click();
      await page.locator('[data-testid="account-pending-card"]').waitFor({ state: 'detached', timeout: 15000 });
      assert.equal(state.deletion.status, 'active', 'cancel should restore the server state');
      await page.locator('[data-testid="account-delete-card"]').waitFor();
      await page.screenshot({ path: `${SHOTS}/1440-account-pending-cancelled.png`, fullPage: true });
      await context.close();
    });

    // ── e) pending user elsewhere: banner + readable business 403 ───────
    await check('pending account: shell banner, readable business 403, banner opens the account page', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'pending' });
      const page = await context.newPage();
      await page.goto(`${BASE}/#/app/today`);
      await page.locator('[data-testid="app-shell"]').waitFor({ timeout: 20000 });
      const banner = page.locator('[data-testid="account-pending-banner"]');
      await banner.waitFor();
      assert.match(await banner.innerText(), /冷静期/);
      await page.screenshot({ path: `${SHOTS}/1440-pending-banner.png`, fullPage: true });

      const input = page.locator('#video-url').first();
      await input.waitFor({ timeout: 15000 });
      await input.fill(YOUTUBE_URL);
      const submit = page.locator('[data-testid="start-submit"]').first();
      await submit.waitFor({ timeout: 15000 });
      await submit.click();
      const toast = page.locator('[data-testid="toast"]', {
        hasText: '账号正在删除冷静期，仅可取消删除或导出数据。',
      }).first();
      await toast.waitFor({ timeout: 10000 });
      assert.doesNotMatch(await toast.innerText(), /服务器错误/);

      await page.locator('[data-testid="account-pending-banner-action"]').click();
      await page.locator('[data-testid="account-screen"]').waitFor();
      await page.locator('[data-testid="account-pending-card"]').waitFor();
      await context.close();
    });

    // ── f) admin console ────────────────────────────────────────────────
    await check('admin console: deletion list, forced execute (reason + DELETE), audit row', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'active', admin: true });
      const page = await context.newPage();
      // Real entry path: profile → admin button. This exercises the in-app
      // route switch that used to hit a React hook-order crash.
      await openProfile(page);
      await page.locator('[data-testid="account-admin-entry"]').click();
      await page.locator('[data-testid="admin-screen"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="admin-tab-deletions"]').click();
      await page.locator('[data-testid="admin-panel-deletions"]').waitFor();
      await page.locator('[data-testid="admin-deletion-row"]').first().waitFor();
      await page.waitForTimeout(450);

      const firstRow = page.locator('[data-testid="admin-deletion-row"][data-request-id="del-e2e-due"]');
      await firstRow.waitFor();
      const rowText = await firstRow.innerText();
      assert.doesNotMatch(rowText, /second\.person@example\.test/, 'admin list must mask the email');
      assert.match(rowText, /\*\*\*/, 'masked email should keep a visible mask');
      assert.match(rowText, /已到期/);
      await page.screenshot({ path: `${SHOTS}/1440-admin-deletions.png`, fullPage: true });

      // Not-due row: backend refuses without force; the dialog explains why.
      const notDueRow = page.locator('[data-testid="admin-deletion-row"][data-request-id="del-e2e-not-due"]');
      await notDueRow.locator('[data-testid="admin-deletion-execute"]').click();
      await page.locator('[data-testid="admin-deletion-dialog"]').waitFor();
      assert.equal(await page.locator('[data-testid="admin-deletion-submit"]').isDisabled(), true);
      await page.locator('[data-testid="admin-deletion-reason"]').fill('support ticket #7');
      assert.equal(await page.locator('[data-testid="admin-deletion-submit"]').isDisabled(), true);
      await page.locator('[data-testid="admin-deletion-confirm"]').fill('DELETE');
      assert.equal(await page.locator('[data-testid="admin-deletion-submit"]').isDisabled(), false);
      await page.screenshot({ path: `${SHOTS}/1440-admin-execute-dialog.png` });
      await page.locator('[data-testid="admin-deletion-submit"]').click();
      await page.locator('[data-testid="admin-deletion-error"]').waitFor();
      assert.match(await textOf(page, 'admin-deletion-error'), /冷静期尚未结束/);
      await page.locator('[data-testid="admin-deletion-force"]').click();
      await page.locator('[data-testid="admin-deletion-submit"]').click();
      await page.locator('[data-testid="admin-deletion-dialog"]').waitFor({ state: 'detached', timeout: 15000 });
      await page.locator('[data-testid="admin-deletion-row"][data-request-id="del-e2e-not-due"][data-status="completed"]')
        .waitFor({ timeout: 15000 });

      await page.locator('[data-testid="admin-tab-audit"]').click();
      await page.locator('[data-testid="admin-panel-audit"]').waitFor();
      await page.waitForTimeout(450);
      const auditRow = page.locator('[data-testid="admin-audit-row"][data-action="account.deletion.execute.completed"]').first();
      await auditRow.waitFor();
      assert.equal(await auditRow.getAttribute('data-result'), 'ok');
      const auditText = await auditRow.innerText();
      assert.match(auditText, /执行删除/, 'audit action should be localized');
      assert.match(auditText, /成功/);
      await page.screenshot({ path: `${SHOTS}/1440-admin-audit.png`, fullPage: true });
      await context.close();
    });

    // ── g) vi-VN copy ───────────────────────────────────────────────────
    await check('vi-VN: account data + cooldown copy is translated', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await context.addInitScript(() => {
        window.localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
      });
      await installStubs(context, { mode: 'pending' });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-data"]').waitFor();
      const dataText = await page.locator('[data-testid="account-data"]').innerText();
      assert.match(dataText, /Dữ liệu & tài khoản/);
      assert.match(dataText, /Xuất dữ liệu/);
      assert.doesNotMatch(dataText, /[\u4e00-\u9fff]/, 'vi-VN UI must not fall back to Chinese copy');
      const pendingText = await page.locator('[data-testid="account-pending-card"]').innerText();
      assert.match(pendingText, /thời gian chờ xóa/);
      assert.match(pendingText, /Hủy xóa/);
      await page.locator('[data-testid="account-data"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/1440-account-vi.png` });
      await context.close();
    });

    // ── h) narrow viewport ──────────────────────────────────────────────
    await check('375px: account data and admin deletions have no page-level overflow', async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await installStubs(context, { mode: 'active', admin: true });
      const page = await context.newPage();
      await openProfile(page);
      await page.locator('[data-testid="account-data"]').waitFor();
      await assertNoHorizontalOverflow(page, '375 account');
      await page.locator('[data-testid="account-data"]').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/375-account-data.png` });

      await page.locator('[data-testid="account-delete-open"]').click();
      await page.locator('[data-testid="account-delete-dialog"]').waitFor();
      await page.waitForTimeout(450);
      const deleteDialogBox = await page.locator('[data-testid="account-delete-dialog"]').boundingBox();
      assert.ok(deleteDialogBox && deleteDialogBox.x >= 0 && deleteDialogBox.width <= 375,
        `delete dialog should fit 375px: ${JSON.stringify(deleteDialogBox)}`);
      await assertNoHorizontalOverflow(page, '375 delete dialog');
      await page.screenshot({ path: `${SHOTS}/375-account-delete-dialog.png` });
      await page.locator('[data-testid="account-delete-cancel"]').click();
      await page.locator('[data-testid="account-delete-dialog"]').waitFor({ state: 'detached' });

      await page.goto(`${BASE}/#/app/profile/admin`);
      await page.locator('[data-testid="admin-screen"]').waitFor({ timeout: 20000 });
      await page.locator('[data-testid="admin-tab-deletions"]').click();
      await page.locator('[data-testid="admin-panel-deletions"]').waitFor();
      await page.locator('[data-testid="admin-deletion-row"]').first().waitFor();
      await page.waitForTimeout(450);
      await assertNoHorizontalOverflow(page, '375 admin deletions');
      await page.screenshot({ path: `${SHOTS}/375-admin-deletions.png`, fullPage: true });

      await page.locator('[data-testid="admin-deletion-row"][data-request-id="del-e2e-due"]')
        .locator('[data-testid="admin-deletion-execute"]').click();
      await page.locator('[data-testid="admin-deletion-dialog"]').waitFor();
      await page.waitForTimeout(450);
      const executeDialogBox = await page.locator('[data-testid="admin-deletion-dialog"]').boundingBox();
      assert.ok(executeDialogBox && executeDialogBox.x >= 0 && executeDialogBox.width <= 375,
        `execute dialog should fit 375px: ${JSON.stringify(executeDialogBox)}`);
      await assertNoHorizontalOverflow(page, '375 execute dialog');
      await page.screenshot({ path: `${SHOTS}/375-admin-execute-dialog.png` });
      await page.locator('[data-testid="admin-deletion-cancel"]').click();
      await page.locator('[data-testid="admin-deletion-dialog"]').waitFor({ state: 'detached' });
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
