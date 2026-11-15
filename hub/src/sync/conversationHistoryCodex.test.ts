import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const session = engine.getOrCreateSession('shared-codex', {
        path: '/tmp/project', host: 'test', flavor: 'codex',
        capabilities: { concurrentClients: true, conversationHistory: { rewindToMessage: true } },
    }, null, 'default')
    engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
    for (const localId of ['one', 'two', 'three']) {
        store.messages.addMessage(session.id, { role: 'user', content: localId }, localId)
        store.messages.markMessagesInvoked(session.id, [localId], Date.now())
    }
    const gateway = (engine as unknown as { rpcGateway: {
        rewindConversation: () => Promise<unknown>
        completeConversationRewind: (sessionId: string, token: string) => Promise<void>
    } }).rpcGateway
    return { store, engine, session, gateway }
}
describe('shared Codex rewind commit', () => {
    it('acknowledges the CLI only after durable transcript truncation and keeps sends locked', async () => {
        const { store, engine, session, gateway } = fixture()
        try {
            let completed = false
            gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'two', rewindToken: 'transaction' })
            gateway.completeConversationRewind = async (id, token) => {
                expect(id).toBe(session.id); expect(token).toBe('transaction')
                expect(store.messages.getLocalMessageStates(id, ['one', 'two', 'three'])).toHaveLength(1)
                await expect(engine.sendMessage(id, { text: 'racing message', localId: 'race' })).rejects.toThrow('in progress')
                completed = true
            }
            expect(await engine.rewindConversation(session.id, 'default', 'two')).toEqual({ type: 'success' })
            expect(completed).toBe(true)
        } finally { engine.stop() }
    })
    it('preserves persisted Hub transcript order across lazy resume, a new turn, and two successive rewinds', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        const session = engine.getOrCreateSession('shared-codex-lazy-rewind', {
            path: '/tmp/project', host: 'test', flavor: 'codex',
            capabilities: { concurrentClients: true, conversationHistory: { rewindToMessage: true } },
        }, null, 'default')
        engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })

        try {
            const gateway = (engine as unknown as { rpcGateway: {
                rewindConversation: () => Promise<unknown>
                completeConversationRewind: (sessionId: string, token: string) => Promise<void>
            } }).rpcGateway

            // 1. 模拟 lazy resume：Native 包含 [Turn A, Turn B]，但 Hub store 中只恢复了最新一轮 B
            store.messages.addMessage(session.id, { role: 'user', content: 'b' }, 'b', 1000)
            store.messages.markMessagesInvoked(session.id, ['b'], 1000)

            // 验证初始状态：Hub 只有 B
            let messages = store.messages.getMessages(session.id).map(m => m.localId)
            expect(messages).toEqual(['b'])

            // 2. 模拟在新会话中完成了新一轮 C
            store.messages.addMessage(session.id, { role: 'user', content: 'c' }, 'c', 2000)
            store.messages.markMessagesInvoked(session.id, ['c'], 2000)
            messages = store.messages.getMessages(session.id).map(m => m.localId)
            expect(messages).toEqual(['b', 'c'])

            // 3. 第一次 Rewind：在 Web 端对 C 执行 rewind
            // Native revert C，保留 [A, B]；Hub 截断 C；CLI 完成 completeRewind（无多余消息重发）
            gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'c', rewindToken: 'token-c' })
            gateway.completeConversationRewind = async () => {
                // CLI projection 重建 locators，绝不向 Hub 发送未曾存在过的保留消息 A
            }
            const rewindC = await engine.rewindConversation(session.id, 'default', 'c')
            expect(rewindC).toEqual({ type: 'success' })

            // 验证关键不变量：Hub transcript 严格保留 [B]，绝不能倒序追加变成 [B, A]
            messages = store.messages.getMessages(session.id).map(m => m.localId)
            expect(messages).toEqual(['b'])

            // 4. 第二次 Rewind：紧接着在 Web 端对剩余的 B 执行 rewind
            // Native revert B，保留 [A]；Hub 截断 B
            gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'b', rewindToken: 'token-b' })
            gateway.completeConversationRewind = async () => {}
            const rewindB = await engine.rewindConversation(session.id, 'default', 'b')
            expect(rewindB).toEqual({ type: 'success' })

            // 验证关键不变量：Hub transcript 中的 B 被干净截断，没有任何错位残留
            messages = store.messages.getMessages(session.id).map(m => m.localId)
            expect(messages).toEqual([])
        } finally {
            engine.stop()
        }
    })

    it.each([
        { name: 'serialized error', response: { error: 'Verification failed' }, expectedMessage: 'Verification failed' },
        { name: 'malformed response', response: { unexpected: true }, expectedMessage: 'Invalid rewind completion response' },
    ])('quarantines when completeConversationRewind receives $name', async ({ response, expectedMessage }) => {
        const { store, engine, session, gateway } = fixture()
        try {
            gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'two', rewindToken: 'transaction' })
            ;(gateway as any).sessionRpc = async () => response

            const result = await engine.rewindConversation(session.id, 'default', 'two')
            expect(result).toMatchObject({
                type: 'error',
                message: expect.stringContaining(expectedMessage),
                hydrateFailed: true
            })
            expect(engine.getSession(session.id)?.metadata?.conversationHistoryDiverged).toBe(true)
        } finally {
            engine.stop()
        }
    })

    it.each(['truncate', 'complete'])('quarantines a %s failure without reporting success', async failure => {
        const { store, engine, session, gateway } = fixture()
        try {
            let completed = false
            gateway.rewindConversation = async () => ({ success: true, truncateFromLocalId: 'two', rewindToken: 'transaction' })
            if (failure === 'truncate') store.messages.truncateMessagesFromLocalId = () => { throw new Error('disk failure') }
            gateway.completeConversationRewind = async () => { completed = true; throw new Error('ack failure') }
            expect(await engine.rewindConversation(session.id, 'default', 'two')).toMatchObject({ type: 'error', hydrateFailed: true })
            expect(completed).toBe(failure === 'complete')
            expect(engine.getSession(session.id)?.metadata?.conversationHistoryDiverged).toBe(true)
        } finally { engine.stop() }
    })
})

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

describe('Codex conversation-history hub integration', () => {
    it('forwards serialized Fork RPC errors instead of using the missing-id fallback', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('codex-fork-not-ready', {
                path: '/tmp/project',
                host: 'localhost',
                machineId: 'machine-1',
                flavor: 'codex',
                codexSessionId: 'native-thread',
                capabilities: { conversationHistory: { forkCurrent: true } }
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(session.id, { role: 'user', content: 'boundary' }, 'local-boundary')
            store.messages.markMessagesInvoked(session.id, ['local-boundary'], Date.now())

            ;(engine as any).rpcGateway.forkConversation = async () => ({
                error: 'Codex thread is not ready'
            })

            await expect(engine.forkConversation(session.id, 'default')).resolves.toEqual({
                type: 'error',
                message: 'Codex thread is not ready'
            })
        } finally {
            engine.stop()
        }
    })
})
