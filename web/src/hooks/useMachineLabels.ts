import { useEffect, useMemo } from 'react'
import type { Machine } from '@/types/api'

export function getMachineTitle(machine: Machine): string {
    if (machine.metadata?.displayName) return machine.metadata.displayName
    if (machine.metadata?.host) return machine.metadata.host
    return machine.id.slice(0, 8)
}

const STORAGE_KEY = 'hapi-machine-labels'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function readCachedLabels(): Record<string, string> {
    if (!isBrowser()) return {}
    try {
        const raw = localStorage.getItem(STORAGE_KEY)
        if (!raw) return {}
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
        const labels: Record<string, string> = {}
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value === 'string' && value.length > 0) {
                labels[key] = value
            }
        }
        return labels
    } catch {
        return {}
    }
}

function writeCachedLabels(labels: Record<string, string>): void {
    if (!isBrowser()) return
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(labels))
    } catch {
        // Ignore storage errors
    }
}

/**
 * Machine id → display label for the session list. Live data from the
 * machines query wins, but labels are also cached in localStorage so a
 * machine whose row is gone (reinstalled CLI, stale sessions) or whose
 * query has not loaded yet keeps its last known name instead of falling
 * back to a raw id prefix.
 */
export function useMachineLabels(machines: Machine[]): Record<string, string> {
    const labels = useMemo(() => {
        const merged = readCachedLabels()
        for (const machine of machines) {
            merged[machine.id] = getMachineTitle(machine)
        }
        return merged
    }, [machines])

    useEffect(() => {
        writeCachedLabels(labels)
    }, [labels])

    return labels
}
