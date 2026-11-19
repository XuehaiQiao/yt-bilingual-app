// Acceptance for the persistent local-video library (2026-11-20):
//   a) a saved record survives a reload: cover, name, progress and subtitle badge;
//   b) clicking the saved card reopens the file, seeks to the saved position;
//   c) the remembered subtitle text rebuilds the transcript without a file pick;
//   d) deleting a row removes it from the grid and from IndexedDB;
//   e) without showOpenFilePicker the page falls back to <input type=file> and
//      says the choice cannot be remembered;
//   f) 375 and 1440 never overflow horizontally;
//   g) permission denial / moved file produce readable, recoverable messages.
// Plus the IndexedDB guards: DataCloneError and an unavailable IndexedDB both
// surface a readable error instead of a blank page.
//
// Chromium's native file picker cannot be driven from Playwright, so the page
// injects a FileSystemFileHandle-shaped mock. Its methods live on the prototype
// (structured clone keeps only own props), which is exactly what proves the
// in-memory handle cache and the reload path behave like real handles.
//
// Run: node scripts/local-video-library-test.mjs   (needs `npm run dev` on :5173)
// Screenshots: /tmp/local-video-library/*.png
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const BASE = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const SHOTS = process.env.SHOT_DIR || '/tmp/local-video-library';
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIDEO = process.env.LOCAL_VIDEO || '/tmp/flower.mp4';
const SRT = process.env.LOCAL_SRT || '/tmp/test-local.srt';
const VIDEO_LAST_MODIFIED = 1763000000000;

fs.rmSync(SHOTS, { recursive: true, force: true });
fs.mkdirSync(SHOTS, { recursive: true });
assert.ok(fs.existsSync(VIDEO), `missing fixture video: ${VIDEO}`);
assert.ok(fs.existsSync(SRT), `missing fixture subtitle: ${SRT}`);
const VIDEO_SIZE = fs.statSync(VIDEO).size;
const VIDEO_BASE64 = fs.readFileSync(VIDEO).toString('base64');

const CORS = {
    'access-control-allow-origin': BASE,
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

async function apiHandler(route) {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    const pathname = new URL(request.url()).pathname;
    const respond = (data, status = 200) => route.fulfill({
        status, contentType: 'application/json', headers: CORS, body: JSON.stringify(data),
    });
    if (pathname === '/api/auth/me') {
        return respond({ user: { id: 'u-local-library', email: 'library@example.com', username: 'Reader' }, isAdmin: false, guest: false });
    }
    if (pathname === '/api/history' || pathname === '/api/subscriptions') return respond([]);
    if (pathname === '/api/shows') return respond({ shows: [] });
    if (pathname === '/api/favorites') return respond([]);
    if (pathname === '/api/sentences/levels') return respond([]);
    if (pathname === '/api/models') {
        return respond({ models: [{ id: 'deepseek-chat', name: 'DeepSeek Chat', provider: 'deepseek', available: true, quotaInfo: '' }], default: 'deepseek-chat' });
    }
    if (pathname === '/api/report/week') return respond({ numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null } });
    if (pathname === '/api/placement/profile') return respond({ profile: null, preliminary: false, sampleSize: 0, disclaimer: '' });
    if (pathname === '/api/ability/profile') return respond({ status: 'ok' });
    if (pathname === '/api/recommendations') return respond({ items: [], basis: { band: 'A2–B2', source: 'default' }, preliminary: false });
    if (pathname === '/api/content/difficulty/batch') return respond({ items: [] });
    if (pathname === '/api/vocabulary/level') return respond({});
    if (pathname.startsWith('/api/')) return respond({});
    return respond({ detail: `unmocked ${method} ${pathname}` }, 404);
}

async function prepareContext(browser, { initScripts = [], viewport = { width: 1440, height: 1000 } } = {}) {
    const context = await browser.newContext({ viewport, reducedMotion: 'reduce' });
    await context.addInitScript(() => {
        if (!localStorage.getItem('yt_bilingual_ui_lang')) localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        if (!localStorage.getItem('yt_bilingual_target_lang')) localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    });
    for (const script of initScripts) await context.addInitScript(script);
    await context.route('**/api/**', apiHandler);
    return context;
}

const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--autoplay-policy=no-user-gesture-required'],
});
const pageErrors = [];

function watchErrors(page, label) {
    page.on('pageerror', (error) => pageErrors.push(`${label}: ${String(error)}`));
    page.on('dialog', (dialog) => { void dialog.accept(); });
}

async function shot(page, name) {
    await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
    console.log(`shot: ${name}.png`);
}

async function noOverflow(page, label) {
    const metrics = await page.evaluate(() => ({
        doc: document.documentElement.scrollWidth,
        inner: window.innerWidth,
    }));
    assert.ok(metrics.doc <= metrics.inner + 1, `${label}: horizontal overflow ${JSON.stringify(metrics)}`);
}

async function gotoContent(page) {
    await page.goto(`${BASE}/#/app/content`, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 20000 });
}

async function waitForPlayerReady(page) {
    await page.getByTestId('local-video-player').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return video && video.readyState >= 2;
    }, undefined, { timeout: 10000 });
}

async function waitForToast(page, needle) {
    await page.waitForFunction((text) => {
        return [...document.querySelectorAll('[data-testid="toast"]')]
            .some((element) => element.textContent?.includes(text));
    }, needle, { timeout: 10000 });
}

async function closeToasts(page) {
    const buttons = page.locator('[data-testid="toast-close"]');
    const count = await buttons.count();
    for (let index = 0; index < count; index += 1) {
        await buttons.nth(index).click().catch(() => {});
    }
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid="toast"]').length === 0,
        undefined,
        { timeout: 5000 },
    ).catch(() => {});
}

async function installMockHandle(page) {
    await page.evaluate(({ base64, lastModified }) => {
        window.__mockState = {
            permission: 'granted',
            fileLost: false,
            bytes: Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
            lastModified,
        };
        // Methods sit on the prototype on purpose: structured clone keeps only
        // own data, so a reload proves what is and is not persisted.
        class MockFileHandle {
            constructor() {
                this.kind = 'file';
                this.name = 'flower.mp4';
                this.lastModified = lastModified;
            }
            async queryPermission() {
                return window.__mockState.permission;
            }
            async requestPermission() {
                return window.__mockState.permission;
            }
            async getFile() {
                if (window.__mockState.fileLost) {
                    throw new DOMException('The file has moved.', 'NotFoundError');
                }
                return new File([window.__mockState.bytes], this.name, {
                    type: 'video/mp4',
                    lastModified: this.lastModified,
                });
            }
        }
        const handle = new MockFileHandle();
        window.showOpenFilePicker = async () => [handle];
    }, { base64: VIDEO_BASE64, lastModified: VIDEO_LAST_MODIFIED });
}

async function readLibrary(page) {
    return page.evaluate(async () => {
        const library = await import('/src/lib/localVideoLibrary.ts');
        const rows = await library.listLocalVideos();
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            size: row.size,
            lastModified: row.lastModified,
            cover: row.coverDataUrl ?? null,
            duration: row.duration,
            progress: row.progress,
            subtitleName: row.subtitleName ?? null,
            subtitleText: row.subtitleText ?? null,
            handleKind: row.fileHandle?.kind ?? null,
        }));
    });
}

const context = await prepareContext(browser);
const page = await context.newPage();
watchErrors(page, 'main');

try {
    // ── secure context: save a real handle + cover + subtitle + progress ──
    await gotoContent(page);
    assert.equal(await page.getByTestId('local-video-fallback-hint').count(), 0);
    assert.equal(await page.getByTestId('local-video-shelf').count(), 0, 'empty shelf takes no space');
    await installMockHandle(page);

    await page.getByTestId('local-video-open').click();
    await waitForPlayerReady(page);
    assert.equal(
        await page.evaluate(() => typeof window.showOpenFilePicker),
        'function',
    );

    const [subtitleChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByTestId('local-video-load-subtitle').click(),
    ]);
    await subtitleChooser.setFiles(SRT);
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });

    await page.evaluate(async () => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        video.muted = true;
        video.currentTime = 1.2;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 700));
        video.pause();
    });
    await page.waitForTimeout(500);
    await shot(page, '1440-player');

    const saved = (await readLibrary(page))[0];
    assert.ok(saved, 'one local video record is saved');
    assert.equal(saved.id, `flower.mp4::${VIDEO_SIZE}::${VIDEO_LAST_MODIFIED}`);
    assert.equal(saved.name, 'flower.mp4');
    assert.equal(saved.size, VIDEO_SIZE);
    assert.equal(saved.handleKind, 'file', 'the picker handle is stored');
    assert.match(saved.cover ?? '', /^data:image\/jpeg;base64,/, 'a JPEG cover is saved');
    const coverBrightness = await page.evaluate(async (dataUrl) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        context.drawImage(image, 0, 0);
        const pixels = context.getImageData(0, 0, 320, 180).data;
        let total = 0;
        for (let index = 0; index < pixels.length; index += 4) {
            total += pixels[index] + pixels[index + 1] + pixels[index + 2];
        }
        return Math.round(total / (pixels.length / 4) / 3);
    }, saved.cover);
    assert.ok(coverBrightness > 10, `cover is a real frame, not black (brightness ${coverBrightness})`);
    assert.ok(saved.duration > 5 && saved.duration < 5.2, `duration persisted (${saved.duration})`);
    assert.ok(saved.progress > 1.2, `progress persisted (${saved.progress})`);
    assert.match(saved.subtitleName ?? '', /test-local\.srt$/);
    assert.match(saved.subtitleText ?? '', /Hello world\./);

    // ── the shelf shows the saved episode after closing the player ────────
    await page.getByTestId('learning-back').click();
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForFunction(() => {
        const image = document.querySelector('[data-testid^="local-video-cover-"]');
        return image && image.complete && image.naturalWidth > 0;
    }, undefined, { timeout: 10000 });
    const cover = await page.locator('[data-testid^="local-video-cover-"]').first().evaluate((image) => ({
        width: image.naturalWidth,
        height: image.naturalHeight,
        prefix: image.src.slice(0, 30),
    }));
    assert.deepEqual({ width: cover.width, height: cover.height }, { width: 320, height: 180 });
    assert.match(cover.prefix, /^data:image\/jpeg/);
    const shelfText = await page.getByTestId('local-video-shelf').innerText();
    assert.match(shelfText, /flower\.mp4/);
    assert.match(shelfText, /有字幕/);
    assert.match(shelfText, /上次看到/);
    assert.match(shelfText, /%/);
    assert.equal(await page.locator('[data-testid^="local-video-progress-bar-"]').count(), 1);
    await page.getByTestId('local-video-shelf').scrollIntoViewIfNeeded();
    await page.locator('[data-testid^="local-video-cover-"]').first().evaluate(async (image) => {
        if (typeof image.decode === 'function') await image.decode().catch(() => {});
    });
    await page.waitForTimeout(150);
    await noOverflow(page, '1440 shelf');
    await shot(page, '1440-shelf');

    const savedProgress = (await readLibrary(page))[0].progress;

    // ── b + c: click the card → same file, saved position, saved cues ─────
    await page.locator('[data-testid^="local-video-card-"]').first().click();
    await waitForPlayerReady(page);
    await page.waitForFunction((target) => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return video && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.25;
    }, savedProgress, { timeout: 10000 });
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    const restored = await page.evaluate(() => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return { currentTime: video.currentTime, paused: video.paused, src: video.src };
    });
    assert.ok(Math.abs(restored.currentTime - savedProgress) < 0.25, `seek restored ${restored.currentTime} vs ${savedProgress}`);
    assert.equal(restored.paused, true, 'restored playback must not autoplay');
    assert.match(restored.src, /^blob:/);
    const restoredBody = await page.locator('body').innerText();
    assert.match(restoredBody, /test-local\.srt/, 'subtitle name restored from the record');
    assert.equal(await page.getByTestId('local-video-load-subtitle').count(), 0);
    assert.ok(await page.getByTestId('local-video-change-subtitle').isVisible());
    assert.equal(await page.getByTestId('local-video-analyze').isDisabled(), false);
    await noOverflow(page, '1440 restored');
    await shot(page, '1440-restored');

    // ── replacing the subtitle also persists the new raw text ────────────
    const replacementSrt = path.join(SHOTS, 'replacement.srt');
    fs.writeFileSync(replacementSrt, [
        '1',
        '00:00:00,500 --> 00:00:03,500',
        'A replacement subtitle.',
        '',
    ].join('\n'));
    const [replaceChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByTestId('local-video-change-subtitle').click(),
    ]);
    await replaceChooser.setFiles(replacementSrt);
    await page.getByText('A replacement subtitle.').waitFor({ state: 'visible', timeout: 10000 });
    const replaced = (await readLibrary(page))[0];
    assert.match(replaced.subtitleName ?? '', /replacement\.srt$/);
    assert.match(replaced.subtitleText ?? '', /A replacement subtitle\./);

    await page.setViewportSize({ width: 375, height: 812 });
    await page.waitForTimeout(300);
    await noOverflow(page, '375 player');
    await shot(page, '375-player');
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.getByTestId('learning-back').click();
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 15000 });
    await closeToasts(page);

    // ── g: permission denied → readable toast with a re-pick action ───────
    await page.evaluate(() => { window.__mockState.permission = 'denied'; });
    await page.locator('[data-testid^="local-video-card-"]').first().click();
    await waitForToast(page, '没有读取这个视频文件的权限');
    assert.match(await page.getByTestId('toast').last().innerText(), /重新选择/);
    assert.equal(await page.getByTestId('local-video-shelf').count(), 1, 'a denied open keeps the row');
    await shot(page, '1440-permission');
    await closeToasts(page);

    // ── g: moved file → readable toast; re-picking recovers ───────────────
    await page.evaluate(() => {
        window.__mockState.permission = 'granted';
        window.__mockState.fileLost = true;
    });
    await page.locator('[data-testid^="local-video-card-"]').first().click();
    await waitForToast(page, '视频文件已被移动或删除');
    assert.match(await page.getByTestId('toast').last().innerText(), /重新选择/);
    await shot(page, '1440-file-lost');
    await page.evaluate(() => { window.__mockState.fileLost = false; });
    await page.getByTestId('toast-action').last().click();
    await waitForPlayerReady(page);
    await page.waitForTimeout(300);
    await page.getByTestId('learning-back').click();
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 15000 });
    await closeToasts(page);

    // ── a: reload — cover/name/progress/subtitle still in the shelf ───────
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => {
        const image = document.querySelector('[data-testid^="local-video-cover-"]');
        return image && image.complete && image.naturalWidth > 0;
    }, undefined, { timeout: 10000 });
    const reloadShelfText = await page.getByTestId('local-video-shelf').innerText();
    assert.match(reloadShelfText, /flower\.mp4/);
    assert.match(reloadShelfText, /replacement\.srt/);
    assert.match(reloadShelfText, /有字幕/);
    assert.match(reloadShelfText, /上次看到/);
    assert.equal(await page.getByTestId('local-video-fallback-hint').count(), 0);
    await noOverflow(page, '1440 shelf after reload');
    await shot(page, '1440-shelf-reload');
    const afterReload = await readLibrary(page);
    assert.equal(afterReload.length, 1);
    assert.match(afterReload[0].cover ?? '', /^data:image\/jpeg/);
    assert.match(afterReload[0].subtitleText ?? '', /A replacement subtitle\./);
    assert.ok(afterReload[0].progress > 1.2);

    // ── f: 375 shelf ──────────────────────────────────────────────────────
    await page.setViewportSize({ width: 375, height: 812 });
    await page.getByTestId('local-video-shelf').scrollIntoViewIfNeeded();
    await page.locator('[data-testid^="local-video-cover-"]').first().evaluate(async (image) => {
        if (typeof image.decode === 'function') await image.decode().catch(() => {});
    });
    await page.waitForTimeout(250);
    await noOverflow(page, '375 shelf');
    await shot(page, '375-shelf');

    // ── Vietnamese copy for the new shelf ────────────────────────────────
    await page.evaluate(() => localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 20000 });
    await page.getByTestId('local-video-shelf').scrollIntoViewIfNeeded();
    await page.locator('[data-testid^="local-video-cover-"]').first().evaluate(async (image) => {
        if (typeof image.decode === 'function') await image.decode().catch(() => {});
    });
    await page.waitForTimeout(200);
    const viShelfText = await page.getByTestId('local-video-shelf').innerText();
    assert.match(viShelfText, /Video cục bộ đã lưu/);
    assert.match(viShelfText, /Lần trước xem đến/);
    assert.match(viShelfText, /Có phụ đề/);
    await noOverflow(page, '375 vi shelf');
    await shot(page, '375-vi-shelf');

    // ── d: delete removes the row from the UI and from IndexedDB ─────────
    await page.evaluate(() => localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN'));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 20000 });
    await page.getByTestId('local-video-shelf').scrollIntoViewIfNeeded();
    await page.locator('[data-testid^="local-video-delete-"]').first().click();
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="local-video-card-"]').length === 0,
        undefined,
        { timeout: 10000 },
    );
    await waitForToast(page, '已删除本地视频');
    assert.equal(await page.getByTestId('local-video-shelf').count(), 0);
    assert.deepEqual(await readLibrary(page), []);
    await shot(page, '1440-deleted');
    await closeToasts(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 20000 });
    assert.equal(await page.getByTestId('local-video-shelf').count(), 0, 'deleted row stays deleted');

    // ── IndexedDB structured-clone failure is a readable tagged error ────
    const cloneError = await page.evaluate(async () => {
        const library = await import('/src/lib/localVideoLibrary.ts');
        try {
            await library.putLocalVideo({
                id: 'not-cloneable::1::1',
                name: 'not-cloneable.mp4',
                size: 1,
                lastModified: 1,
                fileHandle: {
                    kind: 'file',
                    name: 'not-cloneable.mp4',
                    getFile: () => new File([], 'not-cloneable.mp4'),
                },
                duration: 0,
                progress: 0,
                lastOpenedAt: Date.now(),
            });
            return null;
        } catch (error) {
            return { name: error.name, code: error.code, message: error.message };
        }
    });
    assert.ok(cloneError, 'a non-cloneable handle rejects instead of crashing');
    assert.equal(cloneError.name, 'LocalVideoLibraryError');
    assert.equal(cloneError.code, 'clone');
    assert.match(cloneError.message, /clone/i);

    // ── real FileSystemFileHandle: reopen after a reload ────────────────
    // The mock above cannot survive structured clone with working methods, so
    // this leg uses an actual OPFS FileSystemFileHandle — exactly what Chromium
    // stores for a picked file. It proves the reload → click → resume path.
    await page.evaluate(async ({ base64 }) => {
        const root = await navigator.storage.getDirectory();
        const handle = await root.getFileHandle('opfs-flower.mp4', { create: true });
        const writable = await handle.createWritable();
        await writable.write(Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)));
        await writable.close();
        window.showOpenFilePicker = async () => [handle];
    }, { base64: VIDEO_BASE64 });
    await page.getByTestId('local-video-open').click();
    await waitForPlayerReady(page);
    const [opfsSubtitleChooser] = await Promise.all([
        page.waitForEvent('filechooser'),
        page.getByTestId('local-video-load-subtitle').click(),
    ]);
    await opfsSubtitleChooser.setFiles(SRT);
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    await page.evaluate(async () => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        video.muted = true;
        video.currentTime = 1.1;
        await video.play();
        await new Promise((resolve) => setTimeout(resolve, 500));
        video.pause();
    });
    await page.waitForTimeout(400);
    await page.getByTestId('learning-back').click();
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 15000 });
    await page.waitForTimeout(500);
    const opfsRecord = (await readLibrary(page)).find((row) => row.name === 'opfs-flower.mp4');
    assert.ok(opfsRecord, 'OPFS handle record is saved');
    assert.match(opfsRecord.subtitleText ?? '', /Hello world\./);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('[data-testid^="local-video-card-"]').first().click();
    await waitForPlayerReady(page);
    await page.waitForFunction((target) => {
        const video = document.querySelector('[data-testid="local-video-player"]');
        return video && video.readyState >= 2 && Math.abs(video.currentTime - target) < 0.25;
    }, opfsRecord.progress, { timeout: 10000 });
    await page.getByText('Hello world.').waitFor({ state: 'visible', timeout: 10000 });
    const opfsBody = await page.locator('body').innerText();
    assert.match(opfsBody, /test-local\.srt/);
    await noOverflow(page, '1440 real handle reload');
    await shot(page, '1440-real-handle-reload');
    await page.getByTestId('learning-back').click();
    await page.getByTestId('local-video-shelf').waitFor({ state: 'visible', timeout: 15000 });
    await page.locator('[data-testid^="local-video-delete-"]').first().click();
    await page.waitForFunction(
        () => document.querySelectorAll('[data-testid^="local-video-card-"]').length === 0,
        undefined,
        { timeout: 10000 },
    );
    await page.evaluate(async () => {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry('opfs-flower.mp4');
    });
    await closeToasts(page);

    // ── e: insecure-context fallback still opens the file and says so ────
    const fallbackContext = await prepareContext(browser, {
        initScripts: [() => {
            try { delete window.showOpenFilePicker; } catch { /* ignore */ }
            window.showOpenFilePicker = undefined;
        }],
    });
    const fallbackPage = await fallbackContext.newPage();
    watchErrors(fallbackPage, 'fallback');
    await gotoContent(fallbackPage);
    assert.equal(await fallbackPage.evaluate(() => typeof window.showOpenFilePicker), 'undefined');
    const fallbackHint = fallbackPage.getByTestId('local-video-fallback-hint');
    await fallbackHint.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await fallbackHint.innerText(), /无法保存文件句柄/);
    await noOverflow(fallbackPage, '1440 fallback');
    await shot(fallbackPage, '1440-fallback');

    const [fallbackChooser] = await Promise.all([
        fallbackPage.waitForEvent('filechooser'),
        fallbackPage.getByTestId('local-video-open').click(),
    ]);
    await waitForToast(fallbackPage, '此地址无法保存文件句柄');
    await shot(fallbackPage, '1440-fallback-toast');
    await fallbackChooser.setFiles(VIDEO);
    await waitForPlayerReady(fallbackPage);
    await fallbackPage.getByTestId('learning-back').click();
    await fallbackPage.locator('[data-testid=content-materials]').waitFor({ state: 'visible', timeout: 15000 });
    assert.equal(await fallbackPage.getByTestId('local-video-shelf').count(), 0, 'fallback sessions save no row');
    const fallbackLibrary = await fallbackPage.evaluate(async () => {
        const library = await import('/src/lib/localVideoLibrary.ts');
        return library.listLocalVideos();
    });
    assert.deepEqual(fallbackLibrary, []);
    await fallbackPage.setViewportSize({ width: 375, height: 812 });
    await fallbackHint.scrollIntoViewIfNeeded();
    await noOverflow(fallbackPage, '375 fallback');
    await shot(fallbackPage, '375-fallback');
    await fallbackContext.close();

    // ── IndexedDB unavailable: inline readable error, not a blank page ───
    const noIdbContext = await prepareContext(browser, {
        initScripts: [() => {
            try {
                Object.defineProperty(window, 'indexedDB', { get: () => undefined, configurable: true });
            } catch { /* ignore */ }
        }],
    });
    const noIdbPage = await noIdbContext.newPage();
    watchErrors(noIdbPage, 'no-idb');
    await gotoContent(noIdbPage);
    assert.equal(await noIdbPage.evaluate(() => typeof indexedDB), 'undefined');
    const idbError = noIdbPage.getByTestId('local-video-library-error');
    await idbError.waitFor({ state: 'visible', timeout: 10000 });
    assert.match(await idbError.innerText(), /不支持 IndexedDB/);
    await idbError.scrollIntoViewIfNeeded();
    await shot(noIdbPage, '1440-idb-unsupported');
    await noIdbContext.close();
    assert.equal(await noIdbPage.isClosed(), true);

    assert.deepEqual(pageErrors, [], `page errors: ${pageErrors.join(' | ')}`);
    console.log('local video library: all assertions passed', {
        records: 1,
        savedProgress,
        screenshots: fs.readdirSync(SHOTS).filter((name) => name.endsWith('.png')).length,
    });
} finally {
    await browser.close();
}
