import { describe, expect, it, spyOn } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession('opencode-rewind', { path: '/tmp/project', host: 'fixture', flavor: 'opencode',
        opencodeSessionId: 'native', opencodeWorkerId: 'worker', conversationHistoryIndexes: { one: 0, two: 1 },
        opencodeHistoryCheckpoint: { sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'], userMessageIds: ['u1', 'u2'], localMessageIds: [] },
        capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default')
    engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
    for (const [role, localId] of [['user', 'one'], ['agent', undefined], ['user', 'two'], ['agent', undefined]] as const) {
        store.messages.addMessage(session.id, { role, content: 'synthetic' }, localId)
        if (localId) store.messages.markMessagesInvoked(session.id, [localId], Date.now())
    }
    const version = () => store.sessions.getSession(session.id)!.metadataVersion
    return { store, engine, id: session.id, version }
}

describe('OpenCode durable Hub rewind commit', () => {
    it('reserves before RPC and atomically commits exact cutoff, metadata and epoch; replay cannot delete a new turn', async () => {
        const f = fixture(); let operation!: OpenCodeRewindOperation
        const checkpoint = { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                expect((f.store.sessions.getSession(f.id)!.metadata as any).opencodeRewind.operationId).toBe(operation.operationId)
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version())
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, f.version())
                return { success: true, truncateFromLocalId: 'two' }
            }
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toEqual({ type: 'success' })
            expect(f.store.messages.getAllMessages(f.id)).toHaveLength(2)
            const epoch = f.store.messages.getMessageEpoch(f.id)
            expect(epoch).toBe(1)
            f.store.messages.addMessage(f.id, { role: 'user', content: 'new turn' }, 'later')
            const replay = f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, 0)
            expect(replay.phase).toBe('committed')
            expect(f.store.messages.getAllMessages(f.id).at(-1)?.localId).toBe('later')
            expect(f.store.messages.getMessageEpoch(f.id)).toBe(epoch)
        } finally { f.engine.stop() }
    })

    it('preserves both histories on output/epoch change instead of applying a stale cutoff', async () => {
        const f = fixture()
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind
                const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version())
                f.store.messages.addMessage(f.id, { role: 'agent', content: 'late peer output' })
                expect(() => f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                    checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }, indexes: { one: 0 } }, f.version())).toThrow()
                return { success: false, outcome: 'unknown', error: 'conflict' }
            }
            expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
            expect(f.store.messages.getAllMessages(f.id)).toHaveLength(5)
            expect(f.store.messages.getMessageEpoch(f.id)).toBe(0)
            await expect(f.engine.sendMessage(f.id, { text: 'do not admit', localId: 'blocked' })).rejects.toThrow()
        } finally { f.engine.stop() }
    })

    it('retains durable admission locks after Hub reconstruction, independent of the volatile history set', async () => {
        const f = fixture(); let restarted: SyncEngine | undefined
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation: request.opencodeRewind, phase: 'unknown' }, f.version())
                throw new Error('CLI disconnected')
            }
            expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
            f.engine.stop()
            restarted = new SyncEngine(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            expect(restarted.getDeliverableMessagesAfter(f.id, { afterSeq: 0, limit: 100, now: Date.now() })).toEqual([])
            await expect(restarted.sendMessage(f.id, { text: 'blocked' })).rejects.toThrow('in progress')
            await expect(restarted.applySessionConfig(f.id, { model: 'blocked-model' })).rejects.toThrow('reconciliation')
            await expect(restarted.switchSession(f.id, 'local')).rejects.toThrow('reconciliation')
            expect(f.store.messages.getAllMessages(f.id)).toHaveLength(4)
        } finally { restarted?.stop(); f.engine.stop() }
    })

    it('rolls back deletion/epoch when metadata CAS fails and emits no premature invalidation', async () => {
        const f = fixture(); const invalidations: unknown[] = []
        const unsubscribe = f.engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event) })
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind; const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version())
                const failure = spyOn(f.store.sessions, 'updateSessionMetadata').mockReturnValue({ result: 'error' })
                try {
                    expect(() => f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                        checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }, indexes: { one: 0 } }, f.version())).toThrow('CAS failed')
                } finally { failure.mockRestore() }
                return { success: false, outcome: 'unknown', error: 'CAS failed' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect(f.store.messages.getAllMessages(f.id)).toHaveLength(4)
            expect(f.store.messages.getMessageEpoch(f.id)).toBe(0)
            expect(invalidations).toHaveLength(0)
        } finally { unsubscribe(); f.engine.stop() }
    })

    it('rejects namespace, operation identity and current-version mismatches before native completion', async () => {
        const f = fixture()
        try {
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                const operation = request.opencodeRewind; const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                expect(() => f.engine.reportOpenCodeRewind(f.id, 'other-namespace', { operation, phase: 'prepared', ...hashes }, f.version())).toThrow('access denied')
                expect(() => f.engine.reportOpenCodeRewind(f.id, 'default', { operation: { ...operation, cutoffSeq: 1 }, phase: 'prepared', ...hashes }, f.version())).toThrow('mismatch')
                expect(() => f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version() - 1)).toThrow('version changed')
                return { success: false, outcome: 'unknown', error: 'pending' }
            }
            await f.engine.rewindConversation(f.id, 'default', 'two')
            expect(f.store.messages.getAllMessages(f.id)).toHaveLength(4)
        } finally { f.engine.stop() }
    })
})
