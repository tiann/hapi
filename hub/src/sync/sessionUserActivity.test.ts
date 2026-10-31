import { describe, expect, it } from 'bun:test'
import type { SyncEvent } from '@hapi/protocol'
import { toSessionSummary } from '@hapi/protocol'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

describe('user-activity ordering SSE', () => {
    it('publishes a summary patch only when stored user input advances the clock', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast: (event: SyncEvent) => events.push(event) } as never)
        try {
            const session = engine.getOrCreateSession('tag', { path: '/tmp', host: 'mac' }, null, 'default')
            const receive = (content: unknown, at: number, localId?: string) => {
                const message = store.messages.addMessage(session.id, content, localId, null, at)
                engine.handleRealtimeEvent({ type: 'message-received', sessionId: session.id, message })
            }
            const user = { role: 'user', content: { type: 'text', text: 'hello' } }
            receive(user, 100, 'prompt')
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(100)
            expect(events.some(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data && e.data.lastUserMessageAt === 100)).toBe(true)
            events.length = 0
            receive(user, 500, 'prompt')
            receive({ role: 'agent', content: { type: 'text', text: 'working' } }, 900)
            engine.recordSessionActivity(session.id, 1_000)
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(100)
            expect(events.filter(e => e.type === 'session-updated' && e.data && 'lastUserMessageAt' in e.data)).toHaveLength(0)
            receive(user, 2_000, 'next')
            expect(toSessionSummary(engine.getSession(session.id)!).lastUserMessageAt).toBe(2_000)
        } finally {
            engine.stop()
            store.close()
        }
    })
})
