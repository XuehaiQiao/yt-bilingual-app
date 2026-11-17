#!/usr/bin/env node
// Frontend-only acceptance for the free-library level filter (mock API).
//
// The point of this check is that filtering and opening a pre-built video are
// pure frontend behaviour: no estimate/process/define request may fire. We
// intercept the library endpoints with a tiny fixture, let auth and the rest of
// the shell talk to the real backend, and drive the UI with Playwright.
//
// Run (needs a dev server, e.g. APP_URL=http://localhost:5173):
//   npm run check:library
//   APP_URL=http://localhost:5174 PLAYWRIGHT_CHROMIUM_EXECUTABLE="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" npm run check:library
//
// Playwright lives in the repo's scripts/ package (browser tooling); reuse it
// instead of adding a second 100MB browser dependency to the frontend.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('../../scripts/node_modules/playwright');

const BASE = process.env.APP_URL || 'http://localhost:5173';
const EXE = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const LEVELS = { A1: 2, A2: 2, B1: 2, B2: 2, C1: 2, C2: 2 };

function video(id, level, title) {
    return { id, title: `${title} (${level})`, channel: 'Mock Channel', duration: 400, level };
}

const VIDEOS = [
    video('mock-a1-one', 'A1', 'Slow English One'),
    video('mock-a1-two', 'A1', 'Slow English Two'),
    video('mock-a2-one', 'A2', 'Easy English One'),
    video('mock-a2-two', 'A2', 'Easy English Two'),
    video('mock-b1-one', 'B1', 'Six Minute One'),
    video('mock-b1-two', 'B1', 'Six Minute Two'),
    video('mock-b2-one', 'B2', 'Explainer One'),
    video('mock-b2-two', 'B2', 'Explainer Two'),
    video('mock-c1-one', 'C1', 'Talk One'),
    video('mock-c1-two', 'C1', 'Talk Two'),
    video('mock-c2-one', 'C2', 'Lecture One'),
    video('mock-c2-two', 'C2', 'Lecture Two'),
];

const INDEX = {
    videos: VIDEOS,
    articles: [],
    counts: { videos: VIDEOS.length, articles: 0 },
    videoLevels: LEVELS,
};

const DETAIL = {
    ...VIDEOS[0],
    youtubeId: 'h-NZcQF7jgI',
    free: true,
    source: 'youtube',
    thumbnail: 'https://i.ytimg.com/vi/h-NZcQF7jgI/hqdefault.jpg',
    blocks: [
        { id: 1, start: 0, end: 2, en_text: 'Hi everyone!', zh_text: '大家好！', highlights: [] },
        { id: 2, start: 2, end: 4, en_text: 'This is a story.', zh_text: '这是一个故事。', highlights: [] },
    ],
};

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
const billed = [];
page.on('request', (request) => {
    const url = request.url();
    if (/\/(api\/)?(process-video|estimate-cost|define)/.test(url)) billed.push(url);
});

await page.route('**/api/library', (route) => route.fulfill({ json: INDEX }));
await page.route('**/api/library/videos/*', (route) => route.fulfill({ json: DETAIL }));
await page.route('**/api/content/difficulty/batch*', (route) => route.fulfill({ json: { items: [] } }));

await page.goto(`${BASE}/#/content`, { waitUntil: 'domcontentloaded' });
await page.waitForSelector('[data-testid="library-section"]', { timeout: 30000 });

const chips = page.locator('[data-testid="library-level-filter"] button');
assert.equal(await chips.count(), 7, 'expected ALL + six CEFR chips');
for (const [level, expected] of Object.entries(LEVELS)) {
    const label = await page.locator(`[data-testid="library-level-${level}"]`).innerText();
    assert.equal(label.trim().replace(/\s+/g, ' '), `${level} ${expected}`, `${level} chip count`);
}
assert.equal(await page.locator('[data-testid^="library-video-card-"]').count(), 12);

await page.locator('[data-testid="library-level-A1"]').click();
assert.equal(await page.locator('[data-testid^="library-video-card-"]').count(), 2);
assert.equal(await page.locator('[data-testid="library-video-card-mock-a1-one"]').count(), 1);
assert.equal(await page.locator('[data-testid="library-video-card-mock-b2-one"]').count(), 0);

await page.locator('[data-testid="library-level-C2"]').click();
assert.equal(await page.locator('[data-testid^="library-video-card-"]').count(), 2);
assert.equal(await page.locator('[data-testid="library-video-card-mock-c2-two"]').count(), 1);

await page.locator('[data-testid="library-level-ALL"]').click();
assert.equal(await page.locator('[data-testid^="library-video-card-"]').count(), 12);
// Cards expose level, duration and channel (the requirements for the video tab).
const firstCard = page.locator('[data-testid="library-video-card-mock-a1-one"]');
assert.match(await firstCard.innerText(), /A1/);
assert.match(await firstCard.innerText(), /分钟/);
assert.match(await firstCard.innerText(), /Mock Channel/);

// 375px: chips scroll horizontally instead of overflowing the card list.
await page.setViewportSize({ width: 375, height: 812 });
const scroller = page.locator('[data-testid="library-level-filter"]');
const overflow = await scroller.evaluate((el) => el.scrollWidth > el.clientWidth);
assert.equal(overflow, true);
await page.setViewportSize({ width: 1440, height: 1000 });

await firstCard.click();
await page.waitForSelector('[data-testid="library-video-badge"]', { timeout: 30000 });
await page.waitForTimeout(500);
assert.match(page.url(), /#\/learn\/library\/mock-a1-one$/);
const body = await page.locator('body').innerText();
assert.match(body, /Hi everyone!/);
assert.match(body, /大家好！/);
assert.match(body, /This is a story\./);
assert.match(body, /这是一个故事。/);

assert.deepEqual(billed, [], 'opening a pre-built video must not call estimate/process/define');

console.log('library UI check passed:', {
    cards: 12,
    chips: 7,
    levels: LEVELS,
    opened: page.url(),
    billedRequests: billed.length,
});
await browser.close();
