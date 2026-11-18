# AGENTS.md — 面向开发 Agent

这个文件写给在本仓库里干活的 Agent 和开发者。人类读者请看 [README.md](README.md)。

## 这个仓库是什么

一个 DeepSeek Harness（DSH）插件，把 `chat.deepseek.com` 的对话体验搬进 DSH。**唯一的实现依据是官方开源前端 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)**，不是逆向、不是猜测。

上游基准版本记录在 [`UPSTREAM.md`](UPSTREAM.md)。**任何与 chat-demo 不一致的地方都必须写进 [`FIDELITY.md`](FIDELITY.md) 并说明原因**，没有例外。这条规矩比任何性能或代码风格都优先。

## 三层结构（一个包内三块）

| 块 | 文件 | 作用 | 与 chat-demo 的关系 |
|---|---|---|---|
| 协议 | `src/protocol.js` | 请求构造、`latest_reminder`、历史压平、SSE 读取。纯函数，通道与前端共用 | `store.ts:999-1011`、`reply.ts`、`latestReminder.ts` |
| 通道 | `src/provider.js` | 注册 `deepseek-webchat` 模型路由，把官方流翻译成 DSH chunk | `store.ts` 的请求体 |
| 界面 | `src/webview.js` + `webview/dist` + `client.js` | 托管官方前端、模型代理、会话桥、DSH 页签 | `src/` 整体（补丁见 `webview/patches/`） |
| 会话桥 | `src/sessions.js` | DSH 事件日志 ⇄ 上游数据模型 | 替代 `db.ts` |

## 命令

```bash
node --test packages/chat-demo-in-dsh/test/protocol.test.js   # 单元测试
pwsh scripts/build-webview.ps1                                 # 重建前端并同步产物
```

安装：`plugin_manager` 装 `packages/chat-demo-in-dsh`（本地目录即链接安装）。改动宿主代码后要 `remove_bundle` 再 `install_bundle` 才会重新加载。

## 硬约束

1. **请求体逐字段对齐**。`system`、`thinking`、`tools`、`safety_check`、`title`、`latest_reminder` 的取值与顺序以 chat-demo 为准；新增字段必须有上游依据。
2. **不发明提示词**。除 chat-demo 源码里出现的字符串，不额外添加任何面向模型的文字。
3. **服务端工具不由客户端执行**。`deepseek_web_search` / `deepseek_read_url` 的结果是服务端块；DSH 聊天界面无法原样渲染时，按 `FIDELITY.md` 记录降级方式，不得伪造工具调用。
4. **不加遥测、不加外部请求**。只连 DeepSeek 官方接口。
5. **许可证合规**：上游 MIT，保留其 LICENSE 与版权声明；派生文件在文件头注明来源与改动。

## 提交规范

- Conventional Commits：`feat: ` / `fix: ` / `docs: ` / `refactor: ` / `test: ` / `chore: `
- 一次提交只做一件事；调研与文档与代码分开提交。
- 提交信息用中文写正文，subject 用英文短句。
- 每个里程碑结束打 tag：`v0.1.0-preset`、`v0.2.0-provider`、`v0.3.0-webview`。

## 验证

- 协议层：把插件实际发出的请求体打印成 JSON，与 `docs/reference-request.json`（由上游客端源码整理）逐字段比对。
- 界面层：与上游 demo 同题同图对照，截图入库到 `docs/assets/`。
- 会话层：在 DSH 新建会话 → 页面能看到同一会话 → 另一端发消息能回流。

## 当前状态

`v0.1.0`：协议层、通道层、网页版界面（`/webchat/`）、DSH 页签、会话桥已落地；
附件与"网页版新建会话写回 DSH 侧栏"未做（见 `FIDELITY.md` F9/F10）。
