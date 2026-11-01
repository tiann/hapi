import { describe, expect, it } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { Store } from '../store'
import { SyncEngine } from './syncEngine'
import { RpcRegistry } from '../socket/rpcRegistry'
import { MACHINE_CAPABILITIES } from '@hapi/protocol'
import type { RpcGateway } from './rpcGateway'
import type { ForkArchivedCodexRequest } from '@hapi/protocol/apiTypes'

function fixture() {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    const machineId = randomUUID()
    engine.getOrCreateMachine(machineId, { host: 'test', platform: 'win32', happyCliVersion: '1',
        capabilities: [MACHINE_CAPABILITIES.ForkArchivedCodex] }, null, 'ns')
    engine.handleMachineAlive({ machineId, time: Date.now() })
    const source = engine.getOrCreateSession('archived', { path: '/work', host: 'test', machineId, flavor: 'codex',
        lifecycleState: 'archived', archivedBy: 'hub', codexSessionId: 'native-source',
        conversationHistoryTurns: { boundary: 'turn-2' }, conversationHistoryPoints: { boundary: true }
    }, null, 'ns')
    store.messages.addMessage(source.id, { role: 'user', content: { type: 'text', text: 'old prompt' } }, 'boundary')
    store.messages.markMessagesInvoked(source.id, ['boundary'], Date.now())
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    let forks = 0, spawns = 0
    rpc.forkArchivedCodex = async (_machine, request) => {
        forks++
        expect(request.sourceSessionId).toBe(source.id)
        expect(engine.getSession(source.id)?.active).toBe(false)
        expect(engine.getSession(source.id)?.metadata?.lifecycleState).toBe('archived')
        return { nativeSessionId: 'native-child' }
    }
    rpc.spawnSession = async (...args) => {
        spawns++
        const id = args[12]!
        engine.handleSessionAlive({ sid: id, time: Date.now(), mode: 'remote' })
        engine.handleSessionReady({ sid: id, time: Date.now() })
        return { type: 'success', sessionId: id }
    }
    return { engine, store, source, machineId, rpc, counts: () => ({ forks, spawns }) }
}

describe('archived Codex fork coordination', () => {
    it('refuses local resume discovery of a CLI-archived source while its fork child is starting', async () => {
        const f = fixture()
        let entered!: () => void
        const spawning = new Promise<void>(resolve => { entered = resolve })
        let childId = ''
        try {
            const current = f.store.sessions.getSession(f.source.id)!
            f.store.sessions.updateSessionMetadata(f.source.id, { ...current.metadata as object, archivedBy: 'cli' }, current.metadataVersion, 'ns')
            ;(f.engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(f.source.id)
            f.rpc.spawnSession = async (...args) => {
                childId = args[12]!
                f.engine.handleSessionAlive({ sid: childId, time: Date.now(), mode: 'remote' })
                entered()
                return { type: 'success', sessionId: childId }
            }
            const pending = f.engine.forkConversation(f.source.id, 'ns')
            await spawning
            expect(f.engine.resolveLocalResumeTarget(f.source.id, 'ns')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(f.engine.resolveLocalResumeTarget(childId, 'ns')).toMatchObject({ type: 'error', code: 'resume_unavailable' })
            expect(f.engine.getSession(f.source.id)?.active).toBe(false)
            f.engine.handleSessionReady({ sid: childId, time: Date.now() })
            expect((await pending).type).toBe('success')
            expect(f.engine.resolveLocalResumeTarget(f.source.id, 'ns').type).toBe('success')
        } finally { f.engine.stop() }
    })
    it('keeps an unconfirmed resume fenced across sparse metadata and late activation until native ready', async () => {
        const f = fixture()
        try {
            f.rpc.spawnSession = async () => ({ type: 'error', message: 'startup unconfirmed' })
            const result = await f.engine.resumeSession(f.source.id, 'ns')
            expect(result).toMatchObject({ type: 'error', rollbackSafe: false })
            expect(f.engine.getSession(f.source.id)?.metadata?.codexResumePending).toEqual({ machineId: f.machineId, nativeSessionId: 'native-source' })
            const current = f.store.sessions.getSession(f.source.id)!
            f.store.sessions.updateSessionMetadata(f.source.id, { path: '/work', host: 'test' }, current.metadataVersion, 'ns')
            ;(f.engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(f.source.id)
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            f.engine.handleSessionAlive({ sid: f.source.id, time: Date.now(), mode: 'remote' })
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            expect(f.counts().forks).toBe(0)
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            f.engine.handleSessionReady({ sid: f.source.id, time: Date.now() })
            expect(f.engine.getSession(f.source.id)?.metadata?.codexResumePending).toBeUndefined()
        } finally { f.engine.stop() }
    })

    it('retains an unconfirmed resume across Hub restart and reconciles only a proven stopped process', async () => {
        const f = fixture()
        let restarted: SyncEngine | undefined
        try {
            f.rpc.spawnSession = async () => ({ type: 'error', message: 'startup unconfirmed' })
            await f.engine.reopenSession(f.source.id, 'ns')
            f.engine.stop()
            restarted = new SyncEngine(f.store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
            expect((await restarted.forkConversation(f.source.id, 'ns')).type).toBe('error')
            const rpc = (restarted as unknown as { rpcGateway: RpcGateway }).rpcGateway
            rpc.stopRunnerSession = async () => 'unknown'
            expect((await restarted.resumeSession(f.source.id, 'ns')).type).toBe('error')
            expect(restarted.getSession(f.source.id)?.metadata?.codexResumePending).toBeDefined()
            rpc.stopRunnerSession = async () => 'already_gone'
            rpc.spawnSession = async () => ({ type: 'error', message: 'confirmed refusal', childStarted: false })
            await restarted.resumeSession(f.source.id, 'ns')
            expect(restarted.getSession(f.source.id)?.metadata?.codexResumePending).toBeUndefined()
        } finally { restarted?.stop(); f.engine.stop() }
    })

    it('releases confirmed pre-start failure immediately and permits an archived fork', async () => {
        const f = fixture()
        try {
            const spawn = f.rpc.spawnSession
            f.rpc.spawnSession = async () => ({ type: 'error', message: 'confirmed refusal', childStarted: false })
            await f.engine.reopenSession(f.source.id, 'ns')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexResumePending).toBeUndefined()
            f.rpc.spawnSession = spawn
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('success')
        } finally { f.engine.stop() }
    })

    it('keeps an unconfirmed resume fenced until archive proves Runner termination', async () => {
        const f = fixture()
        try {
            f.rpc.spawnSession = async () => ({ type: 'error', message: 'startup unconfirmed' })
            await f.engine.resumeSession(f.source.id, 'ns')
            f.rpc.killSession = async () => ({})
            f.rpc.stopRunnerSession = async () => 'unknown'
            await expect(f.engine.archiveSession(f.source.id)).rejects.toThrow('still running')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexResumePending).toBeDefined()
            f.rpc.stopRunnerSession = async () => 'already_gone'
            await f.engine.archiveSession(f.source.id)
            expect(f.engine.getSession(f.source.id)?.metadata?.codexResumePending).toBeUndefined()
            expect(f.engine.getSession(f.source.id)?.metadata?.lifecycleState).toBe('archived')
        } finally { f.engine.stop() }
    })

    it.each(['resume', 'reopen'])('rejects a fork while an earlier %s is awaiting startup confirmation', async action => {
        const f = fixture()
        let finish!: () => void
        let spawned!: () => void
        const entered = new Promise<void>(resolve => { spawned = resolve })
        const gate = new Promise<void>(resolve => { finish = resolve })
        f.rpc.spawnSession = async (...args) => {
            spawned()
            await gate
            f.engine.handleSessionAlive({ sid: args[12]!, time: Date.now(), mode: 'remote' })
            f.engine.handleSessionReady({ sid: args[12]!, time: Date.now() })
            return { type: 'success', sessionId: args[12]! }
        }
        try {
            const pending = action === 'resume' ? f.engine.resumeSession(f.source.id, 'ns') : f.engine.reopenSession(f.source.id, 'ns')
            await entered
            const fork = await f.engine.forkConversation(f.source.id, 'ns', 'boundary')
            expect(fork.type).toBe('error')
            expect(f.counts().forks).toBe(0)
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            finish()
            expect((await pending).type).toBe('success')
            // The startup lock is released after confirmation, even though the
            // original source is now active.
            expect((await f.engine.reopenSession(f.source.id, 'ns')).type).toBe('success')
        } finally { finish(); f.engine.stop() }
    })

    it.each(['resume', 'reopen'])('coalesces concurrent %s requests so parallel callers share in-flight startup', async action => {
        const f = fixture()
        let finish!: () => void
        let spawned!: () => void
        const entered = new Promise<void>(resolve => { spawned = resolve })
        const gate = new Promise<void>(resolve => { finish = resolve })
        let spawnCount = 0
        f.rpc.spawnSession = async (...args) => {
            spawnCount++
            spawned()
            await gate
            f.engine.handleSessionAlive({ sid: args[12]!, time: Date.now(), mode: 'remote' })
            f.engine.handleSessionReady({ sid: args[12]!, time: Date.now() })
            return { type: 'success', sessionId: args[12]! }
        }
        try {
            const call = () => action === 'resume' ? f.engine.resumeSession(f.source.id, 'ns') : f.engine.reopenSession(f.source.id, 'ns')
            const first = call()
            await entered
            const second = call()
            finish()
            const [r1, r2] = await Promise.all([first, second])
            expect(r1.type).toBe('success')
            expect(r2.type).toBe('success')
            expect(spawnCount).toBe(1)
        } finally { finish(); f.engine.stop() }
    })

    it('releases a fresh ownership rejection so source reconnection cannot trap lifecycle actions', async () => {
        const f = fixture()
        try {
            f.rpc.forkArchivedCodex = async () => {
                f.engine.handleSessionAlive({ sid: f.source.id, time: Date.now(), mode: 'remote' })
                return { error: 'Thread belongs to another Codex runtime', rollbackSafe: true }
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            expect((await f.engine.reopenSession(f.source.id, 'ns')).type).toBe('success')
        } finally { f.engine.stop() }
    })
    it.each(['offline', 'old-runner', 'queued', 'diverged', 'missing-native'])('rejects %s before reserving a child', async condition => {
        const f = fixture()
        try {
            if (condition === 'offline') f.engine.getMachine(f.machineId)!.active = false
            if (condition === 'old-runner') f.engine.getMachine(f.machineId)!.metadata!.capabilities = []
            if (condition === 'queued') f.store.messages.addMessage(f.source.id, { role: 'user', content: 'not invoked' }, 'queued')
            if (condition === 'diverged' || condition === 'missing-native') {
                const current = f.store.sessions.getSession(f.source.id)!
                f.store.sessions.updateSessionMetadata(f.source.id, {
                    ...current.metadata as Record<string, unknown>,
                    ...(condition === 'diverged' ? { conversationHistoryDiverged: true } : { codexSessionId: null })
                }, current.metadataVersion, 'ns')
                ;(f.engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(f.source.id)
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            expect(f.counts()).toEqual({ forks: 0, spawns: 0 })
        } finally { f.engine.stop() }
    })
    it('preserves a pending reservation across sparse CLI writes and releases it explicitly after success', async () => {
        const f = fixture()
        try {
            const actual = f.rpc.forkArchivedCodex
            f.rpc.forkArchivedCodex = async (machine, request) => {
                const current = f.store.sessions.getSession(f.source.id)!
                const write = f.store.sessions.updateSessionMetadata(f.source.id,
                    { path: '/work', host: 'test' }, current.metadataVersion, 'ns')
                expect(write.result).toBe('success')
                const saved = f.store.sessions.getSession(f.source.id)!.metadata as Record<string, unknown>
                expect(saved.codexArchivedFork).toBeDefined()
                return actual.call(f.rpc, machine, request)
            }
            const result = await f.engine.forkConversation(f.source.id, 'ns')
            expect(result.type).toBe('success')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
        } finally { f.engine.stop() }
    })
    it('clears a reservation when native validation proves no mutation occurred', async () => {
        const f = fixture()
        try {
            f.rpc.forkArchivedCodex = async () => ({ error: 'Native source history is missing', rollbackSafe: true })
            const result = await f.engine.forkConversation(f.source.id, 'ns')
            expect(result.type).toBe('error')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            expect(f.counts().spawns).toBe(0)
        } finally { f.engine.stop() }
    })
    it('creates one independent child without activating or altering archived source history', async () => {
        const f = fixture()
        try {
            const before = f.store.messages.getAllMessages(f.source.id)
            const result = await f.engine.forkConversation(f.source.id, 'ns', 'boundary')
            expect(result.type).toBe('success')
            if (result.type !== 'success') throw new Error(result.message)
            const child = f.engine.getSession(result.sessionId)!
            expect(child.metadata?.forkedFrom).toBe(f.source.id)
            expect(child.metadata?.codexSessionId).toBe('native-child')
            expect(child.active).toBe(true)
            expect(f.engine.getSession(f.source.id)?.active).toBe(false)
            expect(f.engine.getSession(f.source.id)?.metadata?.lifecycleState).toBe('archived')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            expect(f.store.messages.getAllMessages(f.source.id)).toEqual(before)
            expect(f.counts()).toEqual({ forks: 1, spawns: 1 })
        } finally { f.engine.stop() }
    })

    it('persists the reservation after lost native response, blocking reopen and delete until retry', async () => {
        const f = fixture()
        try {
            const actual = f.rpc.forkArchivedCodex
            let firstOperation: string | undefined
            f.rpc.forkArchivedCodex = async (_machine, request) => {
                firstOperation = request.operationId
                throw new Error('connection lost')
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            expect((await f.engine.reopenSession(f.source.id, 'ns')).type).toBe('error')
            expect((await f.engine.resumeSession(f.source.id, 'ns')).type).toBe('error')
            await expect(f.engine.deleteSession(f.source.id)).rejects.toThrow('pending')
            const reserved = f.engine.getSession(f.source.id)!.metadata!.codexArchivedFork!.childSessionId
            expect((await f.engine.reopenSession(reserved, 'ns')).type).toBe('error')
            expect((await f.engine.forkConversation(reserved, 'ns')).type).toBe('error')
            await expect(f.engine.archiveSession(reserved)).rejects.toThrow('in progress')
            await expect(f.engine.deleteSession(reserved)).rejects.toThrow('pending')
            f.rpc.forkArchivedCodex = async (machine, request) => {
                expect(request.operationId).toBe(firstOperation!)
                return actual.call(f.rpc, machine, request)
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('success')
        } finally { f.engine.stop() }
    })

    it('reconciles a failed launcher and reuses its native child without another fork', async () => {
        const f = fixture()
        try {
            const actual = f.rpc.spawnSession
            f.rpc.spawnSession = async () => ({ type: 'error', message: 'launcher rejected', childStarted: false })
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            const childId = f.engine.getSession(f.source.id)!.metadata!.codexArchivedFork!.childSessionId
            let stopped: string | undefined
            f.rpc.stopRunnerSession = async (_machine, id) => { stopped = id; return 'already_gone' }
            f.rpc.spawnSession = actual
            const result = await f.engine.forkConversation(f.source.id, 'ns')
            expect(result).toEqual({ type: 'success', sessionId: childId })
            expect(stopped).toBe(childId)
            expect(f.counts().forks).toBe(1)
        } finally { f.engine.stop() }
    })

    it('retries an interrupted historical fork with its reserved native boundary after sparse metadata replacement', async () => {
        const f = fixture()
        try {
            let original: ForkArchivedCodexRequest | undefined
            f.rpc.forkArchivedCodex = async (_machine, request) => {
                original = structuredClone(request)
                throw new Error('native response lost')
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns', 'boundary')).type).toBe('error')
            const current = f.store.sessions.getSession(f.source.id)!
            f.store.sessions.updateSessionMetadata(f.source.id, { path: '/work', host: 'test' }, current.metadataVersion, 'ns')
            ;(f.engine as unknown as { sessionCache: { refreshSession(id: string): void } }).sessionCache.refreshSession(f.source.id)
            expect(f.engine.getSession(f.source.id)?.metadata?.conversationHistoryTurns).toBeUndefined()
            f.rpc.forkArchivedCodex = async (_machine, request) => {
                expect(request).toEqual(original!)
                return { nativeSessionId: 'native-child' }
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns', 'boundary')).type).toBe('success')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
        } finally { f.engine.stop() }
    })

    it('does not complete an active child retry until native readiness is confirmed again', async () => {
        const f = fixture()
        try {
            f.rpc.spawnSession = async (...args) => {
                f.engine.handleSessionAlive({ sid: args[12]!, time: Date.now(), mode: 'remote' })
                return { type: 'error', message: 'startup interrupted', childStarted: false }
            }
            expect((await f.engine.forkConversation(f.source.id, 'ns')).type).toBe('error')
            const child = f.engine.getSession(f.source.id)!.metadata!.codexArchivedFork!.childSessionId
            let completed = false
            const retry = f.engine.forkConversation(f.source.id, 'ns').then(result => { completed = true; return result })
            await new Promise(resolve => setTimeout(resolve, 10))
            expect(completed).toBe(false)
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeDefined()
            f.engine.handleSessionReady({ sid: child, time: Date.now() })
            expect(await retry).toEqual({ type: 'success', sessionId: child })
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
        } finally { f.engine.stop() }
    })

    it('accepts a late native-ready binding after an ambiguous spawn acknowledgement', async () => {
        const f = fixture()
        try {
            f.rpc.spawnSession = async (...args) => {
                setTimeout(() => {
                    f.engine.handleSessionAlive({ sid: args[12]!, time: Date.now(), mode: 'remote' })
                    f.engine.handleSessionReady({ sid: args[12]!, time: Date.now() })
                }, 10)
                return { type: 'error', message: 'spawn acknowledgement timed out' }
            }
            const result = await f.engine.forkConversation(f.source.id, 'ns')
            expect(result.type).toBe('success')
            expect(f.counts().forks).toBe(1)
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
        } finally { f.engine.stop() }
    })

    it('rejects wrong namespace and stale historical boundary before creating reservations', async () => {
        const f = fixture()
        try {
            expect((await f.engine.forkConversation(f.source.id, 'other')).type).toBe('error')
            expect((await f.engine.forkConversation(f.source.id, 'ns', 'missing')).type).toBe('error')
            expect(f.engine.getSession(f.source.id)?.metadata?.codexArchivedFork).toBeUndefined()
            expect(f.counts()).toEqual({ forks: 0, spawns: 0 })
        } finally { f.engine.stop() }
    })
})
