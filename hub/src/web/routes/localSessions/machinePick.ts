import type { Machine, SyncEngine } from '../../../sync/syncEngine'

/**
 * Machine selection for local-session imports: requested machine
 * (must be online) -> the unique online machine owning the cwd -> first
 * online machine. The temporary `requestedOrFirst` mode keeps the previous
 * Pi/OpenCode route behavior until commit 4a switches them.
 */

export type MachinePickMode = 'requestedOrFirst' | 'requestedOrCwdOwnerOrFirst'

function normalizeComparablePath(pathValue: string, options?: { caseInsensitive?: boolean }): string {
    let normalized = pathValue.trim().replace(/\\/g, '/').replace(/\/+/g, '/')
    if (normalized.length > 1) {
        normalized = normalized.replace(/\/+$/, '')
    }
    return options?.caseInsensitive ? normalized.toLowerCase() : normalized
}

function shouldCompareCaseInsensitive(...pathValues: string[]): boolean {
    return pathValues.some((pathValue) => /^[a-z]:[\\/]/i.test(pathValue) || pathValue.includes('\\'))
}

function machineOwnsCwd(machine: Machine, cwd: string): boolean {
    const workspaceRoots = machine.metadata?.workspaceRoots ?? []
    if (workspaceRoots.length === 0 || !cwd.trim()) return false
    const caseInsensitive = shouldCompareCaseInsensitive(cwd, ...workspaceRoots)
    const path = normalizeComparablePath(cwd, { caseInsensitive })
    if (!path) return false
    return workspaceRoots.some((root) => {
        const normalizedRoot = normalizeComparablePath(root, { caseInsensitive })
        if (!normalizedRoot) return false
        if (path === normalizedRoot) return true
        if (normalizedRoot === '/') return path.startsWith('/')
        return path.startsWith(`${normalizedRoot}/`)
    })
}

export function pickImportMachine(options: {
    engine: SyncEngine | null
    namespace: string
    requestedMachineId?: string | null
    cwd?: string | null
    mode?: MachinePickMode
}): Machine | null {
    const { engine, namespace } = options
    if (!engine) return null
    const online = engine.getOnlineMachinesByNamespace(namespace)
    if (options.requestedMachineId) {
        const requested = online.find((machine) => machine.id === options.requestedMachineId)
        if (!requested) return null
        return requested
    }
    if (options.mode !== 'requestedOrFirst' && options.cwd) {
        const requestedCwd = options.cwd.trim()
        if (requestedCwd) {
            const owners = online.filter((candidate) => machineOwnsCwd(candidate, requestedCwd))
            const ownerIds = Array.from(new Set(owners.map((candidate) => candidate.id)))
            if (ownerIds.length === 1) {
                return owners.find((candidate) => candidate.id === ownerIds[0]) ?? null
            }
        }
    }
    return online[0] ?? null
}