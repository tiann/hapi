import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    ArchivePeerError,
    archivePeer,
    exitCodeForArchivePeerError
} from './archivePeer'

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

describe('archivePeer', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('archives an active Peer Done session via POST /archive (no hand JWT)', async () => {
        const sessionId = '05d9f0f2-9273-4137-933c-07459a1146a2'
        const posts: string[] = []
        const http = createHttpMock({
            post: (url, body) => {
                posts.push(url)
                if (url.endsWith('/api/auth')) {
                    expect(body).toEqual({ accessToken: 'tok' })
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/archive`)) {
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
                                thinking: false,
                                metadata: { name: 'Peer Done Worker', flavor: 'cursor' }
                            }]
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await archivePeer({
            sessionIdPrefix: '05d9f0f2',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result).toEqual({
            sessionId,
            name: 'Peer Done Worker',
            alreadyArchived: false
        })
        expect(posts.some((url) => url.endsWith(`/api/sessions/${sessionId}/archive`))).toBe(true)
    })

    it('treats alreadyArchived as success (idempotent)', async () => {
        const sessionId = 'aaaaaaaa-1111-1111-1111-111111111111'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/archive`)) {
                    return { status: 200, data: { ok: true, alreadyArchived: true } }
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
                                active: false,
                                metadata: {
                                    name: 'Old Peer',
                                    lifecycleState: 'archived'
                                }
                            }]
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await archivePeer({
            sessionIdPrefix: sessionId,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result.alreadyArchived).toBe(true)
        expect(result.sessionId).toBe(sessionId)
    })

    it('refuses when the hub says the process is still running (WORKING peer)', async () => {
        const sessionId = 'bbbbbbbb-3333-3333-3333-333333333333'
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/sessions/${sessionId}/archive`)) {
                    return {
                        status: 409,
                        data: { error: 'Session process is still running and could not be stopped' }
                    }
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
                                thinking: true,
                                metadata: { name: 'Working Peer' }
                            }]
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(archivePeer({
            sessionIdPrefix: 'bbbb',
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({
            code: 'archive_failed',
            message: expect.stringMatching(/still running/)
        })
    })

    it('maps error codes to exit codes', () => {
        expect(exitCodeForArchivePeerError(new ArchivePeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForArchivePeerError(new ArchivePeerError('not_found', 'x'))).toBe(2)
        expect(exitCodeForArchivePeerError(new ArchivePeerError('archive_failed', 'x'))).toBe(4)
    })
})
