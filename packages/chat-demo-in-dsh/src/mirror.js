/**
 * 把网页版的会话同步进 DSH 的事件日志，好让它也出现在 DSH 侧栏里。
 *
 * 走 DSH 自己的会话服务：agentLoop.create/resume 建会话（挂上日志写入器）→
 * session.append 追加 turn/step/消息 → sessions.flush 落盘。
 *
 * 进度不靠外部计数，直接数 live 会话里已有的 `assistant/message`，
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
    if (agentLoop === undefined || sessions === undefined) return { session: undefined, note: 'services unavailable' }
    const existing = live(id)
    if (existing !== undefined) return { session: existing, note: 'live' }
    // 已落盘但没有 live 实例时先 resume；直接 create 会撞上已存在的会话 id。
    try {
      await agentLoop.resume(ctx, {
        resumeSessionId: id,
        agentOptions: { provider: 'deepseek-webchat', model: 'deepseek-flash' },
      })
      const resumed = live(id)
      if (resumed !== undefined) return { session: resumed, note: 'resumed' }
      return { session: undefined, note: 'resume returned no live session' }
    } catch (error) {
      const resumeError = `resume: ${error?.message ?? error}`
      try {
        await agentLoop.create(id, { provider: 'deepseek-webchat', model: 'deepseek-flash' }, { cwd: options.cwd })
      } catch (createError) {
        return { session: undefined, note: `${resumeError}; create: ${createError?.message ?? createError}` }
      }
      return { session: live(id), note: 'created' }
    }
  }

  /**
   * DSH 里已经出现过的消息 id（提问与回答都记）。
   *
   * 不按"第几条"推算：早期失败的追加可能留下只有提问、没有回答的半截回合，
   * 按计数会永久错位；按 id 对齐则天然幂等，重复保存不会重复追加。
   */
  const seenIds = (target) => {
    const seen = new Set()
    for (const event of target.ownEvents()) {
      if (event.type === 'user/message') seen.add(String(event.data?.id ?? ''))
      if (event.type === 'assistant/message') seen.add(String(event.data?.message?.id ?? ''))
    }
    return seen
  }

  const countTurns = (target) => {
    let turns = 0
    for (const event of target.ownEvents()) {
      if (event.type === 'turn/start') turns += 1
    }
    return turns
  }
  return async function mirror(session) {
    if (agentLoop === undefined || sessions === undefined) return { appended: 0, live: false, note: 'services unavailable' }
    const { session: target, note } = await ensure(session.id)
    if (target === undefined) return { appended: 0, live: false, note }

    const seen = seenIds(target)
    let turn = countTurns(target) + 1
    let appended = 0
    let stage = 'none'
    try {
      for (let index = 0; index < session.messages.length; index += 1) {
        const message = session.messages[index]
        if (message.role !== 'user') continue
        const reply = session.messages[index + 1]
        if (reply?.role !== 'assistant') continue
        const userSeen = seen.has(String(message.id))
        const replySeen = seen.has(String(reply.id))
        if (userSeen && replySeen) continue

        stage = 'turn/start'
        target.append('turn/start', { turn })

        if (!userSeen) {
          stage = 'user/message'
          target.append('user/message', {
            id: message.id,
            role: 'user',
            content: [{ type: 'text', text: message.content }],
            source: { kind: 'user' },
          }, { surfaceOp: 'append' })
        }

        stage = 'request/header'
        target.append('request/header', {
          header: { config: { provider: 'deepseek-webchat', model: 'deepseek-flash' } },
          reason: 'initial',
        })

        stage = 'step/start'
        target.append('step/start', { turn, step: 1 })

        stage = 'assistant/message'
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

        stage = 'step/end'
        target.append('step/end', { turn, step: 1 })

        stage = 'turn/end'
        target.append('turn/end', { turn, reason: { kind: 'completed' } })

        turn += 1
        appended += userSeen ? 1 : 2
      }
      if (appended > 0) await sessions.flush(target)
    } catch (error) {
      return { appended, live: true, note, failure: `${stage}: ${error?.message ?? error}` }
    }
    return { appended, live: true, note }
  }
}

