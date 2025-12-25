import { useCallback, useMemo, useState } from 'react'

const SERVER_URL_KEY = 'hapi_server_url'

export type ServerUrlResult =
    | { ok: true; value: string }
    | { ok: false; error: string }

export function normalizeServerUrl(input: string): ServerUrlResult {
    const trimmed = input.trim()
    if (!trimmed) {
        return { ok: false, error: 'Enter a server URL like https://example.com' }
    }

    let parsed: URL
    try {
        parsed = new URL(trimmed)
    } catch {
        return { ok: false, error: 'Enter a valid URL including http:// or https://' }
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return { ok: false, error: 'Server URL must start with http:// or https://' }
    }

    return { ok: true, value: parsed.origin }
}

function readStoredServerUrl(): string | null {
    try {
        const stored = localStorage.getItem(SERVER_URL_KEY)
        if (!stored) {
            return null
        }
        const normalized = normalizeServerUrl(stored)
        if (!normalized.ok) {
            localStorage.removeItem(SERVER_URL_KEY)
            return null
        }
        return normalized.value
    } catch {
        return null
    }
}

function writeStoredServerUrl(value: string): void {
    try {
        localStorage.setItem(SERVER_URL_KEY, value)
    } catch {
        // Ignore storage errors
    }
}

function clearStoredServerUrl(): void {
    try {
        localStorage.removeItem(SERVER_URL_KEY)
    } catch {
        // Ignore storage errors
    }
}

export function useServerUrl(): {
    serverUrl: string | null
    baseUrl: string
    setServerUrl: (input: string) => ServerUrlResult
    clearServerUrl: () => void
} {
    const [serverUrl, setServerUrlState] = useState<string | null>(() => readStoredServerUrl())

    const fallbackOrigin = typeof window !== 'undefined' ? window.location.origin : ''
    const baseUrl = useMemo(() => serverUrl ?? fallbackOrigin, [serverUrl, fallbackOrigin])

    const setServerUrl = useCallback((input: string): ServerUrlResult => {
        const normalized = normalizeServerUrl(input)
        if (!normalized.ok) {
            return normalized
        }
        writeStoredServerUrl(normalized.value)
        setServerUrlState(normalized.value)
        return normalized
    }, [])

    const clearServerUrl = useCallback(() => {
        clearStoredServerUrl()
        setServerUrlState(null)
    }, [])

    return {
        serverUrl,
        baseUrl,
        setServerUrl,
        clearServerUrl
    }
}
