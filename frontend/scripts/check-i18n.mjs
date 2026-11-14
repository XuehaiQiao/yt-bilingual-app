#!/usr/bin/env node
// Dictionary guard for the UI languages (specs/012-i18n-multilingual §5.7).
//
// zh-CN.json is the structural source of truth. This script catches the things
// TypeScript cannot:
//   1. vi-VN keys missing from / extra compared to zh-CN (tsc catches missing
//      only when the dictionary is typed; this keeps parity explicit);
//   2. `{{placeholder}}` sets drifting between languages;
//   3. CJK characters leaking into the Vietnamese dictionary.
//
// Run: npm run check:i18n   (or: node scripts/check-i18n.mjs)
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BASE = 'zh-CN';
const OTHERS = ['vi-VN'];
const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const placeholder = (value) => [...value.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]).sort().join(',');

const readDict = (code) => JSON.parse(readFileSync(resolve(root, `src/i18n/${code}.json`), 'utf8'));
const base = readDict(BASE);
const problems = [];
const warnings = [];

for (const code of OTHERS) {
  const dict = readDict(code);
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
}

const total = Object.keys(base).length;
for (const warning of warnings) console.warn(`WARN ${warning}`);
for (const problem of problems) console.error(`ERR  ${problem}`);
if (problems.length > 0) {
  console.error(`\ni18n check failed: ${problems.length} problem(s) across ${total} keys.`);
  process.exit(1);
}
console.log(`i18n check passed: ${total} keys × ${1 + OTHERS.length} languages, placeholders aligned, no CJK in ${OTHERS.join(', ')}.`);
