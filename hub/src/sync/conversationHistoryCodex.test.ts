import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'
import type { MessageService } from './messageService'
import type { SessionCache } from './sessionCache'

function recoveryState(engine: SyncEngine) {
    return engine as unknown as {
        rpcGateway: RpcGateway
        messageService: MessageService
        sessionCache: SessionCache
        codexForkRecoveryByChildId: Map<string, Promise<void>>
        expireInactive(): void
    }
}

function recoveryFixture(childCount = 1) {
    const store = new Store(':memory:')
    const emitted: Array<{ body: { t: string; sid: string; message?: { localId: string } } }> = []
    const io = { of: () => ({ to: () => ({ emit: (event: string, update: typeof emitted[number]) => {
        if (event === 'update') emitted.push(update)
    } }) }) }
    const start = () => {
        const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        spyOn(recoveryState(engine).rpcGateway, 'spawnSession').mockImplementation(async (...args) => ({
            type: 'success', sessionId: args[12]!
        }))
        return engine
    }
    const first = start()
    const source = first.getOrCreateSession('recovery-source', {
        path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
        codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
    }, null, 'default')
    const children = Array.from({ length: childCount }, (_, index) => first.getOrCreateSession(`recovery-child-${index}`, {
        path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
        codexSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' },
        forkedFrom: source.id
    }, null, 'default'))
    first.stop()
    const bind = (id: string) => {
        const child = store.sessions.getSession(id)
        if (!child) throw new Error('Missing child')
        const metadata = { ...(child.metadata as Record<string, unknown>), codexSessionId: `thread-${id}` }
        delete (metadata as Record<string, unknown>).codexForkRequest
        expect(store.sessions.updateSessionMetadata(id, metadata, child.metadataVersion, child.namespace).result).toBe('success')
    }
    return { store, source, children, emitted, start, bind }
}

describe('Codex conversation-history hub integration', () => {
    it('recovers a crash after transcript commit using the original child and launch settings', async () => {
        const { store, source, start, bind } = recoveryFixture(0)
        const first = start()
        const state = recoveryState(first)
        first.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote',
            model: 'child-model', modelReasoningEffort: 'high', permissionMode: 'read-only',
            serviceTier: 'fast', collaborationMode: 'plan' })
        spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
            nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source', lastTurnId: 'turn-a' }
        })
        store.messages.addMessage(source.id, { role: 'assistant', content: 'prefix' }, 'prefix')
        store.messages.markMessagesInvoked(source.id, ['prefix'], Date.now())
        const copy = store.messages.copyMessagesToSession.bind(store.messages)
        const crash = spyOn(store.messages, 'copyMessagesToSession').mockImplementation((...args) => {
            const result = copy(...args)
            first.stop()
            return result
        })
        const originalSpawn = spyOn(state.rpcGateway, 'spawnSession')
        expect(await first.forkConversation(source.id, 'default')).toMatchObject({ type: 'error', message: 'Sync engine stopped during fork' })
        crash.mockRestore()
        expect(originalSpawn).not.toHaveBeenCalled()
        const child = store.sessions.getSessions().find(session => session.id !== source.id)!
        expect(child).toBeDefined()
        const restarted = start()
        const spawn = spyOn(recoveryState(restarted).rpcGateway, 'spawnSession').mockImplementation(async (...args) => {
            expect(args[8]).toBe('thread-source')
            expect(args[12]).toBe(child.id)
            expect(args[3]).toBe('child-model')
            expect(args[4]).toBe('high')
            expect(args[10]).toBe('read-only')
            expect(args[11]).toBe('fast')
            expect(args[13]).toBe('plan')
            expect(store.sessions.getSession(child.id)?.metadata).toHaveProperty('codexForkRequest.lastTurnId', 'turn-a')
            bind(child.id)
            restarted.handleSessionAlive({ sid: child.id, time: Date.now(), mode: 'remote' })
            return { type: 'success', sessionId: child.id }
        })
        try {
            await Promise.all(recoveryState(restarted).codexForkRecoveryByChildId.values())
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(store.sessions.getSession(child.id)?.metadata).not.toHaveProperty('codexForkRequest')
            expect(store.messages.getAllMessages(child.id).map(message => message.localId)).toEqual(['prefix'])
        } finally {
            restarted.stop()
        }
    })

    for (const processStarted of [false, true, undefined]) {
        it(`recovery respects spawn evidence and retries unknown (${processStarted})`, async () => {
            const { store, children: [child], start, bind } = recoveryFixture()
            const engine = start()
            const state = recoveryState(engine)
            const spawn = spyOn(state.rpcGateway, 'spawnSession').mockResolvedValue({ type: 'error', message: 'failure', processStarted })
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
            try {
                state.expireInactive()
                state.expireInactive()
                await Promise.all(state.codexForkRecoveryByChildId.values())
                expect(spawn).toHaveBeenCalledTimes(1)
                expect(stop).toHaveBeenCalledTimes(processStarted === true ? 1 : 0)
                if (processStarted === false) expect(store.sessions.getSession(child.id)).toBeNull()
                else if (processStarted === true) expect(store.sessions.getSession(child.id)?.metadata).toHaveProperty('codexForkCleanup')
                else {
                    expect(store.sessions.getSession(child.id)?.metadata).not.toHaveProperty('codexForkCleanup')
                    spawn.mockReset().mockImplementation(async () => {
                        bind(child.id)
                        engine.handleSessionAlive({ sid: child.id, time: Date.now(), mode: 'remote' })
                        return { type: 'success', sessionId: child.id }
                    })
                    state.expireInactive()
                    await Promise.all(state.codexForkRecoveryByChildId.values())
                    expect(spawn).toHaveBeenCalledTimes(1)
                    expect(store.sessions.getSession(child.id)?.metadata).not.toHaveProperty('codexForkRequest')
                }
            } finally {
                engine.stop()
            }
        })
    }

    it('re-drives the same pending child after a crash before spawn', async () => {
        const { store, children: [child], start, bind } = recoveryFixture()
        const wait = spyOn(SyncEngine.prototype as unknown as {
            waitForCodexForkBound(): Promise<boolean>
        }, 'waitForCodexForkBound').mockResolvedValue(true)
        const engine = start()
        const spawn = spyOn(recoveryState(engine).rpcGateway, 'spawnSession').mockImplementation(async (...args) => {
            expect(args[0]).toBe('machine-1')
            expect(args[8]).toBe('thread-source')
            expect(args[12]).toBe(child.id)
            bind(child.id)
            return { type: 'success', sessionId: child.id }
        })
        try {
            await Promise.all(recoveryState(engine).codexForkRecoveryByChildId.values())
            expect(spawn).toHaveBeenCalledTimes(1)
            expect(store.sessions.getSession(child.id)?.metadata).not.toHaveProperty('codexForkRequest')
        } finally {
            engine.stop()
            spawn.mockRestore()
            wait.mockRestore()
        }
    })

    it('returns success when binding wins the cleanup ownership CAS', async () => {
        const { store, source, start, bind } = recoveryFixture(0)
        const engine = start()
        const state = recoveryState(engine)
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
        spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
            nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
        })
        let childId = ''
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        const cas = spyOn(store.sessions, 'updateSessionMetadata').mockImplementation((...args) => {
            if ((args[1] as Record<string, unknown>).codexForkCleanup) {
                cas.mockRestore()
                bind(childId)
            }
            return update(...args)
        })
        spyOn(state.rpcGateway, 'spawnSession').mockImplementation(async (...args) => {
            childId = args[12]!
            return { type: 'error', message: 'lost reply' }
        })
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('stopped')
        try {
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: childId })
            expect(stop).not.toHaveBeenCalled()
            expect(store.sessions.getSession(childId)).not.toBeNull()
        } finally {
            cas.mockRestore()
            engine.stop()
        }
    })

    it('preserves a bind between recovery refresh and cleanup, and refuses a stale ownership CAS', async () => {
        for (const race of ['refresh', 'cas'] as const) {
            const { store, children: [child], start, bind } = recoveryFixture()
            const wait = spyOn(SyncEngine.prototype as unknown as {
                waitForCodexForkBound(): Promise<boolean>
            }, 'waitForCodexForkBound').mockResolvedValue(false)
            const engine = start()
            const state = recoveryState(engine)
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('stopped')
            let restoreRace: () => void
            if (race === 'refresh') {
                const refresh = state.sessionCache.refreshSession.bind(state.sessionCache)
                const read = spyOn(state.sessionCache, 'refreshSession').mockImplementation((id) => {
                    const snapshot = refresh(id)
                    read.mockRestore()
                    bind(child.id)
                    return snapshot
                })
                restoreRace = () => read.mockRestore()
            } else {
                const update = store.sessions.updateSessionMetadata.bind(store.sessions)
                const cas = spyOn(store.sessions, 'updateSessionMetadata').mockImplementation((...args) => {
                    cas.mockRestore()
                    bind(child.id)
                    return update(...args)
                })
                restoreRace = () => cas.mockRestore()
            }
            try {
                await Promise.all(state.codexForkRecoveryByChildId.values())
                expect(stop).not.toHaveBeenCalled()
                expect(store.sessions.getSession(child.id)?.metadata).not.toHaveProperty('codexForkCleanup')
                expect(store.sessions.getSession(child.id)).not.toBeNull()
            } finally {
                wait.mockRestore()
                restoreRace()
                engine.stop()
            }
        }
    })

    it('preserves a child that binds between the catch read and cleanup ownership acquisition', async () => {
        const { store, source, start, bind } = recoveryFixture(0)
        const engine = start()
        const state = recoveryState(engine)
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
        spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
            nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
        })
        let childId = ''
        spyOn(state.rpcGateway, 'spawnSession').mockImplementation(async (...args) => {
            childId = args[12]!
            const refresh = state.sessionCache.refreshSession.bind(state.sessionCache)
            const read = spyOn(state.sessionCache, 'refreshSession').mockImplementation((id) => {
                const snapshot = refresh(id)
                if (id === childId) {
                    read.mockRestore()
                    bind(childId)
                    store.messages.addMessage(childId, { role: 'user', content: 'accepted after bind' }, 'accepted')
                }
                return snapshot
            })
            return { type: 'error', message: 'lost reply' }
        })
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('stopped')
        try {
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: childId })
            expect(stop).not.toHaveBeenCalled()
            expect(store.sessions.getSession(childId)).not.toBeNull()
            expect(store.messages.getAllMessages(childId).map((message) => message.localId)).toEqual(['accepted'])
        } finally {
            engine.stop()
        }
    })

    it('retains no-process proof across a failed deletion and hub restart', async () => {
        const { store, source, start } = recoveryFixture(0)
        const engine = start()
        const state = recoveryState(engine)
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
        spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
            nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
        })
        spyOn(state.rpcGateway, 'spawnSession').mockResolvedValue({ type: 'error', message: 'no PID', processStarted: false })
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
        const deletion = spyOn(store.sessions, 'deleteSession').mockReturnValue(false)
        try {
            expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
            expect(stop).not.toHaveBeenCalled()
        } finally {
            deletion.mockRestore()
            engine.stop()
        }
        const restarted = start()
        const recovery = recoveryState(restarted)
        const recoveryStop = spyOn(recovery.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
        try {
            await Promise.all(recovery.codexForkRecoveryByChildId.values())
            expect(recoveryStop).not.toHaveBeenCalled()
            expect(restarted.getSessions().filter((session) => session.metadata?.forkedFrom === source.id)).toEqual([])
            await expect(restarted.sendMessage(source.id, { text: 'released' })).resolves.toBeUndefined()
        } finally {
            restarted.stop()
        }
    }, 10_000)

    for (const processStarted of [false, true, undefined]) {
        it(`only skips stop recovery for explicit no-process evidence (${processStarted})`, async () => {
            const { store, source, start } = recoveryFixture(0)
            const engine = start()
            const state = recoveryState(engine)
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
                nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            let childId = ''
            spyOn(state.rpcGateway, 'spawnSession').mockImplementation(async (...args) => {
                childId = args[12]!
                return { type: 'error', message: 'spawn failure', processStarted }
            })
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
            try {
                expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
                if (processStarted === false) {
                    expect(stop).not.toHaveBeenCalled()
                    expect(store.sessions.getSession(childId)).toBeNull()
                    await expect(engine.sendMessage(source.id, { text: 'released' })).resolves.toBeUndefined()
                } else {
                    expect(stop).toHaveBeenCalledTimes(1)
                    expect(store.sessions.getSession(childId)?.metadata).toHaveProperty('codexForkCleanup')
                    await expect(engine.sendMessage(source.id, { text: 'held' })).rejects.toThrow(/history action/)
                }
            } finally {
                engine.stop()
            }
        })
    }

    for (const [stopped, returnedError] of [[false, false], [false, true], [true, false]] as const) {
        it(`preserves a bound child after late spawn failure (stopped=${stopped}, returnedError=${returnedError})`, async () => {
            const { store, source, start, bind } = recoveryFixture(0)
            const engine = start()
            const state = recoveryState(engine)
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
                nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            let failSpawn!: () => void
            let spawnStarted!: () => void
            const started = new Promise<void>((resolve) => { spawnStarted = resolve })
            spyOn(state.rpcGateway, 'spawnSession').mockImplementation(() => {
                spawnStarted()
                return new Promise((resolve, reject) => {
                    failSpawn = () => returnedError
                        ? resolve({ type: 'error', message: 'spawn response lost' })
                        : reject(new Error('spawn response lost'))
                })
            })
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('stopped')
            const fork = engine.forkConversation(source.id, 'default')
            try {
                await started
                const child = engine.getSessions().find((session) => session.metadata?.forkedFrom === source.id)!
                bind(child.id) // Deliberately leave the cache stale; persisted binding is authoritative.
                await engine.sendMessage(child.id, { text: 'accepted', localId: 'accepted' })
                if (stopped) engine.stop()
                failSpawn()
                expect(await fork).toEqual(stopped
                    ? { type: 'error', message: 'Sync engine stopped during fork' }
                    : { type: 'success', sessionId: child.id })
                expect(stop).not.toHaveBeenCalled()
                expect(store.sessions.getSession(child.id)).not.toBeNull()
                expect(store.messages.getAllMessages(child.id).map((message) => message.localId)).toEqual(['accepted'])
            } finally {
                engine.stop()
            }
        })
    }

    for (const cleanup of [false, true]) {
        it(`gates replacement native-thread sources and preserves the original during dedupe (cleanup=${cleanup})`, async () => {
            const { store, source, children: [child], emitted, start, bind } = recoveryFixture()
            if (cleanup) {
                const current = store.sessions.getSession(child.id)!
                store.sessions.updateSessionMetadata(child.id, {
                    ...(current.metadata as Record<string, unknown>),
                    codexForkCleanup: { sourceSessionId: source.id, machineId: 'machine-1' }
                }, current.metadataVersion, current.namespace)
                bind(child.id)
            }
            const engine = start()
            const state = recoveryState(engine)
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
            try {
                const replacement = engine.getOrCreateSession('replacement', {
                    path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                    codexSessionId: 'thread-source'
                }, null, 'default')
                engine.handleSessionAlive({ sid: replacement.id, time: Date.now(), mode: 'remote' })
                await state.sessionCache.deduplicateByAgentSessionId(replacement.id)
                await expect(engine.sendMessage(replacement.id, { text: 'held' })).rejects.toThrow(/history action/)
                expect(await engine.forkConversation(replacement.id, 'default')).toMatchObject({ type: 'error', message: expect.stringMatching(/history action/) })
                expect(await engine.rewindConversation(replacement.id, 'default', 'missing')).toMatchObject({ type: 'error', message: expect.stringMatching(/history action/) })
                await expect(engine.switchSession(replacement.id, 'local')).rejects.toThrow(/history action/)
                store.messages.addMessage(replacement.id, { role: 'user', content: 'scheduled' }, 'alias-scheduled', Date.now() - 1)
                state.messageService.releaseMatureScheduledMessages(Date.now())
                expect(engine.getDeliverableMessagesAfter(replacement.id, { afterSeq: 0, limit: 200, now: Date.now() })).toEqual([])
                expect(emitted).toEqual([])
                expect(store.sessions.getSession(source.id)).not.toBeNull()
                for (const [machineId, namespace] of [['machine-2', 'default'], ['machine-1', 'other']]) {
                    const unrelated = engine.getOrCreateSession(`unrelated-${machineId}-${namespace}`, {
                        path: '/tmp/project', host: 'localhost', machineId, flavor: 'codex', codexSessionId: 'thread-source'
                    }, null, namespace)
                    await engine.sendMessage(unrelated.id, { text: 'allowed' })
                    expect(store.isCodexForkDeliveryGated(unrelated.id)).toBe(false)
                }
                if (cleanup) {
                    await state.codexForkRecoveryByChildId.get(child.id)
                    stop.mockResolvedValue('stopped')
                    state.expireInactive()
                    await state.codexForkRecoveryByChildId.get(child.id)
                    expect(store.sessions.getSession(child.id)).toBeNull()
                } else {
                    bind(child.id)
                }
                state.messageService.releaseMatureScheduledMessages(Date.now())
                expect(emitted.at(-1)?.body.message?.localId).toBe('alias-scheduled')
                await engine.sendMessage(replacement.id, { text: 'released' })
            } finally {
                engine.stop()
                await Promise.all(state.codexForkRecoveryByChildId.values())
            }
        })
    }

    it('does not deduplicate a pending child against its source thread anchor', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('codex-dedupe-source', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source'
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            const child = engine.getOrCreateSession('codex-dedupe-child', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }, forkedFrom: source.id
            }, null, 'default')

            await (engine as any).sessionCache.deduplicateByAgentSessionId(source.id)

            expect(engine.getSession(source.id)).toBeDefined()
            expect(engine.getSession(child.id)?.metadata?.codexForkRequest).toEqual({ sourceThreadId: 'thread-source' })

            await (engine as any).sessionCache.deduplicateByAgentSessionId(child.id)

            expect(engine.getSession(source.id)).toBeDefined()
            expect(engine.getSession(child.id)?.metadata?.codexForkRequest).toEqual({ sourceThreadId: 'thread-source' })
        } finally {
            engine.stop()
        }
    })

    it('stores child-side fork intent while spawning from the source thread', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('codex-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'source transcript' }, 'local-1')
            store.messages.markMessagesInvoked(source.id, ['local-1'], Date.now())
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: args[12] }
            }
            const waitCalls: unknown[][] = []
            ;(engine as any).waitForCodexForkBound = async (...args: unknown[]) => {
                waitCalls.push(args)
                return true
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(engine.getSession(result.sessionId)?.metadata).toMatchObject({
                codexSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            expect(spawnArgs[8]).toBe('thread-source')
            expect(waitCalls).toEqual([[result.sessionId, 'thread-source']])
            expect(store.messages.getAllMessages(result.sessionId).map((message) => message.localId)).toEqual(['local-1'])
        } finally {
            engine.stop()
        }
    })

    for (const [name, rpcResult] of [
        ['missing request', { nativeSessionId: 'thread-source' }],
        ['mismatched source id', { nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'other' } }],
        ['conflicting boundaries', {
            nativeSessionId: 'thread-source',
            codexForkRequest: { sourceThreadId: 'thread-source', lastTurnId: 'a', beforeTurnId: 'b' }
        }]
    ] as const) {
        it(`fails closed for ${name}`, async () => {
            const store = new Store(':memory:')
            const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            try {
                const source = engine.getOrCreateSession(`codex-${name}`, {
                    path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                    codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
                }, null, 'default')
                engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
                ;(engine as any).rpcGateway.forkConversation = async () => rpcResult
                let spawnCalls = 0
                ;(engine as any).rpcGateway.spawnSession = async () => {
                    spawnCalls += 1
                    return { type: 'success', sessionId: 'unexpected' }
                }

                expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
                expect(spawnCalls).toBe(0)
            } finally {
                engine.stop()
            }
        })
    }

    it('rejects Codex fork intent returned for another flavor', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('grok-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'grok',
                capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'grok-fork', codexForkRequest: { sourceThreadId: 'grok-fork' }
            })

            expect((await engine.forkConversation(source.id, 'default')).type).toBe('error')
        } finally {
            engine.stop()
        }
    })

    it('accepts only a distinct Codex id with the pending request removed', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const success = engine.getOrCreateSession('codex-bound', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-child'
            }, null, 'default')
            const pending = engine.getOrCreateSession('codex-pending', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-child',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            }, null, 'default')
            const same = engine.getOrCreateSession('codex-same', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source'
            }, null, 'default')
            engine.handleSessionAlive({ sid: success.id, time: Date.now(), mode: 'remote' })
            engine.handleSessionAlive({ sid: pending.id, time: Date.now(), mode: 'remote' })

            expect(await (engine as any).waitForCodexForkBound(success.id, 'thread-source', 5)).toBe(true)
            expect(await (engine as any).waitForCodexForkBound(pending.id, 'thread-source', 5)).toBe(false)
            expect(await (engine as any).waitForCodexForkBound(same.id, 'thread-source', 5)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('returns false when the Codex fork child becomes inactive', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const child = engine.getOrCreateSession('codex-inactive', {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'thread-source',
                codexForkRequest: { sourceThreadId: 'thread-source' }
            }, null, 'default')
            expect(await (engine as any).waitForCodexForkBound(child.id, 'thread-source', 5)).toBe(false)
        } finally {
            engine.stop()
        }
    })

    it('cleans up the child when Codex materialization does not bind', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const source = engine.getOrCreateSession('codex-cleanup-source', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'codex',
                codexSessionId: 'thread-source', capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            let pendingChildWasPublished = false
            engine.subscribe((event) => {
                if (event.type !== 'session-added') return
                const data = event.data as { metadata?: { forkedFrom?: string } } | undefined
                if (data?.metadata?.forkedFrom === source.id) {
                    pendingChildWasPublished = true
                }
            })
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
            })
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => ({ type: 'success', sessionId: args[12] })
            let pendingChildId: string | undefined
            ;(engine as any).waitForCodexForkBound = async () => {
                pendingChildId = engine.getSessions().find((session) => session.metadata?.forkedFrom === source.id)?.id
                if (!pendingChildId) throw new Error('pending child was not created')
                expect(pendingChildWasPublished).toBe(true)
                await expect(engine.sendMessage(pendingChildId, {
                    text: 'must not be accepted before materialization',
                    localId: 'premature-message'
                })).rejects.toThrow(/materializing/)
                expect(store.messages.getAllMessages(pendingChildId)).toEqual([])
                return false
            }
            ;(engine as any).rpcGateway.stopRunnerSession = async () => 'already_gone'

            const result = await engine.forkConversation(source.id, 'default')
            expect(result).toEqual({ type: 'error', message: 'Codex fork did not materialize before timeout' })
            expect(pendingChildId).toBeDefined()
            expect(engine.getSessions().filter((session) => session.metadata?.forkedFrom === source.id)).toEqual([])
        } finally {
            engine.stop()
        }
    })

    it('keeps the persisted source gate after failed cleanup and retries on a later tick', async () => {
        const { store, source, children: [child], emitted, start } = recoveryFixture()
        const scheduled = store.messages.addMessage(source.id, { role: 'user', content: 'scheduled' }, 'scheduled', Date.now() - 1)
        let now = Date.now()
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        const restarted = start()
        const state = recoveryState(restarted)
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession')
            .mockRejectedValue(new Error('runner unavailable'))
        try {
            await Bun.sleep(0)
            now += 61_000
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledTimes(1)
            await expect(restarted.sendMessage(source.id, { text: 'held' })).rejects.toThrow(/history action/)
            stop.mockResolvedValue('still_alive')
            state.expireInactive()
            now += 61_000
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledTimes(2)
            expect(restarted.getSession(child.id)).toBeDefined()
            await expect(restarted.switchSession(source.id, 'local')).rejects.toThrow(/history action/)
            stop.mockResolvedValue('already_gone')
            const deletion = spyOn(store.sessions, 'deleteSession').mockReturnValueOnce(false)
            state.expireInactive()
            now += 61_000
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledTimes(3)
            expect(store.sessions.getSession(child.id)).not.toBeNull()
            expect(store.messages.lookupQueuedMessage(source.id, scheduled.id).status).toBe('queued')
            expect(emitted).toEqual([])
            deletion.mockRestore()
            state.expireInactive()
            now += 61_000
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledTimes(4)
            expect(restarted.getSession(child.id)).toBeUndefined()
            expect(await restarted.rewindConversation(source.id, 'default', 'missing')).toEqual({
                type: 'error', message: 'Session must be active'
            })
            state.expireInactive()
            expect(emitted.map((update) => update.body.message?.localId)).toEqual(['scheduled'])
        } finally {
            restarted.stop()
            await Promise.all(state.codexForkRecoveryByChildId.values())
            clock.mockRestore()
        }
    })

    it('leaves a live fork in sole ownership of its child, then recovers its failed cleanup', async () => {
        const { source, start } = recoveryFixture(0)
        let now = Date.now()
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        const engine = start()
        const state = recoveryState(engine)
        engine.handleSessionAlive({ sid: source.id, time: now, mode: 'remote' })
        spyOn(state.rpcGateway, 'forkConversation').mockResolvedValue({
            nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' }
        })
        let finishSpawn!: (result: { type: 'error'; message: string }) => void
        let spawnStarted!: () => void
        const started = new Promise<void>((resolve) => { spawnStarted = resolve })
        spyOn(state.rpcGateway, 'spawnSession').mockImplementation(() => {
            spawnStarted()
            return new Promise((resolve) => { finishSpawn = resolve })
        })
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
        const fork = engine.forkConversation(source.id, 'default')
        try {
            await started
            const child = engine.getSessions().find((session) => session.metadata?.forkedFrom === source.id)
            if (!child) throw new Error('Missing live child')
            now += 61_000
            state.expireInactive()
            state.expireInactive()
            expect(state.codexForkRecoveryByChildId.size).toBe(0)
            expect(stop).not.toHaveBeenCalled()
            finishSpawn({ type: 'error', message: 'spawn reply lost' })
            expect(await fork).toMatchObject({ type: 'error', message: expect.stringMatching(/cleanup was not confirmed/) })
            expect(stop).toHaveBeenCalledTimes(1)
            await expect(engine.sendMessage(source.id, { text: 'held' })).rejects.toThrow(/history action/)
            stop.mockResolvedValue('stopped')
            state.expireInactive()
            state.expireInactive()
            now += 61_000
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledTimes(2)
            expect(engine.getSession(child.id)).toBeUndefined()
            await engine.sendMessage(source.id, { text: 'released' })
        } finally {
            engine.stop()
            await Promise.all(state.codexForkRecoveryByChildId.values())
            clock.mockRestore()
        }
    })

    it('blocks delivery across repeated restarts until every pending child binds', async () => {
        const { store, source, children, emitted, start, bind } = recoveryFixture(2)
        const scheduled = store.messages.addMessage(source.id, { role: 'user', content: 'scheduled' }, 'scheduled', Date.now() - 1)
        store.messages.addMessage(source.id, { role: 'user', content: 'replay' }, 'replay')
        const retry = store.messages.addMessage(source.id, { role: 'user', content: 'retry' }, 'retry')
        store.messages.setMessagesDeliveryState(source.id, ['retry'], 'indeterminate')
        const stopped = start()
        const staleWaiters = [...recoveryState(stopped).codexForkRecoveryByChildId.values()]
        const staleStop = spyOn(recoveryState(stopped).rpcGateway, 'stopRunnerSession')
        stopped.stop()
        const restarted = start()
        const state = recoveryState(restarted)
        const stop = spyOn(state.rpcGateway, 'stopRunnerSession')
        try {
            await Promise.all(staleWaiters)
            expect(staleStop).not.toHaveBeenCalled()
            for (const child of children) {
                await expect(restarted.sendMessage(source.id, { text: 'held' })).rejects.toThrow(/history action/)
                expect(await restarted.forkConversation(source.id, 'default')).toMatchObject({ type: 'error', message: expect.stringMatching(/history action/) })
                expect(await restarted.rewindConversation(source.id, 'default', 'missing')).toMatchObject({ type: 'error', message: expect.stringMatching(/history action/) })
                await expect(restarted.switchSession(source.id, 'local')).rejects.toThrow(/history action/)
                expect(await restarted.resumeSession(child.id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
                expect(await restarted.steerQueuedMessage(source.id, 'replay')).toMatchObject({ status: 'failed', error: expect.stringMatching(/history action/) })
                expect(await restarted.retryIndeterminateMessage(source.id, retry.id)).toEqual({ status: 'retry-unavailable', localId: 'retry' })
                restarted.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
                state.expireInactive()
                expect(state.messageService.releaseDeliverableQueuedMessages(source.id)).toBe(0)
                expect(restarted.getDeliverableMessagesAfter(source.id, { afterSeq: 0, limit: 200, now: Date.now() })).toEqual([])
                expect(emitted).toEqual([])
                expect(store.messages.lookupQueuedMessage(source.id, scheduled.id).status).toBe('queued')
                bind(child.id)
                restarted.handleSessionAlive({ sid: child.id, time: Date.now(), mode: 'remote' })
                await state.codexForkRecoveryByChildId.get(child.id)
            }
            expect(stop).not.toHaveBeenCalled()
            expect(restarted.getDeliverableMessagesAfter(source.id, { afterSeq: 0, limit: 200, now: Date.now() })
                .map((message) => message.localId)).toEqual(['scheduled', 'replay'])
            state.expireInactive()
            expect(emitted.map((update) => update.body.message?.localId)).toEqual(['scheduled'])
            restarted.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            expect(emitted.map((update) => update.body.message?.localId)).toEqual(['scheduled', 'replay'])
            await restarted.sendMessage(source.id, { text: 'released', localId: 'released' })
            expect(emitted.at(-1)?.body.message?.localId).toBe('released')
            expect(store.messages.lookupQueuedMessage(source.id, retry.id).status).toBe('indeterminate')
        } finally {
            restarted.stop()
            await Promise.all(state.codexForkRecoveryByChildId.values())
        }
    })

    it('rejects normal deletion of an inactive pending child before cleanup starts', async () => {
        const { store, children: [child], start } = recoveryFixture()
        const engine = start()
        try {
            await expect(engine.deleteSession(child.id)).rejects.toThrow(/termination/)
            expect(store.sessions.getSession(child.id)).not.toBeNull()
        } finally {
            engine.stop()
            await Promise.all(recoveryState(engine).codexForkRecoveryByChildId.values())
        }
    })

    it('does not create or spawn a child when the source fork RPC resolves after shutdown', async () => {
        const { source, start } = recoveryFixture(0)
        const engine = start()
        const state = recoveryState(engine)
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
        let finishFork!: (result: Awaited<ReturnType<RpcGateway['forkConversation']>>) => void
        spyOn(state.rpcGateway, 'forkConversation').mockImplementation(() => new Promise((resolve) => { finishFork = resolve }))
        const spawn = spyOn(state.rpcGateway, 'spawnSession').mockResolvedValue({ type: 'error', message: 'unexpected spawn' })
        const fork = engine.forkConversation(source.id, 'default')
        engine.stop()
        finishFork({ nativeSessionId: 'thread-source', codexForkRequest: { sourceThreadId: 'thread-source' } })
        expect(await fork).toMatchObject({ type: 'error', message: expect.stringMatching(/stopped/) })
        expect(spawn).not.toHaveBeenCalled()
        expect(engine.getSessions().map((session) => session.id)).toEqual([source.id])
    })

    it('keeps cleanup ownership across late binding, still_alive and restart until confirmed deletion', async () => {
        const { store, source, children: [child], emitted, start, bind } = recoveryFixture()
        let now = Date.now()
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        const first = start()
        let finishStop!: (status: 'still_alive') => void
        let stopStarted!: () => void
        const started = new Promise<void>((resolve) => { stopStarted = resolve })
        spyOn(recoveryState(first).rpcGateway, 'stopRunnerSession').mockImplementation(() => {
            stopStarted()
            return new Promise((resolve) => { finishStop = resolve })
        })
        const waiter = recoveryState(first).codexForkRecoveryByChildId.get(child.id)
        await Bun.sleep(0)
        now += 61_000
        let restarted: SyncEngine | undefined
        try {
            await started
            // A CLI bootstrap/binding write may omit every hub-owned fork field.
            const persisted = store.sessions.getSession(child.id)!
            expect(store.sessions.updateSessionMetadata(child.id, {
                path: '/tmp/project', host: 'localhost', flavor: 'codex', codexSessionId: 'late-bound'
            }, persisted.metadataVersion, persisted.namespace).result).toBe('success')
            first.handleSessionAlive({ sid: child.id, time: now, mode: 'remote' })
            await expect(first.sendMessage(child.id, { text: 'must not be accepted' })).rejects.toThrow(/history action/)
            await expect(first.sendMessage(source.id, { text: 'source held' })).rejects.toThrow(/history action/)
            expect(store.messages.getAllMessages(child.id)).toEqual([])
            finishStop('still_alive')
            await waiter
            first.handleSessionEnd({ sid: child.id, time: now, reason: 'error' })
            await expect(first.deleteSession(child.id)).rejects.toThrow(/termination/)
            first.stop()
            restarted = start()
            const state = recoveryState(restarted)
            const stop = spyOn(state.rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(stop).toHaveBeenCalledWith('machine-1', child.id)
            bind(child.id)
            await expect(restarted.sendMessage(child.id, { text: 'still held' })).rejects.toThrow(/history action/)
            await expect(restarted.deleteSession(child.id)).rejects.toThrow(/termination/)
            expect(emitted).toEqual([])
            stop.mockResolvedValue('stopped')
            state.expireInactive()
            await state.codexForkRecoveryByChildId.get(child.id)
            expect(store.sessions.getSession(child.id)).toBeNull()
            await restarted.sendMessage(source.id, { text: 'released' })
        } finally {
            first.stop()
            finishStop?.('still_alive')
            await waiter
            restarted?.stop()
            if (restarted) await Promise.all(recoveryState(restarted).codexForkRecoveryByChildId.values())
            clock.mockRestore()
        }
    })

    it('does not let a stopped recovery delete a child after its stop RPC completes', async () => {
        const { store, source, children: [child], start, bind } = recoveryFixture()
        let now = Date.now()
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        const first = start()
        let finishStop!: (status: 'stopped') => void
        let stopStarted!: () => void
        const started = new Promise<void>((resolve) => { stopStarted = resolve })
        spyOn(recoveryState(first).rpcGateway, 'stopRunnerSession').mockImplementation(() => {
            stopStarted()
            return new Promise((resolve) => { finishStop = resolve })
        })
        const waiter = recoveryState(first).codexForkRecoveryByChildId.get(child.id)
        await Bun.sleep(0)
        now += 61_000
        await started
        first.stop()
        const restarted = start()
        const stop = spyOn(recoveryState(restarted).rpcGateway, 'stopRunnerSession').mockResolvedValue('still_alive')
        try {
            bind(child.id)
            restarted.handleSessionAlive({ sid: child.id, time: now, mode: 'remote' })
            finishStop('stopped')
            await waiter
            await recoveryState(restarted).codexForkRecoveryByChildId.get(child.id)
            expect(store.sessions.getSession(child.id)).not.toBeNull()
            await expect(restarted.sendMessage(source.id, { text: 'held' })).rejects.toThrow(/history action/)
            stop.mockResolvedValue('stopped')
            recoveryState(restarted).expireInactive()
            await recoveryState(restarted).codexForkRecoveryByChildId.get(child.id)
            expect(store.sessions.getSession(child.id)).toBeNull()
            await restarted.sendMessage(source.id, { text: 'released' })
        } finally {
            restarted.stop()
            clock.mockRestore()
        }
    })
})
