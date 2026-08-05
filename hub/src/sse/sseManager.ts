import { createHash, randomUUID } from 'node:crypto'
import type { SyncEvent } from '../sync/syncEngine'
import type { VisibilityState } from '../visibility/visibilityTracker'
import type { VisibilityTracker } from '../visibility/visibilityTracker'

export type SSESubscription = {
    id: string
    namespace: string
    all: boolean
    sessionId: string | null
    machineId: string | null
}

type SSEConnection = SSESubscription & {
    send: (event: SyncEvent, eventId?: string) => void | Promise<void>
    sendHeartbeat: () => void | Promise<void>
    /**
     * Non-null while a resumed connection is still writing its replay: live
     * broadcasts land here instead of on the wire so replayed events keep
     * their original order. `drainPending` flushes and clears it.
     */
    pending: Array<{ event: SyncEvent; eventId: string }> | null
}

export type SSEResumeResult = {
    /** 'ok': `replay` holds every missed event; client may skip its resync. */
    resume: 'ok' | 'gap'
    replay: Array<{ event: SyncEvent; eventId: string }>
}

/** How many broadcast events are kept for reconnect replay. */
const EVENT_BUFFER_CAPACITY = 256
/**
 * Byte budget for the replay buffer (sum of JSON-encoded events). Bounds
 * memory when large message payloads flow; evicting early just means older
 * cursors resync via REST like they always did.
 */
const EVENT_BUFFER_MAX_BYTES = 2 * 1024 * 1024

export class SSEManager {
    private readonly connections: Map<string, SSEConnection> = new Map()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private readonly heartbeatMs: number
    private readonly visibilityTracker: VisibilityTracker
    /**
     * Replay ring buffer. Event ids are `${epoch}:${seq}:${nsTag}`: the epoch
     * is per-process so a cursor from before a hub restart can never match a
     * fresh buffer, seq grows monotonically within the process, and nsTag
     * binds the cursor to the namespace it was issued under - a client whose
     * token swap changed its namespace must NOT resume from the old cursor
     * (its verdict would skip the resync the new namespace needs), even
     * though replay filtering alone would never leak foreign events.
     */
    private readonly epoch = randomUUID().slice(0, 8)
    private nextSeq = 1
    private readonly eventBuffer: Array<{ seq: number; event: SyncEvent; bytes: number }> = []
    private eventBufferBytes = 0
    private readonly namespaceTags = new Map<string, string>()

    constructor(heartbeatMs = 30_000, visibilityTracker: VisibilityTracker) {
        this.heartbeatMs = heartbeatMs
        this.visibilityTracker = visibilityTracker
    }

    subscribe(options: {
        id: string
        namespace: string
        all?: boolean
        sessionId?: string | null
        machineId?: string | null
        visibility?: VisibilityState
        /** Last event id the client saw; enables replay instead of resync. */
        resumeFrom?: string | null
        send: (event: SyncEvent, eventId?: string) => void | Promise<void>
        sendHeartbeat: () => void | Promise<void>
    }): SSESubscription & SSEResumeResult {
        const subscription: SSEConnection = {
            id: options.id,
            namespace: options.namespace,
            all: Boolean(options.all),
            sessionId: options.sessionId ?? null,
            machineId: options.machineId ?? null,
            send: options.send,
            sendHeartbeat: options.sendHeartbeat,
            pending: null
        }

        const { resume, replay } = this.resolveResume(subscription, options.resumeFrom ?? null)
        if (replay.length > 0) {
            // Live broadcasts must not overtake the replay the caller is about
            // to write; queue them until drainPending.
            subscription.pending = []
        }

        this.connections.set(subscription.id, subscription)
        this.visibilityTracker.registerConnection(
            subscription.id,
            subscription.namespace,
            options.visibility ?? 'hidden'
        )
        this.ensureHeartbeat()
        return {
            id: subscription.id,
            namespace: subscription.namespace,
            all: subscription.all,
            sessionId: subscription.sessionId,
            machineId: subscription.machineId,
            resume,
            replay
        }
    }

    /**
     * Flush events queued while the caller was writing a replay, then switch
     * the connection to direct delivery. Must be awaited after the replay has
     * been written; a no-op for connections that never queued.
     */
    async drainPending(id: string): Promise<void> {
        const connection = this.connections.get(id)
        if (!connection) {
            return
        }
        while (connection.pending) {
            const batch = connection.pending.splice(0)
            if (batch.length === 0) {
                // No await between this check and the assignment, so no
                // broadcast can slip into the queue and be dropped.
                connection.pending = null
                break
            }
            for (const item of batch) {
                try {
                    await connection.send(item.event, item.eventId)
                } catch {
                    this.unsubscribe(connection.id)
                    return
                }
            }
        }
    }

    private namespaceTag(namespace: string): string {
        const cached = this.namespaceTags.get(namespace)
        if (cached) {
            return cached
        }
        const tag = createHash('sha256').update(`${this.epoch}|${namespace}`).digest('hex').slice(0, 8)
        this.namespaceTags.set(namespace, tag)
        return tag
    }

    private eventIdFor(seq: number, namespace: string): string {
        return `${this.epoch}:${seq}:${this.namespaceTag(namespace)}`
    }

    private resolveResume(connection: SSEConnection, resumeFrom: string | null): SSEResumeResult {
        if (!resumeFrom) {
            return { resume: 'gap', replay: [] }
        }
        const parts = resumeFrom.split(':')
        if (parts.length !== 3 || parts[0] !== this.epoch) {
            return { resume: 'gap', replay: [] }
        }
        if (parts[2] !== this.namespaceTag(connection.namespace)) {
            // Cursor was issued under a different namespace (token swap on the
            // same hub): its position says nothing about what THIS namespace
            // has missed, so force the full resync.
            return { resume: 'gap', replay: [] }
        }
        const seq = Number(parts[1])
        if (!Number.isSafeInteger(seq) || seq < 1 || seq >= this.nextSeq) {
            return { resume: 'gap', replay: [] }
        }
        const oldestBuffered = this.eventBuffer[0]?.seq ?? this.nextSeq
        if (seq < oldestBuffered - 1) {
            // Events between the cursor and the buffer were evicted.
            return { resume: 'gap', replay: [] }
        }
        const replay: Array<{ event: SyncEvent; eventId: string }> = []
        for (const entry of this.eventBuffer) {
            if (entry.seq > seq && this.shouldSend(connection, entry.event)) {
                replay.push({ event: entry.event, eventId: this.eventIdFor(entry.seq, connection.namespace) })
            }
        }
        return { resume: 'ok', replay }
    }

    private recordEvent(event: SyncEvent): number {
        const seq = this.nextSeq++
        const bytes = JSON.stringify(event).length
        this.eventBuffer.push({ seq, event, bytes })
        this.eventBufferBytes += bytes
        while (
            this.eventBuffer.length > EVENT_BUFFER_CAPACITY
            || (this.eventBufferBytes > EVENT_BUFFER_MAX_BYTES && this.eventBuffer.length > 1)
        ) {
            const evicted = this.eventBuffer.shift()
            if (evicted) {
                this.eventBufferBytes -= evicted.bytes
            }
        }
        return seq
    }

    unsubscribe(id: string): void {
        this.connections.delete(id)
        this.visibilityTracker.removeConnection(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
    }

    hasSubscription(id: string): boolean {
        return this.connections.has(id)
    }

    async sendToast(namespace: string, event: Extract<SyncEvent, { type: 'toast' }>): Promise<number> {
        const deliveries: Array<Promise<{ id: string; ok: boolean }>> = []
        for (const connection of this.connections.values()) {
            if (connection.namespace !== namespace) {
                continue
            }
            if (!this.visibilityTracker.isVisibleConnection(connection.id)) {
                continue
            }

            deliveries.push(
                Promise.resolve(connection.send(event))
                    .then(() => ({ id: connection.id, ok: true }))
                    .catch(() => ({ id: connection.id, ok: false }))
            )
        }

        if (deliveries.length === 0) {
            return 0
        }

        const results = await Promise.all(deliveries)
        let successCount = 0
        for (const result of results) {
            if (result.ok) {
                successCount += 1
                continue
            }
            this.unsubscribe(result.id)
        }

        return successCount
    }

    broadcast(event: SyncEvent): void {
        const seq = this.recordEvent(event)
        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            // The id is per-connection: same epoch and seq, but tagged with
            // the receiving namespace so the cursor stays bound to it.
            const eventId = this.eventIdFor(seq, connection.namespace)
            if (connection.pending) {
                connection.pending.push({ event, eventId })
                continue
            }

            void Promise.resolve(connection.send(event, eventId)).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    stop(): void {
        this.stopHeartbeat()
        for (const id of this.connections.keys()) {
            this.visibilityTracker.removeConnection(id)
        }
        this.connections.clear()
    }

    private ensureHeartbeat(): void {
        if (this.heartbeatTimer || this.heartbeatMs <= 0) {
            return
        }

        this.heartbeatTimer = setInterval(() => {
            for (const connection of this.connections.values()) {
                void Promise.resolve(connection.sendHeartbeat()).catch(() => {
                    this.unsubscribe(connection.id)
                })
            }
        }, this.heartbeatMs)
    }

    private stopHeartbeat(): void {
        if (!this.heartbeatTimer) {
            return
        }

        clearInterval(this.heartbeatTimer)
        this.heartbeatTimer = null
    }

    private shouldSend(connection: SSEConnection, event: SyncEvent): boolean {
        if (event.type !== 'connection-changed') {
            const eventNamespace = event.namespace
            if (!eventNamespace || eventNamespace !== connection.namespace) {
                return false
            }
        }

        if (event.type === 'message-received' || event.type === 'scheduled-matured') {
            return connection.all || connection.sessionId === event.sessionId
        }

        if (event.type === 'connection-changed') {
            return true
        }

        if (connection.all) {
            return true
        }

        if ('sessionId' in event && connection.sessionId === event.sessionId) {
            return true
        }

        if ('machineId' in event && connection.machineId === event.machineId) {
            return true
        }

        return false
    }
}
