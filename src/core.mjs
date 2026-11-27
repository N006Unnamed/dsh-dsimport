/**
 * core.mjs —— 导入核心：把 DeepSeek 网页对话写成「真实、可续聊的 dsh 会话」。
 *
 * 关键：写「可续聊的真会话」必须落到磁盘的持久化日志上。仅用 ctx.sessions.create()
 * + session.append() 只注册了内存里的 live 会话，**不会写盘**（没有 persistence write handle），
 * 于是刷新/重启后在会话列表里 resume 会报 SessionPersistenceNotFoundError。
 *
 * 正解：直接用宿主的 sessionPersistence 服务（session/event 真正落到 .jsonl.zstd 的就是它）：
 *   persistence.create(header) → 拿到 write handle（懒物化，首次 append/flush 才写盘）
 *   handle.append(events)      → events 必须是 {type, seq(从0连续), time, data}
 *   handle.close()             → flush + 释放写锁
 * 之后网关 resume 走 persistence.open(id,'write') 就能读到完整日志、正常打开并续聊。
 *
 * 事件格式已用真实 dsh-session 验证：
 *   turn/start, step/start, user/message, assistant/message, step/end, turn/end
 * 其中 assistant/message 的 message 必须带 id（MessageId），stream 用最简 text-chunks。
 * surface 事件（user/message、assistant/message）在存储日志里必须带 surfaceOp:'append'，
 * 否则读回时 foldSurface 会报 "surfaceOp requires an object"（已实测）。
 */
import { parseHistoryMessages, pairTurns } from './parse.mjs';
import { buildSessionEvents, buildModelSelectionEvent, uuid } from './convert.mjs';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';

const errText = (e) => String(e instanceof Error ? e.message : e);

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig   读当前配置
 * @param {(m:string)=>void} deps.log
 * @param {object} deps.sessions          宿主 ctx.sessions（保留，未用于写盘）
 * @param {object} deps.persistence       宿主 sessionPersistence 服务（create/open 的持久化后端）
 * @param {object} deps.workspaceRegistry 宿主 workspaceRegistry 服务（把会话挂到工作区，侧边栏才会显示）
 * @param {object} deps.host              DsHost 实例
 */
export function createCore({ getConfig, log = () => {}, sessions, getSessions, persistence, workspaceRegistry, permissionPresets, getWorkspaceRegistry, getPermissionPresets, getAgents, getAgentDefaultModel, getService, host }) {
  /** 惰性取会话 store（ctx.sessions）：把导入的会话「录入内存 live store」，以此触发 session/created → 侧边栏即时出现 + 可直接打开。 */
  function sessStore() {
    try {
      const v = typeof getSessions === 'function' ? getSessions() : undefined;
      return v || sessions;
    } catch {
      return sessions;
    }
  }
  /** 惰性取工作区注册表：优先用 getter（apply 时服务可能未激活），回退到直接传入的实例。 */
  function wsReg() {
    try {
      const v = typeof getWorkspaceRegistry === 'function' ? getWorkspaceRegistry() : undefined;
      return v || workspaceRegistry;
    } catch {
      return workspaceRegistry;
    }
  }
  /** 惰性取权限预设服务。 */
  function permPresets() {
    try {
      const v = typeof getPermissionPresets === 'function' ? getPermissionPresets() : undefined;
      return v || permissionPresets;
    } catch {
      return permissionPresets;
    }
  }

  /**
   * 取「当前默认模型」（{provider, model, reasoningEffort?}），用于写入 model/selection 事件。
   * 优先级：agentDefaultModel.currentSelection() → 回退到配置里 provider/model → 再回退 undefined。
   * 返回 undefined 表示拿不到，此时仍会写一条兜底 selection（尽量让续聊可用）。
   */
  function resolveModelSelection() {
    try {
      const adm = typeof getAgentDefaultModel === 'function' ? getAgentDefaultModel() : undefined;
      if (adm && typeof adm.currentSelection === 'function') {
        const sel = adm.currentSelection();
        if (sel && typeof sel.provider === 'string' && sel.provider && typeof sel.model === 'string' && sel.model) {
          const out = { provider: sel.provider, model: sel.model };
          if (sel.reasoningEffort !== undefined && sel.reasoningEffort !== null && sel.reasoningEffort !== '') {
            out.reasoningEffort = String(sel.reasoningEffort);
          }
          return out;
        }
      }
    } catch (e) {
      log(`读取默认模型失败：${errText(e)}`);
    }
    return undefined;
  }
  /** 记录已导入的会话 id（避免重复导入）。放内存即可，重启后会丢；加 file 也行。 */
  const importedMap = new Map(); // dsSessionId -> dshSessionId

  /**
   * 生成「会话初始化」必备的 3 个环境事件（seq 0/1/2）。
   * 真实 dsh 会话每条都以 permission/preset、sandbox/mode、approval/policy 开场；
   * 缺了它们，DSH 打开该会话时会判定「用户配置损坏」。值来自 permissionPresets 服务的默认预设。
   */
  function buildEnvEvents() {
    let presetName = 'workspace-write';
    let sandbox = 'workspace-write';
    let approval = 'ask';
    try {
      const pp = permPresets();
      if (pp && typeof pp.defaultPreset === 'string') {
        presetName = pp.defaultPreset;
      }
      if (pp && typeof pp.resolve === 'function') {
        const spec = pp.resolve(presetName);
        if (spec) {
          if (spec.sandbox) sandbox = spec.sandbox;
          if (spec.approval) approval = spec.approval;
        }
      }
    } catch (e) {
      log(`读取权限预设失败，使用默认值：${errText(e)}`);
    }
    return [
      { type: 'permission/preset', data: { preset: presetName } },
      { type: 'sandbox/mode', data: { mode: sandbox } },
      { type: 'approval/policy', data: { policy: approval } },
    ];
  }

  function cfg() {
    const c = getConfig() || {};
    return {
      titleSuffix: typeof c.titleSuffix === 'string' ? c.titleSuffix : '（来自 DeepSeek）',
      keepReasoning: Boolean(c.keepReasoning),
      targetWorkspacePath: typeof c.targetWorkspacePath === 'string' ? c.targetWorkspacePath : '',
    };
  }

  /**
   * 选择会话 header 的 cwd。**必须**是某个已注册工作区的真实 path，
   * 因为 attachSession 会校验 realpathNormalize(header.cwd) === workspace.path，
   * 不相等就抛错 / 挂不上，会话就不会出现在侧边栏。
   *
   * 选择顺序：
   *   1) 配置里的 targetWorkspacePath（用户显式指定）；
   *   2) 与 process.cwd() 匹配的工作区（正常启动时）；
   *   3) sessionIds 最多的那个工作区（即「主工作区」，用户日常用的）；
   *   4) list()[0]；
   *   5) 兜底 process.cwd()/DSH_HOME（此时多半挂不上，但至少能写盘）。
   */
  async function resolveCwd() {
    const wr = wsReg();
    if (wr && typeof wr.list === 'function') {
      try {
        const list = wr.list();
        if (Array.isArray(list) && list.length) {
          const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
          const want = cfg().targetWorkspacePath;
          if (want) {
            const hit = list.find((w) => norm(w.path) === norm(want));
            if (hit && hit.path) return hit.path;
          }
          const c = process.cwd();
          const byCwd = c ? list.find((w) => norm(w.path) === norm(c)) : undefined;
          if (byCwd && byCwd.path) return byCwd.path;
          // 主工作区 = sessionIds 最多的那个（用户日常会话都堆在这里）
          let main;
          for (const w of list) {
            const n = Array.isArray(w.sessionIds) ? w.sessionIds.length : 0;
            if (!main || n > main.n) main = { w, n };
          }
          if (main && main.w && main.w.path) return main.w.path;
          if (list[0] && list[0].path) return list[0].path;
        }
      } catch {}
    }
    const c = process.cwd();
    if (c && isAbsolute(c)) return c;
    return process.env.DSH_HOME || join(homedir(), '.dsh');
  }

  /**
   * 把已写盘的新会话挂到其 cwd 对应的工作区（workspace.json 的 sessionIds）。
   * attachSession 会读 header、校验 cwd 解析后必须等于 workspace.path。
   * @returns {Promise<string|undefined>} 成功返回 workspaceId
   */
  async function attachToWorkspace(sessionId, cwd) {
    const wr = wsReg();
    if (!wr) return { ok: false, reason: '宿主未提供 workspaceRegistry 服务（无法把会话挂进侧边栏工作区）' };
    // 优先按路径直接解析；失败再遍历 list() 比较 path。
    let entity;
    try {
      if (typeof wr.resolveByPath === 'function') {
        entity = await wr.resolveByPath(cwd);
      }
    } catch (e) {
      log(`resolveByPath 失败：${errText(e)}`);
    }
    if (!entity && typeof wr.list === 'function') {
      const list = wr.list();
      const norm = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase();
      const target = norm(cwd);
      entity = list.find((w) => norm(w.path) === target);
    }
    if (!entity) return { ok: false, reason: `没有与 cwd 「${cwd}」匹配的工作区（可导入后手动移动，或在设置里指定工作区路径）` };
    await entity.attachSession(sessionId); // 可能在 cwd 不匹配时抛错，由调用方捕获
    return { ok: true, workspaceId: entity.id };
  }

  /**
   * 列 DeepSeek 网页上的会话（带是否已导入的标记）。
   */
  async function list({ limit = 100 } = {}) {
    const items = await host.listSessions({ limit });
    return items.map((it) => ({
      ...it,
      imported: importedMap.has(it.id),
      dshSessionId: importedMap.get(it.id) || '',
    }));
  }

  /**
   * 导入指定的 DeepSeek 会话到 dsh。
   * @param {object} opts
   * @param {string[]} [opts.sessionIds]  要导入的会话 id 列表（用户勾选的）
   * @param {boolean} [opts.all]          为 true 时导入全部（不推荐，UI 默认勾选导入）
   * @param {number} [opts.limit]         all 模式下的上限
   * @returns {Promise<{ok:boolean, results:Array}>}
   */
  async function importSessions({ sessionIds = [], all = false, limit = 100 } = {}) {
    const conf = cfg();
    let targets = Array.isArray(sessionIds) ? sessionIds.slice() : [];
    if (all && targets.length === 0) {
      const listed = await host.listSessions({ limit });
      targets = listed.map((x) => x.id);
    }
    if (targets.length === 0) throw new Error('没有选择要导入的会话。请先列出会话并勾选。');

    const results = [];
    for (const dsId of targets) {
      try {
        const res = await host.fetchSessionMessages(dsId);
        // res.messages 是已解析好的 {id,title,turns}
        const parsed = (res && res.messages && Array.isArray(res.messages.turns))
          ? res.messages
          : parseHistoryMessages(res && res.raw ? res.raw : res, { keepThinking: conf.keepReasoning });
        const dsTitle = parsed.title || (res && res.session && res.session.title) || '导入的对话';
        const paired = pairTurns(parsed.turns);
        if (paired.length === 0) {
          results.push({ dsId, ok: false, error: '该对话没有可导入的问答内容（可能只有思考、或为空）。' });
          continue;
        }
        const modelSel = resolveModelSelection();
        const { events, turnCount } = buildSessionEvents(paired, { baseTime: Date.now(), model: modelSel });

        // 会话级模型选择：续聊组装 prompt 需要它（否则 persona-prefix 的 {{model}} 无值报错）。
        // 拿不到默认模型时用兜底 provider/model，至少让 {{model}} 有值。
        const selForEvent = modelSel || { provider: 'deepseek-official', model: 'deepseek-flash' };

        // 建会话日志：id 用 'session-<uuid>'（dsh 约定，侧边栏/投影都按这个前缀识别）；
        // 标题带后缀。必须走 sessionPersistence 才真正落盘、可 resume。
        const dshId = 'session-' + uuid();
        const createdAt = Date.now();
        const header = {
          version: 4,
          id: dshId,
          createdAt,
          cwd: await resolveCwd(),
          isSeeded: false,
          delegationDepth: 0,
          agentPreset: 'standard',
        };

        if (!persistence || typeof persistence.create !== 'function') {
          results.push({ dsId, ok: false, error: '宿主未提供 sessionPersistence，无法写盘（当前环境不支持导入）。' });
          continue;
        }

        let handle;
        try {
          handle = await persistence.create(header);
        } catch (e) {
          results.push({ dsId, ok: false, error: '建会话日志失败：' + errText(e) });
          continue;
        }

        // 组装带「密集 seq + time」的完整事件列表。
        // seq 0 = session/title；其后是 convert 产出的事件（surface 事件保留 surfaceOp:'append'）。
        let stored;
        try {
          stored = [];
          let seq = 0;
          let t = createdAt;
          // 必须先写 3 个「会话环境事件」，否则 DSH 打开会报「用户配置损坏」。
          for (const env of buildEnvEvents()) {
            stored.push({ type: env.type, seq: seq++, time: (t += 2), data: env.data });
          }
          // 会话种子结束标记（真实会话 seq3 就是这个，标记「非 seed 的正式会话」）。
          stored.push({ type: 'session/end-seed', seq: seq++, time: (t += 2), data: {} });
          // 会话级模型选择：必须写入，否则续聊时 prompt 的 {{model}} 无值报错
          // 「prompt variable "{{model}}" has no value for this assembly (section "deployment:persona-prefix")」。
          {
            const mse = buildModelSelectionEvent(selForEvent);
            stored.push({ type: mse.type, seq: seq++, time: (t += 2), data: mse.data });
          }
          // 标题（放在环境事件之后，便于侧边栏展示）。
          stored.push({
            type: 'session/title',
            seq: seq++,
            time: (t += 2),
            data: {
              title: `${dsTitle}${conf.titleSuffix}`.slice(0, 120),
              messageSeqs: [],
              source: { kind: 'user' },
            },
          });
          for (const ev of events) {
            const item = { type: ev.type, seq: seq++, time: (t += 3), data: ev.data };
            if (ev.surfaceOp) item.surfaceOp = ev.surfaceOp; // 存储格式要求 surface 事件带 surfaceOp:'append'
            stored.push(item);
          }
          await handle.append(stored);
          await handle.close();
        } catch (e) {
          try { await handle.close(); } catch {}
          results.push({ dsId, ok: false, error: '写事件失败：' + errText(e) });
          continue;
        }

        // 关键：把会话挂到工作区成员表（workspace.json 的 sessionIds），
        // 否则会话文件虽已落盘，但左侧「对话侧边栏」只列 workspace 成员 → 看不到。
        // attachSession 会校验 header.cwd（realpathNormalize）必须等于 workspace.path。
        let attachError = '';
        try {
          const at = await attachToWorkspace(dshId, header.cwd);
          if (!at.ok) attachError = '未能挂到工作区：' + at.reason;
        } catch (e) {
          attachError = '挂到工作区失败：' + errText(e);
          log(`警告：会话 ${dshId} attach 失败：${errText(e)}`);
        }

        // 关键 2：把会话「激活为 live 会话」——用宿主的 agents.resume（与用户点开会话时
        // 走的是同一条正常 resume 路径），而不是 ctx.sessions.create。
        // 失败时**完整记录真实报错**（不静默吞），面板会展示，便于真机定位。
        let liveError = '';
        let diag = {};
        const agentSvc = (() => {
          try {
            return typeof getAgents === 'function' ? getAgents() : undefined;
          } catch (e) {
            diag.getAgents = 'getAgents 抛错：' + errText(e);
            return undefined;
          }
        })();
        if (agentSvc && typeof agentSvc.resume === 'function') {
          try {
            await agentSvc.resume({ resumeSessionId: dshId });
            diag.resume = 'ok';
            log(`已激活 live 会话：${dshId}`);
          } catch (e) {
            liveError = '激活实时会话失败：' + errText(e);
            diag.resume = errText(e);
            if (e && e.stack) diag.resumeStack = String(e.stack).split('\n').slice(0, 8).join(' | ');
            log(`警告：会话 ${dshId} 激活失败：${errText(e)}`);
          }
        } else {
          liveError = '宿主未提供 agents 服务（需重启 dsh 才能在侧边栏即时看到）';
          diag.resume = 'no agents service';
        }

        // 关键 3：诊断——用真实查询/代理服务核验「点开路径」能不能拿到数据。
        // 把每一步的真实结果/报错都放进 diag，直接回传给设置面板。
        const q = (() => { try { return typeof getService === 'function' ? getService('sessionQuery') : undefined; } catch (e) { diag.getSessionQuery = errText(e); return undefined; } })();
        if (q && typeof q.observeSession === 'function') {
          try {
            const obs = await q.observeSession(dshId);
            diag.observe = `ok events=${obs && obs.events ? obs.events.length : '?'} cwd=${obs && obs.header ? obs.header.cwd : '?'}`;
          } catch (e) {
            diag.observe = 'observeSession 抛错：' + errText(e);
          }
        } else {
          diag.observe = 'no sessionQuery service';
        }
        const ag = (() => { try { return typeof getService === 'function' ? getService('agents') : undefined; } catch { return undefined; } })();
        if (ag && typeof ag.get === 'function') {
          try {
            const a = ag.get(dshId);
            diag.agentGet = a ? 'live agent 存在（点开应即时渲染）' : '无 live agent（点开会走 resume）';
          } catch (e) { diag.agentGet = 'agents.get 抛错：' + errText(e); }
        }

        importedMap.set(dsId, dshId);
        log(`导入成功：${dsTitle}（${turnCount} 轮）→ ${dshId}${attachError ? ' | ' + attachError : ''}${liveError ? ' | ' + liveError : ''}`);
        results.push({
          dsId,
          dshId,
          ok: true,
          title: `${dsTitle}${conf.titleSuffix}`,
          turns: turnCount,
          messages: paired.length,
          attached: !attachError,
          live: !liveError,
          note: attachError || liveError || undefined,
          diag,
        });
      } catch (e) {
        results.push({ dsId, ok: false, error: errText(e) });
      }
    }
    return { ok: results.every((r) => r.ok), results };
  }

  async function status() {
    const h = await host.status();
    return { host: h };
  }

  return { list, importSessions, status, cfg };
}
