// Unit tests for the zh-CN CJK rule (V-06 / QA-X-17).
//
// The negative cases are the point: a plain-English zh-CN value must be caught
// unless it is explicitly allowlisted. Run with:
//
//   node --test scripts/check-i18n.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkLanguage, checkV06, checkZhCjk, placeholder, validateAllowlist } from './check-i18n.mjs';

const frontendRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// QA-X-25: these were confirmed dead (0 live refs) and deleted from both
// dictionaries on 2026-11-19. Keep the list so a regression that re-adds one
// without a caller fails loudly.
const REMOVED_DEAD_KEYS = [
  'common.back',
  'common.thumbnailAlt',
  'home.heroTitle',
  'home.heroSubtitle',
  'share.source.video',
  'common.notRecorded',
  'common.noSessions',
  'common.studiedTimes',
  'common.watchedPercent',
  'home.continueLearning',
  'home.continueEmpty',
  'home.localShows',
  'home.subscriptions',
  'home.latestVideos',
];

test('negative: a plain-English zh-CN value without an allowlist entry is rejected', () => {
  const problems = checkZhCjk({
    base: { 'demo.cancel': 'Cancel', 'demo.ok': '取消' },
    allowlistedKeys: new Set(),
  });
  assert.deepEqual(problems, ['zh-CN: no CJK in "demo.cancel": "Cancel"']);
});

test('positive: a zh-CN value containing CJK passes', () => {
  const problems = checkZhCjk({
    base: { 'demo.cancel': '取消', 'demo.loading': '加载中…' },
    allowlistedKeys: new Set(),
  });
  assert.deepEqual(problems, []);
});

test('positive: allowlisted brand/CEFR values without CJK pass', () => {
  const problems = checkZhCjk({
    base: { 'brand.engine': 'LinguaTrek Engine', 'vocab.col.level': 'CEFR' },
    allowlistedKeys: new Set(['brand.engine', 'vocab.col.level']),
  });
  assert.deepEqual(problems, []);
});

test('negative: a V-06 key that regresses to English is rejected even if expectedCount matches', () => {
  const problems = checkV06({
    base: { 'common.cancel': 'Cancel', 'sentences.day': '第 {{day}} 天' },
    v06: { expectedCount: 2, keys: ['common.cancel', 'sentences.day'], adjudicated: [] },
  });
  assert.deepEqual(problems, ['V-06: no CJK in "common.cancel" (still English: "Cancel")']);
});

test('negative: a V-06 key cannot be smuggled in through the allowlist', () => {
  const problems = checkV06({
    base: { 'common.cancel': 'Cancel' },
    v06: { expectedCount: 1, keys: ['common.cancel'], adjudicated: [] },
    allowlistedKeys: new Set(['common.cancel']),
  });
  assert.deepEqual(problems, ['V-06: "common.cancel" is allowlisted but must be translated']);
});

test('negative: the sentences.day adjudication is enforced', () => {
  const problems = checkV06({
    base: { 'sentences.day': 'Day {{day}}' },
    v06: {
      expectedCount: 0,
      keys: [],
      adjudicated: [{ key: 'sentences.day', decision: 'translate' }],
    },
  });
  assert.deepEqual(problems, ['V-06: adjudicated "translate" key has no CJK: "sentences.day"']);
});

test('placeholder extraction is order-insensitive (duplicates preserved)', () => {
  assert.equal(placeholder('{{a}} {{b}}'), 'a,b');
  assert.equal(placeholder('{{b}} {{a}} {{a}}'), 'a,a,b');
  assert.equal(placeholder('no placeholders'), '');
});

test('existing guard still catches CJK in vi-VN and placeholder drift', () => {
  const result = checkLanguage({
    code: 'vi-VN',
    base: { 'demo.ok': '取消 {{count}}' },
    dict: { 'demo.ok': 'Hủy {{total}} 中' },
  });
  assert.ok(result.problems.some((problem) => problem.includes('CJK characters')));
  assert.ok(result.problems.some((problem) => problem.includes('placeholder mismatch')));
});

test('negative: an allowlist entry needs a reason, a live path, and no duplicates', () => {
  const result = validateAllowlist({
    data: {
      allowlist: [
        { key: 'brand.engine' }, // no reason, no path
        {
          key: 'demo.english',
          reason: 'not actually a brand',
          path: 'src/components/WelcomeScreen.tsx', // exists but does not reference demo.english
        },
      ],
      deadKeys: [{ key: 'brand.engine', reason: 'duplicate of the live entry' }],
    },
    base: {
      'brand.engine': 'LinguaTrek Engine',
      'demo.english': 'Cancel',
    },
    sourceFiles: [],
    rootDir: frontendRoot,
  });
  assert.ok(result.problems.some((problem) => problem.includes('"brand.engine" needs a reason')));
  assert.ok(result.problems.some((problem) => problem.includes('live key "brand.engine" needs a rendering path')));
  assert.ok(result.problems.some((problem) => problem.includes('"demo.english" path does not reference the key')));
  assert.ok(result.problems.some((problem) => problem.includes('duplicate key "brand.engine"')));
});

test('QA-X-25: the 14 dead keys are gone from zh-CN and vi-VN', () => {
  const zh = JSON.parse(readFileSync(resolve(frontendRoot, 'src/i18n/zh-CN.json'), 'utf8'));
  const vi = JSON.parse(readFileSync(resolve(frontendRoot, 'src/i18n/vi-VN.json'), 'utf8'));
  for (const key of REMOVED_DEAD_KEYS) {
    assert.ok(!(key in zh), `${key} is still in zh-CN.json`);
    assert.ok(!(key in vi), `${key} is still in vi-VN.json`);
  }
});

test('QA-X-25: the allowlist deadKeys list is empty', () => {
  const data = JSON.parse(readFileSync(resolve(frontendRoot, 'scripts/i18n-allowlist.json'), 'utf8'));
  assert.ok(Array.isArray(data.deadKeys), 'deadKeys must stay an array for the guard');
  assert.equal(data.deadKeys.length, 0);
});

test('negative: a dead key referenced by live source is rejected', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'i18n-dead-'));
  const liveFile = resolve(dir, 'Live.tsx');
  writeFileSync(liveFile, "export const label = 'demo.dead';\n");
  try {
    const result = validateAllowlist({
      data: { allowlist: [], deadKeys: [{ key: 'demo.dead', reason: 'test fixture' }] },
      base: { 'demo.dead': '死键' },
      sourceFiles: [liveFile],
      rootDir: dir,
    });
    assert.ok(
      result.problems.some((problem) => problem.includes('dead key "demo.dead" is referenced by live code')),
      result.problems.join('\n'),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
