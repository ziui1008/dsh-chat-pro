import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEBCHAT_PROVIDER,
  dshRouteOf,
  effortFor,
  toGenerateMessages,
} from '../src/llm-bridge.js'

test('没选路由时仍走网页版自己的端点', () => {
  assert.equal(dshRouteOf({ model: 'deepseek-flash' }), undefined)
  assert.equal(dshRouteOf({ dsh: { provider: WEBCHAT_PROVIDER, model: 'deepseek-flash' } }), undefined)
  assert.deepEqual(dshRouteOf({ dsh: { provider: 'nume', model: 'gpt-6.2-sol', effort: 'high' } }), {
    provider: 'nume',
    model: 'gpt-6.2-sol',
    effort: 'high',
  })
})

test('路由字段不全时忽略', () => {
  assert.equal(dshRouteOf({ dsh: { provider: 'nume' } }), undefined)
  assert.equal(dshRouteOf({ dsh: { model: 'gpt-6.2-sol' } }), undefined)
  assert.equal(dshRouteOf({ dsh: null }), undefined)
})

test('思考开关关掉时优先用 off 档位', () => {
  const route = { provider: 'nume', model: 'gpt-6.2-sol', effort: 'high' }
  assert.equal(effortFor(route, false, [{ id: 'off' }, { id: 'high' }]), 'off')
  assert.equal(effortFor(route, false, [{ id: 'high' }]), undefined)
  assert.equal(effortFor(route, true, [{ id: 'high' }]), 'high')
  assert.equal(effortFor({ provider: 'nume', model: 'gpt-6.2-sol' }, true, [{ id: 'high' }]), undefined)
})

test('消息转换丢掉 latest_reminder 与 system，并保留思考块', () => {
  const { messages, system } = toGenerateMessages(
    {
      system: '该助手为DeepSeek，由深度求索公司创造。',
      messages: [
        { role: 'latest_reminder', content: '[Current date: 2026-11-19]' },
        { role: 'user', content: [{ type: 'text', text: '你好' }] },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '想一想', signature: 's' },
            { type: 'text', text: '你好呀' },
            { type: 'server_tool_use', id: 'x' },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '继续' }] },
      ],
    },
    { provider: 'nume', model: 'gpt-6.2-sol' }
  )
  assert.equal(system, '该助手为DeepSeek，由深度求索公司创造。')
  assert.equal(messages.length, 3)
  assert.deepEqual(messages[0], { role: 'user', content: [{ type: 'text', text: '你好' }] })
  assert.equal(messages[1].role, 'assistant')
  assert.equal(messages[1].source.provider, 'nume')
  assert.deepEqual(messages[1].content, [
    { type: 'reasoning', text: '想一想' },
    { type: 'text', text: '你好呀' },
  ])
})

test('历史以 assistant 开头时去掉，直到第一条 user', () => {
  const { messages } = toGenerateMessages(
    {
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '上一轮' }] },
        { role: 'user', content: [{ type: 'text', text: '这一轮' }] },
      ],
    },
    { provider: 'nume', model: 'gpt-6.2-sol' }
  )
  assert.equal(messages.length, 1)
  assert.equal(messages[0].role, 'user')
})

test('图片附件在非网页版模型上明确报错', () => {
  assert.throws(
    () =>
      toGenerateMessages(
        {
          messages: [
            {
              role: 'user',
              content: [
                { type: 'text', text: '看图' },
                { type: 'image', source: { type: 'file', file_id: 'f' } },
              ],
            },
          ],
        },
        { provider: 'nume', model: 'gpt-6.2-sol' }
      ),
    error => error.status === 400
  )
})
