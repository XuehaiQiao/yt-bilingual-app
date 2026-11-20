#!/usr/bin/env node
// Browser acceptance for M4 — real privacy policy / terms pages, the signup
// disclosure and the local-video copy correction.
//
// Covers the user-visible contract:
//   a) `#/privacy` and `#/terms` are real public pages, reachable directly and
//      after a refresh, without the app shell and without a session;
//   b) an anonymous context (401 on `/api/auth/me`) can still read both;
//   c) footer / account page / signup page all link to the real pages, and the
//      old "coming soon" / "legalPending" placeholders are gone;
//   d) the privacy policy discloses operator, collected data, purposes, AI
//      providers + cross-border transfer, cookies, retention, deletion/export
//      (M2 boundaries), security, changes and the invite-only contact channel;
//   e) the terms disclose service, invite-only accounts, prohibited behaviour,
//      content/copyright, third parties, changes, liability and applicable law
//      without inventing a court;
//   f) the signup tab carries the short G1 disclosure (invite-only, no email
//      verification, no self-service reset, 7-day cooldown, subtitle text to
//      the LLM) — not a legal essay;
//   g) the false local-video claim is gone from the dictionaries and the source,
//      replaced by the accurate "subtitle text is sent to the AI model, the
//      video file is not uploaded" copy;
//   h) 375 / 1440 and zh-CN / vi-VN: both pages, no horizontal overflow, no
//      Chinese leaking into the Vietnamese UI;
//   i) keyboard activation of the footer legal link and the in-page 进入学习 CTA;
//   j) the local-video screen renders the corrected AI disclosure;
//   k) a signed-in account page links to both pages (and leaves the app shell);
//   screenshots under /tmp/legal-pages-shots/.
//
// API stubs: `/api/auth/me` (guest + anonymous shapes), the public registration
// switches and the few guest-boot endpoints the app shell reads. Everything is
// intercepted, so the normal dev server must be up (no backend required).
//
// Run: APP_URL=http://localhost:5173 npm run check:legal
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const here = dirname(fileURLToPath(import.meta.url));
const FRONTEND = resolve(here, '..');
const BASE = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));
const SHOTS = '/tmp/legal-pages-shots';
mkdirSync(SHOTS, { recursive: true });
// A tiny WebM header is enough to drive the local-video picker path: the
// screen only needs a File with a video MIME/extension, not a decodable stream.
// (The disclosure under test does not depend on playback.)
const VIDEO_FIXTURE = '/tmp/legal-pages-fixture.webm';
writeFileSync(VIDEO_FIXTURE, Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01]));

const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const GUEST_ME = { user: null, guest: true };
const REGISTRATION = {
  registrationOpen: false,
  inviteSignupEnabled: true,
  inviteRequired: true,
  registrationClosed: false,
};
const AUTH_ME = {
  user: {
    id: 'legal-e2e',
    email: 'legal-e2e@example.test',
    username: 'legal-e2e',
    credits: 0,
    memberSince: Date.now() - 30 * 24 * 60 * 60 * 1000,
    status: 'active',
  },
  isAdmin: false,
};
const ACTIVE_DELETION = {
  status: 'active',
  dueAt: null,
  deletion: null,
  cooldownDays: 7,
  backupRetentionDays: 30,
  notice: '7 天冷静期',
};
const REVIEW_STATS = {
  targetLang: 'zh-CN',
  now: Date.now(),
  today: new Date().toISOString().slice(0, 10),
  dueToday: 0,
  dueNow: 0,
  reviewedToday: 0,
  reviewedWordsToday: 0,
  newWords: 0,
  newToday: 0,
  totalWords: 0,
  suspendedWords: 0,
  streakDays: 0,
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

function json(route, body, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    body: JSON.stringify(body),
  });
}

/**
 * Intercept every /api request for one context. `me` is either the guest
 * payload or the string `'anonymous'` (the legacy 401 answer).
 */
async function installStubs(context, me) {
  await context.route('**/api/**', (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/api/auth/me') {
      if (me === 'anonymous') {
        return json(route, { detail: '未登录', code: 'auth_required' }, 401);
      }
      return json(route, me);
    }
    if (pathname === '/api/auth/registration') return json(route, REGISTRATION);
    if (pathname.startsWith('/api/favorites')) return json(route, []);
    if (pathname === '/api/subscriptions') {
      // GET returns the array the app feeds into `.slice`; PUT just acks.
      return json(route, route.request().method() === 'GET' ? [] : { ok: true });
    }
    if (pathname === '/api/history') return json(route, []);
    if (pathname === '/api/sentences/levels') return json(route, []);
    if (pathname === '/api/report/week') {
      return json(route, { numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    }
    if (pathname === '/api/review/stats') return json(route, REVIEW_STATS);
    if (pathname === '/api/user/summary') {
      return json(route, {
        user: { ...AUTH_ME.user, memberSince: Date.now() - 30 * 24 * 60 * 60 * 1000 },
        monthSpendUsd: 0,
        usageToday: { minutes: 0 },
        version: 'e2e',
        preliminary: false,
      });
    }
    if (pathname === '/api/account/deletion') return json(route, ACTIVE_DELETION);
    if (pathname === '/api/account/exports') {
      return json(route, {
        jobs: [],
        limits: { per24h: 1, per30d: 3, ttlHours: 24, maxBytes: 200 * 1024 * 1024, concurrentJobs: 1 },
      });
    }
    if (pathname === '/api/books/imported') return json(route, { books: [] });
    if (pathname.startsWith('/api/course/')) {
      return json(route, { detail: 'not found' }, 404);
    }
    return json(route, {});
  });
}

async function newContext(browser, { width = 1440, height = 900, language = 'zh-CN', me = GUEST_ME } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    reducedMotion: 'reduce',
  });
  if (language !== 'zh-CN') {
    await context.addInitScript((lang) => {
      try {
        localStorage.setItem('yt_bilingual_ui_lang', lang);
        localStorage.setItem('yt_bilingual_target_lang', lang);
      } catch {
        // storage disabled: the page still renders with the default language
      }
    }, language);
  }
  await installStubs(context, me);
  return context;
}

function hashOf(page) {
  return new URL(page.url()).hash;
}

async function waitHash(page, hash, timeout = 15000) {
  await page.waitForFunction(
    (expected) => window.location.hash === expected,
    hash,
    { timeout },
  );
}

async function openLegal(page, hash, testId) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-testid="${testId}"]`, { timeout: 20000 });
}

async function textOf(page, testId) {
  return page.locator(`[data-testid="${testId}"]`).innerText();
}

async function shot(page, name, fullPage = true) {
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function assertNoHorizontalOverflow(page, label) {
  const overflow = await page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - window.innerWidth),
  );
  assert.ok(overflow <= 1, `${label}: horizontal overflow ${overflow}px`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function* walkSource(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* walkSource(full);
    else if (/\.(ts|tsx)$/.test(entry.name)) yield full;
  }
}

// ── Static copy guarantees ────────────────────────────────────────────────
// The dictionaries are the source of truth for both languages; the old false
// claim must be gone from the data and from any component that could still
// reference the removed key.
function checkStaticCopy() {
  const zh = readJson(resolve(FRONTEND, 'src/i18n/zh-CN.json'));
  const vi = readJson(resolve(FRONTEND, 'src/i18n/vi-VN.json'));

  assert.ok(!('localVideo.subtitleLocalOnly' in zh), 'zh-CN: subtitleLocalOnly must be removed');
  assert.ok(!('localVideo.subtitleLocalOnly' in vi), 'vi-VN: subtitleLocalOnly must be removed');
  assert.match(
    zh['localVideo.subtitleAiDisclosure'],
    /字幕文本会发送给 AI 模型.*视频文件不会上传/,
    'zh-CN: local video must disclose subtitle text to AI and no video upload',
  );
  assert.match(
    vi['localVideo.subtitleAiDisclosure'],
    /Văn bản phụ đề.*mô hình AI.*tệp video không được tải lên/,
    'vi-VN: local video must disclose subtitle text to AI and no video upload',
  );
  for (const [code, dict] of [['zh-CN', zh], ['vi-VN', vi]]) {
    assert.ok(
      !Object.values(dict).some((value) => value.includes('字幕只在本地读取') || value.includes('Phụ đề chỉ được đọc cục bộ')),
      `${code}: the old LOCAL-ONLY subtitle claim must not survive anywhere`,
    );
    assert.ok(!('account.about.legalPending' in dict), `${code}: legalPending key must be removed`);
    assert.ok(!Object.values(dict).some((value) => value.includes('即将上线')), `${code}: no coming-soon copy left`);
  }

  // Contact wording: G1 has no support mailbox/team, so auth + account copy
  // must point at the inviter/admin instead of an imaginary "支持".
  for (const key of [
    'auth.inviteNotice',
    'auth.registrationClosedNotice',
    'auth.error.emailTaken',
    'account.errors.exportFailed',
  ]) {
    assert.doesNotMatch(zh[key], /联系支持/, `zh-CN ${key}: no fake support channel`);
    assert.doesNotMatch(vi[key], /liên hệ hỗ trợ|bộ phận hỗ trợ/i, `vi-VN ${key}: no fake support channel`);
  }
  assert.match(zh['account.data.legal'], /邀请人或管理员/);
  assert.doesNotMatch(zh['account.data.legal'], /人工客服/);

  for (const file of walkSource(resolve(FRONTEND, 'src'))) {
    const source = readFileSync(file, 'utf8');
    assert.ok(!source.includes('subtitleLocalOnly'), `${file}: stale key reference`);
    assert.ok(!source.includes('字幕只在本地读取'), `${file}: stale claim`);
    assert.ok(!source.includes('即将上线'), `${file}: stale coming-soon copy`);
  }
}

const browser = await launchBrowser();
const zhDesktop = await newContext(browser);
const zhMobile = await newContext(browser, { width: 375, height: 812 });
const viDesktop = await newContext(browser, { width: 1440, height: 900, language: 'vi-VN' });
const viMobile = await newContext(browser, { width: 375, height: 812, language: 'vi-VN' });
const anonymous = await newContext(browser, { me: 'anonymous' });
const authDesktop = await newContext(browser, { me: AUTH_ME });

try {
  // ── a) static dictionary/source guarantees ─────────────────────────────
  await check('a) old local-video claim and legal placeholders are gone from copy + source', async () => {
    checkStaticCopy();
  });

  // ── b) privacy direct/deep link/reload (zh, 1440) ──────────────────────
  await check('b) #/privacy is a real public page with the M4 disclosures', async () => {
    const page = await zhDesktop.newPage();
    try {
      await openLegal(page, '#/privacy', 'privacy-screen');
      assert.equal(hashOf(page), '#/privacy');
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, 'privacy must not mount the app');
      assert.ok(await page.locator('[data-testid="public-header"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-footer"]').isVisible());

      const title = await textOf(page, 'legal-title');
      assert.match(title, /隐私政策/);
      const body = await textOf(page, 'privacy-screen');
      for (const needle of [
        '个人开发者',
        '邀请人',
        'Argon2id',
        'ln_session',
        'ln_guest',
        '学习记录',
        'AI 用量',
        '访问日志',
        '字幕文本',
        '视频文件本身不会上传',
        'DeepSeek',
        'Qwen',
        'Gemini',
        '跨境',
        '14–30 天',
        '7 天冷静期',
        '30 天',
        '每 24 小时最多 1 次',
        '30 天内最多 3 次',
        '24 小时内可下载',
        '导出',
        '删除',
        'HTTPS',
        '变更',
      ]) {
        assert.ok(body.includes(needle), `privacy: missing disclosure "${needle}"`);
      }
      assert.doesNotMatch(body, /support@/i, 'privacy: no invented support mailbox');
      assert.doesNotMatch(body, /即将上线/, 'privacy: no coming-soon copy');
      assert.equal(await page.locator('a[href^="mailto:"]').count(), 0, 'no mailto link without a real inbox');

      assert.equal(await page.locator('[data-testid="legal-enter"]').getAttribute('href'), '#/app/today');
      assert.equal(await page.locator('[data-testid="legal-back-home"]').getAttribute('href'), '/');
      assert.ok(await page.locator('[data-testid="legal-contact-note"]').isVisible());

      // Direct link + refresh must stay on the policy.
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
      assert.equal(hashOf(page), '#/privacy', 'refresh must keep the policy URL');
      await shot(page, 'privacy-zh-1440');
    } finally {
      await page.close();
    }
  });

  // ── c) terms (zh, 1440) ────────────────────────────────────────────────
  await check('c) #/terms is a real public page with the M4 terms', async () => {
    const page = await zhDesktop.newPage();
    try {
      await openLegal(page, '#/terms', 'terms-screen');
      assert.equal(hashOf(page), '#/terms');
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
      assert.match(await textOf(page, 'legal-title'), /使用协议/);
      const body = await textOf(page, 'terms-screen');
      for (const needle of [
        '免费内测',
        '邀请码',
        '一人一号',
        '没有邮箱验证',
        '官方嵌入播放器',
        '公版',
        '侵权',
        '第三方',
        '服务变更与终止',
        '免责与责任限制',
        '适用法律',
        '运营者所在地',
        '联系方式',
      ]) {
        assert.ok(body.includes(needle), `terms: missing section/copy "${needle}"`);
      }
      assert.doesNotMatch(body, /人民法院|管辖法院|specific court/i, 'terms: no invented court');
      assert.doesNotMatch(body, /即将上线/);
      assert.equal(await page.locator('[data-testid="legal-other-doc"]').getAttribute('href'), '#/privacy');
      await shot(page, 'terms-zh-1440');
    } finally {
      await page.close();
    }
  });

  // ── d) anonymous (no session at all) can still read both ───────────────
  await check('d) an anonymous visitor (401 /api/auth/me) can open both pages', async () => {
    const page = await anonymous.newPage();
    try {
      for (const [hash, root, title] of [
        ['#/privacy', 'privacy-screen', /隐私政策/],
        ['#/terms', 'terms-screen', /使用协议/],
      ]) {
        await openLegal(page, hash, root);
        assert.match(await textOf(page, 'legal-title'), title);
        assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
        assert.ok(await page.locator('[data-testid="public-header-login"]').isVisible(), 'anonymous header offers login');
      }
    } finally {
      await page.close();
    }
  });

  // ── e) footer links + keyboard activation ──────────────────────────────
  await check('e) footer exposes real legal links and the old placeholders are gone', async () => {
    const page = await zhDesktop.newPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="public-footer-privacy"]').getAttribute('href'), '#/privacy');
      assert.equal(await page.locator('[data-testid="public-footer-terms"]').getAttribute('href'), '#/terms');
      assert.equal(await page.locator('[data-testid="welcome-privacy"]').count(), 0, 'old privacy placeholder removed');
      assert.equal(await page.locator('[data-testid="welcome-terms"]').count(), 0, 'old terms placeholder removed');
      assert.equal(await page.locator('[data-coming-soon="true"]').count(), 0, 'no coming-soon placeholder left');
      await shot(page, 'home-footer-zh-1440');

      // Keyboard: focus the real link and press Enter.
      await page.locator('[data-testid="public-footer-privacy"]').focus();
      await page.keyboard.press('Enter');
      await waitHash(page, '#/privacy');
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
      await assertNoHorizontalOverflow(page, 'privacy zh');

      // In-page cross-link + legal CTA.
      await page.click('[data-testid="legal-other-doc"]');
      await waitHash(page, '#/terms');
      await page.waitForSelector('[data-testid="terms-screen"]', { timeout: 20000 });
      await page.click('[data-testid="legal-back-home"]');
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.equal(hashOf(page), '');

      await page.goto(`${BASE}/#/privacy`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
      await page.locator('[data-testid="legal-enter"]').focus();
      await page.keyboard.press('Enter');
      await waitHash(page, '#/app/today');
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  // ── f) account page links ──────────────────────────────────────────────
  await check('f) account page links to both legal pages and has no legalPending placeholder', async () => {
    const page = await zhDesktop.newPage();
    try {
      await page.goto(`${BASE}/#/app/profile`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="account-screen"]', { timeout: 20000 });
      await page.waitForSelector('[data-testid="account-about"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="account-privacy"]').getAttribute('href'), '#/privacy');
      assert.equal(await page.locator('[data-testid="account-terms"]').getAttribute('href'), '#/terms');
      assert.equal(await page.locator('[data-testid="account-legal-pending"]').count(), 0);
      const about = await textOf(page, 'account-about');
      assert.doesNotMatch(about, /即将上线/, 'account about must not show a coming-soon legal row');
      assert.match(about, /隐私政策/);
      assert.match(about, /使用协议/);
      await page.locator('[data-testid="account-about"]').scrollIntoViewIfNeeded();
      await shot(page, 'account-legal-zh-1440', false);

      await page.click('[data-testid="account-privacy"]');
      await waitHash(page, '#/privacy');
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, 'account → privacy leaves the app shell');
    } finally {
      await page.close();
    }
  });

  // ── g) signup disclosure (zh, 375) ─────────────────────────────────────
  await check('g) signup tab carries the short G1 disclosure and legal links', async () => {
    const page = await zhMobile.newPage();
    try {
      await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="auth-email"]', { timeout: 20000 });
      await page.click('[data-testid="auth-tab-signup"]');
      await page.waitForSelector('[data-testid="auth-signup-disclosure"]', { timeout: 15000 });
      const disclosure = await textOf(page, 'auth-signup-disclosure');
      for (const needle of ['邀请制', '邀请码', '没有邮箱验证', '忘记密码', '邀请人', '7 天冷静期', '30 天', '字幕文本', 'AI']) {
        assert.ok(disclosure.includes(needle), `signup disclosure: missing "${needle}"`);
      }
      assert.doesNotMatch(disclosure, /联系支持/, 'signup disclosure: no fake support channel');
      assert.equal(await page.locator('[data-testid="auth-privacy-link"]').getAttribute('href'), '#/privacy');
      assert.equal(await page.locator('[data-testid="auth-terms-link"]').getAttribute('href'), '#/terms');
      await assertNoHorizontalOverflow(page, 'signup zh');
      await shot(page, 'signup-disclosure-zh-375');

      await page.click('[data-testid="auth-privacy-link"]');
      await waitHash(page, '#/privacy');
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
      await shot(page, 'privacy-zh-375');
    } finally {
      await page.close();
    }
  });

  // ── h) 1440 / 375 × zh / vi: both pages, no overflow, no CJK in vi ────
  await check('h) 375/1440 + zh/vi render both pages with no overflow and no CJK in vi', async () => {
    const matrix = [
      { context: zhDesktop, language: 'zh-CN', width: 1440 },
      { context: zhMobile, language: 'zh-CN', width: 375 },
      { context: viDesktop, language: 'vi-VN', width: 1440 },
      { context: viMobile, language: 'vi-VN', width: 375 },
    ];
    for (const { context, language, width } of matrix) {
      const page = await context.newPage();
      try {
        for (const [hash, root, titlePattern, needles] of [
          [
            '#/privacy',
            'privacy-screen',
            language === 'vi-VN' ? /Chính sách quyền riêng tư/ : /隐私政策/,
            language === 'vi-VN'
              ? ['nhà phát triển cá nhân', 'Argon2id', 'ln_session', 'văn bản phụ đề', '7 ngày', '30 ngày', 'người mời', '24 giờ']
              : ['个人开发者', '字幕文本', '7 天冷静期', '邀请人'],
          ],
          [
            '#/terms',
            'terms-screen',
            language === 'vi-VN' ? /Điều khoản sử dụng/ : /使用协议/,
            language === 'vi-VN'
              ? ['mã mời', 'YouTube', 'bản quyền', 'luật', 'người mời', 'liên hệ']
              : ['邀请码', '官方嵌入播放器', '公版', '适用法律'],
          ],
        ]) {
          await openLegal(page, hash, root);
          assert.match(await textOf(page, 'legal-title'), titlePattern);
          const body = await textOf(page, root);
          for (const needle of needles) {
            assert.ok(body.includes(needle), `${language} ${width} ${hash}: missing "${needle}"`);
          }
          assert.doesNotMatch(body, /即将上线|Sắp ra mắt/, `${language} ${hash}: stale coming-soon copy`);
          if (language === 'vi-VN') {
            assert.ok(!CJK.test(body), `${language} ${hash}: Chinese leaked into the Vietnamese page`);
          }
          assert.ok(await page.locator('[data-testid="public-footer-privacy"]').isVisible());
          assert.ok(await page.locator('[data-testid="public-footer-terms"]').isVisible());
          assert.ok(await page.locator('[data-testid="legal-enter"]').isVisible());
          await assertNoHorizontalOverflow(page, `${language} ${width} ${hash}`);
          await shot(page, `${root.replace('-screen', '')}-${language === 'vi-VN' ? 'vi' : 'zh'}-${width}`);
        }
      } finally {
        await page.close();
      }
    }
  });

  // ── k) signed-in account page links + legal page reachable while signed in ─
  await check('k) signed-in account page links to both legal pages', async () => {
    const page = await authDesktop.newPage();
    try {
      await page.goto(`${BASE}/#/app/profile`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="account-screen"]', { timeout: 20000 });
      await page.waitForSelector('[data-testid="account-about"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="account-privacy"]').getAttribute('href'), '#/privacy');
      assert.equal(await page.locator('[data-testid="account-terms"]').getAttribute('href'), '#/terms');
      await page.click('[data-testid="account-terms"]');
      await waitHash(page, '#/terms');
      await page.waitForSelector('[data-testid="terms-screen"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
      assert.ok(await page.locator('[data-testid="public-header-enter"]').isVisible(), 'signed-in header keeps the enter-app CTA');
      await page.goto(`${BASE}/#/app/profile`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="account-screen"]', { timeout: 20000 });
      await page.click('[data-testid="account-privacy"]');
      await waitHash(page, '#/privacy');
      await page.waitForSelector('[data-testid="privacy-screen"]', { timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  // ── j) local video screen uses the corrected disclosure ────────────────
  await check('j) local video screen shows the corrected AI disclosure (no local-only claim)', async () => {
    const page = await zhDesktop.newPage();
    try {
      await page.goto(`${BASE}/#/app/content`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="content-screen"]', { timeout: 20000 });
      await page.setInputFiles('[data-testid="local-video-input"]', VIDEO_FIXTURE);
      const disclosure = page.locator('[data-testid="local-video-ai-disclosure"]');
      await disclosure.waitFor({ timeout: 20000 });
      const copy = (await disclosure.innerText()).trim();
      assert.match(copy, /字幕文本会发送给 AI 模型/);
      assert.match(copy, /视频文件不会上传/);
      assert.doesNotMatch(copy, /只在本地读取|不会上传。$/);
      await shot(page, 'local-video-disclosure-zh-1440', false);
    } finally {
      await page.close();
    }
  });

  // ── i) vi signup disclosure ────────────────────────────────────────────
  await check('i) vi-VN signup disclosure is fully translated', async () => {
    const page = await viMobile.newPage();
    try {
      await page.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="auth-email"]', { timeout: 20000 });
      await page.click('[data-testid="auth-tab-signup"]');
      await page.waitForSelector('[data-testid="auth-signup-disclosure"]', { timeout: 15000 });
      const disclosure = await textOf(page, 'auth-signup-disclosure');
      for (const needle of ['mã mời', 'xác minh email', 'quên mật khẩu', '7 ngày', '30 ngày', 'văn bản phụ đề']) {
        assert.ok(disclosure.includes(needle), `vi signup disclosure: missing "${needle}"`);
      }
      assert.ok(!CJK.test(disclosure), 'vi signup disclosure must not contain Chinese');
      await assertNoHorizontalOverflow(page, 'signup vi');
      await shot(page, 'signup-disclosure-vi-375');
    } finally {
      await page.close();
    }
  });
} finally {
  await zhDesktop.close();
  await zhMobile.close();
  await viDesktop.close();
  await viMobile.close();
  await anonymous.close();
  await authDesktop.close();
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\nlegal pages: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`\nlegal pages passed: ${checks}/${checks} flows against ${BASE}; screenshots in ${SHOTS}.`);
