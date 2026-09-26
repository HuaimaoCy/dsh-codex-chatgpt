/**
 * Per-session Codex thread registry.
 *
 * Measured against `codex-cli 0.155.0-alpha.16.4`: the first turn of any thread
 * costs ~115s while the app-server retries a WebSocket transport; later turns on
 * that same thread cost ~3s. Reuse is therefore mandatory, and it is safe only
 * because the app-server's own thread state is used exclusively as a cache — DSH
 * remains the authoritative transcript, and `planTurn` proves the cached thread
 * is still a prefix of it before anything is appended.
 *
 * A failed turn invalidates the session's thread rather than leaving a possibly
 * desynchronized thread cached: the next call then rebuilds from the DSH
 * transcript, which is always correct even when it is slower.
 */

import { CodexClient } from './client.js'
import { deliveredRows, planTurn } from './plan.js'

/** Session threads kept alive with no use before being dropped. */
export const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000

/** Upper bound on cached session threads, protecting app-server memory. */
export const DEFAULT_MAX_THREADS = 16

/**
 * @typedef {object} ThreadRecord
 * @property {string} sessionKey - DSH session identity this thread serves.
 * @property {CodexClient} client - the app-server connection owning the thread.
 * @property {string} threadId - app-server thread id.
 * @property {string} model - native model id the thread was created with.
 * @property {string} system - thread instructions it was created with.
 * @property {Array<{ role: string, text: string }>} rows - messages already delivered.
 * @property {number} lastUsed - epoch milliseconds of the last successful turn.
 */

/**
 * Owns app-server clients and the per-session threads they hold.
 */
export class ThreadRegistry {
  /**
   * @param {object} spec - registry policy and client factory inputs.
   * @param {import('./config.js').ResolvedConfig} spec.config - resolved plugin configuration.
   * @param {(message: string) => void} [spec.onDiagnostic] - diagnostic sink.
   * @param {typeof import('node:child_process').spawn} [spec.spawn] - spawn implementation.
   * @param {number} [spec.idleTimeoutMs] - idle eviction window.
   * @param {number} [spec.maxThreads] - cached thread ceiling.
   * @param {() => number} [spec.now] - clock, injectable for tests.
   * @param {() => void} [spec.onPrepare] - re-verifies launch prerequisites on each cold start.
   */
  constructor(spec) {
    this.config = spec.config
    this.onDiagnostic = spec.onDiagnostic ?? (() => {})
    this.onPrepare = spec.onPrepare
    this.spawn = spec.spawn
    this.idleTimeoutMs = spec.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    this.maxThreads = spec.maxThreads ?? DEFAULT_MAX_THREADS
    this.now = spec.now ?? Date.now
    /** @type {Map<string, ThreadRecord>} */
    this.threads = new Map()
    /** @type {Promise<{ client: CodexClient, account: object|null }>|null} */
    this.starting = null
    /** @type {CodexClient|null} */
    this.client = null
    /** @type {{ account: object|null, userAgent: string|null }|null} */
    this.handshake = null
    this.closed = false
  }

  /**
   * Ensure a started app-server client exists.
   *
   * Startup is shared: concurrent first calls must not each spawn a child, and
   * a failed start must not be cached, or every later call would inherit the
   * failure.
   *
   * @returns {Promise<CodexClient>} the started client.
   */
  async ensureClient() {
    if (this.closed) throw new Error('dsh-codex-chatgpt: provider is unloading')
    if (this.client !== null) return this.client
    if (this.starting === null) {
      this.starting = (async () => {
        // Re-verify launch prerequisites on every cold start, so a problem that
        // cleared itself after load — a locked credential file, an executable
        // mid-update — does not need a plugin reload to recover.
        this.onPrepare?.()
        const client = new CodexClient({
          executable: this.config.codexExecutable,
          codexHome: this.config.codexHome,
          cwd: this.config.cwd,
          startupTimeoutMs: this.config.startupTimeoutMs,
          turnTimeoutMs: this.config.turnTimeoutMs,
          onDiagnostic: this.onDiagnostic,
          spawn: this.spawn,
          onLost: () => { this.invalidateClient(client) },
        })
        const handshake = await client.start()
        return { client, handshake, account: handshake.account }
      })()
    }
    try {
      const started = await this.starting
      this.client = started.client
      this.handshake = started.handshake
      const account = started.account
      this.onDiagnostic(account === null
        ? 'codex app-server started (no account reported)'
        : `codex app-server started (account: ${describeAccount(account)})`)
      return this.client
    } catch (error) {
      this.starting = null
      throw error
    }
  }

  /**
   * Discard a client whose connection died, along with every thread it held.
   *
   * Cached threads live in the app-server process, so a dead process takes them
   * with it. Without this the registry would keep handing out `threadId`s that
   * no longer exist, and every later call would fail until the plugin was
   * reloaded — a single `codex.exe` crash would retire the provider for the
   * lifetime of the host process.
   *
   * @param {CodexClient} client - the client that reported the loss.
   */
  invalidateClient(client) {
    if (this.client !== client) return
    this.client = null
    this.starting = null
    this.handshake = null
    this.threads.clear()
    this.onDiagnostic('codex app-server connection lost; the next call will start a new one')
  }

  /**
   * Read the account facts reported at handshake, for diagnostics surfaces.
   * @returns {{ account: object|null, userAgent: string|null }|null} handshake facts.
   */
  accountFacts() {
    return this.handshake
  }

  /**
   * Plan one request and run it, creating or extending a thread as needed.
   *
   * @param {string} sessionKey - DSH session identity.
   * @param {object} options - the `GenerateOptions` request.
   * @param {object} hooks - per-turn callbacks.
   * @param {(turnId: string) => void} hooks.onStart - the committed turn id.
   * @param {(text: string) => void} hooks.onDelta - one agent-message increment.
   * @param {(usage: object) => void} hooks.onUsage - token counts.
   * @param {() => boolean} hooks.isAborted - whether the caller cancelled.
   * @param {AbortSignal|undefined} hooks.signal - cancellation signal.
   * @returns {Promise<{ threadId: string, reused: boolean, deltaChars: number }>} turn facts.
   */
  async run(sessionKey, options, hooks) {
    this.evictIdle()
    const client = await this.ensureClient()
    const existing = this.threads.get(sessionKey) ?? null
    const memory = existing !== null && existing.client === client ? existing : null
    const plan = planTurn(options, memory)

    let record
    if (plan.reusable && plan.threadId !== null && memory !== null) {
      record = memory
      this.onDiagnostic(
        `reusing codex thread ${plan.threadId} for session ${sessionKey} (+${plan.reusedMessages} messages)`,
      )
    } else {
      const thread = await client.startThread({
        model: plan.model ?? null,
        baseInstructions: plan.system.length > 0 ? plan.system : this.config.baseInstructions,
        cwd: this.config.cwd,
        approvalPolicy: this.config.approvalPolicy,
        sandbox: this.config.sandbox,
        ephemeral: this.config.ephemeralThreads,
        environmentId: this.config.environmentId,
      })
      record = {
        sessionKey,
        client,
        threadId: thread.id,
        model: plan.model,
        system: plan.system,
        rows: [],
        lastUsed: this.now(),
      }
      this.threads.set(sessionKey, record)
      this.enforceLimit()
      this.onDiagnostic(`created codex thread ${thread.id} for session ${sessionKey}`)
    }

    let deltaChars = 0
    let usage
    let completed = false
    let failure
    try {
      const stream = client.runTurn({
        threadId: record.threadId,
        input: [{ type: 'text', text: plan.input, text_elements: [] }],
        model: plan.model.length > 0 ? plan.model : null,
        effort: effortOf(options, this.config),
        signal: hooks.signal,
      })
      for await (const event of stream) {
        switch (event.kind) {
          case 'started':
            hooks.onStart(event.turnId)
            break
          case 'delta':
            deltaChars += event.text.length
            hooks.onDelta(event.text)
            break
          case 'usage':
            usage = event.usage
            hooks.onUsage(event.usage)
            break
          case 'completed':
            completed = true
            break
          case 'failed':
            failure = event.failure
            if (usage === undefined) break
            break
          case 'notice':
            this.onDiagnostic(`codex ${event.level}: ${event.message}`)
            break
          default:
            break
        }
      }
    } catch (error) {
      // Drop the thread: the turn ended without a terminal notification, so its
      // server-side state cannot be assumed to match the DSH transcript.
      this.forget(sessionKey)
      throw error
    }

    if (failure !== undefined && !completed) {
      this.forget(sessionKey)
      const error = new Error(`dsh-codex-chatgpt: ${failure.message}`)
      error.code = failure.code
      error.retryable = failure.retryable
      throw error
    }
    if (!completed) {
      this.forget(sessionKey)
      throw new Error('dsh-codex-chatgpt: Codex turn ended without a terminal status')
    }

    // Only now is the thread's server-side state known to have reached the end
    // of this turn, so only now may the memory advance. The memory records the
    // rows the thread received as input, which excludes assistant messages: the
    // model's own output is never replayed to it as input.
    record.rows = deliveredRows(plan.rows)
    record.lastUsed = this.now()
    return { threadId: record.threadId, reused: plan.reusable, deltaChars }
  }

  /**
   * Drop one session's cached thread, leaving the client running.
   * @param {string} sessionKey - DSH session identity.
   */
  forget(sessionKey) {
    this.threads.delete(sessionKey)
  }

  /** Drop threads idle beyond the configured window. */
  evictIdle() {
    const cutoff = this.now() - this.idleTimeoutMs
    for (const [key, record] of [...this.threads]) {
      if (record.lastUsed < cutoff) {
        this.threads.delete(key)
        this.onDiagnostic(`evicted idle codex thread ${record.threadId} (session ${key})`)
      }
    }
  }

  /** Drop least-recently-used threads beyond the configured ceiling. */
  enforceLimit() {
    if (this.threads.size <= this.maxThreads) return
    const ordered = [...this.threads.entries()].sort((a, b) => a[1].lastUsed - b[1].lastUsed)
    while (ordered.length > this.maxThreads) {
      const [key, record] = ordered.shift()
      this.threads.delete(key)
      this.onDiagnostic(`evicted codex thread ${record.threadId} over the ${this.maxThreads}-thread limit (session ${key})`)
    }
  }

  /** Terminate the client and drop every thread. Idempotent. */
  close() {
    this.closed = true
    this.threads.clear()
    this.client?.close()
    this.client = null
    this.starting = null
  }
}

/**
 * The reasoning effort to request for one turn.
 * @param {object} options - the `GenerateOptions` request.
 * @param {import('./config.js').ResolvedConfig} config - resolved configuration.
 * @returns {string|null} an effort id, or null to inherit the thread's setting.
 */
export function effortOf(options, config) {
  const requested = typeof options.reasoningEffort === 'string' ? options.reasoningEffort.trim() : ''
  if (requested.length > 0) return requested
  return config.reasoningEffort.length > 0 ? config.reasoningEffort : null
}

/**
 * @param {object} account - account facts from `account/read`.
 * @returns {string} a non-secret description.
 */
export function describeAccount(account) {
  const type = typeof account.type === 'string' ? account.type : 'unknown'
  const plan = typeof account.planType === 'string' ? account.planType : undefined
  // The email is deliberately not reported: diagnostics and logs should not
  // carry an account identity that the user did not ask to surface.
  return plan === undefined ? type : `${type}/${plan}`
}
