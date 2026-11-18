# 与上游的差异

**规矩**：凡是与 chat-demo 不一致的地方，都必须在这里登记。没有登记的差异视为 bug。

分三类：
- 🟢 **环境差异**：DSH 侧没有这个概念，但请求体经转换后与上游等价。
- 🟡 **降级**：能做到上游的协议，但 DSH 界面表达不出来。
- 🔴 **缺失**：暂时做不到，记着。

## 已登记

| 编号 | 类别 | 差异 | 原因 | 状态 |
|---|---|---|---|---|
| F1 | 🟢 | 浏览器端不发 `x-api-key`，由宿主用 DSH 账户凭据代发 | 不让密钥落到页面里，用户不用填 | **已验证** |
| F2 | 🟢 | 会话来自 DSH 会话日志，不走 IndexedDB | 目标就是"看到的就是 DSH 的对话" | **已验证**：73 条会话、按 turn 合并 |
| F3 | 🟡 | DSH 原生聊天界面渲染不了 `server_tool_use` / `web_search_tool_result` 块 | DSH 的消息块只有 text / reasoning / image / file / tool-call | **已验证**；网页版界面能看到完整卡片 |
| F4 | 🟢 | 网页版用服务端 `title`（已实测拿到「确认收到」）；DSH 原生界面仍用 DSH 的标题机制 | 两条入口各自负责标题 | 网页版已通 |
| F5 | 🟢 | `latest_reminder` 的地区为空 | DSH 没有稳定地理位置来源 | **已验证**：官方接受 |
| F6 | 🟡 | `reasoningEffort` 映射为 `thinking` 开关 | 官方协议没有 effort 概念 | 已验证 |
| F7 | 🟡 | DSH 的系统提示与工具 schema 在通道内被丢弃 | 保证线上请求只含官方字段 | 已验证 |
| F8 | 🟡 | 历史里的 `latest_reminder` 不落盘，按用户消息时间重建 | DSH 不保存请求期消息 | 已验证 |
| F9 | 🟢 | 附件经宿主转发到官方 Files API（multipart 原样） | 浏览器不持有密钥 | **已验证**：上传返回真实 `file_id` |
| F10 | 🟢 | 网页版新建的会话会镜像成 DSH 会话（`agentLoop.create` + `session.append` + `flush`） | 让两边的对话真正是同一份 | **已验证**：日志落在当前工作区，读回正常 |
| F11 | 🟡 | 在网页版重命名或删除 DSH 原有会话，不会改动 DSH 日志 | 日志由 DSH 写入，插件不重写已有会话 | 保留 |
| F12 | 🟢 | 网页版左上角用官方字标替代「API 使用 demo」 | 品牌贴合网页版 | 与官网 web-logo.svg 逐字节一致（SHA256 1BEAB099…） |
| F13 | 🟢 | DSH 内入口改为「会话 View + 左侧面板」，不再占用插件页签 | 插件页属于插件市场 | 实测两处注册均 active |
| F14 | 🟡 | 会话 View 用 iframe 承载 `?embed=1&session=<id>` | 前端与 DSH 解耦、可独立升级 | 已验证参数生效 |

## 验收记录

| 日期 | 用例 | 结果 |
|---|---|---|
| 2026-11-18 | `GET /webchat/api/probe` | 200，202 个 SSE 事件，块类型 `thinking`/`text`，**思考为中文** |
| 2026-11-18 | `GET /webchat/api/stream` 走 `adapter.stream()` | 146 chunks，`finish: {kind:'stop'}`，usage 正确 |
| 2026-11-18 | `GET /webchat/api/status` | 通道 `deepseek-webchat` 已注册 |
| 2026-11-18 | `GET /webchat/`、`/webchat/static/js/*`、`/webchat/brand-mark.svg` | 200 / 200 / 200 |
| 2026-11-18 | `GET /webchat/api/sessions` | 61 条 DSH 会话（已过滤子代理），标题与时间正确 |
| 2026-11-18 | `GET /webchat/api/self-test` | 5/5 通过（入口页、静态资源、会话列表、会话详情、一次真实生成） |
| 2026-11-18 | `POST /webchat/anthropic/v1/files` | 200，返回真实 `file_id` |
| 2026-11-18 | `POST /webchat/anthropic/v1/messages`（前端同款 body，含 title） | 200，流正常，`title: 确认收到` |
| 2026-11-18 | `node --test` | 8 项通过 |
| 2026-11-18 | 镜像保存（PUT 一条新会话） | 204，DSH 侧出现 `session.v4.jsonl.zstd`，读回 title 与两条消息 |
| 2026-11-18 | 智能搜索（前端同款 body，声明 `deepseek_web_search`） | 200，2 个 `server_tool_use`、1 个 `web_search_tool_result`（15 条）、3 个引用增量 |
| 2026-11-18 | 客户端槽位 | `conversation.view`、`main`、`sidebar.panellist` 三处均为 `chat-demo` 且 `active: true`（页面实测） |




