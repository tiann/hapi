import { describe, expect, it, spyOn } from 'bun:test'
import type { Database } from 'bun:sqlite'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { OpenCodeRewindOperation } from '@hapi/protocol/schemas'

function fixture(searchable = false) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession('opencode-rewind', { path: '/tmp/project', host: 'fixture', flavor: 'opencode',
        opencodeSessionId: 'native', opencodeWorkerId: 'worker', conversationHistoryIndexes: { one: 0, two: 1 },
        opencodeHistoryCheckpoint: { sessionId: 'native', messageIds: ['u1', 'a1', 'u2', 'a2'], userMessageIds: ['u1', 'u2'], localMessageIds: [] },
        capabilities: { conversationHistory: { rewindToMessage: true } } }, null, 'default')
    engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
    for (const [role, localId, text] of [
        ['user', 'one', 'retainedprefix user'], ['agent', undefined, 'retainedprefix assistant'],
        ['user', 'two', 'removedsuffix user'], ['agent', undefined, 'removedsuffix assistant']
    ] as const) {
        const content = !searchable ? 'synthetic' : role === 'user'
            ? { type: 'text', text }
            : { type: 'codex', data: { type: 'message', id: text, message: text } }
        store.messages.addMessage(session.id, { role, content }, localId)
        if (localId) store.messages.markMessagesInvoked(session.id, [localId], Date.now())
    }
    const version = () => store.sessions.getSession(session.id)!.metadataVersion
    return { store, engine, id: session.id, version }
}

describe('OpenCode durable Hub rewind commit', () => {
    it('atomically removes only cutoff search rows before invalidation and preserves later rows on committed replay', async () => {
        const f = fixture(true)
        const rows = f.store.messages.getAllMessages(f.id)
        const db = (f.store as unknown as { db: Database }).db
        const invalidations: unknown[] = []
        const unsubscribe = f.engine.subscribe(event => {
            if (event.type === 'messages-invalidated') invalidations.push({
                inTransaction: db.inTransaction,
                phase: (f.store.sessions.getSession(f.id)!.metadata as any).opencodeRewind.phase,
                matches: f.store.messages.searchContent('removedsuffix', 'default')
            })
        })
        const checkpoint = { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] }
        const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
        let operation!: OpenCodeRewindOperation
        try {
            const prefixContext = f.engine.getMessageContext(f.id, rows[0]!.id)
            expect(prefixContext).not.toBeNull()
            expect(f.store.messages.searchContentInSession('removedsuffix', 'default', f.id).total).toBe(2)
            expect(f.store.messages.searchContentInSession('re', 'default', f.id).total).toBe(4)
            const prefixLookups = db.query('SELECT * FROM message_content_search_lookup WHERE target_message_id IN (?, ?) ORDER BY search_rowid')
                .all(rows[0]!.id, rows[1]!.id)
            const beforeRevision = f.store.sessions.getSession(f.id)!.contentRevision
            db.query(`UPDATE sessions SET manual_unread = 1, read_revision = (
                SELECT MAX(content_revision) FROM messages WHERE session_id = ? AND seq < 3
            ) WHERE id = ?`).run(f.id, f.id)
            const beforeRead = db.query('SELECT read_revision, content_revision, read_state_version FROM sessions WHERE id = ?')
                .get(f.id) as { read_revision: number; content_revision: number; read_state_version: number }
            expect(beforeRead.read_revision).toBeLessThan(beforeRead.content_revision)
            ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                operation = request.opencodeRewind
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version())
                f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, f.version())
                return { success: true, truncateFromLocalId: 'two' }
            }
            expect(await f.engine.rewindConversation(f.id, 'default', 'two')).toEqual({ type: 'success' })
            expect(f.store.messages.getAllMessages(f.id).map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id))
            expect(f.store.messages.searchContent('removedsuffix', 'default')).toEqual([])
            expect(f.store.messages.searchContentInSession('removedsuffix', 'default', f.id)).toMatchObject({ total: 0, matches: [] })
            expect(f.store.messages.searchContentInSession('re', 'default', f.id).matches.map(match => match.messageId).sort())
                .toEqual(rows.slice(0, 2).map(row => row.id).sort())
            expect(f.store.messages.searchContent('retainedprefix', 'default')).toHaveLength(1)
            expect(f.store.messages.searchContentInSession('retainedprefix', 'default', f.id).total).toBe(2)
            for (const row of rows.slice(2)) {
                expect(f.store.messages.getMessageById(f.id, row.id)).toBeNull()
                expect(f.engine.getMessageContext(f.id, row.id)).toBeNull()
                expect(db.query('SELECT * FROM message_content_search_lookup WHERE target_message_id = ? OR message_id = ?').all(row.id, row.id)).toEqual([])
            }
            expect(db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all()).toEqual(prefixLookups)
            expect(db.query('SELECT * FROM message_content_search_short WHERE search_rowid NOT IN (SELECT search_rowid FROM message_content_search_lookup)').all()).toEqual([])
            expect(db.query('SELECT rowid FROM message_content_search WHERE rowid NOT IN (SELECT search_rowid FROM message_content_search_lookup)').all()).toEqual([])
            expect(f.engine.getMessageContext(f.id, rows[0]!.id)?.messages.map(row => row.id)).toEqual(rows.slice(0, 2).map(row => row.id))
            expect(f.store.messages.getMessageEpoch(f.id)).toBe(1)
            expect(f.store.sessions.getSession(f.id)!.contentRevision).toBe(beforeRevision)
            expect(db.query('SELECT read_revision, content_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(f.id))
                .toEqual({ read_revision: beforeRead.content_revision, content_revision: beforeRead.content_revision,
                    read_state_version: beforeRead.read_state_version + 1, manual_unread: 1 })
            expect(invalidations).toEqual([{ inTransaction: false, phase: 'committed', matches: [] }])

            const later = f.store.messages.addMessage(f.id, { role: 'user', content: { type: 'text', text: 'latersearch' } }, 'later')
            f.store.messages.markMessagesInvoked(f.id, ['later'], Date.now())
            expect(later.seq).toBe(operation.cutoffSeq)
            const beforeReplay = f.store.messages.searchContentInSession('latersearch', 'default', f.id)
            const metadataVersion = f.version()
            const result = f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes, checkpoint, indexes: { one: 0 } }, 0)
            expect(result.phase).toBe('committed')
            expect(f.store.messages.getMessageById(f.id, later.id)).not.toBeNull()
            expect(f.store.messages.searchContentInSession('latersearch', 'default', f.id)).toEqual(beforeReplay)
            expect(beforeReplay.matches[0]?.messageId).toBe(later.id)
            expect(f.engine.getMessageContext(f.id, later.id)?.targetMessageId).toBe(later.id)
            expect(f.store.messages.getMessageEpoch(f.id)).toBe(1)
            expect(f.version()).toBe(metadataVersion)
            expect(invalidations).toHaveLength(1)
        } finally { unsubscribe(); f.engine.stop(); f.store.close() }
    })

    for (const failureAt of ['metadata CAS', 'search cleanup'] as const) {
        it(`rolls back transcript, every search table and read state when ${failureAt} fails`, async () => {
            const f = fixture(true)
            const db = (f.store as unknown as { db: Database }).db
            const invalidations: unknown[] = []
            let checkedRollback = false
            const unsubscribe = f.engine.subscribe(event => { if (event.type === 'messages-invalidated') invalidations.push(event) })
            const snapshot = () => ({
                rows: f.store.messages.getAllMessages(f.id),
                epoch: f.store.messages.getMessageEpoch(f.id),
                readState: db.query('SELECT content_revision, read_revision, read_state_version, manual_unread FROM sessions WHERE id = ?').get(f.id),
                fts: db.query('SELECT rowid, * FROM message_content_search ORDER BY rowid').all(),
                lookup: db.query('SELECT * FROM message_content_search_lookup ORDER BY search_rowid').all(),
                short: db.query('SELECT * FROM message_content_search_short ORDER BY gram, search_rowid').all(),
                global: f.store.messages.searchContent('removedsuffix', 'default'),
                inSession: f.store.messages.searchContentInSession('removedsuffix', 'default', f.id),
                shortSearch: f.store.messages.searchContentInSession('re', 'default', f.id)
            })
            try {
                ;(f.engine as any).rpcGateway.rewindConversation = async (_id: string, request: { opencodeRewind: OpenCodeRewindOperation }) => {
                    const operation = request.opencodeRewind
                    const hashes = { sourceHash: 'a'.repeat(64), prefixHash: 'b'.repeat(64) }
                    f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'prepared', ...hashes }, f.version())
                    const before = snapshot()
                    const failure = failureAt === 'metadata CAS'
                        ? spyOn(f.store.sessions, 'updateSessionMetadata').mockReturnValue({ result: 'error' }) : null
                    if (failureAt === 'search cleanup') db.exec(`
                        CREATE TRIGGER fail_rewind_search_cleanup BEFORE DELETE ON message_content_search_lookup
                        BEGIN SELECT RAISE(ABORT, 'forced search cleanup failure'); END;
                    `)
                    try {
                        expect(() => f.engine.reportOpenCodeRewind(f.id, 'default', { operation, phase: 'applied', ...hashes,
                            checkpoint: { sessionId: 'native', messageIds: ['u1', 'a1'], userMessageIds: ['u1'], localMessageIds: [] },
                            indexes: { one: 0 } }, f.version())).toThrow(failureAt === 'metadata CAS' ? 'CAS failed' : 'forced search cleanup failure')
                    } finally { failure?.mockRestore() }
                    expect(snapshot()).toEqual(before)
                    expect((f.store.sessions.getSession(f.id)!.metadata as any).opencodeRewind.phase).toBe('prepared')
                    expect(invalidations).toEqual([])
                    checkedRollback = true
                    return { success: false, outcome: 'unknown', error: failureAt }
                }
                expect((await f.engine.rewindConversation(f.id, 'default', 'two')).type).toBe('error')
                expect(checkedRollback).toBe(true)
                expect(f.store.messages.getAllMessages(f.id)).toHaveLength(4)
                expect(f.store.messages.searchContentInSession('removedsuffix', 'default', f.id).total).toBe(2)
            } finally { unsubscribe(); f.engine.stop(); f.store.close() }
        })
    }

    for (const rollback of [false, true]) {
        it(`invalidates injected-turn cache for the exact cutoff${rollback ? ' and lazily restores it after rollback' : ''}`, () => {
            const store = new Store(':memory:')
            const session = store.sessions.getOrCreateSession('rewind-cache', { path: '/tmp/project' }, null, 'default')
            const db = (store as unknown as { db: Database }).db
            const injected = (uuid: string) => ({ role: 'agent', content: { type: 'output', data: {
                type: 'user', uuid, message: { content: '<system-reminder>injected</system-reminder>' }
            } } })
            const sentinel = (parentUuid: string) => ({ role: 'agent', content: { type: 'output', data: {
                type: 'assistant', parentUuid, message: { content: [{ type: 'text', text: 'No response requested.' }] }
            } } })
            try {
                store.messages.addMessage(session.id, injected('retained-injected'))
                store.messages.addMessage(session.id, sentinel('retained-injected'))
                const cutoff = store.messages.addMessage(session.id, injected('removed-injected')).seq
                store.messages.addMessage(session.id, sentinel('removed-injected'))
                expect(store.messages.searchContent('No response requested', 'default')).toEqual([])
                if (rollback) {
                    expect(() => store.runInTransaction(() => {
                        store.messages.truncateOpenCodeRewind(session.id, cutoff)
                        throw new Error('rollback cache cleanup')
                    })).toThrow('rollback cache cleanup')
                    expect(store.messages.getAllMessages(session.id)).toHaveLength(4)
                    expect(store.messages.getMessageEpoch(session.id)).toBe(0)
                } else store.messages.truncateOpenCodeRewind(session.id, cutoff)
                store.messages.addMessage(session.id, sentinel('retained-injected'))
                const removedParentReply = store.messages.addMessage(session.id, sentinel('removed-injected'))
                const matches = store.messages.searchContentInSession('No response requested', 'default', session.id)
                expect(matches.matches.map(match => match.messageId)).toEqual(rollback ? [] : [removedParentReply.id])
                expect(matches.total).toBe(rollback ? 0 : 1)
                expect(db.inTransaction).toBe(false)
            } finally { store.close() }
        })
    }

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
