import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('DSH conversation-history hub integration', () => {
    it('forks a DSH child with dshSessionId and exact-native bind', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('dsh-source', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-source-native',
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { local1: true, local2: true },
                conversationHistoryIndexes: { local1: 7, local2: 15 },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'one' }, 'local1')
            store.messages.addMessage(source.id, { role: 'user', content: 'two' }, 'local2')
            store.messages.markMessagesInvoked(source.id, ['local1', 'local2'], Date.now())

            ;(engine as any).rpcGateway.forkConversation = async () => {
                return { nativeSessionId: 'dsh-clone-native' }
            }
            let spawnArgs: unknown[] = []
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnArgs = args
                return { type: 'success', sessionId: args[12] }
            }
            const exactBinds: unknown[][] = []
            ;(engine as any).waitForExactNativeForkBound = async (...args: unknown[]) => {
                exactBinds.push(args)
                return true
            }
            let capturedChildMetadata: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    capturedChildMetadata = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            console.log('CHILD METADATA', JSON.stringify(capturedChildMetadata, null, 1))
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(capturedChildMetadata).toMatchObject({
                flavor: 'dsh',
                dshSessionId: 'dsh-clone-native',
                conversationHistoryPoints: { local1: true, local2: true },
                conversationHistoryIndexes: { local1: 7, local2: 15 },
            })
            expect(exactBinds).toEqual([[result.sessionId, 'dsh-clone-native', 'dshSessionId', true]])
            expect(spawnArgs[2]).toBe('dsh')
            // Child reuses the fork native id as the resume target.
            expect(spawnArgs[8]).toBe('dsh-clone-native')
        } finally {
            engine.stop()
        }
    })

    it('rewinds a DSH session by forking a child and archiving the source', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('dsh-rewind-src', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-rewind-native',
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { local1: true },
                conversationHistoryIndexes: { local1: 4 },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'anchor' }, 'local1')
            store.messages.markMessagesInvoked(source.id, ['local1'], Date.now())

            // Rewind RPC: DSH CLI acknowledges without native truncation.
            ;(engine as any).rpcGateway.rewindConversation = async () => {
                return { success: true, truncateFromLocalId: 'local1', messages: [] }
            }
            // Fork RPC: the hub archives the source and spawns the child.
            ;(engine as any).rpcGateway.forkConversation = async () => {
                return { nativeSessionId: 'dsh-rewind-child-native' }
            }
            let killedSessionId: string | null = null
            ;(engine as any).rpcGateway.killSession = async (sid: string) => {
                killedSessionId = sid
            }
            let spawnedChild = ''
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                spawnedChild = args[12] as string
                return { type: 'success', sessionId: args[12] }
            }
            ;(engine as any).waitForExactNativeForkBound = async () => true

            const result = await engine.rewindConversation(source.id, 'default', 'local1')
            expect(result.type).toBe('success')

            // Source archived with supersededBySessionId pointing at the child.
            const archived = (engine as any).sessionCache.refreshSession(source.id)!
            expect(archived.metadata?.archiveReason).toContain('Rewound')
            expect(archived.metadata?.supersededBySessionId).toEqual(spawnedChild)
            expect(killedSessionId === source.id).toBe(true)
            const child = engine.getSession(spawnedChild)
            expect((child?.metadata as Record<string, unknown> | undefined)?.dshSessionId).toBe('dsh-rewind-child-native')
        } finally {
            engine.stop()
        }
    })

    it('F1: seeds dshEventCursor on the child from the fork nativeCursor', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('dsh-f1-src', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-f1-native',
                capabilities: { conversationHistory: { forkCurrent: true } },
                conversationHistoryPoints: { local1: true },
                conversationHistoryIndexes: { local1: 3 },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'one' }, 'local1')
            store.messages.markMessagesInvoked(source.id, ['local1'], Date.now())

            ;(engine as any).rpcGateway.forkConversation = async () => {
                return { nativeSessionId: 'dsh-f1-child-native', nativeCursor: 42 }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                return { type: 'success', sessionId: args[12] }
            }
            ;(engine as any).waitForExactNativeForkBound = async () => true
            let captured: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    captured = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            expect(captured?.dshEventCursor).toBe(42)
        } finally {
            engine.stop()
        }
    })

    it('F2: fork without a nativeCursor leaves the child cursor unset', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('dsh-f2-src', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-f2-native',
                capabilities: { conversationHistory: { forkCurrent: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })

            ;(engine as any).rpcGateway.forkConversation = async () => {
                return { nativeSessionId: 'dsh-f2-child-native' }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                return { type: 'success', sessionId: args[12] }
            }
            ;(engine as any).waitForExactNativeForkBound = async () => true
            let captured: Record<string, unknown> | undefined
            const cache = (engine as any).sessionCache
            const originalCreate = cache.getOrCreateSession.bind(cache)
            cache.getOrCreateSession = (...args: unknown[]) => {
                if (typeof args[0] === 'string' && args[0].startsWith('fork:')) {
                    captured = args[1] as Record<string, unknown>
                }
                return originalCreate(...args)
            }

            const result = await engine.forkConversation(source.id, 'default')
            expect(result.type).toBe('success')
            expect((captured as Record<string, unknown>).dshEventCursor).toBeUndefined()
        } finally {
            engine.stop()
        }
    })

    it('F3: rewind archive CAS failure cleans up the live fork child', async () => {
        const { store, engine } = createEngine()
        try {
            const source = engine.getOrCreateSession('dsh-f3-src', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-f3-native',
                capabilities: { conversationHistory: { forkAtMessage: true, rewindToMessage: true } },
                conversationHistoryPoints: { local1: true },
                conversationHistoryIndexes: { local1: 4 },
            }, null, 'default')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(source.id, { role: 'user', content: 'anchor' }, 'local1')
            store.messages.markMessagesInvoked(source.id, ['local1'], Date.now())

            ;(engine as any).rpcGateway.rewindConversation = async () => {
                return { success: true, truncateFromLocalId: 'local1', messages: [] }
            }
            ;(engine as any).rpcGateway.forkConversation = async () => {
                return { nativeSessionId: 'dsh-f3-child-native' }
            }
            ;(engine as any).rpcGateway.killSession = async () => {}
            let cleanupChild: string | null = null
            ;(engine as any).cleanupFailedForkChild = async (childId: string) => {
                cleanupChild = childId
                return { type: 'success' }
            }
            ;(engine as any).rpcGateway.spawnSession = async (...args: unknown[]) => {
                return { type: 'success', sessionId: args[12] }
            }
            ;(engine as any).waitForExactNativeForkBound = async () => true
            // Force every archive CAS (supersededBySessionId write) to fail
            // with version-mismatch, on every retry attempt.
            const originalUpdate = store.sessions.updateSessionMetadata.bind(store.sessions)
            store.sessions.updateSessionMetadata = ((id: string, metadata: unknown, expectedVersion: number, namespace: string, opts?: unknown) => {
                const meta = metadata as { supersededBySessionId?: string }
                if (id === source.id && meta.supersededBySessionId) {
                    return { result: 'version-mismatch', version: 1, value: null }
                }
                return originalUpdate(id, metadata, expectedVersion, namespace, opts as never)
            }) as typeof store.sessions.updateSessionMetadata

            const result = await engine.rewindConversation(source.id, 'default', 'local1')
            expect(result.type).toBe('error')
            expect(cleanupChild).not.toBeNull()
        } finally {
            engine.stop()
        }
    })

    it('G1: resolveAgentResumeId resolves dshSessionId for DSH sessions', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('dsh-g1-src', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'dsh',
                dshSessionId: 'dsh-g1-native',
            }, null, 'default')
            const resolved = (engine as any).resolveAgentResumeId(session, 'default')
            expect(resolved).toBe('dsh-g1-native')
        } finally {
            engine.stop()
        }
    })
})
