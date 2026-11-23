import { useCallback, useSyncExternalStore } from 'react'

export const DEFAULT_CONCISE_CHAT_MODE = false

const CONCISE_CHAT_MODE_STORAGE_KEY = 'hapi-concise-chat-mode'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(CONCISE_CHAT_MODE_STORAGE_KEY)
    } catch {
        return null
    }
}

function persistPreference(value: boolean): void {
    if (!isBrowser()) return
    try {
        if (value === DEFAULT_CONCISE_CHAT_MODE) {
            localStorage.removeItem(CONCISE_CHAT_MODE_STORAGE_KEY)
        } else {
            localStorage.setItem(CONCISE_CHAT_MODE_STORAGE_KEY, String(value))
        }
    } catch {
        // Keep the in-memory value when storage is unavailable.
    }
}

function parseConciseChatMode(raw: string | null): boolean {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return DEFAULT_CONCISE_CHAT_MODE
}

// One shared snapshot so the session header toggle, the chat thread and the
// settings page update together within a tab; `storage` covers other tabs.
let currentValue = parseConciseChatMode(safeGetItem())
const listeners = new Set<() => void>()

function setCurrentValue(value: boolean): void {
    if (value === currentValue) return
    currentValue = value
    for (const listener of listeners) listener()
}

function handleStorage(event: StorageEvent): void {
    if (event.key !== CONCISE_CHAT_MODE_STORAGE_KEY) return
    setCurrentValue(parseConciseChatMode(event.newValue))
}

function subscribe(listener: () => void): () => void {
    if (listeners.size === 0 && isBrowser()) {
        window.addEventListener('storage', handleStorage)
    }
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
        if (listeners.size === 0 && isBrowser()) {
            window.removeEventListener('storage', handleStorage)
        }
    }
}

function getSnapshot(): boolean {
    return currentValue
}

export function useConciseChatMode(): {
    conciseChatMode: boolean
    setConciseChatMode: (value: boolean) => void
} {
    const conciseChatMode = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_CONCISE_CHAT_MODE)

    const setConciseChatMode = useCallback((value: boolean) => {
        persistPreference(value)
        setCurrentValue(value)
    }, [])

    return { conciseChatMode, setConciseChatMode }
}
