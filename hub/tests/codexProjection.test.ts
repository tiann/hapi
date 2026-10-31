import { describe, expect, it } from 'bun:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ApiSessionClient } from '../../cli/src/api/apiSession'
import { SharedCodexProjection } from '../../cli/src/codex/shared/projection'
import { SharedCodexQueue } from '../../cli/src/codex/shared/queue'
import { Store } from '../src/store'
import { RpcRegistry } from '../src/socket/rpcRegistry'
import { SyncEngine } from '../src/sync/syncEngine'

async function fixture() {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-projection-'))
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    let metadata = { path: directory, host: 'test', machineId: 'machine', hostPid: 123,
        flavor: 'codex' as const, codexSessionId: 'thread',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true } } }
    const source = engine.getOrCreateSession('codex-projected', metadata, null, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), mode: 'remote' })
    const packets: string[] = []
    const consumptionClient = {
        sessionId: source.id,
        emitOrQueue: (work: () => void) => work(),
        socket: { emit: (_event: string, data: { localIds: string[] }) => {
            packets.push('ack')
            store.messages.markMessagesInvoked(source.id, data.localIds, Date.now())
        } }
    } as unknown as ApiSessionClient
    const session = {
        getMetadata: () => metadata,
        updateMetadata: (fn: (value: typeof metadata) => typeof metadata) => { metadata = fn(metadata) },
        sendUserMessage: (text: string, _meta: unknown, id: string) => {
            packets.push('message')
            store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text } }, id)
        },
        sendAgentMessage: (body: unknown, id: string) => {
            packets.push('message')
            store.messages.addMessage(source.id, { role: 'agent', content: { type: 'output', data: body } }, id)
        },
        emitMessagesConsumed: (ids: string[]) => {
            ApiSessionClient.prototype.emitMessagesConsumed.call(consumptionClient, ids)
        }
    } as unknown as ApiSessionClient
    const queue = new SharedCodexQueue({ request: async () => ({ data: [] }) } as never,
        'thread', join(directory, 'queue.json'), ids => session.emitMessagesConsumed(ids), () => {})
    const projection = new SharedCodexProjection(session, 'thread', id => queue.committed(id, false), undefined,
        ids => queue.committedHistory(ids, false))
    return { store, engine, source, projection, packets, directory, async close() {
        engine.stop()
        store.close()
        await rm(directory, { recursive: true, force: true })
    } }
}

describe('shared Codex projection persisted consumption', () => {
    it('persists the live round duration before acknowledging it without leaving queued output', async () => {
        const f = await fixture()
        try {
            await f.projection.notification('turn/started', { threadId: 'thread', turn: { id: 'live' } }, undefined, 1_000)
            await f.projection.notification('turn/completed', { threadId: 'thread', turn: { id: 'live', status: 'completed' } }, undefined, 4_250)
            expect(f.store.messages.getAllMessages(f.source.id)).toEqual([
                expect.objectContaining({ localId: 'codex:thread:duration:live', invokedAt: expect.any(Number),
                    content: { role: 'agent', content: { type: 'output', data: expect.objectContaining({
                        type: 'turn_duration', turn_id: 'live', durationMs: 3_250
                    }) } } })
            ])
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toEqual([])
            expect(f.packets).toEqual(['message', 'ack'])
        } finally { await f.close() }
    })
    it('consumes an import larger than the SQLite variable limit and preserves pagination and fork availability', async () => {
        const f = await fixture()
        try {
            const items = [
                { id: 'user', clientId: 'local', type: 'userMessage', content: [{ type: 'text', text: 'large history' }] },
                ...Array.from({ length: 250_000 }, (_, i) => ({ id: `agent-${i}`, type: 'agentMessage', text: `output ${i}` }))
            ]
            await f.projection.history({ turns: [{ id: 'large-turn', status: 'completed', items }] })
            const rows = f.store.messages.getAllMessages(f.source.id)
            expect(rows).toHaveLength(250_001)
            expect(rows.every(row => row.invokedAt !== null)).toBe(true)
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toEqual([])
            expect(f.engine.getMessagesPage(f.source.id, { limit: 20 }).messages).toHaveLength(20)
            const child = f.engine.getOrCreateSession('large-fork', {
                ...f.source.metadata!, codexSessionId: 'large-fork-native', forkedFrom: f.source.id
            }, null, 'default')
            ;(f.engine as unknown as { rpcGateway: { forkConversation: () => Promise<unknown> } }).rpcGateway.forkConversation = async () => ({
                sessionId: child.id, nativeSessionId: 'large-fork-native'
            })
            await expect(f.engine.forkConversation(f.source.id, 'default')).resolves.toEqual({ type: 'success', sessionId: child.id })
        } finally { await f.close() }
    }, 60_000)
    it('marks newly imported prompts and output invoked after one replay, with bounded latest pages and working fork', async () => {
        const f = await fixture()
        try {
            const turns = Array.from({ length: 80 }, (_, i) => ({ id: `turn-${i}`, status: 'completed', items: [
                { id: `user-${i}`, clientId: `local-${i}`, type: 'userMessage', content: [{ type: 'text', text: `prompt ${i}` }] },
                { id: `agent-${i}`, type: 'agentMessage', text: `answer ${i}` }
            ] }))
            await f.projection.history({ turns })
            const rows = f.store.messages.getAllMessages(f.source.id)
            expect(rows.length).toBeGreaterThanOrEqual(160)
            expect(rows.every(row => row.invokedAt !== null)).toBe(true)
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toEqual([])
            expect(f.packets.filter(packet => packet === 'ack')).toHaveLength(1)
            expect(f.packets.at(-1)).toBe('ack')
            const ledger = JSON.parse(await readFile(join(f.directory, 'queue.json'), 'utf8'))
            expect(Object.values(ledger).every(value => (value as { state: string }).state === 'consumed')).toBe(true)
            expect(f.engine.getMessagesPage(f.source.id, { limit: 20 }).messages.length).toBeLessThanOrEqual(20)
            const child = f.engine.getOrCreateSession('codex-fork', {
                ...f.source.metadata!, codexSessionId: 'fork-native', forkedFrom: f.source.id
            }, null, 'default')
            ;(f.engine as unknown as { rpcGateway: { forkConversation: () => Promise<unknown> } }).rpcGateway.forkConversation = async () => ({
                sessionId: child.id, nativeSessionId: 'fork-native'
            })
            await expect(f.engine.forkConversation(f.source.id, 'default')).resolves.toEqual({ type: 'success', sessionId: child.id })
        } finally { await f.close() }
    })

    it('consumes live native prompts and assistant output after inserting their rows', async () => {
        const f = await fixture()
        try {
            await f.projection.notification('item/completed', { threadId: 'thread', turnId: 'live', item: {
                id: 'native-user', type: 'userMessage', content: [{ type: 'text', text: 'native prompt' }]
            } })
            await f.projection.notification('item/completed', { threadId: 'thread', turnId: 'live', item: {
                id: 'native-agent', type: 'agentMessage', text: 'reply'
            } })
            expect(f.store.messages.getAllMessages(f.source.id).length).toBeGreaterThanOrEqual(2)
            expect(f.store.messages.getUninvokedLocalMessages(f.source.id)).toEqual([])
            expect(f.packets.at(-1)).toBe('ack')
        } finally { await f.close() }
    })
})
