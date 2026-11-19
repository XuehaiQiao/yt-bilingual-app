// React binding for the hash navigation model
// (docs/design-governance/navigation-model.md §3 / §12.3).
//
// One state, one history policy:
//   go(tab)        → replaceState   (tab switches never pile up history)
//   open(sub)      → pushState      (any forward move: tab → sub, sub → sub,
//                                    list → detail, source → target; D-02)
//   replace(state) → replaceState   (same-screen params / environment loss)
//   openAnchor()   → replaceState   (`#/app/content/library|books`; D-05)
//   back()         → history.back() when this entry has an in-app frame
//                    beneath it (history.state.dshNav.depth > 0), otherwise
//                    replace to `parentOf(state)` so a deep link never leaves
//                    the app (D-02/N-03).
//
// `history.length` is deliberately NOT consulted: it counts cross-site entries
// and made deep links look backable (the root cause of N-03). Every pushState
// carries `{ dshNav: { depth } }`; popstate reads it back.
//
// `popstate` and `hashchange` both feed the same resolver. They can fire for one
// browser-back gesture, so the handlers are idempotent: the second one sees the
// hash already committed and does nothing.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  isPublicHash,
  parentOf,
  resolveRoute,
  sameRoute,
  toHash,
  type NavState,
  type SectionAnchor,
  type SubRoute,
  type TabId,
} from './nav';
import { t } from '../i18n';
import { toast } from './toast';

export interface NavApi {
  state: NavState;
  /** Current in-app history depth (0 for a deep link / refresh entry). */
  depth: number;
  /** Switch first-level tab (replace; clears any sub view / anchor). */
  go: (tab: TabId) => void;
  /** Open a sub view on top of the current screen (push). */
  open: (sub: SubRoute) => void;
  /** Replace the current entry without adding history. */
  replace: (state: NavState) => void;
  /** Jump to a content-page section anchor (replace; D-05). */
  openAnchor: (anchor: SectionAnchor) => void;
  /** Close the current sub view: pop one frame or fall back to the parent. */
  back: () => void;
  /** Return to today. */
  goHome: () => void;
}

const NAV_STATE_KEY = 'dshNav';

interface NavHistoryState {
  [NAV_STATE_KEY]?: { depth?: unknown };
}

function readHash(): string {
  return window.location.hash;
}

function readDepth(state: unknown): number {
  const raw = (state as NavHistoryState | null)?.[NAV_STATE_KEY]?.depth;
  return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.trunc(raw) : 0;
}

function marker(depth: number): NavHistoryState {
  return { [NAV_STATE_KEY]: { depth } };
}

export function useNav(): NavApi {
  const [state, setState] = useState<NavState>(() => resolveRoute(readHash()).state);
  const [depth, setDepth] = useState<number>(() => readDepth(window.history.state));
  const stateRef = useRef(state);
  const hashRef = useRef(toHash(state));
  const depthRef = useRef(depth);
  const initialisedRef = useRef(false);
  // One toast per bad link, not per popstate/hashchange pair (D-07).
  const invalidNotifiedRef = useRef<Set<string>>(new Set());

  const notifyInvalid = useCallback((raw: string) => {
    const key = raw || '(blank)';
    if (invalidNotifiedRef.current.has(key)) return;
    invalidNotifiedRef.current.add(key);
    toast.info(t('nav.notFound'));
  }, []);

  const commit = useCallback((next: NavState, mode: 'push' | 'replace') => {
    const hash = toHash(next);
    if (mode === 'push') {
      // Never push a duplicate frame (navigation-model §3.3).
      if (hash === hashRef.current) {
        stateRef.current = next;
        setState(next);
        return;
      }
      depthRef.current += 1;
      window.history.pushState(marker(depthRef.current), '', hash);
    } else {
      // A tab root restarts the in-app stack; same-screen params keep it.
      if (!next.sub && !next.anchor) depthRef.current = 0;
      window.history.replaceState(marker(depthRef.current), '', hash);
    }
    hashRef.current = hash;
    stateRef.current = next;
    setDepth(depthRef.current);
    setState(next);
  }, []);

  // First mount: canonicalise whatever the address bar already held. An app
  // URL is already `#/app/...`; a legacy alias is rewritten once; an invalid
  // hash falls back to `#/app/today` with one toast. A reload keeps its in-app
  // depth marker; a fresh deep link has no marker and starts at depth 0.
  // Public hashes never mount AppContent, but guard anyway so a stale mount
  // cannot rewrite the public URL into the app namespace.
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    const raw = readHash();
    if (isPublicHash(raw)) return;
    const resolved = resolveRoute(raw);
    const initialDepth = readDepth(window.history.state);
    window.history.replaceState(marker(initialDepth), '', resolved.canonical);
    hashRef.current = resolved.canonical;
    depthRef.current = initialDepth;
    stateRef.current = resolved.state;
    // The URL is an external store: reading it once on mount is the
    // synchronise-with-an-external-system case, not derived state.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot URL sync on mount
    setDepth(initialDepth);
    setState(resolved.state);
    if (resolved.kind === 'invalid') notifyInvalid(raw);
  }, [notifyInvalid]);

  useEffect(() => {
    const syncTo = (raw: string, resolved: ReturnType<typeof resolveRoute>, nextDepth: number) => {
      if (resolved.canonical !== raw) {
        // Aliases and unknown parameters are normalised in place, keeping the
        // frame depth we resolved for this entry.
        window.history.replaceState(marker(nextDepth), '', resolved.canonical);
      }
      hashRef.current = resolved.canonical;
      depthRef.current = nextDepth;
      stateRef.current = resolved.state;
      setDepth(nextDepth);
      setState(resolved.state);
      if (resolved.kind === 'invalid') notifyInvalid(raw);
    };

    const onPopState = (event: PopStateEvent) => {
      const raw = readHash();
      // Public pages (`#/blog`, `#/login`, `#/welcome`, `/` …) are outside the
      // app nav model: App's own public-view listener owns them.
      if (isPublicHash(raw)) return;
      const resolved = resolveRoute(raw);
      // A frame pushed by us carries its depth; an external/older entry has no
      // marker and is treated as a new entry (depth 0 → parent fallback).
      syncTo(raw, resolved, readDepth(event.state));
    };

    const onHashChange = () => {
      const raw = readHash();
      if (isPublicHash(raw)) return;
      const resolved = resolveRoute(raw);
      // `popstate` may already have handled this gesture; our own
      // canonicalisation never fires hashchange. Anything left is a hand-edited
      // address or a link → an external entry.
      if (resolved.canonical === hashRef.current) return;
      syncTo(raw, resolved, 0);
    };

    window.addEventListener('popstate', onPopState);
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [notifyInvalid]);

  const go = useCallback((tab: TabId) => {
    commit({ tab, sub: null }, 'replace');
  }, [commit]);

  const open = useCallback((sub: SubRoute) => {
    const current = stateRef.current;
    // `#/app/<source tab>/...`: the source is wherever the learner is now.
    const next: NavState = { tab: sub.kind === 'admin' ? 'profile' : current.tab, sub };
    if (sameRoute(current, next)) return;
    commit(next, 'push');
  }, [commit]);

  const replace = useCallback((next: NavState) => {
    commit(next, 'replace');
  }, [commit]);

  const openAnchor = useCallback((anchor: SectionAnchor) => {
    commit({ tab: 'content', sub: null, anchor }, 'replace');
  }, [commit]);

  const back = useCallback(() => {
    const current = stateRef.current;
    if (depthRef.current > 0) {
      // `popstate` syncs the state from the frame we are going back to.
      window.history.back();
      return;
    }
    const parent = parentOf(current);
    if (parent) commit(parent, 'replace');
  }, [commit]);

  const goHome = useCallback(() => {
    commit({ tab: 'today', sub: null }, 'replace');
  }, [commit]);

  return { state, depth, go, open, replace, openAnchor, back, goHome };
}
