import assert from 'node:assert/strict'
import test from 'node:test'

import { createScrubber } from '../src/llm-bridge.js'

test('整段的 DSML 标签直接刮掉', () => {
  const scrubber = createScrubber()
  const text = '先看一眼<｜｜DSML｜｜ calls>再看<｜｜DSML｜｜ invoke name="read_url">结果'
  assert.equal(scrubber.push(text), '先看一眼再看结果')
  assert.equal(scrubber.flush(), '')
})

test('标签被拆到多个 chunk 里也能认出来', () => {
  const scrubber = createScrubber()
  const pieces = ['帮我查<', '｜', '｜DSML｜｜ calls', '>一下', '天气']
  const output = pieces.map(piece => scrubber.push(piece)).join('')
  assert.equal(output.includes('DSML'), false)
  assert.equal(output, '帮我查一下天气')
})

test('半截标签留在缓冲里，等下一片', () => {
  const scrubber = createScrubber()
  assert.equal(scrubber.push('正文<｜｜DSML'), '正文')
  assert.equal(scrubber.push('｜｜ calls>尾巴'), '尾巴')
})

test('普通的小于号不受影响', () => {
  const scrubber = createScrubber()
  assert.equal(scrubber.push('1 < 2 且 a<b'), '1 < 2 且 a<b')
})

test('流结束时把残留吐出来', () => {
  const scrubber = createScrubber()
  assert.equal(scrubber.push('未完<'), '未完')
  assert.equal(scrubber.flush(), '<')
})
