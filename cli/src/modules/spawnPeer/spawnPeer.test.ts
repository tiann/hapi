import { resolve } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
    SpawnPeerError,
    exitCodeForSpawnPeerError,
    spawnPeer
} from './spawnPeer'

type MockResponse = {
    status: number
    data: unknown
}

function createHttpMock(handlers: {
    post?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
    get?: (url: string, config?: { params?: Record<string, unknown> }) => MockResponse | Promise<MockResponse>
    patch?: (url: string, body?: unknown) => MockResponse | Promise<MockResponse>
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
        }),
        patch: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.patch) {
                throw new Error(`unexpected PATCH ${url}`)
            }
            return handlers.patch(url, body)
        })
    }
}

const SESSION_ID = 'cccccccc-1111-1111-1111-111111111111'
const MACHINE_ID = 'machine-abc'

function userMessageRow(text: string) {
    return {
        id: 'msg-1',
        createdAt: 1,
        content: { role: 'user', content: { text } }
    }
}

describe('spawnPeer', () => {
    let nowMs: number

    beforeEach(() => {
        nowMs = 1_000_000
    })

    it('rejects an empty remit', async () => {
        await expect(spawnPeer({
            directory: '/tmp/project',
            message: '   ',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test'
        })).rejects.toMatchObject({ code: 'bad_args' })
    })

    it('rejects a missing directory', async () => {
        await expect(spawnPeer({
            directory: '',
            message: 'do the work',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test'
        })).rejects.toMatchObject({ code: 'bad_args' })
    })

    it('rejects a permissionMode the selected agent does not support before spawn', async () => {
        const http = createHttpMock({
            post: (url) => {
                throw new Error(`spawn must not run; unexpected POST ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            agent: 'codex',
            permissionMode: 'bypassPermissions',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })

        expect(http.post).not.toHaveBeenCalled()
    })

    it('rejects a Claude-illegal permissionMode when agent is omitted (hub default)', async () => {
        const http = createHttpMock({
            post: (url) => {
                throw new Error(`spawn must not run; unexpected POST ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            permissionMode: 'yolo',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })

        expect(http.post).not.toHaveBeenCalled()
    })

    it('rejects a name longer than the hub rename max before spawn', async () => {
        const http = createHttpMock({
            post: (url) => {
                throw new Error(`spawn must not run; unexpected POST ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            name: 'n'.repeat(256),
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })

        expect(http.post).not.toHaveBeenCalled()
    })

    it('maps spawn type=error to spawn_failed', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'error', message: 'no runner' } }
                }
                throw new Error(`unexpected POST ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'spawn_failed' })
        expect(http.post).toHaveBeenCalledTimes(2)
    })

    it('maps missing sessionId after spawn HTTP 200 to spawn_failed', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success' } }
                }
                throw new Error(`unexpected POST ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'spawn_failed' })
    })

    it('spawns, renames, delivers remit, and verifies a user message', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        let delivered: unknown
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    delivered = body
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    throw new Error('happy-path spawn must not archive the child')
                }
                throw new Error(`unexpected POST ${url}`)
            },
            patch: (url, body) => {
                expect(url.endsWith(`/api/sessions/${SESSION_ID}`)).toBe(true)
                expect(body).toEqual({ name: 'Peer #1509: spawn-peer remit' })
                return { status: 200, data: { ok: true } }
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(SESSION_ID)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Peer #1509: spawn-peer remit', flavor: 'cursor' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Peer #1509: spawn-peer remit', flavor: 'cursor' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('do the work')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await spawnPeer({
            directory: '/home/u/coding/hapi/worktrees/spawn-peer-remit',
            message: 'do the work',
            name: 'Peer #1509: spawn-peer remit',
            agent: 'cursor',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result).toEqual({
            sessionId: SESSION_ID,
            name: 'Peer #1509: spawn-peer remit'
        })
        expect(spawnedBody).toMatchObject({
            directory: '/home/u/coding/hapi/worktrees/spawn-peer-remit',
            agent: 'cursor',
            permissionMode: 'yolo',
            sessionType: 'simple'
        })
        expect(spawnedBody).not.toHaveProperty('message')
        expect(spawnedBody).not.toHaveProperty('prompt')
        expect(spawnedBody).not.toHaveProperty('text')
        expect(spawnedBody).not.toHaveProperty('yolo')
        expect(spawnedBody).toHaveProperty('permissionMode', 'yolo')
        expect(delivered).toEqual({ text: 'do the work' })
        expect(http.patch).toHaveBeenCalledTimes(1)
    })

    it('waits for a freshly spawned inactive session without posting /resume', async () => {
        let resumeCalls = 0
        let sessionGets = 0
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/resume`)) {
                    resumeCalls += 1
                    throw new Error('spawn-peer must not resume a just-spawned child')
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    sessionGets += 1
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: sessionGets >= 3,
                                metadata: { name: 'Fresh', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 10,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })

        expect(resumeCalls).toBe(0)
    })

    it('resolves a relative directory in the caller before the spawn POST', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Rel', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: 'relative-peer-dir',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody?.directory).toBe(resolve('relative-peer-dir'))
    })

    it('archives the child when ping-peer delivery throws after spawn', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return { status: 404, data: { error: 'missing' } }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 404, data: { error: 'missing' } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({ code: 'not_found' })

        expect(http.post).toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            {},
            expect.anything()
        )
    })

    it('keeps the child when ping-peer throws but the remit is already in the transcript', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    throw new Error('socket hang up after hub accepted the remit')
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    throw new Error('must not archive a child that already has the remit')
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Kept', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result).toEqual({ sessionId: SESSION_ID, name: SESSION_ID.slice(0, 8) })
    })

    it('does not report a requested name when rename failed and ping-peer threw', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    throw new Error('socket hang up after hub accepted the remit')
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    throw new Error('must not archive a child that already has the remit')
                }
                throw new Error(`unexpected POST ${url}`)
            },
            patch: () => ({ status: 409, data: { error: 'rename rejected' } }),
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Untitled', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            name: 'Peer that was never renamed',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(result.name).toBe(SESSION_ID.slice(0, 8))
        expect(result.name).not.toBe('Peer that was never renamed')
    })

    it('retries a thrown transcript GET and still archives if it never succeeds', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Empty', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    throw new Error('temporary hub disconnect')
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'this remit must land',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({ code: 'empty_session' })

        expect(http.post).toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            {},
            expect.anything()
        )
    })

    it('retries a thrown transcript GET then succeeds when the remit appears', async () => {
        let messageGets = 0
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    throw new Error('must not archive after remit is visible')
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Recovered', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    messageGets += 1
                    if (messageGets === 1) {
                        throw new Error('temporary hub disconnect')
                    }
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 10,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })

        expect(result.sessionId).toBe(SESSION_ID)
        expect(messageGets).toBeGreaterThan(1)
    })

    it('fails closed when spawn+send succeed but the session still has no user message', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(SESSION_ID)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Empty', flavor: 'claude' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Empty', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { messages: [] } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'this remit must land',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({ code: 'empty_session' })

        expect(http.post).toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            {},
            expect.anything()
        )
    })

    it('does not claim archive succeeded when the archive POST fails', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    return { status: 500, data: { error: 'rpc failed' } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Empty', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'this remit must land',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({
            code: 'empty_session',
            message: expect.stringMatching(/archive failed[\s\S]*still be running/i)
        })
    })

    it('applies hub peerSpawnDefaults when explicit args are omitted', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/hub-settings')) {
                    return {
                        status: 200,
                        data: {
                            sessionSummaryContract: false,
                            peerSpawnDefaults: {
                                agent: 'codex',
                                permissionMode: 'read-only',
                                models: { codex: 'gpt-5' }
                            }
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Hub defaults', flavor: 'codex' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody).toMatchObject({
            agent: 'codex',
            permissionMode: 'read-only',
            model: 'gpt-5'
        })
    })

    it('forwards explicit model and effort overrides', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Named', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            agent: 'claude',
            model: 'opus',
            effort: 'high',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody).toMatchObject({
            agent: 'claude',
            model: 'opus',
            effort: 'high'
        })
    })

    it('passes an explicit permissionMode and does not clone yolo', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/sessions') && !url.includes(SESSION_ID)) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Named', flavor: 'claude' }
                            }]
                        }
                    }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Named', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'brief',
            permissionMode: 'default',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody).toMatchObject({
            directory: '/tmp/project',
            agent: 'claude',
            sessionType: 'simple',
            permissionMode: 'default',
            model: 'sonnet'
        })
        expect(spawnedBody).not.toHaveProperty('yolo')
    })

    it('does not treat a different user message as a landed remit', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Other', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('some other prompt')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'the actual remit',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({ code: 'empty_session' })
    })

    it('forwards an explicit worktree sessionType', async () => {
        let spawnedBody: Record<string, unknown> | undefined
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    spawnedBody = body as Record<string, unknown>
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { ok: true } }
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'WT', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: { messages: [userMessageRow('brief')] }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/repo',
            message: 'brief',
            sessionType: 'worktree',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })
        expect(spawnedBody).toMatchObject({ sessionType: 'worktree' })
    })

    it('maps exit codes', () => {
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('spawn_failed', 'x'))).toBe(3)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('empty_session', 'x'))).toBe(4)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('send_failed', 'x'))).toBe(4)
    })
})
