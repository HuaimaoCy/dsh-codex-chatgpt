/**
 * The Codex ChatGPT LLM adapter.
 *
 * Presents the ChatGPT models served by the local Codex app-server as a
 * first-class DSH provider route, so they can be selected as a session's model
 * or dispatched to a subagent by name.
 *
 * Three deliberate limits are encoded here rather than left implicit:
 *
 * - **Tools are not forwarded.** Codex runs its own agent loop with its own
 *   tool set inside the app-server; DSH's schemas would describe functions this
 *   transport never invokes. The adapter declares no tools and reports how many
 *   were withheld, so the limitation is visible in diagnostics instead of
 *   surfacing as a model that mysteriously ignores tool calls.
 * - **Reasoning is not streamed.** Measurement across seven models produced no
 *   `item/reasoning/*` notifications on the app-server protocol, so no
 *   `reasoning-delta` chunk is emitted. Emitting an empty reasoning block would
 *   fabricate content the provider never sent.
 * - **The block-end text is assembled locally.** The app-server streams deltas
 *   and a final item, but the harness contract requires every `block-start` to
 *   be closed by a `block-end` carrying the assembled block, so the text is
 *   accumulated as it is forwarded.
 */

import { createHash } from 'node:crypto'
import { describeAccount, effortOf, ThreadRegistry } from './threads.js'
import { withheldToolCount } from './plan.js'

/**
 * Models known to be served by a ChatGPT-plan Codex installation.
 *
 * Seeds the model picker before the app-server has been interrogated — the
 * picker must never be empty on a cold start, because `listModels` is called
 * while the user is choosing, when a ~115s thread warm-up is far too slow to
 * block on. A successful interrogation replaces this list.
 */
export const FALLBACK_MODELS = [
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Default Codex model on a ChatGPT plan.' },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Codex code-reasoning model.' },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Codex general model.' },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Previous-generation Codex model.' },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Previous-generation Codex model.' },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Previous-generation Codex model.' },
  { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Previous-generation Codex model.' },
]

/** Context capacity assumed before the app-server reports one. */
export const DEFAULT_CONTEXT_WINDOW = 258_400

/** Reasoning efforts the app-server accepts for these models. */
export const REASONING_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra', 'max']

/** How long a discovered model catalog stays fresh. */
const CATALOG_TTL_MS = 10 * 60 * 1000

/**
 * How long `resolveModel` waits for an in-flight catalog refresh.
 *
 * Bounded, because the wait may include the app-server handshake: an unbounded
 * wait would stall a settings surface behind a cold start, while no wait at all
 * would publish an unverified reasoning-effort list for the first model the
 * user opens.
 */
const CATALOG_RESOLVE_WAIT_MS = 3_000

/**
 * A single-consumer queue that bridges callback-driven turn events to a
 * generator.
 *
 * The turn is driven by `ThreadRegistry.run`, which delivers deltas through
 * callbacks; an async generator cannot yield from inside those callbacks. This
 * queue lets `stream()` await each event as it arrives, so text reaches the
 * harness while the turn is still running rather than in one burst at the end.
 */
class ChunkChannel {
  constructor() {
    /** @type {object[]} */
    this.items = []
    /** @type {(() => void)|null} */
    this.waiter = null
    this.closed = false
    /** @type {Error|null} */
    this.error = null
  }

  /**
   * @param {object} item - chunk to enqueue.
   */
  push(item) {
    if (this.closed) return
    this.items.push(item)
    this.#wake()
  }

  /**
   * @param {Error} error - terminal failure.
   */
  fail(error) {
    this.error = error
    this.closed = true
    this.#wake()
  }

  /** Mark the stream complete. */
  end() {
    this.closed = true
    this.#wake()
  }

  #wake() {
    const waiter = this.waiter
    this.waiter = null
    if (waiter !== null) waiter()
  }

  /**
   * @returns {Promise<{ done: boolean, value?: object }>} the next item.
   */
  async next() {
    for (;;) {
      if (this.items.length > 0) return { done: false, value: this.items.shift() }
      if (this.error !== null) throw this.error
      if (this.closed) return { done: true }
      await new Promise((resolve) => { this.waiter = resolve })
    }
  }
}

/**
 * The adapter behaviour, independent of which base class it is mixed into.
 *
 * Expressed as a plain function with a prototype rather than a `class`: the
 * concrete class is assembled with a real `extends` clause, and a class
 * constructor cannot be invoked from inside another constructor's `super()`
 * chain without `new`. Field initialization lives on `init`.
 */
function CodexChatGptAdapterMethods() {
  // Fields are installed by `init`, which the concrete constructor calls.
}

/**
 * @param {object} spec - adapter inputs.
 * @param {object} spec.config - resolved plugin configuration.
 * @param {(message: string) => void} [spec.onDiagnostic] - diagnostic sink.
 * @param {typeof import('node:child_process').spawn} [spec.spawn] - spawn implementation.
 * @param {number} [spec.idleTimeoutMs] - idle thread eviction window.
 * @param {number} [spec.maxThreads] - cached thread ceiling.
 * @param {() => void} [spec.onDemandPrepare] - re-verifies launch prerequisites per cold start.
 */
CodexChatGptAdapterMethods.prototype.init = function init(spec) {
  this.config = spec.config
  this.diagnostic = spec.onDiagnostic ?? (() => {})
  this.registry = new ThreadRegistry({
    config: spec.config,
    onDiagnostic: this.diagnostic,
    spawn: spec.spawn,
    idleTimeoutMs: spec.idleTimeoutMs,
    maxThreads: spec.maxThreads,
    onPrepare: spec.onDemandPrepare,
  })
  /** @type {Array<object>|null} */
  this.catalog = null
  /** @type {Promise<void>|null} */
  this.refreshing = null
  this.catalogReadAt = 0
}


/**
 * @param {string} provider - the registered route.
 * @returns {{ id: string, name: string }} display metadata.
 */
CodexChatGptAdapterMethods.prototype.providerInfo = function providerInfo(provider) {
  return { id: provider, name: this.config.providerName }
}

/**
 * Retry policy for this route.
 *
 * A retried turn re-enters the app-server after a failure that invalidated its
 * thread, so it would pay the full ~115s warm-up again; reconnection is left to
 * the provider surface instead of adding a harness-level retry on top.
 *
 * @returns {undefined} always, meaning "use the harness defaults".
 */
CodexChatGptAdapterMethods.prototype.providerRetryPolicy = function providerRetryPolicy() {
  return undefined
}

/**
 * Advertised models, refreshed in the background.
 *
 * Never awaits the app-server: this is called while a model picker renders, and
 * the first handshake can take minutes.
 *
 * @param {string} provider - the registered route.
 * @returns {Promise<Array<object>>} catalog rows.
 */
CodexChatGptAdapterMethods.prototype.listModels = async function listModels(provider) {
  this.refreshCatalogInBackground()
  return catalogRows(this).map((row) => ({
    provider,
    id: row.id,
    name: row.name,
    description: row.description,
    inputModalities: ['text'],
  }))
}

/**
 * Metadata for one exact model.
 * @param {string} provider - the registered route.
 * @param {string} model - model id.
 * @returns {Promise<object>} resolved model metadata.
 */
CodexChatGptAdapterMethods.prototype.resolveModel = async function resolveModel(provider, model) {
  this.refreshCatalogInBackground()
  // Opening one model is a deliberate user action, so a brief bounded wait for
  // the real catalog is affordable; replying from the built-in list would
  // advertise reasoning efforts this exact model may not support.
  if (this.catalog === null && this.refreshing !== null) {
    await Promise.race([
      this.refreshing.catch(() => {}),
      new Promise((resolve) => { setTimeout(resolve, CATALOG_RESOLVE_WAIT_MS).unref?.() }),
    ])
  }
  const row = catalogRows(this).find((entry) => entry.id === model)
  const efforts = row !== undefined && Array.isArray(row.efforts) && row.efforts.length > 0
    ? row.efforts
    : REASONING_EFFORTS
  const defaultEffort = row?.defaultEffort ?? undefined
  return {
    provider,
    id: model,
    name: row?.name ?? model,
    ...(row?.description === undefined || row.description.length === 0
      ? {}
      : { description: row.description }),
    inputModalities: ['text'],
    context: { contextWindow: row?.contextWindow ?? DEFAULT_CONTEXT_WINDOW },
    reasoning: {
      efforts: efforts.map((effort) => ({
        id: effort,
        name: effort,
        description: `Codex reasoning effort: ${effort}`,
      })),
      ...(defaultEffort === undefined || !efforts.includes(defaultEffort) ? {} : { defaultEffort }),
    },
  }
}

/**
 * Stream one model call as DSH chunks, in protocol order.
 *
 * @param {object} options - the assembled request.
 * @returns {AsyncGenerator<object>} chunk stream.
 */
CodexChatGptAdapterMethods.prototype.stream = async function* stream(options) {
  if (options.signal?.aborted === true) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: abortedFailure() } }
    return
  }

  const withheld = withheldToolCount(options)
  if (withheld > 0) {
    this.diagnostic(
      `withholding ${withheld} DSH tool schema(s): this route delegates tool use to the Codex agent`,
    )
  }

  const channel = new ChunkChannel()
  let assembled = ''
  let usage
  let textOpen = false

  const turn = this.registry.run(sessionKeyOf(options), options, {
    onStart: () => {
      textOpen = true
      channel.push({ type: 'block-start', index: 0, blockType: 'text' })
    },
    onDelta: (text) => {
      assembled += text
      channel.push({ type: 'text-delta', index: 0, text })
    },
    onUsage: (counts) => { usage = mapUsage(counts) },
    isAborted: () => options.signal?.aborted === true,
    signal: options.signal,
  }).then(
    () => { channel.end() },
    (error) => { channel.fail(error instanceof Error ? error : new Error(String(error))) },
  )

  /** @type {Error|null} */
  let failure = null
  try {
    for (;;) {
      const next = await channel.next()
      if (next.done) break
      yield next.value
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error))
  }
  await turn

  if (options.signal?.aborted === true) {
    yield { type: 'finish', reason: { kind: 'aborted', failure: abortedFailure() } }
    return
  }
  if (failure !== null) {
    this.diagnostic(`codex turn failed: ${failure.message}`)
    yield {
      type: 'finish',
      reason: {
        kind: 'error',
        failure: {
          message: failure.message,
          code: typeof failure.code === 'string' ? failure.code : 'CODEX_TURN_FAILED',
        },
      },
    }
    return
  }
  if (usage !== undefined) yield { type: 'usage', usage }
  if (textOpen) {
    yield { type: 'block-end', index: 0, block: { type: 'text', text: assembled } }
  }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

/** Release the app-server child and every cached thread. */
CodexChatGptAdapterMethods.prototype.dispose = function dispose() {
  this.registry.close()
}

/**
 * Interview the app-server for its model list, at most once per TTL, without
 * blocking any caller on it.
 */
CodexChatGptAdapterMethods.prototype.refreshCatalogInBackground = function refreshCatalogInBackground() {
  if (this.refreshing !== null) return
  if (this.catalog !== null && Date.now() - this.catalogReadAt < CATALOG_TTL_MS) return
  this.refreshing = (async () => {
    try {
      const client = await this.registry.ensureClient()
      const models = await client.listModels()
      const visible = models.filter((model) => !model.hidden)
      if (visible.length === 0) return
      this.catalog = visible.map((model) => ({
        id: model.id,
        name: model.displayName,
        description: model.description,
        contextWindow: model.modelContextWindow ?? DEFAULT_CONTEXT_WINDOW,
        efforts: model.supportedReasoningEfforts.length > 0
          ? model.supportedReasoningEfforts
          : REASONING_EFFORTS,
        defaultEffort: model.defaultReasoningEffort,
      }))
      this.catalogReadAt = Date.now()
      const account = this.registry.accountFacts()?.account ?? null
      this.diagnostic(
        `model catalog refreshed: ${this.catalog.map((entry) => entry.id).join(', ')}`
        + (account === null ? '' : ` (account ${describeAccount(account)})`),
      )
    } catch (error) {
      this.diagnostic(
        `model discovery failed, continuing with the built-in list: ${error instanceof Error ? error.message : String(error)}`,
      )
    } finally {
      this.refreshing = null
    }
  })()
}

/**
 * @param {object} self - the adapter instance.
 * @returns {Array<object>} catalog rows, discovered or built in.
 */
function catalogRows(self) {
  return self.catalog ?? FALLBACK_MODELS.map((model) => ({
    id: model.id,
    name: model.name,
    description: model.description,
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    efforts: REASONING_EFFORTS,
    defaultEffort: null,
  }))
}

/**
 * Assemble the adapter class over a resolved harness base.
 *
 * A real `extends` clause is required rather than a post-construction prototype
 * swap: the harness registers the instance and calls `stream`, so the concrete
 * class must own a prototype chain in which these methods win over the base.
 *
 * The constructor is declared explicitly because a class body overrides the
 * inherited one: without it the harness base would be constructed and this
 * adapter's own fields would never be initialized.
 *
 * @param {new () => object} [baseClass] - the harness `LlmAdapter`, when resolvable.
 * @returns {new (spec: object) => object} the concrete adapter class.
 */
export function withBase(baseClass) {
  const Base = baseClass ?? class {}
  class CodexChatGptAdapter extends Base {
    /** @param {object} spec - adapter inputs. */
    constructor(spec) {
      super()
      CodexChatGptAdapterMethods.prototype.init.call(this, spec)
    }
  }
  for (const key of Object.getOwnPropertyNames(CodexChatGptAdapterMethods.prototype)) {
    if (key === 'constructor') continue
    const descriptor = Object.getOwnPropertyDescriptor(CodexChatGptAdapterMethods.prototype, key)
    if (descriptor !== undefined) Object.defineProperty(CodexChatGptAdapter.prototype, key, descriptor)
  }
  return CodexChatGptAdapter
}

/**
 * The default adapter class, used when no harness base class was resolvable.
 *
 * Production code should prefer {@link withBase} with the harness `LlmAdapter`;
 * this export exists so the module is usable on its own in tests.
 */
export const CodexChatGptAdapter = withBase(undefined)

/**
 * A stable thread key for one request.
 *
 * `sessionId` identifies a durable session and is the natural key. Auxiliary
 * one-shot calls (session title, compaction) may arrive without one; keying
 * those by a digest of their own transcript keeps their threads from colliding
 * with a session's while still caching repeated identical calls.
 *
 * @param {object} options - the assembled request.
 * @returns {string} a thread key.
 */
export function sessionKeyOf(options) {
  const sessionId = options.sessionId
  if (typeof sessionId === 'string' && sessionId.length > 0) return `session:${sessionId}`
  const hash = createHash('sha256')
  hash.update(typeof options.provider === 'string' ? options.provider : '')
  hash.update('\u0000')
  hash.update(typeof options.model === 'string' ? options.model : '')
  hash.update('\u0000')
  hash.update(typeof options.purpose === 'string' ? options.purpose : 'oneshot')
  for (const message of Array.isArray(options.messages) ? options.messages : []) {
    hash.update(message?.role ?? '')
    hash.update('\u0001')
    hash.update(JSON.stringify(message?.content ?? []))
    hash.update('\u0002')
  }
  return `oneshot:${hash.digest('hex').slice(0, 32)}`
}

/**
 * Map app-server token counts onto the harness's disjoint usage vocabulary.
 *
 * The harness bills `inputTokens + cacheReadTokens + cacheWriteTokens` as input,
 * so cached counts are subtracted out of the provider's total: the app-server
 * reports cached input *inclusive* of `inputTokens`, while the harness expects
 * it exclusive. Passing the counts through unchanged would double-bill the
 * cached portion.
 *
 * @param {object} counts - `thread/tokenUsage/updated` `last` payload.
 * @returns {{ inputTokens: number, outputTokens: number, totalTokens?: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number }}
 *   harness usage.
 */
export function mapUsage(counts) {
  const rawInput = numberOr(counts.inputTokens, 0)
  const cacheRead = numberOr(counts.cachedInputTokens, 0)
  const cacheWrite = numberOr(counts.cacheWriteInputTokens, 0)
  const output = numberOr(counts.outputTokens, 0)
  const reasoning = numberOr(counts.reasoningOutputTokens, 0)
  const usage = {
    inputTokens: Math.max(0, rawInput - cacheRead - cacheWrite),
    outputTokens: output,
  }
  const total = numberOr(counts.totalTokens, NaN)
  if (Number.isFinite(total)) usage.totalTokens = total
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
  if (reasoning > 0) usage.reasoningTokens = reasoning
  return usage
}

/**
 * @param {unknown} value - candidate number.
 * @param {number} fallback - value used when the candidate is not a finite number.
 * @returns {number} a finite number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * @returns {{ message: string, code: string }} the cancellation failure.
 */
function abortedFailure() {
  return { message: 'the Codex request was cancelled', code: 'ABORTED' }
}

export { effortOf }
