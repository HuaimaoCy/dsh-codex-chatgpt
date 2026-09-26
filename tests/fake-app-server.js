/**
 * A scriptable stand-in for `codex app-server`.
 *
 * Exists so the whole provider can be exercised without a Codex installation:
 * the plugin's own logic is what needs proving, and the real app-server costs
 * ~115s per thread and needs a signed-in account. The fake speaks the same
 * newline-delimited JSON-RPC framing and can be told to report specific models,
 * deltas, usage, and failures.
 *
 * It is injected through the adapter's `spawn` seam, which is why that seam
 * exists.
 */

import { EventEmitter } from 'node:events'

/**
 * @typedef {object} FakeOptions
 * @property {Array<object>} [models] - rows returned by `model/list`.
 * @property {string[]} [deltas] - agent-message increments emitted per turn.
 * @property {object} [usage] - token counts reported for each turn.
 * @property {'completed'|'failed'} [turnStatus] - terminal turn status.
 * @property {object} [turnError] - error payload for a failed turn.
 * @property {number} [turnDelayMs] - delay before the turn completes.
 * @property {boolean} [emitTurnStartedFirst] - send `turn/started` before the response.
 * @property {boolean} [noDelta] - send only `item/completed`, never a delta.
 * @property {boolean} [noTerminal] - never send `turn/completed`.
 * @property {object[]} [threads] - rows returned by `thread/list`.
 * @property {object[]} [items] - items returned by `thread/read`.
 * @property {object|null} [account] - account returned by `account/read`.
 * @property {object} [failOn] - method name to reject with `{ code, message }`.
 * @property {boolean} [silentInitialize] - never answer `initialize`.
 * @property {string[]} [stderr] - stderr text emitted at startup.
 */

class Readable extends EventEmitter {
  constructor() {
    super()
    this.readable = true
  }

  /** @param {...unknown} args - forwarded to `emit`. */
  push(...args) { this.emit('data', ...args) }

  /** Simulate the stream ending. */
  endStream() { this.emit('end') }
}

class Writable extends EventEmitter {
  /**
   * @param {(chunk: string) => void} sink - receives each written frame.
   */
  constructor(sink) {
    super()
    this.sink = sink
    this.writable = true
  }

  /**
   * @param {string|Buffer} chunk - frame text.
   * @returns {boolean} always true.
   */
  write(chunk) {
    this.sink(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    return true
  }

  /** No-op; the fake owns no file descriptor. */
  end() {}
}

/**
 * One fake app-server child.
 */
export class FakeAppServer extends EventEmitter {
  /**
   * @param {FakeOptions} [options] - scripted behaviour.
   */
  constructor(options = {}) {
    super()
    this.options = options
    this.stdout = new Readable()
    this.stderr = new Readable()
    this.killed = false
    this.stdinEnded = false
    /** @type {string[]} */
    this.received = []
    /** @type {Array<{ method: string, params: object }>} */
    this.requests = []
    this.turnCount = 0
    this.threadCount = 0
    this.closeCount = 0
    this.timers = new Set()
    this.buffer = ''
    this.pendingTurnId = 'turn-1'
    this.sessionId = 'thread-1'
    this.stdin = new Writable((chunk) => { this.#onWrite(chunk) })
    // The child object the adapter sees is this instance.
    this.stdin.on('error', () => {})
    this.stdout.on('error', () => {})
    this.stderr.on('error', () => {})
    if (Array.isArray(options.stderr)) {
      for (const line of options.stderr) this.stderr.push(`${line}\n`)
    }
  }

  /**
   * @param {number} ms - delay.
   * @returns {Promise<void>} resolves after the delay.
   */
  #sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.timers.delete(timer); resolve() }, ms)
      this.timers.add(timer)
    })
  }

  /**
   * @param {object} frame - JSON-RPC frame to emit.
   */
  #send(frame) {
    this.stdout.push(`${JSON.stringify(frame)}\n`)
  }

  /**
   * @param {number} id - request id.
   * @param {unknown} result - success payload.
   */
  #respond(id, result) {
    this.#send({ jsonrpc: '2.0', id, result })
  }

  /**
   * @param {number} id - request id.
   * @param {object} error - error payload.
   */
  #fail(id, error) {
    this.#send({ jsonrpc: '2.0', id, error })
  }

  /**
   * @param {string} method - notification method.
   * @param {object} params - notification params.
   */
  #notify(method, params) {
    this.#send({ jsonrpc: '2.0', method, params })
  }

  /**
   * @param {string} chunk - written frame text.
   */
  #onWrite(chunk) {
    this.buffer += chunk
    let at
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (line.trim().length === 0) continue
      this.received.push(line)
      /** @type {any} */
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        continue
      }
      this.#dispatch(frame)
    }
  }

  /**
   * @param {any} frame - one parsed client frame.
   */
  #dispatch(frame) {
    if (frame.method === undefined) return
    if (frame.id === undefined) return
    this.requests.push({ method: frame.method, params: frame.params ?? {} })
    const failing = this.options.failOn
    if (failing !== undefined && failing === frame.method) {
      this.#fail(frame.id, { code: -32000, message: `scripted failure in ${frame.method}` })
      return
    }
    switch (frame.method) {
      case 'initialize':
        if (this.options.silentInitialize === true) return
        this.#respond(frame.id, {
          userAgent: 'fake/0.0.0 (test)',
        })
        return
      case 'account/read':
        this.#respond(frame.id, {
          account: this.options.account ?? null,
          requiresOpenaiAuth: true,
        })
        return
      case 'model/list':
        this.#respond(frame.id, { data: this.options.models ?? defaultModels() })
        return
      case 'thread/list':
        this.#respond(frame.id, { data: this.options.threads ?? [] })
        return
      case 'thread/read':
        this.#respond(frame.id, {
          thread: { id: frame.params.threadId, turns: [{ items: this.options.items ?? [] }] },
        })
        return
      case 'thread/start': {
        this.threadCount += 1
        const id = `thread-${this.threadCount}`
        this.#respond(frame.id, {
          thread: {
            id,
            ephemeral: frame.params.ephemeral === true,
            model: frame.params.model ?? 'gpt-6-astra',
          },
        })
        this.#notify('thread/started', { thread: { id, ephemeral: frame.params.ephemeral === true } })
        return
      }
      case 'turn/start': {
        this.turnCount += 1
        // The owning thread is recorded per turn, not held as one shared field:
        // several sessions share one child process, and a notification tagged
        // with another session's thread id is dropped by the client, which then
        // waits out its whole turn timeout.
        const threadId = typeof frame.params.threadId === 'string' ? frame.params.threadId : ''
        const turnId = `turn-${this.turnCount}`
        if (this.options.emitTurnStartedFirst === true) {
          this.#notify('turn/started', {
            threadId,
            turn: { id: turnId, status: 'inProgress', items: [] },
          })
        }
        this.#respond(frame.id, {
          turn: { id: turnId, status: 'inProgress', items: [] },
        })
        void this.#runTurn(turnId, threadId)
        return
      }
      case 'turn/interrupt':
        this.#notify('turn/completed', {
          threadId: typeof frame.params.threadId === 'string' ? frame.params.threadId : '',
          turn: { id: frame.params.turnId, status: 'interrupted', items: [], error: null },
        })
        return
      default:
        this.#respond(frame.id, {})
    }
  }

  /**
   * Emit one scripted turn's notifications.
   * @param {string} turnId - the turn being simulated.
   * @param {string} threadId - the thread that owns this turn.
   */
  async #runTurn(turnId, threadId) {
    const options = this.options
    const delay = typeof options.turnDelayMs === 'number' ? options.turnDelayMs : 0
    if (delay > 0) await this.#sleep(delay)
    if (this.killed) return

    const deltas = options.deltas ?? ['hello']
    const text = deltas.join('')
    if (options.noDelta !== true) {
      for (const delta of deltas) {
        this.#notify('item/agentMessage/delta', {
          threadId,
          turnId,
          itemId: 'msg-1',
          delta,
        })
      }
    }
    if (options.noDelta === true) {
      this.#notify('item/completed', {
        threadId,
        turnId,
        item: { type: 'agentMessage', id: 'msg-1', text, phase: 'final_answer' },
      })
    }
    const usage = options.usage ?? {
      totalTokens: 100,
      inputTokens: 90,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 0,
      outputTokens: 10,
      reasoningOutputTokens: 0,
    }
    this.#notify('thread/tokenUsage/updated', {
      threadId,
      turnId,
      tokenUsage: { last: usage, total: usage, modelContextWindow: 258_400 },
    })
    if (options.noTerminal === true) return
    const status = options.turnStatus ?? 'completed'
    this.#notify('turn/completed', {
      threadId,
      turn: {
        id: turnId,
        status,
        items: [{ type: 'agentMessage', id: 'msg-1', text, phase: 'final_answer' }],
        error: status === 'failed'
          ? (options.turnError ?? { message: 'scripted failure', codexErrorInfo: 'serverOverloaded' })
          : null,
      },
    })
  }

  /**
   * Emit an arbitrary notification from a test.
   * @param {string} method - method name.
   * @param {object} params - params.
   */
  emitNotification(method, params) {
    this.#notify(method, params)
  }

  /** Simulate the protocol stream ending. */
  endProtocol() {
    this.stdout.endStream()
  }

  /**
   * Terminate the child.
   * @param {NodeJS.Signals} [signal] - reported signal.
   */
  kill(signal) {
    if (this.killed) return
    this.killed = true
    this.closeCount += 1
    for (const timer of this.timers) clearTimeout(timer)
    this.timers.clear()
    this.emit('exit', 0, signal ?? null)
  }
}

/**
 * @returns {Array<object>} a default model catalog.
 */
export function defaultModels() {
  return [
    {
      id: 'gpt-6-astra',
      displayName: 'GPT-6-Astra',
      description: 'default',
      isDefault: true,
      hidden: false,
      defaultReasoningEffort: 'low',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      modelContextWindow: 258_400,
    },
    {
      id: 'gpt-6-luna',
      displayName: 'GPT-6-Luna',
      description: 'general',
      isDefault: false,
      hidden: false,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium', 'high'],
      modelContextWindow: 258_400,
    },
    {
      id: 'gpt-5.5',
      displayName: 'GPT-5.5',
      description: 'legacy',
      isDefault: false,
      hidden: true,
      defaultReasoningEffort: 'medium',
      supportedReasoningEfforts: ['low', 'medium'],
      modelContextWindow: 128_000,
    },
  ]
}

/**
 * A `spawn` implementation that records every child it hands out.
 * @param {FakeOptions} [options] - scripted behaviour for each child.
 * @returns {((command: string, args: string[], config: object) => FakeAppServer) & { children: FakeAppServer[], calls: Array<object> }}
 *   the spawn seam.
 */
export function fakeSpawn(options = {}) {
  /** @type {FakeAppServer[]} */
  const children = []
  /** @type {Array<object>} */
  const calls = []
  /**
   * @param {string} command - executable.
   * @param {string[]} args - arguments.
   * @param {object} config - spawn options.
   * @returns {FakeAppServer} the new fake child.
   */
  const spawn = (command, args, config) => {
    calls.push({ command, args, config })
    const child = new FakeAppServer(options)
    children.push(child)
    return child
  }
  spawn.children = children
  spawn.calls = calls
  return spawn
}

/**
 * Collect every chunk from a chunk stream.
 * @param {AsyncIterable<object>} stream - the adapter's stream.
 * @returns {Promise<object[]>} the chunks in order.
 */
export async function collect(stream) {
  const chunks = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/**
 * @param {object[]} chunks - collected chunks.
 * @returns {string} the concatenated text deltas.
 */
export function textOf(chunks) {
  return chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
}

/**
 * @param {object[]} chunks - collected chunks.
 * @returns {object|undefined} the terminal finish chunk.
 */
export function finishOf(chunks) {
  return chunks.find((chunk) => chunk.type === 'finish')
}
