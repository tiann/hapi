import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import type { SSEManager } from '../sse/sseManager'
import type { Session } from '../sync/syncEngine'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { NotificationCopyConfig } from './notificationCopy'
import { buildPermissionRequestCopy, buildReadyCopy, buildSessionCompletionCopy, buildTaskCopy, DEFAULT_COPY } from './notificationCopy'
import type { PushPayload, PushService } from './pushService'

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string,
        private readonly getCopyConfig: () => Promise<NotificationCopyConfig> = async () => ({})
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

    /**
     * Loads custom copy, never failing a notification because of bad config:
     * any loader error degrades to the hardcoded defaults.
     */
    private async loadCopy(): Promise<NotificationCopyConfig> {
        try {
            return await this.getCopyConfig()
        } catch {
            return DEFAULT_COPY
        }
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const requestEntries = Object.entries(session.agentState?.requests ?? {})
        const [requestId] = requestEntries[0] ?? [undefined]
        const stored = await this.loadCopy()
        const url = this.buildSessionPath(session.id)
        const { title, body } = buildPermissionRequestCopy(session, stored, url)

        const payload: PushPayload = {
            title,
            body,
            tag: `permission-${session.id}`,
            data: {
                type: 'permission-request',
                sessionId: session.id,
                url,
                requestId
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'permission')
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const stored = await this.loadCopy()
        const url = this.buildSessionPath(session.id)
        const { title, body } = buildReadyCopy(session, stored, url)

        const payload: PushPayload = {
            title,
            body,
            tag: `ready-${session.id}`,
            data: {
                type: 'ready',
                sessionId: session.id,
                url
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'ready')
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        const stored = await this.loadCopy()
        const url = this.buildSessionPath(session.id)
        const { title, body } = buildTaskCopy(session, notification, stored, url)

        const payload: PushPayload = {
            title,
            body,
            data: {
                type: 'task-notification',
                sessionId: session.id,
                url
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'task')
    }

    /**
     * Session-completion pushes. Deliberately no `session.active` gate: the
     * session has already become inactive by the time this fires (see
     * NotificationHub.sendSessionCompletion, which reads the session directly).
     */
    async sendSessionCompletion(session: Session, reason: SessionEndReason, ctx?: NotificationSendContext): Promise<void> {
        const stored = await this.loadCopy()
        const url = this.buildSessionPath(session.id)
        const { title, body } = buildSessionCompletionCopy(session, reason, stored, url)

        const payload: PushPayload = {
            title,
            body,
            tag: `session-completion-${session.id}`,
            data: {
                type: 'session-completion',
                sessionId: session.id,
                url
            }
        }

        await this.deliverWebOrToast(session, payload, ctx, 'session-completion')
    }

    private async deliverWebOrToast(
        session: Session,
        payload: PushPayload,
        ctx: NotificationSendContext | undefined,
        method: 'permission' | 'ready' | 'task' | 'session-completion'
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

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
