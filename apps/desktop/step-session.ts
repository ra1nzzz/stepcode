/**
 * T5：用户会话接上 Step。
 *
 * 用户在作曲栏发送的文本由锁定点 Pi AgentSession 执行，不再走 agent-turn.ts 的
 * OpenAI 兼容循环。会话经 DefaultResourceLoader 挂上本 GUI 已组合的 Step 扩展
 * （createStepExtensionInline + 本界面的 confirm），所以：
 *
 *   · 工具调用仍由锁定点的创建与审批著决（不改 decideStepToolCall）
 *   · 权限值只有 bypass / autopilot，界面仍只有两档文案
 *   · 危险命令确认只有本 GUI 一个入口（IPC 通道 orchdesk:authz-approval-request）
 *   · 会话存储与模型凭据留在 Step 运行时自己的存储根（ADR 0005 第 5 条）
 *
 * 这里不创建第二套审批，也不把 createStepAgentSession 当作「已接好的运行时」：
 * 它本身不安装权限控制器，控制器随组合后的扩展进入会话。
 *
 * 回合约定的仍是渲染层的旧形状 { text, intent, tools?, steps?, aborted? }，
 * 所以渲染层 delta 订阅与打字态图框不变。
 */
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { resolveStepCheckout, type ComposedStepExtension } from './step-extension';
import { agentExecAudit, type AgentExecAuditInput } from './sandbox-log';
import {
  configFingerprint,
  pickDefaultModel,
  toStepAuthJson,
  toStepModelsJson,
  type GuiModelConfig,
} from './step-model-bridge';

export type StepTurnResult = {
  text: string;
  intent: string;
  tools?: Array<{ n: string; ph: 'running' | 'done' | 'error'; result?: string }>;
  steps?: number;
  aborted?: boolean;
};

type LockedModule = {
  createStepAgentSession: (options: Record<string, unknown>) => Promise<{
    session: StepSessionLike;
  }>;
  DefaultResourceLoader: new (options: Record<string, unknown>) => StepResourceLoaderLike;
  /** Step 运行时自己的 agent 根（凭据 models.json / auth.json 的所在）。 */
  resolveStepAgentDir: (env?: Record<string, string | undefined>) => string;
  /** Step 运行时自己的存储根（本 GUI 的模型凭据写在它的 gui/ 子目录）。 */
  resolveStepStorageRoot: (env?: Record<string, string | undefined>) => string;
  /** 锁定包的模型运行时。自建实例才能把凭据指到本 GUI 的目录。 */
  ModelRuntime: {
    create: (options: { authPath?: string; modelsPath?: string }) => Promise<StepModelRuntimeLike>;
  };
};

type StepModelRuntimeLike = {
  getModel: (provider: string, modelId: string) => unknown;
};

type StepSessionLike = {
  bindExtensions: (bindings: Record<string, unknown>) => Promise<void>;
  subscribe: (listener: (event: StepSessionEvent) => void) => () => void;
  prompt: (text: string) => Promise<void>;
  abort: () => Promise<void>;
  dispose: () => void;
  /** 会话的全部消息；最后一条 assistant 的文本即回合回复。 */
  messages?: Array<{ role?: unknown; content?: unknown } | null> | unknown[];
};

type StepResourceLoaderLike = {
  reload: () => Promise<unknown>;
};

export type StepUiContext = {
  select: (title: string, options: string[], opts?: unknown) => Promise<string | undefined>;
  confirm: (title: string, message: string, opts?: unknown) => Promise<boolean>;
  input: (title: string, placeholder?: string, opts?: unknown) => Promise<string | undefined>;
  notify: (message: string, type?: string, options?: unknown) => void;
  onTerminalInput: (handler: (data: string) => unknown) => () => void;
  setStatus: (key: string, text: string | undefined) => void;
  setWorkingMessage: (message?: string) => void;
  setWorkingVisible: (visible: boolean) => void;
  setWorkingIndicator: (frames?: string[], intervalMs?: number) => void;
  setHiddenThinkingLabel: (label?: string) => void;
  setWidget: (widget?: unknown) => void;
  setFooter: (footer?: unknown) => void;
  setHeader: (header?: unknown) => void;
  setTitle: (title?: string) => void;
  custom: (kind: string, payload?: unknown) => Promise<unknown>;
  pasteToEditor: (text: string) => void;
  setEditorText: (text: string) => void;
  getEditorText: () => string;
  editor: (opts?: unknown) => Promise<unknown>;
  addAutocompleteProvider: (factory: unknown) => void;
  setEditorComponent: (component: unknown) => void;
  getEditorComponent: () => unknown;
  theme: Record<string, (value: string) => string>;
  getAllThemes: () => unknown[];
  getTheme: () => string;
  setTheme: (theme: unknown) => unknown;
  getToolsExpanded: () => boolean;
  setToolsExpanded: (expanded: boolean) => void;
};

type StepSessionEvent = {
  type: string;
  [key: string]: unknown;
};

export type StepSessionHost = {
  /**
   * 已接上的组合（preset + 扩展本体 + confirm）。交整个组合对象，扩展字段由
   * 本模块取——调用方解包到哪一层是历史歧义的来源。
   */
  composed: () => ComposedStepExtension | undefined;
  /**
   * 会话工作目录。必须收 sessionId：GUI 的每条侧栏会话可以各自绑定项目目录
   * （orchdesk:set-session-cwd → setSessionCwd），收了才会按目录取，不收就
   * 永远落到全局默认目录，用户绑的目录被静默忽略。
   */
  sessionCwd: (sessionId?: string) => string;
  /** 增量文本（沿用 orchdesk:agent-delta 通道）。 */
  notifyAgentDelta: (sessionId: string, text: string) => void;
  /** 工具步骤（沿用 orchdesk:tool-step 通道）。 */
  notifyToolStep: (sessionId: string, name: string, ph: 'running' | 'done' | 'error', result?: string) => void;
  /**
   * BUG-053：Agent 在锁定点内执行完一次变更 / 命令类工具后，把结果交给宿主的沙箱审计。
   * 本模块不认识 sandbox-log 的落盘细节，只把已经归一好的判定交出去。
   */
  recordToolRun: (entry: AgentExecAuditInput & { sessionId?: string }) => void;
  /** 界面上下文：确认走本 GUI 弹窗，其余方法在主进程里都是空操作。 */
  uiContext: () => StepUiContext;
  /**
   * GUI 模型页的配置，key 已由宿主解密。会话靠它把用户在本 GUI 配的提供商
   * 投影成 Step 认的形状；不回这个，就永远只能用环境里碰巧存在的凭据。
   */
  modelConfig: () => GuiModelConfig;
  /** 锁定点根目录。 */
  root: () => string;
};

// tsc 会把 import() 降成 require。锁定包是 ESM，必须保留原生动态导入。
const nativeImport = new Function('specifier', 'return import(specifier)') as (
  specifier: string,
) => Promise<LockedModule>;

let stepRoot: string | null = null;
let lockedModule: LockedModule | null = null;
/**
 * 会话缓存。键是 GUI 会话 id，值带该会话建缓存时的 `cwd` 与模型配置指纹：
 *   · 同一条 GUI 会话复用同一条 Step 会话，历史留在 Step 自己的存储根；
 *   · 换会话不会读到别人的历史；
 *   · 工作目录变了（用户重新绑定项目）才重建；
 *   · 模型配置变了（用户在设置页换提供商 / 换 key）也重建——不重建的话下个
 *     回合仍会用旧凭据发请求，就是「设置页对回合没有影响」那个 bug。
 *
 * 必须是多槽而不是单槽：侧栏就是给用户同时开几条会话用的。原先只留一条，
 * A→B→A 会把 A 挤掉并就地重建，A 的上下文在这一轮之后再也回不来，而界面上
 * 没有任何地方说过「切走会丢」。Map 的插入序当 LRU 用，尾部是最近使用。
 */
type CachedSession = { sid: string; cwd: string; configFp: string; session: StepSessionLike };
const sessionCache = new Map<string, CachedSession>();
/** 同时驻留的会话上限。超出时淘汰最久未用且不在跑回合的那条，不销毁正在跑的会话。 */
const MAX_CACHED_SESSIONS = 4;
const turnAborts = new Map<string, AbortController>();

/** 与缓存键同形的激活标记：回合正在进行的那条会话。 */
export function hasActiveStepTurn(sessionId: string): boolean {
  return turnAborts.has(String(sessionId || ''));
}

export function abortStepSession(sessionId: string): { ok: boolean; reason?: string } {
  const sid = String(sessionId || '');
  const cur = turnAborts.get(sid);
  if (!cur) return { ok: false, reason: 'no-active-turn' };
  cur.abort();
  // 只有中止控制器不够：还会说仍在等模型，必须让会话说 agent.abort()。
  const target = sessionCache.get(sid)?.session ?? null;
  if (target) void target.abort().catch(() => {});
  return { ok: true };
}

async function resolveLockedModule(root: () => string): Promise<LockedModule> {
  const dir = stepRoot ?? root();
  if (!lockedModule || stepRoot !== dir) {
    const entry = path.join(dir, 'packages', 'coding-agent', 'dist', 'index.js');
    if (!fs.existsSync(entry)) throw new Error('锁定包尚未构建，未加载');
    lockedModule = await nativeImport(pathToFileURL(entry).href);
    stepRoot = dir;
  }
  return lockedModule;
}

/**
 * 取一个已挂上本 GUI Step 扩展的会话，按 GUI 会话缓存。
 * 会话历史落在 Step 运行时自己的存储根（ADR 0005 第 5 条）——
 * agentDir 不传会崩（DefaultResourceLoader 的 options.agentDir 是必填），
 * 也不能拿 OrchDesk 的 dataDir 顶替：那会把会话搬进本 GUI 的目录。
 */
async function ensureSession(host: StepSessionHost, sid: string): Promise<StepSessionLike> {
  const composed = host.composed();
  if (!composed) throw new Error('进程内组合未接上，未加载');
  const cwd = path.resolve(host.sessionCwd(sid));
  const modelConfig = host.modelConfig();
  const configFp = configFingerprint(modelConfig);
  const hit = sessionCache.get(sid);
  if (hit && hit.cwd === cwd && hit.configFp === configFp) {
    // 命中要刷新 LRU 位置（删掉再插回尾部），否则常用的会话会先被淘汰。
    sessionCache.delete(sid);
    sessionCache.set(sid, hit);
    return hit.session;
  }
  if (hit) {
    // 同一条 GUI 会话但工作目录或模型配置变了：旧会话就地销毁，不留在缓存里等淘汰。
    sessionCache.delete(sid);
    try { hit.session.dispose(); } catch { /* 已销毁 */ }
  }

  const locked = await resolveLockedModule(host.root);
  const agentDir = locked.resolveStepAgentDir();
  // 本 GUI 配的提供商投影成 Step 原生格式，写进 Step 存储根下的 gui/ 子目录：
  // 凭据仍在 Step 的存储根内，但不碰用户在 step CLI 里配的 `<agentDir>/auth.json`。
  const modelRuntime = await writeGuiModelRuntime(locked, modelConfig);
  const loader = new locked.DefaultResourceLoader({
    cwd,
    agentDir,
    extensionFactories: [composed.extension],
    // 本 GUI 自己管 skills / 主题 / 上下文文件；加载器只负责把组合好的扩展交给会话。
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await loader.reload();
  const picked = pickDefaultModel(modelConfig);
  const model = picked ? modelRuntime.getModel(picked.provider, picked.modelId) : undefined;
  const created = await locked.createStepAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
    // 把本 GUI 自己的模型目录/凭据交给会话；不传就是「设置页对回合没有影响」。
    modelRuntime,
    ...(model ? { model } : {}),
  });
  const session = created.session;
  await session.bindExtensions({ uiContext: host.uiContext() });
  sessionCache.set(sid, { sid, cwd, configFp, session });
  evictIdleSessions();
  return session;
}

/**
 * 超出上限时按 LRU 淘汰，但**不淘汰正在跑回合的会话**——那会把用户刚发出的
 * 那条回合并着 agent 一起拆掉。全部都在跑就暂时容忍超额，等下一条回结束。
 */
function evictIdleSessions(): void {
  while (sessionCache.size > MAX_CACHED_SESSIONS) {
    const victim = [...sessionCache.keys()].find((key) => !turnAborts.has(key));
    if (!victim) return;
    const dead = sessionCache.get(victim);
    sessionCache.delete(victim);
    try { dead?.session.dispose(); } catch { /* 已销毁 */ }
  }
}

/**
 * 把 GUI 模型页的配置写成 Step 原生 `models.json` / `auth.json`，返回指向它们的
 * 模型运行时。文件落在 `<Step 存储根>/gui/`（不碰 CLI 自己的 agent 目录）。
 *
 * 每次都重写：模型页是用户改了就期望下回合生效的地方，缓存文件反而会让人困惑。
 */
async function writeGuiModelRuntime(locked: LockedModule, cfg: GuiModelConfig): Promise<StepModelRuntimeLike> {
  const dir = path.join(locked.resolveStepStorageRoot(), 'gui');
  const modelsPath = path.join(dir, 'models.json');
  const authPath = path.join(dir, 'auth.json');
  const models = JSON.stringify(toStepModelsJson(cfg), null, 2);
  const auth = JSON.stringify(toStepAuthJson(cfg), null, 2);
  // 内容没变就不落盘：避免每次发送都重写凭据文件（也是给安全审计留干净的时间戳）。
  if (readIfExists(modelsPath) !== models || readIfExists(authPath) !== auth) {
    fs.mkdirSync(dir, { recursive: true });
    // 原子替换。这两个文件是明文书写的模型配置与**凭据**，而锁定包对
    // `models.json` 的 schema 校验失败时不抛错、静默换成空表——半截写入的
    // 表现就是「设置页配过提供商却说没有 key」，且看不出文件被写坏过。
    atomicWrite(modelsPath, models);
    atomicWrite(authPath, auth);
  }
  return locked.ModelRuntime.create({ authPath, modelsPath });
}

/** 同目录临时文件 + rename：崩溃/断电不留半个文件。 */
function atomicWrite(file: string, content: string): void {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, file);
  } catch (err) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 清理失败不覆盖真因 */ }
    throw err;
  }
}

function readIfExists(file: string): string | null {
  try { return fs.readFileSync(file, 'utf-8'); } catch { return null; }
}

function disposeAllCached(): void {
  for (const [, dead] of sessionCache) {
    try { dead.session.dispose(); } catch { /* 已销毁 */ }
  }
  sessionCache.clear();
}

/** 丢开会话缓存（模式切换、锁定点重新组合后调用）。两档变了，缓存里的每条会话都作废。 */
export function resetStepSessionCache(): void {
  disposeAllCached();
}

function collectText(message: unknown): string {
  if (typeof message === 'string') return message;
  if (!message || typeof message !== 'object') return '';
  const content = (message as { content?: unknown }).content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        const text = (part as { text?: unknown } | null)?.text;
        return typeof text === 'string' ? text : '';
      })
      .filter(Boolean)
      .join('');
  }
  return '';
}

/**
 * 作曲栏发送的执行入口。
 * 订阅会话事件，把增量文本与工具步骤转发给渲染层，回合结束返回旧形状结果。
 */
export async function runStepSessionTurn(
  sessionId: string,
  text: string,
  host: StepSessionHost,
): Promise<StepTurnResult> {
  const sid = String(sessionId || '');
  const ac = new AbortController();
  const prev = turnAborts.get(sid);
  if (prev) prev.abort();
  // 必须在 ensureSession 之前就登记：建会话要跑 loader.reload() 与 createStepAgentSession，
  // 这段时间里若别的回合把缓存填满，evictIdleSessions 看不到「这条在用」，
  // 会把正在创建的会话 dispose 掉，而本回合随后把死对象插回缓存。
  turnAborts.set(sid, ac);
  let session: StepSessionLike;
  try {
    session = await ensureSession(host, sid);
  } catch (err) {
    // 建会话失败时下面那个 finally 还没进入作用域：不清理就会永久留着「这条会话在跑」，
    // 界面据此认为回合仍在进行，缓存里它也永远不可淘汰。
    if (turnAborts.get(sid) === ac) turnAborts.delete(sid);
    throw err;
  }
  const toolSteps: NonNullable<StepTurnResult['tools']> = [];
  // tool_execution_end 不带 args（锁定包只在 start 事件里给），而审计要记的是「对哪个
  // 路径 / 哪条命令」执行的，所以按 toolCallId 暂存 start 的入参，end 时配对取回。
  const startedArgs = new Map<string, unknown>();

  const unsubscribe = session.subscribe((event) => {
    if (ac.signal.aborted) return;
    try {
      if (event.type === 'message_update') {
        const delta = (event as { assistantMessageEvent?: { type?: string; delta?: unknown } }).assistantMessageEvent;
        if (delta?.type === 'text_delta' && typeof delta.delta === 'string') {
          host.notifyAgentDelta(sid, delta.delta);
        }
        return;
      }
      if (event.type === 'tool_execution_start') {
        const name = String((event as { toolName?: unknown }).toolName || '');
        const callId = String((event as { toolCallId?: unknown }).toolCallId || '');
        if (callId) startedArgs.set(callId, (event as { args?: unknown }).args);
        if (name) {
          toolSteps.push({ n: name, ph: 'running' });
          host.notifyToolStep(sid, name, 'running');
        }
        return;
      }
      if (event.type === 'tool_execution_end') {
        const name = String((event as { toolName?: unknown }).toolName || '');
        const callId = String((event as { toolCallId?: unknown }).toolCallId || '');
        const args = startedArgs.get(callId);
        startedArgs.delete(callId);
        const result = (event as { result?: unknown }).result;
        const isError = (event as { isError?: unknown }).isError === true;
        const textOut = typeof result === 'string' ? result : collectText(result);
        if (name) {
          toolSteps.push({ n: name, ph: isError ? 'error' : 'done', result: textOut });
          host.notifyToolStep(sid, name, isError ? 'error' : 'done', textOut);
          // BUG-053：沙箱日志此前只覆盖本壳自己的调用点，Agent 真正执行工具的这条
          // 路一条都不留。映射不到（只读工具、取不到对象）就不留，不编造条目。
          const audit = agentExecAudit(name, args, isError, textOut);
          if (audit) host.recordToolRun({ ...audit, sessionId: sid });
        }
      }
    } catch {
      // 转发失败不影响回合。
    }
  });

  try {
    if (ac.signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await session.prompt(text);
    // 用户按停止时 agent 循环是正常收尾的（stopReason: aborted → turn_end/agent_end
    // 后 return），prompt() 走 resolve 不走 reject。所以只靠 catch 认不出停止，
    // 必须在解析后再看一次中止位，否则界面把停止报成成功。
    if (ac.signal.aborted) return stoppedResult(toolSteps);
    return { text: lastAssistantText(session), intent: 'ACT', tools: toolSteps, steps: toolSteps.length };
  } catch (err) {
    if (ac.signal.aborted || (err as Error)?.name === 'AbortError') return stoppedResult(toolSteps);
    throw err;
  } finally {
    unsubscribe();
    if (turnAborts.get(sid) === ac) turnAborts.delete(sid);
  }
}

function stoppedResult(toolSteps: NonNullable<StepTurnResult['tools']>): StepTurnResult {
  return { text: '（已停止）', intent: 'CONFIRM', aborted: true, tools: toolSteps, steps: toolSteps.length };
}

/**
 * 回合结束后的最终回复 = 会话里最后一条 assistant 消息。
 * 由会话自己保存（含跨回合历史），这里只取本回合要显示的那段。
 */
function lastAssistantText(session: StepSessionLike): string {
  const messages = Array.isArray(session.messages) ? session.messages : [];
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i] as { role?: unknown; content?: unknown } | null;
    if (m && m.role === 'assistant') return collectText(m).trim();
  }
  return '';
}

