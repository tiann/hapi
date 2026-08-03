import type { MessageDeliveryMode } from '@hapi/protocol'

/**
 * The one-shot UI intent associated with a composer submission.  It is not
 * the wire delivery mode: `default` is resolved against the current session
 * state at the SessionChat boundary, while `queue` is an explicit operator
 * request not to steer an in-flight Pi turn. `steer` is only restored from a
 * failed send so its retry preserves the original wire delivery mode.
 */
export type ComposerSendIntent = 'default' | 'queue' | 'steer'

/** Structural shape shared by React's mutable ref and the runtime adapter. */
export type ComposerSendIntentRef = { current: ComposerSendIntent }

/**
 * Read exactly one composer intent and immediately return the shared ref to
 * the ordinary-send default. This is intentionally independent of React so
 * the assistant-ui adapter can consume the value synchronously in `onNew`.
 */
export function consumeComposerSendIntent(ref?: ComposerSendIntentRef): ComposerSendIntent {
    const intent = ref?.current ?? 'default'
    if (ref) ref.current = 'default'
    return intent
}

/**
 * Convert the durable mode recorded for a failed send back into its one-shot
 * composer intent. Missing provenance predates delivery modes and falls back
 * to the ordinary live-state-resolved send.
 */
export function getRestoredComposerSendIntent(
    deliveryMode: MessageDeliveryMode | undefined,
): ComposerSendIntent {
    return deliveryMode ?? 'default'
}

/**
 * Resolve the web composer intent into the durable message delivery mode.
 *
 * Fresh steering is deliberately narrow: it only applies to an immediate
 * ordinary composer submission while the Pi *main session* reports that it
 * is thinking. Scheduled messages and scratchlist additions never steer. A
 * restored explicit steer is passed through for Hub to normalize if the
 * target has changed since the failed attempt.
 */
export function resolveMessageDeliveryMode(input: {
    agentFlavor: string | null | undefined
    isSessionThinking: boolean
    intent: ComposerSendIntent
    scheduledAt?: number | null
    routesToScratchlist?: boolean
}): MessageDeliveryMode {
    if (input.scheduledAt != null) return 'queue'
    if (input.routesToScratchlist === true) return 'queue'
    if (input.intent === 'queue') return 'queue'
    if (input.intent === 'steer') return 'steer'
    if (input.agentFlavor !== 'pi') return 'queue'
    return input.isSessionThinking ? 'steer' : 'queue'
}
