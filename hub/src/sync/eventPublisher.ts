import type { SyncEvent } from '@hapi/protocol/types'
import type { SSEManager } from '../sse/sseManager'

export type SyncEventListener = (event: SyncEvent) => void

export class EventPublisher {
    private readonly listeners: Set<SyncEventListener> = new Set()

    constructor(
        private readonly sseManager: SSEManager,
        private readonly resolveNamespace: (event: SyncEvent) => string | undefined
    ) {
    }

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    emit(event: SyncEvent): void {
        const namespace = this.resolveNamespace(event)
        const enrichedEvent = namespace ? { ...event, namespace } : event

        for (const listener of this.listeners) {
            try {
                listener(enrichedEvent)
            } catch (error) {
                console.error('[SyncEngine] Listener error:', error)
            }
        }

        this.sseManager.broadcast(enrichedEvent)
    }

    /**
     * A toast reaches the visible connections of one namespace only, and is
     * neither recorded nor replayed (`SSEManager.sendToast`), so it does not
     * go through `emit`: nothing persistent happens because of it. Resolves
     * to the number of connections that received it.
     */
    sendToast(namespace: string, event: Extract<SyncEvent, { type: 'toast' }>): Promise<number> {
        return this.sseManager.sendToast(namespace, event)
    }
}
