/**
 * dsh-dsimport —— 把 DeepSeek 网页（chat.deepseek.com）的历史对话导入为 dsh 会话。
 *
 * 数据来源：**宿主内专用浏览器 + 页面内 fetch**（鉴权用 Bearer token，token 从页面
 *   localStorage['userToken'] 取）。DeepSeek 读取接口是干净 JSON、无需签名/PoW。
 * 写入：用真实 ctx.sessions.create() + session.append() 建**可续聊的真会话**，
 *   不手搓 zstd 存储（格式已用真实 dsh-session 验证）。
 *
 * 对外提供：
 *   ① 模型工具：dsimport_list / dsimport_import / dsimport_status
 *   ② 跨插件服务：ctx.provide('dsimport', { list, importSessions, status })
 *   ③ 设置面板：Web UI「设置 → DeepSeek 导入」卡片（client.js 注册到 settings.section）
 *
 * 依赖解析走 hostdeps 模式（桌面 profile 不装 optional peer，裸 import 会让整条插件不激活）。
 */
import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

import { loadHostDeps } from './hostdeps.mjs';
import { DsHost } from './ds-host.js';
import { createCore } from '../src/core.mjs';
import { createRoutes } from './routes.mjs';
import { dsimportConfigSchema } from './config-schema.mjs';

const PLUGIN_ID = 'dsh-dsimport';
const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

const hostDeps = await loadHostDeps();
const z = hostDeps.z;
const defineTool = hostDeps.defineTool;

export const name = PLUGIN_ID;
// webServer：HTTP 路由；tools：注册模型工具。
// connection：DSH 访问检查（requestRejection），防止浏览器里任意网页跨域调用这些路由。
// 注：sessions / sessionPersistence / workspaceRegistry 都用 ctx.get(...) 动态取，不写进 inject。
//   —— 'sessions' 并非根 ctx 上稳定可注入的服务（SessionStore 挂在其自身作用域），
//   写进 inject 会导致插件永远 pending、apply 永不执行 → 路由不注册 → 设置面板 404/一直“加载中”。
//   （持久化后端 sessionPersistence 与 agent-loop 一致用 ctx.get 动态取。）
export const inject = ['webServer', 'tools', 'connection'];

export const Config = z === null ? undefined : dsimportConfigSchema(z);

function deepMerge(base, over) {
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObj(base)) return isObj(over) ? { ...over } : over === undefined ? base : over;
  const out = { ...base };
  if (!isObj(over)) return out;
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) continue;
    out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  }
  return out;
}

function configPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, PLUGIN_ID, 'config.json');
}

function readConfigFile(path = configPath()) {
  if (!existsSync(path)) return { ok: true, value: {} };
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    return { ok: false, error: String(error) };
  }
  text = text.replace(/^\uFEFF/, '');
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const value = JSON.parse(text);
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { ok: false, error: '最外层不是 {}' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

function saveConfigFile(patch, path = configPath()) {
  const cur = readConfigFile(path);
  if (!cur.ok) throw new Error(`${PLUGIN_ID} 配置格式不对，没保存（${cur.error}）。先把文件改对（或删掉）再设置`);
  const next = deepMerge(cur.value, patch);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
  renameSync(tmp, path);
  return next;
}

function objectSchema(props) {
  const properties = {};
  const required = [];
  for (const [k, v] of Object.entries(props)) {
    const { required: req, ...rest } = v;
    properties[k] = rest;
    if (req === true) required.push(k);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function sessionLines(items) {
  return items
    .map((it, i) => {
      const when = it.updatedAt ? new Date(it.updatedAt * (it.updatedAt < 1e12 ? 1000 : 1)).toLocaleString('zh-CN') : '';
      const flag = it.imported ? '（已导入）' : '';
      return `${i + 1}. ${it.title}${flag}${when ? ` ｜ ${when}` : ''}\n   id: ${it.id}`;
    })
    .join('\n');
}

export async function apply(ctx, hostConfig) {
  const log = (msg) => {
    try {
      ctx.logger?.('info')?.('[dsh-dsimport]', String(msg));
    } catch {
      /* ignore */
    }
  };
  for (const n of hostDeps.notes) log(n);

  const fileCfg = readConfigFile();
  let current = deepMerge(hostConfig ?? {}, fileCfg.ok ? fileCfg.value : {});

  const getConfig = () => current;
  const saveConfig = (patch) => {
    current = deepMerge(current, patch);
    try {
      saveConfigFile(patch);
    } catch (e) {
      log(`保存配置失败：${e?.message ?? e}`);
      throw e;
    }
    return current;
  };

  const host = new DsHost({
    pluginDir: join(process.env.DSH_HOME || join(homedir(), '.dsh'), PLUGIN_ID),
    port: Number(current.browserPort) || 47892,
    log,
  });

  // 注意：cordis 的 ctx 是 Proxy，访问未在 inject 里声明的服务属性（ctx.sessionPersistence）
  // 会**直接抛错**「cannot get property "xxx" without inject」。只能用 ctx.get(name) 动态取，
  // 绝不能写 `|| ctx.xxx` 或 catch 里再摸 ctx.xxx —— 那会让 apply 一进来就抛、路由永不注册。
  const getService = (name) => {
    try { return typeof ctx.get === 'function' ? ctx.get(name) : undefined; } catch { return undefined; }
  };

  const persistence = getService('sessionPersistence');
  if (!persistence) log('警告：未找到 sessionPersistence 服务，导入将无法落盘。');

  // 工作区注册表：导入的会话必须挂到 workspace 成员表（workspace.json 的 sessionIds），
  // 否则只写盘、不进左侧对话侧边栏。**惰性取**（在真正导入时再取），
  // 因为 apply 执行时该服务可能尚未 active（cordis ctx.get 严格模式对未激活的服务返回 undefined）。
  const getWorkspaceRegistry = () => getService('workspaceRegistry');

  // 权限预设：用来生成会话开头的 permission/preset、sandbox/mode、approval/policy 三个事件，
  // 缺了它们 DSH 打开会话会报「用户配置损坏」。同样惰性取。
  const getPermissionPresets = () => getService('permissionPresets');

  // 会话 store（ctx.sessions）：仅作兼容保留（导入写盘后不再用它建 live 会话）。
  const getSessions = () => getService('sessions');

  // agents 服务：导入写盘后用它 `agents.resume({resumeSessionId})` 把会话激活成 live 会话——
  // 这是 dsh 打开任何「已持久化但当前未打开」会话的标准路径：既触发 session/created（侧边栏
  // 即时出现），又能让用户点开时 resolve() 直接拿到 live agent（不空白、可续聊）。
  // 绝不能用 ctx.sessions.create 造半成品 live 会话（没有 agent，点开会 resume 抢锁失败→空白）。
  const getAgents = () => getService('agents');

  // 默认模型：导入会话必须写入一条 model/selection 事件，否则续聊时组装 prompt 的
  // deployment:persona-prefix 段里 {{model}} 无值，报错 "prompt variable {{model}} has no value"。
  // 值取自 agentDefaultModel.currentSelection()（{provider,model,reasoningEffort?}），惰性取。
  const getAgentDefaultModel = () => getService('agentDefaultModel');

  const core = createCore({ getConfig, log, persistence, getSessions, getAgents, getWorkspaceRegistry, getPermissionPresets, getAgentDefaultModel, getService, host });

  // ── HTTP 路由（设置面板） ──
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'prefix',
        path: `/api/plugins/${PLUGIN_ID}`,
        handler: createRoutes({ getConfig, saveConfig, core, host, log, uiDir: join(PLUGIN_DIR, 'lib'), connection: ctx.connection }),
      }),
    'dsh-dsimport: api',
  );

  // ── 跨插件服务：别的插件 ctx.get('dsimport') 拿到 ──
  const service = {
    list: async (opts) => (await core.list(opts || {})),
    importSessions: async (opts) => core.importSessions(opts || {}),
    status: () => core.status(),
  };
  ctx.provide('dsimport', service);

  // ── 模型工具 ──
  const textOutput = {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  };

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'dsimport_list',
          description: '列出 DeepSeek 网页（chat.deepseek.com）上的历史对话（标题、更新时间、id）。需要先在插件设置里打开登录窗口并登录。',
          parameters: objectSchema({
            limit: { type: 'number', description: '最多列出多少条，缺省 100' },
          }),
          output: textOutput,
          async execute(args) {
            const items = await core.list({ limit: args.limit || 100 });
            if (!items.length) return '没列出任何对话（可能未登录，或网页上没有历史对话）。';
            return `DeepSeek 网页历史对话（${items.length} 条）：\n${sessionLines(items)}\n\n要导入哪几条，告诉我标题或编号，或去设置面板勾选。`;
          },
        }),
        'dsh-dsimport: dsimport_list',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'dsimport_import',
          description: '把指定的 DeepSeek 网页对话导入为 dsh 会话（导入后可见、可继续追问，标题带「（来自 DeepSeek）」）。按 id 或按标题关键字选择要导入的对话。',
          parameters: objectSchema({
            sessionIds: { type: 'string', description: '要导入的会话 id，多个用逗号分隔（优先用这个）' },
            titles: { type: 'string', description: '或按标题关键字选（逗号分隔，模糊匹配标题）' },
          }),
          output: textOutput,
          async execute(args) {
            let ids = String(args.sessionIds || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
            if (ids.length === 0 && args.titles) {
              const wanted = String(args.titles).split(/[,，]/).map((s) => s.trim()).filter(Boolean);
              const list = await core.list({ limit: 200 });
              ids = list.filter((it) => wanted.some((w) => it.title.includes(w))).map((it) => it.id);
            }
            if (ids.length === 0) return '没指定要导入的对话。先调用 dsimport_list 看有哪些，再用 id 或标题导入。';
            const r = await core.importSessions({ sessionIds: ids });
            const okList = r.results.filter((x) => x.ok);
            const failList = r.results.filter((x) => !x.ok);
            let out = `已导入 ${okList.length} 个对话到 dsh：\n`;
            out += okList.map((x) => `· ${x.title}（${x.turns} 轮）→ dsh 会话 ${x.dshId}`).join('\n');
            if (failList.length) out += `\n\n失败 ${failList.length} 个：\n` + failList.map((x) => `· ${x.dsId}：${x.error}`).join('\n');
            return out;
          },
        }),
        'dsh-dsimport: dsimport_import',
      ),
  );

  ctx.effect(
    () =>
      ctx.tools.register(
        defineTool({
          name: 'dsimport_status',
          description: '查看 DeepSeek 导入插件状态：浏览器是否连接、是否已登录、端口。',
          parameters: objectSchema({}),
          output: textOutput,
          async execute() {
            const st = await core.status();
            const h = st.host || {};
            const logged = h.connected ? await host.isLoggedIn().catch(() => false) : false;
            return `浏览器：${h.connected ? '已连接' : '未连接'}（端口 ${h.port}）\n登录：${logged ? '已登录 DeepSeek' : '未登录/未知'}\n提示：未登录时去 dsh 设置 → DeepSeek 导入 → 点「打开登录窗口」扫码登录。`;
          },
        }),
        'dsh-dsimport: dsimport_status',
      ),
  );

  log('已就绪');
}
