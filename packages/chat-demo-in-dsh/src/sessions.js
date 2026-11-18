/**
 * 会话桥：把 DSH 的会话日志翻译成 chat-demo 的数据模型，并保存网页版新建的会话。
 *
 * 读：DSH 会话目录里的 `session.v4.jsonl.zstd`（事件流）→ `{id,title,createdAt,updatedAt,messages}`。
 * 写：网页版新建/编辑的会话落到 `<DSH_HOME>/webchat/sessions/<id>.json`。
 *
 * 两边的形状差异只在这里出现，前端保持与上游一致。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

/** 事件日志里会进入界面的记录。 */
const SURFACE = new Set(['user/message', 'assistant/message'])

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/**
 * 解压 DSH 的会话日志。
 *
 * 文件是**多个独立帧顺序追加**的（每次落盘一帧），Node 的 `zstdDecompressSync`
 * 只解第一帧，所以按 zstd 魔数切帧逐段解压，再把结果拼起来。
 */
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
      // 伪魔数或截断帧跳过。
    }
  }
  return Buffer.concat(parts).toString('utf8')
}

/** 把内容块翻译成上游的块类型。 */
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
 * 从解压后的 JSONL 文本构造一个会话。
 *
 * DSH 按「步」记录 assistant/message：一回合里可能先若干条只有思考的记录，最后才是正文。
 * 上游的数据模型是一回合一条 assistant 消息，所以这里按 turn 合并连续记录，思考块接在一起。
 */
export function parseSessionLog(text, fallbackId) {
  const records = []
  for (const line of text.split(/\r?\n/u)) {
    if (line.length === 0) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      // 半行或损坏行跳过，不让一条坏记录毁掉整个会话。
    }
  }
  const header = records.find(record => record.type === 'session')
  if (header === undefined) return undefined
  // 子代理会话不进网页版列表。
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined

  let title = ''
  let updatedAt = header.createdAt ?? 0
  const messages = []
  let index = 0
  /** 正在合并的 assistant 回合。 */
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
    if (!SURFACE.has(record.type)) continue
    // user/message 的 data 就是消息本身；assistant/message 包一层 message。
    const message = record.data?.message ?? record.data
    if (message?.role === undefined) continue
    index += 1
    const id = String(message.id ?? `${fallbackId}-${index}`)

    if (message.role === 'user') {
      flush()
      // DSH 把运行时上下文、技能目录、时间快照也记成 user/message；网页版只显示真人说的话。
      if (message.source?.kind !== undefined && message.source.kind !== 'user') continue
      const text = toBlocks(message.content).map(block => block.text ?? '').join('')
      if (text.length === 0 || text.startsWith('<system-reminder>')) continue
      messages.push({ id, role: 'user', content: text, files: [], createdAt: record.time ?? updatedAt })
      continue
    }

    if (message.role === 'assistant') {
      const turn = record.data?.turn
      if (pending !== undefined && pending.turn !== turn) flush()
      const blocks = toBlocks(message.content)
      if (pending === undefined) {
        pending = {
          id,
          turn,
          role: 'assistant',
          createdAt: record.time ?? updatedAt,
          model: message.source?.model ?? null,
          thinking: false,
          search: false,
          prefix: false,
          status: 'done',
          blocks: [],
          stopReason: 'end_turn',
        }
      }
      for (const block of blocks) {
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
    title: title || '新对话',
    createdAt: header.createdAt ?? updatedAt,
    updatedAt,
    messages,
  }
}

/**
 * 找出最近有活动的会话工作目录：镜像出来的网页版会话应该跟着用户当下的工作区，
 * 而不是落在进程当前目录那一格。
 */
export function discoverWorkspace(home) {
  const root = path.join(home, 'sessions')
  const counts = new Map()
  let workspaces = []
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true }).filter(entry => entry.isDirectory())
  } catch {
    return undefined
  }
  for (const workspace of workspaces) {
    const dir = path.join(root, workspace.name)
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      continue
    }
    for (const entry of entries.slice(0, 40)) {
      const file = path.join(dir, entry.name, 'session.v4.jsonl.zstd')
      if (!fs.existsSync(file)) continue
      try {
        const buffer = fs.readFileSync(file)
        const second = buffer.indexOf(ZSTD_MAGIC, buffer.indexOf(ZSTD_MAGIC) + ZSTD_MAGIC.length)
        const frame = second === -1 ? buffer : buffer.subarray(0, second)
        const text = zlib.zstdDecompressSync(frame).toString('utf8')
        const header = JSON.parse(text.split(/\r?\n/u)[0])
        if (typeof header.cwd === 'string' && header.cwd.length > 0) {
          counts.set(header.cwd, Math.max(counts.get(header.cwd) ?? 0, fs.statSync(file).mtimeMs))
        }
      } catch {
        // 跳过读不出来的会话。
      }
    }
  }
  let best
  let bestTime = -1
  for (const [cwd, time] of counts) {
    if (time > bestTime) {
      best = cwd
      bestTime = time
    }
  }
  return best
}

/** 会话仓库：DSH 日志（只读）+ 网页版自建会话（可写）。 */
export function createSessionStore(home) {
  const dshRoot = path.join(home, 'sessions')
  const ownRoot = path.join(home, 'webchat', 'sessions')

  const ensureOwn = () => {
    fs.mkdirSync(ownRoot, { recursive: true })
  }

  /** 遍历 DSH 会话目录，解压并解析。按文件 mtime 缓存，避免每次列表都重解。 */
  const cache = new Map()
  const readDshSessions = () => {
    const sessions = []
    let workspaces = []
    try {
      workspaces = fs.readdirSync(dshRoot, { withFileTypes: true }).filter(entry => entry.isDirectory())
    } catch {
      return sessions
    }
    for (const workspace of workspaces) {
      const workspaceDir = path.join(dshRoot, workspace.name)
      let dirs = []
      try {
        dirs = fs.readdirSync(workspaceDir, { withFileTypes: true }).filter(entry => entry.isDirectory())
      } catch {
        continue
      }
      for (const dir of dirs) {
        const base = path.join(workspaceDir, dir.name)
        for (const candidate of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
          const file = path.join(base, candidate)
          if (!fs.existsSync(file)) continue
          try {
            const stat = fs.statSync(file)
            const stamp = `${stat.mtimeMs}:${stat.size}`
            const hit = cache.get(file)
            if (hit !== undefined && hit.stamp === stamp) {
              if (hit.session !== undefined) sessions.push(hit.session)
              break
            }
            const text = candidate.endsWith('.zstd')
              ? decompressSessionLog(fs.readFileSync(file))
              : fs.readFileSync(file, 'utf8')
            const session = parseSessionLog(text, dir.name)
            const keep = session !== undefined && session.messages.length > 0 ? session : undefined
            cache.set(file, { stamp, session: keep })
            if (keep !== undefined) sessions.push(keep)
          } catch {
            // 单个会话读不出来不影响列表。
          }
          break
        }
      }
    }
    return sessions
  }

  const readOwnSessions = () => {
    const sessions = []
    let files = []
    try {
      files = fs.readdirSync(ownRoot).filter(name => name.endsWith('.json'))
    } catch {
      return sessions
    }
    for (const name of files) {
      try {
        sessions.push(JSON.parse(fs.readFileSync(path.join(ownRoot, name), 'utf8')))
      } catch {
        // 损坏文件跳过。
      }
    }
    return sessions
  }

  /** 网页版自己写过的会话优先，其余来自 DSH 日志。 */
  const all = () => {
    const own = readOwnSessions()
    const ownIds = new Set(own.map(session => session.id))
    return [...own, ...readDshSessions().filter(session => !ownIds.has(session.id))]
  }

  const summary = session => ({
    id: session.id,
    title: session.title,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
  })

  return {
    list: () => all().map(summary).sort((a, b) => b.updatedAt - a.updatedAt),
    get: id => all().find(session => session.id === id),
    save(session) {
      ensureOwn()
      const next = { ...session, updatedAt: Date.now() }
      fs.writeFileSync(path.join(ownRoot, `${session.id}.json`), JSON.stringify(next))
      return next
    },
    rename(id, title) {
      const current = this.get(id)
      if (current === undefined) return undefined
      return this.save({ ...current, title })
    },
    remove(id) {
      const file = path.join(ownRoot, `${id}.json`)
      if (!fs.existsSync(file)) return false
      fs.unlinkSync(file)
      return true
    },
  }
}

