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

const SESSION_ID = 'cccccccc-1111-1111-1111-111111111111'
const MACHINE_ID = 'machine-abc'

const STOCK_RESOLVED_HUB_DEFAULTS = {
    agent: 'claude' as const,
    permissionMode: 'bypassPermissions' as const,
    models: { claude: 'sonnet' }
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
            if (handlers.get) {
                try {
                    return await handlers.get(url, config)
                } catch (error) {
                    if (typeof url === 'string' && url.endsWith('/api/hub-settings')) {
                        return {
                            status: 200,
                            data: {
                                sessionSummaryContract: false,
                                sessionSummaryInChat: false,
                                peerSpawnDefaults: STOCK_RESOLVED_HUB_DEFAULTS
                            }
                        }
                    }
                    throw error
                }
            }
            if (typeof url === 'string' && url.endsWith('/api/hub-settings')) {
                return {
                    status: 200,
                    data: {
                        sessionSummaryContract: false,
                        sessionSummaryInChat: false,
                        peerSpawnDefaults: STOCK_RESOLVED_HUB_DEFAULTS
                    }
                }
            }
            throw new Error(`unexpected GET ${url}`)
        }),
        patch: vi.fn(async (url: string, body?: unknown) => {
            if (!handlers.patch) {
                throw new Error(`unexpected PATCH ${url}`)
            }
            return handlers.patch(url, body)
        })
    }
}
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
        // Unit tests must not inherit the wrapping HAPI session identity.
        delete process.env.HAPI_SESSION_ID
        delete process.env.HAPI_SESSION_NAME
        delete process.env.HAPI_AGENT_SESSION_ID
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

    it('rejects a blank remit even when a Parent stamp would otherwise fill it', async () => {
        // Regression: ensureParentStamp used to turn '' into "## Parent\n..." so the
        // post-stamp emptiness check passed and idle sessions could be created.
        process.env.HAPI_SESSION_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
        process.env.HAPI_SESSION_NAME = 'Parent'
        await expect(spawnPeer({
            directory: '/tmp/project',
            message: '   ',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test'
        })).rejects.toMatchObject({
            code: 'bad_args',
            message: expect.stringMatching(/empty remit/i),
        })
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
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
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
            http: http as never,
            hubPeerSpawnDefaults: null
        })).rejects.toMatchObject({ code: 'bad_args' })

        expect(http.post).toHaveBeenCalledTimes(1)
    })

    it('accepts read-only when agent is omitted and hub default is Codex', async () => {
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
                            peerSpawnDefaults: {
                                agent: 'codex',
                                permissionMode: 'yolo',
                                models: {}
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { messages: [userMessageRow('do the work')] } }
                }
                if (url.includes('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{ id: SESSION_ID, active: true, metadata: { flavor: 'codex' } }],
                            session: { id: SESSION_ID, active: true, metadata: { flavor: 'codex' } }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            permissionMode: 'read-only',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody).toMatchObject({
            agent: 'codex',
            permissionMode: 'read-only'
        })
    })

    it('rejects plan when agent is omitted and hub default is Codex', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`spawn must not run; unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/hub-settings')) {
                    return {
                        status: 200,
                        data: {
                            peerSpawnDefaults: {
                                agent: 'codex',
                                permissionMode: 'yolo',
                                models: {}
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            permissionMode: 'plan',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })
    })

    it('aborts when hub spawn defaults cannot be loaded', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                throw new Error(`spawn must not run; unexpected POST ${url}`)
            },
            get: (url) => {
                if (url.endsWith('/api/hub-settings')) {
                    return { status: 500, data: { error: 'boom' } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })).rejects.toMatchObject({
            code: 'spawn_failed',
            message: expect.stringMatching(/hub spawn defaults/i)
        })
        expect(http.post).toHaveBeenCalledTimes(1)
    })


    it('omits permissionMode for pi (empty launch catalog)', async () => {
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
                                metadata: { flavor: 'pi' }
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
                                metadata: { flavor: 'pi' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { messages: [userMessageRow('do the work')] } }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            agent: 'pi',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never,
            hubPeerSpawnDefaults: null,
            waitActiveSecs: 1,
            now: () => nowMs,
            sleep: async () => { nowMs += 500 }
        })

        expect(spawnedBody?.agent).toBe('pi')
        expect(spawnedBody).not.toHaveProperty('permissionMode')
    })

it('resolves relative directory against cwd (MCP session working directory)', async () => {
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
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return { status: 200, data: { messages: [userMessageRow('do the work')] } }
                }
                if (url.includes('/api/sessions')) {
                    return {
                        status: 200,
                        data: {
                            sessions: [{ id: SESSION_ID, active: true, metadata: { flavor: 'claude' } }],
                            session: { id: SESSION_ID, active: true, metadata: { flavor: 'claude' } }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '.',
            cwd: '/repo-b',
            message: 'do the work',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never,
            hubPeerSpawnDefaults: null
        })

        expect(spawnedBody?.directory).toBe('/repo-b')
    })

    it('rejects a Claude-illegal permissionMode when agent is omitted (hub default Claude)', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
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
            http: http as never,
            hubPeerSpawnDefaults: {
                agent: 'claude',
                permissionMode: 'bypassPermissions',
                models: { claude: 'sonnet' }
            }
        })).rejects.toMatchObject({ code: 'bad_args' })

        expect(http.post).toHaveBeenCalledTimes(1)
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

    it('does not archive when ping-peer delivery throws and transcript cannot be verified', async () => {
        const http = createHttpMock({
            post: (url) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/archive`)) {
                    throw new Error('must not archive when transcript verification is unavailable')
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
        })).rejects.toMatchObject({ code: 'verify_failed' })

        expect(http.post).not.toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            expect.anything(),
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

    it('retries a thrown transcript GET and does not archive when verification never succeeds', async () => {
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
                    throw new Error('must not archive when transcript verification failed')
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
        })).rejects.toMatchObject({
            code: 'verify_failed',
            message: expect.stringMatching(new RegExp(`left child running[\\s\\S]*${SESSION_ID}`, 'i'))
        })

        expect(http.post).not.toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            expect.anything(),
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

    it('does not archive when transcript pagination is exhausted while hasMore stays true', async () => {
        // Cap is 40 pages; if every page says hasMore, remit may still exist older.
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
                    throw new Error('must not archive when pagination is inconclusive')
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
                                metadata: { name: 'Busy', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    messageGets += 1
                    return {
                        status: 200,
                        data: {
                            messages: [{
                                content: {
                                    role: 'user',
                                    content: [{ type: 'text', text: 'unrelated noise' }]
                                }
                            }],
                            page: {
                                hasMore: true,
                                nextBeforeAt: 1_000_000 - messageGets,
                                nextBeforeSeq: messageGets
                            }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'this remit is buried past the page cap',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            waitActiveSecs: 2,
            http: http as never,
            now: () => nowMs,
            sleep: async (ms) => {
                nowMs += ms
            }
        })).rejects.toMatchObject({ code: 'verify_failed' })

        expect(messageGets).toBeGreaterThanOrEqual(40)
        expect(http.post).not.toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            expect.anything(),
            expect.anything()
        )
    })

    it('finds the remit on an older messages page instead of archiving', async () => {
        const messageGets: Array<Record<string, unknown> | undefined> = []
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
                    throw new Error('must not archive when remit is on an older page')
                }
                throw new Error(`unexpected POST ${url}`)
            },
            get: (url, config) => {
                if (url.endsWith(`/api/sessions/${SESSION_ID}`)) {
                    return {
                        status: 200,
                        data: {
                            session: {
                                id: SESSION_ID,
                                active: true,
                                metadata: { name: 'Busy child', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    messageGets.push(config?.params)
                    if (!config?.params?.beforeAt) {
                        return {
                            status: 200,
                            data: {
                                messages: [userMessageRow('later assistant chatter')],
                                page: {
                                    hasMore: true,
                                    nextBeforeAt: 1_700_000_000_000,
                                    nextBeforeSeq: 10
                                }
                            }
                        }
                    }
                    expect(config.params).toMatchObject({
                        beforeAt: 1_700_000_000_000,
                        beforeSeq: 10,
                        limit: 50
                    })
                    return {
                        status: 200,
                        data: {
                            messages: [userMessageRow('do the work')],
                            page: { hasMore: false }
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        const result = await spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
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
        expect(messageGets.length).toBeGreaterThanOrEqual(2)
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
                    throw new Error('must not auto-archive on empty remit')
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
        })).rejects.toMatchObject({
            code: 'empty_session',
            message: expect.stringMatching(new RegExp(`left child running[\\s\\S]*${SESSION_ID}`, 'i'))
        })

        expect(http.post).not.toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            expect.anything(),
            expect.anything()
        )
    })

    it('reports verify_failed when transcript becomes unavailable after an empty read', async () => {
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
                    throw new Error('must not auto-archive when verify is unavailable')
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
                                metadata: { name: 'Unread', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    messageGets += 1
                    if (messageGets === 1) {
                        return { status: 200, data: { messages: [] } }
                    }
                    return { status: 503, data: { error: 'hub unavailable' } }
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
            code: 'verify_failed',
            message: expect.stringMatching(/transcript unread/i)
        })

        expect(messageGets).toBeGreaterThanOrEqual(2)
        expect(http.post).not.toHaveBeenCalledWith(
            `http://hub.test/api/sessions/${SESSION_ID}/archive`,
            expect.anything(),
            expect.anything()
        )
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

    it('maps Codex and OpenCode effort overrides to modelReasoningEffort', async () => {
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
                                metadata: { name: 'Named', flavor: 'codex' }
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
            agent: 'codex',
            effort: 'high',
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never
        })

        expect(spawnedBody).toMatchObject({
            agent: 'codex',
            modelReasoningEffort: 'high'
        })
        expect(spawnedBody).not.toHaveProperty('effort')
    })

    it('treats permissionMode default as omit so stock yolo (bypassPermissions) wins', async () => {
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
            permissionMode: 'bypassPermissions',
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
                    throw new Error('must not auto-archive when remit mismatch')
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

    it('stamps a durable Parent chip onto the remit before delivery', async () => {
        const PARENT_ID = '4bd4d2b9-e114-4e03-af4c-03e9e4f7439e'
        let deliveredText = ''
        const http = createHttpMock({
            post: (url, body) => {
                if (url.endsWith('/api/auth')) {
                    return { status: 200, data: { token: 'jwt' } }
                }
                if (url.endsWith(`/api/machines/${MACHINE_ID}/spawn`)) {
                    return { status: 200, data: { type: 'success', sessionId: SESSION_ID } }
                }
                if (url.endsWith(`/api/sessions/${SESSION_ID}/messages`)) {
                    deliveredText = String((body as { text?: string }).text ?? '')
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
                                metadata: { name: 'Child', flavor: 'claude' }
                            }
                        }
                    }
                }
                if (url.includes(`/api/sessions/${SESSION_ID}/messages`)) {
                    return {
                        status: 200,
                        data: {
                            messages: [userMessageRow(deliveredText)]
                        }
                    }
                }
                throw new Error(`unexpected GET ${url}`)
            }
        })

        await spawnPeer({
            directory: '/tmp/project',
            message: 'Own steps: implement P0',
            parent: {
                sessionId: PARENT_ID,
                name: 'Producer',
                agentSessionId: 'cursor-agent-xyz',
            },
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
            http: http as never,
        })

        expect(deliveredText).toContain(`## Parent`)
        expect(deliveredText).toContain(`[Producer](/sessions/${PARENT_ID})`)
        expect(deliveredText).toContain('agentSessionId: `cursor-agent-xyz`')
        expect(deliveredText).toContain('Own steps: implement P0')
    })

    it('fail-closes in-session spawn when requireParent and parent id is missing', async () => {
        await expect(spawnPeer({
            directory: '/tmp/project',
            message: 'do the work',
            requireParent: true,
            parent: null,
            machineId: MACHINE_ID,
            accessToken: 'tok',
            apiUrl: 'http://hub.test',
        })).rejects.toMatchObject({
            code: 'bad_args',
            message: expect.stringMatching(/parent session id/i),
        })
    })

    it('maps exit codes', () => {
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('spawn_failed', 'x'))).toBe(3)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('empty_session', 'x'))).toBe(4)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('verify_failed', 'x'))).toBe(4)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('send_failed', 'x'))).toBe(4)
    })
})
