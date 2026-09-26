// Minimal reproduction of the suspected hang: one turn against the fake app-server.
import { CodexClient } from '../src/client.js'
import { resolveConfig } from '../src/config.js'
import { fakeSpawn } from '../tests/fake-app-server.js'

const config = resolveConfig({ cwd: process.cwd(), codexExecutable: 'fake-codex' })

for (const scenario of [
  { name: 'plain deltas', options: { deltas: ['Hi'] } },
  { name: 'no delta', options: { noDelta: true, deltas: ['only'] } },
  { name: 'failed turn', options: { turnStatus: 'failed' } },
  { name: 'turn started first', options: { deltas: ['X'], emitTurnStartedFirst: true } },
]) {
  const spawn = fakeSpawn(scenario.options)
  const client = new CodexClient({
    executable: config.codexExecutable,
    codexHome: config.codexHome,
    cwd: config.cwd,
    startupTimeoutMs: 5_000,
    turnTimeoutMs: 5_000,
    spawn,
    onDiagnostic: (m) => console.log(`   [diag] ${m}`),
  })
  const started = Date.now()
  console.log(`\n=== ${scenario.name} ===`)
  try {
    const handshake = await client.start()
    console.log(`   handshake ok in ${Date.now() - started}ms; account=${JSON.stringify(handshake.account)}`)
    const thread = await client.startThread({
      model: 'gpt-6-astra', cwd: config.cwd, approvalPolicy: 'never', sandbox: 'read-only', ephemeral: true,
    })
    console.log(`   thread=${thread.id}`)
    const events = []
    const streaming = (async () => {
      for await (const event of client.runTurn({
        threadId: thread.id,
        input: [{ type: 'text', text: 'hello', text_elements: [] }],
      })) {
        events.push(event.kind + (event.kind === 'delta' ? `(${event.text})` : ''))
      }
    })()
    const timeout = new Promise((resolve) => setTimeout(() => resolve('TIMEOUT'), 6_000))
    const winner = await Promise.race([streaming.then(() => 'DONE'), timeout])
    console.log(`   result=${winner} in ${Date.now() - started}ms`)
    console.log(`   events: ${events.join(' ')}`)
    if (winner === 'TIMEOUT') console.log('   >>> HANG CONFIRMED <<<')
  } catch (error) {
    console.log(`   threw: ${error.message}`)
  } finally {
    client.close()
  }
}
process.exit(0)
