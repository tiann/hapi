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

    it('steers ordinary active Codex sends when the session opts in', () => {
        expect(resolveMessageDeliveryMode({
            agentFlavor: 'codex', isSessionThinking: true, intent: 'default',
            codexPromptMode: 'steer',
        })).toBe('steer')
    })

    it.each([
        { intent: 'queue' as const },
        { isSessionThinking: false },
        { scheduledAt: 1 },
        { routesToScratchlist: true },
        { agentFlavor: 'claude' },
        { codexPromptMode: 'queue' as const },
    ])('keeps queue overrides and non-Codex sends queued: %j', (override) => {
        expect(resolveMessageDeliveryMode({
            agentFlavor: 'codex', isSessionThinking: true, intent: 'default',
            codexPromptMode: 'steer', ...override,
        })).toBe('queue')
    })

    it('keeps the retry-restore contract: a failed steer retry restores as queue', () => {
        const ref = { current: getRestoredComposerSendIntent('steer') }
        const retryIntent = consumeComposerSendIntent(ref)

        expect(retryIntent).toBe('queue')
        expect(ref.current).toBe('default')
        expect(resolveMessageDeliveryMode({ ...base, intent: retryIntent })).toBe('queue')
    })
})
