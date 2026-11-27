/**
 * ds-host.js —— DeepSeek 网页（chat.deepseek.com）对话读取的宿主层。
 *
 * 与小红书的区别：DeepSeek 的读取接口是「干净的 JSON + Bearer token」，不需要签名/PoW
 * （PoW 只在 /chat/completion 发消息时用）。所以这里比 XhsHost 简单得多：
 *   1) 用插件自有 profile 起浏览器、打开 chat.deepseek.com；
 *   2) 用户在窗口里扫码/登录一次，token 落在页面 localStorage['userToken']；
 *   3) 我们在**页面上下文**里直接 fetch DeepSeek 的读取接口（带 Authorization 头），
 *      这样同源、带 cookie，最稳。不需要 CDP 监听响应。
 *
 * 能力：
 *   ensureWaitForLogin()      起浏览器、打开站点，等用户在窗口里登录
 *   isLoggedIn()              读 localStorage['userToken'] 判断
 *   listSessions({limit})     列历史会话（标题、时间、id）
 *   fetchSessionMessages(id)  拉某会话的全部消息（biz_data.chat_messages）
 *   status() / openLogin() / stop()
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getBrowser } from './browser.mjs';

export const DS_HOME = 'https://chat.deepseek.com/';
const DEFAULT_PORT = 47892; // 避开鱼 47890、小红书 47891

const errText = (e) => String(e instanceof Error ? e.message : e);

export class DsHost {
  constructor({ pluginDir, port = DEFAULT_PORT, log = () => {}, browserExe = '' } = {}) {
    this.pluginDir = pluginDir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'dsh-dsimport');
    this.port = port;
    this.log = log;
    this.browserExe = browserExe;
    this.userDataDir = join(this.pluginDir, 'browser');
    this.browser = null;
    this.launching = null;
    this._busy = false;
    /** 缓存 token，避免每次读 localStorage */
    this._token = '';
  }

  get base() {
    return `http://127.0.0.1:${this.port}`;
  }

  /**
   * 浏览器是否可用。同步判据（ws 活着）+ 异步兜底（CDP HTTP 端口还在）：
   * ws 可能在页面导航/闲置后关掉（readyState!=1），但浏览器进程还活着、CDP 端口还通。
   * 这种情况下 connected 应报 true，并在下次操作时自动重连（ensureBrowser）。
   */
  async status() {
    let alive = Boolean(this.browser && this.browser.isAlive());
    if (!alive) {
      const portUp = await this.probePort();
      alive = Boolean(portUp);
    }
    return { connected: alive, port: this.port, profileDir: this.userDataDir, busy: this._busy };
  }

  /** 探测 CDP HTTP 端口是否还活着（{Browser,...} 或 null） */
  async probePort() {
    try {
      const r = await fetch(`${this.base}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  async ensureBrowser() {
    if (this.browser && this.browser.isAlive()) return this.browser;
    if (this.launching) return this.launching;
    this.launching = (async () => {
      mkdirSync(this.userDataDir, { recursive: true });
      const b = await getBrowser({
        exe: this.browserExe || undefined,
        userDataDir: this.userDataDir,
        port: this.port,
        log: (m) => this.log(String(m)),
        reuse: true,
      });
      this.browser = b;
      this.log(`浏览器就绪（端口 ${this.port}）`);
      return b;
    })();
    try {
      return await this.launching;
    } finally {
      this.launching = null;
    }
  }

  /** 确保在 chat.deepseek.com 上；返回 { browser, href, loggedIn }。不强制登录。 */
  async ensureReady({ navToHome = true } = {}) {
    const b = await this.ensureBrowser();
    let href = await b.eval('location.href').catch(() => '');
    const onDs = /chat\.deepseek\.com/.test(href || '');
    if ((!onDs || /sign_in|login|auth/i.test(href || '')) && navToHome) {
      await b.goto(DS_HOME, { settleMs: 5000 });
      href = await b.eval('location.href').catch(() => '');
    }
    const loggedIn = await this.isLoggedIn(b);
    return { browser: b, href: String(href || ''), loggedIn };
  }

  /** 读页面 localStorage['userToken'] 判断是否登录，并缓存 token。 */
  async isLoggedIn(b = null) {
    const browser = b || (await this.ensureBrowser());
    try {
      const tok = await browser.eval(`(() => {
        try {
          // DeepSeek 把 token 存在 localStorage 的 userToken 键（值是 JSON 字符串或纯串）
          let raw = localStorage.getItem('userToken');
          if (!raw) return '';
          try { const o = JSON.parse(raw); raw = o && (o.value || o.token || o) || ''; } catch {}
          return typeof raw === 'string' ? raw : '';
        } catch (e) { return ''; }
      })()`);
      this._token = String(tok || '');
      return this._token.length > 8;
    } catch {
      return false;
    }
  }

  /** 打开登录页，让用户在窗口里扫码 / 登录。 */
  async openLogin() {
    const b = await this.ensureBrowser();
    await b.goto(DS_HOME, { settleMs: 4000 });
    return { href: await b.eval('location.href').catch(() => '') };
  }

  /**
   * 在页面上下文里调 DeepSeek 读取接口。
   * @param {string} path  例如 '/api/v0/chat_session/fetch_page'
   * @param {object} [opts] { method, query, body }
   * @returns {object} 解析后的 JSON（{ code, msg, data } 或 { biz_code, biz_data }）
   */
  async _apiFetch(path, { method = 'GET', query = null, body = null, timeoutMs = 25000 } = {}) {
    const b = await this.ensureBrowser();
    if (!this._token) await this.isLoggedIn(b);
    if (!this._token) throw new Error('DeepSeek 还没登录。请在插件窗口里登录后重试（设置面板点「打开登录窗口」）。');

    let url = path;
    if (query) {
      const qs = new URLSearchParams(query).toString();
      if (qs) url += (url.includes('?') ? '&' : '?') + qs;
    }
    // 页面内 fetch：同源、带 cookie、带 Authorization；body 用 JSON。
    const expr = `(() => {
      return fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: {
          'Authorization': 'Bearer ' + ${JSON.stringify(this._token)},
          'Content-Type': 'application/json'
        },
        credentials: 'include',
        ${body ? `body: ${JSON.stringify(JSON.stringify(body))},` : ''}
      }).then(async (r) => {
        const text = await r.text();
        let json = null;
        try { json = JSON.parse(text); } catch (e) {}
        return { status: r.status, ok: r.ok, text: text.slice(0, 4000), json };
      });
    })()`;
    const res = await b.eval(expr, { awaitPromise: true });
    if (!res || typeof res !== 'object') throw new Error('接口无返回（页面可能已跳走 / 未登录）。');
    if (!res.ok) {
      // 401/403 大概率 token 失效
      if (res.status === 401 || res.status === 403) {
        this._token = '';
        throw new Error(`DeepSeek 接口返回 ${res.status}，可能登录已失效，请在插件窗口重新登录。`);
      }
      throw new Error(`DeepSeek 接口返回 ${res.status}：${(res.text || '').slice(0, 200)}`);
    }
    const json = res.json;
    if (!json) throw new Error('接口返回的不是 JSON：' + (res.text || '').slice(0, 200));
    // 业务错误
    const code = json.code ?? json.biz_code;
    const codeOk = code === 0 || code === '0' || code === undefined;
    if (!codeOk) {
      const msg = json.msg || json.biz_msg || ('code=' + code);
      if (String(code) === '40002' || String(code) === '40003') {
        this._token = '';
        throw new Error('DeepSeek 未登录或 token 失效（' + msg + '），请在插件窗口重新登录。');
      }
      throw new Error('DeepSeek 业务错误：' + msg);
    }
    return json;
  }

  /**
   * 列历史会话。DeepSeek 的 fetch_page 用游标分页，这里循环取前 N 条。
   * @returns {Promise<Array<{id,title,updatedAt,modelType,pinned}>>}
   */
  async listSessions({ limit = 100 } = {}) {
    const { loggedIn } = await this.ensureReady();
    if (!loggedIn) throw new Error('DeepSeek 还没登录。请在插件窗口里登录后重试。');
    this._busy = true;
    try {
      const all = [];
      let cursor = null; // {pinned, updated_at}
      let page = 0;
      const pageSize = 50;
      while (all.length < limit && page < 20) {
        page += 1;
        const query = cursor
          ? { 'lte_cursor.pinned': cursor.pinned ? 'true' : 'false', 'lte_cursor.updated_at': String(cursor.updated_at), count: pageSize }
          : { count: pageSize };
        let json;
        try {
          json = await this._apiFetch('/api/v0/chat_session/fetch_page', { query });
        } catch (e) {
          // 第一页失败必须报错；后续分页失败则用已拿到的结果兜底（避免整列表挂掉）
          if (page === 1) throw e;
          this.log(`分页第 ${page} 页失败，返回已取到的 ${all.length} 条：${errText(e)}`);
          break;
        }
        const { parseSessionList } = await import('../src/parse.mjs');
        const { items, hasMore } = parseSessionList(json);
        for (const it of items) all.push(it);
        if (!hasMore || items.length === 0) break;
        const last = items[items.length - 1] || {};
        // cursor：pinned 必须传 true/false（不是 0/1），updated_at 用原始浮点值
        cursor = { pinned: Boolean(last.pinned), updated_at: last.updatedAt ?? 0 };
      }
      return all.slice(0, Math.max(1, limit));
    } finally {
      this._busy = false;
    }
  }

  /**
   * 拉某会话全部消息。返回 DeepSeek 原始消息数组（{message_id,parent_id,role,fragments}）。
   * @param {string} sessionId
   */
  async fetchSessionMessages(sessionId) {
    const { loggedIn } = await this.ensureReady();
    if (!loggedIn) throw new Error('DeepSeek 还没登录。请在插件窗口里登录后重试。');
    if (!sessionId) throw new Error('缺少会话 id');
    this._busy = true;
    try {
      const json = await this._apiFetch('/api/v0/chat/history_messages', { query: { chat_session_id: sessionId } });
      const { parseHistoryMessages } = await import('../src/parse.mjs');
      const parsed = parseHistoryMessages(json);
      // 返回已解析好的 {id,title,turns}，core 直接用，不再二次解析
      return { session: { id: parsed.id, title: parsed.title }, messages: parsed };
    } finally {
      this._busy = false;
    }
  }

  async stop() {
    try {
      if (this.browser) await this.browser.quit();
    } catch (e) {
      this.log(`关闭浏览器失败：${errText(e)}`);
    }
    this.browser = null;
    this._token = '';
  }
}
