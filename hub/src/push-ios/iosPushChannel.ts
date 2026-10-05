import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import type { NotificationSendContext } from '../notifications/notificationSendContext'
import { NATIVE_CONTRACT_VERSION, NativeNotificationComposer, type ComposedNativeNotification } from '../notifications/nativeNotificationComposer'
import type { Store } from '../store'
import type { IosPushNotificationPayload, IosPushService } from './iosPushService'

/**
 * iOS sibling of FcmNotificationChannel. Fires unconditionally (the phone
 * is a canonical native surface - no SSE/visibility shortcut, see the
 * rationale in FcmNotificationChannel.deliver) and participates in the same
 * per-dispatch nativeGate: when at least one APNs/relay send succeeds,
 * PushNotificationChannel suppresses web-push for this namespace so the
 * operator gets one OS notification, not two.
 */
export class IosPushNotificationChannel implements NotificationChannel {
    private readonly composer: NativeNotificationComposer

    constructor(
        private readonly iosPushService: IosPushService,
        store?: Store
    ) {
        this.composer = new NativeNotificationComposer(store)
    }

    async sendPermissionRequest(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, (language) => this.composer.composePermissionRequest(session, language), ctx)
    }

    async sendReady(session: Session, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, (language) => this.composer.composeReady(session, language), ctx)
    }

    async sendTaskNotification(session: Session, notification: TaskNotification, ctx?: NotificationSendContext): Promise<void> {
        if (!session.active) {
            return
        }

        await this.deliver(session, (language) => this.composer.composeTask(session, notification, language), ctx)
    }

    private toPlaintextPayload(composed: ComposedNativeNotification): IosPushNotificationPayload {
        return {
            type: composed.type,
            sessionId: composed.sessionId,
            sessionName: composed.sessionName,
            url: composed.url,
            title: composed.title,
            body: composed.body,
            contractVersion: NATIVE_CONTRACT_VERSION,
            ...(composed.severity ? { severity: composed.severity } : {}),
            ...(composed.requestId ? { requestId: composed.requestId } : {}),
            ...(composed.notifySummary ? { notifySummary: composed.notifySummary } : {})
        }
    }

    private async deliver(
        session: Session,
        compose: (language: string | null) => ComposedNativeNotification,
        ctx?: NotificationSendContext
    ): Promise<void> {
        const result = await this.iosPushService.sendToNamespace(
            session.namespace,
            (language) => this.toPlaintextPayload(compose(language))
        )
        if ((result?.sent ?? 0) > 0 && ctx?.nativeGate) {
            ctx.nativeGate.sent = true
        }
    }
}
