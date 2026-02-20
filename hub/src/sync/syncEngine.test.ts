import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

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

function createHarness(): {
    engine: SyncEngine
    store: Store
    registerRpc: (method: string, handler: RpcHandler) => void
    stop: () => void
} {
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

    return {
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

function createOnlineMachine(ctx: {
    engine: SyncEngine
}, id: string, namespace: string): { id: string } {
    const machine = ctx.engine.getOrCreateMachine(
        id,
        {
            host: `${id}-host`,
            platform: 'linux',
            happyCliVersion: '1.0.0'
        },
        { status: 'running' },
        namespace
    )
    ctx.engine.handleMachineAlive({ machineId: machine.id, time: Date.now() })
    return machine
}

function createActiveSession(
    ctx: { engine: SyncEngine },
    namespace: string,
    tag: string,
    metadata: Record<string, unknown>
): { id: string } {
    const session = ctx.engine.getOrCreateSession(tag, metadata, null, namespace)
    ctx.engine.handleSessionAlive({ sid: session.id, time: Date.now() })
    return session
}

describe('SyncEngine.spawnSession initialPrompt', () => {
    it('sends initialPrompt when the spawned session is active', async () => {
        const ctx = createHarness()

        try {
            const spawnedSession = ctx.engine.getOrCreateSession(
                'spawn-target',
                { path: '/tmp/repo', host: 'host-a', machineId: 'machine-1' },
                null,
                'alpha'
            )
            ctx.engine.handleSessionAlive({ sid: spawnedSession.id, time: Date.now() })

            ctx.registerRpc('machine-1:spawn-happy-session', (params: unknown) => {
                expect(params).toMatchObject({
                    type: 'spawn-in-directory',
                    directory: '/tmp/repo',
                    agent: 'codex'
                })
                expect((params as { initialPrompt?: string }).initialPrompt).toBeUndefined()
                return { type: 'success', sessionId: spawnedSession.id }
            })

            const result = await ctx.engine.spawnSession(
                'machine-1',
                '/tmp/repo',
                'codex',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'Solve this task'
            )

            expect(result).toEqual({
                type: 'success',
                sessionId: spawnedSession.id,
                initialPromptDelivery: 'delivered'
            })

            const messages = ctx.store.messages.getMessages(spawnedSession.id, 10)
            expect(messages).toHaveLength(1)
            expect(messages[0]?.content).toMatchObject({
                role: 'user',
                content: {
                    type: 'text',
                    text: 'Solve this task'
                },
                meta: {
                    sentFrom: 'spawn'
                }
            })
        } finally {
            ctx.stop()
        }
    })

    it('does not wait or send message when initialPrompt is omitted', async () => {
        const ctx = createHarness()

        try {
            let waitCalls = 0
            ;(ctx.engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => {
                waitCalls += 1
                return true
            }

            ctx.registerRpc('machine-1:spawn-happy-session', () => ({
                type: 'success',
                sessionId: 'spawned-session'
            }))

            const result = await ctx.engine.spawnSession('machine-1', '/tmp/repo')

            expect(result).toEqual({
                type: 'success',
                sessionId: 'spawned-session'
            })
            expect(waitCalls).toBe(0)
            expect(ctx.store.messages.getMessages('spawned-session', 10)).toHaveLength(0)
        } finally {
            ctx.stop()
        }
    })

    it('returns success with timed_out status when prompt delivery wait times out', async () => {
        const ctx = createHarness()

        try {
            ;(ctx.engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => false

            ctx.registerRpc('machine-1:spawn-happy-session', () => ({
                type: 'success',
                sessionId: 'spawned-timeout'
            }))

            const result = await ctx.engine.spawnSession(
                'machine-1',
                '/tmp/repo',
                'claude',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                'Plan this refactor'
            )

            expect(result).toEqual({
                type: 'success',
                sessionId: 'spawned-timeout',
                initialPromptDelivery: 'timed_out'
            })
            expect(ctx.store.messages.getMessages('spawned-timeout', 10)).toHaveLength(0)
        } finally {
            ctx.stop()
        }
    })

    it('treats empty initialPrompt as omitted', async () => {
        const ctx = createHarness()

        try {
            let waitCalls = 0
            ;(ctx.engine as unknown as { waitForSessionActive: () => Promise<boolean> }).waitForSessionActive = async () => {
                waitCalls += 1
                return true
            }

            ctx.registerRpc('machine-1:spawn-happy-session', () => ({
                type: 'success',
                sessionId: 'spawned-empty'
            }))

            const result = await ctx.engine.spawnSession(
                'machine-1',
                '/tmp/repo',
                'claude',
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                '   '
            )

            expect(result).toEqual({
                type: 'success',
                sessionId: 'spawned-empty'
            })
            expect(waitCalls).toBe(0)
            expect(ctx.store.messages.getMessages('spawned-empty', 10)).toHaveLength(0)
        } finally {
            ctx.stop()
        }
    })
})

describe('SyncEngine.restartSessions', () => {
    it('skips non-resumable sessions during preflight without killing them', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const session = createActiveSession(ctx, namespace, 'skip-no-token', {
                path: '/tmp/repo',
                host: 'machine-1-host',
                machineId: machine.id,
                flavor: 'codex'
            })

            let killCalls = 0
            let spawnCalls = 0

            ctx.registerRpc(`${session.id}:killSession`, () => {
                killCalls += 1
                return {}
            })
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, () => {
                spawnCalls += 1
                return { type: 'success', sessionId: session.id }
            })

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                {
                    sessionId: session.id,
                    name: null,
                    status: 'skipped',
                    error: 'not_resumable'
                }
            ])
            expect(killCalls).toBe(0)
            expect(spawnCalls).toBe(0)
            expect(ctx.engine.getSession(session.id)?.active).toBe(true)
        } finally {
            ctx.stop()
        }
    })

    it('restarts matching active sessions sequentially', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const sessionOne = createActiveSession(ctx, namespace, 'restart-1', {
                name: 'Session One',
                path: '/tmp/repo-1',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-1'
            })
            const sessionTwo = createActiveSession(ctx, namespace, 'restart-2', {
                name: 'Session Two',
                path: '/tmp/repo-2',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-2'
            })

            const sequence: string[] = []

            ctx.registerRpc(`${sessionOne.id}:killSession`, () => {
                sequence.push(`kill:${sessionOne.id}`)
                return {}
            })
            ctx.registerRpc(`${sessionTwo.id}:killSession`, () => {
                sequence.push(`kill:${sessionTwo.id}`)
                return {}
            })
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, (params: unknown) => {
                const payload = params as { resumeSessionId?: string }
                const resumedId = payload.resumeSessionId === 'resume-1' ? sessionOne.id : sessionTwo.id
                sequence.push(`spawn:${resumedId}`)
                ctx.engine.handleSessionAlive({ sid: resumedId, time: Date.now() })
                return { type: 'success', sessionId: resumedId }
            })

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                { sessionId: sessionOne.id, name: 'Session One', status: 'restarted' },
                { sessionId: sessionTwo.id, name: 'Session Two', status: 'restarted' }
            ])
            expect(sequence).toEqual([
                `kill:${sessionOne.id}`,
                `spawn:${sessionOne.id}`,
                `kill:${sessionTwo.id}`,
                `spawn:${sessionTwo.id}`
            ])
        } finally {
            ctx.stop()
        }
    })

    it('filters sessions by machineId', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machineOne = createOnlineMachine(ctx, 'machine-1', namespace)
            const machineTwo = createOnlineMachine(ctx, 'machine-2', namespace)
            const included = createActiveSession(ctx, namespace, 'machine-filter-in', {
                path: '/tmp/repo-in',
                host: 'machine-1-host',
                machineId: machineOne.id,
                claudeSessionId: 'resume-in'
            })
            const excluded = createActiveSession(ctx, namespace, 'machine-filter-out', {
                path: '/tmp/repo-out',
                host: 'machine-2-host',
                machineId: machineTwo.id,
                claudeSessionId: 'resume-out'
            })

            let includedKills = 0
            let includedSpawns = 0
            ctx.registerRpc(`${included.id}:killSession`, () => {
                includedKills += 1
                return {}
            })
            ctx.registerRpc(`${machineOne.id}:spawn-happy-session`, () => {
                includedSpawns += 1
                ctx.engine.handleSessionAlive({ sid: included.id, time: Date.now() })
                return { type: 'success', sessionId: included.id }
            })

            const results = await ctx.engine.restartSessions(namespace, { machineId: machineOne.id })

            expect(results).toEqual([
                { sessionId: included.id, name: null, status: 'restarted' }
            ])
            expect(includedKills).toBe(1)
            expect(includedSpawns).toBe(1)
            expect(ctx.engine.getSession(excluded.id)?.active).toBe(true)
        } finally {
            ctx.stop()
        }
    })

    it('filters sessions by explicit sessionIds', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const first = createActiveSession(ctx, namespace, 'id-filter-1', {
                path: '/tmp/repo-1',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-1'
            })
            const second = createActiveSession(ctx, namespace, 'id-filter-2', {
                path: '/tmp/repo-2',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-2'
            })

            let killCalls = 0
            let spawnCalls = 0
            ctx.registerRpc(`${second.id}:killSession`, () => {
                killCalls += 1
                return {}
            })
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, () => {
                spawnCalls += 1
                ctx.engine.handleSessionAlive({ sid: second.id, time: Date.now() })
                return { type: 'success', sessionId: second.id }
            })

            const results = await ctx.engine.restartSessions(namespace, { sessionIds: [second.id] })

            expect(results).toEqual([
                { sessionId: second.id, name: null, status: 'restarted' }
            ])
            expect(killCalls).toBe(1)
            expect(spawnCalls).toBe(1)
            expect(ctx.engine.getSession(first.id)?.active).toBe(true)
        } finally {
            ctx.stop()
        }
    })

    it('recovers from kill RPC failures by force-marking inactive then resuming', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const session = createActiveSession(ctx, namespace, 'kill-recovery', {
                path: '/tmp/repo',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-token'
            })

            let observedInactiveBeforeResume = false

            ctx.registerRpc(`${session.id}:killSession`, () => {
                throw new Error('rpc timeout')
            })
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, () => {
                observedInactiveBeforeResume = ctx.engine.getSession(session.id)?.active === false
                ctx.engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                return { type: 'success', sessionId: session.id }
            })

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                { sessionId: session.id, name: null, status: 'restarted' }
            ])
            expect(observedInactiveBeforeResume).toBe(true)
        } finally {
            ctx.stop()
        }
    })

    it('retries once when resume fails with retryable resume_failed', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const session = createActiveSession(ctx, namespace, 'resume-retry', {
                path: '/tmp/repo',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-token'
            })

            ;(ctx.engine as unknown as { sleep?: (ms: number) => Promise<void> }).sleep = async () => {}

            let spawnCalls = 0
            ctx.registerRpc(`${session.id}:killSession`, () => ({}))
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, () => {
                spawnCalls += 1
                if (spawnCalls === 1) {
                    return { type: 'error', errorMessage: 'temporary failure' }
                }
                ctx.engine.handleSessionAlive({ sid: session.id, time: Date.now() })
                return { type: 'success', sessionId: session.id }
            })

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                { sessionId: session.id, name: null, status: 'restarted' }
            ])
            expect(spawnCalls).toBe(2)
        } finally {
            ctx.stop()
        }
    })

    it('does not retry permanent resume failures', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const session = createActiveSession(ctx, namespace, 'resume-permanent-fail', {
                path: '/tmp/repo',
                host: 'machine-1-host',
                machineId: 'machine-1',
                claudeSessionId: 'resume-token'
            })

            let resumeCalls = 0
            const originalResumeSession = ctx.engine.resumeSession.bind(ctx.engine)
            ;(ctx.engine as unknown as {
                resumeSession: (sessionId: string, namespace: string) => Promise<{ type: 'success'; sessionId: string } | { type: 'error'; message: string; code: 'session_not_found' | 'access_denied' | 'no_machine_online' | 'resume_unavailable' | 'resume_failed' }>
            }).resumeSession = async (sessionId: string, callNamespace: string) => {
                resumeCalls += 1
                if (sessionId === session.id) {
                    return { type: 'error', message: 'No machine online', code: 'no_machine_online' }
                }
                return await originalResumeSession(sessionId, callNamespace)
            }

            ctx.registerRpc(`${session.id}:killSession`, () => ({}))

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                { sessionId: session.id, name: null, status: 'failed', error: 'no_machine_online' }
            ])
            expect(resumeCalls).toBe(1)
        } finally {
            ctx.stop()
        }
    })

    it('returns mixed per-session outcomes for restarted, skipped, and failed sessions', async () => {
        const ctx = createHarness()

        try {
            const namespace = 'alpha'
            const machine = createOnlineMachine(ctx, 'machine-1', namespace)
            const restarted = createActiveSession(ctx, namespace, 'mixed-restarted', {
                path: '/tmp/repo-ok',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-ok'
            })
            const skipped = createActiveSession(ctx, namespace, 'mixed-skipped', {
                path: '/tmp/repo-skip',
                host: 'machine-1-host',
                machineId: machine.id,
                flavor: 'codex'
            })
            const failed = createActiveSession(ctx, namespace, 'mixed-failed', {
                name: 'Failing Session',
                path: '/tmp/repo-fail',
                host: 'machine-1-host',
                machineId: machine.id,
                claudeSessionId: 'resume-fail'
            })

            ctx.registerRpc(`${restarted.id}:killSession`, () => ({}))
            ctx.registerRpc(`${failed.id}:killSession`, () => ({}))
            ctx.registerRpc(`${machine.id}:spawn-happy-session`, (params: unknown) => {
                const payload = params as { resumeSessionId?: string }
                if (payload.resumeSessionId === 'resume-ok') {
                    ctx.engine.handleSessionAlive({ sid: restarted.id, time: Date.now() })
                    return { type: 'success', sessionId: restarted.id }
                }
                return { type: 'error', errorMessage: 'permanent failure' }
            })

            ;(ctx.engine as unknown as { sleep?: (ms: number) => Promise<void> }).sleep = async () => {}

            const results = await ctx.engine.restartSessions(namespace, {})

            expect(results).toEqual([
                { sessionId: restarted.id, name: null, status: 'restarted' },
                { sessionId: skipped.id, name: null, status: 'skipped', error: 'not_resumable' },
                { sessionId: failed.id, name: 'Failing Session', status: 'failed', error: 'resume_failed' }
            ])
        } finally {
            ctx.stop()
        }
    })
})
