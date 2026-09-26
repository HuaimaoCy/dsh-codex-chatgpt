/**
 * Cold-start forensics probe.
 *
 * Spawns the real `codex.exe app-server --listen stdio://` against a private
 * CODEX_HOME and timestamps every stdout frame and every stderr line, so the
 * 100+ second cold start can be attributed to a specific phase instead of
 * guessed at.
 *
 * Usage: node tools/probe-timing.mjs [seconds-to-observe]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const OBSERVE_MS = Number(process.argv[2] ?? 200) * 1000
const HOME = process.argv[3] ?? join(homedir(), '.dsh', 'codex-chatgpt')

/** Locate the binary exactly the way the plugin does. */
function findExecutable() {
  const binRoot = join(process.env.LOCALAPPDATA ?? '', 'OpenAI', 'Codex', 'bin')
  if (!existsSync(binRoot)) return null
  const builds = readdirSync(binRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse()
  for (const build of builds) {
    const candidate = join(binRoot, build, 'codex.exe')
    if (existsSync(candidate)) return candidate
  }
  return null
}

const exe = findExecutable()
if (exe === null) {
  console.log('FAIL: no codex.exe found')
  process.exit(1)
}
console.log(`exe      : ${exe}`)

mkdirSync(HOME, { recursive: true })
if (!existsSync(join(HOME, 'auth.json'))) {
  copyFileSync(join(homedir(), '.codex', 'auth.json'), join(HOME, 'auth.json'))
}
if (!existsSync(join(HOME, 'config.toml'))) writeFileSync(join(HOME, 'config.toml'), '')
console.log(`codexHome: ${HOME}`)

const t0 = Date.now()
/** @param {string} label - phase label. */
const at = (label) => console.log(`[+${String(Date.now() - t0).padStart(6)} ms] ${label}`)

const child = spawn(exe, ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: HOME },
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
    let frame
    try {
      frame = JSON.parse(line)
    } catch {
      at(`stdout NON-JSON: ${line.slice(0, 160)}`)
      continue
    }
    frames.push({ t: Date.now() - t0, frame })
    const method = typeof frame.method === 'string' ? frame.method : `resp#${frame.id}`
    const size = line.length
    at(`stdout ${method} (${size}B)${frame.error !== undefined ? ' ERROR ' + JSON.stringify(frame.error).slice(0, 120) : ''}`)
  }
})

let errBuffer = ''
child.stderr.on('data', (chunk) => {
  errBuffer += chunk.toString('utf8')
  let nl
  while ((nl = errBuffer.indexOf('\n')) >= 0) {
    const line = errBuffer.slice(0, nl)
    errBuffer = errBuffer.slice(nl + 1)
    if (line.trim() === '') continue
    at(`STDERR ${line.slice(0, 240)}`)
  }
})

child.on('exit', (code, signal) => at(`EXIT code=${code} signal=${signal}`))

/** Send one request. */
let nextId = 1
function send(method, params) {
  const id = nextId++
  at(`>>> ${method} (id=${id})`)
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return id
}
/** Send one notification. */
function notify(method, params) {
  at(`>>> ${method} (notification)`)
  const frame = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
  child.stdin.write(`${JSON.stringify(frame)}\n`)
}

setTimeout(() => { send('initialize', { clientInfo: { name: 'timing-probe', title: 'Timing Probe', version: '0.0.1' } }) }, 50)
setTimeout(() => { notify('initialized') }, 4000)
setTimeout(() => { send('model/list', {}) }, 5000)
setTimeout(() => { send('thread/start', { model: null, ephemeral: true }) }, 6000)
setTimeout(() => {
  const threadFrame = [...frames].reverse().find((f) => f.frame.id !== undefined && f.frame.result?.thread !== undefined)
  if (threadFrame === undefined) {
    at('!!! no thread/start result yet; cannot send a turn')
    return
  }
  send('turn/start', {
    threadId: threadFrame.frame.result.thread.id,
    input: [{ type: 'text', text: 'Reply with exactly the word PONG and nothing else.', text_elements: [] }],
  })
}, 8000)

setTimeout(() => {
  at('=== SUMMARY ===')
  const interesting = frames.filter((f) => typeof f.frame.method === 'string')
  const counts = new Map()
  for (const f of interesting) counts.set(f.frame.method, (counts.get(f.frame.method) ?? 0) + 1)
  for (const [method, count] of [...counts].sort((a, b) => b[1] - a[1])) console.log(`  ${count.toString().padStart(4)}x ${method}`)
  const firstTurnCompleted = frames.find((f) => f.frame.method === 'turn/completed')
  if (firstTurnCompleted !== undefined) console.log(`  FIRST turn/completed at +${firstTurnCompleted.t} ms`)
  const firstDelta = frames.find((f) => f.frame.method === 'item/agentMessage/delta')
  if (firstDelta !== undefined) console.log(`  FIRST agentMessage/delta at +${firstDelta.t} ms`)
  const firstNotification = frames.find((f) => typeof f.frame.method === 'string')
  if (firstNotification !== undefined) console.log(`  FIRST notification at +${firstNotification.t} ms`)
  child.kill()
  process.exit(0)
}, OBSERVE_MS)

at(`observing for ${OBSERVE_MS / 1000}s`)
