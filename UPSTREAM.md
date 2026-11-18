# 上游基准

本仓库的界面与请求行为以官方开源客户端为准，不参考第三方实现。

| 项 | 值 |
|---|---|
| 仓库 | https://github.com/deepseek-ai/chat-demo |
| 许可证 | MIT |
| 基准 commit | `5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c`（tag `v0.1.1`） |

## 我们改了什么

一份补丁，七个文件，`+28/−7` 行：[`webview/patches/0001-dsh-integration.patch`](webview/patches/0001-dsh-integration.patch)

| 文件 | 改动 |
|---|---|
| `rspack.config.ts` | `apiOrigin` 默认值改为 `/webchat`，让请求打到宿主的转发路由 |
| `src/index.html` | 标题改为 `DeepSeek` |
| `src/i18n/{zh,en}.ts` | 应用名改为 `deepseek` |
| `src/components/sider/Sider.tsx` | 左上角换成官方字标 |
| `src/components/settings/SettingsDialog.tsx` | 去掉 API Key 输入框（密钥在宿主） |
| `src/services/chat/store.ts` | 启动时把 DSH 暂存的导入会话写进本地存储 |

存储、请求构造、界面组件都没有动。

## 构建

上游 `pnpm build` 用的是 POSIX 脚本（`rm -rf` + `NODE_ENV=x` 前缀），在 Windows 的 cmd.exe 下会失败。等效命令：

```powershell
$env:NODE_ENV="production"; pnpm exec rspack build -c rspack.config.ts
```

一键流程（克隆、打补丁、构建、同步产物到包内）：

```powershell
pwsh scripts/build-webview.ps1
```

产物 153 个文件、约 4.2 MB，`publicPath: 'auto'` 推导出相对根，因此可以挂在 `/webchat/` 下（访问地址必须带尾斜杠）。产物随仓库分发，安装者不需要自己构建。

