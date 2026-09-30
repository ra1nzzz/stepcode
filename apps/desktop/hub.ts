/// <reference types="electron" />
import * as path from 'node:path';
import * as fs from 'node:fs';
import { safeStorage } from 'electron';
import { DATA_FILE_NAMES, getDataDir } from './data-dir';

// ============================================================================
// OrchClaw Hub 联调客户端（T-P6-2）
// ----------------------------------------------------------------------------
// 真实联调：配对远程 Agent、主会话发任务、回收结果。不在本地 mock 绕过。
//
// 凭据安全（PLAN 红线）：配对凭据经 electron safeStorage 加密存储于
// 规范化数据目录/hub.json（非 userData，避免换安装形态后丢失）；仅密文落盘；
// 无可用加密后端时拒绝存储明文。
//
// 协议（须与部署的 OrchClaw Hub 对齐；此处为真实 REST 客户端形态）：
//   POST <hubUrl>/api/pair        { token }            → { handle, agentName }
//   POST <hubUrl>/api/agent/<h>/task   { text }        → { taskId }
//   GET  <hubUrl>/api/agent/<h>/result/<taskId>        → { status, result }
//
// 端到端须可达远程 Hub；本环境仅能编译与形态校验，运行期受远程端门控。
// ============================================================================

export interface HubConfig {
  url: string;
  /** 配对凭据密文（safeStorage 加密后的 base64）。 */
  tokenCipher?: string;
}

export interface PairResult {
  ok: boolean;
  reason?: string;
  handle?: string;
  agentName?: string;
}

export interface SendResult {
  ok: boolean;
  reason?: string;
  taskId?: string;
}

export interface TaskResult {
  status: 'pending' | 'running' | 'done' | 'error';
  result?: string;
}

export interface HubStatus {
  paired: boolean;
  url?: string;
  agentName?: string;
}

/** 配置文件：统一落在规范化数据目录（由 main 注入解析器，见 data-dir.ts）。 */
function configFile(): string {
  return path.join(getDataDir(), DATA_FILE_NAMES.hub);
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function encryptToken(token: string): string {
  if (!encryptionAvailable()) throw new Error('当前环境无可用加密后端，拒绝明文存储凭据');
  return safeStorage.encryptString(token).toString('base64');
}

function decryptToken(cipher: string): string {
  if (!encryptionAvailable()) throw new Error('当前环境无可用加密后端，无法解密凭据');
  return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
}

function readConfig(): HubConfig | null {
  try {
    const file = configFile();
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8')) as HubConfig;
  } catch {
    /* 损坏视为未配对 */
  }
  return null;
}

function writeConfig(cfg: HubConfig): void {
  fs.writeFileSync(configFile(), JSON.stringify(cfg), 'utf-8');
}

export class HubClient {
  // 惰性读取：模块加载时 main 还没注入数据目录解析器（getDataDir 会抛错），
  // 推迟到首次访问再读，确保读到的是规范化目录里的凭据。
  private cfg: HubConfig | null = null;
  private cfgLoaded = false;
  private handle: string | null = null;
  private agentName: string | null = null;

  private config(): HubConfig | null {
    if (!this.cfgLoaded) {
      this.cfgLoaded = true;
      this.cfg = readConfig();
    }
    return this.cfg;
  }

  status(): HubStatus {
    const cfg = this.config();
    const paired = !!(cfg && cfg.tokenCipher && this.handle);
    return { paired, url: cfg?.url, agentName: this.agentName || undefined };
  }

  /** 配对远程 Agent（凭据加密存储）。 */
  async pair(url: string, token: string): Promise<PairResult> {
    // 强制 https（凭据经网传输；本地调试可显式用 http://127.0.0.1，其余一律拒绝，
    // 防明文 token 走 http 与外网任意 URL 的 SSRF 面）。
    const trimmed = (url || '').trim().replace(/\/$/, '');
    const isHttps = /^https:\/\//i.test(trimmed);
    const isLoopbackHttp = /^http:\/\/127\.0\.0\.1(:\d+)?(\/|$)/i.test(trimmed) || /^http:\/\/localhost(:\d+)?(\/|$)/i.test(trimmed);
    if (!isHttps && !isLoopbackHttp) {
      return { ok: false, reason: 'Hub URL 必须为 https（本地调试可 http://127.0.0.1）' };
    }
    if (!token || !token.trim()) return { ok: false, reason: '配对凭据为空' };
    let cipher: string;
    try {
      cipher = encryptToken(token.trim());
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
    try {
      const res = await fetch(`${trimmed}/api/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { ok: false, reason: `配对失败 HTTP ${res.status}` };
      const data = (await res.json()) as { handle?: string; agentName?: string };
      if (!data.handle) return { ok: false, reason: '配对响应缺少 handle' };
      this.cfg = { url: url.trim(), tokenCipher: cipher };
      this.cfgLoaded = true;
      this.handle = data.handle;
      this.agentName = data.agentName || null;
      writeConfig(this.cfg);
      return { ok: true, handle: data.handle, agentName: data.agentName };
    } catch (err) {
      return { ok: false, reason: `配对异常：${(err as Error).message}` };
    }
  }

  private authHeaders(): Record<string, string> {
    const cfg = this.config();
    if (!cfg || !cfg.tokenCipher) return {};
    try {
      return { Authorization: `Bearer ${decryptToken(cfg.tokenCipher)}` };
    } catch {
      return {};
    }
  }

  /** 主会话向远程 Agent 发任务。 */
  async sendTask(text: string): Promise<SendResult> {
    const cfg = this.config();
    if (!this.status().paired || !cfg || !this.handle) {
      return { ok: false, reason: '尚未配对或配对已失效' };
    }
    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/agent/${encodeURIComponent(this.handle)}/task`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) return { ok: false, reason: `发任务失败 HTTP ${res.status}` };
      const data = (await res.json()) as { taskId?: string };
      return data.taskId ? { ok: true, taskId: data.taskId } : { ok: false, reason: '响应缺少 taskId' };
    } catch (err) {
      return { ok: false, reason: `发任务异常：${(err as Error).message}` };
    }
  }

  /** 回收远程 Agent 回传结果。 */
  async getResult(taskId: string): Promise<TaskResult> {
    const cfg = this.config();
    if (!this.status().paired || !cfg || !this.handle) {
      return { status: 'error', result: '尚未配对' };
    }
    try {
      const res = await fetch(`${cfg.url.replace(/\/$/, '')}/api/agent/${encodeURIComponent(this.handle)}/result/${encodeURIComponent(taskId)}`, {
        headers: this.authHeaders(),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return { status: 'error', result: `HTTP ${res.status}` };
      const data = (await res.json()) as TaskResult;
      return data;
    } catch (err) {
      return { status: 'error', result: (err as Error).message };
    }
  }

  /** 解除配对（销毁内存 handle，保留加密凭据以便重连）。 */
  unpair(): void {
    this.handle = null;
    this.agentName = null;
  }
}

export const hubClient = new HubClient();
