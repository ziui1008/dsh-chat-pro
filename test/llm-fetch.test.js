import test from 'node:test'
import assert from 'node:assert/strict'

import {
  htmlToText,
  looksBinary,
  readRequested,
  readTargets,
  renderFetchContext,
  runFetch,
  urlsInText,
} from '../src/llm-bridge.js'

test('只有带 deepseek_read_url 工具才算要求读网页', () => {
  assert.equal(readRequested({ tools: [{ name: 'deepseek_web_search' }] }), false)
  assert.equal(readRequested({ tools: [{ name: 'deepseek_read_url' }] }), true)
  assert.equal(readRequested({}), false)
})

test('从用户消息里挑链接，去掉句末标点并去重', () => {
  assert.deepEqual(urlsInText('看下 https://example.com/a，还有 https://example.com/a。'), ['https://example.com/a'])
  assert.deepEqual(urlsInText('没有链接'), [])
  assert.deepEqual(urlsInText('https://a.com/1 https://b.com/2 https://c.com/3', 2), ['https://a.com/1', 'https://b.com/2'])
})

test('读页面的目标：用户贴的链接优先，检索结果补足', () => {
  const body = {
    messages: [
      { role: 'assistant', content: [{ type: 'text', text: '上一轮 https://old.example.com' }] },
      { role: 'user', content: [{ type: 'text', text: '帮我看看 https://user.example.com/x' }] },
    ],
  }
  const found = { sources: [{ url: 'https://user.example.com/x' }, { url: 'https://search.example.com/1' }] }
  assert.deepEqual(readTargets(body, found), ['https://user.example.com/x', 'https://search.example.com/1'])
  assert.deepEqual(readTargets({ messages: [] }, undefined), [])
})

test('HTML 去标签后保留段落，脚本和样式被丢掉', () => {
  const html = '<html><head><style>.a{color:red}</style><script>alert(1)</script></head>' +
    '<body><h1>标题</h1><p>第一段 &amp; 内容</p><div>第二段<br>换行</div></body></html>'
  const text = htmlToText(html)
  assert.match(text, /标题/)
  assert.match(text, /第一段 & 内容/)
  assert.match(text, /第二段/)
  assert.doesNotMatch(text, /alert|color:red|<p>/)
})

test('抓页面：没有 web 服务、未就绪或抛错时安静返回空数组', async () => {
  const idle = await runFetch({ get: () => undefined }, { provider: 'nume' }, ['https://a.com'])
  assert.deepEqual(idle, [undefined])
  const notReady = { get: () => ({ fetchReady: async () => false, fetch: async () => assert.fail('不该抓') }) }
  assert.deepEqual(await runFetch(notReady, { provider: 'nume' }, ['https://a.com']), [undefined])
  const failing = {
    get: () => ({
      fetchReady: async () => true,
      fetch: async () => {
        throw new Error('boom')
      },
    }),
  }
  assert.deepEqual(await runFetch(failing, { provider: 'nume' }, ['https://a.com']), [undefined])
})

test('抓页面：保留正文、跳过 4xx 与空正文', async () => {
  const ctx = {
    get: () => ({
      fetchReady: async () => true,
      fetch: async request => {
        if (request.url === 'https://bad.example.com') return { url: request.url, statusCode: 404, body: { kind: 'text', content: 'x' } }
        if (request.url === 'https://empty.example.com') return { url: request.url, statusCode: 200, body: { kind: 'html', content: '<html></html>' } }
        return { url: request.url, statusCode: 200, body: { kind: 'html', content: '<p>正文内容</p>' } }
      },
    }),
  }
  const pages = await runFetch(
    ctx,
    { provider: 'nume' },
    ['https://bad.example.com', 'https://empty.example.com', 'https://ok.example.com']
  )
  assert.equal(pages.length, 3)
  assert.equal(pages[0], undefined)
  assert.equal(pages[1], undefined)
  assert.equal(pages[2].url, 'https://ok.example.com')
  assert.match(pages[2].text, /正文内容/)
})

test('正文上下文写清来源，空列表返回空串', () => {
  assert.equal(renderFetchContext([]), '')
  const text = renderFetchContext([{ url: 'https://a.com', text: '页面正文' }])
  assert.match(text, /网页正文摘录/)
  assert.match(text, /1\. https:\/\/a\.com/)
  assert.match(text, /页面正文/)
})

test('PDF 这类二进制不当正文', async () => {
  assert.equal(looksBinary('%PDF-1.7\n1 0 obj'), true)
  assert.equal(looksBinary('\u0000\u0001binary'), true)
  assert.equal(looksBinary('正常的中文网页正文，带标点。'), false)
})

test('抓回二进制时按抓不到处理', async () => {
  const pages = await runFetch(
    { get: () => ({ fetchReady: async () => true, fetch: async () => ({ url: 'https://e.com/a.pdf', statusCode: 200, body: { kind: 'text', content: '%PDF-1.7 ...' } }) }) },
    { provider: 'nume', model: 'm' },
    ['https://e.com/a.pdf'],
    undefined,
  )
  assert.equal(pages[0], undefined)
})
