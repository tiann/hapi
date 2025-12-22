import { useCallback, useMemo, useState } from 'react'

const STORAGE_KEY = 'hapi:recentPaths'
const MAX_PATHS_PER_MACHINE = 5

type RecentPathsData = Record<string, string[]>

function loadRecentPaths(): RecentPathsData {
    try {
        const stored = localStorage.getItem(STORAGE_KEY)
        return stored ? JSON.parse(stored) : {}
    } catch {
        return {}
    }
}

function saveRecentPaths(data: RecentPathsData): void {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
    } catch {
        // Ignore storage errors
    }
}

export function useRecentPaths() {
    const [data, setData] = useState<RecentPathsData>(loadRecentPaths)

    const getRecentPaths = useCallback((machineId: string | null): string[] => {
        if (!machineId) return []
        return data[machineId] ?? []
    }, [data])

    const addRecentPath = useCallback((machineId: string, path: string): void => {
        const trimmed = path.trim()
        if (!trimmed) return

        setData((prev) => {
            const existing = prev[machineId] ?? []
            // Remove if already exists, then add to front
            const filtered = existing.filter((p) => p !== trimmed)
            const updated = [trimmed, ...filtered].slice(0, MAX_PATHS_PER_MACHINE)

            const newData = { ...prev, [machineId]: updated }
            saveRecentPaths(newData)
            return newData
        })
    }, [])

    const getLastUsedMachineId = useCallback((): string | null => {
        try {
            return localStorage.getItem('hapi:lastMachineId')
        } catch {
            return null
        }
    }, [])

    const setLastUsedMachineId = useCallback((machineId: string): void => {
        try {
            localStorage.setItem('hapi:lastMachineId', machineId)
        } catch {
            // Ignore storage errors
        }
    }, [])

    return useMemo(() => ({
        getRecentPaths,
        addRecentPath,
        getLastUsedMachineId,
        setLastUsedMachineId,
    }), [getRecentPaths, addRecentPath, getLastUsedMachineId, setLastUsedMachineId])
}
