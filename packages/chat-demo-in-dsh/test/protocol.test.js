import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'

import { apiRoot, isInside } from '../src/protocol.js'

test('端点根：补上 /v1，已带则不重复', () => {
  assert.equal(apiRoot('https://api.deepseek.com/anthropic'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(apiRoot('https://api.deepseek.com/anthropic/'), 'https://api.deepseek.com/anthropic/v1')
  assert.equal(apiRoot('https://example.com/v1'), 'https://example.com/v1')
})

test('静态资源不得跳出产物目录', () => {
  const root = path.resolve('/srv/dist')
  assert.equal(isInside(root, path.join(root, 'static/js/main.js')), true)
  assert.equal(isInside(root, path.resolve(root, '../secrets.txt')), false)
  assert.equal(isInside(root, path.resolve(root, 'static/../../etc/passwd')), false)
})

test('产物目录本身算在内', () => {
  const root = path.resolve('/srv/dist')
  assert.equal(isInside(root, root), true)
})
