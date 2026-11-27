/**
 * syntax.mjs —— 冒烟测试：不启动真实浏览器，验证插件骨架能加载、
 * apply 能注册工具/服务/路由，且各源模块能被 import（语法/导出正确）。
 * 用法：node test/syntax.mjs
 */
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const imp = (p) => import(pathToFileURL(join(ROOT, p)).href);

let failed = 0;
const ok = (name, cond, extra = '') => {
  console.log(`${cond ? '✓' : '✗'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!cond) failed += 1;
};

// 1) 源模块能被 import 且导出齐全
const parse = await imp('src/parse.mjs');
ok('parse.mjs 导出 parseSessionList', typeof parse.parseSessionList === 'function');
ok('parse.mjs 导出 parseHistoryMessages', typeof parse.parseHistoryMessages === 'function');
ok('parse.mjs 导出 pairTurns', typeof parse.pairTurns === 'function');

const convert = await imp('src/convert.mjs');
ok('convert.mjs 导出 buildSessionEvents', typeof convert.buildSessionEvents === 'function');
ok('convert.mjs 导出 uuid', typeof convert.uuid === 'function');

const coreMod = await imp('src/core.mjs');
ok('core.mjs 导出 createCore', typeof coreMod.createCore === 'function');

// 2) 解析 + 转换端到端（纯函数，不依赖宿主）
const sampleList = {
  biz_data: {
    chat_sessions: [
      { id: 'abc', title: '关于天气的对话', updated_at: 1700000000, pinned: false },
      { id: 'def', title: '代码问题', updated_at: 1700001000, pinned: true },
    ],
    has_more: false,
  },
};
const parsedList = parse.parseSessionList(sampleList);
ok('parseSessionList 得到 2 条', parsedList.items.length === 2, JSON.stringify(parsedList.items.map((x) => x.id)));
ok('parseSessionList hasMore=false', parsedList.hasMore === false);

const sampleHistory = {
  biz_data: {
    session: { id: 'abc', title: '关于天气的对话' },
    chat_messages: [
      { message_id: 'm1', parent_id: null, role: 'USER', fragments: [{ type: 'REQUEST', content: '今天天气如何' }] },
      { message_id: 'm2', parent_id: 'm1', role: 'ASSISTANT', fragments: [
        { type: 'THINK', content: '用户在问天气……' },
        { type: 'RESPONSE', content: '我无法获取实时天气。' },
      ] },
    ],
  },
};
const parsedHist = parse.parseHistoryMessages(sampleHistory);
ok('parseHistoryMessages 得 2 turns', parsedHist.turns.length === 2);
ok('默认丢弃 THINK', !parsedHist.turns[1].text.includes('用户在问天气'), parsedHist.turns[1].text);
const paired = parse.pairTurns(parsedHist.turns);
const built = convert.buildSessionEvents(paired, { baseTime: Date.now() });
ok('buildSessionEvents 产出 6 事件/turn', built.events.length === 6 * built.turnCount, `events=${built.events.length} turns=${built.turnCount}`);
const am = built.events.find((e) => e.type === 'assistant/message');
ok('assistant/message 含 message.id', Boolean(am && am.data.message.id));
ok('assistant/message 含 stream', Boolean(am && Array.isArray(am.data.stream) && am.data.stream.length));

// 3) apply 注册行为（mock ctx）
const registeredTools = [];
const provided = {};
let routeRegistered = false;
const fakeCtx = {
  get: (k) => (k === 'sessionPersistence' ? { create: async () => { throw new Error('stub'); } } : undefined),
  logger: () => () => {},
  effect: (fn) => {
    try { fn(); } catch {}
    return () => {};
  },
  tools: { register: (t) => { registeredTools.push(t); } },
  provide: (k, v) => { provided[k] = v; },
  webServer: { register: () => { routeRegistered = true; } },
  connection: { requestRejection: () => 0 },
  sessions: { create: () => {}, flush: async () => {} },
};

const indexMod = await imp('lib/index.js');
ok('index.js 导出 name=dsh-dsimport', indexMod.name === 'dsh-dsimport');
ok('index.js 导出 apply', typeof indexMod.apply === 'function');
ok('index.js inject 含 connection，且不含 sessions（sessions 用 ctx.get 动态取）', Array.isArray(indexMod.inject) && indexMod.inject.includes('connection') && !indexMod.inject.includes('sessions'));

await indexMod.apply(fakeCtx, {});
ok('注册了 3 个工具', registeredTools.length === 3, registeredTools.map((t) => t.name).join(','));
ok('提供 dsimport 服务', Boolean(provided.dsimport && typeof provided.dsimport.list === 'function'));
ok('注册了 HTTP 路由', routeRegistered);

// 4) core 的 importSessions 在 sessions.create 失败时能优雅报错（不崩）
const badCore = coreMod.createCore({
  getConfig: () => ({ titleSuffix: '（来自 DeepSeek）' }),
  log: () => {},
  sessions: {},
  persistence: { create: async () => { throw new Error('no store'); } },
  host: {
    status: () => ({ connected: false, port: 1, busy: false }),
    listSessions: async () => [{ id: 'x', title: 't', updatedAt: 0 }],
    fetchSessionMessages: async () => ({ session: { title: 't' }, messages: sampleHistory.biz_data.chat_messages }),
  },
});
const r = await badCore.importSessions({ sessionIds: ['x'] });
ok('importSessions 建会话失败时返回 ok=false 不抛', r.ok === false && r.results[0].ok === false, r.results[0].error);

console.log(`\n${failed === 0 ? '全部通过 ✅' : `失败 ${failed} 项 ❌`}`);
process.exit(failed === 0 ? 0 : 1);
