import { describe, expect, it } from 'bun:test'
import { buildSessionTaskMessageLocalId } from '@hapi/protocol'
import { Store } from '../store'
import type { StoredSessionTask } from '../store/sessionTasks'
import { SessionTaskRunner } from './sessionTaskRunner'
import type { SessionWakeFailure } from './sessionWakeGate'

const MINUTE = 60_000
const T0 = 1_700_000_000_000

function makeHarness(options: { active?: boolean } = {}) {
    const store = new Store(':memory:')
    const sessionId = store.sessions.getOrCreateSession('task-session', { path: '/tmp', flavor: 'cursor' }, null, 'default').id
    const session = { id: sessionId, namespace: 'default', active: options.active ?? true }
    let clock = T0
    const sent: Array<{ sessionId: string; text: string; localId: string }> = []
    const wakeCalls: string[] = []
    const wake: { result: boolean; failure?: SessionWakeFailure } = { result: true }
    const changes: string[] = []
    const sendFailure: { error?: Error } = {}
    const sessionGone = { value: false }
    const runner = new SessionTaskRunner({
        store,
        getSession: () => (sessionGone.value ? null : session),
        wake: async (id) => {
            wakeCalls.push(id)
            return wake.result
        },
        wakeFailure: () => wake.failure,
        sendMessage: async (id, payload) => {
            if (sendFailure.error) throw sendFailure.error
            sent.push({ sessionId: id, ...payload })
            store.addMessageForCurrentSession(
                id,
                { role: 'user', content: { type: 'text', text: payload.text }, meta: { sentFrom: 'webapp' } },
                payload.localId,
                null
            )
        },
        onTasksChanged: (id) => changes.push(id),
        now: () => clock,
        retryDelayMs: 15_000
    })
    const task = (id: string) => store.sessionTasks.getById(id) as StoredSessionTask
    return {
        store,
        sessionId,
        session,
        sent,
        wakeCalls,
        wake,
        changes,
        sendFailure,
        sessionGone,
        runner,
        task,
        setClock: (value: number) => { clock = value },
        advance: (ms: number) => { clock += ms },
        /** The CLI acknowledges taking a prompt. */
        take: (localId: string, at = clock) => {
            if (at !== clock) clock = at
            store.messages.markMessagesInvoked(sessionId, [localId], at)
        },
        create: (input: Parameters<Store['sessionTasks']['create']>[0]) => store.sessionTasks.create({ ...input, now: clock })
    }
}

type Harness = ReturnType<typeof makeHarness>

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
            h.store.sessionTasks.setPaused(created.id, true, null, T0)
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
            h.store.messages.deleteQueuedMessageById(h.sessionId, h.sent[0].localId)
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
            h.wake.result = false
            h.wake.failure = { code: 'no_machine_online', message: 'No machine online' }
            const created = h.create({
                sessionId: h.sessionId, kind: 'queue', items: ['a', 'b'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ state: 'active', lastError: 'machine_offline', runCount: 0 })
            const changesAfterFirstFailure = h.changes.length
            h.advance(MINUTE)
            await h.runner.tick()
            // Same failure again: no redundant change event.
            expect(h.changes.length).toBe(changesAfterFirstFailure)

            h.wake.result = true
            h.wake.failure = undefined
            h.session.active = true
            await h.runner.tick()
            expect(h.sent).toHaveLength(1)
            expect(h.task(created.id)).toMatchObject({ lastError: null, runCount: 1 })
        })

        it('pauses a task whose session cannot be resumed', async () => {
            const h: Harness = makeHarness({ active: false })
            h.wake.result = false
            h.wake.failure = { code: 'resume_unavailable', message: 'Session data is gone' }
            const created = h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })

            await h.runner.tick()
            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.task(created.id)).toMatchObject({ state: 'paused', nextRunAt: null, lastError: 'session_unavailable' })
            expect(h.wakeCalls).toHaveLength(1)
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
        })

        it('deletes a task whose session is gone', async () => {
            const h: Harness = makeHarness()
            h.create({
                sessionId: h.sessionId, kind: 'repeat', items: ['ping'], intervalMs: 10 * MINUTE, maxRuns: null, nextRunAt: T0
            })
            h.sessionGone.value = true
            await h.runner.tick()
            expect(h.sent).toEqual([])
            expect(h.store.sessionTasks.list(h.sessionId)).toEqual([])
            expect(h.wakeCalls).toEqual([])
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
