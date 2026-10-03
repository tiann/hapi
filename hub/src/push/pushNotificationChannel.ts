import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'
import { composeInputRequestNotification, getFirstPendingRequest } from '../notifications/inputRequest'
import { hubT, resolveHubLocale } from '../i18n/hubI18n'

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
        const pending = getFirstPendingRequest(session)
        const { requestId, request } = pending ?? {}
        const toolName = request?.tool ? ` (${request.tool})` : ''

        const buildPayload = (language: string | null): PushPayload => {
            const locale = resolveHubLocale(language)
            const inputNotification = composeInputRequestNotification(session, pending, locale)
            return {
                title: inputNotification?.title ?? hubT(locale, 'push.permission.title'),
                body: inputNotification?.body ?? `${name}${toolName}`,
                tag: inputNotification?.tag ?? `permission-${session.id}`,
                data: {
                    type: inputNotification?.type ?? 'permission-request',
                    sessionId: session.id,
                    url: this.buildSessionPath(session.id),
                    requestId
                }
            }
        }

        await this.deliverWebOrToast(session, buildPayload, ctx, 'permission')
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const agentName = getAgentName(session)
        const name = getSessionName(session)

        const buildPayload = (language: string | null): PushPayload => {
            const locale = resolveHubLocale(language)
            return {
                title: hubT(locale, 'push.ready.title'),
                body: hubT(locale, 'push.ready.body', { agent: agentName, session: name }),
                tag: `ready-${session.id}`,
                data: {
                    type: 'ready',
                    sessionId: session.id,
                    url: this.buildSessionPath(session.id)
                }
            }
        }

        await this.deliverWebOrToast(session, buildPayload, ctx, 'ready')
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

        const buildPayload = (language: string | null): PushPayload => {
            const locale = resolveHubLocale(language)
            return {
                title: hubT(locale, isFailure ? 'push.task.failed' : 'push.task.completed'),
                body: `${agentName} · ${name} · ${notification.summary}`,
                data: {
                    type: 'task-notification',
                    sessionId: session.id,
                    url: this.buildSessionPath(session.id)
                }
            }
        }

        await this.deliverWebOrToast(session, buildPayload, ctx, 'task')
    }

    private async deliverWebOrToast(
        session: Session,
        buildPayload: (language: string | null) => PushPayload,
        ctx: NotificationSendContext | undefined,
        method: 'permission' | 'ready' | 'task'
    ): Promise<void> {
        if (ctx?.nativeGate?.sent) {
            this.logBranch(method, session.namespace, 'defer-to-native', 'fcm-delivered-this-dispatch')
            return
        }

        // In-page toasts render from the viewer's own web UI, so they use the
        // default locale; the web-push payload below is per subscription.
        const toastPayload = buildPayload(null)
        const url = toastPayload.data?.url ?? this.buildSessionPath(session.id)
        if (this.visibilityTracker.hasVisibleConnection(session.namespace)) {
            const delivered = await this.sseManager.sendToast(session.namespace, {
                type: 'toast',
                data: {
                    title: toastPayload.title,
                    body: toastPayload.body,
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
        await this.pushService.sendToNamespace(session.namespace, buildPayload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
