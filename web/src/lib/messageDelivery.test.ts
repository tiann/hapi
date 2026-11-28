import { describe, expect, it } from 'vitest'
import {
    consumeComposerSendIntent,
    getRestoredComposerSendIntent,
    getRetryDeliveryMode,
    resolveMessageDeliveryMode,
    type ComposerSendIntentRef,
} from './messageDelivery'

describe('consumeComposerSendIntent', () => {
    it('consumes an explicit queue request exactly once', () => {
        const ref: ComposerSendIntentRef = { current: { intent: 'queue' } }

        expect(consumeComposerSendIntent(ref)).toEqual({ intent: 'queue' })
        expect(ref.current).toEqual({ intent: 'default' })
        expect(consumeComposerSendIntent(ref)).toEqual({ intent: 'default' })
    })

    it('defaults safely when no composer ref is present', () => {
        expect(consumeComposerSendIntent()).toEqual({ intent: 'default' })
    })
})

describe('retry delivery safety', () => {
    it('preserves queue and downgrades steer or missing legacy provenance to queue', () => {
        expect(getRetryDeliveryMode('queue')).toBe('queue')
        expect(getRetryDeliveryMode('steer')).toBe('queue')
        expect(getRetryDeliveryMode(undefined)).toBe('queue')
        expect(getRestoredComposerSendIntent('queue')).toBe('queue')
        expect(getRestoredComposerSendIntent('steer')).toBe('queue')
        expect(getRestoredComposerSendIntent(undefined)).toBe('queue')
    })
})

describe('resolveMessageDeliveryMode', () => {
    const base = {
        agentFlavor: 'pi',
        isSessionThinking: true,
        intent: 'default' as const,
    }

    // Every composer submission queues — mid-turn delivery happens only via
    // the explicit per-queued-message Steer action (issue #1466). The old Pi
    // automatic steer while thinking was removed.
    it.each([
        { name: 'thinking Pi (previously auto-steered)', input: base },
        { name: 'thinking Pi with explicit queue intent', input: { ...base, intent: 'queue' as const } },
        { name: 'idle Pi', input: { ...base, isSessionThinking: false } },
        { name: 'non-Pi flavor', input: { ...base, agentFlavor: 'codex' } },
        { name: 'scheduled message', input: { ...base, scheduledAt: Date.now() + 60_000 } },
        { name: 'scratchlist route', input: { ...base, routesToScratchlist: true } },
    ])('queues $name', ({ input }) => {
        expect(resolveMessageDeliveryMode(input)).toBe('queue')
    })

    it('keeps the retry-restore contract: a failed steer retry restores as queue', () => {
        const ref = { current: { intent: getRestoredComposerSendIntent('steer') } }
        const { intent: retryIntent } = consumeComposerSendIntent(ref)

        expect(retryIntent).toBe('queue')
        expect(ref.current).toEqual({ intent: 'default' })
        expect(resolveMessageDeliveryMode({ ...base, intent: retryIntent })).toBe('queue')
    })
})
