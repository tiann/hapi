import { AcpSdkBackend } from '@/agent/backends/acp'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {}
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value
        }
    }
    return result
}

export function createHermesBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: getAgentLaunchCommand('hermes'),
        args: ['acp'],
        env: filterEnv(process.env),
        flavor: 'hermes',
        configOptionUpdates: true,
    })
}
