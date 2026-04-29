import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'

export type TaskNotification = {
    summary: string
    status?: string
}

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
