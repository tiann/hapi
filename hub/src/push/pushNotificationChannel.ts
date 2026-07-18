import type { Session } from '../sync/syncEngine'
import type { AttentionReason, NotificationChannel, NotificationContext } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    private notificationSequence = 0

    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string
    ) {}

    async sendPermissionRequest(session: Session, context?: NotificationContext): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: this.withUnreadCount('Permission Request', context),
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id),
                unreadCount: context?.unreadCount,
                totalUnreadCount: context?.totalUnreadCount
            }
        }

        await this.deliver(session, payload)
    }

    async sendReady(session: Session, context?: NotificationContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: this.withUnreadCount('Ready for input', context),
            body: `${agentName} is waiting in ${name}`,
            tag: this.buildReadyNotificationTag(session.id),
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionPath(session.id),
                unreadCount: context?.unreadCount,
                totalUnreadCount: context?.totalUnreadCount
            }
        }

        await this.deliver(session, payload)
    }

    async sendAttention(session: Session, _reason: AttentionReason, context?: NotificationContext): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const payload: PushPayload = {
            title: this.withUnreadCount('Task needs attention', context),
            body: `${name} stopped or failed`,
            tag: `attention-${session.id}`,
            data: {
                type: 'attention',
                sessionId: session.id,
                url: this.buildSessionPath(session.id),
                unreadCount: context?.unreadCount,
                totalUnreadCount: context?.totalUnreadCount
            }
        }

        await this.deliver(session, payload)
    }

    private async deliver(session: Session, payload: PushPayload): Promise<void> {
        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        const hasVisibleConnection = this.visibilityTracker.hasVisibleConnection(session.namespace)
        if (hasVisibleConnection) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }

    private buildReadyNotificationTag(sessionId: string): string {
        this.notificationSequence += 1
        return `ready-${sessionId}-${Date.now()}-${this.notificationSequence}`
    }

    private withUnreadCount(title: string, context?: NotificationContext): string {
        const unreadCount = context?.unreadCount ?? 0
        return unreadCount > 1 ? `${title} · ${unreadCount} unread` : title
    }
}
