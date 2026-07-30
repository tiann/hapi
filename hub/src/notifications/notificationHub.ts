import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type {
    ModelErrorNotification,
    NotificationChannel,
    NotificationHubOptions,
    TaskNotification
} from './notificationTypes'
import type { NotificationSendContext } from './notificationSendContext'
import { extractMessageEventType, extractTaskNotification } from './eventParsing'

export class NotificationHub {
    private readonly channels: NotificationChannel[]
    private readonly readyCooldownMs: number
    private readonly permissionDebounceMs: number
    private readonly modelErrorRetryDelaysMs: number[]
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
     *
     * Kept across failed deliveries while a bounded backoff retry timer
     * is pending — do not delete it to "retry on next session-updated"
     * (that storms on keepalive and misses inactive sessions).
     */
    private readonly lastModelErrorNotifiedAt: Map<string, number> = new Map()
    private readonly modelErrorRetryTimers: Map<string, NodeJS.Timeout> = new Map()
    private readonly modelErrorRetryAttempts: Map<string, number> = new Map()
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(
        private readonly syncEngine: SyncEngine,
        channels: NotificationChannel[],
        options?: NotificationHubOptions
    ) {
        this.channels = channels
        this.readyCooldownMs = options?.readyCooldownMs ?? 5000
        this.permissionDebounceMs = options?.permissionDebounceMs ?? 500
        this.modelErrorRetryDelaysMs = options?.modelErrorRetryDelaysMs
            ?? [5_000, 15_000, 45_000, 120_000]
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
        for (const timer of this.modelErrorRetryTimers.values()) {
            clearTimeout(timer)
        }
        this.modelErrorRetryTimers.clear()
        this.modelErrorRetryAttempts.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if ((event.type === 'session-updated' || event.type === 'session-added') && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session) {
                this.clearSessionState(event.sessionId, true)
                return
            }
            if (!session.active) {
                // Keep lastModelErrorNotifiedAt across inactive/resume so the
                // same atTs does not re-ping when the session comes back.
                this.clearSessionState(event.sessionId, false)
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
            this.clearSessionState(event.sessionId, true)
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

    private clearSessionState(sessionId: string, removeModelErrorWatermark = false): void {
        const existingTimer = this.notificationDebounce.get(sessionId)
        if (existingTimer) {
            clearTimeout(existingTimer)
            this.notificationDebounce.delete(sessionId)
        }
        this.lastKnownRequests.delete(sessionId)
        this.lastReadyNotificationAt.delete(sessionId)
        if (removeModelErrorWatermark) {
            this.lastModelErrorNotifiedAt.delete(sessionId)
            this.clearModelErrorRetry(sessionId)
        }
    }

    private clearModelErrorRetry(sessionId: string): void {
        const timer = this.modelErrorRetryTimers.get(sessionId)
        if (timer) {
            clearTimeout(timer)
        }
        this.modelErrorRetryTimers.delete(sessionId)
        this.modelErrorRetryAttempts.delete(sessionId)
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
            this.clearModelErrorRetry(session.id)
            return
        }
        const lastNotifiedAt = this.lastModelErrorNotifiedAt.get(session.id) ?? 0
        if (lastModelError.atTs <= lastNotifiedAt) {
            return
        }
        const atTs = lastModelError.atTs
        // New error supersedes any in-flight retry for an older atTs.
        this.clearModelErrorRetry(session.id)
        // Optimistic watermark: prevents concurrent session-updated storms
        // from double-firing. On delivery failure we KEEP it and schedule a
        // bounded backoff retry (do not rely on keepalive session-updated).
        this.lastModelErrorNotifiedAt.set(session.id, atTs)

        const notification: ModelErrorNotification = {
            kind: lastModelError.kind,
            transient: lastModelError.transient,
            rawSnippet: lastModelError.rawSnippet,
            priorAssistantClaimsDone: Boolean(lastModelError.priorAssistantClaimsDone),
            atTs
        }

        void this.notifyModelError(session, notification).then((completed) => {
            if (!completed && this.lastModelErrorNotifiedAt.get(session.id) === atTs) {
                this.scheduleModelErrorRetry(session.id, atTs)
            }
        }).catch((error) => {
            console.error('[NotificationHub] Failed to send model-error notification:', error)
            if (this.lastModelErrorNotifiedAt.get(session.id) === atTs) {
                this.scheduleModelErrorRetry(session.id, atTs)
            }
        })
    }

    private scheduleModelErrorRetry(sessionId: string, atTs: number): void {
        if (this.modelErrorRetryTimers.has(sessionId)) {
            return
        }
        const attempt = this.modelErrorRetryAttempts.get(sessionId) ?? 0
        if (attempt >= this.modelErrorRetryDelaysMs.length) {
            console.error(
                `[NotificationHub] Exhausted model-error delivery retries for session=${sessionId} atTs=${atTs}`
            )
            return
        }
        const delayMs = this.modelErrorRetryDelaysMs[attempt] ?? 5_000
        this.modelErrorRetryAttempts.set(sessionId, attempt + 1)
        const timer = setTimeout(() => {
            this.modelErrorRetryTimers.delete(sessionId)
            void this.retryModelErrorNotification(sessionId, atTs)
        }, delayMs)
        this.modelErrorRetryTimers.set(sessionId, timer)
    }

    private async retryModelErrorNotification(sessionId: string, atTs: number): Promise<void> {
        const session = this.syncEngine.getSession(sessionId)
        if (!session) {
            this.clearModelErrorRetry(sessionId)
            this.lastModelErrorNotifiedAt.delete(sessionId)
            return
        }
        const lastModelError = session.metadata?.lastModelError
        if (
            !lastModelError
            || lastModelError.atTs !== atTs
            || typeof lastModelError.acknowledgedAt === 'number'
        ) {
            this.clearModelErrorRetry(sessionId)
            return
        }

        const notification: ModelErrorNotification = {
            kind: lastModelError.kind,
            transient: lastModelError.transient,
            rawSnippet: lastModelError.rawSnippet,
            priorAssistantClaimsDone: Boolean(lastModelError.priorAssistantClaimsDone),
            atTs
        }

        try {
            const completed = await this.notifyModelError(session, notification)
            if (completed) {
                this.modelErrorRetryAttempts.delete(sessionId)
                return
            }
            this.scheduleModelErrorRetry(sessionId, atTs)
        } catch (error) {
            console.error('[NotificationHub] Failed to retry model-error notification:', error)
            this.scheduleModelErrorRetry(sessionId, atTs)
        }
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
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }
        for (const channel of this.channels) {
            try {
                await channel.sendReady(session, ctx)
            } catch (error) {
                console.error('[NotificationHub] Failed to send ready notification:', error)
            }
        }
    }

    private async notifyPermission(session: Session): Promise<void> {
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }
        for (const channel of this.channels) {
            try {
                await channel.sendPermissionRequest(session, ctx)
            } catch (error) {
                console.error('[NotificationHub] Failed to send permission notification:', error)
            }
        }
    }

    private async notifyTask(session: Session, notification: TaskNotification): Promise<void> {
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }
        for (const channel of this.channels) {
            try {
                await channel.sendTaskNotification(session, notification, ctx)
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

    private async notifyModelError(session: Session, notification: ModelErrorNotification): Promise<boolean> {
        const ctx: NotificationSendContext = { nativeGate: { sent: false } }
        let attempted = false
        let delivered = false
        for (const channel of this.channels) {
            if (typeof channel.sendModelError !== 'function') {
                continue
            }
            try {
                const outcome = await channel.sendModelError(session, notification, ctx)
                if (outcome !== 'unavailable') {
                    attempted = true
                }
                if (outcome === 'delivered') {
                    delivered = true
                }
            } catch (error) {
                attempted = true
                console.error('[NotificationHub] Failed to send model-error notification:', error)
            }
        }
        // No implementers / all unavailable: keep watermark (avoid retry storm).
        // At least one channel tried and none delivered: roll back for retry.
        return !attempted || delivered
    }
}
