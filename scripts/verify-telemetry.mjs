// Playwright verification for CEFR M2 #7 behavior telemetry (frontend).
//
// Usage:
//   # terminal 1: backend with the 0017 migration on :8001
//   AUTH_DB_PATH=/tmp/yt/app.db venv/bin/uvicorn main:app --port 8001
//   # terminal 2: this script
//   APP_URL=http://127.0.0.1:5199 node scripts/verify-telemetry.mjs
//
// `APP_URL` must point at a Vite dev server started with
// `VITE_API_BASE=http://127.0.0.1:8001` (the real backend supplies the
// library/auth endpoints; the script itself is offline for the signals under
// test). `/api/events` and `/api/define` are mocked:
//   - every `/api/events` batch is captured and asserted;
//   - a second page makes `/api/events` fail with 503 and proves word lookup /
//     playback-rate control / seeking still work (telemetry failures are
//     silent).
//
// Covered events: dict_lookup, video_replay, playback_rate, tab_visibility.
// Payload assertions require: contentRef, normalized word, source, from/to
// seconds, from/to rate, visibility state + visible seconds, anonymous
// sessionId, and no context/sentence/free text.
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.APP_URL || 'http://127.0.0.1:5199').replace(/\/+$/, '');
const CHANNEL = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/m2-telemetry-shots';
fs.mkdirSync(SHOT_DIR, { recursive: true });

const browser = await chromium.launch({ channel: CHANNEL, headless: true }).catch(() =>
    chromium.launch({ headless: true }),
);

function isBehavior(event) {
    return ['dict_lookup', 'video_replay', 'playback_rate', 'tab_visibility'].includes(event?.type);
}

async function installMocks(page, options = {}) {
    const captured = [];
    captured.failedRequests = 0;
    await page.route('**/api/events', async (route) => {
        let body = {};
        try {
            body = route.request().postDataJSON() || {};
        } catch {
            body = {};
        }
        const events = Array.isArray(body.events) ? body.events : [];
        captured.push(...events.filter(isBehavior));
        if (options.failEvents) {
            captured.failedRequests += 1;
            await route.fulfill({
                status: 503,
                contentType: 'application/json',
                body: JSON.stringify({ detail: 'mock events unavailable' }),
            });
            return;
        }
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                received: events.length,
                accepted: events.length,
                duplicated: 0,
            }),
        });
    });
    await page.route('**/api/define', async (route) => {
        const body = route.request().postDataJSON() || {};
        await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
                word: body.word || 'word',
                lemma: body.word || 'word',
                ipa: '/mock/',
                zh: '模拟释义',
                definition_en: 'mocked definition',
                senses: [{ pos: 'n.', zh: '模拟释义', definition_en: 'mocked definition' }],
            }),
        });
    });
    // The YouTube embed is irrelevant for these signals; abort it so the test
    // never depends on network / autoplay behaviour.
    await page.route('**/youtube.com/**', (route) => route.abort());
    await page.route('**/youtube-nocookie.com/**', (route) => route.abort());
    return captured;
}

async function enterLibraryVideo(page) {
    await page.goto(`${BASE}/#/content`, { waitUntil: 'domcontentloaded' });
    const welcome = page.getByTestId('welcome-enter');
    if (await welcome.count()) {
        await welcome.click();
        await page.waitForTimeout(600);
    }
    const guest = page.getByTestId('auth-guest-continue');
    if (await guest.count()) {
        await guest.click();
        await page.waitForTimeout(600);
    }
    const card = page.locator('[data-testid^="library-video-card-"]').first();
    await card.waitFor({ state: 'visible', timeout: 25000 });
    await card.click();
    await page.locator('[data-index]').first().waitFor({ state: 'visible', timeout: 25000 });
}

async function waitForEvent(captured, predicate, label, timeout = 10000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const found = captured.find(predicate);
        if (found) return found;
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timed out waiting for ${label}; captured=${JSON.stringify(captured)}`);
}

try {
    // ── Success path: all four events are emitted with safe payloads ───────
    const context = await browser.newContext({
        viewport: { width: 1440, height: 1000 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const page = await context.newPage();
    const pageErrors = [];
    const batchSizes = [];
    page.on('pageerror', (error) => pageErrors.push(String(error)));
    page.on('request', (request) => {
        if (request.url().includes('/api/events') && request.method() === 'POST') {
            try {
                const events = request.postDataJSON().events;
                if (Array.isArray(events)) batchSizes.push(events.length);
            } catch {
                // ignore malformed test-side parses
            }
        }
    });
    const captured = await installMocks(page);
    await enterLibraryVideo(page);
    const cookies = await context.cookies();
    assert.ok(
        cookies.some((cookie) => cookie.name === 'ln_guest' && cookie.value),
        'guest cookie exists for anonymous reporting',
    );

    // 1) dict_lookup: open the dictionary card on one word.
    const wordHit = page.locator('[data-word-hit]').first();
    const lookedUpWord = (await wordHit.getAttribute('data-word-hit')) || '';
    assert.ok(lookedUpWord, 'a clickable word exists');
    await wordHit.click();
    await page.getByTestId('word-popover').waitFor({ state: 'visible', timeout: 10000 });
    const dictEvent = await waitForEvent(captured, (event) => event.type === 'dict_lookup', 'dict_lookup');
    assert.equal(dictEvent.word, lookedUpWord.toLowerCase(), 'word is normalized');
    assert.equal(dictEvent.source, 'transcript', 'source reflects the transcript');
    assert.ok(dictEvent.contentRef, 'dict_lookup carries contentRef');
    assert.ok(dictEvent.sessionId, 'dict_lookup carries the anonymous session id');
    assert.equal(dictEvent.context, undefined, 'context/free text is never sent');
    assert.equal(dictEvent.sentence, undefined, 'sentence/free text is never sent');
    assert.ok(!JSON.stringify(dictEvent).includes('So, Georgie'), 'payload does not contain transcript text');

    // Close the popover so it cannot intercept transcript clicks.
    await page.getByTestId('word-popover-overlay').click({ position: { x: 8, y: 8 } });
    await page.waitForTimeout(400);

    // 2) playback_rate: user changes the speed selector.
    const rateSelect = page.getByTestId('playback-rate-select');
    await rateSelect.selectOption('1.5');
    const rateEvent = await waitForEvent(captured, (event) => event.type === 'playback_rate', 'playback_rate');
    assert.equal(rateEvent.fromRate, 1);
    assert.equal(rateEvent.toRate, 1.5);
    assert.equal(rateEvent.contentRef, dictEvent.contentRef, 'rate event uses the same content id');

    // 3) video_replay: jump forward (no event), then click an earlier sentence.
    await page.locator('[data-index="5"]').click({ position: { x: 12, y: 12 } });
    await page.waitForTimeout(300);
    await page.locator('[data-index="1"]').click({ position: { x: 12, y: 12 } });
    const replayEvent = await waitForEvent(captured, (event) => event.type === 'video_replay', 'video_replay');
    assert.equal(replayEvent.method, 'click');
    assert.ok(replayEvent.fromSeconds > replayEvent.toSeconds, 'replay is backwards only');
    assert.equal(replayEvent.contentRef, dictEvent.contentRef);

    // 4) tab_visibility: hidden then visible (visible seconds + no page data).
    await page.waitForTimeout(1200);
    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    const hiddenEvent = await waitForEvent(
        captured,
        (event) => event.type === 'tab_visibility' && event.state === 'hidden',
        'tab_visibility hidden',
    );
    assert.ok(hiddenEvent.visibleSeconds > 0, 'hidden event reports visible seconds');
    assert.ok(hiddenEvent.sessionId, 'visibility event is session-scoped');
    assert.equal(hiddenEvent.contentRef, undefined, 'visibility does not carry page content');

    await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await waitForEvent(
        captured,
        (event) => event.type === 'tab_visibility' && event.state === 'visible',
        'tab_visibility visible',
    );

    // Bounded batch: never more than 20 events per request (watch batches may
    // be larger in other flows, but this page only has a handful of events).
    assert.ok(batchSizes.length > 0, 'at least one /api/events batch was sent');
    assert.ok(batchSizes.every((size) => size <= 20), `batch size ≤20: ${batchSizes}`);
    assert.deepEqual(pageErrors, [], 'no uncaught page errors');
    fs.writeFileSync(
        path.join(SHOT_DIR, 'captured-events.json'),
        JSON.stringify(captured, null, 2),
    );
    await page.screenshot({ path: path.join(SHOT_DIR, 'telemetry-ok.png') });

    // ── Failure path: event API 503 must not break lookup or playback ──────
    const failingContext = await browser.newContext({
        viewport: { width: 1280, height: 900 },
        colorScheme: 'dark',
        locale: 'zh-CN',
    });
    const failingPage = await failingContext.newPage();
    const failingErrors = [];
    failingPage.on('pageerror', (error) => failingErrors.push(String(error)));
    const failingCaptured = await installMocks(failingPage, { failEvents: true });
    await enterLibraryVideo(failingPage);

    await failingPage.locator('[data-word-hit]').first().click();
    await failingPage.getByTestId('word-popover').waitFor({ state: 'visible', timeout: 10000 });
    await failingPage
        .getByTestId('word-popover')
        .getByText('模拟释义')
        .first()
        .waitFor({ state: 'visible', timeout: 10000 });
    await failingPage.getByTestId('word-popover-overlay').click({ position: { x: 8, y: 8 } });
    await failingPage.getByTestId('playback-rate-select').selectOption('1.25');
    assert.equal(
        await failingPage.getByTestId('playback-rate-select').inputValue(),
        '1.25',
        'playback-rate control still works when telemetry fails',
    );
    await failingPage.locator('[data-index="5"]').click({ position: { x: 12, y: 12 } });
    await failingPage.waitForTimeout(250);
    await failingPage.locator('[data-index="1"]').click({ position: { x: 12, y: 12 } });
    await failingPage.waitForTimeout(1200);
    assert.ok(failingCaptured.failedRequests > 0, 'the failure path really hit /api/events');
    assert.deepEqual(failingErrors, [], 'telemetry failures do not raise page errors');
    await failingPage.screenshot({ path: path.join(SHOT_DIR, 'telemetry-failure-ok.png') });

    console.log(
        `telemetry verification passed; behavior events=${captured.length} ` +
        `types=${[...new Set(captured.map((event) => event.type))].join(',')}`,
    );
    console.log(`screenshots: ${SHOT_DIR}`);
} finally {
    await browser.close();
}
