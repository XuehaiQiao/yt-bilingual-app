// Acceptance for loading/replacing a local subtitle *after* the video is open
// (2026-11-20):
//   a) opening a video without a subtitle shows a "加载字幕" action;
//   b) picking an SRT in the player parses it in-place: 2 cues, new filename,
//      AI button enabled, video keeps playing and is not remounted;
//   c) "更换字幕" replaces the cues; bad / empty files fail loudly;
//   d) 1440 and 375 have no horizontal overflow.
//
// All /api/** requests are mocked; only browser-local files are read. The video
// and subtitle never leave the tab.
//
// Run: node scripts/local-subtitle-later-test.mjs   (needs `npm run dev` on :5173)
// Output: /tmp/local-subtitle-later/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.APP_URL || 'http://127.0.0.1:5173/').replace(/\/+$/, '');
const SHOTS = process.env.SHOT_DIR || '/tmp/local-subtitle-later';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIDEO = process.env.LOCAL_VIDEO || '/tmp/flower.mp4';
const SRT = process.env.LOCAL_SRT || '/tmp/test-local.srt';

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
assert.ok(fs.existsSync(VIDEO), `missing fixture video: ${VIDEO}`);
assert.ok(fs.existsSync(SRT), `missing fixture subtitle: ${SRT}`);

const REPLACEMENT = path.join(SHOTS, 'replacement.srt');
fs.writeFileSync(REPLACEMENT, [
    '1',
    '00:00:00,500 --> 00:00:03,500',
    'A replacement subtitle.',
    '',
].join('\n'));
const EMPTY_SRT = path.join(SHOTS, 'empty.srt');
fs.writeFileSync(EMPTY_SRT, [
    '1',
    '00:00:00,000 --> 00:00:02,000',
    '这里只有中文，没有英文句子。',
    '',
].join('\n'));
const VTT = path.join(SHOTS, 'replacement.vtt');
fs.writeFileSync(VTT, [
    'WEBVTT',
    '',
    '00:00:01.000 --> 00:00:03.000',
    'A WebVTT subtitle.',
    '',
].join('\n'));
const BAD_FILE = path.join(SHOTS, 'notes.txt');
fs.writeFileSync(BAD_FILE, 'not a subtitle');

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
await context.addInitScript(() => {
    if (!localStorage.getItem('yt_bilingual_ui_lang')) localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
    if (!localStorage.getItem('yt_bilingual_target_lang')) localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
});
const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('dialog', (dialog) => { void dialog.accept(); });

await context.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const pathname = new URL(request.url()).pathname;
    const respond = (data, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data),
    });

    if (pathname === '/api/auth/me') {
        return respond({ user: { id: 'u-local-sub', email: 'local-sub@example.com', username: 'Reader' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/user/summary') {
        return respond({
            user: { id: 'u-local-sub', email: 'local-sub@example.com', username: 'Reader', credits: 12, memberSince: 1763000000000 },
            monthSpendUsd: 0.12, usageToday: { minutes: 8 }, version: 'test', preliminary: false,
        });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites') return respond([]);
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }], default: 'deepseek-chat' });
    }
    if (pathname === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    if (pathname === '/api/placement/profile') {
        return respond({ profile: { cefr: 'A2–B1', levelBandLow: 'A2', levelBandHigh: 'B1', vocabEstimate: 2500, readingEstimate: null, confidence: 0.7, confidenceLabel: 'medium', confidenceLabelZh: '中', pseudoWordSuspicion: 0, updatedAt: 1763000000000, source: 'placement', strengths: [], weaknesses: [], advice: null, measuredDomains: ['vocab'], notMeasured: ['listening', 'speaking', 'writing'], preliminary: false, sampleSize: 32, disclaimer: '' }, preliminary: false, sampleSize: 32, disclaimer: '' });
    }
    if (pathname === '/api/ability/profile') {
        return respond({ status: 'ok', vocabulary: { cefr: 'B1', low: 'A2', high: 'B1', label: 'A2–B1' } });
    }
    if (pathname === '/api/review/stats') {
        return respond({ targetLang: 'zh-CN', now: Date.now(), today: '2026-11-17', dueToday: 0, dueNow: 0, reviewedToday: 0, reviewedWordsToday: 0, newWords: 0, newToday: 0, totalWords: 0, suspendedWords: 0, streakDays: 0 });
    }
    if (pathname === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/vocabulary/level') return respond({});

    if (pathname.startsWith('/api/')) return respond({});
    return respond({ detail: `unmocked ${method} ${pathname}` }, 404);
});

const shot = async (name) => {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
    console.log(`shot: ${name}.png`);
};

async function gotoContent() {
    await page.goto(`${BASE}/#/app/content`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 15000 });
}

async function openVideoOnly() {
    await page.locator('[data-testid=local-video-input]').setInputFiles(VIDEO);
    await page.getByTestId('learning-header').waitFor({ state: 'visible', timeout: 15000 });
    // Let the first frame paint so screenshots show the video, not a black box.
    await page.waitForFunction(() => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return video && video.readyState >= 2;
    }, undefined, { timeout: 10000 });
    await page.waitForTimeout(120);
}

async function pickSubtitle(triggerTestId, file) {
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByTestId(triggerTestId).click(),
    ]);
    await chooser.setFiles(file);
}

const noOverflow = async (label) => {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
};

const subtitleFileText = async () => (await page.locator('section').first().innerText());

async function waitForToastsGone() {
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="toast"]').length === 0,
        undefined,
        { timeout: 15000 },
    );
}

try {
    // ── a) video only → empty state with a load action ────────────────────
    await gotoContent();
    await openVideoOnly();
    const loadButton = page.getByTestId('local-video-load-subtitle');
    await loadButton.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await loadButton.innerText(), /加载字幕/);
    assert.equal(await page.getByTestId('local-video-change-subtitle').count(), 0);
    assert.equal(await page.getByTestId('local-video-subtitle-error').count(), 0);
    assert.equal(await page.getByTestId('local-video-analyze').isDisabled(), true);
    assert.match(await subtitleFileText(), /未加载字幕/);
    await noOverflow('1440 empty');
    await shot('1440-empty');

    // Start playback before loading the subtitle: position/state must survive.
    const before = await page.evaluate(async () => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        video.dataset.subtitleMarker = 'keep';
        video.muted = true;
        video.loop = true;
        video.currentTime = 0.1;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 450));
        return {
            playing: !video.paused,
            currentTime: video.currentTime,
            marker: video.dataset.subtitleMarker,
            src: video.src,
        };
    });
    assert.equal(before.playing, true, 'video should play before loading the subtitle');
    assert.equal(before.marker, 'keep');

    // ── b) pick an SRT inside the player → cues appear in place ───────────
    await pickSubtitle('local-video-load-subtitle', SRT);
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('This is a local video.').waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await loadButton.count(), 0, 'load button is replaced by the change action');
    const changeButton = page.getByTestId('local-video-change-subtitle');
    assert.match(await changeButton.innerText(), /更换字幕/);
    assert.equal(await page.getByTestId('local-video-analyze').isEnabled(), true);
    const strip = await subtitleFileText();
    assert.match(strip, /test-local\.srt/);
    assert.match(strip, /2 句/);
    assert.equal(await page.getByTestId('toast').first().innerText().then((text) => /字幕已加载/.test(text)), true);
    await page.waitForTimeout(150);
    await noOverflow('1440 loaded');
    await shot('1440-loaded');

    const after = await page.evaluate(() => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return {
            marker: video.dataset.subtitleMarker,
            src: video.src,
            playing: !video.paused,
            currentTime: video.currentTime,
        };
    });
    assert.equal(after.marker, 'keep', 'the <video> element must not be remounted');
    assert.equal(after.src, before.src, 'the video object URL must not change');
    assert.equal(after.playing, true, 'playback must continue after loading a subtitle');
    assert.ok(after.currentTime > before.currentTime, `playhead should keep moving (${before.currentTime} → ${after.currentTime})`);

    // ── c) replace the subtitle in place ──────────────────────────────────
    await pickSubtitle('local-video-change-subtitle', REPLACEMENT);
    await page.getByText('A replacement subtitle.').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await subtitleFileText(), /replacement\.srt/);
    assert.match(await subtitleFileText(), /1 句/);
    assert.equal(await page.getByText('Hello world.').count(), 0, 'old cues are gone after replacement');

    // The same entry also accepts WebVTT.
    await pickSubtitle('local-video-change-subtitle', VTT);
    await page.getByText('A WebVTT subtitle.').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await subtitleFileText(), /replacement\.vtt/);
    assert.match(await subtitleFileText(), /1 句/);

    // Bad extension fails loudly and keeps the old cues. Let the earlier
    // success toasts expire so the error screenshot reads clearly.
    await waitForToastsGone();
    await pickSubtitle('local-video-change-subtitle', BAD_FILE);
    const errorBox = page.getByTestId('local-video-subtitle-error');
    await errorBox.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await errorBox.innerText(), /仅支持 \.srt 或 \.vtt/);
    assert.equal(await page.getByText('A WebVTT subtitle.').count(), 1);
    await shot('1440-error');

    // A subtitle with no usable English cues is also rejected, not silent.
    await pickSubtitle('local-video-change-subtitle', EMPTY_SRT);
    await page.waitForFunction(() => {
        const box = document.querySelector('[data-testid="local-video-subtitle-error"]');
        return box && box.textContent.includes('没有可用的英文句子');
    }, { timeout: 10000 });
    assert.equal(await page.getByText('A WebVTT subtitle.').count(), 1);

    // Restore the healthy loaded state, then let the success toasts expire so
    // the 375 screenshots show the panel rather than a toast stack.
    await pickSubtitle('local-video-change-subtitle', REPLACEMENT);
    await page.getByText('A replacement subtitle.').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByTestId('local-video-subtitle-error').count(), 0);

    // ── d) 375 layout: loaded + empty, no horizontal overflow ─────────────
    await waitForToastsGone();
    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(250);
    await noOverflow('375 loaded');
    await shot('375-loaded');

    // Close and reopen the player so the 375 empty state is exercised too.
    await page.getByTestId('learning-back').click();
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 10000 });
    await openVideoOnly();
    await page.getByTestId('local-video-load-subtitle').waitFor({ state: 'visible', timeout: 10000 });
    await noOverflow('375 empty');
    await shot('375-empty');

    // Regression: choosing a subtitle together with the video still parses.
    await page.getByTestId('learning-back').click();
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('[data-testid=local-video-input]').setInputFiles([VIDEO, SRT]);
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await subtitleFileText(), /test-local\.srt/);
    assert.match(await subtitleFileText(), /2 句/);

    // Vietnamese UI: the same late-load action is translated and still fits.
    await page.getByTestId('learning-back').click();
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(() => localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 15000 });
    await openVideoOnly();
    const viLoadButton = page.getByTestId('local-video-load-subtitle');
    await viLoadButton.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await viLoadButton.innerText(), /Tải phụ đề/);
    await pickSubtitle('local-video-load-subtitle', SRT);
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await page.getByTestId('toast').first().innerText(), /Đã tải phụ đề/);
    assert.match(await subtitleFileText(), /test-local\.srt/);
    await noOverflow('375 vi loaded');
    await shot('375-vi-loaded');

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    console.log('local subtitle later: all assertions passed');
} finally {
    await browser.close();
}
