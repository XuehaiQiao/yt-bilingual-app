// Navigation state model for the P0 IA (docs/信息架构-导航重构.md §7).
//
// Pure functions only — no React, no DOM. `parseRoute` is the single place
// that decides "which screen does this URL mean"; `toHash` is its inverse.
// `App.tsx` maps the resulting `NavState` to components and never chains view
// booleans again.
//
// Route table (canonical hrefs):
//   #/today  #/content  #/practice  #/profile            first-level tabs
//   #/today/review        #/practice/review              review
//   #/today/report        #/profile/report               weekly report
//   #/practice/placement[?view=profile]                  placement / profile
//   #/practice/exam                                      exam practice
//   #/content/discover                                   content discovery
//   #/content/reader[/<articleId>]                       reading
//   #/content/sentences/<levelId>                        sentence packs
//   #/content/blog[/<slug>]                              official blog
//   #/content/book/<bookId>                              public-domain book reader
//   #/content/book-series/<seriesId>                     public-domain series page
//   #/content/imported-book/<bookId>                     imported public-domain book reader
//   #/learn/youtube/<videoId>                            learning view (YouTube)
//   #/learn/local/<showId>/S<ss>E<ee>                    learning view (local episode)
//   #/learn/library/<itemId>                             learning view (free library)
//   #/profile/favorites                                  favorites
//   #/profile/ability                                    ability profile
//   #/profile/admin                                      admin console
//
// Invalid hashes fall back to `#/today` (requirement: 非法 hash 回落 today).
// `#admin` (the pre-P0 deep link) and `/admin` are still recognised.

export type TabId = 'today' | 'content' | 'practice' | 'profile';

export const TAB_IDS: readonly TabId[] = ['content', 'practice', 'today', 'profile'];

export function isTabId(value: unknown): value is TabId {
  return typeof value === 'string' && (TAB_IDS as readonly string[]).includes(value);
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
  | { kind: 'favorites' }
  | { kind: 'ability' }
  | { kind: 'admin' };

export interface NavState {
  tab: TabId;
  sub: SubRoute | null;
}

const FALLBACK: NavState = { tab: 'today', sub: null };

function decode(value: string | undefined): string {
  if (!value) return '';
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
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
 * Which tab a sub view belongs to when the URL did not carry the prefix
 * (learning views) or when the caller's current tab is not a valid home for
 * it. Used by `parseRoute` and by the "back with no history" fallback.
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
    case 'favorites':
    case 'ability':
    case 'admin':
      return 'profile';
    default:
      return 'today';
  }
}

/**
 * The tab a sub view should live under when opened from `currentTab`.
 * Review/report keep the current today|practice / today|profile home so the
 * return path matches the entry point; everything else has one canonical tab.
 */
export function tabForSub(sub: SubRoute, currentTab: TabId): TabId {
  switch (sub.kind) {
    case 'learn':
      return isTabId(currentTab) ? currentTab : 'content';
    case 'review':
      return currentTab === 'today' || currentTab === 'practice' ? currentTab : 'practice';
    case 'report':
      return currentTab === 'today' || currentTab === 'profile' ? currentTab : 'today';
    default:
      return tabOfSub(sub, currentTab);
  }
}

/**
 * Parse a location hash (or a bare route string) into the nav model.
 * Anything unrecognised falls back to today, per the P0 acceptance rule.
 */
export function parseRoute(hash: string): NavState {
  let raw = String(hash || '').trim();
  if (!raw || raw === '#') return { ...FALLBACK };
  if (raw.startsWith('#')) raw = raw.slice(1);
  // Tolerate a full URL passed by a caller.
  const hashIndex = raw.indexOf('#');
  if (hashIndex > 0) raw = raw.slice(hashIndex + 1);
  if (!raw.startsWith('/')) {
    if (raw === 'admin') return { tab: 'profile', sub: { kind: 'admin' } };
    return { ...FALLBACK };
  }

  const withoutLeadingSlash = raw.slice(1);
  const [pathPart, queryPart = ''] = withoutLeadingSlash.split('?');
  const segments = pathPart.split('/').filter(Boolean).map(decode);
  if (segments.length === 0) return { ...FALLBACK };

  const [head, ...rest] = segments;

  if (head === 'today' || head === 'practice' || head === 'profile' || head === 'content') {
    const tab = head as TabId;
    if (rest.length === 0) return { tab, sub: null };

    const sub = rest[0];
    if (sub === 'review' && rest.length === 1) {
      if (tab === 'today' || tab === 'practice') return { tab, sub: { kind: 'review' } };
      return { ...FALLBACK };
    }
    if (sub === 'report' && rest.length === 1) {
      if (tab === 'today' || tab === 'profile') return { tab, sub: { kind: 'report' } };
      return { ...FALLBACK };
    }
    if (sub === 'favorites' && rest.length === 1 && tab === 'profile') {
      return { tab, sub: { kind: 'favorites' } };
    }
    if (sub === 'ability' && rest.length === 1 && tab === 'profile') {
      return { tab, sub: { kind: 'ability' } };
    }
    if (sub === 'admin' && rest.length === 1 && tab === 'profile') {
      return { tab, sub: { kind: 'admin' } };
    }
    if (sub === 'placement' && rest.length === 1 && tab === 'practice') {
      const view = new URLSearchParams(queryPart).get('view') === 'profile' ? 'profile' : 'intro';
      return { tab, sub: { kind: 'placement', view } };
    }
    if (sub === 'exam' && rest.length === 1 && tab === 'practice') {
      return { tab, sub: { kind: 'exam' } };
    }
    if (sub === 'discover' && rest.length === 1 && tab === 'content') {
      return { tab, sub: { kind: 'discover' } };
    }
    if (sub === 'reader' && tab === 'content' && rest.length <= 2) {
      return { tab, sub: { kind: 'reader', articleId: rest[1] || undefined } };
    }
    if (sub === 'sentences' && tab === 'content' && rest.length === 2) {
      const levelId = Number.parseInt(rest[1], 10);
      if (Number.isInteger(levelId) && levelId > 0) return { tab, sub: { kind: 'sentences', levelId } };
      return { ...FALLBACK };
    }
    if (sub === 'blog' && tab === 'content' && rest.length <= 2) {
      return { tab, sub: { kind: 'blog', slug: rest[1] || undefined } };
    }
    if (sub === 'book' && tab === 'content' && rest.length === 2 && rest[1]) {
      return { tab, sub: { kind: 'book', bookId: rest[1] } };
    }
    if (sub === 'book-series' && tab === 'content' && rest.length === 2 && rest[1]) {
      return { tab, sub: { kind: 'book-series', seriesId: rest[1] } };
    }
    if (sub === 'imported-book' && tab === 'content' && rest.length === 2 && rest[1]) {
      return { tab, sub: { kind: 'imported-book', bookId: rest[1] } };
    }
    // `#/content/library` is accepted as "the content page, free-library
    // section" (the section lives on the page, not in its own route).
    if (sub === 'library' && tab === 'content' && rest.length === 1) {
      return { tab, sub: null };
    }
    return { ...FALLBACK };
  }

  if (head === 'learn') {
    // #/learn/youtube/<videoId>
    if (rest[0] === 'youtube' && rest.length === 2 && rest[1]) {
      return { tab: 'content', sub: { kind: 'learn', source: 'youtube', videoId: rest[1] } };
    }
    // #/learn/library/<itemId>
    if (rest[0] === 'library' && rest.length === 2 && rest[1]) {
      return { tab: 'content', sub: { kind: 'learn', source: 'library', itemId: rest[1] } };
    }
    // #/learn/local/<showId>/S<ss>E<ee>
    if (rest[0] === 'local' && rest.length === 3 && rest[1]) {
      const parsed = parseSeasonEpisode(rest[2]);
      if (parsed) {
        return {
          tab: 'content',
          sub: { kind: 'learn', source: 'local', showId: rest[1], ...parsed },
        };
      }
    }
    return { ...FALLBACK };
  }

  if (head === 'admin') return { tab: 'profile', sub: { kind: 'admin' } };
  return { ...FALLBACK };
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value);
}

/**
 * Serialise a nav state to its canonical hash. Tab-level routes have no
 * trailing slash; sub routes always carry the tab prefix except learning
 * views, whose href is source-absolute (`#/learn/...`) by design.
 */
export function toHash(state: NavState): string {
  const { tab, sub } = state;
  if (!sub) return `#/${tab}`;
  switch (sub.kind) {
    case 'learn':
      if (sub.source === 'youtube') {
        return `#/learn/youtube/${encodeSegment(sub.videoId || '')}`;
      }
      if (sub.source === 'local') {
        return `#/learn/local/${encodeSegment(sub.showId || '')}/S${padSeason(sub.season)}E${padSeason(sub.episode)}`;
      }
      return `#/learn/library/${encodeSegment(sub.itemId || '')}`;
    case 'review':
      return `#/${tab === 'practice' ? 'practice' : 'today'}/review`;
    case 'report':
      return `#/${tab === 'profile' ? 'profile' : 'today'}/report`;
    case 'placement':
      return sub.view === 'profile'
        ? '#/practice/placement?view=profile'
        : '#/practice/placement';
    case 'exam':
      return '#/practice/exam';
    case 'discover':
      return '#/content/discover';
    case 'reader':
      return sub.articleId
        ? `#/content/reader/${encodeSegment(sub.articleId)}`
        : '#/content/reader';
    case 'sentences':
      return `#/content/sentences/${sub.levelId}`;
    case 'blog':
      return sub.slug ? `#/content/blog/${encodeSegment(sub.slug)}` : '#/content/blog';
    case 'book':
      return `#/content/book/${encodeSegment(sub.bookId)}`;
    case 'book-series':
      return `#/content/book-series/${encodeSegment(sub.seriesId)}`;
    case 'imported-book':
      return `#/content/imported-book/${encodeSegment(sub.bookId)}`;
    case 'favorites':
      return '#/profile/favorites';
    case 'ability':
      return '#/profile/ability';
    case 'admin':
      return '#/profile/admin';
    default:
      return `#/${tab}`;
  }
}

/** True when two nav states point at the same screen (ignoring object identity). */
export function sameRoute(a: NavState, b: NavState): boolean {
  return toHash(a) === toHash(b);
}
