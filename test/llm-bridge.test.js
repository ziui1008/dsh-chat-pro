import test from 'node:test'
import assert from 'node:assert/strict'

import {
  WEBCHAT_PROVIDER,
  dshRouteOf,
  effortFor,
  renderSearchContext,
  runSearch,
  searchQueryOf,
  searchRequested,
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

test('只有带 deepseek_web_search 工具才算要求联网搜索', () => {
  assert.equal(searchRequested({ tools: [{ name: 'deepseek_read_url' }] }), false)
  assert.equal(searchRequested({ tools: [{ name: 'deepseek_web_search' }] }), true)
  assert.equal(searchRequested({}), false)
  assert.equal(searchRequested(undefined), false)
})

test('检索词取最后一条用户消息，压缩空白并截断', () => {
  const body = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一轮' }] },
      { role: 'assistant', content: [{ type: 'text', text: '回答' }] },
      { role: 'user', content: [{ type: 'text', text: '  今天   北京天气\n怎么样  ' }] },
    ],
  }
  assert.equal(searchQueryOf(body), '今天 北京天气 怎么样')
  assert.equal(searchQueryOf({ messages: [] }), undefined)
  assert.equal(searchQueryOf(body, 3), '今天 ')
})

test('检索结果渲染成可引用的上下文，不是指令', () => {
  const text = renderSearchContext('北京天气', {
    sources: [
      { url: 'https://example.com/a', title: '天气页', snippet: '晴，22 度' },
      { url: 'https://example.com/b' },
    ],
  })
  assert.match(text, /检索词：北京天气/)
  assert.match(text, /1\. 天气页/)
  assert.match(text, /2\. https:\/\/example\.com\/b/)
  assert.match(text, /晴，22 度/)
})

test('没有 web 服务或检索报错时安静跳过', async () => {
  const noWeb = { get: () => undefined }
  assert.equal(await runSearch(noWeb, { provider: 'nume' }, '问题'), undefined)
  const failing = {
    get: () => ({
      searchReady: async () => true,
      search: async () => {
        throw new Error('boom')
      },
    }),
  }
  assert.equal(await runSearch(failing, { provider: 'nume' }, '问题'), undefined)
  const notReady = {
    get: () => ({ searchReady: async () => false, search: async () => assert.fail('不该检索') }),
  }
  assert.equal(await runSearch(notReady, { provider: 'nume' }, '问题'), undefined)
})

test('检索成功时返回来源列表', async () => {
  const ctx = {
    get: () => ({
      searchReady: async provider => provider === 'nume',
      search: async (request, signal) => {
        assert.equal(request.query, '问题')
        assert.equal(request.maxResults, 6)
        assert.equal(signal, undefined)
        return { sources: [{ url: 'https://example.com/a', title: 'A' }, { nope: true }], truncated: false }
      },
    }),
  }
  const result = await runSearch(ctx, { provider: 'nume' }, '问题')
  assert.equal(result.sources.length, 1)
  assert.equal(result.sources[0].url, 'https://example.com/a')
})

test('历史里换过模型的回答按自己的来源标注', () => {
  const { messages } = toGenerateMessages({
    messages: [
      { role: 'user', content: [{ type: 'text', text: '第一问' }] },
      {
        role: 'assistant',
        dsh: { provider: 'nume', model: 'gpt-6.2-sol' },
        content: [{ type: 'text', text: '第一答' }],
      },
      { role: 'user', content: [{ type: 'text', text: '第二问' }] },
    ],
  }, { provider: 'deepseek-account', model: 'deepseek-flash' })

  assert.equal(messages[1].source.provider, 'nume')
  assert.equal(messages[1].source.model, 'gpt-6.2-sol')
})
