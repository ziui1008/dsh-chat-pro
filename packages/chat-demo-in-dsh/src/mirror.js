/**
 * 把网页版的会话同步进 DSH 的事件日志，好让它也出现在 DSH 侧栏里。
 *
 * 做法不是自己拼 JSONL，而是走 DSH 自己的会话服务：
 *   1. `agentLoop.create()` 建一个会话（这一步才会挂上日志写入器）；
 *   2. 用 `session.append()` 追加 turn/step/消息事件；
 *   3. `sessions.flush()` 落盘。
 *
 * 进度不靠外部计数，直接数 live 会话里已有的 `assistant/message`——
 * 这样无论会话最初来自 DSH 还是网页版，都能继续往后追加，不会重复。
 */

/** 一条上游 assistant 消息 → DSH 的内容块。 */
const toContent = blocks => blocks.map((block) => block.type === 'thinking'
  ? { type: 'reasoning', text: block.thinking }
  : { type: 'text', text: block.text })

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ cwd: string }} options
 */
export function createMirror(ctx, options) {
  const sessions = ctx.get('sessions')
  const agentLoop = ctx.get('agentLoop')

  const live = id => sessions?.get(id)

  async function ensure(id) {
    if (agentLoop === undefined || sessions === undefined) return undefined
    const existing = live(id)
    if (existing !== undefined) return existing
    // 会话已存在于磁盘但当前没有 live 实例时，先 resume 载入并挂上写入器；
    // 直接用 create 会撞上已存在的会话 id。
    try {
      await agentLoop.resume(ctx, {
        resumeSessionId: id,
        agentOptions: { provider: 'deepseek-webchat', model: 'deepseek-flash' },
      })
      const resumed = live(id)
      if (resumed !== undefined) return resumed
    } catch {
      // 没落过盘的会话走 create。
    }
    try {
      await agentLoop.create(id, { provider: 'deepseek-webchat', model: 'deepseek-flash' }, { cwd: options.cwd })
    } catch {
      return undefined
    }
    return live(id)
  }

  /** 已经写进 DSH 的消息条数（每回合两条：提问 + 回答）。 */
  const progressOf = (target) => {
    let replies = 0
    let turns = 0
    for (const event of target.ownEvents()) {
      if (event.type === 'assistant/message') replies += 1
      if (event.type === 'turn/start') turns += 1
    }
    return { mirrored: replies * 2, turns }
  }

  return async function mirror(session) {
    if (agentLoop === undefined || sessions === undefined) return { appended: 0, live: false }
    let target
    try {
      target = await ensure(session.id)
    } catch {
      return { appended: 0, live: false }
    }
    if (target === undefined) return { appended: 0, live: false }

    const { mirrored, turns } = progressOf(target)
    const pending = session.messages.slice(mirrored)
    let turn = turns + 1
    let appended = 0
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const message = pending[index]
        const reply = pending[index + 1]
        // 网页版按「用户 / 助手」成对推进；剩下的半对留给下一次保存。
        if (message.role !== 'user' || reply?.role !== 'assistant') break
        target.append('turn/start', { turn })
        target.append('user/message', {
          id: message.id,
          role: 'user',
          content: [{ type: 'text', text: message.content }],
          source: { kind: 'user' },
        }, { surfaceOp: 'append' })
        target.append('step/start', { turn, step: 1 })
        target.append('assistant/message', {
          turn,
          step: 1,
          message: {
            id: reply.id,
            role: 'assistant',
            content: toContent(reply.blocks),
            source: { kind: 'model', provider: 'deepseek-webchat', model: 'deepseek-flash' },
          },
          stream: [],
        }, { surfaceOp: 'append' })
        target.append('step/end', { turn, step: 1 })
        target.append('turn/end', { turn, reason: { kind: 'completed' } })
        turn += 1
        index += 1
        appended += 2
      }
      if (appended > 0) await sessions.flush(target)
    } catch {
      // 事件顺序不被接受时停在失败处；网页版自己的状态不受影响。
    }
    return { appended, live: true }
  }
}

