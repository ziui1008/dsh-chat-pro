/**
 * `deepseek-webchat` 模型通道。
 *
 * 一个实现了 DSH 适配器契约的普通对象：DSH 只调用它的方法，不需要 `instanceof`。
 * 它把 DSH 的历史压成官方请求形态（见 protocol.js），因此无论会话挂了什么预设、
 * 有多少工具，发出去的东西与 chat-demo 一致。
 */
import {
  DEFAULT_BASE_URL,
  TOKEN_HEADER,
  apiRoot,
  buildChatRequest,
  textOf,
  toWireMessages,
} from './protocol.js'

/** 通道路由名。模型选择器里按这个名字显示。 */
export const PROVIDER = 'deepseek-webchat'

/** 官方目录里的两个模型（dsh-llm-deepseek/src/models.ts 同源）。 */
const MODELS = [
  { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
]

const CONTEXT_WINDOW = 1_048_576
const MAX_TOKENS = 256_000

const EFFORTS = [
  { id: 'off', name: '关闭思考', description: 'thinking: disabled' },
  { id: 'high', name: '标准', description: 'thinking: enabled' },
  { id: 'max', name: '深入', description: 'thinking: enabled' },
]

/** 上游 stop_reason → DSH 的结束原因。 */
function finishOf(stopReason) {
  switch (stopReason) {
    case 'max_tokens': return { kind: 'max-tokens' }
    case 'refusal': return { kind: 'error', failure: { message: 'DeepSeek 内容审核拒绝', code: 'REFUSAL' } }
    default: return { kind: 'stop' }
  }
}

/** usage 字段映射。缺失的计数一律不出现——DSH 要求每个 chunk 都能无损 JSON 序列化，`undefined` 属性不算。 */
function usageOf(usage) {
  if (!usage) return undefined
  const mapped = {
    inputTokens: usage.input_tokens ?? 0,
    outputTokens: usage.output_tokens ?? 0,
  }
  mapped.totalTokens = mapped.inputTokens + mapped.outputTokens
  if (typeof usage.cache_read_input_tokens === 'number') mapped.cacheReadTokens = usage.cache_read_input_tokens
  if (typeof usage.cache_creation_input_tokens === 'number') mapped.cacheWriteTokens = usage.cache_creation_input_tokens
  if (typeof usage.reasoning_tokens === 'number') mapped.reasoningTokens = usage.reasoning_tokens
  return mapped
}

/**
 * 建立通道实例。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ baseURL?: string, search?: boolean, language?: string }} config
 */
export function createWebchatAdapter(ctx, config = {}) {
  const baseURL = () => config.baseURL || process.env.DEEPSEEK_BASE_URL || DEFAULT_BASE_URL

  async function authorize() {
    const destination = baseURL()
    const token = await ctx.get('deepseekAccount')?.resolveToken(destination)
    if (token === undefined) {
      const error = new Error('尚未登录 DeepSeek，或该端点不接受 DSH 账户凭据')
      error.code = 'ACCOUNT_SIGN_IN_REQUIRED'
      throw error
    }
    return token
  }

  async function* stream(options) {
    const token = await authorize()
    const thinking = options.reasoningEffort !== 'off'
    const body = buildChatRequest({
      messages: toWireMessages(options.messages, { language: config.language }),
      model: options.model,
      thinking,
      search: config.search === true,
      title: false,
    })
    const response = await fetch(`${apiRoot(baseURL())}/messages`, {
      method: 'POST',
      signal: options.signal,
      redirect: 'error',
      headers: {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        'anthropic-version': '2023-06-01',
        [TOKEN_HEADER]: token,
      },
      body: JSON.stringify(body),
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      const error = new Error(`DeepSeek Messages ${response.status}: ${detail.slice(0, 500)}`)
      error.code = 'WEBCHAT_HTTP'
      error.status = response.status
      throw error
    }
    if (response.body === null) {
      const error = new Error('DeepSeek Messages 返回了空响应体')
      error.code = 'WEBCHAT_EMPTY'
      throw error
    }
    // DSH 要求每个 chunk 都能无损 JSON 序列化；统一过一遍 JSON 往返，顺手剔除 undefined。
    for await (const chunk of translate(response.body, options.signal)) {
      yield JSON.parse(JSON.stringify(chunk))
    }
  }

  /** 把官方流翻译成 DSH 的 chunk 序列。服务端工具块不进入 DSH 的消息模型。 */
  async function* translate(body, signal) {
    const { readSse } = await import('./protocol.js')
    /** 上游块索引 → 我们发出的块索引。只映射 thinking / text。 */
    const mapping = new Map()
    let nextIndex = 0
    let stopReason = 'end_turn'
    const open = new Map()

    for await (const { data } of readSse(body, signal)) {
      if (data.type === 'content_block_start') {
        const block = data.content_block ?? {}
        if (block.type === 'thinking' || block.type === 'text') {
          const index = nextIndex++
          mapping.set(data.index, index)
          const blockType = block.type === 'thinking' ? 'reasoning' : 'text'
          open.set(index, { type: blockType, text: '' })
          yield { type: 'block-start', index, blockType }
          const initial = block.type === 'thinking' ? block.thinking : block.text
          if (typeof initial === 'string' && initial.length > 0) {
            open.get(index).text += initial
            yield block.type === 'thinking'
              ? { type: 'reasoning-delta', index, text: initial }
              : { type: 'text-delta', index, text: initial }
          }
        }
        continue
      }
      if (data.type === 'content_block_delta') {
        const index = mapping.get(data.index)
        if (index === undefined) continue
        const delta = data.delta ?? {}
        if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
          open.get(index).text += delta.thinking
          yield { type: 'reasoning-delta', index, text: delta.thinking }
        } else if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          open.get(index).text += delta.text
          yield { type: 'text-delta', index, text: delta.text }
        }
        continue
      }
      if (data.type === 'content_block_stop') {
        const index = mapping.get(data.index)
        if (index === undefined) continue
        const block = open.get(index)
        mapping.delete(data.index)
        open.delete(index)
        yield { type: 'block-end', index, block: { type: block.type, text: block.text } }
        continue
      }
      if (data.type === 'message_delta') {
        stopReason = data.delta?.stop_reason ?? stopReason
        const usage = usageOf(data.usage)
        if (usage) yield { type: 'usage', usage }
        continue
      }
      if (data.type === 'message_stop') break
    }
    yield { type: 'finish', reason: finishOf(stopReason) }
  }

  const modelInfo = (provider, id) => {
    const entry = MODELS.find(item => item.id === id) ?? MODELS[0]
    return {
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text'],
      context: { contextWindow: CONTEXT_WINDOW },
      defaultMaxTokens: MAX_TOKENS,
      reasoning: { efforts: EFFORTS, defaultEffort: 'high' },
    }
  }

  return {
    providerInfo: provider => ({ id: provider, name: 'DeepSeek 网页版' }),
    // 通道自己就是一次网络请求，重试交给上层对话级策略；这里不做传输层重试。
    providerRetryPolicy: () => ({
      mode: 'normal',
      maxRetries: 0,
      retryableCodes: [],
      initialDelayMs: 500,
      maxDelayMs: 5_000,
      jitterRatio: 0,
    }),
    imageRequestPricing: () => undefined,
    imageRequestTarget: () => ({ width: 1024, height: 1024, maxBytes: 10 * 1024 * 1024 }),
    listModels: async provider => MODELS.map(entry => ({
      provider,
      id: entry.id,
      name: entry.name,
      inputModalities: ['text'],
    })),
    resolveModel: async (provider, model) => modelInfo(provider, model),
    prepareCall: async (provider, model) => ({
      model: modelInfo(provider, model),
      stream: options => stream(options),
    }),
    stream: options => stream(options),
  }
}
