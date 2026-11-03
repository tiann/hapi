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

export function createDshBackend(env: NodeJS.ProcessEnv = process.env): AcpSdkBackend {
    const { command, args } = resolveDshAcpCommand(env)
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv(env),
        flavor: 'dsh'
    })
}
