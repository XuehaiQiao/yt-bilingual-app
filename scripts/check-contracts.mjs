#!/usr/bin/env node
/**
 * check-contracts.mjs · 契约与 Feature Flag 注册表检查（机器门禁）
 *
 * 检查：
 *   1. CONTRACTS/schemas/*.json 全部是合法 JSON（JSON.parse）；
 *   2. CONTRACTS/flags.yaml 行级解析（不引依赖）：
 *      - owner / default / created / expiry 必填；
 *      - flag 名字唯一且符合 ff.<域>.<特性>；
 *      - expiry 未过期、不早于 created；default 为布尔；
 *   3. 扫描 frontend/src 与 backend 中的 `ff.<域>.<特性>`，未登记 → 报错；
 *   4. 旧开关 `REVIEW_UI_ENABLED` → 「迁移待办」警告（不阻断，ARCHITECTURE §8）。
 *
 * 用法：node scripts/check-contracts.mjs
 * 无第三方依赖，Node ≥ 22。只读；退出码 0 通过 / 1 失败。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

const REQUIRED_FLAG_FIELDS = ['owner', 'default', 'created', 'expiry'];
const LEGAL_FLAG_NAME = /^ff\.[a-z0-9][a-z0-9_]*\.[a-z0-9][a-z0-9_]*$/;
const FLAG_USE_RE = /\bff\.[A-Za-z0-9_]+\.[A-Za-z0-9_]+/g;
const SOURCE_DIRS = ['frontend/src', 'backend'];
const SOURCE_EXTENSIONS = new Set(['.py', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'venv',
  '.venv',
  '__pycache__',
  'dist',
  'build',
  'coverage',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
]);

/** 旧本地开关 → 注册表 flag（ARCHITECTURE.md §8）。 */
export const LEGACY_FLAGS = [{ name: 'REVIEW_UI_ENABLED', replacement: 'ff.review.ui' }];

export function todayIso(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function isIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function stripInlineComment(line) {
  const index = line.indexOf('#');
  if (index === -1) return line;
  if (index === 0) return '';
  return line.slice(0, index);
}

/**
 * 行级解析 flags.yaml（只支持本仓库用到的形状：`flags:` + 两级缩进映射）。
 * 返回 { flags: [{ name, fields, line }], errors }。
 */
export function parseFlagsYaml(text) {
  const errors = [];
  const flags = [];
  const byName = new Map();
  let inFlags = false;
  let current = null;

  const lines = String(text).split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const raw = stripInlineComment(lines[index]);
    if (raw.trim() === '') continue;
    const indent = raw.match(/^[ \t]*/)[0].replace(/\t/g, '  ').length;
    const trimmed = raw.trim();
    const lineNo = index + 1;

    if (!inFlags) {
      if (/^flags:\s*$/.test(trimmed)) inFlags = true;
      continue;
    }
    if (indent === 0) {
      // 下一个顶层键（本文件只有 flags，但保持通用）
      inFlags = false;
      current = null;
      continue;
    }

    const flagMatch = trimmed.match(/^(ff\.[A-Za-z0-9_.-]+):\s*$/);
    if (flagMatch) {
      const name = flagMatch[1];
      if (byName.has(name)) {
        errors.push(`flags.yaml:${lineNo}：flag 重复登记：${name}（首次在第 ${byName.get(name)} 行）`);
      }
      byName.set(name, lineNo);
      current = { name, fields: {}, line: lineNo, indent };
      flags.push(current);
      continue;
    }

    const kvMatch = trimmed.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kvMatch && current && indent > current.indent) {
      let value = kvMatch[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"'))
        || (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (Object.hasOwn(current.fields, kvMatch[1])) {
        errors.push(`flags.yaml:${lineNo}：${current.name} 字段重复：${kvMatch[1]}`);
      }
      current.fields[kvMatch[1]] = value;
      continue;
    }

    errors.push(`flags.yaml:${lineNo}：无法解析的行：${trimmed}`);
  }

  if (!inFlags && flags.length === 0) errors.push('flags.yaml：找不到 `flags:` 段');
  return { flags, errors };
}

/** 校验 flag 条目（纯函数）。today 为 YYYY-MM-DD。 */
export function validateFlags(flags, { today = todayIso() } = {}) {
  const errors = [];
  const warnings = [];
  const seen = new Set();

  if (!Array.isArray(flags) || flags.length === 0) {
    errors.push('flags.yaml：没有任何 flag 登记');
    return { errors, warnings };
  }

  for (const flag of flags) {
    const label = flag.name || `第 ${flag.line} 行`;
    if (seen.has(flag.name)) errors.push(`${label}：flag 名字重复`);
    seen.add(flag.name);
    if (!LEGAL_FLAG_NAME.test(flag.name)) {
      errors.push(`${label}：名字非法（应形如 ff.<域>.<特性>，小写字母/数字/下划线）`);
    }
    for (const field of REQUIRED_FLAG_FIELDS) {
      const value = flag.fields?.[field];
      if (value === undefined || String(value).trim() === '') {
        errors.push(`${label}：缺少必填字段 ${field}`);
      }
    }
    const def = flag.fields?.default;
    if (def !== undefined && !['true', 'false'].includes(String(def).toLowerCase())) {
      errors.push(`${label}：default 必须是 true/false，收到「${def}」`);
    }
    const created = flag.fields?.created;
    if (created !== undefined && !isIsoDate(created)) {
      errors.push(`${label}：created 不是合法日期（YYYY-MM-DD）：${created}`);
    }
    const expiry = flag.fields?.expiry;
    if (expiry !== undefined) {
      if (!isIsoDate(expiry)) {
        errors.push(`${label}：expiry 不是合法日期（YYYY-MM-DD）：${expiry}`);
      } else if (expiry < today) {
        errors.push(`${label}：flag 已于 ${expiry} 过期（今天 ${today}）——到期未删即 CI 报红`);
      } else if (created !== undefined && isIsoDate(created) && expiry < created) {
        errors.push(`${label}：expiry(${expiry}) 早于 created(${created})`);
      }
    }
    if (flag.fields && flag.fields.removal === undefined) {
      warnings.push(`${label}：建议补 removal（ARCHITECTURE §8 要求写明移除 PR）`);
    }
  }

  return { errors, warnings };
}

/** 从 [{file, text}] 收集未登记 flag 的使用。 */
export function findUnregisteredFlags(files, registeredNames) {
  const registered = new Set(registeredNames);
  const found = new Map();
  for (const { file, text } of files) {
    const lines = String(text).split(/\r?\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const matches = lines[index].match(FLAG_USE_RE) ?? [];
      for (const flag of matches) {
        if (registered.has(flag)) continue;
        if (!found.has(flag)) found.set(flag, []);
        found.get(flag).push(`${file}:${index + 1}`);
      }
    }
  }
  return [...found.entries()].map(([flag, occurrences]) => ({
    flag,
    count: occurrences.length,
    samples: [...new Set(occurrences)].slice(0, 5),
  }));
}

/** 旧开关迁移待办（不阻断）。 */
export function findLegacyFlagUses(files) {
  const results = [];
  for (const legacy of LEGACY_FLAGS) {
    const re = new RegExp(`\\b${legacy.name}\\b`, 'g');
    let count = 0;
    const filesHit = new Set();
    const samples = [];
    for (const { file, text } of files) {
      const lines = String(text).split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const hits = lines[index].match(re);
        if (!hits) continue;
        count += hits.length;
        filesHit.add(file);
        if (samples.length < 5) samples.push(`${file}:${index + 1}`);
      }
    }
    if (count > 0) {
      results.push({ ...legacy, count, fileCount: filesHit.size, samples });
    }
  }
  return results;
}

/** CONTRACTS/schemas/*.json 必须是合法 JSON。 */
export function validateSchemaTexts(entries) {
  const errors = [];
  for (const { file, text } of entries) {
    try {
      const parsed = JSON.parse(text);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        errors.push(`${file}：顶层必须是 JSON 对象`);
      }
    } catch (error) {
      errors.push(`${file}：JSON 非法：${error.message}`);
    }
  }
  return { errors, count: entries.length };
}

export function walkSourceFiles(root, dirs = SOURCE_DIRS) {
  const files = [];
  const walk = (absolute) => {
    let entries;
    try {
      entries = readdirSync(absolute, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.') && entry.name !== '.env.example') continue;
      const full = join(absolute, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(relative(root, full).replace(/\\/g, '/'));
      }
    }
  };
  for (const dir of dirs) {
    const absolute = resolve(root, dir);
    if (existsSync(absolute)) walk(absolute);
  }
  return files.sort();
}

function loadSources(root) {
  return walkSourceFiles(root).map((file) => ({
    file,
    text: readFileSync(resolve(root, file), 'utf8'),
  }));
}

function loadSchemas(root) {
  const dir = resolve(root, 'CONTRACTS/schemas');
  if (!existsSync(dir)) return { entries: [], errors: ['CONTRACTS/schemas/ 不存在'] };
  const errors = [];
  const entries = [];
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const file = `CONTRACTS/schemas/${name}`;
    try {
      entries.push({ file, text: readFileSync(resolve(dir, name), 'utf8') });
    } catch (error) {
      errors.push(`${file}：无法读取：${error.message}`);
    }
  }
  if (entries.length === 0) errors.push('CONTRACTS/schemas/ 下没有 *.json');
  return { entries, errors };
}

function main() {
  const root = DEFAULT_ROOT;
  const errors = [];
  const warnings = [];
  const passes = [];

  // 1. schemas
  const schemas = loadSchemas(root);
  const schemaResult = validateSchemaTexts(schemas.entries);
  errors.push(...schemas.errors, ...schemaResult.errors);
  if (schemaResult.errors.length === 0 && schemas.errors.length === 0) {
    passes.push(`schemas：${schemaResult.count} 个 *.json 均为合法 JSON`);
  }

  // 2. flags.yaml
  const flagsPath = resolve(root, 'CONTRACTS/flags.yaml');
  let flags = [];
  if (!existsSync(flagsPath)) {
    errors.push('CONTRACTS/flags.yaml 不存在');
  } else {
    const parsed = parseFlagsYaml(readFileSync(flagsPath, 'utf8'));
    errors.push(...parsed.errors);
    flags = parsed.flags;
    const validated = validateFlags(flags);
    errors.push(...validated.errors);
    warnings.push(...validated.warnings);
    if (parsed.errors.length === 0 && validated.errors.length === 0) {
      passes.push(`flags：${flags.length} 条登记通过（必填/唯一/未过期：${flags.map((f) => f.name).join('、')}）`);
    }
  }

  // 3. 代码扫描：未登记 ff.* + 旧开关迁移待办
  if (flags.length > 0) {
    const sources = loadSources(root);
    const unregistered = findUnregisteredFlags(sources, flags.map((flag) => flag.name));
    if (unregistered.length > 0) {
      for (const item of unregistered) {
        errors.push(`未登记 flag：${item.flag}（${item.count} 处，如 ${item.samples.join('、')}）→ 先在 CONTRACTS/flags.yaml 登记`);
      }
    } else {
      passes.push(`代码扫描：${sources.length} 个源文件，未发现未登记 ff.*`);
    }

    const legacy = findLegacyFlagUses(sources);
    for (const item of legacy) {
      warnings.push(
        `迁移待办（不阻断）：${item.name} 仍出现在 ${item.fileCount} 个文件 / ${item.count} 处（如 ${item.samples.join('、')}）→ 应迁移到 ${item.replacement}（ARCHITECTURE §8）`,
      );
    }
  }

  console.log('check-contracts · 契约 / Feature Flag 注册表');
  console.log(`schemas: CONTRACTS/schemas/*.json（${schemas.entries.length} 个）`);
  console.log(`flags:   CONTRACTS/flags.yaml（${flags.length} 条）`);
  for (const item of passes) console.log(`PASS  ${item}`);
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
    console.error(`❌ check-contracts 错误：${error.message}`);
    process.exitCode = 1;
  }
}
