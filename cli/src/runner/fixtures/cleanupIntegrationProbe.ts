import { appendFile } from 'node:fs/promises'

import {
    matchesIntegrationFixtureProcess,
    type IntegrationFixtureProcessBinding
} from '../integrationFixtureIdentity'
import { readProcessIdentity } from '../processIdentity'
import { requireRunnerIntegrationContract } from '../runnerIntegrationContract'

if (process.env.NODE_ENV !== 'test'
    || process.env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1'
    || process.env.HAPI_RUNNER_INTEGRATION_CLEANUP_PROBE !== '1') {
    throw new Error('The cleanup probe is test-only and requires the explicit integration contract')
}

function exactFlag(flag: string): string {
    const index = process.argv.indexOf(flag)
    const value = index >= 0 ? process.argv[index + 1] : undefined
    if (!value) throw new Error(`Missing cleanup probe flag ${flag}`)
    return value
}

process.on('SIGTERM', () => undefined)

const contract = requireRunnerIntegrationContract(process.env)
const identity = await readProcessIdentity(process.pid)
if (!identity || identity.evidenceSource !== 'kernel') {
    throw new Error('Cleanup probe requires exact kernel process identity')
}
const binding: IntegrationFixtureProcessBinding = {
    pid: identity.pid,
    pgid: identity.pgid,
    birthToken: identity.birthToken,
    executableRealpath: identity.executableRealpath,
    launchNonce: exactFlag('--hapi-launch-nonce'),
    runnerInstanceId: exactFlag('--hapi-runner-instance')
}
if (!matchesIntegrationFixtureProcess(binding, identity)) {
    throw new Error('Cleanup probe identity does not match its managed argv binding')
}

await appendFile(contract.ledgerFile, `${JSON.stringify({
    event: 'process-started',
    at: Date.now(),
    ...binding
})}\n`, 'utf8')
process.stdout.write(`${JSON.stringify({ event: 'cleanup-probe-ready', pid: binding.pid })}\n`)
setInterval(() => undefined, 60_000)
