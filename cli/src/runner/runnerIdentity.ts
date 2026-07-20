import { createHash } from 'node:crypto'
import type { RunnerLocallyPersistedState } from '@/persistence'

export type RunnerConnectionIdentity = {
    apiUrl: string
    machineId?: string
    cliApiTokenHash?: string
    extraHeadersHash?: string
}

export function hashRunnerCliApiToken(token: string | null | undefined): string | undefined {
    const trimmed = token?.trim()
    if (!trimmed) {
        return undefined
    }
    return createHash('sha256').update(trimmed).digest('hex')
}

export function hashRunnerExtraHeaders(
    headers: Readonly<Record<string, string>> | null | undefined
): string | undefined {
    const entries = Object.entries(headers ?? {})
    if (entries.length === 0) {
        return undefined
    }

    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    return createHash('sha256').update(JSON.stringify(entries)).digest('hex')
}

export function isRunnerStateCompatibleWithIdentity(
    state: Pick<
        RunnerLocallyPersistedState,
        | 'startedWithApiUrl'
        | 'startedWithMachineId'
        | 'startedWithCliApiTokenHash'
        | 'startedWithExtraHeadersHash'
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

    if (state.startedWithExtraHeadersHash !== current.extraHeadersHash) {
        return false
    }

    return true
}
