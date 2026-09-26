// Diagnose why dispose() does not release an in-flight turn.
import { CodexChatGptAdapter } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { fakeSpawn } from '../tests/fake-app-server.js'

const config = resolveConfig({ cwd: process.cwd(), codexExecutable: 'fake-codex', turnTimeoutMs: 60_000 })
const spawn = fakeSpawn({ deltas: ['hi'], noTerminal: true })
const provider = new CodexChatGptAdapter({
  config,
  spawn,
  onDiagnostic: (m) => console.log(`   [diag] ${m}`),
})

const chunks = []
const streaming = (async () => {
  for await (const chunk of provider.stream({
    provider: 'codex-chatgpt',
    model: 'gpt-6-astra',
    sessionId: 's1',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
  })) {
    chunks.push(chunk.type)
    console.log(`   chunk: ${chunk.type}`)
  }
})()

await new Promise((r) => setTimeout(r, 30))
const client = provider.registry.client
console.log('client present:', client !== undefined && client !== null)
console.log('client.closed:', client?.closed, '| client.lost:', client?.lost)

console.log('--- calling provider.dispose() ---')
provider.dispose()
console.log('after dispose: client.closed =', client?.closed, '| client.lost =', client?.lost)

const winner = await Promise.race([
  streaming.then(() => 'SETTLED'),
  new Promise((r) => setTimeout(() => r('STILL-PENDING'), 2_000)),
])
console.log('result:', winner)
console.log('chunks:', chunks.join(','))
process.exit(0)
