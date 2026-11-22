#!/usr/bin/env node
/**
 * check-task-board.mjs · 任务板一致性检查（机器门禁）
 *
 * 检查 TASKS/board.json：
 *   1. 卡文件存在（`file` 指向的 TASKS/*.md）；
 *   2. 卡 ID 唯一；
 *   3. 状态合法（枚举见 BOARD_STATUSES；`pending` = 未开始）；
 *   4. deps 引用存在、无自依赖、无环；
 *   5. write_scope / shared_writes 形状合法（活跃卡必须至少有 1 条写域）。
 *
 * 用法：node scripts/check-task-board.mjs
 * 无第三方依赖，Node ≥ 22。只读；退出码 0 通过 / 1 失败。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export const BOARD_STATUSES = new Set([
  'pending',
  'proposed',
  'ready',
  'claimed',
  'in_review',
  'approved',
  'merged',
  'closed',
  'blocked',
  'changes_requested',
]);

export const ACTIVE_STATUSES = new Set(['ready', 'claimed', 'in_review']);

/** 返回依赖环列表；每个环是 [a, b, ..., a] 形式。 */
export function findCycles(cards) {
  const validCards = (cards ?? []).filter(
    (card) => card && typeof card === 'object' && typeof card.id === 'string' && card.id !== '',
  );
  const byId = new Map(validCards.map((card) => [card.id, card]));
  const deps = new Map(
    validCards.map((card) => [
      card.id,
      (Array.isArray(card.deps) ? card.deps : []).filter((dep) => byId.has(dep)),
    ]),
  );
  const state = new Map();
  const stack = [];
  const cycles = [];
  const seen = new Set();

  const visit = (id) => {
    state.set(id, 1);
    stack.push(id);
    for (const dep of deps.get(id) ?? []) {
      if (state.get(dep) === 1) {
        const start = stack.indexOf(dep);
        const cycle = [...stack.slice(start), dep];
        const key = [...cycle].sort().join('>');
        if (!seen.has(key)) {
          seen.add(key);
          cycles.push(cycle);
        }
      } else if (!state.get(dep)) {
        visit(dep);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const card of validCards) {
    if (!state.get(card.id)) visit(card.id);
  }
  return cycles;
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '');
}

/**
 * 校验任务板（纯函数，便于单测）。
 * @param {object} board
 * @param {{ cardFileExists?: (file: string) => boolean }} options
 */
export function validateBoard(board, options = {}) {
  const cardFileExists = options.cardFileExists ?? (() => true);
  const errors = [];
  const warnings = [];

  if (!board || typeof board !== 'object' || Array.isArray(board)) {
    return { errors: ['board.json 顶层必须是对象'], warnings, cards: [] };
  }
  if (!Array.isArray(board.cards)) {
    return { errors: ['board.json 缺少 cards 数组'], warnings, cards: [] };
  }
  if (board.cards.length === 0) errors.push('board.json 的 cards 为空');
  if (board.version !== undefined && typeof board.version !== 'number') {
    errors.push('board.json 的 version 必须是数字');
  }

  const ids = new Set();
  const allIds = new Set(
    board.cards.filter((card) => card && typeof card.id === 'string' && card.id !== '').map((card) => card.id),
  );
  for (const [index, card] of board.cards.entries()) {
    const label = card && typeof card.id === 'string' ? card.id : `cards[${index}]`;
    if (!card || typeof card !== 'object' || Array.isArray(card)) {
      errors.push(`${label}：必须是对象`);
      continue;
    }
    if (typeof card.id !== 'string' || card.id.trim() === '') {
      errors.push(`${label}：id 必须是非空字符串`);
    } else if (ids.has(card.id)) {
      errors.push(`卡 ID 重复：${card.id}`);
    } else {
      ids.add(card.id);
    }
    if (typeof card.file !== 'string' || card.file.trim() === '') {
      errors.push(`${label}：file 必须是非空字符串（TASKS/<id>.md）`);
    } else if (!cardFileExists(card.file)) {
      errors.push(`${label}：卡文件不存在：${card.file}`);
    }
    if (!BOARD_STATUSES.has(card.status)) {
      errors.push(`${label}：状态非法「${card.status}」（允许：${[...BOARD_STATUSES].join('/')}）`);
    }
    if (typeof card.owner !== 'string') {
      errors.push(`${label}：owner 必须是字符串（可为空）`);
    } else if (ACTIVE_STATUSES.has(card.status) && card.owner.trim() === '') {
      warnings.push(`${label}：活跃卡 owner 为空（preflight 会拒绝开工）`);
    }
    if (!Array.isArray(card.write_scope)) {
      errors.push(`${label}：write_scope 必须是数组`);
    } else {
      if (!isStringArray(card.write_scope)) errors.push(`${label}：write_scope 含非字符串/空项`);
      if (new Set(card.write_scope).size !== card.write_scope.length) {
        errors.push(`${label}：write_scope 有重复项`);
      }
      if (ACTIVE_STATUSES.has(card.status) && card.write_scope.length === 0) {
        errors.push(`${label}：活跃卡 write_scope 不能为空`);
      }
    }
    if (card.shared_writes !== undefined && !isStringArray(card.shared_writes)) {
      errors.push(`${label}：shared_writes 必须是字符串数组`);
    }
    if (card.deps !== undefined) {
      if (!isStringArray(card.deps)) {
        errors.push(`${label}：deps 必须是字符串数组`);
      } else if (new Set(card.deps).size !== card.deps.length) {
        errors.push(`${label}：deps 有重复项`);
      } else {
        for (const dep of card.deps) {
          if (!allIds.has(dep)) errors.push(`${label}：依赖的卡不存在：${dep}`);
          if (dep === card.id) errors.push(`${label}：不能依赖自己`);
        }
      }
    }
  }

  for (const cycle of findCycles(board.cards)) {
    errors.push(`依赖环：${cycle.join(' → ')}`);
  }

  return { errors, warnings, cards: board.cards };
}

function main() {
  const root = DEFAULT_ROOT;
  const boardPath = resolve(root, 'TASKS/board.json');
  if (!existsSync(boardPath)) {
    console.error(`❌ check-task-board：任务板不存在：${boardPath}`);
    process.exitCode = 1;
    return;
  }
  let board;
  try {
    board = JSON.parse(readFileSync(boardPath, 'utf8'));
  } catch (error) {
    console.error(`❌ check-task-board：TASKS/board.json 不是合法 JSON：${error.message}`);
    process.exitCode = 1;
    return;
  }

  const { errors, warnings, cards } = validateBoard(board, {
    cardFileExists: (file) => existsSync(resolve(root, file)),
  });

  console.log('check-task-board · 任务板一致性');
  console.log(`board: TASKS/board.json（version=${board?.version ?? '?'}，updated=${board?.updated ?? '?'}）`);
  const counts = {};
  for (const card of cards) counts[card?.status] = (counts[card?.status] ?? 0) + 1;
  console.log(
    `卡片：${cards.length} 张（${Object.entries(counts)
      .map(([status, count]) => `${status} ${count}`)
      .join(' / ')}）`,
  );
  for (const card of cards) {
    console.log(
      `  - ${card?.id}  ${String(card?.status ?? '?').padEnd(12)} scope=${card?.write_scope?.length ?? 0}  deps=[${(card?.deps ?? []).join(', ')}]`,
    );
  }
  for (const item of warnings) console.log(`WARN  ${item}`);
  for (const item of errors) console.log(`FAIL  ${item}`);
  console.log('');
  console.log(
    errors.length > 0
      ? `结果：❌ 未通过（${errors.length} errors，${warnings.length} warnings）`
      : `结果：✅ 通过（0 errors，${warnings.length} warnings）`,
  );
  process.exitCode = errors.length > 0 ? 1 : 0;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  try {
    main();
  } catch (error) {
    console.error(`❌ check-task-board 错误：${error.message}`);
    process.exitCode = 1;
  }
}
