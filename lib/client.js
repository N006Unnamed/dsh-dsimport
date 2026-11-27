/**
 * dsh-dsimport — 桌面端设置面板（client.js）
 *
 * 宿主契约（照抄 dsh-xhs / dsh-toutiao）：
 *  - window.__ModuleLoader__.load({ id, factory })，exports.apply / inject；inject: ["slots"]
 *  - ctx.slots.inject("settings.section", ...) 挂到「设置」里一个独立分区
 *  - 所有数据走 /api/plugins/dsh-dsimport/*（见 lib/routes.mjs）
 *
 * ⚠️ 血泪教训：函数组件只从 props.children 取子节点，不要用 rest 参数 ...kids。
 */
window.__ModuleLoader__.load({
	id: "dsh-dsimport",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const react = require("react");

		const inject = ["slots"];
		const PLUGIN_ID = "dsh-dsimport";
		const API = "/api/plugins/dsh-dsimport";
		const h = react.createElement;
		const cx = (...names) => names.filter(Boolean).join(" ");

		async function api(method, path, body) {
			try {
				const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
				const timer = controller ? setTimeout(() => { try { controller.abort(); } catch {} }, 20000) : null;
				const response = await fetch(API + path, {
					method,
					headers: { "content-type": "application/json" },
					...(controller ? { signal: controller.signal } : {}),
					...(body !== undefined ? { body: JSON.stringify(body) } : {}),
				});
				if (timer) clearTimeout(timer);
				const data = await response.json().catch(() => null);
				if (data) return data;
				return { ok: false, error: `HTTP ${response.status}` };
			} catch (error) {
				return { ok: false, error: String(error instanceof Error ? error.message : error) };
			}
		}

		let cssPromise = null;
		function useCss() {
			const [css, setCss] = react.useState(null);
			react.useEffect(() => {
				let alive = true;
				cssPromise ??= fetch(`${API}/ui/panel.css`).then((r) => (r.ok ? r.text() : "")).catch(() => "");
				cssPromise.then((text) => { if (alive) setCss(text); if (text === "") cssPromise = null; });
				return () => { alive = false; };
			}, []);
			return css;
		}

		// ── 控件 ──
		function Switch({ checked, onChange, label, disabled }) {
			return h("button", { type: "button", role: "switch", "aria-checked": checked === true, "aria-label": label, disabled, className: "ds-switch", onClick: () => onChange(!checked) },
				h("span", { className: "ds-switch-thumb" }));
		}
		const Button = ({ variant, children, ...props }) => h("button", { type: "button", ...props, className: cx("ds-btn", variant) }, children);
		const Input = (props) => h("input", { spellCheck: false, autoComplete: "off", ...props, className: cx("ds-input", props.className) });
		const Num = (props) => h("input", { type: "number", inputMode: "numeric", ...props, className: "ds-input num" });
		const Dot = (state) => h("span", { className: "ds-dot", "data-state": state, "aria-hidden": true });
		const State = (state, text, title) => h("span", { className: "ds-state", "data-state": state, title: title ?? text, role: "status" }, Dot(state), h("span", null, text));
		const Tag = (text, tone) => h("span", { className: cx("ds-tag", tone) }, text);
		function Row({ title, desc, stack, children }) {
			return h("div", { className: cx("ds-row", stack && "stack") },
				h("div", { className: "ds-row-title" }, h("span", null, title), desc ? h("span", { className: "ds-row-desc" }, desc) : null),
				h("div", { className: "ds-ctl" }, children));
		}
		function Group({ title, children }) {
			return h("section", { className: "ds-group" }, title ? h("h3", { className: "ds-group-head" }, h("span", null, title)) : null, children);
		}

		const fmtDate = (sec) => {
			if (!sec || !Number.isFinite(sec)) return "";
			const d = new Date(sec < 1e12 ? sec * 1000 : sec);
			const p = (n) => String(n).padStart(2, "0");
			return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
		};

		function SessionRow({ item, checked, onToggle }) {
			return h("label", { className: cx("ds-sess", item.imported && "imported") },
				h("input", { type: "checkbox", checked: checked === true, onChange: () => onToggle(item.id) }),
				h("div", { className: "ds-sess-main" },
					h("div", { className: "ds-sess-title" }, item.title || "(无标题)"),
					h("div", { className: "ds-sess-meta" },
						item.updatedAt ? h("span", null, fmtDate(item.updatedAt)) : null,
						item.imported ? Tag("已导入", "ok") : null)));
		}

		function DsimportSection() {
			const css = useCss();
			const [cfg, setCfg] = react.useState(null);
			const [status, setStatus] = react.useState(null);
			const [busy, setBusy] = react.useState("");
			const [items, setItems] = react.useState(null);
			const [selected, setSelected] = react.useState({});
			const [results, setResults] = react.useState(null);
			const [toast, setToast] = react.useState(null);

			const notify = (text) => { setToast({ text, key: Date.now() }); setTimeout(() => setToast(null), 3200); };

			const loadState = async () => {
				let r;
				try {
					r = await api("GET", "/state");
				} catch (e) {
					r = { ok: false, error: String(e && e.message ? e.message : e) };
				}
				if (r && r.ok) {
					setCfg(r.config || {});
					setStatus(r.status || null);
				} else {
					// 即使 /state 失败也要让面板可用：用默认配置渲染，并提示原因，绝不卡在「加载中…」。
					setCfg((prev) => prev || { titleSuffix: "（来自 DeepSeek）", keepReasoning: false, browserPort: 47892 });
					setStatus((prev) => prev || { host: { connected: false } });
					notify("读取状态失败：" + ((r && r.error) || "未知错误") + "（已按默认配置显示）");
				}
			};
			react.useEffect(() => { loadState(); }, []);

			const patch = async (p) => {
				const r = await api("POST", "/config", p);
				if (r.ok) { setCfg(r.config || {}); notify("已保存"); } else notify(r.error || "保存失败");
			};

			const openLogin = async () => {
				setBusy("login");
				const r = await api("POST", "/login");
				setBusy("");
				if (r.ok) { notify(r.loggedIn ? "已打开 DeepSeek 窗口并检测到登录" : "已打开 DeepSeek 窗口，请在窗口里扫码/登录"); loadState(); }
				else notify(r.error || "打开失败");
			};

			const stopBrowser = async () => {
				setBusy("stop");
				await api("POST", "/stop");
				setBusy("");
				notify("已关闭浏览器");
				loadState();
			};

			const doList = async () => {
				setBusy("list");
				const r = await api("POST", "/list", { limit: 200 });
				setBusy("");
				if (r.ok) {
					setItems(r.items || []);
					const sel = {};
					// 默认不勾选；不自动全选（用户要求：不要全部导入）
					setSelected(sel);
					notify(`拉到 ${((r.items) || []).length} 个对话，勾选要导入的`);
				} else notify(r.error || "拉取失败（可能未登录）");
			};

			const toggle = (id) => setSelected((s) => ({ ...s, [id]: !s[id] }));
			const idsChecked = () => Object.keys(selected).filter((k) => selected[k]);
			const toggleAll = () => {
				const all = idsChecked().length === (items || []).length;
				const sel = {};
				if (!all) for (const it of (items || [])) if (!it.imported) sel[it.id] = true;
				setSelected(sel);
			};

			const doImport = async () => {
				const ids = idsChecked();
				if (ids.length === 0) { notify("先勾选要导入的对话"); return; }
				setBusy("import");
				const r = await api("POST", "/import", { sessionIds: ids });
				setBusy("");
				if (r.ok || Array.isArray(r.results)) {
					setResults(r.results || []);
					const okN = (r.results || []).filter((x) => x.ok).length;
					const noAttach = (r.results || []).filter((x) => x.ok && x.attached === false).length;
					const noLive = (r.results || []).filter((x) => x.ok && x.live === false).length;
					let msg = `导入完成：成功 ${okN} 个`;
					if (noAttach) msg += `，其中 ${noAttach} 个未能挂到工作区（可能不在侧边栏显示）`;
					else if (noLive) msg += `，已加入左侧对话列表（需重启 dsh 才在侧边栏刷新）`;
					else msg += `，已加入左侧对话列表，可直接打开`;
					notify(msg);
					doListRefresh();
				} else notify(r.error || "导入失败");
			};

			const doListRefresh = async () => {
				const r = await api("POST", "/list", { limit: 200 });
				if (r.ok) setItems(r.items || []);
			};

			if (css === null) return null;
			if (cfg === null) {
				return h("div", { className: "ds" },
					css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),
					h("p", { className: "ds-muted" }, "加载中…"));
			}

			const st = (status && status.host) || {};
			const connected = st.connected === true;
			const nSel = idsChecked().length;

			return h("div", { className: "ds" },
				css === "" ? null : h("style", { "data-plugin-css": `${PLUGIN_ID}/panel.css` }, css),

				// 连接 / 登录
				h(Group, { title: "连接与登录" },
					h(Row, { title: "DeepSeek 浏览器", desc: connected ? `已连接（端口 ${st.port}）` : "未连接 · 点「打开登录窗口」启动内置浏览器" },
						State(connected ? "connected" : "off", connected ? "已连接" : "未连接"),
						h(Button, { variant: "primary", disabled: busy === "login", onClick: openLogin }, busy === "login" ? "启动中…" : "打开登录窗口"),
						connected ? h(Button, { disabled: busy === "stop", onClick: stopBrowser }, "关闭浏览器") : null),
					h(Row, { title: "说明", desc: "插件内置一个独立浏览器，你只需在里面登录一次 chat.deepseek.com（扫码/账号），之后点击「拉取对话列表」即可读取你网页上的历史对话。" })),

				// 导入设置
				h(Group, { title: "导入设置" },
					h(Row, { title: "标题后缀", desc: "导入后加在会话标题末尾，方便在 dsh 里识别" },
						h(Input, { value: cfg.titleSuffix ?? "", onChange: (e) => setCfg({ ...cfg, titleSuffix: e.target.value }), onBlur: (e) => patch({ titleSuffix: e.target.value }) })),
					h(Row, { title: "保留思考/推理", desc: "默认关闭：只导入问答，丢弃 DeepSeek 的思考过程" },
						h(Switch, { checked: cfg.keepReasoning === true, label: "保留思考", onChange: (v) => patch({ keepReasoning: v }) })),
					h(Row, { title: "CDP 调试端口", desc: "一般不用改（改后需重启 dsh）" },
						h(Num, { value: cfg.browserPort ?? 47892, min: 1024, max: 65535, onChange: (e) => setCfg({ ...cfg, browserPort: Number(e.target.value) }), onBlur: (e) => patch({ browserPort: Number(e.target.value) }) }))),

				// 拉取 + 勾选导入
				h(Group, { title: "选择要导入的对话" },
					h(Row, { title: "拉取网页对话列表", desc: "只读取列表，不会自动导入；下面勾选要导入的对话", stack: true },
						h("div", { className: "ds-ctl" },
							h(Button, { variant: "primary", disabled: busy === "list", onClick: doList }, busy === "list" ? "拉取中…" : "拉取对话列表"),
							(items && items.length) ? h(Button, { onClick: toggleAll }, idsChecked().length === items.filter((x) => !x.imported).length && nSel > 0 ? "取消全选" : "全选未导入") : null,
							h(Button, { variant: "primary", disabled: busy === "import" || nSel === 0, onClick: doImport }, busy === "import" ? "导入中…" : `导入选中的 ${nSel} 个对话`))),
					items === null ? null : (items.length === 0
						? h("p", { className: "ds-muted" }, "没有拉到对话（可能就是没有历史对话，或未登录）。")
						: h("div", { className: "ds-sess-list" }, items.map((it) => h(SessionRow, { key: it.id, item: it, checked: selected[it.id] === true, onToggle: toggle })))),
					results && results.length ? h("div", { className: "ds-results" },
						h("h4", { className: "ds-group-head" }, "导入结果"),
						results.map((r, i) => h("div", { key: i, className: cx("ds-result", r.ok ? "ok" : "err") },
							r.ok
								? h("div", null,
									h("div", null, `✓ ${r.title}（${r.turns} 轮）→ dsh 会话 ${r.dshId}`),
									r.note ? h("div", { className: "ds-muted", style: { fontSize: "12px" } }, "⚠ " + r.note) : null,
									r.diag ? h("pre", { className: "ds-diag", style: { fontSize: "11px", whiteSpace: "pre-wrap", margin: "4px 0 0", opacity: 0.85 } }, JSON.stringify(r.diag, null, 2)) : null)
								: `✗ ${r.dsId}：${r.error}`))) : null),

				toast ? h("div", { className: "ds-toast", role: "status", key: toast.key }, toast.text) : null);
		}

		function apply(ctx) {
			ctx.effect(() => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "dsh-dsimport",
				order: 64,
				label: () => "DeepSeek 导入"
			}, DsimportSection)), `${PLUGIN_ID}: panel`);
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
