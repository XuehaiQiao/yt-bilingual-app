#!/usr/bin/env node
/**
 * install-hooks.mjs · 安装仓库级 git hook（治理门禁）
 *
 * 做的事：
 *   1. 确认 .githooks/pre-commit 存在，并 chmod +x；
 *   2. `git config core.hooksPath .githooks`；
 *   3. 读回校验。
 *
 * 用法：
 *   node scripts/install-hooks.mjs             # 安装（每个 clone 执行一次）
 *   node scripts/install-hooks.mjs --check     # 只检查，不安装
 *   node scripts/install-hooks.mjs --uninstall # 移除 core.hooksPath
 *   node scripts/install-hooks.mjs --root <path>  # 指定仓库（测试用）
 *
 * 提交规则（见 .githooks/pre-commit）：
 *   - 未设置 TASK_ID 且 GOVERNANCE_BYPASS!=1 → 拒绝提交；
 *   - 有 TASK_ID → 跑 `node scripts/agent-preflight.mjs --card "$TASK_ID" --staged`。
 * 说明：本脚本不修改全局 git config；`--no-verify` / GOVERNANCE_BYPASS=1 可绕过，
 *       所以 CI 的 governance job 才是最终兜底（分支保护仍待管理员配置）。
 *
 * 无第三方依赖，Node ≥ 22。退出码：0 成功 / 1 失败。
 */

import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(SCRIPT_DIR, '..');

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  if (result.error) throw new Error(`无法执行 git：${result.error.message}`);
  return result;
}

function gitOrFail(root, args, label = args.join(' ')) {
  const result = git(root, args);
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim();
    throw new Error(`git ${label} 失败（exit ${result.status}）${detail ? `：${detail}` : ''}`);
  }
  return result.stdout.trim();
}

function parseArgs(argv) {
  const opts = { check: false, uninstall: false, root: DEFAULT_ROOT, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--check') opts.check = true;
    else if (arg === '--uninstall') opts.uninstall = true;
    else if (arg === '--root') {
      i += 1;
      if (!argv[i]) throw new Error('--root 缺少路径');
      opts.root = resolve(argv[i]);
    } else if (arg.startsWith('--root=')) {
      opts.root = resolve(arg.slice('--root='.length));
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

const USAGE = `用法：node scripts/install-hooks.mjs [--check | --uninstall] [--root <path>]

安装后：core.hooksPath=.githooks，pre-commit 强制要求 TASK_ID（或显式 GOVERNANCE_BYPASS=1）。
每个 clone 执行一次；安装不修改全局 git config。`;

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    console.log(USAGE);
    return 0;
  }
  const root = opts.root;
  const hooksDir = resolve(root, '.githooks');
  const hookPath = resolve(hooksDir, 'pre-commit');

  const inside = git(root, ['rev-parse', '--git-dir']);
  if (inside.status !== 0) {
    throw new Error(`不是 git 仓库：${root}`);
  }

  const current = git(root, ['config', '--get', 'core.hooksPath']).stdout.trim();

  if (opts.check) {
    console.log('check-hooks');
    console.log(`  repo: ${root}`);
    console.log(`  core.hooksPath: ${current || '（未设置）'}`);
    console.log(`  hook: ${existsSync(hookPath) ? hookPath : `缺失：${hookPath}`}`);
    const ok = current === '.githooks' && existsSync(hookPath);
    console.log(ok ? '结果：✅ 已安装' : '结果：❌ 未安装（运行 node scripts/install-hooks.mjs）');
    return ok ? 0 : 1;
  }

  if (opts.uninstall) {
    if (current) {
      gitOrFail(root, ['config', '--unset', 'core.hooksPath'], 'config --unset core.hooksPath');
      console.log('✅ 已移除 core.hooksPath（git hook 不再生效）');
    } else {
      console.log('ℹ️  core.hooksPath 本就没有设置，无需移除');
    }
    return 0;
  }

  if (!existsSync(hookPath)) throw new Error(`hook 不存在：${hookPath}`);
  chmodSync(hookPath, 0o755);

  gitOrFail(root, ['config', 'core.hooksPath', '.githooks'], 'config core.hooksPath .githooks');
  const installed = gitOrFail(root, ['config', '--get', 'core.hooksPath'], 'config --get core.hooksPath');
  if (installed !== '.githooks') {
    throw new Error(`安装后读回不一致：core.hooksPath=${installed}`);
  }

  console.log('✅ 已安装治理 git hook');
  console.log(`  repo: ${root}`);
  console.log('  core.hooksPath: .githooks');
  console.log(`  pre-commit: ${hookPath}（可执行）`);
  console.log('');
  console.log('用法：TASK_ID=P0-06 git commit -m "..."');
  console.log('紧急绕过：GOVERNANCE_BYPASS=1 git commit ...（事后必须在 handoff/PR 记录原因）');
  console.log('检查：node scripts/install-hooks.mjs --check');
  return 0;
}

function isEntrypoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url));
}

if (isEntrypoint()) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(`❌ install-hooks 错误：${error.message}`);
    process.exitCode = 1;
  }
}
