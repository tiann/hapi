import { waitForExactIntegrationFixtureProcess, type IntegrationFixtureProcessBinding } from '../integrationFixtureIdentity'

function requireTestContract(env: NodeJS.ProcessEnv): void {
    if (env.NODE_ENV !== 'test'
        || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1'
        || env.HAPI_RUNNER_INTEGRATION_SIGNAL_HELPER !== '1') {
        throw new Error('The fixture signal helper is test-only and requires the explicit integration contract')
    }
}

function parseBinding(raw: string | undefined): IntegrationFixtureProcessBinding {
    const value = JSON.parse(raw ?? 'null') as Record<string, unknown> | null
    const expectedKeys = ['birthToken', 'executableRealpath', 'launchNonce', 'pgid', 'pid', 'runnerInstanceId']
    if (!value || Array.isArray(value) || Object.keys(value).sort().join(',') !== expectedKeys.join(',')) {
        throw new Error('The fixture signal binding must contain exactly the required identity fields')
    }
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
        || !Number.isSafeInteger(value.pgid) || Number(value.pgid) <= 0
        || typeof value.birthToken !== 'string' || !value.birthToken
        || typeof value.executableRealpath !== 'string' || !value.executableRealpath.startsWith('/')
        || typeof value.launchNonce !== 'string' || !value.launchNonce
        || typeof value.runnerInstanceId !== 'string' || !value.runnerInstanceId) {
        throw new Error('The fixture signal binding contains an invalid identity field')
    }
    return value as IntegrationFixtureProcessBinding
}

function parseSignal(raw: string | undefined): NodeJS.Signals {
    if (raw === 'SIGTERM' || raw === 'SIGKILL' || raw === 'SIGINT') return raw
    throw new Error('The fixture signal helper accepts only SIGTERM, SIGKILL, or SIGINT')
}

requireTestContract(process.env)
const binding = parseBinding(process.argv[2])
const signal = parseSignal(process.argv[3])
const identity = await waitForExactIntegrationFixtureProcess(binding)
if (!identity) {
    process.stdout.write('{"status":"gone"}\n')
} else {
    try {
        process.kill(binding.pid, signal)
        process.stdout.write('{"status":"signaled"}\n')
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            process.stdout.write('{"status":"gone"}\n')
        } else {
            throw error
        }
    }
}
