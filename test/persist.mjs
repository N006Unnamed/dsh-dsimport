/**
 * persist.mjs —— 集成验证：用真实的 jsonl 持久化后端，在临时目录
 *   apply(ctx) → ctx.sessionPersistence.create(header) → handle.append(带 seq/time 事件) → close()
 * 再 open(id,'read') → read() 读回，验证：
 *   ① 日志确实落盘（能找到 .jsonl.zstd 文件）
 *   ② 读回的 events 数量/seq 连续正确
 *   ③ 用 dsh-session 的 Session 还原出 user/assistant 消息（可续聊的前提）
 *
 * 不碰用户真实 sessions，全在 tmp 目录。
 */
import { mkdtempSync, rmSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeHostImporter } from './_host.mjs';

const host = makeHostImporter('cordis/lib/index.js');
if (!host.ready) {
  console.log('跳过 persist 集成测试：未找到 DSH 宿主的 @deepseek-ai 包（在有 dsh 的机器上运行即可）。');
  process.exit(0);
}
const imp = host.imp;

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) { pass++; console.log('  ✓', m); } else { fail++; console.log('  ✗', m); } };

const { Context } = await imp('cordis/lib/index.js');
const persistMod = await imp('dsh-session-persistence-jsonl/lib/index.js');
const sessionMod = await imp('dsh-session/lib/index.js');
const { buildSessionEvents } = await import('../src/convert.mjs');

const root = mkdtempSync(join(tmpdir(), 'dsimport-persist-'));
const ctx = new Context();

async function main() {
  // 挂载持久化后端到临时 root
  const fiber = ctx.plugin(persistMod, { root });
  await fiber;
  const persistence = ctx.get('sessionPersistence');
  ok(!!persistence, '拿得到 ctx.sessionPersistence');

  // 造一段两轮对话
  const paired = [
    { role: 'user', text: '你好，介绍一下你自己' },
    { role: 'assistant', text: '我是 DeepSeek，一个乐于助人的 AI 助手。' },
    { role: 'user', text: '今天天气怎么样？' },
    { role: 'assistant', text: '抱歉，我无法获取实时天气，建议你查看天气应用。' },
  ];
  const { events, turnCount } = buildSessionEvents(paired, { baseTime: Date.now() });
  ok(turnCount === 2, 'convert 产出 2 轮');

  const dshId = 'import-test-' + Date.now();
  const createdAt = Date.now();
  const header = { version: 4, id: dshId, createdAt, cwd: 'C:\\tmp\\w', isSeeded: false, delegationDepth: 0, agentPreset: 'standard' };

  const handle = await persistence.create(header);
  ok(!!handle, 'create 拿到 write handle');

  const stored = [];
  let seq = 0, t = createdAt;
  stored.push({ type: 'session/title', seq: seq++, time: t, data: { title: '导入的对话（来自 DeepSeek）', messageSeqs: [], source: { kind: 'user' } } });
  for (const ev of events) {
    const item = { type: ev.type, seq: seq++, time: (t += 3), data: ev.data };
    if (ev.surfaceOp) item.surfaceOp = ev.surfaceOp;
    stored.push(item);
  }
  await handle.append(stored);
  await handle.close();
  console.log('  · 已写入', stored.length, '条事件');

  // 文件落盘检查
  let found = false;
  const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); if (s.isDirectory()) walk(p); else if (n.includes('session.v4.jsonl')) found = true; } };
  walk(root);
  ok(found, '日志文件已落盘（.jsonl.zstd 存在）');

  // 读回
  const rh = await persistence.open(dshId, 'read');
  const r = await rh.read(0, undefined);
  ok(Array.isArray(r.events) && r.events.length === stored.length, `读回事件数一致（${r.events?.length} == ${stored.length}）`);
  ok(r.events.every((e, i) => e.seq === i), '读回 seq 从 0 连续');

  // 模拟网关 resume：以 write 身份再打开一次（agent-loop resume 就是 open(id,'write')）
  let rw;
  try {
    const wh = await persistence.open(dshId, 'write');
    rw = await wh.read(0, undefined);
    await wh.close();
    ok(Array.isArray(rw.events) && rw.events.length === stored.length, `resume(open write) 读回事件数一致（${rw.events?.length}）`);
  } catch (e) {
    ok(false, 'resume(open write) 失败：' + (e?.message || e));
  }

  // 用 dsh-session 还原消息（可续聊的核心）
  const Session = sessionMod.Session;
  const det = Session.create(dshId, r.events, header);
  const msgs = det.deriveMessages();
  ok(msgs.length === 4, `deriveMessages 还原 4 条消息（实际 ${msgs.length}）`);
  const userMsg = msgs.find((m) => m.role === 'user');
  ok(!!userMsg && JSON.stringify(userMsg.content).includes('介绍一下你自己'), '用户消息文本正确');
  const asstMsg = msgs.find((m) => m.role === 'assistant');
  ok(!!asstMsg && JSON.stringify(asstMsg.content).includes('乐于助人'), '助手消息文本正确');

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
}

try { await main(); } catch (e) { fail++; console.log('  ✗ 抛错：', e?.stack || e); }
finally { try { ctx.scope.dispose?.(); } catch {} try { rmSync(root, { recursive: true, force: true }); } catch {} process.exit(fail ? 1 : 0); }
