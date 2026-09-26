/**
 * dsh-codex-chatgpt — use the ChatGPT models from the local Codex desktop app
 * inside DeepSeek Harness.
 *
 * The plugin registers one LLM provider route backed by `codex app-server`,
 * reusing the desktop app's ChatGPT sign-in. It deliberately does not touch
 * `~/.codex`: that directory's sqlite state runtime is held by the running
 * desktop app, and a second app-server pointed at it fails to initialize. A
 * private CODEX_HOME is built instead and seeded with a copy of the credential
 * file, which is what actually carries the login.
 *
 * @module dsh-codex-chatgpt
 */

import { createRequire } from 'node:module'
import { CONFIG_DEFAULTS, findCodexExecutable, prepareHome, resolveConfig } from './src/config.js'
import { withBase } from './src/adapter.js'
import { buildTools } from './src/tools.js'

/** Cordis plugin name. */
export const name = 'codex-chatgpt'

/**
 * Required services.
 *
 * `llm` is the provider registry this plugin exists to extend. `tools` is
 * deliberately absent: the conversation-access tools register only when the
 * service is present, so a headless composition that has no tool registry still
 * gets the provider route instead of failing to load.
 */
export const inject = ['llm']

/**
 * @typedef {object} Config
 * @property {string} [provider] - provider route key registered on `ctx.llm`.
 * @property {string} [providerName] - display name shown in the model picker.
 * @property {string} [codexExecutable] - absolute path to the Codex executable; empty to auto-detect.
 * @property {string} [codexHome] - private CODEX_HOME; empty for the default under the DSH home.
 * @property {string} [authSource] - directory the ChatGPT credential is copied from.
 * @property {string} [cwd] - workspace passed to `thread/start`; empty for the process cwd.
 * @property {string} [approvalPolicy] - `never` | `on-request` | `on-failure` | `untrusted`.
 * @property {string} [sandbox] - `read-only` | `workspace-write` | `danger-full-access`.
 * @property {string} [reasoningEffort] - default effort when a request omits one.
 * @property {string|null} [baseInstructions] - overrides the system prompt when a request carries none.
 * @property {number} [turnTimeoutMs] - ceiling for one Codex turn.
 * @property {number} [startupTimeoutMs] - ceiling for handshake and thread creation.
 * @property {boolean} [ephemeralThreads] - keep threads out of the shared thread history.
 * @property {string|null} [environmentId] - app-server environment selector.
 */

/**
 * Standard-schema validator for the plugin config.
 *
 * Hand-written rather than imported: this bundle is out-of-tree and keeps its
 * runtime import surface to nothing but Node builtins and the harness LLM
 * package it must share an instance with.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-codex-chatgpt',
    /**
     * @param {unknown} raw - config as loaded from the profile patch.
     * @returns {{ value: object } | { issues: Array<{ message: string }> }} validation outcome.
     */
    validate(raw) {
      try {
        const resolved = resolveConfig(raw === null || typeof raw !== 'object' ? {} : raw)
        return {
          // Every field `resolveConfig` produces must be listed here. DSH validates
          // the profile's config with this schema and hands *this object* to
          // `apply()`, so a field missing from this list is silently dropped no
          // matter what the user wrote — the provider then runs on the default.
          // tools/check-schema-output.mjs fails if any of them goes missing.
          value: {
            provider: resolved.provider,
            providerName: resolved.providerName,
            codexExecutable: resolved.codexExecutable,
            codexHome: resolved.codexHome,
            authSource: resolved.authSource,
            cwd: resolved.cwd,
            approvalPolicy: resolved.approvalPolicy,
            sandbox: resolved.sandbox,
            reasoningEffort: resolved.reasoningEffort,
            baseInstructions: resolved.baseInstructions,
            turnTimeoutMs: resolved.turnTimeoutMs,
            startupTimeoutMs: resolved.startupTimeoutMs,
            ephemeralThreads: resolved.ephemeralThreads,
            environmentId: resolved.environmentId,
            httpTransport: resolved.httpTransport,
          },
        }
      } catch (error) {
        return {
          issues: [{
            message: error instanceof Error ? error.message : String(error),
          }],
        }
      }
    },
  },
}

export { CONFIG_DEFAULTS }

/**
 * Resolve the harness `LlmAdapter` from the plugin's own resolution path.
 *
 * Registering a nominal subclass is preferred because the harness documents
 * `LlmAdapter` as the registration contract. Resolution is still allowed to
 * fail: the registry validates only the methods it calls, so a duck-typed
 * adapter keeps the provider usable instead of turning a packaging problem into
 * a dead plugin.
 *
 * @returns {{ baseClass: (new () => object) | undefined, reason: string }} resolution outcome.
 */
function resolveAdapterBase() {
  try {
    const require = createRequire(import.meta.url)
    const module = require('@deepseek-ai/dsh-llm')
    if (typeof module?.LlmAdapter === 'function') {
      return { baseClass: module.LlmAdapter, reason: 'linked @deepseek-ai/dsh-llm' }
    }
    return { baseClass: undefined, reason: '@deepseek-ai/dsh-llm exposed no LlmAdapter export' }
  } catch (error) {
    return {
      baseClass: undefined,
      reason: `@deepseek-ai/dsh-llm is not resolvable (${error?.code ?? 'error'}); `
        + 'registering a structurally-compatible adapter',
    }
  }
}

/**
 * Register the provider route and the conversation-access tools.
 *
 * Registration never bails out. An earlier version returned early when the
 * private `CODEX_HOME` could not be prepared or no executable was found, which
 * made the provider vanish from the model picker with no way for the user to
 * tell why — the worst possible failure shape, because "the model is missing"
 * looks like a broken install rather than a fixable configuration problem.
 *
 * Instead the route is always registered, and the first real use reports the
 * exact problem. That keeps the failure inside the provider (visible where the
 * user is looking) and keeps a transient problem at load time — a locked
 * credential file, an executable mid-update — from retiring the provider for
 * the lifetime of the host process.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - the plugin context.
 * @param {Config} rawConfig - validated plugin config.
 */
export function apply(ctx, rawConfig) {
  const config = resolveConfig(rawConfig ?? {})
  const warn = (message) => { ctx.logger?.warn?.(`dsh-codex-chatgpt: ${message}`) }
  const diagnostic = (message) => { ctx.logger?.debug?.(`dsh-codex-chatgpt: ${message}`) }

  /** Advisory problems reported at load time; none of them stop registration. */
  const problems = []

  const executable = findCodexExecutable({ configured: config.codexExecutable })
  if (executable.length === 0) {
    problems.push(
      'no Codex executable was found: install the Codex desktop app, or set '
      + '"codexExecutable" to the codex.exe path',
    )
  } else {
    config.codexExecutable = executable
  }

  // Best-effort at load time, and retried on first use: the home is cheap to
  // prepare and it keeps a cold first turn from also paying the copy.
  const prepare = () => {
    if (config.codexExecutable.length === 0) {
      const missing = findCodexExecutable({ configured: config.codexExecutable })
      if (missing.length === 0) {
        throw new Error(
          'dsh-codex-chatgpt: no Codex executable was found. Install the Codex desktop app, '
          + 'or set "codexExecutable" in the plugin config to the codex.exe path.',
        )
      }
      config.codexExecutable = missing
    }
    const prepared = prepareHome(config)
    if (prepared.credentials.length === 0) {
      throw new Error(
        `dsh-codex-chatgpt: no ChatGPT credential was found in ${config.authSource}. `
        + 'Sign in with the Codex desktop app first, or point "authSource" at the directory '
        + 'holding auth.json.',
      )
    }
    return prepared
  }

  let prepared = false
  try {
    const result = prepare()
    prepared = true
    diagnostic(`codex home ready at ${config.codexHome} (credentials: ${result.credentials.join(', ')})`)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
  }

  for (const problem of problems) warn(`${problem} — the provider stays registered and will report this on first use.`)

  const resolution = resolveAdapterBase()
  diagnostic(resolution.reason)

  const AdapterClass = withBase(resolution.baseClass)
  const adapter = new AdapterClass({
    config,
    onDiagnostic: diagnostic,
    // Re-verified per use, so a problem that clears itself needs no reload.
    onDemandPrepare: () => {
      if (prepared) return
      prepare()
      prepared = true
    },
  })

  // The registration is owned by this plugin's fiber, so unloading the plugin
  // releases the route; the adapter's app-server child is disposed alongside it.
  ctx.llm.registerAdapter([config.provider], adapter)
  ctx.effect(() => () => { adapter.dispose() }, 'codex-chatgpt.dispose()')
  diagnostic(
    `registered provider "${config.provider}" `
    + (config.codexExecutable.length === 0 ? '(no executable yet)' : `via ${config.codexExecutable}`)
    + ` (home ${config.codexHome}, sandbox ${config.sandbox})`,
  )

  const tools = ctx.get('tools')
  if (tools === undefined || tools === null || typeof tools.register !== 'function') {
    diagnostic('no tools service; conversation-access tools were not registered')
    return
  }
  let clientPromise
  const getClient = async () => {
    if (clientPromise === undefined) clientPromise = adapter.registry.ensureClient()
    try {
      return await clientPromise
    } catch (error) {
      // A failed start must not be cached, or every later tool call inherits it.
      clientPromise = undefined
      throw error
    }
  }
  for (const definition of buildTools({ getClient, config, onDiagnostic: diagnostic })) {
    // Register through the resolved reference, never `ctx.tools`: this plugin
    // injects only `llm`, and a Cordis context refuses an undeclared service
    // property with "cannot get property \"tools\" without inject". That throw
    // aborted `apply()` after the provider registration, so the route was
    // revoked and the model vanished from the picker.
    tools.register(definition)
  }
  diagnostic('registered conversation-access tools')
}
