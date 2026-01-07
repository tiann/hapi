import type { Session } from '../sync/syncEngine'
import type { NotificationChannel } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        _appUrl: string
    ) {}

    async sendPermissionRequest(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const request = session.agentState?.requests
            ? Object.values(session.agentState.requests)[0]
            : null
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendReady(session: Session): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Ready for input',
            body: `${agentName} is waiting in ${name}`,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendQuestion(session: Session, questionSummary: string): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Question',
            body: questionSummary || `Claude has a question in ${name}`,
            tag: `question-${session.id}`,
            data: {
                type: 'question',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendError(session: Session, errorMessage: string): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)

        const payload: PushPayload = {
            title: 'Error',
            body: errorMessage || `Error in ${name}`,
            tag: `error-${session.id}`,
            data: {
                type: 'error',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
