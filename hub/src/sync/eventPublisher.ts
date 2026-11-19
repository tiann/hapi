import { affectsSessionSchedule, type SessionSchedule } from '@hapi/protocol/schemas'
import type { SyncEvent } from '@hapi/protocol/types'
import type { SSEManager } from '../sse/sseManager'

export type SyncEventListener = (event: SyncEvent) => void

export class EventPublisher {
    private readonly listeners: Set<SyncEventListener> = new Set()

    constructor(
        private readonly sseManager: SSEManager,
        private readonly resolveNamespace: (event: SyncEvent) => string | undefined,
        private readonly readSessionSchedule?: (sessionId: string) => SessionSchedule
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

        // Read after listeners run so the snapshot reflects the state at broadcast time.
        if (namespace && this.readSessionSchedule && affectsSessionSchedule(enrichedEvent)) {
            let sessionSchedule: SessionSchedule | undefined
            try {
                sessionSchedule = this.readSessionSchedule(enrichedEvent.sessionId)
            } catch (error) {
                console.error('[SyncEngine] Failed to read session schedule:', error)
            }
            if (sessionSchedule) {
                this.sseManager.broadcast({ ...enrichedEvent, sessionSchedule })
                return
            }
        }
        this.sseManager.broadcast(enrichedEvent)
    }
}
