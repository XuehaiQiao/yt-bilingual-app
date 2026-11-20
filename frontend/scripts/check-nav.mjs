#!/usr/bin/env node
// Contract test for the navigation model (docs/design-governance/navigation-model.md)
// and the public-site split.
//
// Pure Node test — no browser, no dev server, no extra dependency. It imports
// `src/lib/nav.ts` directly (Node strips the TypeScript types) and checks:
//
//   1. every app screen lives under `#/app`, and `parseRoute(toHash(s))` is the
//      inverse for every legal `NavState`;
//   2. `#/app/content/library` / `#/app/content/books` are legal anchors, not aliases;
//   3. old unprefixed URLs (`#/today`, `#/learn/...`, `#/lesson/...`,
//      `#/profile/favorites`, `#admin`, `#/<tab>/admin`) still parse and are
//      marked `legacy`, canonicalising to the `#/app/...` form;
//   4. garbage is marked `invalid` and falls back to `#/app/today`;
//   5. `parentOf` gives the deep-link back target, `backLabelFor` the aria key;
//   6. the public routes (home, `#/welcome` → `/`, `#/blog[/slug]`, `#/pricing`,
//      `#/resources`, `#/privacy`, `#/terms`, `#/login`) are parsed by
//      `parsePublicRoute`, the legacy
//      in-app blog URLs redirect to `#/blog...`, and `isAppHash` separates app
//      URLs from the public site.
//
// Run: node scripts/check-nav.mjs
import assert from 'node:assert/strict';
import {
  APP_ROUTE_PREFIX,
  TASK_SUB_KINDS,
  backLabelFor,
  isAppHash,
  isPublicHash,
  isTabPrefixedRoute,
  parentOf,
  parsePublicRoute,
  parseRoute,
  resolveRoute,
  sameRoute,
  tabForSub,
  toHash,
} from '../src/lib/nav.ts';

let checks = 0;
const failures = [];

function check(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (error) {
    failures.push(`${name}: ${error.message}`);
  }
}

function canonical(hash) {
  const resolved = resolveRoute(hash);
  assert.equal(resolved.canonical, hash, `${hash} should already be canonical (got ${resolved.canonical})`);
  assert.equal(resolved.kind, 'canonical', `${hash} should resolve as canonical (got ${resolved.kind})`);
  // Reparsing the canonical form must be stable.
  assert.equal(toHash(parseRoute(hash)), hash);
  return parseRoute(hash);
}

// ── 1. canonical app URL → state ───────────────────────────────────────────
check('every app URL is namespaced under #/app', () => {
  assert.equal(APP_ROUTE_PREFIX, '#/app');
  for (const tab of ['today', 'content', 'practice', 'profile']) {
    assert.equal(toHash({ tab, sub: null }), `#/app/${tab}`);
  }
});

check('tab roots', () => {
  for (const tab of ['today', 'content', 'practice', 'profile']) {
    assert.deepEqual(canonical(`#/app/${tab}`), { tab, sub: null });
  }
});

check('every sub kind is tab-prefixed and reversible', () => {
  const subs = [
    { kind: 'review' },
    { kind: 'report' },
    { kind: 'placement', view: 'intro' },
    { kind: 'placement', view: 'profile' },
    { kind: 'exam' },
    { kind: 'discover' },
    { kind: 'reader' },
    { kind: 'reader', articleId: 'article 1/2' },
    { kind: 'sentences', levelId: 3 },
    { kind: 'book', bookId: 'book-1' },
    { kind: 'book-series', seriesId: 'series-1' },
    { kind: 'imported-book', bookId: 'imported-1' },
    { kind: 'learn', source: 'youtube', videoId: 'dQw4w9WgXcQ' },
    { kind: 'learn', source: 'local', showId: 'house-of-cards', season: 3, episode: 3 },
    { kind: 'learn', source: 'library', itemId: 'eci-total-beginners-story' },
    { kind: 'course', lessonId: 'lesson-1' },
    { kind: 'vocabulary' },
    { kind: 'ability' },
    { kind: 'admin' },
  ];
  for (const tab of ['today', 'content', 'practice', 'profile']) {
    for (const sub of subs) {
      const state = { tab, sub };
      const hash = toHash(state);
      // The admin console is the one fixed-prefix shell (D-10).
      const expectedPrefix = sub.kind === 'admin' ? '#/app/profile/' : `#/app/${tab}/`;
      assert.ok(hash.startsWith(expectedPrefix), `${hash} should start with ${expectedPrefix}`);
      assert.equal(resolvedKind(hash), 'canonical', `${hash} should be canonical`);
      assert.equal(toHash(parseRoute(hash)), hash, `roundtrip ${hash}`);
      const parsed = parseRoute(hash);
      const normalized = JSON.parse(JSON.stringify(sub.kind === 'admin' ? { tab: 'profile', sub } : state));
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), normalized);
    }
  }
});

check('#/app is the app entry and defaults to today', () => {
  const resolved = resolveRoute('#/app');
  assert.equal(resolved.canonical, '#/app/today');
  assert.equal(resolved.kind, 'legacy');
  assert.deepEqual(resolved.state, { tab: 'today', sub: null });
});

function resolvedKind(hash) {
  return resolveRoute(hash).kind;
}

check('legacy app URLs canonicalise to the #/app prefix', () => {
  const cases = [
    ['#/today', { tab: 'today', sub: null }, '#/app/today'],
    ['#/content', { tab: 'content', sub: null }, '#/app/content'],
    ['#/practice/review', { tab: 'practice', sub: { kind: 'review' } }, '#/app/practice/review'],
    ['#/content/report', { tab: 'content', sub: { kind: 'report' } }, '#/app/content/report'],
    ['#/learn/youtube/dQw4w9WgXcQ', { tab: 'content', sub: { kind: 'learn', source: 'youtube', videoId: 'dQw4w9WgXcQ' } }, '#/app/content/learn/youtube/dQw4w9WgXcQ'],
    ['#/learn/library/item-1', { tab: 'content', sub: { kind: 'learn', source: 'library', itemId: 'item-1' } }, '#/app/content/learn/library/item-1'],
    ['#/learn/local/show/S01E02', { tab: 'content', sub: { kind: 'learn', source: 'local', showId: 'show', season: 1, episode: 2 } }, '#/app/content/learn/local/show/S01E02'],
    ['#/lesson/lesson-1', { tab: 'today', sub: { kind: 'course', lessonId: 'lesson-1' } }, '#/app/today/lesson/lesson-1'],
  ];
  for (const [legacy, state, expected] of cases) {
    const resolved = resolveRoute(legacy);
    assert.equal(resolved.kind, 'legacy', `${legacy} should be legacy`);
    assert.equal(resolved.canonical, expected);
    assert.deepEqual(resolved.state, state);
  }
});

check('other aliases normalise once', () => {
  const cases = [
    ['#/profile/favorites', '#/app/profile/vocabulary'],
    ['#/content/admin', '#/app/profile/admin'],
    ['#/today/admin', '#/app/profile/admin'],
    ['#admin', '#/app/profile/admin'],
    ['#/admin', '#/app/profile/admin'],
    ['/admin', '#/app/profile/admin'],
  ];
  for (const [legacy, expected] of cases) {
    const resolved = resolveRoute(legacy);
    assert.equal(resolved.kind, 'legacy', `${legacy} should be legacy`);
    assert.equal(resolved.canonical, expected);
  }
});

// ── 2. anchors (D-05) ───────────────────────────────────────────────────────
check('content section anchors stay in the URL', () => {
  for (const anchor of ['library', 'books']) {
    const hash = `#/app/content/${anchor}`;
    const resolved = resolveRoute(hash);
    assert.equal(resolved.kind, 'canonical', `${hash} must not be discarded`);
    assert.equal(resolved.canonical, hash);
    assert.deepEqual(resolved.state, { tab: 'content', sub: null, anchor });
    assert.equal(toHash(resolved.state), hash);
    assert.equal(parentOf(resolved.state), null, 'an anchor is a tab root: no back control');
  }
});

// ── 3. invalid app routes fall back to Today (D-07) ─────────────────────────
check('invalid app routes resolve to #/app/today and are marked invalid', () => {
  const bad = [
    '#/nonsense',
    '#/app/nonsense',
    '#/app/content/nonsense',
    '#/app/today/lesson',
    '#/app/content/sentences/zero',
    '#/app/content/book',
    // Public pages are not part of the app nav model; App routes them first.
    '#/welcome',
    '#/login',
    '#/blog',
    '#/blog/hello-world',
    '#/pricing',
    '#/resources',
    '#/learn/youtube',
  ];
  for (const hash of bad) {
    const resolved = resolveRoute(hash);
    assert.equal(resolved.kind, 'invalid', `${hash} should be invalid`);
    assert.equal(resolved.canonical, '#/app/today');
    assert.deepEqual(resolved.state, { tab: 'today', sub: null });
  }
  // Empty hash is not an error for AppContent; the public router sends it home.
  assert.equal(resolveRoute('').kind, 'canonical');
  assert.equal(resolveRoute('').canonical, '#/app/today');
});

// ── 4. parentOf / backLabelFor (deep-link fallback, §4) ─────────────────────
check('parentOf matches the return-target table', () => {
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'learn', source: 'youtube', videoId: 'v' } }), { tab: 'content', sub: null });
  assert.deepEqual(parentOf({ tab: 'practice', sub: { kind: 'review' } }), { tab: 'practice', sub: null });
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'report' } }), { tab: 'content', sub: null });
  assert.deepEqual(parentOf({ tab: 'profile', sub: { kind: 'admin' } }), { tab: 'profile', sub: null });
  // Detail → list (N-01/N-08).
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'reader', articleId: 'a' } }), { tab: 'content', sub: { kind: 'reader' } });
  // Tab roots and anchors have no parent.
  assert.equal(parentOf({ tab: 'today', sub: null }), null);
  assert.equal(parentOf({ tab: 'content', sub: null, anchor: 'library' }), null);
});

check('backLabelFor keys', () => {
  assert.equal(backLabelFor({ tab: 'content', sub: { kind: 'reader', articleId: 'a' } }), 'reader.backToList');
  assert.equal(backLabelFor({ tab: 'today', sub: { kind: 'review' } }), 'nav.back');
  assert.equal(backLabelFor({ tab: 'profile', sub: { kind: 'vocabulary' } }), 'nav.back');
});

// ── 5. helpers ─────────────────────────────────────────────────────────────
check('sameRoute ignores object identity', () => {
  assert.equal(sameRoute({ tab: 'today', sub: { kind: 'review' } }, { tab: 'today', sub: { kind: 'review' } }), true);
  assert.equal(sameRoute({ tab: 'today', sub: { kind: 'review' } }, { tab: 'practice', sub: { kind: 'review' } }), false);
});

check('tabForSub keeps the source tab (D-01/D-02)', () => {
  for (const sub of [
    { kind: 'review' },
    { kind: 'report' },
    { kind: 'placement', view: 'intro' },
    { kind: 'learn', source: 'youtube', videoId: 'v' },
  ]) {
    assert.equal(tabForSub(sub, 'content'), 'content');
    assert.equal(tabForSub(sub, 'today'), 'today');
  }
  assert.equal(tabForSub({ kind: 'admin' }, 'content'), 'profile', 'admin is fixed to profile (D-10)');
});

check('isTabPrefixedRoute requires the #/app prefix', () => {
  for (const hash of ['#/app/today', '#/app/content/report', '#/app/practice/exam', '#/app/content/library', '#/app/profile/admin']) {
    assert.equal(isTabPrefixedRoute(hash), true, `${hash} should be app-prefixed`);
  }
  for (const hash of ['#/today', '#/content/report', '#/welcome', '#/login', '#/blog', '#/learn/youtube/v', '#/nonsense', '']) {
    assert.equal(isTabPrefixedRoute(hash), false, `${hash} should not be app-prefixed`);
  }
});

check('TASK_SUB_KINDS is the shell single source', () => {
  for (const kind of ['learn', 'reader', 'review', 'exam', 'placement', 'course']) {
    assert.equal(TASK_SUB_KINDS.has(kind), true, `${kind} should be immersive`);
  }
  for (const kind of ['report', 'discover', 'vocabulary', 'ability', 'admin']) {
    assert.equal(TASK_SUB_KINDS.has(kind), false, `${kind} should keep the shell`);
  }
});

// ── 6. public site routing ─────────────────────────────────────────────────
check('public home + welcome redirect', () => {
  assert.deepEqual(parsePublicRoute(''), { view: 'home', canonical: '/', rewrite: false });
  assert.deepEqual(parsePublicRoute('#'), { view: 'home', canonical: '/', rewrite: false });
  assert.deepEqual(parsePublicRoute('#/'), { view: 'home', canonical: '/', rewrite: true });
  assert.deepEqual(parsePublicRoute('#/welcome'), { view: 'home', canonical: '/', rewrite: true });
  assert.deepEqual(parsePublicRoute('#/welcome/'), { view: 'home', canonical: '/', rewrite: true });
});

check('public blog list/article and legacy in-app aliases', () => {
  const list = parsePublicRoute('#/blog');
  assert.equal(list.view, 'blog');
  assert.equal(list.slug, undefined);
  assert.equal(list.rewrite, false);

  const article = parsePublicRoute('#/blog/hello-world');
  assert.equal(article.view, 'blog');
  assert.equal(article.slug, 'hello-world');
  assert.equal(article.canonical, '#/blog/hello-world');
  assert.equal(article.rewrite, false);

  for (const alias of [
    '#/app/blog',
    '#/app/blog/hello-world',
    '#/app/content/blog',
    '#/app/content/blog/hello-world',
    '#/today/blog/hello-world',
    '#/content/blog/hello-world',
  ]) {
    const resolved = parsePublicRoute(alias);
    assert.equal(resolved?.view, 'blog', `${alias} should be a public blog alias`);
    assert.equal(resolved.rewrite, true, `${alias} must be rewritten to #/blog`);
    assert.equal(resolved.canonical, alias.endsWith('hello-world') ? '#/blog/hello-world' : '#/blog');
  }
});

check('public pricing / resources / privacy / terms / login', () => {
  const pricing = parsePublicRoute('#/pricing');
  assert.deepEqual(pricing, { view: 'pricing', canonical: '#/pricing', rewrite: false });
  const resources = parsePublicRoute('#/resources');
  assert.deepEqual(resources, { view: 'resources', canonical: '#/resources', rewrite: false });
  const privacy = parsePublicRoute('#/privacy');
  assert.deepEqual(privacy, { view: 'privacy', canonical: '#/privacy', rewrite: false });
  const terms = parsePublicRoute('#/terms');
  assert.deepEqual(terms, { view: 'terms', canonical: '#/terms', rewrite: false });
  const login = parsePublicRoute('#/login?next=%23%2Fapp%2Ftoday');
  assert.equal(login?.view, 'login');
  assert.equal(login.rewrite, false);
  assert.equal(parsePublicRoute('#/pricing/foo'), null);
  assert.equal(parsePublicRoute('#/privacy/foo'), null);
  assert.equal(parsePublicRoute('#/terms/foo'), null);
  assert.equal(parsePublicRoute('#/login/extra'), null);
});

check('isAppHash separates the app from the public site', () => {
  for (const hash of ['#/app', '#/app/today', '#/app/content/library', '#/today', '#/content/report', '#/learn/youtube/v', '#/lesson/x', '#admin', '#/admin']) {
    assert.equal(isAppHash(hash), true, `${hash} should be app-owned`);
  }
  for (const hash of ['', '#/', '#/welcome', '#/blog', '#/blog/x', '#/pricing', '#/resources', '#/privacy', '#/terms', '#/login', '#/nonsense']) {
    assert.equal(isAppHash(hash), false, `${hash} should not be app-owned`);
  }
  // Legacy in-app blog aliases belong to the public site, not the app.
  assert.equal(isAppHash('#/today/blog/x'), true, 'the alias still lives in the app namespace');
  assert.equal(parsePublicRoute('#/today/blog/x')?.view, 'blog');
});

check('isPublicHash keeps useNav away from public URLs', () => {
  for (const hash of ['', '#', '#/', '#/welcome', '#/blog', '#/blog/x', '#/app/blog/x', '#/today/blog/x', '#/pricing', '#/resources', '#/privacy', '#/terms', '#/login?next=x']) {
    assert.equal(isPublicHash(hash), true, `${hash} should be public`);
  }
  for (const hash of ['#/app/today', '#/today', '#/content/report', '#/nonsense', '#/learn/youtube/v']) {
    assert.equal(isPublicHash(hash), false, `${hash} should not be public`);
  }
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERR  ${failure}`);
  console.error(`\nnav contract: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`nav contract passed: ${checks} checks (app/legacy/public routes, anchors, parentOf, helpers).`);
