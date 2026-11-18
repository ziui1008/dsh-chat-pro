# 网页版到底给模型发什么——官方证据版

> 调研于 2026-11-18。不再依赖"泄露提示词"这类二手信息：DeepSeek 在 2026-11-13 把 App 的整套能力做成了 API，并开源了与网页版同款的前端 `deepseek-ai/chat-demo`。以下全部来自官方源码与官方文档。

## 0. 一句话结论

网页版**只有一句系统提示词**，每轮额外塞一条 `latest_reminder`（日期、星期、地区、平台、语言），工具是**0–2 个服务端工具**、由模型自己决定用不用，客户端不执行任何工具。

## 1. 证据链

| 来源 | 说了什么 |
|---|---|
| [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo) 源码 | 网页版同款前端，请求体逐字段可读（本文主要依据） |
| [Build a Chatbot](https://api-docs.deepseek.com/guides/build_a_chatbot) | "The DeepSeek API offers the same conversation features as DeepSeek Chat on the web and in the app" |
| [Web Tools](https://api-docs.deepseek.com/guides/web_tools) | 服务端工具 `deepseek_web_search` / `deepseek_read_url` 的完整协议 |
| [User Metadata Marker](https://api-docs.deepseek.com/guides/latest_reminder) | `latest_reminder` 角色的格式与约束 |
| [DeepSeek-R1 README](https://github.com/deepseek-ai/DeepSeek-R1) | 早期官方口径："在官方 web/app 我们不用系统提示词，只为文件上传和联网搜索设计了两个特定提示；web/app 的温度是 0.6" |

## 2. 网页版一次请求的完整形态

```js
// src/services/chat/store.ts:999-1011
{
  model: 'deepseek-flash',                       // 或 deepseek-v4-pro
  system: '该助手为DeepSeek，由深度求索公司创造。',   // 就这一句
  messages: [ latest_reminder?, user, assistant, ... ],
  thinking: { type: 'enabled' | 'disabled' },    // 深度思考开关
  tools: [                                       // 见下方 serverTools()
    { type: 'deepseek_read_url',  name: 'deepseek_read_url' },
    { type: 'deepseek_web_search', name: 'deepseek_web_search' },  // 仅当智能搜索打开
  ],
  safety_check: { level: 'high' },
  title: { enabled: true },                      // 仅自动起标题的那一轮
  stream: true,
}
```

`store.ts:48-57` 写得很明确：

> 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。

也就是说 `deepseek_read_url` **每轮都在**，`deepseek_web_search` 只在"智能搜索"开着时才声明。没有温度参数。

### 2.1 `latest_reminder`：网页版真正藏东西的地方

格式 `<日期>,<星期>,<地区>,<平台>,<语言>`，例如：

```
2026-11-18,星期二,上海,Web,中文
```

- 它是 Anthropic 协议之外的**扩展角色**，紧贴在该轮 user 消息前面。
- 日期与星期按浏览器本地时区算，避免 UTC 跨日。
- 平台固定 `Web`（App 里是 `App`）。
- **语言是本轮用户的语言**，取值为官方枚举里的 `中文` / `中文繁體` / `English` …
- 只在内容变化时插入一次，历史里的旧快照原样回传（为了命中缓存）。

### 2.2 历史怎么回传（决定了"每轮的工具"为什么看起来时有时无）

- assistant 只回传**正文**，思考块丢弃。
- 搜索结果块、页面打开结果**都不进历史**——只有正文进下一轮。
- 唯一的例外：`read_link` 的调用块和结果块原样回传，页面正文加密在 `signature` 里，服务端解密后把页面拼回那一轮提问末尾。
- 消息只保留"提问 + 有可用回答"的成对轮次。

## 3. 对你三个观察的核对

**① "系统提示词应该确实精简" —— 成立，而且比精简更极端**

官方源码里就一句 22 字。2025 年那份泄露版还多两句（`今天是{date}`、`模型温度值设为 0.6`），到 2026 年日期已经移到 `latest_reminder`、温度不再写进提示词，剩下的就只有这一句。

**② "网页版不是没有工具，是每轮动态的" —— 成立，你观察得准**

- 工具**声明**跟着请求走：`read_url` 恒在，`web_search` 看开关。
- 用不用由**模型自己决定**（文档原话："The model decides whether to go online"）。
- 结果块只在**那一轮**出现，下一轮不带 → 看起来就是"有时候有搜索、有时候没有"。
- 而且这些是**服务端工具**，客户端一行执行代码都没有：搜索、打开页面、页内查找全在服务端跑。

**③ "思考是中文的，第一句是'我们需要回答中文'" —— 最可能的原因找到了**

网页版每轮都用 `latest_reminder` 告诉模型「语言 = 中文」，系统提示本身也是中文。而 DSH 从头到尾**没有任何一处声明语言**，工具说明全是英文，每轮第一句反而是 `Time sampled while preparing turn 1, step 1: …`。

模型在"这一段是中文对话"的语境里想中文，在"这是一份英文工程文档"的语境里想英文。这句"灵感"大概率不是玄学，是那条语言字段。

（旁证：DSH 社区已有两个插件专门在请求末尾追加中文思考提醒，都报告"系统提示里写没用，末尾提醒才有效"。）

## 4. DSH 现状 vs 网页版

| | 网页版 | DSH 当前（cordis 预设） |
|---|---|---|
| system | 22 字，中文 | 6,367 字，英文 |
| 每轮元信息 | `2026-11-18,星期二,上海,Web,中文` 一行 | 英文时间长句 + 工作目录 + 沙箱策略 + 审批策略 + 技能目录（约 5.4k 字） |
| 工具 | 0–2 个**服务端**工具 | 39 个**客户端**工具（39,162 字符 schema） |
| 工具执行 | 服务端；客户端不执行 | 客户端本地执行 |
| 工具结果进历史 | 只有正文进，工具块丢弃 | 工具调用与结果都进历史 |
| 思考 | 开关；上下文是中文 | `reasoningEffort: high/max`；上下文是英文 |
| temperature | 0.6（无工具时） | 从不发送（adapter 没有这个字段） |
| 标题 | 同一请求里 `title:{enabled:true}` | 单独的请求 |
| 安全审核 | `safety_check: high` | 无 |

## 5. 差距分三档，成本差很多

### A 档：现在就能对齐，几乎零成本

1. `system` 换成官方原文：`该助手为DeepSeek，由深度求索公司创造。`
2. 工具清零（或只留一个"什么都不做"的场景）。
3. 关掉运行时上下文（工作目录、沙箱、审批、技能目录）。

→ 这三点一个 preset 就够（已装的 `webchat` 预设就是干这个的，只差把文案改成官方原文）。

### B 档：需要一个 host 插件，但不改协议

4. **用 `ctx.systemPrompt.context()` 注入 `latest_reminder` 同格式的一行**（user 角色快照）。
   这是最高性价比的一步：DSH 的 context 机制本来就产出 user 角色消息，只要把文案从英文长句换成 `日期,星期,地区,Web,中文`，语言字段就有了。
   代价：拿不到官方那个 `latest_reminder` **角色**（DSH 的消息类型里没有），只能用 user 角色近似——角色名不同，但语义信息一致。

### C 档：要动 adapter，成本和风险都上一个台阶

5. **服务端工具** `deepseek_web_search` / `deepseek_read_url`：需要在 `dsh-llm-deepseek` 里支持非 function-schema 的 tools 字段，并解析 `server_tool_use` / `web_search_tool_result` / `web_fetch_tool_result` 三种新块，还要在历史里按规则回传（read_link 带 signature，其余丢弃）。这是协议级改造，不是配置。
6. **temperature 0.6**：adapter 目前根本不发；而且开了服务端工具后服务端会忽略这个字段，收益有限。
7. `safety_check`、`title`：都依赖 5 的扩展模式。

## 6. 建议顺序

1. 先做 A 档（改文案 + 零工具），此时已经是"网页版骨架"。
2. B 档只做第 4 条（`latest_reminder` 同格式一行）——很可能就解决"中文思考"和"灵气"的大部分。
3. C 档按需：如果你确实需要对等联网体验（引用、边想边搜），再论证改 adapter 的代价；否则 DSH 现有的 `web_search` 工具够用，只是形态不同。

## 附：证据文件

- `evidence/store.ts` — 官方 chat-demo 的会话/请求实现（`SYSTEM_PROMPT` 在第 38 行，请求体在第 999-1011 行）
- `evidence/system-prompt.txt` — DSH 本会话实际系统提示（6,367 字）
- `evidence/session.jsonl` — DSH 会话日志（含 39 个工具的 schema 与采样配置）
