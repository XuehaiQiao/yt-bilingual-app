#!/usr/bin/env node
/**
 * contrast-audit.mjs · 设计 token 对比度实测（WCAG 2.1）
 *
 * 用途（W3 后续 / design QA QA-X-30、附录 G）：
 *   1. 从 `frontend/tailwind.config.js` 读取 token 定义，计算文字色 / 底色对的
 *      WCAG 2.1 相对亮度比值（与附录 G 的登记口径一致：底色 `app #09090b`）。
 *   2. 用 Playwright 打开 `#/dev/ui` 的 token 探针，读取浏览器实际计算的
 *      color / background-color，检查静态定义与渲染值是否一致（取色实测）。
 *   3. 输出 PASS / FAIL / 已登记例外 / 观测项；不写文件、不接 CI。
 *
 * 定位：**report-only**。默认退出码 0（参数/内部错误除外）；只有显式
 * `--fail` 才在存在 token FAIL 时退出 1。观测项（usage-context）不阻断。
 *
 * 用法：
 *   node scripts/contrast-audit.mjs                    # 全量：静态计算 + 浏览器取色
 *   node scripts/contrast-audit.mjs --no-browser       # 只做静态计算
 *   node scripts/contrast-audit.mjs --json             # 机器可读
 *   node scripts/contrast-audit.mjs --fail             # 有 token FAIL 时退出码 1
 *   node scripts/contrast-audit.mjs --self-test        # 校验对比度/混色函数
 *   node scripts/contrast-audit.mjs --help
 *   APP_URL=http://localhost:5173 node scripts/contrast-audit.mjs
 *
 * 需要：Node ≥ 18；`--no-browser` 之外需要 scripts/node_modules 的 playwright
 * （默认走系统 Chrome，可用 PLAYWRIGHT_CHANNEL 覆盖）。只读，不改 git 状态。
 */

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const VERSION = '1.0';
const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '..');
const TOKENS_FILE = 'frontend/tailwind.config.js';
const APP_URL = (process.env.APP_URL || 'http://localhost:5173').replace(/\/+$/, '');
const DEV_UI_HASH = '#/dev/ui';

const USAGE = `contrast-audit v${VERSION} · WCAG 2.1 对比度实测（report-only，不接 CI）

用法：
  node scripts/contrast-audit.mjs                 静态计算 + 浏览器取色（默认）
  node scripts/contrast-audit.mjs --no-browser    只做静态 token 计算
  node scripts/contrast-audit.mjs --json          JSON 输出
  node scripts/contrast-audit.mjs --fail          存在 token FAIL 时退出码 1（默认 0）
  node scripts/contrast-audit.mjs --self-test     对比度/混色函数自测
  node scripts/contrast-audit.mjs --help

环境变量：
  APP_URL                浏览器实测地址（默认 http://localhost:5173）
  PLAYWRIGHT_CHANNEL     Playwright 浏览器通道（默认 chrome；失败再试内置 chromium）

口径：
  A 类文字 ≥ 4.5:1；B 类 fg-muted 4.12:1 为已登记例外（仅非关键元信息）；
  C 类 fg-disabled 仅禁用态；fill 类不按文字判定；usage-context 为观测项。
`;

/* ── 颜色 / WCAG ─────────────────────────────────────────────────────────── */

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

/** @returns {{r:number,g:number,b:number,a:number}|null} 0–255, a 0–1 */
export function parseCssColor(value) {
  const text = String(value ?? '').trim().toLowerCase();
  if (!text) return null;

  const hex = text.match(/^#([0-9a-f]{3,8})$/);
  if (hex) {
    let digits = hex[1];
    if (digits.length === 3 || digits.length === 4) {
      digits = digits
        .slice(0, 3)
        .split('')
        .map((digit) => digit + digit)
        .join('');
    }
    if (digits.length === 6 || digits.length === 8) {
      const r = Number.parseInt(digits.slice(0, 2), 16);
      const g = Number.parseInt(digits.slice(2, 4), 16);
      const b = Number.parseInt(digits.slice(4, 6), 16);
      const a = digits.length === 8 ? Number.parseInt(digits.slice(6, 8), 16) / 255 : 1;
      return { r, g, b, a };
    }
  }

  const rgb = text.match(/^rgba?\((.+)\)$/);
  if (rgb) {
    const parts = rgb[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const channels = parts.slice(0, 3).map((part) => {
        const raw = part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number.parseFloat(part);
        return clamp(Math.round(raw), 0, 255);
      });
      const alphaPart = parts[3];
      const alpha = alphaPart === undefined
        ? 1
        : clamp(alphaPart.endsWith('%') ? Number.parseFloat(alphaPart) / 100 : Number.parseFloat(alphaPart), 0, 1);
      if (channels.every((channel) => Number.isFinite(channel)) && Number.isFinite(alpha)) {
        return { r: channels[0], g: channels[1], b: channels[2], a: alpha };
      }
    }
  }
  return null;
}

export function toHex(color) {
  const hex = (value) => clamp(Math.round(value), 0, 255).toString(16).padStart(2, '0');
  return `#${hex(color.r)}${hex(color.g)}${hex(color.b)}`.toUpperCase();
}

/** Source-over composite of `top` on an opaque `bottom`. */
export function blendOver(top, bottom) {
  const alpha = top.a ?? 1;
  return {
    r: top.r * alpha + bottom.r * (1 - alpha),
    g: top.g * alpha + bottom.g * (1 - alpha),
    b: top.b * alpha + bottom.b * (1 - alpha),
    a: 1,
  };
}

export function relativeLuminance(color) {
  const channel = (value) => {
    const normalized = clamp(value, 0, 255) / 255;
    return normalized <= 0.03928
      ? normalized / 12.92
      : Math.pow((normalized + 0.055) / 1.055, 2.4);
  };
  return (
    0.2126 * channel(color.r) +
    0.7152 * channel(color.g) +
    0.0722 * channel(color.b)
  );
}

export function contrastRatio(foreground, background) {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/* ── Tokens ──────────────────────────────────────────────────────────────── */

async function loadTokenColors() {
  const configUrl = pathToFileURL(join(REPO_ROOT, TOKENS_FILE)).href;
  const { default: config } = await import(configUrl);
  const colors = config?.theme?.extend?.colors;
  if (!colors) throw new Error(`${TOKENS_FILE}: theme.extend.colors not found`);
  return colors;
}

/**
 * Resolve the semantic names used in the audit to the Tailwind config tree:
 * `fg-primary` → colors.fg.primary, `brand-300` → colors.brand['300'],
 * `success-fg` → colors.success.fg, `app` → colors.app.
 */
export function resolveToken(colors, name) {
  const parts = String(name).split('-');
  const root = colors[parts[0]];
  if (root === undefined || root === null) {
    throw new Error(`Unknown token "${name}" (no colors.${parts[0]})`);
  }
  if (typeof root === 'string') {
    if (parts.length > 1) throw new Error(`Token "${name}" is not an object`);
    return root;
  }
  if (parts.length === 1) {
    if (typeof root.DEFAULT === 'string') return root.DEFAULT;
    throw new Error(`Token "${name}" has no DEFAULT`);
  }
  const key = parts.slice(1).join('-');
  if (typeof root[key] === 'string') return root[key];
  throw new Error(`Unknown token "${name}" (no colors.${parts[0]}["${key}"])`);
}

function colorOf(colors, name) {
  const value = resolveToken(colors, name);
  const parsed = parseCssColor(value);
  if (!parsed) throw new Error(`Token "${name}" is not a CSS color: ${value}`);
  return parsed;
}

/* ── Audit matrix ────────────────────────────────────────────────────────── */

const TEXT_PAIRS = [
  { id: 'fg-primary', label: 'fg-primary on app', fg: 'fg-primary', bg: 'app', kind: 'A', note: '正文强调 / 标题（附录 G 18.10）' },
  { id: 'fg-strong', label: 'fg-strong on app', fg: 'fg-strong', bg: 'app', kind: 'A', note: '列表主文字 / 次按钮（附录 G 13.46）' },
  { id: 'fg-secondary', label: 'fg-secondary on app', fg: 'fg-secondary', bg: 'app', kind: 'A', note: '说明 / 空态 / 占位（附录 G 7.76）' },
  { id: 'fg-muted', label: 'fg-muted on app', fg: 'fg-muted', bg: 'app', kind: 'B', note: 'B 类已登记例外 4.12；仅非关键元信息' },
  { id: 'fg-disabled', label: 'fg-disabled on app', fg: 'fg-disabled', bg: 'app', kind: 'C', note: 'C 类仅禁用态（WCAG 豁免）' },
  { id: 'brand', label: 'brand on app', fg: 'brand', bg: 'app', kind: 'A', note: '品牌文字 / 图标（附录 G 5.45；不作 11px 正文）' },
  { id: 'brand-300', label: 'brand-300 on app', fg: 'brand-300', bg: 'app', kind: 'A', note: '品牌文字 / 图标（附录 G 8.73）' },
  { id: 'brand-400', label: 'brand-400 on app', fg: 'brand-400', bg: 'app', kind: 'A', note: '品牌图标 / hover 文字（附录 G 7.03）' },
  { id: 'success-fg', label: 'success-fg on app', fg: 'success-fg', bg: 'app', kind: 'A', note: '成功文字（附录 G 10.35）' },
  { id: 'warning-fg', label: 'warning-fg on app', fg: 'warning-fg', bg: 'app', kind: 'A', note: '警告文字（附录 G 11.92）' },
  { id: 'danger-fg', label: 'danger-fg on app', fg: 'danger-fg', bg: 'app', kind: 'A', note: '危险文字（附录 G 7.19）' },
  { id: 'highlight-fg', label: 'highlight-fg on app', fg: 'highlight-fg', bg: 'app', kind: 'A', note: 'AI 高亮注释（附录 G 11.25）' },
  { id: 'fg-inverse-control', label: 'fg-inverse on control', fg: 'fg-inverse', bg: 'control', kind: 'A', note: 'primary 按钮文字（18.10）' },
  { id: 'fg-inverse-brand', label: 'fg-inverse on brand', fg: 'fg-inverse', bg: 'brand', kind: 'A', note: 'CountBadge 文字（5.45）' },
];

const FILL_TOKENS = [
  { id: 'brand-600', label: 'brand-600 on app', fg: 'brand-600', bg: 'app', note: '仅作填充；附录 G 4.43 不作文字' },
  { id: 'success', label: 'success on app', fg: 'success', bg: 'app', note: '仅作填充/圆点；不作文字' },
  { id: 'warning', label: 'warning on app', fg: 'warning', bg: 'app', note: '仅作填充/圆点；不作文字' },
  { id: 'danger', label: 'danger on app', fg: 'danger', bg: 'app', note: '仅作填充/圆点；不作文字' },
  { id: 'highlight', label: 'highlight on app', fg: 'highlight', bg: 'app', note: 'AI 高亮底/边框；注释用 highlight-fg' },
];

/**
 * Usage contexts: the token pair as actually composed with an alpha surface.
 * These are informative (not part of the appendix G "on app" registration);
 * values below the text threshold are reported as OBSERVE, never as PASS.
 */
const CONTEXT_PAIRS = [
  { id: 'fg-strong-secondary', label: 'fg-strong on surface-2/60', fg: 'fg-strong', bg: 'surface-2', bgAlpha: 0.6, note: 'secondary 按钮文字' },
  { id: 'fg-secondary-card', label: 'fg-secondary on surface/40', fg: 'fg-secondary', bg: 'surface', bgAlpha: 0.4, note: 'Card 说明文字' },
  { id: 'brand-tinted', label: 'brand-300 on brand/10', fg: 'brand-300', bg: 'brand', bgAlpha: 0.1, note: 'brand tinted 按钮 / Badge' },
  { id: 'success-tinted', label: 'success-fg on success/10', fg: 'success-fg', bg: 'success', bgAlpha: 0.1, note: 'success tinted 按钮 / Badge' },
  { id: 'warning-tinted', label: 'warning-fg on warning/10', fg: 'warning-fg', bg: 'warning', bgAlpha: 0.1, note: 'warning tinted 按钮 / Badge' },
  { id: 'danger-tinted', label: 'danger-fg on danger/10', fg: 'danger-fg', bg: 'danger', bgAlpha: 0.1, note: 'destructive 按钮 / Badge' },
  { id: 'highlight-tinted', label: 'highlight-fg on highlight/15', fg: 'highlight-fg', bg: 'highlight', bgAlpha: 0.15, note: 'highlight Badge' },
  { id: 'fg-muted-listrow', label: 'fg-muted on surface-2/30', fg: 'fg-muted', bg: 'surface-2', bgAlpha: 0.3, observeOnly: true, note: 'ListRow meta；B 类例外在实际底色上复核' },
  { id: 'fg-muted-listrow-hover', label: 'fg-muted on surface-2/60', fg: 'fg-muted', bg: 'surface-2', bgAlpha: 0.6, observeOnly: true, note: 'ListRow hover meta；B 类例外在实际底色上复核' },
];

const BROWSER_TOKENS = [
  // Text tokens exposed by ComponentMatrix `[data-token]`.
  'fg-primary', 'fg-strong', 'fg-secondary', 'fg-muted', 'fg-disabled', 'fg-inverse',
  'brand', 'brand-300', 'brand-400', 'success-fg', 'warning-fg', 'danger-fg', 'highlight-fg',
  // Background tokens exposed by `[data-token-bg]`.
  'app', 'surface', 'surface-2', 'surface-3', 'control', 'brand', 'success', 'warning',
  'danger', 'highlight',
];

function classify(pair, ratio) {
  if (pair.kind === 'fill') {
    return { verdict: 'N/A', passes: true, counted: false, reason: '仅填充，不按文字判定' };
  }
  if (pair.kind === 'C') {
    return { verdict: 'EXEMPT', passes: true, counted: false, reason: '仅 disabled（WCAG 豁免）' };
  }
  if (pair.kind === 'B') {
    return ratio >= 4.11
      ? { verdict: 'PASS', passes: true, counted: true, reason: 'B 类登记例外（4.12，非关键元信息）' }
      : { verdict: 'FAIL', passes: false, counted: true, reason: '低于已登记 B 类 4.12' };
  }
  if (pair.observeOnly) {
    return ratio >= 4.5
      ? { verdict: 'PASS', passes: true, counted: false, reason: '实际使用场景 ≥4.5' }
      : { verdict: 'OBSERVE', passes: true, counted: false, reason: '实际使用场景低于 4.5（观测项）' };
  }
  return ratio >= 4.5
    ? { verdict: 'PASS', passes: true, counted: true, reason: 'A 类文字 ≥4.5' }
    : { verdict: 'FAIL', passes: false, counted: true, reason: 'A 类文字 <4.5' };
}

function evaluatePair(colors, pair, index) {
  const fg = colorOf(colors, pair.fg);
  let bg = colorOf(colors, pair.bg);
  if (pair.bgAlpha !== undefined) {
    bg = blendOver({ ...bg, a: pair.bgAlpha }, colorOf(colors, pair.over ?? 'app'));
  }
  const ratio = contrastRatio(fg, bg);
  const result = classify(pair, ratio);
  return {
    index,
    id: pair.id,
    label: pair.label,
    fg: toHex(fg),
    bg: toHex(bg),
    ratio: Number(ratio.toFixed(3)),
    kind: pair.kind ?? (pair.observeOnly ? 'context' : 'A'),
    ...result,
    note: pair.note ?? '',
  };
}

function buildReport(colors) {
  const text = TEXT_PAIRS.map((pair, index) => evaluatePair(colors, pair, index + 1));
  const fills = FILL_TOKENS.map((pair, index) => evaluatePair(colors, { ...pair, kind: 'fill' }, index + 1));
  const contexts = CONTEXT_PAIRS.map((pair, index) => evaluatePair(colors, pair, index + 1));
  return { text, fills, contexts };
}

/* ── Browser sampling ────────────────────────────────────────────────────── */

function formatRgbSample(value) {
  const parsed = parseCssColor(value);
  return parsed ? toHex(parsed) : null;
}

async function sampleBrowser(url) {
  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (error) {
    return { ok: false, reason: `playwright unavailable (${error.message.split('\n')[0]})` };
  }

  let browser;
  const launchOptions = { headless: true };
  const channel = process.env.PLAYWRIGHT_CHANNEL || 'chrome';
  try {
    browser = await chromium.launch({ ...launchOptions, channel });
  } catch (firstError) {
    try {
      browser = await chromium.launch(launchOptions);
    } catch (secondError) {
      return { ok: false, reason: `browser launch failed (${secondError.message.split('\n')[0]})` };
    }
  }

  try {
    const context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      colorScheme: 'dark',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.goto(`${url}/${DEV_UI_HASH}`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForSelector('[data-testid="dev-ui-screen"]', { timeout: 20000 });
    const samples = await page.evaluate(() => {
      const text = {};
      const bg = {};
      for (const element of document.querySelectorAll('[data-token]')) {
        const token = element.getAttribute('data-token');
        if (token) text[token] = window.getComputedStyle(element).color;
      }
      for (const element of document.querySelectorAll('[data-token-bg]')) {
        const token = element.getAttribute('data-token-bg');
        if (token) bg[token] = window.getComputedStyle(element).backgroundColor;
      }
      return { text, bg, title: document.title, path: `${window.location.pathname}${window.location.hash}` };
    });
    const version = typeof browser.version === 'function' ? browser.version() : 'unknown';
    return { ok: true, samples, url: page.url(), version };
  } catch (error) {
    return { ok: false, reason: error.message.split('\n')[0] };
  } finally {
    await browser.close().catch(() => {});
  }
}

function compareBrowserSamples(colors, browser) {
  if (!browser.ok) return { ok: false, reason: browser.reason, rows: [], matched: 0, total: 0 };
  const rows = [];
  const check = (token, expected, actual, surface) => {
    const actualHex = formatRgbSample(actual);
    if (!actualHex) {
      rows.push({ token, surface, expected, actual: String(actual), delta: null, ok: false });
      return;
    }
    const expectedColor = colorOf(colors, token);
    const actualColor = parseCssColor(actualHex);
    const delta = Math.max(
      Math.abs(expectedColor.r - actualColor.r),
      Math.abs(expectedColor.g - actualColor.g),
      Math.abs(expectedColor.b - actualColor.b),
    );
    rows.push({
      token,
      surface,
      expected: toHex(expectedColor),
      actual: actualHex,
      delta,
      ok: delta <= 1,
    });
  };

  for (const token of [...new Set(BROWSER_TOKENS)]) {
    if (browser.samples.text[token]) {
      check(token, 'text', browser.samples.text[token], 'text');
    }
    if (browser.samples.bg[token]) {
      check(token, 'bg', browser.samples.bg[token], 'background');
    }
  }

  const matched = rows.filter((row) => row.ok).length;
  return { ok: true, reason: '', rows, matched, total: rows.length };
}

/* ── CLI output ──────────────────────────────────────────────────────────── */

export function summarize(report, browser) {
  const tokenPairs = report.text.filter((row) => row.counted);
  const tokenPass = tokenPairs.filter((row) => row.passes).length;
  const tokenFail = tokenPairs.length - tokenPass;
  const contextObserve = report.contexts.filter((row) => row.verdict === 'OBSERVE').length;
  const contextFail = report.contexts.filter((row) => !row.passes).length;
  return {
    tokenPairs: tokenPairs.length,
    tokenPass,
    tokenFail,
    contextObserve,
    contextFail,
    browserOk: browser.ok,
    browserMatched: browser.ok ? browser.matched : 0,
    browserTotal: browser.ok ? browser.total : 0,
    browserDrift: browser.ok ? browser.rows.filter((row) => !row.ok).length : null,
    pass: tokenFail === 0 && contextFail === 0 && (browser.ok ? browser.matched === browser.total : true),
  };
}

function pad(value, width) {
  const text = String(value);
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

function printReport({ report, browser, summary, url }) {
  console.log(`contrast-audit v${VERSION} · WCAG 2.1 相对亮度`);
  console.log(`repo:    ${REPO_ROOT}`);
  console.log(`tokens:  ${TOKENS_FILE}`);
  console.log(`base:    app ${toHex(colorOfToken('app'))}（附录 G 计算口径）`);
  if (browser.ok) {
    console.log(`browser: ${url}/${DEV_UI_HASH} (${browser.version})`);
  } else {
    console.log(`browser: unavailable — ${browser.reason}`);
  }
  console.log('');

  const printRows = (rows) => {
    console.log(`${pad('PAIR', 36)} ${pad('FG', 9)} ${pad('BG', 9)} ${pad('RATIO', 7)} ${pad('MIN', 6)} ${pad('RESULT', 8)} NOTE`);
    for (const row of rows) {
      const min = row.kind === 'A' ? '4.50' : row.kind === 'B' ? '4.12' : row.kind === 'C' ? '—' : row.kind === 'fill' ? '—' : '4.50';
      console.log(`${pad(row.label, 36)} ${pad(row.fg, 9)} ${pad(row.bg, 9)} ${pad(row.ratio.toFixed(2), 7)} ${pad(min, 6)} ${pad(row.verdict, 8)} ${row.note}`);
    }
  };

  console.log('[1] Token text pairs（附录 G 登记口径）');
  printRows(report.text);
  console.log('');
  console.log('[2] Fill tokens（非文字，不计 PASS/FAIL）');
  printRows(report.fills);
  console.log('');
  console.log('[3] Usage-context pairs（实际底色；观测项，不计 token FAIL）');
  printRows(report.contexts);
  console.log('');

  console.log('[4] Browser computed-style samples');
  if (!browser.ok) {
    console.log(`  unavailable: ${browser.reason}`);
  } else {
    console.log(`  ${pad('TOKEN', 16)} ${pad('SURFACE', 10)} ${pad('EXPECTED', 10)} ${pad('ACTUAL', 10)} ${pad('DELTA', 6)} RESULT`);
    for (const row of browser.rows) {
      console.log(`  ${pad(row.token, 16)} ${pad(row.surface, 10)} ${pad(row.expected, 10)} ${pad(row.actual, 10)} ${pad(row.delta ?? '—', 6)} ${row.ok ? 'MATCH' : 'DRIFT'}`);
    }
    console.log(`  browser samples: ${browser.matched}/${browser.total} match`);
  }
  console.log('');
  console.log('SUMMARY');
  console.log(`  token pairs: ${summary.tokenPass}/${summary.tokenPairs} PASS, ${summary.tokenFail} FAIL`);
  console.log(`  registered exceptions: fg-muted 4.12 (B), fg-disabled 2.57 (C), brand-600/highlight/fills (fill-only)`);
  console.log(`  usage-context: ${summary.contextObserve} OBSERVE, ${summary.contextFail} FAIL (informative)`);
  console.log(`  browser: ${browser.ok ? `${summary.browserMatched}/${summary.browserTotal} match` : 'unavailable'}`);
  console.log(`  RESULT: ${summary.pass ? 'PASS (token pairs)' : 'FAIL (token pairs)'}${summary.contextObserve ? `; ${summary.contextObserve} observation(s)` : ''}`);
  console.log('');
  console.log('report-only · 未接 CI · 未修改 UI');
}

function colorOfToken(name) {
  return colorOf(CURRENT_COLORS, name);
}

let CURRENT_COLORS = null;

/* ── Self-test ───────────────────────────────────────────────────────────── */

function runSelfTest() {
  const close = (actual, expected, tolerance = 0.01) => Math.abs(actual - expected) <= tolerance;
  const cases = [];
  const black = parseCssColor('#000000');
  const white = parseCssColor('#ffffff');
  cases.push(['black/white = 21', close(contrastRatio(black, white), 21)]);
  cases.push(['fg-muted on app = 4.12', close(contrastRatio(parseCssColor('#71717a'), parseCssColor('#09090b')), 4.12, 0.02)]);
  cases.push(['brand on app = 5.45', close(contrastRatio(parseCssColor('#0A84FF'), parseCssColor('#09090b')), 5.45, 0.02)]);
  cases.push(['blend 50% white over black = #808080', toHex(blendOver({ r: 255, g: 255, b: 255, a: 0.5 }, black)) === '#808080']);
  cases.push(['parse rgba', toHex(parseCssColor('rgba(102, 176, 255, 1)')) === '#66B0FF']);
  cases.push(['alpha blend changes luminance', contrastRatio(parseCssColor('#f4f4f5'), parseCssColor('#000000')) > contrastRatio(parseCssColor('#f4f4f5'), parseCssColor('#ffffff'))]);
  const passed = cases.filter(([, ok]) => ok).length;
  for (const [name, ok] of cases) console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  console.log(`self-test ${passed}/${cases.length} PASS`);
  return passed === cases.length;
}

/* ── Main ────────────────────────────────────────────────────────────────── */

async function main(argv) {
  const args = new Set(argv.slice(2));
  if (args.has('--help') || args.has('-h')) {
    console.log(USAGE);
    return;
  }
  if (args.has('--self-test')) {
    process.exitCode = runSelfTest() ? 0 : 1;
    return;
  }

  CURRENT_COLORS = await loadTokenColors();
  const { report, summary: built } = { report: buildReport(CURRENT_COLORS), summary: null };
  const browser = args.has('--no-browser')
    ? { ok: false, reason: 'skipped with --no-browser' }
    : await sampleBrowser(APP_URL);
  const comparedBrowser = browser.ok
    ? { ...browser, ...compareBrowserSamples(CURRENT_COLORS, browser) }
    : { ...browser, rows: [], matched: 0, total: 0 };
  const summary = summarize(report, comparedBrowser);

  if (args.has('--json')) {
    console.log(JSON.stringify({
      version: VERSION,
      generatedAt: new Date().toISOString(),
      app: APP_URL,
      tokensFile: TOKENS_FILE,
      base: 'app #09090B',
      report,
      browser: {
        ok: comparedBrowser.ok,
        reason: comparedBrowser.reason,
        url: comparedBrowser.url ?? null,
        version: comparedBrowser.version ?? null,
        rows: comparedBrowser.rows,
        matched: comparedBrowser.matched,
        total: comparedBrowser.total,
      },
      summary,
    }, null, 2));
  } else {
    printReport({ report, browser: comparedBrowser, summary, url: APP_URL });
  }

  if (args.has('--fail') && !summary.pass) process.exitCode = 1;
  void built;
}

main(process.argv).catch((error) => {
  console.error(`contrast-audit: ${error.message}`);
  process.exitCode = 2;
});
