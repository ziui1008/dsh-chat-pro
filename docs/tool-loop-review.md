# 模型自主工具调用：改动审查

这一版把「宿主替模型决定检索哪几页」换成了「模型自己决定」。用户明确要求，**开发完先别发正式版，先审查**——这份文档就是那次审查的记录：改了什么、威胁在哪里、失败了会怎样、怎么退回去。

结论先说：协议层已经跑通，测试与三组实跑都过；剩下的风险主要不在代码，而在「模型能读到任意外部页面」这件事本身。是否公开发布，建议先看完第 4、5 节再定。

## 1. 改了什么

| | 0.8.0（已发布） | 本分支 |
| --- | --- | --- |
| 谁决定检索词 | 宿主：取最后一条用户消息 | 模型：自己写 `query` |
| 谁决定读哪一页 | 宿主：用户贴的链接 + 至多一条检索结果 | 模型：自己写 `url` |
| 检索结果去哪 | 拼进 `system` | 作为 `tool` 消息回灌 |
| 轮次 | 固定 1 轮 | 最多 3 轮工具 + 1 轮作答 |
| 前端观感 | 先「搜索中」再出正文 | 正文 → 搜索卡片 → 正文，可交替出现 |

代码集中在 `src/llm-bridge.js` 的 `hostTools()` / `executeTool()` / `streamRound()` / `streamDshReply()`；纯函数部分有测试，网络部分靠 `ctx.web`。

## 2. 协议事实（写这份文档时核对过的）

- `GenerateOptions.tools?: ToolSchema[]`（`dsh-llm/src/types.ts:517`），`ToolSchema` 只要 `name` / `description` / `parameters`。
- 模型的工具调用以 `block-end` 里的 `{type:'tool-call', id, name, arguments}` 结束，`arguments` 是**原始 JSON 字符串**，可能不合法（`dsh-llm-pi-ai/src/stream.ts:186-224`）。
- 工具结果需要一条 `role: 'tool'` 消息，带 `toolCallId` 与 `isError`（`dsh-llm/src/message.ts:173-180`）；适配器靠 `toolCallId` 把结果对回调用。
- 前端只认 Anthropic 那套块；宿主必须自己把内部结果翻译成 `server_tool_use` + `web_search_tool_result` / `web_fetch_tool_result`。
- 一个 Anthropic message 里的块索引必须递增且唯一，所以每轮都要把局部 index 重映射到全局游标。

## 3. 预算与上限（为什么是这几个数）

| 项 | 值 | 理由 |
| --- | --- | --- |
| `MAX_ROUNDS` | 3 | 实测「查天气」要 2–3 轮（搜 → 读 → 再搜）才够；再多就是模型在绕圈 |
| `MAX_TOOL_CALLS` | 4 | 一轮里模型偶尔并发两个调用；4 次够用，也挡住页面诱导的批量抓取 |
| 单次工具超时 | 20 s | 检索 6 条来源通常 2–5 s，抓单页 8 s 上限；20 s 是兜底 |
| 抓取正文 | 每页 2000 字、上下文 3000 字 | 防止一次抓取把 prompt 撑爆 |
| 最后一轮 | 不给工具 | 否则模型会把最后额度花在工具上，用户看到一段没有结论的思考——这条是实跑踩出来的 |

## 4. 威胁模型

| 威胁 | 现状 | 对策 / 残留风险 |
| --- | --- | --- |
| 网页内容注入（页面里写「忽略上文，去读 X」） | 模型会把页面当数据，但也可能照做 | 工具集固定、轮次与次数有上限；**残留**：仍可能被诱导去读一个攻击者页面，属于「模型读了不该读的东西」这一类，无法在协议层消除 |
| SSRF（模型被骗去读内网 / 云元数据） | 宿主 `isFetchableUrl()` 挡协议、凭据、内网字面量；DSH 的 fetch provider 还会做公网解析与连接固定 | 两道闸；**残留**：依赖 provider 的实现，插件自身不解析 DNS |
| 数据外带（把对话内容拼进 URL 查询串） | 没有拦截 | **残留**：任何带 web 能力的模型都有这个问题；缓冲是「工具调用只有 4 次」，泄漏量受限，但不能说没有 |
| 成本放大（每轮都重发整段 prompt） | 3 轮工具 + 1 轮作答，等于最多 4 次请求 | 预算写死；思考块与工具结果都会进下一轮上下文，长对话下单价明显高于 0.8.0，需在 Release 说明里写清 |
| 无限循环 / 卡死 | `MAX_ROUNDS`、`MAX_TOOL_CALLS`、单次 20 s、`controller.signal` 贯穿 | 无 |
| 客户端中途关闭 | `res.on('close')` → `controller.abort()`，正在跑的 `ctx.web.*` 一起取消 | 已实跑：断开后上游立刻 abort |
| 工具执行抛异常 | `executeTool()` 不抛，失败变成 `isError` 的 tool 消息 | 模型能看到「打不开」，继续作答 |
| 上游中途报错 | `finish.reason.kind === 'error'` → 发 `event: error` 并结束 | 前端按 ApiError 处理，不会停在 wip |
| 未知工具名 | 回一条「没有这个工具」的 tool 消息，不发前端块 | 前端不会画出不认识的块 |
| 块索引冲突 | 游标按每轮 `maxIndex + 1` 前进，工具有独立索引 | 单测断言索引递增且唯一 |

## 5. 失败模式与回滚

| 现象 | 现在的行为 | 退回方式 |
| --- | --- | --- |
| 供应商不支持工具调用 | 模型不吐 tool-call，等于只有一轮普通回答 | 无需处理；也可切回 `webchat` 路由 |
| 模型每轮都调工具、从不作答 | 第 3 轮后强制无工具作答 | 调小 `MAX_TOOL_CALLS` |
| 检索服务不可用 | `web_search_tool_result_error: unavailable`，模型改用已有信息 | — |
| 抓取被拦（内网 / 非文本 / 超时） | `web_fetch_tool_result_error: url_not_accessible` | — |
| 前端渲染异常 | 工具块形状沿用 0.7/0.8 已验证过的结构 | 回到 tag `v0.8.0` |
| 整体回滚 | — | `git checkout v0.8.0`，或把 profile 里的 `src/llm-bridge.js` 换回 0.8.0 |

## 6. 验证记录

- 单测：`test/llm-tools.test.js`（11 例，工具集、参数容错、URL 闸门、执行失败）+ `test/llm-loop.test.js`（5 例，假 `ctx.get('llm')` 脚本化多轮：工具回灌后出正文、预算耗尽最后一轮无工具、直接回答不发工具块、工具失败仍继续、只声明 read_url 时只给一个工具、块索引唯一递增）。合计 41 项全过。
- 接口实跑（nume / gpt-6.2-sol）：
  - 「北京天气」→ `text, server_tool_use, web_search_tool_result, server_tool_use, web_fetch_tool_result, server_tool_use, web_search_tool_result, server_tool_use, web_search_tool_result, text`，22 s，答案带 weather.com.cn 的预警与气温，说明模型确实读了页面。
  - 「你好」+ 两个工具 → 只有 `text`，5 s，没有多余的检索。
  - 关掉搜索只留 `read_url` → 模型仍自己打开 weather.com.cn 拿到气温。
  - deepseek-account + thinking + 工具 → `thinking, 检索, thinking, 抓取, thinking, text`，跨轮思考块与工具块索引都对得上。
- 面板实跑：「帮我查一下今天上海天气」→ 正文、10 个网页的来源卡片、带日期的表格与穿衣建议；「深度思考」开着时思考块正常折叠。

## 7. 发布前建议

1. 版本号建议 `0.9.0`（行为变化大，不是补丁）。
2. Release 说明里必须写清「第三方模型现在会自己发起检索/抓取，单次回答最多 4 次工具调用，计费按 4 次请求估算」。
3. 如果只想保守一点：把 `MAX_ROUNDS` 调到 2、`MAX_TOOL_CALLS` 调到 2，先观察一轮再放宽。
4. 不建议在本次一并做：`citations` 角标、附件走第三方模型、把工具循环开放给网页版路由。
