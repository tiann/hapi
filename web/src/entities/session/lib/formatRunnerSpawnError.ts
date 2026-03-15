type LastSpawnError = {
    message: string
    pid?: number
    exitCode?: number | null
    signal?: string | null
    at: number
} | null

type MachineWithRunnerState = {
    runnerState?: {
        lastSpawnError?: LastSpawnError
    } | null
} | null

export function formatRunnerSpawnError(machine: MachineWithRunnerState): string | null {
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
