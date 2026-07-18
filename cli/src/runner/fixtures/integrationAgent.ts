import { appendFile, mkdir } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

import { bootstrapSession } from '@/agent/sessionFactory'
import { createRunnerLifecycle } from '@/agent/runnerLifecycle'
import { readProcessIdentity } from '@/runner/processIdentity'

type FixtureEvent = {
    event: 'process-started' | 'session-created' | 'lifecycle-ready' | 'webhook-reported' | 'managed-outcome-acknowledged' | 'process-stopped'
    pid: number
    at: number
    launchNonce?: string
    runnerInstanceId?: string
    sessionId?: string
    signal?: string
    birthToken: string
    pgid: number
    executableRealpath: string
    outcomeId?: string
}

function requireFixtureContract(env: NodeJS.ProcessEnv): { eventFile: string; ledgerFile: string } {
    if (env.NODE_ENV !== 'test' || env.HAPI_RUNNER_INTEGRATION_FIXTURE !== '1') {
        throw new Error('Runner integration fixture is test-only and requires the explicit test contract')
    }

    const eventFile = env.HAPI_RUNNER_INTEGRATION_EVENT_FILE?.trim()
    const ledgerFile = env.HAPI_RUNNER_INTEGRATION_LEDGER_FILE?.trim()
    const home = env.HAPI_HOME?.trim()
    if (!eventFile || !ledgerFile || !home
        || !isAbsolute(eventFile) || !isAbsolute(ledgerFile) || !isAbsolute(home)) {
        throw new Error('HAPI_HOME and both Runner integration evidence files must be absolute paths')
    }
    const canonicalHome = realpathSync(resolve(home))
    for (const file of [eventFile, ledgerFile]) {
        const canonicalFile = realpathSync(resolve(file))
        const contained = relative(canonicalHome, canonicalFile)
        if (!contained || contained.startsWith('..') || isAbsolute(contained)) {
            throw new Error(`Runner integration evidence file must be a child of HAPI_HOME: home=${canonicalHome} file=${canonicalFile} relative=${contained}`)
        }
    }
    if (realpathSync(resolve(eventFile)) === realpathSync(resolve(ledgerFile))) {
        throw new Error('Runner integration event and ledger files must be distinct')
    }
    return { eventFile, ledgerFile }
}

function readWebhookDelayMs(env: NodeJS.ProcessEnv): number {
    const raw = env.HAPI_RUNNER_INTEGRATION_WEBHOOK_DELAY_MS?.trim()
    if (!raw) return 0
    const delay = Number(raw)
    if (!Number.isSafeInteger(delay) || delay < 0 || delay > 60_000) {
        throw new Error('HAPI_RUNNER_INTEGRATION_WEBHOOK_DELAY_MS must be an integer between 0 and 60000')
    }
    return delay
}

function readExitBeforeWebhook(env: NodeJS.ProcessEnv): boolean {
    const raw = env.HAPI_RUNNER_INTEGRATION_EXIT_BEFORE_WEBHOOK?.trim() || '0'
    if (!['0', '1'].includes(raw)) {
        throw new Error('HAPI_RUNNER_INTEGRATION_EXIT_BEFORE_WEBHOOK must be 0 or 1')
    }
    return raw === '1'
}

async function recordFixtureEvent(eventFile: string, ledgerFile: string, event: FixtureEvent): Promise<void> {
    await mkdir(dirname(eventFile), { recursive: true })
    if (event.event === 'process-started') {
        await mkdir(dirname(ledgerFile), { recursive: true })
        await appendFile(ledgerFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    }
    await appendFile(eventFile, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
}

export async function runIntegrationAgentFixture(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const { eventFile, ledgerFile } = requireFixtureContract(env)
    const webhookDelayMs = readWebhookDelayMs(env)
    const exitBeforeWebhook = readExitBeforeWebhook(env)
    const launchNonce = env.HAPI_LAUNCH_NONCE
    const runnerInstanceId = env.HAPI_RUNNER_INSTANCE_ID
    if (!launchNonce || !runnerInstanceId) {
        throw new Error('Runner integration fixture requires exact managed launch identity')
    }
    const processIdentity = await readProcessIdentity(process.pid)
    if (!processIdentity || processIdentity.evidenceSource !== 'kernel') {
        throw new Error('Runner integration fixture requires kernel process identity')
    }
    const baseEvent = {
        pid: process.pid,
        launchNonce,
        runnerInstanceId,
        birthToken: processIdentity.birthToken,
        pgid: processIdentity.pgid,
        executableRealpath: processIdentity.executableRealpath
    }

    await recordFixtureEvent(eventFile, ledgerFile, {
        event: 'process-started',
        ...baseEvent,
        at: Date.now()
    })

    const bootstrapped = await bootstrapSession({
        flavor: 'runner-integration-fixture',
        startedBy: 'runner',
        workingDirectory: process.cwd()
    })
    await recordFixtureEvent(eventFile, ledgerFile, {
        event: 'session-created',
        ...baseEvent,
        sessionId: bootstrapped.sessionInfo.id,
        at: Date.now()
    })

    // Match production provider ordering: lifecycle construction synchronously
    // consumes the inherited signing descriptor before the session webhook is
    // reported. This intentionally blocks until the Runner commits and writes
    // the key, or observes recoverable EOF when a predecessor dies first.
    let stopSignal = 'unknown'
    let keepAlive: ReturnType<typeof setInterval> | null = null
    const lifecycle = createRunnerLifecycle({
        session: bootstrapped.session,
        logTag: 'runner-integration-fixture',
        stopKeepAlive: () => {
            if (keepAlive) clearInterval(keepAlive)
        },
        onAfterClose: async () => {
            await recordFixtureEvent(eventFile, ledgerFile, {
                event: 'process-stopped',
                ...baseEvent,
                sessionId: bootstrapped.sessionInfo.id,
                signal: stopSignal,
                at: Date.now()
            })
        },
        onManagedOutcomeAcknowledged: async (receipt) => {
            await recordFixtureEvent(eventFile, ledgerFile, {
                event: 'managed-outcome-acknowledged',
                ...baseEvent,
                sessionId: bootstrapped.sessionInfo.id,
                outcomeId: receipt.idempotencyKey,
                at: Date.now()
            })
        }
    })

    process.once('SIGTERM', () => { stopSignal = 'SIGTERM' })
    process.once('SIGINT', () => { stopSignal = 'SIGINT' })
    keepAlive = setInterval(() => undefined, 60_000)
    lifecycle.registerProcessHandlers()
    await recordFixtureEvent(eventFile, ledgerFile, {
        event: 'lifecycle-ready',
        ...baseEvent,
        sessionId: bootstrapped.sessionInfo.id,
        at: Date.now()
    })

    if (exitBeforeWebhook) {
        process.exit(42)
    }

    if (webhookDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, webhookDelayMs))
    }

    await bootstrapped.reportStartedToRunner()
    await recordFixtureEvent(eventFile, ledgerFile, {
        event: 'webhook-reported',
        ...baseEvent,
        sessionId: bootstrapped.sessionInfo.id,
        at: Date.now()
    })

    await new Promise<never>(() => {})
}
