/**
 * parse.mjs —— 解析 DeepSeek 网页 API 的响应（fetch_page 会话列表 / history_messages 消息）。
 *
 * fetch_page 返回：{ biz_code, biz_data: { chat_sessions: [ {id, title, updated_at, ...} ], has_more } }
 * history_messages 返回：{ biz_code, biz_data: { chat_messages: [ { message_id, parent_id, role, fragments:[{type,content}] } ] } }
 *   - role: 'USER' | 'ASSISTANT'（大小写兼容）
 *   - fragments[].type: 'REQUEST'（用户提问） / 'THINK'（思考，导入时默认丢弃） / 'RESPONSE'（回答正文）
 */

function pickArray(obj, keys) {
  if (!obj || typeof obj !== 'object') return [];
  for (const k of keys) {
    if (Array.isArray(obj[k])) return obj[k];
  }
  return [];
}

/**
 * 把响应剥到「真正含目标数组」的那层对象。
 * DeepSeek 真实返回形如：{code:0, data:{biz_code:0, biz_data:{chat_sessions:[...]}}}
 * 旧版/导出又可能是 {biz_code, biz_data:{...}} 或直接 {...}。逐层下探，找到含任一 key 数组的对象。
 */
function unwrapBiz(json, keys) {
  let cur = json;
  const seen = new Set();
  for (let i = 0; i < 6 && cur && typeof cur === 'object' && !seen.has(cur); i += 1) {
    seen.add(cur);
    if (keys.some((k) => Array.isArray(cur[k]))) return cur;
    // 依次尝试 data / biz_data 下钻（哪个存在走哪个）
    const next = cur.biz_data && typeof cur.biz_data === 'object' ? cur.biz_data
      : (cur.data && typeof cur.data === 'object' ? cur.data : null);
    if (!next) break;
    cur = next;
  }
  // 没找到数组：返回能拿到的最深对象，让上层按空数组处理
  return cur && typeof cur === 'object' ? cur : {};
}

/** 归一化一个会话条目。 */
function normSession(s) {
  if (!s || typeof s !== 'object') return null;
  const id = String(s.id ?? s.chat_session_id ?? s.session_id ?? '').trim();
  if (!id) return null;
  return {
    id,
    title: String(s.title ?? s.name ?? '').trim() || '（无标题对话）',
    updatedAt: Number(s.updated_at ?? s.updatedAt ?? 0) || 0,
    modelType: s.model_type ?? s.modelType ?? '',
    pinned: Boolean(s.pinned),
  };
}

/** 解析会话列表响应（容忍多层包裹）。 */
export function parseSessionList(json) {
  const data = unwrapBiz(json, ['chat_sessions', 'sessions', 'chat_session_list', 'list']);
  const arr = pickArray(data, ['chat_sessions', 'sessions', 'chat_session_list', 'list']);
  const items = arr.map(normSession).filter(Boolean);
  const hasMore = Boolean(data.has_more ?? data.hasMore);
  return { items, hasMore };
}

/** 把一个 message 的 fragments 拼成纯文本；keepThinking=false 时丢弃 THINK。 */
function messageText(msg, keepThinking) {
  const frags = Array.isArray(msg.fragments) ? msg.fragments : [];
  const parts = [];
  for (const f of frags) {
    const type = String(f && f.type || '').toUpperCase();
    const content = f && (f.content ?? '');
    if (typeof content !== 'string' || !content.trim()) continue;
    if (type === 'THINK' || type === 'REASONING') {
      if (keepThinking) parts.push(content);
      else continue; // 默认丢弃思考
    } else {
      // REQUEST / RESPONSE / 其它可见片段
      parts.push(content);
    }
  }
  return parts.join('\n\n').trim();
}

/** 判断一个 message 在 dsh 视角的角色：user / assistant / skip。 */
function messageRole(msg) {
  const role = String(msg && msg.role || '').toUpperCase();
  if (role === 'USER' || role === 'HUMAN') return 'user';
  if (role === 'ASSISTANT' || role === 'AI' || role === 'BOT') return 'assistant';
  // 有些版本 role 不在顶层，看 fragments 类型判断
  const frags = Array.isArray(msg && msg.fragments) ? msg.fragments : [];
  if (frags.some((f) => String(f && f.type || '').toUpperCase() === 'REQUEST')) return 'user';
  if (frags.some((f) => ['RESPONSE', 'THINK'].includes(String(f && f.type || '').toUpperCase()))) return 'assistant';
  return 'skip';
}

/**
 * 解析消息历史响应，返回按父链排序后的问答轮次。
 * @returns {{ id, title, turns: Array<{role:'user'|'assistant', text:string}> }}
 */
export function parseHistoryMessages(json, { keepThinking = false } = {}) {
  const data = unwrapBiz(json, ['chat_messages', 'messages', 'list']);
  const msgs = pickArray(data, ['chat_messages', 'messages', 'list']);
  const session = data.session || data.chat_session || {};

  // 建立 id -> msg 映射，按 parent 链还原顺序
  const byId = new Map();
  for (const m of msgs) {
    if (!m || typeof m !== 'object') continue;
    const id = String(m.message_id ?? m.id ?? '').trim();
    if (id) byId.set(id, m);
  }

  // 找根（parent_id 不在集合内），然后 DFS 沿子链展开（DeepSeek 是树，取主链）
  const children = new Map();
  const roots = [];
  for (const m of msgs) {
    const id = String(m.message_id ?? m.id ?? '').trim();
    if (!id) continue;
    const pid = String(m.parent_id ?? m.parentId ?? '').trim();
    if (!pid || !byId.has(pid)) {
      roots.push(id);
    } else {
      if (!children.has(pid)) children.set(pid, []);
      children.get(pid).push(id);
    }
  }
  // 优先取第一个根；无根则按原顺序
  const ordered = [];
  if (roots.length) {
    // 沿主链 DFS（每层取第一个子）
    let cur = roots[0];
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      ordered.push(byId.get(cur));
      const kids = children.get(cur) || [];
      cur = kids[0];
    }
    // 若主链没覆盖全部（多分支），补上剩下的到末尾（去重）
    if (ordered.length < msgs.length) {
      for (const m of msgs) {
        const id = String(m.message_id ?? m.id ?? '').trim();
        if (id && !seen.has(id)) { seen.add(id); ordered.push(m); }
      }
    }
  } else {
    ordered.push(...msgs);
  }

  const turns = [];
  for (const m of ordered) {
    const role = messageRole(m);
    if (role === 'skip') continue;
    const text = messageText(m, keepThinking);
    if (!text) continue;
    turns.push({ role, text });
  }

  return {
    id: String(session.id ?? session.chat_session_id ?? '').trim(),
    title: String(session.title ?? '').trim(),
    turns,
  };
}

/**
 * 把一个会话的多条 assistant 回答拼成 dsh 历史（按轮次），
 * 保证 user/assistant 交替（DSH 会话最好成对）。
 * @returns {Array<{role:'user',text} | {role:'assistant',text}>}
 */
export function pairTurns(turns) {
  const out = [];
  let pendingUser = null;
  for (const t of turns) {
    if (t.role === 'user') {
      // 若上一个 user 还没配对，先补一个占位 assistant，保持交替
      if (pendingUser !== null) { out.push(pendingUser); out.push({ role: 'assistant', text: '（该轮没有可用的回答）' }); }
      pendingUser = t;
    } else if (t.role === 'assistant') {
      if (pendingUser === null) {
        // 没有 user 的孤立回答，补一个占位 user
        out.push({ role: 'user', text: '（导入的对话）' });
      } else {
        out.push(pendingUser);
        pendingUser = null;
      }
      out.push(t);
    }
  }
  if (pendingUser !== null) { out.push(pendingUser); out.push({ role: 'assistant', text: '（该轮没有可用的回答）' }); }
  return out;
}
