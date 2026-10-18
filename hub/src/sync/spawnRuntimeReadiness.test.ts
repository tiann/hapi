import { describe, expect, it, spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'
import type { SpawnSessionWithRemitRequest } from '@hapi/protocol/apiTypes'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import type { RpcGateway } from './rpcGateway'
import { SessionCache } from './sessionCache'

function createHarness(
    selection: Partial<SpawnSessionWithRemitRequest>,
    onSpawn: (engine: SyncEngine, sessionId: string) => void = () => {}
) {
    const store = new Store(':memory:')
    const engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    engine.stop()
    const machine = engine.getOrCreateMachine('runtime-machine', {
        host: 'localhost', platform: 'linux', happyCliVersion: 'test'
    }, null, 'default')
    const request: SpawnSessionWithRemitRequest = {
        directory: '/tmp/project', agent: 'claude', message: 'perform the task',
        remitId: randomUUID(), waitActiveSecs: 1, ...selection
    }
    let childId = ''
    let delivered = false
    const queuedState = engine.getQueuedState.bind(engine)
    spyOn(engine, 'getQueuedState').mockImplementation((id, localIds) => ({
        ...queuedState(id, localIds), queuedLocalIds: delivered ? [request.remitId] : []
    }))
    const sendMessage = spyOn(engine, 'sendMessage').mockImplementation(async () => { delivered = true })
    const rpc = (engine as unknown as { rpcGateway: RpcGateway }).rpcGateway
    const stopChild = spyOn(rpc, 'stopRunnerSession').mockResolvedValue('already_gone')
    spyOn(engine, 'spawnSession').mockImplementation(async (...args) => {
        childId = args[12]!
        engine.handleSessionAlive({ sid: childId, time: Date.now() })
        onSpawn(engine, childId)
        return { type: 'success', sessionId: childId }
    })
    const spawn = () => engine.spawnSessionWithRemit(machine.id, 'default', request)
    return { engine, request, machine, sendMessage, stopChild, spawn, get childId() { return childId } }
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 20))

describe('atomic spawn runtime readiness', () => {
    it('waits for all independently reported fields despite matching reservation defaults', async () => {
        const h = createHarness({ model: 'claude-model', effort: 'high', permissionMode: 'bypassPermissions' })
        const pending = h.spawn()
        await pause()
        expect(h.engine.getSession(h.childId)).toMatchObject({ active: true, model: 'claude-model', effort: 'high' })
        expect(h.sendMessage).not.toHaveBeenCalled()
        expect(h.stopChild).not.toHaveBeenCalled()

        h.engine.handleSessionAlive({ sid: h.childId, time: Date.now(), permissionMode: 'bypassPermissions' })
        await pause()
        expect(h.sendMessage).not.toHaveBeenCalled()
        h.engine.handleSessionAlive({ sid: h.childId, time: Date.now(), model: 'claude-model', effort: 'high' })
        expect(await pending).toMatchObject({ type: 'success', sessionId: h.childId })
        expect(h.sendMessage).toHaveBeenCalledTimes(1)
        expect(h.stopChild).not.toHaveBeenCalled()
    })

    it('rejects an actually reported wrong permission and cleans up without delivery', async () => {
        const h = createHarness({ permissionMode: 'bypassPermissions' }, (engine, sid) => {
            engine.handleSessionAlive({ sid, time: Date.now(), permissionMode: 'default' })
        })
        expect(await h.spawn()).toMatchObject({ type: 'error', code: 'spawn_selection_mismatch', cleanedUp: true })
        expect(h.stopChild).toHaveBeenCalledWith(h.machine.id, h.childId)
        expect(h.sendMessage).not.toHaveBeenCalled()
    })

    it('does not treat matching seeded model and effort as proof before the deadline', async () => {
        const h = createHarness({ model: 'claude-model', effort: 'high', waitActiveSecs: 0.05 })
        expect(await h.spawn()).toMatchObject({ type: 'error', code: 'spawn_timeout', cleanedUp: true })
        expect(h.stopChild).toHaveBeenCalledTimes(1)
        expect(h.sendMessage).not.toHaveBeenCalled()
    })

    it('stops waiting when the child ends before reporting its settings', async () => {
        const h = createHarness({ permissionMode: 'bypassPermissions' })
        const pending = h.spawn()
        await pause()
        h.engine.handleSessionEnd({ sid: h.childId, time: Date.now(), reason: 'error' })
        expect(await pending).toMatchObject({ type: 'error', code: 'spawn_ended', cleanedUp: true })
        expect(h.sendMessage).not.toHaveBeenCalled()
    })

    it('uses the original active deadline even when a matching report is already available', async () => {
        let now = Date.now()
        const clock = spyOn(Date, 'now').mockImplementation(() => now)
        try {
            const h = createHarness({ model: 'claude-model', waitActiveSecs: 1 }, (engine, sid) => {
                engine.handleSessionAlive({ sid, time: now, model: 'claude-model' })
            })
            spyOn(h.engine, 'waitForSessionActive').mockImplementation(async () => { now += 1_000; return true })
            expect(await h.spawn()).toMatchObject({ type: 'error', code: 'spawn_timeout', cleanedUp: true })
            expect(h.sendMessage).not.toHaveBeenCalled()
        } finally {
            clock.mockRestore()
        }
    })

    it('rejects an explicit null runtime value rather than treating it as an absent report', async () => {
        const h = createHarness({ serviceTier: 'fast' }, (engine, sid) => {
            engine.handleSessionAlive({ sid, time: Date.now(), serviceTier: null })
        })
        expect(await h.spawn()).toMatchObject({ type: 'error', code: 'spawn_selection_mismatch', cleanedUp: true })
        expect(h.sendMessage).not.toHaveBeenCalled()
    })
})

describe('reported runtime evidence', () => {
    it('does not use persisted preferences or retain evidence across end, restart, or expired activation', () => {
        const store = new Store(':memory:')
        const publisher = { emit() {} } as never
        const cache = new SessionCache(store, publisher)
        const session = cache.getOrCreateSession('runtime-evidence', {
            path: '/tmp/project', host: 'localhost', flavor: 'claude', preferredPermissionMode: 'bypassPermissions'
        }, null, 'default', 'claude-model', 'high')
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), permissionMode: 'bypassPermissions' })
        expect(cache.getReportedRuntime(session.id)).toEqual({ permissionMode: 'bypassPermissions' })

        const restarted = new SessionCache(store, publisher)
        restarted.refreshSession(session.id)
        expect(restarted.getSession(session.id)?.permissionMode).toBe('bypassPermissions')
        expect(restarted.getReportedRuntime(session.id)).toBeUndefined()

        cache.handleSessionEnd({ sid: session.id, time: Date.now() })
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
        cache.handleSessionAlive({ sid: session.id, time: Date.now() })
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), permissionMode: 'bypassPermissions' })
        cache.expireInactive(Date.now() + 30_001)
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
        cache.handleSessionAlive({ sid: session.id, time: Date.now() })
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
    })

    it('does not count a stale heartbeat rejected by the existing config watermark', () => {
        const cache = new SessionCache(new Store(':memory:'), { emit() {} } as never)
        const session = cache.getOrCreateSession('stale-runtime', {
            path: '/tmp/project', host: 'localhost', flavor: 'claude'
        }, null, 'default')
        const before = Date.now() - 100
        cache.applySessionConfig(session.id, { permissionMode: 'bypassPermissions' })
        cache.handleSessionAlive({ sid: session.id, time: before, permissionMode: 'default' })
        expect(cache.getReportedRuntime(session.id)).toBeUndefined()
        expect(cache.getSession(session.id)?.permissionMode).toBe('bypassPermissions')
        cache.handleSessionAlive({ sid: session.id, time: Date.now(), permissionMode: 'bypassPermissions' })
        expect(cache.getReportedRuntime(session.id)).toEqual({ permissionMode: 'bypassPermissions' })
    })
})
