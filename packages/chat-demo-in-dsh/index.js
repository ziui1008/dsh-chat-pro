/**
 * dsh-webchat 宿主半边。
 *
 * 两件事：
 *   1. 通道 —— 把「官方请求形态」注册成一条模型路由 `deepseek-webchat`，
 *      于是 DSH 自己的会话也能发和 chat.deepseek.com 一致的请求；
 *   2. 路由 —— `/webchat` 下的 HTTP 面，前端页签与浏览器直连都走这里。
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
import { createWebview } from './src/webview.js'

export { SYSTEM_PROMPT, PROVIDER }
export const name = 'chat-demo-in-dsh'
export const inject = ['webServer', 'llm']

/** 把 SSE 响应收成便于验收的摘要。 */
function summarizeSse(text) {
  const events = []
  for (const frame of text.split(/\r?\n\r?\n/u)) {
    const data = frame
      .split(/\r?\n/u)
      .filter(line => line.startsWith('data:'))
      .map(line => line.slice(5).trim())
      .join('')
    if (data.length === 0) continue
    try {
      events.push(JSON.parse(data))
    } catch {
      // 保活注释或非 JSON 帧。
    }
  }
  let thinking = ''
  let answer = ''
  const kinds = []
  for (const event of events) {
    if (event.type === 'content_block_start') {
      const block = event.content_block
      kinds.push(block?.type)
      if (block?.type === 'thinking') thinking += block.thinking ?? ''
      if (block?.type === 'text') answer += block.text ?? ''
    }
    if (event.type === 'content_block_delta') {
      const delta = event.delta
      if (delta?.type === 'thinking_delta') thinking += delta.thinking ?? ''
      if (delta?.type === 'text_delta') answer += delta.text ?? ''
    }
  }
  return { events: events.length, kinds, thinking, answer }
}

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
    redirect: 'error',
  })
  const text = await response.text()
  if (!response.ok) {
    return { ok: false, stage: 'http', baseURL, status: response.status, body: text.slice(0, 800) }
  }
  const summary = summarizeSse(text)
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
      safety_check: body.safety_check,
      keys: Object.keys(body),
    },
    response: {
      events: summary.events,
      blockKinds: summary.kinds,
      thinkingHead: summary.thinking.slice(0, 120),
      answerHead: summary.answer.slice(0, 200),
      answerChars: summary.answer.length,
    },
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

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/webchat',
    resource: async (request) => {
      const url = new URL(request.url)
      try {
        if (url.pathname === '/webchat/api/status') {
          return Response.json({
            provider: PROVIDER,
            baseURL: config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL,
            search: config.search === true,
            language: config.language ?? '中文',
            providers: ctx.llm.listProviders(),
          })
        }
        if (url.pathname === '/webchat/api/stream') {
          // 走真正的通道代码路径（adapter.stream），验收 chunk 翻译是否成立。
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
          const text = collected.filter(c => c.type === 'text-delta').map(c => c.text).join('')
          const reasoning = collected.filter(c => c.type === 'reasoning-delta').map(c => c.text).join('')
          return Response.json({
            ok: collected.some(c => c.type === 'finish'),
            chunks: collected.length,
            blocks: collected.filter(c => c.type === 'block-start').map(c => c.blockType),
            finish: collected.find(c => c.type === 'finish')?.reason,
            usage: collected.find(c => c.type === 'usage')?.usage,
            reasoningHead: reasoning.slice(0, 120),
            reasoningChars: reasoning.length,
            textHead: text.slice(0, 200),
            textChars: text.length,
          })
        }
        if (url.pathname === '/webchat/api/probe') {
          const question = url.searchParams.get('q') ?? '用一句话介绍你自己'
          const result = await runProbe(ctx, config, question, {
            model: url.searchParams.get('model') ?? undefined,
            thinking: url.searchParams.get('thinking') !== 'off',
            search: url.searchParams.get('search') === 'on' ? true : undefined,
          })
          return Response.json(result, { status: result.ok ? 200 : 500 })
        }
      } catch (error) {
        return Response.json({ ok: false, stage: 'exception', message: String(error?.message ?? error) }, { status: 500 })
      }
      // 其余路径交给网页版：静态产物、模型代理、会话桥。
      return webview(request)
    },
  }), 'webchat.routes')
}
