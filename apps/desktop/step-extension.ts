/**
 * 进程内组合接缝。
 * 只调用锁定点的 createStepExtensionInline。权限值只能是 bypass 或 autopilot。
 * confirm 是本 GUI 的回调，绑到权限钩子读取的 ui.confirm。
 * 不把会话工厂或代码宿主当作已接好的运行时，不改裁决函数。
 */
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STEP_LOCK_COMMIT = '93ebc5bea25032a77af007a968a8998b492989f5';
export const STEP_LOCK_TREE = 'c94a0b58ec48c1d5b83d30c122a5dd74c4f0e3d3';
export const STEP_PACKAGE_NAME = '@step-harness/coding-agent';
export const STEP_PACKAGE_VERSION = '0.84.4';
export const OFFICIAL_STEP_SOURCE = 'stepfun-ai/Step-Code';
export const GUI_CONFIRM_CHANNEL = 'orchdesk:authz-approval-request';

const STEP_PRESETS = ['bypass', 'autopilot'] as const;
export type StepPreset = (typeof STEP_PRESETS)[number];

export interface GuiPermissionMode {
  id: StepPreset;
  label: '默认模式' | '完全信任';
  blurb: string;
}

/** 界面只有这两档。机器标识仍是 bypass / autopilot，文案不能再长出第三档。 */
export const GUI_PERMISSION_MODES: readonly GuiPermissionMode[] = [
  {
    id: 'bypass',
    label: '默认模式',
    blurb: '普通工具直接运行。危险命令仍由本界面确认。',
  },
  {
    id: 'autopilot',
    label: '完全信任',
    blurb: '普通工具直接运行，并在模型短暂失败后续跑。危险命令仍由本界面确认。',
  },
];

export function listGuiPermissionModes(): GuiPermissionMode[] {
  return GUI_PERMISSION_MODES.map((mode) => ({ ...mode }));
}

export type StepConfirm = (
  title: string,
  message: string,
  opts?: { signal?: AbortSignal; timeout?: number; overlay?: boolean },
) => Promise<boolean>;

export interface StepPermissionOptions {
  initialPreset: StepPreset;
  /** 空对象，避免宿主环境把未选择的策略或放行开关带进锁定包。 */
  env: Record<string, string | undefined>;
}

export interface StepExtensionInlineOptions {
  permission: StepPermissionOptions;
}

export interface StepInlineExtension {
  name: string;
  hidden?: boolean;
  factory: (pi: StepExtensionApi) => void;
}

export interface StepExtensionModule {
  createStepExtensionInline: (options?: StepExtensionInlineOptions) => StepInlineExtension;
}

interface StepExtensionApi {
  on: (event: string, handler: (event: unknown, ctx: StepToolContext) => unknown) => void;
}

interface StepToolContext {
  hasUI?: boolean;
  ui?: { confirm?: StepConfirm };
}

export interface ComposedStepExtension {
  preset: StepPreset;
  extension: StepInlineExtension;
  confirm: StepConfirm;
  ui: { confirm: StepConfirm };
}

export interface GuiConfirmDeps {
  hasWindow: () => boolean;
  send: (channel: string, payload: unknown) => void;
  nextId: () => string;
  wait: (id: string, signal?: AbortSignal) => Promise<string>;
}

export interface StepLoadDeps {
  nodeVersion?: string;
  readLock?: (root: string) => { commit: string; tree: string };
  importModule?: (href: string) => Promise<StepExtensionModule>;
  entryExists?: (entry: string) => boolean;
  readOrigin?: (root: string) => { source: string; commit: string; tree: string } | null;
}

let current: ComposedStepExtension | null = null;
let toolHookBound = false;

export function stepToolHookBound(): boolean {
  return toolHookBound;
}

export function currentStepExtension(): ComposedStepExtension | null {
  return current;
}

export function nodeSatisfiesStepRuntime(version: string): boolean {
  const parts = version.split('.').map((part) => Number(part));
  const major = parts[0] ?? 0;
  const minor = parts[1] ?? 0;
  const patch = parts[2] ?? 0;
  if (major > 22) return true;
  if (major < 22) return false;
  if (minor > 19) return true;
  if (minor < 19) return false;
  return patch >= 0;
}

export function assertStepPreset(value: unknown): StepPreset {
  if (value !== 'bypass' && value !== 'autopilot') {
    throw new Error('权限策略只能是 bypass 或 autopilot');
  }
  return value;
}

/** 本 GUI 的 confirm。没有窗口、应答失败或非允许，都返回 false，不改写成放行。 */
export function createGuiStepConfirm(deps: GuiConfirmDeps): StepConfirm {
  return async (title, message, opts) => {
    if (!deps.hasWindow()) return false;
    if (opts?.signal?.aborted) return false;
    const id = deps.nextId();
    try {
      deps.send(GUI_CONFIRM_CHANNEL, {
        id,
        toolName: String(title || '受限操作'),
        reason: String(message || ''),
      });
      const outcome = await deps.wait(id, opts?.signal);
      return outcome === 'allowed-once';
    } catch {
      return false;
    }
  };
}

export function composeStepExtension(input: {
  preset: unknown;
  confirm: StepConfirm | null | undefined;
  hasConfirmUi?: boolean;
  load: StepExtensionModule;
}): ComposedStepExtension {
  const preset = assertStepPreset(input.preset);
  if (input.hasConfirmUi === false || typeof input.confirm !== 'function') {
    throw new Error('没有确认界面，不得放行');
  }
  const confirm = input.confirm;
  const extension = bindGuiConfirm(
    input.load.createStepExtensionInline({
      permission: { initialPreset: preset, env: {} },
    }),
    confirm,
  );
  const wired: ComposedStepExtension = {
    preset,
    extension,
    confirm,
    ui: { confirm },
  };
  current = wired;
  return wired;
}

export async function connectStepExtension(input: {
  preset: unknown;
  confirm: StepConfirm | null | undefined;
  hasConfirmUi?: boolean;
  root?: string;
  env?: NodeJS.ProcessEnv;
  fromDir?: string;
  load?: StepExtensionModule;
  loadDeps?: StepLoadDeps;
}): Promise<ComposedStepExtension> {
  assertStepPreset(input.preset);
  if (input.hasConfirmUi === false || typeof input.confirm !== 'function') {
    throw new Error('没有确认界面，不得放行');
  }
  const load = input.load ?? await loadStepRuntime(
    input.root ?? resolveStepCheckout(input.env, input.fromDir),
    input.loadDeps,
  );
  return composeStepExtension({
    preset: input.preset,
    confirm: input.confirm,
    hasConfirmUi: input.hasConfirmUi,
    load,
  });
}

/**
 * 把界面选择落到已接上的组合。
 * 工具钩子一旦绑定，控制器闭包不再跟随这次选择，所以拒绝改成另一档，而不是假装已切换。
 */
export async function selectGuiPreset(input: {
  preset: unknown;
  confirm: StepConfirm | null | undefined;
  hasConfirmUi?: boolean;
  root?: string;
  env?: NodeJS.ProcessEnv;
  fromDir?: string;
  load?: StepExtensionModule;
  loadDeps?: StepLoadDeps;
}): Promise<{ ok: true; preset: StepPreset } | { ok: false; reason: string }> {
  let preset: StepPreset;
  try {
    preset = assertStepPreset(input.preset);
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
  if (input.hasConfirmUi === false || typeof input.confirm !== 'function') {
    return { ok: false, reason: '没有确认界面，不得放行' };
  }
  if (toolHookBound && current?.preset !== preset) {
    return { ok: false, reason: '工具钩子已绑定，本次运行不能改成另一套审批' };
  }
  if (current?.preset === preset) return { ok: true, preset };
  try {
    const wired = await connectStepExtension(input);
    return { ok: true, preset: wired.preset };
  } catch (err) {
    return { ok: false, reason: (err as Error).message };
  }
}

export function isOfficialStepRemote(value: string): boolean {
  const text = value.trim().replace(/\.git$/i, '').replace(/\\/g, '/');
  return text === OFFICIAL_STEP_SOURCE
    || text.endsWith('github.com/stepfun-ai/Step-Code')
    || text.endsWith('github.com:stepfun-ai/Step-Code');
}

export function readStepOrigin(root: string): { source: string; commit: string; tree: string } | null {
  const manifest = path.join(root, 'step-origin.json');
  if (fs.existsSync(manifest)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { source?: string; commit?: string; tree?: string };
      if (typeof parsed.source === 'string' && isOfficialStepRemote(parsed.source)) {
        return { source: OFFICIAL_STEP_SOURCE, commit: String(parsed.commit ?? ''), tree: String(parsed.tree ?? '') };
      }
    } catch {
      // 清单损坏时继续看 git remote。
    }
  }
  try {
    if (!fs.existsSync(path.join(root, '.git'))) return null;
    const remote = execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    if (!isOfficialStepRemote(remote)) return null;
    if (!fs.existsSync(path.join(root, '.git'))) throw new Error('没有锁定清单');
  const text = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H%n%T'], { encoding: 'utf8' });
    const [commit, tree] = text.trim().split(/\r?\n/u);
    return { source: OFFICIAL_STEP_SOURCE, commit: commit ?? '', tree: tree ?? '' };
  } catch {
    return null;
  }
}

export function resolveStepCheckout(env: NodeJS.ProcessEnv = process.env, fromDir = __dirname): string {
  const names = ['Step-Code-93ebc5be', 'Step-Code'];
  const candidates: string[] = [];
  const runtime = env.ORCHDESK_STEP_RUNTIME?.trim();
  const explicit = env.ORCHDESK_STEP_CODE?.trim();
  if (runtime) candidates.push(runtime);
  if (explicit) candidates.push(explicit);
  const resources = (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resources) candidates.push(path.join(resources, 'step'));
  let dir = path.resolve(fromDir);
  for (let i = 0; i < 6; i += 1) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    for (const name of names) candidates.push(path.join(parent, name));
    dir = parent;
  }
  let pinned: string | null = null;
  for (const candidate of candidates) {
    const origin = readStepOrigin(candidate);
    if (origin && origin.source === OFFICIAL_STEP_SOURCE && origin.commit) return candidate;
    if (pinned) continue;
    try {
      const lock = readLock(candidate);
      if (lock.commit === STEP_LOCK_COMMIT && lock.tree === STEP_LOCK_TREE) pinned = candidate;
    } catch {
      // 没有清单也没有 git 的目录不是锁定点。
    }
  }
  if (pinned) return pinned;
  throw new Error('找不到官方源仓库或随包锁定点，未加载');
}

export async function loadStepRuntime(root: string, deps: StepLoadDeps = {}): Promise<StepExtensionModule> {
  const origin = deps.readOrigin ? deps.readOrigin(root) : readStepOrigin(root);
  if (origin && origin.source === OFFICIAL_STEP_SOURCE) return loadOfficialStepRuntime(root, deps);
  return loadLockedStepExtension(root, deps);
}

/**
 * 运行时的入口文件。包内是 esbuild 打好的单文件 index.js，
 * 检出里是编译出的 packages/coding-agent/dist/index.js。
 */
export function stepRuntimeEntry(root: string): string {
  const bundled = path.join(root, 'index.js');
  if (fs.existsSync(bundled)) return bundled;
  return path.join(root, 'packages', 'coding-agent', 'dist', 'index.js');
}

/** 检出布局才有的身份文件。包内的身份由打包清单给出，不在这里读。 */
function stepCheckoutIdentity(root: string): { name?: string; version?: string } | null {
  const pkgPath = path.join(root, 'packages', 'coding-agent', 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  return JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { name?: string; version?: string };
}

async function importStepRuntime(entry: string, deps: StepLoadDeps, what: string): Promise<StepExtensionModule> {
  const importer = deps.importModule ?? nativeImport;
  const loaded = await importer(pathToFileURL(entry).href);
  if (typeof loaded.createStepExtensionInline !== 'function') {
    throw new Error(`${what}没有 createStepExtensionInline`);
  }
  return loaded;
}

async function loadOfficialStepRuntime(root: string, deps: StepLoadDeps): Promise<StepExtensionModule> {
  const version = deps.nodeVersion ?? process.versions.node;
  if (!nodeSatisfiesStepRuntime(version)) {
    throw new Error(`Node ${version} 低于 22.19.0，未加载官方运行时`);
  }
  const entry = stepRuntimeEntry(root);
  const exists = deps.entryExists ?? fs.existsSync;
  if (!exists(entry)) throw new Error('官方运行时尚未构建，未加载');
  const identity = stepCheckoutIdentity(root);
  if (identity && identity.name !== STEP_PACKAGE_NAME) throw new Error('官方运行时身份不符，未加载');
  return importStepRuntime(entry, deps, '官方运行时');
}

export async function loadLockedStepExtension(root: string, deps: StepLoadDeps = {}): Promise<StepExtensionModule> {
  const version = deps.nodeVersion ?? process.versions.node;
  if (!nodeSatisfiesStepRuntime(version)) {
    throw new Error(`Node ${version} 低于 22.19.0，未加载锁定包`);
  }
  const lock = (deps.readLock ?? readLock)(root);
  if (lock.commit !== STEP_LOCK_COMMIT || lock.tree !== STEP_LOCK_TREE) {
    throw new Error('锁定点不符，未加载');
  }
  const entry = stepRuntimeEntry(root);
  const exists = deps.entryExists ?? fs.existsSync;
  if (!exists(entry)) throw new Error('锁定包尚未构建，未加载');
  const identity = stepCheckoutIdentity(root);
  if (identity && (identity.name !== STEP_PACKAGE_NAME || identity.version !== STEP_PACKAGE_VERSION)) {
    throw new Error('锁定包身份不符，未加载');
  }
  return importStepRuntime(entry, deps, '锁定包');
}

// tsc 会把 import() 降成 require。锁定包是 ESM，必须保留原生动态导入。
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<StepExtensionModule>;

function readLock(root: string): { commit: string; tree: string } {
  // 打包进 resources/step 的没有 .git。清单由打包脚本写，内容与 git 核对的是同一对值。
  const manifest = path.join(root, 'step-lock.json');
  if (fs.existsSync(manifest)) {
    const parsed = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { commit?: string; tree?: string };
    return { commit: parsed.commit ?? '', tree: parsed.tree ?? '' };
  }
  if (!fs.existsSync(path.join(root, '.git'))) throw new Error('没有锁定清单');
  const text = execFileSync('git', ['-C', root, 'log', '-1', '--format=%H%n%T'], { encoding: 'utf8' });
  const [commit, tree] = text.trim().split(/\r?\n/u);
  return { commit: commit ?? '', tree: tree ?? '' };
}

function stubCanTakeConfirm(ctx: object): boolean {
  const descriptor = Object.getOwnPropertyDescriptor(ctx, 'hasUI');
  return !descriptor || descriptor.writable === true || typeof descriptor.set === 'function';
}

function bindGuiConfirm(extension: StepInlineExtension, confirm: StepConfirm): StepInlineExtension {
  return {
    name: extension.name,
    hidden: extension.hidden,
    factory: (pi) => {
      toolHookBound = true;
      const on = pi.on.bind(pi);
      pi.on = (event, handler) => {
        if (event !== 'tool_call') return on(event, handler);
        return on(event, async (payload, ctx) => {
          // 真实会话的 hasUI 是只读 getter。不要改它，也不要改共享的空界面。
          // 界面由 session.bindExtensions 注入。这里只补测试桩。
          if (ctx && typeof ctx === 'object' && stubCanTakeConfirm(ctx)) {
            if (!ctx.ui) ctx.ui = { confirm };
            else ctx.ui.confirm = confirm;
            ctx.hasUI = true;
          }
          return handler(payload, ctx);
        });
      };
      return extension.factory(pi);
    },
  };
}
