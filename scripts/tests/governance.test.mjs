/**
 * 治理门禁单测（node:test，无第三方依赖）。
 *
 * 运行：node --test scripts/tests
 *
 * 覆盖：白名单匹配（精确/前缀/**）、共享文件判定、活跃卡写域重叠、
 *       board 依赖环/状态/文件、flags 行级解析/必填/唯一/过期、
 *       未登记 ff.* 与旧开关迁移提醒、证据 SHA 绑定。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  attributeChangedFiles,
  checkEvidenceSha,
  findDependencyIssues,
  findOverlaps,
  matchesScope,
  parseArgs as parsePreflightArgs,
  pathIsShared,
} from '../agent-preflight.mjs';

import { findCycles, validateBoard } from '../check-task-board.mjs';

import {
  findLegacyFlagUses,
  findUnregisteredFlags,
  parseFlagsYaml,
  validateFlags,
  validateSchemaTexts,
} from '../check-contracts.mjs';

// ─────────────────────────────────────────────────────────────────────────────
// 1. 白名单匹配
// ─────────────────────────────────────────────────────────────────────────────

test('matchesScope：精确文件相等', () => {
  assert.equal(matchesScope('frontend/src/App.tsx', 'frontend/src/App.tsx'), true);
  assert.equal(matchesScope('frontend/src/App.tsx', 'frontend/src/App2.tsx'), false);
});

test('matchesScope：目录前缀（含尾斜杠/无尾斜杠）', () => {
  assert.equal(matchesScope('scripts/tests/', 'scripts/tests/governance.test.mjs'), true);
  assert.equal(matchesScope('scripts/tests', 'scripts/tests/governance.test.mjs'), true);
  assert.equal(matchesScope('scripts/tests', 'scripts/tests'), true);
  assert.equal(matchesScope('scripts/tests', 'scripts/test-server.mjs'), false);
});

test('matchesScope：** 跨目录、* 不跨目录', () => {
  assert.equal(matchesScope('frontend/src/components/ui/**', 'frontend/src/components/ui/Dialog.tsx'), true);
  assert.equal(matchesScope('frontend/src/components/ui/**', 'frontend/src/components/ui/a/B.tsx'), true);
  assert.equal(matchesScope('frontend/src/i18n/*.json', 'frontend/src/i18n/zh-CN.json'), true);
  assert.equal(matchesScope('frontend/src/i18n/*.json', 'frontend/src/i18n/sub/en.json'), false);
  assert.equal(matchesScope('package*.json', 'package-lock.json'), true);
});

test('matchesScope：空值/无关路径不匹配', () => {
  assert.equal(matchesScope('', 'a.ts'), false);
  assert.equal(matchesScope('frontend/', 'backend/a.py'), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. 共享文件
// ─────────────────────────────────────────────────────────────────────────────

test('pathIsShared：全局共享文件命中（App.tsx / i18n / gate-receipt）', () => {
  const empty = { write_scope: [], shared_writes: [] };
  assert.equal(pathIsShared('frontend/src/App.tsx', empty), true);
  assert.equal(pathIsShared('frontend/src/i18n/zh-CN.json', empty), true);
  assert.equal(pathIsShared('scripts/gate-receipt.mjs', empty), true);
  assert.equal(pathIsShared('frontend/src/components/VocabularyBookScreen.tsx', empty), false);
});

test('pathIsShared：卡 shared_writes 命中；write_scope 显式授权可覆盖全局共享表', () => {
  const card = {
    write_scope: ['.github/workflows/ci.yml'],
    shared_writes: ['frontend/src/App.tsx'],
  };
  assert.equal(pathIsShared('frontend/src/App.tsx', card), true);
  assert.equal(pathIsShared('.github/workflows/ci.yml', card), false);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. 活跃卡写域重叠
// ─────────────────────────────────────────────────────────────────────────────

test('findOverlaps：两张 ready 卡同改一文件 → 冲突并列出对方卡', () => {
  const cards = [
    { id: 'P0-06', status: 'claimed', owner: 'me', write_scope: ['scripts/tests/governance.test.mjs'] },
    { id: 'P0-02', status: 'ready', owner: 'other', write_scope: ['scripts/tests/'] },
  ];
  const conflicts = findOverlaps(['scripts/tests/governance.test.mjs'], cards, 'P0-06');
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].cardId, 'P0-02');
  assert.deepEqual(conflicts[0].files, ['scripts/tests/governance.test.mjs']);
});

test('findOverlaps：排除本卡；pending 卡不算活跃；不同文件不冲突', () => {
  const cards = [
    { id: 'P0-06', status: 'claimed', write_scope: ['a.ts'] },
    { id: 'P0-03', status: 'pending', write_scope: ['a.ts'] },
    { id: 'P0-02', status: 'ready', write_scope: ['b.ts'] },
  ];
  assert.deepEqual(findOverlaps(['a.ts'], cards, 'P0-06'), []);
  const conflict = findOverlaps(['b.ts'], cards, 'P0-06');
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].cardId, 'P0-02');
});

test('attributeChangedFiles：其他活跃卡的文件被剔除，双方都覆盖的文件仍算本卡（交给 overlap）', () => {
  const cards = [
    { id: 'P0-06', status: 'claimed', write_scope: ['scripts/tests/governance.test.mjs'] },
    { id: 'P0-02', status: 'ready', write_scope: ['scripts/reconcile.py', 'scripts/tests/'] },
  ];
  const result = attributeChangedFiles(
    ['scripts/tests/governance.test.mjs', 'scripts/reconcile.py'],
    cards,
    cards[0],
  );
  assert.deepEqual(result.mine, ['scripts/tests/governance.test.mjs']);
  assert.deepEqual(result.others, [{ file: 'scripts/reconcile.py', cardId: 'P0-02' }]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. deps / 证据 SHA / 参数
// ─────────────────────────────────────────────────────────────────────────────

test('findDependencyIssues：缺失=错误、未完成=警告、已完成=通过', () => {
  const board = {
    cards: [
      { id: 'A', status: 'ready', deps: ['B', 'NOPE'] },
      { id: 'B', status: 'pending', deps: [] },
      { id: 'C', status: 'merged', deps: [] },
    ],
  };
  const missing = findDependencyIssues(board.cards[0], board);
  assert.deepEqual(missing.errors, ['依赖的卡不存在：NOPE']);
  assert.deepEqual(missing.warnings, ['依赖尚未完成：B（status=pending）']);
  assert.deepEqual(findDependencyIssues({ ...board.cards[0], deps: ['C'] }, board), { errors: [], warnings: [] });
});

test('checkEvidenceSha：7 位且等于 HEAD 前 7 位才通过', () => {
  const head = '779473d9aa2c542c970679086dfa3ad4910a676c';
  assert.equal(checkEvidenceSha(null, head).skipped, true);
  assert.equal(checkEvidenceSha('779473d', head).ok, true);
  assert.equal(checkEvidenceSha('779473e', head).ok, false);
  assert.equal(checkEvidenceSha('779473', head).ok, false);
});

test('parseArgs：--card 必填；其余开关解析', () => {
  assert.throws(() => parsePreflightArgs([]), /--card/);
  assert.deepEqual(parsePreflightArgs(['--card', 'P0-06', '--staged']).staged, true);
  const parsed = parsePreflightArgs([
    '--card=P0-06',
    '--as-integrator',
    '--evidence-sha',
    '779473d',
  ]);
  assert.equal(parsed.card, 'P0-06');
  assert.equal(parsed.asIntegrator, true);
  assert.equal(parsed.evidenceSha, '779473d');
  assert.throws(() => parsePreflightArgs(['--card', 'P0-06', '--bogus']), /未知参数/);
});

// ─────────────────────────────────────────────────────────────────────────────
// 5. 任务板
// ─────────────────────────────────────────────────────────────────────────────

const card = (overrides = {}) => ({
  id: 'P0-01',
  file: 'TASKS/P0-01.md',
  status: 'ready',
  owner: 'impl',
  write_scope: ['frontend/src/a.ts'],
  shared_writes: [],
  deps: [],
  ...overrides,
});

const boardOf = (cards) => ({ version: 1, updated: '2026-11-22', cards });

test('validateBoard：合法任务板通过', () => {
  const result = validateBoard(boardOf([card(), card({ id: 'P0-02', deps: [] })]));
  assert.deepEqual(result.errors, []);
});

test('validateBoard：ID 重复、状态非法、卡文件缺失', () => {
  const dup = validateBoard(boardOf([card(), card()]));
  assert.ok(dup.errors.some((item) => item.includes('卡 ID 重复')));
  const badStatus = validateBoard(boardOf([card({ status: 'doing' })]));
  assert.ok(badStatus.errors.some((item) => item.includes('状态非法')));
  const missing = validateBoard(boardOf([card()]), { cardFileExists: () => false });
  assert.ok(missing.errors.some((item) => item.includes('卡文件不存在')));
});

test('validateBoard：deps 引用不存在、自依赖、环', () => {
  const missing = validateBoard(boardOf([card({ deps: ['P9-99'] })]));
  assert.ok(missing.errors.some((item) => item.includes('依赖的卡不存在')));

  const cyclic = validateBoard(
    boardOf([
      card({ id: 'A', file: 'TASKS/A.md', deps: ['B'] }),
      card({ id: 'B', file: 'TASKS/B.md', deps: ['A'] }),
    ]),
  );
  assert.ok(cyclic.errors.some((item) => item.includes('依赖环')));

  const self = validateBoard(boardOf([card({ deps: ['P0-01'] })]));
  assert.ok(self.errors.some((item) => item.includes('不能依赖自己')));
});

test('findCycles：无环返回空，环返回闭合路径', () => {
  assert.deepEqual(
    findCycles([
      { id: 'A', deps: ['B'] },
      { id: 'B', deps: ['C'] },
      { id: 'C', deps: [] },
    ]),
    [],
  );
  const cycles = findCycles([
    { id: 'A', deps: ['B'] },
    { id: 'B', deps: ['A'] },
  ]);
  assert.equal(cycles.length, 1);
  assert.equal(cycles[0][0], cycles[0][cycles[0].length - 1]);
});

// ─────────────────────────────────────────────────────────────────────────────
// 6. 契约 / flags
// ─────────────────────────────────────────────────────────────────────────────

const FLAGS_YAML = `# comments
flags:
  ff.review.ui:
    owner: vocabulary-owner
    default: false
    created: "2026-11-22"
    expiry: "2027-03-31"
    removal: "独立背单词功能上线时移除"
  ff.course.generation:
    owner: reading-owner
    default: true
    created: "2026-11-17"
    expiry: "2027-06-30"
`;

test('parseFlagsYaml：行级解析 flag 与字段（去引号/注释）', () => {
  const parsed = parseFlagsYaml(FLAGS_YAML);
  assert.deepEqual(parsed.errors, []);
  assert.equal(parsed.flags.length, 2);
  assert.equal(parsed.flags[0].name, 'ff.review.ui');
  assert.equal(parsed.flags[0].fields.default, 'false');
  assert.equal(parsed.flags[0].fields.expiry, '2027-03-31');
});

test('parseFlagsYaml：重名报错', () => {
  const parsed = parseFlagsYaml(`${FLAGS_YAML}  ff.review.ui:\n    owner: x\n`);
  assert.ok(parsed.errors.some((item) => item.includes('flag 重复登记')));
});

test('validateFlags：必填字段/default 布尔/名字格式', () => {
  const missing = validateFlags(
    [{ name: 'ff.a.b', fields: { default: 'false' }, line: 1 }],
    { today: '2026-11-22' },
  );
  assert.ok(missing.errors.some((item) => item.includes('缺少必填字段 owner')));
  const badBool = validateFlags(
    [{ name: 'ff.a.b', fields: { owner: 'x', default: 'nope', created: '2026-01-01', expiry: '2027-01-01' }, line: 1 }],
    { today: '2026-11-22' },
  );
  assert.ok(badBool.errors.some((item) => item.includes('default 必须是')));
  const badName = validateFlags(
    [{ name: 'review.ui', fields: { owner: 'x', default: 'false', created: '2026-01-01', expiry: '2027-01-01' }, line: 1 }],
    { today: '2026-11-22' },
  );
  assert.ok(badName.errors.some((item) => item.includes('名字非法')));
});

test('validateFlags：过期 / expiry 早于 created', () => {
  const expired = validateFlags(
    [{ name: 'ff.a.b', fields: { owner: 'x', default: 'false', created: '2025-01-01', expiry: '2026-01-01' }, line: 1 }],
    { today: '2026-11-22' },
  );
  assert.ok(expired.errors.some((item) => item.includes('过期')));
  const reversed = validateFlags(
    [{ name: 'ff.a.b', fields: { owner: 'x', default: 'false', created: '2027-01-01', expiry: '2026-12-01' }, line: 1 }],
    { today: '2026-11-22' },
  );
  assert.ok(reversed.errors.some((item) => item.includes('早于 created')));
});

test('findUnregisteredFlags：已登记不报，未登记按文件/行报', () => {
  const files = [
    { file: 'frontend/src/a.ts', text: 'if (flags.ff.review.ui) {}\nconst x = ff.course.generation;\n' },
    { file: 'backend/b.py', text: 'if flags.is_enabled("ff.review.ui"): pass\n' },
  ];
  assert.deepEqual(findUnregisteredFlags(files, ['ff.review.ui', 'ff.course.generation']), []);
  const found = findUnregisteredFlags(files, ['ff.review.ui']);
  assert.equal(found.length, 1);
  assert.equal(found[0].flag, 'ff.course.generation');
  assert.deepEqual(found[0].samples, ['frontend/src/a.ts:2']);
});

test('findLegacyFlagUses：REVIEW_UI_ENABLED 作为迁移待办（不阻断）', () => {
  const files = [
    { file: 'frontend/src/App.tsx', text: 'if (!REVIEW_UI_ENABLED) return;\n' },
    { file: 'frontend/src/lib/review.ts', text: 'export const REVIEW_UI_ENABLED = false;\n' },
    { file: 'backend/a.py', text: 'pass\n' },
  ];
  const result = findLegacyFlagUses(files);
  assert.equal(result.length, 1);
  assert.equal(result[0].name, 'REVIEW_UI_ENABLED');
  assert.equal(result[0].count, 2);
  assert.equal(result[0].fileCount, 2);
  assert.equal(result[0].replacement, 'ff.review.ui');
});

test('validateSchemaTexts：合法 JSON 通过，非法 JSON/非对象报错', () => {
  const ok = validateSchemaTexts([{ file: 'a.json', text: '{"title":"x"}' }]);
  assert.deepEqual(ok.errors, []);
  const bad = validateSchemaTexts([
    { file: 'b.json', text: '{bad json' },
    { file: 'c.json', text: '[]' },
  ]);
  assert.equal(bad.errors.length, 2);
  assert.ok(bad.errors[0].includes('JSON 非法'));
  assert.ok(bad.errors[1].includes('顶层必须是 JSON 对象'));
});

// ─────────────────────────────────────────────────────────────────────────────
// 7. 验收用的组合场景（白名单外 / 共享文件 / 重叠）
// ─────────────────────────────────────────────────────────────────────────────

test('组合：白名单外文件 → 不在 write_scope 且非共享', () => {
  const cardDef = { write_scope: ['scripts/a.mjs'], shared_writes: [] };
  const files = ['scripts/a.mjs', 'frontend/src/lib/favorites.ts'];
  const outOfScope = files.filter(
    (file) => !pathIsShared(file, cardDef) && !cardDef.write_scope.some((entry) => matchesScope(entry, file)),
  );
  assert.deepEqual(outOfScope, ['frontend/src/lib/favorites.ts']);
});

test('组合：App.tsx 命中共享文件（需 --as-integrator），integrator 模式下不落入白名单外', () => {
  const cardDef = { write_scope: ['scripts/a.mjs'], shared_writes: [] };
  const files = ['frontend/src/App.tsx'];
  const shared = files.filter((file) => pathIsShared(file, cardDef));
  assert.deepEqual(shared, ['frontend/src/App.tsx']);
  const outOfScopeAsIntegrator = files.filter(
    (file) => !pathIsShared(file, cardDef) && !cardDef.write_scope.some((entry) => matchesScope(entry, file)),
  );
  assert.deepEqual(outOfScopeAsIntegrator, []);
});
