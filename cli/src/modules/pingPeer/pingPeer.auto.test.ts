import { describe, expect, it, vi } from 'vitest'
import { pingPeer, exitCodeForPingPeerError, PingPeerError, type PingPeerSessionSummary } from './pingPeer'

const sessionId = '99999999-1111-4111-8111-111111111111'
const flavors = ['claude', 'codex', 'opencode', 'pi', 'cursor'] as const
type Flavor = typeof flavors[number]
type Response = { status: number; data: unknown }
type Submission = { text: string; localId: string; deliveryMode?: string }

function target(flavor: Flavor, active = true, steering = true): PingPeerSessionSummary {
    return {
        id: sessionId, active, thinking: steering,
        metadata: {
            flavor,
            ...(flavor === 'pi' ? { piSessionId: 'synthetic-pi' } : {}),
            ...(flavor === 'cursor' ? { cursorSessionProtocol: 'acp' as const } : {})
        },
        agentState: { steeringActive: steering }
    }
}

function transport(initial: PingPeerSessionSummary, options: {
    steer?: Response | Error
    send?: Response | Error
    live?: PingPeerSessionSummary
    afterResume?: PingPeerSessionSummary
} = {}) {
    let current = options.live ?? initial
    const rows: Submission[] = []
    const steers: string[] = []
    const http = {
        get: vi.fn(async (url: string) => url.endsWith('/api/sessions')
            ? { status: 200, data: { sessions: [initial] } }
            : { status: 200, data: { session: current } }),
        post: vi.fn(async (url: string, body?: unknown) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'synthetic-jwt' } }
            if (url.endsWith('/resume')) {
                current = options.afterResume ?? { ...current, active: true }
                return { status: 200, data: { type: 'success', sessionId } }
            }
            if (url.endsWith('/messages')) {
                rows.push(body as Submission)
                if (options.send instanceof Error) throw options.send
                return options.send ?? { status: 200, data: { ok: true } }
            }
            if (url.endsWith('/steer')) {
                steers.push(url)
                if (options.steer instanceof Error) throw options.steer
                return options.steer ?? { status: 200, data: { status: 'steered' } }
            }
            throw new Error(`Unexpected synthetic route ${url}`)
        })
    }
    return {
        rows, steers, http,
        input: { sessionIdPrefix: sessionId, message: 'Synthetic peer update',
            apiUrl: 'http://hub.test', accessToken: 'synthetic-access', http: http as never }
    }
}

describe.each(flavors)('auto delivery to %s', (flavor) => {
    it.each([undefined, 'auto'] as const)('steers an eligible active turn with mode %s using one ordinary queued row', async (deliveryMode) => {
        const t = transport(target(flavor))
        const result = await pingPeer({ ...t.input, deliveryMode })
        expect(result.delivery).toBe('steered')
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([`http://hub.test/api/sessions/${sessionId}/messages/${result.localId}/steer`])
    })

    it('queues an idle target without a steer request', async () => {
        const t = transport(target(flavor, true, false))
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto' })
        expect(result.delivery).toBe('accepted')
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
    })

    it('queues when concurrent control is explicitly disabled for a local target', async () => {
        const session = target(flavor)
        session.agentState = { steeringActive: true, controlledByUser: true }
        session.metadata = { ...session.metadata, capabilities: { concurrentClients: false } }
        const t = transport(session)
        expect((await pingPeer({ ...t.input, deliveryMode: 'auto' })).delivery).toBe('accepted')
        expect(t.rows).toHaveLength(1)
        expect(t.steers).toEqual([])
    })

    it('resumes an inactive target and queues even if the resumed turn reports steering ready', async () => {
        const t = transport(target(flavor, false), { afterResume: target(flavor) })
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto', wake: true })
        expect(result.resumed).toBe(true)
        expect(result.delivery).toBe('accepted')
        expect(t.http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(1)
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
    })

    it.each(['auto', 'queue'] as const)('refuses an inactive target by default in %s mode without resume, row or RPC', async (deliveryMode) => {
        const t = transport(target(flavor, false))
        const error = await pingPeer({ ...t.input, deliveryMode }).catch(error => error)
        expect(error).toBeInstanceOf(PingPeerError)
        expect(error.code).toBe('inactive')
        expect(exitCodeForPingPeerError(error)).toBe(5)
        expect(t.http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(0)
        expect(t.rows).toEqual([])
        expect(t.steers).toEqual([])
    })

    it('rejects explicit steer to an inactive target even with wake enabled', async () => {
        const t = transport(target(flavor, false))
        await expect(pingPeer({ ...t.input, deliveryMode: 'steer', wake: true })).rejects.toMatchObject({ code: 'bad_args' })
        expect(t.http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(0)
        expect(t.rows).toEqual([])
        expect(t.steers).toEqual([])
    })

    it.each(['auto', 'queue'] as const)('preserves opt-in wake for an active-list/inactive-live race in %s mode', async (deliveryMode) => {
        for (const wake of [false, true]) {
            const t = transport(target(flavor), { live: target(flavor, false), afterResume: target(flavor) })
            if (wake) {
                const result = await pingPeer({ ...t.input, deliveryMode, wake })
                expect(result.resumed).toBe(true)
                expect(result.delivery).toBe('accepted')
                expect(result.steerNote).toBe(deliveryMode === 'auto' ? 'steer not attempted: target was just resumed' : undefined)
                expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
            } else {
                await expect(pingPeer({ ...t.input, deliveryMode, wake })).rejects.toMatchObject({ code: 'inactive' })
                expect(t.rows).toEqual([])
            }
            expect(t.http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(wake ? 1 : 0)
            expect(t.steers).toEqual([])
        }
    })

    it.each([
        [{ status: 200, data: { status: 'failed', error: 'Session not found', localId: null } }, 'steer rejected by hub: Session not found', 'stays queued'],
        [{ status: 409, data: { error: 'Session became inactive' } }, 'steer rejected by hub: Session became inactive', 'stays queued'],
        [{ status: 200, data: { status: 'failed', error: 'RPC timeout: steer-queued-message', localId: 'ping-peer-x' } },
            'steer not confirmed; delivery unresolved: RPC timeout: steer-queued-message', 'delivery unresolved'],
        [{ status: 200, data: { status: 'failed', error: 'Steer outcome is being reconciled', localId: 'ping-peer-x' } },
            'steer not confirmed; delivery unresolved: Steer outcome is being reconciled', 'delivery unresolved'],
        [{ status: 500, data: { error: 'Hub unavailable' } }, 'steer not confirmed; delivery unresolved: Hub unavailable', 'delivery unresolved'],
        [new Error('Synthetic steer ACK lost'), 'steer not confirmed; delivery unresolved: Synthetic steer ACK lost', 'delivery unresolved']
    ] as const)('retains the one accepted row and words the steer outcome by its evidence: %j', async (steer, steerNote, progressTail) => {
        const t = transport(target(flavor), { steer })
        const progress: string[] = []
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto', onProgress: (m) => progress.push(m) })
        expect(result.delivery).toBe('accepted')
        expect(result.steerNote).toBe(steerNote)
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([`http://hub.test/api/sessions/${sessionId}/messages/${result.localId}/steer`])
        expect(t.http.post.mock.calls).toHaveLength(3)
        const line = progress.find((m) => m.startsWith(steerNote))
        expect(line).toBeDefined()
        expect(line).toContain(progressTail)
        if (progressTail === 'delivery unresolved') expect(line).not.toContain('stays queued')
    })

    it.each([
        { status: 500, data: { error: 'Synthetic hub failure' } },
        { status: 409, data: { error: 'Session is inactive' } }
    ])('does not hide a non-2xx initial submission or attempt a steer: %j', async (send) => {
        const t = transport(target(flavor), { send })
        await expect(pingPeer({ ...t.input, deliveryMode: 'auto' })).rejects.toMatchObject({ code: 'send_failed' })
        expect(t.rows).toHaveLength(1)
        expect(t.steers).toEqual([])
    })

    it('queues without a steer when the target only became active through waitForInitialActive', async () => {
        const t = transport(target(flavor, false), { live: target(flavor, true) })
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto', waitForInitialActive: true })
        expect(result.delivery).toBe('accepted')
        expect(result.steerNote).toBe('steer not attempted: target was not active')
        expect(result.resumed).toBe(false)
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
        expect(t.http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(0)
    })

    it('keeps authoritative consumption instead of claiming a queue fallback', async () => {
        const t = transport(target(flavor), { steer: { status: 200, data: { status: 'invoked' } } })
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto' })
        expect(result.delivery).toBe('invoked')
        expect(t.rows).toHaveLength(1)
        expect(t.steers).toHaveLength(1)
    })

    it('does not hide an unconfirmed initial message submission or attempt a steer', async () => {
        const t = transport(target(flavor), { send: new Error('Synthetic message ACK lost') })
        await expect(pingPeer({ ...t.input, deliveryMode: 'auto' })).rejects.toThrow(/Send not confirmed.*Do not resend automatically/)
        expect(t.rows).toHaveLength(1)
        expect(t.steers).toEqual([])
    })

    it('preserves explicit steer rejection and its existing queued-row payload', async () => {
        const t = transport(target(flavor), { steer: { status: 200, data: { status: 'failed', error: 'No active turn' } } })
        await expect(pingPeer({ ...t.input, deliveryMode: 'steer' })).rejects.toThrow(/Message accepted.*steer was not confirmed/)
        expect(t.rows).toHaveLength(1)
        expect(t.rows[0]).toEqual({ text: t.input.message, localId: t.rows[0]?.localId })
        expect(t.steers).toHaveLength(1)
    })

    it('preserves explicit queue without attempting a steer', async () => {
        const t = transport(target(flavor))
        const result = await pingPeer({ ...t.input, deliveryMode: 'queue' })
        expect(result.delivery).toBe('accepted')
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
    })
})

describe('auto delivery to a legacy Cursor stream-json session', () => {
    it('queues without a steer request because the session cannot steer', async () => {
        const legacy: PingPeerSessionSummary = {
            id: sessionId, active: true, thinking: true,
            metadata: { flavor: 'cursor', cursorSessionProtocol: 'stream-json' as never },
            agentState: { steeringActive: true }
        }
        const t = transport(legacy)
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto' })
        expect(result.delivery).toBe('accepted')
        expect(result.steerNote).toMatch(/^steer not attempted: /)
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
    })
})

describe.each([
    ['idle', { active: true, steering: false }, 'steer not attempted: target is idle'],
    ['locally controlled', { active: true, steering: true, local: true }, 'steer not attempted: target is controlled locally'],
] as const)('auto delivery to a %s target', (_label, shape, note) => {
    it('accepts the message and explains the skipped steer without claiming nothing was sent', async () => {
        const base = target('claude', shape.active, shape.steering)
        const peer: PingPeerSessionSummary = 'local' in shape
            ? { ...base, agentState: { ...base.agentState, controlledByUser: true } }
            : base
        const t = transport(peer)
        const progress: string[] = []
        const result = await pingPeer({ ...t.input, deliveryMode: 'auto', onProgress: (m) => progress.push(m) })
        expect(result.delivery).toBe('accepted')
        expect(result.steerNote).toBe(note)
        expect(result.steerNote).not.toMatch(/no message sent/i)
        expect(progress.join('\n')).not.toMatch(/no message sent/i)
        expect(t.rows).toEqual([{ text: t.input.message, localId: result.localId }])
        expect(t.steers).toEqual([])
    })

    it('still refuses an explicit steer with the pre-send wording', async () => {
        const base = target('claude', shape.active, shape.steering)
        const peer: PingPeerSessionSummary = 'local' in shape
            ? { ...base, agentState: { ...base.agentState, controlledByUser: true } }
            : base
        const t = transport(peer)
        await expect(pingPeer({ ...t.input, deliveryMode: 'steer' })).rejects.toThrow(/no message sent/)
        expect(t.rows).toEqual([])
    })
})
