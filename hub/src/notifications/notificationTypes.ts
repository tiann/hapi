import type { Session } from '../sync/syncEngine'

export type AttentionReason = 'failed' | 'interrupted'

export type NotificationContext = {
    unreadCount: number
    totalUnreadCount: number
}

export type NotificationChannel = {
    sendReady: (session: Session, context?: NotificationContext) => Promise<void>
    sendPermissionRequest: (session: Session, context?: NotificationContext) => Promise<void>
    sendAttention: (session: Session, reason: AttentionReason, context?: NotificationContext) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
    attentionCooldownMs?: number
}
