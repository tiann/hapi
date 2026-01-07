import type { Session } from '../sync/syncEngine'

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendQuestion?: (session: Session, questionSummary: string) => Promise<void>
    sendError?: (session: Session, errorMessage: string) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
    questionDebounceMs?: number
}
