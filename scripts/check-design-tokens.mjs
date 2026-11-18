#!/usr/bin/env node
/**
 * check-design-tokens.mjs · 设计 token 扫描（design token scan）
 *
 * 用途（W5b / design-gate.md 附录 B）：
 *   扫描 `frontend/src/**\/*.tsx` 与 `frontend/src/**\/*.css`，报告 A2 tokens §13 中
 *   本轮约定的字面量：裸 hex/rgb/hsl、任意字号（T-05/T-06）、任意/非 token z（T-08）、
 *   任意阴影（T-07）、blue/purple/violet/sky/pink 残留（T-04）、h-8/h-9 + rounded-xl
 *   与 h-10 + rounded-full（T-11）、transition-all（T-14）、hover:scale / active:scale-[0.95]
 *   （T-15）。输出按文件、数量、P0/P1/P2 分组。
 *
 * 定位：**report-only，不阻断**。
 *   - 默认退出码 0（参数/内部错误除外）；只有显式 `--fail` 才在存在 P0/P1 时退出 1。
 *   - 不接 CI（W5b 明确），不改产品代码，不修存量。
 *   - 规则是**行级正则**：同一行可命中多条规则，只用于发现候选，不替代人眼 / 截图 / 评审。
 *   - 覆盖范围是本轮约定的子集，不等同于 A2 T-01…T-15 全量；未纳入项见 --help / 报告。
 *
 * 用法：
 *   node scripts/check-design-tokens.mjs                    # 全量扫描当前工作区（report-only）
 *   node scripts/check-design-tokens.mjs --diff <base>      # 只扫相对 <base> 的新增行（merge-base）
 *   node scripts/check-design-tokens.mjs --baseline         # 只输出基线汇总（规则/热点计数）
 *   node scripts/check-design-tokens.mjs --json             # 机器可读
 *   node scripts/check-design-tokens.mjs --fail             # 有 P0/P1 时退出码 1（默认 0）
 *   node scripts/check-design-tokens.mjs --self-test        # 注入反例自测（失败退出码 1）
 *   node scripts/check-design-tokens.mjs --help
 *
 * 无第三方依赖，Node ≥ 18。只读：不写文件、不改 git 状态。
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const VERSION = '1.0';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const SCAN_ROOT = 'frontend/src';
const SCAN_EXT_RE = /\.(?:tsx|css)$/;
const TEST_PATH_RE = /(?:\.test\.(?:tsx|css)$|\/__tests__\/)/;

const USAGE = `check-design-tokens v${VERSION} · 设计 token 扫描（report-only，不阻断）

用法：
  node scripts/check-design-tokens.mjs                    全量扫描 frontend/src/**/*.tsx|css
  node scripts/check-design-tokens.mjs --diff <base>      只扫相对 <base> 的新增行（自动取 merge-base）
  node scripts/check-design-tokens.mjs --baseline         只输出基线汇总（规则 × 文件热点）
  node scripts/check-design-tokens.mjs --json             输出 JSON（可与 --baseline/--diff 组合）
  node scripts/check-design-tokens.mjs --fail             存在 P0/P1 时退出码 1（默认始终 0）
  node scripts/check-design-tokens.mjs --self-test        运行注入反例自测
  node scripts/check-design-tokens.mjs --help

本轮规则（A2 tokens §13 子集）：
  T-01 P0  裸 hex / rgb() / hsl()（frontend/src/index.css 为 token 定义源，整文件豁免）
  T-04a P0 blue-* / purple-*
  T-04b P1 violet-* / sky-* / pink-*
  T-05 P1 任意字号 text-[…]（9px / 10px 单列 T-06）
  T-06 P0 text-[9px] / text-[10px]
  T-07 P1 shadow-*（shadow-elev-1/2/3 与 shadow-none 除外）
  T-08a P0 z-[N]；T-08b P1 z-<数字>（8 个 token 之外）
  T-11a P2 h-8/h-9 行内同时出现 rounded-xl
  T-11b P2 h-10 行内同时出现 rounded-full（hero 除外，人工确认）
  T-14 P2 transition-all
  T-15 P2 hover:scale-* / active:scale-[0.95]（0.98 按压允许；group-hover 不匹配）

未纳入本轮：T-02 border-white/5|10、T-03 text-zinc-600、T-09 h-screen/Nvh、
  T-10 zinc-900 透明度、T-12 focus:outline-none、T-13 三处底色、裸 transition。
  这些仍由 scripts/gate-receipt.mjs（diff 级）与人工/后续脚本覆盖。

定位：只报告，不阻断；默认退出码 0，--fail 才在 P0/P1 > 0 时退出 1。
  行级正则只给候选，不替代人眼 / 截图 / 设计评审；不接 CI。`;

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

/**
 * 解析 unified diff 的新增行。`-U0` 下每个 hunk 只包含新增/删除行；
 * 行号取新文件的 hunk 起点，保证与源码行号一致。
 */
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

function collectUntrackedRecords() {
  const output = gitOk(['ls-files', '--others', '--exclude-standard', '--', SCAN_ROOT]) ?? '';
  const records = [];
  const files = [];
  for (const path of output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)) {
    if (!SCAN_EXT_RE.test(path) || TEST_PATH_RE.test(path)) continue;
    const absolute = join(REPO_ROOT, path);
    let lines;
    try {
      lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    files.push(path);
    lines.forEach((text, index) => records.push({ path, line: index + 1, text, added: true }));
  }
  return { records, files };
}

function collectDiffRecords(base) {
  const headExists = Boolean(gitOk(['rev-parse', '--verify', '--quiet', 'HEAD']));
  if (!headExists) fail('仓库没有 HEAD，--diff 不可用');

  const mergeBase = gitOk(['merge-base', 'HEAD', base]) ?? base;
  const diff = git(['diff', '-U0', '--no-color', '--no-renames', mergeBase, '--', SCAN_ROOT]);
  if (diff.code !== 0) fail(`git diff 失败：${diff.stderr.trim() || base}`);

  const records = parseUnifiedDiff(diff.stdout);
  const untracked = collectUntrackedRecords();
  records.push(...untracked.records);

  const files = [...new Set(records.map((record) => record.path))].sort();
  return {
    records,
    files,
    base: { ref: base, mergeBase: shortSha(mergeBase) },
    untracked: untracked.files,
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

function collectAllRecords() {
  const root = join(REPO_ROOT, SCAN_ROOT);
  const files = walkFiles(root).sort();
  const records = [];
  for (const absolute of files) {
    const path = relative(REPO_ROOT, absolute).split('\\').join('/');
    let lines;
    try {
      lines = readFileSync(absolute, 'utf8').split(/\r?\n/);
    } catch {
      continue;
    }
    lines.forEach((text, index) => records.push({ path, line: index + 1, text, added: false }));
  }
  return { records, files: files.map((absolute) => relative(REPO_ROOT, absolute).split('\\').join('/')) };
}

// ─────────────────────────────────────────────────────────────────────────────
// 规则（A2 tokens §13 子集）
// ─────────────────────────────────────────────────────────────────────────────

const COLOR_UTILITIES =
  'bg|text|border|ring|from|via|to|fill|stroke|decoration|outline|divide|placeholder|caret|accent|shadow';

function colorFamilyRegex(families) {
  return new RegExp(
    `(?<![\\w-])(?:${COLOR_UTILITIES})-(?:${families})-(?:\\d{2,3})(?:\\/[\\d.]+)?(?![\\w-])`,
  );
}

const T05_FONT_SIZE_RE = /(?<![-\w])text-\[([^\]]+)\]/g;
const T06_RE = /(?<![-\w])text-\[(?:9|10)px\]/;

function arbitraryFontSizes(text) {
  const matches = [];
  for (const match of text.matchAll(T05_FONT_SIZE_RE)) {
    const value = match[1].trim();
    if (/^(?:#|rgb|hsl|color:)/i.test(value)) continue;
    if (/^length:/i.test(value)) {
      matches.push(match[0]);
      continue;
    }
    if (/(?:^|[^\w-])\d+(?:\.\d+)?(?:px|rem|em|pt|pc|ex|ch|vw|vh|vmin|vmax|%)/i.test(value)) {
      matches.push(match[0]);
    }
  }
  return matches;
}

function t11aLine(text) {
  const hasHeight = /(?<![-\w])h-(?:8|9)(?![-\w])/.test(text);
  return hasHeight && /(?<![-\w])rounded-xl(?![-\w])/.test(text);
}

function t11bLine(text) {
  const hasHeight = /(?<![-\w])h-10(?![-\w])/.test(text);
  return hasHeight && /(?<![-\w])rounded-full(?![-\w])/.test(text);
}

const RULES = [
  {
    id: 'T-01',
    severity: 'P0',
    label: '裸 hex / rgb() / hsl()',
    exemptPaths: new Set([`${SCAN_ROOT}/index.css`]),
    // rgba()/hsl() 也常见于任意值内部的 `0_0_12px_rgba(...)`，所以不能用 \b
    // （`x` 与 `r` 之间没有词边界）；只排除字母/数字/连字符前缀。
    test: (text) =>
      /(?<![&\w])#(?:[0-9a-fA-F]{3,8})(?![0-9a-zA-Z_-])|(?<![A-Za-z0-9-])rgba?\(|(?<![A-Za-z0-9-])hsla?\(/.test(
        text,
      ),
  },
  {
    id: 'T-04a',
    severity: 'P0',
    label: 'blue-* / purple-* 残留',
    test: (text) => colorFamilyRegex('blue|purple').test(text),
  },
  {
    id: 'T-04b',
    severity: 'P1',
    label: 'violet-* / sky-* / pink-* 残留',
    test: (text) => colorFamilyRegex('violet|sky|pink').test(text),
  },
  {
    id: 'T-05',
    severity: 'P1',
    label: '任意字号 text-[…]（9/10px 单列 T-06）',
    test: (text) => arbitraryFontSizes(text).length > 0 && !T06_RE.test(text),
  },
  {
    id: 'T-06',
    severity: 'P0',
    label: 'text-[9px] / text-[10px]',
    test: (text) => T06_RE.test(text),
  },
  {
    id: 'T-07',
    severity: 'P1',
    label: 'shadow-*（elev-1/2/3 与 none 除外）',
    test: (text) => /(?<![-\w])shadow-(?!elev-[123](?![-\w])|none(?![-\w]))[a-z0-9[]/.test(text),
  },
  {
    id: 'T-08a',
    severity: 'P0',
    label: 'z-[N] 任意层级',
    test: (text) => /(?<![-\w])z-\[[^\]]+\]/.test(text),
  },
  {
    id: 'T-08b',
    severity: 'P1',
    label: 'z-<数字>（8 个 token 之外）',
    test: (text) => /(?<![-\w])z-\d+(?![-\w])/.test(text),
  },
  {
    id: 'T-11a',
    severity: 'P2',
    label: 'h-8/h-9 + rounded-xl（圆角-高度映射）',
    test: (text) => t11aLine(text),
  },
  {
    id: 'T-11b',
    severity: 'P2',
    label: 'h-10 + rounded-full（hero 除外，人工确认）',
    test: (text) => t11bLine(text),
  },
  {
    id: 'T-14',
    severity: 'P2',
    label: 'transition-all',
    test: (text) => /(?<![-\w])transition-all(?![-\w])/.test(text),
  },
  {
    id: 'T-15',
    severity: 'P2',
    label: 'hover:scale-* / active:scale-[0.95]',
    test: (text) =>
      /(?<![-\w])hover:scale-|(?<![-\w])active:scale-(?:\[0?\.95\]|95)(?![-\w])/.test(text),
  },
];

const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 };

function ruleAppliesToPath(rule, path) {
  return !(rule.exemptPaths && rule.exemptPaths.has(path));
}

// ─────────────────────────────────────────────────────────────────────────────
// 扫描 / 聚合
// ─────────────────────────────────────────────────────────────────────────────

function truncate(text, max = 160) {
  const value = String(text).trim().replace(/\s+/g, ' ');
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

function scanRecords(records) {
  const ruleHits = new Map(RULES.map((rule) => [rule.id, { rule, hits: [] }]));
  const lineMap = new Map();

  for (const record of records) {
    const matched = [];
    for (const rule of RULES) {
      if (!ruleAppliesToPath(rule, record.path)) continue;
      if (!rule.test(record.text)) continue;
      matched.push(rule);
      ruleHits.get(rule.id).hits.push(record);
    }
    if (!matched.length) continue;

    const key = `${record.path}:${record.line}`;
    const severity = matched.map((rule) => rule.severity).sort((a, b) => SEVERITY_RANK[a] - SEVERITY_RANK[b])[0];
    const existing = lineMap.get(key);
    if (existing) {
      for (const rule of matched) existing.ruleIds.add(rule.id);
      if (SEVERITY_RANK[severity] < SEVERITY_RANK[existing.severity]) existing.severity = severity;
    } else {
      lineMap.set(key, {
        path: record.path,
        line: record.line,
        text: truncate(record.text),
        ruleIds: new Set(matched.map((rule) => rule.id)),
        severity,
      });
    }
  }

  const lines = [...lineMap.values()].map((hit) => ({ ...hit, ruleIds: [...hit.ruleIds].sort() }));
  const files = new Map();
  for (const hit of lines) {
    const bucket = files.get(hit.path) ?? {
      path: hit.path,
      lines: 0,
      ruleHits: 0,
      p0: 0,
      p1: 0,
      p2: 0,
      hits: [],
    };
    bucket.lines += 1;
    bucket.ruleHits += hit.ruleIds.length;
    bucket[hit.severity.toLowerCase()] += 1;
    bucket.hits.push(hit);
    files.set(hit.path, bucket);
  }

  const fileList = [...files.values()]
    .map((file) => ({ ...file, hits: file.hits.sort((a, b) => a.line - b.line) }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

  const rules = [...ruleHits.values()]
    .filter((entry) => entry.hits.length > 0)
    .map((entry) => {
      const fileSet = new Set(entry.hits.map((hit) => hit.path));
      return {
        id: entry.rule.id,
        severity: entry.rule.severity,
        label: entry.rule.label,
        lines: entry.hits.length,
        files: fileSet.size,
        examples: entry.hits.slice(0, 3).map((hit) => `${hit.path}:${hit.line}  ${truncate(hit.text, 120)}`),
      };
    })
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || a.id.localeCompare(b.id));

  const totals = {
    lines: lines.length,
    ruleHits: lines.reduce((sum, hit) => sum + hit.ruleIds.length, 0),
    p0: lines.filter((hit) => hit.severity === 'P0').length,
    p1: lines.filter((hit) => hit.severity === 'P1').length,
    p2: lines.filter((hit) => hit.severity === 'P2').length,
    files: fileList.length,
  };

  return { rules, files: fileList, totals };
}

// ─────────────────────────────────────────────────────────────────────────────
// 报告
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(opts) {
  const headFull = gitOk(['rev-parse', '--verify', '--quiet', 'HEAD']);
  const head = shortSha(headFull);

  let mode;
  let records;
  let files;
  let base = null;
  let untracked = [];

  if (opts.diff) {
    mode = 'diff';
    const diff = collectDiffRecords(resolveBase(opts.diff));
    records = diff.records;
    files = diff.files;
    base = diff.base;
    untracked = diff.untracked;
  } else {
    mode = opts.baseline ? 'baseline' : 'full';
    const all = collectAllRecords();
    records = all.records;
    files = all.files;
  }

  const scan = scanRecords(records);
  const uniqueLines = new Set(records.map((record) => `${record.path}:${record.line}`)).size;

  const report = {
    tool: 'check-design-tokens',
    version: VERSION,
    generatedAt: new Date().toISOString(),
    repo: REPO_ROOT,
    head,
    mode,
    reportOnly: true,
    base,
    scope: {
      root: SCAN_ROOT,
      pattern: '**/*.tsx|css（跳过 *.test.* 与 __tests__/）',
      files: files.length,
      lines: uniqueLines,
      rules: RULES.length,
      ...(mode === 'diff' ? { addedLines: records.length, untracked } : {}),
      exemptions: [
        {
          rule: 'T-01',
          path: `${SCAN_ROOT}/index.css`,
          reason: 'token 定义源（runtime channels / glass / 焦点环），裸色值由 A2 tokens 维护',
        },
      ],
    },
    totals: scan.totals,
    rules: scan.rules,
    files: scan.files,
    hotspots: scan.files.slice(0, 10).map((file) => ({
      path: file.path,
      lines: file.lines,
      p0: file.p0,
      p1: file.p1,
      p2: file.p2,
    })),
    notes: [
      'report-only：默认退出码 0；--fail 才在 P0/P1 > 0 时退出 1；不接 CI。',
      '行级正则：同一行可命中多条规则；totals.lines 是去重行数，rules[].lines 可重叠。',
      '覆盖 A2 T-01/T-04/T-05/T-06/T-07/T-08/T-11/T-14/T-15 的本轮子集；T-02/T-03/T-09/T-10/T-12/T-13/裸 transition 未纳入。',
      '只扫 .tsx/.css；lib/*.ts 中的 violet 例外（CHUNK_STYLE）不在扫描范围。',
    ],
  };
  return report;
}

function printRuleTable(report, { withExamples = false } = {}) {
  if (!report.rules.length) {
    console.log('  PASS：未命中本轮规则');
    return;
  }
  for (const rule of report.rules) {
    console.log(
      `  ${rule.id.padEnd(5)} ${rule.severity.padEnd(2)} ${rule.label}  ×${rule.lines} 行（${rule.files} 文件）`,
    );
    if (withExamples) {
      for (const example of rule.examples) console.log(`        - ${example}`);
    }
  }
}

function printHuman(report) {
  const line = '─'.repeat(78);
  console.log(`check-design-tokens v${report.version} · 设计 token 扫描（report-only，不阻断）`);
  console.log(`仓库: ${report.repo}`);
  console.log(`HEAD: ${report.head}`);
  if (report.mode === 'diff') {
    console.log(`Base: ${report.base.ref}@${report.base.mergeBase}（merge-base；仅新增行）`);
  } else {
    console.log(`范围: ${report.scope.root}/**/*.tsx|css（${report.scope.files} 文件 / ${report.scope.lines} 行）`);
  }
  console.log(`模式: ${report.mode}${report.mode === 'diff' ? `（新增 ${report.scope.addedLines} 行）` : ''}`);
  console.log(line);

  console.log(
    `[汇总] 命中 ${report.totals.lines} 行（P0 ${report.totals.p0} / P1 ${report.totals.p1} / P2 ${report.totals.p2}）；` +
      `规则命中 ${report.totals.ruleHits} 次（可重叠）；涉及 ${report.totals.files} 文件`,
  );
  console.log('[规则]');
  printRuleTable(report, { withExamples: true });

  console.log('');
  console.log('[热点文件]（按命中行数，前 10）');
  if (!report.hotspots.length) {
    console.log('  （无）');
  } else {
    for (const file of report.hotspots) {
      console.log(
        `  ${file.path}  ×${file.lines} 行（P0 ${file.p0} / P1 ${file.p1} / P2 ${file.p2}）`,
      );
    }
  }

  console.log('');
  console.log('[按文件明细]（每文件最多 5 条示例；--json 看全量）');
  if (!report.files.length) {
    console.log('  （无命中）');
  } else {
    for (const file of report.files) {
      console.log(
        `${file.path}  ×${file.lines} 行（P0 ${file.p0} / P1 ${file.p1} / P2 ${file.p2}；规则命中 ${file.ruleHits} 次）`,
      );
      for (const hit of file.hits.slice(0, 5)) {
        console.log(`  ${String(hit.line).padStart(5)}  ${hit.severity}  ${hit.ruleIds.join(',')}  ${hit.text}`);
      }
      if (file.hits.length > 5) console.log(`  … 另 ${file.hits.length - 5} 条（--json 全量）`);
    }
  }

  console.log(line);
  console.log('提示：本脚本只报告，不阻断；默认退出码 0，--fail 才在 P0/P1 > 0 时退出 1。');
  console.log('      行级正则只给候选，不替代人眼 / 截图 / 评审；未接 CI。');
  console.log(`用法：node scripts/check-design-tokens.mjs [--diff <base>] [--baseline] [--json] [--fail]`);
}

function printBaseline(report) {
  const line = '─'.repeat(78);
  console.log(`check-design-tokens v${report.version} · 基线汇总（report-only，不阻断）`);
  console.log(`HEAD: ${report.head}`);
  console.log(`范围: ${report.scope.root}/**/*.tsx|css（${report.scope.files} 文件 / ${report.scope.lines} 行，全量）`);
  console.log(line);

  console.log('[基线计数]');
  if (!report.rules.length) {
    console.log('  PASS：未命中本轮规则');
  } else {
    for (const rule of report.rules) {
      console.log(`  ${rule.id.padEnd(5)} ${rule.severity.padEnd(2)} ${rule.label}  ×${rule.lines} 行 / ${rule.files} 文件`);
    }
  }
  console.log(
    `  合计: ${report.totals.lines} 行（P0 ${report.totals.p0} / P1 ${report.totals.p1} / P2 ${report.totals.p2}）；` +
      `规则命中 ${report.totals.ruleHits} 次；涉及 ${report.totals.files} 文件`,
  );

  console.log('');
  console.log('[热点文件]（按命中行数，前 10）');
  for (const file of report.hotspots) {
    console.log(`  ${file.path}  ×${file.lines} 行（P0 ${file.p0} / P1 ${file.p1} / P2 ${file.p2}）`);
  }

  console.log('');
  console.log('[复核命令]');
  console.log('  node scripts/check-design-tokens.mjs --baseline');
  console.log('  node scripts/check-design-tokens.mjs --json');
  console.log(line);
  console.log('注意：基线含存量，**不是门禁通过**；--diff <base> 才只看新增行。');
}

// ─────────────────────────────────────────────────────────────────────────────
// 自测（注入反例；失败退出码 1）
// ─────────────────────────────────────────────────────────────────────────────

function ruleIdsOf(text) {
  return RULES.filter((rule) => rule.test(text)).map((rule) => rule.id);
}

function selfTest() {
  const checks = [];
  const check = (name, condition) => {
    checks.push({ name, ok: Boolean(condition) });
  };

  check('T-01 命中 bg-[#09090b]', ruleIdsOf('bg-[#09090b]').includes('T-01'));
  check('T-01 命中 rgba()', ruleIdsOf('shadow-[0_0_12px_rgba(139,92,246,0.5)]').includes('T-01'));
  check('T-01 命中 hsl()', ruleIdsOf('bg-[hsl(0_0%_10%)]').includes('T-01'));
  check('T-01 放行 bg-brand', !ruleIdsOf('bg-brand text-fg-primary').includes('T-01'));
  check(
    'T-01 对 index.css 豁免',
    !ruleApplicable('T-01', 'frontend/src/index.css') && ruleApplicable('T-01', 'frontend/src/App.tsx'),
  );

  check('T-04a 命中 bg-blue-500/20', ruleIdsOf('bg-blue-500/20').includes('T-04a'));
  check('T-04a 命中 hover:text-purple-300', ruleIdsOf('hover:text-purple-300').includes('T-04a'));
  check('T-04a 放行 bg-brand/10', !ruleIdsOf('bg-brand/10').includes('T-04a'));

  check('T-04b 命中 from-sky-400', ruleIdsOf('from-sky-400').includes('T-04b'));
  check('T-04b 命中 via-violet-400', ruleIdsOf('via-violet-400').includes('T-04b'));
  check('T-04b 命中 to-pink-400', ruleIdsOf('to-pink-400').includes('T-04b'));
  check('T-04b 放行 via-brand-400', !ruleIdsOf('via-brand-400').includes('T-04b'));

  check('T-05 命中 text-[11px]', ruleIdsOf('text-[11px]').includes('T-05'));
  check('T-05 命中 text-[0.8rem]', ruleIdsOf('text-[0.8rem]').includes('T-05'));
  check('T-05 命中 text-[clamp(0.8rem,2vw,1rem)]', ruleIdsOf('text-[clamp(0.8rem,2vw,1rem)]').includes('T-05'));
  check('T-05 放行 text-[#fff]', !ruleIdsOf('text-[#fff]').includes('T-05'));
  check('T-05 放行 text-zinc-500', !ruleIdsOf('text-zinc-500').includes('T-05'));

  check('T-06 命中 text-[9px]', ruleIdsOf('text-[9px]').includes('T-06'));
  check('T-06 命中 text-[10px]', ruleIdsOf('text-[10px]').includes('T-06'));
  check('T-06 放行 text-[11px]', !ruleIdsOf('text-[11px]').includes('T-06'));

  check('T-07 命中 shadow-[…]', ruleIdsOf('shadow-[0_1px_1px_rgba(0,0,0,.3)]').includes('T-07'));
  check('T-07 命中 shadow-2xl', ruleIdsOf('shadow-2xl').includes('T-07'));
  check('T-07 命中 shadow-black/40', ruleIdsOf('shadow-black/40').includes('T-07'));
  check('T-07 命中 shadow-lg', ruleIdsOf('shadow-lg').includes('T-07'));
  check('T-07 放行 shadow-elev-2', !ruleIdsOf('shadow-elev-2').includes('T-07'));
  check('T-07 放行 shadow-none', !ruleIdsOf('shadow-none').includes('T-07'));

  check('T-08a 命中 z-[90]', ruleIdsOf('z-[90]').includes('T-08a'));
  check('T-08a 放行 z-dialog', !ruleIdsOf('z-dialog').includes('T-08a'));
  check('T-08b 命中 z-50', ruleIdsOf('z-50').includes('T-08b'));
  check('T-08b 放行 z-popover', !ruleIdsOf('z-popover').includes('T-08b'));

  check('T-11a 命中 h-9 + rounded-xl', ruleIdsOf('h-9 px-3 rounded-xl').includes('T-11a'));
  check('T-11a 放行 h-9 + rounded-lg', !ruleIdsOf('h-9 px-3 rounded-lg').includes('T-11a'));
  check('T-11a 放行 h-10 + rounded-xl', !ruleIdsOf('h-10 px-3 rounded-xl').includes('T-11a'));
  check('T-11b 命中 h-10 + rounded-full', ruleIdsOf('h-10 rounded-full').includes('T-11b'));

  check('T-14 命中 transition-all', ruleIdsOf('transition-all').includes('T-14'));
  check('T-14 放行 transition-colors', !ruleIdsOf('transition-colors').includes('T-14'));
  check('T-14 不把裸 transition 计入（本轮范围）', !ruleIdsOf('transition').includes('T-14'));

  check('T-15 命中 hover:scale-105', ruleIdsOf('hover:scale-105').includes('T-15'));
  check('T-15 命中 active:scale-[0.95]', ruleIdsOf('active:scale-[0.95]').includes('T-15'));
  check('T-15 命中 active:scale-95', ruleIdsOf('active:scale-95').includes('T-15'));
  check('T-15 放行 active:scale-[0.98]', !ruleIdsOf('active:scale-[0.98]').includes('T-15'));
  check('T-15 放行 group-hover:scale-100', !ruleIdsOf('group-hover:scale-100').includes('T-15'));

  const diffSample = [
    'diff --git a/frontend/src/App.tsx b/frontend/src/App.tsx',
    '--- a/frontend/src/App.tsx',
    '+++ b/frontend/src/App.tsx',
    '@@ -10,0 +11,2 @@',
    '+<div className="bg-[#09090b]" />',
    '+// 注释行不影响解析',
  ].join('\n');
  const parsed = parseUnifiedDiff(diffSample);
  check('diff 解析路径', parsed[0]?.path === 'frontend/src/App.tsx');
  check('diff 解析行号', parsed[0]?.line === 11 && parsed[1]?.line === 12);
  check(
    'diff 跳过 .ts 与测试文件',
    parseUnifiedDiff('+++ b/frontend/src/lib/x.ts\n@@ -1,0 +1,1 @@\n+bg-[#000]').length === 0 &&
      parseUnifiedDiff('+++ b/frontend/src/__tests__/x.tsx\n@@ -1,0 +1,1 @@\n+bg-[#000]').length === 0,
  );

  const failed = checks.filter((item) => !item.ok);
  for (const item of checks) console.log(`${item.ok ? 'PASS' : 'FAIL'}  ${item.name}`);
  console.log(`\nself-test: ${failed.length === 0 ? 'PASS' : 'FAIL'}（${checks.length - failed.length}/${checks.length}）`);
  if (failed.length) process.exitCode = 1;
}

function ruleApplicable(ruleId, path) {
  const rule = RULES.find((entry) => entry.id === ruleId);
  return Boolean(rule) && ruleAppliesToPath(rule, path);
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
        `FAIL  --fail：P0 ${report.totals.p0} + P1 ${report.totals.p1} = ${blocking} 行；` +
          '先修 / 登记例外，或用 --diff 只看新增。',
      );
      process.exitCode = 1;
    } else {
      console.log('PASS  --fail：无 P0/P1 命中。');
    }
  }
}

main();
