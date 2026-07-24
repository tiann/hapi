import type { ModelErrorNotification } from './notificationTypes'

/**
 * Map model-error kinds to human-readable titles. Shared by all
 * notification channels (FCM / Web Push / Telegram) so the wrist
 * glance, browser toast, and chat message all read the same.
 *
 * Title is the GLANCE line: short, scannable, kind-specific. The body
 * (separate) carries the priorAssistantClaimsDone alert and agent +
 * session names. Raw provider/RPC text stays in the authenticated web
 * banner only — never in push/Telegram (prompt text, paths, auth crumbs).
 *
 * Unknown kinds fall through to "Model error" so we never ship a
 * notification with `[object Object]` or an internal kind string.
 */
export function formatModelErrorTitle(kind: string): string {
    switch (kind) {
        case 'quota_exhausted':       return 'Quota exhausted'
        case 'rate_limited':          return 'Rate limited'
        case 'capacity_exhausted':    return 'Capacity exhausted'
        case 'context_window':        return 'Context window exceeded'
        case 'auth_failed':           return 'Authentication failed'
        case 'model_not_found':       return 'Model not found'
        case 'transport_closed':      return 'Agent transport closed'
        case 'agent_crashed':         return 'Agent crashed'
        case 'rpc_timeout':           return 'Agent request timed out'
        case 'connection_stalled':    return 'Connection stalled'
        case 'deadline_exceeded':     return 'Deadline exceeded'
        case 'unavailable':           return 'Service unavailable'
        case 'canceled':              return 'Agent canceled'
        case 'prompt_failed':         return 'Prompt failed'
        case 'unknown_stderr':
        case 'unknown_t_prefix':
        default:                      return 'Model error'
    }
}

/**
 * Body line strategy (external channels only — Web Push / Telegram / FCM):
 *   - If priorAssistantClaimsDone, lead with the lying-completion warning
 *     ("agent claimed completion before this error -- work likely
 *     INCOMPLETE"). This is the high-value disambiguator from the
 *     operator's POV: an "all done" green dot followed by an error means
 *     the agent walked away from a half-finished task.
 *   - Append agent/session context.
 *   - Do NOT append rawSnippet: that text is provider/RPC stderr and can
 *     contain prompt fragments, paths, or auth material. Operators see the
 *     full excerpt in the authenticated ModelErrorBanner.
 */
export function formatModelErrorBody(
    notification: ModelErrorNotification,
    context: { agentName: string; sessionName: string }
): string {
    const lines: string[] = []
    if (notification.priorAssistantClaimsDone) {
        lines.push('Agent claimed completion before this error - work likely INCOMPLETE.')
    }
    lines.push(`${context.agentName} - ${context.sessionName}`)
    if (notification.transient) {
        lines.push('(transient - safe to retry)')
    }
    return lines.join('\n')
}
