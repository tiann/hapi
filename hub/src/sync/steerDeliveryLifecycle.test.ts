import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store = new Store(':memory:'), flavor: 'opencode' | 'claude' | 'codex' | 'cursor' = 'opencode') {
    const events: SyncEvent[] = []
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast(event: SyncEvent) { events.push(event) } } as never)
    const session = engine.getOrCreateSession('delivery-owner', { path: '/tmp/project', host: 'localhost', flavor, hostPid: 100, hostStartMarker: 'worker-A' }, { steeringActive: true }, 'default')
    engine.handleSessionAlive({ sid: session.id, time: Date.now(), thinking: true })
    for (const localId of ['pending', 'queued', 'consumed']) store.messages.addMessage(session.id, { text: localId }, localId)
    store.messages.setMessagesDeliveryState(session.id, ['pending'], 'dispatching')
    store.messages.markMessagesInvoked(session.id, ['consumed'], 1000)
    return { store, engine, session, events }
}

function expectUnknown(store: Store, engine: SyncEngine, sessionId: string) {
    expect(engine.getQueuedState(sessionId, ['pending'])).toEqual({ queuedLocalIds: [], indeterminateLocalIds: ['pending'], invokedLocalMessages: [] })
    expect(store.messages.lookupQueuedMessage(sessionId, 'pending').status).toBe('indeterminate')
    expect(store.messages.lookupQueuedMessage(sessionId, 'queued').status).toBe('queued')
    expect(store.messages.lookupQueuedMessage(sessionId, 'consumed').status).toBe('invoked')
    expect(store.messages.countMessages(sessionId)).toBe(3)
    expect(engine.getDeliverableMessagesAfter(sessionId, { afterSeq: 0, limit: 100, now: Date.now() }).map(message => message.localId)).not.toContain('pending')
}

describe.each(['opencode', 'claude'] as const)('%s pending delivery ownership', (flavor) => {
    it('holds only unconfirmed dispatches as unknown when the session ends', () => {
        const { store, engine, session, events } = createEngine(new Store(':memory:'), flavor)
        const other = store.sessions.getOrCreateSession('other', { path: '/tmp/other', flavor: 'opencode' }, null, 'other-namespace')
        store.messages.addMessage(other.id, { text: 'other' }, 'pending')
        store.messages.setMessagesDeliveryState(other.id, ['pending'], 'dispatching')
        try {
            engine.handleSessionEnd({ sid: session.id, time: Date.now(), reason: 'error' })
            expectUnknown(store, engine, session.id)
            expect(store.messages.lookupQueuedMessage(other.id, 'pending').status).toBe('dispatching')
            expect(events).toContainEqual(expect.objectContaining({ type: 'messages-indeterminate', sessionId: session.id, localIds: ['pending'] }))
        } finally { engine.stop(); store.close() }
    })

    it('turns abandoned dispatches unknown when a replacement worker identifies itself after hub restart', () => {
        const path = join(mkdtempSync(join(tmpdir(), 'hapi-steer-restart-')), 'hapi.db')
        const { store, engine, session } = createEngine(new Store(path), flavor)
        const id = session.id
        engine.stop(); store.close()
        const reopened = new Store(path)
        const io = { of: () => ({ to: () => ({ emit() {} }) }) }
        const restarted = new SyncEngine(reopened, io as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const before = reopened.sessions.getSession(id)!
            const metadata = { ...(before.metadata as Record<string, unknown>), hostPid: 101, hostStartMarker: 'worker-B' }
            const update = reopened.sessions.updateSessionMetadata(id, metadata, before.metadataVersion, 'default')
            if (update.result !== 'success') throw new Error('metadata update failed')
            restarted.handleRealtimeEvent({ type: 'session-updated', sessionId: id, data: { metadata: { version: update.version, value: metadata as never } } })
            restarted.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
            expect(restarted.getSession(id)?.thinking).toBe(true)
            expectUnknown(reopened, restarted, id)
            const next = reopened.sessions.updateSessionAgentState(id, { steeringActive: true }, before.agentStateVersion, 'default')
            if (next.result !== 'success') throw new Error('next state update failed')
            restarted.handleRealtimeEvent({ type: 'session-updated', sessionId: id, data: { agentState: { version: next.version, value: { steeringActive: true } } } })
            expectUnknown(reopened, restarted, id)
            reopened.messages.markMessagesInvoked(id, ['pending'], 2000)
            expect(restarted.getQueuedState(id, ['pending']).invokedLocalMessages).toEqual([{ localId: 'pending', invokedAt: 2000 }])
        } finally { restarted.stop(); reopened.close() }
    })

    it('keeps pending delivery during a live reconnect but resolves an expired owner to unknown', () => {
        const { store, engine, session } = createEngine(new Store(':memory:'), flavor)
        const clock = spyOn(Date, 'now')
        try {
            engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
            expect(engine.getQueuedState(session.id, ['pending']).dispatchingLocalIds).toEqual(['pending'])
            // Use the live cache row — createEngine's local binding can lag
            // activeAt after handleSessionAlive refreshes the session object.
            const live = engine.getSession(session.id)!
            clock.mockReturnValue(live.activeAt + 300_001)
            engine['expireInactive']()
            expectUnknown(store, engine, session.id)
        } finally { clock.mockRestore(); engine.stop(); store.close() }
    })
})


it('does not confuse closing Steer admission with a live request finishing its drain', () => {
    const { store, engine, session } = createEngine()
    try {
        const state = store.sessions.updateSessionAgentState(session.id, { steeringActive: false }, session.agentStateVersion, 'default')
        if (state.result !== 'success') throw new Error('state update failed')
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data: { agentState: { version: state.version, value: { steeringActive: false } } } })
        expect(engine.getQueuedState(session.id, ['pending']).dispatchingLocalIds).toEqual(['pending'])
        expect(store.messages.lookupQueuedMessage(session.id, 'pending').status).toBe('dispatching')
    } finally { engine.stop(); store.close() }
})


it.each(['codex', 'cursor'] as const)('preserves the separate %s runtime delivery owner on metadata replacement', (flavor) => {
    const { store, engine, session } = createEngine(new Store(':memory:'), flavor)
    try {
        // createEngine's returned session object can lag the DB: handleSessionAlive
        // may bump metadata (e.g. titleSuggestionTurn) and refresh the cache to a
        // new object while this local binding still holds the pre-alive version.
        const current = engine.getSession(session.id)!
        const metadata = { ...current.metadata!, hostPid: 101, hostStartMarker: 'worker-B' }
        const update = store.sessions.updateSessionMetadata(session.id, metadata, current.metadataVersion, 'default')
        if (update.result !== 'success') throw new Error('metadata update failed')
        engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id, data: { metadata: { version: update.version, value: metadata } } })
        expect(engine.getQueuedState(session.id, ['pending']).dispatchingLocalIds).toEqual(['pending'])
        expect(store.messages.lookupQueuedMessage(session.id, 'pending').status).toBe('dispatching')
    } finally { engine.stop(); store.close() }
})

it('keeps prior-generation backgroundWork and unresolvedTurn across host replace (#2021 Approach)', () => {
    const { store, engine, session } = createEngine(new Store(':memory:'), 'cursor')
    try {
        const cache = (engine as unknown as {
            sessionCache: {
                setBackgroundTasks(id: string, tasks: Array<{ id: string; type: string; description: string }>): void
                setUnresolvedTurn(id: string, unresolved: boolean): void
            }
        }).sessionCache
        cache.setBackgroundTasks(session.id, [{ id: 'bg-1', type: 'local_bash', description: 'sleep' }])
        cache.setUnresolvedTurn(session.id, true)
        const before = engine.getSession(session.id)!
        expect(before.metadata?.backgroundWork?.tasks).toHaveLength(1)
        expect(before.metadata?.unresolvedTurn).toBeTruthy()
        expect(before.metadata?.hostStartMarker).toBe('worker-A')
        expect(before.metadata?.backgroundWork?.hostStartMarker).toBe('worker-A')

        const metadata = {
            ...before.metadata!,
            hostPid: 101,
            hostStartMarker: 'worker-B',
            cursorSessionProtocol: 'acp' as const,
        }
        const update = store.sessions.updateSessionMetadata(session.id, metadata, before.metadataVersion, 'default')
        if (update.result !== 'success') throw new Error('metadata update failed')
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId: session.id,
            data: { metadata: { version: update.version, value: metadata } },
        })

        const after = engine.getSession(session.id)!
        expect(after.metadata?.hostStartMarker).toBe('worker-B')
        expect(after.metadata?.backgroundWork?.tasks).toHaveLength(1)
        expect(after.metadata?.backgroundWork?.hostStartMarker).toBe('worker-A')
        expect(after.metadata?.unresolvedTurn).toBeTruthy()
        expect(store.messages.lookupQueuedMessage(session.id, 'pending').status).toBe('dispatching')
    } finally { engine.stop(); store.close() }
})

it('keeps Cursor foreground tool work when a replacement worker identifies itself (#2021 Approach)', async () => {
    const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
    const { store, engine, session } = createEngine(new Store(':memory:'), 'cursor')
    try {
        store.messages.upsertToolCallMessage(session.id, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'tool-call',
                    callId: 'cursor-shell',
                    name: 'Shell',
                    input: {},
                    status: 'in_progress',
                },
            },
        }, 'cursor-shell')
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)

        const current = engine.getSession(session.id)!
        const metadata = {
            ...current.metadata!,
            hostPid: 101,
            hostStartMarker: 'worker-B',
            cursorSessionProtocol: 'acp' as const,
        }
        const update = store.sessions.updateSessionMetadata(session.id, metadata, current.metadataVersion, 'default')
        if (update.result !== 'success') throw new Error('metadata update failed')
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId: session.id,
            data: { metadata: { version: update.version, value: metadata } },
        })

        // Prior-gen sticky tools stay until Archive probe already_gone —
        // generation replace alone is not containment proof.
        expect(store.messages.getLiveToolWork(session.id)).toBe(true)
        // Delivery ownership for Cursor stays separate from OpenCode/Claude.
        expect(store.messages.lookupQueuedMessage(session.id, 'pending').status).toBe('dispatching')
    } finally { engine.stop(); store.close() }
})
