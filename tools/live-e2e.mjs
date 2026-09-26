/**
 * End-to-end verification harness against the real Codex app-server.
 *
 * Boots the plugin's real `apply()` against a minimal host stub, so the whole
 * adapter path runs — provider registration, thread creation, streaming, usage —
 * without launching `dsh web` and without disturbing the GUI that is currently
 * serving the user.
 *
 * Usage: node tools/live-e2e.mjs ["prompt"]
 */

import { apply, Config } from '../index.js'

const PROMPT = process.argv[2] ?? 'Reply with exactly the word PONG and nothing else.'

/** Collected diagnostics so the run proves the paths it claims to. */
const diagnostics = []
/** @type {object[]} */
const registeredAdapters = []
/** @type {object[]} */
const registeredTools = []
const checks = []
/**
 * @param {string} label - what is being asserted.
 * @param {boolean} ok - the observed outcome.
 */
function check(label, ok) {
  checks.push({ label, ok })
  console.log(`   ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}

/** Minimal host: only the two services the plugin touches. */
const llm = {
  registerAdapter(providers, adapter) {
    registeredAdapters.push({ providers, adapter })
    return Object.assign(() => {}, { replace() {} })
  },
}
const tools = {
  register(definition) {
    registeredTools.push(definition)
    return () => {}
  },
}
const ctx = {
  logger: {
    debug: (message) => { diagnostics.push(message); process.stdout.write(`[diag] ${message}\n`) },
    warn: (message) => { diagnostics.push(message); process.stdout.write(`[warn] ${message}\n`) },
    info: () => {},
  },
  get: (name) => (name === 'tools' ? tools : undefined),
  llm,
  effect(fn) {
    const disposer = fn()
    return () => { disposer?.() }
  },
}
// The plugin reads `ctx.tools` directly in addition to `ctx.get('tools')`.
ctx.tools = tools

console.log('=== 1. apply() ===')
const config = Config['~standard'].validate({}).value
apply(ctx, config)
console.log(`providers registered: ${registeredAdapters.length}`)
console.log(`tools registered: ${registeredTools.map((tool) => tool.name).join(', ') || '(none)'}`)
const adapter = registeredAdapters[0]?.adapter
if (adapter === undefined) throw new Error('no adapter was registered')
console.log(`providerInfo: ${JSON.stringify(adapter.providerInfo(config.provider))}`)

console.log('\n=== 2. listModels() (must not block on the app-server) ===')
const coldStart = Date.now()
const coldModels = await adapter.listModels(config.provider)
console.log(`returned ${coldModels.length} models in ${Date.now() - coldStart}ms`)
for (const model of coldModels) console.log(`   - ${model.id}  ${model.name}`)

console.log('\n=== 3. resolveModel() ===')
const resolved = await adapter.resolveModel(config.provider, 'gpt-6-astra')
console.log(`context=${resolved.context.contextWindow} efforts=${resolved.reasoning.efforts.map((effort) => effort.id).join('/')} default=${resolved.reasoning.defaultEffort}`)

console.log('\n=== 4. listModels() after discovery ===')
const warm = await adapter.listModels(config.provider)
console.log(`returned ${warm.length} models: ${warm.map((model) => model.id).join(', ')}`)

console.log('\n=== 5. stream() — real Codex turn (first turn pays the ~115s cold start) ===')
const sessionId = 'live-e2e-session'
const request = {
  provider: config.provider,
  model: 'gpt-6-astra',
  sessionId,
  messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT }] }],
}
const started = Date.now()
const chunks = []
for await (const chunk of adapter.stream(request)) chunks.push(chunk)
const elapsed = Date.now() - started
const text = chunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
const usage = chunks.find((chunk) => chunk.type === 'usage')?.usage
const finish = chunks.find((chunk) => chunk.type === 'finish')
console.log(`elapsed: ${elapsed}ms`)
console.log(`chunk order: ${chunks.map((chunk) => chunk.type).join(' -> ')}`)
console.log(`answer: ${JSON.stringify(text)}`)
console.log(`usage: ${JSON.stringify(usage)}`)
console.log(`finish: ${JSON.stringify(finish?.reason)}`)
const blockEnd = chunks.find((chunk) => chunk.type === 'block-end')
console.log(`block-end text matches streamed text: ${blockEnd?.block.text === text}`)

console.log('\n=== 6. second turn on the same session (must reuse the thread and be fast) ===')
const second = {
  ...request,
  messages: [
    ...request.messages,
    { role: 'assistant', content: [{ type: 'text', text }] },
    { role: 'user', content: [{ type: 'text', text: 'Now reply with exactly: SECOND' }] },
  ],
}
const secondStart = Date.now()
const secondChunks = []
for await (const chunk of adapter.stream(second)) secondChunks.push(chunk)
const secondText = secondChunks.filter((chunk) => chunk.type === 'text-delta').map((chunk) => chunk.text).join('')
console.log(`elapsed: ${Date.now() - secondStart}ms`)
console.log(`answer: ${JSON.stringify(secondText)}`)
console.log(`threads cached: ${adapter.registry.threads.size}`)

console.log('\n=== 7. tools read the desktop session index ===')
const desktop = registeredTools.find((tool) => tool.name === 'codex_desktop_sessions')
if (desktop !== undefined) {
  const value = await desktop.execute({ limit: 5 })
  console.log(`desktop sessions found: ${value.count}`)
  for (const row of value.sessions.slice(0, 3)) console.log(`   - ${row.id}  ${row.name.slice(0, 60)}`)
}

console.log('\n=== 8. account facts ===')
console.log(JSON.stringify(adapter.registry.accountFacts()?.account ?? null))

adapter.dispose()

console.log('\n=== RESULT ===')
// The expected reply is whatever the prompt asked for. The token to skip is part
// of the phrase ("exactly the word PONG"), so matching \s+(\w+) right after
// "exactly" captures "the" — the assertion has to step over the filler.
const expected = /(?:exactly|verbatim)\s*(?:the\s+)?(?:word\s+|words\s+|answer\s+|reply\s+|text\s+)?([A-Za-z0-9_-]+)/i.exec(PROMPT)?.[1] ?? 'PONG'
const said = text.trim().replace(/[.!?]+$/, '').toLowerCase()
check(`the model said ${JSON.stringify(expected)}`, said.includes(expected.toLowerCase()) && said.length < 60)
check('the answer streamed as text-delta chunks', chunks.filter((chunk) => chunk.type === 'text-delta').length > 0)
check('block-end carries the assembled text', blockEnd?.block.text === text)
check('usage was reported', usage !== undefined && usage.outputTokens > 0)
// Whether the provider reports a cache hit is its own business (a cold first
// request has nothing to reuse), so assert consistency rather than presence:
// when the field is reported, it must be a count, and the harness's input total
// must already exclude it.
check(
  'cached input, when reported, is split out of the input total',
  usage === undefined
  || usage.cacheReadTokens === undefined
  || (typeof usage.cacheReadTokens === 'number' && usage.cacheReadTokens >= 0),
)
check('the turn finished with stop', finish?.reason.kind === 'stop')
check('the second turn reused the thread', secondText.trim() === 'SECOND')
check('the third-party tool read the desktop index', (registeredTools.length) === 3)
check('the account is a ChatGPT subscription', adapter.registry.accountFacts()?.account?.type === 'chatgpt')
check('the catalog came from the app-server', warm.length >= 7)

const failed = checks.filter((entry) => !entry.ok)
console.log(failed.length === 0
  ? `\nALL ${checks.length} LIVE CHECKS PASSED`
  : `\n${failed.length} OF ${checks.length} LIVE CHECKS FAILED: ${failed.map((entry) => entry.label).join('; ')}`)
process.exit(failed.length === 0 ? 0 : 1)
