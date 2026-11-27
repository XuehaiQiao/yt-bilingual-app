// Cross-tab auth isolation (P2-48): one browser profile has one session.
// A sign-in/out in one tab broadcasts; other tabs must reload so they cannot
// keep rendering account A while the shared cookie now resolves to account B.
//
// Uses the real local frontend (5173) and only exercises the broadcast/reload
// path; no credentials or backend writes are needed.
import { chromium } from 'playwright';
import { existsSync } from 'node:fs';

const BASE = process.env.APP_BASE || 'http://127.0.0.1:5173';
const chrome = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch(existsSync(chrome) ? { executablePath: chrome } : {});
const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
const first = await context.newPage();
const second = await context.newPage();
let firstNavigations = 0;
let secondNavigations = 0;
first.on('framenavigated', (frame) => {
  if (frame === first.mainFrame()) firstNavigations += 1;
});
second.on('framenavigated', (frame) => {
  if (frame === second.mainFrame()) secondNavigations += 1;
});

await Promise.all([
  first.goto(`${BASE}/#/app/today`, { waitUntil: 'domcontentloaded' }),
  second.goto(`${BASE}/#/app/today`, { waitUntil: 'domcontentloaded' }),
]);
await first.waitForTimeout(1500);
const firstBefore = firstNavigations;
const secondBefore = secondNavigations;

// The sender tab must not reload itself; the other tab must.
await second.evaluate(() => localStorage.setItem('ln_auth_sync_v1', String(Date.now())));
await first.waitForTimeout(1500);

const firstReloaded = firstNavigations > firstBefore;
const secondStayed = secondNavigations === secondBefore;
await browser.close();

console.log(JSON.stringify({
  firstReloaded,
  secondStayed,
  firstNavigations,
  secondNavigations,
}, null, 2));

if (!firstReloaded || !secondStayed) {
  console.error('P2-48 acceptance failed: sender must not reload, peer must reload');
  process.exit(1);
}
console.log('P2-48 cross-tab auth acceptance: PASS');
