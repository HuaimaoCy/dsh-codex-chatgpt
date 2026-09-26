/**
 * Codex app-server client: child lifecycle, thread creation, and one turn.
 *
 * Two protocol facts drive the shape of this module, both established by
 * measurement against `codex-cli 0.155.0-alpha.16.4`:
 *
 * 1. A turn's first round trip takes ~115s while the app-server retries a
 *    WebSocket transport (`Reconnecting... 2/5` .. `5/5`) and falls back to
 *    HTTPS. Later turns on the *same thread* complete in ~3s. A new thread pays
 *    the cost again, even in a warm process. Callers must therefore reuse
 *    threads, and this module must never treat a slow turn as a hang.
 * 2. `turn/start`'s response and the `turn/started` notification race. Item
 *    notifications carrying the turn id can arrive before either. They are
 *    buffered until the id is committed, then replayed — mirroring the
 *    in-tree `subagent-codex` wire, which hit the same race.
 *
 * No generic request surface is exposed: every method here exists because the
 * adapter needs it, so an unsupported product call fails loudly rather than
 * silently issuing an untested request.
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { LineTransport } from './transport.js'

/** Turn statuses the app-server reports as terminal. */
const TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'failed'])

/**
 * Decide an unattended answer for a server request.
 *
 * This plugin runs as a headless model provider: there is no UI to surface an
 * approval prompt, and guessing "allow" would silently grant the Codex agent
 * file or command authority the user never gave. Every request is therefore
 * refused with the most conservative decision the server offered.
 *
 * @param {string} method - server request method.
 * @returns {object} the response payload.
 */
function unattendedResponse(method) {
  switch (method) {
    case 'item/commandExecution/requestApproval':
    case 'item/fileChange/requestApproval':
      return { decision: 'decline' }
    case 'item/permissions/requestApproval':
      return { permissions: {}, scope: 'turn' }
    case 'item/tool/requestUserInput':
      return { answers: {} }
    case 'mcpServer/elicitation/request':
      return { action: 'decline', content: null, _meta: null }
    default:
      return {}
  }
}

/**
 * Translate an app-server failure object into a stable machine code.
 * @param {object} turn - the terminal turn payload.
 * @returns {{ code: string, message: string, retryable: boolean }} failure facts.
 */
export function classifyTurnFailure(turn) {
  const error = turn?.error
  const message = typeof error?.message === 'string' && error.message.length > 0
    ? error.message
    : 'Codex turn failed'
  const info = error?.codexErrorInfo
  const key = typeof info === 'string' ? info : Object.keys(info ?? {})[0]
  switch (key) {
    case 'contextWindowExceeded':
      return { code: 'CODEX_CONTEXT_WINDOW_EXCEEDED', message, retryable: false }
    case 'sessionBudgetExceeded':
    case 'usageLimitExceeded':
      return { code: 'CODEX_USAGE_LIMIT', message, retryable: false }
    case 'serverOverloaded':
    case 'internalServerError':
      return { code: 'CODEX_SERVER_ERROR', message, retryable: true }
    case 'cyberPolicy':
    case 'misalignmentPolicyViolation':
    case 'unauthorized':
      return { code: 'CODEX_ACCESS_POLICY', message, retryable: false }
    case 'responseStreamDisconnected':
    case 'httpConnectionFailed':
    case 'responseStreamConnectionFailed':
    case 'responseTooManyFailedAttempts':
      return { code: 'CODEX_TRANSPORT', message, retryable: true }
    case 'sandboxError':
      return { code: 'CODEX_SANDBOX', message, retryable: false }
    default:
      return { code: 'CODEX_TURN_FAILED', message, retryable: true }
  }
}

/**
 * Raised when the app-server cannot be started or handshaken.
 */
export class CodexStartupError extends Error {
  /**
   * @param {string} message - diagnostic text.
   * @param {{ cause?: unknown }} [options] - optional underlying failure.
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'CodexStartupError'
  }
}

/**
 * Raised when the app-server connection is lost, so the caller can rebuild.
 */
export class CodexConnectionLostError extends Error {
  /**
   * @param {string} message - diagnostic text.
   * @param {{ cause?: unknown }} [options] - optional underlying failure.
   */
  constructor(message, options) {
    super(message, options)
    this.name = 'CodexConnectionLostError'
    this.code = 'CODEX_CONNECTION_LOST'
    this.retryable = true
  }
}

export class CodexClient {
  /**
   * @param {object} spec - launch and policy settings.
   * @param {string} spec.executable - absolute path to the Codex executable.
   * @param {string} spec.codexHome - private CODEX_HOME.
   * @param {string} spec.cwd - working directory for the child process.
   * @param {Record<string, string>} [spec.env] - extra environment entries.
   * @param {typeof nodeSpawn} [spec.spawn] - spawn implementation (injectable for tests).
   * @param {number} [spec.startupTimeoutMs] - handshake ceiling.
   * @param {number} [spec.turnTimeoutMs] - per-turn ceiling.
   * @param {(message: string) => void} [spec.onDiagnostic] - stderr/diagnostic sink.
   */
  constructor(spec) {
    this.spec = spec
    this.spawn = spec.spawn ?? nodeSpawn
    this.startupTimeoutMs = spec.startupTimeoutMs ?? 120_000
    this.turnTimeoutMs = spec.turnTimeoutMs ?? 900_000
    this.onDiagnostic = spec.onDiagnostic ?? (() => {})
    this.onLost = spec.onLost ?? (() => {})
    this.child = undefined
    this.transport = undefined
    this.closed = false
    this.pendingStderr = []
    // A transport death must fail the in-flight turn immediately. Waiting out
    // the turn timeout instead would leave the user staring at a stalled
    // request for the whole ceiling with no chance of recovery.
    this.fatal = Promise.withResolvers()
    this.fatal.promise.catch(() => {})
    this.terminated = false
  }

  /**
   * Terminate the connection: fail every waiter and notify the owner.
   *
   * Both a lost child and a deliberate `close()` go through here, because a
   * turn waiting on a terminal notification must be released in either case —
   * otherwise the caller sits until the turn ceiling expires.
   *
   * @param {Error} reason - why the connection ended.
   * @param {boolean} notifyOwner - whether the registry should rebuild.
   */
  #terminate(reason, notifyOwner) {
    if (this.terminated) return
    this.terminated = true
    this.fatal.reject(
      reason instanceof CodexConnectionLostError
        ? reason
        : new CodexConnectionLostError(reason.message, { cause: reason }),
    )
    this.fatal.promise.catch(() => {})
    if (notifyOwner) this.onLost(reason)
  }

  /**
   * Start the child, perform the handshake, and report account facts.
   * @returns {Promise<{ account: object|null, userAgent: string|null }>} handshake facts.
   */
  async start() {
    if (this.transport !== undefined) throw new CodexStartupError('codex client already started')
    let child
    try {
      child = this.spawn(this.spec.executable, ['app-server', '--listen', 'stdio://'], {
        cwd: this.spec.cwd,
        env: { ...process.env, CODEX_HOME: this.spec.codexHome, ...this.spec.env },
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      throw new CodexStartupError(
        `dsh-codex-chatgpt: cannot launch Codex at ${this.spec.executable}`,
        { cause: error },
      )
    }
    this.child = child
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text.length > 0) {
        this.pendingStderr.push(text)
        if (this.pendingStderr.length > 40) this.pendingStderr.shift()
      }
    })
    child.on('error', (error) => {
      this.onDiagnostic(`codex child process error: ${error.message}`)
      this.#terminate(
        error instanceof Error ? error : new Error(String(error)),
        !this.closed,
      )
    })
    child.on('exit', (code, signal) => {
      this.onDiagnostic(`codex child exited (code ${code}, signal ${signal})`)
      // A clean close is initiated by `close()`; anything else means the
      // provider lost its app-server and its cached threads with it.
      this.#terminate(
        new Error(`codex child exited (code ${code}, signal ${signal})`),
        !this.closed,
      )
    })

    this.transport = new LineTransport(child.stdout, child.stdin, {
      onError: (error) => {
        this.onDiagnostic(`codex protocol error: ${error.message}`)
        this.#terminate(error, !this.closed)
      },
    })
    this.transport.onRequest((request) => {
      request.respond(unattendedResponse(request.method))
    })
    this.transport.start()

    const initialized = await this.#withTimeout(
      this.transport.request('initialize', {
        clientInfo: { name: 'dsh-codex-chatgpt', title: 'DSH ChatGPT (Codex)', version: '0.1.0' },
        capabilities: { experimentalApi: false, requestAttestation: false },
      }),
      this.startupTimeoutMs,
      'initialize',
    )
    this.transport.notify('initialized')
    return {
      account: await this.#readAccount(),
      userAgent: typeof initialized?.userAgent === 'string' ? initialized.userAgent : null,
    }
  }

  /**
   * Read the signed-in account without failing startup when the call is
   * unsupported by an older app-server.
   * @returns {Promise<object|null>} account facts, or null.
   */
  async #readAccount() {
    try {
      const result = await this.#withTimeout(
        this.transport.request('account/read', {}),
        this.startupTimeoutMs,
        'account/read',
      )
      return result?.account ?? null
    } catch {
      return null
    }
  }

  /**
   * Create a thread and return its identity.
   * @param {object} options - thread settings.
   * @param {string|null} [options.model] - native model id.
   * @param {string|null} [options.baseInstructions] - system prompt override.
   * @param {string} [options.cwd] - workspace root.
   * @param {string} [options.approvalPolicy] - approval policy.
   * @param {string} [options.sandbox] - sandbox mode.
   * @param {string|null} [options.environmentId] - app-server environment id.
   * @param {boolean} [options.ephemeral] - keep the thread out of shared history.
   * @returns {Promise<{ id: string, model: string|null, ephemeral: boolean }>} the created thread.
   */
  async startThread(options) {
    /** @type {Record<string, unknown>} */
    const params = {
      cwd: options.cwd,
      approvalPolicy: options.approvalPolicy,
      sandbox: options.sandbox,
    }
    if (typeof options.model === 'string' && options.model.length > 0) params.model = options.model
    if (typeof options.baseInstructions === 'string' && options.baseInstructions.length > 0) {
      params.baseInstructions = options.baseInstructions
    }
    if (typeof options.environmentId === 'string' && options.environmentId.length > 0) {
      params.environmentId = options.environmentId
    }
    if (options.ephemeral === true) params.ephemeral = true
    const response = await this.#withTimeout(
      this.transport.request('thread/start', params),
      this.startupTimeoutMs,
      'thread/start',
    )
    const thread = response?.thread
    if (thread === null || typeof thread !== 'object' || typeof thread.id !== 'string') {
      throw new CodexStartupError('dsh-codex-chatgpt: app-server returned no thread id')
    }
    return {
      id: thread.id,
      model: typeof thread.model === 'string' ? thread.model : null,
      ephemeral: thread.ephemeral === true,
    }
  }

  /**
   * List the models the signed-in account may use.
   * @returns {Promise<Array<{ id: string, displayName: string, description: string, isDefault: boolean, hidden: boolean, defaultReasoningEffort: string|null, supportedReasoningEfforts: string[], modelContextWindow: number|null }>>}
   *   advertised models in app-server order.
   */
  async listModels() {
    const response = await this.#withTimeout(
      this.transport.request('model/list', {}),
      this.startupTimeoutMs,
      'model/list',
    )
    const rows = Array.isArray(response?.data) ? response.data : []
    return rows
      .filter((row) => row !== null && typeof row === 'object' && typeof row.id === 'string')
      .map((row) => ({
        id: row.id,
        displayName: typeof row.displayName === 'string' && row.displayName.length > 0 ? row.displayName : row.id,
        description: typeof row.description === 'string' ? row.description : '',
        isDefault: row.isDefault === true,
        hidden: row.hidden === true,
        defaultReasoningEffort: typeof row.defaultReasoningEffort === 'string' ? row.defaultReasoningEffort : null,
        supportedReasoningEfforts: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
            .map((effort) => (typeof effort === 'string' ? effort : effort?.reasoningEffort))
            .filter((effort) => typeof effort === 'string')
          : [],
        modelContextWindow: typeof row.modelContextWindow === 'number' ? row.modelContextWindow : null,
      }))
  }

  /**
   * Replay a thread's stored items.
   * @param {string} threadId - thread to read.
   * @returns {Promise<{ items: object[] }>} the thread's items.
   */
  async readThread(threadId) {
    const response = await this.#withTimeout(
      this.transport.request('thread/read', { threadId, includeTurns: true }),
      this.startupTimeoutMs,
      'thread/read',
    )
    const thread = response?.thread
    const turns = Array.isArray(thread?.turns) ? thread.turns : []
    const items = []
    for (const turn of turns) {
      if (Array.isArray(turn?.items)) items.push(...turn.items)
    }
    return { items }
  }

  /**
   * List stored threads from the shared history.
   * @param {{ limit?: number, query?: string, archived?: boolean }} [options] - filter options.
   * @returns {Promise<object[]>} thread summaries.
   */
  async listThreads(options = {}) {
    /** @type {Record<string, unknown>} */
    const params = {}
    if (typeof options.limit === 'number') params.limit = options.limit
    if (typeof options.query === 'string' && options.query.length > 0) params.query = options.query
    if (typeof options.archived === 'boolean') params.archived = options.archived
    const response = await this.#withTimeout(
      this.transport.request('thread/list', params),
      this.startupTimeoutMs,
      'thread/list',
    )
    if (Array.isArray(response?.data)) return response.data
    if (Array.isArray(response?.threads)) return response.threads
    return []
  }

  /**
   * Run one turn and yield its lifecycle as an async stream.
   *
   * Yields, in order: `started` once the turn id is committed, then `delta` for
   * each agent-message increment, then `usage` when the app-server reports
   * token counts, and exactly one `completed` or `failed`. A `signal` abort
   * issues `turn/interrupt` and closes the stream without a terminal event, so
   * the caller owns the aborted finish reason.
   *
   * @param {object} options - turn input.
   * @param {string} options.threadId - target thread.
   * @param {Array<object>} options.input - app-server `UserInput` entries.
   * @param {string|null} [options.model] - per-turn model override.
   * @param {string|null} [options.effort] - per-turn reasoning effort.
   * @param {AbortSignal} [options.signal] - cancellation.
   * @returns {AsyncGenerator<object>} the turn event stream.
   */
  async *runTurn(options) {
    const { threadId, input, signal } = options
    let turnId
    let started = false
    let settled = false
    /** @type {Array<{ method: string, params: object }>} */
    const deferred = []
    /** @type {object[]} */
    const queue = []
    let wake = () => {}
    let failure
    let finished = false
    const timeoutMs = this.turnTimeoutMs
    // An item that streamed deltas must not also be reported from its completed
    // payload, and an item that never streamed must be reported exactly once at
    // turn end — otherwise a caller would receive the answer twice.
    const deltaItems = new Set()
    const completedItems = new Map()

    const push = (event) => {
      queue.push(event)
      const w = wake
      wake = () => {}
      w()
    }

    /**
     * @param {string} method - notification method.
     * @param {object} params - notification params.
     */
    const handle = (method, params) => {
      const eventThread = typeof params.threadId === 'string' ? params.threadId : undefined
      if (eventThread !== undefined && eventThread !== threadId) return
      if (method === 'item/agentMessage/delta') {
        const itemId = typeof params.itemId === 'string' ? params.itemId : ''
        if (typeof params.delta === 'string' && params.delta.length > 0) {
          deltaItems.add(itemId)
          push({ kind: 'delta', text: params.delta })
        }
        return
      }
      if (method === 'thread/tokenUsage/updated') {
        const last = params.tokenUsage?.last
        if (last !== null && typeof last === 'object') push({ kind: 'usage', usage: last })
        return
      }
      if (method === 'turn/completed') {
        const turn = params.turn
        if (turn === null || typeof turn !== 'object') return
        if (!TERMINAL_STATUSES.has(turn.status)) return
        settled = true
        for (const [itemId, text] of completedItems) {
          if (!deltaItems.has(itemId)) push({ kind: 'delta', text })
        }
        completedItems.clear()
        if (turn.status === 'completed') {
          push({ kind: 'completed', turn })
        } else {
          push({ kind: 'failed', status: turn.status, failure: classifyTurnFailure(turn) })
        }
        return
      }
      if (method === 'turn/started') {
        const turn = params.turn
        if (turn !== null && typeof turn === 'object' && typeof turn.id === 'string' && turnId === undefined) {
          turnId = turn.id
        }
        return
      }
      if (method === 'error') {
        // `willRetry` errors are transport retries the app-server absorbs; only
        // a terminal error is reported, and the turn still decides the outcome.
        if (params.willRetry !== true && !settled) {
          push({ kind: 'notice', level: 'error', message: describeNotice(params) })
        }
        return
      }
      if (method === 'warning') {
        push({ kind: 'notice', level: 'warning', message: describeNotice(params) })
        return
      }
      if (method === 'item/completed') {
        const item = params.item
        if (item === null || typeof item !== 'object') return
        if (item.type !== 'agentMessage' || typeof item.text !== 'string' || item.text.length === 0) return
        const itemId = typeof item.id === 'string' ? item.id : ''
        if (deltaItems.has(itemId)) return
        // Held until turn end: a late delta for this item would make reporting
        // it now a duplicate, and the terminal payload still carries the text.
        completedItems.set(itemId, item.text)
      }
    }

    const unsubscribe = this.transport.onNotification((method, params) => {
      if (turnId === undefined && !settled && method !== 'turn/started') {
        // The turn id is not committed yet, so this frame cannot be attributed.
        // Buffer it; the commit path replays the buffer in arrival order.
        deferred.push({ method, params })
        return
      }
      handle(method, params)
    })

    // A terminated connection ends this turn at once instead of at the timeout.
    const terminateWatch = this.fatal.promise.then(
      () => {},
      (error) => {
        if (settled || finished) return
        finished = true
        failure = error instanceof Error ? error : new Error(String(error))
        const w = wake
        wake = () => {}
        w()
      },
    )

    const onAbort = () => {
      if (turnId !== undefined) {
        this.transport.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
      failure = new Error('dsh-codex-chatgpt: turn aborted')
      finished = true
      const w = wake
      wake = () => {}
      w()
    }
    if (signal !== undefined) {
      if (signal.aborted) {
        unsubscribe()
        return
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }

    const deadline = Date.now() + timeoutMs
    try {
      /** @type {Record<string, unknown>} */
      const params = { threadId, input }
      if (typeof options.model === 'string' && options.model.length > 0) params.model = options.model
      if (typeof options.effort === 'string' && options.effort.length > 0) params.effort = options.effort
      const response = await this.#withTimeout(
        this.transport.request('turn/start', params),
        this.startupTimeoutMs,
        'turn/start',
      )
      const turn = response?.turn
      if (turn === null || typeof turn !== 'object' || typeof turn.id !== 'string') {
        throw new Error('dsh-codex-chatgpt: app-server returned no turn id')
      }
      turnId = turn.id
      started = true
      const replay = deferred.splice(0)
      for (const entry of replay) handle(entry.method, entry.params)
      yield { kind: 'started', turnId }

      while (!finished && !settled) {
        while (queue.length > 0) {
          const event = queue.shift()
          yield event
          if (event.kind === 'completed' || event.kind === 'failed') {
            finished = true
            break
          }
        }
        if (finished || settled) break
        if (Date.now() > deadline) {
          failure = new Error(`dsh-codex-chatgpt: Codex turn exceeded ${timeoutMs}ms`)
          break
        }
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('turn wait timeout')), Math.max(1, deadline - Date.now()))
          wake = () => { clearTimeout(timer); resolve() }
          // A stream that already ended must not leave this promise pending.
          if (finished || settled) { clearTimeout(timer); resolve() }
        }).catch((error) => { failure = error })
      }
      if (failure !== undefined) throw failure
      if (settled && !finished) {
        while (queue.length > 0) yield queue.shift()
      }
    } catch (error) {
      if (signal?.aborted) return
      throw error
    } finally {
      unsubscribe()
      void terminateWatch
      // Keep the terminal rejection observed when this turn settled first.
      this.fatal.promise.catch(() => {})
      signal?.removeEventListener('abort', onAbort)
      if (started && !settled && signal?.aborted !== true) {
        this.transport?.request('turn/interrupt', { threadId, turnId }).catch(() => {})
      }
    }
  }

  /**
   * Render the most recent child stderr text for diagnostics.
   * @returns {string} the last stderr lines, or an empty string.
   */
  diagnostics() {
    return this.pendingStderr.join('\n')
  }

  /** Terminate the child and detach the transport. Idempotent. */
  close() {
    if (this.closed) return
    this.closed = true
    // Release any turn still waiting for a terminal notification, and keep the
    // rejection observed. The owner is not asked to rebuild: this is deliberate.
    this.#terminate(new Error('the Codex app-server was closed'), false)
    this.transport?.close()
    try {
      this.child?.stdin?.end()
    } catch {
      // A concurrently closed stdin does not change child ownership.
    }
    try {
      this.child?.kill()
    } catch {
      // The child may already have exited.
    }
  }

  /**
   * @template T
   * @param {Promise<T>} pending - operation to bound.
   * @param {number} ms - ceiling in milliseconds.
   * @param {string} label - operation name for the diagnostic.
   * @returns {Promise<T>} the operation result.
   */
  async #withTimeout(pending, ms, label) {
    let timer
    try {
      return await Promise.race([
        pending,
        new Promise((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error(`dsh-codex-chatgpt: ${label} did not settle within ${ms}ms`)),
            ms,
          )
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

/**
 * @param {object} params - an error or warning notification payload.
 * @returns {string} a one-line description.
 */
function describeNotice(params) {
  const error = params?.error
  if (error !== null && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : 'Codex reported an error'
    const code = error.codexErrorInfo
    const key = typeof code === 'string' ? code : Object.keys(code ?? {})[0]
    return key === undefined ? message : `${message} (${key})`
  }
  if (typeof params?.message === 'string') return params.message
  return 'Codex reported a problem'
}
