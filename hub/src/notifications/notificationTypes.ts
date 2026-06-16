import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'

export type TaskNotification = {
    summary: string
    status?: string
}

/**
 * Model error notification: fires when cursor-agent (or another flavor's
 * runtime) hits an internal model-side failure that HAPI detects either
 * structurally (typed AcpStderrError, RPC rejection, transport close) or
 * via the text-classifier fallback for stringified-into-prose errors.
 *
 * Higher urgency than ready/task: an operator who walks away from the
 * web UI MUST get a phone-side / wrist-side ping for this, otherwise the
 * "all done" green dot lies to them. Banner-only is opt-in (requires
 * looking); notification is push (regardless of attention).
 */
export type ModelErrorNotification = {
    kind: string                          // e.g. 'quota_exhausted', 'transport_closed'
    transient: boolean                    // retryable hint (rate_limit / canceled / timeout)
    rawSnippet: string                    // first 400 chars of the raw error text
    priorAssistantClaimsDone: boolean     // agent said "Done"/"Committed" right before the error
    atTs: number                          // metadata.lastModelError.atTs, used for dedup
}

export type NotificationChannel = {
    sendReady: (session: Session) => Promise<void>
    sendPermissionRequest: (session: Session) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
    /**
     * Optional. Channels that don't implement it just skip model-error
     * pings (matches sendSessionCompletion's pattern). Wire this when
     * the channel can render a higher-urgency error variant.
     */
    sendModelError?: (session: Session, notification: ModelErrorNotification) => Promise<void>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
}
