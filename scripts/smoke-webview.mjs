/**
 * 网页版的界面冒烟测试：用无头 Chrome 的 CDP 真点一次界面，截图留证。
 *
 * 前置：DSH 在跑，且已开一个带调试端口的 Chrome：
 *   chrome --headless=new --remote-debugging-port=9222 --user-data-dir=<临时目录>
 *
 * 用法：node scripts/smoke-webview.mjs [baseURL]
 */
import fs from 'node:fs'
import path from 'node:path'

const BASE = process.argv[2] ?? 'http://127.0.0.1:59731/webchat/'
const OUT = path.join(import.meta.dirname, '..', 'docs', 'assets')
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const targets = await (await fetch('http://127.0.0.1:9222/json')).json()
const page = targets.find(target => target.type === 'page')
if (page === undefined) throw new Error('没有可用的页面目标')

const socket = new WebSocket(page.webSocketDebuggerUrl)
const pending = new Map()
let nextId = 0

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined && pending.has(message.id)) {
    pending.get(message.id)(message)
    pending.delete(message.id)
  }
})
await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))

const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++nextId
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

const evaluate = async (expression) => {
  const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (reply.result?.exceptionDetails !== undefined) {
    throw new Error(reply.result.exceptionDetails.text ?? 'evaluate failed')
  }
  return reply.result?.result?.value
}

const shot = async (name) => {
  const reply = await send('Page.captureScreenshot', { format: 'png' })
  const file = path.join(OUT, name)
  fs.writeFileSync(file, Buffer.from(reply.result.data, 'base64'))
  return file
}

await send('Page.enable')
await send('Runtime.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: BASE })
await sleep(4000)

const listTitle = await evaluate(`(() => {
  const items = [...document.querySelectorAll('*')].filter(el =>
    el.children.length === 0 && el.textContent.trim().length > 4 &&
    el.closest('[class*="list"], [class*="sider"]'))
  return items.length
})()`)
console.log('侧栏条目元素：', listTitle)

// 点开第一条会话
const clicked = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('div,button,a')]
    .filter(el => el.getAttribute('class')?.includes('item') || el.getAttribute('class')?.includes('title'))
  const target = rows.find(el => el.textContent.trim().length > 4)
  if (!target) return 'none'
  target.click()
  return target.textContent.trim().slice(0, 40)
})()`)
console.log('点击会话：', clicked)
await sleep(3500)
console.log('会话截图：', await shot('webview-session.png'))

// 输入一句话并发送（若输入框可用）
const typed = await evaluate(`(() => {
  const box = document.querySelector('textarea, [contenteditable="true"]')
  if (!box) return 'no-input'
  box.focus()
  if (box.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(box, '用一个比喻说说你现在看到的世界')
    box.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    box.textContent = '用一个比喻说说你现在看到的世界'
    box.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }
  return 'ok'
})()`)
console.log('输入：', typed)

if (typed === 'ok') {
  await sleep(500)
  const sent = await evaluate(`(() => {
    const buttons = [...document.querySelectorAll('button')]
    const send = buttons.find(button => button.getAttribute('class')?.match(/submit|send/i))
      ?? buttons[buttons.length - 1]
    if (!send) return 'no-send'
    send.click()
    return 'sent'
  })()`)
  console.log('发送：', sent)
  await sleep(12000)
  console.log('回复截图：', await shot('webview-reply.png'))
  const reply = await evaluate(`document.body.innerText.slice(-400)`)
  console.log('页面末尾文本：', String(reply).replace(/\n+/g, ' | ').slice(0, 300))
}

socket.close()
