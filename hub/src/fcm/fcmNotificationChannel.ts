import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { NATIVE_CONTRACT_VERSION, NativeNotificationComposer, type ComposedNativeNotification } from '../notifications/nativeNotificationComposer'
import type { Store } from '../store'
import type { SSEManager } from '../sse/sseManager'
import type { VisibilityTracker } from '../visibility/visibilityTracker'
import type { FcmSendPayload, FcmService } from './fcmService'

export class FcmNotificationChannel implements NotificationChannel {
    private readonly composer: NativeNotificationComposer

    constructor(
        private readonly fcmService: FcmService,
        private readonly sseManager: SSEManager,
        private readonly visibilityTracker: VisibilityTracker,
        private readonly store?: Store
    ) {
        this.composer = new NativeNotificationComposer(store)
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, this.toFcmPayload(this.composer.composePermissionRequest(session)), ctx)
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, this.toFcmPayload(this.composer.composeReady(session)), ctx)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, this.toFcmPayload(this.composer.composeTask(session, notification)), ctx)
    }

    private toFcmPayload(composed: ComposedNativeNotification): FcmSendPayload {
        return {
            title: composed.title,
            body: composed.body,
            tag: composed.tag,
            data: {
                type: composed.type,
                sessionId: composed.sessionId,
                sessionName: composed.sessionName,
                url: composed.url,
                requestId: composed.requestId,
                title: composed.title,
                body: composed.body,
                contractVersion: NATIVE_CONTRACT_VERSION,
                severity: composed.severity,
                ...(composed.notifySummary ? { notifySummary: composed.notifySummary } : {})
            }
        }
    }

    private async deliver(session: Session, payload: FcmSendPayload, ctx?: NotificationSendContext): Promise<void> {
        // Native companion is the canonical surface: always fire FCM when the
        // hub asks us to. The previous SSE-toast shortcut here meant that
        // when the operator had the PWA open in foreground, the watch got
        // NOTHING - the in-page React toast was the only signal. That broke
        // the wrist-first UX (the whole point of installing a watch app)
        // and confused the operator about whether the agent was making
        // progress. SSE in-page toasts are still emitted by the PWA's own
        // SyncEngine event stream for users who want them; this channel's
        // job is to reach the wrist, period.
        const result = await this.fcmService.sendToNamespace(session.namespace, payload)
        if ((result?.sent ?? 0) > 0 && ctx?.nativeGate) {
            ctx.nativeGate.sent = true
        }
    }
}
