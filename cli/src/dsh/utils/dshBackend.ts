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

export function resolveDshAcpCommand(env: DshAcpEnvironment = process.env): {
    command: string
    args: string[]
} {
    const command = env.HAPI_DSH_ACP_COMMAND?.trim() || 'dsh-acp-demo'
    if (env.HAPI_DSH_ACP_ARGS_JSON?.trim()) {
        return { command, args: parseArgsJson(env.HAPI_DSH_ACP_ARGS_JSON.trim()) }
    }
    const config = env.HAPI_DSH_ACP_CONFIG?.trim()
    return { command, args: config ? ['--config', config] : [] }
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
