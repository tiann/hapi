import { waitUntilSessionActive } from './sessionJobWake'

/**
 * Resumes a session so the hub can deliver to it (mature scheduled
 * messages, session tasks). Mirrors the ordering of the job-complete wake
 * (#1489): resume → wait until active → let the caller send.
 *
 * One attempt per session at a time, and a doubling backoff after a failed
 * one, so a machine that is asleep or offline costs one cheap resume
 * rejection per interval instead of one per scheduler tick. At most
 * `SESSION_WAKE_MAX_CONCURRENT_RESUMES` resumes run in the whole hub at
 * once; a wake that finds the budget spent is deferred, not attempted.
 *
 * An archived session is never resumed here: the wake is refused with
 * `session_archived` before `resumeSession` is called, because resuming
 * would un-archive it and spend tokens with nobody watching.
 */

/** Session resumes the hub runs at once, across every wake caller. */
export const SESSION_WAKE_MAX_CONCURRENT_RESUMES = 3

export type WakeableSession = {
    id: string
    namespace: string
    active: boolean
    archived: boolean
}

export type SessionWakeResumeResult =
    | { type: 'success'; sessionId: string }
    | { type: 'error'; code: string; message: string }

export type SessionWakeFailure = { code: string; message: string }

/**
 * - `active`: the session is running; a prompt can be sent now.
 * - `refused`: a resume was attempted and did not get the session running; `failure` says why.
 * - `deferred`: nothing was attempted now (the backoff has not elapsed, or the hub's resume budget is spent).
 */
export type SessionWakeResult =
    | { type: 'active' }
    | { type: 'refused'; failure: SessionWakeFailure }
    | { type: 'deferred' }

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
    /** Resumes allowed at once across the hub. */
    maxConcurrentResumes?: number
    log?: (message: string, detail: Record<string, unknown>) => void
}

export class SessionWakeGate {
    private readonly inFlight = new Map<string, Promise<SessionWakeResult>>()
    private readonly backoffUntil = new Map<string, number>()
    private readonly failures = new Map<string, number>()
    private readonly lastFailureBySession = new Map<string, SessionWakeFailure>()
    /** Requested id → id the resume rotated it to; the requested row no longer exists. */
    private readonly rotatedTo = new Map<string, string>()
    private resumesInFlight = 0

    constructor(private readonly deps: SessionWakeGateDeps) {}

    /** Resolves `active` once the session is running, or says why it is not. */
    wake(sessionId: string): Promise<SessionWakeResult> {
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
            ?? this.lastFailureBySession.get(this.rotatedTo.get(sessionId) ?? '')
    }

    /** Drop retry state for a session that no longer exists. */
    forget(sessionId: string): void {
        this.backoffUntil.delete(sessionId)
        this.failures.delete(sessionId)
        this.lastFailureBySession.delete(sessionId)
    }

    /** A successful wake: the requested id and the one it may have rotated to start clean. */
    private clear(sessionId: string): void {
        const rotated = this.rotatedTo.get(sessionId)
        this.rotatedTo.delete(sessionId)
        this.forget(sessionId)
        if (rotated !== undefined) this.forget(rotated)
    }

    private fail(sessionId: string, code: string, message: string): SessionWakeResult {
        const count = (this.failures.get(sessionId) ?? 0) + 1
        this.failures.set(sessionId, count)
        const base = this.deps.baseBackoffMs ?? 15_000
        const max = this.deps.maxBackoffMs ?? 60_000
        this.backoffUntil.set(sessionId, this.now() + Math.min(base * 2 ** (count - 1), max))
        const previous = this.lastFailureBySession.get(sessionId)
        const failure = { code, message }
        this.lastFailureBySession.set(sessionId, failure)
        // A sleeping machine fails the same way for hours; say it once per code.
        if (previous?.code !== code) {
            this.deps.log?.('[session-wake] resume deferred', { sessionId, code, message })
        }
        return { type: 'refused', failure }
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }

    private async attempt(sessionId: string): Promise<SessionWakeResult> {
        const session = this.deps.getSession(sessionId)
        if (!session) {
            return { type: 'refused', failure: { code: 'session_not_found', message: 'Session not found' } }
        }
        if (session.active) {
            this.clear(sessionId)
            return { type: 'active' }
        }
        if (session.archived) {
            return this.fail(sessionId, 'session_archived', 'Session is archived')
        }
        const blockedUntil = this.backoffUntil.get(sessionId)
        if (blockedUntil !== undefined && blockedUntil > this.now()) return { type: 'deferred' }
        if (this.resumesInFlight >= (this.deps.maxConcurrentResumes ?? SESSION_WAKE_MAX_CONCURRENT_RESUMES)) {
            return { type: 'deferred' }
        }

        let result: SessionWakeResumeResult
        this.resumesInFlight += 1
        try {
            result = await this.deps.resumeSession(sessionId, session.namespace)
        } catch (error) {
            result = {
                type: 'error',
                code: 'resume_failed',
                message: error instanceof Error ? error.message : String(error)
            }
        }
        // A resume may rotate the session id (the row is merged into the one
        // the runner spawned). From here on everything is about that row.
        const targetId = result.type === 'success' ? result.sessionId : sessionId
        if (targetId !== sessionId) this.rotatedTo.set(sessionId, targetId)
        try {
            if (result.type !== 'success') {
                return this.fail(targetId, result.code, result.message)
            }
            const becameActive = await waitUntilSessionActive({
                getActive: () => this.deps.getSession(targetId)?.active === true,
                sleep: this.deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))),
                now: this.now.bind(this),
                timeoutMs: this.deps.activeTimeoutMs ?? 30_000,
                pollMs: 250
            })
            if (!becameActive) {
                return this.fail(targetId, 'resume_failed', 'Session did not become active')
            }
            this.clear(sessionId)
            return { type: 'active' }
        } finally {
            this.resumesInFlight -= 1
        }
    }
}
