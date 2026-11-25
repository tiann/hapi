import { AcpSdkBackend } from '@/agent/backends/acp'

type DshAcpEnvironment = Record<string, string | undefined>

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
        throw new Error('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_DSH_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

/** Default ACP entrypoint: the official `dsh` CLI ships the ACP profile since 0.2.x. */
export const DSH_DEFAULT_ACP_COMMAND = 'dsh'
export const DSH_DEFAULT_ACP_ARGS = ['--profile', 'acp']

export function resolveDshAcpCommand(env: DshAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const override = env.HAPI_DSH_ACP_COMMAND?.trim()
    const command = override || DSH_DEFAULT_ACP_COMMAND
    if (env.HAPI_DSH_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_DSH_ACP_ARGS_JSON.trim()) }
    }
    const config = env.HAPI_DSH_ACP_CONFIG?.trim()
    if (config) {
        // The official CLI has no `--config` flag: it composes config overlays
        // via `--patch` on top of a profile, so a config-only override still
        // needs `--profile acp`. Legacy community servers that speak
        // `--config` must be pinned with HAPI_DSH_ACP_COMMAND.
        if (override) return { command, args: ['--config', config] }
        return { command, args: [...DSH_DEFAULT_ACP_ARGS, '--patch', config] }
    }
    // An explicitly configured server keeps bare `[]` args: custom wrappers
    // must not silently receive the official CLI's `--profile acp` flags.
    if (override) return { command, args: [] }
    return { command, args: DSH_DEFAULT_ACP_ARGS }
}

/**
 * Env overlay resolving the spawn-time HAPI permission mode onto DSH's
 * `DSH_PERMISSION_MODE` sandbox preset (read-only / workspace-write /
 * danger-full-access).
 *
 * Mapping (verified against the DSH 0.2.2-rc.1 source): `read-only` pins the
 * read-only preset, `yolo` pins danger-full-access, and `default` /
 * `safe-yolo` stay UNSET so the server applies its own default
 * (workspace-write). The preset is read at process spawn only — DSH has no
 * runtime mode RPC, so mid-session mode switches remain HAPI-side
 * auto-approval decisions over request_permission and never reach this
 * overlay. A machine-level `DSH_PERMISSION_MODE` already present in the env
 * stays authoritative, mirroring the peer-tools overlay.
 */
export function dshPermissionModeEnvOverlay(
    permissionMode: string | undefined,
    env: DshAcpEnvironment = process.env
): Record<string, string> {
    const raw = env.DSH_PERMISSION_MODE
    if (raw !== undefined && raw !== '') return {}
    if (permissionMode === 'read-only') return { DSH_PERMISSION_MODE: 'read-only' }
    if (permissionMode === 'yolo') return { DSH_PERMISSION_MODE: 'danger-full-access' }
    return {}
}

export function createDshBackend(
    env: NodeJS.ProcessEnv = process.env,
    opts: { permissionMode?: string } = {}
): AcpSdkBackend {
    const { command, args } = resolveDshAcpCommand(env)
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv({ ...env, ...dshPermissionModeEnvOverlay(opts.permissionMode, env) }),
        flavor: 'dsh'
    })
}
