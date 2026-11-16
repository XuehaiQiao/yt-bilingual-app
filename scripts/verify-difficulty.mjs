// Playwright mock verification for the CEFR M2 difficulty badges (specs/026).
//
// Usage:
//   APP_URL=http://127.0.0.1:5199 node verify-difficulty.mjs
//
// It runs against the real local backend for auth/library/recommendations, but
// mocks `/api/content/difficulty/batch` so the badge/bucket assertions are
// deterministic. Fails (exit 1) if any expected badge/bucket text is missing or
// if user-visible copy contains the forbidden word 「个性化」.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5199').replace(/\/+$/, '');
const SHOT = process.env.SHOT || path.resolve(__dirname, '../data/reports/difficulty-web.png');

const BROWSER = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const MOCK = {
    video: { cefrInput: 'B1', bucket: '3–5%' },
    article: { cefrInput: 'B2', bucket: '1–3%' },
};

const browser = await chromium.launch({ channel: BROWSER, headless: true });
try {
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const page = await context.newPage();

    await page.route('**/api/content/difficulty/batch**', async (route) => {
        const url = new URL(route.request().url());
        const items = (url.searchParams.get('items') || '')
            .split(',')
            .map((entry) => entry.trim())
            .filter(Boolean);
        const payload = items.map((entry) => {
            const separator = entry.indexOf(':');
            const kind = separator === -1 ? entry : entry.slice(0, separator);
            const ref = separator === -1 ? '' : entry.slice(separator + 1);
            const values = MOCK[kind] || { cefrInput: 'B1', bucket: '5–8%' };
            return {
                schema: 'difficulty.v1',
                kind,
                ref,
                level: null,
                cefrInput: values.cefrInput,
                cefrTask: null,
                lexicalBand: values.cefrInput,
                syntaxBand: null,
                discourseBand: null,
                confidence: 0.8,
                method: 'rule',
                support: { subtitle: kind === 'article' ? 'none' : 'human', text: true },
                features: { schema: 'difficulty.v1' },
                utrBand: 0.04,
                bucket: values.bucket,
                estimated: true,
                source: 'computed',
            };
        });
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            headers: { 'cache-control': 'no-store' },
            body: JSON.stringify({ schema: 'difficulty.v1', items: payload }),
        });
    });

    await page.goto(`${BASE}/#/content`, { waitUntil: 'networkidle' });
    // Welcome screen (fresh visitor) → enter the app as a guest.
    const enter = page.getByTestId('welcome-enter');
    if (await enter.count()) {
        await enter.click();
        await page.waitForTimeout(1200);
    }
    const guestContinue = page.getByTestId('auth-guest-continue');
    if (await guestContinue.count()) {
        await guestContinue.click();
        await page.waitForTimeout(800);
    }

    await page.getByTestId('library-section').waitFor({ state: 'visible', timeout: 25000 });
    await page.getByTestId('home-recommendations').waitFor({ state: 'visible', timeout: 25000 });
    await page.waitForTimeout(1500);

    const libraryBadges = page.locator('[data-testid^="library-video-difficulty-"], [data-testid^="library-article-difficulty-"]');
    const libraryCount = await libraryBadges.count();
    assert.ok(libraryCount > 0, 'library cards must show a difficulty badge');
    const libraryBands = new Set();
    for (let index = 0; index < libraryCount; index += 1) {
        const badge = libraryBadges.nth(index);
        const band = await badge.getAttribute('data-cefr-input');
        const bucket = await badge.getAttribute('data-bucket');
        assert.ok(band, 'library difficulty badge must carry data-cefr-input');
        assert.ok(bucket, 'library difficulty badge must carry data-bucket');
        assert.ok(['B1', 'B2'].includes(band), `unexpected mocked band: ${band}`);
        libraryBands.add(band);
    }
    assert.ok(libraryBands.size >= 1, 'library should render at least one difficulty band');

    const libraryText = await page.getByTestId('library-section').innerText();
    assert.ok(libraryText.includes('生词约'), 'library card shows the novelty bucket label');
    assert.ok(/3–5%/.test(libraryText), 'library video bucket from mock is rendered');

    const recommendationBadges = page.locator('[data-testid^="recommend-difficulty-"]');
    const recommendationCount = await recommendationBadges.count();
    assert.ok(recommendationCount > 0, 'recommendation cards must show difficulty');
    let withBucket = 0;
    for (let index = 0; index < recommendationCount; index += 1) {
        const badge = recommendationBadges.nth(index);
        const band = (await badge.getAttribute('data-cefr-input')) || '';
        const bucket = (await badge.getAttribute('data-bucket')) || '';
        assert.ok(band || (await badge.innerText()).trim(), 'recommendation badge has a label');
        if (bucket) withBucket += 1;
    }
    assert.ok(withBucket > 0, 'at least one recommendation shows a novelty bucket');

    const recommendationText = await page.getByTestId('home-recommendations').innerText();
    assert.ok(
        recommendationText.includes('与你当前词汇区间接近'),
        'recommendation reason includes the difficulty-match phrase',
    );

    const bodyText = await page.locator('body').innerText();
    assert.ok(!bodyText.includes('个性化'), 'user-visible copy must not say 个性化');

    await page.getByTestId('home-recommendations').scrollIntoViewIfNeeded();
    await page.waitForTimeout(400);
    await page.screenshot({ path: SHOT, fullPage: false });
    console.log(`PASS library badges=${libraryCount} recommendation badges=${recommendationCount} buckets=${withBucket}`);
    console.log(`screenshot: ${SHOT}`);
} finally {
    await browser.close();
}
