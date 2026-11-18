# AGENTS.md — 面向开发 Agent

这个文件写给在本仓库里干活的 Agent 和开发者。人类读者请看 [README.md](README.md)。

## 这个仓库是什么

一个 DeepSeek Harness（DSH）插件：在侧栏托管 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)，让 DSH 用户得到一份与网页版一致的聊天界面。**实现依据只有官方源码**，不逆向、不猜测。

上游基准记录在 [`UPSTREAM.md`](UPSTREAM.md)。**任何与 chat-demo 不一致的地方都必须写进 [`FIDELITY.md`](FIDELITY.md)**，没有例外。

## 结构

| 块 | 文件 | 作用 |
|---|---|---|
| 宿主 | `index.js` | 注册 `/webchat` 前缀路由（**必须用 `handler`，`resource` 只接 GET/HEAD**） |
| 路由 | `src/webview.js` | 静态产物、`/webchat/api/*` 自检、Messages / Files 转发（用 DSH 账户凭据代发） |
| 约定 | `src/protocol.js` | 端点根、令牌头、路径越界判断（纯函数，有测试） |
| 界面 | `client.js` | 只注册左侧面板两个槽位：`main`（key=`chat-demo`）+ `sidebar.panellist`（同 id） |
| 前端 | `webview/dist` | 官方 chat-demo 构建产物，随包分发 |

## 命令

```bash
node --test packages/chat-demo-in-dsh/test/protocol.test.js
pwsh scripts/build-webview.ps1
```

安装：`plugin_manager` 装 `packages/chat-demo-in-dsh`。宿主代码改动后要 `remove_bundle` 再 `install_bundle` 才重新加载；只改 `client.js`/`dist` 时刷新页面即可。

## 硬约束

1. **一个入口**：只有左侧面板。不要加模型路由、不要加 `conversation.view`、不要做会话互通——这是产品决定，不是待办。
2. **网页版独立存储**：用上游自带的本地存储，不要改回宿主会话。
3. **不发明提示词**：浏览器构造请求体，宿主只转发。
4. **解密钥**：浏览器不持有 API Key；`BOOTSTRAP` 注入的只是让上游放行的占位值，真正的鉴权在宿主。
5. **许可证合规**：上游 MIT，保留 LICENSE 与版权声明。

## 提交规范

- Conventional Commits；一次提交一件事；正文中文，subject 英文短句。
- 里程碑打 tag：`v0.3.0` 起按语义化版本递增。

## 验证

- `GET /webchat/`：入口页含引导脚本；`GET /webchat/static/js/main.*.js`：200。
- `GET /webchat/api/self-test`：入口页、静态资源、一次真实生成，三项全绿。
- 槽位：`main` 与 `sidebar.panellist` 都有 `chat-demo`，`conversation.view` 里**不应**出现它。
