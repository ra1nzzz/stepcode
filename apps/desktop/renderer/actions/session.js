/**
 * session 页动作（审查项③：ACTIONS 注册表按 VIEWS 三页模块化）。
 * app.js 启动时 install(ACTIONS, ctx)——ctx 注入 IIFE 私有面（state/bridge/toast/…），
 * 本文件不引用 app.js 作用域任何符号，全部经 ctx.* 访问。
 */
function installSessionActions(ACTIONS, ctx) {
  async function act_nav(el, id, e) {
 {
        ctx.state.page = id;
        // 进入设置页时重拉记忆域与沙箱日志：SubAgent 执行完会随时往 worker 域落结论，
        // 只靠启动时拉一次，用户看到的就是「空的」，会误判成功能没生效。
        if (id === 'settings') { ctx.refreshMemoryDomain(); ctx.refreshMemorySummarize(); ctx.refreshSandboxLog(); ctx.refreshUsage(); }
        if (id === 'plugins') { ctx.refreshConnectors(); ctx.refreshMarket(); }
        ctx.render();}
  
  }

  async function act_toggle_side(el, id, e) {
    const grid = ctx.$('#appGrid');
    if (grid) grid.classList.toggle('side-open');
  }

  async function act_toggle_theme(el, id, e) {
 { ctx.state.theme = ctx.state.theme === 'light' ? 'dark' : 'light'; document.documentElement.dataset.theme = ctx.state.theme;}
  
  }

  async function act_toggle_ctx(el, id, e) {
 ctx.state.ctxOpen = !ctx.state.ctxOpen;
 // P1.3：回合中手动调面板 = 用户接管，本回合不再自动开/关
 if (ctx.state.turnBusy) { ctx.state.ctxAutoToggled = true; ctx.state.ctxAutoOpened = false; }
 ctx.render();
  
  }

  async function act_ctx_tab(el, id, e) {
 ctx.state.ctxTab = el.dataset.id; ctx.render();
  
  }

  async function act_think_toggle(el, id, e) {
 {
        const k = el.dataset.k;
        if (!k) return;
        if (ctx.state.thinkExpanded.has(k)) ctx.state.thinkExpanded.delete(k); else ctx.state.thinkExpanded.add(k);
        ctx.render();}
  
  }

  async function act_ftab_toggle(el, id, e) {
 {
        const p = el.dataset.p;
        if (!p) return;
        const ft = ctx.state.fileTab;
        if (ft.expanded.has(p)) { ft.expanded.delete(p); ctx.render(); }
        else {
          ft.expanded.add(p);
          if (ft.children.has(p)) ctx.render();
          else ctx.fileTabLoadDir(p).then(() => ctx.render()).catch(() => ctx.render());
        }}
  
  }

  async function act_ftab_open(el, id, e) {
 {
        // 侧栏只做浏览（很窄），点文件交给全屏面板预览——复用既有预览/编辑/diff 链路
        const p = el.dataset.p;
        if (!p) return;
        ctx.openFilePanel();
        ctx.openFilePreview(p, p.split(/[\\/]/).pop());}
  
  }

  async function act_ftab_pick(el, id, e) {
 {
        const r = await ctx.bridge.pickFolder();
        if (r && r.ok && r.path) {
          const ft = ctx.state.fileTab;
          ft.root = r.path; ft.expanded = new Set(); ft.children = new Map(); ft.error = ''; ft.inited = true;
          await ctx.fileTabLoadDir(r.path);
        } else if (r && r.ok === false) {
          ctx.toast(`选择目录失败：${(r && r.reason) || '未接入'}`, 'err');
        }
        ctx.render();}
  
  }

  async function act_ftab_refresh(el, id, e) {
 {
        const ft = ctx.state.fileTab;
        if (!ft.root) return;
        ft.children = new Map();
        await ctx.fileTabLoadDir(ft.root);
        ctx.render();}
  
  }

  async function act_preview_product(el, id, e) {
 {
        const content = el.dataset.content;
        const name = el.dataset.name;
        const lang = el.dataset.lang;
        if (content) ctx.openProductPreview(name, content, lang);}
  
  }


  async function act_welcome_new_proj(el, id, e) {
 ctx.doNewConv();
  
  }

  async function act_welcome_task(el, id, e) {
 {
        const id = 's' + Date.now().toString(36);
        const s = { id, pid: '__task__', title: '任务', expert: ctx.expertList()[ctx.state.wzExpert] || ctx.expertList()[0], model: ctx.state.selectedModels[0] || '—', updated: '刚刚', ts: ctx.nowTime(), msgs: [] };
        ctx.state.sessions[id] = s; ctx.state.sel = id;
        ctx.persist(); ctx.render(); ctx.toast('已进入任务模式（无项目）', 'ok');
        return;
      }

      /* 会话 */
      // 切换会话即退出回放视图（回放只对被点开的那个会话有效）
      // BUG-023：打开会话时重放工作区（幂等）——覆盖「重启后主进程 Map 已空」的场景。
  
  }

  async function act_sel(el, id, e) {
 ctx.state.sel = id; ctx.state.replayFor = null; ctx.applySessionCwd(id); ctx.pushFloatingContext(); ctx.render();
  
  }

  async function act_newconv(el, id, e) {
 ctx.doNewConv();
  
  }

  async function act_home_send(el, id, e) {
 {
        const homeInp = ctx.$('#homeComposer');
        const text = homeInp?.value?.trim();
        if (!text) { ctx.toast('输入为空', 'warn'); return; }
        // P4-S1-05：发送前同步判一次不可逆操作。欢迎页的预警原本走 300ms 防抖 input
        // 监听，而本函数会把文本搬进 #composer 后立即 doSend——定时器只可能在发送之后
        // 才 fire，欢迎页的 #outboundWarn 等于死的。needsConfirm 时这里拦下并提示
        // 「再点一次发送」，第二次放行（一 shot 确认，不会卡死）。
        if (!(await ctx.confirmOutboundIfNeeded(text))) return;
        homeInp.value = '';
        if (!ctx.state.selProjForComposer || ctx.state.selProjForComposer === '__task__') {
          const id = 's' + Date.now().toString(36);
          const s = { id, pid: '__task__', cwd: ctx.state.workspaceDir || '', title: text.slice(0, 20), expert: ctx.expertList()[ctx.state.wzExpert] || ctx.expertList()[0], model: ctx.state.selectedModels[0] || '—', updated: '刚刚', ts: ctx.nowTime(), msgs: [] };
          ctx.state.sessions[id] = s;
          ctx.state.sel = id;
          ctx.state.selProjForComposer = '__task__';
          ctx.state.pExpanded.add('__task__');
          ctx.persist(); ctx.render();
          // P1.4 评审修复：隐式 cwd 必须在建会话时即生效——此前只在 act_sel 重放，
          // 第一个回合 Agent 跑在默认目录（承诺在最常见路径上未兑现）。
          ctx.applySessionCwd(id);
        } else {
          const pid = ctx.state.selProjForComposer;
          const sid = 's' + Date.now().toString(36);
          const p = ctx.state.projects.find(x => x.id === pid);
          const s = { id: sid, pid, title: text.slice(0, 20), expert: ctx.expertList()[ctx.state.wzExpert] || ctx.expertList()[0], model: ctx.state.selectedModels[0] || '—', updated: '刚刚', ts: ctx.nowTime(), msgs: [] };
          ctx.state.sessions[sid] = s;
          if (p && !p.sessions.includes(sid)) p.sessions.push(sid);
          ctx.state.pExpanded.add(pid);
          ctx.state.sel = sid;
          ctx.persist(); ctx.render();
          ctx.applySessionCwd(sid);
        }
        const c = ctx.$('#composer');
        if (c) {
          c.value = text;
          c.dispatchEvent(new Event('input', { bubbles: true }));
          ctx.doSend();
        } else {
          ctx.toast('发送失败：未找到输入框', 'warn');
        }}
  
  }


  async function act_home_create_proj(el, id, e) {
 {
        ctx.openModal(`<div class="mh">${ctx.ic('folder', 18)}<b>创建项目</b></div>
          <div class="mb">
            <div class="mb-row"><label>项目名称</label><input id="newProjName" class="inp" placeholder="如：React 重构" style="width:100%"></div>
            <div class="mb-row"><label>本地文件夹</label>
              <div style="display:flex;gap:8px;align-items:center">
                <input id="newProjPath" class="inp" placeholder="选择或输入本地文件夹路径" style="flex:1" readonly>
                <button class="btn sm" data-action="pick-folder">浏览</button>
              </div>
              <div class="faint" style="font-size:11px;margin-top:4px">绑定后可通过「打开项目目录」快速访问</div>
            </div>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="do-create-proj-home">创建</button></div>`);}
  
  }

  async function act_pick_folder(el, id, e) {
 {
        const pathInput = ctx.$('#newProjPath');
        try {
          const r = await ctx.bridge.pickFolder();
          if (r && r.ok && r.path && pathInput) pathInput.value = r.path;
        } catch {
          const selected = prompt('请输入本地文件夹路径：');
          if (selected && pathInput) pathInput.value = selected;
        }}
  
  }

  async function act_do_create_proj_home(el, id, e) {
 {
        const name = (ctx.$('#newProjName')?.value || '').trim();
        const path = (ctx.$('#newProjPath')?.value || '').trim();
        if (!name) { ctx.toast('请输入项目名称', 'warn'); return; }
        const id = 'p' + Date.now().toString(36);
        const p = { id, n: name, d: '', open: 1, archived: 0, sessions: [], path: path || '' };
        ctx.state.projects.push(p);
        ctx.state.selProjForComposer = id;
        ctx.persist();
        ctx.closeModal();
        // Create initial session
        ctx.createSessionInProject(id);
        ctx.toast(`项目「${name}」已创建`, 'ok');}
  
  }

  async function act_proj_toggle(el, id, e) {
 { if (ctx.state.pExpanded.has(id)) ctx.state.pExpanded.delete(id); else ctx.state.pExpanded.add(id); ctx.render();}
  
  }

  async function act_proj_menu(el, id, e) {
 e.stopPropagation(); ctx.openMenu(el, [
        { id: 'open', label: '打开项目目录', svg: ctx.ic('folder', 14) },
        { sep: 1, label: '归档项目', svg: ctx.ic('archive', 14), danger: 1, id: 'archive' }]);
        document.querySelector('.pop [data-id="open"]').onclick = async () => {
          ctx.$('#menuRoot').innerHTML = '';
          // BUG-022：必须把项目绑定的文件夹传给主进程。旧代码无参调用，主进程恒开数据目录，
          // 于是「打开项目目录」弹出的永远是 C 盘 OrchDesk 数据目录。
          const proj = ctx.state.projects.find((x) => x.id === id);
          const bound = proj && String(proj.path || '').trim();
          if (!bound) {
            ctx.toast('该项目未绑定本地文件夹（新建项目时选择本地文件夹后可用）', 'warn');
            return;
          }
          const r = await ctx.bridge.openProjectDir(bound);
          ctx.toast(
            r && r.ok
              ? `已打开项目目录：${(r && r.path) || bound}`
              : `打开失败：${(r && r.reason) || '未知错误'}`,
            r && r.ok ? 'ok' : 'danger',
          );
        };
        document.querySelector('.pop [data-id="archive"]').onclick = () => { ctx.$('#menuRoot').innerHTML = ''; ctx.confirmArchiveProject(id); };
  
  }

  async function act_sess_menu(el, id, e) {
 e.stopPropagation(); ctx.openMenu(el, [
        { id: 'copy', label: '复制会话 ID', svg: ctx.ic('copy', 14) },
        { id: 'rename', label: '重命名', svg: ctx.ic('edit', 14) },
        { sep: 1, id: 'fork', label: '创建分支', svg: ctx.ic('fork', 14) },
        { sep: 1, id: 'archive', label: '归档', svg: ctx.ic('archive', 14), danger: 1 },
        { sep: 1, id: 'delete', label: '删除', svg: ctx.ic('trash', 14), danger: 1 }]);
        const pop = document.querySelector('.pop');
        pop.querySelector('[data-id="copy"]').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(id).catch(() => {}); ctx.toast(`已复制 #${id}`, 'ok'); ctx.$('#menuRoot').innerHTML = ''; };
        pop.querySelector('[data-id="rename"]').onclick = () => { ctx.$('#menuRoot').innerHTML = ''; ctx.confirmRename(id); };
        pop.querySelector('[data-id="fork"]').onclick = () => { ctx.$('#menuRoot').innerHTML = ''; ctx.confirmNewBranch(id); };
        pop.querySelector('[data-id="archive"]').onclick = () => { ctx.$('#menuRoot').innerHTML = ''; ctx.doArchiveSession(id); };
        pop.querySelector('[data-id="delete"]').onclick = () => {
          ctx.$('#menuRoot').innerHTML = '';
          const s = ctx.state.sessions[id];
          // P1：删会话是一等公民数据的不可逆丢失，先确认再执行（归档才是可逆路径）
          ctx.confirmDestructive({
            title: `删除会话 #${ctx.esc(id)}？`,
            body: '删除后<b>不可恢复</b>：消息、执行记录与事件流索引都会从数据目录移除。',
            warnList: [
              `将丢失 <b>${s && s.msgs ? s.msgs.length : 0}</b> 条消息`,
              '分叉血缘与事件流索引一并移除',
              '如只是想暂时收起，请用「归档」——归档可随时还原',
            ],
            action: 'session-del-confirm', id, confirmLabel: '确认删除',
          });
        };
  
  }

  async function act_fork(el, id, e) {
 ctx.confirmNewBranch(el.dataset.sid || ctx.state.sel); return;
      /* 创建分支（FR-6）：分叉点来自滑块，缺省 = 全继承 */
  
  }

  async function act_branch_confirm(el, id, e) {
 {
        const inp = ctx.$('#modalRoot input[type=text]');
        const nm = inp ? inp.value : '';
        const at = ctx.$('#modalRoot #fork-at');
        const sid = el.dataset.sid || ctx.state.sel;
        ctx.closeModal();
        ctx.doFork(sid, nm, at ? at.value : undefined);}
  
  }

  async function act_replay_open(el, id, e) {
 { ctx.state.replayFor = el.dataset.sid || ctx.state.sel; ctx.state.sessionEvents = { sid: null, data: null, loaded: false }; ctx.render(); ctx.refreshSessionEvents(ctx.state.replayFor);}
  
  }

  async function act_replay_close(el, id, e) {
 { ctx.state.replayFor = null; ctx.render();}
  
  }

  async function act_rename_confirm(el, id, e) {
 { const inp = ctx.$('#modalRoot input[type=text]'); const sid = el.dataset.id; if (inp && sid) ctx.doRename(sid, inp.value); ctx.closeModal(); return; }

      /* composer */
  
  }

  async function act_send(el, id, e) {
 ctx.doSend();
  
  }

  async function act_abort_send(el, id, e) {
 ctx.doAbortSend();
  
  }

  async function act_expert_add(el, id, e) {
 ctx.openExpertPicker();
  
  }

  async function act_expert_attach(el, id, e) {
 // P3 触发③：引用专家/专家团 → 自动升级项目模式
 /* 引用专家不再切换壳层 */
 ctx.toast(`已 @引用「${el.dataset.n}」参与本次回复（SubAgent）`, 'ok'); ctx.closeModal();
  
  }

  async function act_sim_highrisk(el, id, e) {
 { const z = ctx.$('#confirmZone'); z.innerHTML = `<div class="confirm-banner"><span class="badge warn">意图 · 待确认</span> 该请求含「删除文件」高风险动作，本地模型判定需人工确认。
        <div class="row" style="margin-top:8px"><button class="btn sm primary" data-action="confirm-yes">确认执行</button><button class="btn sm" data-action="confirm-no">拒绝</button></div></div>`; ctx.state.pendingConfirm = true; ctx.state.pendingConfirmHtml = z ? z.innerHTML : ''; if (typeof ctx.revealInspector === 'function') ctx.revealInspector();}
  
  }

  async function act_approval_allow(el, id, e) {
 { const id = el.dataset.id; ctx.closeModal(); ctx.bridge.submitDecision(id, 'allowed-once'); ctx.toast('已允许本次操作（allowed-once）', 'ok'); return; }
      /* 授权白名单（PRD FR-9）：会话 / 永久粒度 —— 先建规则再放行，规则失败则拒绝 */
  
  }

  async function act_approval_deny(el, id, e) {
 { const id = el.dataset.id; ctx.closeModal(); ctx.bridge.submitDecision(id, 'rejected'); ctx.toast('已拒绝该操作', 'danger');}
  
  }

  async function act_confirm_yes(el, id, e) {
 { const z = ctx.$('#confirmZone'); ctx.state.pendingConfirm = false; ctx.state.pendingConfirmHtml = ''; if (z) z.innerHTML = ''; const yes = el?.dataset?.action === 'confirm-yes'; ctx.toast(yes ? '已确认 · 入审计日志' : '已拒绝 · 入审计日志', yes ? 'ok' : 'danger'); return; }

      /* 补偿层（T-P5-1） */
      /* 沙箱日志（PRD FR-8 可检索）：检索条件变更由 input/change 监听驱动，
         这里只处理「清空」这个破坏性动作。 */
      /* 数据目录清单（PRD FR-4.2）：导入/导出之后体积会变，手动重扫。 */
  
  }

  async function act_dir_inv_refresh(el, id, e) {
 {
        ctx.refreshDataDirInventory();
        ctx.toast('正在重新扫描数据目录…', 'ok');
        return;
      }

      /* 分层记忆晋升（PRD FR-10，第十四个死挂点）：
         插件的 promote() 一直存在但零调用方，这里补的是调用链。 */
  
  }

  async function act_sblog_clear(el, id, e) {
    if (!ctx.state.sandboxLog.total) return;
    // P1：沙箱日志是授权/执行的审计记录，清空不可恢复——先确认
    ctx.confirmDestructive({
      title: '清空沙箱日志？',
      body: '沙箱日志是授权与工具执行的<b>审计记录</b>，清空后不可恢复。',
      warnList: [
        `将清空 <b>${ctx.state.sandboxLog.total}</b> 条记录`,
        '仅影响本地审计，不影响沙箱策略与授权模式',
      ],
      action: 'sblog-clear-confirm', id: '', confirmLabel: '确认清空',
    });
  }

  async function act_sblog_clear_confirm(el, id, e) {
    ctx.closeModal();
        ctx.bridge.clearSandboxLog().then((r) => {
          if (!r || !r.ok) { ctx.toast('清空失败（主进程未接入）', 'warn'); return; }
          ctx.state.sandboxLog.entries = [];
          ctx.state.sandboxLog.total = 0;
          ctx.state.sandboxLog.stats = { total: 0, allowed: 0, denied: 0, error: 0, byTool: [] };
          ctx.render();
          ctx.toast(`已清空沙箱日志（${r.cleared} 条）`, 'ok');
        }).catch(() => ctx.toast('清空失败', 'err'));
  }

  async function act_model_pick(el, id, e) {
 ctx.openModelPicker();
  
  }

  async function act_model_toggle(el, id, e) {
 {
        const n = el.dataset.n; const idx = ctx.state.selectedModels.indexOf(n);
        if (idx >= 0) { ctx.state.selectedModels.splice(idx, 1); el.classList.remove('sel'); }
        else { ctx.state.selectedModels.push(n); el.classList.add('sel'); }
        const btn = document.querySelector('[data-action="model-confirm"]'); if (btn) btn.textContent = `确认（${ctx.state.selectedModels.length} 个）`;
        document.querySelectorAll('.mg-all').forEach((sp) => { const p = sp.dataset.p; const grp = ctx.getModelPool().filter((m) => m.p.split(' · ')[0] === p); const allSel = grp.every((m) => ctx.state.selectedModels.includes(m.n)); sp.textContent = allSel ? '取消全选' : '全选'; });}
  
  }

  async function act_mg_toggle_all(el, id, e) {
 {
        const p = el.dataset.p; const grp = ctx.getModelPool().filter((m) => m.p.split(' · ')[0] === p);
        const allSel = grp.every((m) => ctx.state.selectedModels.includes(m.n));
        if (allSel) grp.forEach((m) => { const i = ctx.state.selectedModels.indexOf(m.n); if (i >= 0) ctx.state.selectedModels.splice(i, 1); });
        else grp.forEach((m) => { if (!ctx.state.selectedModels.includes(m.n)) ctx.state.selectedModels.push(m.n); });
        ctx.openModelPicker();}
  
  }

  async function act_model_confirm(el, id, e) {
 {
        const selectedNames = [...ctx.state.selectedModels];
        // 持久化到 localStorage（跨会话复用）
        if (selectedNames.length === 0) {
          try { localStorage.removeItem(ctx.MODEL_SELECTION_KEY); } catch { /* ignore */ }
          ctx.autoSelectModels(ctx.state.modelProviders, ctx.state.defaultProvider, ctx.state.defaultModel);
          ctx.toast('未选择模型，已回退默认策略', 'warn');
        } else {
          ctx.saveModelSelection(selectedNames);
        }
        // 持久化到当前选中会话
        const curS = ctx.state.sessions[ctx.state.sel];
        if (curS && selectedNames.length) curS.model = selectedNames[0];
        if (curS) curS.models = selectedNames;
        ctx.closeModal(); ctx.render();}
  
  }

  async function act_model_clear(el, id, e) {
 ctx.state.selectedModels = []; ctx.openModelPicker(); return;

      /* 插件 */
  
  }

  async function act_conn_cfg(el, id, e) {
        ctx.state.connectors.expanded = ctx.state.connectors.expanded === id ? null : id;
        if (ctx.state.page === 'plugins') ctx.render();
  
  }

  async function act_conn_test(el, id, e) {
 {
        el.textContent = '测试中…'; el.disabled = true;
        ctx.bridge.connectorTest(id).then((r) => {
          if (!r || r.ok === false && r.reason) { ctx.toast(String(r && r.reason || '探测失败'), 'err'); }
          else ctx.toast(r.message || (r.ok ? '连通性正常' : '探测失败'), r.ok ? 'ok' : 'warn');
          ctx.refreshConnectors();
        }).catch((err) => { ctx.toast(`探测失败：${err && err.message || err}`, 'err'); ctx.refreshConnectors(); });}
  
  }

  async function act_conn_discover(el, id, e) {
 {
        // 自动发现：从本机 CLI/git 登录态找该连接器是否已可用。只找不写盘——
        // 找到的 secret 回填进表单，用户仍要点「保存并测试」才真正写入（尊重授权）。
        if (typeof ctx.bridge.connectorDiscover !== 'function') { ctx.toast('主进程未接入，无法自动发现', 'warn'); return; }
        el.textContent = '发现中…'; el.disabled = true;
        try {
          const r = await ctx.bridge.connectorDiscover(id);
          // 先刷新连接器（会 render 重建表单），再在重建后的输入框里回填 token ——
          // 顺序反了的话，后面那次 render 会把刚塞进去的值冲掉成存储里的脱敏值。
          await ctx.refreshConnectors();
          if (r && r.found && r.cred) {
            if (r.cred.usable && r.cred.secret) {
              ctx.state.connectors.expanded = id;
              ctx.render();
              const inp = document.querySelector(`#connf-${id}-token`);
              if (inp) { inp.value = r.cred.secret; inp.focus(); }
              ctx.toast(`发现可用登录态（${r.cred.source}）${r.cred.identity ? ' · 账户 ' + r.cred.identity : ''} — 点「保存并测试」确认`, 'ok');
            } else {
              ctx.toast(`检测到已登录（${r.cred.identity || ''}），但 token 混淆不可读：${r.cred.note || ''}`, 'warn');
            }
          } else {
            ctx.toast(`未发现本机登录态：${(r && r.reason) || '无'}`, 'warn');
          }
        } catch (err) {
          ctx.toast(`自动发现失败：${err && err.message || err}`, 'err');
        }}
  
  }

  async function act_conn_save(el, id, e) {
 {
        const inputs = document.querySelectorAll(`[id^="connf-${id}-"]`);
        const creds = {};
        inputs.forEach((inp) => { creds[inp.id.replace(`connf-${id}-`, '')] = inp.value; });
        el.textContent = '保存中…'; el.disabled = true;
        ctx.bridge.connectorSave(id, creds).then((r) => {
          if (!r || r.ok === false) { ctx.toast(String(r && r.reason || '保存失败'), 'err'); }
          else if (r.configured === false) ctx.toast('凭证已保存（必填字段不完整）', 'warn');
          else if (r.probe) ctx.toast(r.probe.manual ? String(r.probe.message || '已保存') : (r.probe.ok ? `已保存 · ${r.probe.message}` : `已保存 · ${r.probe.message}`), r.probe.manual || r.probe.ok ? 'ok' : 'warn');
          else ctx.toast('凭证已保存', 'ok');
          ctx.refreshConnectors();
        }).catch((err) => { ctx.toast(`保存失败：${err && err.message || err}`, 'err'); ctx.refreshConnectors(); });}
  
  }

  async function act_conn_clear(el, id, e) {
    // P4-S2-10：清除凭证先确认。同页的「清空审计」「卸载技能」「删除 MCP」都走了
    // confirmDestructive，唯独清除凭证一键直达——清 GitHub 等连接器凭证意味着重新走
    // 设备流/重新输密钥，确认模式应用不一致。
    const cid = id;
    const cname = (ctx.state.connectors.items || []).find((x) => x.id === cid);
    ctx.confirmDestructive({
      title: `清除「${cname ? cname.name : cid}」凭证？`,
      body: '清除后该连接器恢复未配置状态，需要重新走设备流或重新输入密钥才能使用。',
      warnList: ['本地保存的加密凭证一并移除', '已配置的字段值随之失效'],
      action: 'conn-clear-confirmed', id: cid, confirmLabel: '确认清除',
    });
  }

  async function act_conn_clear_confirmed(el, id, e) {
    ctx.closeModal();
    {
        ctx.bridge.connectorClear(id).then((r) => {
          ctx.toast(r && r.ok ? '凭证已清除' : String(r && r.reason || '清除失败'), r && r.ok ? 'ok' : 'err');
          ctx.refreshConnectors();
        }).catch((err) => ctx.toast(`清除失败：${err && err.message || err}`, 'err'));}
  
  }

  async function act_conn_audit_clear(el, id, e) {
    // P1：连接器审计同为不可恢复的审计记录，清空前确认
    ctx.confirmDestructive({
      title: '清空连接器审计日志？',
      body: '连接器审计记录连接器的调用与授权历史，清空后不可恢复。',
      warnList: ['仅影响本地审计，不影响连接器配置'],
      action: 'conn-audit-clear-confirm', id: '', confirmLabel: '确认清空',
    });
  }

  async function act_conn_audit_clear_confirm(el, id, e) {
    ctx.closeModal();
        ctx.bridge.clearConnectorAudit().then((r) => {
          ctx.toast(r && r.ok ? `已清空 ${r.cleared} 条审计` : '清空失败', r && r.ok ? 'ok' : 'err');
          ctx.refreshConnectorAudit();
        }).catch(() => {});
  }

  async function act_open_external(el, id, e) {
        if (typeof ctx.bridge.openExternal === 'function') {
          ctx.bridge.openExternal(el.dataset.url || '').then((r) => {
            if (!r || !r.ok) ctx.toast(String(r && r.reason || '无法打开链接'), 'err');
          }).catch(() => {});
        } else ctx.toast('外部链接打开未接入', 'warn');
        return;

      /* 本地插件市场（PRD FR-3） */
  
  }

  async function act_conn_nav(el, id, e) {
 {
        // 侧栏点连接器 = 滚到连接器分区 + 展开该连接器配置（原来只展开、不滚动）
        const node = document.getElementById('psec-connectors');
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
        ctx.state.connectors.expanded = id;
        ctx.render();
        // render() 会重建 DOM，滚定位要在重建之后
        requestAnimationFrame(() => {
          const n2 = document.getElementById('psec-connectors');
          if (n2) n2.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
        return;
      }

      /* T-P6-1 观雅集技能市场 */
  
  }

  async function act_model_test(el, id, e) {
 {
        // 此前用 800ms setTimeout 伪造「连通正常」，而真正的 bridge.testModel 从未被调用 —— 假成功。
        // 改为真实连通性测试：主进程发一次真实请求并计时。
        const pid = el.dataset.id || '';
        const model = el.dataset.n || '';
        el.disabled = true; el.textContent = '测试中…';
        try {
          const r = await ctx.bridge.testModel(pid, model);
          if (r && r.ok) ctx.toast(`${model} 连通正常（${r.latencyMs != null ? r.latencyMs + 'ms' : '已响应'}）`, 'ok');
          else ctx.toast(`${model} 连通失败：${(r && r.error) || '未知错误'}`, 'danger');
        } catch (err) {
          ctx.toast(`测试异常：${(err && err.message) || err}`, 'danger');
        } finally {
          el.disabled = false; el.textContent = '测试';
        }}
  
  }

  async function act_model_edit_provider(el, id, e) {
 {
        const p = (ctx.state.modelProviders || []).find(x => x.id === el.dataset.id);
        if (!p) return;
        ctx.state.mpEditing = { id: p.id };
        ctx.render();
        ctx.$('#mp-type').value = p.type || 'ollama';
        ctx.$('#mp-name').value = p.name;
        ctx.$('#mp-url').value = p.baseUrl;
        ctx.$('#mp-fullurl').checked = true;
        ctx.$('#mp-mode').value = p.apiMode || 'chat';
        ctx.$('#mp-key').value = '';
        ctx.$('#mp-models').value = (p.models || []).join(', ');
        // 预设回填（有 presetId 才认，避免把自定义网关猜成目录提供商）
        ctx.state.mpPreset = p.presetId ? { id: p.presetId, name: p.name, api: p.baseUrl } : null;
        // 已保存模型子集回填为勾选面板（改 URL/KEY 可重新拉取覆盖）
        ctx.state.mpModels = (p.models || []).map((m) => ({ id: m }));
        ctx.state.mpModelsChecked = new Set(p.models || []);
        ctx.state.mpModelsSource = '';
        ctx.state.mpModelsNote = (p.models || []).length ? '已加载已保存的模型；修改 Base URL 或 KEY 可重新拉取' : '';
        ctx.state.mpModelsExpanded = false;
        ctx.updateProtocolRow();
        ctx.mpRefreshPreset();
        ctx.mpRefreshPool();
        ctx.$('#mp-name').focus();}
  
  }

  async function act_model_del_provider(el, id, e) {
    // P1：删除前确认（列明将失去的模型数），执行逻辑原样下沉到 -confirm
    const pid = el.dataset.id;
    const p = (ctx.state.modelProviders || []).find((x) => x.id === pid);
    ctx.confirmDestructive({
      title: `删除模型提供商「${ctx.esc(p ? p.name : pid)}」？`,
      body: '删除后该提供商下的模型将从所有会话的可用列表消失，默认选择需要重设。',
      warnList: [
        `<b>${p && p.models ? p.models.length : 0}</b> 个模型将不可用`,
        '保存的是本地模型配置，删除后需重新添加',
      ],
      action: 'model-del-provider-confirm', id: pid, confirmLabel: '确认删除',
    });
  }

  async function act_model_del_provider_confirm(el, id, e) {
    ctx.closeModal();
 {
        const prevProviders = ctx.state.modelProviders || [];
        const nextProviders = prevProviders.filter(x => x.id !== el.dataset.id);
        ctx.state.modelProviders = nextProviders;
        const r = await ctx.bridge.saveModelConfig({ providers: nextProviders, defaultProvider: ctx.state.defaultProvider });
        if (r && r.ok) {
          try { const mc = await ctx.bridge.getModelConfig(); if (mc && mc.providers) ctx.dynamicModels.list = mc.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' · ' + p.type, k: '(本地)', state: '已配' }))); } catch { ctx.dynamicModels.list = []; }
          ctx.toast('提供商已删除', 'warn'); ctx.renderModelProviders();
        } else {
          ctx.state.modelProviders = prevProviders;   // 主进程拒了就退回去，不留半应用态
          ctx.toast(`删除失败：${(r && r.reason) || '主进程未应答'}`, 'danger');
          ctx.render();
        }}
  
  }

  async function act_model_cancel_edit(el, id, e) {
 { ctx.state.mpEditing = null;
        ctx.state.mpPreset = null; ctx.state.mpModels = []; ctx.state.mpModelsChecked = new Set();
        ctx.state.mpModelsNote = ''; ctx.state.mpModelsSource = ''; ctx.state.mpModelsExpanded = false;
        ctx.render();}
  
  }

  /* ---------- models.dev 预设 + 可用模型拉取（方案 A） ---------- */
  async function act_mp_preset_toggle(el, id, e) {
    ctx.state.mpPresetOpen = !ctx.state.mpPresetOpen;
    ctx.mpRefreshPreset();
    if (ctx.state.mpPresetOpen) ctx.mpEnsureCatalog(); // 首次展开才拉目录
  }
  async function act_mp_preset_pick(el, id, e) {
    ctx.mpApplyPreset(el.dataset.id);
  }
  async function act_mp_preset_clear(el, id, e) {
    ctx.state.mpPreset = null;
    ctx.state.mpPresetOpen = false;
    ctx.mpRefreshPreset();
  }
  async function act_mp_catalog_retry(el, id, e) {
    // 目录获取失败后的重试：先置 null 绕开 mpEnsureCatalog 的 early return
    ctx.state.mpCatalog = null;
    await ctx.mpEnsureCatalog();
  }
  async function act_mp_models_all(el, id, e) {
    ctx.state.mpModelsChecked = new Set(ctx.state.mpModels.map((m) => m.id));
    ctx.mpRefreshPool();
  }
  async function act_mp_models_none(el, id, e) {
    ctx.state.mpModelsChecked = new Set();
    ctx.mpRefreshPool();
  }
  async function act_mp_models_more(el, id, e) {
    ctx.state.mpModelsExpanded = true;
    ctx.mpRefreshPool();
  }
  async function act_mp_models_refetch(el, id, e) {
    ctx.mpFetchModels(true);
  }
  async function act_ollama_adopt(el, id, e) {
    // P2：composer chip「发现 Ollama · 一键接入」——写真提供商配置（非演示模式）
    await ctx.adoptOllama();
  }

  async function act_model_add_provider(el, id, e) {
    // P4-S3-02：保存期间禁用按钮，防连点重复提交（await saveModelConfig 有真实网络往返）
    if (el && el.disabled) return;
    if (el) el.disabled = true;
    try {
      await addOrUpdateProvider();
    } finally {
      if (el) el.disabled = false;
    }

    async function addOrUpdateProvider() {
        const type = ctx.$('#mp-type')?.value || 'ollama';
        const name = ctx.$('#mp-name')?.value?.trim();
        let url = ctx.$('#mp-url')?.value?.trim();
        const key = ctx.$('#mp-key')?.value?.trim();
        const modelsStr = ctx.$('#mp-models')?.value?.trim();
        const apiMode = type === 'openai-compatible' ? (ctx.$('#mp-mode')?.value || 'chat') : 'ollama';
        if (!name || !url) { ctx.toast('请填写名称和 Base URL', 'warn'); return; }
        // P4-S3-03：缺协议一律补 http://（与 mpCurrentInput 同规则，去掉 full 门禁）
        if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
        // P4-S3-01：模型来源优先级重写。原实现「勾选 > 手动输入 > 占位 'default'」有三个坑：
        //   ① 手动框被 hidden 隐藏但值不清，旧值仍参与计算；
        //   ② 面板拉取成功后用户取消全部勾选 → 静默保存假模型 'default'；
        //   ③ 编辑时取消全部勾选 → 旧模型全部保留（用户操作被静默吞掉）。
        // 新规则：面板出现过（mpModels.length>0）就只认勾选，为空则阻止保存；面板没出现过
        // 才认手动输入；两者皆空也阻止——不再有 'default' 这种根本不存在的假模型。
        const checked = ctx.state.mpModelsChecked;
        let models;
        if (ctx.state.mpModels.length) {
          models = ctx.state.mpModels.filter((m) => checked.has(m.id)).map((m) => m.id);
          if (!models.length) { ctx.toast('请至少勾选一个模型；都不想用可在高级区手动填写模型名称', 'warn'); return; }
        } else if (modelsStr) {
          models = modelsStr.split(',').map(s => s.trim()).filter(Boolean);
          if (!models.length) { ctx.toast('请至少填写一个模型名称', 'warn'); return; }
        } else {
          ctx.toast('请先拉取可用模型并勾选，或在高级区手动填写模型名称', 'warn'); return;
        }
        const presetId = ctx.state.mpPreset?.id;
        const isEdit = !!ctx.state.mpEditing;
        const providers = [...(ctx.state.modelProviders || [])];
        if (isEdit) {
          const idx = providers.findIndex(p => p.id === ctx.state.mpEditing.id);
          const provider = { id: ctx.state.mpEditing.id, name, type, apiMode, baseUrl: url, models, apiKey: key, presetId };
          if (idx >= 0) providers[idx] = provider;
          else providers.push(provider);
          ctx.state.mpEditing = null;
        } else {
          // id 只当机器标识，不能拿显示名直接铸：`replace(/[^a-z0-9]/g,'-')` 把纯中文名
          // 折叠成 '--'，两个中文名必撞；主进程虽拒绝新引入的重复，但提示用户「改一个可区分
          // 的名字」对中文名是死路（改名后折叠结果照样是 '--'）。保底：折叠为空用 provider，
          // 再撞就加序号，让渲染层这一路不可能产重复。
          const base = (name.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '') || 'provider');
          let id = base;
          for (let n = 2; providers.some((p) => p.id === id); n += 1) id = `${base}-${n}`;
          providers.push({ id, name, type, apiMode, baseUrl: url, models, apiKey: key, presetId });
        }
        const r2 = await ctx.bridge.saveModelConfig({ providers, defaultProvider: type === 'ollama' ? providers[providers.length - 1]?.id : (ctx.state.defaultProvider || providers[0]?.id) });
        if (r2 && r2.ok) {
          ctx.state.modelProviders = providers;
          const inModal = !!ctx.$('#mp-key')?.closest('#modalRoot');
          try { const mc2 = await ctx.bridge.getModelConfig(); if (mc2 && mc2.providers) ctx.dynamicModels.list = mc2.providers.flatMap(p => p.models.map(n => ({ n, p: p.name + ' · ' + p.type, k: key ? 'sk-••••••••' : '(本地)', state: '已配' }))); } catch { ctx.dynamicModels.list = []; }
          ctx.toast(isEdit ? `提供商「${name}」已更新（${models.length} 个模型）` : `提供商「${name}」已添加`, 'ok');
          // P4-S1-01：两条路径都必须刷新 chip 的事实源（selectedModels）并退出演示模式。
          // 原实现只在模态分支做，设置页添加成功后回到会话页，composer chip 仍显示
          // 「未配置模型 / 演示模式」——刚刚配置成功的事实与 UI 状态相反（铁律：不许撒谎）。
          ctx.state.demoMode = false;
          ctx.autoSelectModels(providers, ctx.state.defaultProvider, ctx.state.defaultModel);
          if (inModal) {
            ctx.state.mpPreset = null; ctx.state.mpModels = []; ctx.state.mpModelsChecked = new Set();
            ctx.state.mpModelsNote = ''; ctx.state.mpModelsSource = ''; ctx.state.mpModelsExpanded = false;
            ctx.closeModal();
            ctx.render();
            return;
          }
          // P4-S3-02：设置页保存成功后必须整页 render。原实现只调 renderModelProviders()
          // 刷新列表、不重渲染表单——标题仍写「编辑提供商」、按钮仍写「保存」，而 mpEditing
          // 已置 null；用户再点一次「保存」会走添加分支 push 一个同名 id 的提供商，列表出现
          // 两行完全相同的项（删一行会同时删掉两行）。
          ctx.state.mpPreset = null; ctx.state.mpModels = []; ctx.state.mpModelsChecked = new Set();
          ctx.state.mpModelsNote = ''; ctx.state.mpModelsSource = ''; ctx.state.mpModelsExpanded = false;
          ctx.render();
        } else { ctx.toast(`保存失败：${(r2 && r2.reason) || ''}`, 'danger'); }
    }
  }

  async function act_todo(el, id, e) {
        console.warn('[orchdesk] 未接线的动作被点击：', el.dataset.action, el.outerHTML.slice(0, 120));
        ctx.toast('该动作尚未接线（已记录到控制台）', 'warn');
  
  }

  async function act_check_updates(el, id, e) {
 {
        ctx.toast('正在先快照数据目录，然后检查更新…', 'ok');
        const r = await ctx.bridge.checkUpdates();
        const snap = (r && r.snapshot && r.snapshot.ok) ? `数据快照：${r.snapshot.dir}` : '数据快照失败';
        const upd = (r && r.update) ? (r.update.available ? `发现新版本 ${r.update.version}` : (r.update.note || '已是最新')) : (r && r.reason || '更新检查暂不可用');
        ctx.toast(`${snap}\n${upd}`, (r && r.update && r.update.available) ? 'ok' : 'warn');
        return;
      }

      /* 系统提示词（T-P4-3） */
  
  }

  async function act_modal_bg(el, id, e) {
 if (e.target === el) { ctx.state.askInputCb = null; ctx.state.browserPanelOpen = false; ctx.closeModal(); }
  
  }

  async function act_modal_cancel(el, id, e) {
 ctx.state.askInputCb = null; ctx.state.browserPanelOpen = false; ctx.closeModal(); return;

      /* 浏览器面板（ADR-0011）+ 侧栏（需求3） */
  
  }

  async function act_browser_panel(el, id, e) {
 {
        // 右下角图标：浏览器已打开 → 切换侧栏；未打开 → 打开详情弹窗（里面说明了触发方式）
        if (ctx.state.browser.open) {
          ctx.state.browserSideOpen = !ctx.state.browserSideOpen;
          ctx.renderBrowserSide();
          ctx.renderStatusBarActions();
        } else {
          ctx.openBrowserPanel();
        }}
  
  }

  async function act_bw_side_close(el, id, e) {
 {
        ctx.state.browserSideOpen = false;
        ctx.renderBrowserSide();
        ctx.renderStatusBarActions();}
  
  }

  async function act_bw_tab_close(el, id, e) {
 {
        const id = el.dataset.id;
        if (!id) return;
        const r = await ctx.bridge.closeBrowserPage(id);
        if (r && r.state) ctx.applyBrowserState(r.state);}
  
  }

  async function act_bw_tab_clear(el, id, e) {
 {
        const r = await ctx.bridge.clearBrowserPages();
        if (r && r.state) ctx.applyBrowserState(r.state);
        ctx.toast('已关闭全部页面', 'ok');}
  
  }

  async function act_bw_tab_focus(el, id, e) {
 {
        // 单窗口模型：切到历史页面 = 把窗口导航过去（用户亲手操作，不过授权门）
        const id = el.dataset.id;
        const p = (ctx.state.browser.pages || []).find((x) => x.id === id);
        if (!p) return;
        const r = await ctx.bridge.browserGoto(p.url);
        if (r && r.state) ctx.applyBrowserState(r.state);
        if (r && r.ok === false) ctx.toast(`切换失败：${r.reason || ''}`, 'err');}
  
  }

  async function act_browser_show(el, id, e) {
 ctx.browserAct(() => ctx.bridge.setBrowserVisible(true));
  
  }

  async function act_browser_hide(el, id, e) {
 ctx.browserAct(() => ctx.bridge.setBrowserVisible(false));
  
  }

  async function act_browser_close(el, id, e) {
 ctx.browserAct(() => ctx.bridge.closeBrowser(), '浏览器已关闭'); return;

      /* 终端面板（P2-10）+ 底部抽屉（需求3） */
  
  }

  async function act_terminal_panel(el, id, e) {
 {
        // 右下角图标：展开 / 收起抽屉
        if (ctx.state.terminalPanelOpen) ctx.closeTerminalPanel(); else ctx.openTerminalPanel();}
  
  }

  async function act_term_full(el, id, e) {
 ctx.toggleTermFull();
  
  }

  async function act_term_close(el, id, e) {
 ctx.closeTerminalPanel();
  
  }

  async function act_term_new(el, id, e) {
 ctx.newTerminalSession();
  
  }

  async function act_term_tab(el, id, e) {
 {
        if (ctx.state.terminal.activeId !== id) {
          ctx.state.terminal.activeId = id;
          ctx.renderTerminalPanel();
        }}
  
  }

  async function act_term_tab_close(el, id, e) {
 {
        ctx.bridge.terminalKill(id).then(() => ctx.refreshTerminal());
        return;
      }

      /* 文件面板（P2-11） */
  
  }

  async function act_file_panel(el, id, e) {
 ctx.openFilePanel();
  
  }

  async function act_file_close(el, id, e) {
 ctx.closeFilePanel();
  
  }

  async function act_file_pick(el, id, e) {
 ctx.pickFileRoot();
  
  }

  async function act_file_refresh(el, id, e) {
 {
        ctx.state.filePanel.children.delete(ctx.state.filePanel.root);
        ctx.state.filePanel.expanded = new Set([ctx.state.filePanel.root]);
        ctx.loadFileDir(ctx.state.filePanel.root);}
  
  }

  async function act_file_toggle(el, id, e) {
 {
        const path = el.dataset.path;
        if (ctx.state.filePanel.expanded.has(path)) {
          ctx.state.filePanel.expanded.delete(path);
          ctx.renderFilePanel();
        } else {
          ctx.state.filePanel.expanded.add(path);
          if (ctx.state.filePanel.children.has(path)) ctx.renderFilePanel();
          else ctx.loadFileDir(path);
        }}
  
  }

  async function act_file_open(el, id, e) {
 ctx.openFilePreview(el.dataset.path, el.dataset.name);
  
  }

  async function act_file_edit(el, id, e) {
 ctx.startFileEdit();
  
  }

  async function act_file_edit_diff(el, id, e) {
 ctx.toggleFileDiff();
  
  }

  async function act_file_edit_save(el, id, e) {
 ctx.saveFileEdit();
  
  }

  async function act_file_edit_cancel(el, id, e) {
 ctx.cancelFileEdit();
  
  }

  async function act_file_edit_reload(el, id, e) {
 ctx.reloadFilePreview();
  
  }

  async function act_browser_shot_dir(el, id, e) {
 {
        ctx.bridge.openBrowserShotDir().then((r) => {
          if (!r || r.ok === false) ctx.toast(`打开截图目录失败：${(r && r.reason) || '未接入'}`, 'err');
          else ctx.toast('已打开截图目录', 'ok');
        }).catch((err) => ctx.toast(`打开截图目录失败：${(err && err.message) || err}`, 'err'));}
  
  }

  async function act_ask_input_ok(el, id, e) {
 {
        const cb = ctx.state.askInputCb;
        ctx.state.askInputCb = null;
        const v = (ctx.$('#askInput') && ctx.$('#askInput').value) || '';
        ctx.closeModal();
        if (typeof cb === 'function') cb(v);}
  
  }

  async function act_archive_confirm(el, id, e) {
 ctx.doArchiveProject(id); ctx.closeModal(); return;

      /* 向导 */
  
  }

  async function act_grant_add(el, id, e) {
 {
        const tool = (ctx.$('#grant-tool') && ctx.$('#grant-tool').value) || '*';
        const pattern = ((ctx.$('#grant-pattern') && ctx.$('#grant-pattern').value) || '').trim();
        const scope = (ctx.$('#grant-scope') && ctx.$('#grant-scope').value) === 'session' ? 'session' : 'permanent';
        if (!pattern) { ctx.toast('请填写目标模式（不限目标填 *）', 'warn'); return; }
        ctx.bridge.addGrant({
          tool, pattern, scope,
          ...(scope === 'session' ? { sessionId: ctx.state.sel || '' } : {}),
          note: '设置页手动添加',
        }).then((r) => {
          if (!r || !r.ok) { ctx.toast((r && r.reason) || '添加失败', 'err'); return; }
          ctx.state.grants = Array.isArray(r.grants) ? r.grants : ctx.state.grants;
          const p = ctx.$('#grant-pattern'); if (p) p.value = '';
          ctx.render(); ctx.toast('已加入白名单', 'ok');
        }).catch((e) => ctx.toast('添加失败: ' + ((e && e.message) || e), 'err'));}
  
  }

  async function act_grant_revoke(el, id, e) {
 {
        ctx.bridge.revokeGrant(el.dataset.id).then((r) => {
          if (!r || !r.ok) { ctx.toast('撤销失败', 'err'); return; }
          ctx.state.grants = Array.isArray(r.grants) ? r.grants : ctx.state.grants;
          ctx.render(); ctx.toast('已撤销该白名单规则', 'ok');
        }).catch((e) => ctx.toast('撤销失败: ' + ((e && e.message) || e), 'err'));}
  
  }

  async function act_grant_revoke_all(el, id, e) {
 {
        ctx.bridge.revokeAllGrants().then((r) => {
          if (!r || !r.ok) { ctx.toast('撤销失败', 'err'); return; }
          ctx.state.grants = Array.isArray(r.grants) ? r.grants : [];
          ctx.render(); ctx.toast(`已撤销全部 ${r.revoked || 0} 条白名单`, 'ok');
        }).catch((e) => ctx.toast('撤销失败: ' + ((e && e.message) || e), 'err'));
        return;
      }
      /* 桌面集成开关（PRD FR-4.2）：此前 6 项全是 data-action="todo" 空壳 */
  
  }

  async function act_team_compose(el, id, e) {
 {
        const tid = el.dataset.tid;
        const tn = el.dataset.tn || '专家团';
        // BUG（全盘死挂点扫描）：原代码 askInput({...}).then(...)——askInput 不返回
        // Promise（onOk 回调式），对 undefined 调 .then 必抛 TypeError，专家团「派发
        // 任务」按钮一点就崩，composeTeam 从不被调用（UI 显示成功实为永不可达）。
        ctx.askInput({
          title: `派发任务 · ${tn}`,
          label: 'CEO（主会话）将拆解任务并派给 Director→Worker，经真实模型执行，耗时可能较长。',
          placeholder: '描述要派发的任务…',
          onOk: (task) => {
            task = String(task || '').trim();
            if (!task) return;
            ctx.toast('编排中：CEO 拆解 → Director → Worker…', 'info');
            ctx.bridge.composeTeam(tid, task).then((r) => {
              if (r && r.error) { ctx.toast(r.error, 'err'); return; }
              ctx.state.delegationLast = r;
              // P3 触发③：专家团派发成功 → 自动升级项目模式（委派树/派发入口常驻）

              ctx.render();
              ctx.toast(`编排完成 · ${r.rootId || ''}`, 'ok');
            }).catch((e) => ctx.toast('编排失败: ' + ((e && e.message) || e), 'err'));
          },
        });}
  
  }

  Object.assign(ACTIONS, {
    'nav': act_nav,
    'toggle-side': act_toggle_side,

    'toggle-theme': act_toggle_theme,
    'toggle-ctx': act_toggle_ctx,
    'ctx-tab': act_ctx_tab,
    'think-toggle': act_think_toggle,
    'ftab-toggle': act_ftab_toggle,
    'ftab-open': act_ftab_open,
    'ftab-pick': act_ftab_pick,
    'ftab-refresh': act_ftab_refresh,
    'preview-product': act_preview_product,
    'welcome-new-proj': act_welcome_new_proj,
    'welcome-task': act_welcome_task,
    'sel': act_sel,
    'newconv': act_newconv,
    'home-send': act_home_send,
    'home-create-proj': act_home_create_proj,
    'pick-folder': act_pick_folder,
    'ws-pick': () => ctx.pickWorkspace(),
    'do-create-proj-home': act_do_create_proj_home,
    'proj-toggle': act_proj_toggle,
    'proj-menu': act_proj_menu,
    'sess-menu': act_sess_menu,
    'fork': act_fork,
    'branch-confirm': act_branch_confirm,
    'replay-open': act_replay_open,
    'replay-close': act_replay_close,
    'rename-confirm': act_rename_confirm,
    'send': act_send,
    'abort-send': act_abort_send,
    'expert-add': act_expert_add,
    'expert-attach': act_expert_attach,
    'sim-highrisk': act_sim_highrisk,
    'approval-allow': act_approval_allow,
    'approval-deny': act_approval_deny,
    'confirm-yes': act_confirm_yes,
    'confirm-no': act_confirm_yes,
    'dir-inv-refresh': act_dir_inv_refresh,
    'sblog-clear': act_sblog_clear,
    'model-pick': act_model_pick,
    'model-toggle': act_model_toggle,
    'mg-toggle-all': act_mg_toggle_all,
    'model-confirm': act_model_confirm,
    'model-clear': act_model_clear,
    'conn-cfg': act_conn_cfg,
    'conn-test': act_conn_test,
    'conn-discover': act_conn_discover,
    'conn-save': act_conn_save,
    'conn-clear': act_conn_clear,
    'conn-clear-confirmed': act_conn_clear_confirmed,
    'conn-audit-clear': act_conn_audit_clear,
    'open-external': act_open_external,
    'conn-nav': act_conn_nav,
    'model-test': act_model_test,
    'model-edit-provider': act_model_edit_provider,
    'model-del-provider': act_model_del_provider,
    'model-del-provider-confirm': act_model_del_provider_confirm,
    'sblog-clear-confirm': act_sblog_clear_confirm,
    'conn-audit-clear-confirm': act_conn_audit_clear_confirm,
    'session-del-confirm': async (el, id) => { ctx.closeModal(); await ctx.doDeleteSession(el.dataset.id); },
    'model-cancel-edit': act_model_cancel_edit,
    'model-add-provider': act_model_add_provider,
    'mp-preset-toggle': act_mp_preset_toggle,
    'mp-preset-pick': act_mp_preset_pick,
    'mp-preset-clear': act_mp_preset_clear,
    'mp-catalog-retry': act_mp_catalog_retry,
    'mp-models-all': act_mp_models_all,
    'mp-models-none': act_mp_models_none,
    'mp-models-more': act_mp_models_more,
    'mp-models-refetch': act_mp_models_refetch,
    'ollama-adopt': act_ollama_adopt,

    'todo': act_todo,
    'check-updates': act_check_updates,
    'modal-bg': act_modal_bg,
    'modal-cancel': act_modal_cancel,
    'browser-panel': act_browser_panel,
    'bw-side-close': act_bw_side_close,
    'bw-tab-close': act_bw_tab_close,
    'bw-tab-clear': act_bw_tab_clear,
    'bw-tab-focus': act_bw_tab_focus,
    'browser-show': act_browser_show,
    'browser-hide': act_browser_hide,
    'browser-close': act_browser_close,
    'terminal-panel': act_terminal_panel,
    'term-full': act_term_full,
    'term-close': act_term_close,
    'term-new': act_term_new,
    'term-tab': act_term_tab,
    'term-tab-close': act_term_tab_close,
    'file-panel': act_file_panel,
    'file-close': act_file_close,
    'file-pick': act_file_pick,
    'file-refresh': act_file_refresh,
    'file-toggle': act_file_toggle,
    'file-open': act_file_open,
    'file-edit': act_file_edit,
    'file-edit-diff': act_file_edit_diff,
    'file-edit-save': act_file_edit_save,
    'file-edit-cancel': act_file_edit_cancel,
    'file-edit-reload': act_file_edit_reload,
    'browser-shot-dir': act_browser_shot_dir,
    'ask-input-ok': act_ask_input_ok,
    'archive-confirm': act_archive_confirm,
    'grant-add': act_grant_add,
    'grant-revoke': act_grant_revoke,
    'grant-revoke-all': act_grant_revoke_all,
    'team-compose': act_team_compose,
  });
}

window.__orchdeskActionModules = window.__orchdeskActionModules || [];
window.__orchdeskActionModules.push(installSessionActions);
