import { describe, expect, it, spyOn } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store = new Store(':memory:')) {
    const events: SyncEvent[] = []
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast(event: SyncEvent) { events.push(event) } } as never)
    const session = engine.getOrCreateSession('delivery-owner', { path: '/tmp/project', host: 'localhost', flavor: 'opencode', hostPid: 100, hostStartMarker: 'worker-A' }, { steeringActive: true }, 'default')
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

describe('OpenCode pending delivery ownership', () => {
    it('holds only unconfirmed dispatches as unknown when the session ends', () => {
        const { store, engine, session, events } = createEngine()
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
        const { store, engine, session } = createEngine(new Store(path))
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
        const { store, engine, session } = createEngine()
        const clock = spyOn(Date, 'now')
        try {
            engine.handleRealtimeEvent({ type: 'session-updated', sessionId: session.id })
            expect(engine.getQueuedState(session.id, ['pending']).dispatchingLocalIds).toEqual(['pending'])
            clock.mockReturnValue(session.activeAt + 300_001)
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
