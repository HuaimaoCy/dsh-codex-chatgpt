/**
 * Line-delimited JSON-RPC 2.0 transport for the Codex app-server.
 *
 * Owns framing, request/response correlation, server-initiated requests, and
 * notification fan-out. It deliberately knows nothing about Codex product
 * methods: `thread/*`, `turn/*`, and item events belong to `client.js`.
 *
 * Frames are newline-delimited JSON. A single `data` handler accumulates a
 * string buffer and drains complete lines, so a frame split across chunks is
 * reassembled before parsing — the app-server writes large `turn/completed`
 * payloads that routinely span chunk boundaries.
 */

/** One server-initiated request the app-server expects an answer to. */
export class ServerRequest {
  /**
   * @param {string} method - JSON-RPC method name.
   * @param {object} params - request params.
   * @param {(result: unknown) => void} respond - settle the request successfully.
   * @param {(error: unknown) => void} fail - settle the request with an error.
   */
  constructor(method, params, respond, fail) {
    this.method = method
    this.params = params
    this.respond = respond
    this.fail = fail
  }
}

/** Raised when the protocol stream ends or fails before a caller settled. */
export class TransportClosedError extends Error {
  /** @param {string} message - diagnostic text. */
  constructor(message) {
    super(message)
    this.name = 'TransportClosedError'
  }
}

export class LineTransport {
  /**
   * @param {import('node:stream').Readable} input - app-server stdout.
   * @param {import('node:stream').Writable} output - app-server stdin.
   * @param {{ onError?: (error: Error) => void }} [options] - diagnostics sink.
   */
  constructor(input, output, options = {}) {
    this.input = input
    this.output = output
    this.onError = options.onError
    /** @type {Map<number, {resolve: (v: unknown)=>void, reject: (e: Error)=>void, method: string}>} */
    this.pending = new Map()
    /** @type {Array<(request: ServerRequest) => void>} */
    this.requestHandlers = []
    /** @type {Array<(method: string, params: object) => void>} */
    this.notificationHandlers = []
    this.nextId = 1
    this.buffer = ''
    this.closed = false
    this.started = false
    this.onData = (chunk) => { this.#ingest(chunk) }
    this.onInputError = (error) => { this.#fail(error instanceof Error ? error : new Error(String(error))) }
    this.onInputEnd = () => { this.#fail(new TransportClosedError('codex app-server protocol stream closed')) }
    this.onOutputError = (error) => { this.#fail(error instanceof Error ? error : new Error(String(error))) }
  }

  /** Begin reading frames. Idempotent. */
  start() {
    if (this.started || this.closed) return
    this.started = true
    this.input.on('data', this.onData)
    this.input.on('error', this.onInputError)
    this.input.on('end', this.onInputEnd)
    this.output.on('error', this.onOutputError)
  }

  /**
   * Send one request and await its response.
   * @param {string} method - JSON-RPC method.
   * @param {object} params - request params.
   * @returns {Promise<unknown>} the `result` field.
   */
  request(method, params) {
    if (this.closed) {
      return Promise.reject(new TransportClosedError(`cannot send ${method}: transport is closed`))
    }
    const id = this.nextId++
    const promise = new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
    })
    this.#write({ jsonrpc: '2.0', id, method, params })
    return promise
  }

  /**
   * Send one notification (no response expected).
   * @param {string} method - JSON-RPC method.
   * @param {object} [params] - notification params.
   */
  notify(method, params) {
    if (this.closed) return
    const frame = params === undefined
      ? { jsonrpc: '2.0', method }
      : { jsonrpc: '2.0', method, params }
    this.#write(frame)
  }

  /**
   * Register a handler for server-initiated requests.
   * @param {(request: ServerRequest) => void} handler - receives each request.
   * @returns {() => void} unregister.
   */
  onRequest(handler) {
    this.requestHandlers.push(handler)
    return () => {
      const at = this.requestHandlers.indexOf(handler)
      if (at >= 0) this.requestHandlers.splice(at, 1)
    }
  }

  /**
   * Register a handler for server notifications.
   * @param {(method: string, params: object) => void} handler - receives each notification.
   * @returns {() => void} unregister.
   */
  onNotification(handler) {
    this.notificationHandlers.push(handler)
    return () => {
      const at = this.notificationHandlers.indexOf(handler)
      if (at >= 0) this.notificationHandlers.splice(at, 1)
    }
  }

  /** Detach listeners and reject every outstanding request. Idempotent. */
  close() {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.output.off('error', this.onOutputError)
    this.#rejectAll(new TransportClosedError('codex app-server transport closed'))
  }

  /**
   * @param {object} frame - JSON-RPC frame to serialize.
   */
  #write(frame) {
    try {
      this.output.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      this.#fail(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /**
   * @param {Buffer|string} chunk - raw stream bytes.
   */
  #ingest(chunk) {
    if (this.closed) return
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let at
    while ((at = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, at)
      this.buffer = this.buffer.slice(at + 1)
      if (line.trim().length === 0) continue
      let frame
      try {
        frame = JSON.parse(line)
      } catch {
        // A malformed frame is a protocol failure, not a recoverable event:
        // continuing would silently drop a notification a caller is awaiting.
        this.#fail(new Error('codex app-server sent a non-JSON frame'))
        return
      }
      this.#dispatch(frame)
      if (this.closed) return
    }
  }

  /**
   * @param {any} frame - one parsed JSON-RPC frame.
   */
  #dispatch(frame) {
    if (frame === null || typeof frame !== 'object') {
      this.#fail(new Error('codex app-server sent a non-object frame'))
      return
    }
    if (frame.id !== undefined && (frame.result !== undefined || frame.error !== undefined)) {
      const entry = this.pending.get(frame.id)
      if (entry === undefined) return
      this.pending.delete(frame.id)
      if (frame.error !== undefined) {
        entry.reject(new Error(`${entry.method} failed: ${describeError(frame.error)}`))
      } else {
        entry.resolve(frame.result)
      }
      return
    }
    const method = typeof frame.method === 'string' ? frame.method : undefined
    if (method === undefined) return
    const params = frame.params !== null && typeof frame.params === 'object' ? frame.params : {}
    if (frame.id !== undefined) {
      const request = new ServerRequest(
        method,
        params,
        (result) => { this.#write({ jsonrpc: '2.0', id: frame.id, result }) },
        (error) => { this.#write({ jsonrpc: '2.0', id: frame.id, error: { code: -32603, message: String(error) } }) },
      )
      for (const handler of [...this.requestHandlers]) handler(request)
      return
    }
    for (const handler of [...this.notificationHandlers]) handler(method, params)
  }

  /**
   * @param {Error} error - terminal transport failure.
   */
  #fail(error) {
    if (this.closed) return
    this.closed = true
    this.input.off('data', this.onData)
    this.input.off('error', this.onInputError)
    this.input.off('end', this.onInputEnd)
    this.output.off('error', this.onOutputError)
    this.#rejectAll(error)
    if (this.onError !== undefined) this.onError(error)
  }

  /**
   * @param {Error} error - rejection reason for every outstanding request.
   */
  #rejectAll(error) {
    const outstanding = [...this.pending.entries()]
    this.pending.clear()
    for (const [, entry] of outstanding) entry.reject(error)
  }
}

/**
 * Render an app-server error value as diagnostic text.
 * @param {unknown} error - the JSON-RPC `error` member.
 * @returns {string} a human-readable message.
 */
export function describeError(error) {
  if (typeof error === 'string') return error
  if (error !== null && typeof error === 'object' && typeof error.message === 'string') {
    return error.code === undefined ? error.message : `${error.message} (code ${error.code})`
  }
  return JSON.stringify(error)
}
