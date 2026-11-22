#!/usr/bin/env node
/**
 * agent-preflight.mjs · 任务卡写域 preflight（机器门禁，不靠自觉）
 *
 * 依据：ARCHITECTURE.md §9（所有权与写域）、docs/多agent协作工作流.md §3–§4、
 *       TASKS/P0-06-governance-hardening.md。
 *
 * 检查：
 *   1. TASKS/board.json 存在，`--card` 对应卡存在、状态可开工、owner 非空；
 *   2. deps 存在（缺失=错误；未完成=警告，不阻断）；
 *   3. 本次改动文件 ⊆ 卡 write_scope；命中 shared_writes（或全局共享文件）时
 *      必须显式传 `--as-integrator`（共享文件只由 Integrator 合入）；
 *   4. 其他活跃卡（ready/claimed/in_review，排除本卡）的写域与本次改动有交集
 *      → 失败并列出冲突卡；
 *   5. `--evidence-sha <sha7>` 必须等于 `git rev-parse HEAD` 的前 7 位；
 *   6. `--staged` 检查暂存区（pre-commit 用），否则检查 base..工作区（已跟踪文件）。
 *
 * 用法：
 *   node scripts/agent-preflight.mjs --card P0-06
 *   node scripts/agent-preflight.mjs --card P0-06 --base 3c270d4
 *   node scripts/agent-preflight.mjs --card P0-06 --staged
 *   node scripts/agent-preflight.mjs --card P0-06 --as-integrator
 *   node scripts/agent-preflight.mjs --card P0-06 --evidence-sha 779473d
 *   node scripts/agent-preflight.mjs --help
 *
 * 无第三方依赖，Node ≥ 22。只读 git 与 board；不写文件、不改索引。
 * 退出码：0 通过；1 拒绝/错误。
 *
 * 工作区说明：默认模式只看 `git diff <base>` 的已跟踪文件。新增（untracked）文件
 * 请先 `git add` 再用 `--staged`（pre-commit 即此模式），否则不会进入白名单检查——
 * 这是为了在共享工作区里不把其他活跃卡的未跟踪文件误判成本卡的改动。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

export const ACTIVE_CARD_STATUSES = new Set(['ready', 'claimed', 'in_review']);
export const DONE_CARD_STATUSES = new Set(['approved', 'merged', 'closed']);
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

/**
 * 全局共享文件（ARCHITECTURE.md §9 + docs/多agent协作工作流.md §3）。
 * 例外：卡在 write_scope 里显式列出某路径，视为 Architect 对该卡的明确授权
 * （P0-06 的 .github/workflows/ci.yml 就是这种情况）。
 */
export const DEFAULT_SHARED_PATHS = [
  'frontend/src/App.tsx',
  'frontend/src/i18n/*.json',
  'frontend/src/components/ui/**',
  'frontend/src/lib/nav*',
  'backend/migrations/**',
  'scripts/gate-receipt.mjs',
  'specs/README.md',
  '.github/**',
  'package*.json',
  'frontend/package*.json',
];

const GLOB_CACHE = new Map();

export function normalizePath(input) {
  return String(input ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

/** glob → RegExp：`**` 跨目录，`*` 不跨 `/`，`?` 单字符。 */
export function globToRegExp(glob) {
  const key = normalizePath(glob);
  if (GLOB_CACHE.has(key)) return GLOB_CACHE.get(key);
  let out = '';
  for (let i = 0; i < key.length; i += 1) {
    const ch = key[i];
    if (ch === '*') {
      if (key[i + 1] === '*') {
        if (key[i + 2] === '/') {
          out += '(?:.*/)?';
          i += 2;
        } else {
          out += '.*';
          i += 1;
        }
      } else {
        out += '[^/]*';
      }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$+.()|{}[]'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  const re = new RegExp(`^${out}$`);
  GLOB_CACHE.set(key, re);
  return re;
}

/**
 * 单条写域是否覆盖某个文件：
 *   - 含通配符 → glob；
 *   - 精确路径，或以 `/` 结尾/是文件所在的父目录 → 前缀；
 */
export function matchesScope(scopeEntry, filePath) {
  const raw = String(scopeEntry ?? '').trim();
  if (!raw) return false;
  const entry = normalizePath(raw);
  const file = normalizePath(filePath);
  if (!entry || !file) return false;
  if (entry.includes('*') || entry.includes('?')) return globToRegExp(raw).test(file);
  return file === entry || file.startsWith(`${entry}/`);
}

/** 文件是否属于共享文件（卡 shared_writes ∪ 全局共享表，write_scope 显式授权除外）。 */
export function pathIsShared(filePath, card, globalShared = DEFAULT_SHARED_PATHS) {
  const file = normalizePath(filePath);
  const declared = (card?.shared_writes ?? []).some((entry) => matchesScope(entry, file));
  if (declared) return true;
  const explicitlyOwned = (card?.write_scope ?? []).some((entry) => matchesScope(entry, file));
  if (explicitlyOwned) return false;
  return globalShared.some((entry) => matchesScope(entry, file));
}

export function findOverlaps(changedFiles, cards, currentCardId) {
  const conflicts = [];
  for (const card of cards) {
    if (!card || card.id === currentCardId) continue;
    if (!ACTIVE_CARD_STATUSES.has(card.status)) continue;
    const scope = [...(card.write_scope ?? []), ...(card.shared_writes ?? [])];
    const hits = changedFiles.filter((file) => scope.some((entry) => matchesScope(entry, file)));
    if (hits.length > 0) {
      conflicts.push({
        cardId: card.id,
        status: card.status,
        owner: card.owner || '（未填）',
        files: [...new Set(hits)],
      });
    }
  }
  return conflicts;
}

/**
 * 共享工作区归属：被其他活跃卡写域覆盖、且不在本卡写域内的文件，视为其他卡的
 * 并发改动，从本卡 preflight 的改动集中剔除并提示；两边都覆盖的文件仍算本卡
 * 改动，交给 overlap 检查报冲突。
 */
export function attributeChangedFiles(changedFiles, cards, currentCard) {
  const mine = [];
  const others = [];
  const currentScope = [...(currentCard.write_scope ?? []), ...(currentCard.shared_writes ?? [])];
  for (const file of changedFiles) {
    if (currentScope.some((entry) => matchesScope(entry, file))) {
      mine.push(file);
      continue;
    }
    const owner = cards.find(
      (card) =>
        card.id !== currentCard.id
        && ACTIVE_CARD_STATUSES.has(card.status)
        && [...(card.write_scope ?? []), ...(card.shared_writes ?? [])].some((entry) =>
          matchesScope(entry, file),
        ),
    );
    if (owner) others.push({ file, cardId: owner.id });
    else mine.push(file);
  }
  return { mine: [...new Set(mine)], others };
}

export function findDependencyIssues(card, board) {
  const errors = [];
  const warnings = [];
  const byId = new Map((board.cards ?? []).map((item) => [item.id, item]));
  for (const dep of card.deps ?? []) {
    const depCard = byId.get(dep);
    if (!depCard) {
      errors.push(`依赖的卡不存在：${dep}`);
    } else if (!DONE_CARD_STATUSES.has(depCard.status)) {
      warnings.push(`依赖尚未完成：${dep}（status=${depCard.status}）`);
    }
  }
  return { errors, warnings };
}

export function checkEvidenceSha(evidenceSha, headFull) {
  if (!evidenceSha) return { ok: true, skipped: true };
  const expected = String(headFull).slice(0, 7);
  const actual = String(evidenceSha).trim();
  if (!/^[0-9a-fA-F]{7}$/.test(actual)) {
    return { ok: false, message: `--evidence-sha 必须是 7 位 hex sha，收到「${actual}」；HEAD 前 7 位=${expected}` };
  }
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    return {
      ok: false,
      message: `证据 SHA 不符：--evidence-sha ${actual} ≠ HEAD 前 7 位 ${expected}（rebase/amend 后证据作废重跑）`,
    };
  }
  return { ok: true, expected };
}

export function parseArgs(argv) {
  const opts = {
    card: null,
    base: null,
    staged: false,
    asIntegrator: false,
    evidenceSha: null,
    help: false,
  };
  const fail = (message) => {
    const error = new Error(message);
    error.code = 'ARGS';
    throw error;
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      i += 1;
      if (i >= argv.length) fail(`${arg} 缺少值`);
      return argv[i];
    };
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--staged') opts.staged = true;
    else if (arg === '--as-integrator') opts.asIntegrator = true;
    else if (arg === '--card') opts.card = next();
    else if (arg.startsWith('--card=')) opts.card = arg.slice('--card='.length);
    else if (arg === '--base') opts.base = next();
    else if (arg.startsWith('--base=')) opts.base = arg.slice('--base='.length);
    else if (arg === '--evidence-sha') opts.evidenceSha = next();
    else if (arg.startsWith('--evidence-sha=')) opts.evidenceSha = arg.slice('--evidence-sha='.length);
    else fail(`未知参数：${arg}`);
  }
  if (!opts.help && !opts.card) fail('--card <ID> 必填（如 --card P0-06）');
  return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// git 只读辅助
// ─────────────────────────────────────────────────────────────────────────────

function runGit(root, args) {
  // core.quotepath=false：让中文路径按 UTF-8 输出，避免变成 "\345\244..." 的转义。
  const result = spawnSync('git', ['-C', root, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`无法执行 git：${result.error.message}`);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(-3).join('\n');
    throw new Error(`git ${args.join(' ')} 失败（exit ${result.status}）${detail ? `：${detail}` : ''}`);
  }
  return result.stdout.trim();
}

export function readCardBaseSha(root, cardFile) {
  if (!cardFile) return null;
  const path = resolve(root, cardFile);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^\s*[-*]?\s*base_sha:\s*([0-9a-f]{7,40})\s*$/m);
  return match ? match[1] : null;
}

export function resolveBase(root, card, board, explicitBase) {
  if (explicitBase) return { base: explicitBase, source: '--base' };
  const fromBoard = card.base_sha ?? card.base;
  if (fromBoard) return { base: String(fromBoard), source: 'board' };
  const fromCard = readCardBaseSha(root, card.file);
  if (fromCard) return { base: fromCard, source: '卡 base_sha' };
  return { base: 'HEAD~1', source: '默认 HEAD~1' };
}

export function changedFiles(root, { base, staged }) {
  const args = staged
    ? ['diff', '--cached', '--name-only', '--diff-filter=ACDMRTUXB']
    : ['diff', '--name-only', base, '--diff-filter=ACDMRTUXB'];
  return runGit(root, args)
    .split('\n')
    .map((line) => normalizePath(line))
    .filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// 主流程
// ─────────────────────────────────────────────────────────────────────────────

const USAGE = `用法：node scripts/agent-preflight.mjs --card <ID> [选项]

选项：
  --card <ID>             必填。任务卡 ID（TASKS/board.json 中的 id）
  --base <sha>            对比基线；默认取 board/卡内 base_sha，再退回 HEAD~1
  --staged                检查暂存区（pre-commit 使用；未跟踪新文件须先 git add）
  --as-integrator         允许写共享文件（仅 Integrator；其余写域仍受白名单约束）
  --evidence-sha <sha7>   要求等于 git rev-parse HEAD 前 7 位（提交后补证据时用）
  --help, -h              显示本帮助

退出码：0 通过；1 拒绝/错误。`;

function fmtList(items) {
  return items.map((item) => `    - ${item}`).join('\n');
}

export function runPreflight({ root = DEFAULT_ROOT, argv, board = null, headFull = null, files = null } = {}) {
  const opts = parseArgs(argv);
  if (opts.help) return { help: true, exitCode: 0, lines: [USAGE] };

  const errors = [];
  const warnings = [];
  const infos = [];
  const pass = [];

  let boardData = board;
  if (!boardData) {
    const boardPath = resolve(root, 'TASKS/board.json');
    if (!existsSync(boardPath)) throw new Error(`任务板不存在：${boardPath}`);
    try {
      boardData = JSON.parse(readFileSync(boardPath, 'utf8'));
    } catch (error) {
      throw new Error(`TASKS/board.json 不是合法 JSON：${error.message}`);
    }
  }
  if (!Array.isArray(boardData.cards)) throw new Error('TASKS/board.json 缺少 cards 数组');

  const card = boardData.cards.find((item) => item.id === opts.card);
  if (!card) throw new Error(`任务板里找不到卡：${opts.card}`);

  // 1. 卡状态 / owner
  if (DONE_CARD_STATUSES.has(card.status)) {
    errors.push(`卡 ${card.id} 已结束（status=${card.status}），不应再开工/改动`);
  } else if (!ACTIVE_CARD_STATUSES.has(card.status)) {
    errors.push(`卡 ${card.id} 状态为 ${card.status}，不能开工（需 ready/claimed/in_review）`);
  } else {
    pass.push(`卡状态：${card.id}（${card.status}）可开工`);
  }
  if (ACTIVE_CARD_STATUSES.has(card.status)) {
    if (!String(card.owner ?? '').trim()) errors.push(`卡 ${card.id} 的 owner 为空（Board 里补 owner 再开工）`);
    else pass.push(`owner：${card.owner}`);
  }

  // 2. deps
  const dep = findDependencyIssues(card, boardData);
  errors.push(...dep.errors);
  warnings.push(...dep.warnings);
  if (!dep.errors.length && !dep.warnings.length) pass.push(`deps：${(card.deps ?? []).length ? (card.deps ?? []).join('、') : '无'}`);

  // 3. base / changed files
  const { base, source } = resolveBase(root, card, boardData, opts.base);
  try {
    runGit(root, ['rev-parse', '--verify', `${base}^{commit}`]);
  } catch (error) {
    errors.push(`base 不可用：${base}（来源：${source}）；${error.message}`);
    return { exitCode: 1, lines: render({ opts, card, errors, warnings, infos, pass, base, source }) };
  }
  const changed = files ?? changedFiles(root, { base, staged: opts.staged });

  // 4. 其他活跃卡文件的归属（共享工作区）
  const attributed = attributeChangedFiles(changed, boardData.cards, card);
  if (attributed.others.length > 0) {
    const grouped = new Map();
    for (const item of attributed.others) {
      if (!grouped.has(item.cardId)) grouped.set(item.cardId, []);
      grouped.get(item.cardId).push(item.file);
    }
    for (const [cardId, items] of grouped) {
      infos.push(`跳过其他活跃卡（${cardId}）的 ${items.length} 个改动文件：${items.join('、')}`);
    }
  }
  const ownFiles = attributed.mine;

  // 5. 白名单 / 共享文件
  const scope = card.write_scope ?? [];
  const sharedHits = ownFiles.filter((file) => pathIsShared(file, card));
  const outOfScope = ownFiles.filter(
    (file) => !pathIsShared(file, card) && !scope.some((entry) => matchesScope(entry, file)),
  );

  if (sharedHits.length > 0) {
    if (opts.asIntegrator) {
      pass.push(`共享文件：${sharedHits.length} 个（已显式 --as-integrator）\n${fmtList(sharedHits)}`);
    } else {
      errors.push(
        `命中共享文件，共享文件需 --as-integrator（仅 Integrator 可写）：\n${fmtList(sharedHits)}`,
      );
    }
  } else {
    pass.push('共享文件：未命中');
  }

  if (outOfScope.length > 0) {
    errors.push(`白名单外文件（${outOfScope.length} 个，卡 write_scope 未覆盖）：\n${fmtList(outOfScope)}`);
  } else {
    pass.push(`白名单：${ownFiles.length} 个改动文件均在 write_scope 或共享例外内`);
  }

  // 6. 活跃卡写域交集
  const conflicts = findOverlaps(ownFiles, boardData.cards, card.id);
  if (conflicts.length > 0) {
    const detail = conflicts
      .map(
        (item) =>
          `    - ${item.cardId}（${item.status}，owner=${item.owner}）冲突文件：${item.files.join('、')}`,
      )
      .join('\n');
    errors.push(`活跃卡写域交集（${conflicts.length} 张卡），需等对方合并或拆卡：\n${detail}`);
  } else {
    const activeOthers = boardData.cards
      .filter((item) => item.id !== card.id && ACTIVE_CARD_STATUSES.has(item.status))
      .map((item) => item.id);
    pass.push(`活跃卡写域：无交集（已检查：${activeOthers.length ? activeOthers.join('、') : '无其他活跃卡'}）`);
  }

  // 7. 证据 SHA
  const head = headFull ?? runGit(root, ['rev-parse', 'HEAD']);
  const evidence = checkEvidenceSha(opts.evidenceSha, head);
  if (!evidence.ok) errors.push(evidence.message);
  else if (evidence.skipped) infos.push(`证据绑 HEAD：提交后请用 --evidence-sha ${String(head).slice(0, 7)} 复核`);
  else pass.push(`证据 SHA：${opts.evidenceSha} == HEAD 前 7 位`);

  return {
    exitCode: errors.length > 0 ? 1 : 0,
    card,
    base,
    source,
    head,
    staged: opts.staged,
    ownFiles,
    errors,
    warnings,
    infos,
    pass,
    lines: render({
      opts,
      card,
      errors,
      warnings,
      infos,
      pass,
      base,
      source,
      head,
      staged: opts.staged,
      ownFiles,
    }),
  };
}

function render({ opts, card, errors, warnings, infos, pass, base, source, head, staged, ownFiles = [] }) {
  const lines = [];
  lines.push('agent-preflight · 写域/证据门禁');
  lines.push(`card: ${card.id}（status=${card.status}，owner=${card.owner || '（未填）'}）`);
  lines.push(`base: ${base}（来源：${source}）`);
  lines.push(`mode: ${staged ? '暂存区（--staged）' : '工作区 diff（已跟踪文件；新增文件先 git add 再 --staged）'}`);
  if (head) lines.push(`HEAD: ${head}${opts.evidenceSha ? `（证据绑 ${String(head).slice(0, 7)}）` : ''}`);
  lines.push(`改动文件：${ownFiles.length} 个${ownFiles.length ? '' : '（无）'}`);
  lines.push('');
  for (const item of infos) lines.push(`INFO  ${item}`);
  for (const item of pass) lines.push(`PASS  ${item}`);
  for (const item of warnings) lines.push(`WARN  ${item}`);
  for (const item of errors) lines.push(`FAIL  ${item}`);
  lines.push('');
  lines.push(
    errors.length > 0
      ? `结果：❌ 未通过（${errors.length} errors，${warnings.length} warnings）`
      : `结果：✅ 通过（0 errors，${warnings.length} warnings）`,
  );
  return lines;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  try {
    const result = runPreflight({ argv: process.argv.slice(2) });
    console.log(result.lines.join('\n'));
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`❌ agent-preflight 错误：${error.message}`);
    if (error.code === 'ARGS') console.error(`\n${USAGE}`);
    process.exitCode = 1;
  }
}
