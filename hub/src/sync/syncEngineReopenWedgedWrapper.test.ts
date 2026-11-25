import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Socket } from 'socket.io'
import { getSessionStopPreparationMethod, RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

type Child = { pid: number; connects: boolean }

/**
 * A runner-spawned wrapper can stay alive after its hub socket closed (event
 * loop blocked). The runner keeps deduping spawns for that HAPI id while the
 * child lives, so reopen must stop the unreachable wrapper first.
 *
 * The real RpcGateway runs (registry lookups, session RPC, spawn and stop
 * response parsing); only the runner behind the machine RPC and the wrapper
 * sockets are simulated. The fake runner follows the recovery contract: it
 * signals only the named pid and asks the hub once right before.
 */
describe('SyncEngine reopen of an unreachable runner wrapper', () => {
    const NAMESPACE = 'default'
    const MACHINE = 'machine-x'
    let store: Store
    let registry: RpcRegistry
    let engine: SyncEngine
    let rooms: Map<string, Set<string>>
    let sockets: Map<string, unknown>

    // Fake runner state: live children by HAPI id, with dedupe on that id.
    let children: Map<string, Child>
    let nextPid: number
    let spawnCalls: number
    let stopCalls: number
    let confirmations: boolean[]
    let lastRequest: { sessionId: string; pid: number; requestId: string } | undefined
    let wrapperPrepareCalls: number
    let duringStop: (() => void) | undefined
    let bootConnects: boolean
    let oldRunner: boolean

    const cache = () => (engine as unknown as { sessionCache: SessionCache }).sessionCache
    const gateway = () => (engine as unknown as { rpcGateway: Record<string, unknown> }).rpcGateway

    function insertInactiveSession(tag: string, overrides: Record<string, unknown> = {}, quietMs = 5 * 60_000): string {
        const created = cache().getOrCreateSession(tag, {
            path: '/tmp/proj',
            host: 'localhost',
            machineId: MACHINE,
            flavor: 'opencode',
            opencodeSessionId: `native-${tag}`,
            startedBy: 'runner',
            startedFromRunner: true,
            hostPid: 4242,
            lifecycleState: 'running',
            ...overrides,
        }, null, NAMESPACE)
        const session = cache().getSession(created.id)!
        session.active = false
        session.activeAt = Date.now() - quietMs
        return created.id
    }

    function connect(sessionId: string): void {
        registry.register({ id: `socket-${sessionId}` } as Socket, `${sessionId}:${RPC_METHODS.KillSession}`)
    }

    /** The wrapper process `pid` comes back: socket, room, handlers, keepalive. */
    function reconnectWrapper(sessionId: string, pid: number): void {
        const socket = {
            id: `live-${sessionId}`,
            timeout: () => ({
                emitWithAck: async () => {
                    wrapperPrepareCalls++
                    return { success: true, pid }
                },
            }),
        }
        sockets.set(socket.id, socket)
        rooms.set(`session:${sessionId}`, new Set([socket.id]))
        registry.register(socket as unknown as Socket, `${sessionId}:${RPC_METHODS.KillSession}`)
        registry.register(socket as unknown as Socket, `${sessionId}:${getSessionStopPreparationMethod(MACHINE, pid)}`)
        cache().markSessionActive(sessionId)
    }

    async function runnerRpc(_machineId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === RPC_METHODS.SpawnHappySession) {
            spawnCalls++
            const id = (params.reservedSessionId ?? params.existingSessionId) as string
            if (children.has(id)) return { type: 'success', sessionId: id, reusedChild: true }
            const child = { pid: nextPid++, connects: bootConnects }
            children.set(id, child)
            if (child.connects) cache().markSessionActive(id)
            return { type: 'success', sessionId: id }
        }
        if (method === RPC_METHODS.StopUnreachableSession) {
            if (oldRunner) throw new RpcTargetMissingError(`${MACHINE}:${method}`, 'handler-not-registered')
            stopCalls++
            lastRequest = params as typeof lastRequest
            const id = params.sessionId as string
            const child = children.get(id)
            if (!child) return { status: 'unknown' }
            if (child.pid !== params.pid) return { status: 'still_alive' }
            duringStop?.()
            const confirmed = engine.confirmRecoveryStop(id, MACHINE, child.pid, params.requestId as string)
            confirmations.push(confirmed)
            if (!confirmed) return { status: 'still_alive' }
            children.delete(id)
            return { status: 'stopped' }
        }
        throw new Error(`unexpected machine RPC ${method}`)
    }

    function createEngine(hubStartedMsAgo: number): void {
        const io = {
            of: () => ({ adapter: { rooms }, sockets, to: () => ({ emit() {} }) }),
        }
        engine = new SyncEngine(store, io as never, registry, { broadcast() {} } as never)
        ;(engine as unknown as { startedAt: number }).startedAt = Date.now() - hubStartedMsAgo
        ;(engine as unknown as { machineCache: unknown }).machineCache = {
            getOnlineMachinesByNamespace: () => [{ id: MACHINE, metadata: { host: 'localhost' } }],
            getMachineByNamespace: () => ({ id: MACHINE, metadata: { host: 'localhost' } }),
            getMachine: () => ({ id: MACHINE, metadata: { host: 'localhost' } }),
            expireInactive: () => {},
        }
        ;(engine as unknown as { waitForSessionActive: unknown }).waitForSessionActive =
            async (id: string) => cache().getSession(id)?.active === true
        gateway().machineRpc = runnerRpc
    }

    beforeEach(() => {
        store = new Store(':memory:')
        registry = new RpcRegistry()
        rooms = new Map()
        sockets = new Map()
        children = new Map()
        nextPid = 5000
        spawnCalls = 0
        stopCalls = 0
        confirmations = []
        lastRequest = undefined
        wrapperPrepareCalls = 0
        duringStop = undefined
        bootConnects = true
        oldRunner = false
        createEngine(10 * 60_000)
    })

    afterEach(() => {
        engine.stop()
    })

    it('stops a wedged wrapper through the recovery RPC and respawns it with native resume', async () => {
        const id = insertInactiveSession('wedged')
        children.set(id, { pid: 4242, connects: false })

        const result = await engine.reopenSession(id, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId: id, resumed: true })
        expect(stopCalls).toBe(1)
        expect(lastRequest).toMatchObject({ sessionId: id, pid: 4242 })
        expect(confirmations).toEqual([true])
        expect(spawnCalls).toBe(1)
        expect(children.get(id)?.pid).not.toBe(4242)
        expect(cache().getSession(id)?.active).toBe(true)
    })

    it('does not stop an unreachable wrapper when resume preflight rejects a cursor session without its native chat id', async () => {
        const id = insertInactiveSession('cursor-no-native', { flavor: 'cursor' })
        store.messages.addMessage(id, { role: 'user', content: 'stored before the wrapper went quiet' }, 'stored-user')
        children.set(id, { pid: 4242, connects: false })

        const result = await engine.reopenSession(id, NAMESPACE)

        expect(result).toMatchObject({ type: 'error', code: 'resume_unavailable' })
        expect(stopCalls).toBe(0)
        expect(spawnCalls).toBe(0)
        expect(children.get(id)?.pid).toBe(4242)
    })

    it('keeps today\'s path with a runner that predates the recovery RPC', async () => {
        oldRunner = true
        const id = insertInactiveSession('old-runner')
        children.set(id, { pid: 4242, connects: false })
        const warn = spyOn(console, 'warn').mockImplementation(() => {})
        try {
            expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('error')
            expect(warn.mock.calls.some(([message]) => String(message).endsWith('failed'))).toBe(true)
        } finally {
            warn.mockRestore()
        }
        expect(children.get(id)?.pid).toBe(4242)
        expect(spawnCalls).toBe(1)
    })

    it('does not stop a wrapper that a recent reopen spawned and that is still booting', async () => {
        const id = insertInactiveSession('late-boot')
        bootConnects = false
        children.set(id, { pid: 4242, connects: false })
        // The first reopen replaces the wedged child with one that is slow to connect.
        const first = await engine.reopenSession(id, NAMESPACE)
        expect(first.type).toBe('error')
        expect(stopCalls).toBe(1)
        const bootingPid = children.get(id)!.pid
        expect(bootingPid).not.toBe(4242)

        // A retry right after must join the booting child, not kill it.
        const retry = await engine.reopenSession(id, NAMESPACE)
        expect(retry.type).toBe('error')
        expect(stopCalls).toBe(1)
        expect(children.get(id)?.pid).toBe(bootingPid)
    })

    it('does not let deduplicated spawns extend the quiet period', async () => {
        const id = insertInactiveSession('retries', {}, 30_000)
        children.set(id, { pid: 4242, connects: false })

        // Inside the quiet period each retry rejoins the wedged child.
        for (let attempt = 0; attempt < 3; attempt++) {
            expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('error')
        }
        expect(stopCalls).toBe(0)
        expect(spawnCalls).toBe(3)

        // Once the last keepalive is 60s old, the next retry recovers it.
        cache().getSession(id)!.activeAt = Date.now() - 61_000
        expect(await engine.reopenSession(id, NAMESPACE)).toEqual({ type: 'success', sessionId: id, resumed: true })
        expect(stopCalls).toBe(1)
        expect(children.get(id)?.pid).not.toBe(4242)
    })

    it('does not let a cached startup error extend the quiet period', async () => {
        const id = insertInactiveSession('cached-error', {}, 61_000)
        children.set(id, { pid: 4242, connects: false })
        const runner = runnerRpc
        gateway().machineRpc = async (machineId: string, method: string, params: Record<string, unknown>) =>
            method === RPC_METHODS.SpawnHappySession
                ? { type: 'error', errorMessage: 'Session webhook timeout', reusedChild: true }
                : runner(machineId, method, params)
        await (gateway().spawnSession as (...args: unknown[]) => Promise<unknown>)(MACHINE, '/tmp/proj', 'opencode',
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, id)
        gateway().machineRpc = runner

        expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('success')
        expect(stopCalls).toBe(1)
    })

    it('does not stop a wrapper that another hub spawn path just started', async () => {
        const id = insertInactiveSession('generic-spawn')
        bootConnects = false
        const spawned = await engine.spawnSession(MACHINE, '/tmp/proj', 'opencode', undefined, undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, id)
        expect(spawned).toEqual({ type: 'success', sessionId: id })
        const bootingPid = children.get(id)!.pid

        expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('error')
        expect(stopCalls).toBe(0)
        expect(children.get(id)?.pid).toBe(bootingPid)
    })

    it('does not stop anything within the quiet period after the hub process started', async () => {
        engine.stop()
        createEngine(5_000)
        const id = insertInactiveSession('hub-restart')
        children.set(id, { pid: 4242, connects: false })

        expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('error')
        expect(stopCalls).toBe(0)
        expect(children.get(id)?.pid).toBe(4242)
    })

    it('keeps today\'s path for a wrapper that went quiet recently or is still connected', async () => {
        const quiet = insertInactiveSession('recently-quiet', {}, 20_000)
        children.set(quiet, { pid: 4242, connects: false })
        const reachable = insertInactiveSession('connected')
        children.set(reachable, { pid: 4243, connects: false })
        connect(reachable)
        const inRoom = insertInactiveSession('in-room')
        children.set(inRoom, { pid: 4244, connects: false })
        rooms.set(`session:${inRoom}`, new Set(['socket-room']))

        expect((await engine.reopenSession(quiet, NAMESPACE)).type).toBe('error')
        expect((await engine.reopenSession(reachable, NAMESPACE)).type).toBe('error')
        expect((await engine.reopenSession(inRoom, NAMESPACE)).type).toBe('error')
        expect(stopCalls).toBe(0)
    })

    for (const flavor of ['opencode', 'claude'] as const) {
        it(`keeps a ${flavor} wrapper that reconnects with its prepare handler during the stop`, async () => {
            const id = insertInactiveSession(`${flavor}-reconnects`, { flavor, claudeSessionId: 'native-claude' })
            children.set(id, { pid: 4242, connects: false })
            duringStop = () => reconnectWrapper(id, 4242)

            const result = await engine.reopenSession(id, NAMESPACE)

            expect(confirmations).toEqual([false])
            expect(wrapperPrepareCalls).toBe(0)
            expect(children.get(id)?.pid).toBe(4242)
            expect(result).toEqual({ type: 'success', sessionId: id, resumed: true })
        })
    }

    it('confirms only the live request for its own process, never a late or foreign one', async () => {
        const id = insertInactiveSession('scoped', { flavor: 'claude', claudeSessionId: 'native-claude' })
        children.set(id, { pid: 4242, connects: false })
        let probes: boolean[] = []
        duringStop = () => {
            const request = lastRequest!
            probes = [
                engine.confirmRecoveryStop(id, MACHINE, 7777, request.requestId),
                engine.confirmRecoveryStop(id, 'machine-other', 4242, request.requestId),
                engine.confirmRecoveryStop(id, MACHINE, 4242, 'another-request'),
            ]
        }
        await engine.reopenSession(id, NAMESPACE)
        expect(probes).toEqual([false, false, false])
        expect(confirmations).toEqual([true])

        // After reopen returned, the same request no longer confirms anything.
        expect(engine.confirmRecoveryStop(id, MACHINE, 4242, lastRequest!.requestId)).toBe(false)
        // Ordinary stops keep their own coordination.
        await expect(engine.prepareOpenCodeSessionStop(id, 4242, 'gen', { id: 'lease', expiresAt: 1 }, MACHINE))
            .resolves.toBe('not_required')
    })

    it('logs a stop that did not stop anything and still resumes', async () => {
        const id = insertInactiveSession('already-exited')
        const warn = spyOn(console, 'warn').mockImplementation(() => {})
        try {
            const result = await engine.reopenSession(id, NAMESPACE)
            expect(result.type).toBe('success')
            expect(stopCalls).toBe(1)
            expect(warn.mock.calls.some(([message]) => String(message).endsWith(': unknown'))).toBe(true)
        } finally {
            warn.mockRestore()
        }
    })

    it('never stops terminal-started, archived, never-booted or codex wrappers', async () => {
        const terminal = insertInactiveSession('terminal', { startedBy: 'terminal', startedFromRunner: false })
        const neverBooted = insertInactiveSession('never-booted', { hostPid: undefined })
        const codex = insertInactiveSession('codex', { flavor: 'codex', codexSessionId: 'thread-1' })
        const archived = insertInactiveSession('archived', { lifecycleState: 'archived', archivedBy: 'hub', archiveReason: 'test' })
        for (const id of [terminal, neverBooted, codex, archived]) {
            children.set(id, { pid: 4242, connects: false })
            await engine.reopenSession(id, NAMESPACE)
        }
        expect(stopCalls).toBe(0)
    })

    it('keeps OpenCode rewind reconciliation blocking even for an unreachable wrapper', async () => {
        const id = insertInactiveSession('rewind')
        const current = store.sessions.getSession(id)!
        const operation = { operationId: 'op', nativeSessionId: 'native', workerId: 'worker',
            requestedLocalId: 'turn', nativeMessageId: 'native-turn', cutoffSeq: 1, sourceEpoch: 0,
            sourceMaxSeq: 1, reservationVersion: 1, sourceTranscriptHash: 'a'.repeat(64), phase: 'prepared' }
        store.sessions.updateSessionMetadata(id, { ...current.metadata as object, opencodeRewind: operation },
            current.metadataVersion, NAMESPACE)
        cache().refreshSession(id)
        cache().getSession(id)!.activeAt = Date.now() - 5 * 60_000
        children.set(id, { pid: 4242, connects: false })

        await engine.reopenSession(id, NAMESPACE)

        expect(confirmations).toEqual([false])
        expect(children.get(id)?.pid).toBe(4242)
    })
})
