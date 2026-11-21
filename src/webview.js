/**
 * `/webchat` 的 HTTP 面：
 *   - 静态资源：托管官方 chat-demo 的构建产物（只打了品牌与转发落点的补丁）；
 *   - 接口转发：浏览器不持有 API Key，由宿主用 DSH 的账户凭据代发；
 *   - 自检：把浏览器实际会走的几条路径跑一遍。
 *
 * 网页版有自己的一套存储（上游的 IndexedDB），与 DSH 会话互不相干——
 * 这是产品决定：两边的系统提示词和工具都不同，混合只会让双方都失真。
 *
 * 注意：DSH 的 `resource` 路由只接 GET/HEAD，聊天是 POST，所以用 `handler`。
 */
import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'
import { DEFAULT_BASE_URL, TOKEN_HEADER, apiRoot, isInside } from './protocol.js'
import { ackPending, listPending, readDshSession, stageImport } from './dsh-import.js'
import { buildCatalog, dshRouteOf, streamDshReply } from './llm-bridge.js'

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
 * 页面启动前把"已经登录"的状态铺好：网页版要一个 API Key 才肯进主界面，
 * 这里塞一个占位值，真正的鉴权由宿主转发时完成。
 */
const BOOTSTRAP = `<script>(function(){try{var s=window.localStorage;
if(!s.getItem('chat-demo:api-key'))s.setItem('chat-demo:api-key','dsh');
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
async function readJsonBody(req) {
  const raw = await readBody(req)
  if (raw.length === 0) return {}
  return JSON.parse(raw.toString('utf8'))
}
/** 读取入口页并注入引导脚本。入口页只有几百字节，且响应本身 no-store，所以每次现读，避免 dist 更新后仍发旧入口。 */
function readIndex() {
  const html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8')
  return html.replace(/<head>/iu, `<head>${BOOTSTRAP}`)
}

async function sendFile(res, file) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404).end('not found')
    return
  }
  const type = MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'content-length': fs.statSync(file).size })
  await pipeline(fs.createReadStream(file), res)
}

/** 上游请求原样转发，鉴权换成 DSH 账户凭据；SSE 直接透传。 */
async function proxyMessages(ctx, config, req, res, body) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    sendJson(res, { error: { message: '尚未登录 DeepSeek，或该端点不接受 DSH 账户凭据' } }, 401)
    return
  }
  // 带附件的请求要原样带上浏览器发的 anthropic-beta（files-api-…），
  // 少了它上游会直接 400：Missing or invalid anthropic-beta header。
  const beta = req.headers['anthropic-beta']
  const upstream = await fetch(`${apiRoot(baseURL)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      ...(typeof beta === 'string' && beta.length > 0 ? { 'anthropic-beta': beta } : {}),
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

/** 附件上传转发：multipart 原样送到官方 Files API。 */
async function proxyFiles(ctx, config, req, res, pathname) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    sendJson(res, { error: { message: '尚未登录 DeepSeek' } }, 401)
    return
  }
  const target = `${apiRoot(baseURL)}${pathname.slice('/webchat/anthropic/v1'.length)}`
  // 优先沿用浏览器发来的 beta 版本，没带时才用已知可用的那个。
  const clientBeta = req.headers['anthropic-beta']
  const headers = {
    'anthropic-version': '2023-06-01',
    'anthropic-beta': typeof clientBeta === 'string' && clientBeta.length > 0 ? clientBeta : 'files-api-2025-04-14',
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
  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
  })
  res.end(text)
}

/**
 * 与 DSH 自己的 `/api` 走同一条准入检查。
 *
 * 面板在 DSH 自己的 origin 里加载，所以同源请求天然带着 DSH 的会话凭据；
 * 别的网页发过来的请求没有这个凭据，Origin 也对不上，会在这里被挡掉。
 *
 * 拿不到 `connection` 服务时（更老的 DSH 没有这个服务）只能放行：
 * 没有可对照的会话体系，挡住反而会让面板整个不可用。
 * @returns {number|undefined} 拒绝时的 HTTP 状态码
 */
export function rejectWithoutSession(ctx, req) {
  const connection = ctx.get('connection')
  if (connection === undefined) return undefined
  return connection.requestRejection(req)
}

/** 自检：入口页、静态资源、一次真实生成。 */
async function selfTest(ctx, config) {
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
        messages: [{ role: 'user', content: '只回复两个字：收到' }],
        thinking: { type: 'disabled' },
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
 * @param {{ baseURL?: string }} config
 * @param {string} home DSH_HOME，用来读 DSH 会话与存放待导入暂存
 */
export function createWebview(ctx, config, home) {
  return async function handle(req, res) {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const { pathname } = url
    const method = (req.method ?? 'GET').toUpperCase()
    const isGet = method === 'GET' || method === 'HEAD'

    // 没有 DSH 会话凭据、或从别的站点发起的请求，一律不进后面的路由。
    const rejection = rejectWithoutSession(ctx, req)
    if (rejection !== undefined) {
      // 被拒时请求体还没读，直接关连接，避免客户端继续往一个被丢弃的 socket 里写。
      res.writeHead(rejection, {
        'content-type': 'text/plain; charset=utf-8',
        connection: 'close',
      })
      res.end(rejection === 403 ? 'forbidden' : 'dsh web authentication required; reopen the URL printed by dsh web.')
      return
    }

    // ---- 从 DSH 一次性导入 ----
    if (pathname === '/webchat/api/import/stage' && method === 'POST') {
      const body = await readJsonBody(req)
      const sessionId = String(body.sessionId ?? '')
      const session = readDshSession(home, sessionId)
      if (session === undefined) {
        sendJson(res, { ok: false, error: '找不到这条会话，或它没有可导入的内容' }, 404)
        return
      }
      stageImport(home, session)
      sendJson(res, { ok: true, id: session.id, title: session.title, messages: session.messages.length })
      return
    }
    if (pathname === '/webchat/api/import/pending' && isGet) {
      sendJson(res, listPending(home))
      return
    }
    if (pathname === '/webchat/api/import/ack' && method === 'POST') {
      const body = await readJsonBody(req)
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : []
      sendJson(res, { removed: ackPending(home, ids) })
      return
    }
    if (pathname === '/webchat/api/self-test' && isGet) {
      try {
        sendJson(res, await selfTest(ctx, config))
      } catch (error) {
        sendJson(res, { ok: false, error: String(error?.message ?? error) }, 500)
      }
      return
    }

    // 上游前端用一个 Key 做入口校验，宿主给个假的即可。
    if (pathname === '/webchat/models' && isGet) {
      sendJson(res, { object: 'list', data: [{ id: 'deepseek-flash', object: 'model' }] })
      return
    }

    // DSH 里已配置的供应商 / 模型 / 思考档位，供输入框左侧的切换器使用。
    if (pathname === '/webchat/api/catalog' && isGet) {
      try {
        sendJson(res, await buildCatalog(ctx))
      } catch (error) {
        sendJson(res, { groups: [], error: String(error?.message ?? error) }, 500)
      }
      return
    }

    if (pathname === '/webchat/anthropic/v1/messages' && method === 'POST') {
      let body
      try {
        body = await readJsonBody(req)
      } catch {
        sendJson(res, { error: { message: '请求体不是合法 JSON' } }, 400)
        return
      }
      const route = dshRouteOf(body)
      if (route !== undefined) {
        try {
          await streamDshReply(ctx, body, route, res)
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, { error: { message: String(error?.message ?? error) } }, error?.status ?? 502)
          } else {
            res.destroy()
          }
        }
        return
      }
      try {
        await proxyMessages(ctx, config, req, res, Buffer.from(JSON.stringify(body)))
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

    if (pathname === '/webchat' || pathname === '/webchat/') {
      const html = readIndex()
      res.writeHead(200, {
        'content-type': MIME['.html'],
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(html),
      })
      res.end(method === 'HEAD' ? undefined : html)
      return
    }

    if (pathname === '/webchat/brand-mark.svg') {
      await sendFile(res, path.join(DIST, '..', 'brand-mark.svg'))
      return
    }

    if (pathname.startsWith('/webchat/')) {
      const target = path.resolve(DIST, pathname.slice('/webchat/'.length))
      if (!isInside(path.resolve(DIST), target)) {
        res.writeHead(403).end('forbidden')
        return
      }
      await sendFile(res, target)
      return
    }

    res.writeHead(404).end('not found')
  }
}



