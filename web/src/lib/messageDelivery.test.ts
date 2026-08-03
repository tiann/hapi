import { describe, expect, it } from 'vitest'
import {
    consumeComposerSendIntent,
    getRestoredComposerSendIntent,
    resolveMessageDeliveryMode,
} from './messageDelivery'

describe('consumeComposerSendIntent', () => {
    it('consumes an explicit queue request exactly once', () => {
        const ref = { current: 'queue' as const }

        expect(consumeComposerSendIntent(ref)).toBe('queue')
        expect(ref.current).toBe('default')
        expect(consumeComposerSendIntent(ref)).toBe('default')
    })

    it('consumes a restored steer request exactly once', () => {
        const ref = { current: getRestoredComposerSendIntent('steer') }

        expect(consumeComposerSendIntent(ref)).toBe('steer')
        expect(ref.current).toBe('default')
        expect(consumeComposerSendIntent(ref)).toBe('default')
    })

    it('defaults safely when no composer ref is present', () => {
        expect(consumeComposerSendIntent()).toBe('default')
    })
})

describe('getRestoredComposerSendIntent', () => {
    it('preloads the exact original queue or steer wire mode', () => {
        expect(getRestoredComposerSendIntent('queue')).toBe('queue')
        expect(getRestoredComposerSendIntent('steer')).toBe('steer')
    })

    it('uses live-state resolution when no durable mode is available', () => {
        expect(getRestoredComposerSendIntent(undefined)).toBe('default')
    })
})

describe('resolveMessageDeliveryMode', () => {
    const base = {
        agentFlavor: 'pi',
        isSessionThinking: true,
        intent: 'default' as const,
    }

    it('steers an immediate default Pi send while the main session is thinking', () => {
        expect(resolveMessageDeliveryMode(base)).toBe('steer')
    })

    it('keeps an explicit queue gesture queued even while Pi is thinking', () => {
        expect(resolveMessageDeliveryMode({ ...base, intent: 'queue' })).toBe('queue')
    })

    it('preserves restored steer after the Pi main session settles, then resets to fresh idle queueing', () => {
        const ref = { current: getRestoredComposerSendIntent('steer') }
        const retryIntent = consumeComposerSendIntent(ref)

        expect(resolveMessageDeliveryMode({ ...base, isSessionThinking: false, intent: retryIntent })).toBe('steer')
        expect(ref.current).toBe('default')
        expect(resolveMessageDeliveryMode({ ...base, isSessionThinking: false, intent: consumeComposerSendIntent(ref) })).toBe('queue')
    })

    it('keeps scheduled and scratchlist sends queued even when retry provenance says steer', () => {
        expect(resolveMessageDeliveryMode({ ...base, intent: 'steer', scheduledAt: Date.now() + 60_000 })).toBe('queue')
        expect(resolveMessageDeliveryMode({ ...base, intent: 'steer', routesToScratchlist: true })).toBe('queue')
    })

    it('leaves a restored immediate steer intact for Hub to normalize if its target is no longer Pi', () => {
        expect(resolveMessageDeliveryMode({ ...base, agentFlavor: 'codex', intent: 'steer' })).toBe('steer')
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
