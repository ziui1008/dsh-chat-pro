/**
 * 用 Chrome DevTools Protocol 给页面拍一张图，并回收控制台错误与失败请求。
 * 只用于开发期验收：node scripts/shot.mjs <url> <out.png>
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const url = process.argv[2] ?? 'http://127.0.0.1:59731/webchat/'
const out = process.argv[3] ?? path.join(os.tmpdir(), 'shot.png')
const chrome = process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const port = 9333
const profile = path.join(os.tmpdir(), `shot-profile-${Date.now()}`)

const child = spawn(chrome, [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--hide-scrollbars',
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profile}`,
  '--window-size=1280,880',
  'about:blank',
], { stdio: 'ignore' })

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

async function pickTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`)
      const targets = await response.json()
      const page = targets.find(target => target.type === 'page')
      if (page !== undefined) return page
    } catch {
      // 浏览器还没起来。
    }
    await sleep(250)
  }
  throw new Error('Chrome 调试端口未就绪')
}

const target = await pickTarget()
const socket = new WebSocket(target.webSocketDebuggerUrl)
let nextId = 1
const pending = new Map()
const problems = []

socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data)
  if (message.id !== undefined) {
    pending.get(message.id)?.(message)
    pending.delete(message.id)
    return
  }
  if (message.method === 'Network.responseReceived' && message.params.response.status >= 400) {
    problems.push('http ' + message.params.response.status + ': ' + message.params.response.url)
  }
  if (message.method === 'Network.loadingFailed') {
    problems.push('failed: ' + message.params.errorText + ' ' + message.params.requestId)
  }
  if (message.method === 'Runtime.exceptionThrown') {
    problems.push('exception: ' + (message.params.exceptionDetails?.exception?.description ?? message.params.exceptionDetails?.text))
  }
  if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') {
    problems.push('log: ' + message.params.entry.text)
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    problems.push('console: ' + (message.params.args ?? []).map(arg => arg.value ?? arg.description ?? '').join(' '))
  }
})

const send = (method, params = {}) => new Promise((resolve) => {
  const id = nextId++
  pending.set(id, resolve)
  socket.send(JSON.stringify({ id, method, params }))
})

await new Promise(resolve => socket.addEventListener('open', resolve, { once: true }))
await send('Page.enable')
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')
await send('Page.navigate', { url })
await sleep(9000)

const expression = 'JSON.stringify({ root: document.getElementById("root")?.innerHTML.length ?? -1, title: document.title, text: (document.body.innerText || "").slice(0, 200) })'
const probe = await send('Runtime.evaluate', { expression, returnByValue: true })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
fs.writeFileSync(out, Buffer.from(shot.result.data, 'base64'))

console.log(JSON.stringify({
  probe: JSON.parse(probe.result?.result?.value ?? '{}'),
  problems: [...new Set(problems)].slice(0, 15),
  screenshot: out,
  bytes: fs.statSync(out).size,
}, null, 2))

socket.close()
child.kill()
