import { useCallback, useSyncExternalStore } from 'react'

export const DEFAULT_REASONING_COLLAPSED = false

const REASONING_COLLAPSED_STORAGE_KEY = 'hapi-reasoning-collapsed'

function isBrowser(): boolean {
    return typeof window !== 'undefined' && typeof document !== 'undefined'
}

function safeGetItem(): string | null {
    if (!isBrowser()) return null
    try {
        return localStorage.getItem(REASONING_COLLAPSED_STORAGE_KEY)
    } catch {
        return null
    }
}

// Persist best-effort. Returns whether the write succeeded so callers can
// keep the in-memory override when storage is unavailable or quota-limited.
function persistPreference(value: boolean): boolean {
    if (!isBrowser()) return false
    try {
        if (value === DEFAULT_REASONING_COLLAPSED) {
            localStorage.removeItem(REASONING_COLLAPSED_STORAGE_KEY)
        } else {
            localStorage.setItem(REASONING_COLLAPSED_STORAGE_KEY, String(value))
        }
        return true
    } catch {
        return false
    }
}

function parseReasoningCollapsed(raw: string | null): boolean {
    if (raw === 'true') return true
    if (raw === 'false') return false
    return DEFAULT_REASONING_COLLAPSED
}

export function getInitialReasoningCollapsed(): boolean {
    return parseReasoningCollapsed(safeGetItem())
}

// ── Module-level singleton store ────────────────────────────────────────────
// ReasoningGroup mounts once per reasoning card, and the chat window keeps
// hundreds of cards (message-window-store.ts). Mounting a window `storage`
// listener per card would fan out to hundreds of listeners, so the
// subscription lives here at module scope: one listener total, and every hook
// instance reads the same shared snapshot.

let currentCollapsed = DEFAULT_REASONING_COLLAPSED
// True while a persistence failure left the in-memory value diverging from
// storage. New subscriptions must not resync over it until a real cross-tab
// storage event arrives.
let hasUnpersistedOverride = false
const listeners = new Set<() => void>()

function syncFromStorage(): void {
    const next = parseReasoningCollapsed(safeGetItem())
    if (next === currentCollapsed) return
    currentCollapsed = next
    for (const listener of listeners) listener()
}

// Update the shared snapshot and notify subscribers. Used by the setter so
// the preference stays functional in memory even when persistence fails
// (e.g. storage unavailable or quota exceeded).
function setCurrentCollapsed(value: boolean): void {
    if (value === currentCollapsed) return
    currentCollapsed = value
    for (const listener of listeners) listener()
}

function handleStorage(event: StorageEvent): void {
    if (event.key !== REASONING_COLLAPSED_STORAGE_KEY) return
    hasUnpersistedOverride = false
    syncFromStorage()
}

function subscribe(listener: () => void): () => void {
    // Re-read on every subscribe so fresh hook mounts (and tests) observe the
    // latest value — unless a persistence failure left an in-memory override
    // that storage does not reflect yet.
    if (!hasUnpersistedOverride) {
        syncFromStorage()
    }
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
    return currentCollapsed
}

export function useReasoningCollapse(): {
    reasoningCollapsed: boolean
    setReasoningCollapsed: (value: boolean) => void
} {
    const reasoningCollapsed = useSyncExternalStore(
        subscribe,
        getSnapshot,
        () => DEFAULT_REASONING_COLLAPSED,
    )

    const setReasoningCollapsed = useCallback((value: boolean) => {
        hasUnpersistedOverride = !persistPreference(value)
        setCurrentCollapsed(value)
    }, [])

    return { reasoningCollapsed, setReasoningCollapsed }
}
