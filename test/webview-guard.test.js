import test from 'node:test'
import assert from 'node:assert/strict'

import { rejectWithoutSession } from '../src/webview.js'

/** 假 ctx：`get` 只认识 connection。 */
const fakeContext = connection => ({
  get(id) {
    return id === 'connection' ? connection : undefined
  },
})

test('准入：没有 connection 服务时放行（更老的 DSH）', () => {
  assert.equal(rejectWithoutSession(fakeContext(undefined), {}), undefined)
})

test('准入：跨站请求按 DSH 的判定返回 403', () => {
  const connection = { requestRejection: () => 403 }
  assert.equal(rejectWithoutSession(fakeContext(connection), {}), 403)
})

test('准入：没有会话凭据时返回 401', () => {
  const connection = { requestRejection: () => 401 }
  assert.equal(rejectWithoutSession(fakeContext(connection), {}), 401)
})

test('准入：通过时返回 undefined，并把原始请求交给 connection 判定', () => {
  const request = { headers: { host: '127.0.0.1:1' }, method: 'GET' }
  let seen
  const connection = {
    requestRejection(value) {
      seen = value
      return undefined
    },
  }
  assert.equal(rejectWithoutSession(fakeContext(connection), request), undefined)
  assert.equal(seen, request)
})
