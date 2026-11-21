# 访问检查评审：给 `/webchat` 接上 DSH 的准入

> 背景：插件被收录进 `awesome-dsh-plugin` 后，维护者在条目描述里加了一句风险提示——
> 「它的 HTTP 路由没有 DSH 的访问检查（没有 `ctx.connection.requestRejection`），
> 浏览器里打开的网页可以调用它们」。这份记录回答两件事：这句话现在是否已经不成立，
> 以及补上检查之后有没有把面板自己挡在门外。

## 1. 改了什么

| 文件 | 改动 |
| --- | --- |
| `src/webview.js` | 新增 `rejectWithoutSession(ctx, req)`；`createWebview` 的 handler 在解析路径之后、任何路由之前调用它，被拒直接 `403` / `401` 并 `connection: close` |
| `src/dsh-import.js` | `ackPending` 与 `findSessionFile` 只接受单段会话 id（`/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/`），`../` 一律忽略 |
| `test/webview-guard.test.js` | 4 条：无服务放行、403、401、通过时把原始 `req` 交给 `connection` |
| `test/dsh-import-paths.test.js` | 3 条：越界 id 不删文件、只删暂存区、会话 id 不许穿目录 |
| `README.md` / `AGENTS.md` | 安全边界改成现在的实情；验证清单加一条「改路由时不要绕开这道检查」 |

## 2. 事实依据（不是猜的）

`requestRejection` 是 DSH 自己给 `/api` 用的准入函数，实现分两层：

- **Host / Origin 围栏**：`dsh-client-connection/lib/index.js:240-250` 的 `isTrustedApiRequest` —— Host 必须是 loopback、配置里的 trusted host 或绑定地址；`sec-fetch-site: cross-site` 直接拒；有 `Origin` 时必须是同一个 authority。
- **会话凭据**：同文件 `:737-750` 的 `requestRejection` → `admit` → `browserAuth.isAuthenticated(request, secure)`；没有就走 API 令牌通道，仍没有就是 `401`。

也就是说，返回值只有三种：`403`（来源不对）、`401`（没有会话）、`undefined`（放行）。

面板为什么还能通过：

- **桌面版**：窗口加载 `dsh-app://app`，请求经 `forwardWebRequest`（`app/lib/main.js:15361-15391`）转发——它会删掉 `host` / `origin` / `cookie` / `sec-fetch-site`，注入 shell 持有的 `dsh-auth-*` cookie。到了宿主那边，Host 由 fetch 重新填成 `127.0.0.1:<port>`（loopback 通过围栏），没有 Origin（通过围栏），cookie 有效（通过凭据检查）。
- **浏览器直连**：面板与 DSH 同源，打开带 `token` 的启动 URL 后 cookie 落在 `127.0.0.1:<port>`，面板的 `fetch` 自然带上；`Origin` 与 Host 同 authority。

## 3. 威胁模型

| 场景 | 现在的结果 | 依据 |
| --- | --- | --- |
| 用户浏览器里别的网页 `fetch('http://127.0.0.1:port/webchat/api/import/pending')` | 403（`Origin` 不匹配）或 401（没有 cookie） | 围栏 + 凭据 |
| 恶意网页用 `<img>` / `<form>` 这类无预检请求 | 同样被挡；且表单 POST 带 `Origin` | 同上 |
| DNS rebinding：域名解析到 127.0.0.1 | `Host` 是攻击者域名，非 loopback 且不在 trusted hosts → 403 | `isTrustedApiRequest` 的 Host 判定 |
| 同网段直连端口（用户把 web server 绑到 `0.0.0.0`） | 401：连上了端口，但没有该机器的 DSH 会话 cookie | 凭据层 |
| 本机上另一个进程直接读 `~/.dsh` 或改文件 | 不在本检查范围内（本地同用户权限本来就共享） | 设计边界 |
| 插件把请求转发到 DeepSeek 上游 | 不受影响：那是宿主出站，不经本检查 | `proxyMessages` |

## 4. 验证矩阵

| 层 | 用例 | 结果 |
| --- | --- | --- |
| 单元 | `rejectWithoutSession` 的四种返回 | 4/4 通过 |
| 单元 | 导入路径消毒（越界 id、只删暂存、会话 id 穿目录） | 3/3 通过 |
| 负向 HTTP | 无 cookie 直连 `/webchat/api/catalog` | `401` |
| 负向 HTTP | 无 cookie 直连 `/webchat/`、静态 JS（HEAD）、`POST /api/import/stage`、`OPTIONS /models` | 全部 `401` |
| 负向 HTTP | 带 `Origin: https://evil.example` 请求 `/webchat/models` | `403` |
| 负向 HTTP | 伪造 `Host: evil.example:53820` | `403` |
| 正向 | 桌面版点开「网页版」：面板渲染、历史列表在、输入框可用 | 通过（`app-panel2.png`） |
| 正向 | 在面板里发「只回复两个字：收到」→ 模型回「收到」 | 通过（`app-panel3.png`） |

正向验证是怎么做的：UI Automation 找到名为「网页版」的按钮并 `Invoke`，再用 `ValuePattern` 往「请输入消息」里写字、`Invoke` 名为「发送」的按钮。合成鼠标点击不可用（DPI 1.5 下坐标换算不可靠），UIA 这条路不需要坐标。

全量单测：9 个文件 **69 项全过**（`npm test`）。

## 5. 兼容与副作用

- **旧版 DSH**：拿不到 `connection` 服务时放行（`rejectWithoutSession` 第一行就返回 `undefined`）。没有会话体系可对照，挡住只会让面板整个不可用。
- **HTTPS 部署**：`requestRejection` 内部按 `webServer.protocol` 决定 cookie 的 secure 语义，插件不额外判断。
- **行为变化**：未登录时直接在浏览器打开 `http://127.0.0.1:<port>/webchat/` 会看到 `dsh web authentication required; reopen the URL printed by dsh web.`，以前能直接看到面板。这与 DSH 自己的 `/` 行为一致。
- **被拒的 POST**：请求体没有读，响应带 `connection: close`，避免客户端往被丢弃的 socket 里继续写。

## 6. 正向确认（已完成）

桌面版点开左侧「网页版」后：面板正常渲染、历史会话在、发一条消息能收到回复（`app-panel2.png` / `app-panel3.png`）。说明 `forwardWebRequest` 注入的 cookie 能通过 `requestRejection`，准入没有误伤面板自己。

这条不能靠「代码看着一样」推断——它依赖桌面代理转发时对 `host` / `origin` / `cookie` 的重写行为，只有真跑一次才知道。

## 7. 回滚

单点回滚：把 `src/webview.js` 里 `rejectWithoutSession` 那一段连同调用删掉即可，导入路径消毒与它无关，可以保留。提交 `9901035` 是这一批改动的边界。
