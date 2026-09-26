/**
 * Provider tests: request planning, turn streaming, thread reuse, usage mapping,
 * failure and cancellation paths, and the conversation-access tools.
 *
 * The real app-server is never started. Every case runs against the scripted
 * fake injected through the adapter's `spawn` seam, so the provider's own logic
 * is what is under test.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CodexChatGptAdapter, mapUsage, sessionKeyOf } from '../src/adapter.js'
import { resolveConfig } from '../src/config.js'
import { HTTP_TRANSPORT_CONFIG, prepareHome } from '../src/config.js'
import { contentText, freshThreadInput, planTurn, systemText } from '../src/plan.js'
import { buildTools } from '../src/tools.js'
import { collect, fakeSpawn, finishOf, textOf } from './fake-app-server.js'

/**
 * @param {object} [overrides] - config overrides.
 * @returns {object} a resolved test configuration.
 */
function config(overrides = {}) {
  // The executable is a placeholder: every test injects the fake spawn seam, so
  // no real process is ever created.
  return resolveConfig({ cwd: process.cwd(), codexExecutable: 'fake-codex', ...overrides })
}

/**
 * @param {object} spawn - the fake spawn seam.
 * @param {object} [overrides] - config overrides.
 * @returns {CodexChatGptAdapter} an adapter wired to the fake.
 */
function adapter(spawn, overrides = {}) {
  return new CodexChatGptAdapter({
    config: config(overrides),
    spawn,
    onDiagnostic: () => {},
  })
}

/**
 * @param {string} text - user text.
 * @param {string} [sessionId] - session identity.
 * @returns {object} a minimal generate request.
 */
function request(text, sessionId) {
  return {
    provider: 'codex-chatgpt',
    model: 'gpt-6-astra',
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    ...(sessionId === undefined ? {} : { sessionId }),
  }
}

test('contentText renders text and describes blocks the wire cannot carry', () => {
  const text = contentText([
    { type: 'text', text: 'hello' },
    { type: 'reasoning', text: 'private scratch' },
    { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"p":"a"}' },
  ], 'assistant')
  assert.match(text, /hello/)
  assert.match(text, /\[tool call: read\(\{"p":"a"\}\)\]/)
  // Reasoning must never be replayed as context.
  assert.doesNotMatch(text, /private scratch/)
})

test('contentText labels tool results', () => {
  assert.equal(contentText([{ type: 'text', text: '42' }], 'tool'), '[tool result]\n42')
})

test('systemText reads both the field and a leading system message', () => {
  assert.equal(systemText({ system: ' from field ', messages: [] }), 'from field')
  assert.equal(
    systemText({ messages: [{ role: 'system', content: [{ type: 'text', text: 'from message' }] }] }),
    'from message',
  )
  assert.equal(systemText({ messages: [] }), '')
})

test('a fresh thread receives the earlier transcript plus the last user message', () => {
  const plan = planTurn({
    provider: 'codex-chatgpt',
    model: 'm',
    system: 'be terse',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'first' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }] },
      { role: 'user', content: [{ type: 'text', text: 'second' }] },
    ],
  }, null)
  assert.equal(plan.reusable, false)
  assert.match(plan.input, /Conversation so far:/)
  assert.match(plan.input, /User: first/)
  assert.match(plan.input, /Assistant: answer/)
  assert.match(plan.input, /User: second$/)
})

test('a thread is reused only when it is a faithful prefix', () => {
  const first = {
    provider: 'codex-chatgpt',
    model: 'm',
    system: 'sys',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'one' }] }],
  }
  const memory = {
    threadId: 'thread-x',
    model: 'm',
    system: 'sys',
    rows: [{ role: 'user', text: 'one' }],
  }
  // Extending with a new exchange is reuse, and only the new message is sent.
  const second = planTurn({
    ...first,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ],
  }, memory)
  assert.equal(second.reusable, true)
  assert.equal(second.threadId, 'thread-x')
  assert.equal(second.input, 'two')

  // A changed system prompt invalidates the thread outright.
  const changedSystem = planTurn({ ...first, system: 'different' }, memory)
  assert.equal(changedSystem.reusable, false)

  // A diverged transcript must not be appended to.
  const diverged = planTurn({
    ...first,
    messages: [{ role: 'user', content: [{ type: 'text', text: 'something else' }] }],
  }, memory)
  assert.equal(diverged.reusable, false)

  // An unanswered tail cannot be replayed onto the thread.
  const unanswered = planTurn({
    ...first,
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'reply' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ],
  }, { ...memory, rows: [{ role: 'user', text: 'one' }, { role: 'user', text: 'two' }] })
  assert.equal(unanswered.reusable, false)
})

test('tool results after an assistant reply are forwarded on reuse', () => {
  // Thread memory records only what actually travelled as turn input, so it
  // holds the user and tool rows — never the assistant rows between them.
  const memory = {
    threadId: 'thread-x',
    model: 'm',
    system: '',
    rows: [{ role: 'user', text: 'do it' }],
  }
  const plan = planTurn({
    provider: 'codex-chatgpt',
    model: 'm',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'do it' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'calling a tool' }] },
      { role: 'tool', content: [{ type: 'text', text: 'result!' }] },
    ],
  }, memory)
  assert.equal(plan.reusable, true)
  assert.match(plan.input, /\[tool result\]/)
  assert.match(plan.input, /result!/)
  // The model's own reply must not be replayed as if the user had sent it.
  assert.doesNotMatch(plan.input, /calling a tool/)
})

test('a fresh thread labels every transcript line by its real role', () => {
  // The tail is not always a user message, so an unconditional `User:` label
  // would attribute the model's own answer to the user.
  const fromAssistant = freshThreadInput([
    { role: 'user', text: 'a' },
    { role: 'assistant', text: 'b' },
  ])
  assert.match(fromAssistant, /User: a/)
  assert.match(fromAssistant, /Assistant: b/)
  assert.doesNotMatch(fromAssistant, /User: b/)

  const fromTool = freshThreadInput([
    { role: 'user', text: 'a' },
    { role: 'tool', text: 'r' },
  ])
  assert.match(fromTool, /Tool result: r/)

  // A single message is sent verbatim, with no transcript wrapper.
  assert.equal(freshThreadInput([{ role: 'assistant', text: 'solo' }]), 'solo')
  assert.equal(freshThreadInput([{ role: 'user', text: 'a' }, { role: 'assistant', text: '' }]), 'a')
})

test('freshThreadInput with a single message sends only that message', () => {
  assert.equal(freshThreadInput([{ role: 'user', text: 'only' }]), 'only')
  assert.equal(freshThreadInput([]), '')
})

test('usage maps cached input out of the harness input total', () => {
  const usage = mapUsage({
    totalTokens: 14_435,
    inputTokens: 14_430,
    cachedInputTokens: 12_416,
    cacheWriteInputTokens: 0,
    outputTokens: 5,
    reasoningOutputTokens: 0,
  })
  // Billed input is inputTokens + cacheReadTokens + cacheWriteTokens, so the
  // cached portion must not remain inside inputTokens.
  assert.equal(usage.inputTokens, 2_014)
  assert.equal(usage.cacheReadTokens, 12_416)
  assert.equal(usage.outputTokens, 5)
  assert.equal(usage.totalTokens, 14_435)
  assert.equal(usage.reasoningTokens, undefined)
})

test('session keys separate sessions and hash one-shot calls', () => {
  assert.equal(sessionKeyOf({ sessionId: 's1' }), 'session:s1')
  const a = sessionKeyOf({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
  const b = sessionKeyOf({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'x' }] }] })
  const c = sessionKeyOf({ provider: 'p', model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'y' }] }] })
  assert.equal(a, b)
  assert.notEqual(a, c)
})

test('a turn streams block-start, deltas, usage, block-end and finish in order', async () => {
  const spawn = fakeSpawn({ deltas: ['Hel', 'lo'] })
  const provider = adapter(spawn)
  const chunks = await collect(provider.stream(request('hi', 's1')))
  assert.deepEqual(chunks.map((chunk) => chunk.type), [
    'block-start', 'text-delta', 'text-delta', 'usage', 'block-end', 'finish',
  ])
  assert.equal(textOf(chunks), 'Hello')
  assert.deepEqual(chunks[4].block, { type: 'text', text: 'Hello' })
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(chunks[3].usage.inputTokens, 50)
  provider.dispose()
})

test('the second request on a session reuses its thread', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream(request('one', 's1')))
  const threadsAfterFirst = spawn.children[0].threadCount
  await collect(provider.stream({
    provider: 'codex-chatgpt',
    model: 'gpt-6-astra',
    sessionId: 's1',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'one' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'ok' }] },
      { role: 'user', content: [{ type: 'text', text: 'two' }] },
    ],
  }))
  // Reuse is the whole point: a new thread costs the ~115s cold start.
  assert.equal(spawn.children[0].threadCount, threadsAfterFirst)
  const turnStarts = spawn.children[0].requests.filter((entry) => entry.method === 'turn/start')
  assert.equal(turnStarts.length, 2)
  assert.equal(turnStarts[1].params.input[0].text, 'two')
  provider.dispose()
})

test('different sessions get different threads on one child process', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream(request('a', 's1')))
  await collect(provider.stream(request('b', 's2')))
  assert.equal(spawn.children.length, 1)
  assert.equal(spawn.children[0].threadCount, 2)
  provider.dispose()
})

test('a thread is not reused with a different session key', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream(request('a', 's1')))
  await collect(provider.stream(request('b', 's2')))
  const turnStarts = spawn.children[0].requests.filter((entry) => entry.method === 'turn/start')
  // The second session starts a fresh thread, so its input is not a delta.
  assert.equal(turnStarts[1].params.input[0].text, 'b')
  provider.dispose()
})

test('a completed item with no deltas is still delivered exactly once', async () => {
  const spawn = fakeSpawn({ noDelta: true, deltas: ['only-completed'] })
  const provider = adapter(spawn)
  const chunks = await collect(provider.stream(request('hi', 's1')))
  assert.equal(textOf(chunks), 'only-completed')
  assert.equal(chunks.filter((chunk) => chunk.type === 'text-delta').length, 1)
  provider.dispose()
})

test('a failed turn produces an error finish carrying the classified code', async () => {
  const spawn = fakeSpawn({ turnStatus: 'failed', turnError: { message: 'overloaded', codexErrorInfo: 'serverOverloaded' } })
  const provider = adapter(spawn)
  const chunks = await collect(provider.stream(request('hi', 's1')))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.equal(finish.reason.failure.code, 'CODEX_SERVER_ERROR')
  provider.dispose()
})

test('a failed turn drops the session thread so the next call rebuilds', async () => {
  const spawn = fakeSpawn({ turnStatus: 'failed' })
  const provider = adapter(spawn)
  await collect(provider.stream(request('hi', 's1')))
  assert.equal(provider.registry.threads.size, 0)
  provider.dispose()
})

test('an aborted signal finishes as aborted without running a turn', async () => {
  const spawn = fakeSpawn({ deltas: ['never'] })
  const provider = adapter(spawn)
  const controller = new AbortController()
  controller.abort()
  const chunks = await collect(provider.stream({ ...request('hi', 's1'), signal: controller.signal }))
  assert.equal(finishOf(chunks).reason.kind, 'aborted')
  assert.equal(spawn.children.length, 0)
  provider.dispose()
})

test('a startup failure surfaces as an error finish rather than throwing', async () => {
  const spawn = fakeSpawn({ failOn: 'initialize' })
  const provider = adapter(spawn)
  const chunks = await collect(provider.stream(request('hi', 's1')))
  const finish = finishOf(chunks)
  assert.equal(finish.reason.kind, 'error')
  assert.match(finish.reason.failure.message, /initialize/)
  provider.dispose()
})

test('the adapter never forwards DSH tool schemas to Codex', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream({
    ...request('hi', 's1'),
    tools: [{ name: 'bash', description: 'run', parameters: { type: 'object' } }],
  }))
  const turnStart = spawn.children[0].requests.find((entry) => entry.method === 'turn/start')
  // Codex runs its own tools; forwarding schemas would advertise functions this
  // transport never invokes.
  assert.equal(turnStart.params.tools, undefined)
  const threadStart = spawn.children[0].requests.find((entry) => entry.method === 'thread/start')
  assert.equal(threadStart.params.baseInstructions, undefined)
  provider.dispose()
})

test('the DSH system prompt becomes the thread baseInstructions', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream({ ...request('hi', 's1'), system: 'You are terse.' }))
  const threadStart = spawn.children[0].requests.find((entry) => entry.method === 'thread/start')
  assert.equal(threadStart.params.baseInstructions, 'You are terse.')
  provider.dispose()
})

test('configured baseInstructions apply when the request carries none', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn, { baseInstructions: 'Configured prompt.' })
  await collect(provider.stream(request('hi', 's1')))
  const threadStart = spawn.children[0].requests.find((entry) => entry.method === 'thread/start')
  assert.equal(threadStart.params.baseInstructions, 'Configured prompt.')
  provider.dispose()
})

test('the thread is created with the configured sandbox and approval policy', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn, { sandbox: 'workspace-write', approvalPolicy: 'on-request' })
  await collect(provider.stream(request('hi', 's1')))
  const threadStart = spawn.children[0].requests.find((entry) => entry.method === 'thread/start')
  assert.equal(threadStart.params.sandbox, 'workspace-write')
  assert.equal(threadStart.params.approvalPolicy, 'on-request')
  assert.equal(threadStart.params.ephemeral, true)
  provider.dispose()
})

test('only one child is spawned across concurrent first calls', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'], turnDelayMs: 5 })
  const provider = adapter(spawn)
  await Promise.all([
    collect(provider.stream(request('a', 's1'))),
    collect(provider.stream(request('b', 's2'))),
    collect(provider.stream(request('c', 's3'))),
  ])
  assert.equal(spawn.children.length, 1)
  provider.dispose()
})

test('idle threads are evicted', async () => {
  let now = 1_000
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = new CodexChatGptAdapter({
    config: config({ cwd: process.cwd() }),
    spawn,
    onDiagnostic: () => {},
    idleTimeoutMs: 100,
  })
  // Replace the clock through the registry so eviction is deterministic.
  provider.registry.now = () => now
  await collect(provider.stream(request('a', 's1')))
  assert.equal(provider.registry.threads.size, 1)
  now += 1_000
  provider.registry.evictIdle()
  assert.equal(provider.registry.threads.size, 0)
  provider.dispose()
})

test('disposing the adapter kills the child', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream(request('hi', 's1')))
  provider.dispose()
  assert.equal(spawn.children[0].closeCount, 1)
})

test('a lost connection fails the turn at once instead of waiting out the timeout', async () => {
  const spawn = fakeSpawn({ deltas: ['hi'], noTerminal: true })
  const provider = adapter(spawn, { turnTimeoutMs: 60_000 })
  const streaming = collect(provider.stream(request('hi', 's1')))
  // Let the turn reach the point where it is waiting for a terminal event.
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  spawn.children[0].endProtocol()
  const started = Date.now()
  const chunks = await streaming
  const elapsed = Date.now() - started
  assert.equal(finishOf(chunks).reason.kind, 'error')
  assert.equal(finishOf(chunks).reason.failure.code, 'CODEX_CONNECTION_LOST')
  // The whole point: a dead transport must not cost the full 60s ceiling.
  assert.ok(elapsed < 5_000, `expected a fast failure, took ${elapsed}ms`)
  provider.dispose()
})

test('the registry rebuilds its client after a connection loss', async () => {
  const spawn = fakeSpawn({ deltas: ['ok'] })
  const provider = adapter(spawn)
  await collect(provider.stream(request('a', 's1')))
  assert.equal(spawn.children.length, 1)
  await provider.registry.ensureClient()
  assert.notEqual(provider.registry.client, null)

  // Kill the connection as a crashed codex.exe would.
  spawn.children[0].endProtocol()
  await new Promise((resolve) => { setTimeout(resolve, 10) })
  assert.equal(provider.registry.client, null)

  // The next call must spawn a fresh child rather than failing forever.
  const chunks = await collect(provider.stream(request('b', 's2')))
  assert.equal(finishOf(chunks).reason.kind, 'stop')
  assert.equal(spawn.children.length, 2)
  provider.dispose()
})

test('disposing the adapter settles an in-flight turn', async () => {
  const spawn = fakeSpawn({ deltas: ['hi'], noTerminal: true })
  const provider = adapter(spawn, { turnTimeoutMs: 60_000 })
  const streaming = collect(provider.stream(request('hi', 's1')))
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  provider.dispose()
  const started = Date.now()
  const chunks = await streaming
  assert.ok(Date.now() - started < 5_000, 'dispose must release the waiting turn')
  assert.equal(finishOf(chunks).reason.kind, 'error')
})

test('model discovery is reported and hidden models are filtered out', async () => {
  const spawn = fakeSpawn({})
  const provider = adapter(spawn)
  const rows = await provider.listModels('codex-chatgpt')
  // Before discovery completes, the built-in list keeps the picker usable.
  assert.equal(rows.length, 7)
  await provider.registry.ensureClient()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  const refreshed = await provider.listModels('codex-chatgpt')
  assert.deepEqual(refreshed.map((row) => row.id), ['gpt-6-astra', 'gpt-6-luna'])
  assert.deepEqual(refreshed.map((row) => row.provider), ['codex-chatgpt', 'codex-chatgpt'])
  provider.dispose()
})

test('resolved model metadata carries context and reasoning efforts', async () => {
  const spawn = fakeSpawn({})
  const provider = adapter(spawn)
  await provider.registry.ensureClient()
  await new Promise((resolve) => { setTimeout(resolve, 20) })
  const resolved = await provider.resolveModel('codex-chatgpt', 'gpt-6-astra')
  assert.equal(resolved.id, 'gpt-6-astra')
  assert.equal(resolved.context.contextWindow, 258_400)
  assert.deepEqual(resolved.reasoning.efforts.map((effort) => effort.id), ['low', 'medium', 'high'])
  assert.equal(resolved.reasoning.defaultEffort, 'low')
  provider.dispose()
})

test('providerInfo names the route and preserves its id', () => {
  const spawn = fakeSpawn({})
  const provider = adapter(spawn)
  assert.deepEqual(provider.providerInfo('codex-chatgpt'), {
    id: 'codex-chatgpt',
    name: 'ChatGPT (Codex)',
  })
  provider.dispose()
})

test('conversation-access tools declare object-rooted schemas', () => {
  const tools = buildTools({ getClient: async () => { throw new Error('unused') }, config: config() })
  assert.equal(tools.length, 3)
  for (const tool of tools) {
    // The harness forwards `parameters` verbatim; a schema without an object
    // root would reject the whole model request.
    assert.equal(tool.parameters.type, 'object', `${tool.name} must have an object root`)
    assert.equal(typeof tool.parameters.properties, 'object')
    assert.equal(typeof tool.execute, 'function')
    assert.equal(typeof tool.output.render, 'function')
  }
})

test('codex_thread_read rejects a missing thread id', async () => {
  const tools = buildTools({ getClient: async () => { throw new Error('unused') }, config: config() })
  const read = tools.find((tool) => tool.name === 'codex_thread_read')
  await assert.rejects(() => read.execute({}), /threadId is required/)
})

/**
 * Build the conversation-access tools over a fake app-server.
 * @param {object} spawn - the fake spawn seam.
 * @param {object} [overrides] - config overrides.
 * @returns {{ tools: object[], provider: CodexChatGptAdapter }} tools and their adapter.
 */
function toolHarness(spawn, overrides = {}) {
  const provider = adapter(spawn, overrides)
  return {
    provider,
    tools: buildTools({
      getClient: () => provider.registry.ensureClient(),
      config: provider.config,
      onDiagnostic: () => {},
    }),
  }
}

test('codex_threads_list projects stored conversations', async () => {
  const spawn = fakeSpawn({
    threads: [
      { id: 't1', name: 'First', updatedAt: '2026-01-01T00:00:00Z', cwd: 'C:\\w', ephemeral: false },
      { id: 't2', title: 'Second', updated_at: '2026-01-02T00:00:00Z' },
    ],
  })
  const { tools, provider } = toolHarness(spawn)
  const list = tools.find((tool) => tool.name === 'codex_threads_list')
  const value = await list.execute({ limit: 5 })
  assert.equal(value.count, 2)
  assert.deepEqual(value.threads.map((row) => row.id), ['t1', 't2'])
  assert.equal(value.threads[1].name, 'Second')
  const rendered = list.output.render({}, value)
  assert.match(rendered[0].text, /t1/)
  provider.dispose()
})

test('codex_thread_read projects messages and drops reasoning items', async () => {
  const spawn = fakeSpawn({
    items: [
      { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
      { type: 'reasoning', text: 'private' },
      { type: 'agentMessage', text: 'answer', phase: 'final_answer' },
    ],
  })
  const { tools, provider } = toolHarness(spawn)
  const read = tools.find((tool) => tool.name === 'codex_thread_read')
  const value = await read.execute({ threadId: 't1' })
  assert.equal(value.count, 2)
  assert.deepEqual(value.messages.map((row) => row.role), ['user', 'assistant'])
  assert.equal(value.messages[1].text, 'answer')
  provider.dispose()
})

test('codex_desktop_sessions reads the session index and tolerates a bad line', async () => {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'codex-index-'))
  writeFileSync(join(dir, 'session_index.jsonl'), [
    '{"id":"a","thread_name":"Alpha","updated_at":"2026-01-01T00:00:00Z"}',
    'not json',
    '{"id":"b","thread_name":"Beta","updated_at":"2026-02-01T00:00:00Z"}',
  ].join('\n'))
  const tools = buildTools({
    getClient: async () => { throw new Error('unused') },
    config: config({ authSource: dir }),
  })
  const desktop = tools.find((tool) => tool.name === 'codex_desktop_sessions')
  const value = await desktop.execute({})
  assert.equal(value.count, 2)
  // Newest first.
  assert.deepEqual(value.sessions.map((row) => row.id), ['b', 'a'])
})

test('codex_desktop_sessions reports a missing index instead of failing', async () => {
  const { mkdtempSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'codex-empty-'))
  const tools = buildTools({
    getClient: async () => { throw new Error('unused') },
    config: config({ authSource: dir }),
  })
  const desktop = tools.find((tool) => tool.name === 'codex_desktop_sessions')
  const value = await desktop.execute({})
  assert.equal(value.count, 0)
  assert.match(value.note, /no session index/)
})

/**
 * Build a throwaway auth source holding one credential file.
 * @returns {Promise<{authSource: string, home: string}>} the two temp dirs.
 */
async function tempHomes() {
  const { mkdtempSync, writeFileSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const authSource = mkdtempSync(join(tmpdir(), 'codex-auth-'))
  writeFileSync(join(authSource, 'auth.json'), '{"tokens":{}}')
  return { authSource, home: mkdtempSync(join(tmpdir(), 'codex-home-')) }
}

test('the private home disables the WebSocket transport by default', async () => {
  const { authSource, home } = await tempHomes()
  const prepared = prepareHome(config({ authSource, codexHome: home }))
  assert.deepEqual(prepared.credentials, ['auth.json'])
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const written = readFileSync(join(home, 'config.toml'), 'utf8')
  assert.equal(written, HTTP_TRANSPORT_CONFIG)
  // The three facts that make the transport switch effective: a user-defined
  // provider (the built-in `openai` entry cannot be overridden), selected at the
  // top level, with the WebSocket transport off.
  assert.match(written, /^model_provider = "codex-http"$/m)
  assert.match(written, /^\[model_providers\.codex-http\]$/m)
  assert.match(written, /^supports_websockets = false$/m)
  assert.match(written, /^name = ".+"$/m)
})

test('httpTransport false leaves the private home without a provider override', async () => {
  const { authSource, home } = await tempHomes()
  prepareHome(config({ authSource, codexHome: home, httpTransport: false }))
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  assert.equal(readFileSync(join(home, 'config.toml'), 'utf8'), '')
})

test('a stale config file is overwritten on every prepare, in both directions', async () => {
  const { authSource, home } = await tempHomes()
  const { writeFileSync, readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const target = join(home, 'config.toml')
  writeFileSync(target, 'stale = true\n')
  prepareHome(config({ authSource, codexHome: home }))
  assert.equal(readFileSync(target, 'utf8'), HTTP_TRANSPORT_CONFIG)
  prepareHome(config({ authSource, codexHome: home, httpTransport: false }))
  assert.equal(readFileSync(target, 'utf8'), '')
})

test('httpTransport must be a boolean', () => {
  assert.throws(
    () => resolveConfig({ cwd: process.cwd(), codexExecutable: 'fake-codex', httpTransport: 'yes' }),
    /httpTransport must be a boolean/,
  )
})

test('prepareHome reports an unusable home instead of returning quietly', async () => {
  // A home whose parent is a regular file cannot be created. The failure has to
  // surface: `apply()` treats a resolved `prepare()` as "the home is ready" and
  // only records the transport config on that path, so swallowing it here would
  // bring back the 115s stall with nothing in the log to explain it.
  const { authSource, home } = await tempHomes()
  const { writeFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const blocker = join(home, `blocker-${Date.now()}`)
  writeFileSync(blocker, 'not a directory')
  assert.throws(() => prepareHome(config({ authSource, codexHome: join(blocker, 'nested') })))
})

test('the config schema carries every resolved field through to apply()', async () => {
  // DSH validates the profile config with this schema and hands *that output* to
  // apply(), so a field the schema forgets is silently dropped: the user's value
  // never arrives and the provider runs on the default. Asserting the whole set
  // targets the real defect, which is the hand-written field list.
  const { Config } = await import('../index.js')
  const base = { cwd: process.cwd(), codexExecutable: 'fake-codex' }
  const validated = Config['~standard'].validate(base)
  assert.equal(validated.issues, undefined, JSON.stringify(validated.issues))
  assert.deepEqual(Object.keys(validated.value).sort(), Object.keys(resolveConfig(base)).sort())
})

test('the schema passes an explicit httpTransport false through unchanged', async () => {
  const { Config } = await import('../index.js')
  const base = { cwd: process.cwd(), codexExecutable: 'fake-codex' }
  assert.equal(Config['~standard'].validate({ ...base, httpTransport: false }).value.httpTransport, false)
  // Omitting it must still resolve to the WebSocket-free default.
  assert.equal(Config['~standard'].validate(base).value.httpTransport, true)
})

// The suite holds no handle by design — every fake child is closed by the test
// that created it — but the runner itself has been observed to keep the process
// alive after the last test reports. Exiting explicitly keeps `--test` usable as
// the package's test script instead of requiring `--test-force-exit`, which
// would also mask a genuine leak. Test results are already flushed by this point.
process.on('beforeExit', () => { process.exit(0) })
