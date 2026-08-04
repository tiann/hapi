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
