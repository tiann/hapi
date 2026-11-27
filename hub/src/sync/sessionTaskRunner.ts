import {
    buildSessionTaskMessageLocalId,
    nextRepeatRunAt,
    type SessionTaskErrorCode
} from '@hapi/protocol'
import type { Store } from '../store'
import {
    SESSION_TASK_RUN_RETENTION_MS,
    sessionTaskRunPreview,
    type StoredSessionTask
} from '../store/sessionTasks'
import type { SessionWakeResult, WakeableSession } from './sessionWakeGate'

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
 * The first skipped slot of a prompt is one line in the history, then at
 * most one an hour for as long as that prompt keeps waiting.
 *
 * Every run leaves a line in the run history (`session_task_runs`): a prompt
 * sent (stamped when the agent takes it, or flipped to `cancelled`), a slot
 * skipped, or a run that could not go out.
 */

/** Times the hub wakes a session for one pending prompt before it stops and reports `prompt_not_taken`. */
export const SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS = 3
/** How often run-history rows past the retention age are deleted. */
export const SESSION_TASK_RUN_PRUNE_INTERVAL_MS = 60 * 60 * 1000
/**
 * How often a skipped slot is written to the history again while the same
 * prompt keeps waiting: the first skipped slot always is, then at most one
 * an hour (an overnight outage on a one-minute task would otherwise fill
 * the history with skipped lines).
 */
export const SESSION_TASK_SKIP_REPEAT_MS = 60 * 60 * 1000

export type SessionTaskRunnerDeps = {
    store: Pick<Store, 'sessionTasks' | 'messages' | 'resolveMessageTarget'>
    getSession: (sessionId: string) => WakeableSession | null
    /** Resume the session if it is not active; the result says whether it is running now, and if not, why. */
    wake: (sessionId: string) => Promise<SessionWakeResult>
    sendMessage: (sessionId: string, payload: { text: string; localId: string }) => Promise<void>
    /** Remove a prompt the runner inserted but no task tracks any more. */
    cancelMessage: (sessionId: string, localId: string) => Promise<void>
    onTasksChanged: (sessionId: string) => void
    now?: () => number
    /** How long to wait before retrying a run whose send threw. */
    retryDelayMs?: number
    pruneIntervalMs?: number
    log?: (message: string, detail: Record<string, unknown>) => void
}

/**
 * The task error that a wake failure leaves on a task. Everything that says
 * the session could not be resumed is `session_unavailable`; `send_failed`
 * is kept for a run whose insert threw (see `run`). The engine reads the
 * same classification to tell a user about a scheduled message whose
 * session will not resume (`SyncEngine.reportUnresumableScheduledMessages`).
 */
export function taskErrorCodeFor(wakeCode: string): SessionTaskErrorCode {
    switch (wakeCode) {
        case 'no_machine_online':
            return 'machine_offline'
        case 'session_archived':
            return 'session_archived'
        case 'resume_unavailable':
        case 'resume_failed':
        case 'session_not_found':
        case 'access_denied':
            return 'session_unavailable'
        default:
            return 'send_failed'
    }
}

/** The prompt the task's next run sends: the one after the last sent (queue), or the only one (repeat). */
function nextPrompt(task: StoredSessionTask): string | undefined {
    return task.kind === 'queue' ? task.items[task.runCount] : task.items[0]
}

export class SessionTaskRunner {
    private readonly inFlight = new Set<string>()
    private readonly retryAt = new Map<string, number>()
    /** Wake attempts so far, per pending prompt localId. */
    private readonly pendingWakeAttempts = new Map<string, number>()
    /** Per task: the prompt that was waiting and the time of the last skipped slot written to the history. */
    private readonly skipRecordedAt = new Map<string, { pendingLocalId: string; at: number }>()
    private lastPruneAt = 0

    constructor(private readonly deps: SessionTaskRunnerDeps) {}

    /** Look at every task that needs attention now. Safe to call on every tick. */
    async tick(): Promise<void> {
        const now = this.now()
        this.pruneRuns(now)
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

    /**
     * Drop the wake count of a prompt (`task.pendingLocalId`): the user
     * resumed its task, so the hub tries the session again from the start
     * instead of answering `prompt_not_taken` at once, or deleted the task,
     * so nothing is left to count for. A null prompt is nothing to forget.
     */
    forgetPrompt(pendingLocalId: string | null): void {
        if (pendingLocalId !== null) this.pendingWakeAttempts.delete(pendingLocalId)
    }

    private retryElapsed(taskId: string, now: number): boolean {
        const retryAt = this.retryAt.get(taskId)
        if (retryAt === undefined) return true
        if (retryAt > now) return false
        this.retryAt.delete(taskId)
        return true
    }

    /** Run-history rows older than the retention age go, at most once per interval. */
    private pruneRuns(now: number): void {
        if (now - this.lastPruneAt < (this.deps.pruneIntervalMs ?? SESSION_TASK_RUN_PRUNE_INTERVAL_MS)) return
        this.lastPruneAt = now
        try {
            this.deps.store.sessionTasks.pruneRuns(now - SESSION_TASK_RUN_RETENTION_MS)
        } catch (error) {
            this.log('prune failed', error)
        }
    }

    private async run(task: StoredSessionTask, now: number): Promise<void> {
        try {
            if (task.pendingLocalId !== null) {
                await this.settle(task, now)
                return
            }
            if (task.state !== 'active' || task.nextRunAt === null || task.nextRunAt > now) return
            await this.deliver(task)
        } catch (error) {
            this.retryAt.set(task.id, this.now() + (this.deps.retryDelayMs ?? 15_000))
            this.log('run failed', error, task)
            const failedAt = this.now()
            if (this.deps.store.sessionTasks.setError(task.id, 'send_failed', failedAt)) {
                this.recordRun(task, { outcome: 'failed', detail: 'send_failed', now: failedAt })
                this.changed(task)
            }
        }
    }

    /** The session a prompt of this task lives in: an unfinished OpenCode /clear redirects new messages to the replacement. */
    private promptSessionId(task: StoredSessionTask): string {
        return this.deps.store.resolveMessageTarget(task.sessionId) ?? task.sessionId
    }

    /** The pending prompt was taken (or cancelled): step the task forward. */
    private async settle(task: StoredSessionTask, now: number): Promise<void> {
        const store = this.deps.store.sessionTasks
        const localId = task.pendingLocalId as string
        const session = this.deps.getSession(task.sessionId)
        const lookup = session
            ? this.deps.store.messages.lookupQueuedMessage(this.promptSessionId(task), localId)
            : ({ status: 'absent' } as const)

        if (lookup.status === 'invoked' || lookup.status === 'absent') {
            const taken = lookup.status === 'invoked'
            const consumedAt = taken ? (lookup.message.invokedAt ?? now) : now
            this.completeSend(task, localId, taken, consumedAt, now)
            return
        }
        if (lookup.status === 'indeterminate') {
            // Whether the agent took the prompt is unknown. Only the queued-message
            // bar's Retry (the row is queued again) or Discard (the row is gone) moves
            // the task on; waking the session would not deliver an indeterminate row.
            if (store.setError(task.id, 'prompt_indeterminate', now)) this.changed(task)
            return
        }

        // The row is queued again (Retry in the queued-message bar): it is plainly
        // waiting once more, so the task stops saying its take is unknown — now,
        // not when the agent gets to it.
        if (task.lastError === 'prompt_indeterminate' && store.setError(task.id, null, now)) this.changed(task)

        // Still queued (or being dispatched). A repeat task that came due again
        // while its previous prompt waits: skip the slot. The first skipped slot
        // of a prompt is a line in the history, then at most one an hour for as
        // long as that prompt keeps waiting, whatever kept it waiting (a busy
        // agent, an offline machine, an archived session); a slot that writes
        // no line announces nothing.
        if (task.kind === 'repeat' && task.state === 'active' && task.nextRunAt !== null && task.nextRunAt <= now) {
            const skippedFor = task.nextRunAt
            const nextRunAt = nextRepeatRunAt(task.nextRunAt, task.intervalMs, now)
            if (store.skipDueSlot(task.id, nextRunAt, now) && this.skipIsWritable(task, localId, now)) {
                this.skipRecordedAt.set(task.id, { pendingLocalId: localId, at: now })
                this.recordRun(task, { outcome: 'skipped', scheduledFor: skippedFor, detail: 'previous_prompt_waiting', now })
                this.changed(task)
            }
        }

        // The prompt is still waiting on a session that is not running: wake it
        // so the prompt is replayed to the agent, a bounded number of times.
        if (session && !session.active) {
            await this.wakeForPendingPrompt(task, localId, session.id, now)
        }
    }

    /**
     * Whether a skipped slot is written up. The first one while this prompt
     * waits always is; a later one only once `SESSION_TASK_SKIP_REPEAT_MS` has
     * passed since the last line. The bookkeeping is per hub process, so a
     * restart writes one more first line.
     */
    private skipIsWritable(task: StoredSessionTask, pendingLocalId: string, now: number): boolean {
        const last = this.skipRecordedAt.get(task.id)
        return last === undefined || last.pendingLocalId !== pendingLocalId || now - last.at >= SESSION_TASK_SKIP_REPEAT_MS
    }

    /** The task is gone: nothing of it is left to remember. */
    private remove(task: StoredSessionTask): boolean {
        this.skipRecordedAt.delete(task.id)
        return this.deps.store.sessionTasks.delete(task.id)
    }

    private completeSend(task: StoredSessionTask, localId: string, taken: boolean, consumedAt: number, now: number): void {
        const store = this.deps.store.sessionTasks
        this.pendingWakeAttempts.delete(localId)
        if (taken) store.markRunTaken(task.sessionId, localId, consumedAt)
        else store.markRunCancelled(task.sessionId, localId)
        const finished = task.kind === 'queue'
            ? task.runCount >= task.items.length
            : task.maxRuns !== null && task.runCount >= task.maxRuns
        if (finished) {
            // Nothing left to send; the prompts themselves stay in the transcript.
            this.changed(task, this.remove(task))
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
            this.changed(task, this.remove(task))
            return
        }

        if (!session.active) {
            const outcome = await this.deps.wake(session.id)
            if (outcome.type === 'refused') {
                this.recordWakeFailure(task, outcome)
                return
            }
            if (outcome.type !== 'active') return
        }

        // The wake took time, and may have moved the task to a new session row
        // (a resume that rotated the id merges the old row away). Work from the
        // task as it is now, and send nothing once it was deleted or paused, or
        // another run already sent, in the meantime.
        const current = store.getById(task.id)
        if (!current || current.state !== 'active' || current.pendingLocalId !== null) return
        const target = this.deps.getSession(current.sessionId)
        if (!target) {
            this.changed(current, this.remove(current))
            return
        }
        await this.send(current, target)
    }

    private async send(task: StoredSessionTask, session: WakeableSession): Promise<void> {
        const store = this.deps.store.sessionTasks
        const runNumber = task.runCount + 1
        const text = nextPrompt(task)
        if (text === undefined) {
            // No prompt left: the queue is over. (Runs normally delete the task on the last acknowledgement.)
            this.changed(task, this.remove(task))
            return
        }
        const localId = buildSessionTaskMessageLocalId(task.id, runNumber)
        const preview = sessionTaskRunPreview(text)
        // A previous hub process may have inserted this prompt and stopped
        // before recording it. The localId makes that insert idempotent.
        if (this.deps.store.messages.lookupQueuedMessage(this.promptSessionId(task), localId).status === 'absent') {
            await this.deps.sendMessage(session.id, { text, localId })
        }

        // The insert took time (an input translation is an LLM call): the task
        // may have been deleted or paused while the prompt was on its way. An
        // untracked prompt must not go out on its own: take it back.
        const current = store.getById(task.id)
        if (!current || current.state !== 'active') {
            await this.takeBack(task, localId)
            return
        }

        const sentAt = this.now()
        const nextRunAt = task.kind === 'repeat'
            ? nextRepeatRunAt(task.nextRunAt as number, task.intervalMs, sentAt)
            : null
        if (!store.markSent(task.id, { localId, nextRunAt, now: sentAt })) {
            // Another run counted this send in the meantime.
            await this.takeBack(task, localId)
            return
        }
        this.recordRun(task, { runNumber, localId, outcome: 'sent', preview, now: sentAt })
        this.changed(task)
    }

    /** Remove a prompt the runner inserted but no active task tracks: it lives where the redirect put it. */
    private async takeBack(task: StoredSessionTask, localId: string): Promise<void> {
        try {
            await this.deps.cancelMessage(this.promptSessionId(task), localId)
        } catch (error) {
            this.log('could not take back an untracked prompt', error, task)
        }
    }

    private async wakeForPendingPrompt(task: StoredSessionTask, localId: string, sessionId: string, now: number): Promise<void> {
        const attempts = this.pendingWakeAttempts.get(localId) ?? 0
        if (attempts >= SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS) {
            // Woken that many times and the agent never took the prompt: stop
            // waking, show why, and let the user decide.
            if (this.deps.store.sessionTasks.setError(task.id, 'prompt_not_taken', now)) this.changed(task)
            return
        }
        const outcome = await this.deps.wake(sessionId)
        if (outcome.type === 'active') {
            this.pendingWakeAttempts.set(localId, attempts + 1)
        } else if (outcome.type === 'refused') {
            this.recordWakeFailure(task, outcome)
        }
    }

    /**
     * Put the wake failure on the task. The task stays due (nothing here
     * pauses it): the gate's backoff paces the retries, and the error clears
     * on the next run that goes out. A failure that stopped a run from going
     * out is also one history line, written when it is new for the task.
     */
    private recordWakeFailure(
        task: StoredSessionTask,
        outcome: Extract<SessionWakeResult, { type: 'refused' }>,
        now: number = this.now()
    ): void {
        const code = taskErrorCodeFor(outcome.failure.code)
        if (!this.deps.store.sessionTasks.setError(task.id, code, now)) return
        if (task.pendingLocalId === null) {
            this.recordRun(task, { outcome: 'failed', detail: code, now })
        }
        this.changed(task)
    }

    private recordRun(
        task: StoredSessionTask,
        run: {
            runNumber?: number
            localId?: string
            outcome: 'sent' | 'skipped' | 'failed'
            scheduledFor?: number | null
            detail?: string | null
            preview?: string | null
            now: number
        }
    ): void {
        this.deps.store.sessionTasks.recordRun({
            sessionId: task.sessionId,
            taskId: task.id,
            taskKind: task.kind,
            runNumber: run.runNumber ?? null,
            localId: run.localId,
            outcome: run.outcome,
            scheduledFor: run.scheduledFor === undefined ? task.nextRunAt : run.scheduledFor,
            detail: run.detail ?? null,
            // The prompt this run was about (the next one of a queue), when the caller did not pass it.
            preview: run.preview ?? sessionTaskRunPreview(nextPrompt(task) ?? task.items[0] ?? '')
        }, run.now)
    }

    private changed(task: StoredSessionTask, storeChanged: boolean = true): void {
        if (storeChanged) this.deps.onTasksChanged(task.sessionId)
    }

    private log(message: string, error: unknown, task?: StoredSessionTask): void {
        this.deps.log?.(`[session-task] ${message}`, {
            ...(task ? { taskId: task.id, sessionId: task.sessionId } : {}),
            error: error instanceof Error ? error.message : String(error)
        })
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now()
    }
}
