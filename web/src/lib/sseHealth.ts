import { useSyncExternalStore } from 'react'

/**
 * Module-level SSE health store. App.tsx's SSE hooks write connection
 * transitions; the router's sessions query reads them to decide whether to
 * fall back to REST polling while SSE is dark.
 *
 * Why module-level (not React context): the sessions query's refetchInterval
 * needs a synchronous, non-render-cycle check ("has SSE been down long
 * enough?") on every interval tick. An external store with useSyncExternalStore
 * gives us both: reactive for rendering, cheap for imperative reads.
 */

let connected = true
let lastConnectAt = Date.now()
let lastDisconnectAt: number | null = null
const listeners = new Set<() => void>()

function emit(): void {
    for (const listener of listeners) listener()
}

/** Report an SSE connection transition. Called by App.tsx's useSSE callbacks. */
export function reportSseConnected(): void {
    connected = true
    lastConnectAt = Date.now()
    lastDisconnectAt = null
    emit()
}

export function reportSseDisconnected(): void {
    if (connected) {
        lastDisconnectAt = Date.now()
    }
    connected = false
    emit()
}

/** True when the SSE has been continuously down for at least `ms`. */
export function isSseDownFor(ms: number): boolean {
    if (connected || lastDisconnectAt === null) return false
    return Date.now() - lastDisconnectAt >= ms
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener)
    return () => { listeners.delete(listener) }
}

function getSnapshot(): boolean {
    return connected
}



/** React hook: subscribes to connection state; re-renders on transitions. */
export function useSseConnected(): boolean {
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
