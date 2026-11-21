import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { ackPending, findSessionFile, stageImport } from '../src/dsh-import.js'

/** 一个临时 DSH_HOME，用完删掉。 */
const tempHome = () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-chat-pro-'))
  return { home, done: () => fs.rmSync(home, { recursive: true, force: true }) }
}

test('导入：确认时拒绝越界的 id', () => {
  const { home, done } = tempHome()
  try {
    fs.writeFileSync(path.join(home, 'outer.json'), '{}')
    const removed = ackPending(home, ['../outer', 'ok-1', '/etc/passwd'])
    assert.deepEqual(removed, [])
    assert.equal(fs.existsSync(path.join(home, 'outer.json')), true)
  } finally {
    done()
  }
})

test('导入：确认只删暂存区里的文件', () => {
  const { home, done } = tempHome()
  try {
    stageImport(home, { id: 'session-abc', title: 't', messages: [] })
    assert.deepEqual(ackPending(home, ['session-abc']), ['session-abc'])
    assert.equal(fs.existsSync(path.join(home, 'webchat-imports', 'session-abc.json')), false)
  } finally {
    done()
  }
})

test('导入：会话 id 不允许穿过目录', () => {
  const { home, done } = tempHome()
  try {
    assert.equal(findSessionFile(home, '../secret'), undefined)
    assert.equal(findSessionFile(home, 'a/b'), undefined)
  } finally {
    done()
  }
})
