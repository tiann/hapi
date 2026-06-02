import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { PushPayload, PushService } from './pushService'

/**
 * Probe that returns true when a native companion (Android FCM phone/wear)
 * device is registered for this namespace. When provided to
 * PushNotificationChannel, the channel suppresses its web-push fallback so
 * the operator stops getting double notifications: one on the native app,
 * one on the PWA service worker. The in-app SSE toast path is unaffected -
 * if the operator has the PWA actively in the foreground, they'll still see
 * the toast inside the page.
 */
export type NativeFallbackProbe = (namespace: string) => boolean

export class PushNotificationChannel implements NotificationChannel {
    constructor(
        private readonly pushService: PushService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        _appUrl: string,
        private readonly nativeFallbackProbe?: NativeFallbackProbe
    ) {}

    /**
     * Returns true if web-push delivery should be skipped because a native
     * companion will already cover this namespace. Centralised so all three
     * send* methods stay in lock-step.
     */
    private shouldSkipWebPush(namespace: string): boolean {
        return this.nativeFallbackProbe?.(namespace) ?? false
    }

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

    async sendPermissionRequest(session: Session): Promise<void> {
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

        // Native-companion-first: when an FCM device is registered for this
        // namespace the watch already covers this notification end-to-end.
        // Skip the SSE in-page toast AND the web-push fallback - both are
        // redundant surfaces that the operator explicitly asked us to mute.
        if (this.shouldSkipWebPush(session.namespace)) {
            this.logBranch('permission', session.namespace, 'defer-to-native', 'native-companion-registered')
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
                this.logBranch('permission', session.namespace, 'sse-toast-delivered', `count=${delivered}`)
                return
            }
            this.logBranch('permission', session.namespace, 'sse-toast-zero', 'visible but delivered=0')
        } else {
            this.logBranch('permission', session.namespace, 'not-visible')
        }

        this.logBranch('permission', session.namespace, 'web-push-fired')
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

        if (this.shouldSkipWebPush(session.namespace)) {
            this.logBranch('ready', session.namespace, 'defer-to-native', 'native-companion-registered')
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
                this.logBranch('ready', session.namespace, 'sse-toast-delivered', `count=${delivered}`)
                return
            }
            this.logBranch('ready', session.namespace, 'sse-toast-zero', 'visible but delivered=0')
        } else {
            this.logBranch('ready', session.namespace, 'not-visible')
        }

        this.logBranch('ready', session.namespace, 'web-push-fired')
        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
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

        if (this.shouldSkipWebPush(session.namespace)) {
            this.logBranch('task', session.namespace, 'defer-to-native', 'native-companion-registered')
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
                this.logBranch('task', session.namespace, 'sse-toast-delivered', `count=${delivered}`)
                return
            }
            this.logBranch('task', session.namespace, 'sse-toast-zero', 'visible but delivered=0')
        } else {
            this.logBranch('task', session.namespace, 'not-visible')
        }

        this.logBranch('task', session.namespace, 'web-push-fired')
        await this.pushService.sendToNamespace(session.namespace, payload)
    }

    private buildSessionPath(sessionId: string): string {
        return `/sessions/${sessionId}`
    }
}
