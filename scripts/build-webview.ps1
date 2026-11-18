# 重新构建网页版前端并同步到插件包内。
#
# 前置：Node 22.12+、pnpm、git。首次运行会克隆上游 chat-demo。
# 为什么不用上游的 `pnpm build`：它的脚本是 POSIX 语法（`rm -rf` + `NODE_ENV=x` 前缀），
# 在 Windows 的 cmd.exe 下失败。这里直接调 rspack，产物完全一致。

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$vendor = Join-Path $root 'webview\vendor\chat-demo'
$patch = Join-Path $root 'webview\patches\0001-dsh-integration.patch'
$dist = Join-Path $root 'webview\dist'
$upstream = '5d5dd754ebc1948e977ddb880a9eb5aa25f37b4c'

if (-not (Test-Path $vendor)) {
  git clone https://github.com/deepseek-ai/chat-demo.git $vendor
}

Push-Location $vendor
try {
  git checkout $upstream
  git checkout -- .
  git apply $patch
  pnpm install
  $env:NODE_ENV = 'production'
  pnpm exec rspack build -c rspack.config.ts
} finally {
  Pop-Location
}

if (Test-Path $dist) { Remove-Item -Recurse -Force $dist }
Copy-Item -Path (Join-Path $vendor 'dist') -Destination (Split-Path $dist -Parent) -Recurse -Force
Write-Host "已同步到 $dist"

