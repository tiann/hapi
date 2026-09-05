import { describe, expect, it, vi } from 'vitest'
import { SpawnPeerError, exitCodeForSpawnPeerError, listMachineTargets, spawnPeer } from './spawnPeer'

const SESSION_ID = '05d9f0f2-9273-4137-933c-07459a1146a2'
const MACHINE_ID = 'runner-2'

function createHttpMock(
    handler: (url: string, body?: unknown) => { status: number; data: unknown },
    get?: (url: string) => { status: number; data: unknown }
) {
    return {
        post: vi.fn(async (url: string, body?: unknown) => handler(url, body)),
        get: vi.fn(async (url: string) => {
            if (!get) throw new Error(`unexpected GET ${url}`)
            return get(url)
        })
    }
}

describe('spawnPeer', () => {
    it.each([
        { directory: '', message: 'work' },
        { directory: '/tmp/project', message: '   ' }
    ])('rejects incomplete input before authentication', async (input) => {
        const http = createHttpMock(() => { throw new Error('must not call HTTP') })
        await expect(spawnPeer({
            ...input,
            machineId: MACHINE_ID,
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })
        expect(http.post).not.toHaveBeenCalled()
    })

    it('uses the hub atomic endpoint and preserves a remote runner path', async () => {
        let request: Record<string, unknown> | undefined
        const http = createHttpMock((url, body) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            expect(url).toBe(`http://hub.test/api/machines/${MACHINE_ID}/spawn-with-remit`)
            request = body as Record<string, unknown>
            return {
                status: 200,
                data: {
                    type: 'success',
                    sessionId: SESSION_ID,
                    remitId: request.remitId,
                    name: 'Worker',
                    session: {
                        machineId: MACHINE_ID,
                        directory: '/runner/path',
                        agent: 'codex',
                        model: 'gpt-5',
                        modelReasoningEffort: 'high',
                        effort: null,
                        permissionMode: 'safe-yolo'
                    }
                }
            }
        })

        const result = await spawnPeer({
            directory: '/runner/path',
            message: 'implement issue',
            name: 'Worker',
            agent: 'codex',
            model: 'gpt-5',
            effort: 'high',
            permissionMode: 'safe-yolo',
            machineId: MACHINE_ID,
            waitActiveSecs: 30,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })

        expect(request).toMatchObject({
            directory: '/runner/path',
            message: 'implement issue',
            name: 'Worker',
            agent: 'codex',
            model: 'gpt-5',
            modelReasoningEffort: 'high',
            permissionMode: 'safe-yolo',
            waitActiveSecs: 30
        })
        expect(request?.remitId).toMatch(/^[0-9a-f-]{36}$/)
        expect(result).toMatchObject({
            sessionId: SESSION_ID,
            remitId: request?.remitId,
            machineId: MACHINE_ID,
            agent: 'codex',
            directory: '/runner/path',
            name: 'Worker',
            session: expect.objectContaining({ machineId: MACHINE_ID, agent: 'codex' })
        })
        expect(http.post).toHaveBeenCalledTimes(2)
    })

    it.each([
        ['opencode', 'modelReasoningEffort'],
        ['claude', 'effort'],
        ['grok', 'effort'],
        ['pi', 'effort'],
        ['agy', 'effort']
    ] as const)('maps --effort to the %s runner field', async (agent, field) => {
        let request: Record<string, unknown> | undefined
        const http = createHttpMock((url, body) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            request = body as Record<string, unknown>
            return {
                status: 200,
                data: {
                    type: 'success',
                    sessionId: SESSION_ID,
                    remitId: request.remitId,
                    session: {
                        machineId: MACHINE_ID,
                        directory: '/runner/path',
                        agent,
                        model: null,
                        modelReasoningEffort: field === 'modelReasoningEffort' ? 'high' : null,
                        effort: field === 'effort' ? 'high' : null,
                        permissionMode: null
                    }
                }
            }
        })

        await spawnPeer({
            directory: '/runner/path',
            message: 'implement issue',
            agent,
            effort: 'high',
            machineId: MACHINE_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })

        expect(request?.[field]).toBe('high')
        expect(request?.[field === 'effort' ? 'modelReasoningEffort' : 'effort']).toBeUndefined()
    })

    it.each(['cursor', 'dsh', 'copilot', 'kimi'] as const)(
        'rejects --effort for unsupported %s sessions before authentication',
        async (agent) => {
            const http = createHttpMock(() => { throw new Error('must not call HTTP') })
            await expect(spawnPeer({
                directory: '/runner/path',
                message: 'implement issue',
                agent,
                effort: 'high',
                machineId: MACHINE_ID,
                apiUrl: 'http://hub.test',
                accessToken: 'token',
                http: http as never
            })).rejects.toMatchObject({ code: 'bad_args' })
            expect(http.post).not.toHaveBeenCalled()
        }
    )

    it('retries an ambiguous transport failure with the same remit id', async () => {
        const bodies: Array<Record<string, unknown>> = []
        let spawnAttempts = 0
        const http = createHttpMock((url, body) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            bodies.push(body as Record<string, unknown>)
            spawnAttempts += 1
            if (spawnAttempts === 1) throw new Error('socket reset')
            return {
                status: 200,
                data: {
                    type: 'success',
                    sessionId: SESSION_ID,
                    remitId: bodies[0]?.remitId,
                    name: 'Worker',
                    session: {
                        machineId: MACHINE_ID,
                        directory: '/runner/project',
                        agent: 'codex',
                        model: null,
                        modelReasoningEffort: null,
                        effort: null,
                        permissionMode: null
                    }
                }
            }
        })

        await expect(spawnPeer({
            directory: '/runner/project',
            message: 'work',
            agent: 'codex',
            remitId: '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c',
            machineId: MACHINE_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toMatchObject({ sessionId: SESSION_ID })
        expect(bodies).toHaveLength(2)
        expect(bodies[1]).toEqual(bodies[0])
        expect(bodies[0]?.remitId).toBe('7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c')
    })

    it('returns the generated remit id when both spawn responses are lost', async () => {
        const bodies: Array<Record<string, unknown>> = []
        const http = createHttpMock((url, body) => {
            if (url.endsWith('/api/auth')) return { status: 200, data: { token: 'jwt' } }
            bodies.push(body as Record<string, unknown>)
            throw new Error('socket reset')
        })

        await expect(spawnPeer({
            directory: '/runner/project',
            message: 'work',
            machineId: MACHINE_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({
            code: 'spawn_failed',
            remitId: expect.stringMatching(/^[0-9a-f-]{36}$/)
        })
        expect(bodies).toHaveLength(2)
        expect(bodies[1]?.remitId).toBe(bodies[0]?.remitId)
    })

    it('fails closed when the hub reports an uncleaned child', async () => {
        const remitId = '7ee03698-0fe7-4f76-b8a8-d84f4eddbf5c'
        const http = createHttpMock((url) => url.endsWith('/api/auth')
            ? { status: 200, data: { token: 'jwt' } }
            : {
                status: 502,
                data: {
                    type: 'error',
                    message: 'delivery failed',
                    childSessionId: SESSION_ID,
                    cleanedUp: false
                }
            })

        await expect(spawnPeer({
            directory: '/runner/project',
            message: 'work',
            machineId: MACHINE_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            remitId,
            http: http as never
        })).rejects.toMatchObject({ code: 'cleanup_failed', remitId })
    })

    it('uses stable exit codes', () => {
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('bad_args', 'x'))).toBe(2)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('spawn_failed', 'x'))).toBe(3)
        expect(exitCodeForSpawnPeerError(new SpawnPeerError('cleanup_failed', 'x'))).toBe(5)
    })

    it('lists runner ids and workspace roots and resolves only exact ids', async () => {
        const http = createHttpMock(
            (url) => url.endsWith('/api/auth')
                ? { status: 200, data: { token: 'jwt' } }
                : { status: 500, data: {} },
            () => ({
                status: 200,
                data: {
                    machines: [{
                        id: MACHINE_ID,
                        active: true,
                        metadata: {
                            host: 'runner.example',
                            displayName: 'Build runner',
                            homeDir: '/home/runner',
                            workspaceRoots: ['/workspace']
                        }
                    }]
                }
            })
        )

        await expect(listMachineTargets({
            machineId: MACHINE_ID,
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).resolves.toEqual([{
            id: MACHINE_ID,
            active: true,
            host: 'runner.example',
            displayName: 'Build runner',
            homeDir: '/home/runner',
            workspaceRoots: ['/workspace']
        }])
        await expect(listMachineTargets({
            machineId: 'runner',
            apiUrl: 'http://hub.test',
            accessToken: 'token',
            http: http as never
        })).rejects.toMatchObject({ code: 'bad_args' })
    })
})
