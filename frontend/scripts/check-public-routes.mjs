#!/usr/bin/env node
// End-to-end acceptance for the public-site + app-prefix router refactor.
//
// Covers the user-visible contract:
//   a) `/` (no hash) renders the marketing home, not the app;
//   b) `#/welcome` replaces to `/` (hash removed, history.replaceState);
//   c) all four app tabs render under `#/app/<tab>`;
//   d) old unprefixed URLs redirect to `#/app/...`;
//   e) `#/blog` list + `#/blog/<slug>` direct/refresh;
//   f) the home topbar exposes blog / pricing / resources links;
//   g) blog / pricing / resources share the public header + footer and never
//      render the app shell; pricing shows no invented price;
//   h) `#/login` is public and `next=` only accepts app targets;
//   i) 375 / 1440 screenshots under /tmp/router-public-shots/;
//   j) app main flows regress: the four tabs mount their screens (the deeper
//      back-stack flows live in check-nav-e2e.mjs).
//
// API stubs: auth `/api/auth/me` (guest + authenticated contexts), the two
// public blog endpoints, and the three guest-403 shapes the app shell reads on
// boot. Everything else talks to the running backend, so the normal dev stack
// must be up.
//
// Run: APP_URL=http://localhost:5173 node scripts/check-public-routes.mjs
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
const SHOTS = '/tmp/router-public-shots';
mkdirSync(SHOTS, { recursive: true });

const BLOG_SLUG = 'router-public-post';
const BLOG_POST = {
  slug: BLOG_SLUG,
  title: '公开站路由测试文章',
  date: '2026-11-19',
  excerpt: '主页、博客、定价、资源共用公开 UI。',
  tags: ['路由'],
  lang: 'zh-CN',
  readingMinutes: 2,
};
const BLOG_LIST = { posts: [BLOG_POST], count: 1 };
const BLOG_DETAIL = {
  ...BLOG_POST,
  published: true,
  markdown: '公开站路由测试正文。\n\n## 小节\n\n刷新后仍在。',
  html: '<p>公开站路由测试正文。</p>',
};

const AUTH_ME = {
  user: { id: 'public-e2e', email: 'public-e2e@example.test', username: 'public-e2e', credits: 0, status: 'active' },
  isAdmin: false,
};
const GUEST_ME = { user: null, guest: true };

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
        `Playwright Chromium is not installed and no system Chrome found. ` +
        `Set PLAYWRIGHT_CHROMIUM_EXECUTABLE. (${error.message.split('\n')[0]})`,
      );
    }
    return chromium.launch({ headless: true, executablePath: CHROME_FALLBACK });
  }
}

async function installStubs(context, authPayload) {
  await context.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(authPayload),
  }));
  await context.route(/\/api\/blog\/posts(?:\/.*)?$/, (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/api/blog/posts') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BLOG_LIST),
      });
    }
    if (pathname === `/api/blog/posts/${BLOG_SLUG}`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(BLOG_DETAIL),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Article not found' }),
    });
  });
  await context.route('**/api/favorites*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify([]),
  }));
  await context.route('**/api/review/stats*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(REVIEW_STATS),
  }));
  await context.route('**/api/books/imported*', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ books: [] }),
  }));
  // A fake course id must not 401 and flip the mocked session; keep the alias
  // redirect assertion about routing.
  await context.route('**/api/course/**', (route) => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'not found' }),
  }));
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

async function shot(page, name, fullPage = true) {
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage });
}

async function openPublic(page, hash, rootTestId) {
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector(`[data-testid="${rootTestId}"]`, { timeout: 20000 });
}

const browser = await launchBrowser();
const guestContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const authContext = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
const mobileContext = await browser.newContext({ viewport: { width: 375, height: 812 }, reducedMotion: 'reduce' });
await installStubs(guestContext, GUEST_ME);
await installStubs(authContext, AUTH_ME);
await installStubs(mobileContext, GUEST_ME);

try {
  // ── a) root is the marketing home ───────────────────────────────────────
  await check('a) / renders the marketing home without an app shell', async () => {
    const page = await guestContext.newPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.equal(hashOf(page), '', 'the home is the bare origin, not a hash route');
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, 'home must not mount the app');
      assert.ok(await page.locator('[data-testid="public-header"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-footer"]').isVisible());
      assert.equal(await page.locator('[data-testid="welcome-enter"]').getAttribute('href'), '#/app/content');
      assert.equal(await page.locator('[data-testid="welcome-login"]').getAttribute('href'), '#/login');
      await shot(page, 'home-1440');
    } finally {
      await page.close();
    }
  });

  // ── b) #/welcome → / (hash removed) ─────────────────────────────────────
  await check('b) #/welcome replaces to / with history.replaceState', async () => {
    const page = await guestContext.newPage();
    try {
      await page.goto(`${BASE}/#/welcome`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(
        () => window.location.pathname === '/' && window.location.hash === '',
        null,
        { timeout: 15000 },
      );
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
    } finally {
      await page.close();
    }
  });

  // ── c) the four app tabs live under #/app ───────────────────────────────
  await check('c) all four app tabs render under #/app/<tab>', async () => {
    const page = await guestContext.newPage();
    try {
      for (const [tab, marker] of [
        ['today', 'today-screen'],
        ['content', 'content-screen'],
        ['practice', 'practice-screen'],
        ['profile', 'account-screen'],
      ]) {
        await page.goto(`${BASE}/#/app/${tab}`, { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
        await page.waitForSelector(`[data-testid="${marker}"]`, { timeout: 20000 });
        assert.equal(hashOf(page), `#/app/${tab}`, `${tab} tab must keep the #/app prefix`);
      }
      await page.goto(`${BASE}/#/app/today`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="today-screen"]', { timeout: 20000 });
      await shot(page, 'app-today-1440');
    } finally {
      await page.close();
    }
  });

  // ── d) legacy URLs redirect to #/app ────────────────────────────────────
  await check('d) old #/today and #/content/... redirect to #/app/...', async () => {
    const page = await guestContext.newPage();
    try {
      for (const [legacy, expected] of [
        ['#/app', '#/app/content'],
        ['#/today', '#/app/today'],
        ['#/content', '#/app/content'],
        ['#/practice', '#/app/practice'],
        ['#/profile', '#/app/profile'],
        ['#/content/library', '#/app/content/library'],
        ['#/lesson/router-public-lesson', '#/app/today/lesson/router-public-lesson'],
      ]) {
        await page.goto(`${BASE}/${legacy}`, { waitUntil: 'domcontentloaded' });
        await waitHash(page, expected);
      }
      await page.goto(`${BASE}/#/app/content/library`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="content-screen"]', { timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  // ── e) blog list + article deep link/refresh ────────────────────────────
  await check('e) #/blog lists posts and #/blog/<slug> survives a refresh', async () => {
    const page = await guestContext.newPage();
    try {
      await openPublic(page, '#/blog', 'blog-screen');
      await page.waitForSelector(`[data-testid="blog-post-${BLOG_SLUG}"]`, { timeout: 15000 });
      assert.equal(hashOf(page), '#/blog');
      await page.waitForSelector('[data-testid="public-blog-screen"]');
      await shot(page, 'blog-list-1440');

      await page.goto(`${BASE}/#/blog/${BLOG_SLUG}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="blog-markdown"]', { timeout: 15000 });
      assert.equal(hashOf(page), `#/blog/${BLOG_SLUG}`);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="blog-markdown"]', { timeout: 15000 });
      assert.equal(hashOf(page), `#/blog/${BLOG_SLUG}`, 'refresh must keep the article URL');
      await shot(page, 'blog-article-1440');

      // The list → article → back history works without the app shell.
      await page.goto(`${BASE}/#/blog`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector(`[data-testid="blog-post-${BLOG_SLUG}"]`, { timeout: 15000 });
      await page.click(`[data-testid="blog-post-${BLOG_SLUG}"]`);
      await waitHash(page, `#/blog/${BLOG_SLUG}`);
      await page.waitForSelector('[data-testid="blog-markdown"]', { timeout: 15000 });
      await page.click('[data-testid="public-blog-back"]');
      await waitHash(page, '#/blog');
    } finally {
      await page.close();
    }
  });

  // ── f) home topbar exposes blog / pricing / resources ───────────────────
  await check('f) home topbar links point at #/blog, #/pricing, #/resources', async () => {
    const page = await guestContext.newPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="public-header"]', { timeout: 20000 });
      assert.equal(await page.locator('[data-testid="public-nav-blog"]').getAttribute('href'), '#/blog');
      assert.equal(await page.locator('[data-testid="public-nav-pricing"]').getAttribute('href'), '#/pricing');
      assert.equal(await page.locator('[data-testid="public-nav-resources"]').getAttribute('href'), '#/resources');
      // CTA adapts to the session: a guest sees "进入学习".
      assert.equal(await page.locator('[data-testid="public-header-enter"]').getAttribute('href'), '#/app/content');

      // Clicking the nav goes to the public page with the same header/footer.
      await page.click('[data-testid="public-nav-blog"]');
      await waitHash(page, '#/blog');
      await page.waitForSelector('[data-testid="public-blog-screen"]', { timeout: 20000 });
    } finally {
      await page.close();
    }
  });

  // ── g) shared public UI + honest pricing ────────────────────────────────
  await check('g) blog/pricing/resources share the public header+footer and never the app shell', async () => {
    const page = await guestContext.newPage();
    try {
      for (const [hash, root] of [
        ['#/blog', 'public-blog-screen'],
        ['#/pricing', 'pricing-screen'],
        ['#/resources', 'resources-screen'],
      ]) {
        await openPublic(page, hash, root);
        assert.ok(await page.locator('[data-testid="public-header"]').isVisible(), `${hash}: header`);
        assert.ok(await page.locator('[data-testid="public-footer"]').isVisible(), `${hash}: footer`);
        assert.equal(await page.locator('[data-testid="public-nav-blog"]').count(), 1, `${hash}: blog nav`);
        assert.equal(await page.locator('[data-testid="public-nav-pricing"]').count(), 1, `${hash}: pricing nav`);
        assert.equal(await page.locator('[data-testid="public-nav-resources"]').count(), 1, `${hash}: resources nav`);
        assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, `${hash}: no app shell`);
        assert.equal(await page.locator('[data-testid="public-brand"]').getAttribute('href'), '/');
      }

      await openPublic(page, '#/pricing', 'pricing-screen');
      const pricingText = await page.locator('[data-testid="pricing-screen"]').innerText();
      assert.ok(pricingText.includes('内测免费'), 'pricing must say the beta is free');
      assert.ok(pricingText.includes('定价即将公布'), 'pricing must say the price is not published yet');
      assert.ok(!/[¥$€£]\s*\d/.test(pricingText), 'pricing must not invent a monetary amount');
      assert.equal(await page.locator('[data-testid="pricing-cta-enter"]').getAttribute('href'), '#/app/content');
      assert.equal(await page.locator('[data-testid="pricing-cta-login"]').getAttribute('href'), '#/login');
      await shot(page, 'pricing-1440');

      await openPublic(page, '#/resources', 'resources-screen');
      const expectedLinks = {
        blog: '#/blog',
        library: '#/app/content',
        gutenberg: 'https://www.gutenberg.org/',
        standardebooks: 'https://standardebooks.org/',
        librivox: 'https://librivox.org/',
      };
      for (const [id, href] of Object.entries(expectedLinks)) {
        assert.equal(await page.locator(`[data-testid="resource-card-${id}"]`).getAttribute('href'), href, `${id} href`);
      }
      assert.equal(await page.locator('[data-testid="resource-card-gutenberg"]').getAttribute('target'), '_blank');
      assert.equal(await page.locator('[data-testid="resource-card-standardebooks"]').getAttribute('target'), '_blank');
      assert.equal(await page.locator('[data-testid="resource-card-librivox"]').getAttribute('target'), '_blank');
      await shot(page, 'resources-1440');
    } finally {
      await page.close();
    }
  });

  // ── h) login is public; next accepts app targets only ───────────────────
  await check('h) #/login stays public and next= accepts only app targets', async () => {
    const guest = await guestContext.newPage();
    try {
      await guest.goto(`${BASE}/#/login`, { waitUntil: 'domcontentloaded' });
      await guest.waitForSelector('[data-testid="auth-email"]', { timeout: 20000 });
      assert.equal(await guest.locator('[data-testid="app-shell"]').count(), 0, 'login must not mount the app');
      assert.equal(await guest.locator('[data-testid="login-back"]').count(), 1);
      await shot(guest, 'login-1440');
    } finally {
      await guest.close();
    }

    const page = await authContext.newPage();
    try {
      // A signed-in learner can still open the marketing home at `/`.
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.equal(hashOf(page), '', 'authenticated home stays on the bare origin');
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);

      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('#/app/content')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/app/content');

      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('#/today')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/app/today');

      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('#/blog')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/app/content');

      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('https://evil.example/')}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/app/content');
    } finally {
      await page.close();
    }
  });

  // ── i) 375 screenshots + mobile nav reachability ────────────────────────
  await check('i) 375 layout keeps the public nav and shared shell', async () => {
    const page = await mobileContext.newPage();
    try {
      await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="welcome-screen"]', { timeout: 20000 });
      assert.ok(await page.locator('[data-testid="public-mobile-nav-blog"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-mobile-nav-pricing"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-mobile-nav-resources"]').isVisible());
      await shot(page, 'home-375');

      for (const [hash, root, name] of [
        ['#/blog', 'public-blog-screen', 'blog-list-375'],
        ['#/pricing', 'pricing-screen', 'pricing-375'],
        ['#/resources', 'resources-screen', 'resources-375'],
      ]) {
        await openPublic(page, hash, root);
        assert.ok(await page.locator('[data-testid="public-header"]').isVisible(), `${hash}: mobile header`);
        assert.ok(await page.locator('[data-testid="public-footer"]').isVisible(), `${hash}: mobile footer`);
        assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0, `${hash}: no app shell`);
        await shot(page, name);
      }

      await page.goto(`${BASE}/#/blog/${BLOG_SLUG}`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="blog-markdown"]', { timeout: 20000 });
      await shot(page, 'blog-article-375');

      await page.goto(`${BASE}/#/app/today`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await shot(page, 'app-today-375');
    } finally {
      await page.close();
    }
  });

  // ── j) app main flows still work (tabs + content entry) ─────────────────
  await check('j) app main flows: content tab opens its sections and library anchor', async () => {
    const page = await guestContext.newPage();
    try {
      await page.goto(`${BASE}/#/app/content`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="content-screen"]', { timeout: 20000 });
      await page.waitForSelector('[data-testid="content-library"]', { timeout: 20000 });
      await page.goto(`${BASE}/#/app/content/library`, { waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="content-library"]', { timeout: 20000 });
      assert.equal(hashOf(page), '#/app/content/library');
      await page.waitForSelector('[data-testid="topbar-wordbook"]', { timeout: 20000 });
      await page.click('[data-testid="topbar-wordbook"]');
      await waitHash(page, '#/app/content/vocabulary');
      await page.waitForSelector('[data-testid="vocab-back"]', { timeout: 20000 });
    } finally {
      await page.close();
    }
  });
} finally {
  await guestContext.close();
  await authContext.close();
  await mobileContext.close();
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\npublic routes: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`\npublic routes passed: ${checks}/${checks} flows against ${BASE}; screenshots in ${SHOTS}.`);
