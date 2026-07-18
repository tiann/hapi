import { readFile } from 'node:fs/promises'

import {
    waitForExactIntegrationFixtureProcess,
    type IntegrationFixtureProcessBinding
} from './integrationFixtureIdentity'

export type IntegrationFixtureCleanupResult = {
    startedPids: number[]
    invalidEntries: Array<{ line: number; pid?: number; reason: string }>
    cleanupErrors: Array<{
        pid?: number
        operation: 'liveness' | 'verify' | 'signal'
        code?: string
        reason: string
    }>
    termSignaled: number[]
    killSignaled: number[]
    mismatchedLivePids: number[]
    exactLivePids: number[]
}

type SignalResult = 'signaled' | 'gone'

function parseBinding(value: Record<string, unknown>): IntegrationFixtureProcessBinding | null {
    if (!Number.isSafeInteger(value.pid) || Number(value.pid) <= 0
        || !Number.isSafeInteger(value.pgid) || Number(value.pgid) <= 0
        || typeof value.birthToken !== 'string' || !value.birthToken
        || typeof value.executableRealpath !== 'string' || !value.executableRealpath.startsWith('/')
        || typeof value.launchNonce !== 'string' || !value.launchNonce
        || typeof value.runnerInstanceId !== 'string' || !value.runnerInstanceId) {
        return null
    }
    return {
        pid: Number(value.pid),
        pgid: Number(value.pgid),
        birthToken: value.birthToken,
        executableRealpath: value.executableRealpath,
        launchNonce: value.launchNonce,
        runnerInstanceId: value.runnerInstanceId
    }
}

function sameBinding(left: IntegrationFixtureProcessBinding, right: IntegrationFixtureProcessBinding): boolean {
    return left.pid === right.pid
        && left.pgid === right.pgid
        && left.birthToken === right.birthToken
        && left.executableRealpath === right.executableRealpath
        && left.launchNonce === right.launchNonce
        && left.runnerInstanceId === right.runnerInstanceId
}

async function readBindings(ledgerFile: string): Promise<{
    bindings: IntegrationFixtureProcessBinding[]
    invalidEntries: IntegrationFixtureCleanupResult['invalidEntries']
}> {
    const raw = await readFile(ledgerFile, 'utf8')
    const bindings = new Map<number, IntegrationFixtureProcessBinding>()
    const conflicted = new Set<number>()
    const invalidEntries: IntegrationFixtureCleanupResult['invalidEntries'] = []

    for (const [index, line] of raw.split('\n').entries()) {
        if (!line.trim()) continue
        let value: Record<string, unknown>
        try {
            const parsed = JSON.parse(line) as unknown
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
            value = parsed as Record<string, unknown>
        } catch {
            invalidEntries.push({ line: index + 1, reason: 'invalid JSON ledger entry' })
            continue
        }
        if (value.event !== 'process-started') {
            invalidEntries.push({
                line: index + 1,
                pid: Number.isSafeInteger(value.pid) ? Number(value.pid) : undefined,
                reason: 'unexpected ledger event'
            })
            continue
        }
        const binding = parseBinding(value)
        if (!binding) {
            invalidEntries.push({
                line: index + 1,
                pid: Number.isSafeInteger(value.pid) ? Number(value.pid) : undefined,
                reason: 'invalid process-started binding'
            })
            continue
        }
        if (conflicted.has(binding.pid)) {
            invalidEntries.push({ line: index + 1, pid: binding.pid, reason: 'PID has conflicting ledger bindings' })
            continue
        }
        const existing = bindings.get(binding.pid)
        if (existing && !sameBinding(existing, binding)) {
            bindings.delete(binding.pid)
            conflicted.add(binding.pid)
            invalidEntries.push({ line: index + 1, pid: binding.pid, reason: 'PID has conflicting ledger bindings' })
            continue
        }
        bindings.set(binding.pid, binding)
    }

    return { bindings: [...bindings.values()], invalidEntries }
}

function defaultIsAlive(pid: number): boolean {
    try {
        process.kill(pid, 0)
        return true
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
        throw error
    }
}

function cleanupError(
    pid: number,
    operation: IntegrationFixtureCleanupResult['cleanupErrors'][number]['operation'],
    error: unknown
): IntegrationFixtureCleanupResult['cleanupErrors'][number] {
    const candidate = error as NodeJS.ErrnoException
    return {
        pid,
        operation,
        code: typeof candidate?.code === 'string' ? candidate.code : undefined,
        reason: error instanceof Error ? error.message : String(error)
    }
}

export async function cleanupIntegrationFixtures(options: {
    ledgerFile: string
    isAlive?: (pid: number) => boolean
    verifyExact?: (binding: IntegrationFixtureProcessBinding) => Promise<'exact' | 'gone'>
    sendSignal?: (pid: number, signal: 'SIGTERM' | 'SIGKILL') => void
    sleep?: (delayMs: number) => Promise<void>
    termTimeoutMs?: number
    killTimeoutMs?: number
}): Promise<IntegrationFixtureCleanupResult> {
    const { bindings, invalidEntries } = await readBindings(options.ledgerFile)
    const isAlive = options.isAlive ?? defaultIsAlive
    const sleep = options.sleep ?? (async (delayMs: number) => {
        await new Promise((resolve) => setTimeout(resolve, delayMs))
    })
    const verifyExact = options.verifyExact ?? (async (binding) => (
        await waitForExactIntegrationFixtureProcess(binding) ? 'exact' : 'gone'
    ))
    const sendSignal = options.sendSignal ?? ((pid, signal) => { process.kill(pid, signal) })
    const termTimeoutMs = options.termTimeoutMs ?? 3_000
    const killTimeoutMs = options.killTimeoutMs ?? 2_000
    const result: IntegrationFixtureCleanupResult = {
        startedPids: bindings.map((binding) => binding.pid),
        invalidEntries,
        cleanupErrors: [],
        termSignaled: [],
        killSignaled: [],
        mismatchedLivePids: [],
        exactLivePids: []
    }

    const waitUntilGone = async (pid: number, timeoutMs: number): Promise<boolean> => {
        const deadline = Date.now() + timeoutMs
        while (isAlive(pid) && Date.now() < deadline) await sleep(Math.min(100, Math.max(0, deadline - Date.now())))
        return !isAlive(pid)
    }

    for (const binding of bindings) {
        let operation: IntegrationFixtureCleanupResult['cleanupErrors'][number]['operation'] = 'liveness'
        try {
            if (!isAlive(binding.pid)) continue
            const signalVerified = async (signal: 'SIGTERM' | 'SIGKILL'): Promise<SignalResult> => {
                operation = 'verify'
                if (await verifyExact(binding) === 'gone') return 'gone'
                operation = 'signal'
                try {
                    sendSignal(binding.pid, signal)
                    return 'signaled'
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return 'gone'
                    throw error
                }
            }
            if (await signalVerified('SIGTERM') === 'gone') continue
            result.termSignaled.push(binding.pid)
            operation = 'liveness'
            if (await waitUntilGone(binding.pid, termTimeoutMs)) continue
            if (await signalVerified('SIGKILL') === 'gone') continue
            result.killSignaled.push(binding.pid)
            operation = 'liveness'
            if (await waitUntilGone(binding.pid, killTimeoutMs)) continue
            operation = 'verify'
            if (await verifyExact(binding) === 'exact') result.exactLivePids.push(binding.pid)
        } catch (error) {
            result.cleanupErrors.push(cleanupError(binding.pid, operation, error))
            if (operation === 'liveness') continue
            try {
                if (isAlive(binding.pid)) result.mismatchedLivePids.push(binding.pid)
            } catch (livenessError) {
                result.cleanupErrors.push(cleanupError(binding.pid, 'liveness', livenessError))
            }
        }
    }

    result.mismatchedLivePids = [...new Set(result.mismatchedLivePids)]
    result.exactLivePids = [...new Set(result.exactLivePids)]
    return result
}

export function isCleanIntegrationFixtureCleanup(result: IntegrationFixtureCleanupResult): boolean {
    return result.invalidEntries.length === 0
        && result.cleanupErrors.length === 0
        && result.mismatchedLivePids.length === 0
        && result.exactLivePids.length === 0
}

export function hasExpectedTermKillReceipt(result: IntegrationFixtureCleanupResult, pid: number): boolean {
    return result.termSignaled.includes(pid) && result.killSignaled.includes(pid)
}
