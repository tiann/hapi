import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PingPeerError,
    exitCodeForPingPeerError,
    pingPeer,
    resolveSessionByPrefix,
    type PingPeerSessionSummary
} from './pingPeer'

type MockResponse = {
    status: number
    data: unknown
}

function createHttpMock(handlers: {
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get?: (url: string) => MockResponse | Promise<MockResponse>
}) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.post) {
                throw new Error(`unexpected POST ${url}`)
            }
            return handlers.post(url, body)
        }),
        get: vi.fn(async (url: string) => {
            if (!handlers.get) {
                throw new Error(`unexpected GET ${url}`)
            }
            return handlers.get(url)
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
                    expect(body).toEqual({ text: 'hello peer' })
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

        expect(result).toEqual({
            sessionId,
            name: 'Orchestrator',
            resumed: false
        })
        expect(http.post).toHaveBeenCalledTimes(2)
    })

    it('resumes an inactive session, waits for active, then sends', async () => {
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
