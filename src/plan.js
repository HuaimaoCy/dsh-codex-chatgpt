/**
 * Request planning: DSH messages and tool schemas become one Codex turn.
 *
 * The app-server owns server-side thread state, while DSH owns the authoritative
 * transcript and re-sends it on every call. Bridging the two means deciding,
 * per call, whether an existing Codex thread is still a faithful prefix of the
 * DSH transcript. Because a thread's first turn costs ~115s of transport
 * negotiation and later turns cost ~3s, getting this decision right is the
 * difference between a usable provider and an unusable one — but the decision
 * must stay conservative: a wrong "reuse" silently corrupts the conversation,
 * while a wrong "rebuild" only costs latency.
 *
 * The plan is therefore computed by pure functions here and nothing is
 * mutated: a caller hands the result to the thread registry.
 */

import { createHash } from 'node:crypto'

/**
 * Canonical text of one content-block list.
 *
 * Codex has no representation for a provider-neutral `tool-call` or `tool-result`
 * block, so those are rendered as explicit prose. Rendering beats dropping: a
 * transcript that silently lost a tool result would let the model answer from a
 * history it never actually saw.
 *
 * @param {readonly object[]} content - DSH content blocks.
 * @param {string} role - the message role, used to label tool prose.
 * @returns {string} model-facing text.
 */
export function contentText(content, role) {
  if (!Array.isArray(content) || content.length === 0) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string') parts.push(block.text)
        break
      case 'reasoning':
        // Reasoning is provider-private scratch space. Replaying it would feed
        // the model its own discarded chain of thought as if it were context.
        break
      case 'tool-call': {
        const name = typeof block.name === 'string' ? block.name : 'unknown'
        const args = typeof block.arguments === 'string' ? block.arguments : ''
        parts.push(`[tool call: ${name}(${args})]`)
        break
      }
      case 'image':
        parts.push('[image omitted: this provider route does not forward attachments yet]')
        break
      case 'file': {
        const name = block.attachment?.name
        parts.push(`[file attached: ${typeof name === 'string' ? name : 'unnamed'}]`)
        break
      }
      case 'tool-addition':
        if (typeof block.toolName === 'string') parts.push(`[tool available: ${block.toolName}]`)
        break
      case 'tool-removal':
        if (typeof block.toolName === 'string') parts.push(`[tool withdrawn: ${block.toolName}]`)
        break
      default:
        break
    }
  }
  const text = parts.join('\n').trim()
  if (role === 'tool' && text.length > 0) return `[tool result]\n${text}`
  return text
}

/**
 * The system prompt a request carries.
 *
 * A loop-built request puts it in a leading `system` message; a one-shot caller
 * uses `options.system`. Both are read so a one-shot auxiliary call (session
 * title, compaction) is not silently sent without its instructions.
 *
 * @param {object} options - the `GenerateOptions` request.
 * @returns {string} system text, or an empty string.
 */
export function systemText(options) {
  const fromField = typeof options.system === 'string' ? options.system.trim() : ''
  if (fromField.length > 0) return fromField
  const messages = Array.isArray(options.messages) ? options.messages : []
  const parts = []
  for (const message of messages) {
    if (message?.role !== 'system') continue
    const text = contentText(message.content, 'system')
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n').trim()
}

/**
 * Indices of conversation messages, excluding every `system` message, which is
 * delivered through thread instructions rather than as turn input.
 *
 * @param {object} options - the `GenerateOptions` request.
 * @returns {Array<{ index: number, role: string, text: string }>} per-message text.
 */
function conversationMessages(options) {
  const messages = Array.isArray(options.messages) ? options.messages : []
  const rows = []
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    const role = typeof message?.role === 'string' ? message.role : 'user'
    if (role === 'system') continue
    rows.push({ index, role, text: contentText(message?.content, role) })
  }
  return rows
}

/**
 * Stable fingerprint of a whole request's conversation identity.
 *
 * Hashed rather than concatenated because the identity of every call is
 * retained for the lifetime of the process; a raw concatenation would hold the
 * full transcript of every session in memory.
 *
 * @param {string} system - system text.
 * @param {Array<{ role: string, text: string }>} rows - conversation messages.
 * @returns {string} hex digest.
 */
function requestSignature(system, rows) {
  const hash = createHash('sha256')
  hash.update(system)
  hash.update('\u0000')
  for (const row of rows) {
    hash.update(row.role)
    hash.update('\u0001')
    hash.update(row.text)
    hash.update('\u0002')
  }
  return hash.digest('hex')
}

/** @typedef {object} ThreadMemories */
/**
 * @typedef {object} ThreadMemory
 * @property {string} threadId - the app-server thread.
 * @property {string} model - native model id the thread was created with.
 * @property {string} system - the system text the thread was created with.
 * @property {Array<{ role: string, text: string }>} rows - everything sent so far.
 */

/**
 * @typedef {object} TurnPlan
 * @property {boolean} reusable - whether the remembered thread may be extended.
 * @property {string|null} threadId - thread to extend, when reusing.
 * @property {string} input - text to send as this turn's user input.
 * @property {string} signature - this request's full signature.
 * @property {Array<{ role: string, text: string }>} rows - this request's conversation rows.
 * @property {string} system - this request's system text.
 * @property {string} model - normalized native model id this request routes to.
 * @property {number} reusedMessages - how many prior messages were already in the thread.
 * @property {boolean} rebuildReason - whether the caller must create a new thread.
 */

/**
 * Find the longest prefix of `rows` that is a chain of complete exchanges.
 *
 * Used only by callers that need a boundary rather than a delivered-row count;
 * {@link pendingMessages} handles the reuse path.
 *
 * @param {Array<{ role: string, text: string }>} rows - conversation messages.
 * @returns {number} count of leading messages that form completed exchanges.
 */
export function completePrefixLength(rows) {
  let boundary = 0
  let index = 0
  while (index < rows.length) {
    if (rows[index].role === 'user' && index + 1 < rows.length && rows[index + 1].role === 'assistant') {
      boundary = index + 2
      index += 2
      while (index < rows.length && rows[index].role === 'tool') {
        boundary = index + 1
        index += 1
      }
      continue
    }
    index += 1
  }
  return boundary
}

/**
 * The rows a Codex thread has actually received as turn input.
 *
 * Only `user` and `tool` messages travel as turn input: an assistant message is
 * the model's own output, which no thread ever consumes as input. Thread memory
 * therefore records exactly these rows, so the prefix comparison in
 * {@link planTurn} compares like with like instead of stalling on an assistant
 * message the thread never received.
 *
 * @param {Array<{ role: string, text: string }>} rows - this request's conversation rows.
 * @returns {Array<{ role: string, text: string }>} rows to remember.
 */
export function deliveredRows(rows) {
  return rows.filter((row) => row.role !== 'assistant')
}

/**
 * Plan how one request reaches Codex.
 *
 * @param {object} options - the `GenerateOptions` request.
 * @param {ThreadMemory|null|undefined} memory - what this session's thread has already seen.
 * @param {number} retainedMessages - cap on retained conversation rows.
 * @returns {TurnPlan} the plan.
 */
export function planTurn(options, memory, retainedMessages = 4000) {
  const system = systemText(options)
  const model = normalizeModel(options.model)
  const allRows = conversationMessages(options)
  const rows = allRows.length > retainedMessages
    ? allRows.slice(allRows.length - retainedMessages)
    : allRows
  const signature = requestSignature(system, rows)

  const reusableMemory = memory !== undefined && memory !== null
    && memory.system === system
    && memory.model === model
    && Array.isArray(memory.rows)

  if (reusableMemory) {
    const held = memory.rows
    const delivered = deliveredRows(rows)
    const prefixMatches = held.length <= delivered.length
      && held.every((row, index) => row.role === delivered[index].role && row.text === delivered[index].text)
    if (prefixMatches) {
      // Both sides are delivered rows, so the held count indexes this array
      // directly. Indexing the full transcript instead would be thrown off by
      // the assistant messages interleaved between user and tool rows.
      const pending = delivered.slice(held.length)
      const input = pending.map((row) => row.text).filter((text) => text.length > 0).join('\n\n')
      if (input.length > 0) {
        return {
          reusable: true,
          threadId: memory.threadId,
          input,
          signature,
          rows,
          system,
          model,
          reusedMessages: pending.length,
          rebuildReason: false,
        }
      }
    }
  }

  return {
    reusable: false,
    threadId: null,
    input: freshThreadInput(rows),
    signature,
    rows,
    system,
    model,
    reusedMessages: 0,
    rebuildReason: true,
  }
}

/**
 * The label a transcript line carries for one role.
 * @param {string} role - message role.
 * @returns {string} the transcript label.
 */
export function roleLabel(role) {
  switch (role) {
    case 'user': return 'User'
    case 'assistant': return 'Assistant'
    case 'tool': return 'Tool result'
    default: return 'Context'
  }
}

/**
 * The input a freshly created thread receives.
 *
 * A new thread starts empty, so anything before the final message would be lost
 * if only that message were sent. Earlier messages are prepended as a labelled
 * transcript, which keeps the model's context faithful at the cost of one
 * payload — the alternative, sending them as separate turns, would cost the
 * ~115s cold start once per message.
 *
 * Every line is labelled by its actual role. Labelling the final message `User`
 * unconditionally would attribute the model's own last answer to the user, and
 * a one-shot request or a truncated transcript can legitimately end on a
 * non-user message.
 *
 * @param {Array<{ role: string, text: string }>} rows - conversation messages.
 * @returns {string} the first turn's input.
 */
export function freshThreadInput(rows) {
  const meaningful = rows.filter((row) => row.text.length > 0)
  if (meaningful.length === 0) return ''
  if (meaningful.length === 1) return meaningful[0].text
  const head = meaningful.slice(0, -1)
  const tail = meaningful[meaningful.length - 1]
  const transcript = head
    .map((row) => `${roleLabel(row.role)}: ${row.text}`)
    .join('\n\n')
  return `Conversation so far:\n\n${transcript}\n\n${roleLabel(tail.role)}: ${tail.text}`
}

/**
 * Normalize a model id for comparison, so `undefined` and `''` agree.
 * @param {unknown} model - candidate model id.
 * @returns {string} a comparable string.
 */
export function normalizeModel(model) {
  return typeof model === 'string' ? model : ''
}

/**
 * Describe which tool schemas this route cannot honor.
 *
 * The plugin declares no tools to Codex because Codex executes its own tool set
 * inside its own agent loop; forwarding DSH's schemas would advertise functions
 * that never run. Reporting the count keeps the limitation visible in
 * diagnostics instead of looking like the model simply ignored a tool.
 *
 * @param {object} options - the `GenerateOptions` request.
 * @returns {number} how many tool schemas were withheld.
 */
export function withheldToolCount(options) {
  return Array.isArray(options.tools) ? options.tools.length : 0
}
