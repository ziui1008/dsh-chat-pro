/**
 * `/webchat` 的 HTTP 面：
 *   静态资源 —— 托管 chat-demo 的构建产物（已按 DSH 打过补丁）；
 *   模型代理 —— 浏览器不发 API key，由宿主用 DSH 的账户凭据代发；
 *   会话桥   —— 网页版的会话读写（见 sessions.js）。
 *
 * 注意：DSH 的 `resource` 路由只接 GET/HEAD，POST/PUT/DELETE 一律 405，
 * 所以这里用 `handler`（Node 原生 req/res）而不是 fetch 风格。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { createSessionStore, discoverWorkspace } from './sessions.js'
import { createMirror } from './mirror.js'
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

const MAX_BODY = 64 * 1024 * 1024

/**
 * 页面启动前把"已经登录"的状态铺好，用户看不到 API key 表单。
 * 与上游 settings.js 的 localStorage 键一致。
 */
const BOOTSTRAP = `<script>(function(){try{var s=window.localStorage;
if(!s.getItem('chat-demo:api-key'))s.setItem('chat-demo:api-key','dsh-webchat');
if(!s.getItem('chat-demo:locale'))s.setItem('chat-demo:locale','zh-CN');
if(!s.getItem('chat-demo:thinking'))s.setItem('chat-demo:thinking','true');
}catch(e){}})();</script>`

/** 统一 JSON 响应。 */
export function sendJson(res, value, status = 200) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/** 读取请求体。 */
export async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BODY) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

/** 读取并解析 JSON 请求体。 */
export async function readJson(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8'))
}

/**
 * 读取入口页并注入引导脚本。
 *
 * 每次都从磁盘读：构建产物按内容哈希命名，进程里缓存旧 HTML 会让页面去请求
 * 一个已经不存在的 JS，结果是白屏。文件只有几百字节，读它的成本可以忽略。
 */
function readIndex() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  return html.replace(/<head>/iu, `<head>${BOOTSTRAP}`)
}

async function sendFile(res, file, status = 200) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(status, { 'content-type': type, 'content-length': fs.statSync(file).size })
  await pipeline(fs.createReadStream(file), res)
}

/**
 * 把上游请求原样转发给 DeepSeek，鉴权换成 DSH 账户凭据。
 * 流式响应直接透传，浏览器的 SSE 解析代码不用改。
 */
async function proxyMessages(ctx, config, req, res) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    sendJson(res, { error: { message: '尚未登录 DeepSeek，或该端点不接受 DSH 账户凭据' } }, 401)
    return
  }
  const body = await readBody(req)
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
  if (!upstream.ok || upstream.body === null) {
    const text = await upstream.text().catch(() => '')
    res.writeHead(upstream.status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(text || JSON.stringify({ error: { message: '上游请求失败' } }))
    return
  }
  res.writeHead(200, {
    'content-type': upstream.headers.get('content-type') ?? 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  await pipeline(Readable.fromWeb(upstream.body), res)
}

/** 附件上传转发：multipart 原样送到官方 Files API，返回值原样回给页面。 */
async function proxyFiles(ctx, config, req, res, pathname) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    sendJson(res, { error: { message: '尚未登录 DeepSeek' } }, 401)
    return
  }
  const target = `${apiRoot(baseURL)}${pathname.slice('/webchat/anthropic/v1'.length)}`
  const headers = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': 'files-api-2025-04-14',
    [TOKEN_HEADER]: token,
  }
  const init = { method: req.method, headers }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const contentType = req.headers['content-type']
    if (typeof contentType === 'string') headers['content-type'] = contentType
    init.body = await readBody(req)
  }
  const upstream = await fetch(target, init)
  const text = await upstream.text()
  res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8' })
  res.end(text)
}

/** 自检：把浏览器实际会走的那几条路径跑一遍，便于出问题时一眼定位。 */
async function selfTest(ctx, config, store) {
  const checks = []
  const add = (name, ok, detail) => checks.push({ name, ok, detail })
  try {
    add('index', readIndex().includes('chat-demo:api-key'), `${readIndex().length} bytes`)
  } catch (error) {
    add('index', false, String(error?.message ?? error))
  }
  const main = (() => {
    try {
      return /src="(static\/js\/[^"]+\.js)"/u.exec(readIndex())?.[1]
    } catch {
      return undefined
    }
  })()
  add('static', main !== undefined && fs.existsSync(path.join(DIST, main)), main ?? 'not found')

  const sessions = store.list()
  add('sessions', sessions.length > 0, `${sessions.length} 条`)
  if (sessions.length > 0) {
    const first = store.get(sessions[0].id)
    add('session-detail', (first?.messages?.length ?? 0) > 0, `${sessions[0].title} · ${first?.messages?.length ?? 0} 条消息`)
  }
  try {
    const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
    const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
    const response = await fetch(`${apiRoot(baseURL)}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify({
        model: 'deepseek-flash',
        system: '该助手为DeepSeek，由深度求索公司创造。',
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        thinking: { type: 'disabled' },
        tools: [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }],
        safety_check: { level: 'high' },
        stream: true,
      }),
      signal: AbortSignal.timeout(60_000),
    })
    const text = await response.text()
    add('messages', response.ok && text.includes('message_stop'), `${response.status} · ${text.length} bytes`)
  } catch (error) {
    add('messages', false, String(error?.message ?? error))
  }
  return { ok: checks.every(check => check.ok), checks }
}

/**
 * 建立请求处理器（Node 原生 req/res）。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string, search?: boolean, language?: string }} config
 * @param {string} home DSH_HOME
 */
export function createWebview(ctx, config, home) {
  const store = createSessionStore(home)
  const mirrorLog = new Map()
  // 镜像会话要落在一个真实工作区下；优先 DSH 的默认工作区。
  const preferred = discoverWorkspace(home)
    ?? ctx.get('workingDirectory')?.defaultDirectory
    ?? path.join(os.homedir(), 'Documents', 'deepseek-harness-default-workspace')
  const mirror = createMirror(ctx, { cwd: fs.existsSync(preferred) ? preferred : process.cwd() })

  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { pathname } = url
    const method = (req.method ?? 'GET').toUpperCase()
    const isGet = method === 'GET' || method === 'HEAD'

    // ---- 自检 ----
    if (pathname === '/webchat/api/self-test') {
      try {
        sendJson(res, await selfTest(ctx, config, store))
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    // ---- 模型代理 ----
    if (pathname === '/webchat/models' && isGet) {
      sendJson(res, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }, { id: 'deepseek-v4-pro', object: 'model' }] })
      return
    }
    if (pathname === '/webchat/anthropic/v1/messages' && method === 'POST') {
      try {
        await proxyMessages(ctx, config, req, res)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }
    if (pathname.startsWith('/webchat/anthropic/v1/files')) {
      try {
        await proxyFiles(ctx, config, req, res, pathname)
      } catch (error) {
        if (!res.headersSent) sendJson(res, { error: { message: String(error?.message ?? error) } }, 502)
        else res.destroy()
      }
      return
    }

    // ---- 镜像日志 ----
    if (pathname === '/webchat/api/mirror-log' && method === 'GET') {
      sendJson(res, [...mirrorLog.entries()].map(([id, entry]) => ({ id, ...entry })))
      return
    }

    // ---- 镜像自检 ----
    if (pathname === '/webchat/api/mirror-test' && method === 'POST') {
      const body = await readJson(req).catch(() => ({}))
      const id = String(body.id ?? `webchat-test-${Date.now()}`)
      const now = Date.now()
      const pairs = Number.isFinite(Number(body.pairs)) ? Math.max(1, Number(body.pairs)) : 1
      const messages = []
      for (let index = 1; index <= pairs; index += 1) {
        messages.push({ id: `${id}-u${index}`, role: 'user', content: `镜像自检提问 ${index}`, files: [], createdAt: index * 2 - 1 })
        messages.push({
          id: `${id}-a${index}`,
          role: 'assistant',
          createdAt: index * 2,
          model: 'deepseek-flash',
          thinking: false,
          search: false,
          prefix: false,
          status: 'done',
          stopReason: 'end_turn',
          blocks: [{ type: 'text', text: `镜像自检回答 ${index}` }],
        })
      }
      const sample = { id, title: '镜像自检', createdAt: now, updatedAt: now, messages }
      const result = await mirror(sample)
      const readback = store.get(id)
      const liveSession = ctx.get('sessions')?.get(id)
      let derived = []
      try {
        derived = liveSession === undefined ? [] : liveSession.deriveMessages().map(message => message.role)
      } catch (error) {
        derived = ['derive failed: ' + String(error?.message ?? error)]
      }
      sendJson(res, {
        id,
        result,
        readbackMessages: readback?.messages?.length ?? 0,
        readbackRoles: readback?.messages?.map(message => message.role) ?? [],
        derived,
      })
      return
    }
    // ---- 会话桥 ----
    if (pathname === '/webchat/api/sessions' && isGet) {
      sendJson(res, store.list())
      return
    }
    const match = /^\/webchat\/api\/sessions\/([^/]+)(\/title)?$/u.exec(pathname)
    if (match !== null) {
      const id = decodeURIComponent(match[1])
      const isTitle = match[2] !== undefined
      if (isGet && !isTitle) {
        const session = store.get(id)
        if (session === undefined) res.writeHead(404).end('not found')
        else sendJson(res, session)
        return
      }
      if (method === 'PUT' && isTitle) {
        const body = await readJson(req).catch(() => ({}))
        const updated = store.rename(id, String(body.title ?? ''))
        res.writeHead(updated === undefined ? 404 : 204).end()
        return
      }
      if (method === 'PUT' && !isTitle) {
        const body = await readJson(req)
        const saved = store.save(body)
        const result = await mirror(saved)
        mirrorLog.set(saved.id, { at: Date.now(), messages: saved.messages.length, result })
        if (mirrorLog.size > 20) mirrorLog.delete(mirrorLog.keys().next().value)
        // DSH 本来就有的会话不保留影子副本：日志是唯一来源。
        // 只有在镜像目标确实存活（内容已落盘）时才丢弃本地副本，否则保留以免丢消息。
        if (store.isDsh(saved.id) && result.live) store.remove(saved.id)
        res.writeHead(204).end()
        return
      }
      if (method === 'DELETE') {
        store.remove(id)
        res.writeHead(204).end()
        return
      }
      res.writeHead(405, { allow: 'GET, PUT, DELETE' }).end()
      return
    }

    // ---- 静态资源 ----
    if (pathname === '/webchat' || pathname === '/webchat/') {
      const html = readIndex()
      // 产物与入口页不一致时直接报出来，而不是给用户一片白屏。
      const main = /src="(static\/js\/[^"]+\.js)"/u.exec(html)?.[1]
      if (main !== undefined && !fs.existsSync(path.join(DIST, main))) {
        res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' })
        res.end(`webchat: 入口页引用的 ${main} 不存在，请重新构建前端（scripts/build-webview.ps1）`)
        return
      }
      res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'no-store', 'content-length': Buffer.byteLength(html) })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }
    if (pathname === '/webchat/brand-mark.svg' || pathname === '/webchat/panel-icon.svg') {
      await sendFile(res, path.join(DIST, '..', pathname.slice('/webchat/'.length)))
      return
    }
    if (pathname.startsWith('/webchat/')) {
      const target = path.resolve(DIST, pathname.slice('/webchat/'.length))
      if (!target.startsWith(path.resolve(DIST))) {
        res.writeHead(403).end('forbidden')
        return
      }
      await sendFile(res, target)
      return
    }
    res.writeHead(404).end('not found')
  }
}












