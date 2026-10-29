import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { Metadata, TodoItem } from '@hapi/protocol/types'
import { registerSessionHandlers } from '../socket/handlers/cli/sessionHandlers'
import { Hono } from 'hono'
import { createMessagesRoutes } from '../web/routes/messages'
import type { WebAppEnv } from '../web/middleware/auth'
import { RpcTargetMissingError } from './rpcGateway'

function setup() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, { of: () => ({ adapter: { rooms: new Map() }, to: () => ({ emit() {} }) }) } as never, new RpcRegistry(), { broadcast() {} } as never)
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
    it('cannot erase persisted unknown through a null or non-object ordinary metadata write', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'serialized error' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const before = store.sessions.getSession(sid)!
            const rows = store.messages.getAllMessages(sid)
            const handlers = new Map<string, (...args: any[]) => void>()
            registerSessionHandlers({ on: (event: string, handler: (...args: any[]) => void) => handlers.set(event, handler), to: () => ({ emit() {} }) } as never, {
                store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(sid)! }), emitAccessError() {},
                onClaudeRewindApplied: (id, metadata, version) => engine.commitClaudeRewind(id, metadata, version)
            })
            for (const metadata of [null, [], 'reset', 0]) {
                let ack: any
                handlers.get('update-metadata')!({ sid, expectedVersion: before.metadataVersion, metadata }, (result: unknown) => { ack = result })
                expect(ack.result).toBe('error')
                expect(store.sessions.getSession(sid)!.metadata).toEqual(before.metadata)
                expect(store.sessions.getSession(sid)!.metadataVersion).toBe(before.metadataVersion)
                expect(store.messages.getAllMessages(sid)).toEqual(rows)
            }
        } finally { engine.stop() }
    })

    it('cannot reconcile serialized-error unknown with late exact rejection, only same-op applied proof', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'serialized error' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const before = store.sessions.getSession(sid)!
            const rows = store.messages.getAllMessages(sid)
            const report = applied(store, sid)
            const rejected = { ...report.metadata, conversationHistoryDiverged: false,
                claudeRewind: { ...report.metadata.claudeRewind, phase: 'rejected' as const } }
            const events: any[] = []
            const publisher = (engine as any).eventPublisher
            const emit = publisher.emit.bind(publisher)
            publisher.emit = (event: unknown) => { events.push(event); emit(event) }
            expect(engine.commitClaudeRewind(sid, rejected, report.version).result).toBe('error')
            expect(store.sessions.getSession(sid)!.metadata).toEqual(before.metadata)
            expect(store.sessions.getSession(sid)!.metadataVersion).toBe(before.metadataVersion)
            expect(store.messages.getAllMessages(sid)).toEqual(rows)
            expect(events.some(event => event.type === 'messages-invalidated')).toBe(false)
            await expect(engine.switchSession(sid, 'local')).rejects.toThrow('rewind is pending')
            expect(await engine.rewindConversation(sid, 'default', 'boundary')).toMatchObject({ type: 'error' })
            expect(engine.commitClaudeRewind(sid, report.metadata, report.version).result).toBe('success')
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({
                claudeRewind: { operationId: report.metadata.claudeRewind.operationId, phase: 'committed' }, conversationHistoryDiverged: false
            })
            expect(events.some(event => event.type === 'messages-invalidated' && event.namespace === 'default')).toBe(true)
        } finally { engine.stop() }
    })

    for (const phase of ['unknown', 'rejected', 'applied', 'committed'] as const) {
        it(`preserves durable ${phase} across every late RPC result or error`, async () => {
            for (const path of ['pending', 'serialized-error', 'rejected', 'success', 'transport-error', 'target-missing'] as const) {
                const { store, engine, sid } = setup()
                try {
                    let before: unknown
                    let rows: ReturnType<Store['messages']['getAllMessages']> = []
                    ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => {
                        const report = applied(store, sid)
                        if (phase === 'applied') {
                            expect(store.sessions.updateSessionMetadata(sid, report.metadata, report.version, 'default').result).toBe('success')
                        } else {
                            const proof = { ...report.metadata, claudeRewind: {
                                ...report.metadata.claudeRewind, phase: phase === 'committed' ? 'applied' as const : phase
                            } }
                            expect(engine.commitClaudeRewind(sid, proof, report.version).result).toBe('success')
                        }
                        before = store.sessions.getSession(sid)!.metadata
                        rows = store.messages.getAllMessages(sid)
                        if (path === 'transport-error') throw new Error('late disconnect')
                        if (path === 'target-missing') throw new RpcTargetMissingError('rewind', 'handler-not-registered')
                        if (path === 'serialized-error') return { error: 'late serialized error' }
                        if (path === 'rejected') return { success: false, outcome: 'rejected', error: 'late native rejection' }
                        if (path === 'success') return { success: true, truncateFromLocalId: 'boundary' }
                        return { success: false, outcome: 'pending', operationId: params.operationId,
                            nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary' }
                    }
                    const result = await engine.rewindConversation(sid, 'default', 'boundary')
                    expect(result.type).toBe(['applied', 'committed'].includes(phase) ? 'success' : 'error')
                    expect(store.sessions.getSession(sid)!.metadata).toEqual(before)
                    expect(store.messages.getAllMessages(sid)).toEqual(rows)
                } finally { engine.stop() }
            }
        })
    }

    for (const alreadyInvoked of [false, true]) {
        it(`reports offline staged-Q withdrawal authoritatively (consumed before crash: ${alreadyInvoked})`, async () => {
            const { store, engine, sid } = setup()
            try {
                ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => ({
                    success: false, outcome: 'pending', operationId: params.operationId,
                    nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary'
                })
                expect(await engine.rewindConversation(sid, 'default', 'boundary')).toEqual({ type: 'success', pending: true })
                await engine.sendMessage(sid, { text: 'staged Q not yet written to native', localId: 'staged-q' })
                const handlers = new Map<string, (...args: any[]) => void>()
                const consumed: string[][] = []
                registerSessionHandlers({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), to: () => ({ emit() {} }) } as never, {
                    store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSessionByNamespace(sid, 'default')! }), emitAccessError() {},
                    onSessionActivity: (id, at) => engine.recordSessionActivity(id, at),
                    onWebappEvent: event => { if (event.type === 'messages-consumed') consumed.push(event.localIds) }
                })
                const confirm = (localIds: string[]) => {
                    let ack: unknown
                    handlers.get('messages-consumed')!({ sid, localIds }, (result: unknown) => { ack = result })
                    return ack
                }
                if (alreadyInvoked) expect(confirm(['staged-q'])).toEqual({ ok: true })
                // The mock CLI room is empty, representing death before (or
                // after, in the control case) the original consumption ACK.
                const app = new Hono<WebAppEnv>()
                app.use('*', async (c, next) => { c.set('namespace', 'default'); await next() })
                app.route('/api', createMessagesRoutes(() => engine))
                const row = store.messages.getAllMessages(sid).find(message => message.localId === 'staged-q')!
                const cancelled = await app.request(`/api/sessions/${sid}/messages/${row.id}`, { method: 'DELETE' })
                expect(cancelled.status).toBe(200)
                expect(await cancelled.json()).toMatchObject({ status: alreadyInvoked ? 'invoked' : 'cancelled' })
                await engine.sendMessage(sid, { text: 'remaining/new R', localId: 'remaining-r' })
                const before = store.messages.getAllMessages(sid)
                const count = consumed.length
                if (alreadyInvoked) {
                    expect(confirm(['staged-q'])).toEqual({ ok: true })
                    expect(store.messages.getAllMessages(sid).find(message => message.localId === 'staged-q')!.invokedAt).not.toBeNull()
                } else {
                    expect(confirm(['staged-q'])).toEqual({ ok: false, missingLocalIds: ['staged-q'] })
                    expect(confirm(['staged-q', 'remaining-r'])).toEqual({ ok: false, missingLocalIds: ['staged-q'] })
                    expect(store.messages.getAllMessages(sid)).toEqual(before)
                    expect(consumed.length).toBe(count)
                    expect(confirm(['remaining-r'])).toEqual({ ok: true })
                    expect(store.messages.getAllMessages(sid).some(message => message.localId === 'staged-q')).toBe(false)
                    expect(consumed.slice(count)).toEqual([['remaining-r']])
                }
                expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe('pending')
            } finally { engine.stop() }
        })
    }

    it('blocks terminal remote-to-local handoff from durable pending state without an in-flight lock', async () => {
        const { store, engine, sid } = setup()
        try {
            const calls: string[] = []
            ;(engine as any).rpcGateway.switchSession = async (_sid: string, to: string) => { calls.push(to) }
            for (const phase of ['requested', 'pending', 'applied', 'unknown', 'committed', 'rejected'] as const) {
                const current = store.sessions.getSession(sid)!
                store.sessions.updateSessionMetadata(sid, { ...(current.metadata as Metadata), startedBy: 'terminal', claudeRewind: {
                    operationId: 'op', phase, requestedLocalId: 'boundary', cutoffSeq: 1
                } }, current.metadataVersion, 'default')
                expect((engine as any).historyActionsInFlight.has(sid)).toBe(false)
                const before = calls.length
                if (['committed', 'rejected'].includes(phase)) {
                    await engine.switchSession(sid, 'local')
                    expect(calls.slice(before)).toEqual(['local'])
                } else {
                    await expect(engine.switchSession(sid, 'local')).rejects.toThrow('while Claude rewind is pending')
                    expect(calls.length).toBe(before)
                }
                await engine.switchSession(sid, 'remote')
                expect(calls.at(-1)).toBe('remote')
            }
        } finally { engine.stop() }
    })

    it('allows a rejected -> clear/new native ID update through ordinary metadata CAS', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async (_: string, params: { operationId: string }) => ({
                success: false, outcome: 'pending', operationId: params.operationId,
                nativeSessionId: 'native', keepBoundary: 'uuid', truncateFromLocalId: 'boundary'
            })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const proof = applied(store, sid)
            expect(engine.commitClaudeRewind(sid, { ...proof.metadata, claudeRewind: {
                ...proof.metadata.claudeRewind, phase: 'rejected'
            } }, proof.version).result).toBe('success')
            const handlers = new Map<string, (...args: any[]) => void>()
            let proofCalls = 0
            registerSessionHandlers({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), to: () => ({ emit() {} }) } as never, {
                store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(sid)! }), emitAccessError() {},
                onClaudeRewindApplied: (id, metadata, version) => { proofCalls++; return engine.commitClaudeRewind(id, metadata, version) }
            })
            await engine.sendMessage(sid, { text: '/clear', localId: 'clear-after-rejection' })
            const current = store.sessions.getSession(sid)!
            const metadata = current.metadata as Metadata
            // Reordering JSON properties must not turn an unchanged marker into proof.
            const carried = Object.fromEntries(Object.entries(metadata.claudeRewind!).reverse())
            const update = { ...metadata, claudeSessionId: 'new-native-after-clear', claudeRewind: carried,
                conversationHistoryPoints: {}, conversationHistoryEntryIds: {} }
            const send = (expectedVersion: number) => {
                let ack: any
                handlers.get('update-metadata')!({ sid, expectedVersion, metadata: update }, (result: any) => { ack = result })
                return ack
            }
            expect(send(current.metadataVersion - 1).result).toBe('version-mismatch')
            expect(send(current.metadataVersion)).toMatchObject({ result: 'success', metadata: {
                claudeSessionId: 'new-native-after-clear', claudeRewind: metadata.claudeRewind
            } })
            expect(proofCalls).toBe(0)
            expect(store.sessions.getSession(sid)!.metadata).toMatchObject({ claudeSessionId: 'new-native-after-clear', claudeRewind: metadata.claudeRewind })
            expect((store.sessions.getSession(sid)!.metadata as Metadata).conversationHistoryPoints).toEqual({})
            expect((store.sessions.getSession(sid)!.metadata as Metadata).conversationHistoryEntryIds).toEqual({})
            await engine.sendMessage(sid, { text: '/new', localId: 'new-after-rejection' })
            const afterNew = store.sessions.getSession(sid)!
            let newAck: any
            handlers.get('update-metadata')!({ sid, expectedVersion: afterNew.metadataVersion, metadata: {
                ...(afterNew.metadata as Metadata), claudeSessionId: 'new-native-after-new'
            } }, (result: any) => { newAck = result })
            expect(newAck).toMatchObject({ result: 'success', metadata: { claudeSessionId: 'new-native-after-new', claudeRewind: metadata.claudeRewind } })
            expect(proofCalls).toBe(0)
            expect(store.messages.getAllMessages(sid)).toHaveLength(3)
        } finally { engine.stop() }
    })

    it('allows unchanged unknown metadata echoes but validates changed reports and re-ACKs explicit applied retries', async () => {
        const { store, engine, sid } = setup()
        try {
            ;(engine as any).rpcGateway.rewindConversation = async () => ({ error: 'lost response' })
            await engine.rewindConversation(sid, 'default', 'boundary')
            const events: any[] = []
            const publisher = (engine as any).eventPublisher
            const emit = publisher.emit.bind(publisher)
            publisher.emit = (event: unknown) => { events.push(event); emit(event) }
            const handlers = new Map<string, (...args: any[]) => void>()
            let proofCalls = 0
            registerSessionHandlers({ on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn), to: () => ({ emit() {} }) } as never, {
                store, resolveSessionAccess: () => ({ ok: true, value: store.sessions.getSession(sid)! }), emitAccessError() {},
                onClaudeRewindApplied: (id, metadata, version) => { proofCalls++; return engine.commitClaudeRewind(id, metadata, version) }
            })
            const send = (metadata: unknown, expectedVersion = store.sessions.getSession(sid)!.metadataVersion) => {
                let ack: any
                handlers.get('update-metadata')!({ sid, expectedVersion, metadata }, (result: any) => { ack = result })
                return ack
            }
            const current = store.sessions.getSession(sid)!
            const metadata = current.metadata as Metadata
            // Hub-created unknown may lack journal identity. Merely carrying it
            // must not make unrelated updates enter an impossible retry loop.
            const echo = { ...metadata, name: 'ordinary update', conversationHistoryDiverged: false,
                conversationHistoryPoints: { forged: true }, conversationHistoryIndexes: { forged: 7 },
                conversationHistoryTurns: { forged: 'turn' }, conversationHistoryEntryIds: { forged: 'entry' } }
            expect(send(echo, current.metadataVersion - 1).result).toBe('version-mismatch')
            const echoAck = send(echo)
            expect(echoAck).toMatchObject({ result: 'success', metadata: {
                name: 'ordinary update', claudeRewind: metadata.claudeRewind, conversationHistoryDiverged: true,
                conversationHistoryPoints: { boundary: true }
            } })
            expect(echoAck.metadata.conversationHistoryIndexes).toBeUndefined()
            expect(echoAck.metadata.conversationHistoryTurns).toBeUndefined()
            expect(echoAck.metadata.conversationHistoryEntryIds).toBeUndefined()
            expect(proofCalls).toBe(0)
            const { claudeRewind: _omitted, ...sparse } = echo
            const omittedAck = send({ ...sparse, name: 'omitted marker update' })
            expect(omittedAck).toMatchObject({ result: 'success', metadata: {
                name: 'omitted marker update', claudeRewind: metadata.claudeRewind,
                conversationHistoryDiverged: true, conversationHistoryPoints: { boundary: true }
            } })
            expect(omittedAck.metadata.conversationHistoryIndexes).toBeUndefined()
            expect(proofCalls).toBe(0)
            // Old pending snapshots refresh before being interpreted as new
            // proof, then the exact unknown echo can advance unrelated fields.
            const stalePending = { ...echo, claudeRewind: { ...metadata.claudeRewind!, phase: 'pending' } }
            const refresh = send(stalePending, current.metadataVersion)
            expect(refresh).toMatchObject({ result: 'version-mismatch', metadata: { claudeRewind: { phase: 'unknown' }, conversationHistoryDiverged: true } })
            expect(send({ ...refresh.metadata, name: 'after refresh' }, refresh.version).result).toBe('success')
            expect(proofCalls).toBe(0)
            expect(send({ ...metadata, claudeRewind: { ...metadata.claudeRewind!, nativeSessionId: undefined } }).result).toBe('error')
            const proof = applied(store, sid)
            expect(send({ ...proof.metadata, claudeRewind: { ...proof.metadata.claudeRewind, phase: 'unknown', operationId: 'forged' } }).result).toBe('error')
            expect(send({ ...proof.metadata, claudeRewind: { ...proof.metadata.claudeRewind, phase: 'unknown', keepBoundary: 'changed', cutoffSeq: 999 } }).result).toBe('error')
            for (const phase of ['pending', 'requested', 'rejected'] as const) {
                expect(send({ ...echo, claudeRewind: { ...metadata.claudeRewind!, phase } }).result).toBe('error')
            }
            expect(send({ ...echo, claudeRewind: null }).result).toBe('error')
            const forged = send({ ...proof.metadata, claudeRewind: { ...proof.metadata.claudeRewind, phase: 'committed' } })
            expect(forged.result).toBe('error')
            expect(store.messages.getAllMessages(sid)).toHaveLength(1)
            expect(events.some(event => event.type === 'messages-invalidated')).toBe(false)
            const fresh = applied(store, sid)
            expect(send(fresh.metadata, fresh.version).metadata.claudeRewind.phase).toBe('committed')
            const epoch = store.messages.getMessageEpoch(sid)
            const version = store.sessions.getSession(sid)!.metadataVersion
            expect(send(fresh.metadata, fresh.version)).toMatchObject({ result: 'version-mismatch', version, metadata: { claudeRewind: { phase: 'committed' } } })
            expect(send(fresh.metadata, version)).toMatchObject({ result: 'success', version, metadata: { claudeRewind: { phase: 'committed' } } })
            expect(store.messages.getMessageEpoch(sid)).toBe(epoch)
            expect(proofCalls).toBe(10)
        } finally { engine.stop() }
    })

    it('blocks clear/new/compact in every pending phase at the durable send layer while preserving normal input', async () => {
        for (const phase of ['requested', 'pending', 'applied', 'unknown', 'committed', 'rejected'] as const) {
            const { store, engine, sid } = setup()
            try {
                const current = store.sessions.getSession(sid)!
                store.sessions.updateSessionMetadata(sid, { ...(current.metadata as Metadata), claudeRewind: {
                    operationId: 'op', phase, requestedLocalId: 'boundary', cutoffSeq: 1
                } }, current.metadataVersion, 'default')
                const blocked = !['committed', 'rejected'].includes(phase)
                for (const text of ['/clear', ' /new ', '/clear arguments', '/new\nextra', '/compact', '/compact focus']) {
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
                expect(ack.result).toBe('error')
                expect((store.sessions.getSession(sid)!.metadata as Metadata).claudeRewind?.phase).toBe('unknown')
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
