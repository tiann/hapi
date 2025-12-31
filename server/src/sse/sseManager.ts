import type { SyncEvent } from '../sync/syncEngine'

export type SSESubscription = {
    id: string
    namespace: string
    all: boolean
    sessionId: string | null
    machineId: string | null
}

type SSEConnection = SSESubscription & {
    send: (event: SyncEvent) => void | Promise<void>
    sendHeartbeat: () => void | Promise<void>
}

export class SSEManager {
    private readonly connections: Map<string, SSEConnection> = new Map()
    private heartbeatTimer: NodeJS.Timeout | null = null
    private readonly heartbeatMs: number

    constructor(heartbeatMs = 30_000) {
        this.heartbeatMs = heartbeatMs
    }

    subscribe(options: {
        id: string
        namespace: string
        all?: boolean
        sessionId?: string | null
        machineId?: string | null
        send: (event: SyncEvent) => void | Promise<void>
        sendHeartbeat: () => void | Promise<void>
    }): SSESubscription {
        const subscription: SSEConnection = {
            id: options.id,
            namespace: options.namespace,
            all: Boolean(options.all),
            sessionId: options.sessionId ?? null,
            machineId: options.machineId ?? null,
            send: options.send,
            sendHeartbeat: options.sendHeartbeat
        }

        this.connections.set(subscription.id, subscription)
        this.ensureHeartbeat()
        return {
            id: subscription.id,
            namespace: subscription.namespace,
            all: subscription.all,
            sessionId: subscription.sessionId,
            machineId: subscription.machineId
        }
    }

    unsubscribe(id: string): void {
        this.connections.delete(id)
        if (this.connections.size === 0) {
            this.stopHeartbeat()
        }
    }

    broadcast(event: SyncEvent): void {
        for (const connection of this.connections.values()) {
            if (!this.shouldSend(connection, event)) {
                continue
            }

            void Promise.resolve(connection.send(event)).catch(() => {
                this.unsubscribe(connection.id)
            })
        }
    }

    stop(): void {
        this.stopHeartbeat()
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

        if (event.type === 'message-received') {
            return Boolean(event.sessionId && connection.sessionId === event.sessionId)
        }

        if (event.type === 'connection-changed') {
            return true
        }

        if (connection.all) {
            return true
        }

        if (event.sessionId && connection.sessionId === event.sessionId) {
            return true
        }

        if (event.machineId && connection.machineId === event.machineId) {
            return true
        }

        return false
    }
}
