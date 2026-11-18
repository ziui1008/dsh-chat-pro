# 变更记录

## v0.2.0 — 2026-11-18

**网页版界面**

- `/webchat/` 托管官方 chat-demo 构建产物，安装即用，不需要用户 clone 或构建上游
- 聊天与附件全部改走 `handler` 路由（`resource` 路由只接受 GET/HEAD，POST 一律 405）
- 设置里不再出现 API Key 输入框，首次打开也不会弹密钥表单
- 左上角换成 DeepSeek 官方标识，标题与应用名改为 `DeepSeek`

**通道**

- 修复 `Assistant stream chunk must be losslessly JSON-serializable`：usage 去掉 `undefined`，所有 chunk 走一次 JSON 往返
- 智能搜索经代理实测：2 个 `server_tool_use`、1 个 `web_search_tool_result`（15 条结果）、3 个引用增量

**会话**

- 网页版新建的会话镜像进 DSH 事件日志（`agentLoop.create` + `session.append` + `flush`），落在最近活跃的工作区
- 读 DSH 日志支持多帧 zstd（Node 的内置解压只解第一帧，这里按魔数切帧）
- 按 `turn` 合并 assistant 的多条记录，丢弃 DSH 注入的运行时上下文

**其他**

- `/webchat/api/self-test`：入口页、静态资源、会话列表、会话详情、一次真实生成，五项一键自检
- DSH 页签「插件 → DeepSeek」注册为 `plugins.tab`，浏览器打开 `/webchat/` 同样可用
- 8 项单元测试

## v0.1.0 — 2026-11-18

- 仓库与规范（`AGENTS.md` / `UPSTREAM.md` / `FIDELITY.md`）
- `deepseek-webchat` 模型通道：官方请求形态、`latest_reminder`、服务端工具声明、中文思考

## v0.2.1 — 2026-11-18

- DSH 内入口重做：会话标题栏新增「网页版」View（只渲染当前会话），左侧面板新增「DeepSeek」（完整界面，带会话列表）；不再占用插件页签
- 品牌标识改用官网 `web-logo.svg`（与官方逐字节一致），前端支持 `?embed=1` 与 `?session=<id>`

## v0.2.2 — 2026-11-18

- 双向实时同步：网页版视图每 1.5 秒从宿主拉取同一会话，DSH 原生聊天里新产生的问答会出现在网页版；网页版发出的消息经镜像写入同一个 live 会话，DSH 侧随事件更新
- 会话不再保留影子副本：DSH 本来就有的会话只追加事件，唯一来源是 DSH 日志（网页版新建的会话仍保留自己的记录）

## v0.2.3 — 2026-11-18

- 左侧面板与会话视图改用「按容器矩形铺满到窗口底部」的固定层，不再因主区域留白而在底部露出空白，也顺带盖住 DSH 常驻输入框
- 侧栏图标只保留官方小鲸鱼（品牌蓝 #3964FE），内联为 data URI，不依赖额外请求
- 网页版保存后通过 postMessage 通知宿主，DSH 原生聊天调用 refreshProjections 刷新同一条会话
- 镜像改为「先 resume 再 create」，已落盘但未存活的会话也能续写
