import { describe, expect, it } from 'vitest'
import {
    consumeComposerSendIntent,
    getRestoredComposerSendIntent,
    getRetryDeliveryMode,
    resolveMessageDeliveryMode,
} from './messageDelivery'

describe('consumeComposerSendIntent', () => {
    it('consumes an explicit queue request exactly once', () => {
        const ref = { current: 'queue' as const }

        expect(consumeComposerSendIntent(ref)).toBe('queue')
        expect(ref.current).toBe('default')
        expect(consumeComposerSendIntent(ref)).toBe('default')
    })

    it('defaults safely when no composer ref is present', () => {
        expect(consumeComposerSendIntent()).toBe('default')
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

    it('steers an immediate fresh Pi send while the main session is thinking', () => {
        expect(resolveMessageDeliveryMode(base)).toBe('steer')
    })

    it('keeps an explicit queue gesture queued even while Pi is thinking', () => {
        expect(resolveMessageDeliveryMode({ ...base, intent: 'queue' })).toBe('queue')
    })

    it('queues a failed steer retry even when a later Pi generation is active', () => {
        const ref = { current: getRestoredComposerSendIntent('steer') }
        const retryIntent = consumeComposerSendIntent(ref)

        expect(resolveMessageDeliveryMode({ ...base, intent: retryIntent })).toBe('queue')
        expect(ref.current).toBe('default')
        expect(resolveMessageDeliveryMode({ ...base, intent: consumeComposerSendIntent(ref) })).toBe('steer')
    })

    it.each([
        { name: 'idle Pi', input: { ...base, isSessionThinking: false } },
        { name: 'non-Pi flavor', input: { ...base, agentFlavor: 'codex' } },
        { name: 'scheduled message', input: { ...base, scheduledAt: Date.now() + 60_000 } },
        { name: 'scratchlist route', input: { ...base, routesToScratchlist: true } },
    ])('queues $name', ({ input }) => {
        expect(resolveMessageDeliveryMode(input)).toBe('queue')
    })
})
