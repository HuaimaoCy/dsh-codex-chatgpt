/**
 * Experiment: can a `config.toml` provider entry turn the Responses WebSocket
 * transport off, and does that remove the ~115s first-turn stall?
 *
 * `ModelClient::responses_websocket_enabled()` requires
 * `provider.supports_websockets`, which is `true` for the built-in `openai`
 * provider. A user-defined provider entry cannot override `openai` (the merge
 * is `entry(key).or_insert(provider)`), so this uses a new key and points the
 * top-level `model_provider` at it.
 *
 * Usage: node tools/probe-nows.mjs <variant>
 *   variant: minimal  — name + base_url + wire_api + requires_openai_auth + supports_websockets=false
 *            noname   — same without `name`, to find out whether it is required
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const VARIANT = process.argv[2] ?? 'minimal'
const ROOT = join(homedir(), '.dsh', 'codex-bench')

/** Locate codex.exe the way the plugin does. */
function findExecutable() {
  const binRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
  if (!existsSync(binRoot)) return null
  for (const build of readdirSync(binRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse()) {
    const candidate = join(binRoot, build, 'codex.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const CONFIG_MINIMAL = `model_provider = "codex-http"

[model_providers.codex-http]
name = "OpenAI (HTTPS only)"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
`

const CONFIG_NONAME = `model_provider = "codex-http"

[model_providers.codex-http]
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
`

const home = join(ROOT, `nows-${VARIANT}`)
mkdirSync(home, { recursive: true })
if (!existsSync(join(home, 'auth.json'))) copyFileSync(join(homedir(), '.codex', 'auth.json'), join(home, 'auth.json'))
writeFileSync(join(home, 'config.toml'), VARIANT === 'noname' ? CONFIG_NONAME : CONFIG_MINIMAL, 'utf8')

const EXE = findExecutable()
console.log(`variant  : ${VARIANT}`)
console.log(`codexHome: ${home}`)
console.log(`exe      : ${EXE}`)
console.log(`--- config.toml ---`)
console.log(VARIANT === 'noname' ? CONFIG_NONAME : CONFIG_MINIMAL)

const t0 = Date.now()
const at = (label) => console.log(`[+${String(Date.now() - t0).padStart(6)} ms] ${label}`)
const child = spawn(EXE, ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: home },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})
at(`spawned pid=${child.pid}`)

let buffer = ''
const frames = []
child.stdout.on('data', (chunk) => {
  buffer += chunk.toString('utf8')
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl)
    buffer = buffer.slice(nl + 1)
    if (line.trim() === '') continue
    try {
      const frame = JSON.parse(line)
      frames.push({ t: Date.now() - t0, frame })
      const label = typeof frame.method === 'string' ? frame.method : `resp#${frame.id}`
      at(`stdout ${label}${frame.error !== undefined ? ' ERROR ' + JSON.stringify(frame.error).slice(0, 200) : ''}`)
    } catch {
      at(`stdout NON-JSON ${line.slice(0, 200)}`)
    }
  }
})
let errBuf = ''
child.stderr.on('data', (chunk) => {
  errBuf += chunk.toString('utf8')
  let nl
  while ((nl = errBuf.indexOf('\n')) >= 0) {
    const line = errBuf.slice(0, nl)
    errBuf = errBuf.slice(nl + 1)
    if (line.trim() !== '') at(`STDERR ${line.slice(0, 260)}`)
  }
})
child.on('exit', (code) => at(`EXIT code=${code}`))

let nextId = 1
const request = (method, params) => {
  const id = nextId++
  at(`>>> ${method}`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return id
}

/** Wait for a matching frame. */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const hit = frames.find((f) => predicate(f.frame))
      if (hit !== undefined) return resolve(hit)
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

setTimeout(() => request('initialize', { clientInfo: { name: 'probe', title: 'Probe', version: '0.0.1' } }), 50)
setTimeout(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`), 3000)
setTimeout(async () => {
  try {
    const id = request('thread/start', { ephemeral: true })
    const frame = await waitFor((f) => f.id === id, 60000)
    const threadId = frame.frame.result?.thread?.id
    if (threadId === undefined) {
      at(`!!! no thread id: ${JSON.stringify(frame.frame).slice(0, 300)}`)
      child.kill()
      return
    }
    const sentAt = Date.now() - t0
    request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'What is 17 * 23? Answer with just the number.', text_elements: [] }],
    })
    let firstDelta = null
    const deadline = Date.now() + 240000
    while (Date.now() < deadline) {
      const delta = frames.find((f) => f.frame.method === 'item/agentMessage/delta')
      if (delta !== undefined && firstDelta === null) firstDelta = delta.t
      const done = frames.find((f) => f.frame.method === 'turn/completed')
      if (done !== undefined) {
        at(`=== FIRST TOKEN at +${firstDelta === null ? 'n/a' : firstDelta - sentAt} ms after turn/start`)
        at(`=== TURN COMPLETED at +${done.t - sentAt} ms after turn/start`)
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
  } catch (error) {
    at(`!!! experiment failed: ${String(error)}`)
  }
  child.kill()
  setTimeout(() => process.exit(0), 300)
}, 4000)
