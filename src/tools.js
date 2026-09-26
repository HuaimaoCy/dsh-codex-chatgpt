/**
 * Conversation-access tools.
 *
 * These expose the Codex side of the integration to the model: which ChatGPT
 * conversations exist, what one contains, and what the desktop app's session
 * index lists. They are the "read the desktop sessions" half of the plugin —
 * the provider route handles new conversation, these handle inspection.
 *
 * Every tool registers a raw, object-rooted JSON Schema. The harness forwards
 * `parameters` to the provider verbatim, so a schema without a root
 * `type: 'object'` would be rejected for the whole request rather than failing
 * locally; the object root is therefore not stylistic.
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/** Upper bound on lines read from a session index file. */
const MAX_INDEX_LINES = 2000

/** Upper bound on items returned by one thread read. */
const MAX_READ_ITEMS = 200

/**
 * @param {object} spec - tool dependencies.
 * @param {() => Promise<import('./client.js').CodexClient>} spec.getClient - lazily started app-server client.
 * @param {object} spec.config - resolved plugin configuration.
 * @param {(message: string) => void} [spec.onDiagnostic] - diagnostic sink.
 * @returns {object[]} raw tool definitions.
 */
export function buildTools(spec) {
  const { getClient, config } = spec
  const diagnostic = spec.onDiagnostic ?? (() => {})

  return [
    {
      name: 'codex_threads_list',
      description:
        'List conversations stored by the local Codex app-server. Use this to find a conversation to read with codex_thread_read. Returns thread ids, names, and last-updated times.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum conversations to return. Defaults to 20.',
          },
          query: {
            type: 'string',
            description: 'Optional case-insensitive substring to filter conversation names.',
          },
          archived: {
            type: 'boolean',
            description: 'When true, list archived conversations instead of active ones.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderThreadList(value) }],
      },
      /**
       * @param {object} args - validated arguments.
       * @returns {Promise<object>} the thread listing.
       */
      async execute(args) {
        const client = await getClient()
        const limit = clampLimit(args?.limit, 20)
        const threads = await client.listThreads({
          limit,
          ...(typeof args?.query === 'string' && args.query.length > 0 ? { query: args.query } : {}),
          ...(typeof args?.archived === 'boolean' ? { archived: args.archived } : {}),
        })
        const rows = threads.slice(0, limit).map((thread) => ({
          id: stringOr(thread?.id, ''),
          name: stringOr(thread?.name, stringOr(thread?.title, '')),
          updatedAt: stringOr(thread?.updatedAt, stringOr(thread?.updated_at, '')),
          cwd: stringOr(thread?.cwd, ''),
          ephemeral: thread?.ephemeral === true,
        })).filter((row) => row.id.length > 0)
        return { count: rows.length, threads: rows }
      },
    },
    {
      name: 'codex_thread_read',
      description:
        'Read one stored Codex conversation by id, returning its messages in order. Obtain the id from codex_threads_list. Reasoning items are omitted.',
      parameters: {
        type: 'object',
        properties: {
          threadId: {
            type: 'string',
            description: 'Conversation id returned by codex_threads_list.',
          },
          maxItems: {
            type: 'number',
            description: 'Maximum messages to return, newest kept. Defaults to 80.',
          },
        },
        required: ['threadId'],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderThreadRead(value) }],
      },
      /**
       * @param {object} args - validated arguments.
       * @returns {Promise<object>} the conversation contents.
       */
      async execute(args) {
        const threadId = typeof args?.threadId === 'string' ? args.threadId.trim() : ''
        if (threadId.length === 0) throw new Error('codex_thread_read: threadId is required')
        const client = await getClient()
        const { items } = await client.readThread(threadId)
        const maxItems = clampLimit(args?.maxItems, 80, MAX_READ_ITEMS)
        const messages = items
          .map(toMessage)
          .filter((message) => message !== null)
          .slice(-maxItems)
        return { threadId, count: messages.length, messages }
      },
    },
    {
      name: 'codex_desktop_sessions',
      description:
        'List the session index written by the Codex desktop app on this machine, newest first. Use this to discover conversations that exist in the desktop app, then read them with codex_thread_read.',
      parameters: {
        type: 'object',
        properties: {
          limit: {
            type: 'number',
            description: 'Maximum entries to return. Defaults to 30.',
          },
        },
        required: [],
      },
      output: {
        schema: { type: 'object', additionalProperties: true },
        render: (args, value) => [{ type: 'text', text: renderDesktopSessions(value) }],
      },
      /**
       * @param {object} args - validated arguments.
       * @returns {Promise<object>} the desktop session index.
       */
      async execute(args) {
        const limit = clampLimit(args?.limit, 30, MAX_INDEX_LINES)
        const indexPath = join(config.authSource, 'session_index.jsonl')
        if (!existsSync(indexPath)) {
          return { count: 0, sessions: [], note: `no session index at ${indexPath}` }
        }
        const raw = readFileSync(indexPath, 'utf8')
        const sessions = []
        for (const line of raw.split('\n')) {
          const trimmed = line.trim()
          if (trimmed.length === 0) continue
          try {
            const entry = JSON.parse(trimmed)
            const id = stringOr(entry?.id, '')
            if (id.length === 0) continue
            sessions.push({
              id,
              name: stringOr(entry?.thread_name, ''),
              updatedAt: stringOr(entry?.updated_at, ''),
            })
          } catch {
            // One malformed line must not hide the rest of the index.
            diagnostic('codex_desktop_sessions: skipped a malformed index line')
          }
        }
        sessions.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0))
        return { count: Math.min(sessions.length, limit), sessions: sessions.slice(0, limit) }
      },
    },
  ]
}

/**
 * @param {unknown} value - candidate limit.
 * @param {number} fallback - value used when absent or invalid.
 * @param {number} [ceiling] - optional upper bound.
 * @returns {number} a usable limit.
 */
function clampLimit(value, fallback, ceiling = 200) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return fallback
  return Math.min(Math.floor(value), ceiling)
}

/**
 * @param {unknown} value - candidate string.
 * @param {string} fallback - value used when the candidate is not a non-empty string.
 * @returns {string} a string.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.length > 0 ? value : fallback
}

/**
 * Project one app-server item onto a chat message.
 * @param {object} item - an app-server thread item.
 * @returns {{ role: string, text: string, phase?: string }|null} the projected message, or null.
 */
function toMessage(item) {
  if (item === null || typeof item !== 'object') return null
  if (item.type === 'userMessage') {
    const text = collectUserText(item.content)
    return text.length === 0 ? null : { role: 'user', text }
  }
  if (item.type === 'agentMessage') {
    const text = typeof item.text === 'string' ? item.text : ''
    if (text.length === 0) return null
    return typeof item.phase === 'string'
      ? { role: 'assistant', text, phase: item.phase }
      : { role: 'assistant', text }
  }
  return null
}

/**
 * @param {unknown} content - app-server user-message content entries.
 * @returns {string} concatenated text.
 */
function collectUserText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const entry of content) {
    if (entry !== null && typeof entry === 'object' && typeof entry.text === 'string') {
      parts.push(entry.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * @param {object} value - the listing result.
 * @returns {string} model-facing text.
 */
function renderThreadList(value) {
  const threads = Array.isArray(value?.threads) ? value.threads : []
  if (threads.length === 0) return 'No stored Codex conversations matched.'
  const lines = threads.map((thread) => {
    const name = thread.name.length > 0 ? thread.name : '(unnamed)'
    const updated = thread.updatedAt.length > 0 ? `  updated ${thread.updatedAt}` : ''
    return `- ${thread.id}  ${name}${updated}`
  })
  return `${threads.length} conversation(s):\n${lines.join('\n')}`
}

/**
 * @param {object} value - the read result.
 * @returns {string} model-facing text.
 */
function renderThreadRead(value) {
  const messages = Array.isArray(value?.messages) ? value.messages : []
  if (messages.length === 0) return `Conversation ${value?.threadId ?? ''} has no readable messages.`
  const body = messages
    .map((message) => `${message.role === 'user' ? 'User' : 'Assistant'}: ${message.text}`)
    .join('\n\n')
  return `Conversation ${value.threadId} (${messages.length} messages):\n\n${body}`
}

/**
 * @param {object} value - the desktop index result.
 * @returns {string} model-facing text.
 */
function renderDesktopSessions(value) {
  const sessions = Array.isArray(value?.sessions) ? value.sessions : []
  if (sessions.length === 0) {
    return typeof value?.note === 'string' ? value.note : 'The desktop session index is empty.'
  }
  const lines = sessions.map((session) => {
    const name = session.name.length > 0 ? session.name : '(unnamed)'
    const updated = session.updatedAt.length > 0 ? `  ${session.updatedAt}` : ''
    return `- ${session.id}  ${name}${updated}`
  })
  return `${sessions.length} desktop session(s), newest first:\n${lines.join('\n')}`
}
