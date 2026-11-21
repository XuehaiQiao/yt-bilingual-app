// PWA runtime helpers: service-worker registration, online state and the
// deferred `beforeinstallprompt` event.
//
// Registration runs in both production and Vite dev. Append `?dev` (or
// `?no-sw`) to the page URL to skip it while iterating on the app; the dev
// worker itself runs in network-first mode so edited modules are never stale,
// and only falls back to its cache when offline.
import { useCallback, useEffect, useState } from 'react';

// Install entry timing: the browser install button is useful only after the
// learner has come back a couple of times (report 1.3.3). Counting happens
// once per page load, not per rendered route, so SPA navigation cannot inflate
// it. localStorage is also what makes "third visit" survive a restart.
export const VISIT_COUNT_KEY = 'yt_bilingual_visit_count';
export const INSTALL_MIN_VISITS = 3;

function readVisitCount(): number {
  try {
    const raw = window.localStorage.getItem(VISIT_COUNT_KEY);
    const parsed = raw === null ? 0 : Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    // Private mode / storage disabled: no history to count, so no install
    // prompt (the rest of the app keeps working).
    return 0;
  }
}

/** Count one page load and return the new total. */
export function recordAppVisit(): number {
  const next = readVisitCount() + 1;
  try {
    window.localStorage.setItem(VISIT_COUNT_KEY, String(next));
  } catch {
    // Storage unavailable: return the in-memory count for this load only.
  }
  return next;
}

/** Total page loads recorded on this browser (0 when storage is blocked). */
export function getAppVisitCount(): number {
  return readVisitCount();
}

/** Install entry is offered from the third recorded visit onwards. */
export function canOfferInstall(): boolean {
  return getAppVisitCount() >= INSTALL_MIN_VISITS;
}

export interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>;
  prompt: () => Promise<void>;
}

type InstallPromptListener = (event: BeforeInstallPromptEvent | null) => void;

// Capture the event at module load: Chrome can fire it before React mounts,
// and a `useEffect` listener would miss it. `preventDefault()` keeps the
// browser's own mini-infobar out of the way so the app can show its button.
let capturedInstallPrompt: BeforeInstallPromptEvent | null = null;
const installPromptListeners = new Set<InstallPromptListener>();

function emitInstallPrompt(): void {
  for (const listener of installPromptListeners) listener(capturedInstallPrompt);
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    capturedInstallPrompt = event as BeforeInstallPromptEvent;
    emitInstallPrompt();
  });
  window.addEventListener('appinstalled', () => {
    capturedInstallPrompt = null;
    emitInstallPrompt();
  });
}

export function getCapturedInstallPrompt(): BeforeInstallPromptEvent | null {
  return capturedInstallPrompt;
}

export function subscribeInstallPrompt(listener: InstallPromptListener): () => void {
  installPromptListeners.add(listener);
  return () => {
    installPromptListeners.delete(listener);
  };
}

export function takeCapturedInstallPrompt(): BeforeInstallPromptEvent | null {
  const event = capturedInstallPrompt;
  capturedInstallPrompt = null;
  emitInstallPrompt();
  return event;
}

/** Add the URLs already used by this page to the worker's runtime cache. */
function cacheLoadedAssets(registration: ServiceWorkerRegistration): void {
  const worker = registration.active;
  if (!worker) return;

  const urls: string[] = [];
  for (const entry of performance.getEntriesByType('resource')) {
    const name = (entry as PerformanceResourceTiming).name;
    try {
      const url = new URL(name);
      if (url.origin !== window.location.origin) continue;
      if (url.pathname === '/api' || url.pathname.startsWith('/api/')) continue;
      if (url.pathname === '/sw.js') continue;
      if (/\.(?:srt|vtt|ass|ssa|mp4|m4v|webm|mov|mp3|wav|m4a|aac|flac|ogg)$/i.test(url.pathname)) continue;
      urls.push(url.href);
    } catch {
      // Ignore malformed entries (blob:, data:, …).
    }
  }

  worker.postMessage({ type: 'CACHE_URLS', urls });
}

export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;

  const params = new URLSearchParams(window.location.search);
  if (params.has('dev') || params.has('no-sw')) {
    if (import.meta.env.DEV) console.info('[pwa] service worker skipped (?dev / ?no-sw)');
    return;
  }

  const register = async () => {
    try {
      const swUrl = import.meta.env.DEV ? '/sw.js?mode=dev' : '/sw.js';
      const registration = await navigator.serviceWorker.register(swUrl, { scope: '/' });
      if (import.meta.env.DEV) console.info('[pwa] service worker registered:', registration.scope);

      await navigator.serviceWorker.ready;
      cacheLoadedAssets(registration);
      // Late-loaded chunks / dev-transformed modules may finish right after
      // `load`; a second pass makes the first offline reload self-contained.
      window.setTimeout(() => cacheLoadedAssets(registration), 1500);
    } catch (error) {
      // The web app must keep working when a browser or context refuses SWs
      // (private mode, HTTP origin, enterprise policy…).
      console.warn('[pwa] service worker registration failed:', error);
    }
  };

  if (document.readyState === 'complete') {
    void register();
  } else {
    window.addEventListener('load', () => void register(), { once: true });
  }
}

export function useOnlineStatus(): boolean {
  const [online, setOnline] = useState<boolean>(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  );

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    update();
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  return online;
}

function detectIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  if (/iphone|ipad|ipod/i.test(navigator.userAgent)) return true;
  // iPadOS 13+ reports a desktop Safari UA.
  return navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
}

function detectStandalone(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  return (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

export interface InstallPromptState {
  /** A real Chrome/Edge install prompt is waiting for a user gesture. */
  canInstall: boolean;
  /** iOS never fires `beforeinstallprompt`; show manual Safari steps. */
  isIos: boolean;
  /** Already running as an installed app: hide every install affordance. */
  isStandalone: boolean;
  promptInstall: () => Promise<'accepted' | 'dismissed' | 'unavailable'>;
}

export function useInstallPrompt(): InstallPromptState {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(
    () => getCapturedInstallPrompt(),
  );
  const [isIos] = useState(detectIos);
  const [isStandalone, setIsStandalone] = useState(detectStandalone);

  useEffect(() => subscribeInstallPrompt(setDeferredPrompt), []);

  useEffect(() => {
    const media = window.matchMedia?.('(display-mode: standalone)');
    if (!media) return;
    const update = () => setIsStandalone(detectStandalone());
    media.addEventListener?.('change', update);
    return () => media.removeEventListener?.('change', update);
  }, []);

  const promptInstall = useCallback(async (): Promise<'accepted' | 'dismissed' | 'unavailable'> => {
    const event = takeCapturedInstallPrompt();
    if (!event) return 'unavailable';
    try {
      await event.prompt();
      const choice = await event.userChoice;
      return choice.outcome === 'accepted' ? 'accepted' : 'dismissed';
    } catch {
      return 'unavailable';
    }
  }, []);

  return { canInstall: deferredPrompt !== null, isIos, isStandalone, promptInstall };
}
