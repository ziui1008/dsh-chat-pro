# chat-demo-in-dsh

把 [DeepSeek 官方开源的 chat-demo](https://github.com/deepseek-ai/chat-demo) 搬进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

安装一个插件，侧栏就多一个「网页版」面板。点开就是 DeepSeek 网页版：**不用装 chat-demo，不用填 API Key，不用登录。**

![网页版界面](docs/assets/webview.png)

## 为什么做这个

2026 年 11 月 16 日，DeepSeek App 与网页端开始限额，大量用户转向 DeepSeek Harness。

他们中的许多人并不是开发者：他们要的是一个会聊天的 DeepSeek，而不是一个会改代码、会写文件、每次开口前先读六千字工程规范的智能体。对这些人来说，DSH 的默认形态太重了。

DeepSeek 把网页版的前端开源了。于是有了这个插件：**用官方那一套界面，把网页版原样搬进 DSH。**

![带思考过程的回答](docs/assets/webview-reply.png)

## 功能

- **原样界面**：chat-demo 的界面、交互一个没改，包括编辑重发、重新生成、分支切换
- **智能搜索与深度思考**：面板里的开关就是网页版的开关，答案是带引用的
- **完整渲染**：Markdown、代码高亮、KaTeX 公式、Mermaid 图、思考折叠、来源卡片、深浅色主题
- **免密钥**：请求由 DSH 宿主用你已登录的 DeepSeek 账户代发，浏览器里没有 Key
- **一个入口**：侧栏面板列表里的「网页版」

## 安装

```bash
dsh plugin --profile desktop add github:YinkaiYu/chat-demo-in-dsh
```

重启 DSH 后，侧栏面板列表里会出现「网页版」。

## 它和 DSH 自己的对话是什么关系

**没有关系，这是设计决定。**

网页版的提示词只有一句、工具是服务端工具；DSH 的对话带着工程规范、文件与命令工具。把它们混在一起，两边都会失真，所以我们不做互通：

| | 网页版面板 | DSH 对话 |
|---|---|---|
| 存储 | 浏览器本地（上游自带） | DSH 会话日志 |
| 提示词 | 官方那一句 | DSH 组装 |
| 工具 | 服务端搜索 / 读链接 | 文件、命令、搜索等 |

你会在两边看到两份互不相干的对话，这是刻意的。

## 它怎么工作

![架构](docs/assets/architecture.svg)

前端仍然是官方 chat-demo，只是把请求发到宿主：宿主用 DSH 的账户凭据转发给 DeepSeek，再把流原样送回浏览器。所以浏览器里既没有 Key，也不需要你登录。

## 与官方 chat-demo 的关系

我们只打了 6 个文件、`+5/−7` 行的补丁：请求落点、品牌字标、隐藏 API Key 输入。存储与界面都是上游原样。

- 上游基准与补丁：[UPSTREAM.md](UPSTREAM.md)
- 已知差异：[FIDELITY.md](FIDELITY.md)（没登记的差异一律算 bug）

上游 MIT，本仓库同样 MIT，保留其版权与许可。

## 开发

```bash
node --test test/protocol.test.js   # 单元测试
node scripts/smoke-webview.mjs                                  # 界面冒烟（需要可调试的 Chrome）
pwsh scripts/build-webview.ps1                                  # 重新构建前端并同步产物
```

结构与硬约束见 [AGENTS.md](AGENTS.md)。

## 许可

MIT。界面来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT），品牌标识归深度求索公司所有——详见 [NOTICE.md](NOTICE.md)。



