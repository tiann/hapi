import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { AcpSdkBackend } from '@/agent/backends/acp'
import { resolveHapiHomeDir } from '@/configuration'

type BerryAcpEnvironment = Record<string, string | undefined>

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    return Object.fromEntries(
        Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined)
    )
}

function parseArgsJson(raw: string): string[] {
    let value: unknown
    try {
        value = JSON.parse(raw)
    } catch {
        throw new Error('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_BERRY_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

/** Default ACP entrypoint: the `berry` CLI exposes ACP as the `acp` subcommand. */
export const BERRY_DEFAULT_ACP_COMMAND = 'berry'
export const BERRY_DEFAULT_ACP_ARGS = ['acp']

export function resolveBerryAcpCommand(env: BerryAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const override = env.HAPI_BERRY_ACP_COMMAND?.trim()
    const command = override || BERRY_DEFAULT_ACP_COMMAND
    if (env.HAPI_BERRY_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_BERRY_ACP_ARGS_JSON.trim()) }
    }
    // An explicitly configured server keeps bare `[]` args: custom wrappers
    // must not silently receive the official CLI's `acp` subcommand.
    if (override) return { command, args: [] }
    return { command, args: BERRY_DEFAULT_ACP_ARGS }
}

/**
 * Dedicated data dir for berry agents spawned by HAPI, isolated from the
 * user's interactive berry (`~/.berry-agent` by default).
 *
 * Berry persists TWO sticky things inside its dataDir: `tool-policy.json`
 * (allow_always permission answers are remembered permanently) and
 * `sessions.db` (every session it ever created). Sharing the interactive
 * dataDir with HAPI-spawned agents would let a sticky allow granted in a
 * HAPI session auto-approve tools in the user's terminal berry (and vice
 * versa) and pollute the interactive session list with HAPI rows. Keying
 * the directory by the HAPI row id additionally scopes sticky grants to
 * the HAPI session that made them, while staying stable across backend
 * respawns and runner restarts (the row id outlives both, so
 * `session/load` always finds the session in the same sessions.db).
 */
export function resolveBerryDataDir(
    sessionId?: string | null,
    env: BerryAcpEnvironment = process.env
): string {
    const base = join(resolveHapiHomeDir(env), 'berry-data')
    return join(base, sessionId && sessionId.length > 0 ? sessionId : 'default')
}

/**
 * Spawn-time env overlay for the berry ACP child. Berry reads both levers
 * ONLY at process spawn (there is no runtime RPC for either):
 * - `BERRY_AGENT_MODEL` — the model lever (id format `provider/model-id`);
 * - `BERRY_AGENT_DATA_DIR` — the isolated data dir (see
 *   {@link resolveBerryDataDir}).
 *
 * A machine-level value already present in the env wins, mirroring
 * `dshPermissionModeEnvOverlay`'s respect for explicit operator env: an
 * operator pinning `BERRY_AGENT_MODEL` on the machine profile keeps
 * control regardless of the session's model preference.
 */
export function berrySpawnEnvOverlay(
    opts: { model?: string; dataDir?: string },
    env: BerryAcpEnvironment = process.env
): Record<string, string> {
    const overlay: Record<string, string> = {}
    if (opts.model && !env.BERRY_AGENT_MODEL) {
        overlay.BERRY_AGENT_MODEL = opts.model
    }
    if (opts.dataDir && !env.BERRY_AGENT_DATA_DIR) {
        overlay.BERRY_AGENT_DATA_DIR = opts.dataDir
    }
    return overlay
}

export function createBerryBackend(
    env: NodeJS.ProcessEnv = process.env,
    opts: { model?: string; dataDir?: string } = {}
): AcpSdkBackend {
    const { command, args } = resolveBerryAcpCommand(env)
    const overlay = berrySpawnEnvOverlay(opts, env)
    if (overlay.BERRY_AGENT_DATA_DIR) {
        // Berry manages the contents; HAPI only guarantees the directory
        // exists before the child first resolves its dataDir. Idempotent
        // across respawns.
        mkdirSync(overlay.BERRY_AGENT_DATA_DIR, { recursive: true })
    }
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv({ ...env, ...overlay }),
        flavor: 'berry',
        // Berry's agent_message_chunk stream is a pure DELTA stream: the
        // default overlap dedupe treats repeated tokens (a later "0" after
        // "300") as an already-buffered suffix and drops them, corrupting
        // the transcript (grok streams the same way).
        textChunkMode: 'delta'
    })
}
