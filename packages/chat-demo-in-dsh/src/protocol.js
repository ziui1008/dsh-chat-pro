/**
 * 官方请求形态的唯一实现。所有字段与取值以 deepseek-ai/chat-demo 为准：
 *   src/services/chat/store.ts:38        SYSTEM_PROMPT
 *   src/services/chat/store.ts:999-1011  请求体
 *   src/services/chat/latestReminder.ts  元信息行
 *   src/services/chat/reply.ts           messages 组装与历史裁剪
 *
 * 本文件是纯函数，不依赖 DSH：通道与前端共用同一份，便于逐字段比对与测试。
 */

/** 官方 chat-demo 里唯一的系统提示词，一字不改。 */
export const SYSTEM_PROMPT = '该助手为DeepSeek，由深度求索公司创造。'

/** 与上游一致默认端点。 */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com/anthropic'

/** 账户令牌头，与 DSH 的 deepseek-account 通道一致。 */
export const TOKEN_HEADER = 'x-dsh-auth-token'

/** 解析 Messages 资源根，显式带版本段就不重复追加（与 dsh-llm-deepseek 同义）。 */
export function apiRoot(baseURL) {
  const base = baseURL.replace(/\/+$/u, '')
  return new URL(base).pathname.endsWith('/v1') ? base : `${base}/v1`
}

/**
 * `<日期>,<星期>,<地区>,<平台>,<语言>`，星期用目标语言书写。
 * @param {Date} now 本地时区时间（上游按浏览器本地时区计算，避免 UTC 跨日）
 * @param {string} language 官方枚举里的语言名，如 `中文`
 * @param {string} location 可空，可含逗号
 */
export function latestReminder(now = new Date(), language = '中文', location = '', platform = 'Web') {
  const pad = value => String(value).padStart(2, '0')
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
  const locale = language === 'English' ? 'en-US' : 'zh-CN'
  const weekday = new Intl.DateTimeFormat(locale, { weekday: 'long' }).format(now)
  return [date, weekday, location, platform, language].join(',')
}

/** 服务端工具声明。阅读链接恒开；智能搜索按开关追加（上游 store.ts:48-57）。 */
export function serverTools(search) {
  const tools = [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }]
  if (search) tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  return tools
}

/** 取一条消息的纯文本。 */
export function textOf(message) {
  const content = message?.content
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(block => block?.type === 'text' && typeof block.text === 'string')
    .map(block => block.text)
    .join('')
}

/**
 * 把 DSH 的历史压成官方形态的 messages。
 *
 * 只保留用户真正说过的话与模型自己的回答：DSH 的系统提示、运行时上下文、技能目录、
 * 工具往返全部丢弃——网页版请求里没有这些。每条用户消息前按它自己的时间补一条
 * `latest_reminder`，与上一轮相同则跳过（上游 reply.ts 的同款去重）。
 */
export function toWireMessages(history, { language = '中文', now = new Date() } = {}) {
  const messages = []
  let previousReminder
  let lastUserIdleIndex = -1
  for (const message of history ?? []) {
    if (message?.role === 'user') {
      if (message.source?.kind !== 'user') continue
      const at = Number.isFinite(message.time) ? new Date(message.time) : now
      const reminder = latestReminder(at, language)
      if (reminder !== previousReminder) {
        messages.push({ role: 'latest_reminder', content: reminder })
        previousReminder = reminder
      }
      const text = textOf(message)
      if (text.length === 0) continue
      messages.push({ role: 'user', content: text })
      lastUserIdleIndex = messages.length - 1
      continue
    }
    if (message?.role === 'assistant') {
      const text = textOf(message)
      if (text.length === 0) continue
      messages.push({ role: 'assistant', content: [{ type: 'text', text }] })
    }
  }
  return messages
}

/**
 * 构造一次生成请求。字段与上游 store.ts:999-1011 逐项对应；
 * 上游没有的字段一个都不加（temperature 也在其中——扩展模式下由服务端决定）。
 */
export function buildChatRequest({
  messages,
  model = 'deepseek-flash',
  thinking = true,
  search = false,
  title = false,
}) {
  const body = {
    model,
    system: SYSTEM_PROMPT,
    messages,
    thinking: { type: thinking ? 'enabled' : 'disabled' },
    tools: serverTools(search),
    safety_check: { level: 'high' },
    ...(title ? { title: { enabled: true } } : {}),
    stream: true,
  }
  return body
}

/** 增量读取 SSE 帧：返回 `{event, data}`，注释帧与坏帧跳过。 */
export async function* readSse(body, signal) {
  const decoder = new TextDecoder()
  let buffer = ''
  for await (const chunk of body) {
    if (signal?.aborted) return
    buffer += decoder.decode(chunk, { stream: true })
    let index
    while ((index = buffer.search(/\r?\n\r?\n/u)) !== -1) {
      const frame = buffer.slice(0, index)
      buffer = buffer.slice(index).replace(/^\r?\n\r?\n/u, '')
      const lines = frame.split(/\r?\n/u)
      let event = 'message'
      const data = []
      for (const line of lines) {
        if (line.startsWith(':')) continue
        if (line.startsWith('event:')) event = line.slice(6).trim()
        else if (line.startsWith('data:')) data.push(line.slice(5).trim())
      }
      if (data.length === 0) continue
      const payload = data.join('')
      if (payload === '[DONE]') return
      try {
        yield { event, data: JSON.parse(payload) }
      } catch {
        // 非 JSON 帧忽略。
      }
    }
  }
}
