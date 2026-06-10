/**
 * Module-level pub/sub for `message-patched` SSE events.
 *
 * The SSE stream is processed globally in App.tsx.  Individual MermaidDiagram
 * instances need to react to patches without owning their own SSE connections.
 * This emitter lets App.tsx publish events and components subscribe by key.
 */

export type PatchedPayload = {
    sessionId: string
    msgId: string
    blockIndex: number
    correctedCode: string
}

type Listener = (payload: PatchedPayload) => void

const listeners = new Set<Listener>()

export function subscribePatch(listener: Listener): () => void {
    listeners.add(listener)
    return () => {
        listeners.delete(listener)
    }
}

export function emitPatch(payload: PatchedPayload): void {
    for (const listener of listeners) {
        listener(payload)
    }
}
