import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function fixture(flavor = 'codex') {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const source = engine.getOrCreateSession('source', {
        path: '/tmp/work', host: 'test', machineId: 'machine', flavor,
        capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
        conversationHistoryPoints: { retained: true, boundary: true },
        conversationHistoryTurns: { retained: 'turn-1', boundary: 'turn-2' }
    }, { controlledByUser: false }, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
    for (const id of ['retained', 'boundary', 'running']) {
        store.messages.addMessage(source.id, { role: 'user', content: id }, id)
        store.messages.markMessagesInvoked(source.id, [id], Date.now())
    }
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    return { store, engine, source, rpc }
}

describe('historical forks while the source runs', () => {
    it('copies only the historical prefix even when the source receives events during native fork', async () => {
        const { store, engine, source, rpc } = fixture()
        try {
            rpc.forkConversation = async (_id, payload) => {
                expect(payload).toEqual({ messageLocalId: 'boundary' })
                store.messages.addMessage(source.id, { role: 'assistant', content: 'new streaming event' }, 'late')
                store.messages.markMessagesInvoked(source.id, ['late'], Date.now())
                return { nativeSessionId: 'child-native' }
            }
            rpc.spawnSession = async (...args) => ({ type: 'success', sessionId: args[12]! })
            const result = await engine.forkConversation(source.id, 'default', 'boundary')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(store.messages.getAllMessages(result.sessionId).map(row => row.localId)).toEqual(['retained'])
            expect(engine.getSession(result.sessionId)?.metadata?.conversationHistoryTurns).toEqual({ retained: 'turn-1' })
            expect(engine.getSession(source.id)?.thinking).toBe(true)
            expect(store.messages.getAllMessages(source.id)).toHaveLength(4)
        } finally { engine.stop() }
    })

    for (const flavor of ['claude', 'pi', 'grok', 'agy', 'dsh']) {
        it(`retains the busy guard for ${flavor}`, async () => {
            const { engine, source } = fixture(flavor)
            try {
                expect(await engine.forkConversation(source.id, 'default', 'boundary'))
                    .toEqual({ type: 'error', message: 'Session is busy' })
            } finally { engine.stop() }
        })
    }

    it('rejects stale boundaries and concurrent history actions before another native mutation', async () => {
        const { engine, source, rpc } = fixture()
        try {
            expect(await engine.forkConversation(source.id, 'default', 'missing')).toMatchObject({ type: 'error' })
            expect(await engine.forkConversation(source.id, 'other', 'boundary')).toMatchObject({ type: 'error' })
            let release!: () => void
            rpc.forkConversation = async () => {
                await new Promise<void>(resolve => { release = resolve })
                throw new Error('native fork rejected')
            }
            const pending = engine.forkConversation(source.id, 'default', 'boundary')
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toEqual({
                type: 'error', message: 'Conversation history action already in progress'
            })
            release()
            expect(await pending).toEqual({ type: 'error', message: 'native fork rejected' })
            expect(engine.getSession(source.id)?.thinking).toBe(true)
        } finally { engine.stop() }
    })

    it('retains diverged-history and capability checks for a running Codex source', async () => {
        const { store, engine, source, rpc } = fixture()
        try {
            let calls = 0
            rpc.forkConversation = async () => { calls++; return { nativeSessionId: 'unused' } }
            const update = (more: Record<string, unknown>) => {
                const current = store.sessions.getSession(source.id)!
                store.sessions.updateSessionMetadata(source.id, { ...current.metadata as Record<string, unknown>, ...more },
                    current.metadataVersion, 'default', { touchUpdatedAt: false })
                ;(engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(source.id)
            }
            update({ conversationHistoryDiverged: true })
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toEqual({
                type: 'error', message: 'Conversation history is diverged; refuse further fork/rewind'
            })
            update({ conversationHistoryDiverged: false, capabilities: {} })
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toEqual({
                type: 'error', message: 'Historical fork is not supported for this session'
            })
            expect(calls).toBe(0)
        } finally { engine.stop() }
    })
})

describe('opencode fork-at-message exclusive boundary', () => {
    it('pins the copied hub prefix to the native before-boundary user message', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const source = engine.getOrCreateSession('source', {
            path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'opencode',
            capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true, rewindToMessage: true } },
            conversationHistoryPoints: { first: true, second: true },
            conversationHistoryIndexes: { first: 0, second: 1 },
            opencodeHistoryCheckpoint: { sessionId: 'acp-1', messageIds: ['n_first', 'n_a1', 'n_second'], userMessageIds: ['n_first', 'n_second'], localMessageIds: [] }
        }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
        for (const id of ['first', 'second']) {
            store.messages.addMessage(source.id, { role: 'user', content: id }, id)
            store.messages.markMessagesInvoked(source.id, [id], Date.now())
        }
        const checkpoint = source.metadata!.opencodeHistoryCheckpoint!
        const indexes = source.metadata!.conversationHistoryIndexes!
        const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
        try {
            let requestedBefore: string | undefined
            rpc.forkConversation = async (_id, payload) => {
                expect(payload).toEqual({ messageLocalId: 'second' })
                // The CLI forks at the native user message identified by the
                // boundary's index; the copied prefix must end before it.
                requestedBefore = checkpoint.userMessageIds[indexes.second]
                expect(requestedBefore).toBe('n_second')
                return { nativeSessionId: 'child-native',
                    opencodeHistoryCheckpoint: { sessionId: 'child-native', messageIds: ['n_first'], userMessageIds: ['n_first'], localMessageIds: [] } }
            }
            rpc.spawnSession = async (...args) => {
                const childId = args[12]!
                const resumeNative = args[8]!
                const current = store.sessions.getSession(childId)!
                store.sessions.updateSessionMetadata(childId,
                    { ...current.metadata as Record<string, unknown>, opencodeSessionId: resumeNative },
                    current.metadataVersion, 'default', { touchUpdatedAt: false })
                ;(engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(childId)
                engine.handleSessionAlive({ sid: childId, time: Date.now(), mode: 'remote' })
                engine.handleSessionReady({ sid: childId, time: Date.now() })
                return { type: 'success', sessionId: childId }
            }
            const result = await engine.forkConversation(source.id, 'default', 'second')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            // The child's copied hub transcript ends exactly before the forked
            // prompt: its last user localId is the prompt before the boundary,
            // and the child's native checkpoint holds exactly the user messages
            // preceding the native `before` id — the same exclusive boundary.
            const copiedUsers = store.messages.getAllMessages(result.sessionId)
                .filter(row => (row.content as { role?: string } | null)?.role === 'user').map(row => row.localId)
            expect(copiedUsers).toEqual(['first'])
            const nativeBeforePrevious = checkpoint.userMessageIds[indexes.second - 1]
            expect(nativeBeforePrevious).toBe('n_first')
            const child = engine.getSession(result.sessionId)
            expect(child?.metadata?.opencodeHistoryCheckpoint?.userMessageIds).toEqual([nativeBeforePrevious])
            expect(child?.metadata?.opencodeSessionId).toBe('child-native')
            expect(requestedBefore).toBe('n_second')
        } finally { engine.stop() }
    })
})

describe('latest completed mode admission', () => {
    it('fails closed for old Runner capabilities and non-Codex sessions', async () => {
        const { engine, source, rpc } = fixture();
        try {
            let calls = 0;
            rpc.forkConversation = async () => { calls++; return { nativeSessionId: 'unused' }; };
            expect(await engine.forkConversation(source.id, 'default', undefined, true)).toMatchObject({ type: 'error' });
            expect(calls).toBe(0);
        } finally { engine.stop(); }
    });
    it('requires a verified shared child rather than copying a moving source tail', async () => {
        const { engine, store, source, rpc } = fixture();
        try {
            const current = store.sessions.getSession(source.id)!;
            store.sessions.updateSessionMetadata(source.id, { ...current.metadata as object,
                capabilities: { conversationHistory: { forkCurrent: true, forkLatestCompleted: true } } }, current.metadataVersion, 'default');
            (engine as any).sessionCache.refreshSession(source.id);
            rpc.forkConversation = async (_id, payload) => {
                expect(payload).toEqual({ latestCompleted: true });
                return { nativeSessionId: 'unverified' };
            };
            expect(await engine.forkConversation(source.id, 'default', undefined, true)).toEqual({
                type: 'error', message: 'Runner did not verify the completed-turn fork boundary'
            });
            expect(engine.getSession(source.id)?.thinking).toBe(true);
        } finally { engine.stop(); }
    });
});
