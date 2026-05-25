import type { SessionEndReason } from '@hapi/protocol'
import type { PluginNotificationEvent, PluginNotificationSession } from '@hapi/protocol/plugins'
import type { Session } from '../sync/syncEngine'
import type { NotificationChannel, TaskNotification } from '../notifications/notificationTypes'
import { getAgentName, getSessionName } from '../notifications/sessionInfo'
import type { PluginNotificationChannel } from './types'

function buildSessionUrl(publicUrl: string | undefined, sessionId: string): string | undefined {
    if (!publicUrl) {
        return `/sessions/${sessionId}`
    }
    try {
        return new URL(`/sessions/${sessionId}`, publicUrl).toString()
    } catch {
        const normalized = publicUrl.replace(/\/+$/, '')
        return `${normalized}/sessions/${sessionId}`
    }
}

export function toPluginNotificationSession(session: Session, publicUrl?: string): PluginNotificationSession {
    return {
        id: session.id,
        namespace: session.namespace,
        name: getSessionName(session),
        ...(session.metadata?.path ? { path: session.metadata.path } : {}),
        agent: getAgentName(session),
        active: session.active,
        url: buildSessionUrl(publicUrl, session.id)
    }
}

export function createPluginNotificationEvent(
    type: PluginNotificationEvent['type'],
    session: Session,
    publicUrl?: string,
    extra: Omit<PluginNotificationEvent, 'type' | 'session'> = {}
): PluginNotificationEvent {
    return {
        type,
        session: toPluginNotificationSession(session, publicUrl),
        ...extra
    }
}

export class PluginNotificationChannelAdapter implements NotificationChannel {
    constructor(
        private readonly pluginChannel: PluginNotificationChannel,
        private readonly isDisposed: () => boolean,
        private readonly publicUrl?: string,
        private readonly sanitizeError: (error: unknown) => Error = (error) => error instanceof Error ? error : new Error(String(error))
    ) {}

    async sendReady(session: Session): Promise<void> {
        await this.send(createPluginNotificationEvent('ready', session, this.publicUrl))
    }

    async sendPermissionRequest(session: Session): Promise<void> {
        await this.send(createPluginNotificationEvent('permission-request', session, this.publicUrl))
    }

    async sendTaskNotification(session: Session, notification: TaskNotification): Promise<void> {
        await this.send(createPluginNotificationEvent('task-notification', session, this.publicUrl, {
            task: {
                summary: notification.summary,
                ...(notification.status ? { status: notification.status } : {})
            }
        }))
    }

    async sendSessionCompletion(session: Session, reason: SessionEndReason): Promise<void> {
        await this.send(createPluginNotificationEvent('session-completion', session, this.publicUrl, { reason }))
    }

    private async send(event: PluginNotificationEvent): Promise<void> {
        if (this.isDisposed()) {
            return
        }
        try {
            await this.pluginChannel.send(event)
        } catch (error) {
            throw this.sanitizeError(error)
        }
    }
}
