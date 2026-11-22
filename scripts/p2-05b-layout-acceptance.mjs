// P2-05B desktop layout acceptance (docs/设计-桌面布局规范.md §7).
//
// Real public pages, mocked API: opens the blog list, a blog article, pricing,
// resources, privacy and terms and asserts against the actual DOM at
// 1440 / 1920 / 375:
//   - 1440: marketing container 1200 (content box 1136 ≥ 1100), centered at
//     x = 120, no horizontal overflow;
//   - 1920: still the 1200 measure, centered at x = 360;
//   - legal: a 240px TOC rail is visible only at ≥xl, sticky under the public
//     header, sits right of the body; the body column keeps its readable 3xl
//     measure instead of stretching with the container; a TOC click scrolls
//     in-page (no route change) and the heading clears the sticky header;
//   - blog: the list uses the marketing measure; an article keeps the 68ch
//     reading column (65–75ch) so markdown does not stretch into long lines;
//   - pricing/resources: the card grid spans the marketing content width, one
//     column at 375;
//   - 375: single column, TOC hidden, no horizontal overflow.
// Screenshots: /tmp/p2-05b-<page>-<width>@<sha7>.png.
//
// Run: node scripts/p2-05b-layout-acceptance.mjs
// Needs `npm run dev` on http://127.0.0.1:5173 (override with APP_URL).
import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const BASE = process.env.APP_URL || 'http://127.0.0.1:5173/';
const CHROME =
    process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const HEAD = execSync('git rev-parse --short=7 HEAD', { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
const SHOT = (name, width, suffix = '') => `/tmp/p2-05b-${name}-${width}${suffix}@${HEAD}.png`;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// ── Fixtures ─────────────────────────────────────────────────────────────
const BLOG_SLUG = 'why-linguatrek';

const BLOG_POSTS = {
    posts: [
        {
            slug: BLOG_SLUG,
            title: '为什么是语途：用真实内容学英语',
            date: '2026-11-20',
            excerpt: '不做打卡，不堆题库：用你真正想看的内容，把英语变成日常。',
            tags: ['理念', '学习设计'],
            lang: 'zh-CN',
            readingMinutes: 5,
        },
        {
            slug: 'no-streak-design',
            title: '为什么我们不设计连续打卡',
            date: '2026-11-18',
            excerpt: '连续天数会惩罚生活，语途用“今天可以停下来”代替断签焦虑。',
            tags: ['设计'],
            lang: 'zh-CN',
            readingMinutes: 4,
        },
    ],
    count: 2,
};

const BLOG_ARTICLE = {
    ...BLOG_POSTS.posts[0],
    published: true,
    markdown: [
        '# 为什么是语途',
        '',
        '学英语最稀缺的不是题目，而是你愿意反复回到的真实内容。把一段你看得懂七八成的视频、一篇文章读透，比刷一百道选择题更接近“会用”。',
        '',
        '## 从真实内容出发',
        '',
        '- 先看内容，再查词：语境先于定义。',
        '- 把生词放进句子，而不是放进词表。',
        '- 学完立刻在原文里再遇到一次。',
        '',
        '## 不设计打卡',
        '',
        '连续天数会把学习变成负担。语途只记录你真正花在内容上的时间，并在合适的时候提醒你回来。',
    ].join('\n'),
    html: '<h1>为什么是语途</h1><p>示例</p>',
};

// ── Browser + mocked API ─────────────────────────────────────────────────
const cors = {
    'access-control-allow-origin': 'http://127.0.0.1:5173',
    'access-control-allow-credentials': 'true',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,x-api-key',
    'access-control-max-age': '600',
};

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    reducedMotion: 'reduce',
});
await context.addInitScript(() => {
    try {
        localStorage.setItem('yt_bilingual_ui_lang', 'zh-CN');
        localStorage.setItem('yt_bilingual_target_lang', 'zh-CN');
    } catch {
        /* about:blank has no storage access; the real pages do. */
    }
});

await context.route('**/api/**', (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    const pathname = new URL(request.url()).pathname;
    const respond = (data, status = 200) =>
        route.fulfill({
            status,
            contentType: 'application/json',
            headers: cors,
            body: JSON.stringify(data),
        });
    if (pathname === '/api/auth/me') {
        return respond({
            user: { id: 'u-layout', email: 'layout@example.com' },
            isAdmin: false,
            guest: false,
        });
    }
    if (pathname === '/api/blog/posts') return respond(BLOG_POSTS);
    if (pathname === `/api/blog/posts/${BLOG_SLUG}`) return respond(BLOG_ARTICLE);
    if (pathname.startsWith('/api/')) return respond({});
    return route.fulfill({
        status: 404,
        headers: cors,
        contentType: 'application/json',
        body: '{}',
    });
});

const page = await context.newPage();
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));

// ── Metrics helpers ──────────────────────────────────────────────────────
const metrics = () =>
    page.evaluate(() => {
        const byTestId = (id) => document.querySelector(`[data-testid="${id}"]`);
        const box = (el) => {
            if (!el) return null;
            const rect = el.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
        };
        const container = byTestId('page-container');
        let contentWidth = null;
        if (container) {
            const style = getComputedStyle(container);
            contentWidth =
                container.getBoundingClientRect().width -
                parseFloat(style.paddingLeft) -
                parseFloat(style.paddingRight);
        }
        const toc = byTestId('legal-toc');
        return {
            viewport: window.innerWidth,
            documentWidth: document.documentElement.scrollWidth,
            scrollY: window.scrollY,
            container: container
                ? {
                      ...box(container),
                      contentWidth,
                      variant: container.getAttribute('data-page-variant'),
                      documentOffsetLeft: container.getBoundingClientRect().x,
                  }
                : null,
            blogList: box(byTestId('blog-post-list')),
            blogMarkdown: box(byTestId('blog-markdown')),
            pricingGrid: box(byTestId('pricing-free-card')?.parentElement),
            pricingFirstCard: box(byTestId('pricing-free-card')),
            pricingSecondCard: box(byTestId('pricing-free-card')?.parentElement?.children?.[1]),
            resourcesList: box(byTestId('resource-card-blog')?.closest('ul')),
            resourceCards: Array.from(
                document.querySelectorAll('[data-testid^="resource-card-"]'),
            ).map(box),
            legalBody: box(byTestId('legal-body')),
            legalGrid: box(byTestId('legal-body')?.parentElement),
            legalArticle: box(byTestId('legal-title')?.closest('section')?.querySelector('article')),
            legalToc: box(toc),
            legalTocPosition: toc ? getComputedStyle(toc).position : null,
            legalTocVisible: toc ? getComputedStyle(toc).display !== 'none' : false,
            legalTocCount: document.querySelectorAll('[data-testid^="legal-toc-"]').length,
            legalSectionCount: document.querySelectorAll('[data-testid^="legal-section-"]').length,
            legalDocWidth: document.documentElement.scrollWidth,
        };
    });

const assertNoOverflow = (label, data) => {
    assert.ok(
        data.documentWidth <= data.viewport + 1,
        `${label}: horizontal overflow (document ${data.documentWidth} > viewport ${data.viewport})`,
    );
};

const assertMarketingMetrics = (label, data, expectedX) => {
    assert.ok(data.container, `${label}: missing PageContainer`);
    assert.equal(data.container.variant, 'marketing', `${label}: container variant`);
    assert.ok(
        Math.abs(data.container.width - 1200) <= 2,
        `${label}: container ${data.container.width} != 1200`,
    );
    assert.ok(
        Math.abs(data.container.x - expectedX) <= 2,
        `${label}: container x ${data.container.x} != ${expectedX} (not centered)`,
    );
    assert.ok(
        data.container.contentWidth >= 1100,
        `${label}: content ${data.container.contentWidth} < 1100`,
    );
    assertNoOverflow(label, data);
};

// ── Per-page assertions ──────────────────────────────────────────────────
const cases = [
    {
        name: 'blog-list',
        url: '/blog',
        ready: ['public-header', 'blog-post-list'],
        check1440: (data) => {
            assert.ok(data.blogList, 'blog-list 1440: missing blog post list');
            assert.ok(data.blogList.width >= 1100, `blog-list 1440: list ${data.blogList.width} < 1100`);
        },
        check1920: (data) => {
            assert.ok(data.blogList.width >= 1100, `blog-list 1920: list ${data.blogList.width} < 1100`);
        },
        check375: (data) => {
            assert.ok(data.blogList, 'blog-list 375: missing blog post list');
            assert.ok(data.blogList.width <= 343.5, `blog-list 375: list ${data.blogList.width} > 343`);
            assert.equal(
                Math.round(data.blogList.x),
                Math.round(data.container.x + 16),
                'blog-list 375: list is not flush with the page padding',
            );
        },
    },
    {
        name: 'blog-article',
        url: `/blog/${BLOG_SLUG}`,
        ready: ['public-header', 'blog-markdown'],
        check1440: (data) => {
            assert.ok(data.blogMarkdown, 'blog-article 1440: missing markdown body');
            assert.ok(
                data.blogMarkdown.width >= 600 && data.blogMarkdown.width <= 760,
                `blog-article 1440: body ${data.blogMarkdown.width} outside the 68ch reading column`,
            );
        },
        check1920: (data) => {
            assert.ok(
                data.blogMarkdown.width >= 600 && data.blogMarkdown.width <= 760,
                `blog-article 1920: body ${data.blogMarkdown.width} outside the 68ch reading column`,
            );
        },
        check375: (data) => {
            assert.ok(
                data.blogMarkdown.width <= 343.5,
                `blog-article 375: body ${data.blogMarkdown.width} > 343`,
            );
        },
    },
    {
        name: 'pricing',
        url: '/pricing',
        ready: ['public-header', 'pricing-title', 'pricing-free-card'],
        check1440: (data) => {
            assert.ok(data.pricingGrid, 'pricing 1440: missing card grid');
            assert.ok(data.pricingGrid.width >= 1100, `pricing 1440: grid ${data.pricingGrid.width} < 1100`);
            assert.equal(
                Math.round(data.pricingSecondCard.y),
                Math.round(data.pricingFirstCard.y),
                'pricing 1440: the two cards are not on one row',
            );
        },
        check1920: (data) => {
            assert.ok(data.pricingGrid.width >= 1100, `pricing 1920: grid ${data.pricingGrid.width} < 1100`);
        },
        check375: (data) => {
            assert.ok(data.pricingGrid.width <= 343.5, `pricing 375: grid ${data.pricingGrid.width} > 343`);
            assert.ok(
                data.pricingSecondCard.y >= data.pricingFirstCard.y + data.pricingFirstCard.height - 1,
                'pricing 375: cards did not stack into one column',
            );
        },
    },
    {
        name: 'resources',
        url: '/resources',
        ready: ['public-header', 'resources-title', 'resource-card-blog'],
        check1440: (data) => {
            assert.ok(data.resourcesList, 'resources 1440: missing resource list');
            assert.ok(
                data.resourcesList.width >= 1100,
                `resources 1440: list ${data.resourcesList.width} < 1100`,
            );
            assert.equal(data.resourceCards.length, 5, 'resources 1440: expected five resource cards');
            assert.equal(
                Math.round(data.resourceCards[2].y),
                Math.round(data.resourceCards[0].y),
                'resources 1440: the cards are not on one three-column row',
            );
        },
        check1920: (data) => {
            assert.ok(
                data.resourcesList.width >= 1100,
                `resources 1920: list ${data.resourcesList.width} < 1100`,
            );
        },
        check375: (data) => {
            assert.ok(data.resourceCards.length === 5, 'resources 375: expected five resource cards');
            for (let index = 1; index < data.resourceCards.length; index += 1) {
                assert.ok(
                    data.resourceCards[index].y >=
                        data.resourceCards[index - 1].y + data.resourceCards[index - 1].height - 1,
                    `resources 375: card ${index} did not stack into one column`,
                );
            }
        },
    },
    ...[
        ['privacy', '/privacy', 'legal-section-operator'],
        ['terms', '/terms', 'legal-section-service'],
    ].map(([name, url, sectionId]) => ({
        name,
        url,
        ready: ['public-header', 'legal-title', sectionId, 'legal-toc'],
        legal: true,
        check1440: (data) => {
            assert.ok(data.legalToc, `${name} 1440: missing TOC`);
            assert.ok(data.legalTocVisible, `${name} 1440: TOC is hidden at xl`);
            assert.ok(
                Math.abs(data.legalToc.width - 240) <= 2,
                `${name} 1440: TOC ${data.legalToc.width} != 240`,
            );
            assert.equal(data.legalTocPosition, 'sticky', `${name} 1440: TOC is not sticky`);
            assert.ok(
                data.legalToc.x >= data.legalBody.x + data.legalBody.width - 1,
                `${name} 1440: TOC is not right of the body column`,
            );
            assert.ok(
                data.legalGrid.width >= 1100,
                `${name} 1440: two-column grid ${data.legalGrid.width} < 1100`,
            );
            assert.ok(
                data.legalArticle.width <= 780 && data.legalArticle.width >= 700,
                `${name} 1440: body measure ${data.legalArticle.width} outside the readable column`,
            );
            assert.equal(
                data.legalTocCount,
                data.legalSectionCount,
                `${name} 1440: TOC entries do not match sections`,
            );
            assert.ok(data.legalSectionCount >= 9, `${name} 1440: too few sections to test a TOC`);
        },
        check1920: (data) => {
            assert.ok(
                Math.abs(data.legalToc.width - 240) <= 2,
                `${name} 1920: TOC ${data.legalToc.width} != 240`,
            );
            assert.equal(data.legalTocPosition, 'sticky', `${name} 1920: TOC is not sticky`);
            assert.ok(
                data.legalBody.width >= 800 && data.legalBody.width <= 900,
                `${name} 1920: body column ${data.legalBody.width} out of range`,
            );
        },
        check375: (data) => {
            assert.equal(data.legalTocVisible, false, `${name} 375: TOC must be hidden on narrow screens`);
            assert.ok(data.legalBody, `${name} 375: missing body column`);
            assert.ok(data.legalBody.width <= 343.5, `${name} 375: body ${data.legalBody.width} > 343`);
            assert.ok(
                data.legalArticle.width <= 343.5,
                `${name} 375: article ${data.legalArticle.width} > 343`,
            );
        },
    })),
];

const results = [];

for (const entry of cases) {
    const label = entry.name;
    // A fresh document per page: a hash-only change keeps the previous screen.
    await page.goto('about:blank');
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${BASE}#${entry.url}`, { waitUntil: 'domcontentloaded' });
    for (const testId of entry.ready) {
        await page.locator(`[data-testid="${testId}"]`).waitFor({ state: 'visible', timeout: 20000 });
    }
    await sleep(500); // fonts + the xl media query

    // ── 1440 ─────────────────────────────────────────────────────────────
    await page.evaluate(() => window.scrollTo(0, 0));
    const at1440 = await metrics();
    await page.screenshot({ path: SHOT(label, 1440), fullPage: false });
    assertMarketingMetrics(`${label} 1440`, at1440, 120);
    entry.check1440(at1440);

    // ── 1920 ─────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 1920, height: 900 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const at1920 = await metrics();
    await page.screenshot({ path: SHOT(label, 1920), fullPage: false });
    assertMarketingMetrics(`${label} 1920`, at1920, 360);
    entry.check1920(at1920);

    // ── 375 ──────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 375, height: 812 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(300);
    const at375 = await metrics();
    await page.screenshot({ path: SHOT(label, 375), fullPage: false });
    assertNoOverflow(`${label} 375`, at375);
    assert.ok(at375.container, `${label} 375: missing PageContainer`);
    assert.ok(
        at375.container.width <= 375.5 && at375.container.contentWidth >= 300,
        `${label} 375: container ${at375.container.width} / content ${at375.container.contentWidth} out of range`,
    );
    entry.check375(at375);

    const result = {
        page: label,
        screenshots: [SHOT(label, 1440), SHOT(label, 1920), SHOT(label, 375)],
        at1440: {
            containerWidth: at1440.container.width,
            contentWidth: at1440.container.contentWidth,
            containerX: at1440.container.x,
            innerWidths: {
                blogList: at1440.blogList?.width ?? null,
                blogArticleBody: at1440.blogMarkdown?.width ?? null,
                pricingGrid: at1440.pricingGrid?.width ?? null,
                resourcesList: at1440.resourcesList?.width ?? null,
                legalBody: at1440.legalBody?.width ?? null,
                legalToc: at1440.legalToc?.width ?? null,
                legalArticle: at1440.legalArticle?.width ?? null,
            },
        },
        at1920: {
            containerWidth: at1920.container.width,
            contentWidth: at1920.container.contentWidth,
            containerX: at1920.container.x,
        },
        at375: {
            containerWidth: at375.container.width,
            contentWidth: at375.container.contentWidth,
        },
    };

    // ── legal: the TOC jumps in-page and stays stuck under the header ─────
    if (entry.legal) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.evaluate(() => window.scrollTo(0, 0));
        await sleep(300);
        const [secondTocId] = await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('[data-testid^="legal-toc-"]'));
            return [buttons[1]?.getAttribute('data-testid') ?? null];
        });
        assert.ok(secondTocId, `${label}: missing a second TOC entry`);
        const hashBefore = await page.evaluate(() => window.location.hash);
        await page.locator(`[data-testid="${secondTocId}"]`).click();
        await sleep(400);
        const afterJump = await metrics();
        const hashAfter = await page.evaluate(() => window.location.hash);
        assert.equal(hashAfter, hashBefore, `${label}: TOC click must not change the route`);
        assert.ok(afterJump.scrollY > 0, `${label}: TOC click did not scroll the page`);
        const headingTop = await page.evaluate((tocId) => {
            const target = document.getElementById(
                `legal-${tocId.replace('legal-toc-', '')}-title`,
            );
            return target ? target.getBoundingClientRect().top : null;
        }, secondTocId);
        assert.ok(headingTop !== null, `${label}: TOC target heading missing`);
        assert.ok(
            headingTop >= 40 && headingTop <= 160,
            `${label}: heading landed at ${headingTop}px (under the sticky header or off screen)`,
        );
        assert.ok(
            Math.abs(afterJump.legalToc.y - 80) <= 2,
            `${label}: sticky TOC top ${afterJump.legalToc.y} != 80`,
        );
        await page.screenshot({ path: SHOT(label, 1440, '-toc-jump') });
        result.tocJump = {
            target: secondTocId,
            scrollY: afterJump.scrollY,
            headingTop,
            tocTop: afterJump.legalToc.y,
            routeUnchanged: hashAfter === hashBefore,
        };
    }

    results.push(result);
}

assert.deepEqual(pageErrors, [], `page errors: ${JSON.stringify(pageErrors)}`);

console.log(
    JSON.stringify(
        {
            status: 'PASS',
            head: HEAD,
            pages: results,
        },
        null,
        2,
    ),
);

await browser.close();
