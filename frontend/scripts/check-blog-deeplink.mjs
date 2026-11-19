#!/usr/bin/env node
// End-to-end check for the public official blog:
// `#/blog` is the list, `#/blog/<slug>` is a shareable article deep link that
// survives a refresh, and the page renders **outside** the app shell (it must
// not mount `app-shell`). The legacy in-app blog URLs redirect here too.
//
// It drives the real app against the running dev server. Only `GET
// /api/auth/me` and the two public blog endpoints are stubbed, so the check is
// deterministic and does not depend on which articles `content/blog/*.md`
// currently ships; every other request talks to the configured backend, so the
// normal dev stack must be up.
//
// Run: APP_URL=http://localhost:5173 node scripts/check-blog-deeplink.mjs
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

const SLUG = 'n01-deeplink-post';
const POST = {
  slug: SLUG,
  title: '深链测试文章',
  date: '2026-11-19',
  excerpt: 'N-01 深链、刷新、分享、返回列表。',
  tags: ['测试'],
  lang: 'zh-CN',
  readingMinutes: 2,
};
const LIST = { posts: [POST], count: 1 };
const DETAIL = {
  ...POST,
  published: true,
  markdown: 'N-01 深链正文。\n\n## 小节\n\n刷新后仍应看到这段文字。',
  html: '<p>N-01 深链正文。</p>',
};

const AUTH_ME = {
  user: { id: 'blog-e2e', email: 'blog-e2e@example.test', username: 'blog-e2e', credits: 0, status: 'active' },
  isAdmin: false,
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

async function waitForArticle(page) {
  await page.waitForSelector('[data-testid="blog-markdown"]', { timeout: 15000 });
  await page.waitForFunction(
    (title) => {
      const heading = document.querySelector('[data-testid="blog-screen"] h1');
      return heading?.textContent?.includes(title) === true;
    },
    POST.title,
    { timeout: 15000 },
  );
}

async function waitForList(page) {
  await page.waitForSelector('[data-testid="blog-post-list"]', { timeout: 15000 });
  await page.waitForSelector(`[data-testid="blog-post-${SLUG}"]`, { timeout: 15000 });
}

async function openPage(context, hash) {
  const page = await context.newPage();
  await page.goto(`${BASE}/${hash}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="public-blog-screen"]', { timeout: 20000 });
  return page;
}

const browser = await launchBrowser();
const context = await browser.newContext({
  viewport: { width: 1280, height: 800 },
  reducedMotion: 'reduce',
});

try {
  await context.route('**/api/auth/me', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify(AUTH_ME),
  }));
  await context.route(/\/api\/blog\/posts(?:\/.*)?$/, (route) => {
    const pathname = decodeURIComponent(new URL(route.request().url()).pathname);
    if (pathname === '/api/blog/posts') {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(LIST),
      });
    }
    if (pathname === `/api/blog/posts/${SLUG}`) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(DETAIL),
      });
    }
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'Article not found' }),
    });
  });

  // a) Public list renders outside the app shell.
  await check('a) #/blog renders the public list without app-shell', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/#/blog`, { waitUntil: 'domcontentloaded' });
      await waitForList(page);
      assert.equal(hashOf(page), '#/blog');
      assert.ok(await page.locator('[data-testid="public-blog-screen"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-header"]').isVisible());
      assert.ok(await page.locator('[data-testid="public-footer"]').isVisible());
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
    } finally {
      await page.close();
    }
  });

  // b) Deep link renders the article, not the list, and keeps the URL.
  await check('b) deep link #/blog/<slug> opens the article', async () => {
    const page = await openPage(context, `#/blog/${SLUG}`);
    try {
      await waitForArticle(page);
      assert.equal(hashOf(page), `#/blog/${SLUG}`);
      assert.equal(await page.locator('[data-testid="blog-post-list"]').count(), 0);
      assert.ok(await page.locator('[data-testid="blog-screen"]').isVisible());
    } finally {
      await page.close();
    }
  });

  // c) Refresh keeps the article (and its URL).
  await check('c) refresh stays on the article', async () => {
    const page = await openPage(context, `#/blog/${SLUG}`);
    try {
      await waitForArticle(page);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.waitForSelector('[data-testid="public-blog-screen"]', { timeout: 20000 });
      await waitForArticle(page);
      assert.equal(hashOf(page), `#/blog/${SLUG}`);
      assert.equal(await page.locator('[data-testid="blog-post-list"]').count(), 0);
    } finally {
      await page.close();
    }
  });

  // d) A shared URL opened in a fresh page renders the article.
  await check('d) shared article URL opens the article in a fresh page', async () => {
    const page = await openPage(context, `#/blog/${SLUG}`);
    try {
      await waitForArticle(page);
      assert.ok(await page.locator('[data-testid="blog-screen"]').isVisible());
    } finally {
      await page.close();
    }
  });

  // e) List → article pushes the slug; Back returns to the list.
  await check('e) list → article writes the URL, back returns to the list', async () => {
    const page = await openPage(context, '#/blog');
    try {
      await waitForList(page);
      await page.click(`[data-testid="blog-post-${SLUG}"]`);
      await waitHash(page, `#/blog/${SLUG}`);
      await waitForArticle(page);
      assert.equal(await page.locator('[data-testid="blog-post-list"]').count(), 0);

      await page.click('[data-testid="public-blog-back"]');
      await waitHash(page, '#/blog');
      await waitForList(page);
      assert.equal(await page.locator('[data-testid="blog-markdown"]').count(), 0);
    } finally {
      await page.close();
    }
  });

  // f) A cold deep link has no list frame beneath it: Back replaces to the
  //    list instead of calling history.back() off-site (D-02/N-03).
  await check('f) deep-link article back falls back to the public list', async () => {
    const page = await openPage(context, `#/blog/${SLUG}`);
    try {
      await waitForArticle(page);
      await page.click('[data-testid="public-blog-back"]');
      await waitHash(page, '#/blog');
      await waitForList(page);
      assert.ok(await page.locator('[data-testid="public-blog-screen"]').isVisible());
    } finally {
      await page.close();
    }
  });

  // g) Unknown slug shows the existing error panel, no white screen, no
  //    silent URL rewrite; its "back to list" action still works.
  await check('g) invalid slug shows an error panel, not a white screen', async () => {
    const page = await openPage(context, '#/blog/does-not-exist-n01');
    try {
      await page.waitForSelector('[data-testid="blog-detail-error"]', { timeout: 15000 });
      assert.ok(await page.locator('[data-testid="blog-detail-error"]').isVisible());
      const text = (await page.locator('[data-testid="blog-detail-error"]').innerText()).trim();
      assert.ok(text.length > 0, 'error panel should carry a message');
      assert.equal(hashOf(page), '#/blog/does-not-exist-n01');
      assert.equal(await page.locator('[data-testid="blog-markdown"]').count(), 0);

      await page.locator('[data-testid="blog-detail-error"] button').last().click();
      await waitHash(page, '#/blog');
      await waitForList(page);
    } finally {
      await page.close();
    }
  });

  // h) Legacy in-app blog URLs redirect to the public article deep link.
  await check('h) old #/app/.../blog/<slug> redirects to #/blog/<slug>', async () => {
    const page = await context.newPage();
    try {
      await page.goto(`${BASE}/#/app/content/blog/${SLUG}`, { waitUntil: 'domcontentloaded' });
      await waitHash(page, `#/blog/${SLUG}`);
      await waitForArticle(page);
      assert.equal(await page.locator('[data-testid="app-shell"]').count(), 0);
    } finally {
      await page.close();
    }
  });

  // i) The RSS feed entry on the public list is present and opens a new tab.
  await check('i) list still exposes the RSS link', async () => {
    const page = await openPage(context, '#/blog');
    try {
      await waitForList(page);
      const feed = page.locator('a[href*="/api/blog/feed.xml"]');
      assert.equal(await feed.count(), 1);
      assert.equal(await feed.getAttribute('target'), '_blank');
    } finally {
      await page.close();
    }
  });
} finally {
  await context.close();
  await browser.close();
}

if (failures.length > 0) {
  console.error(`\nblog deeplink: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`\nblog deeplink passed: ${checks}/${checks} flows against ${BASE}.`);
