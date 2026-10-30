import { describe, expect, it } from 'bun:test'
import type { BranchConversationRequest } from '@hapi/protocol/apiTypes'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'
import { mergeSessionMetadata } from '../store/sessions'

const request: BranchConversationRequest = {
    requestId: 'b428e5be-dc54-4edc-9903-59250c1b5c31', messageLocalId: 'second', boundary: 'before',
    agent: 'codex', model: 'target-model', workspace: 'worktree', instruction: 'Try the other implementation'
}
function fixture() {
    const store = new Store(':memory:')
    const io = { of: () => ({ to: () => ({ emit() {} }) }) }
    const engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.getOrCreateMachine('machine', { host: 'test', platform: 'linux', happyCliVersion: 'test' }, null, 'default')
    engine.handleMachineAlive({ machineId: 'machine', time: Date.now() })
    const source = engine.getOrCreateSession('source', {
        path: '/tmp/work', host: 'test', machineId: 'machine', flavor: 'claude', claudeSessionId: 'private-native-id'
    }, { controlledByUser: false }, 'default')
    engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: false, mode: 'remote' })
    for (const id of ['first', 'second']) {
        store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: id } }, id)
        store.messages.markMessagesInvoked(source.id, [id], Date.now())
    }
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    rpc.listCodexModelsForMachine = async () => ({ success: true, models: [{ id: 'target-model', displayName: 'Target', isDefault: true }] })
    return { store, engine, source, rpc }
}
describe('portable branch lifecycle', () => {
    it('preallocates a fresh target, persists reference before spawn, and submits once', async () => {
        const { store, engine, source, rpc } = fixture()
        let calls = 0
        rpc.spawnSession = async (...args) => {
            calls++
            expect(args[2]).toBe('codex')
            expect(args[3]).toBe('target-model')
            expect(args[6]).toBe('worktree')
            expect(args[8]).toBeUndefined() // never resume the source native id
            expect(args[12]).toBeUndefined() // fresh, never reopen
            const childId = args[17]!
            const initial = store.messages.getAllMessages(childId)
            expect(initial).toHaveLength(1)
            expect(initial[0].scheduledAt).not.toBeNull()
            expect(JSON.stringify(initial)).not.toContain('private-native-id')
            expect(engine.getSession(childId)?.metadata?.forkedFrom).toBe(source.id)
            return { type: 'success', sessionId: childId }
        }
        try {
            const result = await engine.branchConversation(source.id, 'default', request)
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(result.warning).toBeUndefined()
            expect(engine.getSession(result.sessionId)?.metadata?.conversationBranch?.state).toBe('started')
            expect(await engine.branchConversation(source.id, 'default', request)).toEqual(result)
            expect(calls).toBe(1)
            expect(store.messages.getAllMessages(result.sessionId)).toHaveLength(1)
            expect(store.messages.getAllMessages(source.id)).toHaveLength(2)
            expect(await engine.branchConversation(source.id, 'default', { ...request, instruction: 'Different' })).toMatchObject({ type: 'error' })
        } finally { engine.stop() }
    })
    it('keeps ambiguous children and never respawns an idempotent retry', async () => {
        const { store, engine, source, rpc } = fixture()
        let calls = 0
        rpc.spawnSession = async () => { calls++; throw new Error('RPC timeout') }
        try {
            const result = await engine.branchConversation(source.id, 'default', request)
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            expect(result.warning).toContain('uncertain')
            expect(store.messages.getAllMessages(result.sessionId)).toHaveLength(1)
            expect((await engine.branchConversation(source.id, 'default', request)).type).toBe('success')
            expect(calls).toBe(1)
        } finally { engine.stop() }
    })
    it('can branch an inactive source and recovers the same child after hub restart', async () => {
        const { store, engine, source, rpc } = fixture()
        engine.handleSessionEnd({ sid: source.id, time: Date.now(), reason: 'completed' })
        rpc.spawnSession = async (...args) => ({ type: 'success', sessionId: args[17]! })
        const result = await engine.branchConversation(source.id, 'default', request)
        engine.stop()
        expect(result.type).toBe('success')
        const restarted = new SyncEngine(store, { of: () => ({ to: () => ({ emit() {} }) }) } as never,
            new RpcRegistry(), { broadcast() {} } as never)
        try {
            // No machine RPC registrations after restart; recovery must use the
            // durable child rather than re-validating models or re-spawning.
            expect(await restarted.branchConversation(source.id, 'default', request)).toEqual(result)
        } finally { restarted.stop() }
    })

    it('rejects busy, unauthorized, stale and unavailable model requests before spawn', async () => {
        const { engine, source, rpc } = fixture()
        let calls = 0
        rpc.spawnSession = async () => { calls++; return { type: 'error', message: 'unexpected' } }
        try {
            expect((await engine.branchConversation(source.id, 'other', request)).type).toBe('error')
            expect((await engine.branchConversation(source.id, 'default', { ...request, model: 'unknown' })).type).toBe('error')
            expect((await engine.branchConversation(source.id, 'default', { ...request, messageLocalId: 'missing' })).type).toBe('error')
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
            expect(await engine.branchConversation(source.id, 'default', request)).toEqual({ type: 'error', message: 'Session is busy' })
            expect(calls).toBe(0)
        } finally { engine.stop() }
    })
    it('rechecks the source after asynchronous model discovery and serializes history actions', async () => {
        const { engine, source, rpc } = fixture()
        let release!: () => void
        let spawned = false
        rpc.listCodexModelsForMachine = async () => {
            await new Promise<void>(resolve => { release = resolve })
            return { success: true, models: [{ id: 'target-model', displayName: 'Target', isDefault: true }] }
        }
        rpc.spawnSession = async () => { spawned = true; throw new Error('unexpected') }
        try {
            const pending = engine.branchConversation(source.id, 'default', request)
            expect(await engine.branchConversation(source.id, 'default', request)).toEqual({
                type: 'error', message: 'Conversation history action already in progress'
            })
            engine.handleSessionAlive({ sid: source.id, time: Date.now(), thinking: true, mode: 'remote' })
            release()
            expect(await pending).toEqual({ type: 'error', message: 'Session is busy' })
            expect(spawned).toBe(false)
        } finally { engine.stop() }
    })

    it('cleans up only when runner confirms no child was started', async () => {
        const { engine, source, rpc } = fixture()
        let childId: string | undefined
        rpc.spawnSession = async (...args) => { childId = args[17]; return { type: 'error', message: 'outside roots', childStarted: false } }
        try {
            expect(await engine.branchConversation(source.id, 'default', request)).toEqual({ type: 'error', message: 'outside roots' })
            expect(engine.getSession(childId!)).toBeUndefined()
        } finally { engine.stop() }
    })
    it('preserves provenance across sparse and stale CLI metadata updates', () => {
        const branch = { requestFingerprint: 'fp', state: 'started' }
        const prior = { path: '/tmp/work', forkedFrom: 'source', conversationBranch: branch }
        expect(mergeSessionMetadata(prior, { path: '/tmp/work' })).toMatchObject(prior)
        expect(mergeSessionMetadata(prior, { conversationBranch: { ...branch, state: 'launching' } })).toMatchObject({ conversationBranch: branch })
    })
})
