/**
 * 把网页版面板接到 DSH 自己的模型路由上。
 *
 * 网页版前端仍然是官方 chat-demo 那份：请求体是 DeepSeek 的 Anthropic 兼容方言
 * （`thinking`、`safety_check`、`deepseek_*` 工具）。选中的是 DSH 里已配置的其它
 * 供应商时，宿主把这层方言翻译成 `ctx.llm.stream()` 的调用，再把流式 chunk 翻译回
 * 网页版会消费的 Anthropic SSE 事件——浏览器不用知道供应商长什么样。
 *
 * 这里不做提示词工程：`system` 与消息都由浏览器构造，宿主只做结构转换。
 */
import { randomUUID } from 'node:crypto'

/** 网页版自己的 DeepSeek 代理路由（不经 ctx.llm）。 */
export const WEBCHAT_PROVIDER = 'webchat'
/** 网页版默认模型。 */
export const WEBCHAT_MODEL = 'deepseek-flash'

/** 请求体里是否指定了 DSH 路由。 */
export function dshRouteOf(body) {
  const route = body?.dsh
  if (route === null || typeof route !== 'object') return undefined
  const { provider, model, effort } = route
  if (typeof provider !== 'string' || provider.length === 0) return undefined
  if (provider === WEBCHAT_PROVIDER) return undefined
  if (typeof model !== 'string' || model.length === 0) return undefined
  return {
    provider,
    model,
    effort: typeof effort === 'string' && effort.length > 0 ? effort : undefined,
  }
}

/** 把内容块数组压成文字；非文本块返回 `undefined` 表示无法表达。 */
function textOfContent(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
      continue
    }
    // 图片/文件要落盘成 DSH 附件，属于 next step，先明确报错而不是静默丢内容。
    if (block.type === 'image' || block.type === 'file' || block.type === 'document') {
      return undefined
    }
  }
  return parts.join('\n\n')
}

/** 历史里的 assistant 块：文本与思考都保留，工具块丢弃（网页版本来也不回传工具结果）。 */
function assistantBlocks(content) {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  const blocks = []
  if (!Array.isArray(content)) return blocks
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    } else if (block.type === 'thinking' && typeof block.thinking === 'string' && block.thinking.length > 0) {
      blocks.push({ type: 'reasoning', text: block.thinking })
    }
  }
  return blocks
}

/**
 * 把网页版的请求体转成 `GenerateOptions.messages`。
 * @returns {{ messages: object[], system: string | undefined }}
 * @throws {Error} 带 `status` 的 4xx：无法表达的附件或多模态内容
 */
export function toGenerateMessages(body, route) {
  const messages = []
  for (const message of Array.isArray(body?.messages) ? body.messages : []) {
    if (message === null || typeof message !== 'object') continue
    // latest_reminder 是网页版注入的位置/时间快照，DSH 侧不消费。
    if (message.role === 'latest_reminder' || message.role === 'system') continue
    if (message.role === 'user') {
      const text = textOfContent(message.content)
      if (text === undefined) {
        const error = new Error('当前模型不支持图片或文件附件，请切换到 DeepSeek 网页版再发送')
        error.status = 400
        throw error
      }
      if (text.trim().length === 0) continue
      messages.push({ role: 'user', content: [{ type: 'text', text }] })
      continue
    }
    if (message.role === 'assistant') {
      const content = assistantBlocks(message.content)
      if (content.length === 0) continue
      messages.push({
        role: 'assistant',
        id: randomUUID(),
        content,
        source: { kind: 'model', provider: route.provider, model: route.model },
      })
    }
  }
  // 历史必须以 user 开头；开头若是 assistant（截断的历史），去掉。
  while (messages.length > 0 && messages[0].role !== 'user') messages.shift()
  const system = typeof body?.system === 'string' && body.system.length > 0 ? body.system : undefined
  return { messages, system }
}

/** 浏览器有没有要求联网搜索（网页版用 `deepseek_web_search` 这个服务端工具表示）。 */
export function searchRequested(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.some(tool => tool !== null && typeof tool === 'object' && tool.name === 'deepseek_web_search')
}

/** 检索词：最后一条用户消息的正文，过长的截断，避免把整段粘贴当查询。 */
export function searchQueryOf(body, limit = 200) {
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue
    const text = textOfContent(message.content)
    if (typeof text !== 'string') continue
    const query = text.replace(/\s+/g, ' ').trim()
    if (query.length > 0) return query.length > limit ? query.slice(0, limit) : query
  }
  return undefined
}

/** 宿主没声明 inject，按需取联网能力；没有就跳过检索。 */
const webOf = ctx => {
  try {
    return ctx.get('web')
  } catch {
    return undefined
  }
}

/**
 * 给非网页版模型补一次联网检索。
 *
 * 网页版的搜索是 DeepSeek 的服务端工具，只有它自己的端点会执行；切到别的供应商后这个
 * 工具就没人管了，于是这里改用 DSH 的 `ctx.web.search()` 把结果取回来交给模型。
 * 检索失败、没配搜索提供方、或者该路由拿不到凭据时返回 `undefined`，请求照常继续。
 */
export async function runSearch(ctx, route, query, signal) {
  const web = webOf(ctx)
  if (web === undefined || typeof web.search !== 'function') return undefined
  try {
    if (typeof web.searchReady === 'function') {
      const ready = await web.searchReady(route.provider)
      if (ready === false) return undefined
    }
    const result = await web.search({ query, maxResults: 6 }, signal)
    const sources = Array.isArray(result?.sources) ? result.sources.filter(source => typeof source?.url === 'string') : []
    if (sources.length === 0 && typeof result?.content !== 'string') return undefined
    return { ...result, sources }
  } catch {
    return undefined
  }
}

/** 把检索结果压成给模型看的上下文；这只是数据，不是额外的人格或指令。 */
export function renderSearchContext(query, result) {
  const lines = [
    `以下是宿主为本次提问做的联网检索，检索词：${query}`,
    '回答时可以引用其中的来源，并在句末给出链接；与本问题无关的结果直接忽略。',
  ]
  let index = 0
  for (const source of result.sources ?? []) {
    index += 1
    const title = typeof source.title === 'string' && source.title.length > 0 ? source.title : source.url
    const excerpt = typeof source.snippet === 'string' && source.snippet.length > 0
      ? source.snippet
      : typeof source.summary === 'string' ? source.summary : ''
    lines.push('', `${index}. ${title}`, `   ${source.url}`, ...(excerpt.length > 0 ? [`   ${excerpt}`] : []))
  }
  if (typeof result.content === 'string' && result.content.trim().length > 0) {
    lines.push('', result.content.trim())
  }
  return lines.join('\n')
}

/** 服务端工具块的 id 形如 `srvtoolu_s_1_<32 位 hex>`。 */
const toolUseId = () => `srvtoolu_s_1_${randomUUID().replaceAll('-', '')}`

/** 思考开关 + 档位 → DSH 的 reasoningEffort。 */
export function effortFor(route, thinking, efforts) {
  const ids = new Set((efforts ?? []).map(effort => effort.id))
  if (!thinking) return ids.has('off') ? 'off' : undefined
  if (route.effort !== undefined) return route.effort
  return undefined
}

/** 宿主没声明 inject，按需取模型路由服务；没有就退回网页版自己的端点。 */
const llmOf = ctx => {
  try {
    return ctx.get('llm')
  } catch {
    return undefined
  }
}

/** 列 DSH 里当前可用的供应商与模型（含思考档位）。 */
export async function buildCatalog(ctx) {
  const groups = [{
    provider: WEBCHAT_PROVIDER,
    name: 'DeepSeek 网页版',
    models: [{ id: WEBCHAT_MODEL, name: 'DeepSeek Flash', description: '官方网页版对话，带联网搜索' }],
  }]
  const llm = llmOf(ctx)
  if (llm === undefined || typeof llm.listProviders !== 'function') return { groups }
  for (const provider of llm.listProviders()) {
    let models = []
    try {
      models = await llm.listModels(provider.id)
    } catch {
      continue
    }
    const entries = []
    for (const model of models) {
      const entry = { id: model.id, name: model.name || model.id }
      if (typeof model.description === 'string') entry.description = model.description
      try {
        const info = await llm.resolveModelInfo(provider.id, model.id)
        if (info?.reasoning !== undefined) {
          entry.reasoning = {
            efforts: info.reasoning.efforts.map(effort => ({
              id: effort.id,
              name: effort.name,
              ...(typeof effort.description === 'string' ? { description: effort.description } : {}),
            })),
            ...(info.reasoning.defaultEffort === undefined ? {} : { defaultEffort: info.reasoning.defaultEffort }),
          }
        }
      } catch {
        // 单个模型解析失败不影响整个目录。
      }
      entries.push(entry)
    }
    if (entries.length > 0) {
      groups.push({ provider: provider.id, name: provider.name || provider.id, models: entries })
    }
  }
  return { groups }
}

const writeEvent = (res, type, payload) => {
  res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`)
}

const usageOf = usage => ({
  input_tokens: usage?.inputTokens ?? 0,
  cache_creation_input_tokens: usage?.cacheWriteTokens ?? 0,
  cache_read_input_tokens: usage?.cacheReadTokens ?? 0,
  output_tokens: usage?.outputTokens ?? 0,
})

const STOP_REASON = {
  stop: 'end_turn',
  'max-tokens': 'max_tokens',
  'tool-calls': 'tool_use',
  aborted: 'end_turn',
}

/**
 * 用 DSH 的模型路由生成一轮回答，并按网页版消费的 Anthropic SSE 写出去。
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {object} body 网页版的原始请求体
 * @param {import('node:http').ServerResponse} res
 */
export async function streamDshReply(ctx, body, route, res) {
  const llm = llmOf(ctx)
  if (llm === undefined) {
    const error = new Error('DSH 的模型服务当前不可用')
    error.status = 503
    throw error
  }
  const thinking = body?.thinking?.type === 'enabled'
  const efforts = await (async () => {
    try {
      const info = await llm.resolveModelInfo(route.provider, route.model)
      return info.reasoning?.efforts ?? []
    } catch {
      return []
    }
  })()
  const { messages, system: browserSystem } = toGenerateMessages(body, route)
  if (messages.length === 0) {
    const error = new Error('没有可发送的消息')
    error.status = 400
    throw error
  }
  const effort = effortFor(route, thinking, efforts)
  const controller = new AbortController()
  res.on('close', () => controller.abort())

  // 非网页版路由下 deepseek_web_search 没有执行者，改用 DSH 自己的联网检索补上；
  // 检索失败或被取消时 found 为 undefined，这一轮照常按纯文本继续。
  const query = searchRequested(body) ? searchQueryOf(body) : undefined
  const found = query === undefined ? undefined : await runSearch(ctx, route, query, controller.signal)
  const system = [browserSystem, found === undefined ? undefined : renderSearchContext(query, found)]
    .filter(part => typeof part === 'string' && part.length > 0)
    .join('\n\n')

  const options = {
    provider: route.provider,
    model: route.model,
    messages,
    signal: controller.signal,
    ...(system.length === 0 ? {} : { system }),
    ...(effort === undefined ? {} : { reasoningEffort: effort }),
    ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  })
  writeEvent(res, 'message_start', {
    type: 'message_start',
    message: {
      id: randomUUID(),
      model: body?.model ?? route.model,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
  })

  // 检索结果按网页版的服务端工具协议下发，前端才会画出「已搜索 N 个网页」那张卡片。
  let base = 0
  if (found !== undefined) {
    const id = toolUseId()
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: {
        type: 'server_tool_use',
        id,
        name: 'deepseek_web_search',
        input: { action: 'search', queries: [query] },
        caller: { type: 'direct' },
        kind: 'search',
      },
    })
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 0 })
    writeEvent(res, 'content_block_start', {
      type: 'content_block_start',
      index: 1,
      content_block: {
        type: 'web_search_tool_result',
        tool_use_id: id,
        kind: 'search',
        content: found.sources.map(source => ({
          type: 'web_search_result',
          title: typeof source.title === 'string' && source.title.length > 0 ? source.title : source.url,
          url: source.url,
          snippet: typeof source.snippet === 'string' ? source.snippet : source.summary ?? '',
          site_icon: null,
          site_name: null,
          page_age: null,
          encrypted_content: '',
        })),
      },
    })
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: 1 })
    base = 2
  }

  let usage
  let stopReason = 'end_turn'
  const open = new Set()
  try {
    for await (const chunk of llm.stream(options)) {
      switch (chunk.type) {
        case 'block-start': {
          const index = chunk.index + base
          if (chunk.blockType === 'text') {
            open.add(index)
            writeEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' },
            })
          } else if (chunk.blockType === 'reasoning') {
            open.add(index)
            writeEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            })
          }
          break
        }
        case 'text-delta': {
          const index = chunk.index + base
          if (!open.has(index)) {
            open.add(index)
            writeEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'text', text: '' },
            })
          }
          writeEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'text_delta', text: chunk.text },
          })
          break
        }
        case 'reasoning-delta': {
          const index = chunk.index + base
          if (!open.has(index)) {
            open.add(index)
            writeEvent(res, 'content_block_start', {
              type: 'content_block_start',
              index,
              content_block: { type: 'thinking', thinking: '', signature: '' },
            })
          }
          writeEvent(res, 'content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: { type: 'thinking_delta', thinking: chunk.text },
          })
          break
        }
        case 'block-end': {
          const index = chunk.index + base
          if (open.delete(index)) {
            writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
          }
          break
        }
        case 'usage':
          usage = chunk.usage
          break
        case 'finish': {
          if (chunk.reason?.kind === 'error') {
            stopReason = 'end_turn'
            const message = chunk.reason.failure?.message ?? '模型调用失败'
            writeEvent(res, 'error', { type: 'error', error: { type: 'api_error', message } })
          } else {
            stopReason = STOP_REASON[chunk.reason?.kind] ?? 'end_turn'
          }
          break
        }
        default:
          break
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    if (!res.writableEnded) {
      writeEvent(res, 'error', { type: 'error', error: { type: 'api_error', message } })
      res.end()
    }
    return
  }
  for (const index of open) {
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }
  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage === undefined ? {} : { usage: usageOf(usage) }),
  })
  writeEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}
