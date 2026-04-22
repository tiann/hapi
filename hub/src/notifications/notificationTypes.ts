import type { Session } from '../sync/syncEngine'

export type AttentionReason = 'failed' | 'interrupted'

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendAttention: (session: Session, reason: AttentionReason) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
    attentionCooldownMs?: number
}
