import type { MessageDeliveryMode } from '@hapi/protocol'

/**
 * The one-shot UI intent associated with a composer submission.  It is not
 * the wire delivery mode: `default` is resolved against the current session
 * state at the SessionChat boundary, while `queue` is an explicit operator
 * request not to steer an in-flight Pi turn.
 */
export type ComposerSendIntent = 'default' | 'queue'

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
 * A retry cannot prove that the original Pi turn is still active. Preserve an
 * explicit queue, but downgrade turn-scoped steer (and legacy missing mode) to
 * the durable HAPI queue instead of binding the retry to a later generation.
 */
export function getRetryDeliveryMode(
    deliveryMode: MessageDeliveryMode | undefined,
): 'queue' {
    return deliveryMode === 'steer' ? 'queue' : (deliveryMode ?? 'queue')
}

/** Convert retry delivery into the composer's one-shot intent representation. */
export function getRestoredComposerSendIntent(
    deliveryMode: MessageDeliveryMode | undefined,
): ComposerSendIntent {
    return getRetryDeliveryMode(deliveryMode)
}

/**
 * Resolve the web composer intent into the durable message delivery mode.
 *
 * Fresh steering is deliberately narrow: it only applies to an immediate
 * ordinary composer submission while the Pi *main session* reports that it
 * is thinking. Scheduled messages, scratchlist additions, and retries never
 * steer because none can prove the original turn identity.
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
    if (input.agentFlavor !== 'pi') return 'queue'
    return input.isSessionThinking ? 'steer' : 'queue'
}
