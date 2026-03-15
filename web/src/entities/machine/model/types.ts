export type RunnerState = {
    status?: string
    pid?: number
    httpPort?: number
    startedAt?: number
    shutdownRequestedAt?: number
    shutdownSource?: string
    lastSpawnError?: {
        message: string
        pid?: number
        exitCode?: number | null
        signal?: string | null
        at: number
    } | null
}

export type Machine = {
    id: string
    active: boolean
    metadata: {
        host: string
        platform: string
        happyCliVersion: string
        displayName?: string
    } | null
    runnerState?: RunnerState | null
}

export type MachinesResponse = { machines: Machine[] }

export type MachinePathsExistsResponse = { exists: Record<string, boolean> }
