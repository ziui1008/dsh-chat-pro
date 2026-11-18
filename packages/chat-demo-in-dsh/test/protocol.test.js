import test from 'node:test'
import assert from 'node:assert/strict'

import {
  SYSTEM_PROMPT,
  buildChatRequest,
  latestReminder,
  serverTools,
  toWireMessages,
} from '../src/protocol.js'
import { parseSessionLog } from '../src/sessions.js'

test('系统提示与官方 chat-demo 逐字一致', () => {
  assert.equal(SYSTEM_PROMPT, '该助手为DeepSeek，由深度求索公司创造。')
})

test('请求体只包含官方字段', () => {
  const body = buildChatRequest({ messages: [{ role: 'user', content: 'hi' }] })
  assert.deepEqual(Object.keys(body).sort(), [
    'messages', 'model', 'safety_check', 'stream', 'system', 'thinking', 'tools',
  ])
  assert.equal(body.stream, true)
  assert.deepEqual(body.safety_check, { level: 'high' })
  assert.equal(body.temperature, undefined)
})

test('工具声明：阅读链接恒开，搜索按开关追加', () => {
  assert.deepEqual(serverTools(false), [{ type: 'deepseek_read_url', name: 'deepseek_read_url' }])
  assert.deepEqual(serverTools(true).map(tool => tool.type), ['deepseek_read_url', 'deepseek_web_search'])
})

test('latest_reminder 是五个字段的一行', () => {
  const at = new Date('2026-11-18T09:00:00+08:00')
  assert.equal(latestReminder(at), '2026-11-18,星期三,,Web,中文')
  assert.equal(latestReminder(at, 'English'), '2026-11-18,Wednesday,,Web,English')
})

test('历史只留真人发言与模型回答，并按轮补 latest_reminder', () => {
  const messages = toWireMessages([
    { role: 'system', content: '系统提示' },
    { role: 'user', source: { kind: 'runtime-context' }, content: '工作目录', time: Date.parse('2026-11-18T09:00:00+08:00') },
    { role: 'user', source: { kind: 'user' }, content: '你好', time: Date.parse('2026-11-18T09:00:00+08:00') },
    { role: 'assistant', content: [{ type: 'reasoning', text: '想' }, { type: 'text', text: '你好呀' }] },
    { role: 'user', source: { kind: 'user' }, content: '再说一句', time: Date.parse('2026-11-18T09:05:00+08:00') },
  ])
  assert.deepEqual(messages.map(m => m.role), ['latest_reminder', 'user', 'assistant', 'user'])
  assert.equal(messages[1].content, '你好')
  assert.deepEqual(messages[2].content, [{ type: 'text', text: '你好呀' }])
})

test('同一轮的重复提醒只发一次', () => {
  const at = Date.parse('2026-11-18T09:00:00+08:00')
  const messages = toWireMessages([
    { role: 'user', source: { kind: 'user' }, content: 'a', time: at },
    { role: 'user', source: { kind: 'user' }, content: 'b', time: at + 1000 },
  ])
  assert.equal(messages.filter(m => m.role === 'latest_reminder').length, 1)
})

test('会话日志：按 turn 合并 assistant，丢弃 DSH 注入的上下文', () => {
  const record = (type, data, time) => JSON.stringify({ type, seq: 0, time, data })
  const text = [
    JSON.stringify({ type: 'session', version: 4, id: 's1', createdAt: 1, cwd: 'C:/x', isSeeded: false, delegationDepth: 0 }),
    record('user/message', { id: 'u1', role: 'user', content: [{ type: 'text', text: '你好' }], source: { kind: 'user' } }, 10),
    record('user/message', { id: 'u2', role: 'user', content: [{ type: 'text', text: '环境' }], source: { kind: 'time-context' } }, 11),
    record('assistant/message', { turn: 1, step: 1, message: { id: 'a1', role: 'assistant', content: [{ type: 'reasoning', text: '想' }], source: { kind: 'model' } } }, 12),
    record('assistant/message', { turn: 1, step: 2, message: { id: 'a2', role: 'assistant', content: [{ type: 'reasoning', text: '一' }, { type: 'text', text: '答' }], source: { kind: 'model' } } }, 13),
    JSON.stringify({ type: 'session/title', seq: 9, time: 14, data: { title: '测试会话', source: { kind: 'fallback' } } }),
  ].join('\n')

  const session = parseSessionLog(text, 'fallback')
  assert.equal(session.title, '测试会话')
  assert.equal(session.messages.length, 2)
  assert.equal(session.messages[0].role, 'user')
  assert.equal(session.messages[1].blocks.map(block => block.type).join('+'), 'thinking+text')
})

test('子代理会话不进列表', () => {
  const text = JSON.stringify({ type: 'session', version: 4, id: 's2', createdAt: 1, cwd: 'C:/x', isSeeded: false, delegationDepth: 1 })
  assert.equal(parseSessionLog(text, 'x'), undefined)
})
