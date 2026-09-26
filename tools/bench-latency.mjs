/**
 * Latency benchmark for the Codex app-server route.
 *
 * Measures the things a user actually feels, per turn:
 *   - time to first byte (first streamed token)
 *   - time to completion
 *   - reasoning-token volume (the usual cause of a slow turn)
 *   - how both change as a conversation grows, and across reasoning efforts
 *
 * Each scenario gets its own CODEX_HOME so runs cannot interfere with the
 * live plugin home or with each other.
 *
 * Usage: node tools/bench-latency.mjs <scenario> [outFile]
 *   scenarios: cold      — one thread, 3 turns, no effort override
 *              effort    — one thread per effort, 2 turns each
 *              models    — one thread per candidate model, 2 turns each
 */

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const SCENARIO = process.argv[2] ?? 'cold'
const OUT = process.argv[3] ?? join(process.cwd(), `bench-${SCENARIO}.jsonl`)
const ROOT = join(homedir(), '.dsh', 'codex-bench')
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

/**
 * One app-server session bound to its own CODEX_HOME.
 */
class Session {
  /** @param {string} name - scenario label used for the private home. */
  constructor(name, homeDir) {
    this.name = name
    this.home = homeDir ?? join(ROOT, name)
    this.frames = []
    this.stderr = []
    this.buffer = ''
    this.errBuffer = ''
    this.nextId = 1
    this.t0 = 0
  }

  /** Boot the private home and the process. */
  start() {
    mkdirSync(this.home, { recursive: true })
    if (!existsSync(join(this.home, 'auth.json'))) {
      copyFileSync(join(homedir(), '.codex', 'auth.json'), join(this.home, 'auth.json'))
    }
    if (!existsSync(join(this.home, 'config.toml'))) writeFileSync(join(this.home, 'config.toml'), '')
    this.t0 = Date.now()
    this.child = spawn(EXE, ['app-server', '--listen', 'stdio://'], {
      env: { ...process.env, CODEX_HOME: this.home },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.child.stdout.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      let nl
      while ((nl = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, nl)
        this.buffer = this.buffer.slice(nl + 1)
        if (line.trim() === '') continue
        try {
          this.frames.push({ t: Date.now() - this.t0, frame: JSON.parse(line) })
        } catch {
          /* ignore malformed */
        }
      }
    })
    this.child.stderr.on('data', (chunk) => {
      this.errBuffer += chunk.toString('utf8')
      let nl
      while ((nl = this.errBuffer.indexOf('\n')) >= 0) {
        const line = this.errBuffer.slice(0, nl)
        this.errBuffer = this.errBuffer.slice(nl + 1)
        if (line.trim() !== '') this.stderr.push({ t: Date.now() - this.t0, line: line.slice(0, 300) })
      }
    })
    this.child.on('error', (error) => this.stderr.push({ t: Date.now() - this.t0, line: `SPAWN ERROR ${error.message}` }))
  }

  /** Wait for a frame matching a predicate. @param {(f:object)=>boolean} predicate @param {number} timeoutMs */
  waitFor(predicate, timeoutMs = 240000, since = 0) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = () => {
        for (let i = since; i < this.frames.length; i++) {
          if (predicate(this.frames[i].frame)) return resolve(this.frames[i])
        }
        if (Date.now() > deadline) return reject(new Error(`timeout after ${timeoutMs}ms waiting for ${predicate}`))
        setTimeout(tick, 25)
      }
      tick()
    })
  }

  /** Send a request and return its id. */
  request(method, params) {
    const id = this.nextId++
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return id
  }

  /** Send a notification. */
  notify(method, params) {
    const frame = params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params }
    this.child.stdin.write(`${JSON.stringify(frame)}\n`)
  }

  /** Boot the protocol and return the model catalog. */
  async boot() {
    this.request('initialize', { clientInfo: { name: 'bench', title: 'Bench', version: '0.0.1' } })
    await this.waitFor((f) => f.id === 1, 60000)
    this.notify('initialized')
    const id = this.request('model/list', {})
    const frame = await this.waitFor((f) => f.id === id, 120000)
    return frame.frame.result?.data ?? frame.frame.result?.models ?? []
  }

  /** Open one thread. */
  async startThread(model, effort) {
    const params = { ephemeral: true }
    if (typeof model === 'string' && model.length > 0) params.model = model
    if (typeof effort === 'string' && effort.length > 0) params.effort = effort
    const id = this.request('thread/start', params)
    const frame = await this.waitFor((f) => f.id === id, 240000)
    if (frame.frame.error !== undefined) throw new Error(`thread/start: ${JSON.stringify(frame.frame.error)}`)
    return frame.frame.result.thread.id
  }

  /**
   * Run one turn and return its timing.
   * @param {string} threadId - target thread.
   * @param {string} text - prompt text.
   * @param {string} [effort] - per-turn reasoning effort.
   * @param {string} [model] - per-turn model override.
   */
  async turn(threadId, text, effort, model) {
    const since = this.frames.length
    const params = {
      threadId,
      input: [{ type: 'text', text, text_elements: [] }],
    }
    if (typeof effort === 'string' && effort.length > 0) params.effort = effort
    if (typeof model === 'string' && model.length > 0) params.model = model
    const sentAt = Date.now() - this.t0
    this.request('turn/start', params)

    let firstDelta = null
    let completed = null
    const deadline = Date.now() + 300000
    while (Date.now() < deadline) {
      for (let i = since; i < this.frames.length; i++) {
        const { t, frame } = this.frames[i]
        if (firstDelta === null && frame.method === 'item/agentMessage/delta') firstDelta = t
        if (completed === null && frame.method === 'turn/completed') completed = { t, frame }
      }
      if (completed !== null) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    if (completed === null) return { sentAt, failed: 'no turn/completed within 300s' }

    const usage = completed.frame.params?.usage ?? completed.frame.params?.turn?.usage ?? {}
    const reasoning = this.frames.slice(since).filter((f) => f.frame.method === 'item/reasoning/delta').length
    return {
      sentAt,
      firstDeltaMs: firstDelta === null ? null : firstDelta - sentAt,
      totalMs: completed.t - sentAt,
      status: completed.frame.params?.turn?.status ?? completed.frame.params?.status ?? 'unknown',
      inputTokens: usage.inputTokens ?? usage.input_tokens ?? null,
      outputTokens: usage.outputTokens ?? usage.output_tokens ?? null,
      reasoningTokens: usage.reasoningOutputTokens ?? usage.reasoning_output_tokens ?? null,
      cachedTokens: usage.cachedInputTokens ?? usage.cached_input_tokens ?? null,
      reasoningDeltas: reasoning,
    }
  }

  /** Kill the process. */
  stop() {
    try { this.child.kill() } catch { /* already gone */ }
  }
}

/** Append one JSON result line. */
function record(entry) {
  appendFileSync(OUT, `${JSON.stringify(entry)}\n`, 'utf8')
  console.log(JSON.stringify(entry))
}

const scenario = SCENARIO
console.log(`scenario : ${scenario}`)
console.log(`out      : ${OUT}`)
console.log(`exe      : ${EXE}`)

if (scenario === 'cold') {
  const homeDir = process.argv[4]
  const session = new Session('cold', homeDir)
  session.start()
  const models = await session.boot()
  console.log(`boot ok, ${models.length} models, first frame at +${session.frames[0]?.t}ms`)
  record({ scenario, phase: 'boot', models: models.map((m) => m.id ?? m.model), firstFrameMs: session.frames[0]?.t })
  const threadId = await session.startThread(null, null)
  for (let i = 1; i <= 3; i++) {
    record({ scenario, phase: 'turn', turn: i, ...(await session.turn(threadId, PROMPT)) })
  }
  // A second thread in the *same* process tells us whether the cold cost is
  // per-process or per-thread, which decides where a prewarm belongs.
  const secondThread = await session.startThread(null, null)
  record({ scenario, phase: 'turn', turn: 'threadB-1', ...(await session.turn(secondThread, PROMPT)) })
  record({ scenario, phase: 'stderr', lines: session.stderr.slice(0, 40) })
  session.stop()
  process.exit(0)
}

if (scenario === 'effort') {
  const session = new Session('effort')
  session.start()
  const models = await session.boot()
  const efforts = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max']
  for (const effort of efforts) {
    try {
      const threadId = await session.startThread('gpt-6-astra', effort)
      const first = await session.turn(threadId, PROMPT, effort)
      record({ scenario, phase: 'effort-first', effort, model: 'gpt-6-astra', ...first })
      const second = await session.turn(threadId, 'And 17 * 24?', effort)
      record({ scenario, phase: 'effort-second', effort, model: 'gpt-6-astra', ...second })
    } catch (error) {
      record({ scenario, phase: 'effort-error', effort, error: String(error) })
    }
  }
  record({ scenario, phase: 'stderr', lines: session.stderr.slice(0, 60) })
  session.stop()
  process.exit(0)
}

if (scenario === 'models') {
  const session = new Session('models')
  session.start()
  const catalog = await session.boot()
  const ids = catalog.map((m) => m.id ?? m.model).filter(Boolean)
  record({ scenario, phase: 'catalog', ids })
  for (const model of ids) {
    try {
      const threadId = await session.startThread(model, null)
      const first = await session.turn(threadId, PROMPT, null, model)
      record({ scenario, phase: 'model-first', model, ...first })
    } catch (error) {
      record({ scenario, phase: 'model-error', model, error: String(error) })
    }
  }
  session.stop()
  process.exit(0)
}

if (scenario === 'baseline' || scenario === 'nows') {
  const homeDir = join(ROOT, scenario)
  const session = new Session(scenario, homeDir)
  session.start()
  const models = await session.boot()
  console.log(`boot ok, ${models.length} models, first frame at +${session.frames[0]?.t}ms`)
  record({ scenario, phase: 'boot', home: homeDir, models: models.map((m) => m.id ?? m.model), firstFrameMs: session.frames[0]?.t })
  const threadId = await session.startThread(null, null)
  for (let i = 1; i <= 3; i++) {
    record({ scenario, phase: 'turn', turn: i, ...(await session.turn(threadId, PROMPT)) })
  }
  // A second thread in the *same* process tells us whether the cold cost is
  // per-process or per-thread, which decides where a prewarm belongs.
  const secondThread = await session.startThread(null, null)
  record({ scenario, phase: 'turn', turn: 'threadB-1', ...(await session.turn(secondThread, PROMPT)) })
  record({ scenario, phase: 'stderr', lines: session.stderr.slice(0, 40) })
  session.stop()
  process.exit(0)
}

console.log(`unknown scenario: ${scenario}`)
process.exit(2)
