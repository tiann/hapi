import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { Metadata, TodoItem } from '@hapi/protocol/types'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'

function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession('claude-rewind', {
        path: '/tmp', host: 'localhost', flavor: 'claude', claudeSessionId: 'native',
        capabilities: { conversationHistory: { rewindToMessage: true, forkCurrent: true } },
        conversationHistoryPoints: { boundary: true }
    }, null, 'default')
    engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
    store.messages.addMessage(session.id, { role: 'user', content: 'old' }, 'boundary')
    store.messages.markMessagesInvoked(session.id, ['boundary'], Date.now())
    return { store, engine, sid: session.id }
}

function applied(store: Store, sid: string) {
    const session = store.sessions.getSession(sid)!
    const metadata = session.metadata as Metadata
    return { version: session.metadataVersion, metadata: {
        ...metadata, claudeRewind: { ...metadata.claudeRewind!, phase: 'applied' as const,
            nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary' }
    } }
}

describe('durable Claude rewind', () => {
    it('blocks clear/new in every pending phase at the durable send layer while preserving normal input', async () => {
        for (const phase of ['requested', 'pending', 'applied', 'unknown', 'committed', 'rejected'] as const) {
            const { store, engine, sid } = setup()
            try {
                const current = store.sessions.getSession(sid)!
                store.sessions.updateSessionMetadata(sid, { ...(current.metadata as Metadata), claudeRewind: {
                    operationId: 'op', phase, requestedLocalId: 'boundary', cutoffSeq: 1
                } }, current.metadataVersion, 'default')
                const blocked = !['committed', 'rejected'].includes(phase)
                for (const text of ['/clear', ' /new ', '/clear arguments', '/new\nextra']) {
                    if (blocked) await expect(engine.sendMessage(sid, { text })).rejects.toThrow('while Claude rewind is pending')
                    else await engine.sendMessage(sid, { text })
                }
                if (blocked) expect(store.messages.getAllMessages(sid)).toHaveLength(1)
                await engine.sendMessage(sid, { text: 'continue the real next turn', localId: 'next-turn' })
                await engine.sendMessage(sid, { text: '/newspaper is not /new', localId: 'not-a-command' })
                expect(store.messages.getAllMessages(sid).some(row => row.localId === 'next-turn')).toBe(true)
                expect(store.messages.getAllMessages(sid).some(row => row.localId === 'not-a-command')).toBe(true)
            } finally { engine.stop() }
        }
    })

    for (const phase of ['unknown', 'rejected'] as const) {
        it(`settles a full ${phase} report before ACK without deleting messages and resists late RPC pending`, async () => {
            const { store, engine, sid } = setup()
            try {
                const handlers = new Map<string, (...args: any[]) => void>()
                registerSessionHandlers({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), to: () => ({ emit() {} }) } as never, {
                    store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(sid)! }), emitAccessError() {},
                    onClaudeRewindApplied: (id, metadata, version) => engine.commitClaudeRewind(id, metadata, version)
                })
                ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => {
                    const report = applied(store, sid)
                    const epoch = store.messages.getMessageEpoch(sid)
                    const bad = { ...report.metadata, claudeRewind: { ...report.metadata.claudeRewind, phase, nativeSessionId: 'other-native' } }
                    expect(engine.commitClaudeRewind(sid, bad, report.version).result).toBe('error')
                    const metadata = { ...report.metadata, claudeRewind: { ...report.metadata.claudeRewind, phase } }
                    handlers.get('update-metadata')!({ sid, expectedVersion: report.version - 1, metadata }, (ack: any) => expect(ack.result).toBe('version-mismatch'))
                    handlers.get('update-metadata')!({ sid, expectedVersion: report.version, metadata }, (ack: any) => {
                        expect(ack.result).toBe('success')
                        expect(ack.metadata.claudeRewind.phase).toBe(phase)
                        expect(ack.metadata.conversationHistoryDiverged === true).toBe(phase === 'unknown')
                        expect(store.messages.getAllMessages(sid)).toHaveLength(1)
                        expect(store.messages.getMessageEpoch(sid)).toBe(epoch)
                    })
                    return { success: false, outcome: 'pending', operationId: params.operationId,
                        nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary' }
                }
                expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
                expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe(phase)
                expect(store.messages.getAllMessages(sid)).toHaveLength(1)
                if (phase === 'unknown') expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
            } finally { engine.stop() }
        })
    }

    it('checks current native identity and prevents canonical boundaries after the requested row', async () => {
        const { store, engine, sid } = setup()
        try {
            store.messages.addMessage(sid, { role: 'user', content: 'later old row' }, 'later')
            store.messages.markMessagesInvoked(sid, ['later'], Date.now())
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'lost response' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const report = applied(store, sid)
            for (const phase of ['applied', 'unknown', 'rejected'] as const) {
                expect(engine.commitClaudeRewind(sid, { ...report.metadata, claudeRewind: {
                    ...report.metadata.claudeRewind, phase, nativeSessionId: 'other-native'
                } }, report.version).result).toBe('error')
                expect(engine.commitClaudeRewind(sid, { ...report.metadata, claudeRewind: {
                    ...report.metadata.claudeRewind, phase, truncateFromLocalId: 'later'
                } }, report.version).result).toBe('error')
            }
            expect(store.messages.getAllMessages(sid)).toHaveLength(2)
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({ conversationHistoryDiverged: true, claudeRewind: { phase: 'unknown' } })
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            const committed = applied(store, sid)
            for (const phase of ['unknown', 'rejected'] as const) {
                expect(engine.commitClaudeRewind(sid, { ...committed.metadata, claudeRewind: {
                    ...committed.metadata.claudeRewind, phase
                } }, committed.version).result).toBe('error')
            }
        } finally { engine.stop() }
    })

    it('wires applied metadata to a durable committed ACK and protects hub-owned phases', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => { throw new Error('lost response') }
            await engine.rewindConversation(sid, 'default', 'boundary')
            const handlers = new Map<string, (...args: any[]) => void>()
            registerSessionHandlers({
                on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn),
                to: () => ({ emit() {} })
            } as never, {
                store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(sid)! }),
                emitAccessError() {},
                onClaudeRewindApplied: (id, metadata, version) => engine.commitClaudeRewind(id, metadata, version)
            })
            const report = applied(store, sid)
            handlers.get('update-metadata')!({ sid, expectedVersion: report.version, metadata: {
                ...report.metadata, claudeRewind: { ...report.metadata.claudeRewind, phase: 'committed' }
            } }, (ack: any) => {
                expect(ack.metadata.claudeRewind.phase).toBe('unknown')
                expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            })
            const fresh = applied(store, sid)
            handlers.get('update-metadata')!({ sid, expectedVersion: fresh.version, metadata: fresh.metadata }, (ack: any) => {
                expect(ack.result).toBe('success')
                expect(ack.metadata.claudeRewind.phase).toBe('committed')
                expect(store.messages.getAllMessages(sid)).toHaveLength(0)
                expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe('committed')
            })
        } finally { engine.stop() }
    })

    it('reserves before RPC, preserves next turn and commits/re-ACKs exactly once', async () => {
        const { store, engine, sid } = setup()
        try {
            const events: any[] = []
            const publisher = (engine as any).eventPublisher
            const emit = publisher.emit.bind(publisher)
            publisher.emit = (event: unknown) => { events.push(event); emit(event) }
            ;(engine as any).rpcGateway.rewindConversation = async (_sid: string, params: { operationId: string; cutoffSeq: number }) => {
                expect(params.cutoffSeq).toBe(store.messages.getAllMessages(sid)[0]!.seq)
                expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind).toMatchObject({ phase: 'requested', operationId: params.operationId, cutoffSeq: params.cutoffSeq })
                return { success: false, outcome: 'pending', operationId: params.operationId,
                    nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary' }
            }
            expect(await engine.rewindConversation(sid, 'default', 'boundary')).toEqual({ type: 'success', pending: true })
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
            store.messages.addMessage(sid, { role: 'user', content: 'new' }, 'next-turn')
            const report = applied(store, sid)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            const committed = store.sessions.getSession(sid)!.metadata as Metadata
            expect(committed.claudeRewind?.phase).toBe('committed')
            expect(committed.conversationHistoryPoints).toBeUndefined()
            expect(store.messages.getAllMessages(sid).map(m => m.localId)).toEqual(['next-turn'])
            const epoch = store.messages.getMessageEpoch(sid)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            expect(store.messages.getMessageEpoch(sid)).toBe(epoch)
            expect(events.find(event => event.type === 'messages-invalidated')).toMatchObject({ namespace: 'default', sessionId: sid })
        } finally { engine.stop() }
    })

    it('accepts applied after loss of pending response, rejects mismatches and forged committed', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => { throw new Error('transport') }
            await engine.rewindConversation(sid, 'default', 'boundary')
            expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe('unknown')
            const report = applied(store, sid)
            const bad = { ...report.metadata, claudeRewind: { ...report.metadata.claudeRewind, operationId: 'forged' } }
            expect(engine.commitClaudeRewind(sid, bad, report.version).result).toBe('error')
            expect(engine.commitClaudeRewind(sid, { ...report.metadata, claudeRewind: { ...report.metadata.claudeRewind, phase: 'committed' } }, report.version).result).toBe('error')
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
        } finally { engine.stop() }
    })

    it('marks serialized RPC errors unknown, and explicit unchanged rejection safe', async () => {
        for (const safe of [false, true]) {
            const { store, engine, sid } = setup()
            try {
                ;(engine as any).rpcGateway.rewindConversation = async () => safe
                    ? { success: false, outcome: 'rejected', error: 'unchanged' } : { error: 'serialized failure' }
                expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
                const metadata = store.sessions.getSession(sid)!.metadata as Metadata
                expect(metadata.claudeRewind?.phase).toBe(safe ? 'rejected' : 'unknown')
                expect(metadata.conversationHistoryDiverged === true).toBe(!safe)
                expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            } finally { engine.stop() }
        }
    })

    it('never accepts applied proof for a rejected operation', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ success: false, outcome: 'rejected', error: 'unchanged' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const report = applied(store, sid)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('error')
            expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe('rejected')
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
        } finally { engine.stop() }
    })

    it('does not acknowledge pending when its native identity reservation fails to persist', async () => {
        const { store, engine, sid } = setup()
        const update = store.sessions.updateSessionMetadata.bind(store.sessions)
        try {
            ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => ({
                success: false, outcome: 'pending', operationId: params.operationId,
                nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary'
            })
            store.sessions.updateSessionMetadata = (...args) => (args[1] as Metadata)?.claudeRewind?.phase === 'pending'
                ? { result: 'error' } : update(...args)
            await expect(engine.rewindConversation(sid, 'default', 'boundary')).rejects.toThrow('Failed to persist rewind pending reservation')
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({ claudeRewind: { phase: 'requested' } })
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
        } finally { store.sessions.updateSessionMetadata = update; engine.stop() }
    })

    it('validates reserved pending identity and retries a full applied report after version mismatch', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => ({
                success: false, outcome: 'pending', operationId: params.operationId,
                nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary'
            })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const stale = applied(store, sid)
            for (const field of ['nativeSessionId', 'keepBoundary', 'truncateFromLocalId', 'requestedLocalId', 'operationId'] as const) {
                const bad = { ...stale.metadata, claudeRewind: { ...stale.metadata.claudeRewind, [field]: 'different' } }
                expect(engine.commitClaudeRewind(sid, bad, stale.version).result).toBe('error')
            }
            store.sessions.updateSessionMetadata(sid, { ...stale.metadata, name: 'concurrent title',
                claudeRewind: (store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind
            }, stale.version, 'default')
            const mismatch = engine.commitClaudeRewind(sid, stale.metadata, stale.version)
            expect(mismatch.result).toBe('version-mismatch')
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            const fresh = applied(store, sid)
            const ack = engine.commitClaudeRewind(sid, fresh.metadata, fresh.version)
            expect(ack.result).toBe('success')
            if (ack.result === 'success') expect(ack.value).toMatchObject({ name: 'concurrent title', claudeRewind: { phase: 'committed' } })
            expect(engine.commitClaudeRewind(sid, stale.metadata, stale.version).result).toBe('success')
        } finally { engine.stop() }
    })

    it('publishes cleaned locators and rebuilt todos only after the transaction commits', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'unknown' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const todos: TodoItem[] = [{ content: 'retained next-turn todo', status: 'pending', priority: 'high', id: 'todo' }]
            store.messages.addMessage(sid, { role: 'agent', content: {
                type: 'output', data: { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'TodoWrite', input: { todos } }] } }
            } }, 'next-todo')
            const current = store.sessions.getSession(sid)!
            store.sessions.updateSessionMetadata(sid, { ...(current.metadata as Metadata),
                conversationHistoryPoints: { boundary: true, 'next-todo': true },
                conversationHistoryIndexes: { boundary: 0, 'next-todo': 1 },
                conversationHistoryTurns: { boundary: 'old-turn', 'next-todo': 'next-turn' },
                conversationHistoryEntryIds: { boundary: 'old-entry', 'next-todo': 'next-entry' }
            }, current.metadataVersion, 'default')
            const events: any[] = []
            const publisher = (engine as any).eventPublisher
            const emit = publisher.emit.bind(publisher)
            publisher.emit = (event: unknown) => { events.push(event); emit(event) }
            const replace = store.sessions.replaceSessionTodos.bind(store.sessions)
            store.sessions.replaceSessionTodos = (...args) => {
                expect(events).toHaveLength(0)
                return replace(...args)
            }
            const report = applied(store, sid)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            const cached = engine.getSession(sid)!
            expect(cached.todos).toEqual(todos)
            expect(cached.metadata).toMatchObject({ claudeRewind: { phase: 'committed' },
                conversationHistoryPoints: { 'next-todo': true }, conversationHistoryIndexes: { 'next-todo': 1 },
                conversationHistoryTurns: { 'next-todo': 'next-turn' }, conversationHistoryEntryIds: { 'next-todo': 'next-entry' }
            })
            expect(cached.metadata?.conversationHistoryPoints?.boundary).toBeUndefined()
            expect(events.some(event => event.type === 'session-updated' && event.data?.metadata?.claudeRewind?.phase === 'committed')).toBe(true)
            expect(events.some(event => event.type === 'messages-invalidated')).toBe(true)
        } finally { engine.stop() }
    })

    it('rolls deletion and committed metadata back when post-delete cleanup fails', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'unknown' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const report = applied(store, sid)
            const events: any[] = []
            const publisher = (engine as any).eventPublisher
            const emit = publisher.emit.bind(publisher)
            publisher.emit = (event: unknown) => { events.push(event); emit(event) }
            const replace = store.sessions.replaceSessionTodos.bind(store.sessions)
            store.sessions.replaceSessionTodos = () => { throw new Error('crash boundary after metadata write') }
            const epoch = store.messages.getMessageEpoch(sid)
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('error')
            expect(store.messages.getMessageEpoch(sid)).toBe(epoch)
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({
                conversationHistoryDiverged: true, claudeRewind: { phase: 'unknown' }, conversationHistoryPoints: { boundary: true }
            })
            expect(events.some(event => event.type === 'messages-invalidated')).toBe(false)
            expect(events.some(event => event.data?.metadata?.claudeRewind?.phase === 'committed')).toBe(false)
            expect(engine.getSession(sid)?.metadata?.claudeRewind?.phase).toBe('unknown')
            store.sessions.replaceSessionTodos = replace
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({ conversationHistoryDiverged: false, claudeRewind: { phase: 'committed' } })
            expect(engine.getSession(sid)?.metadata?.claudeRewind?.phase).toBe('committed')
            expect(engine.getSession(sid)?.metadata?.conversationHistoryPoints).toBeUndefined()
            expect(events.some(event => event.type === 'messages-invalidated' && event.namespace === 'default')).toBe(true)
        } finally { engine.stop() }
    })

    for (const path of ['pending', 'serialized-error', 'transport-error'] as const) {
        it(`keeps prior committed ACK when completion precedes the ${path} RPC result`, async () => {
            const { store, engine, sid } = setup()
            try {
                ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string; cutoffSeq: number }) => {
                    expect(params.cutoffSeq).toBeNumber()
                    const report = applied(store, sid)
                    expect(report.metadata.claudeRewind.operationId).toBe(params.operationId)
                    expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
                    store.messages.addMessage(sid, { role: 'user', content: 'late next turn' }, 'late')
                    const epoch = store.messages.getMessageEpoch(sid)
                    const retry = engine.commitClaudeRewind(sid, report.metadata, report.version)
                    expect(retry.result).toBe('success')
                    if (retry.result === 'success') expect(retry.value).toMatchObject({ claudeRewind: { phase: 'committed' } })
                    expect(store.messages.getMessageEpoch(sid)).toBe(epoch)
                    if (path === 'transport-error') throw new Error('RPC disconnected after commit')
                    if (path === 'serialized-error') return { error: 'RPC response serialization failed' }
                    return { success: false, outcome: 'pending', operationId: params.operationId,
                        nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary' }
                }
                expect(await engine.rewindConversation(sid, 'default', 'boundary')).toEqual({ type: 'success' })
                expect(store.sessions.getSession(sid)!.metadata).toMatchObject({ conversationHistoryDiverged: false, claudeRewind: { phase: 'committed' } })
                expect(store.messages.getAllMessages(sid).map(m => m.localId)).toEqual(['late'])
            } finally { engine.stop() }
        })
    }
})
