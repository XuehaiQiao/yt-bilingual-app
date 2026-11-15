/* 语途 (LinguaTrek) service worker — installable app shell + offline fallback.
 *
 * Strategy (spec: user request #12, mobile step 1):
 *   - navigations: network-first, fall back to the cached index.html shell;
 *   - same-origin static assets: cache-first (network-first in Vite dev so
 *     edited modules are never served stale while `npm run dev` is running);
 *   - /api/** and cross-origin requests: never intercepted, never cached.
 *     User content / subtitles / history must stay in the backend only.
 *
 * The page registers `/sw.js` and, after activation, posts the URLs it already
 * loaded (`CACHE_URLS`) so the very first reload can be offline even though
 * the first paint happened before this worker took control.
 *
 * Bump CACHE_VERSION when the strategy changes; activate removes every older
 * cache that starts with CACHE_PREFIX.
 */
const CACHE_PREFIX = 'linguatrek-pwa-';
const CACHE_VERSION = 'v1';
const SHELL_CACHE = `${CACHE_PREFIX}shell-${CACHE_VERSION}`;
const RUNTIME_CACHE = `${CACHE_PREFIX}runtime-${CACHE_VERSION}`;
const INDEX_URL = '/index.html';

const IS_DEV = new URL(self.location.href).searchParams.get('mode') === 'dev';

const CORE_ASSETS = [
  '/',
  INDEX_URL,
  '/manifest.webmanifest',
  '/pwa-192.png',
  '/pwa-512.png',
  '/pwa-maskable-512.png',
  '/apple-touch-icon.png',
  '/hero_icon.png',
];

// Only these destinations are cached. `document`, `audio`, `video`, `track`
// and empty destinations (XHR/fetch) are deliberately excluded so the worker
// can never retain private study data or media.
const STATIC_DESTINATIONS = new Set(['script', 'style', 'image', 'font', 'manifest', 'worker']);
const STATIC_EXTENSION = /\.(?:js|mjs|css|woff2?|ttf|otf|eot|png|jpe?g|webp|gif|svg|ico|json|webmanifest)$/i;

const OFFLINE_HTML = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#09090b" />
    <title>语途 · 当前离线</title>
    <style>
      html, body { height: 100%; margin: 0; }
      body { display: grid; place-items: center; background: #09090b; color: #f4f4f5;
             font: 15px/1.6 -apple-system, BlinkMacSystemFont, "PingFang SC", system-ui, sans-serif; }
      main { text-align: center; padding: 24px; }
      h1 { font-size: 20px; font-weight: 600; margin: 0 0 8px; }
      p { color: #a1a1aa; margin: 0; font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <h1>语途</h1>
      <p>当前离线。联网后会恢复正常。</p>
    </main>
  </body>
</html>`;

function cacheableUrl(raw) {
  let url;
  try {
    url = new URL(raw, self.location.origin);
  } catch {
    return false;
  }
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (url.pathname === '/sw.js') return false;
  if (/\/(?:history|subtitles)\//.test(url.pathname)) return false;
  if (/\.(?:srt|vtt|ass|ssa|mp4|m4v|webm|mov|mp3|wav|m4a|aac|flac|ogg)$/i.test(url.pathname)) return false;
  return true;
}

function isStaticRequest(request) {
  if (request.method !== 'GET') return false;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return false;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return false;
  if (request.destination) return STATIC_DESTINATIONS.has(request.destination);
  // Older browsers / programmatic requests leave `destination` empty; only
  // cache URLs that are unambiguously build/static assets.
  return STATIC_EXTENSION.test(url.pathname);
}

async function fetchAndStore(cache, url) {
  try {
    const existing = await cache.match(url);
    if (existing) return;
    const response = await fetch(url, { cache: 'reload' });
    if (response.ok && response.type === 'basic') await cache.put(url, response);
  } catch {
    // A missing optional asset must never fail the whole install.
  }
}

async function precacheShell() {
  const shell = await caches.open(SHELL_CACHE);
  await Promise.all(CORE_ASSETS.map((url) => fetchAndStore(shell, url)));

  // The hashed JS/CSS names are decided by Vite at build time, so read them
  // from the built index.html instead of hardcoding them in this file.
  let indexResponse = null;
  try {
    indexResponse = await fetch(INDEX_URL, { cache: 'reload' });
  } catch {
    return;
  }
  if (!indexResponse.ok) return;

  const html = await indexResponse.text();
  try {
    await shell.put(INDEX_URL, new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }));
  } catch {
    // Cache quota errors are non-fatal; runtime caching may still succeed.
  }

  const discovered = new Set();
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const candidate = match[1];
    if (!cacheableUrl(candidate)) continue;
    const url = new URL(candidate, self.location.origin);
    if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/src/') || STATIC_EXTENSION.test(url.pathname)) {
      discovered.add(url.href);
    }
  }
  await Promise.all([...discovered].map((url) => fetchAndStore(shell, url)));
}

async function cacheLoadedUrls(cacheName, urls) {
  const cache = await caches.open(cacheName);
  const unique = [...new Set(urls)]
    .filter((url) => typeof url === 'string' && cacheableUrl(url))
    .slice(0, 250);
  await Promise.all(unique.map(async (url) => {
    try {
      const existing = await cache.match(url);
      if (existing) return;
      const response = await fetch(url, { cache: 'no-store' });
      if (response.ok && response.type === 'basic') await cache.put(url, response);
    } catch {
      // Best-effort only; the page is already usable.
    }
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    await precacheShell();
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== SHELL_CACHE && key !== RUNTIME_CACHE)
        .map((key) => caches.delete(key)),
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.type !== 'CACHE_URLS' || !Array.isArray(data.urls)) return;
  event.waitUntil(cacheLoadedUrls(RUNTIME_CACHE, data.urls));
});

async function networkFirstNavigation(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const shell = await caches.open(SHELL_CACHE);
        await shell.put(INDEX_URL, response.clone());
      } catch {
        // Storage full: still return the live response.
      }
    }
    return response;
  } catch {
    const shell = await caches.open(SHELL_CACHE);
    const cached = (await shell.match(INDEX_URL)) || (await shell.match('/'));
    if (cached) return cached;
    return new Response(OFFLINE_HTML, {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
}

// Cache API matching honours `Vary` by default. Vite's dev server varies some
// module responses by `Origin`, while the page's asset-caching pass fetches
// without that header — matching strictly would miss our own cache offline.
// Static build assets are immutable, so ignoring `Vary` here is safe.
async function matchCached(request) {
  const cached = await caches.match(request, { ignoreVary: true });
  if (cached) return cached;
  // Older Chromium ignores `ignoreVary` for Request objects; retry by URL.
  return caches.match(request.url, { ignoreVary: true });
}

async function networkFirstAsset(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      try {
        const cache = await caches.open(RUNTIME_CACHE);
        await cache.put(request, response.clone());
      } catch {
        // Storage full; serve the network response.
      }
    }
    return response;
  } catch {
    const cached = await matchCached(request);
    if (cached) return cached;
    throw new Error('offline and not cached');
  }
}

async function cacheFirstAsset(request) {
  const cached = await matchCached(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) {
    try {
      const cache = await caches.open(RUNTIME_CACHE);
      await cache.put(request, response.clone());
    } catch {
      // Storage full; serve the network response.
    }
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  if (request.headers.has('range')) return;

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (!isStaticRequest(request)) return;

  if (IS_DEV) {
    event.respondWith(networkFirstAsset(request));
  } else {
    event.respondWith(cacheFirstAsset(request));
  }
});
