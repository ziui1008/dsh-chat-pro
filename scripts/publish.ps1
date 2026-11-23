#!/usr/bin/env pwsh
# 发布 dsh-chat-pro 到 npm，并在发布后核对线上版本。
# 前置：本机已 `npm login`（或 ~/.npmrc 里有带 publish 权限的 token）。
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)

$name = (Get-Content package.json -Raw | ConvertFrom-Json).name
$version = (Get-Content package.json -Raw | ConvertFrom-Json).version

Write-Host "== 检查登录状态 ==" -ForegroundColor Cyan
$who = npm whoami 2>&1
if ($LASTEXITCODE -ne 0) {
  Write-Host "未登录，先执行 npm login（浏览器授权后再运行本脚本）。" -ForegroundColor Red
  exit 1
}
Write-Host "登录账号：$who"

Write-Host "== 检查包名是否已被占用 ==" -ForegroundColor Cyan
$err = npm view $name version 2>&1
if ($LASTEXITCODE -eq 0) {
  Write-Host "警告：$name 已存在，线上版本 $err（本次发布会覆盖该版本号或报 E403）。" -ForegroundColor Yellow
} else {
  Write-Host "$name 在 npm 上还没有发布记录，可以占用。"
}

Write-Host "== 跑测试（prepublishOnly 也会再跑一次）==" -ForegroundColor Cyan
npm test
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "== 发布 ==" -ForegroundColor Cyan
npm publish --access public
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "== 核对 ==" -ForegroundColor Cyan
npm view $name version dist.tarball
Write-Host "完成：https://www.npmjs.com/package/$name/v/$version" -ForegroundColor Green
