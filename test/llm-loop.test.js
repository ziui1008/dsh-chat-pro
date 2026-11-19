import assert from 'node:assert/strict'
import test from 'node:test'

import { friendlyFailure, offeredTools, renderSearchContext, streamDshReply, toolAvailability } from '../src/llm-bridge.js'

/** Minimal ServerResponse stand-in that records the SSE events written to it. */
function fakeResponse() {
  const events = []
  return {
    events,
    writableEnded: false,
    headers: undefined,
    writeHead(status, headers) {
      this.headers = { status, headers }
    },
    write(chunk) {
      for (const line of String(chunk).split('\n')) {
        if (line.startsWith('data: ')) events.push(JSON.parse(line.slice(6)))
      }
      return true
    },
    end() {
      this.writableEnded = true
    },
    on() {},
  }
}

/** Build a fake ctx whose llm replays one scripted turn per round. */
function fakeContext(turns, ready = {}) {
  let round = 0
  const seen = []
  const web = {
    searchReady: async () => ready.search !== false,
    search: async () => ({ truncated: false, sources: [{ url: 'https://example.com/a', title: 'A', snippet: 'aa' }] }),
    fetchReady: async () => ready.fetch !== false,
    fetch: async () => ({ url: 'https://example.com/a', statusCode: 200, body: { kind: 'html', content: '<p>正文</p>' } }),
  }
  const llm = {
    resolveModelInfo: async () => ({ reasoning: undefined }),
    async *stream(options) {
      seen.push({
        round,
        tools: Array.isArray(options.tools) ? options.tools.length : 0,
        toolNames: Array.isArray(options.tools) ? options.tools.map(tool => tool.name) : [],
        system: options.system,
      })
      const scripted = turns[round++] ?? [{ type: 'text', text: 'end' }]
      // 没有工具可调时，假模型只能给出正文——和真实供应商的行为一致。
      const turn = options.tools === undefined ? [{ type: 'text', text: '结论。' }] : scripted
      for (const [index, piece] of turn.entries()) {
        if (piece.type === 'text') {
          yield { type: 'block-start', index, blockType: 'text' }
          yield { type: 'text-delta', index, text: piece.text }
          yield { type: 'block-end', index, block: { type: 'text', text: piece.text } }
        } else {
          yield { type: 'block-start', index, blockType: 'tool-call' }
          yield { type: 'block-end', index, block: { type: 'tool-call', id: piece.id, name: piece.name, arguments: JSON.stringify(piece.args) } }
        }
      }
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
      yield {
        type: 'finish',
        reason: turn.some(piece => piece.type === 'tool')
          ? { kind: 'tool-calls' }
          : { kind: 'stop' },
      }
    },
  }
  return {
    seen,
    ctx: {
      get(name) {
        if (name === 'llm') return llm
        if (name === 'web') return web
        return undefined
      },
    },
  }
}

const route = { provider: 'nume', model: 'gpt-6.2-sol', effort: 'low' }
const body = {
  model: 'gpt-6.2-sol',
  messages: [{ role: 'user', content: [{ type: 'text', text: '北京天气' }] }],
  thinking: { type: 'disabled' },
  tools: [{ name: 'deepseek_web_search' }, { name: 'deepseek_read_url' }],
}

test('工具调用后把结果回灌，最后给出正文', async () => {
  const { ctx } = fakeContext([
    [{ type: 'tool', id: 'call_1', name: 'web_search', args: { query: '北京天气' } }],
    [{ type: 'text', text: '明天适合跑步。' }],
  ])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  const types = res.events.filter(event => event.type === 'content_block_start').map(event => event.content_block.type)
  assert.deepEqual(types, ['server_tool_use', 'web_search_tool_result', 'text'])
  const text = res.events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')
  assert.equal(text, '明天适合跑步。')
  assert.equal(res.writableEnded, true)

  const indices = res.events.filter(event => event.type === 'content_block_start').map(event => event.index)
  assert.deepEqual([...indices].sort((a, b) => a - b), indices)
  assert.equal(new Set(indices).size, indices.length)
})

test('预算用完后不再给工具，逼出最后一段回答', async () => {
  const toolTurn = (id) => [{ type: 'tool', id, name: 'web_search', args: { query: id } }]
  const { ctx, seen } = fakeContext([
    toolTurn('call_a'),
    toolTurn('call_b'),
    toolTurn('call_c'),
    toolTurn('call_d'),
    toolTurn('call_e'),
    [{ type: 'text', text: '结论。' }],
  ])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  assert.deepEqual(seen.map(entry => entry.tools), [2, 2, 2, 0])
  const text = res.events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')
  assert.equal(text, '结论。')
})

test('模型直接回答时不发工具块', async () => {
  const { ctx } = fakeContext([[{ type: 'text', text: '直接答。' }]])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  const types = res.events.filter(event => event.type === 'content_block_start').map(event => event.content_block.type)
  assert.deepEqual(types, ['text'])
})

test('工具失败也回灌一条 isError 结果，回答继续', async () => {
  const { ctx } = fakeContext([
    [{ type: 'tool', id: 'call_x', name: 'read_url', args: { url: 'file:///etc/passwd' } }],
    [{ type: 'text', text: '换个说法。' }],
  ])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  const result = res.events.find(event => event.type === 'content_block_start' && event.content_block.type === 'web_fetch_tool_result')
  assert.equal(result.content_block.content.type, 'web_fetch_tool_result_error')
  const text = res.events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')
  assert.equal(text, '换个说法。')
})

test('只声明 read_url 时不提供检索工具', async () => {
  const { ctx, seen } = fakeContext([[{ type: 'text', text: '好。' }]])
  const res = fakeResponse()
  await streamDshReply(ctx, { ...body, tools: [{ name: 'deepseek_read_url' }] }, route, res)

  assert.equal(seen[0].tools, 1)
})

test('供应商不认 tools 时去掉工具重试一次', async () => {
  const { ctx, seen } = fakeContext([[], [{ type: 'text', text: '照常回答。' }]])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  assert.deepEqual(seen.map(entry => entry.tools), [2, 0])
  const text = res.events.filter(event => event.type === 'content_block_delta').map(event => event.delta.text).join('')
  assert.equal(text, '结论。')
})

test('一轮里超额的调用不执行，只回一条预算提示', async () => {
  const many = ['a', 'b', 'c', 'd', 'e'].map(id => ({ type: 'tool', id: `call_${id}`, name: 'web_search', args: { query: id } }))
  const { ctx } = fakeContext([many, [{ type: 'text', text: '收尾。' }]])
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  const starts = res.events.filter(event => event.type === 'content_block_start')
  assert.equal(starts.filter(event => event.content_block.type === 'server_tool_use').length, 4)
  assert.equal(starts.filter(event => event.content_block.type === 'web_search_tool_result').length, 4)
  assert.equal(starts.filter(event => event.content_block.type === 'text').length, 1)
})

test('检索与抓取都不可用时一个工具都不提供', async () => {
  const ctx = { get: () => ({ searchReady: async () => false, fetchReady: async () => false }) }
  assert.deepEqual(await offeredTools(ctx, route, body), [])
})

test('只有检索可用时仍提供 read_url 之外的工具集', async () => {
  const ctx = { get: () => ({ searchReady: async () => true, fetchReady: async () => false }) }
  const tools = await offeredTools(ctx, route, body)
  assert.deepEqual(tools.map(tool => tool.name), ['web_search'])
})

test('没有 web 服务时不给任何工具', async () => {
  assert.deepEqual(await offeredTools({ get: () => undefined }, route, body), [])
})

test('检索摘要过长会截断', () => {
  const text = renderSearchContext('q', {
    sources: [{ url: 'https://e.com', title: 'T', snippet: 'x'.repeat(900) }],
  })
  assert.equal(text.includes('x'.repeat(301)), false)
  assert.equal(text.includes('…'), true)
})

test('工具不可用时要如实告知，而不是让模型假装查过', async () => {
  const { ctx, seen } = fakeContext([[{ type: 'text', text: '现在查不了。' }]], { search: false })
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)

  assert.deepEqual(seen[0].toolNames, ['read_url'])
  assert.match(seen[0].system, /联网检索暂时不可用/)
})

test('两个工具都不可用时不带工具调用模型', async () => {
  const { ctx, seen } = fakeContext([[{ type: 'text', text: '好。' }]], { search: false, fetch: false })
  const res = fakeResponse()
  await streamDshReply(ctx, body, route, res)
  assert.equal(seen[0].tools, 0)
  assert.match(seen[0].system, /联网检索和打开网页暂时不可用/)
})

test('toolAvailability 报告缺失的工具名', async () => {
  const available = await toolAvailability(
    { get: () => ({ searchReady: async () => true, fetchReady: async () => false }) },
    route,
    body,
  )
  assert.deepEqual(available.tools.map(tool => tool.name), ['web_search'])
  assert.deepEqual(available.missing, ['read_url'])
})

test('供应商配置类错误换成用户看得懂的话', () => {
  assert.match(friendlyFailure('no adapter registered for provider "nope"'), /供应商现在不可用/)
  assert.match(friendlyFailure('pi-ai provider "nume" has no configured model "x"'), /已经不在 DSH 的配置里/)
  assert.match(friendlyFailure('401 Unauthorized: invalid api key'), /凭据不可用/)
  assert.equal(friendlyFailure('socket hang up'), 'socket hang up')
  assert.equal(friendlyFailure('x'.repeat(400)).length, 301)
})
