import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'

import {
    cleanupIntegrationFixtures,
    hasExpectedTermKillReceipt,
    isCleanIntegrationFixtureCleanup
} from '../integrationFixtureCleanup'
import { requireRunnerIntegrationContract } from '../runnerIntegrationContract'

if (process.env.NODE_ENV !== 'test'
    || process.env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1'
    || process.env.HAPI_RUNNER_INTEGRATION_CLEANUP_HELPER !== '1') {
    throw new Error('The fixture cleanup helper is test-only and requires the explicit integration contract')
}

const contract = requireRunnerIntegrationContract(process.env)
const ledgerArgument = process.argv[2]
if (!ledgerArgument || realpathSync(resolve(ledgerArgument)) !== realpathSync(contract.ledgerFile)) {
    throw new Error('Cleanup ledger argument must exactly match the canonical integration contract')
}

const result = await cleanupIntegrationFixtures({ ledgerFile: contract.ledgerFile })
const expectedProbeRaw = process.env.HAPI_RUNNER_INTEGRATION_EXPECT_TERM_KILL_PID?.trim()
if (expectedProbeRaw) {
    const expectedProbePid = Number(expectedProbeRaw)
    if (!Number.isSafeInteger(expectedProbePid) || expectedProbePid <= 0) {
        throw new Error('Expected cleanup probe PID must be a positive safe integer')
    }
    if (!hasExpectedTermKillReceipt(result, expectedProbePid)) {
        result.cleanupErrors.push({
            pid: expectedProbePid,
            operation: 'signal',
            reason: 'Expected cleanup probe did not receive both TERM and KILL'
        })
    }
}
process.stdout.write(`${JSON.stringify(result)}\n`)
if (!isCleanIntegrationFixtureCleanup(result)) process.exitCode = 1
