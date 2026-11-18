# 上游基准

本仓库的协议与界面行为以官方开源客户端为准，不参考第三方逆向实现。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/chat-demo |
| 许可证 | MIT |
| 基准快照 | `main` 分支，取于 2026-11-18，tag `v0.1.1` |
| 基准 commit | `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（`fix: clarify history import errors and release v0.1.1`） |
| 关键文件 | `src/services/chat/store.ts`（请求体）、`src/services/api/client.ts`（端点）、`src/components/sider/Sider.tsx`（品牌） |

## 引入方式

**尚未决定**，M2 前端里程碑开工前必须定稿。候选：

1. **Git submodule** 固定到上游 commit，构建时打补丁 —— 上游清晰、diff 最干净，但贡献者要懂 submodule。
2. **`vendor/chat-demo/` 内联快照** + `patches/*.patch` —— 上手简单，仓库体积变大。
3. **GitHub fork 作为 npm 依赖** —— 安装流程简单，但依赖网络与上游可见性。

当前倾向：**方案 2**。理由是本项目对上游前端要做的改动集中在数据层（`src/services/chat/store.ts`、`db.ts`、`history/`），改动面固定且可枚举，内联快照 + 补丁比 submodule 更适合"改一个已有的前端"，也便于在 GitHub 上 review 我们到底改了什么。

## 上游契约（供比对）

一次生成请求的完整形态，字段顺序与取值以 `store.ts:999-1011` 为准：

```js
{
  model: 'deepseek-flash',
  system: '该助手为DeepSeek，由深度求索公司创造。',
  messages: [ /* latest_reminder?, user, assistant, ... */ ],
  thinking: { type: 'enabled' | 'disabled' },
  tools: [ { type: 'deepseek_read_url', name: 'deepseek_read_url' },
           /* 智能搜索开启时追加 */ { type: 'deepseek_web_search', name: 'deepseek_web_search' } ],
  safety_check: { level: 'high' },
  title: { enabled: true },   // 仅自动起标题的那一轮
  stream: true,
}
```

不含 `temperature`。`latest_reminder` 格式：`<日期>,<星期>,<地区>,<平台>,<语言>`，如 `2026-11-18,星期二,上海,Web,中文`，只在变化时插入。

## 构建（Windows）

上游 `pnpm build` 脚本是 POSIX 语法（`rm -rf` + `NODE_ENV=x` 前缀），在 cmd.exe 下失败。等效命令：

```powershell
$env:NODE_ENV="production"; pnpm exec rspack build -c rspack.config.ts
```

产物 `dist/`：153 文件 / 4.19 MB，`publicPath: 'auto'` 推出相对根，可直接挂在 `/webchat/` 下（**必须以带尾斜杠的 URL 访问**）。`__API_ORIGIN__` 是编译期 DefinePlugin 注入；`createConfig({ apiOrigin })` 已导出，可用自定义 config 文件改，无需改动源码。

## 追加（2026-11-18）

- 补丁：[`webview/patches/0001-dsh-integration.patch`](webview/patches/0001-dsh-integration.patch)（6 文件，+49/−215）
- 改动点：`rspack.config.ts`（`apiOrigin = '/webchat'`）、`index.html` 与 `i18n/*`（品牌）、`Sider.tsx`（官方字标）、`SettingsDialog.tsx`（去掉 API Key 输入）\n- 存储保持上游原样（IndexedDB），不再接宿主会话
- 构建：`pwsh scripts/build-webview.ps1`，产物同步到 `packages/chat-demo-in-dsh/webview/dist` 并随仓库分发（安装即用，用户不必构建）

