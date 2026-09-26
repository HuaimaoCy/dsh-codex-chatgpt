/**
 * Configuration resolution and the plugin-owned `CODEX_HOME`.
 *
 * The desktop app owns `~/.codex` and holds an exclusive sqlite state runtime
 * there: a second app-server pointed at that directory dies with
 * "failed to initialize state runtime". So this plugin never uses the real
 * home. It builds a private home and copies only the credential file, which is
 * what actually carries the user's ChatGPT login.
 *
 * The credential is read to be copied, never parsed, logged, or returned.
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/** Credential file names that carry a ChatGPT login, in preference order. */
const CREDENTIAL_FILES = ['auth.json']

/**
 * @typedef {object} ResolvedConfig
 * @property {string} provider - provider route key registered on `ctx.llm`.
 * @property {string} providerName - display name in the model picker.
 * @property {string} codexExecutable - absolute path to `codex.exe`, or `''` to auto-detect.
 * @property {string} codexHome - private CODEX_HOME.
 * @property {string} authSource - directory to copy credentials from.
 * @property {string} cwd - workspace passed to `thread/start`.
 * @property {string} approvalPolicy - `never` | `on-request`.
 * @property {string} sandbox - `read-only` | `workspace-write` | `danger-full-access`.
 * @property {string} reasoningEffort - default effort when the caller omits one.
 * @property {string|null} baseInstructions - overrides Codex's own system prompt.
 * @property {number} turnTimeoutMs - hard ceiling for one Codex turn.
 * @property {number} startupTimeoutMs - ceiling for handshake and thread creation.
 * @property {boolean} ephemeralThreads - keep threads out of the shared thread history.
 * @property {string|null} environmentId - optional app-server environment selector.
 * @property {boolean} httpTransport - force the Responses-over-HTTPS transport.
 */

/** Defaults applied before validation. */
export const CONFIG_DEFAULTS = {
  provider: 'codex-chatgpt',
  providerName: 'ChatGPT (Codex)',
  codexExecutable: '',
  codexHome: '',
  authSource: '',
  cwd: '',
  approvalPolicy: 'never',
  sandbox: 'read-only',
  reasoningEffort: '',
  baseInstructions: null,
  turnTimeoutMs: 900_000,
  startupTimeoutMs: 120_000,
  ephemeralThreads: true,
  environmentId: null,
  httpTransport: true,
}

const APPROVAL_POLICIES = ['never', 'on-request', 'on-failure', 'untrusted']
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access']

/**
 * @param {unknown} value - candidate value.
 * @param {string} label - field name for the diagnostic.
 * @returns {string} the trimmed string.
 */
function requireString(value, label) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`dsh-codex-chatgpt: ${label} must be a non-empty string`)
  }
  return value.trim()
}

/**
 * @param {unknown} value - candidate value.
 * @param {string} label - field name for the diagnostic.
 * @returns {number} a positive finite number.
 */
function requirePositiveNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`dsh-codex-chatgpt: ${label} must be a positive finite number`)
  }
  return value
}

/**
 * Normalize a raw profile config into a fully-resolved configuration.
 * @param {Record<string, unknown>} [raw] - config as loaded from the profile patch.
 * @returns {ResolvedConfig} resolved configuration.
 */
export function resolveConfig(raw = {}) {
  const merged = { ...CONFIG_DEFAULTS, ...raw }
  const provider = requireString(merged.provider, 'provider')
  const providerName = requireString(merged.providerName, 'providerName')
  const approvalPolicy = requireString(merged.approvalPolicy, 'approvalPolicy')
  if (!APPROVAL_POLICIES.includes(approvalPolicy)) {
    throw new TypeError(
      `dsh-codex-chatgpt: approvalPolicy must be one of ${APPROVAL_POLICIES.join(', ')}`,
    )
  }
  const sandbox = requireString(merged.sandbox, 'sandbox')
  if (!SANDBOXES.includes(sandbox)) {
    throw new TypeError(`dsh-codex-chatgpt: sandbox must be one of ${SANDBOXES.join(', ')}`)
  }
  if (merged.baseInstructions !== null
    && merged.baseInstructions !== undefined
    && typeof merged.baseInstructions !== 'string') {
    throw new TypeError('dsh-codex-chatgpt: baseInstructions must be a string or null')
  }
  if (merged.environmentId !== null
    && merged.environmentId !== undefined
    && typeof merged.environmentId !== 'string') {
    throw new TypeError('dsh-codex-chatgpt: environmentId must be a string or null')
  }
  if (typeof merged.httpTransport !== 'boolean') {
    throw new TypeError('dsh-codex-chatgpt: httpTransport must be a boolean')
  }
  const cwdSetting = typeof merged.cwd === 'string' && merged.cwd.trim().length > 0
    ? merged.cwd.trim()
    : process.cwd()
  return {
    provider,
    providerName,
    codexExecutable: typeof merged.codexExecutable === 'string' ? merged.codexExecutable.trim() : '',
    codexHome: typeof merged.codexHome === 'string' && merged.codexHome.trim().length > 0
      ? resolve(merged.codexHome.trim())
      : join(homedir(), '.dsh', 'codex-chatgpt'),
    authSource: typeof merged.authSource === 'string' && merged.authSource.trim().length > 0
      ? resolve(merged.authSource.trim())
      : join(homedir(), '.codex'),
    cwd: resolve(cwdSetting),
    approvalPolicy,
    sandbox,
    reasoningEffort: typeof merged.reasoningEffort === 'string' ? merged.reasoningEffort.trim() : '',
    baseInstructions: typeof merged.baseInstructions === 'string' ? merged.baseInstructions : null,
    turnTimeoutMs: requirePositiveNumber(merged.turnTimeoutMs, 'turnTimeoutMs'),
    startupTimeoutMs: requirePositiveNumber(merged.startupTimeoutMs, 'startupTimeoutMs'),
    ephemeralThreads: merged.ephemeralThreads !== false,
    environmentId: typeof merged.environmentId === 'string' ? merged.environmentId : null,
    httpTransport: merged.httpTransport === true,
  }
}

/**
 * Locate the Codex executable without relying on `PATH`.
 *
 * A desktop installation keeps a per-build directory under
 * `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe`, so the hash — not a
 * fixed name — is what must be discovered. Version directories are compared by
 * name so the highest build wins deterministically rather than by directory
 * enumeration order.
 *
 * @param {{ configured?: string, env?: Record<string, string|undefined>, localAppData?: string }} [options]
 *   overrides for testing.
 * @returns {string} absolute executable path, or `''` when nothing was found.
 */
export function findCodexExecutable(options = {}) {
  const configured = options.configured ?? ''
  if (configured.length > 0) return configured
  const env = options.env ?? process.env
  const fromEnv = env.DSH_CODEX_EXECUTABLE
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) return fromEnv.trim()
  const localAppData = options.localAppData ?? env.LOCALAPPDATA ?? ''
  if (localAppData.length === 0) return ''
  const binRoot = join(localAppData, 'OpenAI', 'Codex', 'bin')
  if (!existsSync(binRoot)) return ''
  /** @type {string[]} */
  let builds
  try {
    builds = readDirectoryNames(binRoot)
  } catch {
    return ''
  }
  for (const build of builds.sort().reverse()) {
    const candidate = join(binRoot, build, 'codex.exe')
    if (isFile(candidate)) return candidate
  }
  return ''
}

/**
 * List immediate child directory names.
 * @param {string} directory - directory to enumerate.
 * @returns {string[]} child names.
 */
function readDirectoryNames(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
}

/**
 * @param {string} path - candidate path.
 * @returns {boolean} whether the path is an existing regular file.
 */
function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * @typedef {object} PreparedHome
 * @property {string} home - the private CODEX_HOME.
 * @property {string[]} credentials - credential file names that were copied.
 */

/**
 * The `config.toml` this plugin writes into its private CODEX_HOME.
 *
 * It deliberately declares a provider instead of leaving the file empty. Codex
 * performs a Responses-over-WebSocket *prewarm* before the first stream request
 * of a session and waits for it to finish; on a network where that handshake
 * never completes, the wait is the full connect timeout times the request retry
 * budget (15s x 5 attempts), which measured 115.8s to the first token on this
 * machine. The transport then fell back to HTTPS and every later turn ran in
 * 3-5s, so the handshake was paying a large cost for a connection it never got.
 *
 * A user-defined provider entry cannot override the built-in `openai` provider
 * (`entry(key).or_insert(provider)`), so this uses its own key and points the
 * top-level `model_provider` at it. `name` is required by the provider schema,
 * which denies unknown fields. Everything else matches the built-in OpenAI
 * provider, minus the WebSocket transport.
 */
export const HTTP_TRANSPORT_CONFIG = `# Written by dsh-codex-chatgpt. Do not edit: regenerated on every load.
#
# Same provider as the built-in "openai" entry, with the Responses WebSocket
# transport disabled. Without this, Codex prewarms a WebSocket connection before
# the first turn and blocks on it; when that handshake cannot complete, the wait
# is the full connect timeout times the retry budget before falling back to HTTPS.
model_provider = "codex-http"

[model_providers.codex-http]
name = "OpenAI (HTTPS only)"
wire_api = "responses"
requires_openai_auth = true
supports_websockets = false
`

/**
 * Create the private CODEX_HOME and seed it with the ChatGPT credential.
 *
 * The desktop config is deliberately *not* copied: it enables marketplaces,
 * plugins, and MCP servers that would each add startup cost and side effects to
 * every DSH model call. Only the credential is inherited, plus the one transport
 * setting this plugin needs (see {@link HTTP_TRANSPORT_CONFIG}).
 *
 * @param {ResolvedConfig} config - resolved plugin configuration.
 * @returns {PreparedHome} the prepared home and what was carried into it.
 */
export function prepareHome(config) {
  mkdirSync(config.codexHome, { recursive: true })
  const credentials = []
  for (const name of CREDENTIAL_FILES) {
    const source = join(config.authSource, name)
    if (!existsSync(source)) continue
    const destination = join(config.codexHome, name)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(source, destination)
    credentials.push(name)
  }
  // Written unconditionally so a stale file from an earlier run — including the
  // empty one earlier versions left behind — cannot keep steering the home.
  writeFileSync(
    join(config.codexHome, 'config.toml'),
    config.httpTransport ? HTTP_TRANSPORT_CONFIG : '',
  )
  return { home: config.codexHome, credentials }
}
