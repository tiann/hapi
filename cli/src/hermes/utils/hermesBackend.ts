import { AcpSdkBackend } from '@/agent/backends/acp'

type HermesAcpEnvironment = Record<string, string | undefined>

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
        throw new Error('HAPI_HERMES_ACP_ARGS_JSON must be a JSON array of strings')
    }
    if (!Array.isArray(value) || value.some((arg) => typeof arg !== 'string')) {
        throw new Error('HAPI_HERMES_ACP_ARGS_JSON must be a JSON array of strings')
    }
    return value
}

/** Default ACP entrypoint: the `hermes` CLI exposes ACP as the `acp` subcommand. */
export const HERMES_DEFAULT_ACP_COMMAND = 'hermes'
export const HERMES_DEFAULT_ACP_ARGS = ['acp']

export function resolveHermesAcpCommand(env: HermesAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const override = env.HAPI_HERMES_ACP_COMMAND?.trim()
    const command = override || HERMES_DEFAULT_ACP_COMMAND
    if (env.HAPI_HERMES_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_HERMES_ACP_ARGS_JSON.trim()) }
    }
    // An explicitly configured server keeps bare `[]` args: custom wrappers
    // must not silently receive the official CLI's `acp` subcommand.
    if (override) return { command, args: [] }
    return { command, args: HERMES_DEFAULT_ACP_ARGS }
}

export function createHermesBackend(env: NodeJS.ProcessEnv = process.env): AcpSdkBackend {
    const { command, args } = resolveHermesAcpCommand(env)
    return new AcpSdkBackend({
        command,
        args,
        env: filterEnv(env),
        flavor: 'hermes'
    })
}
