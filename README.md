# dsh-chat-pro

把 DeepSeek 官网那套对话界面搬进 DeepSeek Harness 的左侧面板，并且让它能用上 DSH 里已经配好的模型。

<p>
  <img alt="version" src="https://img.shields.io/badge/version-1.1.1-2F6FEB?style=flat-square" />
  <a href="https://github.com/ziui1008/dsh-chat-pro/actions/workflows/test.yml"><img alt="test" src="https://github.com/ziui1008/dsh-chat-pro/actions/workflows/test.yml/badge.svg" /></a>
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/badge/license-MIT-2EA043?style=flat-square" /></a>
  <a href="https://github.com/deepseek-ai/chat-demo"><img alt="upstream" src="https://img.shields.io/badge/upstream-chat--demo-555?style=flat-square" /></a>
</p>

## 缘起

2026 年 11 月 15 日，DeepSeek 官方 App 和网页端开始限额。平时拿它聊天、写东西的人一下被卡住，于是不少人转到 DeepSeek Harness —— 可 DSH 是给编程代理准备的：每次对话都带着几千字的系统提示词和一堆工具定义，模型被按在「干活」的姿势上，回话也变得板正。

做这个插件最初就为一件事：在 DSH 里留出一块地方，还是官方那个网页版，还是官方那套轻提示词，只是借 DSH 已经登录的账户去发请求。模型桥是后来的事 —— 面板既然已经在这儿了，顺手让它也能用上 DSH 里配好的其它供应商。

## 这个面板做了什么

面板里跑的是 DeepSeek 官方开源前端 `chat-demo` 的构建产物：官方那份界面、那份系统提示词、那套服务端工具。它和 DSH 的会话完全隔离 —— 不共享上下文，不共享系统提示词，也不共享历史存储。

宿主这一侧只做三件事：把前端产物托管在 `/webchat` 下；用 DSH 当前登录的 DeepSeek 账户换 token，替浏览器转发请求；当前端要求切到别的模型时，把请求改投给 DSH 的模型服务。

## 功能

- **界面是原版**：官方前端的交互、排版、动效没有改动，只换了请求落点和左上角标识。
- **不用 API Key**：请求由宿主用 DSH 当前登录的 DeepSeek 账户换 token 代发。
- **存储独立**：面板的会话存在浏览器 IndexedDB 里，与 DSH 的会话日志互不影响，删一边不牵连另一边。
- **从 DSH 搬对话**：任意会话右键 →「导入到网页版」，复制一份过来接着聊（一次性复制）。
- **借用其它模型**：右下角胶囊按供应商列出 DSH 里的模型，同一张浮层里切思考档位；首条消息的标题也由当前模型来起。
- **动效克制**：消息入场、浮层展开、按钮按下都有一点位移与缩放，切面板时面板整体淡入；系统开了「减少动效」就全部关掉。
- **官方能力都在**：深度思考、联网搜索、引用角标、公式、图表、深色模式。

## 安装

1. 打开 DSH 左侧的「插件」页，点右上角「添加插件」。
2. 填仓库地址 `https://github.com/ziui1008/dsh-chat-pro`，点「安装」。
3. 装好后点「立即启用」，左侧面板列表里会多出「网页版」。

> 仓库名、包名、插件 id 都是 `dsh-chat-pro`；装过旧包（`chat-in-dsh`）的话先卸掉再装。

## 使用

- 点左侧「网页版」打开面板；想让聊天区更宽，点左上角按钮收起 DSH 的会话栏。
- 传文件、语音、导出历史等功能都是官方前端自带的，位置没变。
- 想把 DSH 里的某段对话带过来：在左侧会话列表右键 →「导入到网页版」，再切到面板，它会出现在列表里。
- 换模型：点输入框下方的模型胶囊 → 选供应商下的模型 → 需要的话在浮层底部选思考档位。选择记在浏览器本地，下次打开还是它。

关掉输入框左上角的「深度思考」时，档位不参与请求；这也是官方前端的行为。

## 模型桥是怎么工作的

浏览器发出的仍是 DeepSeek 的 Anthropic 兼容请求（`POST /webchat/anthropic/v1/messages`），宿主根据请求体决定往哪儿发：

| 请求体 | 宿主行为 |
| --- | --- |
| 没有 `dsh` 字段，或 `dsh.provider` 是 `webchat` | 换真 token 后转发给 `https://api.deepseek.com/anthropic`（网页版原路径） |
| 带 `dsh: { provider, model, effort }` | 转成 `ctx.llm.stream()` 调用，再把 chunk 翻回 Anthropic SSE 交给前端 |

模型目录来自 `GET /webchat/api/catalog`：宿主依次调 `ctx.llm.listProviders()`、`listModels()`、`resolveModelInfo()`，把供应商、模型名和各自声明的思考档位拼成前端要的结构。

翻译只做结构转换，不动内容：`system`、消息、附件都由浏览器构造，宿主不拼接提示词，`x-api-key` 一律丢弃。

### 搜索和读页：交给模型自己决定

`deepseek_web_search` 与 `deepseek_read_url` 都是 DeepSeek 的服务端工具，只能挂在他家端点上执行。选中第三方模型时，宿主把这两个动作做成真正的工具交给模型：

1. 宿主按请求体里声明过的工具，构造 `web_search`（`query`）与 `read_url`（`url`）两个工具定义，随 `ctx.llm.stream()` 一起发出去；
2. 模型想要资料就自己发 tool-call，宿主用 `ctx.web.search()` / `ctx.web.fetch()` 执行，把结果作为 tool 消息回灌，再让模型接着写；
3. 每执行一个工具，宿主同时按 Anthropic 的形状补发 `server_tool_use` 与 `web_search_tool_result` / `web_fetch_tool_result`，前端照常画出「已阅读 N 个网页」。

预算写死在宿主里：一次回答最多 **3 轮**工具、**4 次**调用，单次操作 20 秒超时；用完额度的最后一轮不再提供工具，逼模型直接作答——否则它会把最后的额度花在再一次检索上，用户看到的是一段没有结论的思考。

关掉「智能搜索」时宿主不再提供 `web_search`，模型仍然可以 `read_url`（比如你直接贴了链接）。它想搜也没得搜。

## 配置

`cordis.patch.yml` 里的 `baseURL` 可以改上游端点，也可以用环境变量 `DEEPSEEK_BASE_URL`；宿主会自动补 `/v1`。留空则用默认的 `https://api.deepseek.com/anthropic`。

工具循环的边界、威胁模型与回滚方式单独写在 [docs/tool-loop-review.md](docs/tool-loop-review.md)。

## 已知限制

- 图片、文件附件只在「DeepSeek 网页版」这条路径可用。选中第三方模型时发附件会直接报错提示，不会静默丢内容。
- 联网搜索与读网页在第三方模型下由模型自己发起工具调用，正文引用角标（`citations`）仍不提供——前端只会显示「已阅读 N 个网页」这一层。
- 工具调用有预算：一次回答最多 3 轮、4 次调用、单次 20 秒；页面里如果写着「再读三个链接」这类指令，模型可能照做，但很快会撞上预算。
- 第三方模型有没有思考块，取决于供应商是否真的返回 reasoning 内容。
- 导入只搬文字和思考：工具调用、图片、系统提醒会被丢掉。
- 会话格式绑在 DSH 的 `session.v4.jsonl[.zstd]` 上，DSH 换格式后导入会失效。

## 安全边界

`/webchat` 下的路由没有额外的鉴权，也没有 Origin / CSRF 校验 —— 它假设只有本机能访问 DSH 的 web 端口。默认情况下 DSH 桌面版用 `--port 0` 起服务、窗口走 `dsh-app://app` 反代，不会暴露到局域网；但如果你手动把 web server 绑到 `0.0.0.0` 或对公网做了端口映射，同网段的人就能借你的账户发请求、读暂存里的会话内容。

请不要把 DSH 的 web 端口暴露到公网。导入确认接口的 `ids` 参数目前没有做路径消毒，这也是待修项。

## 开发

```bash
git clone https://github.com/ziui1008/dsh-chat-pro.git
cd dsh-chat-pro
node --test test/protocol.test.js test/dsh-import.test.js test/llm-bridge.test.js
```

前端是上游 `chat-demo` 加一个补丁构建出来的：

```powershell
pwsh scripts/build-webview.ps1
```

脚本会把上游仓库克隆到 `webview/vendor/chat-demo`、切到指定提交、打上 `webview/patches/0001-dsh-integration.patch`、构建并把产物同步到 `webview/dist`。

改了宿主代码（`index.js`、`src/`）需要重新加载插件才生效；只改 `client.js` 或 `webview/dist` 时刷新页面即可。

## 目录

| 路径 | 作用 |
| --- | --- |
| `index.js` | 插件入口，注册 `/webchat` 前缀路由 |
| `src/webview.js` | 静态资源、`/webchat/api/*`、Messages / Files 转发入口 |
| `src/llm-bridge.js` | 模型目录与 DSH 模型调用之间的翻译层 |
| `src/dsh-import.js` | 只读解析 DSH 会话日志、暂存与确认 |
| `src/protocol.js` | 端点根、令牌头、路径越界判断 |
| `client.js` | 左侧面板槽位与「导入到网页版」右键菜单 |
| `webview/dist` | 上游前端的构建产物 |
| `test/` | 协议、导入、模型桥与检索/抓取的单元测试 |

## 致谢

界面与请求逻辑来自 [chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT，Copyright (c) 2026 DeepSeek），宿主接口来自 DeepSeek Harness。完整署名与许可证说明见 [CONTRIBUTORS.md](CONTRIBUTORS.md) 与 [NOTICE](NOTICE)。

## 许可

[MIT](LICENSE)
