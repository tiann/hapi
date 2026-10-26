import { describe, expect, it } from 'vitest'
import { decideUntrackedRunnerWebhook } from './lateRunnerWebhook'

describe('decideUntrackedRunnerWebhook', () => {
    it('adopts shared Codex roots instead of killing (siblings)', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: true,
            timedOutByThisRunner: false,
        })).toBe('adopt')
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: true,
            timedOutByThisRunner: true,
        })).toBe('adopt')
    })

    it('kills nonshared CLIs that this runner timed out', () => {
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: true,
        })).toBe('kill')
    })

    it('adopts nonshared CLIs after runner restart before webhook', () => {
        // No timeout stamp on the new runner generation — ignoring would leave
        // an unreapable process (no argv session id, no durable PID map).
        expect(decideUntrackedRunnerWebhook({
            concurrentClients: false,
            timedOutByThisRunner: false,
        })).toBe('adopt')
    })
})
