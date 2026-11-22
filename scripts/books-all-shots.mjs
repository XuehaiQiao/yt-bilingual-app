// 全公版书库验收截图：内容页 / 系列页 / 阅读器 / 375px。
// 运行：APP_URL=http://localhost:5174 node books-all-shots.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.APP_URL || 'http://localhost:5174';
const OUT = '/tmp/books-all-shots';
fs.mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ headless: true, channel: 'chrome' });
const errors = [];

async function newPage(width, height) {
    const context = await browser.newContext({
        viewport: { width, height },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(String(error)));
    return { context, page };
}

async function waitForBooks(page) {
    await page.waitForSelector('[data-testid="books-section"]', { timeout: 30000 });
    await page.waitForSelector('[data-testid^="book-series-"]', { timeout: 30000 });
    await page.waitForTimeout(800);
}

async function shot(page, name, { fullPage = false, selector = null } = {}) {
    if (selector) {
        const node = page.locator(selector);
        await node.scrollIntoViewIfNeeded();
        await page.waitForTimeout(500);
        await node.screenshot({ path: `${OUT}/${name}` });
    } else {
        await page.screenshot({ path: `${OUT}/${name}`, fullPage });
    }
    console.log('✓', name);
}

// 桌面：内容页公版书区块
{
    const { context, page } = await newPage(1440, 900);
    await page.goto(`${BASE}/#/content`, { waitUntil: 'domcontentloaded' });
    await waitForBooks(page);
    await page.locator('[data-testid="books-section"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(600);
    await shot(page, '01-content-books.png');
    await shot(page, '01b-content-books-full.png', { fullPage: true });
    await context.close();
}

// 桌面：各系列页
for (const [series, name] of [
    ['peter-rabbit', '02-series-peter-rabbit.png'],
    ['anne', '03-series-anne-excluded.png'],
    ['tarzan', '04-series-tarzan.png'],
]) {
    const { context, page } = await newPage(1440, 900);
    await page.goto(`${BASE}/#/content/book-series/${series}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-series-available"]', { timeout: 30000 });
    await page.waitForTimeout(700);
    if (series === 'anne') {
        await shot(page, name, { selector: '[data-testid="book-series-screen"]' });
        await shot(page, '03b-series-anne-excluded-block.png', { selector: '[data-testid="book-series-excluded"]' });
    } else {
        await shot(page, name);
    }
    await context.close();
}

// 桌面：阅读器（已译 / 未译）
for (const [path, name, translated] of [
    ['pr-the-tale-of-squirrel-nutkin', '05-reader-peter-rabbit.png', true],
    ['sh-the-return-of-sherlock-holmes', '06-reader-untranslated.png', false],
    ['sh-a-study-in-scarlet', '07-reader-sherlock-translated.png', true],
]) {
    const { context, page } = await newPage(1440, 900);
    await page.goto(`${BASE}/#/content/book/${path}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-paragraph-0"]', { timeout: 90000 });
    if (translated) {
        await page.waitForSelector('[data-testid="book-translation-0"]', { timeout: 60000 });
    } else {
        await page.waitForSelector('[data-testid="book-chapter-translation-pending"]', { timeout: 60000 });
    }
    await page.waitForTimeout(500);
    await shot(page, name);
    await page.locator('[data-testid="book-paragraph-2"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await shot(page, name.replace('.png', '-scroll.png'));
    await context.close();
}

// 移动端 375px（需求）
{
    const { context, page } = await newPage(375, 812);
    await page.goto(`${BASE}/#/content`, { waitUntil: 'domcontentloaded' });
    await waitForBooks(page);
    await page.locator('[data-testid="books-section"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await shot(page, '08-mobile-content.png');
    await page.goto(`${BASE}/#/content/book-series/peter-rabbit`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-series-available"]', { timeout: 30000 });
    await page.waitForTimeout(500);
    await shot(page, '09-mobile-series.png');
    await page.locator('[data-testid="book-series-book-pr-the-tale-of-pigling-bland"]').scrollIntoViewIfNeeded();
    await shot(page, '09b-mobile-series-list.png');
    await page.goto(`${BASE}/#/content/book/pr-the-tale-of-squirrel-nutkin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-translation-0"]', { timeout: 90000 });
    await page.waitForTimeout(500);
    await shot(page, '10-mobile-reader.png');
    await context.close();
}

// 越南语 UI（需求：中越）
{
    const context = await browser.newContext({
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 2,
        colorScheme: 'dark',
        reducedMotion: 'reduce',
    });
    await context.addInitScript(() => {
        localStorage.setItem('yt_bilingual_ui_lang', 'vi-VN');
    });
    const page = await context.newPage();
    await page.goto(`${BASE}/#/content/book-series/anne`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-series-excluded"]', { timeout: 30000 });
    await page.locator('[data-testid="book-series-excluded"]').scrollIntoViewIfNeeded();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/11-vi-series-excluded.png` });
    await page.goto(`${BASE}/#/content/book/pr-the-tale-of-squirrel-nutkin`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-testid="book-translation-0"]', { timeout: 90000 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${OUT}/12-vi-reader.png` });
    await context.close();
}

await browser.close();
if (errors.length) {
    console.log('PAGE ERRORS:', errors.slice(0, 5));
    process.exitCode = 1;
}
console.log('done:', fs.readdirSync(OUT).sort().join(', '));
