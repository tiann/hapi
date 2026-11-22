import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'

function createEngine() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    return { store, engine }
}

function agentText(text: string) {
    return {
        role: 'agent',
        content: { type: 'output', data: { type: 'assistant', message: { content: [{ type: 'text', text }] } } }
    }
}

describe('Claude fork-at-message hub integration', () => {
    it('surfaces the runner first-message rejection over the fork RPC without mutating the source', async () => {
        const { store, engine } = createEngine()
        try {
            const session = engine.getOrCreateSession('claude-fork-first-message', {
                path: '/tmp/project', host: 'localhost', machineId: 'machine-1', flavor: 'claude',
                capabilities: { conversationHistory: { forkCurrent: true, forkAtMessage: true } },
            }, null, 'default')
            engine.handleSessionAlive({ sid: session.id, time: Date.now(), mode: 'remote' })
            store.messages.addMessage(session.id, { role: 'user', content: 'codename is ARLO-7' }, 'local-t1')
            store.messages.addMessage(session.id, agentText('OK, ARLO-7'))
            store.messages.markMessagesInvoked(session.id, ['local-t1'], Date.now())
            const rowsBefore = store.messages.getAllMessages(session.id).length

            // The runner's ForkConversation handler throws
            // 'Cannot fork before the first message' from resolveForkAtMessagePlan
            // (an exclusive boundary needs a previous turn to resume at); the RPC
            // layer turns the throw into an error result, which the hub must
            // surface verbatim instead of attempting a spawn.
            ;(engine as any).rpcGateway.forkConversation = async () => ({
                error: 'Cannot fork before the first message',
            })

            const result = await engine.forkConversation(session.id, 'default', 'local-t1')
            expect(result).toMatchObject({ type: 'error', message: 'Cannot fork before the first message' })

            // No child stub, no transcript change: the rejection is terminal.
            expect(store.messages.getAllMessages(session.id).length).toBe(rowsBefore)
        } finally {
            engine.stop()
        }
    })
})