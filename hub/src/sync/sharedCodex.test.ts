import { describe, expect, it } from 'bun:test'
import type { Metadata } from '@hapi/protocol/types'
import { MACHINE_CAPABILITIES } from '@hapi/protocol/runnerCapabilities'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'

function fixture(capabilities: string[] = [MACHINE_CAPABILITIES.SessionControlSkill]) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.getOrCreateMachine('machine', { host: 'test', platform: 'linux', happyCliVersion: 'test', capabilities }, null, 'default')
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
    it('rejects a fork before the RPC when the runner cannot deliver the control skill', async () => {
        const { engine, create, rpc } = fixture([])
        let called = false
        rpc.forkConversation = async () => { called = true; return { nativeSessionId: 'unexpected' } }
        try {
            expect(await engine.forkConversation(create('source').id, 'default')).toEqual({
                type: 'error', message: 'Fork requires an upgraded runner with session-control skill delivery'
            })
            expect(called).toBe(false)
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
