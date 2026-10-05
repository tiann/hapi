import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

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
