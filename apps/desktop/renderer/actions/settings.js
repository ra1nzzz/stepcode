/**
 * settings 页动作（审查项③：ACTIONS 注册表按 VIEWS 三页模块化）。
 * app.js 启动时 install(ACTIONS, ctx)——ctx 注入 IIFE 私有面（state/bridge/toast/…），
 * 本文件不引用 app.js 作用域任何符号，全部经 ctx.* 访问。
 */
function installSettingsActions(ACTIONS, ctx) {
  async function act_settings_nav(el, id, e) {
    // P4-S3-14：分区切换只重渲主区，不走整页 render。整页 render 会连侧栏/表单一起
    // 重建——用户在「模型管理」填了一半的预设/KEY/勾选会被静默清空，且无未保存提示。
    // （mpRefreshPool 的注释本就承认「不 render——保住表单其它已填字段」，导航却踩了这个坑。）
    ctx.state.settingsSection = id;
    ctx.renderSettingsMain();
  
  }

  async function act_composer_proj_pick(el, id, e) {
 {
        const pid = el.dataset.pid;
        ctx.state.selProjForComposer = pid;
        ctx.state.projDropdownOpen = false;
        // 若当前会话不在该项目下，跳转到该项目下的第一个会话或创建新会话
        const curS = ctx.state.sessions[ctx.state.sel];
        if (!curS || curS.pid !== pid) {
          const p = ctx.state.projects.find(x => x.id === pid);
          const existing = p ? p.sessions.find(sid => ctx.state.sessions[sid]) : null;
          if (existing) { ctx.state.sel = existing; }
          else if (p) { ctx.createSessionInProject(pid); }
        }
        // BUG-023：重选项目（含重选同一个）后，会话工作区必须跟着项目绑定目录走。
        if (ctx.state.sel && ctx.state.sessions[ctx.state.sel] && ctx.state.sessions[ctx.state.sel].pid === pid) {
          ctx.applySessionCwd(ctx.state.sel);
        }
        // P3 触发②：主动选择项目 → 自动升级项目模式（编排入口就位）

        ctx.render();}
  
  }

  async function act_composer_proj_task(el, id, e) {
 {
        ctx.state.selProjForComposer = '__task__';
        ctx.state.projDropdownOpen = false;
        ctx.closeModal();
        const id = 's' + Date.now().toString(36);
        const s = { id, pid: '__task__', title: '任务', expert: ctx.expertList()[ctx.state.wzExpert] || ctx.expertList()[0], model: ctx.state.selectedModels[0] || '—', updated: '刚刚', ts: ctx.nowTime(), msgs: [] };
        ctx.state.sessions[id] = s;
        ctx.state.sel = id;
        ctx.state.pExpanded.add('__task__');
        ctx.persist(); ctx.render();
        ctx.toast('已进入任务模式（无项目）', 'ok');}
  
  }

  async function act_auth_open(el, id, e) {
 ctx.openAuthPicker();
  
  }

  async function act_auth_mode_pick(el, id, e) {
 {
        const target = el.dataset.id;
        if (target !== 'bypass' && target !== 'autopilot') {
          ctx.toast('只能选择默认模式或完全信任', 'err');
          return;
        }
        if (target === ctx.state.authMode) { ctx.closeModal(); return; }
        // 从更严切到更松需二次确认（T-P3-2 防 L4 风险）。
        // 未入表的当前档按 0 算（未知档不算更松），目标档未入表也不按默认值放行。
        const currentRank = Object.prototype.hasOwnProperty.call(ctx.MODE_RANK, ctx.state.authMode) ? ctx.MODE_RANK[ctx.state.authMode] : 0;
        const targetRank = ctx.MODE_RANK[target];
        const loosening = typeof targetRank === 'number' && targetRank > currentRank;
        if (loosening) { ctx.confirmSwitchAuth(target); }
        else { ctx.doSwitchAuth(target); }}
  
  }

  async function act_auth_do_switch(el, id, e) {
 { const target = el.dataset.id; ctx.closeModal(); ctx.doSwitchAuth(target);}
  
  }

  async function act_mem_domain(el, id, e) {
 {
        ctx.state.memory.domain = el.dataset.domain || 'worker';
        ctx.refreshMemoryDomain();}
  
  }

  async function act_mem_refresh(el, id, e) {
 {
        ctx.refreshMemoryDomain();}
  
  }

  async function act_mem_promote(el, id, e) {
 {
        const id = el.dataset.id || '';
        const from = el.dataset.from || ctx.state.memory.domain;
        const to = el.dataset.to || '';
        if (!id || !to) { ctx.toast('晋升参数缺失', 'warn'); return; }
        if (typeof ctx.bridge.promoteMemory !== 'function') { ctx.toast('晋升未接入（主进程桥不可用）', 'warn'); return; }
        ctx.state.memory.busy = true; ctx.render();
        ctx.bridge.promoteMemory({ id, from, to }).then((r) => {
          ctx.state.memory.busy = false;
          const ok = !!(r && r.ok);
          // 被 Director 驳回不是错误：那是过滤在正常工作。用 warn 而不是 err，
          // 否则用户会以为功能坏了，实际是「这条结论没被放行」。
          ctx.toast(ctx.memReasonText(r && r.reason), ok ? 'ok' : 'warn');
          ctx.refreshMemoryDomain();
        }).catch((err) => {
          ctx.state.memory.busy = false;
          ctx.toast(`晋升失败：${(err && err.message) || err}`, 'err');
          ctx.render();
        });}
  
  }

  async function act_mem_promote_worker(el, id, e) {
 {
        if (typeof ctx.bridge.promoteWorkerDomain !== 'function') { ctx.toast('批量晋升未接入（主进程桥不可用）', 'warn'); return; }
        ctx.state.memory.busy = true; ctx.render();
        ctx.bridge.promoteWorkerDomain('director').then((r) => {
          ctx.state.memory.busy = false;
          if (typeof r.max === 'number') ctx.state.memory.promoteBatchMax = r.max;
          if (!r || !r.ok) { ctx.toast(`批量晋升失败：${(r && r.reason) || '未知原因'}`, 'warn'); ctx.render(); return; }
          // 全部被拒不是失败 —— Director 就是干这个的。只报事实，不报情绪。
          ctx.toast(`已处理 ${r.attempted} 条：晋升 ${r.promoted} · 驳回 ${r.rejected}${r.remaining ? ` · 还剩 ${r.remaining} 条，可再点一次` : ''}`, r.promoted ? 'ok' : 'warn');
          ctx.refreshMemoryDomain();
        }).catch((err) => {
          ctx.state.memory.busy = false;
          ctx.toast(`批量晋升异常：${(err && err.message) || err}`, 'err');
          ctx.render();
        });}
  
  }

  async function act_sandbox_save_net(el, id, e) {
 {
        const ta = document.getElementById('net-allow');
        const list = String((ta && ta.value) || '').split('\n').map((s) => s.trim()).filter(Boolean);
        const tip = document.getElementById('net-allow-tip');
        // 空列表 = 全部拒绝（fail-closed），不再回落 ['*'] 悄悄放开全网。
        ctx.bridge.setNetworkAllow(list).then((r) => {
          if (r && r.ok) {
            ctx.state.sandbox.networkAllow = r.networkAllow || [];
            if (tip) tip.textContent = ctx.state.sandbox.networkAllow.length
              ? `已保存（${ctx.state.sandbox.networkAllow.join('、')}）`
              : '已保存（空 = 全部拒绝）';
            ctx.toast('沙箱：网络域名白名单已更新', 'ok');
          } else {
            if (tip) tip.textContent = `保存失败：${(r && r.reason) || '未知原因'}`;
            ctx.toast('沙箱白名单保存失败', 'warn');
          }
        }).catch(() => { if (tip) tip.textContent = '保存失败（主进程未接入）'; });}
  
  }

  async function act_comp_record(el, id, e) {
 {
        ctx.openModal(`<div class="mh">${ctx.ic('warn', 18)}<b>记录补偿动作</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">补偿层无形式化保证，仅做尽力补偿。描述已发生的边界外/不可逆操作：</div>
            <textarea id="compText" class="inp" rows="3" placeholder="如：已删除 /tmp/secret.txt"></textarea>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="comp-do">记录</button></div>`);}
  
  }

  async function act_comp_do(el, id, e) {
 {
        const t = (ctx.$('#compText')?.value || '').trim();
        if (!t) { ctx.toast('请描述操作', 'warn'); return; }
        try {
          const rec = await ctx.bridge.compensate(t);
          ctx.state.compAudit.unshift(rec);
          ctx.closeModal(); ctx.render(); ctx.toast('补偿动作已记录并入审计', 'ok');
        } catch { ctx.toast('记录失败（运行时未接入）', 'warn'); }
        return;
      }

      /* 自进化临时插件（T-P5-2） */
  
  }

  async function act_trace(el, id, e) {
 {
        // key 必须与 renderMsg 的读取口径一致（sid|m.t）；此前硬编码 's1' 导致反馈永远显示不出来。
        const sid = ctx.state.sel || '';
        const key = sid + '|' + (el.dataset.t || '');
        const feedback = el.dataset.fb === 'negative' ? 'negative' : 'positive';
        if (ctx.state.feedback.has(key)) ctx.state.feedback.delete(key);
        else ctx.state.feedback.add(key);
        // 反馈落盘，重启后仍在（此前仅存于内存 Set）
        const s = ctx.state.sessions[sid];
        if (s) { s.feedback = [...ctx.state.feedback].filter((k) => k.startsWith(sid + '|')); ctx.persist(); }
        ctx.render();
        // 真实遥测落点（第八死挂点修复）：经 IPC → trace 插件 recordFeedback（source='user'）。
        // 此前按钮只改本地 Set，反馈从未进入遥测队列。
        const msg = (s && s.msgs || []).find((m) => m.t === el.dataset.t);
        ctx.bridge.traceFeedback({
          intent: (msg && msg.intent) || 'unknown',
          feedback,
          sessionKey: sid,
          messageKey: el.dataset.t || '',
        }).then((r) => {
          if (r && r.ok) ctx.toast(`TRACE：反馈已记录（待发 ${(r.queue && r.queue.pending) || 0} 条，脱敏后批量上送）`, 'ok');
          else if (r && r.reason) ctx.toast(`TRACE 反馈未能入队：${r.reason}`, 'warn');
        }).catch(() => {});
        return;
      }

      /* 模型选择 + 思维等级 */
  
  }

  async function act_composer_more_toggle(el, id, e) {
 { ctx.state.composerMoreOpen = !ctx.state.composerMoreOpen; const cm = document.querySelector('.composer-more-dropdown'); if (cm) cm.classList.toggle('open', ctx.state.composerMoreOpen);}
  
  }

  async function act_usage_refresh(el, id, e) {
 ctx.refreshUsage();
  
  }

  async function act_usage_clear(el, id, e) {
    // P4-S3-11：用量记账同属不可恢复的记账轨迹，清空前确认（与沙箱日志/晋升审计对齐）
    ctx.confirmDestructive({
      title: '清空用量记账？',
      body: '用量记账记录每个回合真实消耗的 token，清空后不可恢复。',
      warnList: ['历史用量统计将归零', '不影响会话消息本身'],
      action: 'usage-clear-confirmed', id: '', confirmLabel: '确认清空',
    });
  }

  async function act_usage_clear_confirmed(el, id, e) {
    ctx.closeModal();
        ctx.bridge.clearUsage().then((r) => {
          ctx.toast(r && r.ok ? '用量记账已清空' : String(r && r.reason || '清空失败'), r && r.ok ? 'ok' : 'err');
          ctx.refreshUsage();
        }).catch(() => {});
  
  }

  async function act_open_project_dir(el, id, e) {
 {
        // 设置页语义 = 打开数据目录，故意不传项目路径（项目目录走项目的 `··` 菜单）。
        const r = await ctx.bridge.openProjectDir();
        ctx.toast(r && r.ok ? `已打开数据目录：${(r && r.path) || ''}` : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');
        return;
      }
      /* 日志目录（模型调用 / 插件加载诊断留痕） */
  
  }

  async function act_open_log_dir(el, id, e) {
 {
        const r = await ctx.bridge.openLogDir();
        ctx.toast(r && r.ok ? `已打开日志目录\n当前日志: ${r.file || ''}` : `打开失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'ok' : 'danger');}
  
  }

  async function act_snapshot_data(el, id, e) {
 { const r = await ctx.bridge.snapshotData(); ctx.toast(r && r.ok ? `数据快照已生成：${r.dir}` : `快照失败：${(r && r.reason) || ''}`, r && r.ok ? 'ok' : 'danger'); return; }
      /* BUG-013 方案 B：数据导出 / 导入 */
  
  }

  async function act_export_data(el, id, e) {
 {
        const r = await ctx.bridge.exportData();
        ctx.toast(r && r.ok ? `数据已导出：${r.path}` : (r && r.reason === 'cancelled' ? '已取消导出' : `导出失败：${(r && r.reason) || ''}`), r && r.ok ? 'ok' : (r && r.reason === 'cancelled' ? 'ok' : 'danger'));}
  
  }

  async function act_import_data(el, id, e) {
 {
        ctx.importSuspend.on = true;
        try {
          const r = await ctx.bridge.importData();
          if (r && r.ok) {
            const parts = [];
            const im = r.imported || {};
            if (im.sessions) parts.push(`会话 ×${im.sessions}`);
            if (im.projects) parts.push(`项目 ×${im.projects}`);
            if (im.providers) parts.push(`模型提供商 ×${im.providers}`);
            if (im.guanji) parts.push('观雅集 TOKEN');
            if (im.hub) parts.push('Hub 凭据');
            const notes = (r.notes || []).join('\n');
            const summary = parts.length ? parts.join(' · ') : '本地数据已包含备份内容，无新增';
            ctx.toast(`导入完成：${summary}${notes ? '\n' + notes : ''}`, 'ok');
            // 重新拉取会话与项目分组（主进程已重载内存态；sessions 是按 id 的 map，需归一化）
            try {
              const [sess, projs] = await Promise.all([ctx.bridge.loadSessions(), ctx.bridge.loadProjects()]);
              if (Array.isArray(sess) && sess.length) {
                ctx.state.sessions = {};
                sess.forEach((s) => { ctx.state.sessions[s.id] = s; });
                if (!ctx.state.sessions[ctx.state.sel]) ctx.state.sel = sess[0].id;
              }
              if (Array.isArray(projs) && projs.length) ctx.state.projects = projs;
              ctx.render();
            } catch { /* 渲染层自行降级：下次启动生效 */ }
          } else {
            ctx.toast(r && r.reason === 'cancelled' ? '已取消导入' : `导入失败：${(r && r.reason) || ''}`, r && r.reason === 'cancelled' ? 'ok' : 'danger');
          }
        } finally {
          ctx.importSuspend.on = false; // 任何异常路径都必须恢复落盘，否则后续变更永不持久化
        }}
  
  }

  async function act_prompt_new(el, id, e) {
 ctx.openPromptEditor(null);
  
  }

  async function act_prompt_edit(el, id, e) {
 { const d = ctx.state.promptDocs.find((x) => x.id === id); ctx.openPromptEditor(d || null);}
  
  }

  async function act_prompt_save(el, id, e) {
 ctx.doSavePrompt(id);
  
  }

  async function act_prompt_delete(el, id, e) {
    // P1：提示词是用户资产，删除前确认
    ctx.confirmDestructive({
      title: '删除提示词？',
      body: '删除后不可恢复，引用它的会话将失去对应指令段。',
      warnList: ['提示词库的本地副本一并移除'],
      action: 'prompt-delete-confirm', id: el.dataset.id, confirmLabel: '确认删除',
    });
  }

  async function act_prompt_delete_confirm(el, id, e) {
    ctx.closeModal();
    ctx.doDeletePrompt(el.dataset.id); return;

      /* modal */
  
  }

  async function act_wz_next(el, id, e) {
 if (ctx.state.wz === 0) { ctx.state.wz = 1; ctx.renderWizard(); } else { ctx.$('#wizard').classList.add('hidden'); ctx.state.page = 'session'; ctx.render(); ctx.toast(`已进入会话 · 默认专家：${ctx.expertList()[ctx.state.wzExpert] || ctx.expertList()[0]}`, 'ok'); }
  
  }

  async function act_wz_skip(el, id, e) {
 ctx.$('#wizard').classList.add('hidden'); ctx.state.page = 'session'; ctx.render();
  
  }

  async function act_wz_open(el, id, e) {
 ctx.state.wz = 0; ctx.renderWizard(); ctx.$('#wizard').classList.remove('hidden');
  
  }

  async function act_wz_expert(el, id, e) {
 ctx.state.wzExpert = +el.dataset.i; ctx.renderWizard(); return;
      /* 专家团派发（multi composeTeam，第五个死挂点修复：目录可看 → 任务可派） */
      /* TRACE 上报开关（TOKEN 加密内置，用户仅可开关；默认开） */
  
  }

  async function act_trace_toggle(el, id, e) {
 {
        const cur = ctx.state.traceEnabled !== false;
        ctx.bridge.traceSetEnabled(!cur).then((r) => {
          if (!r || !r.ok) { ctx.toast((r && r.reason) || '切换失败', 'err'); return; }
          ctx.state.traceEnabled = !cur;
          ctx.updateTraceUi();
          ctx.toast(r.requiresRestart ? '已保存 · 重启 StepCode Desktop 后生效' : '已保存', 'ok');
        }).catch((e) => ctx.toast('切换失败: ' + ((e && e.message) || e), 'err'));
        return;
      }
      /* 授权白名单（PRD FR-9）：添加 / 撤销 / 全部撤销 */
  
  }

  async function act_desktop_toggle(el, id, e) {
 {
        const key = el.dataset.dk;
        if (!ctx.state.desktop || !ctx.state.desktop.config || !(key in ctx.state.desktop.config)) return;
        const next = !ctx.state.desktop.config[key];
        const label = (ctx.state.desktop.labels && ctx.state.desktop.labels[key]) || key;
        // 乐观更新：先响应用户点击，失败再回滚（设置项切换的即时反馈要求）
        ctx.state.desktop.config[key] = next;
        el.classList.toggle('on', next);
        el.setAttribute('aria-checked', String(next));
        ctx.bridge.setDesktop(key, next).then((r) => {
          if (!r || !r.ok) {
            ctx.state.desktop.config[key] = !next;
            el.classList.toggle('on', !next);
            el.setAttribute('aria-checked', String(!next));
            ctx.toast((r && r.reason) || '切换失败', 'err');
            return;
          }
          if (r.config) ctx.state.desktop.config = r.config;
          if (typeof r.autostartEffective === 'boolean') ctx.state.desktop.autostartEffective = r.autostartEffective;
          const descEl = document.querySelector(`[data-desktop-desc="${key}"]`);
          if (descEl && key === 'autostart') descEl.textContent = ctx.desktopAutostartDesc();
          // 悬浮窗刚开启时先推一次上下文，否则小窗显示「未选择会话」直到下次切会话
          if (key === 'floating' && next) ctx.pushFloatingContext();
          ctx.toast(r.warning ? r.warning : `${label}已${next ? '开启' : '关闭'}`, r.warning ? 'err' : 'ok');
        }).catch((e) => {
          ctx.state.desktop.config[key] = !next;
          el.classList.toggle('on', !next);
          ctx.toast('切换失败: ' + ((e && e.message) || e), 'err');
        });}
  
  }

  Object.assign(ACTIONS, {
    'settings-nav': act_settings_nav,
    'composer-proj-pick': act_composer_proj_pick,
    'composer-proj-task': act_composer_proj_task,
    'auth-open': act_auth_open,
    'auth-mode-pick': act_auth_mode_pick,
    'auth-do-switch': act_auth_do_switch,
    'mem-domain': act_mem_domain,
    'mem-refresh': act_mem_refresh,
    'mem-promote': act_mem_promote,
    'mem-promote-worker': act_mem_promote_worker,
    'sandbox-save-net': act_sandbox_save_net,
    'comp-record': act_comp_record,
    'comp-do': act_comp_do,
    'trace': act_trace,
    'composer-more-toggle': act_composer_more_toggle,
    'usage-refresh': act_usage_refresh,
    'usage-clear': act_usage_clear,
    'usage-clear-confirmed': act_usage_clear_confirmed,
    'open-project-dir': act_open_project_dir,
    'open-log-dir': act_open_log_dir,
    'snapshot-data': act_snapshot_data,
    'export-data': act_export_data,
    'import-data': act_import_data,
    'prompt-new': act_prompt_new,
    'prompt-edit': act_prompt_edit,
    'prompt-save': act_prompt_save,
    'prompt-delete': act_prompt_delete,
    'prompt-delete-confirm': act_prompt_delete_confirm,
    'wz-next': act_wz_next,
    'wz-skip': act_wz_skip,
    'wz-open': act_wz_open,
    'wz-expert': act_wz_expert,
    'trace-toggle': act_trace_toggle,
    'desktop-toggle': act_desktop_toggle,
  });
}

window.__orchdeskActionModules = window.__orchdeskActionModules || [];
window.__orchdeskActionModules.push(installSettingsActions);
