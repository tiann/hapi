/**
 * Controlled Runner integration suite.
 *
 * This file is excluded from the ordinary unit suite. The dedicated command
 * must provide an isolated HAPI_HOME, a loopback Hub, and the explicit
 * deterministic-fixture contract. Missing infrastructure is a failure, never
 * a silent skip.
 */

import { randomUUID } from 'node:crypto'
import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import type { Metadata } from '@/api/types'
import { configuration } from '@/configuration'
import { clearRunnerState, readRunnerState } from '@/persistence'
import { projectPath } from '@/projectPath'
import {
    listRunnerSessions,
    notifyRunnerSessionStarted,
    queryRunnerSpawnSession,
    spawnRunnerSession,
    stopRunnerHttp,
    stopRunnerSession
} from '@/runner/controlClient'
import { isProcessAlive } from '@/utils/process'
import { getSpawnRequestStorePath } from '@/runner/spawnRequestStore'
import type { IntegrationFixtureProcessBinding } from '@/runner/integrationFixtureIdentity'
import { requireRunnerIntegrationContract } from '@/runner/runnerIntegrationContract'

const execFileAsync = promisify(execFile)

type FixtureEvent = {
    event: 'process-started' | 'session-created' | 'lifecycle-ready' | 'webhook-reported' | 'managed-outcome-acknowledged' | 'process-stopped'
    pid: number
    at: number
    launchNonce?: string
    runnerInstanceId?: string
    sessionId?: string
    signal?: string
    birthToken?: string
    pgid?: number
    executableRealpath?: string
    outcomeId?: string
}

type JsonResponse = {
    status: number
    body: Record<string, unknown>
}

const contract = requireRunnerIntegrationContract(process.env)
let runnerProcess: ChildProcess | null = null
let runnerOutput = ''

function failedSpawnMessages(results: Array<Record<string, unknown>>): string[] {
    return results
        .filter((result) => result.success !== true)
        .map((result) => String(result.error ?? 'unknown spawn failure')
            .replaceAll(contract.workspace, '<workspace>')
            .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, '<uuid>')
            .replace(/\bPID \d+\b/g, 'PID <redacted>'))
}

async function waitFor(
    condition: () => boolean | Promise<boolean>,
    timeoutMs = 10_000,
    intervalMs = 100
): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (await condition()) return
        await new Promise((resolve) => setTimeout(resolve, intervalMs))
    }
    throw new Error(`Timed out after ${timeoutMs}ms${runnerOutput ? `\nRunner output:\n${runnerOutput}` : ''}`)
}

async function waitForExit(child: ChildProcess, timeoutMs = 10_000): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (child.exitCode !== null || child.signalCode !== null) {
        return { code: child.exitCode, signal: child.signalCode }
    }
    return await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Process ${child.pid ?? 'unknown'} did not exit`)), timeoutMs)
        child.once('exit', (code, signal) => {
            clearTimeout(timer)
            resolve({ code, signal })
        })
    })
}

async function readFixtureEvents(file = contract.eventFile): Promise<FixtureEvent[]> {
    const raw = await readFile(file, 'utf8').catch(() => '')
    return raw.split('\n').filter(Boolean).map((line) => JSON.parse(line) as FixtureEvent)
}

async function readOwnershipJournal(): Promise<{
    launches: Record<string, {
        lifecycle: string
        pid?: number
        hapiSessionId?: string
        processGroupProvenEmptyAt?: string
    }>
}> {
    return JSON.parse(await readFile(configuration.runnerJournalFile, 'utf8'))
}

async function readSpawnRequestRecord(spawnRequestId: string): Promise<{
    pid?: number
    launchNonce?: string
    runnerInstanceId?: string
    reclaimableAt?: number
    result: Record<string, unknown>
} | undefined> {
    const state = JSON.parse(await readFile(getSpawnRequestStorePath(configuration.happyHomeDir), 'utf8')) as {
        requests: Record<string, {
            pid?: number
            launchNonce?: string
            runnerInstanceId?: string
            reclaimableAt?: number
            result: Record<string, unknown>
        }>
    }
    return state.requests[spawnRequestId]
}

async function readManagedOutcomeReceipt(outcomeId: string): Promise<{ requestHash: string; response: Record<string, unknown> } | null> {
    const helper = join(projectPath(), 'src/runner/fixtures/inspectIntegrationOutcome.ts')
    const { stdout } = await execFileAsync('bun', [helper, contract.hubDbPath, outcomeId], {
        cwd: projectPath(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HAPI_RUNNER_INTEGRATION_FIXTURE: '1',
            HAPI_RUNNER_INTEGRATION_OUTCOME_INSPECTOR: '1'
        },
        encoding: 'utf8',
        timeout: 5_000
    })
    return JSON.parse(stdout) as { requestHash: string; response: Record<string, unknown> } | null
}

async function waitForFixtureEvents(event: FixtureEvent['event'], count: number, timeoutMs = 10_000): Promise<FixtureEvent[]> {
    await waitFor(async () => (await readFixtureEvents()).filter((item) => item.event === event).length >= count, timeoutMs)
    return (await readFixtureEvents()).filter((item) => item.event === event)
}

function fixtureProcessBinding(event: FixtureEvent): IntegrationFixtureProcessBinding {
    if (!event.launchNonce || !event.runnerInstanceId || !event.birthToken
        || !event.pgid || !event.executableRealpath) {
        throw new Error(`Fixture event for PID ${event.pid} lacks exact kernel identity`)
    }
    return {
        pid: event.pid,
        launchNonce: event.launchNonce,
        runnerInstanceId: event.runnerInstanceId,
        birthToken: event.birthToken,
        pgid: event.pgid,
        executableRealpath: event.executableRealpath
    }
}

async function signalExactFixtureProcess(
    event: FixtureEvent,
    signal: NodeJS.Signals,
    allowAlreadyExited = false
): Promise<boolean> {
    const binding = fixtureProcessBinding(event)
    const helper = join(projectPath(), 'src/runner/fixtures/signalIntegrationAgent.ts')
    const { stdout } = await execFileAsync('bun', [
        helper,
        JSON.stringify(binding),
        signal
    ], {
        cwd: projectPath(),
        env: {
            ...process.env,
            NODE_ENV: 'test',
            HAPI_RUNNER_INTEGRATION_FIXTURE: '1',
            HAPI_RUNNER_INTEGRATION_SIGNAL_HELPER: '1'
        },
        encoding: 'utf8',
        timeout: 5_000
    })
    const result = JSON.parse(stdout) as { status?: string }
    if (result.status === 'gone') {
        if (allowAlreadyExited) return false
        throw new Error(`Fixture PID ${binding.pid} exited before the requested ${signal}`)
    }
    if (result.status !== 'signaled') throw new Error(`Unexpected fixture signal helper result: ${stdout}`)
    return true
}

async function hubGet(path: string): Promise<Record<string, unknown>> {
    const response = await fetch(`${configuration.apiUrl}${path}`, {
        headers: { Authorization: `Bearer ${configuration.cliApiToken}` },
        signal: AbortSignal.timeout(5_000)
    })
    if (!response.ok) throw new Error(`Hub GET ${path} failed with HTTP ${response.status}`)
    return await response.json() as Record<string, unknown>
}

async function runnerPost(path: string, body: Record<string, unknown>, timeoutMs = 25_000): Promise<JsonResponse> {
    const state = await readRunnerState()
    if (!state?.httpPort) throw new Error('Runner control endpoint is unavailable')
    const response = await fetch(`http://127.0.0.1:${state.httpPort}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
    })
    return {
        status: response.status,
        body: await response.json() as Record<string, unknown>
    }
}

async function waitForRunnerReady(): Promise<void> {
    await waitFor(async () => {
        if (runnerProcess && (runnerProcess.exitCode !== null || runnerProcess.signalCode !== null)) {
            throw new Error(`Runner exited before readiness (code=${runnerProcess.exitCode}, signal=${runnerProcess.signalCode})${runnerOutput ? `\n${runnerOutput}` : ''}`)
        }
        const state = await readRunnerState()
        if (!state?.pid || state.pid !== runnerProcess?.pid || !isProcessAlive(state.pid)) return false
        try {
            const response = await hubGet(`/cli/machines/${encodeURIComponent(state.startedWithMachineId ?? '')}`)
            const machine = response.machine as { runnerState?: { status?: string } } | undefined
            return machine?.runnerState?.status === 'ready'
        } catch {
            return false
        }
    }, 20_000, 150)
}

async function startTestRunner(options: {
    webhookDelayMs?: number
    sessionStartedFailures?: number
    sessionStartedAckLosses?: number
    managedCommitDelayMs?: number
    attachPidFailures?: number
    commitIdentityFailures?: number
    exitBeforeWebhook?: boolean
    heartbeatIntervalMs?: number
} = {}): Promise<void> {
    runnerOutput = ''
    const child = spawn('bun', ['src/index.ts', 'runner', 'start-sync'], {
        cwd: projectPath(),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            HAPI_INVOKED_CWD: contract.workspace,
            NODE_ENV: 'test',
            HAPI_RUNNER_SUPERVISED: 'foreground',
            HAPI_RUNNER_INTEGRATION_FIXTURE: '1',
            HAPI_RUNNER_INTEGRATION_EVENT_FILE: contract.eventFile,
            HAPI_RUNNER_INTEGRATION_WEBHOOK_DELAY_MS: String(options.webhookDelayMs ?? 0),
            HAPI_RUNNER_INTEGRATION_SESSION_STARTED_FAILURES: String(options.sessionStartedFailures ?? 0),
            HAPI_RUNNER_INTEGRATION_SESSION_STARTED_ACK_LOSSES: String(options.sessionStartedAckLosses ?? 0),
            HAPI_RUNNER_INTEGRATION_MANAGED_COMMIT_DELAY_MS: String(options.managedCommitDelayMs ?? 0),
            HAPI_RUNNER_INTEGRATION_ATTACH_PID_FAILURES: String(options.attachPidFailures ?? 0),
            HAPI_RUNNER_INTEGRATION_COMMIT_IDENTITY_FAILURES: String(options.commitIdentityFailures ?? 0),
            HAPI_RUNNER_INTEGRATION_EXIT_BEFORE_WEBHOOK: options.exitBeforeWebhook ? '1' : '0',
            HAPI_RUNNER_HTTP_TIMEOUT: '30000',
            HAPI_RUNNER_HEARTBEAT_INTERVAL: String(options.heartbeatIntervalMs ?? 60_000)
        }
    })
    runnerProcess = child
    child.stdout?.on('data', (chunk) => { runnerOutput += chunk.toString() })
    child.stderr?.on('data', (chunk) => { runnerOutput += chunk.toString() })
    await waitForRunnerReady()
}

async function stopFixtureProcesses(): Promise<void> {
    const sessions = await listRunnerSessions().catch(() => [])
    for (const session of sessions.filter((item) => item.startedBy === 'runner')) {
        await stopRunnerSession(session.happySessionId).catch(() => false)
    }

    const fixtureProcesses = new Map<number, FixtureEvent>()
    for (const event of (await readFixtureEvents(contract.ledgerFile)).filter((item) => item.event === 'process-started')) {
        fixtureProcesses.set(event.pid, event)
    }
    for (const event of fixtureProcesses.values()) {
        if (!isProcessAlive(event.pid)) continue
        await signalExactFixtureProcess(event, 'SIGTERM', true)
        await waitFor(() => !isProcessAlive(event.pid), 3_000).catch(() => undefined)
        if (isProcessAlive(event.pid)) {
            await signalExactFixtureProcess(event, 'SIGKILL', true)
        }
    }
}

async function stopTestRunner(): Promise<void> {
    await stopFixtureProcesses()
    const child = runnerProcess
    const state = await readRunnerState()
    if (state?.pid && isProcessAlive(state.pid)) {
        await stopRunnerHttp().catch(() => undefined)
    }
    if (child && child.exitCode === null && child.signalCode === null) {
        await waitForExit(child, 10_000).catch(async () => {
            if (child.pid && isProcessAlive(child.pid)) child.kill('SIGTERM')
            await waitForExit(child, 3_000).catch(() => {
                if (child.pid && isProcessAlive(child.pid)) child.kill('SIGKILL')
            })
        })
    }
    runnerProcess = null
    await clearRunnerState()
}

async function restartTestRunner(options: {
    webhookDelayMs?: number
    sessionStartedFailures?: number
    sessionStartedAckLosses?: number
    managedCommitDelayMs?: number
    attachPidFailures?: number
    commitIdentityFailures?: number
    exitBeforeWebhook?: boolean
    heartbeatIntervalMs?: number
} = {}): Promise<void> {
    await stopTestRunner()
    await startTestRunner(options)
}

async function crashTestRunner(): Promise<void> {
    const child = runnerProcess
    if (!child?.pid) throw new Error('Runner process is unavailable for crash injection')
    process.kill(child.pid, 'SIGKILL')
    await waitForExit(child, 5_000)
    runnerProcess = null
}

describe('Runner controlled integration', { timeout: 90_000 }, () => {
    beforeAll(async () => {
        await mkdir(contract.workspace, { recursive: true })
        await writeFile(contract.ledgerFile, '', { mode: 0o600 })
        const health = await fetch(`${configuration.apiUrl}/health`, {
            signal: AbortSignal.timeout(5_000)
        }).catch(() => null)
        if (!health?.ok) {
            throw new Error(`Controlled Hub is not healthy${health ? ` (HTTP ${health.status})` : ''}`)
        }
    })

    beforeEach(async () => {
        await writeFile(contract.eventFile, '', { mode: 0o600 })
        await writeFile(join(configuration.happyHomeDir, 'runner-reconcile.json'), JSON.stringify({
            version: 1,
            mode: 'report',
            killSwitch: false,
            allowedWorkspaceRoots: []
        }), { mode: 0o600 })
        await startTestRunner()
    })

    afterEach(async () => {
        await stopTestRunner()
    })

    it('lists no sessions in a fresh Runner', async () => {
        expect(await listRunnerSessions()).toEqual([])
    })

    it('tracks a terminal webhook without treating it as Runner-owned', async () => {
        const metadata: Metadata = {
            path: contract.workspace,
            host: 'integration-host',
            homeDir: contract.workspace,
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: contract.workspace,
            happyToolsDir: contract.workspace,
            hostPid: 999_999,
            startedBy: 'terminal',
            machineId: 'integration-machine'
        }
        const result = await notifyRunnerSessionStarted('terminal-integration-session', metadata)
        expect(result).not.toHaveProperty('error')
        expect(await listRunnerSessions()).toEqual([
            expect.objectContaining({
                startedBy: 'hapi directly - likely by user from terminal',
                happySessionId: 'terminal-integration-session',
                pid: 999_999
            })
        ])
    })

    it('rejects an unaccepted managed-looking webhook instead of registering it as external', async () => {
        const result = await notifyRunnerSessionStarted('unknown-managed-session', {
            path: contract.workspace,
            host: 'integration-host',
            homeDir: contract.workspace,
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: contract.workspace,
            happyToolsDir: contract.workspace,
            hostPid: 999_998,
            startedBy: 'runner',
            machineId: 'integration-machine',
            launchNonce: randomUUID(),
            runnerInstanceId: randomUUID()
        })
        expect(result).toEqual(expect.objectContaining({ error: expect.stringContaining('HTTP 500') }))
        expect(await listRunnerSessions()).toEqual([])
    })

    it('returns non-2xx for managed identity with a missing or invalid hostPid', async () => {
        for (const hostPid of [undefined, 0, '4242']) {
            const metadata: Record<string, unknown> = {
                path: contract.workspace,
                launchNonce: randomUUID(),
                runnerInstanceId: randomUUID()
            }
            if (hostPid !== undefined) metadata.hostPid = hostPid
            const result = await runnerPost('/session-started', {
                sessionId: `malformed-managed-${String(hostPid)}`,
                metadata
            })
            expect(result.status).toBeGreaterThanOrEqual(500)
        }

        const external = await runnerPost('/session-started', {
            sessionId: 'identity-free-without-pid',
            metadata: { path: contract.workspace }
        })
        expect(external.status).toBe(200)
    })

    it('stops a deterministic child through the real lifecycle and persists its signed outcome', async () => {
        const result = await spawnRunnerSession(contract.workspace)
        expect(result).toEqual(expect.objectContaining({ success: true, sessionId: expect.any(String) }))
        const [started] = await waitForFixtureEvents('process-started', 1)
        expect(started?.launchNonce).toMatch(/^[0-9a-f-]{36}$/)
        expect((await listRunnerSessions()).find((item) => item.happySessionId === result.sessionId)).toEqual(
            expect.objectContaining({ startedBy: 'runner', pid: started?.pid })
        )
        expect(await stopRunnerSession(result.sessionId)).toBe(true)
        const [stopped] = await waitForFixtureEvents('process-stopped', 1)
        expect(stopped).toEqual(expect.objectContaining({
            pid: started?.pid,
            sessionId: result.sessionId,
            signal: 'SIGTERM',
            birthToken: started?.birthToken,
            pgid: started?.pgid,
            executableRealpath: started?.executableRealpath
        }))
        const [acknowledged] = await waitForFixtureEvents('managed-outcome-acknowledged', 1)
        expect(acknowledged).toEqual(expect.objectContaining({
            pid: started?.pid,
            sessionId: result.sessionId,
            launchNonce: started?.launchNonce,
            outcomeId: expect.stringMatching(/^[0-9a-f-]{36}$/)
        }))
        const receipt = await readManagedOutcomeReceipt(acknowledged!.outcomeId!)
        expect(receipt?.requestHash).toMatch(/^[0-9a-f]{64}$/)
        expect(receipt?.response).toEqual(expect.objectContaining({
            result: 'success',
            canonicalSessionId: result.sessionId
        }))
        await waitFor(async () => (await listRunnerSessions()).length === 0)

        const response = await hubGet(`/cli/sessions/${encodeURIComponent(result.sessionId)}`)
        const session = response.session as { active: boolean; metadata?: Record<string, unknown> }
        expect(session.active).toBe(false)
        expect(session.metadata).toEqual(expect.objectContaining({
            lifecycleState: 'stopped',
            stoppedBy: 'runner-recycle',
            stopReasonCode: 'runner-recycle'
        }))
    })

    it('creates one canonical Hub session with managed identity metadata', async () => {
        const result = await spawnRunnerSession(contract.workspace)
        const [created] = await waitForFixtureEvents('session-created', 1)
        expect(created?.sessionId).toBe(result.sessionId)
        const response = await hubGet(`/cli/sessions/${encodeURIComponent(result.sessionId)}`)
        const session = response.session as { id: string; metadata?: Record<string, unknown> }
        expect(session.id).toBe(result.sessionId)
        expect(session.metadata).toEqual(expect.objectContaining({
            flavor: 'runner-integration-fixture',
            startedBy: 'runner',
            hostPid: created?.pid,
            launchNonce: created?.launchNonce,
            runnerInstanceId: created?.runnerInstanceId
        }))
    })

    it('replays one spawn request ID without creating a second child or session', async () => {
        const requestId = randomUUID()
        const [first, concurrentReplay] = await Promise.all([
            spawnRunnerSession(contract.workspace, undefined, requestId),
            spawnRunnerSession(contract.workspace, undefined, requestId)
        ])
        const laterReplay = await spawnRunnerSession(contract.workspace, undefined, requestId)
        expect(first.sessionId).toBe(concurrentReplay.sessionId)
        expect(laterReplay.sessionId).toBe(first.sessionId)
        expect((await readFixtureEvents()).filter((event) => event.event === 'process-started')).toHaveLength(1)
        expect((await readFixtureEvents()).filter((event) => event.event === 'session-created')).toHaveLength(1)
    })

    it('retries a managed session webhook after one HTTP 500 without spawning a second child', async () => {
        await restartTestRunner({ sessionStartedFailures: 1 })
        const requestId = randomUUID()
        const result = await spawnRunnerSession(contract.workspace, undefined, requestId)

        expect(result).toEqual(expect.objectContaining({ success: true, sessionId: expect.any(String) }))
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'success',
            sessionId: result.sessionId
        })
        const events = await readFixtureEvents()
        expect(events.filter((event) => event.event === 'process-started')).toHaveLength(1)
        expect(events.filter((event) => event.event === 'session-created')).toHaveLength(1)
        expect(events.filter((event) => event.event === 'webhook-reported')).toHaveLength(1)
    })

    it('acknowledges an exact webhook replay after durable success lost its first response', async () => {
        await restartTestRunner({ sessionStartedAckLosses: 1 })
        const requestId = randomUUID()
        const result = await spawnRunnerSession(contract.workspace, undefined, requestId)

        expect(result).toEqual(expect.objectContaining({ success: true, sessionId: expect.any(String) }))
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'success',
            sessionId: result.sessionId
        })
        expect((await readFixtureEvents()).filter((event) => event.event === 'process-started')).toHaveLength(1)
        const state = await readRunnerState()
        await waitFor(async () => Boolean(state?.runnerLogPath
            && (await readFile(state.runnerLogPath, 'utf8')).includes('Injected integration acknowledgement loss after durable webhook settlement')))
    })

    it('returns non-2xx for an exact pre-commit webhook and settles it only after durable commit', { timeout: 30_000 }, async () => {
        await restartTestRunner({ webhookDelayMs: 6_000, managedCommitDelayMs: 5_000 })
        const requestId = randomUUID()
        const initialRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        })
        const [created] = await waitForFixtureEvents('session-created', 1)
        const early = await runnerPost('/session-started', {
            sessionId: created.sessionId!,
            metadata: {
                path: contract.workspace,
                host: 'integration-host',
                homeDir: contract.workspace,
                happyHomeDir: configuration.happyHomeDir,
                happyLibDir: contract.workspace,
                happyToolsDir: contract.workspace,
                hostPid: created.pid,
                startedBy: 'runner',
                machineId: 'integration-machine',
                launchNonce: created.launchNonce,
                runnerInstanceId: created.runnerInstanceId
            }
        })

        expect(early.status).toBeGreaterThanOrEqual(500)
        const initial = await initialRequest
        expect(initial.body).toEqual(expect.objectContaining({ success: true, sessionId: created.sessionId }))
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'success',
            sessionId: created.sessionId
        })
        const events = await readFixtureEvents()
        expect(events.filter((event) => event.event === 'process-started')).toHaveLength(1)
        expect(events.filter((event) => event.event === 'session-created')).toHaveLength(1)
    })

    it('adopts an immediately reporting predecessor pre-commit child in mode off and fully settles its stop', { timeout: 45_000 }, async () => {
        await writeFile(join(configuration.happyHomeDir, 'runner-reconcile.json'), JSON.stringify({
            version: 1,
            mode: 'off',
            killSwitch: false,
            allowedWorkspaceRoots: []
        }), { mode: 0o600 })
        await restartTestRunner({ managedCommitDelayMs: 30_000 })
        const requestId = randomUUID()
        const abandonedRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        }).catch(() => null)
        const [created] = await waitForFixtureEvents('session-created', 1)

        await crashTestRunner()
        await startTestRunner()
        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'success', 20_000, 100)

        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'success',
            sessionId: created.sessionId
        })
        const events = await readFixtureEvents()
        expect(events.filter((event) => event.event === 'process-started')).toHaveLength(1)
        expect(events.filter((event) => event.event === 'session-created')).toHaveLength(1)
        expect(events.filter((event) => event.event === 'webhook-reported')).toHaveLength(1)
        expect(await stopRunnerSession(created.sessionId!)).toBe(true)
        await waitFor(async () => {
            const launch = (await readOwnershipJournal()).launches[created.launchNonce!]
            const request = await readSpawnRequestRecord(requestId)
            return launch?.lifecycle === 'stopped'
                && typeof launch.processGroupProvenEmptyAt === 'string'
                && typeof request?.reclaimableAt === 'number'
        })
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'success',
            sessionId: created.sessionId
        })
        await abandonedRequest
    })

    it('settles an adopted pending child that exits before its delayed webhook', { timeout: 50_000 }, async () => {
        await writeFile(join(configuration.happyHomeDir, 'runner-reconcile.json'), JSON.stringify({
            version: 1,
            mode: 'off',
            killSwitch: false,
            allowedWorkspaceRoots: []
        }), { mode: 0o600 })
        await restartTestRunner({ webhookDelayMs: 30_000, managedCommitDelayMs: 30_000 })
        const requestId = randomUUID()
        const abandonedRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        }).catch(() => null)
        const [created] = await waitForFixtureEvents('session-created', 1)

        await crashTestRunner()
        await startTestRunner({ heartbeatIntervalMs: 100 })
        await waitFor(async () => {
            const launch = (await readOwnershipJournal()).launches[created.launchNonce!]
            const request = await readSpawnRequestRecord(requestId)
            return launch?.lifecycle === 'spawned'
                && launch.pid === created.pid
                && request?.pid === created.pid
        })
        await signalExactFixtureProcess(created, 'SIGKILL')
        await waitFor(() => !isProcessAlive(created.pid), 5_000)
        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'error', 8_000, 100)

        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'error',
            errorMessage: expect.stringContaining(`launch ${created.launchNonce}`)
        })
        expect((await readOwnershipJournal()).launches[created.launchNonce!]).toEqual(expect.objectContaining({
            lifecycle: 'stopped',
            processGroupProvenEmptyAt: expect.any(String)
        }))
        await abandonedRequest
    })

    it('terminalizes a post-commit dead child non-destructively while reconciliation mode is off', { timeout: 45_000 }, async () => {
        await writeFile(join(configuration.happyHomeDir, 'runner-reconcile.json'), JSON.stringify({
            version: 1,
            mode: 'off',
            killSwitch: false,
            allowedWorkspaceRoots: []
        }), { mode: 0o600 })
        await restartTestRunner({ webhookDelayMs: 30_000 })
        const requestId = randomUUID()
        const abandonedRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        }).catch(() => null)
        const [created] = await waitForFixtureEvents('session-created', 1)
        await waitFor(async () => (await readOwnershipJournal()).launches[created.launchNonce!]?.lifecycle === 'spawned')

        await crashTestRunner()
        await signalExactFixtureProcess(created, 'SIGKILL')
        await waitFor(() => !isProcessAlive(created.pid), 5_000)
        await startTestRunner({ heartbeatIntervalMs: 100 })

        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'error', 8_000, 100)
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'error',
            errorMessage: 'Managed spawn ended before session registration after Runner restart'
        })
        expect((await readOwnershipJournal()).launches[created.launchNonce!]).toEqual(expect.objectContaining({
            lifecycle: 'stopped',
            processGroupProvenEmptyAt: expect.any(String)
        }))
        await abandonedRequest
    })

    it('terminalizes an exact fast child exit after pre-commit kernel identity failure without persisting its PID', { timeout: 30_000 }, async () => {
        await restartTestRunner({ commitIdentityFailures: 1, exitBeforeWebhook: true, heartbeatIntervalMs: 100 })
        const requestId = randomUUID()
        const initial = await runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        })
        const [started] = await waitForFixtureEvents('process-started', 1)
        await waitFor(() => !isProcessAlive(started.pid), 5_000)
        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'error', 8_000, 100)

        expect([202, 500]).toContain(initial.status)
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'error',
            errorMessage: expect.any(String)
        })
        expect(await readSpawnRequestRecord(requestId)).not.toHaveProperty('pid')
        expect((await readFixtureEvents()).filter((event) => event.event === 'process-started')).toHaveLength(1)
    })

    it('keeps post-commit lifecycle settlement active after PID attachment bookkeeping fails', { timeout: 30_000 }, async () => {
        await restartTestRunner({ webhookDelayMs: 10_000, attachPidFailures: 1 })
        const requestId = randomUUID()
        const initialRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        })
        const [started] = await waitForFixtureEvents('process-started', 1)
        const initial = await Promise.race([
            initialRequest,
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('spawn did not return pending after injected bookkeeping failure')), 3_000))
        ])
        expect(initial.status).toBe(202)
        expect(initial.body).toEqual({ success: false, pending: true, spawnRequestId: requestId })

        await waitForFixtureEvents('lifecycle-ready', 1)
        await signalExactFixtureProcess(started, 'SIGTERM')
        const [stopped] = await waitForFixtureEvents('process-stopped', 1)
        expect(stopped).toEqual(expect.objectContaining({
            pid: started.pid,
            signal: 'SIGTERM',
            birthToken: started.birthToken,
            pgid: started.pgid,
            executableRealpath: started.executableRealpath
        }))
        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'error', 8_000, 100)
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'error',
            errorMessage: expect.stringContaining(`PID ${started.pid}`)
        })
    })

    it('rejects a conflicting payload for an existing spawn request ID', async () => {
        const requestId = randomUUID()
        const otherWorkspace = join(configuration.happyHomeDir, 'other-workspace')
        await mkdir(otherWorkspace, { recursive: true })
        const first = await spawnRunnerSession(contract.workspace, undefined, requestId)
        const conflict = await spawnRunnerSession(otherWorkspace, undefined, requestId)
        expect(first.success).toBe(true)
        expect(conflict.success).not.toBe(true)
        expect(conflict.error).toContain('HTTP 500')
        expect((await readFixtureEvents()).filter((event) => event.event === 'process-started')).toHaveLength(1)
    })

    it('keeps a 16.5 second webhook delay pending and queryable with one child', { timeout: 50_000 }, async () => {
        await restartTestRunner({ webhookDelayMs: 16_500 })
        const requestId = randomUUID()
        const startedAt = Date.now()
        const initialRequest = runnerPost('/spawn-session', {
            spawnRequestId: requestId,
            directory: contract.workspace
        })
        const [started] = await waitForFixtureEvents('process-started', 1)
        const spoofedSessionId = 'spoofed-managed-session'
        const spoofed = await notifyRunnerSessionStarted(spoofedSessionId, {
            path: contract.workspace,
            host: 'integration-host',
            homeDir: contract.workspace,
            happyHomeDir: configuration.happyHomeDir,
            happyLibDir: contract.workspace,
            happyToolsDir: contract.workspace,
            hostPid: started.pid,
            startedBy: 'runner',
            machineId: 'integration-machine',
            launchNonce: randomUUID(),
            runnerInstanceId: started.runnerInstanceId
        })
        expect(spoofed).toEqual(expect.objectContaining({ error: expect.stringContaining('HTTP 500') }))
        expect(await queryRunnerSpawnSession(requestId)).toEqual({
            type: 'pending',
            spawnRequestId: requestId
        })
        expect((await listRunnerSessions()).some((session) => session.happySessionId === spoofedSessionId)).toBe(false)

        const initial = await initialRequest
        const elapsedMs = Date.now() - startedAt
        expect(initial.status).toBe(202)
        expect(initial.body).toEqual({ success: false, pending: true, spawnRequestId: requestId })
        expect(elapsedMs).toBeGreaterThanOrEqual(14_500)
        expect(elapsedMs).toBeLessThan(20_000)

        await waitFor(async () => (await queryRunnerSpawnSession(requestId)).type === 'success', 10_000, 100)
        const terminal = await queryRunnerSpawnSession(requestId)
        expect(terminal).toEqual({ type: 'success', sessionId: expect.any(String) })
        expect((await readFixtureEvents()).filter((event) => event.event === 'process-started')).toHaveLength(1)
        expect((await readFixtureEvents()).filter((event) => event.event === 'session-created')).toHaveLength(1)
        const hubSession = await hubGet(`/cli/sessions/${encodeURIComponent(terminal.sessionId)}`)
        expect((hubSession.session as { id: string }).id).toBe(terminal.sessionId)
    })

    it('spawns and stops twenty controlled sessions under load', { timeout: 90_000 }, async () => {
        const results = await Promise.all(Array.from({ length: 20 }, () => spawnRunnerSession(contract.workspace)))
        expect(failedSpawnMessages(results)).toEqual([])
        expect(new Set(results.map((result) => result.sessionId)).size).toBe(20)
        await waitFor(async () => (await listRunnerSessions()).length === 20, 20_000)
        for (const result of results) expect(await stopRunnerSession(result.sessionId)).toBe(true)
        await waitFor(async () => (await listRunnerSessions()).length === 0, 20_000)
    })

    it('handles three concurrent controlled session operations', async () => {
        const results = await Promise.all(Array.from({ length: 3 }, () => spawnRunnerSession(contract.workspace)))
        expect(results).toHaveLength(3)
        expect(failedSpawnMessages(results)).toEqual([])
        expect(new Set(results.map((result) => result.sessionId)).size).toBe(3)
        await waitFor(async () => (await listRunnerSessions()).length === 3)
    })

    it('refuses a second Runner while preserving the first owner', async () => {
        const original = await readRunnerState()
        const second = spawn('bun', ['src/index.ts', 'runner', 'start-sync'], {
            cwd: projectPath(),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                NODE_ENV: 'test',
                HAPI_INVOKED_CWD: contract.workspace,
                HAPI_RUNNER_SUPERVISED: 'foreground'
            }
        })
        const exit = await waitForExit(second)
        const current = await readRunnerState()
        expect(exit).toEqual({ code: 0, signal: null })
        expect(current?.pid).toBe(original?.pid)
        expect(current?.pid && isProcessAlive(current.pid)).toBe(true)
    })

    it('leaves diagnostic state and logs after an exact test Runner SIGKILL', async () => {
        const state = await readRunnerState()
        expect(state?.pid).toBe(runnerProcess?.pid)
        expect(state?.runnerLogPath && existsSync(state.runnerLogPath)).toBe(true)
        process.kill(state!.pid, 'SIGKILL')
        const child = runnerProcess!
        const exit = await waitForExit(child)
        expect(exit.signal).toBe('SIGKILL')
        expect(await readRunnerState()).not.toBeNull()
        expect(await readFile(state!.runnerLogPath!, 'utf8')).toContain('Runner state written')
        runnerProcess = null
        await clearRunnerState()
    })

    it('writes cleanup evidence and removes state after graceful SIGTERM', async () => {
        const state = await readRunnerState()
        process.kill(state!.pid, 'SIGTERM')
        const child = runnerProcess!
        const exit = await waitForExit(child, 15_000)
        expect(exit).toEqual({ code: 0, signal: null })
        await waitFor(() => !existsSync(configuration.runnerStateFile))
        const log = await readFile(state!.runnerLogPath!, 'utf8')
        expect(log).toContain('Received SIGTERM')
        expect(log).toContain('Cleanup completed')
        runnerProcess = null
    })
})
