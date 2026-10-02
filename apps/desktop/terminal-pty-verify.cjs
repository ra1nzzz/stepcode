/**
 * 终端（PTY）验证（吸收计划 P2-10 · Minke 借鉴）
 * ----------------------------------------------------------------------------
 * 三层，缺一不可：
 *   A. 纯逻辑（TS 直测，ADR-0010）：参数钳制、环境净化、加载候选、路径折叠。
 *   B. 宿主逻辑（直接 require dist/terminal-pty.js，node 内置依赖可直跑）：
 *      pty 正路数据流（攒批 / 截断 / 退出）、管道模式显式降级、会话上限。
 *   C. 接线（stub electron 驱动真实 dist/main.js）：IPC handler 真注册、
 *      净化在真实链路上生效、事件真的推到渲染层。
 *
 * 运行：node terminal-pty-verify.cjs   （需先 npx tsc -p tsconfig.json）
 */
const assert = require('node:assert');
const path = require('node:path');
const Module = require('node:module');
const os = require('node:os');
const fs = require('node:fs');

const APP_DIR = __dirname;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchdesk-terminal-'));
process.env.ORCHDESK_HOME = HOME;

const { importTs } = require('./scripts/ts-load.cjs');
const { makeElectronStub, createChecker } = require('../../scripts/verify-kit.cjs');

const { check, summary } = createChecker();

// ---------------------------------------------------------------------------
// node-pty 假实现（B 组）：记录调用、可控吐数据
// ---------------------------------------------------------------------------

function makeFakePty() {
  const state = {
    spawns: [], received: [], resizeCalls: [], killed: 0, lastOpts: null,
  };
  const spawn = (file, args, opts) => {
    // 每个 spawn 独立持有回调（真 pty 语义：会话间不串线）
    const handles = { dataCbs: [], exitCbs: [], opts };
    state.spawns.push(handles);
    state.lastOpts = opts;
    return {
      pid: 4242,
      write: (d) => state.received.push(d),
      resize: (c, r) => state.resizeCalls.push([c, r]),
      kill: () => { state.killed += 1; },
      onData: (cb) => handles.dataCbs.push(cb),
      onExit: (cb) => handles.exitCbs.push(cb),
    };
  };
  /** 取指定序号（默认最新）会话的回调把手，向它灌数据 / 触发退出。 */
  const poke = (idx) => {
    const h = state.spawns[idx !== undefined ? idx : state.spawns.length - 1];
    return {
      data: (s) => h.dataCbs.forEach((cb) => cb(s)),
      exit: (code) => h.exitCbs.forEach((cb) => cb({ exitCode: code })),
    };
  };
  return { spawn, state, poke };
}

/** 管道模式用的假 ChildProcess（不真起 cmd.exe，验证可确定性）。 */
function makeFakeChild() {
  const { EventEmitter } = require('node:events');
  const child = new EventEmitter();
  child.pid = 777;
  // stdin 必须是可写流语义（真实的 ChildProcess.stdin 是 Stream）：宿主会给它
  // 挂 error 监听防 EPIPE，假件不带 on() 就会在 createTerminal 里直接抛。
  child.stdin = new EventEmitter();
  child.stdin.write = (d) => child.written.push(d);
  child.stdin.destroy = () => {};
  child.written = [];
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; setImmediate(() => child.emit('exit', 0)); return true; };
  return child;
}

(async () => {
  // =========================================================================
  console.log('== A. 纯逻辑：参数与环境净化 ==');
  const tt = await importTs('terminal-tools.ts');

  await check('create 归一化：缺省 cwd 回落到宿主默认，cols/rows 缺省 80x24', () => {
    const r = tt.normalizeTerminalCreate({}, 'D:/work');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.cwd, 'D:/work');
    assert.strictEqual(r.cols, tt.TERMINAL_COLS_DEFAULT);
    assert.strictEqual(r.rows, tt.TERMINAL_ROWS_DEFAULT);
  });

  await check('create 归一化：\'\' / undefined 走默认值（Number(\'\')=0 的坑从入口挡掉）', () => {
    const r = tt.normalizeTerminalCreate({ cwd: 'D:/w', cols: '', rows: undefined }, 'D:/fallback');
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.cols, tt.TERMINAL_COLS_DEFAULT);
    assert.strictEqual(r.rows, tt.TERMINAL_ROWS_DEFAULT);
    const r2 = tt.normalizeTerminalCreate({ cwd: 'D:/w', cols: '120', rows: 30 }, 'D:/f');
    assert.strictEqual(r2.cols, 120, '数字字符串应被解析');
    assert.strictEqual(r2.rows, 30);
  });

  await check('create 归一化：越界钳制到上下限', () => {
    const r = tt.normalizeTerminalCreate({ cwd: 'D:/w', cols: 99999, rows: 1 }, 'D:/f');
    assert.strictEqual(r.cols, tt.TERMINAL_COLS_MAX);
    assert.strictEqual(r.rows, tt.TERMINAL_ROWS_MIN);
  });

  await check('create 归一化：相对路径 / 空 fallback / 超长路径被拒（不猜）', () => {
    assert.strictEqual(tt.normalizeTerminalCreate({ cwd: 'relative/path' }, 'D:/f').ok, false);
    assert.ok(tt.normalizeTerminalCreate({}, '').reason.includes('cwd'));
    const long = tt.normalizeTerminalCreate({ cwd: 'D:/' + 'a'.repeat(1100) }, 'D:/f');
    assert.strictEqual(long.ok, false, '超长应拒绝');
  });

  await check('环境净化：shim/调试变量剔除（NODE_OPTIONS 会劫持终端里的任何 node）', () => {
    const env = {
      PATH: 'C:/Windows', NODE_OPTIONS: '--require shim.cjs', NODE_PATH: '/x',
      ELECTRON_RUN_AS_NODE: '1', ORCHDESK_PTY_MODULE: '/y', LANG: 'zh_CN.UTF-8',
      ORCHDESK_HOME: 'C:/Users/x/AppData/Roaming/OrchDesk', ORCHDESK_DATA_DIR: 'C:/Users/x/AppData/Roaming/OrchDesk',
      ORCHDESK_STEP_RUNTIME: 'D:/checkout/step',
    };
    const snapshot = JSON.stringify(Object.keys(env));
    const out = tt.sanitizeTerminalEnv(env);
    assert.strictEqual(out.PATH, 'C:/Windows', '正常变量保留');
    assert.strictEqual(out.LANG, 'zh_CN.UTF-8');
    for (const k of tt.CHILD_ENV_STRIP) assert.ok(!(k in out), `${k} 必须剔除`);
    // BUG-049：数据目录定位变量必须剥掉——子进程不该知道本壳状态文件在哪。
    for (const k of ['ORCHDESK_HOME', 'ORCHDESK_DATA_DIR', 'ORCHDESK_STEP_RUNTIME']) {
      assert.ok(!(k in out), `${k} 必须被剔除（它指向本壳的数据目录）`);
    }
    assert.strictEqual(JSON.stringify(Object.keys(env)), snapshot, '不得改原对象');
    assert.strictEqual(out.ORCHDESK_BROWSER_NO_SANDBOX, undefined);
  });

  await check('pty 加载候选：显式 env > vendor > node_modules > extra（优先级即顺序）', () => {
    process.env.ORCHDESK_PTY_MODULE = 'D:/custom-pty';
    const cands = tt.ptyRequireCandidates('D:/app', ['D:/dsh-home/profiles/node_modules']);
    delete process.env.ORCHDESK_PTY_MODULE;
    assert.strictEqual(cands[0], 'D:/custom-pty', '显式覆盖必须最优先');
    assert.ok(cands[1].includes('vendor/node-pty'), 'vendor 路径第二：' + cands[1]);
    assert.ok(cands[2].includes('node_modules/node-pty'));
    assert.ok(cands[3].includes('profiles/node_modules/node-pty'));
    assert.strictEqual(tt.ptyRequireCandidates('D:/app').length, 2, '无 override/extra 时候选收敛');
  });

  await check('joinPath：折叠 .. / // / .，盘符不被误折叠', () => {
    assert.strictEqual(tt.joinPath('D:/a', 'b', '..', 'c'), 'D:/a/c');
    assert.strictEqual(tt.joinPath('D://x//', 'y'), 'D:/x/y');
    assert.strictEqual(tt.joinPath('D:', '..', 'x'), 'D:/x', '盘符后不允许 .. 顶掉根');
    assert.strictEqual(tt.joinPath('/a', './b'), '/a/b');
  });

  await check('状态描述：ptyAvailable=false → via 显式 pipe（降级可见，不冒充）', () => {
    assert.strictEqual(tt.describeTerminalState([], true).via, 'pty');
    const s = tt.describeTerminalState([{ id: 't1', pid: 1, shell: 'cmd', cwd: 'D:/', via: 'pipe', createdAt: 0, exited: false }], false);
    assert.strictEqual(s.via, 'pipe');
    assert.strictEqual(s.count, 1);
  });

  // =========================================================================
  console.log('== B. 宿主：pty 正路与降级 ==');
  const tp = require('./dist/terminal-pty.js');

  const fake = makeFakePty();
  tp.setPtyForTest(fake.spawn);

  const mkOpts = (env) => ({
    appDir: 'D:/app',
    extraPtyDirs: [],
    fallbackCwd: 'D:/work',
    env: env || { PATH: 'C:/Windows', LANG: 'zh_CN.UTF-8' },
  });

  const seenData = [];
  const seenExit = [];
  tp.onTerminalData((ev) => seenData.push(ev));
  tp.onTerminalExit((ev) => seenExit.push(ev));

  let created;
  await check('创建（pty 正路）：via=pty、pid/shell/cwd 如实、会话入表', () => {
    const r = tp.createTerminal({ cwd: 'D:/proj', cols: 100, rows: 30 }, mkOpts());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    created = r.session;
    assert.strictEqual(r.session.via, 'pty');
    assert.strictEqual(r.session.pid, 4242);
    assert.strictEqual(r.session.cwd, 'D:/proj');
    assert.ok(fake.state.lastOpts.cols === 100 && fake.state.lastOpts.rows === 30);
    assert.strictEqual(tp.getTerminalState().count, 1);
  });

  await check('环境净化在创建时生效：假 pty 收到的 env 没有 NODE_OPTIONS', () => {
    const r = tp.createTerminal({ cwd: 'D:/proj' }, {
      appDir: 'D:/app', fallbackCwd: 'D:/work',
      env: { PATH: '/bin', NODE_OPTIONS: '--require evil.cjs', ELECTRON_RUN_AS_NODE: '1' },
    });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(fake.state.lastOpts.env.NODE_OPTIONS, undefined, 'NODE_OPTIONS 必须被剔除');
    assert.strictEqual(fake.state.lastOpts.env.ELECTRON_RUN_AS_NODE, undefined);
    assert.strictEqual(fake.state.lastOpts.env.PATH, '/bin');
    tp.killTerminal(r.session.id);
  });

  await check('write 透传：键入原样到达 pty', () => {
    assert.strictEqual(tp.writeTerminal(created.id, 'ls -la\r'), true);
    assert.ok(fake.state.received.includes('ls -la\r'), JSON.stringify(fake.state.received));
    assert.strictEqual(tp.writeTerminal('no-such-id', 'x'), false, '未知 id 返回 false');
  });

  await check('resize 透传 + 越界钳制', () => {
    assert.strictEqual(tp.resizeTerminal(created.id, 120, 40), true);
    assert.deepStrictEqual(fake.state.resizeCalls[fake.state.resizeCalls.length - 1], [120, 40]);
    tp.resizeTerminal(created.id, 0, 99999);
    assert.deepStrictEqual(fake.state.resizeCalls[fake.state.resizeCalls.length - 1], [10, 300]);
  });

  await check('数据攒批：16ms 窗口内 5 块合并 ≤2 次推送，内容不丢', async () => {
    const before = seenData.length;
    const poke = fake.poke(0); // 第一个 spawn = created 会话
    for (let i = 0; i < 5; i++) poke.data(`chunk-${i}\r\n`);
    await new Promise((r) => setTimeout(r, 80));
    const pushed = seenData.slice(before).filter((p) => p.id === created.id);
    assert.ok(pushed.length <= 2, `应攒批（≤2 次），实际 ${pushed.length} 次`);
    const all = pushed.map((p) => p.data).join('');
    for (let i = 0; i < 5; i++) assert.ok(all.includes(`chunk-${i}`), `chunk-${i} 不应丢失`);
  });

  await check('回放缓冲：新观察者（重开 Tab）可补看最近输出', () => {
    const st = tp.getTerminalState();
    const s = st.sessions.find((x) => x.id === created.id);
    assert.ok(s.replay.includes('chunk-0'), '回放应包含历史输出');
    assert.ok(s.replay.length <= tt.TERMINAL_REPLAY_MAX);
  });

  await check('洪峰截断：单窗超限时推送带显式标记（不静默丢弃）', async () => {
    const before = seenData.length;
    const poke = fake.poke(0);
    const big = 'x'.repeat(tt.TERMINAL_CHUNK_MAX + 1024);
    poke.data(big);
    await new Promise((r) => setTimeout(r, 80));
    const pushed = seenData.slice(before).filter((p) => p.id === created.id);
    assert.ok(pushed.length >= 1);
    assert.ok(pushed[pushed.length - 1].data.includes('已截断'), '截断必须可见');
    const s = tp.getTerminalState().sessions.find((x) => x.id === created.id);
    assert.ok(s.replay.length <= tt.TERMINAL_REPLAY_MAX, '洪峰后回放缓冲仍在上限内');
    // 单块本身超过上限时也必须封顶（先截 chunk 再对拼接结果封顶，两处 slice
    // 缺一不可——否则「64KB 尾巴 + 1MB chunk」会绕过上限直接推给渲染层）。
    for (const p of pushed) {
      assert.ok(
        p.data.length <= tt.TERMINAL_CHUNK_MAX + 64,
        `单条推送不得超过 CHUNK_MAX+标记：实际 ${p.data.length}`,
      );
    }
  });

  await check('退出推送：onExit → exit 事件 + 状态标 exited', async () => {
    const before = seenExit.length;
    fake.poke(0).exit(3);
    await new Promise((r) => setTimeout(r, 30));
    const pushed = seenExit.slice(before).filter((e) => e.id === created.id);
    assert.strictEqual(pushed.length, 1, '应推送一次退出');
    assert.strictEqual(pushed[0].code, 3);
    const s = tp.getTerminalState().sessions.find((x) => x.id === created.id);
    assert.strictEqual(s.exited, true);
    assert.strictEqual(s.exitCode, 3);
  });

  await check('killTerminal：pty 被 kill、会话立即出表（幂等）', () => {
    assert.strictEqual(tp.killTerminal(created.id), true);
    assert.strictEqual(fake.state.killed >= 1, true);
    assert.strictEqual(tp.getTerminalState().count, 0);
    assert.strictEqual(tp.killTerminal(created.id), false, '重复 kill 返回 false');
    assert.strictEqual(tp.writeTerminal(created.id, 'x'), false, '已关闭不可写');
  });

  const cp = require('node:child_process');
  const origSpawn = cp.spawn;
  let fakeChild = null;
  let pipeSession = null;
  cp.spawn = function () {
    fakeChild = makeFakeChild();
    return fakeChild;
  };
  try {
    tp.setPtyForTest(null);
    await check('管道模式显式降级：无 pty 候选 → via=pipe 且功能可用（不是报错）', async () => {
      const r = tp.createTerminal({ cwd: 'D:/proj' }, mkOpts());
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      pipeSession = r.session;
      assert.strictEqual(r.session.via, 'pipe', '降级必须可见');
      assert.strictEqual(r.session.pid, 777);
      tp.writeTerminal(pipeSession.id, 'echo hi\r');
      assert.ok(fakeChild.written.includes('echo hi\r'), '键入应到达 stdin');
      const before = seenData.length;
      fakeChild.stdout.emit('data', 'hello from pipe\r\n');
      await new Promise((r2) => setTimeout(r2, 60));
      assert.ok(seenData.slice(before).some((p) => p.data.includes('hello from pipe')));
      assert.strictEqual(tp.resizeTerminal(pipeSession.id, 120, 40), true, 'resize 是 no-op 但不报错');
    });

    await check('管道模式退出：child exit → 事件 + 状态', async () => {
      const before = seenExit.length;
      fakeChild.emit('exit', 0);
      await new Promise((r) => setTimeout(r, 30));
      assert.ok(seenExit.slice(before).some((e) => e.id === pipeSession.id));
    });
  } finally {
    cp.spawn = origSpawn;
    tp.killTerminal(pipeSession && pipeSession.id);
  }

  await check('会话上限：第 7 个被明确拒绝（终端是长驻 OS 资源）', () => {
    tp.setPtyForTest(makeFakePty().spawn);
    const ids = [];
    for (let i = 0; i < tt.TERMINAL_MAX_SESSIONS; i++) {
      const r = tp.createTerminal({ cwd: 'D:/w' }, mkOpts());
      assert.strictEqual(r.ok, true);
      ids.push(r.session.id);
    }
    const r7 = tp.createTerminal({ cwd: 'D:/w' }, mkOpts());
    assert.strictEqual(r7.ok, false);
    assert.ok(r7.reason.includes(String(tt.TERMINAL_MAX_SESSIONS)), '拒绝原因应说明上限：' + r7.reason);
    for (const id of ids) tp.killTerminal(id);
  });

  await check('已退出的会话不占名额（否则连开 6 个短命令后就再也开不了新终端）', () => {
    const fakeX = makeFakePty();
    tp.setPtyForTest(fakeX.spawn);
    const ids = [];
    for (let i = 0; i < tt.TERMINAL_MAX_SESSIONS; i++) {
      const r = tp.createTerminal({ cwd: 'D:/w' }, mkOpts());
      assert.strictEqual(r.ok, true, JSON.stringify(r));
      ids.push(r.session.id);
    }
    // 全部退出（留着看最后一眼输出），但 Tab 不关
    ids.forEach((id, i) => fakeX.poke(i).exit(0));
    const again = tp.createTerminal({ cwd: 'D:/w' }, mkOpts());
    assert.strictEqual(again.ok, true, '退出的会话不应占名额：' + JSON.stringify(again));
    tp.killTerminal(again.session.id);
    for (const id of ids) tp.killTerminal(id);
  });

  await check('回放缓冲在退出/kill 后释放（不按 64KB/会话 常驻）', async () => {
    const fakeY = makeFakePty();
    tp.setPtyForTest(fakeY.spawn);
    const r = tp.createTerminal({ cwd: 'D:/w' }, mkOpts());
    fakeY.poke(0).data('y'.repeat(4096));
    await new Promise((res) => setTimeout(res, 40));
    const alive = tp.getTerminalState().sessions.find((x) => x.id === r.session.id);
    assert.ok(alive.replay.length > 0, '活着时应有回放内容');
    fakeY.poke(0).exit(0);
    await new Promise((res) => setTimeout(res, 30));
    const gone = tp.getTerminalState().sessions.find((x) => x.id === r.session.id);
    assert.ok(gone, '退出但未关 Tab 时条目应保留（用户还要看最后一眼输出）');
    assert.strictEqual(gone.replay, '', '退出后回放缓冲必须释放，否则反复开关终端会持续涨内存');
    tp.killTerminal(r.session.id);
  });

  await check('ptyAvailable 未探测态不得冒充可用（undefined !== null 的经典坑）', () => {
    // 干净实例：ptyCache 处于 undefined（ensurePtyLoaded 尚未跑 / 抛错被吞）
    const p = require.resolve('./dist/terminal-pty.js');
    const saved = require.cache[p];
    delete require.cache[p];
    try {
      const fresh = require('./dist/terminal-pty.js');
      const st = fresh.getTerminalState();
      assert.strictEqual(st.ptyAvailable, false, '未探测 = 不可用，不许报 true');
      assert.strictEqual(st.via, 'pipe', '未探测时 via 必须 pipe；ptyAvailable=true 却 via=pipe 就是降级不可见');
    } finally {
      delete require.cache[p];
      // 恢复原模块实例：C 组随后 require main.js，必须拿到注入过 fake pty 的那一份
      if (saved) require.cache[p] = saved;
    }
  });

  // =========================================================================
  console.log('== C. 接线：stub electron 驱动 dist/main.js ==');
  const electronStub = makeElectronStub({ home: HOME });
  const ipcHandlers = electronStub.ipcHandlers;
  const ready = new Promise((r) => { electronStub.app.whenReady = () => { setImmediate(r); return Promise.resolve(); }; });

  // 在 main.js 之前注入 fake pty：ensurePtyLoaded（whenReady 内）会复用缓存。
  const fakeC = makeFakePty();
  tp.setPtyForTest(fakeC.spawn);

  const origLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return electronStub;
    return origLoad.apply(this, arguments);
  };
  global.fetch = async () => ({ ok: true, status: 200, text: async () => '{}', json: async () => ({}) });

  require('./dist/main.js');
  await ready;
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 50));
    if (ipcHandlers.has('orchdesk:plugin-runtime')) {
      const st = await ipcHandlers.get('orchdesk:plugin-runtime')(null);
      if (st && st.ready === false) break;
    }
  }

  await check('5 个 terminal IPC handler 真注册在主进程', () => {
    for (const ch of ['orchdesk:terminal-create', 'orchdesk:terminal-write', 'orchdesk:terminal-resize', 'orchdesk:terminal-kill', 'orchdesk:terminal-status']) {
      assert.ok(ipcHandlers.has(ch), `缺少 ${ch}`);
    }
  });

  await check('terminal-create（经 IPC）：ok + via=pty + preload 契约形状', async () => {
    const r = await ipcHandlers.get('orchdesk:terminal-create')(null, { cwd: 'D:/proj' });
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.session.via, 'pty');
    assert.ok(typeof r.session.id === 'string' && r.session.id.length > 0);
    assert.ok(typeof r.session.pid === 'number');
    global.__t1 = r.session.id;

    // BUG-067：PTY 创建要在沙箱日志里留下可追溯条目（读真正落盘的文件，不读内存对象）。
    const sb = require('./dist/ipc-sandbox.js');
    sb.flushSandboxLog();
    const sbFile = sb.sandboxLogFile();
    const entries = JSON.parse(fs.readFileSync(sbFile, 'utf-8'));
    const mine = entries.filter((x) => x && x.tool === 'terminal.create');
    assert.ok(mine.length >= 1, '沙箱日志里应有一条 terminal.create，文件=' + sbFile + '，实际条数=' + mine.length);
    const last = mine[mine.length - 1];
    assert.strictEqual(last.kind, 'command', 'PTY 留痕该归到 command 这一类，实际 ' + last.kind);
    assert.strictEqual(last.decision, 'allowed', '创建成功的留痕应是 allowed，实际 ' + last.decision);
    assert.ok(typeof last.target === 'string' && last.target.length > 2, 'target 必须是生效的工作目录，实际 ' + last.target);
  });

  await check('terminal-status：会话与回放缓冲可见', async () => {
    const st = await ipcHandlers.get('orchdesk:terminal-status')(null);
    assert.strictEqual(st.ptyAvailable, true);
    assert.strictEqual(st.via, 'pty');
    assert.strictEqual(st.count, 1);
    assert.ok(st.sessions[0].id === global.__t1);
    assert.ok(typeof st.sessions[0].replay === 'string');
  });

  await check('terminal-write → pty 收到；未知 id → ok:false', async () => {
    const w = await ipcHandlers.get('orchdesk:terminal-write')(null, global.__t1, 'dir\r');
    assert.strictEqual(w.ok, true);
    const bad = await ipcHandlers.get('orchdesk:terminal-write')(null, 'nope', 'x');
    assert.strictEqual(bad.ok, false);
  });

  await check('terminal-data 推送真的到达渲染层（webSent 里有 id 匹配的事件）', async () => {
    const before = electronStub.webSent.filter((x) => x.ch === 'orchdesk:terminal-data').length;
    const r = await ipcHandlers.get('orchdesk:terminal-create')(null, { cwd: 'D:/proj' });
    assert.strictEqual(r.ok, true);
    fakeC.poke(fakeC.state.spawns.length - 1).data('wire-poke\r\n');
    await new Promise((r2) => setTimeout(r2, 80));
    const sent = electronStub.webSent
      .filter((x) => x.ch === 'orchdesk:terminal-data')
      .slice(before);
    assert.ok(sent.length >= 1, '应至少推送一次');
    const hit = sent.find((x) => x.payload && x.payload.id === r.session.id && String(x.payload.data).includes('wire-poke'));
    assert.ok(hit, '推送事件应携带会话 id 与输出内容：' + JSON.stringify(sent.map((s) => s.payload && s.payload.id)));
    await ipcHandlers.get('orchdesk:terminal-kill')(null, r.session.id);
    await ipcHandlers.get('orchdesk:terminal-kill')(null, global.__t1);
  });

  await check('terminal-kill（经 IPC）幂等且状态归零', async () => {
    const r = await ipcHandlers.get('orchdesk:terminal-kill')(null, 'whatever');
    assert.strictEqual(r.ok, false, '未知 id ok:false');
    const st = await ipcHandlers.get('orchdesk:terminal-status')(null);
    assert.strictEqual(st.count, 0, '套件内创建的会话已全部清理');
  });

  await check('closeAllTerminals：退出前清空会话表并如实计数（守卫反证）', () => {
    // before-quit 原先不关 PTY：Windows 上退出后留下 cmd.exe / ConPTY 孤儿。
    // 这条断言的是「表真的空了 + kill 数对得上 + 重复调用幂等」，不是函数存在。
    const startCount = tp.getTerminalState().count;
    const r = tp.createTerminal({ cwd: 'D:/proj' }, mkOpts());
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const afterCreate = tp.getTerminalState().count;
    assert.strictEqual(afterCreate, startCount + 1, `创建后应多一个会话，实际 ${afterCreate}`);

    const killed = tp.closeAllTerminals();
    assert.strictEqual(killed, afterCreate, `应报出关掉 ${afterCreate} 个，实际 ${killed}`);
    assert.strictEqual(tp.getTerminalState().count, 0, '会话表必须清空');
    assert.strictEqual(tp.closeAllTerminals(), 0, '重复调用应为 0（幂等）');
  });

  const ok = summary('终端 PTY 全部验证通过');
  process.exit(ok ? 0 : 1);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
