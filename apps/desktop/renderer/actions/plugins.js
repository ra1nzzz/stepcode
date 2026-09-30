/**
 * plugins 页动作（审查项③：ACTIONS 注册表按 VIEWS 三页模块化）。
 * app.js 启动时 install(ACTIONS, ctx)——ctx 注入 IIFE 私有面（state/bridge/toast/…），
 * 本文件不引用 app.js 作用域任何符号，全部经 ctx.* 访问。
 */
function installPluginsActions(ACTIONS, ctx) {
  async function act_skill_add(el, id, e) {
 ctx.openSkillPicker();
  
  }

  async function act_skill_attach(el, id, e) {
 ctx.toast(`已加载技能「${el.dataset.n}」（注册为 effect，离开会话即卸载）`, 'ok'); ctx.closeModal();
  
  }

  async function act_approval_grant(el, id, e) {
 {
        const id = el.dataset.id;
        const scope = el.dataset.scope === 'permanent' ? 'permanent' : 'session';
        const tool = el.dataset.tool || '';
        const target = el.dataset.target || '';
        ctx.closeModal();
        ctx.bridge.addGrant({
          tool,
          pattern: target,
          scope,
          ...(scope === 'session' ? { sessionId: ctx.state.sel || '' } : {}),
          note: '审批弹窗授权',
        }).then((r) => {
          if (!r || !r.ok) {
            ctx.bridge.submitDecision(id, 'rejected');
            ctx.toast(`白名单写入失败，已拒绝：${(r && r.reason) || '未知原因'}`, 'err');
            return;
          }
          ctx.state.grants = Array.isArray(r.grants) ? r.grants : ctx.state.grants;
          ctx.bridge.submitDecision(id, 'allowed-once');
          ctx.toast(scope === 'permanent' ? '已永久允许（可在设置页撤销）' : '本会话内不再询问', 'ok');
        }).catch((e) => {
          ctx.bridge.submitDecision(id, 'rejected');
          ctx.toast('白名单写入失败，已拒绝: ' + ((e && e.message) || e), 'err');
        });}
  
  }

  async function act_mp_clear(el, id, e) {
    // P4-S3-11：晋升审计里记着「被 Director 拦下」的安全事件，误清即永久丢失。
    // 同为审计轨迹的「清空沙箱日志」早有 confirmDestructive，这里补齐。
    if (!ctx.state.memoryPromotions.total) return;
    ctx.confirmDestructive({
      title: '清空晋升审计？',
      body: '晋升审计记录 SubAgent 结论向上一层晋升的全部历史，<b>包含被拦下的安全事件</b>，清空后不可恢复。',
      warnList: [`将清空 ${ctx.state.memoryPromotions.total} 条记录`, '被拦下（拒绝）的记录也一并移除'],
      action: 'mp-clear-confirmed', id: '', confirmLabel: '确认清空',
    });
  }

  async function act_mp_clear_confirmed(el, id, e) {
    ctx.closeModal();
    {
        if (!ctx.state.memoryPromotions.total) return;
        ctx.bridge.clearMemoryPromotions().then((r) => {
          if (!r || !r.ok) { ctx.toast('清空失败（主进程未接入）', 'warn'); return; }
          ctx.state.memoryPromotions = {
            entries: [], stats: { total: 0, promoted: 0, rejected: 0, byEdge: [] },
            total: 0, max: ctx.state.memoryPromotions.max, ok: ctx.state.memoryPromotions.ok, loaded: true,
          };
          ctx.render();
          ctx.toast(`已清空晋升审计（${r.cleared} 条）`, 'ok');
        }).catch(() => ctx.toast('清空失败', 'err'));}
  
  }

  async function act_tp_new(el, id, e) {
 {
        ctx.openModal(`<div class="mh">${ctx.ic('skills', 18)}<b>新建临时插件（自进化）</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">信任级 = Shell，须沙箱内运行；仅驻内存，重启即失。加载前经静态分析 + CONFIRM。</div>
            <div class="mb-row"><label>名称</label><input id="tpName" class="inp" placeholder="如：summarizer"></div>
            <div class="mb-row"><label>代码</label><textarea id="tpCode" class="inp" rows="4" placeholder="export function run(t){ return t; }"></textarea></div>
          </div>
          <!-- 内联 onclick 里的 toast/bridge/state 都在 IIFE 作用域外，点击必 ReferenceError；
               逻辑已由下方委托的 case 'tp-create' 承担。 -->
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button><button class="btn primary" data-action="tp-create">创建（CONFIRM）</button></div>`);}
  
  }

  async function act_tp_create(el, id, e) {
 {
        const name = (ctx.$('#tpName')?.value || '').trim();
        const code = (ctx.$('#tpCode')?.value || '').trim();
        if (!name || !code) { ctx.toast('请填写名称与代码', 'warn'); return; }
        try {
          const r = await ctx.bridge.createTempPlugin({ name, code });
          if (r && r.ok) { ctx.state.tempPlugins.unshift(r.plugin); ctx.closeModal(); ctx.render(); ctx.toast(`已创建临时插件「${name}」（仅驻内存）`, 'ok'); }
          else { ctx.toast('创建被拒：' + ((r && r.reason) || '静态门控未通过'), 'danger'); }
        } catch { ctx.toast('创建失败（运行时未接入）', 'warn'); }}
  
  }

  async function act_tp_dispose(el, id, e) {
 {
        try {
          const ok = await ctx.bridge.disposeTempPlugin(id);
          if (ok) ctx.state.tempPlugins = ctx.state.tempPlugins.filter((p) => p.id !== id);
          ctx.render(); ctx.toast('临时插件已卸载', 'warn');
        } catch { ctx.toast('卸载失败（运行时未接入）', 'warn'); }}
  
  }

  async function act_pside_toggle(el, id, e) {
 { if (ctx.state.plugSideExpanded.has(id)) ctx.state.plugSideExpanded.delete(id); else ctx.state.plugSideExpanded.add(id); ctx.render();}
  
  }

  async function act_plug_toggle(el, id, e) {
 {
        // 真实热插拔（FR-3）：此前只切 CSS class + toast，插件从未真正加载/卸载。
        const wantOn = !el.classList.contains('on');
        el.style.pointerEvents = 'none'; el.style.opacity = '0.6';
        try {
          const r = await ctx.bridge.setPluginEnabled(id, wantOn);
          if (r && r.ok) {
            // 以运行时返回的真实状态为准，不乐观更新
            const on = r.active === true;
            el.classList.toggle('on', on);
            ctx.state.pluginRuntime = await ctx.bridge.getPluginRuntime().catch(() => ctx.state.pluginRuntime);
            ctx.toast(on ? `已启用 ${id}（注册为 effect）` : `已停用 ${id}（注册已回滚，无残留）`, on ? 'ok' : 'warn');
          } else {
            ctx.toast(`切换失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          ctx.toast(`切换异常：${(err && err.message) || err}`, 'danger');
        } finally {
          el.style.pointerEvents = ''; el.style.opacity = '';
          ctx.render();
        }}
  
  }

  async function act_plug_cfg(el, id, e) {
 { const card = el.closest('.plug'); if (card) card.classList.toggle('open');}
  
  }

  async function act_plug_nav(el, id, e) {
 { const card = document.querySelector(`.plug[data-pid="${id}"]`); if (card) { card.classList.add('open'); card.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
  
  }

  async function act_plug_disable(el, id, e) {
 {
        try {
          const r = await ctx.bridge.setPluginEnabled(id, false);
          if (r && r.ok) {
            ctx.state.pluginRuntime = await ctx.bridge.getPluginRuntime().catch(() => ctx.state.pluginRuntime);
            ctx.toast(`已停用 ${id}（注册已回滚，无残留）`, 'warn');
          } else {
            ctx.toast(`停用失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          ctx.toast(`停用异常：${(err && err.message) || err}`, 'danger');
        }
        ctx.render();}
  
  }

  async function act_plug_unload(el, id, e) {
 {
        // 兼容旧入口：转发到真实停用
        try {
          const r = await ctx.bridge.setPluginEnabled(id || '', false);
          if (r && r.ok) ctx.toast('已停用（注册已回滚，无残留）', 'warn');
          else ctx.toast(`停用失败：${(r && r.reason) || '未知错误'}`, 'danger');
        } catch { ctx.toast('停用异常', 'danger'); }
        ctx.render();}
  
  }

  async function act_market(el, id, e) {
 ctx.toast(`「${el.dataset.n}」请到 设置-技能市场（观雅集）完成安装与能力审查`, 'warn');
  
  }

  async function act_market_auth(el, id, e) {
 ctx.toast(`「${el.dataset.n}」需授权：请在 设置-技能市场 安装时于确认弹窗中授权高危能力`, 'warn'); return;

      /* 连接器（PRD FR-3） */
  
  }

  async function act_market_refresh(el, id, e) {
 ctx.refreshMarket(); return;

      /* FR-5 用量追踪 */
  
  }

  async function act_market_open_dir(el, id, e) {
        if (typeof ctx.bridge.openMarketDir !== 'function') { ctx.toast('未接入', 'warn'); return; }
        ctx.bridge.openMarketDir().then((r) => {
          if (!r || !r.ok) ctx.toast(String(r && r.reason || '无法打开插件目录'), 'err');
          else ctx.toast('已在系统文件管理器打开插件目录', 'ok');
        }).catch((err) => ctx.toast(`打开失败：${err && err.message || err}`, 'err'));
  
  }

  async function act_market_local_toggle(el, id, e) {
 {
        const item = ctx.state.market.items.find((x) => x.dir === id);
        const next = !(item && item.enabled);
        if (item) ctx.state.market.busy = id;
        if (typeof ctx.bridge.setMarketPluginEnabled !== 'function') { ctx.toast('未接入', 'warn'); return; }
        ctx.bridge.setMarketPluginEnabled(id, next).then((r) => {
          if (!r || r.ok === false) {
            ctx.toast(String(r && r.reason || '操作失败'), 'err');
          } else if (r.state && r.state.active) {
            ctx.toast(`已启用并装载：${r.state.manifest && r.state.manifest.name || id}`, 'ok');
          } else if (r.state && r.state.enabled) {
            ctx.toast('装载完成但未激活（注入的依赖未满足）', 'warn');
          } else {
            ctx.toast('已停用（逆回滚完成，无残留）', 'ok');
          }
          ctx.refreshMarket();
        }).catch((err) => ctx.toast(`操作失败：${err && err.message || err}`, 'err'));}
  
  }

  async function act_pside_nav(el, id, e) {
 {
        const target = el.dataset.target;
        const node = target && document.getElementById(target);
        if (node) {
          node.scrollIntoView({ behavior: 'smooth', block: 'start' });
          node.classList.add('psec-flash');
          setTimeout(() => node.classList.remove('psec-flash'), 1200);
        }}
  
  }

  async function act_market_local_nav(el, id, e) {
 {
        // 旧入口（已由 pside-nav 取代），保留以免外部/旧状态点击落空
        const node = document.getElementById('psec-market');
        if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });}
  
  }

  async function act_guanji_token(el, id, e) {
 {
        ctx.askInput({
          title: '配置观雅集 TOKEN',
          label: '粘贴观雅集持久化 TOKEN（来自 https://skill.ytaiv.com/api/auth/token，登录后获取）。TOKEN 将经系统安全存储加密保存，绝不硬编码。',
          placeholder: '粘贴 TOKEN…',
          secret: true,
          okText: '保存',
          onOk: async (t) => {
            if (!t || !t.trim()) { ctx.toast('TOKEN 为空', 'warn'); return; }
            const r = await ctx.bridge.guanjiSetToken(t.trim());
            ctx.state.guanjiTokenSet = !!(r && r.ok);
            if (ctx.state.guanjiTokenSet) { try { ctx.state.guanjiSkills = await ctx.bridge.guanjiList(); } catch { /* 回落静态样本 */ } }
            ctx.toast(ctx.state.guanjiTokenSet ? '观雅集 TOKEN 已配置' : `TOKEN 配置失败：${(r && r.reason) || '未知错误'}`, ctx.state.guanjiTokenSet ? 'ok' : 'danger');
            ctx.render();
          },
        });}
  
  }

  async function act_guanji_install(el, id, e) {
 {
        const slug = el.dataset.slug;
        const list = ctx.state.guanjiSkills.length ? ctx.state.guanjiSkills : ctx.SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }));
        const skill = list.find((x) => x.slug === slug);
        if (!skill) return;
        if (skill.auth === 1) {
          // 高危技能：先弹显式授权确认（列出声明的 L3/L4 高危能力），确认后 authorized=true 安装。
          ctx.openModal(`<div class="mh">${ctx.ic('shield', 18)}<b>授权安装「${ctx.esc(skill.name || slug)}」</b></div>
            <div class="mb">
              <div class="faint" style="margin-bottom:8px">该技能声明了 L3/L4 高危能力，安装后即获得这些权限（L3/L4 强制授权，不可凭 TOKEN 绕过）。请确认：</div>
              <div>${skill.caps.map((c) => `<span class="badge warn" style="margin:2px 4px 2px 0">${ctx.esc(c)}</span>`).join('')}</div>
            </div>
            <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
              <button class="btn danger" data-action="guanji-install-auth" data-slug="${ctx.esc(slug)}">授权并安装</button></div>`);
        } else {
          await ctx.doInstallGuanjiSkill(skill, false);
        }}
  
  }

  async function act_guanji_install_auth(el, id, e) {
 {
        const slug = el.dataset.slug;
        const list = ctx.state.guanjiSkills.length ? ctx.state.guanjiSkills : ctx.SKILLS_MARKET.map((s) => ({ slug: s.n, name: s.n, description: s.d, caps: s.caps, auth: s.auth }));
        const skill = list.find((x) => x.slug === slug);
        if (!skill) return;
        await ctx.doInstallGuanjiSkill(skill, true);}
  
  }

  async function act_guanji_publish(el, id, e) {
 {
        ctx.askInput({
          title: '发布技能到观雅集',
          label: '输入技能 slug（与 .skill 包根 SKILL.md 的 name 一致）。发布需已配置 TOKEN；.skill 包经 Electron 文件对话框选择后上传。',
          placeholder: '技能 slug…',
          okText: '发布',
          onOk: async (slug) => {
            if (!slug || !slug.trim()) { ctx.toast('slug 为空', 'warn'); return; }
            const r = await ctx.bridge.guanjiPublish({ slug: slug.trim(), filePath: '' });
            ctx.toast(r && r.ok ? `已发布「${slug.trim()}」到观雅集` : `发布失败：${(r && r.reason) || '需配置 TOKEN 与有效 .skill 文件'}`, r && r.ok ? 'ok' : 'danger');
            ctx.render();
          },
        });}
  
  }

  async function act_skill_toggle(el, id, e) {
 { const s = ctx.state.installedSkills.find((x) => x.slug === el.dataset.n); if (s) { s.enabled = !s.enabled; ctx.render(); }}
  
  }

  async function act_skill_uninstall(el, id, e) {
    // P1：真删磁盘包，卸载前确认
    const slug = el.dataset.n;
    ctx.confirmDestructive({
      title: `卸载技能「${ctx.esc(slug)}」？`,
      body: '将<b>从磁盘真删除</b>该技能包（不是仅从界面移除），需重新安装才能恢复。',
      warnList: [
        '已加载该技能的会话在下次加载时不可用',
        '安装来源（市场/guanji）需重新走安装流程',
      ],
      action: 'skill-uninstall-confirm', id: slug, confirmLabel: '确认卸载',
    });
  }

  async function act_skill_uninstall_confirm(el, id, e) {
    ctx.closeModal();
 {
        // 真删磁盘包。此前只从渲染层数组移除，文件还在 —— 下次启动又冒出来。
        const slug = el.dataset.id;
        try {
          const r = typeof ctx.bridge.uninstallSkill === 'function'
            ? await ctx.bridge.uninstallSkill(slug)
            : { ok: false, reason: '主进程未接入' };
          if (r && r.ok) {
            ctx.state.installedSkills = ctx.state.installedSkills.filter((x) => x.slug !== slug);
            ctx.toast(`已卸载「${slug}」`, 'warn');
          } else {
            ctx.toast(`卸载失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          ctx.toast(`卸载异常：${(err && err.message) || err}`, 'danger');
        }
        ctx.render();
        return;
      }

      /* MCP（真接入） */
  
  }

  async function act_mcp_add(el, id, e) {
 {
        ctx.openModal(`<div class="mh">${ctx.ic('zap', 18)}<b>添加 MCP server</b></div>
          <div class="mb">
            <div class="faint" style="margin-bottom:8px">stdio 传输：填写启动命令与参数。env 值（如 API 密钥）将<b>加密</b>落盘。保存即握手探测一次。</div>
            <div class="mb-row"><label>ID（唯一）</label><input id="mcpId" class="inp" placeholder="如 filesystem / github"></div>
            <div class="mb-row"><label>显示名</label><input id="mcpName" class="inp" placeholder="可留空，默认用 ID"></div>
            <div class="mb-row"><label>命令</label><input id="mcpCmd" class="inp" placeholder="npx / uvx / node / 绝对路径"></div>
            <div class="mb-row"><label>参数（空格分隔）</label><input id="mcpArgs" class="inp" placeholder="-y @modelcontextprotocol/server-filesystem /path"></div>
            <div class="mb-row"><label>环境变量（KEY=VALUE，一行一个，选填）</label><textarea id="mcpEnv" class="inp" rows="3" placeholder="GITHUB_TOKEN=ghp_xxx"></textarea></div>
          </div>
          <div class="mf"><button class="btn ghost" data-action="modal-cancel">取消</button>
            <button class="btn primary" data-action="mcp-save">保存并探测</button></div>`);}
  
  }

  async function act_mcp_save(el, id, e) {
 {
        const id = (ctx.$('#mcpId') && ctx.$('#mcpId').value || '').trim();
        const name = (ctx.$('#mcpName') && ctx.$('#mcpName').value || '').trim();
        const command = (ctx.$('#mcpCmd') && ctx.$('#mcpCmd').value || '').trim();
        const argsRaw = (ctx.$('#mcpArgs') && ctx.$('#mcpArgs').value || '').trim();
        const envRaw = (ctx.$('#mcpEnv') && ctx.$('#mcpEnv').value || '').trim();
        if (!id || !command) { ctx.toast('ID 与命令必填', 'warn'); return; }
        const args = argsRaw ? argsRaw.split(/\s+/).filter(Boolean) : [];
        const env = {};
        if (envRaw) {
          for (const line of envRaw.split('\n')) {
            const eq = line.indexOf('=');
            if (eq <= 0) continue;
            env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
          }
        }
        try {
          const r = typeof ctx.bridge.mcpSave === 'function'
            ? await ctx.bridge.mcpSave({ id, name, command, args, env: Object.keys(env).length ? env : undefined, enabled: true })
            : { ok: false, reason: '主进程未接入' };
          if (r && r.ok) {
            const probe = r.probe;
            ctx.toast(probe && probe.connected
              ? `已保存并连接「${id}」· ${(probe.tools || []).length} 个工具`
              : (probe ? `已保存但连接失败：${probe.reason || '未知'}` : '已保存（未启用连接）'),
              probe && probe.connected ? 'ok' : 'warn');
          } else {
            ctx.toast(`保存失败：${(r && r.reason) || '未知错误'}`, 'danger');
          }
        } catch (err) {
          ctx.toast(`保存异常：${(err && err.message) || err}`, 'danger');
        }
        ctx.closeModal();
        await ctx.refreshMcp();
        ctx.render();}
  
  }

  async function act_mcp_probe(el, id, e) {
 {
        const id = el.dataset.id;
        el.textContent = '探测中…'; el.disabled = true;
        try {
          const r = typeof ctx.bridge.mcpProbe === 'function'
            ? await ctx.bridge.mcpProbe(id)
            : { ok: false, reason: '主进程未接入' };
          const probe = r && r.probe;
          ctx.toast(probe && probe.connected
            ? `已连接「${id}」· ${(probe.tools || []).length} 个工具`
            : `连接失败：${(probe && probe.reason) || (r && r.reason) || '未知'}`, probe && probe.connected ? 'ok' : 'warn');
        } catch (err) {
          ctx.toast(`探测异常：${(err && err.message) || err}`, 'danger');
        }
        await ctx.refreshMcp();
        ctx.render();}
  
  }

  async function act_mcp_toggle(el, id, e) {
 {
        const id = el.dataset.id;
        const cur = ctx.state.mcp.servers.find((x) => x.id === id);
        const want = !(cur && cur.enabled !== false);
        try {
          const r = typeof ctx.bridge.mcpSetEnabled === 'function'
            ? await ctx.bridge.mcpSetEnabled(id, want)
            : { ok: false, reason: '主进程未接入' };
          if (!r || !r.ok) ctx.toast(`切换失败：${(r && r.reason) || '未知错误'}`, 'danger');
        } catch (err) {
          ctx.toast(`切换异常：${(err && err.message) || err}`, 'danger');
        }
        await ctx.refreshMcp();
        ctx.render();}
  
  }

  async function act_mcp_del(el, id, e) {
    // P1：删除 MCP server 前确认（真删配置，不可恢复）
    const mid = el.dataset.id;
    ctx.confirmDestructive({
      title: `删除 MCP server「${ctx.esc(mid)}」？`,
      body: '删除后该 server 的配置、握手状态与已配置工具都会移除。',
      warnList: [
        '需要重新添加并握手后才能恢复',
        '加密保存的 env 凭据一并移除',
      ],
      action: 'mcp-del-confirm', id: mid, confirmLabel: '确认删除',
    });
  }

  async function act_mcp_del_confirm(el, id, e) {
    ctx.closeModal();
 {
        const id = el.dataset.id;
        try {
          const r = typeof ctx.bridge.mcpDelete === 'function'
            ? await ctx.bridge.mcpDelete(id)
            : { ok: false, reason: '主进程未接入' };
          ctx.toast(r && r.ok ? `已删除「${id}」` : `删除失败：${(r && r.reason) || '未知错误'}`, r && r.ok ? 'warn' : 'danger');
        } catch (err) {
          ctx.toast(`删除异常：${(err && err.message) || err}`, 'danger');
        }
        await ctx.refreshMcp();
        ctx.render();
        return;
      }

      /* T-P6-2 OrchClaw Hub 联调 */
  
  }

  async function act_hub_pair(el, id, e) {
 {
        const url = ((ctx.$('#hubUrl') && ctx.$('#hubUrl').value) || '').trim();
        const token = ((ctx.$('#hubToken') && ctx.$('#hubToken').value) || '').trim();
        if (!url || !token) { ctx.toast('请填写 Hub URL 与配对凭据', 'danger'); return; }
        const r = await ctx.bridge.hubPair(url, token);
        if (r && r.ok) { ctx.state.hubStatus = { paired: true, url, agentName: r.agentName }; ctx.state.hubUrl = url; ctx.toast(`已配对远程 Agent${r.agentName ? '：' + r.agentName : ''}`, 'ok'); }
        else { ctx.toast(`配对失败：${(r && r.reason) || '未知错误'}`, 'danger'); }
        ctx.render();}
  
  }

  async function act_hub_send(el, id, e) {
 {
        const text = ((ctx.$('#hubTask') && ctx.$('#hubTask').value) || '').trim();
        if (!text) { ctx.toast('请填写任务内容', 'danger'); return; }
        ctx.state.hubTaskText = text;
        const r = await ctx.bridge.hubSend(text);
        if (r && r.ok && r.taskId) {
          ctx.toast('任务已下发，正在回收结果…', 'ok');
          const res = await ctx.bridge.hubResult(r.taskId);
          ctx.state.hubResultText = (res && res.result) ? res.result : `状态：${(res && res.status) || 'unknown'}`;
        } else { ctx.state.hubResultText = `发送失败：${(r && r.reason) || '未配对'}`; }
        ctx.render();}
  
  }

  async function act_hub_unpair(el, id, e) {
 { ctx.state.hubStatus = { paired: false }; ctx.state.hubResultText = ''; ctx.toast('已解除配对', 'warn'); ctx.render(); return; }

      /* 设置 */
  
  }

  Object.assign(ACTIONS, {
    'skill-add': act_skill_add,
    'skill-attach': act_skill_attach,
    'approval-grant': act_approval_grant,
    'mp-clear': act_mp_clear,
    'mp-clear-confirmed': act_mp_clear_confirmed,
    'tp-new': act_tp_new,
    'tp-create': act_tp_create,
    'tp-dispose': act_tp_dispose,
    'pside-toggle': act_pside_toggle,
    'plug-toggle': act_plug_toggle,
    'plug-cfg': act_plug_cfg,
    'plug-nav': act_plug_nav,
    'plug-disable': act_plug_disable,
    'plug-unload': act_plug_unload,
    'market': act_market,
    'market-auth': act_market_auth,
    'market-refresh': act_market_refresh,
    'market-open-dir': act_market_open_dir,
    'market-local-toggle': act_market_local_toggle,
    'pside-nav': act_pside_nav,
    'market-local-nav': act_market_local_nav,
    'guanji-token': act_guanji_token,
    'guanji-install': act_guanji_install,
    'guanji-install-auth': act_guanji_install_auth,
    'guanji-publish': act_guanji_publish,
    'skill-toggle': act_skill_toggle,
    'skill-uninstall': act_skill_uninstall,
    'mcp-add': act_mcp_add,
    'mcp-save': act_mcp_save,
    'mcp-probe': act_mcp_probe,
    'mcp-toggle': act_mcp_toggle,
    'mcp-del': act_mcp_del,
    'caps-expand': (el) => { const box = el.closest('.pcaps'); if (box) box.dataset.expanded = '1'; },
    'mcp-del-confirm': act_mcp_del_confirm,
    'skill-uninstall-confirm': act_skill_uninstall_confirm,
    'hub-pair': act_hub_pair,
    'hub-send': act_hub_send,
    'hub-unpair': act_hub_unpair,
  });
}

window.__orchdeskActionModules = window.__orchdeskActionModules || [];
window.__orchdeskActionModules.push(installPluginsActions);
