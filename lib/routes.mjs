/**
 * routes.mjs —— 设置面板 / 导入用的 HTTP 路由（prefix: /api/plugins/dsh-dsimport）。
 *
 * 契约：
 *   GET  /state          → { ok, config, status:{host:{connected,port,busy}} }
 *   POST /config         → 保存设置（白名单字段）
 *   POST /login          → 打开登录窗口（返回当前登录态）
 *   GET  /login-status   → 当前是否已登录
 *   POST /stop           → 关掉浏览器
 *   POST /list           → { limit } → DeepSeek 网页会话列表（含 imported 标记）
 *   POST /import         → { sessionIds?: string[], all?: boolean, limit? } → 导入选中的会话到 dsh
 *   GET  /ui/panel.css   → 面板样式
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

function withTimeout(promise, ms, fallback) {
  let timer;
  const guard = new Promise((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
  return Promise.race([Promise.resolve(promise).catch(() => fallback), guard]).finally(() => clearTimeout(timer));
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * DSH 访问检查：优先用官方 ctx.connection.requestRejection（Host 反 DNS 重绑定
 * + Origin/跨域校验 + 浏览器令牌认证）。返回 401/403 即拒绝，undefined 才放行。
 */
function makeGuard(connection, logger) {
  return function reject(req) {
    if (!connection || typeof connection.requestRejection !== 'function') return 0;
    try {
      return connection.requestRejection(req) || 0;
    } catch (e) {
      logger(`访问检查异常：${String(e?.message ?? e)}`);
      return 403;
    }
  };
}

export function createRoutes({ getConfig, saveConfig, core, host, log, uiDir, connection }) {
  const logger = log ?? (() => {});
  const reject = makeGuard(connection, logger);
  return async function handler(req, res) {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(obj));
    };
    try {
      // DSH 访问检查放最前：CSS 与所有接口一律过闸。
      const denied = reject(req);
      if (denied) {
        res.writeHead(denied, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('forbidden');
        return;
      }
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname.replace('/api/plugins/dsh-dsimport', '') || '/';
      const method = req.method ?? 'GET';

      if (method === 'GET' && path === '/ui/panel.css') {
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache' });
        res.end(readFileSync(join(uiDir, 'panel.css'), 'utf8'));
        return;
      }

      if (method === 'GET' && path === '/state') {
        // status 计算可能因浏览器端口探测而变慢：加硬超时，绝不让面板卡在「加载中…」。
        let status;
        try {
          status = await withTimeout(core.status(), 2500, { host: { connected: false, port: null, busy: '' }, timeout: true });
        } catch (e) {
          logger(`status 异常：${String(e?.message ?? e)}`);
          status = { host: { connected: false, port: null, busy: '' }, error: String(e?.message ?? e) };
        }
        return send(200, { ok: true, config: getConfig(), status });
      }

      if (method === 'GET' && path === '/login-status') {
        const r = await host.ensureReady({ navToHome: false }).catch(() => ({ loggedIn: false }));
        return send(200, { ok: true, loggedIn: Boolean(r?.loggedIn) });
      }

      if (method === 'POST' && path === '/login') {
        const r = await host.openLogin().catch((e) => ({ error: String(e?.message ?? e) }));
        const loggedIn = r?.error ? false : await host.isLoggedIn().catch(() => false);
        return send(200, { ok: !r?.error, ...r, loggedIn });
      }

      if (method === 'POST' && path === '/stop') {
        await host.stop().catch(() => {});
        return send(200, { ok: true });
      }

      if (method === 'POST' && path === '/config') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const allowed = ['enabled', 'browserPort', 'titleSuffix', 'keepReasoning', 'markImported'];
        const patch = {};
        for (const k of allowed) if (body[k] !== undefined) patch[k] = body[k];
        const next = saveConfig(patch);
        return send(200, { ok: true, config: next });
      }

      if (method === 'POST' && path === '/list') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const items = await core.list({ limit: body.limit });
        return send(200, { ok: true, items });
      }

      if (method === 'POST' && path === '/import') {
        const body = JSON.parse((await readBody(req)) || '{}');
        const sessionIds = Array.isArray(body.sessionIds)
          ? body.sessionIds.map(String)
          : String(body.sessionIds || '').split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
        const r = await core.importSessions({ sessionIds, all: Boolean(body.all), limit: body.limit });
        return send(200, { ok: r.ok, results: r.results });
      }

      return send(404, { ok: false, error: 'not found' });
    } catch (error) {
      logger(`路由异常：${String(error instanceof Error ? error.message : error)}`);
      return send(200, { ok: false, error: String(error instanceof Error ? error.message : error) });
    }
  };
}
