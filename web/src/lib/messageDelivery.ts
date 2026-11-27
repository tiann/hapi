import type { FollowUpIntent, MessageDeliveryMode } from '@hapi/protocol'

/** One composer submission's override for the Hub's follow-up default. */
export type ComposerSendIntent = FollowUpIntent

/** The one-shot mode and optional turn captured at submit time. */
export type ComposerSendSelection = {
    intent: ComposerSendIntent
    expectedFollowUpTurnId?: string
}

export type ComposerSendIntentRef = { current: ComposerSendSelection }

/**
 * Read exactly one composer intent and immediately return the shared ref to
 * the ordinary-send default. This is intentionally independent of React so
 * the assistant-ui adapter can consume the value synchronously in `onNew`.
 */
export function consumeComposerSendIntent(ref?: ComposerSendIntentRef): ComposerSendSelection {
    const selection = ref?.current ?? { intent: 'default' }
    if (ref) ref.current = { intent: 'default' }
    return selection
}

/**
 * A retry cannot prove that the original target turn is still active. Preserve an
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
 * Every composer submission queues by default — for every flavor. The Pi
 * automatic steer (deliveryMode 'steer' while the main session is thinking)
 * was removed in favor of the explicit per-queued-message Steer action
 * (issue #1466), matching Codex/Claude behavior: a mid-turn message waits,
 * and the operator presses Steer to deliver it into the running turn.
 * Scheduled messages, scratchlist additions, and retries always queued
 * already.
 */
export function resolveMessageDeliveryMode(input: {
    agentFlavor: string | null | undefined
    isSessionThinking: boolean
    intent: ComposerSendIntent
    scheduledAt?: number | null
    routesToScratchlist?: boolean
}): MessageDeliveryMode {
    void input
    return 'queue'
}
