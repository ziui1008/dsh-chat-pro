/**
 * 把网页版新建的会话镜像进 DSH 的事件日志，好让它也出现在 DSH 侧栏里。
 *
 * 做法不是自己拼 JSONL，而是走 DSH 自己的会话服务：
 *   1. `agentLoop.create()` 建一个会话（这一步才会挂上日志写入器）；
 *   2. 用 `session.append()` 追加 turn/step/消息事件；
 *   3. `sessions.flush()` 落盘。
 *
 * 全程 try/catch：镜像失败不影响网页版自己那份 JSON 存储。
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

  /** 这条会话在 DSH 侧已经镜像到第几条消息。 */
  const live = id => sessions?.get(id)

  async function ensure(id) {
    if (agentLoop === undefined || sessions === undefined) return undefined
    const existing = live(id)
    if (existing !== undefined) return existing
    await agentLoop.create(id, { provider: 'deepseek-webchat', model: 'deepseek-flash' }, { cwd: options.cwd })
    return live(id)
  }

  return async function mirror(session, mirrored = 0) {
    if (agentLoop === undefined || sessions === undefined) return mirrored
    let target
    try {
      target = await ensure(session.id)
    } catch {
      return mirrored
    }
    if (target === undefined) return mirrored

    const pending = session.messages.slice(mirrored)
    let turn = Math.max(1, Math.ceil(mirrored / 2))
    try {
      for (let index = 0; index < pending.length; index += 1) {
        const message = pending[index]
        // 网页版按「用户 / 助手」成对推进；剩下的半对留给下一次保存。
        if (message.role !== 'user' || pending[index + 1]?.role !== 'assistant') break
        const reply = pending[index + 1]
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
        mirrored += 2
        index += 1
      }
      await sessions.flush(target)
    } catch {
      // 事件顺序不被接受时停在这一条，下一次保存再试；网页版那份 JSON 不受影响。
    }
    return mirrored
  }
}
