import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

const metadata: Metadata = { path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'codex', codexSessionId: 'native-root' }
const attached = (bindingId = randomUUID()): NonNullable<Metadata['codexRuntime']> => ({ kind: 'attached', bindingId, state: 'detached' })

describe('external Codex binding safety', () => {
    it.each([true, false])('never sends an inactive attached view to Runner, including an empty startup row (nativeId=%s)', async hasId => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
        try {
            const session = engine.getOrCreateSession('external', { ...metadata, codexSessionId: hasId ? 'native-root' : undefined, codexRuntime: attached() }, null, 'default')
            const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
            let spawned = false
            rpc.spawnSession = async () => { spawned = true; throw new Error('must not spawn') }
            expect(engine.resolveLocalResumeTarget(session.id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(await engine.resumeSession(session.id, 'default')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(await engine.forkConversation(session.id, 'default')).toMatchObject({ type: 'error', message: expect.stringContaining('owning desktop') })
            expect(spawned).toBe(false)
            engine.handleSessionAlive({ sid: session.id, time: Date.now() })
            expect(await engine.resumeSession(session.id, 'default')).toEqual({ type: 'success', sessionId: session.id })
        } finally { engine.stop() }
    })
    it('never deduplicates owned, attached, and post-rewrite epochs into one transcript', async () => {
        const store = new Store(':memory:')
        const cache = new SessionCache(store, { emit() {} } as never)
        const owned = cache.getOrCreateSession('owned', metadata, null, 'default')
        const first = cache.getOrCreateSession('attached', { ...metadata, codexRuntime: attached() }, null, 'default')
        const second = cache.getOrCreateSession('new-view', { ...metadata, codexRuntime: attached() }, null, 'default')
        for (const session of [owned, first, second]) {
            store.messages.addMessage(session.id, { text: session.id }, `message-${session.id}`)
            await cache.deduplicateByAgentSessionId(session.id)
        }
        for (const session of [owned, first, second]) {
            expect(cache.getSession(session.id)).toBeDefined()
            expect(store.messages.getMessages(session.id, 100)).toHaveLength(1)
        }
    })
});
