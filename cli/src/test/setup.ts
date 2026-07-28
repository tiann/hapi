import { readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// This file runs at the top level of each vitest worker, before any test file
// is imported. It reads the hub config written by globalSetup.ts and injects
// the env vars so the CLI configuration singleton sees the temp hub.
const CONFIG_FILE = join(tmpdir(), 'hapi-test-config.json')

if (!existsSync(CONFIG_FILE)) {
    throw new Error(
        `[test setup] Missing isolated hub config: ${CONFIG_FILE}\n` +
        'Run the full test suite via "pnpm test" so globalSetup can spin up a temp hub first.'
    )
}

let config: { port: number; token: string; tmpHome: string; bunExec: string }
try {
    config = JSON.parse(readFileSync(CONFIG_FILE, 'utf8'))
} catch (err) {
    throw new Error(`[test setup] Failed to parse hub config at ${CONFIG_FILE}: ${err}`)
}

process.env.HAPI_API_URL = `http://127.0.0.1:${config.port}`
process.env.CLI_API_TOKEN = config.token
process.env.HAPI_HOME = config.tmpHome
process.env.HAPI_BUN_EXEC = config.bunExec
// The stress test starts 20 real CLI children. On slower/loaded machines their
// session webhooks can take longer than the production control-client default.
process.env.HAPI_RUNNER_HTTP_TIMEOUT ??= '60000'
// Keep heartbeat short so the version-mismatch test doesn't need to wait 60s
process.env.HAPI_RUNNER_HEARTBEAT_INTERVAL ??= '30000'
