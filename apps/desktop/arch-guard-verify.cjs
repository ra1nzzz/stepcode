/**
 * 架构守护测试（ADR-0010 · 借鉴 lencx/Minke 的 knownViolation 自检思路）。
 *
 * 动机：OrchDesk 有一批「只靠自觉」的架构铁律——渲染层禁 require、纯逻辑模块
 * 零 electron 依赖、工具执行与持久化只在主进程。这些约束过去只在人脑和 ADR 里，
 * 没有机器守护：改着改着就会被静默破坏，而且没人会在 review 里发现。
 *
 * 与功能测试的区别：功能测试断言「代码做了什么」，本套件断言「代码不允许变成
 * 什么样」。后者一旦失效是**静默**的——所以每条规则都必须配自检：
 *
 *   M1 规则必须命中自己的正样本（正则写错/被误改成永假 → FAIL「规则失效」）
 *   M2 规则的扫描面必须非空（glob 写错/文件改名 → FAIL「规则空转」）
 *   M3 豁免名单指向的文件必须存在（拼错路径 → FAIL「豁免失效」）
 *   M4 白名单模块必须存在
 *
 * 运行：node arch-guard-verify.cjs
 */
const path = require('path');
const fs = require('fs');

const APP_DIR = __dirname;
const ROOT = path.resolve(APP_DIR, '..', '..');

let passed = 0; let failed = 0; const log = [];
async function check(name, fn) {
  try { await fn(); passed += 1; log.push(`  PASS  ${name}`); }
  catch (e) { failed += 1; log.push(`  FAIL  ${name}\n        ${e && e.message || e}`); }
}
function assert(cond, msg) { if (!cond) throw new Error(msg); }

/* ------------------------------ 扫描面 ------------------------------ */

/** 剥离块注释与整行 // 注释；不剥行尾注释，以免误伤 'http://' 之类的字符串。 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

function rendererFiles() {
  const dir = path.join(APP_DIR, 'renderer');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => ({ name: `renderer/${f}`, abs: path.join(dir, f) }));
  // 审查项③：动作按页模块化至 renderer/actions/*.js——bridge 调用面随之扩展
  const actionsDir = path.join(dir, 'actions');
  if (fs.existsSync(actionsDir)) {
    for (const f of fs.readdirSync(actionsDir).filter((f) => f.endsWith('.js'))) {
      files.push({ name: `renderer/actions/${f}`, abs: path.join(actionsDir, f) });
    }
  }
  return files;
}

/** apps/desktop 顶层 .ts 全量（R9/R12 共用扫描面）。 */
function desktopTsFiles() {
  return fs.readdirSync(APP_DIR).filter((f) => f.endsWith('.ts')).map((f) => path.join(APP_DIR, f));
}

/** 纯逻辑模块白名单：零 electron 依赖、可 node 直测（ADR-0008 / 渲染层双环境方案）。 */
const PURE_MODULES = [
  'agent-runtime.ts', 'browser-tools.ts', 'common-tools.ts', 'connector-registry.ts',
  'credentials.ts', 'data-dir.ts',
  'file-panel.ts',
  'memory-promotion.ts', 'memory-summarize.ts', 'plugin-market.ts',
  'mcp-client.ts', 'connector-discover.ts',
  'sandbox-log.ts', 'session-events.ts', 'terminal-tools.ts', 'usage-registry.ts',
];
function pureFiles() {
  return PURE_MODULES.map((f) => ({ name: f, abs: path.join(APP_DIR, f) }));
}

function hostSourceFiles() {
  return [...PURE_MODULES.map((f) => path.join(APP_DIR, f)), ...rendererFiles().map((f) => f.abs)];
}

function read(p) { return fs.readFileSync(p, 'utf-8'); }

/**
 * preload 故意暴露但渲染层尚未调用的方法。
 * 目标尽量为空；只收录扫描后确实零 caller 的名字（拼错 → M3 豁免失效）。
 */
const PRELOAD_UNUSED_ALLOW = [
  // MCP 工具调用留给主会话 / Agent 复用，渲染层目前没有接线
  'mcpCallTool',
];

/**
 * 解析 preload.ts 里 `const orchdesk = { ... }` 的顶层方法名。
 * 配对花括号到对象结束，只收 depth=1 的 `name:` / `name(`，并跳过 `.invoke(` 这类成员调用。
 */
function parsePreloadOrchdeskMethods(code) {
  const stripped = stripComments(code);
  const marker = stripped.match(/\borchdesk\s*=\s*\{/);
  if (!marker) throw new Error('preload.ts 未找到 orchdesk = {');
  let i = marker.index + marker[0].length;
  let brace = 1;
  let paren = 0;
  let bracket = 0;
  let inStr = null;
  let esc = false;
  const methods = [];
  while (i < stripped.length && brace > 0) {
    const c = stripped[i];
    if (inStr) {
      if (esc) { esc = false; i += 1; continue; }
      if (c === '\\') { esc = true; i += 1; continue; }
      if (c === inStr) inStr = null;
      i += 1;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; i += 1; continue; }
    if (c === '{') { brace += 1; i += 1; continue; }
    if (c === '}') { brace -= 1; if (brace === 0) break; i += 1; continue; }
    if (c === '(') { paren += 1; i += 1; continue; }
    if (c === ')') { paren -= 1; i += 1; continue; }
    if (c === '[') { bracket += 1; i += 1; continue; }
    if (c === ']') { bracket -= 1; i += 1; continue; }
    if (brace === 1 && paren === 0 && bracket <= 0 && /[A-Za-z_$]/.test(c)) {
      let p = i - 1;
      while (p >= 0 && /[ \t]/.test(stripped[p])) p -= 1;
      const isMember = p >= 0 && stripped[p] === '.';
      let j = i + 1;
      while (j < stripped.length && /[\w$]/.test(stripped[j])) j += 1;
      const name = stripped.slice(i, j);
      let k = j;
      while (k < stripped.length && /[ \t]/.test(stripped[k])) k += 1;
      if (!isMember && (stripped[k] === ':' || stripped[k] === '(')) methods.push(name);
      i = j;
      continue;
    }
    i += 1;
  }
  return [...new Set(methods)];
}

/** renderer/*.js 中的 `bridge.NAME` / `orchdesk.NAME`；跳过字符串字面量与 `bridge[expr]` 动态名。 */
function rendererBridgeNames() {
  const names = new Set();
  for (const f of rendererFiles()) {
    const stripped = stripComments(read(f.abs));
    const re = /\b(?:bridge|orchdesk)\.([A-Za-z_$][\w$]*)/g;
    let m;
    while ((m = re.exec(stripped))) {
      const prev = m.index > 0 ? stripped[m.index - 1] : '';
      if (prev === "'" || prev === '"' || prev === '`') continue;
      names.add(m[1]);
    }
  }
  return names;
}

/* ------------------------------ 规则表 ------------------------------ */

/**
 * 每条规则：id / desc / files / forbid（正则数组）/ sample（必然违规的正样本）。
 * sample 用于 M1 自检：规则抓不到自己的 sample = 规则失效。
 */
const RULES = [
  {
    id: 'R1',
    desc: '渲染层禁 Node/Electron 直连（一律经 contextBridge）',
    files: rendererFiles,
    forbid: [
      /\brequire\s*\(/,
      /\bprocess\s*\./,
      /__dirname\b/,
      /__filename\b/,
      /from\s+['"]electron['"]/,
      /\bnode:/,
    ],
    sample: "const { app } = require('electron');\nconst p = process.cwd();\n",
  },
  {
    id: 'R2',
    desc: '纯逻辑模块零 electron 依赖（才可 node 直测）',
    files: pureFiles,
    forbid: [
      /from\s+['"]electron['"]/,
      /require\(\s*['"]electron['"]\s*\)/,
      /\bipcMain\b/,
      /\bipcRenderer\b/,
      /\bBrowserWindow\b/,
    ],
    sample: "import { app, ipcMain } from 'electron';\nexport const p = app.getPath('userData');\n",
  },
  {
    id: 'R3',
    desc: '纯逻辑模块不得依赖宿主层（main/preload/host-services）',
    files: pureFiles,
    forbid: [
      /from\s+['"]\.\/main['"]/,
      /from\s+['"]\.\/preload['"]/,
      /from\s+['"]\.\/host-services['"]/,
      /require\(\s*['"]\.\/main['"]\s*\)/,
    ],
    sample: "import { boot } from './main';\nexport const x = boot;\n",
  },
  {
    id: 'R4',
    desc: '渲染层不得做持久化与工具执行（只在主进程）',
    files: rendererFiles,
    forbid: [
      /\bfs\s*\.\s*(writeFileSync|appendFileSync|unlinkSync|rmSync|mkdirSync)\b/,
      /\bchild_process\b/,
      /\bexecSync\s*\(/,
      /\bspawnSync\s*\(/,
    ],
    sample: "const fs = require('fs');\nfs.writeFileSync('a.txt', 'x');\n",
  },
  {
    id: 'R5',
    desc: '源码禁硬编码本机绝对路径与密钥形态',
    files: () => hostSourceFiles().map((abs) => ({ name: path.basename(abs), abs })),
    forbid: [
      /[A-Za-z]:\\+Users\\+/i,
      /\/home\/[a-z][a-z0-9_-]*\//,
      /\bghp_[A-Za-z0-9]{20,}\b/,
      /\bsk-[A-Za-z0-9]{20,}\b/,
    ],
    sample: "const HOME = 'C:\\\\Users\\\\someone\\\\.orchdesk';\nconst TOKEN = 'ghp_abcdefghijklmnopqrstuvwxyz012345';\n",
  },
];

/** 对一段代码跑规则，返回命中列表（[{ rule, file, pattern, line }]）。 */
function scanRule(rule, code, fileName) {
  const hits = [];
  const lines = stripComments(code).split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const re of rule.forbid) {
      if (re.test(line)) hits.push({ rule: rule.id, file: fileName, pattern: String(re), line: i + 1, text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}

/* ------------------------------ 规则执行 ------------------------------ */

(async () => {
  console.log('== 架构守护：规则（ADR-0010）==');

  for (const rule of RULES) {
    await check(`${rule.id} ${rule.desc}`, () => {
      const files = rule.files();
      assert(files.length > 0, `${rule.id} 扫描面为空（规则空转）`);
      const hits = [];
      for (const f of files) {
        assert(fs.existsSync(f.abs), `${rule.id} 扫描到不存在的文件：${f.name}`);
        hits.push(...scanRule(rule, read(f.abs), f.name));
      }
      assert(hits.length === 0, `${rule.id} 命中 ${hits.length} 处违规：\n        ` +
        hits.map((h) => `${h.file}:${h.line}  ${h.text}`).join('\n        '));
    });
  }

  /* -------------------- 非正则规则：产物链路不陈旧 -------------------- */

  console.log('== 架构守护：产物链路 ==');

  await check('R6 九个 dsh 插件包与 vendor 副本已删除', () => {
    const names = ['intent', 'trace', 'authz', 'brain', 'multi', 'memory', 'prompt', 'compensation', 'evolution'];
    const present = names.filter((name) => fs.existsSync(path.join(ROOT, 'packages', 'plugin', name)) || fs.existsSync(path.join(APP_DIR, 'vendor', 'plugins', name)));
    assert(present.length === 0, '插件删除未完成: ' + present.join(', '));
  });

  await check('R7 每个验证套件都在 package.json verify 链上（防套件被悄悄摘掉）', () => {
    const pkg = JSON.parse(read(path.join(APP_DIR, 'package.json')));
    const chain = String(pkg.scripts && pkg.scripts.verify || '');
    assert(chain.length > 0, 'package.json 缺少 verify 脚本');
    const baseline = 18; // v0.12.0 基线（含本套件与 ts-loader 前的 18 个）
    const missing = [];
    for (const f of fs.readdirSync(APP_DIR)) {
      if (f.endsWith('-verify.cjs') && !chain.includes(f)) missing.push(`apps/desktop/${f}`);
    }
    assert(missing.length === 0, '以下套件不在 verify 链上：' + missing.join(', '));
    const count = (chain.match(/-verify\.cjs|verify-[a-z-]+\.mjs/g) || []).length;
    assert(count >= baseline, `verify 链上套件数 ${count} 少于基线 ${baseline}（链条被删减？）`);
  });

  /* -------------------- 非正则规则：preload 必须有渲染层调用方 -------------------- */

  await check('R8 preload 方法必须有渲染层调用方', () => {
    const preloadPath = path.join(APP_DIR, 'preload.ts');
    assert(fs.existsSync(preloadPath), '找不到 preload.ts');
    const methods = parsePreloadOrchdeskMethods(read(preloadPath));
    assert(methods.length > 20, `preload 顶层方法仅 ${methods.length} 个（规则空转）`);
    const methodSet = new Set(methods);
    const missingAllow = PRELOAD_UNUSED_ALLOW.filter((n) => !methodSet.has(n));
    assert(missingAllow.length === 0, 'PRELOAD_UNUSED_ALLOW 豁免失效（preload 中不存在）：' + missingAllow.join(', '));
    const called = rendererBridgeNames();
    const allow = new Set(PRELOAD_UNUSED_ALLOW);
    const unused = methods.filter((n) => !called.has(n) && !allow.has(n));
    assert(unused.length === 0, '以下 preload 方法零渲染层调用方：' + unused.join(', '));
  });

  await check('R8b 渲染层不得调用不存在的 preload 方法', () => {
    const preloadPath = path.join(APP_DIR, 'preload.ts');
    assert(fs.existsSync(preloadPath), '找不到 preload.ts');
    const methodSet = new Set(parsePreloadOrchdeskMethods(read(preloadPath)));
    const called = rendererBridgeNames();
    const dead = [...called].filter((n) => !methodSet.has(n)).sort();
    assert(dead.length === 0, '渲染层调用了 preload 不存在的方法：' + dead.join(', '));
  });

  /* ---------------- M-10：preload invoke 的 channel 串必须有真实 handler ---------------- */

  await check('R9 preload invoke 的 channel 在主进程必须有 handler（防拼写错误整桥失灵）', () => {
    const preloadPath = path.join(APP_DIR, 'preload.ts');
    assert(fs.existsSync(preloadPath), '找不到 preload.ts');
    const preloadSrc = stripComments(read(preloadPath));
    const invoked = new Set();
    const invokeRe = /invoke\(\s*['"](orchdesk:[a-z0-9-]+)['"]/g;
    let m;
    while ((m = invokeRe.exec(preloadSrc))) invoked.add(m[1]);
    assert(invoked.size > 20, `preload invoke channel 仅 ${invoked.size} 个（规则空转）`);

    const handled = new Set();
    const desktopTs = desktopTsFiles();
    assert(desktopTs.length > 10, `apps/desktop 顶层 .ts 仅 ${desktopTs.length} 个（规则空转）`);
    for (const abs of desktopTs) {
      const src = stripComments(read(abs));
      // ipc-* 模块经注入的 ipc 参数注册（ipc.handle(...)），main.ts 直连 ipcMain.handle(...)。
      const hRe = /\b(?:ipcMain|ipc)\.(?:handle|on)\(\s*['"](orchdesk:[a-z0-9-]+)['"]/g;
      let h;
      while ((h = hRe.exec(src))) handled.add(h[1]);
    }
    assert(handled.size > 50, `主进程 handler 仅 ${handled.size} 个（规则空转）`);

    const dangling = [...invoked].filter((c) => !handled.has(c)).sort();
    assert(dangling.length === 0, 'preload invoke 了不存在的 channel（拼写错误会让生产整桥失灵）：' + dangling.join(', '));
  });

  /* ---------------- M-5：maxToolIterations 上限常量单源，防三处漂移 ---------------- */

  await check('R10 maxToolIterations 上限单源（agent-runtime 常量 ↔ 渲染层滑块 ↔ 钳制点）', () => {
    const arSrc = stripComments(read(path.join(APP_DIR, 'agent-runtime.ts')));
    const capMatch = arSrc.match(/MAX_TOOL_ITERATIONS_CAP\s*=\s*(\d+)/);
    assert(capMatch, 'agent-runtime.ts 未定义 MAX_TOOL_ITERATIONS_CAP');
    const cap = Number(capMatch[1]);
    assert(cap >= 100 && cap <= 1000, `MAX_TOOL_ITERATIONS_CAP=${cap} 超出合理范围`);

    // 渲染层滑块 max 必须等于 cap（所见即所得）。
    const appSrc = stripComments(read(path.join(APP_DIR, 'renderer', 'app.js')));
    const sliderMatch = appSrc.match(/id=["']max-iter-pick["'][^>]*\bmax=["'](\d+)["']/);
    assert(sliderMatch, 'renderer app.js 未找到 max-iter-pick 滑块');
    assert(Number(sliderMatch[1]) === cap, `渲染层滑块 max=${sliderMatch[1]} 与 MAX_TOOL_ITERATIONS_CAP=${cap} 不一致`);

    // 钳制点必须引用常量而非裸数字。
    for (const f of ['main.ts', 'agent-turn.ts']) {
      const src = stripComments(read(path.join(APP_DIR, f)));
      const stray = src.match(/Math\.min\(\s*\d{3}\s*,\s*incoming\.maxToolIterations|Math\.min\(\s*\d{3}\s*,\s*modelCfg\.maxToolIterations/g);
      assert(!stray, `${f} 存在裸数字钳制（应引用 MAX_TOOL_ITERATIONS_CAP）：${stray && stray.join(', ')}`);
    }
  });

  /* ---------------- R11：SHELL_METACHARS 双份定义一致（跨构建边界的正则副本） ---------------- */

  await check('R11 authz 插件副本已删除，SHELL_METACHARS 只留在 agent-runtime', () => {
    const appSide = stripComments(read(path.join(APP_DIR, 'agent-runtime.ts')));
    assert(appSide.includes('SHELL_METACHARS'), 'agent-runtime.ts 应保留 SHELL_METACHARS');
    assert(!fs.existsSync(path.join(ROOT, 'packages', 'plugin', 'authz')), 'authz 插件应已删除，不能再留第二份正则');
  });

  /* ---------------- R12：数据目录单源（M3）——禁止 env 直读复辟 ---------------- */

  await check('R12 数据目录单源：除 data-dir.ts 与 main.ts 赋值点外禁止直读 ORCHDESK_DATA_DIR', () => {
    const offenders = [];
    for (const abs of desktopTsFiles()) {
      const rel = path.relative(APP_DIR, abs).replace(/\\/g, '/');
      if (rel === 'data-dir.ts' || rel === 'main.ts') continue;
      const src = stripComments(read(abs));
      if (/process\.env\.ORCHDESK_DATA_DIR/.test(src)) offenders.push(rel);
    }
    assert(offenders.length === 0,
      '以下模块直读了 ORCHDESK_DATA_DIR（应统一走 getDataDir() 单源）：' + offenders.join(', '));
    // main.ts 只允许「赋值」一处，不允许「读取」
    const mainSrc = stripComments(read(path.join(APP_DIR, 'main.ts')));
    const reads = mainSrc.match(/const\s+\w+\s*=\s*process\.env\.ORCHDESK_DATA_DIR/g) || [];
    assert(reads.length === 0, 'main.ts 不得读取 ORCHDESK_DATA_DIR（只允许赋值给子进程）：' + reads.join('; '));
  });

  /* ---------------- R13：main.ts 导入绑定必须被引用（组合根「导入即接线」守卫） ---------------- */

  await check('R13 main.ts 每个非 type 导入绑定都在后续代码被引用（防「导入了但没接线」的静默掉线）', () => {
    // 注意用原始文本而非 stripComments：后者不识别字符串/正则里的 /*，会把 main.ts
    // 大段真实代码误判为注释（R13 首版即因此误报 8 个存活导入）。失败方向安全：
    // 注释里提及导入名只会让规则漏报，不会把活接线误杀。
    const mainSrc = read(path.join(APP_DIR, 'main.ts'));
    // 收集所有 import 的绑定：命名/默认/命名空间；排除 type 前缀与 `import type` 整句。
    const bindings = new Map(); // name -> from
    const importStmtRe = /import\s+(type\s+)?([^;]+?)\s+from\s+'([^']+)';/g;
    let m;
    while ((m = importStmtRe.exec(mainSrc))) {
      if (m[1]) continue; // import type { ... }
      const clause = m[2];
      const named = clause.match(/\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(',')) {
          const seg = part.trim();
          if (!seg) continue;
          if (/^type\s+/.test(seg)) continue; // 行内 type 前缀
          const name = (seg.split(/\s+as\s+/).pop() || '').trim();
          if (name) bindings.set(name, m[3]);
        }
      }
      const ns = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
      if (ns) bindings.set(ns[1], m[3]);
      const def = clause.match(/^([A-Za-z_$][\w$]*)\s*(?:,|$)/);
      if (def && !named && !ns) bindings.set(def[1], m[3]);
    }
    assert(bindings.size >= 40, `main.ts 导入绑定仅 ${bindings.size} 个（规则空转）`);
    // 引用必须出现在 import 区结束之后（最后一个 import 语句的换行处起的正文）。
    const lastStmtEnd = mainSrc.lastIndexOf("from '");
    const bodyAfter = lastStmtEnd >= 0 ? mainSrc.slice(mainSrc.indexOf('\n', lastStmtEnd)) : mainSrc;
    const unreferenced = [...bindings.keys()].filter((n) => !new RegExp('\\b' + n.replace(/\$/g, '\\$') + '\\b').test(bodyAfter));
    assert(unreferenced.length === 0,
      '以下导入绑定在 main.ts 从未被引用（IPC 模块整组掉线/死导入，tsc 不报）：'
      + unreferenced.map((n) => `${n} (from ${bindings.get(n)})`).join(', '));
    // 孤儿语句守卫：`(ipcMain);` 这类调用名被误删后剩下的合法表达式（真实事故形态）。
    assert(!/^\s*\(\s*ipcMain\s*\)\s*;/m.test(mainSrc), 'main.ts 存在孤儿 `(ipcMain);` 语句（调用名被误删的特征）');
  });

  /* ---------------- R14：bridge stub 单源（审查项④） ---------------- */

  await check('R14 bridge stub 单源：bridge-stub.js 存在且被 index.html 与 app.js 双向引用', () => {
    const stubPath = path.join(APP_DIR, 'renderer', 'bridge-stub.js');
    assert(fs.existsSync(stubPath), 'renderer/bridge-stub.js 缺失');
    const html = read(path.join(APP_DIR, 'renderer', 'index.html'));
    assert(html.includes('<script src="bridge-stub.js"></script>'), 'index.html 未加载 bridge-stub.js');
    const app = read(path.join(APP_DIR, 'renderer', 'app.js'));
    assert(app.includes('window.orchdeskBridgeStub'), 'app.js 未引用共享 stub（双源复辟）');
  });

  /* ---------------- R15：registerXxxIpc 调用必须存在（复审轮 2：R13 只管 import 未用） ---------------- */

  await check('R15 ipc 模块的 register 导出必须在 main.ts 被调用一次且仅一次', () => {
    // R13 盲区实测：import 与调用同时删除时 R13/R9 双双静默（整组 IPC 掉线无守卫）。
    // 本规则反向扫：盘上每个 ipc-*.ts 的 register*Ipc 导出，main.ts 必须恰好调用一次。
    const ipcModules = fs.readdirSync(APP_DIR).filter((f) => /^ipc-[a-z-]+\.ts$/.test(f));
    assert(ipcModules.length >= 8, `ipc-* 模块仅 ${ipcModules.length} 个（规则空转）`);
    const mainSrc = read(path.join(APP_DIR, 'main.ts'));
    const problems = [];
    for (const mod of ipcModules) {
      const src = stripComments(read(path.join(APP_DIR, mod)));
      const exportRe = /export\s+function\s+(register[A-Z]\w*Ipc)\s*\(/g;
      let m;
      while ((m = exportRe.exec(src))) {
        const fn = m[1];
        const callRe = new RegExp('\\b' + fn + '\\s*\\(', 'g');
        const calls = mainSrc.match(callRe) || [];
        if (calls.length === 0) problems.push(`${fn}（${mod} 导出但 main.ts 从未调用——整组 IPC 掉线）`);
        else if (calls.length > 1) problems.push(`${fn} 在 main.ts 被调用 ${calls.length} 次（重复注册）`);
      }
    }
    assert(problems.length === 0, problems.join('; '));
  });

  /* ---------------- R16：stub 真单源（复审轮 2：app.js/e2e 重新长出内联副本的负向断言） ---------------- */

  await check('R16 stub 真单源：app.js 与 e2e 不得存在不 spread 共享 stub 的 window.orchdesk 定义', () => {
    // R14 只查三处 must-have；本规则堵「stub 定义重新长回来」的双源复辟形态。
    // app.js：不得再内联定义 runAgentTurn 空壳（唯一合法所在 = renderer/bridge-stub.js）
    const app = stripComments(read(path.join(APP_DIR, 'renderer', 'app.js')));
    assert(!app.includes('runAgentTurn:'), 'app.js 出现内联 stub 定义特征（双源复辟）');
    const stubFile = stripComments(read(path.join(APP_DIR, 'renderer', 'bridge-stub.js')));
    assert(stubFile.includes('runAgentTurn:') && stubFile.includes("intent: 'CONFIRM'"), 'bridge-stub.js 丢失 stub 定义（被误清空？）');
    // e2e：window.orchdesk = { 之后必须 spread 共享 stub（负向断言）
    const e2e = stripComments(read(path.join(APP_DIR, 'e2e-fix-verify.cjs')));
    assert(e2e.includes('window.orchdeskBridgeStub'), 'e2e-fix-verify.cjs 未 spread 共享 stub（恢复双源）');
  });

  /* ---------------- R17：actions 模块加载顺序 + 语法有效性（复审轮 2） ---------------- */

  await check('R17 actions/*.js 必须在 index.html 中先于 app.js 加载且语法可解析', () => {
    const html = read(path.join(APP_DIR, 'renderer', 'index.html'));
    const appIdx = html.indexOf('<script src="app.js"></script>');
    const actionsDir = path.join(APP_DIR, 'renderer', 'actions');
    const actionFiles = fs.existsSync(actionsDir) ? fs.readdirSync(actionsDir).filter((f) => f.endsWith('.js')) : [];
    assert(actionFiles.length >= 3, `actions/*.js 少于 3 个（规则空转）：${actionFiles.length}`);
    for (const f of actionFiles) {
      const tag = `<script src="actions/${f}"></script>`;
      const idx = html.indexOf(tag);
      assert(idx > 0, `index.html 缺 ${tag}（删掉它 arch-guard 全绿、运行时整页动作死掉）`);
      assert(idx < appIdx, `${tag} 必须在 app.js 之前加载`);
    }
    // 语法有效性：结构损伤（悬挂 } / 截断）不可能过 new Function——把 e2e 兜底前移到静态检查
    const syntaxTargets = [
      ...actionFiles.map((f) => ({ name: `actions/${f}`, abs: path.join(actionsDir, f) })),
      { name: 'bridge-stub.js', abs: path.join(APP_DIR, 'renderer', 'bridge-stub.js') },
      { name: 'app.js', abs: path.join(APP_DIR, 'renderer', 'app.js') },
    ];
    const broken = [];
    for (const t of syntaxTargets) {
      try { new Function(read(t.abs)); } catch (err) { broken.push(`${t.name}: ${err && err.message}`); }
    }
    assert(broken.length === 0, '以下 renderer JS 语法损坏：\n        ' + broken.join('\n        '));
  });

  /* ---------------- R18：终端会话上限单源（R5-17） ---------------- */

  await check('R18 终端会话上限单源（terminal-tools ↔ renderer app.js 副本）', () => {
    const ttSrc = stripComments(read(path.join(APP_DIR, 'terminal-tools.ts')));
    const ttMatch = ttSrc.match(/TERMINAL_MAX_SESSIONS\s*=\s*(\d+)/);
    assert(ttMatch, 'terminal-tools.ts 未定义 TERMINAL_MAX_SESSIONS');
    const cap = Number(ttMatch[1]);
    assert(cap >= 1 && cap <= 32, `TERMINAL_MAX_SESSIONS=${cap} 超出合理范围`);

    const appSrc = stripComments(read(path.join(APP_DIR, 'renderer', 'app.js')));
    const appMatch = appSrc.match(/TERMINAL_MAX_SESSIONS\s*=\s*(\d+)/);
    assert(appMatch, 'renderer app.js 未定义 TERMINAL_MAX_SESSIONS 副本');
    assert(Number(appMatch[1]) === cap,
      `渲染层副本 TERMINAL_MAX_SESSIONS=${appMatch[1]} 与 terminal-tools.ts=${cap} 不一致`);

    // 禁用态判定必须引用常量，不再允许裸数字（主进程改上限时按钮要跟着变）。
    const stray = appSrc.match(/sessions\.length\s*>=\s*\d+/g);
    assert(!stray, `app.js 存在裸数字上限判定（应引用 TERMINAL_MAX_SESSIONS）：${stray && stray.join(', ')}`);
  });
  /* -------------------- 元规则：防规则静默失效 -------------------- */

  console.log('== 架构守护：元规则自检（防规则失效）==');

  for (const rule of RULES) {
    await check(`M1 ${rule.id} 规则有效性自检（必须命中自己的正样本）`, () => {
      const hits = scanRule(rule, rule.sample, '<sample>');
      assert(hits.length > 0, `${rule.id} 抓不到自己的正样本——正则已失效，必须修规则或换样本`);
    });
  }

  await check('M2 全部规则扫描面非空（glob/清单写错 → 规则空转）', () => {
    const empty = RULES.filter((r) => r.files().length === 0).map((r) => r.id);
    assert(empty.length === 0, '扫描面为空的规则：' + empty.join(', '));
  });

  await check('M3 纯逻辑白名单模块均存在（改名/删除后需同步本清单）', () => {
    const missing = PURE_MODULES.filter((f) => !fs.existsSync(path.join(APP_DIR, f)));
    assert(missing.length === 0, '白名单中不存在的模块：' + missing.join(', '));
  });

  await check('M3 PRELOAD_UNUSED_ALLOW 方法均存在于 preload（拼错 → 豁免失效）', () => {
    const preloadPath = path.join(APP_DIR, 'preload.ts');
    assert(fs.existsSync(preloadPath), '找不到 preload.ts');
    const methodSet = new Set(parsePreloadOrchdeskMethods(read(preloadPath)));
    const missing = PRELOAD_UNUSED_ALLOW.filter((n) => !methodSet.has(n));
    assert(missing.length === 0, 'PRELOAD_UNUSED_ALLOW 豁免失效（preload 中不存在）：' + missing.join(', '));
  });

  await check('M4 纯逻辑白名单确实零 electron（与 R2 交叉复核：清单本身没写多）', () => {
    const dirty = PURE_MODULES.filter((f) => /from\s+['"]electron['"]|require\(\s*['"]electron['"]\s*\)/.test(stripComments(read(path.join(APP_DIR, f)))));
    assert(dirty.length === 0, '白名单里含 electron 依赖（应从清单移除或改造为纯逻辑）：' + dirty.join(', '));
  });

  console.log(log.join('\n'));
  console.log(`结果: ${passed} 通过, ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
