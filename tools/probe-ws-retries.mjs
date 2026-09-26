/**
 * Measure where the WebSocket prewarm time actually goes.
 *
 * The earlier attribution ("connect timeout x retry budget") explains the shape
 * but does not reduce to the measured 115.8 s: 15 s x 5 attempts is 75 s. This
 * probe timestamps every frame of a cold, WebSocket-enabled first turn so the
 * gaps between attempts are read off the wire instead of inferred.
 *
 * Usage: node tools/probe-ws-retries.mjs [seconds] [codexHome]
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const OBSERVE_MS = Number(process.argv[2] ?? 200) * 1000
const HOME = process.argv[3] ?? join(homedir(), '.dsh', 'codex-bench', 'bench-plain')
const PROMPT = 'What is 17 * 23? Answer with just the number.'

/** Locate codex.exe the way the plugin does. */
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

const EXE = findExecutable()
if (EXE === null) {
  console.log('FAIL: no codex.exe found')
  process.exit(1)
}

mkdirSync(HOME, { recursive: true })
if (!existsSync(join(HOME, 'auth.json'))) {
  copyFileSync(join(homedir(), '.codex', 'auth.json'), join(HOME, 'auth.json'))
}
// An empty config is the pre-fix state: no provider override, WebSockets allowed.
writeFileSync(join(HOME, 'config.toml'), '')

console.log(`home   : ${HOME}`)
console.log(`config : empty (WebSocket transport allowed)`)
console.log(`prompt : ${PROMPT}`)

const t0 = Date.now()
const at = (label) => console.log(`[+${String(Date.now() - t0).padStart(6)} ms] ${label}`)

const child = spawn(EXE, ['app-server', '--listen', 'stdio://'], {
  env: { ...process.env, CODEX_HOME: HOME },
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true,
})

/** Every frame, with the gap since the previous frame that matters. */
const frames = []
/** Notifications that describe transport trouble, if the build emits any. */
const TRANSPORT_HINTS = /reconnect|retry|websocket|fallback|timeout|http/i

let buffer = ''
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
      continue
    }
    const t = Date.now() - t0
    frames.push({ t, frame })
    const method = typeof frame.method === 'string' ? frame.method : `resp#${frame.id}`
    const error = frame.error === undefined ? '' : ` ERROR ${JSON.stringify(frame.error).slice(0, 140)}`
    if (TRANSPORT_HINTS.test(method) || error !== '') at(`stdout ${method}${error}`)
  }
})

let errBuffer = ''
child.stderr.on('data', (chunk) => {
  errBuffer += chunk.toString('utf8')
  let nl
  while ((nl = errBuffer.indexOf('\n')) >= 0) {
    const line = errBuffer.slice(0, nl)
    errBuffer = errBuffer.slice(nl + 1)
    if (line.trim() !== '') at(`STDERR ${line.slice(0, 240)}`)
  }
})

let nextId = 1
const request = (method, params) => {
  const id = nextId++
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  return id
}

/** Wait for the first frame matching a predicate. */
function waitFor(predicate, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const hit = frames.find((entry) => predicate(entry.frame))
      if (hit !== undefined) return resolve(hit)
      if (Date.now() > deadline) return reject(new Error('timeout'))
      setTimeout(tick, 25)
    }
    tick()
  })
}

setTimeout(() => request('initialize', { clientInfo: { name: 'ws-probe', title: 'WS Probe', version: '0.0.1' } }), 50)
setTimeout(() => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized' })}\n`), 2500)

setTimeout(async () => {
  const threadId = request('thread/start', { ephemeral: true })
  const started = await waitFor((f) => f.id === threadId, 60000)
  const id = started.frame.result?.thread?.id
  const sentAt = Date.now() - t0
  at(`>>> turn/start (thread ${id})`)
  request('turn/start', {
    threadId: id,
    input: [{ type: 'text', text: PROMPT, text_elements: [] }],
  })

  const deadline = Date.now() + OBSERVE_MS
  while (Date.now() < deadline) {
    if (frames.some((entry) => entry.frame.method === 'turn/completed')) break
    await new Promise((resolve) => setTimeout(resolve, 25))
  }

  console.log('\n=== every frame between turn/start and completion ===')
  let previous = sentAt
  for (const entry of frames.filter((f) => f.t >= sentAt)) {
    const gap = entry.t - previous
    previous = entry.t
    const method = typeof entry.frame.method === 'string' ? entry.frame.method : `resp#${entry.frame.id}`
    console.log(`  [+${String(entry.t - sentAt).padStart(6)} ms after turn/start] (+${String(gap).padStart(6)} ms) ${method}`)
  }

  const delta = frames.find((f) => f.frame.method === 'item/agentMessage/delta')
  const done = frames.find((f) => f.frame.method === 'turn/completed')
  console.log('\n=== summary ===')
  console.log(`  first token : ${delta === undefined ? 'n/a' : `${delta.t - sentAt} ms after turn/start`}`)
  console.log(`  completed   : ${done === undefined ? 'not within window' : `${done.t - sentAt} ms after turn/start`}`)
  const gaps = frames.filter((f) => f.t >= sentAt)
  let biggest = 0
  let biggestAt = 0
  let prev = sentAt
  for (const entry of gaps) {
    if (entry.t - prev > biggest) { biggest = entry.t - prev; biggestAt = entry.t - sentAt }
    prev = entry.t
  }
  console.log(`  largest silent gap : ${biggest} ms (ending at +${biggestAt} ms after turn/start)`)
  console.log('  interpretation: a large silent gap is one blocked attempt; several comparable')
  console.log('  gaps are the retry ladder. Zero gaps means one attempt consumed the whole wait.')

  child.kill()
  setTimeout(() => process.exit(0), 200)
}, 3500)
