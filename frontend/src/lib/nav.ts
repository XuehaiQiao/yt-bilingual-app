// Navigation state model for the P0 IA, revised by
// docs/design-governance/navigation-model.md (D-01/D-02/D-05/D-09).
//
// Pure functions only — no React, no DOM. `parseRoute` / `toHash` are the two
// halves of one contract: `parseRoute(toHash(state))` returns `state` for every
// legal nav state (see `resolveRoute` for the raw → canonical decision that
// also tells `useNav` whether to rewrite a legacy URL or toast an invalid one).
//
// Route table (canonical hrefs, URL always starts with the source tab):
//   #/today  #/content  #/practice  #/profile            first-level tabs
//   #/content/library  #/content/books                   section anchors (D-05)
//   #/<tab>/review        #/<tab>/report                  review / weekly report
//   #/<tab>/placement[?view=profile]                      placement / profile
//   #/<tab>/exam                                          exam practice
//   #/<tab>/discover                                      content discovery
//   #/<tab>/reader[/<articleId>]                          reading
//   #/<tab>/sentences/<levelId>                           sentence packs
//   #/<tab>/blog[/<slug>]                                 official blog
//   #/<tab>/book/<bookId>                                 public-domain book reader
//   #/<tab>/book-series/<seriesId>                        public-domain series page
//   #/<tab>/imported-book/<bookId>                        imported book reader
//   #/<tab>/learn/youtube/<videoId>                       learning view (YouTube)
//   #/<tab>/learn/local/<showId>/S<ss>E<ee>               learning view (local episode)
//   #/<tab>/learn/library/<itemId>                        learning view (free library)
//   #/<tab>/lesson/<lessonId>                             12-minute course
//   #/<tab>/vocabulary                                    word book (单词本)
//   #/<tab>/ability                                       ability profile
//   #/profile/admin                                       admin console (fixed, D-10)
//   #/dev/ui                                              component matrix (dev/admin only;
//                                                          not part of NavState — see
//                                                          `isDevUiHash` below)
//
// `<tab>` is the *source* tab (where the learner came from), not an ownership
// claim: the same screen opened from Today and from Content keeps different
// first segments so "back" lands where the learner came from (N-02/N-04/N-12).
//
// Legacy URLs (still readable, rewritten once by `useNav`):
//   #/learn/...          → #/content/learn/...
//   #/lesson/<id>        → #/today/lesson/<id>
//   #/profile/favorites  → #/profile/vocabulary
//   #admin / #/admin     → #/profile/admin
//   #/<tab>/admin (≠profile) → #/profile/admin
//
// Invalid hashes fall back to `#/today` (D-07: the caller toasts once).
import type { TranslationKey } from '../i18n';

export type TabId = 'today' | 'content' | 'practice' | 'profile';

export const TAB_IDS: readonly TabId[] = ['content', 'practice', 'today', 'profile'];

export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
}

/** A tab-level section that owns its own URL (D-05). */
export type SectionAnchor = 'library' | 'books' | 'sentence-packs';

export const SECTION_ANCHORS: readonly SectionAnchor[] = ['library', 'books', 'sentence-packs'];

export function isSectionAnchor(value: unknown): value is SectionAnchor {
  return typeof value === 'string' && (SECTION_ANCHORS as readonly string[]).includes(value);
}

export type LearnSource = 'youtube' | 'local' | 'library';

export type SubRoute =
  | {
    kind: 'learn';
    source: LearnSource;
    videoId?: string;
    showId?: string;
    season?: number;
    episode?: number;
    itemId?: string;
  }
  | { kind: 'review' }
  | { kind: 'report' }
  | { kind: 'placement'; view: 'intro' | 'profile' }
  | { kind: 'exam' }
  | { kind: 'discover' }
  | { kind: 'reader'; articleId?: string }
  | { kind: 'sentences'; levelId: number }
  | { kind: 'blog'; slug?: string }
  | { kind: 'book'; bookId: string }
  | { kind: 'book-series'; seriesId: string }
  | { kind: 'imported-book'; bookId: string }
  | { kind: 'vocabulary' }
  | { kind: 'ability' }
  | { kind: 'admin' }
  | { kind: 'course'; lessonId: string };

export interface NavState {
  /** Source/return tab (the first URL segment). Not an ownership claim. */
  tab: TabId;
  sub: SubRoute | null;
  /** Tab-level section anchor; mutually exclusive with `sub`. */
  anchor?: SectionAnchor;
}

/**
 * Immersive ("task") sub views hide the desktop Sidebar and the primary tabs;
 * panel-style views (report/discover/blog/wordbook/ability) keep the shell.
 * Single source for `App.tsx` and the QA scripts (navigation-model §12.1).
 */
export const TASK_SUB_KINDS: ReadonlySet<SubRoute['kind']> = new Set<SubRoute['kind']>([
  'learn',
  'reader',
  'book',
  'book-series',
  'imported-book',
  'sentences',
  'review',
  'exam',
  'placement',
  'course',
]);

const FALLBACK: NavState = { tab: 'today', sub: null };

const FALLBACK_HASH = '#/today';

function decode(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

function parseSeasonEpisode(value: string | undefined): { season: number; episode: number } | null {
  if (!value) return null;
  const match = value.match(/^S(\d{1,3})E(\d{1,4})$/i);
  if (!match) return null;
  return { season: Number.parseInt(match[1], 10), episode: Number.parseInt(match[2], 10) };
}

export function padSeason(value: number | undefined): string {
  const safe = Number.isFinite(value) ? Math.max(0, Math.trunc(value as number)) : 0;
  return safe.toString().padStart(2, '0');
}

/**
 * Which tab a sub view belongs to when the URL carries no tab prefix (legacy
 * `#/learn`, `#/lesson`) or when the caller has no valid current tab.
 * Not used for new navigation: canonical URLs always carry the source tab.
 */
export function tabOfSub(sub: SubRoute, fallback: TabId = 'today'): TabId {
  switch (sub.kind) {
    case 'learn':
      return 'content';
    case 'review':
      return fallback === 'today' || fallback === 'practice' ? fallback : 'practice';
    case 'report':
      return fallback === 'today' || fallback === 'profile' ? fallback : 'today';
    case 'placement':
    case 'exam':
      return 'practice';
    case 'discover':
    case 'reader':
    case 'sentences':
    case 'blog':
    case 'book':
    case 'book-series':
    case 'imported-book':
      return 'content';
    case 'vocabulary':
    case 'ability':
    case 'admin':
      return 'profile';
    case 'course':
      return 'today';
    default:
      return 'today';
  }
}

/**
 * The tab a sub view is opened under. D-01/D-02: this is always the current
 * source tab; the admin console is the one fixed-prefix shell (D-10).
 */
export function tabForSub(sub: SubRoute, currentTab: TabId): TabId {
  if (sub.kind === 'admin') return 'profile';
  return isTabId(currentTab) ? currentTab : tabOfSub(sub);
}

/** Collapse a hash, a full URL, or a bare path to `#/...` (or `''`). */
function normalizeHash(value: string): string {
  let raw = String(value ?? '').trim();
  if (!raw) return '';
  const hashIndex = raw.indexOf('#');
  if (hashIndex >= 0) raw = raw.slice(hashIndex);
  else if (raw.startsWith('/')) raw = `#${raw}`;
  else return '';
  return raw === '#' ? '#' : `#${raw.slice(1).replace(/^\/+/, '/')}`;
}

function parseLearnSegments(rest: string[]): SubRoute | null {
  // #/<tab>/learn/youtube/<videoId>
  if (rest[0] === 'youtube' && rest.length === 2 && rest[1]) {
    return { kind: 'learn', source: 'youtube', videoId: rest[1] };
  }
  // #/<tab>/learn/library/<itemId>
  if (rest[0] === 'library' && rest.length === 2 && rest[1]) {
    return { kind: 'learn', source: 'library', itemId: rest[1] };
  }
  // #/<tab>/learn/local/<showId>/S<ss>E<ee>
  if (rest[0] === 'local' && rest.length === 3 && rest[1]) {
    const parsed = parseSeasonEpisode(rest[2]);
    if (parsed) {
      return { kind: 'learn', source: 'local', showId: rest[1], ...parsed };
    }
  }
  return null;
}

/** Parse the segments after a first-level tab. */
function parseSub(tab: TabId, rest: string[], query: URLSearchParams): SubRoute | null {
  const head = rest[0];

  if (rest.length === 1) {
    switch (head) {
      case 'review':
        return { kind: 'review' };
      case 'report':
        return { kind: 'report' };
      case 'placement':
        return { kind: 'placement', view: query.get('view') === 'profile' ? 'profile' : 'intro' };
      case 'exam':
        return { kind: 'exam' };
      case 'discover':
        return { kind: 'discover' };
      case 'vocabulary':
        return { kind: 'vocabulary' };
      case 'favorites':
        // Pre-word-book URL; the canonical form is `#/<tab>/vocabulary`.
        return tab === 'profile' ? { kind: 'vocabulary' } : null;
      case 'ability':
        return { kind: 'ability' };
      case 'admin':
        return { kind: 'admin' };
      default:
        break;
    }
  }

  if (head === 'reader' && rest.length <= 2) {
    return { kind: 'reader', articleId: rest[1] || undefined };
  }
  if (head === 'blog' && rest.length <= 2) {
    return { kind: 'blog', slug: rest[1] || undefined };
  }
  if (head === 'sentences' && rest.length === 2) {
    const levelId = Number.parseInt(rest[1], 10);
    return Number.isInteger(levelId) && levelId > 0 ? { kind: 'sentences', levelId } : null;
  }
  if (head === 'book' && rest.length === 2 && rest[1]) {
    return { kind: 'book', bookId: rest[1] };
  }
  if (head === 'book-series' && rest.length === 2 && rest[1]) {
    return { kind: 'book-series', seriesId: rest[1] };
  }
  if (head === 'imported-book' && rest.length === 2 && rest[1]) {
    return { kind: 'imported-book', bookId: rest[1] };
  }
  if (head === 'learn') {
    return parseLearnSegments(rest.slice(1));
  }
  if (head === 'lesson' && rest.length === 2 && rest[1]) {
    return { kind: 'course', lessonId: rest[1] };
  }
  return null;
}

interface ParsedRoute {
  state: NavState;
  /** True for a known old URL that must be rewritten in place (D-01). */
  legacy: boolean;
}

function parseNormalized(raw: string): ParsedRoute | null {
  // `#admin` (pre-P0 deep link) has no slash.
  if (raw === '#admin') {
    return { state: { tab: 'profile', sub: { kind: 'admin' } }, legacy: true };
  }
  if (!raw.startsWith('#/')) return null;

  const [pathPart, queryPart = ''] = raw.slice(2).split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decode);
  if (segments.length === 0) return { state: { ...FALLBACK }, legacy: false };

  const [head, ...rest] = segments;

  if (isTabId(head)) {
    const tab = head;
    if (rest.length === 0) {
      return { state: { tab, sub: null }, legacy: false };
    }
    // Section anchors only exist on the content page (D-05): they are legal
    // tab-level URLs, not aliases that get thrown away.
    if (tab === 'content' && rest.length === 1 && (rest[0] === 'library' || rest[0] === 'books')) {
      return { state: { tab, sub: null, anchor: rest[0] as SectionAnchor }, legacy: false };
    }
    const sub = parseSub(tab, rest, new URLSearchParams(queryPart));
    if (!sub) return null;
    // The admin console is a global shell: always `#/profile/admin` (D-10).
    if (sub.kind === 'admin' && tab !== 'profile') {
      return { state: { tab: 'profile', sub }, legacy: true };
    }
    return { state: { tab, sub }, legacy: false };
  }

  // Legacy source-absolute learning/course URLs (pre-D-01).
  if (head === 'learn') {
    const sub = parseLearnSegments(rest);
    return sub ? { state: { tab: 'content', sub }, legacy: true } : null;
  }
  if (head === 'lesson' && rest.length === 1 && rest[0]) {
    return { state: { tab: 'today', sub: { kind: 'course', lessonId: rest[0] } }, legacy: true };
  }
  if (head === 'admin') {
    return { state: { tab: 'profile', sub: { kind: 'admin' } }, legacy: true };
  }
  return null;
}

export type RouteKind = 'canonical' | 'legacy' | 'invalid';

export interface ResolvedRoute {
  state: NavState;
  /** The address bar value this route should be rewritten to. */
  canonical: string;
  kind: RouteKind;
}

/**
 * Resolve a location hash into `{ state, canonical, kind }`.
 * `kind` is what lets `useNav` decide "replace the alias once" (legacy) vs
 * "fall back to Today and toast once" (invalid / D-07).
 */
export function resolveRoute(hash: string): ResolvedRoute {
  const raw = normalizeHash(hash);
  if (!raw || raw === '#') {
    return { state: { ...FALLBACK }, canonical: FALLBACK_HASH, kind: 'canonical' };
  }
  const parsed = parseNormalized(raw);
  if (!parsed) {
    return { state: { ...FALLBACK }, canonical: FALLBACK_HASH, kind: 'invalid' };
  }
  const canonical = toHash(parsed.state);
  const kind: RouteKind = parsed.legacy || canonical !== raw ? 'legacy' : 'canonical';
  return { state: parsed.state, canonical, kind };
}

/**
 * Parse a location hash (or a bare route string) into the nav model.
 * Anything unrecognised falls back to today; use `resolveRoute` when the
 * caller also needs to know whether the address bar should be rewritten.
 */
export function parseRoute(hash: string): NavState {
  return resolveRoute(hash).state;
}

/**
 * Serialise a nav state to its canonical hash. Every app screen is
 * tab-prefixed (D-01); the admin console keeps its fixed `#/profile/admin`.
 */
export function toHash(state: NavState): string {
  const tab: TabId = isTabId(state.tab) ? state.tab : 'today';
  const { sub } = state;

  if (!sub && tab === 'content' && isSectionAnchor(state.anchor)) {
    return `#/content/${state.anchor}`;
  }
  if (!sub) return `#/${tab}`;

  const prefix = `#/${tab}`;
  switch (sub.kind) {
    case 'learn':
      if (sub.source === 'youtube') {
        return `${prefix}/learn/youtube/${encodeSegment(sub.videoId || '')}`;
      }
      if (sub.source === 'local') {
        return `${prefix}/learn/local/${encodeSegment(sub.showId || '')}/S${padSeason(sub.season)}E${padSeason(sub.episode)}`;
      }
      return `${prefix}/learn/library/${encodeSegment(sub.itemId || '')}`;
    case 'review':
      return `${prefix}/review`;
    case 'report':
      return `${prefix}/report`;
    case 'placement':
      return sub.view === 'profile'
        ? `${prefix}/placement?view=profile`
        : `${prefix}/placement`;
    case 'exam':
      return `${prefix}/exam`;
    case 'discover':
      return `${prefix}/discover`;
    case 'reader':
      return sub.articleId
        ? `${prefix}/reader/${encodeSegment(sub.articleId)}`
        : `${prefix}/reader`;
    case 'sentences':
      return `${prefix}/sentences/${sub.levelId}`;
    case 'blog':
      return sub.slug ? `${prefix}/blog/${encodeSegment(sub.slug)}` : `${prefix}/blog`;
    case 'book':
      return `${prefix}/book/${encodeSegment(sub.bookId)}`;
    case 'book-series':
      return `${prefix}/book-series/${encodeSegment(sub.seriesId)}`;
    case 'imported-book':
      return `${prefix}/imported-book/${encodeSegment(sub.bookId)}`;
    case 'vocabulary':
      return `${prefix}/vocabulary`;
    case 'ability':
      return `${prefix}/ability`;
    case 'admin':
      return '#/profile/admin';
    case 'course':
      return `${prefix}/lesson/${encodeSegment(sub.lessonId)}`;
    default:
      return `#/${tab}`;
  }
}

/** True when two nav states point at the same screen (ignoring identity). */
export function sameRoute(a: NavState, b: NavState): boolean {
  return toHash(a) === toHash(b);
}

/**
 * Parent screen for the no-history fallback (deep link / refresh), per
 * navigation-model §4: detail → list, other sub views → source tab root,
 * admin → profile, tab roots/anchors → null.
 */
export function parentOf(state: NavState): NavState | null {
  const { tab, sub } = state;
  if (!sub) return null;
  if (sub.kind === 'admin') return { tab: 'profile', sub: null };
  if (sub.kind === 'reader' && sub.articleId) return { tab, sub: { kind: 'reader' } };
  if (sub.kind === 'blog' && sub.slug) return { tab, sub: { kind: 'blog' } };
  return { tab, sub: null };
}

/**
 * i18n key for the page-level BackButton aria-label ("返回"/"返回文章列表").
 * Callers resolve it with `t(backLabelFor(state))`.
 */
export function backLabelFor(state: NavState): TranslationKey {
  if (state.sub?.kind === 'reader' && state.sub.articleId) return 'reader.backToList';
  if (state.sub?.kind === 'blog' && state.sub.slug) return 'blog.backToList';
  return 'nav.back';
}

/**
 * Dev-only component matrix hash (`#/dev/ui`).
 *
 * Deliberately NOT a `NavState` / `SubRoute`: the matrix is a pre-auth
 * diagnostics surface, never reachable from product navigation, and `App`'s
 * dev gate decides whether to mount it (`import.meta.env.DEV` or admin).
 * Keeping it out of the route model also keeps `parseRoute`'s contract
 * ("invalid → Today") intact for every normal screen.
 */
export function isDevUiHash(hash: string): boolean {
  const raw = String(hash ?? '').trim();
  if (!raw.startsWith('#')) return false;
  return /^#\/dev\/ui\/?(?:\?.*)?$/.test(raw);
}

/**
 * QA helper: true when the hash already is the canonical tab-prefixed app URL
 * (public pages `#/welcome` / `#/login` and legacy aliases are not).
 */
export function isTabPrefixedRoute(hash: string): boolean {
  const raw = String(hash ?? '').trim();
  if (!raw.startsWith('#/')) return false;
  const resolved = resolveRoute(raw);
  return resolved.kind === 'canonical' && /^#\/(today|content|practice|profile)(\/|$)/.test(resolved.canonical);
}
