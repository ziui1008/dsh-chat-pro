# AGENTS.md — 面向开发 Agent

这个文件写给在本仓库里干活的 Agent 和开发者。人类读者请看 [README.md](README.md)。

## 这个仓库是什么

一个 DeepSeek Harness（DSH）插件，把 `chat.deepseek.com` 的对话体验搬进 DSH。**唯一的实现依据是官方开源前端 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)**，不是逆向、不是猜测。

上游基准版本记录在 [`UPSTREAM.md`](UPSTREAM.md)。**任何与 chat-demo 不一致的地方都必须写进 [`FIDELITY.md`](FIDELITY.md) 并说明原因**，没有例外。这条规矩比任何性能或代码风格都优先。

## 三层结构

| 层 | 目录 | 作用 | 与 chat-demo 的关系 |
|---|---|---|---|
| 预设 | `packages/preset` | 声明「网页版」agent preset：一句系统提示、零客户端工具、无运行时上下文 | 对应 `SYSTEM_PROMPT` 常量 |
| 通道 | `packages/provider` | 注册 `deepseek-webchat` 的 LlmAdapter，自己构造官方请求体 | 对应 `store.ts` 的请求体与 `toRequestMessages` |
| 前端 | `packages/webview` | 在 DSH 里托管同款界面（同一套协议、不填 API key、直接读写 DSH 会话） | 对应 `src/` 整体 |

打包成一个 bundle `dsh-webchat`，含三行声明；前端以 vendored 子目录引入上游代码，见 `UPSTREAM.md` 的引入方式。

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

`M0`：仓库与规范。尚无实现代码。
