import type { Session } from '../sync/syncEngine'
import type { SessionEndReason } from '@hapi/protocol'
import type { NotificationSendContext } from './notificationSendContext'

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

/**
 * Outcome of a model-error channel send. Used by NotificationHub to decide
 * whether to keep or roll back the per-session watermark:
 * - delivered: at least one destination accepted the ping
 * - unavailable: channel had nothing to do (no subs, deferred to native, inactive)
 * - failed: channel tried and every destination failed
 */
export type ModelErrorSendOutcome = 'delivered' | 'unavailable' | 'failed'

export type NotificationChannel = {
    sendReady: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendPermissionRequest: (session: Session, ctx?: NotificationSendContext) => Promise<void>
    sendTaskNotification: (session: Session, notification: TaskNotification, ctx?: NotificationSendContext) => Promise<void>
    sendSessionCompletion?: (session: Session, reason: SessionEndReason) => Promise<void>
    /**
     * Optional. Channels that don't implement it just skip model-error
     * pings (matches sendSessionCompletion's pattern). Wire this when
     * the channel can render a higher-urgency error variant.
     *
     * Pass the same NotificationSendContext as ready/permission/task so
     * FCM can set nativeGate.sent and Web Push can defer (one OS ping).
     * Return a real delivery outcome so the hub watermark is not consumed
     * when every destination failed.
     */
    sendModelError?: (
        session: Session,
        notification: ModelErrorNotification,
        ctx?: NotificationSendContext
    ) => Promise<ModelErrorSendOutcome>
}

export type NotificationHubOptions = {
    readyCooldownMs?: number
    permissionDebounceMs?: number
    /**
     * Backoff delays (ms) for model-error delivery retries after a failed
     * dispatch. Empty / omitted uses the default ladder. Exhausted delays
     * keep the watermark so session-updated storms do not re-fire forever.
     */
    modelErrorRetryDelaysMs?: number[]
}
