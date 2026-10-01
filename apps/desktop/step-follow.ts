/**
 * 官方源仓库的快进。
 * 只在工作树干净时快进到 origin/main。失败则回到快进前的提交。
 * 不把 step.exe 的安装目录当作运行时。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OFFICIAL_STEP_SOURCE, readStepOrigin, resolveStepCheckout } from './step-extension';

export interface FollowResult {
  updated: boolean;
  note: string;
  head: string;
}

export type GitRunner = (args: string[], cwd: string) => string;

const BUILD_PACKAGES = ['agent-core', 'providers', 'tui', 'config', 'coding-agent'];

export function followCleanCheckout(
  root: string,
  git: GitRunner = realGit,
  build: (root: string) => void = buildCheckout,
): FollowResult {
  const local = git(['rev-parse', 'HEAD'], root).trim();
  try {
    git(['fetch', 'origin'], root);
  } catch (err) {
    return { updated: false, note: `无法获取官方更新，仍用当前检出：${message(err)}`, head: local };
  }
  let remote: string;
  try {
    remote = git(['rev-parse', 'origin/main'], root).trim();
  } catch (err) {
    return { updated: false, note: `官方远程没有 origin/main，仍用当前检出：${message(err)}`, head: local };
  }
  if (local === remote) {
    return { updated: false, note: `运行时已是官方 tip ${local.slice(0, 8)}`, head: local };
  }
  const dirty = git(['status', '--porcelain'], root).trim();
  if (dirty) {
    return {
      updated: false,
      note: `官方 tip ${remote.slice(0, 8)} 已前进，检出有本地改动，不快进`,
      head: local,
    };
  }
  try {
    git(['merge', '--ff-only', 'origin/main'], root);
  } catch (err) {
    restore(root, local, git);
    return { updated: false, note: `快进失败，已回到 ${local.slice(0, 8)}：${message(err)}`, head: local };
  }
  const after = git(['rev-parse', 'HEAD'], root).trim();
  if (after === local) return { updated: false, note: '快进没有移动 HEAD', head: local };
  try {
    build(root);
  } catch (err) {
    restore(root, local, git);
    return { updated: false, note: `重建失败，已回到 ${local.slice(0, 8)}：${message(err)}`, head: local };
  }
  return { updated: true, note: `已快进到官方 ${after.slice(0, 8)}`, head: after };
}

export function prepareOfficialRuntime(): { root?: string; note: string } {
  let root: string;
  try {
    root = resolveStepCheckout();
  } catch (err) {
    return { note: message(err) };
  }
  const origin = readStepOrigin(root);
  if (!origin || origin.source !== OFFICIAL_STEP_SOURCE) {
    return { note: '没有官方源仓库检出，使用随包锁定点' };
  }
  const followed = followCleanCheckout(root);
  const entry = path.join(root, 'packages', 'coding-agent', 'dist', 'index.js');
  if (!fs.existsSync(entry)) {
    return { note: `${followed.note}；锁定包尚未构建，使用随包锁定点` };
  }
  return { root, note: followed.note };
}

function buildCheckout(root: string): void {
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) throw new Error('没有 tsc，不能重建官方运行时');
  for (const name of BUILD_PACKAGES) {
    const project = path.join(root, 'packages', name, 'tsconfig.build.json');
    if (!fs.existsSync(project)) throw new Error(`${name} 没有 tsconfig.build.json`);
    execFileSync(process.execPath, [tsc, '-p', project], { stdio: 'ignore' });
  }
}

function restore(root: string, head: string, git: GitRunner): void {
  try {
    const now = git(['rev-parse', 'HEAD'], root).trim();
    if (now !== head) git(['reset', '--hard', head], root);
  } catch {
    // 回退失败留给调用方的日志，不再抛，避免盖住原来的失败原因。
  }
}

function realGit(args: string[], cwd: string): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
