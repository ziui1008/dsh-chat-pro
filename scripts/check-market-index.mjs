import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire('D:/Program Data/DSH/resources/app/dsh/node_modules/')
const { parseMarketIndex, marketInstallTarget } = require('@deepseek-ai/dsh-plugin-market-index')

const file = process.argv[2] ?? 'market/index.json'
const url = 'https://raw.githubusercontent.com/ziui1008/dsh-chat-pro/main/market/index.json'
const index = parseMarketIndex(JSON.parse(readFileSync(file, 'utf8')), url)
const plugin = index.plugins[0]
console.log('format', index.format, '| plugins', index.plugins.length)
console.log('name', plugin.name, '| versions', plugin.versions.map((v) => v.version).join(', '))
console.log('install', JSON.stringify(marketInstallTarget(plugin.name, plugin.versions[0])))
console.log('icon', plugin.icon)
