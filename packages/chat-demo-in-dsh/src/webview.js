/**
 * `/webchat` 的 HTTP 面：
 *   静态资源 —— 托管 chat-demo 的构建产物（已按 DSH 打过补丁）；
 *   模型代理 —— 浏览器不发 API key，由宿主用 DSH 的账户凭据代发；
 *   会话桥   —— 网页版的会话读写（见 sessions.js）。
 *
 * 目标：打开页面就是 DeepSeek 网页版的样子，不需要填任何密钥。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSessionStore } from './sessions.js'
import { DEFAULT_BASE_URL, TOKEN_HEADER, apiRoot } from './protocol.js'

/** 构建产物位置（包内自带，安装即可用）。 */
const DIST = fileURLToPath(new URL('../webview/dist/', import.meta.url))

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.map': 'application/json; charset=utf-8',
}

/**
 * 页面启动前把"已经登录"的状态铺好，用户看不到 API key 表单。
 * 与上游 settings.js 的 localStorage 键一致。
 */
const BOOTSTRAP = `<script>(function(){try{var s=window.localStorage;
if(!s.getItem('chat-demo:api-key'))s.setItem('chat-demo:api-key','dsh-webchat');
if(!s.getItem('chat-demo:locale'))s.setItem('chat-demo:locale','zh-CN');
if(!s.getItem('chat-demo:thinking'))s.setItem('chat-demo:thinking','true');
}catch(e){}})();</script>`

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
})

/** 读取并缓存注入了引导脚本的入口页。 */
let cachedIndex

function readIndex() {
  if (cachedIndex === undefined) {
    const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
    cachedIndex = html.replace(/<head>/iu, `<head>${BOOTSTRAP}`)
  }
  return cachedIndex
}

/**
 * 把上游请求原样转发给 DeepSeek，鉴权换成 DSH 账户凭据。
 * 流式响应直接透传，浏览器的 SSE 解析代码不用改。
 */
async function proxyMessages(ctx, config, request) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    return json({ error: { message: '尚未登录 DeepSeek，或该端点不接受 DSH 账户凭据' } }, 401)
  }
  const body = await request.text()
  const upstream = await fetch(`${apiRoot(baseURL)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      [TOKEN_HEADER]: token,
    },
    body,
  })
  const headers = new Headers({ 'cache-control': 'no-cache' })
  const contentType = upstream.headers.get('content-type')
  if (contentType !== null) headers.set('content-type', contentType)
  return new Response(upstream.body, { status: upstream.status, headers })
}

/** 静态文件响应；不允许跳出产物目录。 */
function serveStatic(relative) {
  const target = path.resolve(DIST, relative)
  if (!target.startsWith(path.resolve(DIST))) return new Response('forbidden', { status: 403 })
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return new Response('not found', { status: 404 })
  const type = MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream'
  return new Response(fs.readFileSync(target), { headers: { 'content-type': type } })
}

/**
 * 建立请求处理器。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string, search?: boolean, language?: string }} config
 * @param {string} home DSH_HOME
 */
export function createWebview(ctx, config, home) {
  const store = createSessionStore(home)

  return async function handle(request) {
    const url = new URL(request.url)
    const { pathname } = url
    const method = request.method.toUpperCase()

    // ---- 模型代理 ----
    if (pathname === '/webchat/models') {
      return json({ object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] })
    }
    if (pathname === '/webchat/anthropic/v1/messages') {
      if (method !== 'POST') return json({ error: { message: 'method not allowed' } }, 405)
      try {
        return await proxyMessages(ctx, config, request)
      } catch (error) {
        return json({ error: { message: String(error?.message ?? error) } }, 502)
      }
    }
    if (pathname.startsWith('/webchat/anthropic/v1/files')) {
      return json({ error: { message: '附件上传暂未接入（见 FIDELITY F9）' } }, 501)
    }

    // ---- 会话桥 ----
    if (pathname === '/webchat/api/sessions' && method === 'GET') {
      return json(store.list())
    }
    const sessionMatch = /^\/webchat\/api\/sessions\/([^/]+)(\/title)?$/u.exec(pathname)
    if (sessionMatch !== null) {
      const id = decodeURIComponent(sessionMatch[1])
      const isTitle = sessionMatch[2] !== undefined
      if (method === 'GET' && !isTitle) {
        const session = store.get(id)
        return session === undefined ? new Response('not found', { status: 404 }) : json(session)
      }
      if (method === 'PUT' && isTitle) {
        const body = await request.json().catch(() => ({}))
        const updated = store.rename(id, String(body.title ?? ''))
        return updated === undefined ? new Response('not found', { status: 404 }) : new Response(null, { status: 204 })
      }
      if (method === 'PUT' && !isTitle) {
        const body = await request.json()
        store.save(body)
        return new Response(null, { status: 204 })
      }
      if (method === 'DELETE') {
        store.remove(id)
        return new Response(null, { status: 204 })
      }
    }

    // ---- 静态资源 ----
    if (pathname === '/webchat' || pathname === '/webchat/') {
      return new Response(readIndex(), { headers: { 'content-type': MIME['.html'], 'cache-control': 'no-store' } })
    }
    if (pathname === '/webchat/brand-mark.svg') {
      const mark = path.join(DIST, '../logo-mark-light.svg')
      if (fs.existsSync(mark)) {
        return new Response(fs.readFileSync(mark), { headers: { 'content-type': MIME['.svg'] } })
      }
    }
    if (pathname.startsWith('/webchat/')) {
      return serveStatic(pathname.slice('/webchat/'.length))
    }
    return new Response('not found', { status: 404 })
  }
}
