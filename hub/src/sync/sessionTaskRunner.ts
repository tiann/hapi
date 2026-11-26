import {
    buildSessionTaskMessageLocalId,
    nextRepeatRunAt,
    type SessionTaskErrorCode
} from '@hapi/protocol'
import type { Store } from '../store'
import type { StoredSessionTask } from '../store/sessionTasks'
import { NON_RETRYABLE_WAKE_CODES, type SessionWakeFailure, type WakeableSession } from './sessionWakeGate'

/**
 * Drives session tasks on the hub's 5s tick.
 *
 * One prompt per task is outstanding at a time:
 *
 * - `deliver` inserts the task's next prompt and records its localId.
 * - `settle` runs once the CLI acknowledges taking that prompt, and moves the
 *   task on: a `queue` task schedules its next prompt `intervalMs` after the
 *   acknowledgement, a `repeat` task stays on its fixed grid.
 *
 * A `repeat` task that comes due while its previous prompt is still waiting
 * skips that slot, so a busy agent never has a second prompt stacked on it.
 */

export type SessionTaskRunnerDeps = {
    store: Pick<Store, 'sessionTasks' | 'messages'>
    getSession: (sessionId: string) => WakeableSession | null
    /** Resume the session if it is not active; false when that could not be done now. */
    wake: (sessionId: string) => Promise<boolean>
    wakeFailure: (sessionId: string) => SessionWakeFailure | undefined
    sendMessage: (sessionId: string, payload: { text: string; localId: string }) => Promise<void>
    onTasksChanged: (sessionId: string) => void
    now?: () => number
    /** How long to wait before retrying a run whose send threw. */
    retryDelayMs?: number
    log?: (message: string, detail: Record<string, unknown>) => void
}

export class SessionTaskRunner {
    private readonly inFlight = new Set<string>()
    private readonly retryAt = new Map<string, number>()

    constructor(private readonly deps: SessionTaskRunnerDeps) {}

    /** Look at every task that needs attention now. Safe to call on every tick. */
    async tick(): Promise<void> {
        const now = this.now()
        const runs: Array<Promise<void>> = []
        for (const task of this.deps.store.sessionTasks.findRunnable(now)) {
            if (this.inFlight.has(task.id)) continue
            if (task.pendingLocalId === null && !this.retryElapsed(task.id, now)) continue
            const run = this.run(task, now).finally(() => {
                this.inFlight.delete(task.id)
            })
            this.inFlight.add(task.id)
            runs.push(run)
        }
        if (runs.length > 0) await Promise.all(runs)
    }

    private retryElapsed(taskId: string, now: number): boolean {
        const retryAt = this.retryAt.get(taskId)
        if (retryAt === undefined) return true
        if (retryAt > now) return false
        this.retryAt.delete(taskId)
        return true
    }

    private async run(task: StoredSessionTask, now: number): Promise<void> {
        try {
            if (task.pendingLocalId !== null) {
                this.settle(task, now)
                return
            }
            if (task.state !== 'active' || task.nextRunAt === null || task.nextRunAt > now) return
            await this.deliver(task)
        } catch (error) {
            this.retryAt.set(task.id, this.now() + (this.deps.retryDelayMs ?? 15_000))
            this.deps.log?.('[session-task] run failed', {
                taskId: task.id,
                sessionId: task.sessionId,
                error: error instanceof Error ? error.message : String(error)
            })
            this.changed(task, this.deps.store.sessionTasks.setError(task.id, 'send_failed', this.now()))
        }
    }

    /** The pending prompt was taken (or cancelled): step the task forward. */
    private settle(task: StoredSessionTask, now: number): void {
        const store = this.deps.store.sessionTasks
        const session = this.deps.getSession(task.sessionId)
        const lookup = session
            ? this.deps.store.messages.lookupQueuedMessage(session.id, task.pendingLocalId as string)
            : ({ status: 'absent' } as const)

        if (lookup.status === 'invoked' || lookup.status === 'absent') {
            const consumedAt = lookup.status === 'invoked' ? (lookup.message.invokedAt ?? now) : now
            this.completeSend(task, consumedAt, now)
            return
        }

        // Still queued. Wake an inactive session so the prompt is replayed to it.
        if (session && !session.active) {
            void this.deps.wake(session.id).catch(() => undefined)
        }
        // A repeat task came due again while its previous prompt waits: skip the slot.
        if (
            task.kind === 'repeat'
            && task.state === 'active'
            && task.nextRunAt !== null
            && task.nextRunAt <= now
        ) {
            const nextRunAt = nextRepeatRunAt(task.nextRunAt, task.intervalMs, now)
            this.changed(task, store.skipDueSlot(task.id, nextRunAt, now))
        }
    }

    private completeSend(task: StoredSessionTask, consumedAt: number, now: number): void {
        const store = this.deps.store.sessionTasks
        const finished = task.kind === 'queue'
            ? task.runCount >= task.items.length
            : task.maxRuns !== null && task.runCount >= task.maxRuns
        if (finished) {
            // Nothing left to send; the prompts themselves stay in the transcript.
            this.changed(task, store.delete(task.id))
            return
        }
        // Queue: the next prompt follows the acknowledgement. Repeat: keep the grid,
        // unless the task was resumed while this prompt was pending (no grid left).
        const followsConsumption = task.kind === 'queue' || task.nextRunAt === null
        const nextRunAt = task.state === 'active' && followsConsumption
            ? consumedAt + task.intervalMs
            : task.state === 'active'
                ? undefined
                : null
        this.changed(task, store.settlePending(task.id, { consumedAt, nextRunAt, now }))
    }

    private async deliver(task: StoredSessionTask): Promise<void> {
        const store = this.deps.store.sessionTasks
        const session = this.deps.getSession(task.sessionId)
        if (!session) {
            // The session row is gone. Its tasks normally go with it (FK cascade).
            this.changed(task, store.delete(task.id))
            return
        }

        if (!session.active) {
            const awake = await this.deps.wake(session.id)
            if (!awake) {
                this.recordWakeFailure(task, session.id)
                return
            }
        }

        const runNumber = task.runCount + 1
        const text = task.kind === 'queue' ? task.items[task.runCount] : task.items[0]
        if (text === undefined) {
            this.changed(task, store.pauseWithError(task.id, 'send_failed', this.now()))
            return
        }
        const localId = buildSessionTaskMessageLocalId(task.id, runNumber)
        // A previous hub process may have inserted this prompt and stopped
        // before recording it. The localId makes that insert idempotent.
        if (this.deps.store.messages.lookupQueuedMessage(session.id, localId).status === 'absent') {
            await this.deps.sendMessage(session.id, { text, localId })
        }

        const sentAt = this.now()
        const nextRunAt = task.kind === 'repeat'
            ? nextRepeatRunAt(task.nextRunAt as number, task.intervalMs, sentAt)
            : null
        this.changed(task, store.markSent(task.id, { localId, nextRunAt, now: sentAt }))
    }

    private recordWakeFailure(task: StoredSessionTask, sessionId: string): void {
        const store = this.deps.store.sessionTasks
        const failure = this.deps.wakeFailure(sessionId)
        const now = this.now()
        if (failure && NON_RETRYABLE_WAKE_CODES.has(failure.code)) {
            // Archived or deleted sessions do not come back by waiting.
            this.changed(task, store.pauseWithError(task.id, 'session_unavailable', now))
            return
        }
        const code: SessionTaskErrorCode = failure?.code === 'no_machine_online'
            ? 'machine_offline'
            : 'send_failed'
        this.changed(task, store.setError(task.id, code, now))
    }

    private changed(task: StoredSessionTask, storeChanged: boolean): void {
        if (storeChanged) this.deps.onTasksChanged(task.sessionId)
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }
}
