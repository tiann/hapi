/**
 * Test-child environment builder for the runner integration suite.
 *
 * Every real CLI child the suite spawns must run with this environment so
 * that:
 *
 * 1. Identity variables of the outer HAPI/pi session (PI_SESSION_ID,
 *    HAPI_SESSION_ID, PM2 metadata, ...) never leak into test children.
 *    These are blanked rather than dropped because `spawnHappyCLI` merges
 *    `{ ...process.env, ...options.env }` — a blank value still wins over the
 *    inherited one, while a missing key would let the parent value through.
 * 2. Every child carries a unique per-run marker (`HAPI_TEST_MARKER=<tmpHome>`)
 *    that the final audit (see `auditTestProcesses.ts`) can use to recognize
 *    test-owned processes even after they have been orphaned/reparented to
 *    PID 1.
 *
 * The worker env already points at the isolated temporary hub (see
 * `setup.ts`), so the hub credentials stay intact while session identity and
 * well-known secrets are neutralized.
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'

const TEST_CONFIG_FILE = join(tmpdir(), 'hapi-test-config.json')

/** Marker env key injected into every test child. Value is the run's tmpHome. */
export const TEST_OWNED_MARKER_KEY = 'HAPI_TEST_MARKER'

/** Keys/prefixes that identify the outer session and must never reach children. */
const IDENTITY_ENV_PATTERNS: RegExp[] = [
    /^PI_/i,
    /^HAPI_SESSION_/i,
    /^PM2_/i,
    /^pm_/,
    /^PM_/,
    /^HAPI_CLI_EXECUTABLE$/,
]

/** Well-known secrets that must not leak from the dev environment into children. */
const SECRET_ENV_PATTERNS: RegExp[] = [
    /^DB_PATH$/,
    /^TELEGRAM_BOT_TOKEN$/,
    /^SERVERCHAN_/i,
    /^WXPUSHER_/i,
    /^ELEVENLABS_/i,
]

function isNeutralizedKey(key: string): boolean {
    return (
        IDENTITY_ENV_PATTERNS.some((pattern) => pattern.test(key)) ||
        SECRET_ENV_PATTERNS.some((pattern) => pattern.test(key))
    )
}

/**
 * Builds the environment for a test-spawned CLI child.
 *
 * Starts from `baseEnv` (defaults to the worker env, which already carries the
 * isolated hub credentials injected by `setup.ts`), blanks identity/secret
 * keys, and injects the per-run test marker.
 */
export function buildTestChildEnv(baseEnv: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value === undefined) continue
        env[key] = isNeutralizedKey(key) ? '' : value
    }

    const tmpHome = baseEnv.HAPI_HOME
    if (!tmpHome) {
        throw new Error('[test env] Missing HAPI_HOME — setup.ts must point the worker at the temp hub home first')
    }
    env[TEST_OWNED_MARKER_KEY] = tmpHome
    return env
}

/**
 * The audit marker string for this run: `HAPI_TEST_MARKER=<tmpHome>`.
 * Matches the env dump produced by `ps eww`, which the final audit greps.
 */
export function testOwnedMarker(tmpHome?: string): string {
    const home = tmpHome ?? process.env.HAPI_HOME
    if (!home) {
        throw new Error('[test env] Missing HAPI_HOME — cannot build test-owned marker')
    }
    return `${TEST_OWNED_MARKER_KEY}=${home}`
}
