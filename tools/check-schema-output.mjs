/**
 * Check that the host's config schema actually carries `httpTransport` through.
 *
 * DSH validates the profile's plugin config with `Config['~standard'].validate`
 * before handing the result to `apply()`. If the schema drops a field, the
 * value a user writes in their profile never reaches the plugin — a silent way
 * for the transport fix to stop working.
 *
 * Usage: node tools/check-schema-output.mjs
 */

import { Config } from '../index.js'

const base = { cwd: process.cwd(), codexExecutable: 'fake-codex' }

const cases = [
  ['explicit true', { ...base, httpTransport: true }, true],
  ['explicit false', { ...base, httpTransport: false }, false],
  ['omitted (default)', { ...base }, true],
]

let failed = 0
for (const [label, input, expected] of cases) {
  const result = Config['~standard'].validate(input)
  if (result.issues !== undefined) {
    console.log(`FAIL ${label}: schema rejected ${JSON.stringify(result.issues)}`)
    failed++
    continue
  }
  const actual = result.value?.httpTransport
  const ok = actual === expected
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}: httpTransport = ${JSON.stringify(actual)} (expected ${JSON.stringify(expected)})`)
}

console.log(`\nkeys in validated output: ${Object.keys(Config['~standard'].validate(base).value ?? {}).join(', ')}`)
console.log(failed === 0 ? '\nALL PASS' : `\n${failed} CHECK(S) FAILED`)
process.exit(failed === 0 ? 0 : 1)
