import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationSendContext } from './notificationSendContext'

export type TaskNotification = {
    summary: string
    status?: string
}

export type NotificationChannel = {
    sendReady: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendPermissionRequest: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification, ctx?: NotificationSendContext) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
