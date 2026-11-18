/**
 * 一次性导入：把一条 DSH 会话读出来，转成 chat-demo 的会话格式。
 *
 * 只读。导入是用户主动发起的复制，复制完两边就各走各的——
 * 网页版有自己的存储，这里不会反过来写 DSH。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** DSH 的会话日志是多帧追加的；Node 的 zstd 只解第一帧，按魔数切帧逐段解。 */
export function decompressSessionLog(buffer) {
  const starts = []
  let cursor = 0
  while (true) {
    const at = buffer.indexOf(ZSTD_MAGIC, cursor)
    if (at === -1) break
    starts.push(at)
    cursor = at + ZSTD_MAGIC.length
  }
  if (starts.length === 0) return buffer.toString('utf8')
  const parts = []
  for (let index = 0; index < starts.length; index += 1) {
    const end = index + 1 < starts.length ? starts[index + 1] : buffer.length
    try {
      parts.push(zlib.zstdDecompressSync(buffer.subarray(starts[index], end)))
    } catch {
      // 伪魔数或截断帧。
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 内容块 → 上游的块类型。 */
function toBlocks(content) {
  if (!Array.isArray(content)) return []
  const blocks = []
  for (const block of content) {
    if (block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'thinking', thinking: block.text })
    } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.length > 0) {
      blocks.push({ type: 'text', text: block.text })
    }
  }
  return blocks
}

/**
 * JSONL 文本 → chat-demo 会话。
 *
 * DSH 按「步」记录 assistant：一回合可能先几条只有思考的记录，最后才是正文；
 * 上游是一条消息一段回复，所以同一个用户消息之后的记录合并成一条。
 */
export function parseSessionLog(text, fallbackId) {
  const records = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 半行或损坏行跳过。
    }
  }
  const header = records.find(record => record.type === 'session')
  if (header === undefined) return undefined
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined

  let title = ''
  let updatedAt = header.createdAt ?? 0
  const messages = []
  let index = 0
  let pending

  const flush = () => {
    if (pending === undefined) return
    if (pending.blocks.length > 0) messages.push(pending)
    pending = undefined
  }

  for (const record of records) {
    if (typeof record.time === 'number' && record.time > updatedAt) updatedAt = record.time
    if (record.type === 'session/title' && typeof record.data?.title === 'string' && record.data.title.length > 0) {
      title = record.data.title
      continue
    }
    if (record.type !== 'user/message' && record.type !== 'assistant/message') continue
    // user/message 的 data 就是消息本身；assistant/message 包一层 message。
    const message = record.data?.message ?? record.data
    if (message?.role === undefined) continue
    index += 1
    const id = String(message.id ?? `${fallbackId}-${index}`)

    if (message.role === 'user') {
      // DSH 把运行时上下文、技能目录、时间快照也记成 user/message；这些不能打断
      // 同一回合里多步 assistant 记录的合并，所以先过滤、后 flush。
      if (message.source?.kind !== undefined && message.source.kind !== 'user') continue
      const text = toBlocks(message.content).map(block => block.text ?? '').join('')
      if (text.length === 0 || text.startsWith('<system-reminder>')) continue
      flush()
      messages.push({ id, role: 'user', content: text, files: [], createdAt: record.time ?? updatedAt })
      continue
    }

    if (message.role === 'assistant') {
      // 同一个用户消息之后的所有 assistant 记录（多步思考 + 正文）合成一条回复。
      if (pending === undefined) {
        pending = {
          id,
          role: 'assistant',
          createdAt: record.time ?? updatedAt,
          model: 'deepseek-flash',
          thinking: false,
          search: false,
          prefix: false,
          status: 'done',
          blocks: [],
          stopReason: 'end_turn',
        }
      }
      for (const block of toBlocks(message.content)) {
        const last = pending.blocks.at(-1)
        if (last !== undefined && last.type === block.type) {
          if (block.type === 'thinking') last.thinking += block.thinking
          else last.text += block.text
        } else {
          pending.blocks.push({ ...block })
        }
      }
      pending.thinking = pending.blocks.some(block => block.type === 'thinking')
    }
  }
  flush()

  for (const message of messages) delete message.turn
  return {
    id: header.id ?? fallbackId,
    title: title || '导入的对话',
    createdAt: header.createdAt ?? updatedAt,
    updatedAt,
    messages,
  }
}

/** 在 DSH 会话目录里找到某条会话的日志文件。 */
export function findSessionFile(home, sessionId) {
  const root = path.join(home, 'sessions')
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const dir = path.join(root, workspace.name, sessionId)
    for (const candidate of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
      const file = path.join(dir, candidate)
      if (fs.existsSync(file)) return { file, zstd: candidate.endsWith('.zstd') }
    }
  }
  return undefined
}

/** 读一条 DSH 会话并转换成上游格式；找不到或没有消息时返回 undefined。 */
export function readDshSession(home, sessionId) {
  const found = findSessionFile(home, sessionId)
  if (found === undefined) return undefined
  const raw = fs.readFileSync(found.file)
  const text = found.zstd ? decompressSessionLog(raw) : raw.toString('utf8')
  const session = parseSessionLog(text, sessionId)
  if (session === undefined || session.messages.length === 0) return undefined
  return session
}

/** 暂存目录：宿主写，网页版取走。 */
const stagingRoot = home => path.join(home, 'webchat-imports')

/** 把一条会话放进暂存区。 */
export function stageImport(home, session) {
  const root = stagingRoot(home)
  fs.mkdirSync(root, { recursive: true })
  const file = path.join(root, `${session.id}.json`)
  fs.writeFileSync(file, JSON.stringify(session))
  return file
}

/** 取出全部暂存会话。 */
export function listPending(home) {
  const root = stagingRoot(home)
  let names = []
  try {
    names = fs.readdirSync(root).filter(name => name.endsWith('.json'))
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    try {
      sessions.push(JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')))
    } catch {
      // 坏文件跳过。
    }
  }
  return sessions
}

/** 确认已取走，删除暂存。 */
export function ackPending(home, ids) {
  const root = stagingRoot(home)
  const removed = []
  for (const id of ids) {
    const file = path.join(root, `${id}.json`)
    if (fs.existsSync(file)) {
      fs.unlinkSync(file)
      removed.push(id)
    }
  }
  return removed
}



