import { useEffect, useMemo, useState } from 'react'

const SESSION_PROJECT_ORDER_STORAGE_KEY = 'hapi-session-project-order'

function readStoredProjectOrder(): string[] {
    if (typeof window === 'undefined' || typeof document === 'undefined') return []
    try {
        const value: unknown = JSON.parse(localStorage.getItem(SESSION_PROJECT_ORDER_STORAGE_KEY) ?? '[]')
        return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
    } catch {
        return []
    }
}

function writeStoredProjectOrder(order: string[]): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return
    try {
        localStorage.setItem(SESSION_PROJECT_ORDER_STORAGE_KEY, JSON.stringify(order))
    } catch {
        // Ignore storage errors.
    }
}

export function sortSessionGroupsBySessionCount<T extends { key: string; sessions: readonly unknown[] }>(
    groups: readonly T[],
    projectOrder: readonly string[],
    totalSessionCounts?: ReadonlyMap<string, number>
): T[] {
    const rank = new Map(projectOrder.map((key, index) => [key, index]))
    return [...groups].sort((a, b) => {
        const countA = totalSessionCounts?.get(a.key) ?? a.sessions.length
        const countB = totalSessionCounts?.get(b.key) ?? b.sessions.length
        const countDifference = countB - countA
        if (countDifference !== 0) return countDifference

        const rankA = rank.get(a.key)
        const rankB = rank.get(b.key)
        if (rankA !== undefined || rankB !== undefined) {
            return (rankA ?? Number.MAX_SAFE_INTEGER) - (rankB ?? Number.MAX_SAFE_INTEGER)
        }
        return a.key.localeCompare(b.key)
    })
}

/**
 * Registers projects in first-seen order and returns an effective order that
 * also places newly discovered projects after existing ones immediately.
 */
export function useSessionProjectOrder(projectKeys: readonly string[]): readonly string[] {
    const [storedOrder, setStoredOrder] = useState<string[]>(readStoredProjectOrder)

    useEffect(() => {
        setStoredOrder((previous) => {
            const known = new Set(previous)
            const additions = projectKeys.filter((key) => !known.has(key))
            if (additions.length === 0) return previous
            const next = [...previous, ...additions]
            writeStoredProjectOrder(next)
            return next
        })
    }, [projectKeys])

    return useMemo(() => {
        const known = new Set(storedOrder)
        const additions = projectKeys.filter((key) => !known.has(key))
        return additions.length === 0 ? storedOrder : [...storedOrder, ...additions]
    }, [projectKeys, storedOrder])
}
