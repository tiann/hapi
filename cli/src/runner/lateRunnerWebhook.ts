/**
 * Decision for a runner-spawned session webhook whose PID is not in this
 * runner's in-memory TrackedSession map.
 *
 * - Nonshared + timed out by this runner generation: terminate (ghost after
 *   webhook timeout).
 * - Otherwise adopt so StopSession can find the PID: shared Codex roots are
 *   siblings and must never be killed here; nonshared CLIs after a runner
 *   restart mid-bootstrap often have no HAPI id on argv yet, so ignoring the
 *   webhook leaves an unreapable detached CLI (#1910 / #1911).
 * - Either way the webhook must prove it comes from the process that owns
 *   the PID right now. Adoption persists the PID's current start marker as
 *   the generation a later stopSession may tree-kill; a late webhook whose
 *   PID the OS has since handed to another process (even another
 *   runner-spawned CLI) would pin that foreign process to the session. The
 *   reporting CLI sends its own marker as metadata.hostStartMarker:
 *     - marker matches the live PID: adopt (or kill, if timed out);
 *     - marker names another generation, or the probe failed: ignore — the
 *       PID is not this session's process, leave it untracked, never kill;
 *     - no marker (older CLI): nothing proves the generation, so ignore
 *       instead of adopting blindly; the timeout ghost kill is unchanged.
 */

export type UntrackedRunnerWebhookDecision = 'kill' | 'adopt' | 'ignore'

export function decideUntrackedRunnerWebhook(opts: {
    concurrentClients: boolean
    timedOutByThisRunner: boolean
    /** metadata.hostStartMarker as sent by the CLI; undefined from older CLIs. */
    reportedStartMarker: string | undefined
    /** getProcessStartMarker(pid) probed on receipt; null when the probe failed. */
    currentStartMarker: string | null
}): UntrackedRunnerWebhookDecision {
    if (opts.reportedStartMarker && opts.reportedStartMarker !== opts.currentStartMarker) {
        return 'ignore'
    }
    if (!opts.concurrentClients && opts.timedOutByThisRunner) {
        return 'kill'
    }
    if (!opts.reportedStartMarker) {
        return 'ignore'
    }
    return 'adopt'
}
