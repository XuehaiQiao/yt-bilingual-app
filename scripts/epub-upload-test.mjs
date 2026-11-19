// specs/031 local EPUB upload — frontend M1 acceptance (mock API, no backend).
//
// Covers:
//   - link / upload tabs (panel skin, keyboard ←/→/Home/End);
//   - local EPUB: pick → upload/parse progress → preview (cover/metadata) →
//     rights declaration → import → shelf card with "本地" badge + cover;
//   - errors: DRM / no chapters / not EPUB / too large / server 413 / cancel;
//   - the public-domain link tab still previews (regression);
//   - 1440 + 375 layouts, no horizontal overflow, zh-CN + vi-VN copy.
//
// Run with the Vite dev server up (API is mocked at the network layer):
//   cd scripts && APP_URL=http://127.0.0.1:5173 node epub-upload-test.mjs
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';

const APP_URL = (process.env.APP_URL || 'http://127.0.0.1:5173').replace(/\/+$/, '');
const OUT_DIR = process.env.SHOT_DIR || '/tmp/epub-upload-shots';
const EPUB_NAME = 'pride-and-prejudice.epub';
const EPUB_FILE = {
    name: EPUB_NAME,
    mimeType: 'application/epub+zip',
    // Same byte count as the mocked preview payload, so the file row and the
    // parsed preview agree in screenshots.
    buffer: Buffer.alloc(2_345_678, 0x65),
};

// 1×1 PNG used both as the preview data URL and the shelf cover endpoint body.
const PNG_BASE64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const PNG_BODY = Buffer.from(PNG_BASE64, 'base64');
const COVER_DATA_URL = `data:image/png;base64,${PNG_BASE64}`;

const PREVIEW_PAYLOAD = {
    uploadToken: 'tok-epub-1',
    fileName: EPUB_NAME,
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    language: 'en',
    chapterCount: 61,
    chapters: [
        { n: 1, title: 'Chapter I' },
        { n: 2, title: 'Chapter II' },
        { n: 3, title: 'Chapter III' },
    ],
    coverDataUrl: COVER_DATA_URL,
    sizeBytes: 2_345_678,
};

const GUTENBERG_BOOK = {
    bookId: 'book-gutenberg-1',
    sourceType: 'gutenberg',
    source: {
        provider: 'Project Gutenberg',
        url: 'https://www.gutenberg.org/ebooks/1342',
    },
    sourceUrl: 'https://www.gutenberg.org/ebooks/1342',
    externalId: 'gutenberg:1342',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    language: 'en',
    chapterCount: 61,
    translatedChapters: 2,
    targetLang: 'zh-CN',
    createdAt: 1,
    updatedAt: 1,
    chapters: [],
    coverUrl: null,
};

const LOCAL_BOOK = {
    bookId: 'book-local-1',
    sourceType: 'local_epub',
    // The real backend hides the local:// identifier: both URLs are null.
    source: {
        provider: 'Local EPUB',
        url: null,
    },
    sourceUrl: null,
    externalId: 'epub:mock-sha256',
    title: 'Pride and Prejudice',
    author: 'Jane Austen',
    language: 'en',
    chapterCount: 61,
    translatedChapters: 0,
    targetLang: 'zh-CN',
    createdAt: 2,
    updatedAt: 2,
    chapters: [{ n: 1, title: 'Chapter I', translated: false, translatedParagraphs: 0 }],
    coverUrl: '/api/books/imported/book-local-1/cover',
};

// The backend returns FastAPI-style Chinese `detail` strings; the frontend maps
// them (plus the HTTP status) onto LocalEpubErrorCode client-side.
const PREVIEW_FAILURES = {
    drm: { status: 422, detail: '这本书是加密/DRM EPUB，无法上传。' },
    noChapters: {
        status: 422,
        detail: '这本书没有可读正文（可能是纯图片/扫描版，或 EPUB 结构不完整）。',
    },
    unsupportedLanguage: {
        status: 422,
        detail: '目前只支持英文 EPUB（检测到语言：fr）。',
    },
    corrupt: { status: 400, detail: '不是有效的 EPUB 文件（ZIP 解析失败）。' },
    notEpub: { status: 400, detail: '只支持 .epub 格式的英文电子书。' },
    tooLarge: { status: 413, detail: '文件超过 30MB 上限。' },
};

const failures = [];
let checks = 0;
function check(ok, label, detail = '') {
    checks += 1;
    if (ok) {
        console.log(`  ✓ ${label}`);
    } else {
        failures.push(label);
        console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function launchBrowser() {
    try {
        return await chromium.launch({ headless: true });
    } catch {
        return await chromium.launch({
            headless: true,
            channel: process.env.PW_CHANNEL || 'chrome',
        });
    }
}

function createState(language = 'zh-CN') {
    return {
        language,
        imported: [{ ...GUTENBERG_BOOK }],
        previewMode: 'ok',
        previewDelay: 0,
        uploadDelay: 0,
        previewCalls: 0,
        linkPreviewCalls: 0,
        uploadCalls: 0,
        lastPreviewBody: '',
        lastUploadBody: '',
    };
}

const json = (route, payload, status = 200) =>
    route
        .fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify(payload),
        })
        .catch(() => {
            // The page may have aborted the request (cancel test).
        });

async function installMocks(context, state) {
    await context.addInitScript(
        ({ language }) => {
            window.localStorage.setItem('yt_bilingual_ui_lang', language);
            window.localStorage.setItem('yt_bilingual_target_lang', language);
        },
        { language: state.language },
    );

    await context.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const pathname = url.pathname;
        const method = request.method();

        if (pathname === '/api/auth/me') {
            return json(route, {
                user: {
                    id: 'u-epub',
                    email: 'epub@example.com',
                    username: 'EPUB Tester',
                    credits: 100,
                    status: 'active',
                },
                isAdmin: false,
            });
        }
        if (pathname === '/api/history') return json(route, []);
        if (pathname === '/api/report/week') {
            return json(route, {
                numbers: { passiveMinutes: 0, reviewedWords: 0, quizAccuracy: null },
            });
        }
        if (pathname === '/api/subscriptions') return json(route, []);
        if (pathname === '/api/favorites') return json(route, []);
        if (pathname === '/api/library') return json(route, { videos: [], articles: [] });
        if (pathname === '/api/models') return json(route, { models: [] });
        if (pathname === '/api/shows') return json(route, { shows: [] });
        if (pathname === '/api/sentences/levels') return json(route, []);
        if (pathname === '/api/placement/profile') return json(route, { profile: null });
        if (pathname === '/api/recommendations') {
            return json(route, {
                items: [],
                basis: { band: 'A2–B1', source: 'default' },
                preliminary: false,
            });
        }
        if (pathname === '/api/books' && method === 'GET') {
            return json(route, {
                series: [],
                counts: {
                    series: 0,
                    books: 0,
                    availableBooks: 0,
                    readableChapters: 0,
                    translatedChapters: 0,
                },
            });
        }
        if (pathname === '/api/books/import/preview' && method === 'POST') {
            state.linkPreviewCalls += 1;
            return json(route, {
                sourceType: 'gutenberg',
                source: {
                    provider: 'Project Gutenberg',
                    url: 'https://www.gutenberg.org/ebooks/1342',
                },
                sourceUrl: 'https://www.gutenberg.org/ebooks/1342',
                externalId: 'gutenberg:1342',
                title: 'Pride and Prejudice',
                author: 'Jane Austen',
                language: 'en',
                chapterCount: 61,
                chapters: [{ n: 1, title: 'Chapter I' }],
            });
        }
        if (pathname === '/api/books/upload/preview' && method === 'POST') {
            state.previewCalls += 1;
            state.lastPreviewBody = request.postDataBuffer()?.toString('utf8') ?? '';
            if (state.previewDelay > 0) await sleep(state.previewDelay);
            if (state.previewMode === 'network') {
                await route.abort('failed').catch(() => {});
                return;
            }
            const failure = PREVIEW_FAILURES[state.previewMode];
            if (failure) return json(route, { detail: failure.detail }, failure.status);
            return json(route, { ...PREVIEW_PAYLOAD, fileName: EPUB_NAME });
        }
        if (pathname === '/api/books/upload' && method === 'POST') {
            state.uploadCalls += 1;
            state.lastUploadBody = request.postDataBuffer()?.toString('utf8') ?? '';
            if (state.uploadDelay > 0) await sleep(state.uploadDelay);
            if (!/name="rightsAccepted"\r\n\r\ntrue/.test(state.lastUploadBody)) {
                return json(route, { detail: 'rights declaration required' }, 422);
            }
            if (!state.imported.some((book) => book.bookId === LOCAL_BOOK.bookId)) {
                state.imported = [{ ...LOCAL_BOOK }, ...state.imported];
            }
            return json(route, {
                bookId: LOCAL_BOOK.bookId,
                title: LOCAL_BOOK.title,
                author: LOCAL_BOOK.author,
                chapterCount: LOCAL_BOOK.chapterCount,
                sourceType: 'local_epub',
                existing: false,
            });
        }
        if (pathname === '/api/books/imported/book-local-1/cover') {
            await route
                .fulfill({ status: 200, contentType: 'image/png', body: PNG_BODY })
                .catch(() => {});
            return;
        }
        if (pathname === '/api/books/imported' && method === 'GET') {
            return json(route, { books: state.imported.map((book) => ({ ...book })) });
        }
        if (pathname === '/api/books/imported/book-local-1' && method === 'GET') {
            return json(route, { ...LOCAL_BOOK });
        }
        if (pathname === '/api/books/imported/book-local-1/chapters/1' && method === 'GET') {
            return json(route, {
                ...LOCAL_BOOK,
                chapter: 1,
                chapterTitle: 'Chapter I',
                targetLang: state.language,
                translated: false,
                translatedChapters: 0,
                missingTranslations: 1,
                paragraphs: [{ index: 0, en: 'It is a truth universally acknowledged.', zh: null }],
                quota: {
                    feature: 'reading',
                    limitPerDay: 20,
                    usedToday: 0,
                    remainingToday: 20,
                    day: '2026-11-19',
                },
                source: {
                    provider: 'Local EPUB',
                    url: null,
                    fetchedAt: '2026-11-19T00:00:00Z',
                    degraded: false,
                },
            });
        }

        return json(route, {});
    });
}

async function newPage(browser, state, { width, height }) {
    const context = await browser.newContext({
        viewport: { width, height },
        colorScheme: 'dark',
        reducedMotion: 'reduce',
    });
    await installMocks(context, state);
    const page = await context.newPage();
    page.on('pageerror', (error) => {
        failures.push(`pageerror: ${error.message}`);
        console.error('  ! pageerror:', error.message);
    });
    return { context, page };
}

async function openContent(page) {
    await page.goto(`${APP_URL}/#/app/content`, { waitUntil: 'domcontentloaded' });
    await page.getByTestId('books-section').waitFor({ state: 'visible', timeout: 25000 });
    // The auth bootstrap re-renders the shell once; give it a beat so the
    // import trigger is stable before clicking.
    await page.waitForTimeout(900);
}

async function openImportDialog(page) {
    const trigger = page.getByTestId('book-import-open');
    await trigger.waitFor({ state: 'visible', timeout: 20000 });
    await trigger.click();
    await page.getByTestId('book-import-dialog').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(350);
}

async function goToUploadTab(page) {
    await page.getByTestId('book-import-tab-upload').click();
    await page.getByTestId('book-import-upload-panel').waitFor({ state: 'visible' });
}

async function pickFile(page, payload) {
    await page.getByTestId('local-epub-input').setInputFiles(payload);
}

async function dialogOverflow(page, label) {
    const result = await page.getByTestId('book-import-dialog').evaluate((panel) => {
        const rect = panel.getBoundingClientRect();
        if (rect.left < -0.5 || rect.right > window.innerWidth + 0.5) {
            return `panel ${rect.left}…${rect.right} vs ${window.innerWidth}`;
        }
        const scroller = panel.querySelector('.custom-scrollbar');
        if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
            return `scroller ${scroller.scrollWidth} > ${scroller.clientWidth}`;
        }
        return null;
    });
    check(!result, label, result || '');
}

(async () => {
    await mkdir(OUT_DIR, { recursive: true });
    const browser = await launchBrowser();
    console.log(`specs/031 local EPUB frontend @ ${APP_URL}`);

    // ── 1440: tabs, keyboard, link regression, upload, errors, cancel ──────
    {
        const state = createState();
        const { context, page } = await newPage(browser, state, { width: 1440, height: 900 });

        console.log('\n[1440] dialog + tabs');
        await openContent(page);
        await openImportDialog(page);
        check(
            (await page.getByTestId('book-import-tab-link').getAttribute('aria-selected')) === 'true',
            'link tab is selected by default',
        );
        check(
            (await page.getByTestId('book-import-tab-upload').getAttribute('aria-selected')) === 'false',
            'upload tab is not selected yet',
        );
        check(
            (await page.getByTestId('book-import-dialog').getAttribute('role')) === 'dialog',
            'dialog keeps role=dialog',
        );
        check(
            (await page.getByTestId('book-import-tabs').getAttribute('role')) === 'tablist',
            'Tabs renders role=tablist',
        );
        check(
            (await page.getByTestId('book-import-link-panel').getAttribute('role')) === 'tabpanel',
            'link panel is a tabpanel',
        );
        check(
            (await page.getByTestId('book-import-link-panel').getAttribute('aria-labelledby')) ===
                'book-import-tab-link',
            'link panel is labelled by its tab',
        );

        console.log('\n[1440] keyboard tabs');
        await page.getByTestId('book-import-tab-link').focus();
        await page.keyboard.press('ArrowRight');
        check(
            (await page.getByTestId('book-import-tab-upload').getAttribute('aria-selected')) === 'true',
            '→ moves selection to the upload tab',
        );
        check(
            (await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))) ===
                'book-import-tab-upload',
            '→ moves focus to the upload tab',
        );
        check(
            (await page.getByTestId('book-import-upload-panel').getAttribute('role')) === 'tabpanel',
            'upload panel appears as a tabpanel',
        );
        await page.keyboard.press('Home');
        check(
            (await page.getByTestId('book-import-tab-link').getAttribute('aria-selected')) === 'true',
            'Home returns to the first tab',
        );
        await page.keyboard.press('End');
        check(
            (await page.getByTestId('book-import-tab-upload').getAttribute('aria-selected')) ===
                'true',
            'End jumps to the last tab',
        );

        console.log('\n[1440] link tab regression');
        await page.getByTestId('book-import-tab-link').click();
        await page.getByTestId('book-import-url').fill('https://www.gutenberg.org/ebooks/1342');
        await page.getByTestId('book-import-preview-button').click();
        await page.getByTestId('book-import-preview').waitFor({ state: 'visible', timeout: 5000 });
        const linkPreviewText = await page.getByTestId('book-import-preview').innerText();
        check(
            state.linkPreviewCalls === 1 &&
                linkPreviewText.includes('Pride and Prejudice') &&
                linkPreviewText.includes('Gutenberg'),
            'link preview still renders the source + title',
            linkPreviewText.replace(/\n+/g, ' | '),
        );

        console.log('\n[1440] upload: pick → parsing → preview');
        await goToUploadTab(page);
        check(
            (await page.getByTestId('local-epub-dropzone').innerText()).includes('最大 30MB'),
            'drop zone shows the 30MB cap',
        );
        check(
            await page.getByTestId('local-epub-dropzone').isVisible(),
            'drop zone is clickable/visible',
        );
        state.previewDelay = 700;
        await pickFile(page, EPUB_FILE);
        await page.getByTestId('local-epub-progress').waitFor({ state: 'visible', timeout: 5000 });
        // Playwright's route interception hides XHR upload progress events, so
        // the mock test asserts the initial "uploading" phase; the "parsing"
        // phase is the same onPhase callback fed by xhr.upload.onload live.
        check(
            (await page.getByTestId('local-epub-progress').innerText()).includes('正在上传'),
            'upload progress is announced while the file is sent',
        );
        await page.getByTestId('local-epub-preview').waitFor({ state: 'visible', timeout: 8000 });
        check(
            (await page.getByTestId('local-epub-file-name').innerText()) === EPUB_NAME,
            'selected file name stays visible',
        );
        const previewText = await page.getByTestId('local-epub-preview').innerText();
        check(
            previewText.includes('Pride and Prejudice') &&
                previewText.includes('Jane Austen') &&
                previewText.includes('61 章') &&
                previewText.includes('2.2 MB') &&
                previewText.includes('仅自己可见'),
            'preview shows title / author / chapters / size / private hint',
            previewText.replace(/\n+/g, ' | '),
        );
        check(
            (await page.getByTestId('local-epub-cover').count()) === 1 &&
                (await page
                    .getByTestId('local-epub-cover')
                    .evaluate((img) => img.complete && img.naturalWidth > 0)),
            'preview renders the cover data URL',
        );
        check(
            !(await page.getByTestId('local-epub-rights').isChecked()),
            'rights declaration starts unchecked',
        );
        check(
            await page.getByTestId('local-epub-confirm').isDisabled(),
            'import is disabled before the rights declaration',
        );
        await dialogOverflow(page, '1440 upload preview has no horizontal overflow');
        await page.screenshot({ path: `${OUT_DIR}/1440-upload-preview.png` });

        console.log('\n[1440] upload: rights → import → shelf');
        await page.getByTestId('local-epub-rights').check();
        check(await page.getByTestId('local-epub-confirm').isEnabled(), 'import enables after consent');
        state.uploadDelay = 350;
        await page.getByTestId('local-epub-confirm').click();
        await page.waitForFunction(
            () =>
                document
                    .querySelector('[data-testid="local-epub-confirm"]')
                    ?.textContent?.includes('正在加入') ?? false,
            { timeout: 3000 },
        );
        check(true, 'import shows the adding state');
        await page.getByTestId('book-import-dialog').waitFor({ state: 'detached', timeout: 8000 });
        check(
            state.uploadCalls === 1 &&
                state.lastUploadBody.includes('name="uploadToken"') &&
                state.lastUploadBody.includes('tok-epub-1') &&
                /name="rightsAccepted"\r\n\r\ntrue/.test(state.lastUploadBody),
            'confirm sends uploadToken + rightsAccepted=true',
        );
        const localCard = page.getByTestId('imported-book-card-book-local-1');
        await localCard.waitFor({ state: 'visible', timeout: 8000 });
        check(
            (await localCard.innerText()).includes('本地'),
            'shelf card shows the 本地 source badge',
            (await localCard.innerText()).replace(/\n+/g, ' | '),
        );
        const shelfCover = localCard.getByTestId('imported-book-cover');
        await shelfCover.waitFor({ state: 'visible', timeout: 5000 });
        const shelfCoverLoaded = await shelfCover.evaluate(
            (img) => img.complete && img.naturalWidth > 0,
        );
        check(shelfCoverLoaded, 'shelf card renders the local cover');
        await page
            .getByTestId('toast')
            .filter({ hasText: '已加入我的书' })
            .waitFor({ state: 'visible', timeout: 4000 });
        check(
            (await page.getByTestId('toast').filter({ hasText: '已加入我的书' }).count()) >= 1,
            'success toast is emitted',
        );
        check(
            (await page.getByTestId('imported-book-card-book-gutenberg-1').innerText()).includes(
                'Gutenberg',
            ),
            'existing Gutenberg card keeps its source badge',
        );
        await page.screenshot({ path: `${OUT_DIR}/1440-shelf-local.png` });

        console.log('\n[1440] local reader badge');
        await page.getByTestId('imported-book-card-book-local-1').click();
        await page.getByTestId('imported-book-title').waitFor({ state: 'visible', timeout: 10000 });
        const readerText = await page.locator('body').innerText();
        check(
            readerText.includes('本地文件仅自己可见'),
            'reader shows the local-source hint instead of "live fetch"',
        );
        check(
            (await page.getByTestId('imported-book-source-link').count()) === 0,
            'reader hides the external source link for a local EPUB',
        );
        await page.goto(`${APP_URL}/#/app/content`, { waitUntil: 'domcontentloaded' });
        await page.getByTestId('books-section').waitFor({ state: 'visible', timeout: 20000 });
        await page.waitForTimeout(900);

        console.log('\n[1440] errors + retry + remove');
        await openImportDialog(page);
        await goToUploadTab(page);
        state.previewDelay = 0;
        state.previewMode = 'drm';
        await pickFile(page, EPUB_FILE);
        await page.getByTestId('book-import-error').waitFor({ state: 'visible', timeout: 5000 });
        check(
            (await page.getByTestId('book-import-error').innerText()).includes('DRM'),
            'DRM preview error is shown inline',
        );
        check(
            await page
                .getByTestId('book-import-error')
                .evaluate((node) => Boolean(node.closest('[role="alert"]'))),
            'error is rendered inside the Dialog alert region',
        );
        check(
            (await page.getByTestId('local-epub-file').innerText()).includes(EPUB_NAME),
            'failed preview keeps the selected file for retry',
        );
        check(
            await page.getByTestId('local-epub-confirm').isDisabled(),
            'failed preview cannot be imported',
        );
        state.previewMode = 'ok';
        await page.getByTestId('local-epub-retry').click();
        await page.getByTestId('local-epub-preview').waitFor({ state: 'visible', timeout: 8000 });
        check(
            await page.getByTestId('local-epub-preview').isVisible(),
            'retry parsing recovers the preview',
        );
        await page.getByTestId('local-epub-remove').click();
        check(
            (await page.getByTestId('local-epub-dropzone').count()) === 1,
            'remove restores the drop zone',
        );

        console.log('\n[1440] client-side validation');
        const previewCallsBeforeBadFiles = state.previewCalls;
        await pickFile(page, {
            name: 'notes.txt',
            mimeType: 'text/plain',
            buffer: Buffer.from('not an epub'),
        });
        await page.getByTestId('book-import-error').waitFor({ state: 'visible', timeout: 3000 });
        check(
            (await page.getByTestId('book-import-error').innerText()).includes('只支持 EPUB'),
            'non-EPUB files are rejected before upload',
        );
        check(
            state.previewCalls === previewCallsBeforeBadFiles,
            'non-EPUB never reaches the preview endpoint',
        );
        await page.getByTestId('local-epub-remove').click();
        await pickFile(page, {
            name: 'huge.epub',
            mimeType: 'application/epub+zip',
            buffer: Buffer.alloc(30 * 1024 * 1024 + 1),
        });
        await page.getByTestId('book-import-error').waitFor({ state: 'visible', timeout: 3000 });
        check(
            (await page.getByTestId('book-import-error').innerText()).includes('30MB'),
            'files over 30MB are rejected before upload',
        );
        check(
            state.previewCalls === previewCallsBeforeBadFiles,
            'oversized files never reach the preview endpoint',
        );
        await page.getByTestId('local-epub-remove').click();

        console.log('\n[1440] server 413 + cancel');
        state.previewMode = 'tooLarge';
        await pickFile(page, EPUB_FILE);
        await page.getByTestId('book-import-error').waitFor({ state: 'visible', timeout: 5000 });
        check(
            (await page.getByTestId('book-import-error').innerText()).includes('30MB'),
            'server 413 maps to the too-large copy',
        );
        await page.getByTestId('local-epub-cancel').click();
        await page.getByTestId('book-import-dialog').waitFor({ state: 'detached', timeout: 5000 });

        console.log('\n[1440] server error mapping');
        for (const [mode, expected] of [
            ['noChapters', '没有可阅读的章节'],
            ['unsupportedLanguage', '只支持英文'],
            ['corrupt', '损坏'],
            ['notEpub', '只支持 EPUB'],
            ['network', '网络连接失败'],
        ]) {
            state.previewMode = mode;
            await openImportDialog(page);
            await goToUploadTab(page);
            await pickFile(page, EPUB_FILE);
            await page.getByTestId('book-import-error').waitFor({ state: 'visible', timeout: 5000 });
            check(
                (await page.getByTestId('book-import-error').innerText()).includes(expected),
                `server "${mode}" maps to its localized error`,
            );
            await page.getByTestId('local-epub-cancel').click();
            await page
                .getByTestId('book-import-dialog')
                .waitFor({ state: 'detached', timeout: 5000 });
        }

        state.previewMode = 'ok';
        state.previewDelay = 1500;
        const uploadCallsBeforeCancel = state.uploadCalls;
        await openImportDialog(page);
        await goToUploadTab(page);
        await pickFile(page, EPUB_FILE);
        await page.getByTestId('local-epub-progress').waitFor({ state: 'visible', timeout: 5000 });
        await page.getByTestId('local-epub-cancel').click();
        await page.getByTestId('book-import-dialog').waitFor({ state: 'detached', timeout: 5000 });
        await sleep(1700);
        check(
            state.uploadCalls === uploadCallsBeforeCancel,
            'cancel during parsing aborts without importing',
        );
        check(
            (await page.getByTestId('book-import-dialog').count()) === 0,
            'cancel closes the dialog',
        );

        await context.close();
    }

    // ── 375: bottom sheet, both tabs, full import, no overflow ──────────────
    {
        const state = createState();
        const { context, page } = await newPage(browser, state, { width: 375, height: 812 });

        console.log('\n[375] dialog + upload flow');
        await openContent(page);
        await openImportDialog(page);
        await dialogOverflow(page, '375 link tab has no horizontal overflow');
        check(
            (await page.getByTestId('book-import-tab-link').boundingBox()) !== null &&
                (await page.getByTestId('book-import-tab-upload').boundingBox()) !== null,
            'both tabs are visible at 375',
        );
        await goToUploadTab(page);
        await dialogOverflow(page, '375 upload tab has no horizontal overflow');
        check(
            (await page.getByTestId('local-epub-dropzone').innerText()).includes('最大 30MB'),
            '375 drop zone keeps the size hint',
        );
        await page.screenshot({ path: `${OUT_DIR}/375-upload-empty.png` });
        await pickFile(page, EPUB_FILE);
        await page.getByTestId('local-epub-preview').waitFor({ state: 'visible', timeout: 8000 });
        await dialogOverflow(page, '375 preview has no horizontal overflow');
        await page.getByTestId('local-epub-rights').check();
        await page.screenshot({ path: `${OUT_DIR}/375-upload-preview.png` });
        await page.getByTestId('local-epub-confirm').click();
        await page.getByTestId('book-import-dialog').waitFor({ state: 'detached', timeout: 8000 });
        await page
            .getByTestId('imported-book-card-book-local-1')
            .waitFor({ state: 'visible', timeout: 8000 });
        await page.getByTestId('imported-book-card-book-local-1').scrollIntoViewIfNeeded();
        check(
            (await page.getByTestId('imported-book-card-book-local-1').innerText()).includes('本地'),
            '375 import lands on the shelf with the local badge',
        );
        const docOverflow = await page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
        );
        check(docOverflow <= 1, '375 page has no horizontal overflow after import', String(docOverflow));
        await page.screenshot({ path: `${OUT_DIR}/375-shelf-local.png` });

        await context.close();
    }

    // ── vi-VN: no CJK leaks in the new surface ─────────────────────────────
    {
        const state = createState('vi-VN');
        const { context, page } = await newPage(browser, state, { width: 1440, height: 900 });

        console.log('\n[vi-VN] dialog copy');
        await openContent(page);
        await openImportDialog(page);
        const dialogText = await page.getByTestId('book-import-dialog').innerText();
        check(dialogText.includes('Nhập sách'), 'vi-VN dialog title is translated');
        check(
            dialogText.includes('Liên kết sách công cộng') &&
                dialogText.includes('Tải lên EPUB'),
            'vi-VN tab labels are translated',
        );
        check(!/[\u4e00-\u9fff]/.test(dialogText), 'vi-VN dialog has no Chinese characters');
        await goToUploadTab(page);
        const uploadText = await page.getByTestId('book-import-upload-panel').innerText();
        check(
            uploadText.includes('Kéo tệp EPUB vào đây') &&
                uploadText.includes('Tối đa 30MB') &&
                uploadText.includes('không có DRM'),
            'vi-VN drop zone + rights hint are translated',
        );
        await page.screenshot({ path: `${OUT_DIR}/1440-vi-upload.png` });
        await context.close();
    }

    await browser.close();
    console.log(
        `\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${checks} checks, ${failures.length} failure(s)`,
    );
    if (failures.length > 0) {
        console.error(`Failures:\n- ${failures.join('\n- ')}`);
        process.exit(1);
    }
})();
