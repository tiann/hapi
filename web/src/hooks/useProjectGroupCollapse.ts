import { useCallback, useState } from 'react'

const STORAGE_PREFIX = 'hapi.projectGroupCollapse.v1.'
const MAX_SAVED_GROUPS = 2000

// Decode only stable identity claims, never store the JWT or access token.
// This partitions a display preference; authentication remains the Hub's job.
export function getProjectGroupCollapseStorageKey(baseUrl: string, token: string): string | null {
    try {
        const payload = token.split('.')[1]
        if (!payload) return null
        const base64 = payload.replace(/-/g, '+').replace(/_/g, '/')
        const bytes = Uint8Array.from(atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')), c => c.charCodeAt(0))
        const claims: unknown = JSON.parse(new TextDecoder().decode(bytes))
        if (!claims || typeof claims !== 'object') return null
        const { uid, ns } = claims as { uid?: unknown; ns?: unknown }
        if (typeof uid !== 'number' || !Number.isFinite(uid) || typeof ns !== 'string') return null
        const hubUrl = new URL(baseUrl)
        hubUrl.hash = ''
        hubUrl.search = ''
        const hub = hubUrl.toString().replace(/\/+$/, '')
        return STORAGE_PREFIX + JSON.stringify([hub, uid, ns])
    } catch {
        return null
    }
}

function readOverrides(key: string | null): Map<string, boolean> {
    try {
        if (!key) return new Map()
        const parsed: unknown = JSON.parse(localStorage.getItem(key) ?? 'null')
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Map()
        return new Map(Object.entries(parsed)
            .filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean')
            .slice(-MAX_SAVED_GROUPS))
    } catch {
        return new Map()
    }
}

function loadState(storageKey: string | null) {
    const manual = readOverrides(storageKey)
    return { storageKey, manual, overrides: manual }
}

export function useProjectGroupCollapse(storageKey: string | null) {
    const [state, setState] = useState(() => loadState(storageKey))
    // Restore the new identity before rendering it; never expose or write the
    // previous Hub/user's choices under the new storage key.
    if (state.storageKey !== storageKey) {
        setState(loadState(storageKey))
    }

    const setManualCollapse = (groupKey: string, collapsed: boolean) => {
        const manual = new Map(state.manual)
        manual.delete(groupKey)
        manual.set(groupKey, collapsed)
        // Keep absent projects (loading/filtering can hide them), but bound
        // storage growth as users visit new directories over time.
        if (manual.size > MAX_SAVED_GROUPS) manual.delete(manual.keys().next().value!)
        const overrides = new Map(state.overrides)
        overrides.set(groupKey, collapsed)
        setState({ storageKey, manual, overrides })
        try {
            if (storageKey) localStorage.setItem(storageKey, JSON.stringify(Object.fromEntries(manual)))
        } catch {
            // A blocked/full store must not prevent in-memory toggles.
        }
    }

    const revealGroup = useCallback((groupKey: string) => {
        setState(previous => {
            if (previous.overrides.get(groupKey) === false) return previous
            const overrides = new Map(previous.overrides)
            overrides.set(groupKey, false)
            return { ...previous, overrides }
        })
    }, [])

    return { collapseOverrides: state.overrides, setManualCollapse, revealGroup }
}
