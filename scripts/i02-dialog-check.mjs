// I-02 / G3-06 acceptance check: the shared Dialog takes over the channel list.
//
// Covers (A3 IX-09/IX-10, A2 C4):
//   - role=dialog + aria-modal + aria-labelledby + accessible close label
//   - initial focus inside the panel, Tab/Shift+Tab never escape to the page
//   - Escape / backdrop / X close, focus returns to the trigger
//   - body scroll lock + background scroll not moved by the wheel
//   - 375 and 1440 screenshots in /tmp/i02-dialog-shots
//
// Run with the Vite dev server (or preview) up:
//   cd scripts && APP_URL=http://localhost:5173 node i02-dialog-check.mjs
// The live backend must answer /api/auth/me (guest is fine); only
// /api/subscriptions and /api/history are stubbed, and their writes are
// swallowed so the local guest directory is not touched.
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const APP_URL = process.env.APP_URL || 'http://localhost:5173';
const OUT_DIR = process.env.SHOT_DIR || '/tmp/i02-dialog-shots';
const CHANNEL = 'I02 Channel';
const HISTORY = [
    {
        filename: 'i02-video-a.json',
        videoId: 'i02aaaaaaa1',
        metadata: {
            title: 'I02 first test video',
            channel: CHANNEL,
            upload_date: '20260103',
            thumbnail: '',
        },
        studyCount: 2,
    },
    {
        filename: 'i02-video-b.json',
        videoId: 'i02bbbbbbb2',
        metadata: {
            title: 'I02 second test video',
            channel: CHANNEL,
            upload_date: '20260101',
            thumbnail: '',
        },
        studyCount: 1,
    },
    {
        filename: 'i02-video-c.json',
        videoId: 'i02ccccccc3',
        metadata: {
            title: 'I02 third test video',
            channel: CHANNEL,
            upload_date: '20251230',
            thumbnail: '',
        },
        studyCount: 0,
    },
];

const failures = [];
function check(ok, label, detail = '') {
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        failures.push(label);
        console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

async function launchBrowser() {
    try {
        return await chromium.launch({ headless: true });
    } catch {
        // The repo's Playwright browsers may not be installed; use Chrome.
        return await chromium.launch({ headless: true, channel: process.env.PW_CHANNEL || 'chrome' });
    }
}

const browser = await launchBrowser();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();

page.on('pageerror', (error) => console.error('  ! pageerror:', error.message));

// Read-only stubs: channel data for the dialog, and a no-op for the automatic
// subscription sync so a test run never writes into the guest directory.
await context.route(/\/api\/subscriptions(?:\?.*)?$/, async (route) => {
    if (route.request().method() === 'GET') {
        await route.fulfill({ json: [{ id: 'UC-i02', name: CHANNEL }] });
    } else {
        await route.fulfill({ json: { ok: true } });
    }
});
await context.route(/\/api\/history(?:\?.*)?$/, async (route) => {
    await route.fulfill({ json: HISTORY });
});

await mkdir(OUT_DIR, { recursive: true });

const dialog = page.locator('[role="dialog"]');
const overlay = page.locator('[data-testid="channel-video-dialog-overlay"]');

async function openDialog() {
    const trigger = page.getByRole('button', { name: CHANNEL, exact: true }).first();
    await trigger.waitFor({ state: 'visible', timeout: 20000 });
    await trigger.evaluate((element) => {
        element.dataset.i02Trigger = '1';
    });
    await trigger.click();
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(120); // focus timer + entry animation
    return trigger;
}

async function activeInsideDialog() {
    return page.evaluate(() => {
        const active = document.activeElement;
        return Boolean(active && active.closest('[role="dialog"]'));
    });
}

async function triggerFocused() {
    return page.evaluate(() => document.activeElement?.dataset?.i02Trigger === '1');
}

async function waitForClose() {
    await dialog.waitFor({ state: 'detached', timeout: 5000 });
}

async function rootInert() {
    return page.evaluate(() => document.getElementById('root')?.inert === true);
}

console.log(`I-02 Dialog check @ ${APP_URL}`);
await page.goto(`${APP_URL}/#/content`, { waitUntil: 'domcontentloaded' });

// ── 1440: open, ARIA, focus trap, three close paths ──────────────────────
console.log('\n[1440] open + ARIA');
const trigger = await openDialog();
const aria = await dialog.evaluate((element) => ({
    role: element.getAttribute('role'),
    modal: element.getAttribute('aria-modal'),
    labelledBy: element.getAttribute('aria-labelledby'),
    describedBy: element.getAttribute('aria-describedby'),
    busy: element.getAttribute('aria-busy'),
}));
check(aria.role === 'dialog', 'role="dialog"', String(aria.role));
check(aria.modal === 'true', 'aria-modal="true"');
const headingText = await page.evaluate((id) => {
    const node = id ? document.getElementById(id) : null;
    return node?.textContent?.trim() ?? '';
}, aria.labelledBy);
check(Boolean(aria.labelledBy) && headingText.includes(CHANNEL), 'aria-labelledby points at the channel heading', headingText);
check(Boolean(aria.describedBy), 'aria-describedby points at the subtitle');
const closeBox = await page
    .locator('[role="dialog"] button[aria-label]')
    .first()
    .boundingBox();
check(
    Boolean(closeBox && closeBox.width >= 43.5 && closeBox.height >= 43.5),
    'close button hit area ≥ 44×44',
    closeBox ? `${closeBox.width}×${closeBox.height}` : 'missing',
);
const closeLabel = await page
    .locator('[role="dialog"] button[aria-label]')
    .first()
    .getAttribute('aria-label');
check(closeLabel === '关闭', 'close button has the localized accessible label', String(closeLabel));
check(await activeInsideDialog(), 'initial focus is inside the dialog');
check(await rootInert(), 'background #root is inert');
const locked = await page.evaluate(() => document.body.style.overflow);
check(locked === 'hidden', 'body scroll is locked', locked);
check((await overlay.count()) === 1, 'overlay exists');

console.log('\n[1440] focus trap');
let escaped = false;
for (let i = 0; i < 24; i += 1) {
    await page.keyboard.press('Tab');
    if (!(await activeInsideDialog())) {
        escaped = true;
        console.error(`    Tab #${i + 1} escaped to background`);
        break;
    }
}
check(!escaped, 'Tab stays inside the dialog (24 presses)');
let escapedBack = false;
for (let i = 0; i < 8; i += 1) {
    await page.keyboard.press('Shift+Tab');
    if (!(await activeInsideDialog())) {
        escapedBack = true;
        console.error(`    Shift+Tab #${i + 1} escaped to background`);
        break;
    }
}
check(!escapedBack, 'Shift+Tab stays inside the dialog (8 presses)');
const focusedTag = await page.evaluate(() => document.activeElement?.tagName ?? '');
check(focusedTag !== 'BODY', 'focus never falls back to <body> while open', focusedTag);

await page.waitForTimeout(400); // let the entry animation settle for the evidence shot
await page.screenshot({ path: `${OUT_DIR}/1440-dialog-open.png` });

console.log('\n[1440] Escape close + focus return');
await page.keyboard.press('Escape');
await waitForClose();
check(await triggerFocused(), 'focus returns to the trigger after Escape');
check(!(await rootInert()), 'background inert is cleared after close');
check((await page.evaluate(() => document.body.style.overflow)) === '', 'body scroll is restored after close');

console.log('\n[1440] backdrop close + focus return');
await openDialog();
await page.mouse.click(8, 8);
await waitForClose();
check(await triggerFocused(), 'focus returns to the trigger after backdrop click');

console.log('\n[1440] X close + focus return');
await openDialog();
await page.locator('[role="dialog"] button[aria-label]').first().click();
await waitForClose();
check(await triggerFocused(), 'focus returns to the trigger after X');

// ── 375: layout + scroll lock ────────────────────────────────────────────
console.log('\n[375] layout + scroll lock');
await page.setViewportSize({ width: 375, height: 812 });
await page.reload({ waitUntil: 'domcontentloaded' });
await openDialog();
const panelBox = await dialog.boundingBox();
check(Boolean(panelBox && panelBox.width <= 375 && panelBox.x >= 0), 'panel fits inside 375px', panelBox ? JSON.stringify(panelBox) : 'missing');
const closeBox375 = await page
    .locator('[role="dialog"] button[aria-label]')
    .first()
    .boundingBox();
check(
    Boolean(closeBox375 && closeBox375.width >= 43.5 && closeBox375.height >= 43.5),
    'close button is still ≥ 44×44 at 375',
    closeBox375 ? `${closeBox375.width}×${closeBox375.height}` : 'missing',
);
const scrollBefore = await page.evaluate(() => {
    const scroller = document.querySelector('[data-page-scroll]');
    return scroller instanceof HTMLElement ? scroller.scrollTop : window.scrollY;
});
await page.mouse.move(4, 4);
await page.mouse.wheel(0, 900);
await page.waitForTimeout(150);
const scrollAfter = await page.evaluate(() => {
    const scroller = document.querySelector('[data-page-scroll]');
    return scroller instanceof HTMLElement ? scroller.scrollTop : window.scrollY;
});
check(scrollBefore === scrollAfter, 'background does not scroll behind the dialog', `${scrollBefore} → ${scrollAfter}`);
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT_DIR}/375-dialog-open.png` });

await page.locator('[role="dialog"] button[aria-label]').first().click();
await waitForClose();
check(await triggerFocused(), 'focus returns to the trigger at 375');

await browser.close();

console.log('\nScreenshots:');
console.log(`  ${OUT_DIR}/1440-dialog-open.png`);
console.log(`  ${OUT_DIR}/375-dialog-open.png`);

if (failures.length > 0) {
    console.error(`\nFAILED (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    process.exit(1);
}
console.log('\nAll I-02 dialog checks passed.');
