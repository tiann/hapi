import { describe, expect, it } from 'bun:test'
import { SessionWakeGate, type SessionWakeResumeResult, type WakeableSession } from './sessionWakeGate'

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
            if (resumeResult.value.type === 'success') sessions.get(sessionId)!.active = true
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
        addSession: (id: string, active: boolean) => sessions.set(id, { id, namespace: 'default', active })
    }
}

describe('SessionWakeGate', () => {
    it('does not resume a session that is already active', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', true)
        await expect(h.gate.wake('s')).resolves.toBe(true)
        expect(h.resumeCalls).toEqual([])
    })

    it('resumes an inactive session and waits until it reports active', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)
        h.resumeResult.value = { type: 'success', sessionId: 's' }
        await expect(h.gate.wake('s')).resolves.toBe(true)
        expect(h.resumeCalls).toEqual([{ sessionId: 's', namespace: 'default' }])
        expect(h.gate.lastFailure('s')).toBeUndefined()
    })

    it('waits for a session that reports active only after the resume answered', async () => {
        const sessions = new Map<string, WakeableSession>([['s', { id: 's', namespace: 'default', active: false }]])
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
        await expect(waking).resolves.toBe(true)
        expect(polls).toBe(2)
    })

    it('backs off after a failed attempt instead of resuming on every tick', async () => {
        const h: Harness = makeHarness()
        h.addSession('s', false)

        await expect(h.gate.wake('s')).resolves.toBe(false)
        expect(h.gate.lastFailure('s')).toEqual({ code: 'no_machine_online', message: 'No machine online' })
        // Still inside the first backoff window: no second resume.
        h.setClock(1_500)
        await expect(h.gate.wake('s')).resolves.toBe(false)
        expect(h.resumeCalls).toHaveLength(1)

        h.setClock(2_001)
        await expect(h.gate.wake('s')).resolves.toBe(false)
        expect(h.resumeCalls).toHaveLength(2)
        // The delay doubles: 2s this time, then 4s (the cap).
        h.setClock(4_000)
        await expect(h.gate.wake('s')).resolves.toBe(false)
        expect(h.resumeCalls).toHaveLength(2)
        h.setClock(4_002)
        await expect(h.gate.wake('s')).resolves.toBe(false)
        h.setClock(8_002)
        await expect(h.gate.wake('s')).resolves.toBe(false)
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
        expect(results).toEqual([true, true, true])
        expect(h.resumeCalls).toHaveLength(1)
    })

    it('fails when the session does not report active before the deadline', async () => {
        let clock = 1_000
        const gate = new SessionWakeGate({
            getSession: () => ({ id: 's', namespace: 'default', active: false }),
            resumeSession: async () => ({ type: 'success' as const, sessionId: 's' }),
            now: () => clock,
            sleep: async (ms) => { clock += ms },
            activeTimeoutMs: 1_000
        })
        await expect(gate.wake('s')).resolves.toBe(false)
        expect(clock).toBeGreaterThanOrEqual(2_000)
        expect(gate.lastFailure('s')?.code).toBe('resume_failed')
    })

    it('turns a thrown resume into a failure instead of rejecting', async () => {
        const sessions = new Map<string, WakeableSession>([['s', { id: 's', namespace: 'default', active: false }]])
        const gate = new SessionWakeGate({
            getSession: (sessionId) => sessions.get(sessionId) ?? null,
            resumeSession: async () => { throw new Error('rpc exploded') }
        })
        await expect(gate.wake('s')).resolves.toBe(false)
        expect(gate.lastFailure('s')).toEqual({ code: 'resume_failed', message: 'rpc exploded' })
    })

    it('resolves false for a session that no longer exists', async () => {
        const h: Harness = makeHarness()
        await expect(h.gate.wake('missing')).resolves.toBe(false)
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
})
