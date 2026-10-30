import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MessageDeliveryModeSchema } from '@hapi/protocol'
import { PeerDeliveryModeSchema } from './deliveryMode'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    inspectPeer,
    listPeerSessions,
    pingPeer,
    resolveSessionByPrefix,
    type PingPeerSessionSummary
} from './pingPeer'
import { applyHubPeerToolsDisabled, resetPeerToolsForTests } from '@/modules/common/peerTools'

type MockResponse = {
    status: number
    data: unknown
}

function createHttpMock(handlers: {
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get?: (url: string, config?: { params?: Record<string, unknown> }) => MockResponse | Promise<MockResponse>
}) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.post) {
                throw new Error(`unexpected POST ${url}`)
            }
            return handlers.post(url, body)
        }),
        get: vi.fn(async (url: string, config?: { params?: Record<string, unknown> }) => {
            if (!handlers.get) {
                throw new Error(`unexpected GET ${url}`)
            }
            return handlers.get(url, config)
        })
    }
}

describe('resolveSessionByPrefix', () => {
    const sessions: PingPeerSessionSummary[] = [
        { id: 'aaaaaaaa-1111-1111-1111-111111111111', active: true, metadata: { name: 'A' } },
        { id: 'aaaaaaab-2222-2222-2222-222222222222', active: false, metadata: { name: 'B' } },
        { id: 'bbbbbbbb-3333-3333-3333-333333333333', active: true, metadata: { name: 'C' } }
    ]

    it('resolves a unique id prefix', () => {
        expect(resolveSessionByPrefix(sessions, 'bbbb').id).toBe(sessions[2]!.id)
    })

    it('prefers an exact id match', () => {
        expect(resolveSessionByPrefix(sessions, sessions[0]!.id).id).toBe(sessions[0]!.id)
    })

    it('refuses ambiguous prefixes', () => {
        expect(() => resolveSessionByPrefix(sessions, 'aaaa')).toThrow(PingPeerError)
        try {
            resolveSessionByPrefix(sessions, 'aaaa')
        } catch (error) {
            expect(error).toBeInstanceOf(PingPeerError)
            expect((error as PingPeerError).code).toBe('ambiguous')
        }
    })

    it('refuses unknown prefixes', () => {
        expect(() => resolveSessionByPrefix(sessions, 'zzzz')).toThrowError(/no session matching/)
    })
})

describe('pingPeer', () => {
    let nowMs: number
    let sleepCalls: number[]

    beforeEach(() => {
        nowMs = 1_000_000
        sleepCalls = []
    })

    it('sends to an already-active session without resume', async () => {
        const sessionId = '05d9f0f2-9273-4137-933c-07459a1146a2'
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    expect(body).toEqual({ accessToken: 'tok' })
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(body).toMatchObject({ text: 'hello peer' })
                    expect(typeof (body as { localId?: unknown }).localId).toBe('string')
                    expect(String((body as { localId?: unknown }).localId)).toMatch(/^ping-peer-/)
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: true,
                                metadata: { name: 'Orchestrator', flavor: 'cursor' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active: true,
                                metadata: { name: 'Orchestrator', flavor: 'cursor' }
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await pingPeer({
            sessionIdPrefix: '05d9f0f2',
            message: 'hello peer',
            accessToken: 'tok',
            apiUrl: 'http://127.0.0.1:3006',
            http: http as never
        })

        expect(result).toMatchObject({
            sessionId,
            name: 'Orchestrator',
            resumed: false,
            delivery: 'accepted'
        })
        expect(result.localId).toMatch(/^ping-peer-/)
        expect(http.post.mock.calls[1]?.[1]).toEqual({ text: 'hello peer', localId: result.localId })
        expect(http.post).toHaveBeenCalledTimes(2)
    })

    it.each([undefined, 'auto', 'queue'] as const)('resumes an inactive session with %s delivery, waits for active, then sends', async (deliveryMode) => {
        const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'
        let active = false
        let polls = 0

        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/resume`)) {
                    return { status: 200, data: { type: 'success', sessionId, resumed: true } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(active).toBe(true)
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(sessionId)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: false,
                                metadata: { name: 'Peer', flavor: 'claude' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    polls += 1
                    if (polls >= 3) {
                        active = true
                    }
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active,
                                metadata: { name: 'Peer', flavor: 'claude' }
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await pingPeer({
            sessionIdPrefix: 'aaaaaaaa',
            message: 'wake up',
            deliveryMode,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 10,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                sleepCalls.push(ms)
                nowMs += ms
            }
        })

        expect(result.resumed).toBe(true)
        expect(result.sessionId).toBe(sessionId)
        expect(sleepCalls.length).toBeGreaterThan(0)
    })

    it('re-checks active before send when the list snapshot was stale', async () => {
        const sessionId = 'bbbbbbbb-1111-1111-1111-111111111111'
        let active = false
        let resumeCalls = 0

        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/resume`)) {
                    resumeCalls += 1
                    return { status: 200, data: { type: 'success', sessionId, resumed: true } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(active).toBe(true)
                    expect(resumeCalls).toBe(1)
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(sessionId)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                // Stale snapshot: list claims active, live GET disagrees.
                                active: true,
                                metadata: { name: 'Stale', flavor: 'claude' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active,
                                metadata: { name: 'Stale', flavor: 'claude' }
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await pingPeer({
            sessionIdPrefix: 'bbbbbbbb',
            message: 'still here?',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 10,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                sleepCalls.push(ms)
                nowMs += ms
                // Become active only after resume has been requested.
                if (resumeCalls > 0) {
                    active = true
                }
            }
        })

        expect(result.resumed).toBe(true)
        expect(resumeCalls).toBe(1)
    })

    it('waits for piSessionId before sending to a pi session', async () => {
        const sessionId = 'piiiiiii-1111-1111-1111-111111111111'
        let piSessionId: string | undefined
        let getCount = 0

        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(piSessionId).toBe('pi-ready-1')
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(sessionId)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: true,
                                metadata: { name: 'Pi', flavor: 'pi' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    getCount += 1
                    if (getCount >= 2) {
                        piSessionId = 'pi-ready-1'
                    }
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active: true,
                                metadata: { name: 'Pi', flavor: 'pi', piSessionId }
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await pingPeer({
            sessionIdPrefix: 'piiiiiii',
            message: 'hi pi',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 5,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })
    })

    it('maps resume failures to resume_failed', async () => {
        const sessionId = 'deadbeef-1111-1111-1111-111111111111'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/resume`)) {
                    return {
                        status: 503,
                        data: { type: 'error', code: 'no_machine_online', message: 'no runner' }
                    }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(sessionId)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: false,
                                metadata: { name: 'Dead' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: sessionId,
                                active: false,
                                metadata: { name: 'Dead' }
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(pingPeer({
            sessionIdPrefix: 'deadbeef',
            message: 'nudge',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'resume_failed' })
    })

    it('maps exit codes', () => {
        expect(exitCodeForPingPeerError(new PingPeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForPingPeerError(new PingPeerError('resume_failed', 'x'))).toBe(3)
        expect(exitCodeForPingPeerError(new PingPeerError('timeout', 'x'))).toBe(4)
        expect(exitCodeForPingPeerError(new PingPeerError('send_failed', 'x'))).toBe(4)
    })
})

describe('pingPeer delivery modes', () => {
    const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'
    const active: PingPeerSessionSummary = {
        id: sessionId, active: true, thinking: true,
        agentState: { steeringActive: true }, metadata: { flavor: 'codex' }
    }

    function setup(session = active, steerResult: MockResponse | Error = {
        status: 200, data: { status: 'steered' }
    }, listedSession = session) {
        const http = createHttpMock({
            get: (url) => url.endsWith('/api/sessions')
                ? { status: 200, data: { sessions: [listedSession] } }
                : { status: 200, data: { session } },
            post: (url) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                if (url.endsWith('/messages')) return { status: 200, data: { ok: true } }
                if (url.endsWith('/steer')) {
                    if (steerResult instanceof Error) throw steerResult
                    return steerResult
                }
                throw new Error(`Unexpected POST ${url}`)
            }
        })
        return {
            http,
            options: {
                sessionIdPrefix: sessionId, message: 'adjust the task',
                apiUrl: 'http://hub.test', accessToken: 'tok', http: http as never
            }
        }
    }

    it('keeps auto out of the hub wire delivery modes', () => {
        expect(PeerDeliveryModeSchema.parse('auto')).toBe('auto')
        expect(MessageDeliveryModeSchema.safeParse('auto').success).toBe(false)
    })

    it('honors explicit queue even when a Codex turn is steerable', async () => {
        const { http, options } = setup()
        const result = await pingPeer({ ...options, deliveryMode: 'queue' })
        expect(result.delivery).toBe('accepted')
        expect(result.localId).toMatch(/^ping-peer-[0-9a-f-]{36}$/)
        expect(http.post.mock.calls.map(([url]) => url)).toEqual([
            'http://hub.test/api/auth', `http://hub.test/api/sessions/${sessionId}/messages`
        ])
        expect(http.post.mock.calls[1]?.[1]).toEqual({ text: options.message, localId: result.localId })
    })

    it.each([undefined, 'auto'] as const)('steers an active Codex peer with %s delivery', async (deliveryMode) => {
        const { http, options } = setup()
        const onProgress = vi.fn()
        const result = await pingPeer({ ...options, deliveryMode, onProgress })
        expect(result.delivery).toBe('steered')
        expect(http.post.mock.calls.map(([url]) => url)).toEqual([
            'http://hub.test/api/auth',
            `http://hub.test/api/sessions/${sessionId}/messages`,
            `http://hub.test/api/sessions/${sessionId}/messages/${result.localId}/steer`
        ])
        expect(http.post.mock.calls[1]?.[1]).toEqual({ text: options.message, localId: result.localId })
        expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('steer via auto'))
    })

    it.each([
        { name: 'idle Codex', session: { ...active, thinking: false, agentState: { steeringActive: false } } },
        { name: 'thinking Codex without a steerable turn', session: { ...active, agentState: { steeringActive: false } } },
        { name: 'Codex without steering state', session: { ...active, agentState: null } },
        { name: 'local Codex without concurrent control', session: { ...active, agentState: { steeringActive: true, controlledByUser: true } } },
        { name: 'unknown flavor', session: { ...active, metadata: null } },
        { name: 'Pi', session: { ...active, metadata: { flavor: 'pi', piSessionId: 'pi-thread' } } },
        { name: 'Cursor ACP', session: { ...active, metadata: { flavor: 'cursor', cursorSessionProtocol: 'acp' as const } } },
        { name: 'legacy Cursor', session: { ...active, metadata: { flavor: 'cursor', cursorSessionProtocol: 'stream-json' as const } } },
        { name: 'Claude', session: { ...active, metadata: { flavor: 'claude' } } }
    ])('auto queues for $name', async ({ session }) => {
        const { http, options } = setup(session)
        expect((await pingPeer({ ...options, deliveryMode: 'auto' })).delivery).toBe('accepted')
        expect(http.post.mock.calls.map(([url]) => url)).toEqual([
            'http://hub.test/api/auth', `http://hub.test/api/sessions/${sessionId}/messages`
        ])
    })

    it('auto steers concurrent Codex when thinking is false but steeringActive is true', async () => {
        const { options } = setup({
            ...active, thinking: false,
            agentState: { steeringActive: true, controlledByUser: true },
            metadata: { flavor: 'codex', capabilities: { concurrentClients: true } }
        })
        expect((await pingPeer({ ...options, deliveryMode: 'auto' })).delivery).toBe('steered')
    })

    it.each([true, false])('auto uses live steeringActive=%s rather than the list snapshot', async (steeringActive) => {
        const { http, options } = setup(
            { ...active, agentState: { steeringActive } },
            undefined,
            { ...active, agentState: { steeringActive: !steeringActive } }
        )
        expect((await pingPeer({ ...options, deliveryMode: 'auto' })).delivery).toBe(steeringActive ? 'steered' : 'accepted')
        expect(http.post.mock.calls.filter(([url]) => url.endsWith('/steer'))).toHaveLength(steeringActive ? 1 : 0)
    })

    it.each([true, false])('auto re-evaluates Codex steeringActive=%s after resume', async (steeringActive) => {
        let resumed = false
        const http = createHttpMock({
            get: (url) => url.endsWith('/api/sessions')
                ? { status: 200, data: { sessions: [{ ...active, active: false }] } }
                : { status: 200, data: { session: { ...active, active: resumed, agentState: { steeringActive: resumed && steeringActive } } } },
            post: (url) => {
                if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
                if (url.endsWith('/resume')) {
                    resumed = true
                    return { status: 200, data: { type: 'success', sessionId } }
                }
                if (url.endsWith('/messages')) return { status: 200, data: { ok: true } }
                if (url.endsWith('/steer')) return { status: 200, data: { status: 'steered' } }
                throw new Error(`Unexpected POST ${url}`)
            }
        })
        const result = await pingPeer({
            sessionIdPrefix: sessionId, message: 'update', deliveryMode: 'auto',
            apiUrl: 'http://hub.test', accessToken: 'tok', http: http as never
        })
        expect(result.resumed).toBe(true)
        expect(result.delivery).toBe(steeringActive ? 'steered' : 'accepted')
        expect(http.post.mock.calls.filter(([url]) => url.endsWith('/resume'))).toHaveLength(1)
        expect(http.post.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(1)
        expect(http.post.mock.calls.filter(([url]) => url.endsWith('/steer'))).toHaveLength(steeringActive ? 1 : 0)
    })

    it.each([
        { flavor: 'codex' },
        { flavor: 'pi', piSessionId: 'pi-thread' },
        { flavor: 'cursor', cursorSessionProtocol: 'acp' as const }
    ])('steers an ackable message in $flavor using its localId', async (metadata) => {
        const { http, options } = setup({ ...active, metadata })
        const result = await pingPeer({ ...options, deliveryMode: 'steer' })
        expect(result.delivery).toBe('steered')
        const body = http.post.mock.calls[1]?.[1] as { text: string; localId: string }
        expect(body.text).toBe(options.message)
        expect(body.localId).toMatch(/^ping-peer-[0-9a-f-]{36}$/)
        expect(result.localId).toBe(body.localId)
        expect(http.post.mock.calls[2]?.[0]).toBe(
            `http://hub.test/api/sessions/${sessionId}/messages/${body.localId}/steer`
        )
        expect(http.post).toHaveBeenCalledTimes(3)
    })

    it.each([undefined, 'auto', 'steer'] as const)('reports a message consumed before %s steer without claiming it was steered', async (deliveryMode) => {
        const { options } = setup(active, { status: 200, data: { status: 'invoked' } })
        expect((await pingPeer({ ...options, deliveryMode })).delivery).toBe('invoked')
    })

    it.each([
        { ...active, active: false },
        { ...active, thinking: false, agentState: { steeringActive: false } },
        { ...active, metadata: { flavor: 'claude' } },
        { ...active, metadata: { flavor: 'cursor', cursorSessionProtocol: 'stream-json' as const } },
        { ...active, metadata: { flavor: 'cursor', cursorSessionId: 'legacy' } },
        { ...active, agentState: { controlledByUser: true } }
    ])('rejects an unavailable steer before sending or resuming: %j', async (session) => {
        const { http, options } = setup(session)
        await expect(pingPeer({ ...options, deliveryMode: 'steer' })).rejects.toThrow(/no message sent/)
        expect(http.post.mock.calls.map(([url]) => url)).toEqual(['http://hub.test/api/auth'])
    })

    it('accepts a concurrent Codex turn even when thinking is false', async () => {
        const { options } = setup({
            ...active, thinking: false, agentState: { steeringActive: true, controlledByUser: true },
            metadata: { flavor: 'codex', capabilities: { concurrentClients: true } }
        })
        expect((await pingPeer({ ...options, deliveryMode: 'steer' })).delivery).toBe('steered')
    })

    it.each([
        { flavor: 'codex', steeringActive: false },
        { flavor: 'codex', steeringActive: undefined },
        { flavor: 'cursor', steeringActive: false },
        { flavor: 'cursor', steeringActive: undefined }
    ])('does not send to a thinking $flavor peer with steeringActive=$steeringActive', async ({ flavor, steeringActive }) => {
        const { http, options } = setup({
            ...active, metadata: { flavor }, agentState: { steeringActive }
        })
        await expect(pingPeer({ ...options, deliveryMode: 'steer' })).rejects.toThrow(/no message sent/)
        expect(http.post.mock.calls.map(([url]) => url)).toEqual(['http://hub.test/api/auth'])
    })

    it('uses thinking rather than steeringActive for an active Pi turn', async () => {
        const { options } = setup({
            ...active, agentState: { steeringActive: false },
            metadata: { flavor: 'pi', piSessionId: 'pi-thread' }
        })
        expect((await pingPeer({ ...options, deliveryMode: 'steer' })).delivery).toBe('steered')
    })

    it('does not send to an idle Pi peer even if steeringActive is true', async () => {
        const { http, options } = setup({
            ...active, thinking: false, metadata: { flavor: 'pi', piSessionId: 'pi-thread' }
        })
        await expect(pingPeer({ ...options, deliveryMode: 'steer' })).rejects.toThrow(/no message sent/)
        expect(http.post.mock.calls.map(([url]) => url)).toEqual(['http://hub.test/api/auth'])
    })

    it('validates delivery mode before making requests', async () => {
        const { http, options } = setup()
        await expect(pingPeer({ ...options, deliveryMode: 'interrupt' as never })).rejects.toThrow(
            'deliveryMode must be auto, queue or steer'
        )
        expect(http.post).not.toHaveBeenCalled()
        expect(http.get).not.toHaveBeenCalled()
    })

    describe.each([undefined, 'auto', 'steer'] as const)('selected steer with %s delivery', (deliveryMode) => {
        it.each([
            { status: 200, data: { status: 'failed', error: 'No active turn' } },
            { status: 200, data: { status: 'failed', error: 'Message not in queue' } },
            { status: 409, data: { error: 'Session inactive' } },
            new Error('Request timed out')
        ])('reports accepted but unconfirmed steer without fallback or resending: %j', async (failure) => {
            const { http, options } = setup(active, failure)
            await expect(pingPeer({ ...options, deliveryMode })).rejects.toThrow(
                /Message accepted \(localId=ping-peer-.+\), but steer was not confirmed: .*Do not resend automatically/
            )
            expect(http.post.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(1)
            expect(http.post.mock.calls.filter(([url]) => url.endsWith('/steer'))).toHaveLength(1)
        })

        it('does not steer or resend when the initial send times out', async () => {
            const { http, options } = setup()
            http.post.mockImplementationOnce(async () => ({ status: 200, data: { token: 'jwt' } }))
            http.post.mockImplementationOnce(async () => { throw new Error('Request timed out') })
            await expect(pingPeer({ ...options, deliveryMode })).rejects.toThrow(
                /Send not confirmed \(localId=ping-peer-.+\).*Do not resend automatically/
            )
            expect(http.post).toHaveBeenCalledTimes(2)
        })

        it.each([
            { status: 500, data: { error: 'Publish failed' } },
            { status: 200, data: { ok: false } }
        ])('retains the localId when the initial send response does not confirm acceptance: %j', async (response) => {
            const { http, options } = setup()
            http.post.mockImplementationOnce(async () => ({ status: 200, data: { token: 'jwt' } }))
            http.post.mockImplementationOnce(async () => response)
            await expect(pingPeer({ ...options, deliveryMode })).rejects.toThrow(
                /Send not confirmed \(localId=ping-peer-.+\).*Do not resend automatically/
            )
            expect(http.post).toHaveBeenCalledTimes(2)
        })
    })

    it('does not attempt steering when a queue submission fails', async () => {
        const { http, options } = setup()
        http.post.mockImplementationOnce(async () => ({ status: 200, data: { token: 'jwt' } }))
        http.post.mockImplementationOnce(async () => ({ status: 500, data: { error: 'Publish failed' } }))
        await expect(pingPeer({ ...options, deliveryMode: 'queue' })).rejects.toMatchObject({
            code: 'send_failed', message: 'send failed: Publish failed'
        })
        expect(http.post).toHaveBeenCalledTimes(2)
    })
})

describe('formatPeerSessionsList', () => {
    it('formats newest-first peer rows with id prefix and metadata', async () => {
        const { formatPeerSessionsList } = await import('./pingPeer')
        const text = formatPeerSessionsList([
            {
                id: 'aaaaaaaa-1111-1111-1111-111111111111',
                active: false,
                updatedAt: 100,
                metadata: { name: 'Old', flavor: 'claude' }
            },
            {
                id: 'bbbbbbbb-2222-2222-2222-222222222222',
                active: true,
                updatedAt: 200,
                metadata: { name: 'Fresh', flavor: 'cursor' }
            }
        ])
        const lines = text.split('\n')
        expect(lines[0]).toContain('bbbbbbbb-2222-2222-2222-222222222222')
        expect(lines[0]).toContain('active=true')
        expect(lines[0]).toContain('flavor=cursor')
        expect(lines[0]).toContain('Fresh')
        expect(lines[1]).toContain('aaaaaaaa-1111-1111-1111-111111111111')
    })

    it('emits full session ids so colliding 8-char prefixes stay resolvable', async () => {
        const { formatPeerSessionsList } = await import('./pingPeer')
        const text = formatPeerSessionsList([
            {
                id: 'aaaaaaaa-1111-1111-1111-111111111111',
                active: true,
                updatedAt: 2,
                metadata: { name: 'A', flavor: 'claude' }
            },
            {
                id: 'aaaaaaaa-2222-2222-2222-222222222222',
                active: true,
                updatedAt: 1,
                metadata: { name: 'B', flavor: 'cursor' }
            }
        ])
        expect(text).toContain('aaaaaaaa-1111-1111-1111-111111111111')
        expect(text).toContain('aaaaaaaa-2222-2222-2222-222222222222')
        expect(text.split('\n')).toHaveLength(2)
    })

    it('uses summary.text when name is unset and collapses multiline titles', async () => {
        const { formatPeerSessionsList, resolvePeerSessionLabel } = await import('./pingPeer')
        const session = {
            id: 'dddddddd-4444-4444-4444-444444444444',
            active: true,
            updatedAt: 50,
            metadata: {
                flavor: 'codex',
                summary: { text: 'Peer\nwith\ttabs' },
                path: '/home/user/projects/widget'
            }
        }
        expect(resolvePeerSessionLabel(session)).toBe('Peer with tabs')
        const text = formatPeerSessionsList([session])
        expect(text).toContain('Peer with tabs')
        expect(text.split('\n')).toHaveLength(1)
        expect(text).not.toContain('(unnamed)')
    })

    it('falls back to path basename then id prefix', async () => {
        const { resolvePeerSessionLabel } = await import('./pingPeer')
        expect(resolvePeerSessionLabel({
            id: 'eeeeeeee-5555-5555-5555-555555555555',
            active: true,
            metadata: { path: '/tmp/my-worktree' }
        })).toBe('my-worktree')
        expect(resolvePeerSessionLabel({
            id: 'ffffffff-6666-6666-6666-666666666666',
            active: true,
            metadata: null
        })).toBe('ffffffff')
        expect(resolvePeerSessionLabel({
            id: 'aaaaaaaa-7777-7777-7777-777777777777',
            active: true,
            metadata: { path: 'C:\\Users\\me\\repo' }
        })).toBe('repo')
    })

    it('respects maxRows and empty list', async () => {
        const { formatPeerSessionsList } = await import('./pingPeer')
        expect(formatPeerSessionsList([])).toContain('No peer sessions')
        const many = Array.from({ length: 5 }, (_, i) => ({
            id: `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
            active: true,
            updatedAt: i,
            metadata: { name: `S${i}`, flavor: 'pi' as string | null }
        }))
        const text = formatPeerSessionsList(many, { maxRows: 2 })
        expect(text.split('\n').filter((l) => l.includes('active='))).toHaveLength(2)
    })

    it('omits the calling session even when it is newest', async () => {
        const { formatPeerSessionsList } = await import('./pingPeer')
        const selfId = 'cccccccc-3333-3333-3333-333333333333'
        const text = formatPeerSessionsList([
            {
                id: selfId,
                active: true,
                updatedAt: 300,
                metadata: { name: 'Self', flavor: 'cursor' }
            },
            {
                id: 'bbbbbbbb-2222-2222-2222-222222222222',
                active: true,
                updatedAt: 200,
                metadata: { name: 'Peer', flavor: 'claude' }
            }
        ], { excludeSessionId: selfId })
        expect(text).not.toContain('cccccccc-3333-3333-3333-333333333333')
        expect(text).not.toContain('Self')
        expect(text).toContain('bbbbbbbb-2222-2222-2222-222222222222')
        expect(text).toContain('Peer')
    })

    it('hasMore marks overflow without requiring an exact omitted count', async () => {
        const { formatPeerSessionsList } = await import('./pingPeer')
        const text = formatPeerSessionsList([
            {
                id: 'aaaaaaaa-1111-1111-1111-111111111111',
                active: true,
                updatedAt: 1,
                metadata: { name: 'Only', flavor: 'claude' }
            }
        ], { maxRows: 1, hasMore: true })
        expect(text).toContain('Only')
        expect(text).toMatch(/more sessions available/)
    })

    it('peerListFetchLimit pads for caller exclusion and overflow probe', async () => {
        const { peerListFetchLimit } = await import('./pingPeer')
        expect(peerListFetchLimit(100, { excludeCaller: true })).toBe(102)
        expect(peerListFetchLimit(100)).toBe(101)
        expect(peerListFetchLimit(499, { excludeCaller: true })).toBe(500)
    })
})

describe('listPeerSessions auth failures', () => {
    it('hints at auth login and hub URL when JWT exchange fails', async () => {
        const { listPeerSessions, PingPeerError } = await import('./pingPeer')
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 401, data: { error: 'invalid token' } }
                }
                throw new Error(`unexpected POST ${url}`)
            }
        })

        let caught: unknown
        try {
            await listPeerSessions({
                accessToken: 'bad',
                apiUrl: 'http://remote-hub:3006',
                http: http as never
            })
        } catch (error) {
            caught = error
        }
        expect(caught).toBeInstanceOf(PingPeerError)
        const message = (caught as InstanceType<typeof PingPeerError>).message
        expect(message).toMatch(/auth login|CLI_API_TOKEN/i)
        expect(message).toContain('http://remote-hub:3006')
        expect(message).toMatch(/list_peers|MCP/i)
    })

    it('hints when CLI_API_TOKEN is missing', async () => {
        const { listPeerSessions, PingPeerError } = await import('./pingPeer')
        const { configuration } = await import('@/configuration')
        const previous = configuration.cliApiToken
        configuration._setCliApiToken('')
        let caught: unknown
        try {
            await listPeerSessions({
                apiUrl: 'http://hub.test',
                accessToken: '   '
            })
        } catch (error) {
            caught = error
        } finally {
            configuration._setCliApiToken(previous)
        }
        expect(caught).toBeInstanceOf(PingPeerError)
        const message = (caught as InstanceType<typeof PingPeerError>).message
        expect(message).toMatch(/auth login/i)
        expect(message).toMatch(/HAPI_API_URL/)
        expect(message).toMatch(/CLI_API_TOKEN|auth login/i)
    })
})

describe('listSessions query params', () => {
    it('listPeerSessions sends limit + order=updatedAt; pingPeer omits limit', async () => {
        const { listPeerSessions, pingPeer } = await import('./pingPeer')
        const listParams: Array<Record<string, unknown> | undefined> = []
        const pingParams: Array<Record<string, unknown> | undefined> = []
        const sessionId = 'zzzzzzzz-9999-9999-9999-999999999999'

        const listHttp = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    listParams.push(config?.params)
                    return {
                        status: 200,
                        data: { sessions: [{ id: sessionId, active: true, updatedAt: 1, metadata: { name: 'Z' } }] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })
        await listPeerSessions({
            apiUrl: 'http://hub.test',
            accessToken: 'tok',
            http: listHttp as never,
            limit: 40
        })
        expect(listParams[0]).toEqual({ limit: 40, order: 'updatedAt' })

        const pingHttp = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(body).toMatchObject({ text: 'hi' })
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions') && !url.includes(sessionId)) {
                    pingParams.push(config?.params)
                    return {
                        status: 200,
                        data: {
                            sessions: Array.from({ length: 501 }, (_, i) => ({
                                id: i === 500 ? sessionId : `${String(i).padStart(8, '0')}-0000-0000-0000-000000000000`,
                                active: true,
                                updatedAt: i,
                                metadata: { name: `S${i}` }
                            }))
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: { session: { id: sessionId, active: true, metadata: { name: 'Target' } } }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })
        const result = await pingPeer({
            sessionIdPrefix: sessionId,
            message: 'hi',
            apiUrl: 'http://hub.test',
            accessToken: 'tok',
            http: pingHttp as never
        })
        expect(result.sessionId).toBe(sessionId)
        expect(pingParams[0]).toBeUndefined()
    })
})


describe('HAPI_DISABLE_PEER_TOOLS kill switch', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS

    beforeEach(() => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
    })

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original
        }
    })

    it('pingPeer refuses before any network call', async () => {
        await expect(pingPeer({ sessionIdPrefix: 'abc', message: 'hi' }))
            .rejects.toMatchObject({ code: 'disabled' })
    })

    it('inspectPeer refuses before any network call', async () => {
        await expect(inspectPeer({ sessionIdPrefix: 'abc' }))
            .rejects.toMatchObject({ code: 'disabled' })
    })

    it('listPeerSessions refuses before any network call', async () => {
        await expect(listPeerSessions()).rejects.toMatchObject({ code: 'disabled' })
    })

    it('maps the disabled code to the usage exit code', () => {
        expect(exitCodeForPingPeerError(new PingPeerError('disabled', 'disabled on this machine'))).toBe(2)
    })
})

describe('hub disablePeerTools preference', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS

    beforeEach(() => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        applyHubPeerToolsDisabled(true)
    })

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original
        }
        resetPeerToolsForTests()
    })

    it('pingPeer refuses before any network call', async () => {
        await expect(pingPeer({ sessionIdPrefix: 'abc', message: 'hi' }))
            .rejects.toMatchObject({ code: 'disabled' })
    })

    it('inspectPeer refuses before any network call', async () => {
        await expect(inspectPeer({ sessionIdPrefix: 'abc' }))
            .rejects.toMatchObject({ code: 'disabled' })
    })

    it('listPeerSessions refuses before any network call', async () => {
        await expect(listPeerSessions()).rejects.toMatchObject({ code: 'disabled' })
    })

    it('mentions the hub administrator in the refusal message', async () => {
        const failure = await pingPeer({ sessionIdPrefix: 'abc', message: 'hi' }).catch((error) => error)
        expect(failure).toMatchObject({ code: 'disabled' })
        expect(String(failure.message)).toContain('hub administrator')
    })
})
