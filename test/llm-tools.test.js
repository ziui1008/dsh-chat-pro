import assert from 'node:assert/strict'
import test from 'node:test'

import {
  executeTool,
  hostTools,
  isFetchableUrl,
  toolArguments,
  toolNamesOf,
} from '../src/llm-bridge.js'

const bodyWith = (names) => ({ tools: names.map(name => ({ type: name, name })) })

test('工具名从请求体里读出来，坏条目跳过', () => {
  assert.deepEqual(toolNamesOf(bodyWith(['deepseek_web_search', 'deepseek_read_url'])), ['deepseek_web_search', 'deepseek_read_url'])
  assert.deepEqual(toolNamesOf({ tools: [null, 42, { name: 'x' }] }), ['x'])
  assert.deepEqual(toolNamesOf(undefined), [])
})

test('宿主只提供请求体声明过的工具', () => {
  assert.deepEqual(hostTools(bodyWith(['deepseek_web_search', 'deepseek_read_url'])).map(tool => tool.name), ['web_search', 'read_url'])
  assert.deepEqual(hostTools(bodyWith(['deepseek_read_url'])).map(tool => tool.name), ['read_url'])
  assert.deepEqual(hostTools(bodyWith([])), [])
  assert.equal(hostTools(bodyWith(['deepseek_web_search']))[0].parameters.required[0], 'query')
})

test('参数解析容错', () => {
  assert.deepEqual(toolArguments('{"query":"天气"}'), { query: '天气' })
  assert.deepEqual(toolArguments('not json'), {})
  assert.deepEqual(toolArguments('null'), {})
  assert.deepEqual(toolArguments(undefined), {})
})

test('只放行 http/https 且不带凭据的地址', () => {
  assert.equal(isFetchableUrl('https://example.com/a'), true)
  assert.equal(isFetchableUrl('http://example.com'), true)
  assert.equal(isFetchableUrl('file:///etc/passwd'), false)
  assert.equal(isFetchableUrl('javascript:alert(1)'), false)
  assert.equal(isFetchableUrl('https://user:pass@example.com'), false)
  assert.equal(isFetchableUrl('not a url'), false)
  assert.equal(isFetchableUrl(undefined), false)
})

test('内网与云元数据地址不放行', () => {
  for (const url of [
    'http://127.0.0.1:60627/webchat/',
    'http://localhost:3000/',
    'http://192.168.1.1/',
    'http://10.0.0.5/',
    'http://172.16.3.4/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'http://0.0.0.0/',
    'https://foo.local/',
  ]) {
    assert.equal(isFetchableUrl(url), false, url)
  }
  assert.equal(isFetchableUrl('https://example.com/a'), true)
})

test('未知工具回一条错误文本，不抛', async () => {
  const result = await executeTool({ get: () => undefined }, { provider: 'nume' }, { id: 'c1', name: 'shell', arguments: '{}' })
  assert.equal(result.ok, false)
  assert.match(result.text, /没有名为 shell 的工具/)
})

test('检索服务不可用时给出可读的失败结果', async () => {
  const ctx = { get: () => undefined }
  const result = await executeTool(ctx, { provider: 'nume' }, { id: 'c2', name: 'web_search', arguments: '{"query":"北京天气"}' })
  assert.equal(result.ok, false)
  assert.match(result.text, /检索服务不可用/)
  assert.equal(result.query, '北京天气')
})

test('空 query 不触发检索', async () => {
  let called = false
  const web = { search: async () => { called = true; return { sources: [], truncated: false } } }
  const result = await executeTool({ get: () => web }, { provider: 'nume' }, { id: 'c3', name: 'web_search', arguments: '{"query":"   "}' })
  assert.equal(result.ok, false)
  assert.equal(called, false)
})

test('非法链接直接拒绝，不发请求', async () => {
  let called = false
  const web = { fetchReady: async () => true, fetch: async () => { called = true; return undefined } }
  const result = await executeTool({ get: () => web }, { provider: 'nume' }, { id: 'c4', name: 'read_url', arguments: '{"url":"file:///etc/passwd"}' })
  assert.equal(result.ok, false)
  assert.equal(called, false)
  assert.match(result.text, /只支持 http 或 https/)
})

test('抓不到正文时给出失败结果', async () => {
  const web = { fetchReady: async () => true, fetch: async () => { throw new Error('boom') } }
  const result = await executeTool({ get: () => web }, { provider: 'nume' }, { id: 'c5', name: 'read_url', arguments: '{"url":"https://example.com"}' })
  assert.equal(result.ok, false)
  assert.match(result.text, /页面取不到正文/)
})

test('检索成功时结果带上来源清单', async () => {
  const web = {
    searchReady: async () => true,
    search: async () => ({
      truncated: false,
      sources: [{ url: 'https://a.example.com', title: 'A', snippet: '摘要 A' }],
    }),
  }
  const result = await executeTool({ get: () => web }, { provider: 'nume' }, { id: 'c6', name: 'web_search', arguments: '{"query":"A"}' })
  assert.equal(result.ok, true)
  assert.match(result.text, /A/)
  assert.match(result.text, /https:\/\/a\.example\.com/)
})

test('抓页面成功时返回正文摘录', async () => {
  const web = {
    fetchReady: async () => true,
    fetch: async () => ({
      url: 'https://example.com',
      statusCode: 200,
      body: { kind: 'html', content: '<main><p>正文第一段</p></main>' },
    }),
  }
  const result = await executeTool({ get: () => web }, { provider: 'nume' }, { id: 'c7', name: 'read_url', arguments: '{"url":"https://example.com"}' })
  assert.equal(result.ok, true)
  assert.match(result.text, /正文第一段/)
  assert.equal(result.payload.url, 'https://example.com')
})
