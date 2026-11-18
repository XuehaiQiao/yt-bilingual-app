#!/usr/bin/env node
// Contract test for the navigation model (docs/design-governance/navigation-model.md).
//
// Pure Node test — no browser, no dev server, no extra dependency. It imports
// `src/lib/nav.ts` directly (Node strips the TypeScript types) and checks the
// D-01/D-02/D-05 decisions that the rest of W1 builds on:
//
//   1. every app screen is tab-prefixed, and `parseRoute(toHash(s))` is the
//      inverse for every legal `NavState`;
//   2. `#/content/library` / `#/content/books` are legal anchors, not aliases;
//   3. old URLs (`#/learn/...`, `#/lesson/...`, `#/profile/favorites`,
//      `#admin`, `#/<tab>/admin`) still parse and are marked `legacy`;
//   4. garbage is marked `invalid` and falls back to Today;
//   5. `parentOf` gives the deep-link back target, `backLabelFor` the aria key.
//
// Run: node scripts/check-nav.mjs
import assert from 'node:assert/strict';
import {
  TASK_SUB_KINDS,
  backLabelFor,
  isTabPrefixedRoute,
  parentOf,
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

// ── 1. canonical URL → state ────────────────────────────────────────────────
check('tab roots', () => {
  for (const tab of ['today', 'content', 'practice', 'profile']) {
    assert.deepEqual(canonical(`#/${tab}`), { tab, sub: null });
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
    { kind: 'blog' },
    { kind: 'blog', slug: 'hello-world' },
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
      const expectedPrefix = sub.kind === 'admin' ? '#/profile/' : `#/${tab}/`;
      assert.ok(hash.startsWith(expectedPrefix), `${hash} should start with ${expectedPrefix}`);
      assert.equal(resolvedKind(hash), 'canonical', `${hash} should be canonical`);
      assert.equal(toHash(parseRoute(hash)), hash, `roundtrip ${hash}`);
      const parsed = parseRoute(hash);
      const normalized = JSON.parse(JSON.stringify(sub.kind === 'admin' ? { tab: 'profile', sub } : state));
      assert.deepEqual(JSON.parse(JSON.stringify(parsed)), normalized);
    }
  }
});

function resolvedKind(hash) {
  return resolveRoute(hash).kind;
}

check('legacy learning URLs carry the source tab', () => {
  const cases = [
    ['#/learn/youtube/dQw4w9WgXcQ', { tab: 'content', sub: { kind: 'learn', source: 'youtube', videoId: 'dQw4w9WgXcQ' } }, '#/content/learn/youtube/dQw4w9WgXcQ'],
    ['#/learn/library/item-1', { tab: 'content', sub: { kind: 'learn', source: 'library', itemId: 'item-1' } }, '#/content/learn/library/item-1'],
    ['#/learn/local/show/S01E02', { tab: 'content', sub: { kind: 'learn', source: 'local', showId: 'show', season: 1, episode: 2 } }, '#/content/learn/local/show/S01E02'],
    ['#/lesson/lesson-1', { tab: 'today', sub: { kind: 'course', lessonId: 'lesson-1' } }, '#/today/lesson/lesson-1'],
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
    ['#/profile/favorites', '#/profile/vocabulary'],
    ['#/content/admin', '#/profile/admin'],
    ['#/today/admin', '#/profile/admin'],
    ['#admin', '#/profile/admin'],
    ['#/admin', '#/profile/admin'],
    ['/admin', '#/profile/admin'],
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
    const hash = `#/content/${anchor}`;
    const resolved = resolveRoute(hash);
    assert.equal(resolved.kind, 'canonical', `${hash} must not be discarded`);
    assert.equal(resolved.canonical, hash);
    assert.deepEqual(resolved.state, { tab: 'content', sub: null, anchor });
    assert.equal(toHash(resolved.state), hash);
    assert.equal(parentOf(resolved.state), null, 'an anchor is a tab root: no back control');
  }
});

// ── 3. invalid routes fall back to Today (D-07) ─────────────────────────────
check('invalid routes resolve to Today and are marked invalid', () => {
  const bad = [
    '#/nonsense',
    '#/content/nonsense',
    '#/today/lesson',
    '#/content/sentences/zero',
    '#/content/book',
    '#/welcome',
    '#/login',
    '#/learn/youtube',
  ];
  for (const hash of bad) {
    const resolved = resolveRoute(hash);
    assert.equal(resolved.kind, 'invalid', `${hash} should be invalid`);
    assert.equal(resolved.canonical, '#/today');
    assert.deepEqual(resolved.state, { tab: 'today', sub: null });
  }
  // Empty hash is not an error: an authenticated landing simply becomes Today.
  assert.equal(resolveRoute('').kind, 'canonical');
  assert.equal(resolveRoute('').canonical, '#/today');
});

// ── 4. parentOf / backLabelFor (deep-link fallback, §4) ─────────────────────
check('parentOf matches the return-target table', () => {
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'learn', source: 'youtube', videoId: 'v' } }), { tab: 'content', sub: null });
  assert.deepEqual(parentOf({ tab: 'practice', sub: { kind: 'review' } }), { tab: 'practice', sub: null });
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'report' } }), { tab: 'content', sub: null });
  assert.deepEqual(parentOf({ tab: 'profile', sub: { kind: 'admin' } }), { tab: 'profile', sub: null });
  // Detail → list (N-01/N-08).
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'reader', articleId: 'a' } }), { tab: 'content', sub: { kind: 'reader' } });
  assert.deepEqual(parentOf({ tab: 'content', sub: { kind: 'blog', slug: 's' } }), { tab: 'content', sub: { kind: 'blog' } });
  // Tab roots and anchors have no parent.
  assert.equal(parentOf({ tab: 'today', sub: null }), null);
  assert.equal(parentOf({ tab: 'content', sub: null, anchor: 'library' }), null);
});

check('backLabelFor keys', () => {
  assert.equal(backLabelFor({ tab: 'content', sub: { kind: 'reader', articleId: 'a' } }), 'reader.backToList');
  assert.equal(backLabelFor({ tab: 'content', sub: { kind: 'blog', slug: 's' } }), 'blog.backToList');
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

check('isTabPrefixedRoute', () => {
  for (const hash of ['#/today', '#/content/report', '#/practice/exam', '#/content/library', '#/profile/admin']) {
    assert.equal(isTabPrefixedRoute(hash), true, `${hash} should be tab-prefixed`);
  }
  for (const hash of ['#/welcome', '#/login', '#/learn/youtube/v', '#/nonsense', '']) {
    assert.equal(isTabPrefixedRoute(hash), false, `${hash} should not be tab-prefixed`);
  }
});

check('TASK_SUB_KINDS is the shell single source', () => {
  for (const kind of ['learn', 'reader', 'review', 'exam', 'placement', 'course']) {
    assert.equal(TASK_SUB_KINDS.has(kind), true, `${kind} should be immersive`);
  }
  for (const kind of ['report', 'discover', 'blog', 'vocabulary', 'ability', 'admin']) {
    assert.equal(TASK_SUB_KINDS.has(kind), false, `${kind} should keep the shell`);
  }
});

if (failures.length > 0) {
  for (const failure of failures) console.error(`ERR  ${failure}`);
  console.error(`\nnav contract: ${failures.length}/${checks} checks failed.`);
  process.exit(1);
}
console.log(`nav contract passed: ${checks} checks (canonical/legacy/invalid routes, anchors, parentOf, helpers).`);
