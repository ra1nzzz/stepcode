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

import { resolveStepCheckout, type ComposedStepExtension, type StepPreset } from './step-extension';

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
  /** 当前预设。权限值只有 bypass / autopilot。 */
  preset: () => StepPreset;
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
  /** 界面上下文：确认走本 GUI 弹窗，其余方法在主进程里都是空操作。 */
  uiContext: () => StepUiContext;
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
 * 会话缓存。键是「GUI 会话 id + 该会话绑定的工作目录」：
 *   · 同一条 GUI 会话复用同一条 Step 会话，历史留在 Step 自己的存储根；
   *   · 换会话不会读到别人的历史；
   *   · 工作目录变了（用户重新绑定项目）才重建。
 */
type CachedSession = { sid: string; cwd: string; session: StepSessionLike };
let cachedSession: CachedSession | null = null;
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
  const target = cachedSession && cachedSession.sid === sid ? cachedSession.session : null;
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
 * 历史与凭据都落在 Step 运行时自己的存储根（ADR 0005 第 5 条）——
 * agentDir 不传会崩（DefaultResourceLoader 的 options.agentDir 是必填），
 * 也不能拿 OrchDesk 的 dataDir 顶替：那会把会话和凭据搬进本 GUI 的目录。
 */
async function ensureSession(host: StepSessionHost, sid: string): Promise<StepSessionLike> {
  const composed = host.composed();
  if (!composed) throw new Error('进程内组合未接上，未加载');
  const cwd = path.resolve(host.sessionCwd(sid));
  if (cachedSession && cachedSession.sid === sid && cachedSession.cwd === cwd) {
    return cachedSession.session;
  }

  const locked = await resolveLockedModule(host.root);
  const agentDir = locked.resolveStepAgentDir();
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
  const created = await locked.createStepAgentSession({
    cwd,
    agentDir,
    resourceLoader: loader,
  });
  const session = created.session;
  await session.bindExtensions({ uiContext: host.uiContext() });
  // 换键前先销毁旧会话，否则每条 GUI 会话各留一套 agent + loader 不释放。
  if (cachedSession) disposeCached();
  cachedSession = { sid, cwd, session };
  return session;
}

function disposeCached(): void {
  if (!cachedSession) return;
  const dead = cachedSession;
  cachedSession = null;
  try { dead.session.dispose(); } catch { /* 已销毁 */ }
}

/** 丢开会话缓存（模式切换、锁定点重新组合后调用）。 */
export function resetStepSessionCache(): void {
  disposeCached();
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
  const session = await ensureSession(host, sid);
  const toolSteps: NonNullable<StepTurnResult['tools']> = [];
  const ac = new AbortController();
  const prev = turnAborts.get(sid);
  if (prev) prev.abort();
  turnAborts.set(sid, ac);

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
        if (name) {
          toolSteps.push({ n: name, ph: 'running' });
          host.notifyToolStep(sid, name, 'running');
        }
        return;
      }
      if (event.type === 'tool_execution_end') {
        const name = String((event as { toolName?: unknown }).toolName || '');
        const result = (event as { result?: unknown }).result;
        const isError = (event as { isError?: unknown }).isError === true;
        const textOut = typeof result === 'string' ? result : collectText(result);
        if (name) {
          toolSteps.push({ n: name, ph: isError ? 'error' : 'done', result: textOut });
          host.notifyToolStep(sid, name, isError ? 'error' : 'done', textOut);
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

