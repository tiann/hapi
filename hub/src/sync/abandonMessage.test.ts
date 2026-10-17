import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'

function fixture(options: { ack?: object; sockets?: number; shared?: boolean; thinking?: boolean; timeout?: boolean } = {}) {
    const store = new Store(':memory:')
    const requests: any[] = []
    const events: any[] = []
    const io = { of: () => ({
        adapter: { rooms: { get: () => new Set(Array.from({ length: options.sockets ?? 1 }, (_, i) => String(i))) } },
        to: () => ({ timeout: () => ({ emit: (_: string, data: any, callback: any) => {
            requests.push(data)
            callback(options.timeout ? new Error('lost reply') : null, options.timeout ? [] : [options.ack ?? { removed: false, abandoned: true }])
        } }) })
    }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast(event: unknown) { events.push(event) } } as never)
    const metadata = { path: '/fixture', host: 'fixture', hostPid: 42, machineId: 'test-machine', flavor: 'codex',
        codexSessionId: 'native', capabilities: { concurrentClients: options.shared ?? true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const source = engine.getOrCreateSession('source', metadata, null, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: options.thinking ?? false, mode: 'remote' })
    store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'completed' } }, 'boundary')
    store.messages.markMessagesInvoked(source.id, ['boundary'], Date.now())
    const original = { role: 'user', content: { type: 'text', text: 'original input', attachments: [{ filename: 'preserve.txt', path: '/fixture/preserve.txt' }] } }
    const row = store.messages.addMessage(source.id, original, 'unknown')
    store.messages.setMessagesDeliveryState(source.id, ['unknown'], 'indeterminate')
    let nativeForks = 0
    ;(engine as any).rpcGateway.forkConversation = async () => {
        nativeForks++
        const child = engine.getOrCreateSession('child', { ...metadata, codexSessionId: 'child-native', forkedFrom: source.id }, null, 'default')
        return { sessionId: child.id, nativeSessionId: 'child-native' }
    }
    return { store, engine, source, original, row, requests, events, nativeForks: () => nativeForks,
        close() { engine.stop(); store.close() } }
}

describe('explicit abandonment of unknown delivery', () => {
    it('reconciles an abandoned duplicate send without broadcasting a pending row or replaying input', async () => {
        const f = fixture()
        try {
            await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)
            f.events.length = 0
            await f.engine.sendMessage(f.source.id, { text: 'idempotent retry must not replace the original', localId: 'unknown' })
            expect(f.events.some(event => event.type === 'message-received')).toBe(false)
            expect(f.events).toContainEqual(expect.objectContaining({ type: 'message-cancelled', sessionId: f.source.id, messageId: f.row.id, localId: 'unknown' }))
            expect(f.requests).toHaveLength(1)
            expect(f.store.messages.getAllMessages(f.source.id).find(row => row.localId === 'unknown')).toMatchObject({ invokedAt: null, deliveryState: 'abandoned', content: f.original })
            expect(f.store.messages.getAllMessages(f.source.id).filter(row => (row.content as any).meta?.abandonedDelivery)).toHaveLength(1)
        } finally { f.close() }
    })
    it('archives the input truthfully and unlocks both current and historical Fork without faking consumption', async () => {
        const f = fixture()
        try {
            expect((await f.engine.forkConversation(f.source.id, 'default')).type).toBe('error')
            const result = await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)
            expect(result).toEqual({ status: 'abandoned', localId: 'unknown' })
            expect(f.requests[0].body).toMatchObject({ t: 'cancel-queued-message', abandon: true, localId: 'unknown' })
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toHaveLength(0)
            const all = f.store.messages.getAllMessages(f.source.id)
            expect(all.find(row => row.localId === 'unknown')).toMatchObject({ invokedAt: null, deliveryState: 'abandoned' })
            expect(f.engine.getQueuedState(f.source.id, ['unknown'])).toEqual({ queuedLocalIds: [], indeterminateLocalIds: [], invokedLocalMessages: [] })
            const notice = all.find(row => (row.content as any).meta?.abandonedDelivery)
            expect((notice?.content as any).meta.abandonedDelivery.content).toEqual(f.original)
            expect((notice?.content as any).content.data.message).toContain('does not undo execution or resend')
            expect(await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).toEqual({ status: 'not-found' })
            expect(f.store.messages.getAllMessages(f.source.id)).toHaveLength(all.length)
            expect((await f.engine.forkConversation(f.source.id, 'default')).type).toBe('success')
            expect((await f.engine.forkConversation(f.source.id, 'default', 'boundary')).type).toBe('success')
            expect(f.nativeForks()).toBe(2)
        } finally { f.close() }
    })

    it.each([{ sockets: 0 }, { sockets: 2 }, { shared: false }, { thinking: true },
        { ack: { removed: true } }, { ack: { removed: false, indeterminate: true } }])('fails closed for %j', async options => {
        const f = fixture(options)
        try {
            expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('unavailable')
            expect(f.store.messages.lookupQueuedMessage(f.source.id, f.row.id).status).toBe('indeterminate')
            expect((await f.engine.forkConversation(f.source.id, 'default')).type).toBe('error')
            expect(f.nativeForks()).toBe(0)
        } finally { f.close() }
    })

    it('returns authoritative consumption instead of abandonment when native history wins', async () => {
        const f = fixture({ ack: { removed: false, consumed: true } })
        try {
            expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('invoked')
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toHaveLength(0)
            expect(f.store.messages.getAllMessages(f.source.id).some(row => (row.content as any).meta?.abandonedDelivery)).toBe(false)
        } finally { f.close() }
    })

    it('never abandons a normal queued message or a live dispatch', async () => {
        const f = fixture()
        try {
            for (const state of ['queued', 'dispatching'] as const) {
                f.store.messages.setMessagesDeliveryState(f.source.id, ['unknown'], state)
                expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('unavailable')
            }
            expect(f.requests).toHaveLength(0)
        } finally { f.close() }
    })

    it('retains correlation for a late real consumption proof without replaying or faking invocation', async () => {
        const f = fixture()
        try {
            await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)
            expect(f.store.messages.getAllMessages(f.source.id).find(row => row.localId === 'unknown')).toMatchObject({ invokedAt: null, deliveryState: 'abandoned' })
            expect(f.engine.getMessagesPage(f.source.id, { limit: 200 }).messages.some(row => row.localId === 'unknown')).toBe(false)
            expect(f.store.messages.getDeliverableMessagesAfter(f.source.id, 0, Date.now()).some(row => row.localId === 'unknown')).toBe(false)
            f.store.messages.markMessagesInvoked(f.source.id, ['unknown'], 12345)
            expect(f.engine.getMessagesPage(f.source.id, { limit: 200 }).messages.find(row => row.localId === 'unknown')).toMatchObject({ invokedAt: 12345 })
            expect(f.store.messages.getAllMessages(f.source.id).filter(row => row.localId === 'unknown')).toHaveLength(1)
            expect(f.engine.getQueuedState(f.source.id, ['unknown']).invokedLocalMessages).toEqual([{ localId: 'unknown', invokedAt: 12345 }])
        } finally { f.close() }
    })

    it('keeps the unresolved record when the native acknowledgement is lost', async () => {
        const f = fixture({ timeout: true })
        try {
            expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('unavailable')
            expect(f.store.messages.lookupQueuedMessage(f.source.id, f.row.id).status).toBe('indeterminate')
            expect(f.store.messages.getAllMessages(f.source.id).some(row => (row.content as any).meta?.abandonedDelivery)).toBe(false)
        } finally { f.close() }
    })

    it('honors an invocation that arrives between the native acknowledgement and the database transition', async () => {
        const f = fixture()
        try {
            ;(f.engine as any).messageService.requestCliCancelAck = async () => {
                f.store.messages.markMessagesInvoked(f.source.id, ['unknown'], 98765)
                return 'abandoned'
            }
            expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('invoked')
            expect(f.store.messages.getAllMessages(f.source.id).some(row => (row.content as any).meta?.abandonedDelivery)).toBe(false)
            expect(f.engine.getQueuedState(f.source.id, ['unknown']).invokedLocalMessages).toEqual([{ localId: 'unknown', invokedAt: 98765 }])
        } finally { f.close() }
    })

    it('rolls back the note when persisting the Hub resolution fails, allowing an idempotent retry', async () => {
        const f = fixture()
        try {
            ;(f.store as any).db.exec("CREATE TRIGGER fail_abandon BEFORE UPDATE ON messages WHEN NEW.delivery_state = 'abandoned' BEGIN SELECT RAISE(ABORT, 'disk unavailable'); END")
            await expect(f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).rejects.toThrow('disk unavailable')
            expect(f.store.messages.lookupQueuedMessage(f.source.id, f.row.id).status).toBe('indeterminate')
            expect(f.store.messages.getAllMessages(f.source.id).some(row => (row.content as any).meta?.abandonedDelivery)).toBe(false)
            ;(f.store as any).db.exec('DROP TRIGGER fail_abandon')
            expect((await f.engine.abandonIndeterminateMessage(f.source.id, f.row.id)).status).toBe('abandoned')
            expect(f.store.messages.getAllMessages(f.source.id).filter(row => (row.content as any).meta?.abandonedDelivery)).toHaveLength(1)
        } finally { f.close() }
    })
})
