# 上游基准

本仓库的协议与界面行为以官方开源客户端为准，不参考第三方逆向实现。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/chat-demo |
| 许可证 | MIT |
| 基准快照 | `main` 分支，取于 2026-11-18 |
| 基准 commit | **待补**：M1 首次拉取时写入完整 SHA，此后只在有意识升级时变更 |
| 关键文件 | `src/services/chat/store.ts`（请求体）、`src/services/chat/reply.ts`（消息组装）、`src/services/chat/latestReminder.ts`（元信息行）、`src/services/api/types.ts`（协议类型） |

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
