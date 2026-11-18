#!/usr/bin/env node
/**
 * check-ui-selectors.mjs · UI 选择器 / 组件冒烟（report-only）
 *
 * 用途（W5b / design-gate.md 附录 B）：
 *   扫描 `frontend/src/**\/*.{tsx,ts}` 与 `scripts/*.mjs`，报告三类「组件/选择器」债务：
 *   1. 旧按钮/卡片/标题常量仍在**定义**（A2 C1–C15、design-gate G2）：PRIMARY_BUTTON、
 *      SECONDARY_BUTTON、CARD、SECTION_TITLE、OPTION_BASE 等 18 个大写常量，以及
 *      ShareCardDialog / ReaderScreen 的 5 个字符串字面量小写常量；
 *   2. `frontend/src/components/ui/` **之外**出现与共享组件同名/同导出的文件（第二份）；
 *   3. 冻结契约属性（`data-word-hit` / `data-lookup-context` / `data-lookup-start` /
 *      `data-highlight`）与关键 `data-testid` 是否仍在；同时给出 testid 清单与
 *      `scripts/*.mjs` 依赖的、无法静态解析的选择器（提示项）。
 *
 * 定位：**report-only，不阻断**。
 *   - 默认退出码 0（参数/内部错误除外）；只有显式 `--fail` 才在存在 P0/P1 时退出 1。
 *   - 不接 CI（W5b 明确），不改产品代码，不修存量。
 *   - 这是静态冒烟，不启动浏览器：动态拼接的 testid / 运行时条件只能提示，不能证明。
 *
 * 用法：
 *   node scripts/check-ui-selectors.mjs                    # 全量扫描（report-only）
 *   node scripts/check-ui-selectors.mjs --diff <base>      # 只报告新增旧常量 / 新增重复组件文件
 *   node scripts/check-ui-selectors.mjs --baseline         # 只输出基线汇总（计数/热点）
 *   node scripts/check-ui-selectors.mjs --json             # 机器可读
 *   node scripts/check-ui-selectors.mjs --fail             # 有 P0/P1 时退出码 1（默认 0）
 *   node scripts/check-ui-selectors.mjs --self-test        # 注入反例自测（失败退出码 1）
 *   node scripts/check-ui-selectors.mjs --help
 *
 * 无第三方依赖，Node ≥ 18。只读：不写文件、不改 git 状态。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SRC_ROOT = 'frontend/src';
const COMPONENTS_ROOT = 'frontend/src/components';
const UI_ROOT = 'frontend/src/components/ui/';
const SCAN_EXT_RE = /\.(?:tsx|ts)$/;
const TEST_PATH_RE = /(?:\.test\.tsx?$|\/__tests__\/)/;

const USAGE = `check-ui-selectors v${VERSION} · UI 选择器 / 组件冒烟（report-only，不阻断）

用法：
  node scripts/check-ui-selectors.mjs                   全量扫描 frontend/src 与 scripts/*.mjs
  node scripts/check-ui-selectors.mjs --diff <base>     只报告新增行里的旧常量 / 新增重复组件文件
  node scripts/check-ui-selectors.mjs --baseline        只输出基线汇总（计数 / 热点）
  node scripts/check-ui-selectors.mjs --json            输出 JSON（可与 --baseline/--diff 组合）
  node scripts/check-ui-selectors.mjs --fail            存在 P0/P1 时退出码 1（默认始终 0）
  node scripts/check-ui-selectors.mjs --self-test       运行注入反例自测
  node scripts/check-ui-selectors.mjs --help

检查项：
  旧常量（P1）       18 个大写常量 + 5 个字符串字面量小写常量的**定义**；
                     usages（className={PRIMARY_BUTTON}）不重复计数。
  重复组件（P1）     components/ui/ 之外出现与共享组件同名或同导出的文件。
  冻结契约属性（P0） data-word-hit / data-lookup-context / data-lookup-start / data-highlight。
  冻结 testid（P1）  脚本依赖的关键 data-testid（见 FROZEN_TESTIDS）仍存在。
  testid 清单（提示）静态唯一 testid 数、动态模板数、scripts/*.mjs 依赖数与无法静态解析数（P2）。

定位：只报告，不阻断；默认退出码 0，--fail 才在 P0/P1 > 0 时退出 1。
  静态扫描不启动浏览器；动态拼接的 id 只作提示，不证明运行时一定存在。`;

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = {
    diff: null,
    baseline: false,
    json: false,
    fail: false,
    selfTest: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--baseline') opts.baseline = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--fail') opts.fail = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--diff') {
      opts.diff = argv[i + 1];
      i += 1;
      if (!opts.diff) fail('--diff 需要一个 base ref（如 origin/main）');
    } else if (arg.startsWith('--diff=')) {
      opts.diff = arg.slice('--diff='.length);
      if (!opts.diff) fail('--diff 需要一个 base ref（如 origin/main）');
    } else {
      fail(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  if (opts.baseline && opts.diff) fail('--baseline 与 --diff 不能同时使用（基线是全量口径，diff 是新增口径）');
  return opts;
}

function fail(message) {
  console.error(`ERR  ${message}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// git helpers（--diff 模式）
// ─────────────────────────────────────────────────────────────────────────────

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
  return {
    code: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function git(args) {
  return run('git', ['-c', 'core.quotepath=false', '--no-pager', ...args]);
}

function gitOk(args) {
  const result = git(args);
  return result.code === 0 ? result.stdout.trim() : null;
}

function shortSha(value) {
  return value ? value.slice(0, 7) : '(no-head)';
}

function resolveBase(explicit) {
  if (!explicit) fail('--diff 需要一个 base ref（如 origin/main）');
  const commit = gitOk(['rev-parse', '--verify', '--quiet', `${explicit}^{commit}`]);
  if (!commit) fail(`base 不存在：${explicit}`);
  return explicit;
}

function parseUnifiedDiff(text) {
  const records = [];
  let path = null;
  let newLine = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const value = raw.slice(4).trim();
      const clean = value.startsWith('b/') ? value.slice(2) : value;
      path = clean === '/dev/null' ? null : clean;
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!path) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      records.push({ path, line: newLine, text: raw.slice(1), added: true });
      newLine += 1;
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  return records.filter((record) => {
    if (!SCAN_EXT_RE.test(record.path)) return false;
    return !TEST_PATH_RE.test(record.path);
  });
}

function collectDiff(opts) {
  const headExists = Boolean(gitOk(['rev-parse', '--verify', '--quiet', 'HEAD']));
  if (!headExists) fail('仓库没有 HEAD，--diff 不可用');

  const mergeBase = gitOk(['merge-base', 'HEAD', opts.base]) ?? opts.base;
  const diff = git(['diff', '-U0', '--no-color', '--no-renames', mergeBase, '--', SRC_ROOT]);
  if (diff.code !== 0) fail(`git diff 失败：${diff.stderr.trim() || opts.base}`);
  const records = parseUnifiedDiff(diff.stdout);

  const untrackedOutput = gitOk(['ls-files', '--others', '--exclude-standard', '--', SRC_ROOT]) ?? '';
  const untracked = [];
  for (const path of untrackedOutput.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!SCAN_EXT_RE.test(path) || TEST_PATH_RE.test(path)) continue;
    let lines;
    try {
      lines = readFileSync(join(REPO_ROOT, path), 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    untracked.push(path);
    lines.forEach((text, index) => records.push({ path, line: index + 1, text, added: true }));
  }

  const statusOutput = git(['diff', '--name-status', '--no-renames', mergeBase, '--', SRC_ROOT]);
  if (statusOutput.code !== 0) fail(`git diff --name-status 失败：${statusOutput.stderr.trim() || opts.base}`);
  const changedFiles = new Map();
  for (const line of statusOutput.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (path) changedFiles.set(path, { path, status: status.trim().slice(0, 1), untracked: false });
  }
  for (const path of untracked) {
    if (!changedFiles.has(path)) changedFiles.set(path, { path, status: 'A', untracked: true });
    else changedFiles.get(path).untracked = true;
  }

  return {
    records,
    changes: [...changedFiles.values()],
    base: { ref: opts.base, mergeBase: shortSha(mergeBase) },
    untracked,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 文件收集（全量模式）
// ─────────────────────────────────────────────────────────────────────────────

function walkFiles(dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(absolute));
    } else if (SCAN_EXT_RE.test(entry.name) && !TEST_PATH_RE.test(absolute)) {
      files.push(absolute);
    }
  }
  return files;
}

function collectAllFiles() {
  const root = join(REPO_ROOT, SRC_ROOT);
  return walkFiles(root)
    .map((absolute) => relative(REPO_ROOT, absolute).split('\\').join('/'))
    .sort();
}

function readLines(relPath) {
  try {
    return readFileSync(join(REPO_ROOT, relPath), 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 共享组件 / 旧常量 / 冻结选择器
// ─────────────────────────────────────────────────────────────────────────────

const SHARED_COMPONENTS = new Set([
  'Button',
  'IconButton',
  'Dialog',
  'ConfirmDialog',
  'Sheet',
  'Card',
  'ListRow',
  'IconTile',
  'Input',
  'Textarea',
  'SearchField',
  'Tabs',
  'Segmented',
  'Badge',
  'CountBadge',
  'Toast',
  'Pagination',
  'EmptyState',
  'ErrorPanel',
  'Skeleton',
  'PageHeader',
  'SubHeader',
  'BackButton',
  'WordCard',
  'OptionCard',
  'Progress',
]);

const OLD_CONSTANTS = [
  'PRIMARY_BUTTON',
  'SECONDARY_BUTTON',
  'GHOST_BUTTON',
  'DANGER_BUTTON',
  'TINTED_BUTTON',
  'SUCCESS_BUTTON',
  'COMPACT_BUTTON',
  'ROW_BUTTON',
  'PAGE_BUTTON',
  'PRIMARY_CTA',
  'SECONDARY_CTA',
  'ACTION',
  'ENTRY_ACTION',
  'OPTION_BASE',
  'CARD',
  'SUB_CARD',
  'CARD_ICON',
  'SECTION_TITLE',
];

const OLD_LOWER_CONSTANTS = ['primaryButton', 'secondaryButton', 'tintedButton', 'dangerButton', 'ghostButton'];


const CONTRACT_ATTRIBUTES = ['data-word-hit', 'data-lookup-context', 'data-lookup-start', 'data-highlight'];

/**
 * 冻结 testid：来自 A4 §5.4、`scripts/*.mjs` 的真实依赖与 design-gate G3 的锚点。
 * 只列**当前已存在**的契约；新增/改名必须在同一 commit 改脚本并更新本清单。
 */
const FROZEN_TESTIDS = [
  'app-shell',
  'word-popover',
  'word-popover-overlay',
  'word-popover-word',
  'books-section',
  'book-series-screen',
  'book-series-available',
  'book-series-excluded',
  'book-reader',
  'library-reader',
  'imported-book-reader',
  'reader-scroll',
  'reader-translation-bar',
  'reader-highlight-toggle',
  'start-mode-select',
  'video-url-input',
  'share-card-dialog',
  'share-card-close',
  'content-rail-continue',
  'content-screen',
];

function oldConstantName(text) {
  const match = text.match(
    new RegExp(`\\bconst\\s+(${[...OLD_CONSTANTS, ...OLD_LOWER_CONSTANTS].join('|')})\\b`),
  );
  if (!match) return null;
  const name = match[1];
  if (OLD_LOWER_CONSTANTS.includes(name)) {
    // 小写旧常量只算「class 字符串字面量」定义；JSX 局部变量不算（gate-receipt 同口径）。
    return new RegExp(`\\bconst\\s+${name}\\b[^=]*=\\s*['"\`]`).test(text) ? name : null;
  }
  return name;
}

function isUiPath(path) {
  return path.startsWith(UI_ROOT);
}

function sharedNameForPath(path) {
  if (!path.startsWith(`${COMPONENTS_ROOT}/`) || isUiPath(path)) return null;
  const name = basename(path).replace(/\.(?:tsx|ts)$/, '');
  return SHARED_COMPONENTS.has(name) ? name : null;
}

function sharedExportName(content) {
  for (const name of SHARED_COMPONENTS) {
    const declaration = new RegExp(`export\\s+(?:default\\s+)?(?:function|const|class)\\s+${name}\\b`);
    if (declaration.test(content)) return name;
    const reExport = new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`);
    if (reExport.test(content)) return name;
  }
  return null;
}

/**
 * 从一行里提取 testid 声明（静态值 / 动态模板）。
 * 处理 `data-testid=...`、`testId=...`（含 `retryTestId` 等透传 prop）；`testId={someVar}` 无法静态解析。
 */
function testidDeclarations(text) {
  const declarations = [];
  // 兼容 testId / retryTestId 等透传 prop（组件内部通常再写到 data-testid 上）。
  const attributeRe = /(?:\bdata-testid|\b[A-Za-z]*[Tt]estId)\s*=\s*(?:"([^"]*)"|'([^']*)'|\{\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)\s*\})/g;
  for (const match of text.matchAll(attributeRe)) {
    const value = match[1] ?? match[2] ?? match[3] ?? match[4] ?? match[5];
    if (value === undefined) continue;
    const dynamic = value.includes('${');
    const lastBrace = value.lastIndexOf('}');
    declarations.push({
      value,
      dynamic,
      prefix: dynamic ? value.split('${')[0] : null,
      // 模板末尾的静态片段（如 `${testId}-overlay` → -overlay），用于静态反查。
      suffix: dynamic && lastBrace >= 0 ? value.slice(lastBrace + 1) : null,
    });
  }
  return declarations;
}

function collectTestidInventory(files) {
  const staticIds = new Set();
  const dynamicTemplates = new Set();
  const dynamicPrefixes = new Set();
  const dynamicSuffixes = new Set();
  const declarations = [];

  for (const path of files) {
    const lines = readLines(path);
    lines.forEach((text, index) => {
      for (const declaration of testidDeclarations(text)) {
        declarations.push({ path, line: index + 1, ...declaration });
        if (declaration.dynamic) {
          dynamicTemplates.add(declaration.value);
          if (declaration.prefix) dynamicPrefixes.add(declaration.prefix);
          if (declaration.suffix) dynamicSuffixes.add(declaration.suffix);
        } else {
          staticIds.add(declaration.value);
        }
      }
      // 三元表达式里的模板（如 `data-testid={testId ? \`${testId}-overlay\` : ...}`）
      // 不会被上一条属性正则整体捕获；只从 `data-testid={` / `testId={` 之后的表达式里补收，
      // 避免把查询选择器字符串（\`[data-testid="${id}"]\`）误当成 testid 模板。
      const attributeExpression = text.match(/(?:\bdata-testid|\b[A-Za-z]*[Tt]estId)=\{(.*)$/);
      if (attributeExpression) {
        for (const match of attributeExpression[1].matchAll(/`([^`]*\$\{[^}]+\}[^`]*)`/g)) {
          const value = match[1];
          const prefix = value.split('${')[0];
          const suffix = value.slice(value.lastIndexOf('}') + 1);
          dynamicTemplates.add(value);
          if (prefix) dynamicPrefixes.add(prefix);
          if (suffix) dynamicSuffixes.add(suffix);
        }
      }
    });
  }
  return { staticIds, dynamicTemplates, dynamicPrefixes, dynamicSuffixes, declarations };
}

/**
 * 提取 `scripts/*.mjs` 里用到的 data-testid 选择器。
 * 支持 `[data-testid="x"]`、`[data-testid=x]`、`[data-testid^="prefix-"]`。
 */
function collectScriptSelectors() {
  const scriptsDir = join(SCRIPT_DIR);
  const selectors = new Map();
  let scanned = 0;
  for (const entry of readdirSync(scriptsDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
    // 不把本脚本自测里的示例选择器当成真实依赖。
    if (entry.name === 'check-ui-selectors.mjs') continue;
    scanned += 1;
    const content = readFileSync(join(scriptsDir, entry.name), 'utf8');
    const selectorRe = /data-testid\s*(\^?=)\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/g;
    for (const match of content.matchAll(selectorRe)) {
      const operator = match[1];
      const value = match[2] ?? match[3] ?? match[4];
      if (!value) continue;
      const existing = selectors.get(`${operator}:${value}`) ?? { operator, value, files: new Set() };
      existing.files.add(entry.name);
      selectors.set(`${operator}:${value}`, existing);
    }
  }
  return {
    scanned,
    selectors: [...selectors.values()].map((selector) => ({ ...selector, files: [...selector.files].sort() })),
  };
}

function resolvesTestid(id, inventory) {
  if (inventory.staticIds.has(id)) return 'static';
  for (const prefix of inventory.dynamicPrefixes) {
    if (prefix && id.startsWith(prefix)) return 'dynamic-prefix';
  }
  // 反向：`${testId}-overlay` 这类模板，用「静态基名 + 固定后缀」反查。
  for (const suffix of inventory.dynamicSuffixes ?? []) {
    if (!suffix || !id.endsWith(suffix)) continue;
    const base = id.slice(0, -suffix.length);
    if (base && inventory.staticIds.has(base)) return 'dynamic-suffix';
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫描
// ─────────────────────────────────────────────────────────────────────────────

function truncate(text, max = 140) {
  const value = String(text).trim().replace(/\s+/g, ' ');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function scanOldConstants(records) {
  const hits = [];
  for (const record of records) {
    const name = oldConstantName(record.text);
    if (!name) continue;
    hits.push({
      path: record.path,
      line: record.line,
      name,
      text: truncate(record.text),
      severity: 'P1',
    });
  }

  const byName = new Map();
  const byFile = new Map();
  for (const hit of hits) {
    byName.set(hit.name, (byName.get(hit.name) ?? 0) + 1);
    byFile.set(hit.path, (byFile.get(hit.path) ?? 0) + 1);
  }

  return {
    total: hits.length,
    files: byFile.size,
    hits,
    byName: [...byName.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name)),
    hotspots: [...byFile.entries()]
      .map(([path, count]) => ({ path, count }))
      .sort((a, b) => b.count - a.count || a.path.localeCompare(b.path)),
  };
}

function scanDuplicates(files) {
  const duplicates = [];
  for (const path of files) {
    const byPath = sharedNameForPath(path);
    if (byPath) {
      duplicates.push({ path, name: byPath, reason: '同名文件（components/ui/ 之外）' });
      continue;
    }
    if (!path.startsWith(`${COMPONENTS_ROOT}/`) || isUiPath(path)) continue;
    const byExport = sharedExportName(readLines(path).join('\n'));
    if (byExport) duplicates.push({ path, name: byExport, reason: '同名导出（components/ui/ 之外）' });
  }
  return {
    total: duplicates.length,
    items: duplicates.sort((a, b) => a.path.localeCompare(b.path)),
  };
}

function scanFrozen(files) {
  const counts = new Map();
  for (const path of files) {
    const content = readLines(path).join('\n');
    for (const attribute of CONTRACT_ATTRIBUTES) {
      const matches = content.match(new RegExp(`\\b${attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
      if (matches) counts.set(attribute, (counts.get(attribute) ?? 0) + matches.length);
    }
  }

  const inventory = collectTestidInventory(files);
  const attributes = CONTRACT_ATTRIBUTES.map((name) => ({
    name,
    count: counts.get(name) ?? 0,
    present: (counts.get(name) ?? 0) > 0,
    severity: 'P0',
  }));

  const testids = FROZEN_TESTIDS.map((id) => {
    const count = inventory.declarations.filter((declaration) => {
      if (declaration.dynamic) return false;
      return declaration.value === id;
    }).length;
    const resolvedBy = resolvesTestid(id, inventory);
    return {
      id,
      count,
      present: count > 0 || resolvedBy !== null,
      resolvedBy,
      severity: 'P1',
    };
  });

  return { attributes, testids, inventory };
}

function scanScripts(inventory) {
  const { scanned, selectors } = collectScriptSelectors();
  const resolved = [];
  const unresolved = [];
  for (const selector of selectors) {
    if (selector.operator === '^=') {
      const prefix = selector.value;
      const found =
        [...inventory.staticIds].some((id) => id.startsWith(prefix)) ||
        [...inventory.dynamicPrefixes].some((dynamicPrefix) => dynamicPrefix.startsWith(prefix));
      (found ? resolved : unresolved).push({ ...selector, kind: 'prefix' });
    } else {
      const by = resolvesTestid(selector.value, inventory);
      (by ? resolved : unresolved).push({ ...selector, kind: 'exact', resolvedBy: by });
    }
  }
  return {
    scannedFiles: scanned,
    total: selectors.length,
    resolved,
    unresolved,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(opts) {
  const headFull = gitOk(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const mode = opts.diff ? 'diff' : opts.baseline ? 'baseline' : 'full';
  const allFiles = collectAllFiles();
  let records;
  let base = null;
  let changes = null;
  let untracked = [];

  if (opts.diff) {
    const diff = collectDiff({ ...opts, base: resolveBase(opts.diff) });
    records = diff.records;
    base = diff.base;
    changes = diff.changes;
    untracked = diff.untracked;
  } else {
    records = [];
    for (const path of allFiles) {
      readLines(path).forEach((text, index) => records.push({ path, line: index + 1, text, added: false }));
    }
  }

  const oldConstants = scanOldConstants(records);
  // full 模式查全仓；diff 模式只查本次新增的组件文件（存量重复不算新增）。
  const duplicateCandidates = opts.diff
    ? (changes ?? []).filter((file) => file.status === 'A').map((file) => file.path)
    : allFiles;
  const duplicates = scanDuplicates(duplicateCandidates);
  const frozen = scanFrozen(allFiles);
  const scripts = scanScripts(frozen.inventory);

  const missingAttributes = frozen.attributes.filter((attribute) => !attribute.present);
  const missingTestids = frozen.testids.filter((testid) => !testid.present);

  const p0 = missingAttributes.length;
  const p1 = oldConstants.total + duplicates.total + missingTestids.length;
  const p2 = scripts.unresolved.length;
  const issues = p0 + p1 + p2;

  const report = {
    tool: 'check-ui-selectors',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    head: shortSha(headFull),
    mode,
    reportOnly: true,
    base,
    scope: {
      source: `${SRC_ROOT}/**/*.{tsx,ts}（跳过 *.test.* 与 __tests__/）`,
      files: allFiles.length,
      scripts: scripts.scannedFiles,
      ...(mode === 'diff' ? { addedLines: records.length, changedFiles: changes, untracked } : {}),
    },
    totals: {
      issues,
      p0,
      p1,
      p2,
      oldConstants: oldConstants.total,
      oldConstantFiles: oldConstants.files,
      duplicateComponents: duplicates.total,
      frozenAttributeMissing: missingAttributes.length,
      frozenTestidMissing: missingTestids.length,
      unresolvedScriptSelectors: scripts.unresolved.length,
    },
    oldConstants,
    duplicates,
    frozen: {
      attributes: frozen.attributes,
      testids: frozen.testids,
      missingAttributes,
      missingTestids,
    },
    inventory: {
      staticTestids: frozen.inventory.staticIds.size,
      dynamicTemplates: frozen.inventory.dynamicTemplates.size,
      dynamicPrefixes: [...frozen.inventory.dynamicPrefixes].sort(),
      scriptSelectors: scripts.total,
      scriptSelectorsResolved: scripts.resolved.length,
      unresolvedScriptSelectors: scripts.unresolved.map((selector) => ({
        operator: selector.operator,
        value: selector.value,
        kind: selector.kind,
        files: selector.files,
      })),
    },
    notes: [
      'report-only：默认退出码 0；--fail 才在 P0/P1 > 0 时退出 1；不接 CI。',
      '旧常量只统计定义行；usages（className={PRIMARY_BUTTON}）不重复计数。',
      '冻结 testid 是静态存在性检查；动态拼接 id 的运行时存在性不在本脚本证明范围内。',
      'testid 清单为提示项：无法静态解析的脚本选择器只列 P2，不据此判定选择器已损坏。',
    ],
  };
  return report;
}

function printFrozen(report) {
  const attributeText = report.frozen.attributes
    .map((attribute) => `${attribute.name}×${attribute.count}${attribute.present ? '' : '（缺失）'}`)
    .join(' / ');
  const missingTestids = report.frozen.testids.filter((testid) => !testid.present);
  console.log(
    `[冻结契约属性] ${report.frozen.attributes.length - report.frozen.missingAttributes.length}/${report.frozen.attributes.length} 存在（P0）`,
  );
  console.log(`  ${attributeText}`);
  console.log(
    `[冻结 testid] ${report.frozen.testids.length - missingTestids.length}/${report.frozen.testids.length} 存在（P1）`,
  );
  if (missingTestids.length) {
    for (const testid of missingTestids) console.log(`  - 缺失：${testid.id}`);
  }
}


function printInventory(report) {
  console.log(
    `[testid 清单] 静态唯一 ${report.inventory.staticTestids}；动态模板 ${report.inventory.dynamicTemplates}；` +
      `scripts 依赖 ${report.inventory.scriptSelectors}（可解析 ${report.inventory.scriptSelectorsResolved}；` +
      `无法静态解析 ${report.inventory.unresolvedScriptSelectors.length}，P2 提示）`,
  );
  for (const selector of report.inventory.unresolvedScriptSelectors.slice(0, 8)) {
    console.log(`  - 提示：${selector.operator === '^=' ? '^=' : '='}${JSON.stringify(selector.value)}（${selector.files.join(', ')}）`);
  }
  if (report.inventory.unresolvedScriptSelectors.length > 8) {
    console.log(`  … 另 ${report.inventory.unresolvedScriptSelectors.length - 8} 条（--json 全量）`);
  }
}

function printHuman(report) {
  const line = '─'.repeat(78);
  console.log(`check-ui-selectors v${report.version} · UI 选择器 / 组件冒烟（report-only，不阻断）`);
  console.log(`仓库: ${report.repo}`);
  console.log(`HEAD: ${report.head}`);
  if (report.mode === 'diff') {
    console.log(`Base: ${report.base.ref}@${report.base.mergeBase}（merge-base；仅新增行）`);
  } else {
    console.log(`范围: ${report.scope.source}（${report.scope.files} 文件）`);
  }
  console.log(line);

  console.log(
    `[汇总] 问题 ${report.totals.issues}（P0 ${report.totals.p0} / P1 ${report.totals.p1} / P2 ${report.totals.p2}）`,
  );

  console.log('');
  console.log(
    `[旧常量] 定义 ${report.totals.oldConstants} 处 / ${report.totals.oldConstantFiles} 文件（P1；G2 旧常量清单）`,
  );
  if (!report.oldConstants.total) {
    console.log('  PASS：未发现旧常量定义');
  } else {
    console.log(`  按名称：${report.oldConstants.byName.map((item) => `${item.name}×${item.count}`).join(' / ')}`);
    for (const hotspot of report.oldConstants.hotspots.slice(0, 12)) {
      console.log(`  ${hotspot.path}  ×${hotspot.count}`);
    }
    if (report.oldConstants.hotspots.length > 12) {
      console.log(`  … 另 ${report.oldConstants.hotspots.length - 12} 个文件（--json 全量）`);
    }
    if (report.mode !== 'diff') {
      console.log(`  前 5 处：`);
      for (const hit of report.oldConstants.hits.slice(0, 5)) {
        console.log(`    ${hit.path}:${hit.line}  ${hit.name}  ${hit.text}`);
      }
    }
  }

  console.log('');
  console.log(
    `[ui/ 外重复组件] ${report.duplicates.total}（P1；共享组件只能在 ${UI_ROOT}）`,
  );
  if (!report.duplicates.total) console.log('  PASS：components/ui/ 之外没有同名文件或同名导出');
  for (const item of report.duplicates.items) console.log(`  - ${item.path}（${item.name}；${item.reason}）`);

  console.log('');
  printFrozen(report);
  console.log('');
  printInventory(report);

  console.log(line);
  console.log('提示：本脚本只报告，不阻断；默认退出码 0，--fail 才在 P0/P1 > 0 时退出 1。');
  console.log('      静态扫描不启动浏览器；动态拼接的 id 只作提示，不证明运行时一定存在；未接 CI。');
  console.log('用法：node scripts/check-ui-selectors.mjs [--diff <base>] [--baseline] [--json] [--fail]');
}

function printBaseline(report) {
  const line = '─'.repeat(78);
  console.log(`check-ui-selectors v${report.version} · 基线汇总（report-only，不阻断）`);
  console.log(`HEAD: ${report.head}`);
  console.log(`范围: ${report.scope.source}（${report.scope.files} 文件，全量）`);
  console.log(line);

  console.log('[基线计数]');
  console.log(`  旧常量定义：${report.totals.oldConstants} 处 / ${report.totals.oldConstantFiles} 文件（P1）`);
  console.log(`  ui/ 外重复组件：${report.totals.duplicateComponents}（P1）`);
  console.log(`  冻结契约属性缺失：${report.totals.frozenAttributeMissing}（P0）`);
  console.log(`  冻结 testid 缺失：${report.totals.frozenTestidMissing}（P1）`);
  console.log(`  无法静态解析的脚本选择器：${report.totals.unresolvedScriptSelectors}（P2 提示）`);
  console.log(
    `  合计：问题 ${report.totals.issues}（P0 ${report.totals.p0} / P1 ${report.totals.p1} / P2 ${report.totals.p2}）`,
  );

  console.log('');
  console.log('[旧常量分布]（按文件，前 10）');
  for (const hotspot of report.oldConstants.hotspots.slice(0, 10)) {
    console.log(`  ${hotspot.path}  ×${hotspot.count}`);
  }

  console.log('');
  console.log('[testid 清单]');
  console.log(
    `  静态唯一 ${report.inventory.staticTestids}；动态模板 ${report.inventory.dynamicTemplates}；` +
      `scripts 依赖 ${report.inventory.scriptSelectors}（无法静态解析 ${report.inventory.unresolvedScriptSelectors.length}）`,
  );

  console.log('');
  console.log('[复核命令]');
  console.log('  node scripts/check-ui-selectors.mjs --baseline');
  console.log('  node scripts/check-ui-selectors.mjs --json');
  console.log(line);
  console.log('注意：基线含存量，**不是门禁通过**；--diff <base> 才只看新增。');
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测（注入反例；失败退出码 1）
// ─────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const checks = [];
  const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });

  check('旧常量 PRIMARY_BUTTON', oldConstantName('const PRIMARY_BUTTON =') === 'PRIMARY_BUTTON');
  check('旧常量 OPTION_BASE', oldConstantName('const OPTION_BASE =') === 'OPTION_BASE');
  check('旧常量 CARD', oldConstantName('const CARD =') === 'CARD');
  check('不误伤 CARD_EST_HEIGHT', oldConstantName('const CARD_EST_HEIGHT = 10') === null);
  check('不误伤 ACTION_ITEM', oldConstantName('const ACTION_ITEM = 10') === null);
  check('小写字符串常量命中', oldConstantName("const primaryButton = 'inline-flex'") === 'primaryButton');
  check('小写 JSX 局部变量不命中', oldConstantName('const secondaryButton = secondary ? (') === null);
  check('usage 不算定义', oldConstantName('className={PRIMARY_BUTTON}') === null);

  check('共享组件同名文件（ui/ 外）', sharedNameForPath('frontend/src/components/Button.tsx') === 'Button');
  check('共享组件同名文件（ui/ 内）', sharedNameForPath('frontend/src/components/ui/Button.tsx') === null);
  check('普通组件不判重复', sharedNameForPath('frontend/src/components/TodayWorkbench.tsx') === null);
  check('同名导出判重复', sharedExportName('export function Card() {}') === 'Card');
  check('同名 const 导出判重复', sharedExportName('export const Dialog = () => null') === 'Dialog');
  check('re-export 判重复', sharedExportName('export { Card } from "./x"') === 'Card');

  const inventory = {
    staticIds: new Set(['app-shell', 'reader-en-0', 'book-series-screen']),
    dynamicTemplates: new Set(['reader-en-${index}', 'book-series-book-${book.id}', '${testId}-overlay']),
    dynamicPrefixes: new Set(['reader-en-', 'book-series-book-']),
    dynamicSuffixes: new Set(['-overlay']),
  };
  check('testid 静态解析', resolvesTestid('app-shell', inventory) === 'static');
  check('testid 动态前缀解析', resolvesTestid('reader-en-2', inventory) === 'dynamic-prefix');
  check('testid 动态后缀反查', resolvesTestid('app-shell-overlay', inventory) === 'dynamic-suffix');
  check('testid 无法解析返回 null', resolvesTestid('missing-id', inventory) === null);

  const declarations = testidDeclarations('data-testid="app-shell" testId="x" data-testid={`reader-en-${i}`}');
  check('testid 声明提取（静态）', declarations.some((item) => item.value === 'app-shell' && !item.dynamic));
  check('testid 声明提取（testId prop）', declarations.some((item) => item.value === 'x' && !item.dynamic));
  check(
    'testid 声明提取（动态模板）',
    declarations.some((item) => item.dynamic && item.prefix === 'reader-en-'),
  );

  const diffSample = [
    '+++ b/frontend/src/components/ReviewScreen.tsx',
    '@@ -106,0 +107,2 @@',
    '+const PRIMARY_BUTTON =',
    "+const primaryButton = 'inline-flex'",
  ].join('\n');
  const parsed = parseUnifiedDiff(diffSample);
  check('diff 解析行号', parsed[0]?.line === 107 && parsed[1]?.line === 108);
  check('diff 跳过测试文件', parseUnifiedDiff('+++ b/frontend/src/__tests__/x.tsx\n@@ -1,0 +1,1 @@\n+const CARD =').length === 0);
  check('diff 跳过 .md', parseUnifiedDiff('+++ b/docs/x.md\n@@ -1,0 +1,1 @@\n+const CARD =').length === 0);

  check('冻结属性清单含 data-word-hit', CONTRACT_ATTRIBUTES.includes('data-word-hit'));
  check('冻结 testid 清单含 word-popover', FROZEN_TESTIDS.includes('word-popover'));
  check('ui/ 路径识别', isUiPath('frontend/src/components/ui/Button.tsx') && !isUiPath('frontend/src/components/Button.tsx'));

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`);
  console.log(`\nself-test: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length}）`);
  if (failed.length) process.exitCode = 1;
}

// ─────────────────────────────────────────────────────────────────────────────
// main
// ─────────────────────────────────────────────────────────────────────────────

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (opts.selfTest) {
    selfTest();
    return;
  }

  const report = buildReport(opts);
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else if (opts.baseline) printBaseline(report);
  else printHuman(report);

  if (opts.fail) {
    const blocking = report.totals.p0 + report.totals.p1;
    if (blocking > 0) {
      console.error(
        `FAIL  --fail：P0 ${report.totals.p0} + P1 ${report.totals.p1} = ${blocking} 项；` +
          '先修 / 登记例外，或用 --diff 只看新增。',
      );
      process.exitCode = 1;
    } else {
      console.log('PASS  --fail：无 P0/P1 命中。');
    }
  }
}

main();
