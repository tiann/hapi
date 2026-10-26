/**
 * Decision for a runner-spawned session webhook whose PID is not in this
 * runner's in-memory TrackedSession map.
 *
 * - Shared Codex: never kill (siblings); adopt so StopSession can find the PID.
 * - Nonshared + timed out by this runner generation: terminate (ghost after
 *   webhook timeout).
 * - Nonshared + not timed out (typical after runner restart mid-bootstrap):
 *   durably adopt — Claude often has no HAPI id on argv yet, so ignoring the
 *   webhook leaves an unreapable detached CLI (#1910 / #1911).
 */

export type UntrackedRunnerWebhookDecision = 'kill' | 'adopt'

export function decideUntrackedRunnerWebhook(opts: {
    concurrentClients: boolean
    timedOutByThisRunner: boolean
}): UntrackedRunnerWebhookDecision {
    if (opts.concurrentClients) {
        return 'adopt'
    }
    if (opts.timedOutByThisRunner) {
        return 'kill'
    }
    return 'adopt'
}
