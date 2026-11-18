# chat-demo-in-dsh

把 [DeepSeek 官方开源的 chat-demo](https://github.com/deepseek-ai/chat-demo) 搬进 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。

安装一个插件，侧栏就多一个「网页版」面板。点开就是 DeepSeek 网页版：**不用装 chat-demo，不用填 API Key，不用登录**。

![架构](docs/assets/architecture.svg)

## 为什么做这个

2026 年 11 月 16 日，DeepSeek App 与网页端开始限额。随后大量用户转向 DeepSeek Harness。

他们中的许多人并不是开发者：他们要的是一个会聊天的 DeepSeek，而不是一个会改代码、会写文件、每次开口前先读六千字工程规范的智能体。

好消息是 DeepSeek 把网页版的前端开源了，也把它的请求形态写进了 API 文档。于是我们做了这个插件：**用官方那一份协议、官方那一套界面，把网页版原样搬进 DSH。**

## 功能

- **与网页版同形态的请求**：系统提示只有一句 `该助手为DeepSeek，由深度求索公司创造。`，每轮附带 `latest_reminder`（日期、星期、地区、平台、语言），工具是服务端的 `deepseek_web_search` / `deepseek_read_url`，没有温度参数，没有工程纪律。
- **中文思考**：和网页版一样，模型用中文推理。
- **智能搜索开关**：打开后声明 `deepseek_web_search`，模型自己决定搜不搜，答案带引用；关闭时仍可读链接。
- **完整界面**：Markdown、代码高亮、KaTeX 公式、Mermaid 图、思考折叠、搜索卡片、来源引用、深浅色主题、中英界面。
- **一个入口**：侧栏面板列表里的「网页版」。

## 安装

```bash
dsh plugin --profile desktop add github:YOUR-NAME/chat-demo-in-dsh
```

然后重启 DSH。

## 使用

侧栏面板列表 → **网页版**。不需要登录，不需要粘贴 Key：请求由 DSH 宿主用你已经在 DSH 里登录的 DeepSeek 账户代发。

（面板本身就是 `/webchat/` 的页面，浏览器直接访问同一个地址也能打开，但入口只有侧栏这一个。）

## 它和 DSH 自己的对话是什么关系

**没有关系，这是设计决定。**

网页版的系统提示词只有一句、工具是服务端工具；DSH 的对话带着工程规范、文件与命令工具。把它们混在一起，只会让两边都变得不对——我们试过双向同步，结论是数据模型和语义都不兼容，最后选择让它们各管各的：

| | 网页版 | DSH 对话 |
|---|---|---|
| 存储 | 浏览器本地上游存储 | DSH 会话日志 |
| 提示词 | 官方那一句 | DSH 组装 |
| 工具 | 服务端搜索/读链接 | 文件、命令、搜索等 |

所以你会在两边看到两份互不相干的对话，这是刻意的。

## 与官方 chat-demo 的关系

我们 fork 了官方前端，只改了品牌与请求落点：把 API Key 换成宿主凭据、把左上角换成官方标识。界面和交互没有动。

- 上游基准：`5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（v0.1.1），见 [UPSTREAM.md](UPSTREAM.md)
- 改动补丁：[webview/patches/0001-dsh-integration.patch](webview/patches/0001-dsh-integration.patch)，6 个文件、+5/−7 行
- 已知差异：[FIDELITY.md](FIDELITY.md)（没登记的差异一律算 bug）

上游 MIT，本仓库同样 MIT，保留其版权与许可。

## 开发

```bash
node --test packages/chat-demo-in-dsh/test/protocol.test.js   # 单元测试
pwsh scripts/build-webview.ps1                                  # 重新构建前端并同步产物
```

仓库约定与结构见 [AGENTS.md](AGENTS.md)。

## 许可

MIT。界面来自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT），DeepSeek 与 DeepSeek 标识归深度求索公司所有。
