import { AcpSdkBackend } from '@/agent/backends/acp'

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) result[key] = value
    }
    return result
}

/** Reasonix exposes ACP over `reasonix acp`; credentials stay in its own config. */
export function createReasonixBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: process.env.REASONIX_CLI_PATH || 'reasonix',
        args: ['acp'],
        env: filterEnv(process.env),
        textChunkMode: 'delta',
        flavor: 'reasonix'
    })
}
