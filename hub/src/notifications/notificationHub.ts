import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type {
    ModelErrorNotification,
    NotificationChannel,
    NotificationHubOptions,
    TaskNotification
} from './notificationTypes'
import { extractMessageEventType, extractTaskNotification } from './eventParsing'

export class NotificationHub {
    private readonly channels: NotificationChannel[]
    private readonly readyCooldownMs: number
    private readonly permissionDebounceMs: number
    private readonly lastKnownRequests: Map<string, Set<string>> = new Map()
    private readonly notificationDebounce: Map<string, NodeJS.Timeout> = new Map()
    private readonly lastReadyNotificationAt: Map<string, number> = new Map()
    /**
     * sessionId -> the `atTs` of the last `lastModelError` we already
     * notified for. Lets us fire ONCE per distinct error event (the field
     * is purely additive on the metadata; subsequent `session-updated`
     * events for the same session shouldn't re-trigger). atTs is set by
     * the launcher's recordModelError; new error in the same session =
     * new atTs.
     */
    private readonly lastModelErrorNotifiedAt: Map<string, number> = new Map()
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(
        private readonly syncEngine: SyncEngine,
        channels: NotificationChannel[],
        options?: NotificationHubOptions
    ) {
        this.channels = channels
        this.readyCooldownMs = options?.readyCooldownMs ?? 5000
        this.permissionDebounceMs = options?.permissionDebounceMs ?? 500
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
        this.lastModelErrorNotifiedAt.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if ((event.type === 'session-updated' || event.type === 'session-added') && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session || !session.active) {
                this.clearSessionState(event.sessionId)
                return
            }
            this.checkForPermissionNotification(session)
            // Model-error gating: fire when metadata.lastModelError.atTs
            // is newer than what we last notified for this session. Inactive
            // sessions are filtered above (no-op for archived rows).
            this.checkForModelErrorNotification(session)
            return
        }

        if (event.type === 'session-removed' && event.sessionId) {
            this.clearSessionState(event.sessionId)
            return
        }

        if (event.type === 'session-ended' && event.sessionId) {
            if (event.reason === 'completed') {
                this.sendSessionCompletion(event.sessionId, event.reason).catch((error) => {
                    console.error('[NotificationHub] Failed to send session completion notification:', error)
                })
            }
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            const eventType = extractMessageEventType(event)
            if (eventType === 'ready') {
                this.sendReadyNotification(event.sessionId).catch((error) => {
                    console.error('[NotificationHub] Failed to send ready notification:', error)
                })
            }

            const taskNotification = extractTaskNotification(event)
            if (taskNotification) {
                this.sendTaskNotification(event.sessionId, taskNotification).catch((error) => {
                    console.error('[NotificationHub] Failed to send task notification:', error)
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
        this.lastModelErrorNotifiedAt.delete(sessionId)
    }

    private checkForModelErrorNotification(session: Session): void {
        const lastModelError = session.metadata?.lastModelError
        if (!lastModelError || typeof lastModelError.atTs !== 'number') {
            return
        }
        // Don't ping for already-acknowledged errors. The web UI sets
        // acknowledgedAt when the operator dismisses the banner; if they
        // dismissed and the row gets re-emitted (e.g. a different metadata
        // field changed), we don't want to re-ring the wrist.
        if (typeof lastModelError.acknowledgedAt === 'number') {
            return
        }
        const lastNotifiedAt = this.lastModelErrorNotifiedAt.get(session.id) ?? 0
        if (lastModelError.atTs <= lastNotifiedAt) {
            return
        }
        this.lastModelErrorNotifiedAt.set(session.id, lastModelError.atTs)

        const notification: ModelErrorNotification = {
            kind: lastModelError.kind,
            transient: lastModelError.transient,
            rawSnippet: lastModelError.rawSnippet,
            priorAssistantClaimsDone: Boolean(lastModelError.priorAssistantClaimsDone),
            atTs: lastModelError.atTs
        }

        this.notifyModelError(session, notification).catch((error) => {
            console.error('[NotificationHub] Failed to send model-error notification:', error)
        })
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

    private async sendReadyNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        const now = Date.now()
        const last = this.lastReadyNotificationAt.get(sessionId) ?? 0
        if (now - last < this.readyCooldownMs) {
            return
        }
        this.lastReadyNotificationAt.set(sessionId, now)

        await this.notifyReady(session)
    }

    private async sendTaskNotification(sessionId: string, notification: TaskNotification): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        await this.notifyTask(session, notification)
    }

    private async sendSessionCompletion(sessionId: string, reason: SessionEndReason): Promise<void> {
        const session = this.syncEngine.getSession(sessionId)
        if (!session) {
            return
        }

        await this.notifySessionCompletion(session, reason)
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

    private async notifyTask(session: Session, notification: TaskNotification): Promise<void> {
        for (const channel of this.channels) {
            try {
                await channel.sendTaskNotification(session, notification)
            } catch (error) {
                console.error('[NotificationHub] Failed to send task notification:', error)
            }
        }
    }

    private async notifySessionCompletion(session: Session, reason: SessionEndReason): Promise<void> {
        for (const channel of this.channels) {
            if (typeof channel.sendSessionCompletion !== 'function') {
                continue
            }
            try {
                await channel.sendSessionCompletion(session, reason)
            } catch (error) {
                console.error('[NotificationHub] Failed to send session completion notification:', error)
            }
        }
    }

    private async notifyModelError(session: Session, notification: ModelErrorNotification): Promise<void> {
        for (const channel of this.channels) {
            if (typeof channel.sendModelError !== 'function') {
                continue
            }
            try {
                await channel.sendModelError(session, notification)
            } catch (error) {
                console.error('[NotificationHub] Failed to send model-error notification:', error)
            }
        }
    }
}
