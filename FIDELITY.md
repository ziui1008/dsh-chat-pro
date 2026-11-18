# 与上游的差异

**规矩**：凡是与 chat-demo 不一致的地方，都必须在这里登记。没有登记的差异视为 bug。

分三类：
- 🟢 **环境差异**：DSH 侧没有这个概念，但请求体经转换后与上游等价。
- 🟡 **降级**：能做到上游的协议，但 DSH 界面表达不出来。
- 🔴 **缺失**：暂时做不到，记着。

## 已登记

| 编号 | 类别 | 差异 | 原因 | 状态 |
|---|---|---|---|---|
| F1 | 🟢 | 浏览器端不发 `x-api-key`，由宿主用 DSH 账户凭据代发 | 不让用户的 key 落到页面里 | **已验证**：官方端点接受 `x-dsh-auth-token` |
| F2 | 🟢 | 会话取自 DSH 会话库，不走 IndexedDB | 目标就是"看到的就是 DSH 的对话" | 映射层待建 |
| F3 | 🟡 | DSH 界面渲染不了 `server_tool_use` / `web_search_tool_result` 块 | DSH 的消息块只有 text / reasoning / image / file / tool-call | **已验证**：块类型仅余 `thinking` / `text` |
| F4 | 🟡 | 自动标题走 DSH 自己的机制 | 上游在 `message_delta` 里带回 `title` | 通道暂不请求 `title` |
| F5 | 🟢 | `latest_reminder` 的地区为空 | DSH 没有稳定地理位置来源 | **已验证**：官方接受 `2026-11-18,星期三,,Web,中文` |
| F6 | 🟡 | `reasoningEffort` 映射为 `thinking` 开关：`off` → `disabled`，其余 → `enabled` | 官方协议没有 effort 概念，只有 thinking 开关 | 已验证 |
| F7 | 🟡 | DSH 的系统提示与工具 schema 在通道内被丢弃 | 保证线上请求只含官方字段，与预设配置无关 | 已验证 |
| F8 | 🟡 | 历史里的 `latest_reminder` 不落盘，按每条用户消息的时间重建 | DSH 不保存请求期消息 | 待前端落地时复验 |
| F9 | 🔴 | 附件/文件输入、续写（Prefill）、`refusal` 呈现 | 尚未实现 | 计划中 |

## 验收记录

| 日期 | 用例 | 结果 |
|---|---|---|
| 2026-11-18 | `GET /webchat/api/probe` 发一次官方形态请求 | 200，202 个 SSE 事件，块类型 `thinking`/`text`，**思考为中文** |
| 2026-11-18 | `GET /webchat/api/stream` 走 `adapter.stream()` | 146 chunks，`finish: {kind:'stop'}`，usage 映射正确，思考为中文 |
| 2026-11-18 | `GET /webchat/api/status` | 通道 `deepseek-webchat` 已注册，与 `deepseek-official` / `deepseek-account` 并列 |
