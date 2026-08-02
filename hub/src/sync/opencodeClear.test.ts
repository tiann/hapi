import { describe, expect, it, mock } from 'bun:test'
import { RpcRegistry } from '../socket/rpcRegistry'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.getOrCreateMachine(
        'machine-1',
        { host: 'host', platform: 'linux', happyCliVersion: 'test' },
        null,
        'default'
    )
    return { store, engine }
}

function createClearSource(engine: SyncEngine, metadata: Record<string, unknown> = {}) {
    return engine.getOrCreateSession('clear-source', {
        path: '/tmp/project',
        host: 'host',
        machineId: 'machine-1',
        flavor: 'opencode',
        lifecycleState: 'archived',
        archiveReason: 'Cleared by /clear',
        preferredPermissionMode: 'yolo',
        opencodeSessionId: 'native-source-must-not-resume',
        ...metadata
    }, null, 'default', 'opencode/model', 'effort-x', 'high')
}

function setSpawn(engine: SyncEngine, spawnSession: ReturnType<typeof mock>) {
    ;(engine as unknown as { rpcGateway: { spawnSession: typeof spawnSession } }).rpcGateway.spawnSession = spawnSession
}

describe('SyncEngine.clearOpenCodeSession', () => {
    it.each(['resume', 'reopen'] as const)('blocks %s of an archived clear source before spawning', async (action) => {
        const { engine } = createEngine()
        try {
            const source = createClearSource(engine)
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            const result = action === 'resume'
                ? await engine.resumeSession(source.id, 'default')
                : await engine.reopenSession(source.id, 'default')

            expect(result).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(spawnSession).not.toHaveBeenCalled()
            expect(engine.getSessionByNamespace(source.id, 'default')?.metadata).toMatchObject({
                lifecycleState: 'archived',
                archiveReason: 'Cleared by /clear'
            })
        } finally {
            engine.stop()
        }
    })

    it('persists a preallocated replacement before spawning, preserving launch settings but never native source identity', async () => {
        const { engine } = createEngine()
        try {
            const source = createClearSource(engine)
            let operationAtSpawn: { replacementSessionId: string } | undefined
            const spawnSession = mock(async (...args: unknown[]) => {
                operationAtSpawn = engine.getSessionByNamespace(source.id, 'default')?.metadata?.opencodeClearOperation
                return {
                    type: 'success' as const,
                    sessionId: args[12] as string
                }
            })
            setSpawn(engine, spawnSession)

            await expect(engine.clearOpenCodeSession(source.id, 'default')).resolves.toMatchObject({
                type: 'success',
                sessionId: expect.any(String)
            })
            const replacementSessionId = spawnSession.mock.calls[0]?.[12] as string
            expect(replacementSessionId).toEqual(expect.any(String))
            expect(operationAtSpawn?.replacementSessionId).toBe(replacementSessionId)
            expect(replacementSessionId).not.toBe(source.id)
            expect(spawnSession).toHaveBeenCalledWith(
                'machine-1',
                '/tmp/project',
                'opencode',
                'opencode/model',
                'high',
                false,
                undefined,
                undefined,
                undefined,
                'effort-x',
                'yolo',
                undefined,
                replacementSessionId,
                undefined
            )
            expect(engine.getSessionByNamespace(replacementSessionId, 'default')?.metadata).toMatchObject({
                flavor: 'opencode',
                path: '/tmp/project'
            })
            expect(engine.getSessionByNamespace(replacementSessionId, 'default')?.metadata?.opencodeSessionId).toBeUndefined()
            expect(engine.getSessionByNamespace(source.id, 'default')?.metadata).toMatchObject({
                supersededBySessionId: replacementSessionId
            })
        } finally {
            engine.stop()
        }
    })

    it('reserves an independent replacement row for each cleared source', async () => {
        const { engine } = createEngine()
        try {
            const first = createClearSource(engine)
            const second = engine.getOrCreateSession('another-clear-source', {
                path: '/tmp/another-project', host: 'host', machineId: 'machine-1', flavor: 'opencode',
                lifecycleState: 'archived', archiveReason: 'Cleared by /clear'
            }, null, 'default')
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)

            const firstResult = await engine.clearOpenCodeSession(first.id, 'default')
            const secondResult = await engine.clearOpenCodeSession(second.id, 'default')
            expect(firstResult).toMatchObject({ type: 'success' })
            expect(secondResult).toMatchObject({ type: 'success' })
            if (firstResult.type !== 'success' || secondResult.type !== 'success') throw new Error('expected successful clears')
            expect(firstResult.sessionId).not.toBe(secondResult.sessionId)
        } finally {
            engine.stop()
        }
    })

    it('retries a failed spawn against the same durable replacement id', async () => {
        const { engine } = createEngine()
        try {
            const source = createClearSource(engine)
            const firstSpawn = mock(async () => ({ type: 'error' as const, message: 'runner unavailable' }))
            setSpawn(engine, firstSpawn)
            await expect(engine.clearOpenCodeSession(source.id, 'default')).resolves.toMatchObject({
                type: 'error', code: 'spawn_failed'
            })

            const pendingId = engine.getSessionByNamespace(source.id, 'default')?.metadata?.opencodeClearOperation?.replacementSessionId
            expect(pendingId).toEqual(expect.any(String))
            if (!pendingId) throw new Error('expected durable replacement id')
            const secondSpawn = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, secondSpawn)
            await expect(engine.clearOpenCodeSession(source.id, 'default')).resolves.toEqual({
                type: 'success', sessionId: pendingId
            })
            expect(secondSpawn.mock.calls[0]?.[12]).toBe(pendingId)
        } finally {
            engine.stop()
        }
    })

    it('returns the durable replacement to a reconnecting clear source without spawning again', async () => {
        const { engine } = createEngine()
        try {
            const source = createClearSource(engine, { supersededBySessionId: 'already-fresh' })
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect(engine.clearOpenCodeSession(source.id, 'default')).resolves.toEqual({
                type: 'success', sessionId: 'already-fresh'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('refuses source metadata that points to a machine outside its namespace', async () => {
        const { engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('cross-namespace-clear', {
                path: '/tmp/project', host: 'host', machineId: 'machine-1', flavor: 'opencode',
                lifecycleState: 'archived', archiveReason: 'Cleared by /clear'
            }, null, 'other')
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect(engine.clearOpenCodeSession(source.id, 'other')).resolves.toMatchObject({
                type: 'error', code: 'clear_unavailable'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })

    it('moves pending scheduled prompts to the replacement before it links the archived source', async () => {
        const { store, engine } = createEngine()
        try {
            const source = createClearSource(engine)
            const events: Array<{ type: string, sessionId?: string }> = []
            engine.subscribe((event) => events.push(event))
            const scheduled = store.messages.addMessage(source.id, { text: 'send later' }, 'scheduled-clear', Date.now() + 60_000)
            const spawnSession = mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string }))
            setSpawn(engine, spawnSession)

            const result = await engine.clearOpenCodeSession(source.id, 'default')
            expect(result).toMatchObject({ type: 'success' })
            if (result.type !== 'success') throw new Error('expected successful clear')
            expect(store.messages.getAllMessages(source.id)).not.toEqual(expect.arrayContaining([
                expect.objectContaining({ id: scheduled.id })
            ]))
            expect(store.messages.getAllMessages(result.sessionId)).toEqual(expect.arrayContaining([
                expect.objectContaining({ id: scheduled.id, localId: 'scheduled-clear', invokedAt: null })
            ]))
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-invalidated', sessionId: source.id }))
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-invalidated', sessionId: result.sessionId }))
        } finally {
            engine.stop()
        }
    })

    it('settles immediate prompts rejected during the clear latch without consuming scheduled transfers', async () => {
        const { store, engine } = createEngine()
        try {
            const source = createClearSource(engine)
            store.messages.addMessage(source.id, { text: 'rejected immediate' }, 'immediate-after-clear')
            store.messages.addMessage(source.id, { text: 'scheduled transfer' }, 'scheduled-after-clear', Date.now() + 60_000)
            const events: Array<{ type: string, sessionId?: string, localIds?: string[] }> = []
            engine.subscribe((event) => events.push(event))
            setSpawn(engine, mock(async (...args: unknown[]) => ({ type: 'success' as const, sessionId: args[12] as string })))

            const result = await engine.clearOpenCodeSession(source.id, 'default')
            if (result.type !== 'success') throw new Error('expected successful clear')

            expect(store.messages.getAllMessages(source.id)).toEqual(expect.arrayContaining([
                expect.objectContaining({ localId: 'immediate-after-clear', invokedAt: expect.any(Number) })
            ]))
            expect(store.messages.getAllMessages(result.sessionId)).toEqual(expect.arrayContaining([
                expect.objectContaining({ localId: 'scheduled-after-clear', invokedAt: null })
            ]))
            expect(events).toContainEqual(expect.objectContaining({
                type: 'messages-consumed', sessionId: source.id, localIds: ['immediate-after-clear']
            }))
        } finally {
            engine.stop()
        }
    })

    it('refuses before spawning while the source is still active', async () => {
        const { engine } = createEngine()
        try {
            const source = createClearSource(engine)
            engine.handleSessionAlive({ sid: source.id, time: Date.now() })
            const spawnSession = mock(async () => ({ type: 'success' as const, sessionId: 'must-not-spawn' }))
            setSpawn(engine, spawnSession)

            await expect(engine.clearOpenCodeSession(source.id, 'default')).resolves.toMatchObject({
                type: 'error', code: 'clear_unavailable'
            })
            expect(spawnSession).not.toHaveBeenCalled()
        } finally {
            engine.stop()
        }
    })
})
