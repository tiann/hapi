import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AcpSdkBackend } from '@/agent/backends/acp'
import { logger } from '@/ui/logger'
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
 *
 * The isolation intentionally does NOT strand the user's provider setup:
 * {@link ensureBerryDataDir} seeds a freshly created dir with the
 * interactive dir's provider configuration (custom providers + stored
 * API keys), which berry resolves strictly relative to its data dir.
 */
export function resolveBerryDataDir(
    sessionId?: string | null,
    env: BerryAcpEnvironment = process.env
): string {
    const base = join(resolveHapiHomeDir(env), 'berry-data')
    return join(base, sessionId && sessionId.length > 0 ? sessionId : 'default')
}

/**
 * The interactive berry data dir berry itself defaults to when
 * `BERRY_AGENT_DATA_DIR` is unset (berry `persist/paths.ts`:
 * `$HOME/.berry-agent`).
 */
export function resolveInteractiveBerryDataDir(env: BerryAcpEnvironment = process.env): string {
    const home = env.HOME ?? env.USERPROFILE ?? homedir()
    return join(home, '.berry-agent')
}

const BERRY_SETTINGS_BASENAME = 'settings.json'
const BERRY_CUSTOM_PROVIDERS_KEY = 'customProviders'

/**
 * Provider-credential files copied from the interactive data dir when HAPI
 * first creates an isolated one. Berry keeps every provider API key in the
 * `credentials` table of `sessions.db` (AES-256-GCM) decryptable only with
 * the data dir's `secret.key` — neither has an env fallback — so a fresh
 * isolated dir silently loses the user's stored provider auth. The WAL
 * sidecar rides along when present: berry opens the store in WAL mode, and
 * commits that were never checkpointed (a key added minutes ago) live only
 * there.
 */
const BERRY_PROVIDER_CREDENTIAL_BASENAMES = ['sessions.db', 'sessions.db-wal', 'secret.key'] as const;

function warnSeedSkipped(what: string, error: unknown): void {
    logger.warn(
        `[berry] provider config seed skipped (${what}): ${error instanceof Error ? error.message : String(error)}`
    )
}

function copyCredentialFile(sourceDir: string, dataDir: string, basename: string): void {
    const source = join(sourceDir, basename)
    const target = join(dataDir, basename)
    if (!existsSync(source) || existsSync(target)) return
    const staging = join(dataDir, `${basename}.hapi-seed-${process.pid}`)
    try {
        copyFileSync(source, staging)
        renameSync(staging, target)
    } catch (error) {
        warnSeedSkipped(basename, error)
        try {
            unlinkSync(staging)
        } catch {
            // Best effort: a stale staging file is inert to berry.
        }
    }
}

function seedProviderSettings(sourceDir: string, dataDir: string): void {
    const source = join(sourceDir, BERRY_SETTINGS_BASENAME)
    const target = join(dataDir, BERRY_SETTINGS_BASENAME)
    if (!existsSync(source) || existsSync(target)) return
    try {
        const parsed: unknown = JSON.parse(readFileSync(source, 'utf8'))
        const customProviders = (parsed as Record<string, unknown> | null)?.[BERRY_CUSTOM_PROVIDERS_KEY]
        if (
            customProviders === undefined || customProviders === null
            || typeof customProviders !== 'object' || Array.isArray(customProviders)
            || Object.keys(customProviders).length === 0
        ) {
            return
        }
        // Only the provider-config key rides over. Berry's settings file
        // also carries its own sandbox/approval defaults for the user's
        // interactive setup; those must not change how HAPI-spawned
        // sessions gate tools.
        const staging = join(dataDir, `${BERRY_SETTINGS_BASENAME}.hapi-seed-${process.pid}`)
        writeFileSync(
            staging,
            `${JSON.stringify({ [BERRY_CUSTOM_PROVIDERS_KEY]: customProviders }, null, 2)}\n`,
            'utf8'
        )
        renameSync(staging, target)
    } catch (error) {
        warnSeedSkipped(BERRY_SETTINGS_BASENAME, error)
    }
}

/**
 * Create the isolated berry data dir and, on FIRST creation only, seed it
 * with the user's provider configuration from the interactive data dir
 * (see {@link resolveInteractiveBerryDataDir}).
 *
 * Without the seed, upgrading to isolated dirs drops every configured
 * provider: berry resolves `settings.json` custom providers and the
 * credentials store strictly relative to the data dir, so a fresh
 * directory means "no custom providers, no stored API keys". The seed is
 * a one-time copy-on-create — it never runs again for a directory that
 * already exists (idempotent across respawns and runner restarts, and it
 * never overwrites anything berry wrote), never copies
 * `tool-policy.json` (sticky permission grants are exactly what the
 * isolation exists to contain), and any failure degrades to the previous
 * behavior (empty dir; berry still boots) with a warning.
 */
export function ensureBerryDataDir(dataDir: string, env: BerryAcpEnvironment = process.env): void {
    const created = !existsSync(dataDir)
    // Berry manages the contents; HAPI only guarantees the directory
    // exists before the child first resolves its dataDir. Idempotent
    // across respawns.
    mkdirSync(dataDir, { recursive: true })
    if (!created) return
    const sourceDir = resolveInteractiveBerryDataDir(env)
    if (sourceDir === dataDir) return
    for (const basename of BERRY_PROVIDER_CREDENTIAL_BASENAMES) {
        copyCredentialFile(sourceDir, dataDir, basename)
    }
    seedProviderSettings(sourceDir, dataDir)
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
        ensureBerryDataDir(overlay.BERRY_AGENT_DATA_DIR, env)
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
