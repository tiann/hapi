import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { AttentionReason, NotificationChannel, NotificationHubOptions } from './notificationTypes'
import { extractAttentionReason, extractMessageEventType, isAgentMessageEvent } from './eventParsing'

export class NotificationHub {
    private readonly channels: NotificationChannel[]
    private readonly readyCooldownMs: number
    private readonly permissionDebounceMs: number
    private readonly attentionCooldownMs: number
    private readonly lastKnownRequests: Map<string, Set<string>> = new Map()
    private readonly notificationDebounce: Map<string, NodeJS.Timeout> = new Map()
    private readonly lastReadyNotificationAt: Map<string, number> = new Map()
    private readonly lastAttentionNotificationAt: Map<string, number> = new Map()
    private readonly lastThinkingBySession: Map<string, boolean> = new Map()
    private readonly agentActivityBySession: Map<string, boolean> = new Map()
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(
        private readonly syncEngine: SyncEngine,
        channels: NotificationChannel[],
        options?: NotificationHubOptions
    ) {
        this.channels = channels
        this.readyCooldownMs = options?.readyCooldownMs ?? 5000
        this.permissionDebounceMs = options?.permissionDebounceMs ?? 500
        this.attentionCooldownMs = options?.attentionCooldownMs ?? 5000
        this.unsubscribeSyncEvents = this.syncEngine.subscribe((event) => {
            this.handleSyncEvent(event)
        })
    }

    stop(): void {
        if (this.unsubscribeSyncEvents) {
            this.unsubscribeSyncEvents()
            this.unsubscribeSyncEvents = null
        }

        for (const timer of this.notificationDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()
        this.lastKnownRequests.clear()
        this.lastReadyNotificationAt.clear()
        this.lastAttentionNotificationAt.clear()
        this.lastThinkingBySession.clear()
        this.agentActivityBySession.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if ((event.type === 'session-updated' || event.type === 'session-added') && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session || !session.active) {
                this.clearSessionState(event.sessionId)
                return
            }

            const wasThinking = this.lastThinkingBySession.get(session.id)
            if (wasThinking !== true && session.thinking) {
                this.agentActivityBySession.delete(session.id)
            }

            this.checkForPermissionNotification(session)
            this.checkForThinkingStoppedNotification(session)
            this.lastThinkingBySession.set(session.id, session.thinking)
            return
        }

        if (event.type === 'session-removed' && event.sessionId) {
            this.clearSessionState(event.sessionId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            if (isAgentMessageEvent(event)) {
                const session = this.syncEngine.getSession(event.sessionId)
                if (session?.active && session.thinking) {
                    this.agentActivityBySession.set(event.sessionId, true)
                } else {
                    this.agentActivityBySession.delete(event.sessionId)
                }
            }

            const eventType = extractMessageEventType(event)
            const attentionReason = extractAttentionReason(event)
            if (attentionReason) {
                this.agentActivityBySession.delete(event.sessionId)
                this.sendAttentionNotification(event.sessionId, attentionReason).catch((error) => {
                    console.error('[NotificationHub] Failed to send attention notification:', error)
                })
                return
            }

            if (eventType === 'ready') {
                this.agentActivityBySession.delete(event.sessionId)
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[NotificationHub] Failed to send ready notification:', error)
                })
            }
        }
    }

    private clearSessionState(sessionId: string): void {
        const existingTimer = this.notificationDebounce.get(sessionId)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.notificationDebounce.delete(sessionId)
        }
        this.lastKnownRequests.delete(sessionId)
        this.lastReadyNotificationAt.delete(sessionId)
        this.lastAttentionNotificationAt.delete(sessionId)
        this.lastThinkingBySession.delete(sessionId)
        this.agentActivityBySession.delete(sessionId)
    }

    private getNotifiableSession(sessionId: string): Session | null {
        const session = this.syncEngine.getSession(sessionId)
        if (!session || !session.active) {
            return null
        }
        return session
    }

    private checkForPermissionNotification(session: Session): void {
        const requests = session.agentState?.requests

        if (requests == null) {
            return
        }

        const newRequestIds = new Set(Object.keys(requests))
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        let hasNewRequests = false
        for (const requestId of newRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                hasNewRequests = true
                break
            }
        }

        this.lastKnownRequests.set(session.id, newRequestIds)

        if (!hasNewRequests) {
            return
        }

        const existingTimer = this.notificationDebounce.get(session.id)
        if (existingTimer) {
            clearTimeout(existingTimer)
        }

        const timer = setTimeout(() => {
            this.notificationDebounce.delete(session.id)
            this.sendPermissionNotification(session.id).catch((error) => {
                console.error('[NotificationHub] Failed to send permission notification:', error)
            })
        }, this.permissionDebounceMs)

        this.notificationDebounce.set(session.id, timer)
    }

    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        await this.notifyPermission(session)
    }

    private hasPendingPermissionRequest(session: Session): boolean {
        const requests = session.agentState?.requests
        return Boolean(requests && Object.keys(requests).length > 0)
    }

    private checkForThinkingStoppedNotification(session: Session): void {
        const wasThinking = this.lastThinkingBySession.get(session.id)
        if (wasThinking !== true || session.thinking) {
            return
        }
        if (!this.agentActivityBySession.get(session.id)) {
            return
        }
        this.agentActivityBySession.delete(session.id)
        if (this.hasPendingPermissionRequest(session)) {
            return
        }

        this.sendReadyNotification(session.id).catch((error) => {
            console.error('[NotificationHub] Failed to send ready notification:', error)
        })
    }

    private async sendAttentionNotification(sessionId: string, reason: AttentionReason): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastAttentionNotificationAt.get(sessionId) ?? 0
        if (now - last < this.attentionCooldownMs) {
            return
        }
        this.lastAttentionNotificationAt.set(sessionId, now)

        await this.notifyAttention(session, reason)
    }

    private async sendReadyNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const lastAttention = this.lastAttentionNotificationAt.get(sessionId) ?? 0
        if (now - lastAttention < this.attentionCooldownMs) {
            return
        }

        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < this.readyCooldownMs) {
            return
        }
        this.lastReadyNotificationAt.set(sessionId, now)

        await this.notifyReady(session)
    }

    private async notifyReady(session: Session): Promise<void> {
        for (const channel of this.channels) {
            try {
                await channel.sendReady(session)
            } catch (error) {
                console.error('[NotificationHub] Failed to send ready notification:', error)
            }
        }
    }

    private async notifyPermission(session: Session): Promise<void> {
        for (const channel of this.channels) {
            try {
                await channel.sendPermissionRequest(session)
            } catch (error) {
                console.error('[NotificationHub] Failed to send permission notification:', error)
            }
        }
    }

    private async notifyAttention(session: Session, reason: AttentionReason): Promise<void> {
        for (const channel of this.channels) {
            try {
                await channel.sendAttention(session, reason)
            } catch (error) {
                console.error('[NotificationHub] Failed to send attention notification:', error)
            }
        }
    }
}
