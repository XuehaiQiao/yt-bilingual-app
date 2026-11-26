// P2-50 acceptance — identity-scoped browser storage (v1.1.1 cache hotfix).
//
// Proves the audit's frontend findings are fixed (docs/cache audit
// /tmp/cache-audit/frontend.md §2/§4):
//   A. storageScope module (isolated browser page, no app):
//      key namespacing device/guest/u:<id>, one-time legacy migration, guest →
//      account claim merge (newer-wins / OR / level fallback), guest table drop,
//      foreign session-key clearing, clear-local-data (device prefs preserved).
//   B. Real A/B/C accounts on the same browser profile (real backend + Vite):
//      - guest → A claim merges guest progress into A and empties the guest
//        bucket (next guest cannot inherit it);
//      - A's private data (book progress, video position, sentence day, level)
//        is written under `u:<A>` and shown to A only; B/C see none of it,
//        including after a refresh;
//      - favorites/subscriptions reads are failed on purpose while B logs in:
//        no localStorage fallback is shown and the subscriptions PUT never
//        fires (B's server account stays empty — no P0-2 regression);
//      - A → B → C → A: A's own progress comes back when A signs in again;
//      - bfcache `pageshow.persisted` restores reload instead of painting the
//        previous identity's DOM;
//      - 「清除本机学习数据」 removes every identity's learning bucket but keeps
//        device preferences and the onboarding flag.
//   C. Legacy v1 data upgrade path: seed v1 keys before the app boots, boot as
//      guest (migration runs once), log in as A (claim merge) → A sees the
//      migrated book/sentence progress; the old keys stay for rollback.
//
// Prerequisites (local dev only):
//   - Vite dev server on :5173 (`cd frontend && npm run dev`)
//   - backend on :8000 (`cd backend && venv/bin/python -m uvicorn main:app --port 8000`)
//   - `backend/venv` present: the script mints 3 one-use invite codes so it can
//     create throwaway accounts (G1 invite-only registration). Pass
//     CACHE_ISO_A_EMAIL / _PASSWORD (+ B/C) to reuse existing accounts instead.
//   - Google Chrome installed (Playwright `channel: 'chrome'`), or set
//     CHROME_CHANNEL=bundled to use the Playwright browser.
//
// Run: node scripts/cache-isolation-acceptance.mjs
// Evidence screenshots land in /tmp/cache-iso-<runid>/.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium, request } = require('playwright');

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const API = (process.env.API_URL || 'http://127.0.0.1:8000').replace(/\/+$/, '');
const PASSWORD = process.env.CACHE_ISO_PASSWORD || 'AuditPass123!';
const RUN_ID = Date.now().toString(36);
const SHOTS = `/tmp/cache-iso-${RUN_ID}`;
const VIEWPORT = { width: 1440, height: 900 };
const BATCH = `yt_bilingual.v2`;
const MIGRATION_KEY = `${BATCH}.migrated`;

fs.mkdirSync(SHOTS, { recursive: true });

let checks = 0;
const failures = [];

function ok(message) {
  checks += 1;
  console.log(`  ✓ ${message}`);
}

function expectEqual(actual, expected, message) {
  try {
    assert.deepEqual(actual, expected);
  } catch {
    throw new Error(`${message}\n    expected: ${JSON.stringify(expected)}\n    actual:   ${JSON.stringify(actual)}`);
  }
  ok(message);
}

function expectTrue(condition, message) {
  if (!condition) throw new Error(message);
  ok(message);
}

// ── account provisioning ──────────────────────────────────────────────────

function mintInvites(count) {
  const python = process.env.BACKEND_PYTHON || resolve(REPO, 'backend/venv/bin/python');
  if (!fs.existsSync(python)) {
    throw new Error(
      `missing backend python at ${python}; run setup.sh or pass BACKEND_PYTHON=... ` +
        '(needed to mint invite codes for throwaway test accounts)',
    );
  }
  const code =
    'import json, invites\n' +
    `print(json.dumps([item["code"] for item in invites.create_invites(` +
    `"cache-isolation-acceptance", count=${count}, max_uses=1, expires_in_days=1)]))`;
  const stdout = execFileSync(python, ['-c', code], {
    cwd: resolve(REPO, 'backend'),
    encoding: 'utf8',
  });
  const line = stdout.trim().split('\n').filter(Boolean).pop();
  return JSON.parse(line);
}

async function postWithBackoff(api, path, data, attempts = 4) {
  let lastResponse = null;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    lastResponse = await api.post(path, { data });
    if (lastResponse.status() !== 429) return lastResponse;
    const payload = await lastResponse.json().catch(() => ({}));
    const retryAfter = Number(payload?.retryAfter ?? lastResponse.headers()['retry-after'] ?? 15);
    const waitMs = Math.min(Math.max(retryAfter, 1) + 1, 60) * 1000;
    console.log(`· rate limited on ${path}; retrying in ${Math.round(waitMs / 1000)}s`);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, waitMs));
  }
  return lastResponse;
}

async function provisionAccounts() {
  const fromEnv = ['A', 'B', 'C'].map((tag) => ({
    email: process.env[`CACHE_ISO_${tag}_EMAIL`],
    password: process.env[`CACHE_ISO_${tag}_PASSWORD`],
  }));
  if (fromEnv.every((account) => account.email && account.password)) {
    console.log('· using accounts from CACHE_ISO_*_EMAIL env');
    return fromEnv;
  }
  const invites = mintInvites(3);
  const accounts = ['a', 'b', 'c'].map((tag, index) => ({
    email: `cacheiso-${RUN_ID}-${tag}@example.test`,
    password: PASSWORD,
    username: `ci_${RUN_ID}_${tag}`,
    inviteCode: invites[index],
  }));
  const api = await request.newContext({ baseURL: API });
  try {
    for (const account of accounts) {
      const response = await postWithBackoff(api, '/api/auth/signup', {
        email: account.email,
        password: account.password,
        username: account.username,
        inviteCode: account.inviteCode,
      });
      if (!response.ok()) {
        throw new Error(`signup failed for ${account.email}: HTTP ${response.status()} ${await response.text()}`);
      }
      const payload = await response.json().catch(() => null);
      if (!payload?.user?.id) throw new Error(`signup response missing user id for ${account.email}`);
      account.id = payload.user.id;
    }
  } finally {
    await api.dispose();
  }
  console.log(`· provisioned throwaway accounts A/B/C (<runId> ${RUN_ID})`);
  return accounts;
}

async function launchBrowser() {
  if (process.env.CHROME_CHANNEL === 'bundled') return chromium.launch();
  try {
    return await chromium.launch({ channel: 'chrome' });
  } catch (error) {
    console.warn(`· system Chrome unavailable (${error.message.split('\n')[0]}), using bundled chromium`);
    return chromium.launch();
  }
}

// ── page helpers ──────────────────────────────────────────────────────────

async function dumpStorage(page) {
  return page.evaluate(() => {
    const snapshot = (store) => {
      const entries = {};
      for (let index = 0; index < store.length; index += 1) {
        const key = store.key(index);
        if (key) entries[key] = store.getItem(key) ?? '';
      }
      return entries;
    };
    return {
      local: snapshot(localStorage),
      session: snapshot(sessionStorage),
      href: window.location.href,
    };
  });
}

async function seedLocal(page, entries) {
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);
  }, entries);
}

async function seedSession(page, entries) {
  await page.evaluate((values) => {
    for (const [key, value] of Object.entries(values)) sessionStorage.setItem(key, value);
  }, entries);
}

async function waitFor(fn, timeoutMs = 12000, intervalMs = 250) {
  const started = Date.now();
  let last = null;
  while (Date.now() - started < timeoutMs) {
    last = await fn();
    if (last) return last;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs));
  }
  return last;
}

async function gotoHash(page, hash) {
  await page.goto(`${BASE}/#${hash}`, { waitUntil: 'domcontentloaded' });
}

/** Let a dev-server reload / auth broadcast settle before touching the DOM. */
async function settle(page, ms = 1500) {
  await page.waitForTimeout(ms);
}

/**
 * Sign in through the real UI, whichever signed-out shell is showing.
 *
 * The auth flow broadcasts to its own BroadcastChannel, so a successful login
 * reloads the tab (auth.tsx design), and Vite may also force one reload while
 * optimising a newly discovered dependency. Both can wipe a half-filled form,
 * so the whole "open form → fill → submit" step is retried.
 *
 * The backend re-issues a guest cookie on `/me`, so after logout the shell is
 * usually the guest app (login card on 我的) rather than the anonymous login
 * page; both are handled here.
 */
async function openLoginForm(page) {
  if ((await page.locator('[data-testid="account-logout"]').count()) > 0) return 'authenticated';
  if ((await page.locator('[data-testid="auth-email"]').count()) > 0) return 'form';
  // Could be a guest shell on a non-profile route, or a reload landing.
  await gotoHash(page, '/app/profile');
  await page.waitForSelector('[data-testid="sidebar"], [data-testid="auth-screen"]', { timeout: 20000 });
  if ((await page.locator('[data-testid="auth-email"]').count()) > 0) return 'form';
  const guestButton = page.locator('[data-testid="account-guest-login"]');
  if ((await guestButton.count()) > 0) {
    await guestButton.click();
    await page.waitForSelector('[data-testid="auth-email"]', { state: 'visible', timeout: 20000 });
    return 'form';
  }
  return 'none';
}

async function loginWithUi(page, account) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const state = await openLoginForm(page);
    if (state === 'authenticated') {
      await settle(page);
      return;
    }
    if (state !== 'form') {
      throw new Error(`no login entry while signing in ${account.email}`);
    }
    await page.waitForSelector('[data-testid="auth-email"]', { state: 'visible', timeout: 20000 });
    await page.fill('[data-testid="auth-email"]', account.email);
    await page.fill('[data-testid="auth-password"]', account.password);
    await page.click('[data-testid="auth-submit"]');
    const signedIn = await waitFor(
      async () => (await page.locator('[data-testid="account-logout"]').count()) > 0,
      20000,
      300,
    );
    await settle(page);
    if (signedIn) return;
    const inlineError = await page
      .locator('[data-testid="auth-error"]')
      .innerText()
      .catch(() => '');
    if (/频繁|frequent|429/i.test(inlineError)) {
      console.log('· login rate limited; backing off 16s');
      await settle(page, 16000);
    }
  }
  throw new Error(`UI login failed for ${account.email} after retries`);
}

async function logoutWithUi(page) {
  await gotoHash(page, '/app/profile');
  await page.waitForSelector('[data-testid="account-logout"]', { timeout: 20000 });
  await page.click('[data-testid="account-logout"]');
  // After the local sign-out the shell reloads and `/me` may answer with a
  // fresh guest identity, so accept either signed-out shell.
  await page.waitForFunction(
    () =>
      Boolean(document.querySelector('[data-testid="auth-screen"]')) ||
      Boolean(document.querySelector('[data-testid="sidebar"]')) ||
      Boolean(document.querySelector('[data-testid="account-guest-login"]')),
    { timeout: 20000 },
  );
  await settle(page, 2000);
}


async function me(context) {
  const response = await context.request.get(`${API}/api/auth/me`);
  if (!response.ok()) return null;
  return response.json().catch(() => null);
}

async function subscriptions(context) {
  const response = await context.request.get(`${API}/api/subscriptions`);
  if (!response.ok()) return { status: response.status(), data: null };
  return { status: response.status(), data: await response.json().catch(() => null) };
}

async function pickBook(context) {
  const response = await context.request.get(`${API}/api/books`);
  if (!response.ok()) throw new Error(`GET /api/books failed: HTTP ${response.status()}`);
  const payload = await response.json();
  const books = (payload?.series ?? []).flatMap((series) => series.books ?? []);
  const book = books.find((entry) => entry.status === 'available') ?? books[0];
  if (!book) throw new Error('no curated books in /api/books');
  return book;
}

async function recentListText(page) {
  const list = page.locator('[data-testid="recent-list"]');
  if ((await list.count()) === 0) return '';
  return (await list.first().innerText()).replace(/\s+/g, ' ');
}

async function todayText(page) {
  await gotoHash(page, '/app/today');
  await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
  const text = await waitFor(async () => (await recentListText(page)) || null, 20000);
  return text ?? '';
}

async function sentenceDoneDays(page) {
  await page.goto(`${BASE}/#/app/practice/sentences/1`, { waitUntil: 'domcontentloaded' });
  const bar = page.locator('[data-testid="sentences-rail-progress"] [role="progressbar"]');
  await bar.waitFor({ timeout: 25000 });
  return Number(await bar.getAttribute('aria-valuenow'));
}

async function vocabBand(page) {
  await gotoHash(page, '/app/profile');
  const chip = page.locator('[data-testid="account-vocab-current"]');
  await chip.waitFor({ timeout: 20000 });
  return (await chip.innerText()).trim();
}

function keysMatching(storage, predicate) {
  return Object.keys(storage).filter(predicate);
}

function learningKey(key) {
  if (key.startsWith(`${BATCH}.`)) {
    if (key.startsWith(`${BATCH}.session.`)) return false;
    const rest = key.slice(BATCH.length + 1);
    const dot = rest.indexOf('.');
    if (dot === -1) return false;
    const name = rest.slice(dot + 1);
    return (
      ['progress', 'books_progress', 'imported_books_progress', 'vocab_level', 'last_model', 'guest_mastered_words'].includes(name) ||
      /^sentence-lv\d+-(day|rev)\d+$/.test(name)
    );
  }
  return (
    ['yt_bilingual_progress', 'yt_bilingual_books_progress', 'yt_bilingual_imported_books_progress', 'yt_bilingual_vocab_level', 'yt_bilingual_last_model', 'yt_bilingual_guest_mastered_words', 'yt_bilingual_favorites', 'yt_bilingual_subs'].includes(key) ||
    /^sentence-lv\d+-(day|rev)\d+$/.test(key)
  );
}

function guestScopedKeys(local) {
  return keysMatching(local, (key) => key.startsWith(`${BATCH}.guest.`));
}

function userScopedKeys(local, userId) {
  return keysMatching(local, (key) => key.startsWith(`${BATCH}.u:${userId}.`));
}

// ── A. storageScope module (isolated page, no app mounted) ────────────────

async function runModuleChecks(browser) {
  console.log('\n[A] storageScope module');
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${BASE}/manifest.webmanifest`, { waitUntil: 'domcontentloaded' });
    const results = await page.evaluate(async () => {
      const scopeModule = await import('/src/lib/storageScope.ts');
      const checks = [];
      const check = (name, condition) => {
        checks.push({ name, pass: Boolean(condition) });
      };
      const V2 = 'yt_bilingual.v2';
      const reset = () => {
        localStorage.clear();
        sessionStorage.clear();
      };

      // A1. one-time migration: v1 keys copy into the booting identity's bucket.
      reset();
      localStorage.setItem('yt_bilingual_progress', JSON.stringify({ 'v-1': { time: 10, duration: 100, updated: 5 } }));
      localStorage.setItem('yt_bilingual_books_progress', JSON.stringify({ book: { chapter: 2, paragraph: 3, updated: 8 } }));
      localStorage.setItem('sentence-lv1-day1', '1');
      localStorage.setItem('sentence-lv2-rev1', '1001');
      localStorage.setItem('yt_bilingual_vocab_level', 'interstellar');
      localStorage.setItem('yt_bilingual_last_model', 'm-x');
      localStorage.setItem('yt_bilingual_guest_mastered_words', JSON.stringify(['apple']));
      localStorage.setItem('yt_bilingual_favorites', '[{"id":"private"}]');
      localStorage.setItem('yt_bilingual_subs', '[]');
      localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
      scopeModule.setStorageScope('guest');
      const migratedKeys = Object.keys(localStorage);
      const migration = scopeModule.readMigrationRecord();
      check('migration copies video progress into guest bucket', localStorage.getItem(`${V2}.guest.progress`) !== null);
      check('migration copies book progress into guest bucket', localStorage.getItem(`${V2}.guest.books_progress`) !== null);
      check('migration copies a dynamic sentence day key', localStorage.getItem(`${V2}.guest.sentence-lv1-day1`) === '1');
      check('migration copies a dynamic review grid key', localStorage.getItem(`${V2}.guest.sentence-lv2-rev1`) === '1001');
      check('migration copies learner settings', localStorage.getItem(`${V2}.guest.vocab_level`) === 'interstellar');
      check('guest-only table always lands in the guest bucket', localStorage.getItem(`${V2}.guest.guest_mastered_words`) !== null);
      check('obsolete favorites mirror is deleted', localStorage.getItem('yt_bilingual_favorites') === null);
      check('obsolete subscriptions mirror is deleted', localStorage.getItem('yt_bilingual_subs') === null);
      check('v1 keys stay for rollback', migratedKeys.includes('yt_bilingual_progress') && migratedKeys.includes('sentence-lv1-day1'));
      check('device preference untouched by migration', localStorage.getItem('yt_bilingual_ui_lang') === 'zh-CN');
      check('migration marker written once', migration && migration.scope === 'guest' && migration.copied.length >= 6);

      // A2. key shapes + read/write isolation per scope.
      scopeModule.setStorageScope('guest');
      check('guest key shape', scopeModule.scopedKey('progress') === `${V2}.guest.progress`);
      scopeModule.writeScoped('probe', { value: 'guest' });
      check('guest JSON read', scopeModule.readScoped('probe', null)?.value === 'guest');
      scopeModule.setStorageScope('user', 'user-a');
      check('user key shape', scopeModule.scopedKey('progress') === `${V2}.u:user-a.progress`);
      check('guest value invisible from user scope', scopeModule.readScoped('probe', 'fallback') === 'fallback');
      scopeModule.writeScopedText('sentence-lv3-day2', '1');
      check('user text key shape', localStorage.getItem(`${V2}.u:user-a.sentence-lv3-day2`) === '1');
      scopeModule.setStorageScope('guest');
      check('guest still has its own value', scopeModule.readScoped('probe', null)?.value === 'guest');
      check('user text value invisible from guest', scopeModule.readScopedText('sentence-lv3-day2') === null);

      // A3. session keys are scoped and foreign ones are dropped on switch.
      reset();
      scopeModule.setStorageScope('guest');
      sessionStorage.setItem(`${V2}.session.u:user-a.discover_last:zh-CN`, '{"query":"a"}');
      sessionStorage.setItem(`${V2}.session.guest.discover_last:zh-CN`, '{"query":"g"}');
      scopeModule.setStorageScope('user', 'user-b');
      check('foreign session keys cleared on identity switch', sessionStorage.getItem(`${V2}.session.u:user-a.discover_last:zh-CN`) === null);
      check('guest session key dropped when switching to a user', sessionStorage.getItem(`${V2}.session.guest.discover_last:zh-CN`) === null);
      sessionStorage.setItem(`${V2}.session.u:user-b.discover_last:zh-CN`, '{"query":"b"}');
      scopeModule.setStorageScope('user', 'user-b');
      check('current session key kept on re-activation', sessionStorage.getItem(`${V2}.session.u:user-b.discover_last:zh-CN`) === '{"query":"b"}');

      // A4. guest → user claim merge rules.
      reset();
      scopeModule.setStorageScope('guest');
      localStorage.setItem(`${V2}.guest.progress`, JSON.stringify({ same: { time: 1, updated: 10 }, newer: { time: 2, updated: 99 }, guestOnly: { time: 3, updated: 5 } }));
      localStorage.setItem(`${V2}.u:user-a.progress`, JSON.stringify({ same: { time: 9, updated: 20 }, newer: { time: 2, updated: 1 } }));
      localStorage.setItem(`${V2}.guest.sentence-lv1-day1`, '1');
      localStorage.setItem(`${V2}.u:user-a.sentence-lv1-day1`, '0');
      localStorage.setItem(`${V2}.guest.sentence-lv1-rev1`, '1001');
      localStorage.setItem(`${V2}.u:user-a.sentence-lv1-rev1`, '0000');
      localStorage.setItem(`${V2}.guest.vocab_level`, 'interstellar');
      localStorage.setItem(`${V2}.u:user-a.vocab_level`, 'orbit');
      localStorage.setItem(`${V2}.guest.last_model`, 'guest-model');
      localStorage.setItem(`${V2}.guest.guest_mastered_words`, JSON.stringify(['apple']));
      sessionStorage.setItem(`${V2}.session.guest.pending_job`, '{"jobId":"g"}');
      const merge = scopeModule.mergeGuestScopeIntoUser('user-a');
      const mergedProgress = JSON.parse(localStorage.getItem(`${V2}.u:user-a.progress`));
      check('merge keeps the newer account entry', mergedProgress.same.time === 9);
      check('merge adopts the newer guest entry', mergedProgress.newer.time === 2 && mergedProgress.newer.updated === 99);
      check('merge adds guest-only entry', mergedProgress.guestOnly?.time === 3);
      check('sentence day marks OR together', localStorage.getItem(`${V2}.u:user-a.sentence-lv1-day1`) === '1');
      check('review grids OR together', localStorage.getItem(`${V2}.u:user-a.sentence-lv1-rev1`) === '1001');
      check('account level wins over guest level', localStorage.getItem(`${V2}.u:user-a.vocab_level`) === 'orbit');
      check('missing account model falls back to guest model', localStorage.getItem(`${V2}.u:user-a.last_model`) === 'guest-model');
      check('guest mastered table is dropped, not merged', merge.droppedGuestMastered === true && localStorage.getItem(`${V2}.u:user-a.guest_mastered_words`) === null);
      check('guest bucket cleared after merge', Object.keys(localStorage).filter((key) => key.startsWith(`${V2}.guest.`)).length === 0);
      check('guest session keys cleared by merge', sessionStorage.getItem(`${V2}.session.guest.pending_job`) === null);
      check('merge reports success', merge.cleared === true && merge.failed.length === 0);

      // A5. clear-local-data keeps device preferences + migration marker.
      reset();
      scopeModule.setStorageScope('guest');
      localStorage.setItem(`${V2}.u:user-a.progress`, '{}');
      localStorage.setItem(`${V2}.u:user-a.sentence-lv1-day1`, '1');
      localStorage.setItem(`${V2}.guest.guest_mastered_words`, '["x"]');
      localStorage.setItem('yt_bilingual_books_progress', '{}');
      localStorage.setItem('sentence-lv1-day1', '1');
      localStorage.setItem('yt_bilingual_vocab_level', 'orbit');
      localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
      localStorage.setItem('yt_bilingual_split_ratio', '56');
      localStorage.setItem('yt_bilingual_onboarding_v1', '{"done":true,"at":1}');
      sessionStorage.setItem(`${V2}.session.guest.pending_job`, '{"jobId":"x"}');
      sessionStorage.setItem('yt_bilingual_pending_job', '{"jobId":"legacy"}');
      const removed = scopeModule.clearLocalLearningData();
      const left = Object.keys(localStorage);
      check('clear removes every scoped learning bucket', left.filter((key) => key.startsWith(`${V2}.u:user-a.`) || key.startsWith(`${V2}.guest.`)).length === 0);
      check('clear removes legacy learning keys', !left.includes('yt_bilingual_books_progress') && !left.includes('sentence-lv1-day1') && !left.includes('yt_bilingual_vocab_level'));
      check('clear keeps device preferences', left.includes('yt_bilingual_ui_lang') && left.includes('yt_bilingual_split_ratio'));
      check('clear keeps the onboarding flag', left.includes('yt_bilingual_onboarding_v1'));
      check('clear keeps the migration marker', left.includes(`${V2}.migrated`));
      check('clear removes tab learning state', sessionStorage.getItem(`${V2}.session.guest.pending_job`) === null && sessionStorage.getItem('yt_bilingual_pending_job') === null);
      return { checks, removed, markerCleared: !left.includes(`${V2}.migrated`) };
    });
    for (const entry of results.checks) {
      if (entry.pass) ok(entry.name);
      else throw new Error(`module check failed: ${entry.name}`);
    }
    console.log(`  · localStorage entries cleared by the settings action: ${results.removed}`);
  } finally {
    await context.close();
  }
}

// ── B. A/B/C end-to-end on one browser profile ────────────────────────────

async function runIsolationChecks(browser, accounts, bookA, bookB) {
  console.log('\n[B] A/B/C isolation (real backend)');
  const [accountA, accountB, accountC] = accounts;
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const consoleErrors = [];
  const consoleLogs = [];
  page.on('pageerror', (error) => consoleErrors.push(String(error)));
  page.on('console', (message) => {
    if (message.type() === 'error') consoleLogs.push(message.text().slice(0, 300));
  });
  const historyFixture = [{
    filename: 'iso-video-1',
    videoId: 'iso-video-1',
    metadata: {
      title: 'Cache isolation video',
      channel: 'ISO Channel',
      upload_date: '20260101',
      thumbnail: '',
    },
    model: null,
    modelName: 'ISO',
    studyCount: 1,
    updatedAt: Date.now(),
  }];
  // Same history row for every identity: only the scoped local progress map can
  // decide whether a resume position is offered, which is exactly the P1-2 bug.
  await page.route(/\/api\/history\?/, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(historyFixture) }),
  );

  try {
    // B1. fresh guest boot runs the one-time migration and owns the guest bucket.
    await gotoHash(page, '/app/today');
    await todayText(page);
    await settle(page, 1200);
    const guestMe = await me(context);
    expectTrue(guestMe?.guest === true, 'first boot is a guest with an httpOnly guest session');
    const boot = await dumpStorage(page);
    expectTrue(Boolean(boot.local[MIGRATION_KEY]), 'first boot writes the v2 migration marker');
    // Device preferences must survive identity switches unchanged.
    await seedLocal(page, {
      'yt_bilingual_ui_lang': 'zh-CN',
      'yt_bilingual_split_ratio': '56',
      'yt_bilingual_onboarding_v1': JSON.stringify({ done: true, at: 1 }),
    });

    // B2. guest learning data seeded, then claimed by account A.
    const guestBookProgress = {
      [bookA.id]: { chapter: 2, paragraph: 1, updated: Date.now() },
    };
    await seedLocal(page, {
      [`${BATCH}.guest.books_progress`]: JSON.stringify(guestBookProgress),
      [`${BATCH}.guest.sentence-lv1-day1`]: '1',
      [`${BATCH}.guest.guest_mastered_words`]: JSON.stringify(['guestword']),
    });
    await seedSession(page, {
      [`${BATCH}.session.guest.discover_last:zh-CN`]: JSON.stringify({ query: 'a-private-search', submittedQuery: 'a-private-search', result: { queries: [], candidates: [] } }),
      [`${BATCH}.session.guest.pending_job`]: JSON.stringify({ jobId: 'guest-job', videoId: 'v', url: 'u', targetLang: 'zh-CN', cursor: 1, total: 2, updatedAt: Date.now() }),
    });
    await loginWithUi(page, accountA);
    const aMe = await me(context);
    expectTrue(aMe?.user?.id === accountA.id, 'A is signed in after the guest-dialog login');
    const claimed = await dumpStorage(page);
    expectEqual(guestScopedKeys(claimed.local), [], 'guest bucket is emptied after A claims it');
    const aBookMap = JSON.parse(claimed.local[`${BATCH}.u:${accountA.id}.books_progress`] ?? 'null');
    expectTrue(Boolean(aBookMap?.[bookA.id]), 'guest book progress is merged into u:<A>');
    expectEqual(claimed.local[`${BATCH}.u:${accountA.id}.sentence-lv1-day1`], '1', 'guest sentence day is merged (OR) into u:<A>');
    expectTrue(claimed.local[`${BATCH}.u:${accountA.id}.guest_mastered_words`] === undefined, 'guest mastered table is not copied into the account');
    expectTrue(!Object.keys(claimed.session).some((key) => key.includes('guest')), 'guest tab state is dropped after claim');
    expectEqual(claimed.local['yt_bilingual_ui_lang'], 'zh-CN', 'device language preference survives the claim');
    expectEqual(claimed.local['yt_bilingual_split_ratio'], '56', 'device layout preference survives the claim');
    await page.screenshot({ path: `${SHOTS}/a-profile-after-claim.png` });

    // B3. A's own private data (books / video progress / sentence / level / model).
    await seedLocal(page, {
      [`${BATCH}.u:${accountA.id}.progress`]: JSON.stringify({ 'iso-video-1': { time: 103, duration: 396.36, updated: Date.now() } }),
      [`${BATCH}.u:${accountA.id}.imported_books_progress`]: JSON.stringify({ 'imported-a': { chapter: 1, paragraph: 2, updated: Date.now() } }),
      [`${BATCH}.u:${accountA.id}.vocab_level`]: 'interstellar',
      [`${BATCH}.u:${accountA.id}.last_model`]: 'model-a',
    });
    await seedSession(page, {
      [`${BATCH}.session.u:${accountA.id}.discover_last:zh-CN`]: JSON.stringify({ query: 'a-private-search', submittedQuery: 'a-private-search', result: { queries: [], candidates: [] } }),
      [`${BATCH}.session.u:${accountA.id}.pending_job`]: JSON.stringify({ jobId: 'a-job', videoId: 'iso-video-1', url: 'u', targetLang: 'zh-CN', cursor: 2, total: 4, updatedAt: Date.now() }),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoHash(page, '/app/today');
    await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
    const aToday = await waitFor(async () => {
      const text = await recentListText(page);
      return text.includes(bookA.titleZh || bookA.title) ? text : null;
    }, 20000);
    expectTrue(Boolean(aToday?.includes(bookA.titleZh || bookA.title)), 'A · Today shows their curated book progress');
    expectTrue(Boolean(aToday?.includes('已看 26%')), 'A · Today shows 26% watched from their own video progress');
    expectEqual(await sentenceDoneDays(page), 1, 'A · sentence day 1 shows as done');
    expectEqual(await vocabBand(page), 'B2', 'A · account settings read A\'s own learner level (interstellar)');
    await page.screenshot({ path: `${SHOTS}/a-today-scoped.png` });

    // B4. Fault-injected account switch A → B: no localStorage fallback, no PUT.
    await logoutWithUi(page);
    const afterLogout = await me(context);
    expectTrue(afterLogout?.user == null, 'logout clears the account session (guest/anonymous session only)');
    const failPrivateReads = (route) => route.abort('failed');
    await page.route(/\/api\/favorites/, failPrivateReads);
    await page.route(/\/api\/subscriptions/, failPrivateReads);
    await loginWithUi(page, accountB);
    const bMe = await me(context);
    expectTrue(bMe?.user?.id === accountB.id, 'B is signed in with favorites/subscriptions reads failing');
    const bState = await dumpStorage(page);
    expectTrue(bState.local['yt_bilingual_favorites'] === undefined, 'no global favorites mirror is written as a fallback');
    expectTrue(bState.local['yt_bilingual_subs'] === undefined, 'no global subscriptions mirror is written as a fallback');
    expectTrue(userScopedKeys(bState.local, accountA.id).some((key) => key.endsWith('.books_progress')), 'A\'s scoped data is still stored for A');
    expectEqual(
      keysMatching(bState.local, (key) => key.startsWith(`${BATCH}.u:${accountB.id}.`) && /\.(progress|books_progress|imported_books_progress|vocab_level|last_model)$/.test(key)),
      [],
      'B starts with no private keys inherited from A',
    );
    expectEqual(bState.session[`${BATCH}.session.u:${accountA.id}.discover_last:zh-CN`], undefined, 'A\'s discover search is gone from the tab');
    expectEqual(bState.session[`${BATCH}.session.u:${accountA.id}.pending_job`], undefined, 'A\'s pending job is gone from the tab');
    const bSubs = await subscriptions(context);
    expectEqual(bSubs.data, [], 'B\'s server subscriptions stay empty (fallback PUT never fired)');
    await page.unroute(/\/api\/favorites/, failPrivateReads);
    await page.unroute(/\/api\/subscriptions/, failPrivateReads);
    const bToday = await todayText(page);
    await settle(page, 1200);
    expectTrue(!bToday.includes(bookA.titleZh || bookA.title), 'B · Today does not show A\'s book progress');
    expectTrue(bToday.includes('上次打开') && !bToday.includes('已看 26%'), 'B · the shared video shows "last opened", never A\'s 26% position');
    expectEqual(await sentenceDoneDays(page), 0, 'B · sentence day 1 is not marked done');
    expectTrue((await vocabBand(page)) !== 'B2', 'B · account settings do not inherit A\'s learner level');
    await page.screenshot({ path: `${SHOTS}/b-today-fault-injected.png` });

    // B5. Refresh keeps the isolation, and B's own data persists on its own.
    await seedLocal(page, {
      [`${BATCH}.u:${accountB.id}.books_progress`]: JSON.stringify({ [bookB.id]: { chapter: 4, paragraph: 0, updated: Date.now() } }),
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await gotoHash(page, '/app/today');
    await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
    const bReloaded = await waitFor(async () => {
      const text = await recentListText(page);
      return text.includes(bookB.titleZh || bookB.title) ? text : null;
    }, 20000) ?? '';
    if (!bReloaded.includes(bookB.titleZh || bookB.title)) {
      const debugState = await dumpStorage(page);
      const debugRows = await page.evaluate(() => {
        const list = document.querySelector('[data-testid="recent-list"]');
        const card = document.querySelector('[data-testid="recent-learning"]');
        return {
          rows: list ? Array.from(list.children).map((row) => ({ kind: row.getAttribute('data-kind'), text: (row.textContent || '').slice(0, 80) })) : [],
          cardText: (card?.innerText || '').slice(0, 300),
          markers: {
            loading: document.querySelectorAll('[data-testid="recent-loading"]').length,
            empty: document.querySelectorAll('[data-testid="recent-empty"]').length,
            error: document.querySelectorAll('[data-testid="recent-error"]').length,
            card: document.querySelectorAll('[data-testid="recent-learning"]').length,
          },
          todayText: (document.querySelector('[data-testid="today-screen"]')?.innerText || '').slice(0, 300),
          sidebar: document.querySelector('[data-testid="sidebar-username"]')?.textContent,
          href: location.href,
        };
      });
      console.log('DEBUG B reloaded:', JSON.stringify({
        bookB: { id: bookB.id, title: bookB.titleZh },
        bProgress: debugState.local[`${BATCH}.u:${accountB.id}.books_progress`],
        recent: bReloaded,
        debugRows,
        consoleLogs: consoleLogs.slice(-6),
      }, null, 1));
    }
    expectTrue(bReloaded.includes(bookB.titleZh || bookB.title), 'B · own book progress survives a refresh');
    expectTrue(!bReloaded.includes(bookA.titleZh || bookA.title), 'B · A\'s book progress is still absent after refresh');
    await page.screenshot({ path: `${SHOTS}/b-today-after-reload.png` });

    // B6. B → C: a third identity sees neither A nor B.
    await logoutWithUi(page);
    await loginWithUi(page, accountC);
    const cMe = await me(context);
    expectTrue(cMe?.user?.id === accountC.id, 'C is signed in');
    const cState = await dumpStorage(page);
    expectTrue(
      userScopedKeys(cState.local, accountB.id).some((key) => key.endsWith('.books_progress')),
      'B\'s own bucket stays on disk (data is preserved, not deleted on switch)',
    );
    expectEqual(
      keysMatching(cState.local, (key) => key.startsWith(`${BATCH}.u:${accountC.id}.`) && learningKey(key)),
      [],
      'C received no learning keys (neither A\'s nor B\'s)',
    );
    const cToday = await todayText(page);
    await settle(page, 1200);
    expectTrue(!cToday.includes(bookA.titleZh || bookA.title) && !cToday.includes(bookB.titleZh || bookB.title), 'C · Today shows neither A\'s nor B\'s books');
    expectEqual(await sentenceDoneDays(page), 0, 'C · sentence progress is empty');
    await page.screenshot({ path: `${SHOTS}/c-today.png` });

    // B7. A signs in again and gets their own progress back.
    await logoutWithUi(page);
    await loginWithUi(page, accountA);
    await gotoHash(page, '/app/today');
    await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
    const aBackToday = await waitFor(async () => {
      const text = await recentListText(page);
      return text.includes(bookA.titleZh || bookA.title) ? text : null;
    }, 20000) ?? '';
    expectTrue(aBackToday.includes(bookA.titleZh || bookA.title), 'A · re-login restores A\'s own book progress');
    expectTrue(!aBackToday.includes(bookB.titleZh || bookB.title), 'A · re-login does not pick up B\'s progress');
    expectEqual(await sentenceDoneDays(page), 1, 'A · re-login restores the sentence day mark');
    expectEqual(await vocabBand(page), 'B2', 'A · re-login restores A\'s learner level');

    // B8. bfcache restore reloads instead of painting the previous identity's DOM.
    await gotoHash(page, '/app/today');
    await todayText(page);
    let navigations = 0;
    const countNavigation = (frame) => {
      if (frame === page.mainFrame()) navigations += 1;
    };
    page.on('framenavigated', countNavigation);
    const before = navigations;
    await page
      .evaluate(() => {
        window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
      })
      .catch(() => {
        // Reload tears down the execution context; that is the expected effect.
      });
    const reloaded = await waitFor(() => navigations > before, 15000);
    page.off('framenavigated', countNavigation);
    expectTrue(Boolean(reloaded), 'bfcache pageshow.persisted triggers a reload');
    await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });

    // B9. 「清除本机学习数据」: every identity's learning bucket goes, device prefs stay.
    await gotoHash(page, '/app/profile');
    await page.waitForSelector('[data-testid="account-clear-local-data"]', { timeout: 20000 });
    await page.click('[data-testid="account-clear-local-data"]');
    await page.waitForSelector('[data-testid="clear-local-data-dialog"]', { timeout: 10000 });
    const reloadedAfterClear = page.waitForEvent('framenavigated', { timeout: 20000 });
    await page.click('[data-testid="clear-local-data-dialog-confirm"]');
    await reloadedAfterClear;
    await page.waitForSelector('[data-testid="account-clear-local-data"]', { timeout: 20000 });
    const cleared = await dumpStorage(page);
    expectEqual(keysMatching(cleared.local, learningKey), [], 'clear-local-data removes every learning key (A/B/C and legacy)');
    expectEqual(keysMatching(cleared.session, (key) => key.includes('pending_job') || key.includes('discover_last')), [], 'clear-local-data removes tab learning state');
    expectTrue(Boolean(cleared.local['yt_bilingual_onboarding_v1']), 'clear-local-data keeps the device onboarding flag');
    expectEqual(cleared.local['yt_bilingual_split_ratio'], '56', 'clear-local-data keeps device layout preferences');
    expectTrue(Boolean(cleared.local[MIGRATION_KEY]), 'clear-local-data keeps the migration marker');
    const stillSignedIn = await me(context);
    expectTrue(stillSignedIn?.user?.id === accountA.id, 'clear-local-data does not sign the account out');
    await page.screenshot({ path: `${SHOTS}/a-after-clear-local-data.png` });

    expectEqual(consoleErrors, [], 'no uncaught page errors during the A/B/C scenario');
  } finally {
    await page.unroute(/\/api\/history\?/);
    await context.close();
  }
}

// ── C. v1 legacy data upgrade path (fresh browser profile) ────────────────

async function runLegacyUpgradeChecks(browser, accountA, bookA) {
  console.log('\n[C] v1 → v2 legacy migration + claim (fresh profile)');
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    const now = Date.now();
    await page.addInitScript((seed) => {
      try {
        if (localStorage.getItem('__cache_iso_legacy_seeded') === '1') return;
        localStorage.setItem('yt_bilingual_progress', JSON.stringify({ 'legacy-video': { time: 50, duration: 200, updated: seed.now } }));
        localStorage.setItem('yt_bilingual_books_progress', JSON.stringify({ [seed.bookId]: { chapter: 3, paragraph: 1, updated: seed.now } }));
        localStorage.setItem('sentence-lv1-day1', '1');
        localStorage.setItem('yt_bilingual_vocab_level', 'interstellar');
        localStorage.setItem('yt_bilingual_guest_mastered_words', JSON.stringify(['legacyword']));
        localStorage.setItem('yt_bilingual_favorites', '[{"id":"legacy-private"}]');
        localStorage.setItem('yt_bilingual_subs', '[]');
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_split_ratio', '56');
        localStorage.setItem('yt_bilingual_onboarding_v1', JSON.stringify({ done: true, at: 1 }));
        localStorage.setItem('__cache_iso_legacy_seeded', '1');
      } catch {
        // Storage blocked: the assertions below will report it.
      }
    }, { bookId: bookA.id, now });

    await gotoHash(page, '/app/today');
    await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
    await settle(page, 2000);
    const boot = await dumpStorage(page);
    expectTrue(Boolean(boot.local[MIGRATION_KEY]), 'legacy boot writes the migration marker');
    expectEqual(boot.local['yt_bilingual.v2.guest.sentence-lv1-day1'], '1', 'legacy sentence key copied into the guest bucket');
    expectTrue(Boolean(boot.local['yt_bilingual.v2.guest.books_progress']), 'legacy book progress copied into the guest bucket');
    expectTrue(Boolean(boot.local['yt_bilingual.v2.guest.guest_mastered_words']), 'legacy guest mastered table copied into the guest bucket');
    expectTrue(boot.local['yt_bilingual_progress'] !== undefined, 'legacy v1 keys remain on disk for rollback');
    expectTrue(boot.local['yt_bilingual_favorites'] === undefined, 'legacy favorites mirror purged during migration');

    await loginWithUi(page, accountA);
    const aMe = await me(context);
    expectTrue(aMe?.user?.id === accountA.id, 'A signs in on the upgraded profile');
    const afterLogin = await dumpStorage(page);
    expectTrue(Boolean(JSON.parse(afterLogin.local[`${BATCH}.u:${accountA.id}.books_progress`] ?? 'null')?.[bookA.id]), 'legacy book progress reaches u:<A> through the claim merge');
    expectEqual(afterLogin.local[`${BATCH}.u:${accountA.id}.sentence-lv1-day1`], '1', 'legacy sentence day reaches u:<A> through the claim merge');
    expectEqual(guestScopedKeys(afterLogin.local), [], 'guest bucket emptied after the claim merge');
    expectTrue(Boolean(afterLogin.local['yt_bilingual_progress']), 'legacy keys are still kept after the claim (rollback path)');
    // Login may land on the shell route it started from (or the public page);
    // navigate explicitly before reading Today, as the A/B scenario does.
    await todayText(page);
    const today = await waitFor(async () => {
      const text = await recentListText(page);
      return text.includes(bookA.titleZh || bookA.title) ? text : null;
    }, 20000) ?? '';
    expectTrue(today.includes(bookA.titleZh || bookA.title), 'A sees the migrated book in Today');
    expectEqual(await sentenceDoneDays(page), 1, 'A sees the migrated sentence day');
    await page.screenshot({ path: `${SHOTS}/legacy-a-today.png` });
  } finally {
    await context.close();
  }
}

// ── main ──────────────────────────────────────────────────────────────────

async function main() {
  console.log(`P2-50 cache isolation acceptance · app ${BASE} · api ${API}`);
  const accounts = await provisionAccounts();
  const browser = await launchBrowser();
  try {
    // Curated books for the row assertions (public endpoint, no identity).
    const unauthContext = await browser.newContext();
    const bookA = await pickBook(unauthContext);
    const bookIndex = await unauthContext.request.get(`${API}/api/books`);
    const bookPayload = await bookIndex.json();
    const allBooks = (bookPayload?.series ?? []).flatMap((series) => series.books ?? []);
    const bookB = allBooks.find((entry) => entry.status === 'available' && entry.id !== bookA.id);
    if (!bookB) throw new Error('need two available curated books for the isolation checks');
    await unauthContext.close();

    await runModuleChecks(browser);
    await runIsolationChecks(browser, accounts, bookA, bookB);
    await runLegacyUpgradeChecks(browser, accounts[0], bookA);
  } finally {
    await browser.close();
  }
  console.log(`\nP2-50 cache isolation acceptance: PASS (${checks} checks)`);
  console.log(`screenshots: ${SHOTS}`);
  console.log('note: throwaway accounts remain in the local backend DB (cacheiso-*@example.test).');
}

try {
  await main();
} catch (error) {
  failures.push(error);
  console.error(`\nP2-50 cache isolation acceptance: FAIL\n${error?.stack ?? error}`);
  process.exitCode = 1;
}
