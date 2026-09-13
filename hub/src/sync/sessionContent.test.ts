import { describe, expect, it } from 'bun:test'
import { toSessionSummary, type SyncEvent } from '@hapi/protocol'
import { SessionSchema } from '@hapi/protocol/schemas'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine(store: Store, events: SyncEvent[]) {
    const io = { of: () => ({ adapter: { rooms: new Map() }, to: () => ({ emit() {} }) }) }
    return new SyncEngine(store, io as never, new RpcRegistry(), {
        broadcast: (event: SyncEvent) => events.push(event)
    } as never)
}

describe('session conversation content', () => {
    it('derives content from stored transcripts on reload, independently of titles', () => {
        const store = new Store(':memory:')
        const empty = store.sessions.getOrCreateSession('empty', { path: '/work', host: 'test', name: 'Named stub' }, null, 'default')
        const nonempty = store.sessions.getOrCreateSession('nonempty', { path: '/work', host: 'test', lifecycleState: 'archived' }, null, 'default')
        const lifecycle = { role: 'agent', content: { type: 'event', data: { type: 'message', message: 'Session started' } } }
        store.messages.addMessage(empty.id, lifecycle)
        // Exceed the usual page size; don't mistake a page of lifecycle events for an empty transcript.
        for (let i = 0; i < 205; i += 1) store.messages.addMessage(nonempty.id, lifecycle)
        store.messages.addImportedMessage(nonempty.id, {
            role: 'agent', content: { type: 'codex', data: { type: 'message', message: 'Answer '.repeat(100) } }
        }, 'imported-answer', Date.now())
        const engine = createEngine(store, [])
        try {
            expect(engine.getSession(empty.id)?.hasConversationContent).toBe(false)
            const session = engine.getSession(nonempty.id)!
            expect(session.hasConversationContent).toBe(true)
            expect(toSessionSummary(SessionSchema.parse(session)).hasConversationContent).toBe(true)
        } finally {
            engine.stop()
            store.close()
        }
    })

    it('publishes eligibility changes for first sends, cancellations and CLI messages', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = createEngine(store, events)
        try {
            const session = engine.getOrCreateSession('live', { path: '/work', host: 'test' }, null, 'default')
            await engine.sendMessage(session.id, { text: 'Hello', localId: 'first' })
            expect(engine.getSession(session.id)?.hasConversationContent).toBe(true)
            expect(events.some(event => event.type === 'session-updated'
                && event.data && 'id' in event.data && event.data.hasConversationContent === true)).toBe(true)

            const first = store.messages.getMessages(session.id)[0]
            await engine.cancelQueuedMessage(session.id, first.id)
            expect(engine.getSession(session.id)?.hasConversationContent).toBe(false)
            expect(events.some(event => event.type === 'session-updated'
                && event.data && 'id' in event.data && event.data.hasConversationContent === false)).toBe(true)

            const message = store.messages.addMessage(session.id, {
                role: 'user', content: { type: 'text', text: '', attachments: [{ id: 'image' }] }
            }, 'attachment')
            engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            expect(engine.getSession(session.id)?.hasConversationContent).toBe(true)
            events.length = 0
            engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            expect(events.filter(event => event.type === 'session-updated')).toHaveLength(0)

            store.messages.truncateMessagesFromLocalId(session.id, 'attachment', [])
            engine.handleRealtimeEvent({ type: 'messages-invalidated', sessionId: session.id, reason: 'rewind' })
            expect(engine.getSession(session.id)?.hasConversationContent).toBe(false)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
