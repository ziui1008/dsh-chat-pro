# 贡献者

这个插件能存在，主要是站在 DeepSeek 官方开源前端的肩膀上。

## DeepSeek（上游）

- **DeepSeek** — <https://github.com/deepseek-ai> — 开源了 [chat-demo](https://github.com/deepseek-ai/chat-demo)：界面、交互、动效、请求协议、构建链路全部来自这个项目。本仓库的 `webview/dist` 就是它的构建产物，只改了请求落点、品牌字标、设置里的 API Key 入口，以及新增的模型切换胶囊。
- **brickmaker** &lt;zhaoxiaodong@zju.edu.cn&gt; — chat-demo 的提交作者。

另外，插件宿主用到的 web server、槽位、`contextMenus`、`ctx.llm` 等接口都来自 **DeepSeek Harness（DSH）**，版权归 DeepSeek 所有。

## 本仓库

- **ziui1008** — DSH 插件宿主（`index.js`、`client.js`、`src/`）、模型桥（`src/llm-bridge.js`）、模型与思考档位切换器、导入链路与测试。

## 许可证

| 部分 | 许可证 | 全文 |
| --- | --- | --- |
| 本仓库代码 | MIT | [LICENSE](LICENSE) |
| chat-demo（`webview/dist`） | MIT，Copyright (c) 2026 DeepSeek | [webview/dist/LICENSE](webview/dist/LICENSE) |
| DeepSeek Harness 接口 | 归 DeepSeek 所有，按插件接口调用 | — |
