# AGENTS.md — 面向开发 Agent

这个文件写给在本仓库里干活的 Agent 和开发者。人类读者请看 [README.md](README.md)。

## 这个仓库是什么

一个 DeepSeek Harness 插件：在左侧面板托管 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 的构建产物，并用 DSH 的账户凭据替浏览器转发请求。

## 结构

| 块 | 文件 | 作用 |
|---|---|---|
| 宿主 | `index.js` | 注册 `/webchat` 前缀路由（**必须用 `handler`，`resource` 只接 GET/HEAD**） |
| 路由 | `src/webview.js` | 静态产物、`/webchat/api/*` 自检与导入接口、Messages / Files 转发 |
| 约定 | `src/protocol.js` | 端点根、令牌头、路径越界判断（纯函数，有测试） |
| 导入 | `src/dsh-import.js` | 只读解析 DSH 会话日志 → chat-demo 格式；暂存与确认（纯函数，有测试） |
| 模型桥 | `src/llm-bridge.js` | `/webchat/api/catalog`、「把网页版请求转给 `ctx.llm.stream()`」的翻译层，以及用 `ctx.web.search` / `ctx.web.fetch` 补上的检索与读页面（纯函数部分有测试） |
| 界面 | `client.js` | 左侧面板两个槽位（`main` + `sidebar.panellist`）与会话右键菜单贡献（`contextMenus`） |
| 前端 | `webview/dist` | 官方 chat-demo 构建产物，随仓库分发 |

上游基准：`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（chat-demo v0.1.1，MIT）。补丁在
`webview/patches/0001-dsh-integration.patch`，只动请求落点、品牌字标、隐藏 API Key 输入、启动时取走导入。

## 命令

```bash
node --test test/protocol.test.js test/dsh-import.test.js test/llm-bridge.test.js test/llm-fetch.test.js test/llm-tools.test.js test/llm-loop.test.js
pwsh scripts/build-webview.ps1     # 克隆上游、打补丁、构建、同步 webview/dist
```

安装：`plugin_manager` 装仓库根目录。宿主代码改动后要 `remove_bundle` 再 `install_bundle` 才重新加载；
只改 `client.js` / `webview/dist` 时刷新页面即可。

## 硬约束

1. **一个入口**：只有左侧面板。不要加 `conversation.view`、不要做会话双向同步——这是产品决定，不是待办。模型路由是例外：仅在 `POST /webchat/anthropic/v1/messages` 里按请求体 `dsh` 字段改投 `ctx.llm.stream()`，不新增面向 DSH 会话的入口。
2. **网页版独立存储**：用上游自带的本地存储；只有「导入」这一次性复制会从 DSH 读数据。
3. **不发明提示词**：浏览器构造请求体，宿主只转发。唯一例外是非网页版路由的联网检索——把 `ctx.web.search()` 的结果原样附在 system 后面，并且只做这一步，不改写用户问题。
4. **密钥不出宿主**：浏览器不持有 API Key；`BOOTSTRAP` 注入的只是让上游放行的占位值。
5. **许可证合规**：`webview/dist/LICENSE` 是上游 MIT 原文，不要删。

## 验证

- `GET /webchat/api/self-test`：入口页、静态资源、一次真实生成，三项全绿。
- 槽位：`main` / `sidebar.panellist` 有 `chat-demo`；会话菜单走 `contextMenus` 贡献，所以旧插槽 `sidebar.workspaces.session.menu.item` 应当是空的；`conversation.view` 里**不应**出现。
- 菜单样式：会话右键菜单里的「导入到网页版」必须和置顶、重命名等原生条目等高同字号——新加菜单项一律用 `ctx.contextMenus.register`，不要往旧插槽塞自定义按钮。
- 导入：右键任意会话 →「导入到网页版」→ `GET /webchat/api/import/pending` 返回该会话 → 网页版启动时写入并 `ack`。
- 模型切换：`GET /webchat/api/catalog` 列出 DSH 的供应商与模型；带 `dsh:{provider,model,effort}` 的 `messages` 请求应当返回 Anthropic SSE，不带则回落网页版端点。
- 联网检索：带 `dsh` 路由且 `tools` 里有 `deepseek_web_search` 时，SSE 先发 `server_tool_use`，检索完再发 `web_search_tool_result`（失败时是 `web_search_tool_result_error`）；读网页同理，先发 `read_link` 的调用块、抓完再发 `web_fetch_tool_result`。正文块索引排在所有工具块之后。
- 检索/抓取都只在 `dsh` 路由下发生；网页版那条路仍由 DeepSeek 服务端执行 `deepseek_web_search`、`deepseek_read_url`，宿主不插手。

