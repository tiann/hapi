import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    PingPeerError,
    formatInspectPeerReport,
    inspectPeer,
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

describe('inspectPeer', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('loads metadata and recent messages without calling resume', async () => {
        const sessionId = '7d55ed21-8a9f-4309-b4f8-30069df36b4b'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: sessionId,
                                active: false,
                                updatedAt: 1_700_000_000_000,
                                metadata: {
                                    name: 'hub runner version governance',
                                    flavor: 'cursor',
                                    path: '/home/heavygee/coding/hapi'
                                }
                            } satisfies PingPeerSessionSummary]
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
                                thinking: false,
                                updatedAt: 1_700_000_000_000,
                                metadata: {
                                    name: 'hub runner version governance',
                                    flavor: 'cursor',
                                    path: '/home/heavygee/coding/hapi',
                                    lifecycleState: 'archived'
                                }
                            }
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 30 })
                    return {
                        status: 200,
                        data: {
                            messages: [
                                {
                                    id: 'm1',
                                    createdAt: 1_700_000_000_100,
                                    content: {
                                        role: 'user',
                                        content: { text: 'status on runner versions?' }
                                    }
                                },
                                {
                                    id: 'm2',
                                    createdAt: 1_700_000_000_200,
                                    content: {
                                        role: 'agent',
                                        content: {
                                            type: 'codex',
                                            data: {
                                                type: 'message',
                                                message: 'Looking into it.'
                                            }
                                        }
                                    }
                                }
                            ],
                            page: { hasMore: false }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await inspectPeer({
            sessionIdPrefix: sessionId,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result.sessionId).toBe(sessionId)
        expect(result.name).toBe('hub runner version governance')
        expect(result.active).toBe(false)
        expect(result.flavor).toBe('cursor')
        expect(result.path).toBe('/home/heavygee/coding/hapi')
        expect(result.messages).toHaveLength(2)
        expect(result.messages[0]).toMatchObject({
            role: 'user',
            text: 'status on runner versions?'
        })
        expect(result.messages[1]?.text).toContain('Looking into it.')

        // Read-only: never resume
        expect(http.post).toHaveBeenCalledTimes(1)
        expect(http.post.mock.calls[0]![0]).toContain('/api/auth')
        expect(http.post.mock.calls.some((call) => String(call[0]).includes('/resume'))).toBe(false)
    })

    it('respects messageLimit and refuses empty prefix', async () => {
        await expect(inspectPeer({
            sessionIdPrefix: '  ',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: createHttpMock({}) as never
        })).rejects.toMatchObject({ code: 'bad_args' } satisfies Partial<PingPeerError>)

        const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'A' } }] }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: { session: { id: sessionId, active: true, metadata: { name: 'A' } } }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 5 })
                    return { status: 200, data: { messages: [], page: {} } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await inspectPeer({
            sessionIdPrefix: 'aaaaaaaa',
            messageLimit: 5,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })
    })

    it('clamps messageLimit to 1..100', async () => {
        const sessionId = 'bbbbbbbb-3333-3333-3333-333333333333'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith('/api/sessions')) {
                    return {
                        status: 200,
                        data: { sessions: [{ id: sessionId, active: true, metadata: { name: 'C' } }] }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}`)) {
                    return {
                        status: 200,
                        data: { session: { id: sessionId, active: true, metadata: { name: 'C' } } }
                    }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/messages`)) {
                    expect(config?.params).toEqual({ limit: 100 })
                    return { status: 200, data: { messages: [], page: {} } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await inspectPeer({
            sessionIdPrefix: sessionId,
            messageLimit: 999,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })
    })
})

describe('formatInspectPeerReport', () => {
    it('includes session id and message snippets for agent consumption', () => {
        const report = formatInspectPeerReport({
            sessionId: '7d55ed21-8a9f-4309-b4f8-30069df36b4b',
            name: 'hub runner version governance',
            active: true,
            thinking: false,
            flavor: 'cursor',
            path: '/tmp/x',
            lifecycleState: null,
            updatedAt: 1_700_000_000_000,
            messages: [
                { id: '1', role: 'user', text: 'hello', createdAt: 1 },
                { id: '2', role: 'agent', text: 'world', createdAt: 2 }
            ]
        })
        expect(report).toContain('7d55ed21-8a9f-4309-b4f8-30069df36b4b')
        expect(report).toContain('hub runner version governance')
        expect(report).toContain('[user] hello')
        expect(report).toContain('[agent] world')
        expect(report).toContain('/sessions/7d55ed21-8a9f-4309-b4f8-30069df36b4b')
    })
})
