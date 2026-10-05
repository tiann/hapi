import { describe, expect, it } from 'vitest'
import { decideUntrackedRunnerWebhook } from './lateRunnerWebhook'

const marker = 'Mon Sep 28 10:00:00 2026'
const otherGeneration = 'Mon Sep 28 10:05:00 2026'
const proven = { reportedStartMarker: marker, currentStartMarker: marker }

describe('decideUntrackedRunnerWebhook', () => {
    it('adopts shared Codex roots instead of killing (siblings)', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: true,
            timedOutByThisRunner: false,
            ...proven,
        })).toBe('adopt')
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: true,
            timedOutByThisRunner: true,
            ...proven,
        })).toBe('adopt')
    })

    it('kills nonshared CLIs that this runner timed out', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: true,
            ...proven,
        })).toBe('kill')
    })

    it('adopts nonshared CLIs after runner restart before webhook', () => {
        // No timeout stamp on the new runner generation — ignoring would leave
        // an unreapable process (no argv session id, no durable PID map).
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: false,
            ...proven,
        })).toBe('adopt')
    })

    it('ignores a webhook whose marker names a generation that no longer owns the PID', () => {
        // Late webhook, PID reused since: adopting would persist the foreign
        // process's marker and let a later stopSession tree-kill it.
        for (const concurrentClients of [false, true]) {
            expect(decideUntrackedRunnerWebhook({
                concurrentClients,
                timedOutByThisRunner: false,
                reportedStartMarker: marker,
                currentStartMarker: otherGeneration,
            })).toBe('ignore')
        }
    })

    it('never kills a PID the webhook proves belongs to another generation', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: true,
            reportedStartMarker: marker,
            currentStartMarker: otherGeneration,
        })).toBe('ignore')
    })

    it('ignores a webhook when the live generation cannot be probed', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: false,
            reportedStartMarker: marker,
            currentStartMarker: null,
        })).toBe('ignore')
    })

    it('ignores a webhook without a marker instead of adopting blindly', () => {
        // Older CLI: nothing proves the generation, so leave the PID untracked
        // rather than pin whatever owns it now to this session.
        for (const concurrentClients of [false, true]) {
            expect(decideUntrackedRunnerWebhook({
                concurrentClients,
                timedOutByThisRunner: false,
                reportedStartMarker: undefined,
                currentStartMarker: marker,
            })).toBe('ignore')
        }
        // The timeout ghost kill for such CLIs is unchanged.
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: true,
            reportedStartMarker: undefined,
            currentStartMarker: marker,
        })).toBe('kill')
    })
})
