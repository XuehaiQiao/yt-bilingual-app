#!/usr/bin/env node
// Dictionary guard for the UI languages (specs/012-i18n-multilingual §5.7,
// design QA appendix A / V-06).
//
// zh-CN.json is the structural source of truth. This script catches the things
// TypeScript cannot:
//   1. vi-VN keys missing from / extra compared to zh-CN (tsc catches missing
//      only when the dictionary is typed; this keeps parity explicit);
//   2. `{{placeholder}}` sets drifting between languages;
//   3. CJK characters leaking into the Vietnamese dictionary;
//   4. zh-CN values that contain no CJK unless explicitly allowlisted
//      (brands / CEFR / Gutenberg / URLs / book titles / format-only keys);
//   5. V-06 keys (design QA appendix A.1 + A.2) regressing to English, plus the
//      `sentences.day` adjudication;
//   6. dead keys in the allowlist becoming referenced by live code again.
//
// Allowlist data lives in `scripts/i18n-allowlist.json`; every entry must carry
// a reason (live entries also carry their rendering path, which is checked to
// exist). The V-06 key list lives in `scripts/v06-keys.json`.
//
// Run: npm run check:i18n   (or: node scripts/check-i18n.mjs)
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASE = 'zh-CN';
const OTHERS = ['vi-VN'];
const SOURCE_EXTENSIONS = /\.(ts|tsx)$/;
export const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

export const placeholder = (value) =>
  [...String(value).matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1]).sort().join(',');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

/**
 * Existing cross-language checks (key parity, placeholder parity, no CJK in
 * vi-VN, non-empty values).
 * @returns {{problems: string[], warnings: string[]}}
 */
export function checkLanguage({ code, base, dict }) {
  const problems = [];
  const warnings = [];
  for (const key of Object.keys(base)) {
    if (!(key in dict)) problems.push(`${code}: missing key "${key}"`);
  }
  for (const key of Object.keys(dict)) {
    if (!(key in base)) warnings.push(`${code}: extra key "${key}" (not in ${BASE})`);
    const basePlaceholders = placeholder(base[key] ?? '');
    const placeholders = placeholder(dict[key] ?? '');
    if (key in base && basePlaceholders !== placeholders) {
      problems.push(`${code}: placeholder mismatch in "${key}" [${basePlaceholders}] vs [${placeholders}]`);
    }
    if (CJK.test(dict[key] ?? '')) problems.push(`${code}: CJK characters in "${key}": ${dict[key]}`);
    if (!String(dict[key] ?? '').trim()) problems.push(`${code}: empty translation for "${key}"`);
  }
  return { problems, warnings };
}

/**
 * V-06 rule: every zh-CN value must contain a CJK ideograph unless its key is
 * in the allowlist (brands / CEFR / URLs / book titles / format-only values).
 * @returns {string[]}
 */
export function checkZhCjk({ base, allowlistedKeys }) {
  const problems = [];
  for (const [key, value] of Object.entries(base)) {
    if (allowlistedKeys.has(key)) continue;
    if (!CJK.test(value)) problems.push(`zh-CN: no CJK in "${key}": ${JSON.stringify(value)}`);
  }
  return problems;
}

/**
 * The 31 keys from design QA appendix A.1 + A.2 must stay translated, and the
 * extra `sentences.day` adjudication is enforced as recorded in v06-keys.json.
 * @returns {string[]}
 */
export function checkV06({ base, v06, allowlistedKeys = new Set() }) {
  const problems = [];
  if (!Array.isArray(v06.keys)) problems.push('v06-keys.json: "keys" must be an array');
  if (!Array.isArray(v06.adjudicated)) problems.push('v06-keys.json: "adjudicated" must be an array');
  if (problems.length > 0) return problems;

  if (v06.expectedCount != null && v06.keys.length !== v06.expectedCount) {
    problems.push(`v06-keys.json: expected ${v06.expectedCount} keys, found ${v06.keys.length}`);
  }
  const seen = new Set();
  for (const key of v06.keys) {
    if (seen.has(key)) {
      problems.push(`V-06: duplicate key "${key}" in v06-keys.json`);
      continue;
    }
    seen.add(key);
    if (!(key in base)) {
      problems.push(`V-06: missing key "${key}"`);
      continue;
    }
    if (allowlistedKeys.has(key)) {
      problems.push(`V-06: "${key}" is allowlisted but must be translated`);
      continue;
    }
    if (!CJK.test(base[key])) {
      problems.push(`V-06: no CJK in "${key}" (still English: ${JSON.stringify(base[key])})`);
    }
  }

  for (const item of v06.adjudicated) {
    if (!item || typeof item.key !== 'string') {
      problems.push('V-06: every adjudicated entry needs a key');
      continue;
    }
    if (!(item.key in base)) {
      problems.push(`V-06: adjudicated key missing from ${BASE}: "${item.key}"`);
      continue;
    }
    if (item.decision === 'translate') {
      if (!CJK.test(base[item.key])) {
        problems.push(`V-06: adjudicated "translate" key has no CJK: "${item.key}"`);
      }
    } else if (item.decision === 'allowlist') {
      if (!allowlistedKeys.has(item.key)) {
        problems.push(`V-06: adjudicated "allowlist" key is not in the allowlist: "${item.key}"`);
      }
    } else {
      problems.push(`V-06: unknown adjudication "${item.decision}" for "${item.key}"`);
    }
  }
  return problems;
}

/** Recursively list .ts/.tsx files under `dir`. */
function listSourceFiles(dir, result = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) listSourceFiles(full, result);
    else if (SOURCE_EXTENSIONS.test(entry.name)) result.push(full);
  }
  return result;
}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const keyReference = (key) => new RegExp(`(['"\`])${escapeRegExp(key)}\\1`);

/**
 * Validate allowlist data: reasons required, live entries need an existing
 * rendering path, no duplicates, no unknown keys. Also proves dead keys are
 * still unreferenced by live TS/TSX code (the pinned InputScreen.tsx is the
 * only allowed exception).
 * @returns {{problems: string[], keys: Set<string>, liveCount: number, deadCount: number}}
 */
export function validateAllowlist({ data, base, sourceFiles, rootDir = root }) {
  const problems = [];
  const keys = new Set();
  const live = Array.isArray(data.allowlist) ? data.allowlist : [];
  const dead = Array.isArray(data.deadKeys) ? data.deadKeys : [];
  if (!Array.isArray(data.allowlist)) problems.push('i18n-allowlist.json: "allowlist" must be an array');
  if (!Array.isArray(data.deadKeys)) problems.push('i18n-allowlist.json: "deadKeys" must be an array');

  for (const [group, entries] of [
    ['allowlist', live],
    ['deadKeys', dead],
  ]) {
    for (const entry of entries) {
      if (!entry || typeof entry.key !== 'string' || entry.key.trim() === '') {
        problems.push(`${group}: every entry needs a non-empty "key"`);
        continue;
      }
      if (keys.has(entry.key)) problems.push(`i18n-allowlist.json: duplicate key "${entry.key}"`);
      keys.add(entry.key);
      if (typeof entry.reason !== 'string' || entry.reason.trim() === '') {
        problems.push(`i18n-allowlist.json: "${entry.key}" needs a reason`);
      }
      if (!(entry.key in base)) {
        problems.push(`i18n-allowlist.json: unknown key "${entry.key}" (not in ${BASE})`);
        continue;
      }
      if (entry.path != null) {
        const path = typeof entry.path === 'string' ? resolve(rootDir, entry.path) : null;
        if (!path || !existsSync(path)) {
          problems.push(`i18n-allowlist.json: "${entry.key}" path not found: ${entry.path}`);
        } else if (!keyReference(entry.key).test(readFileSync(path, 'utf8'))) {
          problems.push(`i18n-allowlist.json: "${entry.key}" path does not reference the key: ${entry.path}`);
        }
      } else if (group === 'allowlist') {
        problems.push(`i18n-allowlist.json: live key "${entry.key}" needs a rendering path`);
      }
    }
  }

  // Dead keys must not be referenced by live code. The one allowed exception is
  // the pinned dead component (`entry.path`), which keeps tsc's TranslationKey
  // type happy until QA-X-25 removes it.
  const sourceText = new Map(sourceFiles.map((file) => [file, readFileSync(file, 'utf8')]));
  for (const entry of dead) {
    if (!entry || typeof entry.key !== 'string') continue;
    const reference = keyReference(entry.key);
    const pinned = entry.path ? resolve(rootDir, entry.path) : null;
    for (const [file, text] of sourceText) {
      if (pinned && file === pinned) continue;
      if (reference.test(text)) {
        const rel = relative(rootDir, file);
        problems.push(
          `i18n-allowlist.json: dead key "${entry.key}" is referenced by live code in ${rel}; translate it or remove it from deadKeys`,
        );
      }
    }
  }

  return { problems, keys, liveCount: live.length, deadCount: dead.length };
}

/**
 * Run the whole guard against a checkout.
 * @returns {{total: number, problems: string[], warnings: string[], liveCount: number, deadCount: number, v06Count: number, adjudicatedCount: number}}
 */
export function run({ rootDir = root } = {}) {
  const base = readJson(resolve(rootDir, `src/i18n/${BASE}.json`));
  const problems = [];
  const warnings = [];

  const allowlist = validateAllowlist({
    data: readJson(resolve(rootDir, 'scripts/i18n-allowlist.json')),
    base,
    sourceFiles: listSourceFiles(resolve(rootDir, 'src')),
    rootDir,
  });
  problems.push(...allowlist.problems);
  const v06 = readJson(resolve(rootDir, 'scripts/v06-keys.json'));
  problems.push(...checkV06({ base, v06, allowlistedKeys: allowlist.keys }));
  problems.push(...checkZhCjk({ base, allowlistedKeys: allowlist.keys }));

  for (const code of OTHERS) {
    const dict = readJson(resolve(rootDir, `src/i18n/${code}.json`));
    const result = checkLanguage({ code, base, dict });
    problems.push(...result.problems);
    warnings.push(...result.warnings);
  }

  if (allowlist.deadCount > 0) {
    warnings.push(
      `${allowlist.deadCount} dead zh-CN keys are CJK-exempt (0 live refs or only the pinned dead InputScreen.tsx); see scripts/i18n-allowlist.json — remove with QA-X-25`,
    );
  }

  return {
    total: Object.keys(base).length,
    problems,
    warnings,
    liveCount: allowlist.liveCount,
    deadCount: allowlist.deadCount,
    v06Count: Array.isArray(v06.keys) ? v06.keys.length : 0,
    adjudicatedCount: Array.isArray(v06.adjudicated) ? v06.adjudicated.length : 0,
  };
}

function main() {
  const result = run();
  const cjkCount = result.total - result.liveCount - result.deadCount;
  for (const warning of result.warnings) console.warn(`WARN ${warning}`);
  for (const problem of result.problems) console.error(`ERR  ${problem}`);
  if (result.problems.length > 0) {
    console.error(`\ni18n check failed: ${result.problems.length} problem(s) across ${result.total} keys.`);
    process.exit(1);
  }
  console.log(
    `i18n check passed: ${result.total} keys × ${1 + OTHERS.length} languages, placeholders aligned, no CJK in ${OTHERS.join(', ')}, ` +
      `zh-CN CJK ${cjkCount}/${result.total} (${result.liveCount} English-safe allowlisted + ${result.deadCount} dead keys), ` +
      `V-06 ${result.v06Count}/${result.v06Count} translated + ${result.adjudicatedCount} adjudicated.`,
  );
}

const selfPath = realpathSync(fileURLToPath(import.meta.url));
const entryPath = process.argv[1] ? realpathSync(resolve(process.argv[1])) : null;
if (entryPath === selfPath) {
  main();
}
