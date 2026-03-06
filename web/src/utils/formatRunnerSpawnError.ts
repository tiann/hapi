import type { Machine } from '../types/api'

export function formatRunnerSpawnError(machine: Machine | null): string | null {
    const lastSpawnError = machine?.runnerState?.lastSpawnError
    if (!lastSpawnError?.message) {
        return null
    }

    const at = typeof lastSpawnError.at === 'number'
        ? new Date(lastSpawnError.at).toLocaleString()
        : null
    return at
        ? `${lastSpawnError.message} (${at})`
        : lastSpawnError.message
}
