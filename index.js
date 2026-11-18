/**
 * chat-in-dsh 宿主半边。
 *
 * 只做一件事：在 `/webchat` 下托管官方 chat-demo，并替浏览器把请求转发给 DeepSeek
 * （浏览器不持有 API Key，用户也不需要登录）。
 *
 * 网页版与 DSH 会话互不干涉：网页版用上游自带的本地存储，DSH 的会话不会出现在里面，
 * 网页版的对话也不会写进 DSH。两边的系统提示词与工具都不同，混合只会让双方都失真。
 */
import os from 'node:os'
import path from 'node:path'
import { createWebview } from './src/webview.js'

export const name = 'chat-in-dsh'
export const inject = ['webServer']

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string }} config
 */
export function apply(ctx, config = {}) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const webview = createWebview(ctx, config, home)
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/webchat',
    handler: (req, res) => webview(req, res),
  }), 'webchat.routes')
}


