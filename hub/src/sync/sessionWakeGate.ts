import { waitUntilSessionActive } from './sessionJobWake'

/**
 * Resumes a session so the hub can deliver to it (mature scheduled
 * messages, session tasks). Mirrors the ordering of the job-complete wake
 * (#1489): resume → wait until active → let the caller send.
 *
 * One attempt per session at a time, and a doubling backoff after a failed
 * one, so a machine that is asleep or offline costs one cheap resume
 * rejection per interval instead of one per scheduler tick.
 */

export type WakeableSession = { id: string; namespace: string; active: boolean }

export type SessionWakeResumeResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; code: string; message: string }

export type SessionWakeFailure = { code: string; message: string }

/** Resume results that will not change on retry; the caller should stop asking. */
export const NON_RETRYABLE_WAKE_CODES: ReadonlySet<string> = new Set([
    'session_not_found',
    'access_denied',
    'resume_unavailable'
])

export type SessionWakeGateDeps = {
    getSession: (sessionId: string) => WakeableSession | null
    resumeSession: (sessionId: string, namespace: string) => Promise<SessionWakeResumeResult>
    now?: () => number
    sleep?: (ms: number) => Promise<void>
    /** How long a resumed session has to report active before the attempt counts as failed. */
    activeTimeoutMs?: number
    /** Retry delay after a failed attempt: `min(base * 2^(failures - 1), max)`. */
    baseBackoffMs?: number
    maxBackoffMs?: number
    log?: (message: string, detail: Record<string, unknown>) => void
}

export class SessionWakeGate {
    private readonly inFlight = new Map<string, Promise<boolean>>()
    private readonly backoffUntil = new Map<string, number>()
    private readonly failures = new Map<string, number>()
    private readonly lastFailureBySession = new Map<string, SessionWakeFailure>()

    constructor(private readonly deps: SessionWakeGateDeps) {}

    /** Resolves true once the session is active; false when it could not be woken now. */
    wake(sessionId: string): Promise<boolean> {
        const running = this.inFlight.get(sessionId)
        if (running) return running
        const attempt = this.attempt(sessionId).finally(() => {
            this.inFlight.delete(sessionId)
        })
        this.inFlight.set(sessionId, attempt)
        return attempt
    }

    /** Why the most recent attempt for this session failed, if it did. */
    lastFailure(sessionId: string): SessionWakeFailure | undefined {
        return this.lastFailureBySession.get(sessionId)
    }

    /** Drop retry state for a session that no longer exists. */
    forget(sessionId: string): void {
        this.backoffUntil.delete(sessionId)
        this.failures.delete(sessionId)
        this.lastFailureBySession.delete(sessionId)
    }

    private clear(sessionId: string): void {
        this.forget(sessionId)
    }

    private fail(sessionId: string, code: string, message: string): void {
        const count = (this.failures.get(sessionId) ?? 0) + 1
        this.failures.set(sessionId, count)
        const base = this.deps.baseBackoffMs ?? 15_000
        const max = this.deps.maxBackoffMs ?? 60_000
        this.backoffUntil.set(sessionId, this.now() + Math.min(base * 2 ** (count - 1), max))
        const previous = this.lastFailureBySession.get(sessionId)
        this.lastFailureBySession.set(sessionId, { code, message })
        // A sleeping machine fails the same way for hours; say it once per code.
        if (previous?.code !== code) {
            this.deps.log?.('[session-wake] resume deferred', { sessionId, code, message })
        }
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    private async attempt(sessionId: string): Promise<boolean> {
        const session = this.deps.getSession(sessionId)
        if (!session) return false
        if (session.active) {
            this.clear(sessionId)
            return true
        }
        const blockedUntil = this.backoffUntil.get(sessionId)
        if (blockedUntil !== undefined && blockedUntil > this.now()) return false

        let result: SessionWakeResumeResult
        try {
            result = await this.deps.resumeSession(sessionId, session.namespace)
        } catch (error) {
            result = {
                type: 'error',
                code: 'resume_failed',
                message: error instanceof Error ? error.message : String(error)
            }
        }
        if (result.type !== 'success') {
            this.fail(sessionId, result.code, result.message)
            return false
        }
        const becameActive = await waitUntilSessionActive({
            getActive: () => this.deps.getSession(sessionId)?.active === true,
            sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
            now: this.now.bind(this),
            timeoutMs: this.deps.activeTimeoutMs ?? 30_000,
            pollMs: 250
        })
        if (!becameActive) {
            this.fail(sessionId, 'resume_failed', 'Session did not become active')
            return false
        }
        this.clear(sessionId)
        return true
    }
}
