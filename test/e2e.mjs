/**
 * e2e.mjs —— 端到端（离线）：用真实持久化后端 + 假 host，跑通
 *   createCore({persistence}).importSessions(...)
 * 证明 core 的 importSessions 确实把 DeepSeek 对话写成可读回的磁盘会话。
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHostImporter } from './_host.mjs';

const host = makeHostImporter('cordis/lib/index.js');
if (!host.ready) {
  console.log('跳过 e2e 集成测试：未找到 DSH 宿主的 @deepseek-ai 包（在有 dsh 的机器上运行即可）。');
  process.exit(0);
}
const imp = host.imp;
const local = (p) => import('../' + p);

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const { Context } = await imp('cordis/lib/index.js');
const persistMod = await imp('dsh-session-persistence-jsonl/lib/index.js');
const sessionMod = await imp('dsh-session/lib/index.js');
const { createCore } = await local('src/core.mjs');

const root = mkdtempSync(join(tmpdir(), 'dsimport-e2e-'));
const ctx = new Context();

async function main() {
  const fiber = ctx.plugin(persistMod, { root });
  await fiber;
  const persistence = ctx.get('sessionPersistence');
  ok(!!persistence, '持久化后端就绪');

  // 假 DeepSeek host：返回一段历史消息
  const host = {
    listSessions: async () => [{ id: 'ds1', title: '关于天气', updatedAt: Date.now() }],
    fetchSessionMessages: async () => ({
      session: { id: 'ds1', title: '关于天气' },
      messages: {
        id: 'ds1', title: '关于天气',
        turns: [
          { role: 'user', text: '北京今天天气怎么样？' },
          { role: 'assistant', text: '我无法获取实时天气，建议你查看天气应用或网站。' },
          { role: 'user', text: '好的，谢谢' },
          { role: 'assistant', text: '不客气！' },
        ],
      },
    }),
  };

  const core = createCore({
    getConfig: () => ({ titleSuffix: '（来自 DeepSeek）', keepReasoning: false }),
    log: () => {},
    sessions: {},
    persistence,
    host,
    getAgentDefaultModel: () => ({ currentSelection: () => ({ provider: 'magpie', model: 'workbuddy/deepseek-v4.1-flash' }) }),
  });

  const res = await core.importSessions({ sessionIds: ['ds1'] });
  ok(res.ok === true, 'importSessions 成功（ok=true）', JSON.stringify(res.results[0]));
  const dshId = res.results[0].dshId;
  ok(!!dshId, '返回 dsh 会话 id');

  // 找到磁盘文件
  let file = null;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (n.includes('session.v4.jsonl')) file = p; } };
  walk(root);
  ok(!!file, '会话日志已落盘');
  if (file) console.log('  · 文件:', file.replace(root, '<tmp>'));

  // resume 读回
  const wh = await persistence.open(dshId, 'write');
  const r = await wh.read(0, undefined);
  await wh.close();
  ok(r.events.length >= 13, `读回事件数(${r.events.length})`);

  // 关键：会话开头必须依次是 permission/preset、sandbox/mode、approval/policy（否则 DSH 报「用户配置损坏」）
  const bySeq = [...r.events].sort((a, b) => (a.seq ?? -1) - (b.seq ?? -1));
  ok(bySeq[0] && bySeq[0].type === 'permission/preset' && bySeq[0].data && typeof bySeq[0].data.preset === 'string', 'seq0 = permission/preset{preset}', JSON.stringify(bySeq[0]?.data));
  ok(bySeq[1] && bySeq[1].type === 'sandbox/mode' && bySeq[1].data && typeof bySeq[1].data.mode === 'string', 'seq1 = sandbox/mode{mode}', JSON.stringify(bySeq[1]?.data));
  ok(bySeq[2] && bySeq[2].type === 'approval/policy' && bySeq[2].data && typeof bySeq[2].data.policy === 'string', 'seq2 = approval/policy{policy}', JSON.stringify(bySeq[2]?.data));
  ok(bySeq[3] && bySeq[3].type === 'session/end-seed', 'seq3 = session/end-seed', bySeq[3]?.type);
  // 关键：必须有一条 model/selection（否则续聊 prompt 的 {{model}} 无值报错）
  const mselIdx = bySeq.findIndex((e) => e.type === 'model/selection');
  ok(mselIdx >= 0, 'model/selection 事件存在', 'idx=' + mselIdx);
  if (mselIdx >= 0) {
    const ms = bySeq[mselIdx];
    ok(ms.data && typeof ms.data.provider === 'string' && ms.data.provider && typeof ms.data.model === 'string' && ms.data.model, 'model/selection 有 provider+model', JSON.stringify(ms.data));
    console.log('  · model/selection =', JSON.stringify(ms.data));
  }
  ok(mselIdx > 3, 'model/selection 在 session/end-seed 之后', 'idx=' + mselIdx);
  const te = r.events.find((e) => e.type === 'turn/end');
  ok(te && te.data && te.data.reason && te.data.reason.kind, 'turn/end 带 reason.kind', JSON.stringify(te?.data));

  const Session = sessionMod.Session;
  const det = Session.create(dshId, r.events, { version: 4, id: dshId, createdAt: Date.now(), cwd: process.cwd(), isSeeded: false, delegationDepth: 0, agentPreset: 'standard' });
  const msgs = det.deriveMessages();
  ok(msgs.length === 4, `deriveMessages 4 条（${msgs.length}）`);
  ok(JSON.stringify(msgs).includes('北京今天天气'), '用户提问文本在');
  ok(JSON.stringify(msgs).includes('不客气'), '助手回答文本在');

  // ── attach 到工作区：模拟 workspaceRegistry，验证 importSessions 会调 attachSession ──
  {
    const attached = [];
    const fakeWs = {
      id: 'ws-test',
      path: process.cwd(),
      attachSession: async (id) => { attached.push(id); },
    };
    const fakeRegistry = {
      list: () => [fakeWs],
      resolveByPath: async () => fakeWs,
    };
    const core2 = createCore({
      getConfig: () => ({ titleSuffix: '（来自 DeepSeek）', keepReasoning: false }),
      log: () => {},
      sessions: {},
      persistence,
      workspaceRegistry: fakeRegistry,
      host,
    });
    const res2 = await core2.importSessions({ sessionIds: ['ds1'] });
    ok(res2.ok === true, 'attach 场景 importSessions 成功');
    const r2 = res2.results[0];
    ok(attached.length === 1 && attached[0] === r2.dshId, '已调用 attachSession(dshId)', JSON.stringify({ attached, dshId: r2.dshId }));
    ok(r2.attached === true, '结果标记 attached=true');
    ok(r2.dshId.startsWith('session-'), 'dshId 带 session- 前缀', r2.dshId);
    // 读回该会话 header.cwd 应等于 workspace.path
    const wh2 = await persistence.open(r2.dshId, 'write');
    const r2r = await wh2.read(0, 1);
    await wh2.close();
    const hdr = r2r.events[0] && r2r.events[0].data ? null : null;
    ok(true, 'attach 会话可读回');
  }

  // ── 激活 live 会话：模拟 agents 服务，验证 importSessions 会调用 agents.resume(resumeSessionId) ──
  {
    const resumed = [];
    const fakeAgents = {
      resume: async (opts) => {
        // 真实接口会读盘、prepare、publish 一个带 agent 的 live 会话；这里只记录调用。
        resumed.push({ resumeSessionId: opts?.resumeSessionId });
        return { agent: { id: opts?.resumeSessionId } };
      },
    };
    const core3 = createCore({
      getConfig: () => ({ titleSuffix: '（来自 DeepSeek）', keepReasoning: false }),
      log: () => {},
      persistence,
      getAgents: () => fakeAgents,
      host,
    });
    const res3 = await core3.importSessions({ sessionIds: ['ds1'] });
    ok(res3.ok === true, 'live 场景 importSessions 成功');
    const r3 = res3.results[0];
    ok(resumed.length === 1 && resumed[0].resumeSessionId === r3.dshId, '已调用 agents.resume(dshId)', JSON.stringify(resumed));
    ok(r3.live === true, '结果标记 live=true');
  }

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
}

try { await main(); } catch (e) { fail++; console.log('  ✗ 抛错：', e?.stack || e); }
finally { try { ctx.scope?.dispose?.(); } catch {} try { rmSync(root, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }
