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
| F4 | 🟡 | 自动标题走 DSH 自己的机制 | 上游在 `message_delta` 里带回 `title` | 通道暂不请求 `title` |
| F5 | 🟢 | `latest_reminder` 的地区为空 | DSH 没有稳定地理位置来源 | **已验证**：官方接受 |
| F6 | 🟡 | `reasoningEffort` 映射为 `thinking` 开关 | 官方协议没有 effort 概念 | 已验证 |
| F7 | 🟡 | DSH 的系统提示与工具 schema 在通道内被丢弃 | 保证线上请求只含官方字段 | 已验证 |
| F8 | 🟡 | 历史里的 `latest_reminder` 不落盘，按用户消息时间重建 | DSH 不保存请求期消息 | 已验证 |
| F9 | 🔴 | 附件 / 文件输入 | Files 端点返回 501 | 计划中 |
| F10 | 🔴 | 网页版里新建的会话存在 `<DSH_HOME>/webchat/sessions`，不出现在 DSH 侧栏 | 尚未写回 DSH 事件日志 | 计划中 |
| F11 | 🟡 | DSH 侧栏的会话在网页版是只读视图：重命名/删除不会改 DSH 日志 | 同一原因 | 计划中 |
| F12 | 🟡 | 网页版左上角用官方标识替代「API 使用 demo」 | 品牌贴合网页版 | 已完成 |

## 验收记录

| 日期 | 用例 | 结果 |
|---|---|---|
| 2026-11-18 | `GET /webchat/api/probe` | 200，202 个 SSE 事件，块类型 `thinking`/`text`，**思考为中文** |
| 2026-11-18 | `GET /webchat/api/stream` 走 `adapter.stream()` | 146 chunks，`finish: {kind:'stop'}`，usage 正确 |
| 2026-11-18 | `GET /webchat/api/status` | 通道 `deepseek-webchat` 已注册 |
| 2026-11-18 | `GET /webchat/`、`/webchat/static/js/*`、`/webchat/brand-mark.svg` | 200 / 200 / 200 |
| 2026-11-18 | `GET /webchat/api/sessions` | 73 条 DSH 会话，标题与时间正确 |
| 2026-11-18 | `node --test` | 8 项通过 |
