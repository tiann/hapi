#!/usr/bin/env bun
/** Re-export shim — canonical: scripts/tooling/backfill-agent-transcript.ts */
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const target = join(dirname(fileURLToPath(import.meta.url)), 'tooling/backfill-agent-transcript.ts')
const result = spawnSync(process.execPath, [target, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(result.status ?? 1)
