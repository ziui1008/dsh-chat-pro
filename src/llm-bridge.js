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
    const raw = typeof source.snippet === 'string' && source.snippet.length > 0
      ? source.snippet
      : typeof source.summary === 'string' ? source.summary : ''
    const excerpt = raw.length > 300 ? `${raw.slice(0, 300)}…` : raw
    lines.push('', `${index}. ${title}`, `   ${source.url}`, ...(excerpt.length > 0 ? [`   ${excerpt}`] : []))
  }
  if (typeof result.content === 'string' && result.content.trim().length > 0) {
    lines.push('', result.content.trim())
  }
  return lines.join('\n')
}

/** 浏览器有没有要求读网页（网页版用 `deepseek_read_url` 这个服务端工具表示）。 */
export function readRequested(body) {
  const tools = Array.isArray(body?.tools) ? body.tools : []
  return tools.some(tool => tool !== null && typeof tool === 'object' && tool.name === 'deepseek_read_url')
}

/** 用户消息里明写的 http(s) 链接，按出现顺序去重。 */
export function urlsInText(text, limit = 2) {
  if (typeof text !== 'string' || text.length === 0) return []
  const found = text.match(/https?:\/\/[^\s<>"'）)，。；、]+/g) ?? []
  const unique = []
  for (const url of found) {
    const cleaned = url.replace(/[.,;:!?]+$/, '')
    if (!unique.includes(cleaned)) unique.push(cleaned)
    if (unique.length >= limit) break
  }
  return unique
}

/** 要读的页面：用户贴的链接优先，其次最多补一条检索结果，避免每轮都抓满。 */
export function readTargets(body, found, limit = 2) {
  const targets = []
  const messages = Array.isArray(body?.messages) ? body.messages : []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message === null || typeof message !== 'object' || message.role !== 'user') continue
    for (const url of urlsInText(textOfContent(message.content), limit)) {
      if (!targets.includes(url)) targets.push(url)
    }
    break
  }
  let fromSearch = 0
  for (const source of found?.sources ?? []) {
    if (targets.length >= limit || fromSearch >= 1) break
    if (typeof source?.url === 'string' && !targets.includes(source.url)) {
      targets.push(source.url)
      fromSearch += 1
    }
  }
  return targets.slice(0, limit)
}

/**
 * 抓页面正文交给模型。
 *
 * 网页版的「读链接」同样是 DeepSeek 侧的服务端工具，第三方路由下没人执行；这里改用
 * DSH 的 `ctx.web.fetch()`。返回数组与 `urls` 一一对应，抓不到的位置是 `undefined`，
 * 好让调用方为每个链接各发一个失败块。单页超时 8 秒，不影响这次回答。
 */
export async function runFetch(ctx, route, urls, signal) {
  const web = webOf(ctx)
  if (web === undefined || typeof web.fetch !== 'function' || urls.length === 0) return urls.map(() => undefined)
  try {
    if (typeof web.fetchReady === 'function') {
      const ready = await web.fetchReady(route.provider)
      if (ready === false) return urls.map(() => undefined)
    }
  } catch {
    return urls.map(() => undefined)
  }
  return await Promise.all(urls.map(async url => {
    try {
      const timeout = AbortSignal.timeout(8000)
      const merged = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      const result = await web.fetch({ url }, merged)
      if (result === undefined || result === null) return undefined
      if (typeof result.statusCode === 'number' && result.statusCode >= 400) return undefined
      const raw = typeof result.body?.content === 'string' ? result.body.content : ''
      const text = result.body?.kind === 'html' ? htmlToText(raw) : raw.replace(/\s+/g, ' ').trim()
      if (text.length === 0) return undefined
      return { url: typeof result.url === 'string' ? result.url : url, text: text.slice(0, 6000) }
    } catch {
      // 单独一页抓不到就算了
      return undefined
    }
  }))
}

/** HTML 去标签取正文：去掉脚本、样式、注释，压掉多余空白。 */
export function htmlToText(html) {
  if (typeof html !== 'string' || html.length === 0) return ''
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t\f\v]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 抓来的正文压成上下文，和检索结果一样只是数据。 */
export function renderFetchContext(pages) {
  if (pages.length === 0) return ''
  const lines = ['以下是宿主为本次提问抓取的网页正文摘录：', '需要细节时从这些摘录里取，不要凭空补全页面内容。']
  pages.forEach((page, index) => {
    lines.push('', `${index + 1}. ${page.url}`)
    lines.push(page.text.slice(0, 3000))
  })
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
/** How many model turns one reply may spend on tool calls. */


const MAX_ROUNDS = 3
/** Total tool calls allowed for one reply, so a hostile page cannot drive an endless crawl. */
const MAX_TOOL_CALLS = 4
/** Whole-reply wall clock budget; four model turns plus fetches sit far below it. */
const DEADLINE_MS = 180_000

const TOOL_SEARCH = {
  name: 'web_search',
  description: 'Search the public web for current information. Call it when the answer depends on facts you cannot verify from the conversation.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'What to search for, in the user language.' },
    },
    required: ['query'],
    additionalProperties: false,
  },
}

const TOOL_READ = {
  name: 'read_url',
  description: 'Open one http or https page and return its readable text. Use it for a link the user pasted, or when a search result needs detail.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'Absolute http or https URL.' },
    },
    required: ['url'],
    additionalProperties: false,
  },
}

/** Tool names the browser declared in its request body. */
export function toolNamesOf(body) {
  const list = Array.isArray(body?.tools) ? body.tools : []
  return list
    .map(tool => (tool !== null && typeof tool === 'object' && typeof tool.name === 'string' ? tool.name : undefined))
    .filter(name => name !== undefined)
}

/**
 * Which tools the host is willing to run for this request.
 *
 * The browser always declares `deepseek_read_url`; `deepseek_web_search` only when the search
 * toggle is on. Passing the same set to the model keeps the UI honest: no pill, no tool.
 */
/**
 * Tools this machine can actually run right now.
 *
 * `searchReady` / `fetchReady` are cheap checks; offering a tool that always fails wastes a
 * round and teaches the model nothing useful.
 */
export async function toolAvailability(ctx, route, body) {
  const wanted = hostTools(body)
  if (wanted.length === 0) return { tools: [], missing: [] }
  const web = webOf(ctx)
  if (web === undefined) return { tools: [], missing: wanted.map(tool => tool.name) }
  const ready = { web_search: true, read_url: true }
  try {
    if (typeof web.searchReady === 'function') ready.web_search = (await web.searchReady(route.provider)) !== false
    else ready.web_search = false
  } catch {
    ready.web_search = false
  }
  try {
    if (typeof web.fetchReady === 'function') ready.read_url = (await web.fetchReady(route.provider)) !== false
    else ready.read_url = false
  } catch {
    ready.read_url = false
  }
  return {
    tools: wanted.filter(tool => ready[tool.name] === true),
    missing: wanted.filter(tool => ready[tool.name] !== true).map(tool => tool.name),
  }
}

export async function offeredTools(ctx, route, body) {
  return (await toolAvailability(ctx, route, body)).tools
}

/**
 * 声音要诚实：工具没给出去时，模型不能假装查过。
 */
function unavailableNote(missing) {
  if (missing.length === 0) return undefined
  const names = missing.map(name => (name === 'web_search' ? '联网检索' : '打开网页')).join('和')
  return `本次会话的${names}暂时不可用（宿主侧服务没有就绪）。如果用户要求检索或打开网页，请直接说明现在做不到，不要编造内容。`
}

/**
 * 把供应商层面的配置问题换成用户能看懂的话；原始文案留给日志。
 */
export function friendlyFailure(message) {
  if (typeof message !== 'string') return '这次回答失败了，请重试。'
  if (/no adapter registered for provider/i.test(message)) return '这个模型所在的供应商现在不可用，请在右下角的模型胶囊里换一个。'
  if (/has no configured model/i.test(message)) return '这个模型已经不在 DSH 的配置里了，请在模型胶囊里重新选一个。'
  if (/api key|unauthorized|401/i.test(message)) return '这个供应商的凭据不可用，请检查 DSH 里的供应商配置。'
  return message.length > 300 ? `${message.slice(0, 300)}…` : message
}

export function hostTools(body) {
  const names = new Set(toolNamesOf(body))
  return [
    ...(names.has('deepseek_web_search') ? [TOOL_SEARCH] : []),
    ...(names.has('deepseek_read_url') ? [TOOL_READ] : []),
  ]
}

/** Parse the raw JSON arguments a model produced without letting a bad payload throw. */
export function toolArguments(text) {
  if (typeof text !== 'string' || text.trim().length === 0) return {}
  try {
    const parsed = JSON.parse(text)
    return parsed !== null && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** True when a URL is something the host is willing to fetch. */
export function isFetchableUrl(value) {
  if (typeof value !== 'string') return false
  let url
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false
  if (url.username.length > 0 || url.password.length > 0) return false
  if (url.hostname.length === 0) return false
  if (value.length > 2048) return false
  return !isPrivateHost(url.hostname)
}

/** Loopback and link-local names the provider would refuse anyway; refuse them with a clear reason. */
function isPrivateHost(hostname) {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  if (host.endsWith('.internal')) return true
  // 方括号里的 IPv6 字面量一律不读：混合写法（::ffff:127.0.0.1）太容易漏，公开站点很少只有 IPv6。
  if (host.includes(':')) return true
  if (host === '0.0.0.0') return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4 === null) return false
  const [a, b] = [Number(ipv4[1]), Number(ipv4[2])]
  if (a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  return false
}

/**
 * Run one model-requested tool call.
 *
 * The model writes the argument; this function only decides whether the host can honour it and
 * what text goes back. Never throws: a failure becomes an `isError` result the model can read.
 */
export async function executeTool(ctx, route, call, signal) {
  const args = toolArguments(call.arguments)
  if (call.name === TOOL_SEARCH.name) {
    const query = typeof args.query === 'string' ? args.query.trim().slice(0, 200) : ''
    if (query.length === 0) {
      return { kind: 'search', ok: false, text: '检索失败：query 为空。', payload: undefined, query }
    }
    const found = await runSearch(ctx, route, query, signal)
    if (found === undefined) {
      return { kind: 'search', ok: false, text: '检索失败：这台机器上的检索服务不可用。', payload: undefined, query }
    }
    return { kind: 'search', ok: true, text: renderSearchContext(query, found), payload: found, query }
  }
  if (call.name === TOOL_READ.name) {
    const url = typeof args.url === 'string' ? args.url.trim() : ''
    if (!isFetchableUrl(url)) {
      return { kind: 'read', ok: false, text: `打不开 ${url || '(空链接)'}：只支持 http 或 https 的公开页面。`, payload: undefined, url }
    }
    const [page] = await runFetch(ctx, route, [url], signal)
    if (page === undefined) {
      return { kind: 'read', ok: false, text: `打不开 ${url}：页面取不到正文，可能超时、被拒绝或不是文本页面。`, payload: undefined, url }
    }
    return { kind: 'read', ok: true, text: renderFetchContext([page]), payload: page, url }
  }
  return { kind: 'other', ok: false, text: `这台机器上没有名为 ${call.name} 的工具。`, payload: undefined }
}

/** Anthropic block for one finished tool call, so the panel can draw its step. */
function toolCallBlockSSE(call, result) {
  if (result.kind === 'search') {
    return {
      type: 'server_tool_use',
      id: call.id,
      name: 'deepseek_web_search',
      input: { action: 'search', queries: [result.query] },
      caller: { type: 'direct' },
      kind: 'search',
    }
  }
  return {
    type: 'server_tool_use',
    id: call.id,
    name: 'deepseek_read_url',
    input: { action: 'read_link', url: result.url },
    caller: { type: 'direct' },
    kind: 'read_link',
  }
}

/** Anthropic result block for one finished tool call. */
function toolResultBlockSSE(call, result) {
  if (result.kind === 'search') {
    const found = result.payload
    return {
      type: 'web_search_tool_result',
      tool_use_id: call.id,
      kind: 'search',
      content: found === undefined
        ? [{ type: 'web_search_tool_result_error', error_code: 'unavailable' }]
        : found.sources.map(source => ({
          type: 'web_search_result',
          title: typeof source.title === 'string' && source.title.length > 0 ? source.title : source.url,
          url: source.url,
          snippet: typeof source.snippet === 'string' ? source.snippet : source.summary ?? '',
          site_icon: null,
          site_name: null,
          page_age: null,
          encrypted_content: '',
        })),
    }
  }
  const page = result.payload
  return {
    type: 'web_fetch_tool_result',
    tool_use_id: call.id,
    kind: 'read_link',
    content: page === undefined
      ? { type: 'web_fetch_tool_result_error', error_code: 'url_not_accessible' }
      : {
        type: 'web_fetch_result',
        url: page.url,
        content: {
          type: 'document',
          source: { type: 'text', media_type: 'text/plain', data: page.text.slice(0, 2000) },
          title: null,
        },
        published_at: null,
      },
  }
}

/**
 * Stream one assistant turn to the browser and collect what the model produced.
 *
 * Block indices are rebased onto `cursor` so several rounds share one Anthropic message.
 */
async function streamRound(llm, options, res, cursor) {
  const text = new Map()
  const blocks = []
  let maxIndex = -1
  let finishReason
  let replayState
  let usage
  const open = new Set()

  const startBlock = (index, blockType) => {
    if (blockType === 'text') {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'text', text: '' },
      })
      open.add(index)
    } else if (blockType === 'reasoning') {
      writeEvent(res, 'content_block_start', {
        type: 'content_block_start',
        index,
        content_block: { type: 'thinking', thinking: '', signature: '' },
      })
      open.add(index)
    }
  }

  for await (const chunk of llm.stream(options)) {
    switch (chunk.type) {
      case 'block-start': {
        maxIndex = Math.max(maxIndex, chunk.index)
        startBlock(cursor + chunk.index, chunk.blockType)
        break
      }
      case 'text-delta': {
        maxIndex = Math.max(maxIndex, chunk.index)
        const index = cursor + chunk.index
        if (!open.has(index)) startBlock(index, 'text')
        const entry = text.get(chunk.index) ?? { type: 'text', text: '' }
        entry.text += chunk.text
        text.set(chunk.index, entry)
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'text_delta', text: chunk.text },
        })
        break
      }
      case 'reasoning-delta': {
        maxIndex = Math.max(maxIndex, chunk.index)
        const index = cursor + chunk.index
        if (!open.has(index)) startBlock(index, 'reasoning')
        const entry = text.get(chunk.index) ?? { type: 'reasoning', text: '' }
        entry.text += chunk.text
        text.set(chunk.index, entry)
        writeEvent(res, 'content_block_delta', {
          type: 'content_block_delta',
          index,
          delta: { type: 'thinking_delta', thinking: chunk.text },
        })
        break
      }
      case 'block-end': {
        maxIndex = Math.max(maxIndex, chunk.index)
        const index = cursor + chunk.index
        if (open.delete(index)) {
          writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
        }
        if (chunk.block?.type === 'tool-call') {
          blocks.push({ index: chunk.index, block: chunk.block })
        }
        break
      }
      case 'usage':
        usage = chunk.usage
        break
      case 'finish': {
        replayState = chunk.replayState
        finishReason = chunk.reason
        break
      }
      default:
        break
    }
  }

  for (const index of open) {
    writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index })
  }

  const ordered = [...text.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, value]) => value)
    .concat(blocks.sort((a, b) => a.index - b.index).map(entry => entry.block))

  return {
    content: ordered,
    toolCalls: blocks.sort((a, b) => a.index - b.index).map(entry => entry.block),
    nextCursor: cursor + Math.max(maxIndex + 1, 0),
    finishReason,
    replayState,
    usage,
  }
}

/** Sum token counts across rounds for the final `message_delta`. */
function mergeUsage(total, usage) {
  if (usage === undefined) return total
  const next = { ...(total ?? {}) }
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
    if (typeof usage[key] === 'number') next[key] = (next[key] ?? 0) + usage[key]
  }
  return next
}

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
  const { messages, system } = toGenerateMessages(body, route)
  if (messages.length === 0) {
    const error = new Error('没有可发送的消息')
    error.status = 400
    throw error
  }
  const effort = effortFor(route, thinking, efforts)
  const controller = new AbortController()
  res.on('close', () => controller.abort())
  // 一次回答的整体上限：四轮模型调用加抓取，正常远低于这个数；挡住供应商发疯的情况。
  let timedOut = false
  const deadline = AbortSignal.timeout(DEADLINE_MS)
  deadline.addEventListener('abort', () => {
    timedOut = true
    controller.abort()
  })
  const signal = AbortSignal.any([controller.signal, deadline])
  const availability = await toolAvailability(ctx, route, body)
  const tools = availability.tools
  const note = unavailableNote(availability.missing)
  const systemWithNote = [system, note].filter(Boolean).join('\n\n')

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

  const convo = [...messages]
  let cursor = 0
  let calls = 0
  let usage
  let stopReason = 'end_turn'
  let failure

  try {
    // 最后一轮不给工具：预算用完时必须让模型把答案写出来，而不是再调一次工具就收尾。
    let toolsBroken = false
    for (let round = 0; round <= MAX_ROUNDS; round++) {
      if (signal.aborted) break
      const offerTools = !toolsBroken && round < MAX_ROUNDS && calls < MAX_TOOL_CALLS && tools.length > 0
      const options = {
        provider: route.provider,
        model: route.model,
        messages: convo,
        signal,
        ...(offerTools ? { tools } : {}),
        ...(systemWithNote.length > 0 ? { system: systemWithNote } : {}),
        ...(effort === undefined ? {} : { reasoningEffort: effort }),
        ...(typeof body.max_tokens === 'number' ? { maxTokens: body.max_tokens } : {}),
      }
      const turn = await streamRound(llm, options, res, cursor)
      cursor = turn.nextCursor
      usage = mergeUsage(usage, turn.usage)
      if (turn.finishReason?.kind === 'error') {
        failure = turn.finishReason.failure?.message ?? '模型调用失败'
        break
      }
      if (turn.toolCalls.length === 0) {
        // 这一轮什么都没产出，多半是这个供应商不认 tools：去掉工具再试一次，别让用户收到空白回答。
        if (turn.content.length === 0 && round === 0 && offerTools && !signal.aborted) {
          toolsBroken = true
          round -= 1
          continue
        }
        stopReason = STOP_REASON[turn.finishReason?.kind] ?? 'end_turn'
        break
      }
      if (!offerTools) break

      convo.push({
        id: randomUUID(),
        role: 'assistant',
        content: turn.content,
        source: { kind: 'model', provider: route.provider, model: route.model, ...(turn.replayState === undefined ? {} : { replayState: turn.replayState }) },
      })

      for (const call of turn.toolCalls) {
        if (calls >= MAX_TOOL_CALLS) {
          convo.push({
            id: randomUUID(),
            role: 'tool',
            toolCallId: call.id,
            isError: true,
            content: [{ type: 'text', text: '这次回答的工具调用次数已用完，请直接基于已有信息作答，不要再调用工具。' }],
            source: { kind: 'tool', callId: call.id },
          })
          continue
        }
        calls++
        const opSignal = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
        const result = await executeTool(ctx, route, call, opSignal)
        writeEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: cursor,
          content_block: toolCallBlockSSE(call, result),
        })
        writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: cursor })
        writeEvent(res, 'content_block_start', {
          type: 'content_block_start',
          index: cursor + 1,
          content_block: toolResultBlockSSE(call, result),
        })
        writeEvent(res, 'content_block_stop', { type: 'content_block_stop', index: cursor + 1 })
        cursor += 2
        convo.push({
          id: randomUUID(),
          role: 'tool',
          toolCallId: call.id,
          isError: !result.ok,
          content: [{ type: 'text', text: result.text }],
          source: { kind: 'tool', callId: call.id },
        })
      }
      stopReason = 'end_turn'
    }
  } catch (error) {
    failure = String(error?.message ?? error)
  }

  if (failure !== undefined && !res.writableEnded) {
    const message = timedOut
      ? '这次回答超过了 180 秒的时间上限，请重试或换一个更快的模型。'
      : friendlyFailure(failure)
    writeEvent(res, 'error', { type: 'error', error: { type: 'api_error', message } })
    res.end()
    return
  }
  if (res.writableEnded) return
  writeEvent(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    ...(usage === undefined ? {} : { usage: usageOf(usage) }),
  })
  writeEvent(res, 'message_stop', { type: 'message_stop' })
  res.end()
}
