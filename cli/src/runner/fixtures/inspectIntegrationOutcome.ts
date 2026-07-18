import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { Database } from 'bun:sqlite'

import { requireRunnerIntegrationContract } from '../runnerIntegrationContract'

if (process.env.NODE_ENV !== 'test'
    || process.env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1'
    || process.env.HAPI_RUNNER_INTEGRATION_OUTCOME_INSPECTOR !== '1') {
    throw new Error('The managed outcome inspector is test-only and requires the explicit integration contract')
}

const contract = requireRunnerIntegrationContract(process.env)
const databaseArgument = process.argv[2]
const outcomeId = process.argv[3]?.trim()
if (!databaseArgument || realpathSync(resolve(databaseArgument)) !== realpathSync(contract.hubDbPath)) {
    throw new Error('Outcome inspector database argument must exactly match the canonical integration contract')
}
if (!outcomeId || !/^[0-9a-f-]{36}$/.test(outcomeId)) {
    throw new Error('Outcome inspector requires an exact managed outcome ID')
}

const db = new Database(contract.hubDbPath, { readonly: true, strict: true })
try {
    const rows = db.query(`
        SELECT request_hash, response_json
        FROM managed_outcome_idempotency
        WHERE idempotency_key = ?
    `).all(outcomeId) as Array<{ request_hash: string; response_json: string }>
    if (rows.length > 1) throw new Error(`Outcome ID ${outcomeId} is not unique in the isolated Hub`)
    const row = rows[0]
    process.stdout.write(`${JSON.stringify(row ? {
        requestHash: row.request_hash,
        response: JSON.parse(row.response_json) as Record<string, unknown>
    } : null)}\n`)
} finally {
    db.close()
}
