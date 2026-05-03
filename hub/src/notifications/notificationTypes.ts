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

/**
 * Task-status classifier shared by notification channels. Accepts the raw
 * status string and returns true when the task is considered a failure.
 * The comparison is case-insensitive and trims whitespace.
 */
export function isFailureStatus(status: string | undefined): boolean {
    const s = status?.trim().toLowerCase()
    return s === 'failed' || s === 'error' || s === 'killed' || s === 'aborted'
}
