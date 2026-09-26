/**
 * Reproduce the host's view of the plugin: resolve and load it the same way the
 * loader does, register it, then run the model-catalog logic the GUI runs.
 *
 * This targets the failure where the provider is registered but no model rows
 * reach the picker.
 */

import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

/**
 * Where the installed plugin's host entry lives.
 *
 * Defaults to this user's profile so the script works out of the box, and takes
 * an argument or `DSH_PROFILE_DIR` for any other layout — a hardcoded absolute
 * path would only ever work on the machine that wrote it.
 */
const HOST_ENTRY = process.argv[2]
  ?? join(process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'web'), 'node_modules', 'dsh-codex-chatgpt', 'index.js')

if (!existsSync(HOST_ENTRY)) {
  console.log(`FAIL: no plugin entry at ${HOST_ENTRY}`)
  console.log('Pass the path as an argument, or set DSH_PROFILE_DIR to your profile directory.')
  process.exit(1)
}

console.log('=== 1. like the loader: createRequire(host entry) ===')
const require = createRequire(HOST_ENTRY)
for (const specifier of ['@deepseek-ai/dsh-llm', '@deepseek-ai/cordis', '@deepseek-ai/schemastery']) {
  try {
    console.log(`   ${specifier} -> ${require.resolve(specifier)}`)
  } catch (error) {
    console.log(`   ${specifier} -> FAIL ${error.code}`)
  }
}

console.log('\n=== 2. import the plugin module exactly as the loader would ===')
const module = await import(pathToFileURL(HOST_ENTRY).href)
console.log(`   exports: ${Object.keys(module).join(', ')}`)
console.log(`   name=${module.name} inject=${JSON.stringify(module.inject)}`)

console.log('\n=== 3. minimal host, then apply() ===')
let adapter
const llm = {
  registerAdapter(providers, instance) {
    console.log(`   registerAdapter called with ${JSON.stringify(providers)}`)
    adapter = instance
    return Object.assign(() => {}, { replace() {} })
  },
}
const tools = {
  register: (definition) => {
    console.log(`   tools.register ${definition.name}`)
    return () => {}
  },
}

/**
 * Mirror Cordis's inject guard instead of handing the plugin whatever it asks for.
 *
 * `vendor/cordis/src/reflect.ts:135-144`: the context proxy returns a real
 * property when the target has it, and otherwise throws
 * `cannot get property "<name>" without inject`. A stub that simply exposes
 * `ctx.tools` makes an undeclared service access look legal — which is exactly
 * how a provider that never registered once slipped past this harness.
 */
const ctx = new Proxy({
  logger: {
    debug: (m) => console.log(`   [debug] ${m}`),
    warn: (m) => console.log(`   [warn] ${m}`),
    info: () => {},
  },
  get: (name) => (name === 'tools' ? tools : undefined),
  llm,
  effect: (fn) => { fn(); return () => {} },
}, {
  get(target, prop) {
    if (typeof prop === 'symbol' || Reflect.has(target, prop)) return Reflect.get(target, prop)
    // `tools` is deliberately absent from the plugin's `inject`, so touching it
    // as a property must fail the same way the real loader fails.
    throw new Error(`cannot get property "${String(prop)}" without inject`)
  },
})

try {
  const config = module.Config['~standard'].validate({}).value
  console.log(`   config valid: provider=${config.provider}`)
  module.apply(ctx, config)
} catch (error) {
  console.log(`   !!! apply() THREW: ${error.name}: ${error.message}`)
  console.log(error.stack?.split('\n').slice(0, 6).join('\n'))
  process.exit(1)
}
if (adapter === undefined) {
  console.log('   !!! no adapter registered — plugin returned early (see warnings above)')
  process.exit(1)
}

console.log('\n=== 4. replicate the GUI catalog builder (packages/api/session-controller/src/catalog.ts) ===')
const providerInfo = adapter.providerInfo('codex-chatgpt')
console.log(`   listProviders() row: ${JSON.stringify(providerInfo)}`)
if (providerInfo.id !== 'codex-chatgpt') throw new Error('providerInfo id mismatch — INVALID_ADAPTER in the real registry')
if (typeof providerInfo.name !== 'string' || providerInfo.name.length === 0) {
  throw new Error('providerInfo name empty — INVALID_ADAPTER in the real registry')
}

const models = await adapter.listModels('codex-chatgpt')
console.log(`   listModels() returned ${models.length} rows`)
const seen = new Set()
for (const model of models) {
  // The runtime's exact validation (packages/llm/llm/src/index.ts listModels).
  if (typeof model.provider !== 'string' || model.provider !== 'codex-chatgpt') {
    throw new Error(`INVALID_CATALOG: provider mismatch on ${model.id}`)
  }
  if (typeof model.id !== 'string' || model.id.length === 0) throw new Error('INVALID_CATALOG: empty id')
  if (typeof model.name !== 'string' || model.name.length === 0) {
    throw new Error(`INVALID_CATALOG: empty name on ${model.id}`)
  }
  if (seen.has(model.id)) throw new Error(`INVALID_CATALOG: duplicate ${model.id}`)
  seen.add(model.id)
  console.log(`   row: ${JSON.stringify(model)}`)
}
console.log('   all rows passed the runtime validation')

console.log('\n=== 5. resolveModelInfo for each row (catalog.ts does this) ===')
for (const model of models.slice(0, 3)) {
  const resolved = await adapter.resolveModel('codex-chatgpt', model.id)
  if (resolved.provider !== 'codex-chatgpt' || resolved.id !== model.id || !resolved.name) {
    throw new Error(`INVALID_EXACT_MODEL_METADATA on ${model.id}`)
  }
  console.log(`   ${model.id}: context=${resolved.context?.contextWindow} efforts=${resolved.reasoning?.efforts.length}`)
}

adapter.dispose()
console.log('\n=== RESULT: the catalog path works; the picker should show these 7 rows ===')
process.exit(0)
