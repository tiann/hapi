import { useCallback, useEffect, useState } from 'react'

export type SessionHeaderMetadataKey =
    | 'showLabels'
    | 'agent'
    | 'agentIcon'
    | 'model'
    | 'reasoning'
    | 'fastMode'
    | 'machine'
    | 'lastActive'
    | 'createdAt'
    | 'updatedAt'
    | 'worktree'

export type SessionHeaderMetadataPreferences = Record<SessionHeaderMetadataKey, boolean>

export const DEFAULT_SESSION_HEADER_METADATA: SessionHeaderMetadataPreferences = {
    showLabels: true,
    agent: true,
    agentIcon: true,
    model: true,
    reasoning: true,
    fastMode: true,
    machine: true,
    lastActive: true,
    createdAt: false,
    updatedAt: false,
    worktree: true,
}

const STORAGE_KEY = 'hapi-session-header-metadata'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

export function parseSessionHeaderMetadata(raw: string | null): SessionHeaderMetadataPreferences {
    if (!raw) return DEFAULT_SESSION_HEADER_METADATA

    try {
        const parsed: unknown = JSON.parse(raw)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            return DEFAULT_SESSION_HEADER_METADATA
        }

        const record = parsed as Record<string, unknown>
        // Preserve the pre-agentIcon preference for existing browsers: before
        // this field existed, `agent` controlled both the label and icon.
        if (typeof record.agentIcon !== 'boolean' && typeof record.agent === 'boolean') {
            record.agentIcon = record.agent
        }
        return Object.fromEntries(
            Object.entries(DEFAULT_SESSION_HEADER_METADATA).map(([key, fallback]) => [
                key,
                typeof record[key] === 'boolean' ? record[key] : fallback,
            ])
        ) as SessionHeaderMetadataPreferences
    } catch {
        return DEFAULT_SESSION_HEADER_METADATA
    }
}

function readPreferences(): SessionHeaderMetadataPreferences {
    if (!isBrowser()) return DEFAULT_SESSION_HEADER_METADATA
    try {
        return parseSessionHeaderMetadata(localStorage.getItem(STORAGE_KEY))
    } catch {
        return DEFAULT_SESSION_HEADER_METADATA
    }
}

function writePreferences(preferences: SessionHeaderMetadataPreferences): void {
    if (!isBrowser()) return
    try {
        if (Object.entries(DEFAULT_SESSION_HEADER_METADATA).every(([key, value]) => preferences[key as SessionHeaderMetadataKey] === value)) {
            localStorage.removeItem(STORAGE_KEY)
        } else {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(preferences))
        }
    } catch {
        // Ignore storage errors.
    }
}

export function useSessionHeaderMetadata(): {
    preferences: SessionHeaderMetadataPreferences
    setPreference: (key: SessionHeaderMetadataKey, value: boolean) => void
} {
    const [preferences, setPreferences] = useState<SessionHeaderMetadataPreferences>(readPreferences)

    useEffect(() => {
        if (!isBrowser()) return
        const onStorage = (event: StorageEvent) => {
            if (event.key === STORAGE_KEY) setPreferences(parseSessionHeaderMetadata(event.newValue))
        }
        window.addEventListener('storage', onStorage)
        return () => window.removeEventListener('storage', onStorage)
    }, [])

    const setPreference = useCallback((key: SessionHeaderMetadataKey, value: boolean) => {
        setPreferences((current) => {
            const next = { ...current, [key]: value }
            writePreferences(next)
            return next
        })
    }, [])

    return { preferences, setPreference }
}
