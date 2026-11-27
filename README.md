# dsh-dsimport

把 **DeepSeek 网页（chat.deepseek.com）** 上的历史对话导入到 DeepSeek Harness，成为**真实、可续聊的 dsh 会话**——导入后能在 dsh 里看到、能接着追问，标题带「（来自 DeepSeek）」方便识别。

## 它做什么

- 插件内置一个独立浏览器（用你自己的登录态，不影响系统主浏览器），你在里面登录一次 chat.deepseek.com；
- 点击「拉取对话列表」，读取你网页上的历史对话（只读，不改动 DeepSeek 上任何东西）；
- **勾选要导入的对话**（默认不全选，按需选），一键导入为 dsh 会话；
- 导入时默认**丢弃 DeepSeek 的思考/推理过程，只保留问答**（可在设置里改为保留）。

## 安装

把本目录拷到当前 DSH profile 的 `node_modules/dsh-dsimport/`，并在该 profile 的 `package.json` 里把 `"dsh-dsimport"` 加入 `dependencies` 与 `dsh.profile.bundles`（注意 JSON 存为**无 BOM** 的 UTF-8），然后重启 DSH 桌面应用。

## 使用

1. dsh「设置」→「DeepSeek 导入」；
2. 点「打开登录窗口」，在弹出的内置浏览器里扫码 / 登录 chat.deepseek.com；
3. 回到设置面板点「拉取对话列表」；
4. 勾选要导入的对话，点「导入选中的 N 个对话」；
5. 到 dsh 会话列表里就能看到这些对话，可继续追问。

## 实现说明

- **读取**：DeepSeek 网页读取接口是干净 JSON，鉴权用 `Authorization: Bearer <token>`（token 取页面 `localStorage['userToken']`），无需签名 / PoW。会话列表 `/api/v0/chat_session/fetch_page`，消息 `/api/v0/chat/history_messages`。
- **写入**：用宿主 `sessionPersistence.create(header)` → `handle.append(events)` → `handle.close()` 把会话**真正落盘**成 dsh v4 会话日志（`.jsonl.zstd`），再用 `workspaceRegistry.attachSession()` 挂进工作区（侧边栏可见），并 `agents.resume({resumeSessionId})` 激活为可续聊的 live 会话。
- **事件序列**：`permission/preset` + `sandbox/mode` + `approval/policy`（缺了会报「用户配置损坏」）→ `session/end-seed` → `model/selection`（续聊 prompt 的 `{{model}}` 取值来源，缺了会报 `prompt variable "{{model}}" has no value`）→ `session/title` → 每轮 `turn/start, step/start, user/message, assistant/message, step/end, turn/end`。全部已用真实 `dsh-session` 的 `Session.create(...).deriveMessages()` 离线验证回合正确。
- **安全**：所有 HTTP 路由第一步走 `ctx.connection.requestRejection()`，浏览器里任意网页无法跨站调用。

## 工具

- `dsimport_list`：列出网页历史对话
- `dsimport_import`：按 id 或标题导入选中对话
- `dsimport_status`：查看连接 / 登录状态

## 跨插件服务

`ctx.get('dsimport')` → `{ list(opts), importSessions(opts), status() }`
