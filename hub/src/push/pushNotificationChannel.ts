import type { Session } from '../sync/syncEngine'
import type {
    ModelErrorNotification,
    NotificationChannel,
    TaskNotification
} from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import { formatModelErrorBody, formatModelErrorTitle } from '../notifications/modelErrorCopy'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string
    ) {}

    /**
     * Debug observability: gated on `HAPI_NOTIFY_DEBUG=1`. Lets the operator
     * see which branch each notification took so we can root-cause "still
     * getting PWA notifications" reports without committing permanent log
     * spam to the hub journal.
     */
    private logBranch(method: string, namespace: string, branch: string, extra: string = ''): void {
        if (process.env.HAPI_NOTIFY_DEBUG !== '1') return
        const note = extra ? ` ${extra}` : ''
        console.log(`[Push.${method}] ns=${namespace} ${branch}${note}`)
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const name = getSessionName(session)
        const requests = session.agentState?.requests ?? null
        const requestEntries = requests ? Object.entries(requests) : []
        const [requestId, request] = requestEntries[0] ?? [undefined, null]
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const payload: PushPayload = {
            title: 'Permission Request',
            body: `${name}${toolName}`,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url: this.buildSessionPath(session.id),
                requestId
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'permission')
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
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

        await this.deliverWebOrToast(session, payload, ctx, 'ready')
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)
        const normalizedStatus = notification.status?.trim().toLowerCase()
        const isFailure = normalizedStatus === 'failed'
            || normalizedStatus === 'error'
            || normalizedStatus === 'killed'
            || normalizedStatus === 'aborted'

        const payload: PushPayload = {
            title: isFailure ? 'Task failed' : 'Task completed',
            body: `${agentName} · ${name} · ${notification.summary}`,
            data: {
                type: 'task-notification',
                sessionId: session.id,
                url: this.buildSessionPath(session.id)
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'task')
    }

    private async deliverWebOrToast(
        session: Session,
        payload: PushPayload,
        ctx: NotificationSendContext | undefined,
        method: 'permission' | 'ready' | 'task'
    ): Promise<void> {
        if (ctx?.nativeGate?.sent) {
            this.logBranch(method, session.namespace, 'defer-to-native', 'fcm-delivered-this-dispatch')
            return
        }

        const url = payload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: payload.title,
                    body: payload.body,
                    sessionId: session.id,
                    url
                }
            })
            if (delivered > 0) {
                this.logBranch(method, session.namespace, 'sse-toast-delivered', `count=${delivered}`)
                return
            }
            this.logBranch(method, session.namespace, 'sse-toast-zero', 'visible but delivered=0')
        } else {
            this.logBranch(method, session.namespace, 'not-visible')
        }

        this.logBranch(method, session.namespace, 'web-push-fired')
        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendModelError(session: Session, notification: ModelErrorNotification): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const sessionName = getSessionName(session)
        const title = formatModelErrorTitle(notification.kind)
        const body = formatModelErrorBody(notification, { agentName, sessionName })
        const url = this.buildSessionPath(session.id)

        const payload: PushPayload = {
            title,
            body,
            // Distinct tag from `ready-${id}` so the model-error ping never
            // collapses into the prior "all done" notification on the same
            // session. Tag keyed by atTs so distinct errors in the same
            // session DON'T overwrite each other on the lock screen.
            tag: `model-error-${session.id}-${notification.atTs}`,
            data: {
                type: 'model-error',
                sessionId: session.id,
                url
            }
        }

        // Skip the in-page toast shortcut for model errors. Toasts are
        // ephemeral and easy to miss; an error of this severity should
        // ALWAYS surface as a real push so a backgrounded operator gets
        // a system-tray ping. The web banner + pulsing-dot already
        // cover the foreground case.
        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
