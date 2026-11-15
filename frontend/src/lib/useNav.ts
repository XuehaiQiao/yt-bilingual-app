// React binding for the hash navigation model (docs/信息架构-导航重构.md §7.1).
//
// One state, one history policy:
//   go(tab)   → replaceState  (tab switches never pile up browser history)
//   open(sub) → pushState     (a sub view is a place you can go back from)
//   back()    → history.back() when this entry was pushed by us, otherwise
//               replaceState to the owning tab (deep link / refresh case)
//   replace() → replaceState  (in-screen switches such as sentence packs)
//
// `popstate` and `hashchange` both feed parseRoute, so the browser back
// button, Android hardware back, and a hand-edited hash all behave the same.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  parseRoute,
  tabForSub,
  tabOfSub,
  toHash,
  type NavState,
  type SubRoute,
  type TabId,
} from './nav';

export interface NavApi {
  state: NavState;
  /** Switch first-level tab (replace; clears any sub view). */
  go: (tab: TabId) => void;
  /** Open a sub view from the current tab (push). */
  open: (sub: SubRoute) => void;
  /** Replace the current entry without adding history (in-screen switches). */
  replace: (state: NavState) => void;
  /** Close the current sub view. */
  back: () => void;
  /** Return to today. */
  goHome: () => void;
}

const NAV_HISTORY_MARK = 'dshNav';

function readHash(): string {
  return window.location.hash;
}

export function useNav(): NavApi {
  const [state, setState] = useState<NavState>(() => parseRoute(readHash()));
  const stateRef = useRef(state);
  useEffect(() => {
    stateRef.current = state;
  }, [state]);
  // True only while the current history entry was pushed by `open`, i.e. the
  // entry beneath it is an in-app tab page. A deep-link/refresh entry has no
  // such guarantee, so `back()` replaces instead of leaving the app.
  const canGoBackRef = useRef(false);
  const initialisedRef = useRef(false);

  const commit = useCallback((next: NavState, mode: 'push' | 'replace') => {
    const hash = toHash(next);
    if (mode === 'push') {
      window.history.pushState({ [NAV_HISTORY_MARK]: 'sub' }, '', hash);
      canGoBackRef.current = true;
    } else {
      window.history.replaceState(
        { [NAV_HISTORY_MARK]: next.sub ? 'sub' : 'tab' },
        '',
        hash,
      );
      if (!next.sub) canGoBackRef.current = false;
    }
    setState(next);
  }, []);

  // First mount: canonicalise whatever the address bar already held. An empty
  // hash becomes `#/today`; an invalid hash is replaced by `#/today`; an old
  // `#admin` deep link becomes `#/profile/admin` (App then decides access).
  useEffect(() => {
    if (initialisedRef.current) return;
    initialisedRef.current = true;
    const raw = readHash();
    const parsed = parseRoute(raw);
    const canonical = toHash(parsed);
    if (raw !== canonical) {
      window.history.replaceState(
        { [NAV_HISTORY_MARK]: parsed.sub ? 'sub' : 'tab' },
        '',
        canonical,
      );
    } else {
      window.history.replaceState(
        { [NAV_HISTORY_MARK]: parsed.sub ? 'sub' : 'tab' },
        '',
        raw,
      );
    }
    // A deep link is a single entry: no in-app entry beneath it.
    canGoBackRef.current = false;
    // The URL is an external store: reading it once on mount is exactly the
    // "synchronise with an external system" case, just with a synchronous
    // first read instead of a subscription.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setState(parsed);
  }, []);

  useEffect(() => {
    const syncFromLocation = () => {
      const raw = readHash();
      const parsed = parseRoute(raw);
      const canonical = toHash(parsed);
      // A hand-edited / stale hash (`#/nonsense`, the `#admin` alias, a
      // `#/content/library` section anchor) is normalised in place: the app
      // shows the fallback screen and the address bar stops lying about it.
      if (raw !== canonical) {
        window.history.replaceState(
          { [NAV_HISTORY_MARK]: parsed.sub ? 'sub' : 'tab' },
          '',
          canonical,
        );
      }
      canGoBackRef.current = Boolean(parsed.sub) && window.history.length > 1;
      setState(parsed);
    };
    window.addEventListener('popstate', syncFromLocation);
    window.addEventListener('hashchange', syncFromLocation);
    return () => {
      window.removeEventListener('popstate', syncFromLocation);
      window.removeEventListener('hashchange', syncFromLocation);
    };
  }, []);

  const go = useCallback((tab: TabId) => {
    commit({ tab, sub: null }, 'replace');
  }, [commit]);

  const open = useCallback((sub: SubRoute) => {
    const current = stateRef.current;
    commit({ tab: tabForSub(sub, current.tab), sub }, 'push');
  }, [commit]);

  const replace = useCallback((next: NavState) => {
    commit(next, 'replace');
  }, [commit]);

  const back = useCallback(() => {
    const current = stateRef.current;
    if (!current.sub) return;
    if (canGoBackRef.current) {
      // `popstate` will sync state from the hash we are going back to.
      window.history.back();
      return;
    }
    commit({ tab: tabOfSub(current.sub, current.tab), sub: null }, 'replace');
  }, [commit]);

  const goHome = useCallback(() => {
    commit({ tab: 'today', sub: null }, 'replace');
  }, [commit]);

  return { state, go, open, replace, back, goHome };
}
