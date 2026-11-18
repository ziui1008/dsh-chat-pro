/**
 * chat-demo-in-dsh 宿主半边。
 *
 * 两件事：
 *   1. 通道 —— 把「官方请求形态」注册成一条模型路由 `deepseek-webchat`，
 *      于是 DSH 自己的会话也能发和 chat.deepseek.com 一致的请求；
 *   2. 界面 —— `/webchat` 下的 HTTP 面（静态产物、模型代理、会话桥、自检）。
 *
 * 官方依据：deepseek-ai/chat-demo · src/services/chat/store.ts:38 与 :999-1011
 */
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_BASE_URL,
  SYSTEM_PROMPT,
  TOKEN_HEADER,
  apiRoot,
  buildChatRequest,
  toWireMessages,
} from './src/protocol.js'
import { PROVIDER, createWebchatAdapter } from './src/provider.js'
import { createWebview, sendJson } from './src/webview.js'

export { SYSTEM_PROMPT, PROVIDER }
export const name = 'chat-demo-in-dsh'
export const inject = ['webServer', 'llm']

/** 用 DSH 的账户凭据发一次官方形态的请求，返回请求与响应的关键事实。 */
async function runProbe(ctx, config, question, options = {}) {
  const baseURL = config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL
  const token = await ctx.get('deepseekAccount')?.resolveToken(baseURL)
  if (token === undefined) {
    return { ok: false, stage: 'auth', baseURL, reason: '该端点不允许使用 DSH 账户凭据，或尚未登录 DeepSeek' }
  }
  const body = buildChatRequest({
    messages: toWireMessages([{
      role: 'user',
      content: [{ type: 'text', text: question }],
      source: { kind: 'user' },
      time: Date.now(),
    }], { language: config.language }),
    model: options.model ?? 'deepseek-flash',
    thinking: options.thinking !== false,
    search: options.search ?? config.search === true,
  })
  const started = Date.now()
  const response = await fetch(`${apiRoot(baseURL)}/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'anthropic-version': '2023-06-01',
      [TOKEN_HEADER]: token,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, stage: 'http', baseURL, status: response.status, body: text.slice(0, 800) }
  }
  let answer = ''
  let thinking = ''
  let events = 0
  for (const line of text.split(/\r?\n/u)) {
    if (!line.startsWith('data:')) continue
    events += 1
    try {
      const event = JSON.parse(line.slice(5).trim())
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') answer += event.delta.text
      if (event.type === 'content_block_delta' && event.delta?.type === 'thinking_delta') thinking += event.delta.thinking
    } catch {
      // 忽略非 JSON 帧。
    }
  }
  return {
    ok: true,
    baseURL,
    ms: Date.now() - started,
    request: {
      model: body.model,
      system: body.system,
      reminder: body.messages[0].content,
      tools: body.tools.map(tool => tool.type),
      thinking: body.thinking.type,
      keys: Object.keys(body),
    },
    response: { events, thinkingHead: thinking.slice(0, 120), answerHead: answer.slice(0, 200), answerChars: answer.length },
  }
}

/**
 * 插件入口。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string, search?: boolean, language?: string }} config
 */
export function apply(ctx, config = {}) {
  const adapter = createWebchatAdapter(ctx, config)
  ctx.effect(() => ctx.llm.registerAdapter([PROVIDER], adapter), 'webchat.adapter')

  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const webview = createWebview(ctx, config, home)

  // resource 路由只接 GET/HEAD，聊天是 POST，所以这里必须用 handler。
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/webchat',
    handler: async (req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const method = (req.method ?? 'GET').toUpperCase()
      try {
        if (url.pathname === '/webchat/api/status' && method === 'GET') {
          sendJson(res, {
            provider: PROVIDER,
            baseURL: config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
            search: config.search === true,
            language: config.language ?? '中文',
            providers: ctx.llm.listProviders(),
            clientPath: ctx.get('clientModules')?.clientPath('chat-demo-in-dsh') ?? null,
          })
          return
        }
        if (url.pathname === '/webchat/api/probe' && method === 'GET') {
          const result = await runProbe(ctx, config, url.searchParams.get('q') ?? '用一句话介绍你自己', {
            model: url.searchParams.get('model') ?? undefined,
            thinking: url.searchParams.get('thinking') !== 'off',
            search: url.searchParams.get('search') === 'on' ? true : undefined,
          })
          sendJson(res, result, result.ok ? 200 : 500)
          return
        }
        if (url.pathname === '/webchat/api/stream' && method === 'GET') {
          const question = url.searchParams.get('q') ?? '用一句话介绍你自己'
          const collected = []
          for await (const chunk of adapter.stream({
            provider: PROVIDER,
            model: url.searchParams.get('model') ?? 'deepseek-flash',
            reasoningEffort: 'high',
            messages: [{
              role: 'user',
              id: 'debug',
              time: Date.now(),
              source: { kind: 'user' },
              content: [{ type: 'text', text: question }],
            }],
            signal: AbortSignal.timeout(180_000),
          })) collected.push(chunk)
          const text = collected.filter(chunk => chunk.type === 'text-delta').map(chunk => chunk.text).join('')
          const reasoning = collected.filter(chunk => chunk.type === 'reasoning-delta').map(chunk => chunk.text).join('')
          sendJson(res, {
            ok: collected.some(chunk => chunk.type === 'finish'),
            chunks: collected.length,
            blocks: collected.filter(chunk => chunk.type === 'block-start').map(chunk => chunk.blockType),
            finish: collected.find(chunk => chunk.type === 'finish')?.reason,
            usage: collected.find(chunk => chunk.type === 'usage')?.usage,
            reasoningHead: reasoning.slice(0, 120),
            reasoningChars: reasoning.length,
            textHead: text.slice(0, 200),
            textChars: text.length,
          })
          return
        }
      } catch (error) {
        sendJson(res, { ok: false, stage: 'exception', message: String(error?.message ?? error) }, 500)
        return
      }
      // 其余路径交给网页版。
      await webview(req, res)
    },
  }), 'webchat.routes')
}

