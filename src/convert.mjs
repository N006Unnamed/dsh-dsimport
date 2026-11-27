/**
 * convert.mjs —— 把 DeepSeek 的一段问答（turns）转成 DSH v4 会话的「事件序列」。
 *
 * DSH 会话是 append-only 事件日志。一轮正常对话大致是：
 *   turn/start → step/start → user/message(appended) → assistant/message(appended) → step/end → turn/end
 * 其中 surface 事件（user/message、assistant/message）要带 surfaceOp:'append'。
 * assistant/message 的 data.stream 必填：用最简的 text-chunks 记录承载整段回答文本。
 *
 * 这里只产出「data 对象 + 事件类型」，真正的 seq/time 由 core.mjs 追加时分配（走 ctx.sessions）。
 */

let _uid = 0;
/** 简单 uuid（避免依赖 crypto.randomUUID 在极端老环境的差异；Node22 有但保守起见自己生成）。 */
export function uuid() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch {}
  // 退化版本：时间戳 + 随机
  const rnd = () => Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, '0');
  const now = Date.now().toString(16).padStart(12, '0');
  _uid = (_uid + 1) & 0xffff;
  return `${rnd()}-${rnd().slice(0, 4)}-4${rnd().slice(1, 4)}-a${rnd().slice(1, 4)}-${now}${rnd()}${_uid.toString(16).padStart(4, '0')}`.slice(0, 36);
}

/**
 * 把 assistant 的整段文本包成最简 AssistantStreamRecord[]。
 * type:'text-chunks' 记录：{ type, time0, index, dt, texts }
 * 用一个 delta、一个整段落，足够让 DSH 渲染出正文。
 */
export function textStream(wholeText, time0 = Date.now()) {
  return [{ type: 'text-chunks', time0, index: 0, dt: [], texts: [String(wholeText ?? '')] }];
}

/**
 * 生成一条 model/selection 事件（会话级模型选择）。
 * DSH 续聊时组装 prompt（deployment:persona-prefix 段含 {{model}}）需要 modelSelection 投影有值，
 * 而该投影只由 `model/selection`（设 pending）或 `request/header`（设 lastUsed）推动。
 * 导入的会话没有任何 request/header，所以必须显式写一条 model/selection，
 * 否则续聊报：prompt variable "{{model}}" has no value for this assembly。
 * @param {{provider:string, model:string, reasoningEffort?:string}} sel
 * @returns {{type:string, data:object}}
 */
export function buildModelSelectionEvent(sel) {
  const data = { provider: String(sel.provider), model: String(sel.model) };
  if (sel.reasoningEffort !== undefined && sel.reasoningEffort !== null && sel.reasoningEffort !== '') {
    data.reasoningEffort = String(sel.reasoningEffort);
  }
  return { type: 'model/selection', data };
}

/**
 * 生成「一轮对话」的事件列表。
 * @param {object} p
 * @param {number} p.turn    第几轮（从 1 开始）
 * @param {number} p.step    第几步（固定 1）
 * @param {string} p.userText
 * @param {string} p.assistantText
 * @param {number} p.baseTime  该轮起始时间戳（ms）；内部会按顺序递增
 * @returns {Array<{type:string, data:any, surfaceOp?:string}>}
 */
export function buildTurnEvents({ turn, step = 1, userText, assistantText, baseTime = Date.now(), model }) {
  const events = [];
  let t = baseTime;
  const tick = (ms = 3) => (t += ms);

  const provider = (model && model.provider) || 'deepseek';
  const modelId = (model && model.model) || 'deepseek-chat';
  const msgSource = { kind: 'model', provider, model: modelId };
  if (model && model.reasoningEffort) msgSource.reasoningEffort = String(model.reasoningEffort);

  events.push({ type: 'turn/start', data: { turn } });
  events.push({ type: 'step/start', data: { turn, step } });

  // 用户消息
  events.push({
    type: 'user/message',
    surfaceOp: 'append',
    data: {
      content: [{ type: 'text', text: String(userText ?? '') }],
      source: { kind: 'user', clientTimeZone: 'Asia/Shanghai' },
      role: 'user',
      id: uuid(),
    },
  });

  // 助手消息（带最简 stream）
  events.push({
    type: 'assistant/message',
    surfaceOp: 'append',
    data: {
      turn,
      step,
      message: {
        id: uuid(),
        role: 'assistant',
        content: [{ type: 'text', text: String(assistantText ?? '') }],
        source: msgSource,
      },
      stream: textStream(assistantText, Date.now()),
    },
  });

  events.push({ type: 'step/end', data: { turn, step } });
  events.push({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
  return events;
}

/**
 * 把整段（已配对的）turns 转成按轮次的事件序列。
 * @param {Array<{role:'user',text}|{role:'assistant',text}>} paired 来自 parse.pairTurns
 * @param {{baseTime?:number}} opts
 * @returns {{ events: Array, turnCount: number }}
 */
export function buildSessionEvents(paired, { baseTime = Date.now(), model } = {}) {
  const events = [];
  let turn = 0;
  let i = 0;
  let t = baseTime;
  while (i < paired.length) {
    const u = paired[i];
    const a = paired[i + 1];
    if (u && a && u.role === 'user' && a.role === 'assistant') {
      turn += 1;
      const evs = buildTurnEvents({
        turn, step: 1, userText: u.text, assistantText: a.text, baseTime: t, model,
      });
      for (const e of evs) events.push(e);
      t += 1000 + Math.min(60000, (u.text.length + a.text.length) * 20);
      i += 2;
    } else if (u && u.role === 'user') {
      // 落单 user：配一个占位 assistant
      turn += 1;
      const evs = buildTurnEvents({ turn, step: 1, userText: u.text, assistantText: '（该轮没有可用的回答）', baseTime: t, model });
      for (const e of evs) events.push(e);
      t += 2000;
      i += 1;
    } else {
      // 落单 assistant：配一个占位 user
      turn += 1;
      const evs = buildTurnEvents({ turn, step: 1, userText: '（导入的对话）', assistantText: a ? a.text : '', baseTime: t, model });
      for (const e of evs) events.push(e);
      t += 2000;
      i += 1;
    }
  }
  return { events, turnCount: turn };
}
