import type { SessionManualOrder } from '@/types/api'

type Direction = 'up' | 'down'

type SortableSession = {
    id: string
}

type SortableGroup<TSession extends SortableSession = SortableSession> = {
    key: string
    sessions: TSession[]
}

export function createEmptyManualOrder(): SessionManualOrder {
    return {
        groupOrder: [],
        sessionOrder: {}
    }
}

export function snapshotManualOrder<TSession extends SortableSession, TGroup extends SortableGroup<TSession>>(
    groups: TGroup[]
): SessionManualOrder {
    const groupOrder = groups.map((group) => group.key)
    const sessionOrder: Record<string, string[]> = {}

    for (const group of groups) {
        sessionOrder[group.key] = group.sessions.map((session) => session.id)
    }

    return {
        groupOrder,
        sessionOrder
    }
}

export function reconcileManualOrder<TSession extends SortableSession, TGroup extends SortableGroup<TSession>>(
    groups: TGroup[],
    manualOrder: SessionManualOrder
): SessionManualOrder {
    const currentGroupKeys = groups.map((group) => group.key)
    const currentGroupKeySet = new Set(currentGroupKeys)

    const knownGroups = manualOrder.groupOrder.filter((groupKey) => currentGroupKeySet.has(groupKey))
    const knownGroupSet = new Set(knownGroups)
    const appendedGroups = currentGroupKeys.filter((groupKey) => !knownGroupSet.has(groupKey))

    const sessionOrder: Record<string, string[]> = {}

    for (const group of groups) {
        const currentSessionIds = group.sessions.map((session) => session.id)
        const currentSessionSet = new Set(currentSessionIds)
        const storedSessionOrder = manualOrder.sessionOrder[group.key] ?? []
        const knownSessions = storedSessionOrder.filter((sessionId) => currentSessionSet.has(sessionId))
        const knownSessionSet = new Set(knownSessions)
        const appendedSessions = currentSessionIds.filter((sessionId) => !knownSessionSet.has(sessionId))

        sessionOrder[group.key] = [...knownSessions, ...appendedSessions]
    }

    return {
        groupOrder: [...knownGroups, ...appendedGroups],
        sessionOrder
    }
}

export function applyManualOrder<TSession extends SortableSession, TGroup extends SortableGroup<TSession>>(
    groups: TGroup[],
    manualOrder: SessionManualOrder
): TGroup[] {
    const reconciled = reconcileManualOrder(groups, manualOrder)
    const groupIndex = new Map(reconciled.groupOrder.map((groupKey, index) => [groupKey, index]))

    return [...groups]
        .sort((groupA, groupB) => {
            const indexA = groupIndex.get(groupA.key) ?? Number.MAX_SAFE_INTEGER
            const indexB = groupIndex.get(groupB.key) ?? Number.MAX_SAFE_INTEGER
            return indexA - indexB
        })
        .map((group) => {
            const order = reconciled.sessionOrder[group.key] ?? []
            const sessionIndex = new Map(order.map((sessionId, index) => [sessionId, index]))
            const sessions = [...group.sessions].sort((sessionA, sessionB) => {
                const indexA = sessionIndex.get(sessionA.id) ?? Number.MAX_SAFE_INTEGER
                const indexB = sessionIndex.get(sessionB.id) ?? Number.MAX_SAFE_INTEGER
                return indexA - indexB
            })

            return {
                ...group,
                sessions
            }
        })
}

function swapAdjacent<T>(items: T[], index: number, direction: Direction): T[] {
    const targetIndex = direction === 'up' ? index - 1 : index + 1
    if (targetIndex < 0 || targetIndex >= items.length) {
        return items
    }

    const next = [...items]
    const current = next[index]
    next[index] = next[targetIndex] as T
    next[targetIndex] = current as T
    return next
}

export function moveGroup(
    manualOrder: SessionManualOrder,
    groupKey: string,
    direction: Direction
): SessionManualOrder {
    const currentIndex = manualOrder.groupOrder.indexOf(groupKey)
    if (currentIndex === -1) {
        return manualOrder
    }

    const nextGroupOrder = swapAdjacent(manualOrder.groupOrder, currentIndex, direction)
    if (nextGroupOrder === manualOrder.groupOrder) {
        return manualOrder
    }

    return {
        groupOrder: nextGroupOrder,
        sessionOrder: { ...manualOrder.sessionOrder }
    }
}

export function moveSession(
    manualOrder: SessionManualOrder,
    groupKey: string,
    sessionId: string,
    direction: Direction
): SessionManualOrder {
    const currentOrder = manualOrder.sessionOrder[groupKey]
    if (!currentOrder || currentOrder.length === 0) {
        return manualOrder
    }

    const currentIndex = currentOrder.indexOf(sessionId)
    if (currentIndex === -1) {
        return manualOrder
    }

    const nextOrder = swapAdjacent(currentOrder, currentIndex, direction)
    if (nextOrder === currentOrder) {
        return manualOrder
    }

    return {
        groupOrder: [...manualOrder.groupOrder],
        sessionOrder: {
            ...manualOrder.sessionOrder,
            [groupKey]: nextOrder
        }
    }
}
