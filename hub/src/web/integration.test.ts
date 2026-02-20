import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'

import { createConfiguration, _resetConfigurationForTesting } from '../configuration'
import { Store } from '../store'
import { SyncEngine } from '../sync/syncEngine'
import { createAuthMiddleware, type WebAppEnv } from './middleware/auth'
import { createAuthRoutes } from './routes/auth'
import { createCliRoutes } from './routes/cli'
import { createGitRoutes } from './routes/git'
import { createMachinesRoutes } from './routes/machines'
import { createSessionsRoutes } from './routes/sessions'

const CLI_TOKEN = 'integration-cli-token'
const JWT_SECRET = new TextEncoder().encode('integration-jwt-secret')

type RpcHandler = (params: unknown) => unknown | Promise<unknown>

type RpcPayload = {
    method: string
    params: string
}

class FakeRpcSocket {
    readonly id: string
    private readonly handlers: Map<string, RpcHandler>

    constructor(id: string, handlers: Map<string, RpcHandler>) {
        this.id = id
        this.handlers = handlers
    }

    timeout(_ms: number): { emitWithAck: (_event: string, payload: RpcPayload) => Promise<unknown> } {
        return {
            emitWithAck: async (_event: string, payload: RpcPayload): Promise<unknown> => {
                const handler = this.handlers.get(payload.method)
                if (!handler) {
                    throw new Error(`RPC handler not registered: ${payload.method}`)
                }

                const parsedParams = JSON.parse(payload.params) as unknown
                return await handler(parsedParams)
            }
        }
    }
}

class FakeCliNamespace {
    readonly sockets: Map<string, FakeRpcSocket> = new Map()
    readonly broadcasts: Array<{ room: string; event: string; payload: unknown }> = []

    to(room: string): { emit: (event: string, payload: unknown) => void } {
        return {
            emit: (event: string, payload: unknown): void => {
                this.broadcasts.push({ room, event, payload })
            }
        }
    }
}

class FakeIo {
    readonly cliNamespace = new FakeCliNamespace()

    of(namespace: string): FakeCliNamespace {
        if (namespace !== '/cli') {
            throw new Error(`Unexpected namespace: ${namespace}`)
        }
        return this.cliNamespace
    }
}

class FakeRpcRegistry {
    private readonly methodToSocketId: Map<string, string> = new Map()

    register(method: string, socketId: string): void {
        this.methodToSocketId.set(method, socketId)
    }

    getSocketIdForMethod(method: string): string | null {
        return this.methodToSocketId.get(method) ?? null
    }
}

type TestContext = {
    app: Hono<WebAppEnv>
    engine: SyncEngine
    store: Store
    registerRpc: (method: string, handler: RpcHandler) => void
    stop: () => void
}

function createTestContext(): TestContext {
    const store = new Store(':memory:')

    const rpcHandlers = new Map<string, RpcHandler>()
    const io = new FakeIo()
    const rpcRegistry = new FakeRpcRegistry()
    const rpcSocket = new FakeRpcSocket('rpc-socket', rpcHandlers)
    io.cliNamespace.sockets.set(rpcSocket.id, rpcSocket)

    const sseStub = {
        broadcast: (_event: unknown): void => {
        }
    }

    const engine = new SyncEngine(store, io as never, rpcRegistry as never, sseStub as never)

    const app = new Hono<WebAppEnv>()
    app.route('/cli', createCliRoutes(() => engine))
    app.route('/api', createAuthRoutes(JWT_SECRET, store))
    app.use('/api/*', createAuthMiddleware(JWT_SECRET))
    app.route('/api', createSessionsRoutes(() => engine))
    app.route('/api', createMachinesRoutes(() => engine))
    app.route('/api', createGitRoutes(() => engine))

    return {
        app,
        engine,
        store,
        registerRpc: (method: string, handler: RpcHandler): void => {
            rpcHandlers.set(method, handler)
            rpcRegistry.register(method, rpcSocket.id)
        },
        stop: (): void => {
            engine.stop()
        }
    }
}

async function getAccessToken(app: Hono<WebAppEnv>, namespace: string): Promise<string> {
    const response = await app.request('/api/auth', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: `${CLI_TOKEN}:${namespace}` })
    })

    expect(response.status).toBe(200)
    const payload = await response.json() as { token: string }
    expect(typeof payload.token).toBe('string')
    return payload.token
}

function authHeaders(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`
    }
}

function authJsonHeaders(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    }
}

function cliHeaders(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`
    }
}

function cliJsonHeaders(token: string): Record<string, string> {
    return {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json'
    }
}

let tempConfigDir = ''

beforeAll(async () => {
    tempConfigDir = mkdtempSync(join(tmpdir(), 'hapi-web-integration-'))
    process.env.HAPI_HOME = tempConfigDir
    process.env.CLI_API_TOKEN = CLI_TOKEN
    _resetConfigurationForTesting()
    await createConfiguration()
})

afterAll(() => {
    _resetConfigurationForTesting()
    if (tempConfigDir) {
        rmSync(tempConfigDir, { recursive: true, force: true })
    }
})

describe('web integration routes', () => {
    it('/api/auth supports access tokens and rejects invalid tokens', async () => {
        const ctx = createTestContext()

        try {
            const success = await ctx.app.request('/api/auth', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ accessToken: `${CLI_TOKEN}:alpha` })
            })
            expect(success.status).toBe(200)

            const successBody = await success.json() as {
                token: string
                user: {
                    id: number
                    firstName: string
                }
            }
            expect(typeof successBody.token).toBe('string')
            expect(successBody.user.firstName).toBe('Web User')

            const invalid = await ctx.app.request('/api/auth', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ accessToken: 'wrong-token:alpha' })
            })
            expect(invalid.status).toBe(401)
            expect(await invalid.json()).toEqual({ error: 'Invalid access token' })
        } finally {
            ctx.stop()
        }
    })

    it('lists sessions for the authenticated namespace', async () => {
        const ctx = createTestContext()

        try {
            const alphaSession = ctx.engine.getOrCreateSession('alpha-tag', { path: '/alpha', host: 'alpha-host' }, null, 'alpha')
            const alphaSecond = ctx.engine.getOrCreateSession('alpha-tag-2', { path: '/alpha-2', host: 'alpha-host' }, null, 'alpha')
            const alphaUnordered = ctx.engine.getOrCreateSession('alpha-tag-3', { path: '/alpha-3', host: 'alpha-host' }, null, 'alpha')
            const betaSession = ctx.engine.getOrCreateSession('beta-tag', { path: '/beta', host: 'beta-host' }, null, 'beta')
            await ctx.engine.updateSessionSortOrder(alphaSecond.id, 'a0')
            await ctx.engine.updateSessionSortOrder(alphaSession.id, 'a0')
            ctx.store.sessions.updateSessionSortOrder(alphaUnordered.id, null, 'alpha')
            ctx.engine.handleRealtimeEvent({ type: 'session-updated', sessionId: alphaUnordered.id } as any)

            const alphaToken = await getAccessToken(ctx.app, 'alpha')

            const response = await ctx.app.request('/api/sessions', {
                headers: authHeaders(alphaToken)
            })
            expect(response.status).toBe(200)

            const body = await response.json() as { sessions: Array<{ id: string }> }
            const ids = body.sessions.map((session) => session.id)
            expect(ids).toContain(alphaSession.id)
            expect(ids).toContain(alphaSecond.id)
            expect(ids).toContain(alphaUnordered.id)
            expect(ids).not.toContain(betaSession.id)
            expect(ids.slice(0, 2)).toEqual([alphaSession.id, alphaSecond.id].sort())
            expect(ids[ids.length - 1]).toBe(alphaUnordered.id)
        } finally {
            ctx.stop()
        }
    })

    it('handles session patch updates and delete conflicts', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const renameOk = ctx.engine.getOrCreateSession(
                'rename-ok',
                { path: '/repo', host: 'host-a', name: 'before' },
                null,
                namespace
            )
            const renameConflict = ctx.engine.getOrCreateSession(
                'rename-conflict',
                { path: '/repo', host: 'host-a', name: 'stale' },
                null,
                namespace
            )
            const beforePatch = ctx.engine.getSession(renameOk.id)
            const beforeUpdatedAt = beforePatch?.updatedAt
            expect(typeof beforeUpdatedAt).toBe('number')

            const concurrentUpdate = ctx.store.sessions.updateSessionMetadata(
                renameConflict.id,
                { path: '/repo', host: 'host-a', name: 'outside' },
                renameConflict.metadataVersion,
                namespace,
                { touchUpdatedAt: false }
            )
            expect(concurrentUpdate.result).toBe('success')

            const renameSuccess = await ctx.app.request(`/api/sessions/${renameOk.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ name: 'renamed', sort_order: 'a0V' })
            })
            expect(renameSuccess.status).toBe(200)
            expect(await renameSuccess.json()).toEqual({ ok: true })

            const renamedSession = ctx.engine.getSession(renameOk.id)
            expect(renamedSession?.metadata?.name).toBe('renamed')
            expect(renamedSession?.sortOrder).toBe('a0V')
            expect(renamedSession?.updatedAt).toBe(beforeUpdatedAt)

            const renameConflictResponse = await ctx.app.request(`/api/sessions/${renameConflict.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ name: 'mine' })
            })
            expect(renameConflictResponse.status).toBe(409)

            const sortOrderOnlyResponse = await ctx.app.request(`/api/sessions/${renameConflict.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ sort_order: 'a1' })
            })
            expect(sortOrderOnlyResponse.status).toBe(200)
            expect(await sortOrderOnlyResponse.json()).toEqual({ ok: true })

            const invalidPatchMissingFields = await ctx.app.request(`/api/sessions/${renameOk.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({})
            })
            expect(invalidPatchMissingFields.status).toBe(400)

            const invalidPatchSortOrder = await ctx.app.request(`/api/sessions/${renameOk.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ sort_order: 'bad-order!' })
            })
            expect(invalidPatchSortOrder.status).toBe(400)

            const invalidPatchSortOrderLength = await ctx.app.request(`/api/sessions/${renameOk.id}`, {
                method: 'PATCH',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ sort_order: 'a'.repeat(51) })
            })
            expect(invalidPatchSortOrderLength.status).toBe(400)

            const deleteInactive = ctx.engine.getOrCreateSession(
                'delete-inactive',
                { path: '/repo', host: 'host-a' },
                null,
                namespace
            )
            const deleteInactiveResponse = await ctx.app.request(`/api/sessions/${deleteInactive.id}`, {
                method: 'DELETE',
                headers: authHeaders(token)
            })
            expect(deleteInactiveResponse.status).toBe(200)
            expect(await deleteInactiveResponse.json()).toEqual({ ok: true })

            const deleteActive = ctx.engine.getOrCreateSession(
                'delete-active',
                { path: '/repo', host: 'host-a' },
                null,
                namespace
            )
            ctx.engine.handleSessionAlive({ sid: deleteActive.id, time: Date.now() })

            const deleteActiveResponse = await ctx.app.request(`/api/sessions/${deleteActive.id}`, {
                method: 'DELETE',
                headers: authHeaders(token)
            })
            expect(deleteActiveResponse.status).toBe(409)
            expect(await deleteActiveResponse.json()).toEqual({
                error: 'Cannot delete active session. Archive it first.'
            })
        } finally {
            ctx.stop()
        }
    })

    it('returns resume errors for missing path and no online machine', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const missingPath = ctx.engine.getOrCreateSession(
                'resume-missing-path',
                { host: 'host-a', claudeSessionId: 'resume-1' },
                null,
                namespace
            )
            const noMachine = ctx.engine.getOrCreateSession(
                'resume-no-machine',
                { path: '/repo', host: 'host-a', claudeSessionId: 'resume-2' },
                null,
                namespace
            )

            const missingPathResponse = await ctx.app.request(`/api/sessions/${missingPath.id}/resume`, {
                method: 'POST',
                headers: authHeaders(token)
            })
            expect(missingPathResponse.status).toBe(500)
            expect(await missingPathResponse.json()).toEqual({
                error: 'Session metadata missing path',
                code: 'resume_unavailable'
            })

            const noMachineResponse = await ctx.app.request(`/api/sessions/${noMachine.id}/resume`, {
                method: 'POST',
                headers: authHeaders(token)
            })
            expect(noMachineResponse.status).toBe(503)
            expect(await noMachineResponse.json()).toEqual({
                error: 'No machine online',
                code: 'no_machine_online'
            })
        } finally {
            ctx.stop()
        }
    })

    it('validates upload body, size limit, and active-session requirement', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const inactive = ctx.engine.getOrCreateSession('upload-inactive', { path: '/repo', host: 'host-a' }, null, namespace)
            const active = ctx.engine.getOrCreateSession('upload-active', { path: '/repo', host: 'host-a' }, null, namespace)
            ctx.engine.handleSessionAlive({ sid: active.id, time: Date.now() })

            const inactiveResponse = await ctx.app.request(`/api/sessions/${inactive.id}/upload`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({
                    filename: 'small.txt',
                    content: 'Zm9v',
                    mimeType: 'text/plain'
                })
            })
            expect(inactiveResponse.status).toBe(409)
            expect(await inactiveResponse.json()).toEqual({ error: 'Session is inactive' })

            const invalidSchemaResponse = await ctx.app.request(`/api/sessions/${active.id}/upload`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ filename: 'missing-fields.txt' })
            })
            expect(invalidSchemaResponse.status).toBe(400)
            expect(await invalidSchemaResponse.json()).toEqual({ error: 'Invalid body' })

            const oversizedLength = Math.ceil(((50 * 1024 * 1024) + 1) * 4 / 3)
            const oversizedContent = 'A'.repeat(oversizedLength)
            const oversizedResponse = await ctx.app.request(`/api/sessions/${active.id}/upload`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({
                    filename: 'large.bin',
                    content: oversizedContent,
                    mimeType: 'application/octet-stream'
                })
            })

            expect(oversizedResponse.status).toBe(413)
            expect(await oversizedResponse.json()).toEqual({
                success: false,
                error: 'File too large (max 50MB)'
            })
        } finally {
            ctx.stop()
        }
    })

    it('deduplicates machine path checks and validates max path count', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const machine = ctx.engine.getOrCreateMachine(
                'machine-1',
                { host: 'host-a', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                namespace
            )
            ctx.engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            let seenPaths: string[] = []
            ctx.registerRpc(`${machine.id}:path-exists`, (params: unknown) => {
                const paths = (params as { paths: string[] }).paths
                seenPaths = paths
                return {
                    exists: Object.fromEntries(paths.map((path) => [path, path.endsWith('/a')]))
                }
            })

            const dedupeResponse = await ctx.app.request(`/api/machines/${machine.id}/paths/exists`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({
                    paths: [' /tmp/a ', '/tmp/a', '/tmp/b', '/tmp/b']
                })
            })
            expect(dedupeResponse.status).toBe(200)
            expect(seenPaths).toEqual(['/tmp/a', '/tmp/b'])
            expect(await dedupeResponse.json()).toEqual({
                exists: {
                    '/tmp/a': true,
                    '/tmp/b': false
                }
            })

            const tooManyPaths = Array.from({ length: 1001 }, (_value, index) => `/tmp/${index}`)
            const tooManyResponse = await ctx.app.request(`/api/machines/${machine.id}/paths/exists`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({ paths: tooManyPaths })
            })
            expect(tooManyResponse.status).toBe(400)
            expect(await tooManyResponse.json()).toEqual({ error: 'Invalid body' })
        } finally {
            ctx.stop()
        }
    })

    it('lists machine agents via RPC and enforces namespace scope', async () => {
        const ctx = createTestContext()

        try {
            const alphaToken = await getAccessToken(ctx.app, 'alpha')
            const betaToken = await getAccessToken(ctx.app, 'beta')

            const alphaMachine = ctx.engine.getOrCreateMachine(
                'machine-alpha',
                { host: 'host-alpha', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                'alpha'
            )
            const betaMachine = ctx.engine.getOrCreateMachine(
                'machine-beta',
                { host: 'host-beta', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                'beta'
            )
            ctx.engine.handleMachineAlive({ machineId: alphaMachine.id, time: Date.now() })
            ctx.engine.handleMachineAlive({ machineId: betaMachine.id, time: Date.now() })

            let seenDirectory = ''
            ctx.registerRpc(`${alphaMachine.id}:list-agents`, (params: unknown) => {
                seenDirectory = (params as { directory: string }).directory
                return {
                    agents: [
                        { name: 'ops', description: 'Ops persona', source: 'global' },
                        { name: 'bead-architect', description: 'Bead workflows', source: 'project' }
                    ]
                }
            })

            const successResponse = await ctx.app.request(`/api/machines/${alphaMachine.id}/agents`, {
                method: 'POST',
                headers: authJsonHeaders(alphaToken),
                body: JSON.stringify({ directory: ' /tmp/repo ' })
            })
            expect(successResponse.status).toBe(200)
            expect(seenDirectory).toBe('/tmp/repo')
            expect(await successResponse.json()).toEqual({
                agents: [
                    { name: 'bead-architect', description: 'Bead workflows', source: 'project' },
                    { name: 'ops', description: 'Ops persona', source: 'global' }
                ]
            })

            const invalidResponse = await ctx.app.request(`/api/machines/${alphaMachine.id}/agents`, {
                method: 'POST',
                headers: authJsonHeaders(alphaToken),
                body: JSON.stringify({ directory: '   ' })
            })
            expect(invalidResponse.status).toBe(400)
            expect(await invalidResponse.json()).toEqual({ error: 'Invalid body' })

            const forbiddenResponse = await ctx.app.request(`/api/machines/${alphaMachine.id}/agents`, {
                method: 'POST',
                headers: authJsonHeaders(betaToken),
                body: JSON.stringify({ directory: '/tmp/repo' })
            })
            expect(forbiddenResponse.status).toBe(403)
            expect(await forbiddenResponse.json()).toEqual({ error: 'Machine access denied' })
        } finally {
            ctx.stop()
        }
    })

    it('validates git file path inputs and wraps rpc failures', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const session = ctx.engine.getOrCreateSession(
                'git-session',
                { path: '/repo', host: 'host-a' },
                null,
                namespace
            )

            const invalidDiffFile = await ctx.app.request(`/api/sessions/${session.id}/git-diff-file`, {
                headers: authHeaders(token)
            })
            expect(invalidDiffFile.status).toBe(400)
            expect(await invalidDiffFile.json()).toEqual({ error: 'Invalid file path' })

            const invalidFileRead = await ctx.app.request(`/api/sessions/${session.id}/file`, {
                headers: authHeaders(token)
            })
            expect(invalidFileRead.status).toBe(400)
            expect(await invalidFileRead.json()).toEqual({ error: 'Invalid file path' })

            ctx.registerRpc(`${session.id}:git-status`, () => {
                throw new Error('rpc exploded')
            })

            const gitStatus = await ctx.app.request(`/api/sessions/${session.id}/git-status`, {
                headers: authHeaders(token)
            })
            expect(gitStatus.status).toBe(200)
            expect(await gitStatus.json()).toEqual({
                success: false,
                error: 'rpc exploded'
            })
        } finally {
            ctx.stop()
        }
    })

    it('lists files for safe queries and rejects queries that start with a dash', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)
            const session = ctx.engine.getOrCreateSession(
                'git-files-session',
                { path: '/repo', host: 'host-a' },
                null,
                namespace
            )

            let ripgrepCallCount = 0
            let ripgrepArgs: string[] = []
            ctx.registerRpc(`${session.id}:ripgrep`, (params: unknown) => {
                ripgrepCallCount += 1
                ripgrepArgs = (params as { args: string[] }).args
                return {
                    success: true,
                    stdout: 'src/index.ts\nREADME.md\n'
                }
            })

            const successResponse = await ctx.app.request(`/api/sessions/${session.id}/files?query=src&limit=1`, {
                headers: authHeaders(token)
            })
            expect(successResponse.status).toBe(200)
            expect(ripgrepArgs).toEqual(['--files', '--iglob', '*src*'])
            expect(await successResponse.json()).toEqual({
                success: true,
                files: [{
                    fileName: 'index.ts',
                    filePath: 'src',
                    fullPath: 'src/index.ts',
                    fileType: 'file'
                }]
            })

            const rejectedResponse = await ctx.app.request(`/api/sessions/${session.id}/files?query=--pre`, {
                headers: authHeaders(token)
            })
            expect(rejectedResponse.status).toBe(400)
            expect(await rejectedResponse.json()).toEqual({
                error: 'Invalid query: must not start with -'
            })
            expect(ripgrepCallCount).toBe(1)
        } finally {
            ctx.stop()
        }
    })

    it('/cli/restart-sessions rejects missing auth and returns 503 when engine is unavailable', async () => {
        const app = new Hono<WebAppEnv>()
        app.route('/cli', createCliRoutes(() => null))

        const noAuth = await app.request('/cli/restart-sessions', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({})
        })
        expect(noAuth.status).toBe(401)
        expect(await noAuth.json()).toEqual({ error: 'Missing Authorization header' })

        const invalidAuth = await app.request('/cli/restart-sessions', {
            method: 'POST',
            headers: cliJsonHeaders('wrong-token:alpha'),
            body: JSON.stringify({})
        })
        expect(invalidAuth.status).toBe(401)
        expect(await invalidAuth.json()).toEqual({ error: 'Invalid token' })

        const notReady = await app.request('/cli/restart-sessions', {
            method: 'POST',
            headers: cliJsonHeaders(`${CLI_TOKEN}:alpha`),
            body: JSON.stringify({})
        })
        expect(notReady.status).toBe(503)
        expect(await notReady.json()).toEqual({ error: 'Not ready' })
    })

    it('/cli/restart-sessions delegates to engine and returns per-session results', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const machine = ctx.engine.getOrCreateMachine(
                'restart-machine',
                { host: 'alpha-host', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                namespace
            )
            ctx.engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const resumable = ctx.engine.getOrCreateSession(
                'cli-restart-resumable',
                { path: '/tmp/repo', host: 'alpha-host', machineId: machine.id, claudeSessionId: 'resume-token' },
                null,
                namespace
            )
            const skipped = ctx.engine.getOrCreateSession(
                'cli-restart-skipped',
                { path: '/tmp/repo-skip', host: 'alpha-host', machineId: machine.id, flavor: 'codex' },
                null,
                namespace
            )
            ctx.engine.handleSessionAlive({ sid: resumable.id, time: Date.now() })
            ctx.engine.handleSessionAlive({ sid: skipped.id, time: Date.now() })

            ctx.registerRpc(`${resumable.id}:killSession`, () => ({}))
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, () => {
                ctx.engine.handleSessionAlive({ sid: resumable.id, time: Date.now() })
                return { type: 'success', sessionId: resumable.id }
            })

            const response = await ctx.app.request('/cli/restart-sessions', {
                method: 'POST',
                headers: cliJsonHeaders(`${CLI_TOKEN}:alpha`),
                body: JSON.stringify({ machineId: machine.id })
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                results: [
                    { sessionId: resumable.id, name: null, status: 'restarted' },
                    { sessionId: skipped.id, name: null, status: 'skipped', error: 'not_resumable' }
                ]
            })
        } finally {
            ctx.stop()
        }
    })

    it('/cli/machines and /cli/machines/:id/spawn are namespace-scoped', async () => {
        const ctx = createTestContext()

        try {
            const alphaMachine = ctx.engine.getOrCreateMachine(
                'alpha-machine',
                { host: 'alpha-host', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                'alpha'
            )
            const betaMachine = ctx.engine.getOrCreateMachine(
                'beta-machine',
                { host: 'beta-host', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                'beta'
            )
            ctx.engine.handleMachineAlive({ machineId: alphaMachine.id, time: Date.now() })
            ctx.engine.handleMachineAlive({ machineId: betaMachine.id, time: Date.now() })

            const alphaCliToken = `${CLI_TOKEN}:alpha`
            const listResponse = await ctx.app.request('/cli/machines', {
                headers: cliHeaders(alphaCliToken)
            })
            expect(listResponse.status).toBe(200)
            expect(await listResponse.json()).toEqual({
                machines: [
                    expect.objectContaining({ id: alphaMachine.id })
                ]
            })

            const activeSpawnTarget = ctx.engine.getOrCreateSession(
                'spawned-alpha-target',
                { path: '/tmp/agent-subtask', host: 'alpha-host', machineId: alphaMachine.id },
                null,
                'alpha'
            )
            ctx.engine.handleSessionAlive({ sid: activeSpawnTarget.id, time: Date.now() })

            ctx.registerRpc(`${alphaMachine.id}:spawn-happy-session`, (params: unknown) => {
                const payload = params as { directory: string; agent?: string; sessionType?: string; initialPrompt?: string }
                expect(payload.directory).toBe('/tmp/agent-subtask')
                expect(payload.agent).toBe('codex')
                expect(payload.sessionType).toBe('simple')
                expect(payload.initialPrompt).toBeUndefined()
                return { type: 'success', sessionId: activeSpawnTarget.id }
            })

            const initialPrompt = 'Investigate flaky upload test and report findings.'

            const spawnResponse = await ctx.app.request(`/cli/machines/${alphaMachine.id}/spawn`, {
                method: 'POST',
                headers: cliJsonHeaders(alphaCliToken),
                body: JSON.stringify({
                    directory: '/tmp/agent-subtask',
                    agent: 'codex',
                    sessionType: 'simple',
                    initialPrompt
                })
            })
            expect(spawnResponse.status).toBe(200)
            expect(await spawnResponse.json()).toEqual({
                type: 'success',
                sessionId: activeSpawnTarget.id,
                initialPromptDelivery: 'delivered'
            })

            const spawnedMessages = ctx.store.messages.getMessages(activeSpawnTarget.id, 20)
            expect(spawnedMessages).toHaveLength(1)
            expect(spawnedMessages[0]?.content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: initialPrompt
                },
                meta: {
                    sentFrom: 'spawn'
                }
            })

            const forbiddenResponse = await ctx.app.request(`/cli/machines/${betaMachine.id}/spawn`, {
                method: 'POST',
                headers: cliJsonHeaders(alphaCliToken),
                body: JSON.stringify({
                    directory: '/tmp/blocked'
                })
            })
            expect(forbiddenResponse.status).toBe(403)
            expect(await forbiddenResponse.json()).toEqual({ error: 'Machine access denied' })
        } finally {
            ctx.stop()
        }
    })

    it('/cli/machines/:id/spawn validates request body', async () => {
        const ctx = createTestContext()

        try {
            const machine = ctx.engine.getOrCreateMachine(
                'machine-1',
                { host: 'host-a', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                'alpha'
            )
            ctx.engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const alphaCliToken = `${CLI_TOKEN}:alpha`
            const response = await ctx.app.request(`/cli/machines/${machine.id}/spawn`, {
                method: 'POST',
                headers: cliJsonHeaders(alphaCliToken),
                body: JSON.stringify({ directory: '' })
            })

            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({ error: 'Invalid body' })

            const oversizedPrompt = 'x'.repeat(100_001)
            const oversizedResponse = await ctx.app.request(`/cli/machines/${machine.id}/spawn`, {
                method: 'POST',
                headers: cliJsonHeaders(alphaCliToken),
                body: JSON.stringify({
                    directory: '/tmp/repo',
                    initialPrompt: oversizedPrompt
                })
            })

            expect(oversizedResponse.status).toBe(400)
            expect(await oversizedResponse.json()).toEqual({
                error: 'Invalid body: initialPrompt must be at most 100000 characters'
            })
        } finally {
            ctx.stop()
        }
    })

    it('/api/machines/:id/spawn validates oversized initialPrompt with descriptive error', async () => {
        const ctx = createTestContext()

        try {
            const namespace = 'alpha'
            const token = await getAccessToken(ctx.app, namespace)

            const machine = ctx.engine.getOrCreateMachine(
                'machine-2',
                { host: 'host-a', platform: 'linux', happyCliVersion: '1.0.0' },
                { status: 'running' },
                namespace
            )
            ctx.engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })

            const oversizedPrompt = 'x'.repeat(100_001)
            const response = await ctx.app.request(`/api/machines/${machine.id}/spawn`, {
                method: 'POST',
                headers: authJsonHeaders(token),
                body: JSON.stringify({
                    directory: '/tmp/repo',
                    initialPrompt: oversizedPrompt
                })
            })

            expect(response.status).toBe(400)
            expect(await response.json()).toEqual({
                error: 'Invalid body: initialPrompt must be at most 100000 characters'
            })
        } finally {
            ctx.stop()
        }
    })

    it('gets session beads and enforces access checks', async () => {
        const ctx = createTestContext()

        try {
            const alphaToken = await getAccessToken(ctx.app, 'alpha')
            const betaToken = await getAccessToken(ctx.app, 'beta')

            const alphaSession = ctx.engine.getOrCreateSession(
                'alpha-beads',
                { path: '/alpha-repo', host: 'host-a', machineId: 'machine-a' },
                null,
                'alpha'
            )
            const betaSession = ctx.engine.getOrCreateSession(
                'beta-beads',
                { path: '/beta-repo', host: 'host-b', machineId: 'machine-b' },
                null,
                'beta'
            )

            ctx.store.sessionBeads.linkBead(alphaSession.id, 'hapi-6uf')
            ctx.store.sessionBeads.saveSnapshot(alphaSession.id, 'hapi-6uf', {
                id: 'hapi-6uf',
                title: 'Beads UI',
                status: 'in_progress',
                priority: 2,
                acceptance_criteria: '- render panel'
            }, 123)

            const success = await ctx.app.request(`/api/sessions/${alphaSession.id}/beads`, {
                headers: authHeaders(alphaToken)
            })
            expect(success.status).toBe(200)
            expect(await success.json()).toEqual({
                beads: [{
                    id: 'hapi-6uf',
                    title: 'Beads UI',
                    status: 'in_progress',
                    priority: 2,
                    acceptance_criteria: '- render panel'
                }],
                stale: false
            })

            const wrongNamespace = await ctx.app.request(`/api/sessions/${betaSession.id}/beads`, {
                headers: authHeaders(alphaToken)
            })
            expect(wrongNamespace.status).toBe(403)

            const unknown = await ctx.app.request('/api/sessions/does-not-exist/beads', {
                headers: authHeaders(alphaToken)
            })
            expect(unknown.status).toBe(404)

            const betaOwn = await ctx.app.request(`/api/sessions/${betaSession.id}/beads`, {
                headers: authHeaders(betaToken)
            })
            expect(betaOwn.status).toBe(200)
            expect(await betaOwn.json()).toEqual({ beads: [], stale: false })
        } finally {
            ctx.stop()
        }
    })

    it('marks beads response stale when refresh fails', async () => {
        const ctx = createTestContext()

        try {
            const token = await getAccessToken(ctx.app, 'alpha')

            const session = ctx.engine.getOrCreateSession(
                'alpha-beads-stale',
                { path: '/alpha-repo', host: 'host-a', machineId: 'machine-a' },
                null,
                'alpha'
            )
            ctx.engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            ctx.store.sessionBeads.linkBead(session.id, 'hapi-6uf')
            ctx.store.sessionBeads.saveSnapshot(session.id, 'hapi-6uf', {
                id: 'hapi-6uf',
                title: 'Cached bead',
                status: 'open',
                priority: 3
            }, 123)

            const response = await ctx.app.request(`/api/sessions/${session.id}/beads`, {
                headers: authHeaders(token)
            })

            expect(response.status).toBe(200)
            expect(await response.json()).toEqual({
                beads: [{
                    id: 'hapi-6uf',
                    title: 'Cached bead',
                    status: 'open',
                    priority: 3
                }],
                stale: true
            })
        } finally {
            ctx.stop()
        }
    })
})
