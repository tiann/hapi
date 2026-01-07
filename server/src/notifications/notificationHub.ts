import type { Session, SyncEngine, SyncEvent } from '../sync/syncEngine'
import type { NotificationChannel, NotificationHubOptions } from './notificationTypes'
import { extractMessageEventType } from './eventParsing'

const QUESTION_TOOL_NAMES = new Set(['AskUserQuestion', 'ask_user_question'])

export class NotificationHub {
    private readonly channels: NotificationChannel[]
    private readonly readyCooldownMs: number
    private readonly permissionDebounceMs: number
    private readonly questionDebounceMs: number
    private readonly lastKnownRequests: Map<string, Set<string>> = new Map()
    private readonly lastKnownQuestions: Map<string, Set<string>> = new Map()
    private readonly notificationDebounce: Map<string, NodeJS.Timeout> = new Map()
    private readonly questionDebounce: Map<string, NodeJS.Timeout> = new Map()
    private readonly lastReadyNotificationAt: Map<string, number> = new Map()
    private unsubscribeSyncEvents: (() => void) | null = null

    constructor(
        private readonly syncEngine: SyncEngine,
        channels: NotificationChannel[],
        options?: NotificationHubOptions
    ) {
        this.channels = channels
        this.readyCooldownMs = options?.readyCooldownMs ?? 5000
        this.permissionDebounceMs = options?.permissionDebounceMs ?? 500
        this.questionDebounceMs = options?.questionDebounceMs ?? 500
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
        for (const timer of this.questionDebounce.values()) {
            clearTimeout(timer)
        }
        this.notificationDebounce.clear()
        this.questionDebounce.clear()
        this.lastKnownRequests.clear()
        this.lastKnownQuestions.clear()
        this.lastReadyNotificationAt.clear()
    }

    private handleSyncEvent(event: SyncEvent): void {
        if ((event.type === 'session-updated' || event.type === 'session-added') && event.sessionId) {
            const session = this.syncEngine.getSession(event.sessionId)
            if (!session || !session.active) {
                this.clearSessionState(event.sessionId)
                return
            }
            this.checkForPermissionNotification(session)
            return
        }

        if (event.type === 'session-removed' && event.sessionId) {
            this.clearSessionState(event.sessionId)
            return
        }

        if (event.type === 'message-received' && event.sessionId) {
            const eventType = extractMessageEventType(event)
            if (eventType === 'ready') {
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
        const existingQuestionTimer = this.questionDebounce.get(sessionId)
        if (existingQuestionTimer) {
            clearTimeout(existingQuestionTimer)
            this.questionDebounce.delete(sessionId)
        }
        this.lastKnownRequests.delete(sessionId)
        this.lastKnownQuestions.delete(sessionId)
        this.lastReadyNotificationAt.delete(sessionId)
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

        // Separate question requests from permission requests
        const questionRequestIds = new Set<string>()
        const permissionRequestIds = new Set<string>()

        for (const [requestId, request] of Object.entries(requests)) {
            if (request && typeof request === 'object' && 'tool' in request) {
                const toolName = (request as { tool?: string }).tool
                if (toolName && QUESTION_TOOL_NAMES.has(toolName)) {
                    questionRequestIds.add(requestId)
                } else {
                    permissionRequestIds.add(requestId)
                }
            } else {
                permissionRequestIds.add(requestId)
            }
        }

        // Check for new question requests
        this.checkForNewQuestions(session, questionRequestIds, requests)

        // Check for new permission requests (excluding questions)
        const oldRequestIds = this.lastKnownRequests.get(session.id) || new Set()

        let hasNewRequests = false
        for (const requestId of permissionRequestIds) {
            if (!oldRequestIds.has(requestId)) {
                hasNewRequests = true
                break
            }
        }

        this.lastKnownRequests.set(session.id, permissionRequestIds)

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

    private checkForNewQuestions(
        session: Session,
        questionRequestIds: Set<string>,
        requests: Record<string, unknown>
    ): void {
        const oldQuestionIds = this.lastKnownQuestions.get(session.id) || new Set()

        let newQuestionId: string | null = null
        for (const requestId of questionRequestIds) {
            if (!oldQuestionIds.has(requestId)) {
                newQuestionId = requestId
                break
            }
        }

        this.lastKnownQuestions.set(session.id, questionRequestIds)

        if (!newQuestionId) {
            return
        }

        // Extract question summary from the request if available
        const request = requests[newQuestionId] as { args?: { questions?: Array<{ question?: string }> } } | undefined
        const questionSummary = request?.args?.questions?.[0]?.question || ''

        const existingTimer = this.questionDebounce.get(session.id)
        if (existingTimer) {
            clearTimeout(existingTimer)
        }

        const timer = setTimeout(() => {
            this.questionDebounce.delete(session.id)
            this.sendQuestionNotification(session.id, questionSummary).catch((error) => {
                console.error('[NotificationHub] Failed to send question notification:', error)
            })
        }, this.questionDebounceMs)

        this.questionDebounce.set(session.id, timer)
    }

    private async sendPermissionNotification(sessionId: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        await this.notifyPermission(session)
    }

    private async sendQuestionNotification(sessionId: string, questionSummary: string): Promise<void> {
        const session = this.getNotifiableSession(sessionId)
        if (!session) {
            return
        }

        await this.notifyQuestion(session, questionSummary)
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

    private async notifyQuestion(session: Session, questionSummary: string): Promise<void> {
        for (const channel of this.channels) {
            try {
                if (channel.sendQuestion) {
                    await channel.sendQuestion(session, questionSummary)
                }
            } catch (error) {
                console.error('[NotificationHub] Failed to send question notification:', error)
            }
        }
    }
}
