import test from 'node:test'
import assert from 'node:assert/strict'
import zlib from 'node:zlib'

import { decompressSessionLog, parseSessionLog } from '../src/dsh-import.js'

const line = (type, data, time) => JSON.stringify({ type, seq: 0, time, data })

/** 一条真实形状的日志：用户提问 → 上下文注入 → 两步 assistant。 */
const log = [
  JSON.stringify({ type: 'session', version: 4, id: 's1', createdAt: 1, cwd: 'C:/x', isSeeded: false, delegationDepth: 0 }),
  line('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, 10),
  line('user/message', { id: 'c1', role: 'user', content: [{ type: 'text', text: '时间快照' }], source: { kind: 'time-context' } }, 11),
  line('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '想' }], source: { kind: 'model' } } }, 12),
  line('user/message', { id: 'c2', role: 'user', content: [{ type: 'text', text: '又一个快照' }], source: { kind: 'runtime-context' } }, 13),
  line('assistant/message', { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'reasoning', text: '一想' }, { type: 'text', text: '答' }], source: { kind: 'model' } } }, 14),
  JSON.stringify({ type: 'session/title', seq: 9, time: 15, data: { title: '测试会话' } }),
].join('\n')

test('导入：上下文注入不打断合并，回答与提问交替', () => {
  const session = parseSessionLog(log, 'fallback')
  assert.equal(session.title, '测试会话')
  assert.deepEqual(session.messages.map(message => message.role), ['user', 'assistant'])
  assert.equal(session.messages[0].content, '你好')
  assert.deepEqual(session.messages[1].blocks.map(block => block.type), ['thinking', 'text'])
})

test('导入：子代理会话不导入', () => {
  const head = JSON.stringify({ type: 'session', version: 4, id: 's2', createdAt: 1, cwd: 'C:/x', isSeeded: false, delegationDepth: 2 })
  assert.equal(parseSessionLog(head, 'x'), undefined)
})

test('导入：多帧 zstd 逐帧解压', () => {
  const frame = text => zlib.zstdCompressSync(Buffer.from(text))
  const buffer = Buffer.concat([frame('第一帧\n'), frame('第二帧\n')])
  assert.equal(decompressSessionLog(buffer), '第一帧\n第二帧\n')
})

