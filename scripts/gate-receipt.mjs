#!/usr/bin/env node
/**
 * gate-receipt.mjs · 设计门禁回执（gate receipt）
 *
 * 用途（design-gate.md §2.4 / §4.2）：
 *   一条只读命令输出 PR 评审需要的机械证据：HEAD SHA、相对 base 的变更文件、
 *   T1–T8 触发判定、G1（A2 T-01…T-15 字面量）、G2（重复组件）、G4（对话框/键盘）、
 *   G6（移动端旧视口）、T-13（三处底色一致）、check:i18n 末行，以及建议的 PR 勾选。
 *
 * 定位：**先只报告，不阻断**。本脚本不判定 P0，也不替代 G3/G5/G7/G8 的人眼走查；
 *   P0 由评审按 design-gate.md §3.1 判定。默认退出码 0（内部错误除外）。
 *
 * 用法：
 *   node scripts/gate-receipt.mjs                    # 默认 base: origin/main → upstream/main → main
 *   node scripts/gate-receipt.mjs --base origin/main  # 指定 base（PR 的 base 分支）
 *   node scripts/gate-receipt.mjs --no-i18n           # 跳过 npm run check:i18n
 *   node scripts/gate-receipt.mjs --json              # 机器可读输出
 *   node scripts/gate-receipt.mjs --self-test         # 注入反例自测（开发用；失败退出码 1）
 *   node scripts/gate-receipt.mjs --help
 *
 * 无第三方依赖，Node ≥ 18（CI Node 22）。只读：不写文件、不改 git 状态。
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.2';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');

const USAGE = `gate-receipt v${VERSION} · 设计门禁回执（report-only，不阻断）

用法：
  node scripts/gate-receipt.mjs                    默认 base: origin/main → upstream/main → main
  node scripts/gate-receipt.mjs --base <ref>        指定 PR base（如 origin/main）
  node scripts/gate-receipt.mjs --no-i18n           跳过 npm run check:i18n
  node scripts/gate-receipt.mjs --json              输出 JSON（供后续 CI/warn 接入）
  node scripts/gate-receipt.mjs --self-test         运行注入反例自测
  node scripts/gate-receipt.mjs --help

输出：HEAD sha、变更文件、T1–T8 触发判定、G1/G2/G4/G6 机械计数、T-13 底色、
      check:i18n 末行、建议 PR 勾选。只报告，不阻断；P0 由评审按 design-gate.md §3.1 判定。`;

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { base: null, i18n: true, json: false, selfTest: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--no-i18n') opts.i18n = false;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--self-test') opts.selfTest = true;
    else if (arg === '--base') {
      opts.base = argv[i + 1];
      i += 1;
      if (!opts.base) fail('--base 需要一个 ref');
    } else if (arg.startsWith('--base=')) {
      opts.base = arg.slice('--base='.length);
    } else {
      fail(`未知参数：${arg}\n\n${USAGE}`);
    }
  }
  return opts;
}

function fail(message) {
  console.error(`ERR  ${message}`);
  process.exit(2);
}

// ─────────────────────────────────────────────────────────────────────────────
// git helpers
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
    signal: result.signal,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    error: result.error ?? null,
  };
}

function git(args, options = {}) {
  return run('git', ['-c', 'core.quotepath=false', '--no-pager', ...args], options);
}

function gitOk(args) {
  const result = git(args);
  return result.code === 0 ? result.stdout.trim() : null;
}

function lastNonEmpty(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length ? lines[lines.length - 1] : '';
}

function resolveBase(explicit) {
  if (explicit) {
    const commit = gitOk(['rev-parse', '--verify', '--quiet', `${explicit}^{commit}`]);
    if (!commit) fail(`base 不存在：${explicit}`);
    return explicit;
  }
  const envBase = process.env.GATE_BASE?.trim();
  if (envBase) {
    const commit = gitOk(['rev-parse', '--verify', '--quiet', `${envBase}^{commit}`]);
    if (commit) return envBase;
  }
  for (const ref of ['origin/main', 'upstream/main', 'main', 'master']) {
    const commit = gitOk(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    if (commit) return ref;
  }
  return null;
}

function shortSha(value) {
  return value ? value.slice(0, 7) : '(no-head)';
}

function normalizeStatus(status) {
  if (status === '??') return 'A';
  return status || 'M';
}

function parseNameStatus(text) {
  const files = new Map();
  for (const line of String(text).split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [status, ...rest] = line.split('\t');
    const path = rest.join('\t');
    if (!path) continue;
    files.set(path, { path, status: normalizeStatus(status.trim()), untracked: false });
  }
  return files;
}

function collectChanges(diffRef, headExists) {
  const files = new Map();
  if (diffRef) {
    const diff = git(['diff', '--name-status', '--no-renames', diffRef]);
    if (diff.code !== 0) fail(`git diff 失败：${diff.stderr.trim() || diffRef}`);
    for (const [path, meta] of parseNameStatus(diff.stdout)) files.set(path, meta);
  } else if (headExists) {
    for (const [path, meta] of parseNameStatus(gitOrEmpty(['diff', '--name-status', '--no-renames', 'HEAD']))) {
      files.set(path, meta);
    }
    for (const [path, meta] of parseNameStatus(gitOrEmpty(['diff', '--cached', '--name-status', '--no-renames']))) {
      files.set(path, meta);
    }
  } else {
    for (const [path, meta] of parseNameStatus(gitOrEmpty(['status', '--porcelain=v1']))) {
      files.set(path, meta);
    }
  }

  const untracked = gitOk(['ls-files', '--others', '--exclude-standard']) ?? '';
  for (const path of untracked.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!files.has(path)) files.set(path, { path, status: 'A', untracked: true });
    else files.get(path).untracked = true;
  }

  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

function gitOrEmpty(args) {
  const result = git(args);
  return result.code === 0 ? result.stdout : '';
}

// ─────────────────────────────────────────────────────────────────────────────
// 触发判定（design-gate.md §1.1 T1–T8）
// ─────────────────────────────────────────────────────────────────────────────

function classifyPath(path) {
  const hits = [];
  if (/^frontend\/src\/components\//.test(path)) hits.push('T1');
  if (/^frontend\/src\/(?:App|main)\.tsx$/.test(path)) hits.push('T2');
  if (/^frontend\/src\/.*\.css$/.test(path)) hits.push('T3');
  if (/^frontend\/(?:tailwind|postcss)\.config\.(?:js|ts|cjs)$/.test(path)) hits.push('T4');
  if (/^frontend\/(?:index\.html|public\/manifest\.webmanifest)$/.test(path)) hits.push('T5');
  if (/^frontend\/src\/(?:i18n\/.*\.json|lib\/i18n\/)/.test(path)) hits.push('T6');
  if (/^frontend\/src\/lib\/(?:nav|useNav|navTabs)\.ts$/.test(path)) hits.push('T7');
  if (hits.length) return hits;

  if (/^frontend\/src\//.test(path)) return ['T8?'];
  if (/^frontend\/(?:package\.json|package-lock\.json)$/.test(path)) return ['T8?'];
  if (/^\.github\//.test(path) || /^frontend\/scripts\//.test(path) || path === 'scripts/gate-receipt.mjs') {
    return ['GUARD'];
  }
  return [];
}

function summarizeTrigger(triggeredFiles) {
  const formal = new Set();
  let t8 = false;
  let guard = false;
  for (const file of triggeredFiles) {
    for (const hit of file.triggers) {
      if (hit.startsWith('T') && hit !== 'T8?') formal.add(hit);
      if (hit === 'T8?') t8 = true;
      if (hit === 'GUARD') guard = true;
    }
  }
  if (formal.size) {
    return {
      triggered: true,
      kind: 'triggered',
      hits: [...formal].sort(),
      t8,
      guard,
      summary: `触发设计门禁（${[...formal].sort().join('、')}）`,
    };
  }
  if (t8) {
    return {
      triggered: false,
      kind: 't8',
      hits: [],
      t8,
      guard,
      summary: '未命中 T1–T7；存在 T8 候选，需人工判断是否改变用户可见层级/跳转/操作方式',
    };
  }
  if (guard) {
    return {
      triggered: false,
      kind: 'guard',
      hits: [],
      t8,
      guard,
      summary: '不套 8 项设计门禁；含门禁自身文件（GUARD），按「门禁自身」评审',
    };
  }
  return { triggered: false, kind: 'none', hits: [], t8, guard, summary: '未触发（可勾「跳过设计门禁」）' };
}

// ─────────────────────────────────────────────────────────────────────────────
// 新增行收集（含未提交改动与未跟踪文件）
// ─────────────────────────────────────────────────────────────────────────────

function collectAddedLines(diffRef, changes) {
  const records = [];
  if (diffRef) {
    const diff = git(['diff', '-U0', '--no-color', '--no-renames', diffRef, '--', 'frontend/src']);
    if (diff.code !== 0) fail(`git diff frontend/src 失败：${diff.stderr.trim()}`);
    records.push(...parseUnifiedDiff(diff.stdout));
  }

  for (const file of changes) {
    if (!file.untracked) continue;
    if (!/^frontend\/src\//.test(file.path)) continue;
    if (!/\.(?:tsx|ts|css)$/.test(file.path)) continue;
    if (/\.test\.(?:ts|tsx)$/.test(file.path) || /\/__tests__\//.test(file.path)) continue;
    const lines = readFileLines(file.path);
    lines.forEach((text, index) => records.push({ path: file.path, line: index + 1, text, untracked: true }));
  }

  return records.filter((record) => {
    if (!/\.(?:tsx|ts|css)$/.test(record.path)) return false;
    if (/\.test\.(?:ts|tsx)$/.test(record.path) || /\/__tests__\//.test(record.path)) return false;
    return true;
  });
}

function parseUnifiedDiff(text) {
  const records = [];
  let path = null;
  let newLine = 0;
  for (const raw of String(text).split(/\r?\n/)) {
    if (raw.startsWith('+++ ')) {
      const value = raw.slice(4).trim();
      path = value.startsWith('b/') ? value.slice(2) : value;
      continue;
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      newLine = match ? Number.parseInt(match[1], 10) : 0;
      continue;
    }
    if (!path) continue;
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      records.push({ path, line: newLine, text: raw.slice(1), untracked: false });
      newLine += 1;
    } else if (raw.startsWith(' ')) {
      newLine += 1;
    }
  }
  return records;
}

const lineCache = new Map();
function readFileLines(path) {
  if (lineCache.has(path)) return lineCache.get(path);
  const absolute = join(REPO_ROOT, path);
  let lines = [];
  try {
    lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
  } catch {
    lines = [];
  }
  lineCache.set(path, lines);
  return lines;
}

// ─────────────────────────────────────────────────────────────────────────────
// G1 · 设计字面量（A2 §13 T-01…T-15）
// ─────────────────────────────────────────────────────────────────────────────

function colorClassRegex(families) {
  return new RegExp(
    `(?:bg|text|border|ring|from|via|to|fill|stroke|decoration|outline|divide|placeholder|caret|accent|shadow)-(?:${families})(?:-\\d{2,3})?(?:\\/[\\d.]+)?(?![\\w-])`,
  );
}

const G1_RULES = [
  {
    id: 'T-01',
    severity: 'P0',
    label: 'hex / rgb / hsl 裸色值',
    test: (text) => /(?<![&\w])#(?:[0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])|\brgba?\(|\bhsla?\(/.test(text),
  },
  {
    id: 'T-02',
    severity: 'P1',
    label: 'border-white/5|10',
    test: (text) => /border-white\/(?:5|10)(?![\w-])/.test(text),
  },
  {
    id: 'T-03',
    severity: 'P0',
    label: 'text-zinc-600',
    test: (text) => /text-zinc-600(?![\w-])/.test(text),
  },
  {
    id: 'T-04a',
    severity: 'P0',
    label: 'blue-* / purple-*',
    test: (text) => colorClassRegex('blue|purple').test(text),
  },
  {
    id: 'T-04b',
    severity: 'P1',
    label: 'violet-* / sky-* / pink-*',
    test: (text) => colorClassRegex('violet|sky|pink').test(text),
  },
  {
    id: 'T-04c',
    severity: 'P1',
    label: 'red-* / emerald-* / amber-*（应走 danger/success/warning）',
    test: (text) => colorClassRegex('red|emerald|amber').test(text),
  },
  {
    id: 'T-04d',
    severity: 'P1',
    label: 'white-* / black-*（应走 surface/state/overlay token）',
    test: (text) => colorClassRegex('white|black').test(text),
  },
  {
    id: 'T-04e',
    severity: 'P1',
    label: 'zinc-*（600 以外，应走 fg/surface token）',
    test: (text) =>
      /(?:bg|text|border|ring|from|via|to|fill|stroke|decoration|outline|divide|placeholder|caret|accent|shadow)-zinc-(?!600(?![\d]))\d{2,3}(?:\/[\d.]+)?(?![-\w])/.test(
        text,
      ),
  },
  {
    id: 'T-05',
    severity: 'P1',
    label: '任意字号 text-[…]（改用 micro/caption/ui/section/dialog）',
    test: (text) => /text-\[[^\]]+\]/.test(text),
  },
  {
    id: 'T-06',
    severity: 'P0',
    label: '9/10px 字号',
    test: (text) => /text-\[(?:9|10)px\]/.test(text),
  },
  {
    id: 'T-07',
    severity: 'P1',
    label: 'shadow-*（elev-1/2/3 以外）',
    test: (text) => /shadow-(?!elev-|none(?![\w-]))[a-z0-9[]/.test(text),
  },
  {
    id: 'T-08a',
    severity: 'P0',
    label: 'z-[N] 任意层级',
    test: (text) => /(?<![-\w])z-\[[^\]]+\](?![-\w])/.test(text),
  },
  {
    id: 'T-08b',
    severity: 'P1',
    label: 'z-* 非 token（不是 8 个 token）',
    test: (text) => /(?<![-\w])z-\d+(?![-\w])/.test(text),
  },
  {
    id: 'T-09',
    severity: 'P1',
    label: 'h-screen / min-h-screen / Nvh（dvh 唯一）',
    test: (text) => /(?<![-\w])(?:min-)?h-screen\b|(?<![-\w])\d+(?:\.\d+)?vh(?![-\w])/.test(text),
  },
  {
    id: 'T-10',
    severity: 'P2',
    label: 'zinc-900/[30|60|90|95]',
    test: (text) => /zinc-900\/(?:30|60|90|95)(?!\d)/.test(text),
  },
  {
    id: 'T-14a',
    severity: 'P2',
    label: 'transition-all',
    test: (text) => /transition-all\b/.test(text),
  },
  {
    id: 'T-14b',
    severity: 'P2',
    label: '裸 transition（应写具体属性或 transition-[…]）',
    test: (text) => /(?<![-\w])transition(?![-\w])/.test(text),
  },
  {
    id: 'T-15',
    severity: 'P2',
    label: 'hover:scale / active:scale-[0.95]',
    test: (text) =>
      /(?<![-\w])hover:scale-|(?<![-\w])active:scale-(?:\[0?\.?95\]|95)(?![-\w])/.test(text),
  },
];

function t11LineMatch(text) {
  const h8or9 = /(?<![-\w])(?:h-8|h-9)(?![-\w])/.test(text);
  const h10 = /(?<![-\w])h-10(?![-\w])/.test(text);
  return (h8or9 && /rounded-xl\b/.test(text)) || (h10 && /rounded-full\b/.test(text));
}

const G1_T11 = { id: 'T-11', severity: 'P2', label: '圆角-高度映射（h-8/h-9+rounded-xl、h-10+rounded-full）' };

function g1RuleIds(text) {
  const ids = G1_RULES.filter((rule) => rule.test(text)).map((rule) => rule.id);
  if (t11LineMatch(text)) ids.push(G1_T11.id);
  return ids;
}

function scanG1(addedLines) {
  const ruleHits = new Map();
  for (const rule of [...G1_RULES, G1_T11]) ruleHits.set(rule.id, { ...rule, hits: [] });

  const lineSeverity = new Map();
  const lineRules = new Map();

  for (const record of addedLines) {
    const matchedRules = G1_RULES.filter((rule) => rule.test(record.text));
    if (t11LineMatch(record.text)) matchedRules.push(G1_T11);

    for (const rule of matchedRules) {
      ruleHits.get(rule.id).hits.push(record);
    }
    if (!matchedRules.length) continue;

    const key = `${record.path}:${record.line}`;
    const severities = matchedRules.map((rule) => rule.severity);
    const rank = { P0: 0, P1: 1, P2: 2 };
    const current = lineSeverity.get(key);
    const best = severities.sort((a, b) => rank[a] - rank[b])[0];
    if (!current || rank[best] < rank[current]) lineSeverity.set(key, best);
    const ids = lineRules.get(key) ?? new Set();
    for (const rule of matchedRules) ids.add(rule.id);
    lineRules.set(key, ids);
  }

  const rules = [...ruleHits.values()].filter((rule) => rule.hits.length > 0);
  const p0 = [...lineSeverity.values()].filter((severity) => severity === 'P0').length;
  const p1 = [...lineSeverity.values()].filter((severity) => severity === 'P1').length;
  const p2 = [...lineSeverity.values()].filter((severity) => severity === 'P2').length;

  return {
    total: lineSeverity.size,
    p0,
    p1,
    p2,
    rules,
    lines: [...lineRules.entries()].map(([key, ids]) => ({ key, ids: [...ids] })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// T-13 · 三处底色一致
// ─────────────────────────────────────────────────────────────────────────────

function normalizeHex(value) {
  if (!value) return null;
  const text = String(value).trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(text) ? text : text;
}

function readText(path) {
  try {
    return readFileSync(join(REPO_ROOT, path), 'utf8');
  } catch {
    return '';
  }
}

function scanAppBackground() {
  const html = readText('frontend/index.html');
  const css = readText('frontend/src/index.css');
  const manifestText = readText('frontend/public/manifest.webmanifest');

  let manifest = {};
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    manifest = {};
  }

  const htmlMatch =
    html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i);
  const cssMatch = css.match(/--app-bg:\s*([^;]+);/);
  const channels = cssMatch
    ? cssMatch[1]
        .trim()
        .split(/\s+/)
        .map((part) => Number.parseInt(part, 10))
        .filter((part) => Number.isFinite(part))
    : [];
  const cssHex =
    channels.length === 3
      ? `#${channels
          .map((channel) => Math.max(0, Math.min(255, channel)).toString(16).padStart(2, '0'))
          .join('')}`
      : null;

  const values = {
    'index.html theme-color': normalizeHex(htmlMatch?.[1]),
    'manifest theme_color': normalizeHex(manifest.theme_color),
    'manifest background_color': normalizeHex(manifest.background_color),
    'index.css --app-bg': normalizeHex(cssHex),
  };
  const present = Object.values(values).filter(Boolean);
  const unique = new Set(present.map((value) => value.toLowerCase()));
  const ok = present.length === Object.keys(values).length && unique.size === 1;

  return { ok, values, unique: [...unique] };
}

// ─────────────────────────────────────────────────────────────────────────────
// G2 · 组件没有出第二份
// ─────────────────────────────────────────────────────────────────────────────

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

const OLD_CONST_RE = new RegExp(`\\bconst\\s+(?:${OLD_CONSTANTS.join('|')})\\b`);
// 小写旧常量只认「字符串字面量」定义（ShareCardDialog/ReaderScreen 的 class 字符串）；
// `const secondaryButton = secondary ? (` 这类 JSX 局部变量不是重复组件。
const OLD_LOWER_CONST_RE =
  /\bconst\s+(?:primaryButton|secondaryButton|tintedButton|dangerButton|ghostButton)\s*(?::[^=]+)?=\s*['"`]/;

function isOldConstantLine(text) {
  return OLD_CONST_RE.test(text) || OLD_LOWER_CONST_RE.test(text);
}

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

function isUiPath(path) {
  return /^frontend\/src\/components\/ui\//.test(path);
}

function sharedComponentForPath(path) {
  if (isUiPath(path)) return null; // ui/ 是唯一白名单，不算“第二份”
  const name = basename(path).replace(/\.(?:tsx|ts)$/, '');
  return SHARED_COMPONENTS.has(name) ? name : null;
}

function exportsSharedComponent(content) {
  for (const name of SHARED_COMPONENTS) {
    const re = new RegExp(`export\\s+(?:default\\s+)?(?:function|const|class)\\s+${name}\\b`);
    if (re.test(content)) return name;
  }
  return null;
}

function scanG2(addedLines, changes) {
  const constHits = addedLines.filter((record) => isOldConstantLine(record.text));

  const addedComponentFiles = changes.filter(
    (file) => file.status === 'A' && /^frontend\/src\/components\/.*\.(?:tsx|ts)$/.test(file.path),
  );
  const newUiFiles = addedComponentFiles.filter((file) => isUiPath(file.path));
  const outsideUiFiles = addedComponentFiles.filter((file) => !isUiPath(file.path));

  const duplicateFiles = [];
  for (const file of outsideUiFiles) {
    const content = readText(file.path);
    const byPath = sharedComponentForPath(file.path);
    const byExport = exportsSharedComponent(content);
    if (byPath || byExport) {
      duplicateFiles.push({
        path: file.path,
        matches: [...new Set([byPath, byExport].filter(Boolean))],
      });
    }
  }

  const duplicateHits = constHits.map((record) => ({
    path: record.path,
    line: record.line,
    text: record.text.trim().replace(/\s+/g, ' ').slice(0, 120),
  }));

  return {
    total: constHits.length + duplicateFiles.length,
    oldConstants: constHits.length,
    duplicateFiles,
    newUiFiles: newUiFiles.map((file) => file.path),
    outsideUiFiles: outsideUiFiles.map((file) => file.path),
    hits: duplicateHits,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G4 · 对话框与键盘
// ─────────────────────────────────────────────────────────────────────────────

function looksLikeInputField(text) {
  return /<(?:input|textarea|select)\b/.test(text) || /focus-within/.test(text);
}

function isInputShellCandidate(record) {
  if (looksLikeInputField(record.text)) return true;
  const lines = readFileLines(record.path);
  if (!lines.length || !record.line) return false;
  const index = record.line - 1;
  const start = Math.max(0, index - 6);
  const end = Math.min(lines.length, index + 7);
  return lines.slice(start, end).some((line) => looksLikeInputField(line));
}

function scanG4(addedLines) {
  const confirmHits = addedLines.filter((record) => /window\.(?:confirm|alert)\s*\(/.test(record.text));
  const outlineHits = addedLines.filter((record) => /outline-none/.test(record.text));
  const outlineCandidates = outlineHits.filter((record) => isInputShellCandidate(record));
  const outlineViolations = outlineHits.filter((record) => !isInputShellCandidate(record));

  return {
    total: confirmHits.length + outlineViolations.length,
    confirmHits,
    outlineHits,
    outlineCandidates,
    outlineViolations,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// G6 · 移动端
// ─────────────────────────────────────────────────────────────────────────────

function scanG6(addedLines) {
  const hits = addedLines.filter((record) =>
    /(?<![-\w])(?:min-)?h-screen\b|(?<![-\w])\d+(?:\.\d+)?vh(?![-\w])/.test(record.text),
  );
  return { total: hits.length, hits };
}

// ─────────────────────────────────────────────────────────────────────────────
// check:i18n
// ─────────────────────────────────────────────────────────────────────────────

function runI18nCheck(enabled) {
  if (!enabled) return { status: 'SKIP', reason: '--no-i18n', lastLine: '', exitCode: null };
  if (!existsSync(join(REPO_ROOT, 'frontend', 'node_modules'))) {
    return {
      status: 'SKIP',
      reason: 'frontend/node_modules 不存在（先 cd frontend && npm ci）',
      lastLine: '',
      exitCode: null,
    };
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = run('npm', ['run', 'check:i18n'], {
    cwd: join(REPO_ROOT, 'frontend'),
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) {
    return { status: 'ERROR', reason: String(result.error.message || result.error), lastLine: '', exitCode: null };
  }

  const stdoutLine = lastNonEmpty(result.stdout);
  const stderrLine = lastNonEmpty(result.stderr);
  const passed = result.code === 0;
  return {
    status: passed ? 'PASS' : 'FAIL',
    reason: '',
    lastLine: (passed ? stdoutLine : stderrLine) || stdoutLine || stderrLine || '(no output)',
    exitCode: result.code,
    warnings: (result.stderr || '')
      .split(/\r?\n/)
      .filter((line) => /^WARN/.test(line.trim()))
      .length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

function truncate(text, max = 120) {
  const value = String(text).trim().replace(/\s+/g, ' ');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function formatExamples(records, max = 2) {
  return records.slice(0, max).map((record) => `${record.path}:${record.line}  ${truncate(record.text)}`);
}

function buildSuggestions(report) {
  const lines = [];
  lines.push(`HEAD ${report.head.short}（PR 首行）`);
  lines.push(`证据/截图文件名后缀 @${report.head.short}`);
  lines.push(`触发：${report.trigger.summary}`);

  if (report.trigger.triggered) {
    const mechanical = [
      ['G1', report.g1.total],
      ['G2', report.g2.total],
      ['G4', report.g4.total],
      ['G6', report.g6.total],
    ];
    for (const [gate, count] of mechanical) {
      const extra = gate === 'G1' && !report.g1.t13.ok ? '；T-13 底色三处 FAIL' : '';
      lines.push(
        count === 0
          ? `${gate}：机械计数 0 → 可判「是」（仍需人眼证据）${extra}`
          : `${gate}：机械计数 ${count} → 先修或按 §5 登记例外，不建议直接勾「是」${extra}`,
      );
    }
    lines.push('G3 / G5 / G7 / G8：receipt 不覆盖，按 5 分钟走查补截图/hash 序列');
    lines.push(
      `G7 的 check:i18n：${report.i18n.status}${
        report.i18n.lastLine ? ` — ${report.i18n.lastLine}` : ''
      }`,
    );
  } else if (report.trigger.kind === 't8') {
    lines.push('T8 待判定：若改变用户可见层级/跳转/操作方式 → 按触发 PR 处理；否则勾「跳过」并写原因');
  } else if (report.trigger.kind === 'guard') {
    lines.push('门禁自身文件：不套 8 项；PR 需标注「门禁自身」并说明不会放松门禁');
  } else {
    lines.push('未触发：勾「本次为纯后端 / 文档 / 无用户可见改动，跳过设计门禁」并写原因');
  }
  lines.push('receipt 只给机械证据，不判定 P0；P0 由评审按 design-gate.md §3.1 阻断');
  return lines;
}

function buildReport(opts) {
  if (gitOk(['rev-parse', '--is-inside-work-tree']) !== 'true') {
    fail(`不是 git 仓库：${REPO_ROOT}`);
  }

  const headFull = gitOk(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const headExists = Boolean(headFull);
  const head = { full: headFull ?? '(no-head)', short: shortSha(headFull) };

  const baseRef = headExists ? resolveBase(opts.base) : null;
  let mergeBase = null;
  let diffRef = null;
  let baseNote = '';
  if (headExists) {
    if (baseRef) {
      mergeBase = gitOk(['merge-base', 'HEAD', baseRef]);
      diffRef = mergeBase || baseRef;
      baseNote = mergeBase
        ? `${baseRef}@${shortSha(mergeBase)}（merge-base；含工作区改动）`
        : `${baseRef}（无 merge-base，直接 diff）`;
    } else {
      diffRef = 'HEAD';
      baseNote = '未找到 origin/main / upstream/main / main；以 HEAD 为基线（仅统计工作区改动）';
    }
  } else {
    baseNote = '仓库尚无 HEAD；仅统计工作区状态';
  }

  const changes = collectChanges(diffRef, headExists);
  const triggeredFiles = changes.map((file) => ({ ...file, triggers: classifyPath(file.path) }));
  const trigger = summarizeTrigger(triggeredFiles);
  const addedLines = collectAddedLines(diffRef, changes);

  const g1 = scanG1(addedLines);
  const t13 = scanAppBackground();
  if (!t13.ok) {
    const values = Object.entries(t13.values)
      .map(([name, value]) => `${name}=${value || '(未读到)'}`)
      .join('；');
    g1.total += 1;
    g1.p1 += 1;
  }

  const g2 = scanG2(addedLines, changes);
  const g4 = scanG4(addedLines);
  const g6 = scanG6(addedLines);
  const i18n = runI18nCheck(opts.i18n);

  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    head,
    base: { ref: baseRef ?? '(none)', mergeBase: mergeBase ? shortSha(mergeBase) : null, note: baseNote },
    changes: triggeredFiles.map((file) => ({
      path: file.path,
      status: file.status,
      untracked: file.untracked,
      triggers: file.triggers,
    })),
    trigger,
    g1: {
      total: g1.total,
      p0: g1.p0,
      p1: g1.p1,
      p2: g1.p2,
      rules: g1.rules.map((rule) => ({
        id: rule.id,
        severity: rule.severity,
        label: rule.label,
        count: rule.hits.length,
        examples: formatExamples(rule.hits, 3),
      })),
      t13,
    },
    g2,
    g4: {
      total: g4.total,
      confirmCount: g4.confirmHits.length,
      outlineCount: g4.outlineHits.length,
      outlineExceptionCandidates: g4.outlineCandidates.length,
      confirmExamples: formatExamples(g4.confirmHits, 3),
      outlineExamples: formatExamples(g4.outlineHits, 3),
    },
    g6: { total: g6.total, examples: formatExamples(g6.hits, 3) },
    i18n,
  };
  report.suggestions = buildSuggestions(report);
  return report;
}

function printHuman(report) {
  const line = '─'.repeat(78);
  console.log(`gate-receipt v${report.version} · 设计门禁回执（report-only，不阻断）`);
  console.log(`仓库: ${report.repo}`);
  console.log(`HEAD: ${report.head.short}（${report.head.full}）`);
  console.log(`Base: ${report.base.note}`);
  const statusCount = report.changes.reduce((acc, file) => {
    acc[file.status] = (acc[file.status] ?? 0) + 1;
    return acc;
  }, {});
  const statusText = Object.entries(statusCount)
    .map(([status, count]) => `${status} ${count}`)
    .join(' / ');
  console.log(`变更: ${report.changes.length} 个文件${statusText ? `（${statusText}）` : ''}`);
  console.log(`触发: ${report.trigger.summary}`);
  console.log(line);

  console.log('[变更清单]');
  if (!report.changes.length) {
    console.log('  （无变更）');
  } else {
    const limit = 40;
    for (const file of report.changes.slice(0, limit)) {
      const tags = file.triggers.length ? file.triggers.join(',') : '-';
      const untracked = file.untracked ? ' (untracked)' : '';
      console.log(`  ${tags.padEnd(18)} ${file.status.padEnd(2)} ${file.path}${untracked}`);
    }
    if (report.changes.length > limit) console.log(`  … 另有 ${report.changes.length - limit} 个文件（--json 看全量）`);
  }

  console.log('');
  console.log(
    `[G1 设计字面量] 命中 ${report.g1.total} 项（P0 ${report.g1.p0} / P1 ${report.g1.p1} / P2 ${report.g1.p2}；T-13 单列）`,
  );
  if (!report.g1.rules.length) {
    console.log('  PASS：未命中 A2 T-01…T-15');
  } else {
    for (const rule of report.g1.rules) {
      console.log(`  ${rule.id.padEnd(5)} ${rule.severity.padEnd(2)} ${rule.label} ×${rule.count}`);
      for (const example of rule.examples) console.log(`        - ${example}`);
    }
  }
  console.log(
    `  T-13 底色三处: ${report.g1.t13.ok ? 'PASS' : 'FAIL'}（${report.g1.t13.unique.join(', ') || '未读到'}）`,
  );

  console.log('');
  console.log(`[G2 组件重复] 命中 ${report.g2.total}（旧常量 ${report.g2.oldConstants} / 新文件重复 ${report.g2.duplicateFiles.length}）`);
  if (!report.g2.total) console.log('  PASS：diff 新增行无旧常量、无 ui/ 外重复组件文件');
  for (const example of report.g2.hits) console.log(`  - ${example.path}:${example.line}  ${example.text}`);
  for (const file of report.g2.duplicateFiles) {
    console.log(`  - 新文件重复: ${file.path}（${file.matches.join(' / ')}）`);
  }
  console.log(`  components/ui 白名单：新增 ${report.g2.newUiFiles.length} 个 ui 文件；ui/ 外新增 ${report.g2.outsideUiFiles.length} 个组件文件`);

  console.log('');
  console.log(
    `[G4 对话框/键盘] 窗口确认 ${report.g4.confirmCount}；outline-none ${report.g4.outlineCount}（输入壳例外候选 ${report.g4.outlineExceptionCandidates}）`,
  );
  if (!report.g4.total) console.log('  PASS：无 window.confirm/alert，无无法解释的 outline-none');
  for (const example of report.g4.confirmExamples) console.log(`  - window.confirm/alert ${example}`);
  for (const example of report.g4.outlineExamples) console.log(`  - outline-none ${example}`);

  console.log('');
  console.log(`[G6 移动端] h-screen / min-h-screen / Nvh 命中 ${report.g6.total}`);
  if (!report.g6.total) console.log('  PASS：无新增旧视口单位');
  for (const example of report.g6.examples) console.log(`  - ${example}`);

  console.log('');
  console.log(
    `[i18n] ${report.i18n.status}${report.i18n.reason ? `（${report.i18n.reason}）` : ''}${
      report.i18n.lastLine ? ` — ${report.i18n.lastLine}` : ''
    }`,
  );

  console.log(line);
  console.log('[建议 PR 勾选]（receipt 只建议，不代勾）');
  for (const suggestion of report.suggestions) console.log(`  - ${suggestion}`);
  console.log(line);
  console.log('提示：本回执只报告，不阻断；P0 由评审按 design-gate.md §3.1 判定。');
  console.log('用法：node scripts/gate-receipt.mjs [--base <ref>] [--no-i18n] [--json] [--self-test]');
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测（注入 A5 反例）
// ─────────────────────────────────────────────────────────────────────────────

function selfTest() {
  const checks = [];
  const check = (name, condition) => {
    checks.push({ name, ok: Boolean(condition) });
  };

  const injection = 'bg-black/60 rounded-[14px] z-50 p-[13px] text-[2rem] leading-[1.7] shadow-lg';
  const ids = g1RuleIds(injection);
  for (const expected of ['T-04d', 'T-05', 'T-07', 'T-08b']) {
    check(`G1 命中 ${expected}（A5 绕行样例）`, ids.includes(expected));
  }
  check('G1 命中 purple', g1RuleIds('selection:bg-purple-500/30 text-purple-300').includes('T-04a'));
  check('G1 命中 red/emerald/amber', ['bg-red-400', 'text-emerald-400', 'border-amber-400'].every((sample) => g1RuleIds(sample).includes('T-04c')));
  check('G1 命中 zinc（600 以外）', g1RuleIds('bg-zinc-900/40').includes('T-04e'));
  check('G1 不把 zinc-600 记入 T-04e', !g1RuleIds('text-zinc-600').includes('T-04e'));
  check('G1 命中 shadow-lg / shadow-black', ['shadow-lg', 'shadow-black'].every((sample) => g1RuleIds(sample).includes('T-07')));
  check('G1 放行 shadow-elev-2', !g1RuleIds('shadow-elev-2').includes('T-07'));
  check('G1 命中 transition-all', g1RuleIds('transition-all').includes('T-14a'));
  check('G1 放行 transition-colors', !g1RuleIds('transition-colors').includes('T-14b'));
  check('G1 命中裸 transition', g1RuleIds('transition').includes('T-14b'));
  check('G1 命中 hover:scale', g1RuleIds('hover:scale-105').includes('T-15'));
  check('G1 命中 active:scale-[0.95]', g1RuleIds('active:scale-[0.95]').includes('T-15'));
  check('G1 放行 active:scale-[0.98]', !g1RuleIds('active:scale-[0.98]').includes('T-15'));
  check('G1 命中 h-8 rounded-xl', t11LineMatch('h-8 rounded-xl'));
  check('G1 放行 h-8 rounded-lg', !t11LineMatch('h-8 rounded-lg'));
  check('G1 命中 z-[N]（P0）', g1RuleIds('z-[70]').includes('T-08a'));
  check('G1 命中 z-50（非 token）', g1RuleIds('z-50').includes('T-08b'));
  check('G1 命中 100vh', g1RuleIds('min-h-[100vh]').includes('T-09'));
  check('G1 放行 100dvh', !g1RuleIds('h-[100dvh]').includes('T-09'));
  check('G1 放行 z-dialog', !g1RuleIds('z-dialog').some((id) => id.startsWith('T-08')));
  check('G1 命中 text-[9px]', g1RuleIds('text-[9px]').includes('T-06'));

  check('G2 命中旧常量', isOldConstantLine('const PRIMARY_BUTTON = '));
  check('G2 命中 CARD_ICON', isOldConstantLine('const CARD_ICON = '));
  check('G2 不误伤 CARD_EST_HEIGHT', !isOldConstantLine('const CARD_EST_HEIGHT = '));
  check('G2 命中 class 字符串小写常量', isOldConstantLine("const primaryButton = 'inline-flex ...'"));
  check('G2 不误伤 JSX 局部变量 secondaryButton', !isOldConstantLine('const secondaryButton = secondary ? ('));
  check('G2 新文件 Button.tsx（ui 外）判重复', sharedComponentForPath('frontend/src/components/Button.tsx') === 'Button');
  check('G2 ui/Button.tsx 不判重复', sharedComponentForPath('frontend/src/components/ui/Button.tsx') === null);
  check('G2 export function Card 判重复', exportsSharedComponent('export function Card() {}') === 'Card');

  check('G4 命中 window.confirm', /window\.(?:confirm|alert)\s*\(/.test('window.confirm("x")'));
  check('G4 命中裸 outline-none', /outline-none/.test('className="outline-none"'));
  check('G4 输入壳候选（同元素）', looksLikeInputField('<input className="outline-none" />'));
  check('G4 按钮 outline-none 不是候选', !looksLikeInputField('<button className="outline-none">x</button>'));

  check('触发 T1 components', classifyPath('frontend/src/components/Foo.tsx').includes('T1'));
  check('触发 T6 i18n', classifyPath('frontend/src/i18n/zh-CN.json').includes('T6'));
  check('docs 不触发', classifyPath('docs/design-governance/design-gate.md').length === 0);
  check('.github 为 GUARD', classifyPath('.github/workflows/ci.yml').includes('GUARD'));
  check('frontend/scripts 为 GUARD', classifyPath('frontend/scripts/check-i18n.mjs').includes('GUARD'));
  check('scripts/gate-receipt.mjs 为 GUARD', classifyPath('scripts/gate-receipt.mjs').includes('GUARD'));

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
  else printHuman(report);
}

main();
