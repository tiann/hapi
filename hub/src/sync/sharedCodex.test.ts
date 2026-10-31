import { describe, expect, it } from 'bun:test'
import type { Metadata } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const metadata: Metadata = { path: '/tmp/work', host: 'test', machineId: 'machine', hostPid: 42, flavor: 'codex',
        capabilities: { concurrentClients: true, conversationHistory: { forkCurrent: true, forkAtMessage: true } } }
    const create = (name: string, more: Partial<Metadata> = {}) => {
        const session = engine.getOrCreateSession(name, { ...metadata, codexSessionId: `native-${name}`, ...more }, { controlledByUser: false }, 'default')
        engine.handleSessionAlive({ sid: session.id, time: Date.now() })
        engine.handleSessionReady({ sid: session.id, time: Date.now() })
        return session
    }
    return { store, engine, create, rpc: (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway }
}

describe('shared Codex hub binding', () => {
    it('allows Codex historical forks while thinking but retains other history guards', async () => {
        const { store, engine, create, rpc } = fixture()
        try {
            const source = create('source', { conversationHistoryPoints: { boundary: true } })
            const child = create('child', { forkedFrom: source.id })
            store.messages.addMessage(source.id, { role: 'user', content: 'boundary' }, 'boundary')
            store.messages.markMessagesInvoked(source.id, ['boundary'], Date.now())
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true })
            let calls = 0
            rpc.forkConversation = async () => { calls++; return { nativeSessionId: 'native-child', sessionId: child.id } }
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toEqual({ type: 'success', sessionId: child.id })
            expect(engine.getSession(source.id)?.thinking).toBe(true)
            expect(await engine.forkConversation(source.id, 'default')).toMatchObject({ type: 'error', message: 'Session is busy' })
            expect(await engine.rewindConversation(source.id, 'default', 'boundary')).toMatchObject({ type: 'error', message: 'Session is busy' })
            store.messages.addMessage(source.id, { role: 'user', content: 'queued' }, 'queued')
            expect(await engine.forkConversation(source.id, 'default', 'boundary')).toMatchObject({ type: 'error', message: 'Session has queued messages' })
            expect(calls).toBe(1)
        } finally { engine.stop() }
    })
    it('guards plan actions by namespace and runtime, leaving stale-plan and retry validation to CLI', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source')
            const unsupported = create('other', { flavor: 'claude' })
            const calls: string[][] = []
            rpc.implementCodexPlan = async (...args) => { calls.push(args); return { ok: true } }
            expect(await engine.implementCodexPlan(source.id, 'other-namespace', 'plan')).toMatchObject({ ok: false })
            expect(await engine.implementCodexPlan(unsupported.id, 'default', 'plan')).toMatchObject({ ok: false })
            expect(calls).toHaveLength(0)
            // The hub can lag the native plan state, including after an accepted action's lost reply.
            expect(await engine.implementCodexPlan(source.id, 'default', 'plan')).toEqual({ ok: true })
            expect(calls).toEqual([[source.id, 'plan']])
        } finally { engine.stop() }
    })

    it('uses the already-bound fork child without spawning a second engine', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source'); const child = create('child', { forkedFrom: source.id })
            rpc.forkConversation = async () => ({ nativeSessionId: 'native-child', sessionId: child.id })
            expect(await engine.forkConversation(source.id, 'default')).toEqual({ type: 'success', sessionId: child.id })
            expect(engine.getSession(source.id)?.metadata?.codexSessionId).toBe('native-source')
        } finally { engine.stop() }
    })
    it('clear returns a new root without superseding other clients and mode switching is inapplicable', async () => {
        const { engine, create, rpc } = fixture()
        try {
            const source = create('source'); const child = create('child')
            rpc.clearConversation = async () => ({ sessionId: child.id })
            expect(await engine.clearConversation(source.id, 'default')).toEqual({ sessionId: child.id })
            expect(engine.getSession(source.id)?.metadata?.supersededBySessionId).toBeUndefined()
            await expect(engine.switchSession(source.id, 'remote')).rejects.toThrow('control_mode_not_applicable')
            await expect(engine.clearConversation(source.id, 'other-namespace')).rejects.toThrow()
        } finally { engine.stop() }
    })
})
