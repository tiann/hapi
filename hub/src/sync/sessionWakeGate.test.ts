import { describe, expect, it } from 'bun:test'
import {
    SESSION_WAKE_MAX_CONCURRENT_RESUMES,
    SessionWakeGate,
    type SessionWakeResumeResult,
    type WakeableSession
} from './sessionWakeGate'

type Harness = ReturnType<typeof makeHarness>

function makeHarness() {
    const sessions = new Map<string, WakeableSession>()
    let clock = 1_000
    const resumeCalls: Array<{ sessionId: string; namespace: string }> = []
    const resumeResult: { value: SessionWakeResumeResult } = { value: { type: 'error', code: 'no_machine_online', message: 'No machine online' } }
    const logs: Array<{ message: string; detail: Record<string, unknown> }> = []
    const gate = new SessionWakeGate({
        getSession: (sessionId) => sessions.get(sessionId) ?? null,
        resumeSession: async (sessionId, namespace) => {
            resumeCalls.push({ sessionId, namespace })
            // A successful resume brings the session up, as the real one does.
            if (resumeResult.value.type === 'success') sessions.get(resumeResult.value.sessionId)!.active = true
            return resumeResult.value
        },
        now: () => clock,
        // Polling advances the fake clock, so an idle wait still reaches its deadline.
        sleep: async (ms) => { clock += ms },
        activeTimeoutMs: 5_000,
        baseBackoffMs: 1_000,
        maxBackoffMs: 4_000,
        log: (message, detail) => logs.push({ message, detail })
    })
    return {
        gate,
        sessions,
        resumeCalls,
        resumeResult,
        logs,
        setClock: (value: number) => { clock = value },
        addSession: (id: string, active: boolean, archived = false) => sessions.set(id, { id, namespace: 'default', active, archived })
    }
}

describe('SessionWakeGate', () => {
    it('does not resume a session that is already active', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', true)
        await expect(h.gate.wake('s')).resolves.toEqual({ type: 'active' })
        expect(h.resumeCalls).toEqual([])
    })

    it('resumes an inactive session and waits until it reports active', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        h.resumeResult.value = { type: 'success', sessionId: 's' }
        await expect(h.gate.wake('s')).resolves.toEqual({ type: 'active' })
        expect(h.resumeCalls).toEqual([{ sessionId: 's', namespace: 'default' }])
        expect(h.gate.lastFailure('s')).toBeUndefined()
    })

    it('waits for a session that reports active only after the resume answered', async () => {
        const sessions = new Map<string, WakeableSession>([['s', { id: 's', namespace: 'default', active: false, archived: false }]])
        let finishResume: (() => void) | undefined
        let polls = 0
        const gate = new SessionWakeGate({
            getSession: (sessionId) => sessions.get(sessionId) ?? null,
            resumeSession: async () => {
                await new Promise<void>((resolve) => { finishResume = resolve })
                return { type: 'success' as const, sessionId: 's' }
            },
            sleep: async () => {
                polls += 1
                // Second poll: the CLI socket has attached.
                if (polls === 2) sessions.get('s')!.active = true
            }
        })
        const waking = gate.wake('s')
        await Promise.resolve()
        finishResume!()
        await expect(waking).resolves.toEqual({ type: 'active' })
        expect(polls).toBe(2)
    })

    it('backs off after a failed attempt instead of resuming on every tick', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)

        await expect(h.gate.wake('s')).resolves.toEqual({
            type: 'refused',
            failure: { code: 'no_machine_online', message: 'No machine online' }
        })
        expect(h.gate.lastFailure('s')).toEqual({ code: 'no_machine_online', message: 'No machine online' })
        // Still inside the first backoff window: no second resume, nothing new to report.
        h.setClock(1_500)
        await expect(h.gate.wake('s')).resolves.toEqual({ type: 'deferred' })
        expect(h.resumeCalls).toHaveLength(1)

        h.setClock(2_001)
        await expect(h.gate.wake('s')).resolves.toMatchObject({ type: 'refused' })
        expect(h.resumeCalls).toHaveLength(2)
        // The delay doubles: 2s this time, then 4s (the cap).
        h.setClock(4_000)
        await expect(h.gate.wake('s')).resolves.toEqual({ type: 'deferred' })
        expect(h.resumeCalls).toHaveLength(2)
        h.setClock(4_002)
        await expect(h.gate.wake('s')).resolves.toMatchObject({ type: 'refused' })
        h.setClock(8_002)
        await expect(h.gate.wake('s')).resolves.toMatchObject({ type: 'refused' })
        expect(h.resumeCalls).toHaveLength(4)
    })

    it('logs a repeated identical failure once', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        await h.gate.wake('s')
        h.setClock(2_001)
        await h.gate.wake('s')
        h.resumeResult.value = { type: 'error', code: 'resume_failed', message: 'spawn failed' }
        h.setClock(4_002)
        await h.gate.wake('s')
        expect(h.logs.map((entry) => entry.detail.code)).toEqual(['no_machine_online', 'resume_failed'])
    })

    it('collapses concurrent wake requests into one resume attempt', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        h.resumeResult.value = { type: 'success', sessionId: 's' }
        const results = await Promise.all([h.gate.wake('s'), h.gate.wake('s'), h.gate.wake('s')])
        expect(results).toEqual([{ type: 'active' }, { type: 'active' }, { type: 'active' }])
        expect(h.resumeCalls).toHaveLength(1)
    })

    it('fails when the session does not report active before the deadline', async () => {
        let clock = 1_000
        const gate = new SessionWakeGate({
            getSession: () => ({ id: 's', namespace: 'default', active: false, archived: false }),
            resumeSession: async () => ({ type: 'success' as const, sessionId: 's' }),
            now: () => clock,
            sleep: async (ms) => { clock += ms },
            activeTimeoutMs: 1_000
        })
        await expect(gate.wake('s')).resolves.toMatchObject({ type: 'refused', failure: { code: 'resume_failed' } })
        expect(clock).toBeGreaterThanOrEqual(2_000)
        expect(gate.lastFailure('s')?.code).toBe('resume_failed')
    })

    it('turns a thrown resume into a failure instead of rejecting', async () => {
        const sessions = new Map<string, WakeableSession>([['s', { id: 's', namespace: 'default', active: false, archived: false }]])
        const gate = new SessionWakeGate({
            getSession: (sessionId) => sessions.get(sessionId) ?? null,
            resumeSession: async () => { throw new Error('rpc exploded') }
        })
        await expect(gate.wake('s')).resolves.toEqual({
            type: 'refused',
            failure: { code: 'resume_failed', message: 'rpc exploded' }
        })
        expect(gate.lastFailure('s')).toEqual({ code: 'resume_failed', message: 'rpc exploded' })
    })

    it('resolves refused for a session that no longer exists', async () => {
        const h: Harness = makeHarness()
        await expect(h.gate.wake('missing')).resolves.toEqual({
            type: 'refused',
            failure: { code: 'session_not_found', message: 'Session not found' }
        })
        expect(h.resumeCalls).toEqual([])
    })

    it('forgets the backoff of a removed session', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        await h.gate.wake('s')
        h.gate.forget('s')
        expect(h.gate.lastFailure('s')).toBeUndefined()
        h.addSession('s', false)
        await h.gate.wake('s')
        expect(h.resumeCalls).toHaveLength(2)
    })

    it('never resumes an archived session, even once its backoff has elapsed', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false, true)
        h.resumeResult.value = { type: 'success', sessionId: 's' }

        await expect(h.gate.wake('s')).resolves.toEqual({
            type: 'refused',
            failure: { code: 'session_archived', message: 'Session is archived' }
        })
        h.setClock(10_000)
        await expect(h.gate.wake('s')).resolves.toMatchObject({ type: 'refused', failure: { code: 'session_archived' } })
        expect(h.resumeCalls).toEqual([])
        expect(h.sessions.get('s')?.active).toBe(false)

        // Un-archived: the next wake after the backoff resumes it as usual.
        h.sessions.get('s')!.archived = false
        h.setClock(14_000)
        await expect(h.gate.wake('s')).resolves.toEqual({ type: 'active' })
        expect(h.resumeCalls).toEqual([{ sessionId: 's', namespace: 'default' }])
        expect(h.gate.lastFailure('s')).toBeUndefined()
    })

    it('waits on, and keys its state by, the id a resume rotates the session to', async () => {
        const h: Harness = makeHarness()
        h.addSession('a', false)
        h.addSession('b', false)
        h.resumeResult.value = { type: 'success', sessionId: 'b' }

        await expect(h.gate.wake('a')).resolves.toEqual({ type: 'active' })
        expect(h.resumeCalls).toEqual([{ sessionId: 'a', namespace: 'default' }])
        expect(h.sessions.get('b')?.active).toBe(true)
        // The rotation is remembered: the requested id reports the new row's state.
        expect(h.gate.lastFailure('a')).toBeUndefined()

        // A rotated resume that never reports active fails under the new id, and
        // the backoff applies to the row that exists now.
        h.addSession('c', false)
        h.addSession('d', false)
        const neverActive = new SessionWakeGate({
            getSession: (sessionId) => h.sessions.get(sessionId) ?? null,
            resumeSession: async () => ({ type: 'success' as const, sessionId: 'd' }),
            now: () => 1_000,
            sleep: async () => {},
            activeTimeoutMs: 0
        })
        await expect(neverActive.wake('c')).resolves.toMatchObject({ type: 'refused', failure: { code: 'resume_failed' } })
        expect(neverActive.lastFailure('c')).toEqual({ code: 'resume_failed', message: 'Session did not become active' })
        expect(neverActive.lastFailure('d')).toEqual({ code: 'resume_failed', message: 'Session did not become active' })
        await expect(neverActive.wake('d')).resolves.toEqual({ type: 'deferred' })
    })

    it(`runs at most ${SESSION_WAKE_MAX_CONCURRENT_RESUMES} resumes at once and defers the rest`, async () => {
        const h: Harness = makeHarness()
        const ids = ['s1', 's2', 's3', 's4', 's5']
        for (const id of ids) h.addSession(id, false)
        const releases: Array<() => void> = []
        let hold = true
        const gate = new SessionWakeGate({
            getSession: (sessionId) => h.sessions.get(sessionId) ?? null,
            resumeSession: async (sessionId) => {
                h.resumeCalls.push({ sessionId, namespace: 'default' })
                if (hold) await new Promise<void>((resolve) => { releases.push(resolve) })
                h.sessions.get(sessionId)!.active = true
                return { type: 'success' as const, sessionId }
            }
        })
        const wakes = Promise.all(ids.map((id) => gate.wake(id)))
        await Promise.resolve()
        // The first three hold the budget until they settle; the other two were not attempted.
        expect(h.resumeCalls.map((call) => call.sessionId).sort()).toEqual(['s1', 's2', 's3'])
        expect(releases).toHaveLength(3)
        for (const release of releases) release()
        const results = await wakes
        expect(results.map((result) => result.type)).toEqual(['active', 'active', 'active', 'deferred', 'deferred'])
        // A deferred session is resumed on a later wake, once a slot is free.
        hold = false
        await expect(gate.wake('s4')).resolves.toEqual({ type: 'active' })
        expect(h.resumeCalls).toHaveLength(4)
    })

    it('spends a resume slot only while a resume is running', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        h.resumeResult.value = { type: 'success', sessionId: 's' }
        await h.gate.wake('s')
        h.addSession('t', false)
        h.resumeResult.value = { type: 'success', sessionId: 't' }
        // The slot s held is free again.
        await expect(h.gate.wake('t')).resolves.toEqual({ type: 'active' })
    })
})
