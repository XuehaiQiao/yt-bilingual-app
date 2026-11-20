#!/usr/bin/env node
// Browser acceptance for the M1 G1 invite/registration gate (specs/032).
//
// This script exercises the real React UI in Chromium with a stubbed API so it
// runs without a backend or a seeded database. The backend contract itself is
// covered by backend/tests/test_invite_registration.py; here we verify:
//   a) invite-only signup: invitation field + "no self-service password reset"
//      notice, client-side required validation, invalid-code copy, success;
//   b) fully closed registration: closed notice + disabled submit;
//   c) public registration (G2): invite field is optional;
//   d) admin console: generate one code (one-time plaintext), list it, revoke
//      it, and see the revoked badge;
//   e) 375 / 1440 screenshots under /tmp/invite-registration-shots/.
//
// The API stubs live in `installStubs`; every unhandled /api request gets an
// empty JSON object so the app shell can boot through its auxiliary requests.
//
// Run: APP_URL=http://localhost:5173 npm run check:invite
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
const SHOTS = '/tmp/invite-registration-shots';
mkdirSync(SHOTS, { recursive: true });

const VALID_CODE = 'LN-E2E1-VALID-0001';
const ADMIN_CODE = 'LN-E2E2-ADMIN-0001';
const ADMIN_EMAIL = 'admin-e2e@example.test';
const GUEST_ME = { user: null, guest: true };

const REGISTRATION_INVITE_ONLY = {
  registrationOpen: false,
  inviteSignupEnabled: true,
  inviteRequired: true,
  registrationClosed: false,
};
const REGISTRATION_OPEN = {
  registrationOpen: true,
  inviteSignupEnabled: true,
  inviteRequired: false,
  registrationClosed: false,
};
const REGISTRATION_CLOSED = {
  registrationOpen: false,
  inviteSignupEnabled: false,
  inviteRequired: false,
  registrationClosed: true,
};
const ADMIN_ME = {
  user: {
    id: 'admin-e2e',
    email: ADMIN_EMAIL,
    username: 'admin-e2e',
    credits: 0,
    status: 'active',
  },
  isAdmin: true,
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
        `Playwright Chromium is not installed and no system Chrome found. `
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

function emptyStats() {
  return {
    users: { total: 1, new7d: 1, activeToday: 0, guests: 0 },
    ai: {
      todayCostUsd: 0,
      monthCostUsd: 0,
      todayCalls: 0,
      todayByFeature: {},
    },
    jobs: { failed: 0, running: 0, pendingRetry: 0 },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Install the API double for one browser context.
 * `mode` is 'invite-only' | 'open' | 'closed'; admin mode adds the invite list
 * state and the admin console payloads.
 */
async function installStubs(context, { mode, admin = false }) {
  const state = {
    invites: [],
  };
  const config = mode === 'open'
    ? REGISTRATION_OPEN
    : mode === 'closed'
      ? REGISTRATION_CLOSED
      : REGISTRATION_INVITE_ONLY;

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

    if (path === '/api/auth/me') {
      return json(route, admin ? ADMIN_ME : GUEST_ME);
    }
    if (path === '/api/auth/registration') {
      return json(route, config);
    }
    if (path === '/api/auth/signup') {
      const body = request.postDataJSON() || {};
      if (mode === 'closed') {
        return json(route, {
          detail: '注册暂未开放，请稍后再试。',
          code: 'registration_closed',
        }, 403);
      }
      if (mode === 'invite-only') {
        if (!body.inviteCode) {
          return json(route, {
            detail: '本次内测为邀请制，请填写邀请码。',
            code: 'invite_required',
          }, 403);
        }
        if (body.inviteCode.replace(/[^A-Z0-9]/gi, '').toUpperCase() !== VALID_CODE.replace(/-/g, '')) {
          return json(route, {
            detail: '邀请码无效或不可用，请向邀请人确认。',
            code: 'invite_invalid',
          }, 403);
        }
      }
      return json(route, {
        user: {
          id: `user-${Date.now()}`,
          email: body.email,
          username: body.username,
          credits: 0,
          status: 'active',
        },
      }, 201);
    }

    if (admin && path === '/api/admin/invites' && method === 'GET') {
      const status = url.searchParams.get('status') || 'all';
      const rows = status === 'all'
        ? state.invites
        : state.invites.filter((row) => row.status === status);
      const counts = { active: 0, used: 0, expired: 0, revoked: 0 };
      for (const row of state.invites) counts[row.status] += 1;
      return json(route, {
        invites: rows,
        total: rows.length,
        limit: 20,
        offset: 0,
        hasMore: false,
        status,
        counts,
        config,
      });
    }
    if (admin && path === '/api/admin/invites' && method === 'POST') {
      const row = {
        id: 'inv-e2e-1',
        prefix: ADMIN_CODE.replace(/-/g, '').slice(0, 6),
        label: 'e2e',
        maxUses: 1,
        usedCount: 0,
        status: 'active',
        createdBy: 'admin-e2e',
        createdAt: Date.now(),
        expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
        revokedAt: null,
        revokedBy: null,
        lastUsedAt: null,
      };
      state.invites.push(row);
      return json(route, {
        codes: [
          {
            id: row.id,
            code: ADMIN_CODE,
            prefix: row.prefix,
            label: row.label,
            maxUses: row.maxUses,
            usedCount: 0,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
          },
        ],
        config,
      });
    }
    const revokeMatch = path.match(/^\/api\/admin\/invites\/([^/]+)\/revoke$/);
    if (admin && revokeMatch && method === 'POST') {
      const target = state.invites.find((row) => row.id === revokeMatch[1]);
      if (!target) return json(route, { detail: '邀请码不存在。' }, 404);
      const already = target.status === 'revoked';
      target.status = 'revoked';
      target.revokedAt = Date.now();
      target.revokedBy = 'admin-e2e';
      return json(route, { invite: target, alreadyRevoked: already });
    }

    if (path === '/api/admin/stats') return json(route, emptyStats());
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
          db: { ok: true, migrations: { current: '0023', head: '0023' } },
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
    if (path === '/api/admin/users') {
      return json(route, { users: [], total: 0, limit: 20, offset: 0, hasMore: false });
    }

    // Everything else is an auxiliary app-shell request; answer an empty object.
    return json(route, {});
  });
  return state;
}

async function signupTab(page) {
  await page.goto(`${BASE}/#/login`);
  await page.locator('[data-testid="auth-tab-signup"]').click();
  await page.locator('[data-testid="auth-screen"]').waitFor();
}

async function fillSignup(page, { email, invite = '' }) {
  await page.locator('[data-testid="auth-email"]').fill(email);
  await page.locator('[data-testid="auth-username"]').fill('e2e-user');
  await page.locator('[data-testid="auth-password"]').fill('e2e-password-123');
  if (invite) {
    await page.locator('[data-testid="auth-invite"]').fill(invite);
  }
}

async function main() {
  const browser = await launchBrowser();
  try {
    await check('375 invite-only signup: field, notice and required error', async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await installStubs(context, { mode: 'invite-only' });
      const page = await context.newPage();
      await signupTab(page);
      await page.locator('[data-testid="auth-invite-notice"]').waitFor();
      const notice = await page.locator('[data-testid="auth-invite-notice"]').innerText();
      assert.match(notice, /邀请码/);
      assert.match(notice, /忘记密码/);
      assert.equal(await page.locator('[data-testid="auth-invite"]').isVisible(), true);
      await fillSignup(page, { email: 'required-error@example.test' });
      await page.locator('[data-testid="auth-submit"]').click();
      await page.locator('[data-testid="auth-error"]').waitFor();
      assert.match(await page.locator('[data-testid="auth-error"]').innerText(), /邀请码/);
      await page.screenshot({ path: `${SHOTS}/375-invite-required.png`, fullPage: true });
      await context.close();
    });

    await check('375 invalid invite shows localized copy; valid invite signs in', async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await installStubs(context, { mode: 'invite-only' });
      const page = await context.newPage();
      await signupTab(page);
      await fillSignup(page, {
        email: 'invalid-code@example.test',
        invite: 'LN-WRNG-WRNG-WRNG',
      });
      await page.locator('[data-testid="auth-submit"]').click();
      await page.locator('[data-testid="auth-error"]').waitFor();
      assert.match(await page.locator('[data-testid="auth-error"]').innerText(), /邀请码无效/);
      await page.screenshot({ path: `${SHOTS}/375-invalid-invite.png`, fullPage: true });

      await page.locator('[data-testid="auth-invite"]').fill(VALID_CODE);
      await page.locator('[data-testid="auth-submit"]').click();
      await page.locator('[data-testid="auth-screen"]').waitFor({ state: 'detached' });
      await context.close();
    });

    await check('1440 invite prefilled from URL and succeeds', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'invite-only' });
      const page = await context.newPage();
      await page.goto(`${BASE}/?invite=${encodeURIComponent(VALID_CODE)}#/login`);
      await page.locator('[data-testid="auth-tab-signup"]').click();
      assert.equal(await page.locator('[data-testid="auth-invite"]').inputValue(), VALID_CODE);
      await fillSignup(page, { email: 'prefill@example.test' });
      await page.locator('[data-testid="auth-submit"]').click();
      await page.locator('[data-testid="auth-screen"]').waitFor({ state: 'detached' });
      await context.close();
    });

    await check('1440 fully closed registration disables signup', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'closed' });
      const page = await context.newPage();
      await signupTab(page);
      await page.locator('[data-testid="auth-registration-closed"]').waitFor();
      assert.match(
        await page.locator('[data-testid="auth-registration-closed"]').innerText(),
        /暂未开放/,
      );
      assert.equal(await page.locator('[data-testid="auth-invite"]').count(), 0);
      assert.equal(await page.locator('[data-testid="auth-submit"]').isDisabled(), true);
      await page.screenshot({ path: `${SHOTS}/1440-registration-closed.png`, fullPage: true });
      await context.close();
    });

    await check('1440 open registration makes the invite field optional', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'open' });
      const page = await context.newPage();
      await signupTab(page);
      assert.equal(await page.locator('[data-testid="auth-invite"]').isVisible(), true);
      assert.match(
        await page.locator('[data-testid="auth-invite-hint"]').innerText(),
        /不填/,
      );
      await fillSignup(page, { email: 'open@example.test' });
      await page.locator('[data-testid="auth-submit"]').click();
      await page.locator('[data-testid="auth-screen"]').waitFor({ state: 'detached' });
      await context.close();
    });

    await check('1440 admin generates, copies and revokes an invite', async () => {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      await installStubs(context, { mode: 'invite-only', admin: true });
      const page = await context.newPage();
      await page.goto(`${BASE}/#/app/profile/admin`);
      await page.locator('[data-testid="admin-screen"]').waitFor();
      await page.locator('[data-testid="admin-tab-invites"]').click();
      await page.locator('[data-testid="admin-panel-invites"]').waitFor();
      assert.match(
        await page.locator('[data-testid="admin-invites-registration-state"]').innerText(),
        /邀请制/,
      );

      await page.locator('[data-testid="admin-invite-create"]').click();
      await page.locator('[data-testid="admin-invite-create-dialog"]').waitFor();
      await page.locator('[data-testid="admin-invite-count"]').fill('1');
      await page.locator('[data-testid="admin-invite-max-uses"]').fill('1');
      await page.locator('[data-testid="admin-invite-expires-days"]').fill('30');
      await page.locator('[data-testid="admin-invite-label"]').fill('e2e');
      await page.locator('[data-testid="admin-invite-generate"]').click();
      await page.locator('[data-testid="admin-invite-created-warning"]').waitFor();
      assert.equal(await page.locator('[data-testid="admin-invite-code"]').first().innerText(), ADMIN_CODE);
      await page.screenshot({ path: `${SHOTS}/1440-admin-invite-generated.png`, fullPage: true });
      await page.locator('[data-testid="admin-invite-done"]').click();

      const row = page.locator('[data-testid="admin-invite-row"]').first();
      await row.waitFor();
      assert.equal(await row.getAttribute('data-status'), 'active');
      await row.locator('[data-testid="admin-invite-revoke"]').click();
      await page.locator('[data-testid="admin-invite-revoke-confirm"]').click();
      await page.locator('[data-testid="admin-invite-row"][data-status="revoked"]').first().waitFor();
      await page.screenshot({ path: `${SHOTS}/1440-admin-invite-revoked.png`, fullPage: true });
      await context.close();
    });

    await check('375 admin invites tab is usable without page-level overflow', async () => {
      const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
      await installStubs(context, { mode: 'invite-only', admin: true });
      const page = await context.newPage();
      await page.goto(`${BASE}/#/app/profile/admin`);
      await page.locator('[data-testid="admin-screen"]').waitFor();
      await page.locator('[data-testid="admin-tab-invites"]').click();
      await page.locator('[data-testid="admin-panel-invites"]').waitFor();
      const overflow = await page.evaluate(() => (
        document.documentElement.scrollWidth - document.documentElement.clientWidth
      ));
      assert.ok(overflow <= 1, `page-level horizontal overflow: ${overflow}px`);
      await page.screenshot({ path: `${SHOTS}/375-admin-invites.png`, fullPage: true });
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

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
