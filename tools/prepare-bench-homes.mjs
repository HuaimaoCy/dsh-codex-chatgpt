/**
 * Prepare the isolated benchmark homes.
 *
 * `bench-plain` is what the plugin produced before the transport fix (an empty
 * config file). `bench-http` is what it produces now. Keeping them separate is
 * what makes the A/B honest: the only difference is the generated config.
 *
 * Usage: node tools/prepare-bench-homes.mjs
 */

import { existsSync, mkdirSync, copyFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { HTTP_TRANSPORT_CONFIG } from '../src/config.js'

const ROOT = join(homedir(), '.dsh', 'codex-bench')
const AUTH = join(homedir(), '.codex', 'auth.json')

if (!existsSync(AUTH)) {
  console.log(`FAIL: no credential at ${AUTH}`)
  process.exit(1)
}

for (const [name, config] of [['bench-plain', ''], ['bench-http', HTTP_TRANSPORT_CONFIG]]) {
  const home = join(ROOT, name)
  // Start clean so a stale sqlite state from an earlier run cannot skew timing.
  if (existsSync(home)) rmSync(home, { recursive: true, force: true })
  mkdirSync(home, { recursive: true })
  copyFileSync(AUTH, join(home, 'auth.json'))
  writeFileSync(join(home, 'config.toml'), config, 'utf8')
  console.log(`prepared ${home} (config.toml ${config.length} bytes)`)
}
