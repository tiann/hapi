import type { Machine, SessionSummary } from '@/types/api'

export type SessionGroup = {
    key: string
    directory: string
    displayName: string
    machineLabel: string | null
    sessions: SessionSummary[]
    latestUpdatedAt: number
    hasActiveSession: boolean
}

function getGroupDisplayName(directory: string): string {
    if (directory === 'Other') return directory
    const parts = directory.split(/[\\/]+/).filter(Boolean)
    if (parts.length === 0) return directory
    if (parts.length === 1) return parts[0]
    return `${parts[parts.length - 2]}/${parts[parts.length - 1]}`
}

export function getMachineLabel(machineId: string | undefined, machinesById: ReadonlyMap<string, Machine>): string | null {
    if (!machineId) return null

    const machine = machinesById.get(machineId)
    const displayName = machine?.metadata?.displayName?.trim()
    if (displayName) return displayName

    const host = machine?.metadata?.host?.trim()
    if (host) return host

    return machineId.slice(0, 8)
}

export function groupSessionsByDirectory(
    sessions: SessionSummary[],
    machinesById: ReadonlyMap<string, Machine>
): SessionGroup[] {
    const groups = new Map<string, { directory: string; machineLabel: string | null; sessions: SessionSummary[] }>()

    sessions.forEach(session => {
        const path = session.metadata?.worktree?.basePath ?? session.metadata?.path ?? 'Other'
        const machineId = session.metadata?.machineId
        const machineLabel = getMachineLabel(machineId, machinesById)
        const groupKey = `${machineId ?? 'unknown'}::${path}`
        if (!groups.has(groupKey)) {
            groups.set(groupKey, {
                directory: path,
                machineLabel,
                sessions: [],
            })
        }
        groups.get(groupKey)!.sessions.push(session)
    })

    return Array.from(groups.entries())
        .map(([key, group]) => {
            const sortedSessions = [...group.sessions].sort((a, b) => {
                const rankA = a.active ? (a.pendingRequestsCount > 0 ? 0 : 1) : 2
                const rankB = b.active ? (b.pendingRequestsCount > 0 ? 0 : 1) : 2
                if (rankA !== rankB) return rankA - rankB
                return b.updatedAt - a.updatedAt
            })
            const latestUpdatedAt = group.sessions.reduce(
                (max, s) => (s.updatedAt > max ? s.updatedAt : max),
                -Infinity
            )
            const hasActiveSession = group.sessions.some(s => s.active)
            const displayName = getGroupDisplayName(group.directory)

            return {
                key,
                directory: group.directory,
                displayName,
                machineLabel: group.machineLabel,
                sessions: sortedSessions,
                latestUpdatedAt,
                hasActiveSession,
            }
        })
        .sort((a, b) => {
            if (a.hasActiveSession !== b.hasActiveSession) {
                return a.hasActiveSession ? -1 : 1
            }
            return b.latestUpdatedAt - a.latestUpdatedAt
        })
}
