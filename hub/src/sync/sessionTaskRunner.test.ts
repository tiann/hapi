import { describe, expect, it } from 'bun:test'
import { buildSessionTaskMessageLocalId, SESSION_TASK_RUN_PREVIEW_LENGTH } from '@hapi/protocol'
import { Store } from '../store'
import { SESSION_TASK_RUN_RETENTION_MS, type StoredSessionTask, type StoredSessionTaskRun } from '../store/sessionTasks'
import { SessionTaskRunner, SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS } from './sessionTaskRunner'
import type { SessionWakeResult, WakeableSession } from './sessionWakeGate'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE
const T0 = 1_700_000_000_000

function makeHarness(options: { active?: boolean; archived?: boolean } = {}) {
    const store = new Store(':memory:')
    const sessionId = store.sessions.getOrCreateSession('task-session', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
    const sessions = new Map<string, WakeableSession>()
    const session: WakeableSession = { id: sessionId, namespace: 'default', active: options.active ?? true, archived: options.archived ?? false }
    sessions.set(sessionId, session)
    let clock = T0
    const sent: Array<{ sessionId: string; text: string; localId: string }> = []
    const cancelled: Array<{ sessionId: string; localId: string }> = []
    const wakeCalls: string[] = []
    /** What `wake` answers; `hold` keeps it pending until `release` is called. */
    const wake: { outcome: SessionWakeResult; hold: boolean; release?: (outcome: SessionWakeResult) => void } = {
        outcome: { type: 'active' },
        hold: false
    }
    const changes: string[] = []
    const sendFailure: { error?: Error } = {}
    /** Runs inside `sendMessage`, before the prompt is inserted. */
    const duringSend: { fn?: () => void | Promise<void> } = {}
    const runner = new SessionTaskRunner({
        store,
        getSession: (id) => sessions.get(id) ?? null,
        wake: async (id) => {
            wakeCalls.push(id)
            if (wake.hold) {
                return await new Promise<SessionWakeResult>((resolve) => { wake.release = resolve })
            }
            return wake.outcome
        },
        sendMessage: async (id, payload) => {
            if (sendFailure.error) throw sendFailure.error
            sent.push({ sessionId: id, ...payload })
            store.addMessageForCurrentSession(
                id,
                { role: 'user', content: { type: 'text', text: payload.text }, meta: { sentFrom: 'webapp' } },
                payload.localId,
                null
            )
            // A change that lands after the insert, before the send returns.
            if (duringSend.fn) await duringSend.fn()
        },
        cancelMessage: async (id, localId) => {
            cancelled.push({ sessionId: id, localId })
            store.messages.deleteQueuedMessageById(id, localId)
        },
        onTasksChanged: (id) => changes.push(id),
        now: () => clock,
        retryDelayMs: 15_000
    })
    const task = (id: string) => store.sessionTasks.getById(id) as StoredSessionTask
    const runs = (id = sessionId) => store.sessionTasks.listRuns(id, 50)
    return {
        store,
        sessionId,
        session,
        sessions,
        sent,
        cancelled,
        wakeCalls,
        wake,
        changes,
        sendFailure,
        duringSend,
        runner,
        task,
        runs,
        setClock: (value: number) => { clock = value },
        advance: (ms: number) => { clock += ms },
        now: () => clock,
        /** The CLI acknowledges taking a prompt. */
        take: (localId: string, at = clock) => {
            if (at !== clock) clock = at
            store.messages.markMessagesInvoked(sessionId, [localId], at)
        },
        /** The user discards a prompt from the queued-message bar. */
        discard: (localId: string) => { store.messages.deleteQueuedMessageById(sessionId, localId) },
        create: (input: Omit<Parameters<Store['sessionTasks']['create']>[0], 'startAt'>) =>
            store.sessionTasks.create({ startAt: T0, ...input, now: clock })
    }
}

type Harness = ReturnType<typeof makeHarness>

const stripRun = (run: StoredSessionTaskRun) => ({
    taskId: run.taskId,
    taskKind: run.taskKind,
    runNumber: run.runNumber,
    localId: run.localId,
    outcome: run.outcome,
    scheduledFor: run.scheduledFor,
    recordedAt: run.recordedAt,
    takenAt: run.takenAt,
    detail: run.detail,
    preview: run.preview
})

describe('SessionTaskRunner', () => {
    describe('repeat tasks', () => {
        it('sends one prompt per slot and stays on its grid', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['check progress'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toEqual([{ sessionId: h.sessionId, text: 'check progress', localId: buildSessionTaskMessageLocalId(created.id, 1) }])
            expect(h.task(created.id)).toMatchObject({ runCount: 1, pendingLocalId: h.sent[0].localId, nextRunAt: T0 + 10 * MINUTE })
            expect(h.changes).toEqual([h.sessionId])

            // Not due, nothing pending to settle.
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)

            // Taken by the agent: the grid the send already recorded is kept.
            h.take(h.sent[0].localId, T0 + MINUTE)
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ pendingLocalId: null, nextRunAt: T0 + 10 * MINUTE, runCount: 1 })

            h.setClock(T0 + 10 * MINUTE)
            await h.runner.tick()
            expect(h.sent.map((prompt) => prompt.localId)).toEqual([
                buildSessionTaskMessageLocalId(created.id, 1),
                buildSessionTaskMessageLocalId(created.id, 2)
            ])
            expect(h.task(created.id)).toMatchObject({ runCount: 2, nextRunAt: T0 + 20 * MINUTE })
        })

        it('skips a slot that comes due while its previous prompt is still waiting', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.setClock(T0 + 10 * MINUTE)
            await h.runner.tick()

            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ runCount: 1, nextRunAt: T0 + 20 * MINUTE })

            // The agent takes the prompt late; the next one still waits for its own slot.
            h.take(h.sent[0].localId, T0 + 12 * MINUTE)
            await h.runner.tick()
            expect(h.task(created.id)?.nextRunAt).toBe(T0 + 20 * MINUTE)
            h.setClock(T0 + 20 * MINUTE)
            await h.runner.tick()
            expect(h.sent).toHaveLength(2)
        })

        it('does not catch up slots missed while the hub was down', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            // First tick after two and a half hours: one prompt now, then back on the grid.
            h.setClock(T0 + 150 * MINUTE)
            await h.runner.tick()

            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)?.nextRunAt).toBe(T0 + 160 * MINUTE)
        })

        it('deletes itself once its last prompt is taken', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 5 * MINUTE, maxRuns: 2, nextRunAt: T0
            })
            await h.runner.tick()
            h.take(h.sent[0].localId)
            await h.runner.tick()
            h.setClock(T0 + 5 * MINUTE)
            await h.runner.tick()
            expect(h.sent).toHaveLength(2)
            expect(h.task(created.id)).toMatchObject({ runCount: 2, maxRuns: 2 })

            h.take(h.sent[1].localId)
            await h.runner.tick()
            expect(h.task(created.id)).toBeNull()
        })
    })

    describe('queue tasks', () => {
        it('sends each prompt interval after the agent took the previous one', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId,
                kind: 'queue',
                items: ['first', '你好', '吃饭了吗？'],
                intervalMs: 10 * MINUTE,
                maxRuns: null,
                nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['first'])
            // Nothing is scheduled until the agent takes it.
            expect(h.task(created.id)).toMatchObject({ runCount: 1, nextRunAt: null, pendingLocalId: h.sent[0].localId })
            h.advance(30 * MINUTE)
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)

            // Taken at T0 + 2m: the second follows ten minutes after that, not after the send.
            h.take(h.sent[0].localId, T0 + 2 * MINUTE)
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ pendingLocalId: null, nextRunAt: T0 + 12 * MINUTE })
            h.setClock(T0 + 12 * MINUTE - 1)
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            h.setClock(T0 + 12 * MINUTE)
            await h.runner.tick()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['first', '你好'])

            h.take(h.sent[1].localId, T0 + 12 * MINUTE)
            await h.runner.tick()
            h.setClock(T0 + 22 * MINUTE)
            await h.runner.tick()
            expect(h.sent.map((prompt) => prompt.text)).toEqual(['first', '你好', '吃饭了吗？'])
            expect(h.sent.map((prompt) => prompt.localId)).toEqual([1, 2, 3].map((n) => buildSessionTaskMessageLocalId(created.id, n)))

            // The last prompt taken: the queue is done and removes itself.
            h.take(h.sent[2].localId)
            expect(h.task(created.id)).not.toBeNull()
            await h.runner.tick()
            expect(h.task(created.id)).toBeNull()
        })

        it('keeps a task paused when its pending prompt is taken', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.store.sessionTasks.update(created.id, { state: { paused: true, nextRunAt: null } }, T0)
            h.take(h.sent[0].localId, T0 + MINUTE)
            h.setClock(T0 + 60 * MINUTE)
            await h.runner.tick()

            expect(h.task(created.id)).toMatchObject({ state: 'paused', nextRunAt: null, pendingLocalId: null, runCount: 1 })
            expect(h.sent).toHaveLength(1)
        })

        it('treats a prompt the user cancelled as taken and moves on', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.discard(h.sent[0].localId)
            h.advance(MINUTE)
            await h.runner.tick()

            expect(h.task(created.id)).toMatchObject({ pendingLocalId: null, nextRunAt: T0 + 11 * MINUTE, runCount: 1 })
        })
    })

    describe('sessions that are not running', () => {
        it('wakes the session before sending', async () => {
            const h: Harness = makeHarness({ active: false })
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()

            expect(h.wakeCalls).toEqual([h.sessionId])
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)?.lastError).toBeNull()
        })

        it('waits for an offline machine without inserting a prompt, then recovers', async () => {
            const h: Harness = makeHarness({ active: false })
            h.wake.outcome = { type: 'refused', failure: { code: 'no_machine_online', message: 'No machine online' } }
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ state: 'active', lastError: 'machine_offline', runCount: 0 })
            const changesAfterFirstFailure = h.changes.length
            h.advance(MINUTE)
            await h.runner.tick()
            // Same failure again: no redundant change event, no second history line.
            expect(h.changes.length).toBe(changesAfterFirstFailure)
            expect(h.runs()).toHaveLength(1)

            h.wake.outcome = { type: 'active' }
            h.session.active = true
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ lastError: null, runCount: 1 })
        })

        it('leaves a wake that was deferred alone', async () => {
            const h: Harness = makeHarness({ active: false })
            h.wake.outcome = { type: 'deferred' }
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toEqual([])
            // Nothing was attempted, so there is nothing to report: no error, no event, still due.
            expect(h.task(created.id)).toMatchObject({ state: 'active', lastError: null, nextRunAt: T0 })
            expect(h.changes).toEqual([])
            expect(h.runs()).toEqual([])
        })

        it('keeps a task due, with the reason, while its session cannot be resumed', async () => {
            const h: Harness = makeHarness({ active: false })
            h.wake.outcome = { type: 'refused', failure: { code: 'resume_unavailable', message: 'Retry after the agent has initialized' } }
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            await h.runner.tick()
            expect(h.sent).toEqual([])
            // A resume can be refused for a while and succeed later: the task is not paused.
            expect(h.task(created.id)).toMatchObject({ state: 'active', nextRunAt: T0, lastError: 'session_unavailable' })
            expect(h.runs().map((run) => [run.outcome, run.detail])).toEqual([['failed', 'session_unavailable']])

            // The user opens the session (it initializes): the next tick goes through by itself.
            h.session.active = true
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ lastError: null, runCount: 1 })
        })

        it('never sends into an archived session and runs by itself once it is reopened', async () => {
            const h: Harness = makeHarness({ active: false, archived: true })
            h.wake.outcome = { type: 'refused', failure: { code: 'session_archived', message: 'Session is archived' } }
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toEqual([])
            // Archiving does not pause the task: it stays due and says why.
            expect(h.task(created.id)).toMatchObject({ state: 'active', nextRunAt: T0, lastError: 'session_archived' })
            expect(h.runs().map((run) => [run.outcome, run.detail])).toEqual([['failed', 'session_archived']])

            h.session.archived = false
            h.wake.outcome = { type: 'active' }
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ lastError: null, runCount: 1 })
        })

        it('wakes a session whose pending prompt was never taken', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            // The agent process went away with the prompt still queued.
            h.session.active = false
            await h.runner.tick()
            expect(h.wakeCalls).toEqual([h.sessionId])
            expect(h.task(created.id)?.pendingLocalId).toBe(h.sent[0].localId)
            expect(h.task(created.id)?.lastError).toBeNull()
        })

        it(`stops waking after ${SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS} wakes that the agent did not take the prompt in`, async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            for (let attempt = 1; attempt <= SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS; attempt += 1) {
                // The wake succeeds, the agent comes up and exits again without taking the prompt.
                h.session.active = false
                await h.runner.tick()
                expect(h.wakeCalls).toHaveLength(attempt)
                expect(h.task(h.runs()[0].taskId as string)?.lastError).toBeNull()
            }

            h.session.active = false
            await h.runner.tick()
            expect(h.wakeCalls).toHaveLength(SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS)
            expect(h.store.sessionTasks.list(h.sessionId)[0]).toMatchObject({ lastError: 'prompt_not_taken', pendingLocalId: h.sent[0].localId })

            // The agent takes it on its own: the error goes and the task moves on.
            h.take(h.sent[0].localId)
            await h.runner.tick()
            expect(h.store.sessionTasks.list(h.sessionId)[0]).toMatchObject({ lastError: null, pendingLocalId: null, runCount: 1 })
        })

        it('records why a pending prompt is not delivered while its machine is offline, once', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            // The agent exited and the machine went to sleep with the prompt queued.
            h.session.active = false
            h.wake.outcome = { type: 'refused', failure: { code: 'no_machine_online', message: 'No machine online' } }
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ lastError: 'machine_offline', pendingLocalId: h.sent[0].localId, state: 'active' })
            const changesAfterFirstFailure = h.changes.length
            // No history line for a prompt that did go out, and no repeat event on the next tick.
            expect(h.runs()).toHaveLength(1)
            h.advance(MINUTE)
            await h.runner.tick()
            expect(h.changes.length).toBe(changesAfterFirstFailure)

            h.wake.outcome = { type: 'active' }
            h.session.active = true
            h.take(h.sent[0].localId)
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ lastError: null, pendingLocalId: null })
        })

        it('deletes a task whose session is gone', async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.sessions.delete(h.sessionId)
            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.store.sessionTasks.list(h.sessionId)).toEqual([])
            expect(h.wakeCalls).toEqual([])
        })

        describe('a prompt that is not progressing', () => {
            /** A one-minute repeat task whose first prompt went out; then the session stops running. */
            async function stuckPrompt(h: Harness, options: { archived?: boolean } = {}): Promise<string> {
                const created = h.create({
                    sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: MINUTE, maxRuns: null, nextRunAt: T0
                })
                await h.runner.tick()
                h.session.active = false
                h.session.archived = options.archived ?? false
                return created.id
            }

            it('moves the grid on while the session is archived: one skipped line for the first slot, then one an hour', async () => {
                const h: Harness = makeHarness()
                const taskId = await stuckPrompt(h, { archived: true })
                h.wake.outcome = { type: 'refused', failure: { code: 'session_archived', message: 'Session is archived' } }
                await h.runner.tick()
                expect(h.task(taskId)).toMatchObject({ lastError: 'session_archived', nextRunAt: T0 + MINUTE })
                const changesWhenStuck = h.changes.length

                // The first slot that comes due while nobody can take the prompt is one line; the next 59 write none.
                h.setClock(T0 + MINUTE)
                await h.runner.tick()
                expect(h.runs().map((run) => [run.outcome, run.scheduledFor, run.detail])).toEqual([
                    ['skipped', T0 + MINUTE, 'previous_prompt_waiting'],
                    ['sent', T0, null]
                ])
                expect(h.changes).toHaveLength(changesWhenStuck + 1)
                for (let slot = 2; slot <= 60; slot += 1) {
                    h.setClock(T0 + slot * MINUTE)
                    await h.runner.tick()
                }
                expect(h.task(taskId)).toMatchObject({ state: 'active', lastError: 'session_archived', nextRunAt: T0 + 61 * MINUTE })
                expect(h.runs()).toHaveLength(2)
                // Each of them still moved the next run, so each is announced.
                expect(h.changes).toHaveLength(changesWhenStuck + 60)
                expect(h.sent).toHaveLength(1)

                // An hour after that line, the next slot due is one more.
                h.setClock(T0 + 61 * MINUTE)
                await h.runner.tick()
                expect(h.runs().map((run) => [run.outcome, run.scheduledFor, run.recordedAt])).toEqual([
                    ['skipped', T0 + 61 * MINUTE, T0 + 61 * MINUTE],
                    ['skipped', T0 + MINUTE, T0 + MINUTE],
                    ['sent', T0, T0]
                ])
                expect(h.changes).toHaveLength(changesWhenStuck + 61)

                // Un-archived and running again: the prompt is taken and the next slot is sent as usual.
                h.session.archived = false
                h.session.active = true
                h.take(h.sent[0].localId, T0 + 62 * MINUTE)
                h.setClock(T0 + 62 * MINUTE)
                await h.runner.tick()
                await h.runner.tick()
                expect(h.sent).toHaveLength(2)
                expect(h.task(taskId)).toMatchObject({ lastError: null, runCount: 2 })
            })

            it('moves the grid on after prompt_not_taken, with one skipped line for the first slot and none for the next', async () => {
                const h: Harness = makeHarness()
                const taskId = await stuckPrompt(h)
                for (let attempt = 0; attempt < SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS; attempt += 1) await h.runner.tick()
                await h.runner.tick()
                expect(h.task(taskId)).toMatchObject({ lastError: 'prompt_not_taken', nextRunAt: T0 + MINUTE })
                const changesWhenStuck = h.changes.length

                h.setClock(T0 + MINUTE)
                await h.runner.tick()
                expect(h.runs().map((run) => [run.outcome, run.scheduledFor, run.detail])).toEqual([
                    ['skipped', T0 + MINUTE, 'previous_prompt_waiting'],
                    ['sent', T0, null]
                ])
                for (let slot = 2; slot <= 10; slot += 1) {
                    h.setClock(T0 + slot * MINUTE)
                    await h.runner.tick()
                }
                expect(h.task(taskId)).toMatchObject({ lastError: 'prompt_not_taken', nextRunAt: T0 + 11 * MINUTE })
                expect(h.runs()).toHaveLength(2)
                // One line for ten slots, but an event for each: the next run moved each time.
                expect(h.changes).toHaveLength(changesWhenStuck + 10)
                expect(h.wakeCalls).toHaveLength(SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS)
            })

            it('announces every skipped slot, also one that writes no history line', async () => {
                const h: Harness = makeHarness()
                const taskId = await stuckPrompt(h)
                for (let attempt = 0; attempt < SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS; attempt += 1) await h.runner.tick()
                await h.runner.tick()
                const changesWhenStuck = h.changes.length

                // Three slots come due while the prompt waits: one history line, three
                // events, so the task bar and the session list see the next run move.
                for (const slot of [1, 2, 3]) {
                    h.setClock(T0 + slot * MINUTE)
                    await h.runner.tick()
                    expect(h.task(taskId)?.nextRunAt).toBe(T0 + (slot + 1) * MINUTE)
                    expect(h.changes).toHaveLength(changesWhenStuck + slot)
                }
                expect(h.runs().filter((run) => run.outcome === 'skipped')).toHaveLength(1)
            })

            it('writes the first skipped slot, then at most one line an hour, while the hub is trying to deliver the prompt', async () => {
                const h: Harness = makeHarness()
                const taskId = await stuckPrompt(h)
                h.wake.outcome = { type: 'refused', failure: { code: 'no_machine_online', message: 'No machine online' } }
                await h.runner.tick()
                expect(h.task(taskId)?.lastError).toBe('machine_offline')

                // The machine is asleep for eight hours of a one-minute task: eight lines, not 480 (newest first).
                const changesBeforeOutage = h.changes.length
                for (let slot = 1; slot <= 8 * 60; slot += 1) {
                    h.setClock(T0 + slot * MINUTE)
                    await h.runner.tick()
                }
                const skipped = () => h.runs().filter((run) => run.outcome === 'skipped')
                expect(skipped().map((run) => [run.scheduledFor, run.recordedAt, run.detail])).toEqual(
                    [421, 361, 301, 241, 181, 121, 61, 1].map((slot) => [T0 + slot * MINUTE, T0 + slot * MINUTE, 'previous_prompt_waiting'])
                )
                // One event per skipped slot: each moved the next run.
                expect(h.changes).toHaveLength(changesBeforeOutage + 8 * 60)
                expect(h.task(taskId)).toMatchObject({ state: 'active', lastError: 'machine_offline', nextRunAt: T0 + 481 * MINUTE })
            })

            it('writes the first skipped slot of the next prompt again', async () => {
                const h: Harness = makeHarness()
                const created = h.create({
                    sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
                })
                await h.runner.tick()
                // The first prompt waits over a slot: one line.
                h.setClock(T0 + 10 * MINUTE)
                await h.runner.tick()
                // Taken; the second prompt goes out at the next slot and waits over one too:
                // its first skip is a line again, well within the hour.
                h.take(h.sent[0].localId, T0 + 12 * MINUTE)
                h.setClock(T0 + 20 * MINUTE)
                await h.runner.tick()
                await h.runner.tick()
                expect(h.sent).toHaveLength(2)
                h.setClock(T0 + 30 * MINUTE)
                await h.runner.tick()
                const skipped = () => h.runs().filter((run) => run.outcome === 'skipped').map((run) => run.scheduledFor)
                expect(skipped()).toEqual([T0 + 30 * MINUTE, T0 + 10 * MINUTE])
                // The same prompt over the next slot, twenty minutes later: not another line.
                h.setClock(T0 + 40 * MINUTE)
                await h.runner.tick()
                expect(skipped()).toEqual([T0 + 30 * MINUTE, T0 + 10 * MINUTE])
                expect(h.task(created.id)?.nextRunAt).toBe(T0 + 50 * MINUTE)
            })

            it('counts wakes from the start again once the prompt is forgotten', async () => {
                const h: Harness = makeHarness()
                const taskId = await stuckPrompt(h)
                const localId = h.sent[0].localId as string
                for (let attempt = 0; attempt < SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS; attempt += 1) await h.runner.tick()
                await h.runner.tick()
                expect(h.task(taskId)?.lastError).toBe('prompt_not_taken')
                h.runner.forgetPrompt(null)
                await h.runner.tick()
                expect(h.task(taskId)?.lastError).toBe('prompt_not_taken')

                // The user resumed the task: the hub wakes the session for the prompt again.
                h.store.sessionTasks.setError(taskId, null, T0)
                h.runner.forgetPrompt(localId)
                await h.runner.tick()
                expect(h.wakeCalls).toHaveLength(SESSION_TASK_MAX_PENDING_WAKE_ATTEMPTS + 1)
                expect(h.task(taskId)).toMatchObject({ lastError: null, pendingLocalId: localId })
            })
        })

        it('follows a task to the session a resume rotated it to', async () => {
            const h: Harness = makeHarness({ active: false })
            const replacementId = h.store.sessions.getOrCreateSession('task-session-rotated', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.wake.hold = true
            const ticking = h.runner.tick()
            await Promise.resolve()
            // The resume merged the old row into the one the runner spawned: the task moved too.
            h.store.sessionTasks.transfer(h.sessionId, replacementId)
            h.sessions.delete(h.sessionId)
            h.sessions.set(replacementId, { id: replacementId, namespace: 'default', active: true, archived: false })
            h.wake.release?.({ type: 'active' })
            await ticking

            expect(h.sent.map((prompt) => prompt.sessionId)).toEqual([replacementId])
            expect(h.store.sessionTasks.get(replacementId, created.id)).toMatchObject({ runCount: 1, pendingLocalId: h.sent[0].localId, lastError: null })
            expect(h.store.messages.lookupQueuedMessage(replacementId, h.sent[0].localId).status).toBe('queued')
        })
    })

    describe('a task that changes while its prompt is on its way', () => {
        it('sends nothing when the task is deleted during the wake', async () => {
            const h: Harness = makeHarness({ active: false })
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.wake.hold = true
            const ticking = h.runner.tick()
            await Promise.resolve()
            expect(h.wakeCalls).toEqual([h.sessionId])
            // The user deletes the task: nothing is pending yet, so there is nothing to cancel.
            h.store.sessionTasks.delete(created.id)
            h.wake.release?.({ type: 'active' })
            await ticking

            expect(h.sent).toEqual([])
            expect(h.store.messages.getMessages(h.sessionId)).toEqual([])
            expect(h.store.sessionTasks.getById(created.id)).toBeNull()
            expect(h.runs()).toEqual([])
        })

        it('sends nothing when the task is paused during the wake', async () => {
            const h: Harness = makeHarness({ active: false })
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.wake.hold = true
            const ticking = h.runner.tick()
            await Promise.resolve()
            h.store.sessionTasks.update(created.id, { state: { paused: true, nextRunAt: null } }, T0)
            h.wake.release?.({ type: 'active' })
            await ticking

            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ state: 'paused', runCount: 0, pendingLocalId: null })
        })

        it('sends nothing when another run already recorded the send during the wake', async () => {
            const h: Harness = makeHarness({ active: false })
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.wake.hold = true
            const ticking = h.runner.tick()
            await Promise.resolve()
            h.store.sessionTasks.markSent(created.id, { localId: 'hapi-task:elsewhere:1', nextRunAt: T0 + 10 * MINUTE, now: T0 })
            h.wake.release?.({ type: 'active' })
            await ticking

            expect(h.sent).toEqual([])
            expect(h.task(created.id)?.runCount).toBe(1)
        })

        it('takes the prompt back when the task is deleted while the prompt is being inserted', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.duringSend.fn = async () => {
                // The delete lands inside the send (after the insert, before markSent).
                await Promise.resolve()
                h.store.sessionTasks.delete(created.id)
            }
            await h.runner.tick()

            const localId = buildSessionTaskMessageLocalId(created.id, 1)
            expect(h.sent).toHaveLength(1)
            // The prompt reached the queue and was taken back: an untracked prompt must not go out.
            expect(h.cancelled).toEqual([{ sessionId: h.sessionId, localId }])
            expect(h.store.messages.lookupQueuedMessage(h.sessionId, localId).status).toBe('absent')
            expect(h.store.sessionTasks.getById(created.id)).toBeNull()
        })

        it('takes the prompt back when the task is paused while the prompt is being inserted', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.duringSend.fn = () => {
                // The pause lands inside the send (after the insert, before the send returns):
                // with input translation on, that insert is an LLM call taking seconds.
                h.store.sessionTasks.update(created.id, { state: { paused: true, nextRunAt: null } }, T0)
            }
            await h.runner.tick()

            const localId = buildSessionTaskMessageLocalId(created.id, 1)
            expect(h.sent).toHaveLength(1)
            // A pause means no prompt of the task reaches the agent after it: this one is taken back.
            expect(h.cancelled).toEqual([{ sessionId: h.sessionId, localId }])
            expect(h.store.messages.lookupQueuedMessage(h.sessionId, localId).status).toBe('absent')
            expect(h.task(created.id)).toMatchObject({ state: 'paused', runCount: 0, pendingLocalId: null, nextRunAt: null })
            expect(h.runs()).toEqual([])
        })

        it('takes a prompt back from the session an OpenCode /clear redirected it to', async () => {
            const h: Harness = makeHarness()
            const replacementId = h.store.sessions.getOrCreateSession('task-session-replacement', { path: '/tmp', flavor: 'opencode' }, null, 'default').id
            const source = h.store.sessions.getSession(h.sessionId) as { metadata: unknown; metadataVersion: number }
            h.store.sessions.updateSessionMetadata(h.sessionId, {
                ...(source.metadata as object),
                opencodeClearOperation: { replacementSessionId: replacementId, state: 'pending' }
            }, source.metadataVersion, 'default')
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.duringSend.fn = () => {
                h.store.sessionTasks.delete(created.id)
            }
            await h.runner.tick()

            // The prompt was inserted into the replacement; that is where it has to be removed,
            // or it would go out on its own from a task that no longer exists.
            const localId = buildSessionTaskMessageLocalId(created.id, 1)
            expect(h.sent).toHaveLength(1)
            expect(h.cancelled).toEqual([{ sessionId: replacementId, localId }])
            expect(h.store.messages.lookupQueuedMessage(replacementId, localId).status).toBe('absent')
            expect(h.store.messages.lookupQueuedMessage(h.sessionId, localId).status).toBe('absent')
            expect(h.store.sessionTasks.getById(created.id)).toBeNull()
        })
    })

    describe('a pending prompt in an unknown state', () => {
        it('records prompt_indeterminate, does not wake, and moves on when the user discards it', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            // The user cancels it from the message bar while the CLI ack times out.
            h.store.messages.setMessagesDeliveryState(h.sessionId, [h.sent[0].localId], 'indeterminate')
            h.session.active = false
            await h.runner.tick()
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ lastError: 'prompt_indeterminate', pendingLocalId: h.sent[0].localId, runCount: 1 })
            // An indeterminate row is never replayed, so waking the session would not help.
            expect(h.wakeCalls).toEqual([])
            expect(h.runs().map((run) => run.outcome)).toEqual(['sent'])

            h.discard(h.sent[0].localId)
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ lastError: null, pendingLocalId: null, nextRunAt: T0 + 10 * MINUTE })
            expect(h.runs().map((run) => run.outcome)).toEqual(['cancelled'])
        })

        it('moves on when the user retries it and the agent takes it', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.store.messages.setMessagesDeliveryState(h.sessionId, [h.sent[0].localId], 'indeterminate')
            await h.runner.tick()
            expect(h.task(created.id)?.lastError).toBe('prompt_indeterminate')

            // Retry queues the row again; the session is up, so the agent gets it.
            h.store.messages.setMessagesDeliveryState(h.sessionId, [h.sent[0].localId], 'queued')
            h.take(h.sent[0].localId)
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ lastError: null, pendingLocalId: null, runCount: 1 })
        })

        it('clears prompt_indeterminate as soon as the user has retried the prompt, while it still waits', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.store.messages.setMessagesDeliveryState(h.sessionId, [h.sent[0].localId], 'indeterminate')
            await h.runner.tick()
            expect(h.task(created.id)?.lastError).toBe('prompt_indeterminate')

            // Retry queues the row again (being dispatched, or plainly queued).
            // The prompt is plainly waiting from then on, so the task must stop
            // saying its take is unknown — before the agent has taken it.
            for (const deliveryState of ['dispatching', 'queued'] as const) {
                h.store.messages.setMessagesDeliveryState(h.sessionId, [h.sent[0].localId], deliveryState)
                h.store.sessionTasks.setError(created.id, 'prompt_indeterminate', h.now())
                const announced = h.changes.length
                h.advance(MINUTE)
                await h.runner.tick()
                expect(h.task(created.id)).toMatchObject({ lastError: null, pendingLocalId: h.sent[0].localId, runCount: 1 })
                expect(h.changes).toHaveLength(announced + 1)
                // Nothing new to say on the next tick.
                await h.runner.tick()
                expect(h.changes).toHaveLength(announced + 1)
            }
        })
    })

    describe('OpenCode /clear redirect', () => {
        it('finds a pending prompt that the clear redirected to the replacement session', async () => {
            const h: Harness = makeHarness()
            const replacementId = h.store.sessions.getOrCreateSession('task-session-replacement', { path: '/tmp', flavor: 'opencode' }, null, 'default').id
            // The clear is pending: new messages for the source land in the replacement until it finishes.
            const source = h.store.sessions.getSession(h.sessionId) as { metadata: unknown; metadataVersion: number }
            h.store.sessions.updateSessionMetadata(h.sessionId, {
                ...(source.metadata as object),
                opencodeClearOperation: { replacementSessionId: replacementId, state: 'pending' }
            }, source.metadataVersion, 'default')
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            const localId = h.sent[0].localId
            expect(h.store.messages.lookupQueuedMessage(replacementId, localId).status).toBe('queued')
            expect(h.store.messages.lookupQueuedMessage(h.sessionId, localId).status).toBe('absent')

            // The prompt is in the replacement, not gone: it is still pending, not consumed.
            await h.runner.tick()
            expect(h.task(created.id)).toMatchObject({ pendingLocalId: localId, runCount: 1, lastConsumedAt: null })

            // The clear finishes and moves the task over; the agent takes the prompt there.
            h.store.sessionTasks.transfer(h.sessionId, replacementId)
            h.sessions.set(replacementId, { id: replacementId, namespace: 'default', active: true, archived: false })
            h.store.messages.markMessagesInvoked(replacementId, [localId], T0 + MINUTE)
            await h.runner.tick()
            expect(h.store.sessionTasks.get(replacementId, created.id)).toMatchObject({ pendingLocalId: null, lastConsumedAt: T0 + MINUTE })
            expect(h.runs(replacementId)[0]).toMatchObject({ takenAt: T0 + MINUTE })
        })
    })

    describe('run history', () => {
        it('records each prompt sent, when it was taken, and nothing for the ticks in between', async () => {
            const h: Harness = makeHarness()
            const longText = `x`.repeat(SESSION_TASK_RUN_PREVIEW_LENGTH + 40)
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: [longText, 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            await h.runner.tick()
            expect(h.runs().map(stripRun)).toEqual([{
                taskId: created.id,
                taskKind: 'queue',
                runNumber: 1,
                localId: h.sent[0].localId,
                outcome: 'sent',
                scheduledFor: T0,
                recordedAt: T0,
                takenAt: null,
                detail: null,
                preview: 'x'.repeat(SESSION_TASK_RUN_PREVIEW_LENGTH)
            }])

            h.take(h.sent[0].localId, T0 + MINUTE)
            await h.runner.tick()
            expect(h.runs()[0]?.takenAt).toBe(T0 + MINUTE)
        })

        it('records a skipped slot with its due time', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.setClock(T0 + 10 * MINUTE + 5_000)
            await h.runner.tick()

            // Newest first.
            expect(h.runs().map((run) => [run.outcome, run.runNumber, run.scheduledFor, run.detail, run.preview])).toEqual([
                ['skipped', null, T0 + 10 * MINUTE, 'previous_prompt_waiting', 'ping'],
                ['sent', 1, T0, null, 'ping']
            ])
        })

        it('flips a prompt the user discarded to cancelled', async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.discard(h.sent[0].localId)
            await h.runner.tick()
            expect(h.runs().map((run) => [run.outcome, run.runNumber, run.takenAt])).toEqual([['cancelled', 1, null]])
        })

        it('writes a failed line when a failure is new for the task, not on every tick', async () => {
            const h: Harness = makeHarness({ active: false })
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.wake.outcome = { type: 'refused', failure: { code: 'no_machine_online', message: 'No machine online' } }
            await h.runner.tick()
            h.advance(MINUTE)
            await h.runner.tick()
            // A resume that threw or timed out is the session's fault, not the insert's.
            h.wake.outcome = { type: 'refused', failure: { code: 'resume_failed', message: 'Session did not become active' } }
            await h.runner.tick()
            expect(h.runs().map((run) => [run.outcome, run.detail, run.scheduledFor, run.recordedAt])).toEqual([
                ['failed', 'session_unavailable', T0, T0 + MINUTE],
                ['failed', 'machine_offline', T0, T0]
            ])
            expect(h.task(created.id)?.lastError).toBe('session_unavailable')

            // The same reason again from another code is not a new failure.
            h.wake.outcome = { type: 'refused', failure: { code: 'resume_unavailable', message: 'Retry after the agent has initialized' } }
            await h.runner.tick()
            expect(h.runs()).toHaveLength(2)
            expect(h.runs().map((run) => [run.outcome, run.detail, run.preview])).toEqual([
                ['failed', 'session_unavailable', 'ping'],
                ['failed', 'machine_offline', 'ping']
            ])
            expect(created.id).toBe(h.runs()[0].taskId)
        })

        it('previews the prompt a failed run of a queue was about to send', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['first', 'second', 'third'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.take(h.sent[0].localId, T0 + MINUTE)
            await h.runner.tick()
            h.setClock(T0 + 11 * MINUTE)
            await h.runner.tick()
            h.take(h.sent[1].localId, T0 + 11 * MINUTE)
            await h.runner.tick()
            h.setClock(T0 + 21 * MINUTE)
            // The machine goes to sleep before the third prompt: it cannot go out.
            h.session.active = false
            h.wake.outcome = { type: 'refused', failure: { code: 'no_machine_online', message: 'No machine online' } }
            await h.runner.tick()

            expect(h.sent.map((prompt) => prompt.text)).toEqual(['first', 'second'])
            expect(h.task(created.id)).toMatchObject({ runCount: 2, lastError: 'machine_offline' })
            expect(h.runs().map((run) => [run.outcome, run.runNumber, run.detail, run.preview])).toEqual([
                ['failed', null, 'machine_offline', 'third'],
                ['sent', 2, null, 'second'],
                ['sent', 1, null, 'first']
            ])
        })

        it('keeps the history of a finished task and follows it through a merge', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await h.runner.tick()
            h.take(h.sent[0].localId)
            await h.runner.tick()
            expect(h.task(created.id)).toBeNull()
            expect(h.runs()).toHaveLength(1)

            const survivorId = h.store.sessions.getOrCreateSession('task-session-survivor', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
            h.store.sessionTasks.transfer(h.sessionId, survivorId)
            expect(h.runs()).toEqual([])
            expect(h.runs(survivorId).map((run) => run.taskId)).toEqual([created.id])
        })

        it('keeps at most a bounded number of rows per session', async () => {
            const h: Harness = makeHarness()
            for (let index = 0; index < 505; index += 1) {
                h.store.sessionTasks.recordRun({
                    sessionId: h.sessionId,
                    taskId: 't',
                    taskKind: 'repeat',
                    runNumber: null,
                    outcome: 'skipped',
                    scheduledFor: T0 + index,
                    detail: 'previous_prompt_waiting'
                }, T0 + index)
            }
            const runs = h.store.sessionTasks.listRuns(h.sessionId, 1_000)
            expect(runs).toHaveLength(500)
            expect(runs[0].scheduledFor).toBe(T0 + 504)
            expect(runs.at(-1)?.scheduledFor).toBe(T0 + 5)
        })

        it('deletes rows past the retention age at most once an hour', async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0 + HOUR
            })
            h.store.sessionTasks.recordRun({
                sessionId: h.sessionId, taskId: 'old', taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: null
            }, T0 - SESSION_TASK_RUN_RETENTION_MS - 1)

            const oldRuns = () => h.runs().filter((run) => run.taskId === 'old')
            // The first tick prunes; the next one, an hour less later, does not.
            await h.runner.tick()
            expect(oldRuns()).toEqual([])
            h.store.sessionTasks.recordRun({
                sessionId: h.sessionId, taskId: 'old', taskKind: 'repeat', runNumber: null, outcome: 'skipped', scheduledFor: null
            }, T0 - SESSION_TASK_RUN_RETENTION_MS - 1)
            h.advance(HOUR - 1)
            await h.runner.tick()
            expect(oldRuns()).toHaveLength(1)
            h.advance(1)
            await h.runner.tick()
            expect(oldRuns()).toEqual([])
            // Rows inside the retention age stay.
            expect(h.runs().filter((run) => run.taskId !== 'old').length).toBeGreaterThan(0)
        })
    })

    describe('failure and restart safety', () => {
        it('does not insert the same prompt twice when the hub stopped before recording a send', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            // The previous process inserted prompt 1 and died before markSent.
            h.store.addMessageForCurrentSession(
                h.sessionId,
                { role: 'user', content: { type: 'text', text: 'a' }, meta: { sentFrom: 'webapp' } },
                buildSessionTaskMessageLocalId(created.id, 1),
                null
            )

            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ runCount: 1, pendingLocalId: buildSessionTaskMessageLocalId(created.id, 1) })
            // The recovered send is in the history too.
            expect(h.runs().map((run) => [run.outcome, run.runNumber, run.preview])).toEqual([['sent', 1, 'a']])
        })

        it('keeps a task due after a failed send and retries after a delay', async () => {
            const h: Harness = makeHarness()
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.sendFailure.error = new Error('Conversation history action already in progress')
            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ state: 'active', runCount: 0, nextRunAt: T0, lastError: 'send_failed' })
            expect(h.runs().map((run) => [run.outcome, run.detail])).toEqual([['failed', 'send_failed']])

            h.advance(1_000)
            await h.runner.tick()
            h.sendFailure.error = undefined
            await h.runner.tick()
            expect(h.sent).toHaveLength(0)

            h.setClock(T0 + 15_000)
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ runCount: 1, lastError: null })
        })

        it('does not run the same task twice on overlapping ticks', async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            await Promise.all([h.runner.tick(), h.runner.tick(), h.runner.tick()])
            expect(h.sent).toHaveLength(1)
        })
    })
})
