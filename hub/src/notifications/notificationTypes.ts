import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationSendContext } from './notificationSendContext'

export type NotificationChannel = {
    sendReady: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendPermissionRequest: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
