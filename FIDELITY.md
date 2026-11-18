# 与上游的差异

**规矩**：凡是与 chat-demo 不一致的地方，都必须在这里登记。没有登记的差异视为 bug。

分三类：
- 🟢 **环境差异**：DSH 侧没有这个概念，但请求体经转换后与上游等价。
- 🟡 **降级**：能做到上游的协议，但 DSH 界面表达不出来。
- 🔴 **缺失**：暂时做不到，记着。

## 已登记

| 编号 | 类别 | 差异 | 原因 | 影响 |
|---|---|---|---|---|
| F1 | 🟢 | 浏览器端不发 `x-api-key`，改由宿主用 DSH 的账户凭据代发 | 不让用户的 key 落到页面里 | 无（上游 demo 也是浏览器直连，这里只是换了鉴权的落点） |
| F2 | 🟢 | 会话从 DSH 会话库读，不走 IndexedDB | 目标就是"看到的就是 DSH 的对话" | 需要一层 DSH 会话 ↔ 前端数据模型的映射 |
| F3 | 🟡 | DSH 聊天界面渲染不了 `server_tool_use` / `web_search_tool_result` 块，搜索过程不显示成卡片 | DSH 的消息块类型只有 text / reasoning / image / file / tool-call | 在 DSH 界面里只看到思考与答案；搜索结果卡片只在 webview 里可见 |
| F4 | 🟡 | 自动起标题由 DSH 自己的标题机制产生 | 上游用 `title: { enabled: true }` 在同一请求里返回标题 | 标题文案风格可能略有不同 |
| F5 | 🟢 | `latest_reminder` 的地区可能为空 | DSH 没有稳定的地理位置来源 | 上游允许该字段为空 |

## 待验证

- 上游对"续写（Prefill）"的处理与 DSH 的 turn 模型是否兼容。
- 附件（Files API）在 DSH 里走附件服务，是否需要改用上游的 `file_id` 引用。
- `safety_check` 触发的 `stop_reason: refusal` 在 DSH 界面如何呈现。
