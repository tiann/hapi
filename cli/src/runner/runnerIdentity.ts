import { createHash } from 'node:crypto'
import type { RunnerLocallyPersistedState } from '@/persistence'

export type RunnerConnectionIdentity = {
    apiUrl: string
    machineId?: string
    cliApiTokenHash?: string
}

export function hashRunnerCliApiToken(token: string | null | undefined): string | undefined {
    const trimmed = token?.trim()
    if (!trimmed) {
        return undefined
    }
    return createHash('sha256').update(trimmed).digest('hex')
}

export function isRunnerStateCompatibleWithIdentity(
    state: Pick<
        RunnerLocallyPersistedState,
        'startedWithApiUrl' | 'startedWithMachineId' | 'startedWithCliApiTokenHash'
    >,
    current: RunnerConnectionIdentity
): boolean {
    if (!state.startedWithApiUrl || state.startedWithApiUrl !== current.apiUrl) {
        return false
    }

    if (!current.machineId || state.startedWithMachineId !== current.machineId) {
        return false
    }

    if (!current.cliApiTokenHash || state.startedWithCliApiTokenHash !== current.cliApiTokenHash) {
        return false
    }

    return true
}
