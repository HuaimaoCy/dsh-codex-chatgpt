/**
 * Validate the config block shipped in `cordis.patch.yml` against the plugin's
 * own config schema.
 *
 * The patch file is what a user copies into their profile, and the schema
 * rejects unknown fields — so a typo here surfaces as a failed plugin load
 * rather than as a wrong value. This catches that before the file is pushed.
 *
 * Usage: node tools/check-patch-config.mjs
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Config } from '../index.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lines = readFileSync(join(root, 'cordis.patch.yml'), 'utf8').split(/\r?\n/)

const start = lines.findIndex((line) => /^\s*config:\s*$/.test(line))
if (start < 0) {
  console.log('FAIL: no "config:" block in cordis.patch.yml')
  process.exit(1)
}

const raw = {}
for (let i = start + 1; i < lines.length; i++) {
  const match = /^(\s+)([A-Za-z][A-Za-z0-9]*):\s*(.*)$/.exec(lines[i])
  if (match === null) continue
  // The `config:` block keys sit at 8 spaces; anything shallower belongs to the
  // surrounding list item or a new top-level key, so the block has ended.
  if (match[1].length < 8) break
  let value = match[3].trim()
  if (value === "''" || value === '""') value = ''
  else if (value === 'null') value = null
  else if (value === 'true') value = true
  else if (value === 'false') value = false
  else if (/^-?\d+$/.test(value)) value = Number(value)
  // YAML quotes are syntax, not content: `'never'` is the string never.
  else if (/^'[^']*'$/.test(value) || /^"[^"]*"$/.test(value)) value = value.slice(1, -1)
  raw[match[2]] = value
}

console.log('parsed from the patch file:')
for (const [key, value] of Object.entries(raw)) console.log(`   ${key} = ${JSON.stringify(value)}`)

const result = Config['~standard'].validate(raw)
if (result.issues !== undefined) {
  console.log(`FAIL: the schema rejected ${result.issues.length} field(s):`)
  for (const issue of result.issues) console.log(`   ${issue.path?.join('.') ?? ''}: ${issue.message}`)
  process.exit(1)
}

console.log(`OK: all ${Object.keys(raw).length} fields validate, httpTransport = ${result.value.httpTransport}`)
