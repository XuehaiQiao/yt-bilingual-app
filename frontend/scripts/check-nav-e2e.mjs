#!/usr/bin/env node
// End-to-end check for the W1 navigation B0 behaviour
// (docs/design-governance/navigation-model.md, remediation-plan W1).
//
// It drives the real app in a browser against the running dev server and
// verifies the user-visible contract the unit test cannot:
//   a) A→B→C then back C→B→A (push stack, D-02/N-03);
//   b) a shared/refreshed deep link stays put and Back stops at the parent
//      inside the app (no history.length guess, N-03);
//   c) `#/content/library` is a real URL and scrolls to the section (D-05);
//   d) report opened from Content returns to Content (N-02);
//   e) word book → article returns to the word book (N-18);
//   f) old `#/learn/...` / `#/lesson/...` aliases rewrite to the new prefix.
//
// Only `GET /api/auth/me` (plus two guest-403 shapes) is stubbed: the point is
// routing, not data. Everything else talks to the configured backend, so the
// normal dev stack must be up.
//
// Run: APP_URL=http://localhost:5173 node scripts/check-nav-e2e.mjs
//      (PLAYWRIGHT_CHROMIUM_EXECUTABLE=/path/to/chrome if bundled Chromium is
//       not installed; the system Chrome is used as a fallback.)
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const BASE = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const CHROME_FALLBACK = [
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].find((candidate) => candidate && existsSync(candidate));

const LIBRARY_VIDEO = 'eci-total-beginners-story';
const LIBRARY_ARTICLE = 'ocean-noise'; // content/library/articles.json
const FAVORITE_ID = 'fav-nav-e2e-1';

const AUTH_ME = {
  user: { id: 'nav-e2e', email: 'nav-e2e@example.test', username: 'nav-e2e', credits: 0, status: 'active' },
  isAdmin: false,
};

// One saved word whose source is a free-library article: the word book can
// then jump to it and the "back" target is the word book again (N-18).
const FAVORITE = {
  id: FAVORITE_ID,
  type: 'vocabulary',
  videoId: 'library-article-nav-e2e',
  start: 0,
  en_text: 'harbor',
  zh_text: '/ˈhɑːrbər/ 港口',
  context_en: 'The harbor was quiet.',
  context_zh: '港口很安静。',
  added_at: Date.now(),
  highlights: [],
  source_kind: 'library_article',
  source_ref: LIBRARY_ARTICLE,
  source_title: 'Ocean Noise',
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
        `Playwright Chromium is not installed and no system Chrome found. ` +
        `Set PLAYWRIGHT_CHROMIUM_EXECUTABLE. (${error.message.split('\n')[0]})`,
      );
    }
    return chromium.launch({ headless: true, executablePath: CHROME_FALLBACK });
  }
}

async function hashOf(page) {
  return new URL(page.url()).hash;
}

async function waitHash(page, hash, timeout = 15000) {
  await page.waitForFunction(
    (expected) => window.location.hash === expected,
    hash,
    { timeout },
  );
}

async function openPage(context, hash) {
  const page = await context.newPage();
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
  return page;
}

const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});

// ── API stubs (routing only; no business mock beyond what auth needs) ──────
await context.route('**/api/auth/me', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(AUTH_ME),
}));
await context.route('**/api/favorites*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify([FAVORITE]),
}));
await context.route('**/api/books/imported*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify({ books: [] }),
}));
await context.route('**/api/review/stats*', (route) => route.fulfill({
  status: 200,
  contentType: 'application/json',
  body: JSON.stringify(REVIEW_STATS),
}));
// A fake course id would otherwise 401 as a guest and sign the mocked session
// out mid-test; a deterministic 404 keeps the alias check about routing.
await context.route('**/api/course/**', (route) => route.fulfill({
  status: 404,
  contentType: 'application/json',
  body: JSON.stringify({ detail: 'not found' }),
}));

try {
  // ── a) A→B→C then back C→B→A ─────────────────────────────────────────────
  await check('a) A→B→C pushes frames; back walks C→B→A', async () => {
    const page = await openPage(context, '#/content');
    try {
      await page.waitForSelector('[data-testid="content-screen"]');
      await page.click('[data-testid="blog-entry"]');
      await waitHash(page, '#/content/blog');
      await page.waitForSelector('[data-testid="blog-screen"]');

      // B → C: the word book keeps the source tab in the URL (N-04 shape).
      await page.click('[data-testid="topbar-wordbook"]');
      await waitHash(page, '#/content/vocabulary');
      await page.waitForSelector('[data-testid="vocab-back"]');

      // C → B
      await page.click('[data-testid="vocab-back"]');
      await waitHash(page, '#/content/blog');

      // B → A (blog's own page back; it calls the same back()).
      await page.locator('[data-testid="blog-screen"] button').first().click();
      await waitHash(page, '#/content');
    } finally {
      await page.close();
    }
  });

  // ── b) shared / refreshed deep link ──────────────────────────────────────
  await check('b) deep link survives a refresh and Back stops at the app parent', async () => {
    const deep = `#/content/learn/library/${LIBRARY_VIDEO}`;
    const page = await openPage(context, deep);
    try {
      await waitHash(page, deep);
      await page.waitForSelector('[data-testid="learning-header"]');

      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="learning-header"]', { timeout: 20000 });
      assert.equal(await hashOf(page), deep, 'refresh must keep the shared deep link');

      // A deep link has no in-app frame beneath it: Back must land on the
      // parent (content), never call history.back() off-site (N-03).
      await page.click('[data-testid="learning-back"]');
      await waitHash(page, '#/content');
    } finally {
      await page.close();
    }
  });

  // ── c) #/content/library is a legal anchor and scrolls ───────────────────
  await check('c) #/content/library keeps its URL and scrolls to the section', async () => {
    const page = await openPage(context, '#/content/library');
    try {
      await page.waitForSelector('[data-testid="content-screen"]');
      await page.waitForSelector('[data-testid="content-library"]');
      // `reducedMotion: reduce` makes scrollIntoView instant; wait for the
      // anchor effect (the section may mount one tick later).
      await page.waitForFunction(() => {
        const scroller = document.querySelector('[data-page-scroll]');
        return Boolean(scroller && scroller.scrollTop > 0);
      }, null, { timeout: 6000 });
      assert.equal(await hashOf(page), '#/content/library', 'the anchor must not be rewritten away');
      const metrics = await page.evaluate(() => {
        const scroller = document.querySelector('[data-page-scroll]');
        const section = document.querySelector('[data-page-scroll] [data-testid="content-library"]');
        if (!scroller || !section) return null;
        const rect = section.getBoundingClientRect();
        return {
          scrollTop: scroller.scrollTop,
          top: rect.top,
          viewport: window.innerHeight,
          visible: rect.top < window.innerHeight && rect.bottom > 0,
        };
      });
      assert.ok(metrics, 'content scroll container / library section missing');
      assert.ok(metrics.visible, 'the library section must be on screen');
      assert.ok(metrics.scrollTop > 0, 'the page must actually scroll down to the section');
      assert.ok(metrics.top >= -8 && metrics.top < 240, `section top ${Math.round(metrics.top)}px is not at the top`);
    } finally {
      await page.close();
    }
  });

  await check('c2) sidebar 免费库/公版书 shortcuts produce the anchor URLs', async () => {
    const page = await openPage(context, '#/content');
    try {
      await page.waitForSelector('[data-testid="content-screen"]');
      await page.click('[data-testid="sidebar-quick-library"]');
      await waitHash(page, '#/content/library');
      await page.click('[data-testid="sidebar-quick-books"]');
      await waitHash(page, '#/content/books');
      await page.waitForSelector('[data-testid="content-books"]');
    } finally {
      await page.close();
    }
  });

  // ── d) report from Content keeps Content as its source tab (N-02) ───────
  await check('d) report opened from Content returns to Content', async () => {
    const page = await openPage(context, '#/content');
    try {
      await page.waitForSelector('[data-testid="content-rail-report-link"]');
      await page.click('[data-testid="content-rail-report-link"]');
      await waitHash(page, '#/content/report');
      await page.waitForSelector('[data-testid="report-close"]');
      await page.click('[data-testid="report-close"]');
      await waitHash(page, '#/content');
    } finally {
      await page.close();
    }
  });

  // ── e) word book → article keeps the word book below it (N-18) ──────────
  await check('e) word book → article returns to the word book, not Profile', async () => {
    const page = await openPage(context, '#/profile');
    try {
      await page.click('[data-testid="topbar-wordbook"]');
      await waitHash(page, '#/profile/vocabulary');
      await page.waitForSelector(`[data-testid="vocab-mine-toggle-${FAVORITE_ID}"]`);
      await page.click(`[data-testid="vocab-mine-toggle-${FAVORITE_ID}"]`);
      await page.click(`[data-testid="vocab-mine-source-${FAVORITE_ID}"]`);
      await waitHash(page, `#/profile/learn/library/${LIBRARY_ARTICLE}`);
      await page.waitForSelector('[data-testid="library-article-back"]');
      await page.click('[data-testid="library-article-back"]');
      await waitHash(page, '#/profile/vocabulary');
    } finally {
      await page.close();
    }
  });

  // ── g) login `next` keeps the target hash (D-09) ────────────────────────
  await check('g) #/login?next= lands on the target; an external next is ignored', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('#/content/discover')}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/content/discover');

      // `http(s)://` must never become a redirect target (open-redirect guard).
      await page.goto(`${BASE}/#/login?next=${encodeURIComponent('http://evil.example/steal')}`, {
        waitUntil: 'domcontentloaded',
      });
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 20000 });
      await waitHash(page, '#/today');
    } finally {
      await page.close();
    }
  });

  // ── f) legacy aliases rewrite once to the tab-prefixed URL (D-01) ───────
  // Each alias gets a fresh page: the old URL mounts a real screen, so reusing
  // one page would let that screen's data requests race the next assertion.
  await check('f) old #/learn alias canonicalises to the content prefix', async () => {
    const page = await openPage(context, `#/learn/library/${LIBRARY_VIDEO}`);
    try {
      await waitHash(page, `#/content/learn/library/${LIBRARY_VIDEO}`);
      await page.waitForSelector('[data-testid="learning-header"]');
    } finally {
      await page.close();
    }
  });

  await check('f2) old #/lesson alias canonicalises to the today prefix', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/#/lesson/nav-alias-lesson`, { waitUntil: 'domcontentloaded' });
      await waitHash(page, '#/today/lesson/nav-alias-lesson');
    } finally {
      await page.close();
    }
  });

  await check('f3) #/profile/favorites canonicalises to the word book', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/#/profile/favorites`, { waitUntil: 'domcontentloaded' });
      await waitHash(page, '#/profile/vocabulary');
    } finally {
      await page.close();
    }
  });
} finally {
  await context.close();
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\nnav e2e: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`\nnav e2e passed: ${checks}/${checks} flows against ${BASE}.`);
