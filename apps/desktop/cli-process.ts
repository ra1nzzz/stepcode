/**
 * 启动官方 step.exe，并用它的更新命令替换这份安装。
 * 子进程环境走 buildChildEnv，不把数据目录定位变量交出去。
 */
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { buildChildEnv } from './terminal-tools';
import { isProviderBaseUrlAllowed } from './common-tools';
import { pickDefaultModel, type GuiModelConfig } from './step-model-bridge';
import { agentExecAudit, type AgentExecAuditInput } from './sandbox-log';
import {
  OFFICIAL_RELEASE_BASE,
  CLI_QUERY_OPTIONS,
  cliCoreDisabled,
  cliStdioArgs,
  compareReleaseVersions,
  locateStandaloneCli,
  officialArtifact,
  officialCliCandidates,
  parseLatestManifest,
  planCliUpdate,
  releaseTargetId,
} from './cli-core';
import { driveCliTurn, type CliProcessLike } from './cli-stdio';

export { cliCoreDisabled };

const turns = new Map<string, AbortController>();

export function hasActiveCliTurn(sessionId: string): boolean {
  return turns.has(sessionId);
}

export function cliTurnInFlight(): boolean {
  return turns.size > 0;
}

export function abortCliTurn(sessionId: string): boolean {
  const ac = turns.get(sessionId);
  if (!ac) return false;
  ac.abort();
  return true;
}

export function findOfficialCli(env: NodeJS.ProcessEnv = process.env, home = os.homedir()): string | null {
  return locateStandaloneCli(officialCliCandidates(home, env), (filePath) => {
    try { return fs.existsSync(filePath); } catch { return false; }
  });
}

export function readCliVersion(cliPath: string): string | null {
  const result = spawnSync(cliPath, ['--version'], {
    encoding: 'utf8',
    timeout: 8000,
    windowsHide: true,
    shell: false,
    env: buildChildEnv({ STEPCODE_DISABLE_UPDATE_CHECK: '1' }),
  });
  if (result.status !== 0) return null;
  const match = String(result.stdout || '').match(/\d+\.\d+\.\d+/);
  return match ? match[0] : null;
}

export async function describeCliCore(fetchImpl: typeof fetch = fetch): Promise<{
  path?: string;
  current?: string;
  latest?: string;
  missing: boolean;
  updateAvailable: boolean;
  note: string;
}> {
  if (cliCoreDisabled()) {
    return { missing: true, updateAvailable: false, note: '本进程关闭了 CLI 核（ORCHDESK_CLI_CORE=0），回合走包内核' };
  }
  const cliPath = findOfficialCli();
  if (!cliPath) {
    return { missing: true, updateAvailable: false, note: '未找到官方 CLI（~/.stepcode/bin/step.exe）。回合暂时用包内核，确认后可安装' };
  }
  const current = readCliVersion(cliPath) || undefined;
  try {
    const response = await fetchImpl(`${OFFICIAL_RELEASE_BASE}/latest.json`, { signal: AbortSignal.timeout(4000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const manifest = parseLatestManifest(await response.json());
    if (!manifest) throw new Error('latest.json 不是可识别的发布清单');
    const updateAvailable = !!current && compareReleaseVersions(current, manifest.version) < 0;
    return {
      path: cliPath,
      current,
      latest: manifest.version,
      missing: false,
      updateAvailable,
      note: updateAvailable
        ? `Agent 核 ${current}，官方 ${manifest.version} 可更新。下一回合使用 ${cliPath}`
        : `Agent 核已是官方 ${current || manifest.version}。下一回合使用 ${cliPath}`,
    };
  } catch (err) {
    return {
      path: cliPath,
      current,
      missing: false,
      updateAvailable: false,
      note: `已找到 ${cliPath}（${current || '版本未知'}），但官方清单读失败：${(err as Error).message}`,
    };
  }
}

function modelEnv(cfg: GuiModelConfig | undefined): Record<string, string> {
  const env: Record<string, string> = { STEPCODE_DISABLE_UPDATE_CHECK: '1' };
  if (!cfg) return env;
  const picked = pickDefaultModel(cfg);
  if (!picked) return env;
  const provider = (cfg.providers || []).find((item) => item.id === picked.provider);
  env.STEP_PROVIDER = 'step';
  env.STEP_MODEL = picked.modelId;
  if (provider?.baseUrl && isProviderBaseUrlAllowed(provider.baseUrl).ok) {
    env.STEP_BASE_URL = provider.baseUrl;
    if (provider.apiKey) env.STEP_API_KEY = provider.apiKey;
  }
  return env;
}

export async function runCliCoreTurn(
  sessionId: string,
  text: string,
  host: {
    sessionCwd: (sessionId?: string) => string;
    notifyAgentDelta: (sessionId: string, text: string) => void;
    notifyToolStep: (sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string) => void;
    recordToolRun: (entry: AgentExecAuditInput & { sessionId?: string }) => void;
    uiContext: () => { confirm?: (title: string, message: string) => Promise<boolean> };
    modelConfig?: () => GuiModelConfig;
  },
): Promise<{ text: string; intent: string; tools?: Array<{ n: string; ph: string; result?: string }>; steps?: number; aborted?: boolean }> {
  const cliPath = findOfficialCli();
  if (!cliPath) throw new Error('未找到官方 CLI');
  const ac = new AbortController();
  const prev = turns.get(sessionId);
  if (prev) prev.abort();
  turns.set(sessionId, ac);
  const sessionDir = path.join(os.homedir(), '.stepcode', 'desktop-sessions');
  fs.mkdirSync(sessionDir, { recursive: true });
  const cwd = host.sessionCwd(sessionId) || os.homedir();
  const child = spawn(cliPath, cliStdioArgs(sessionDir, sessionId), {
    cwd,
    windowsHide: true,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: buildChildEnv(modelEnv(host.modelConfig?.())),
  });
  try {
    const confirm = host.uiContext().confirm;
    return await driveCliTurn(child as unknown as CliProcessLike, text, {
      signal: ac.signal,
      confirm: async (title, detail) => {
        if (!confirm) return false;
        return confirm(title, detail);
      },
      onDelta: (delta) => host.notifyAgentDelta(sessionId, delta),
      onTool: (name, ph, result, args) => {
        host.notifyToolStep(sessionId, name, ph, result);
        if (ph === 'running') return;
        const audit = agentExecAudit(name, args, ph === 'error', result);
        if (audit) host.recordToolRun({ ...audit, sessionId });
      },
    });
  } finally {
    if (turns.get(sessionId) === ac) turns.delete(sessionId);
  }
}

export async function applyOfficialCliUpdate(fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  path?: string;
  version?: string;
  reason?: string;
}> {
  if (cliTurnInFlight()) return { ok: false, reason: '有回合还在用 CLI，先停止再更新' };
  const existing = findOfficialCli();
  if (existing) {
    const plan = planCliUpdate(existing);
    if (!plan.ok) return { ok: false, reason: plan.reason };
    const ran = await runCaptured(plan.command, plan.args, 180000);
    if (ran.code !== 0) {
      return { ok: false, path: existing, reason: (ran.stderr || ran.stdout || `step update 退出 ${ran.code}`).slice(0, 400) };
    }
    return { ok: true, path: existing, version: readCliVersion(existing) || undefined };
  }
  return installOfficialCli(os.homedir(), fetchImpl);
}

export async function installOfficialCli(home: string, fetchImpl: typeof fetch = fetch): Promise<{
  ok: boolean;
  path?: string;
  version?: string;
  reason?: string;
}> {
  const dest = path.join(home, '.stepcode', 'bin');
  const targetId = releaseTargetId();
  if (!targetId) return { ok: false, reason: '当前平台没有官方 CLI 安装包' };
  const response = await fetchImpl(`${OFFICIAL_RELEASE_BASE}/latest.json`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return { ok: false, reason: `官方清单下载失败（HTTP ${response.status}）` };
  const manifest = parseLatestManifest(await response.json());
  if (!manifest) return { ok: false, reason: '官方清单无法识别' };
  const artifact = officialArtifact(manifest, targetId);
  if ('reason' in artifact) return { ok: false, reason: artifact.reason };
  const archiveResponse = await fetchImpl(artifact.url, { signal: AbortSignal.timeout(180000) });
  if (!archiveResponse.ok) return { ok: false, reason: `安装包下载失败（HTTP ${archiveResponse.status}）` };
  const bytes = Buffer.from(await archiveResponse.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== artifact.checksum) return { ok: false, reason: '安装包校验和不匹配，已丢弃' };
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'stepcode-cli-'));
  try {
    const archivePath = path.join(tempRoot, artifact.fileName);
    const extractDir = path.join(tempRoot, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    fs.writeFileSync(archivePath, bytes);
    await extractArchive(archivePath, extractDir);
    const binary = findBinaryInside(extractDir);
    if (!binary) return { ok: false, reason: '安装包里没有 step.exe' };
    fs.mkdirSync(dest, { recursive: true });
    fs.cpSync(path.dirname(binary), dest, { recursive: true, force: true });
    const installed = path.join(dest, path.basename(binary));
    if (!fs.existsSync(installed)) return { ok: false, reason: '安装后找不到 step.exe' };
    return { ok: true, path: installed, version: readCliVersion(installed) || manifest.version };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function findBinaryInside(root: string): string | null {
  const rootReal = fs.realpathSync(root);
  const stack = [rootReal];
  while (stack.length) {
    const dir = stack.pop() as string;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!ent.isFile()) continue;
      const base = ent.name.toLowerCase();
      if (base !== 'step' && base !== 'step.exe') continue;
      const real = fs.realpathSync(full);
      if (!isInside(rootReal, real)) continue;
      return real;
    }
  }
  return null;
}

function isInside(root: string, filePath: string): boolean {
  const rel = path.relative(root, filePath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', archive, '-C', dest], {
      windowsHide: true,
      shell: false,
      env: buildChildEnv(),
    });
    let err = '';
    child.stderr?.on('data', (chunk) => { err += chunk.toString('utf8'); });
    child.on('error', (error) => reject(error));
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error((err || `tar 退出 ${code}`).slice(0, 300)));
    });
  });
}

function runCaptured(command: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child: ChildProcess = spawn(command, args, {
      windowsHide: true,
      shell: false,
      env: buildChildEnv(),
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, stdout, stderr: stderr || '更新超时' });
    }, timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, stdout, stderr: error.message });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function cliQueryOptionsForTest(): typeof CLI_QUERY_OPTIONS {
  return CLI_QUERY_OPTIONS;
}
