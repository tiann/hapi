import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test'
import type { Socket } from 'socket.io'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

type Child = { pid: number; marker: string; connects: boolean }
type PrepareProbe = { pid: number; marker: string }

/**
 * A runner-spawned wrapper can stay alive after its hub socket closed (event
 * loop blocked). The runner keeps deduping spawns for that HAPI id while the
 * child lives, so reopen must stop the unreachable wrapper first.
 *
 * The real RpcGateway runs (registry lookups, session RPC, spawn and stop
 * response parsing); only the runner behind the machine RPC is simulated.
 */
describe('SyncEngine reopen of an unreachable runner wrapper', () => {
    const NAMESPACE = 'default'
    const MACHINE = 'machine-x'
    const LEASE = { id: 'lease', expiresAt: 123456 }
    let store: Store
    let registry: RpcRegistry
    let engine: SyncEngine
    let rooms: Map<string, Set<string>>

    // Fake runner state: live children by HAPI id, with dedupe on that id.
    let children: Map<string, Child>
    let nextPid: number
    let spawnCalls: number
    let stopCalls: number
    let prepareOutcomes: string[]
    // Extra prepare-stop calls the fake runner makes before its own target.
    let extraPrepares: PrepareProbe[]
    let duringStop: (() => void) | undefined
    let bootConnects: boolean

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

    async function prepare(sessionId: string, probe: PrepareProbe): Promise<string> {
        try {
            return await engine.prepareOpenCodeSessionStop(sessionId, probe.pid, probe.marker, LEASE, MACHINE)
        } catch (error) {
            return error instanceof Error ? error.name : 'error'
        }
    }

    async function runnerRpc(_machineId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
        if (method === RPC_METHODS.SpawnHappySession) {
            spawnCalls++
            const id = (params.reservedSessionId ?? params.existingSessionId) as string
            if (!children.has(id)) {
                const child = { pid: nextPid++, marker: `gen-${nextPid}`, connects: bootConnects }
                children.set(id, child)
                if (child.connects) cache().markSessionActive(id)
            }
            return { type: 'success', sessionId: id }
        }
        if (method === RPC_METHODS.StopSession) {
            stopCalls++
            const id = params.sessionId as string
            const child = children.get(id)
            if (!child) return { status: 'unknown' }
            duringStop?.()
            for (const probe of extraPrepares) prepareOutcomes.push(await prepare(id, probe))
            if (cache().getSession(id)?.metadata?.flavor === 'opencode') {
                const outcome = await prepare(id, child)
                prepareOutcomes.push(outcome)
                if (outcome !== 'ready' && outcome !== 'not_required') return { status: 'still_alive' }
            }
            children.delete(id)
            return { status: 'stopped' }
        }
        throw new Error(`unexpected machine RPC ${method}`)
    }

    function createEngine(hubStartedMsAgo: number): void {
        const io = {
            of: () => ({ adapter: { rooms }, sockets: new Map(), to: () => ({ emit() {} }) }),
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
        children = new Map()
        nextPid = 5000
        spawnCalls = 0
        stopCalls = 0
        prepareOutcomes = []
        extraPrepares = []
        duringStop = undefined
        bootConnects = true
        createEngine(10 * 60_000)
    })

    afterEach(() => {
        engine.stop()
    })

    it('stops a wedged wrapper without the drain and respawns it with native resume', async () => {
        const id = insertInactiveSession('wedged')
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })

        const result = await engine.reopenSession(id, NAMESPACE)

        expect(result).toEqual({ type: 'success', sessionId: id, resumed: true })
        expect(stopCalls).toBe(1)
        expect(prepareOutcomes).toEqual(['not_required'])
        expect(spawnCalls).toBe(1)
        expect(children.get(id)?.pid).not.toBe(4242)
        expect(cache().getSession(id)?.active).toBe(true)
    })

    it('does not stop a wrapper that a recent reopen spawned and that is still booting', async () => {
        const id = insertInactiveSession('late-boot')
        bootConnects = false
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })
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
        children.set(id, { pid: 4242, marker: 'gen-booting', connects: false })

        expect((await engine.reopenSession(id, NAMESPACE)).type).toBe('error')
        expect(stopCalls).toBe(0)
        expect(children.get(id)?.pid).toBe(4242)
    })

    it('keeps today\'s path for a wrapper that went quiet recently or is still connected', async () => {
        const quiet = insertInactiveSession('recently-quiet', {}, 20_000)
        children.set(quiet, { pid: 4242, marker: 'gen-a', connects: false })
        const reachable = insertInactiveSession('connected')
        children.set(reachable, { pid: 4243, marker: 'gen-b', connects: false })
        connect(reachable)
        const inRoom = insertInactiveSession('in-room')
        children.set(inRoom, { pid: 4244, marker: 'gen-c', connects: false })
        rooms.set(`session:${inRoom}`, new Set(['socket-room']))

        expect((await engine.reopenSession(quiet, NAMESPACE)).type).toBe('error')
        expect((await engine.reopenSession(reachable, NAMESPACE)).type).toBe('error')
        expect((await engine.reopenSession(inRoom, NAMESPACE)).type).toBe('error')
        expect(stopCalls).toBe(0)
    })

    it('keeps the drain when the wrapper reconnects while the stop is in flight', async () => {
        const id = insertInactiveSession('reconnects')
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })
        duringStop = () => connect(id)

        await engine.reopenSession(id, NAMESPACE)

        expect(stopCalls).toBe(1)
        expect(prepareOutcomes).toEqual(['RpcTargetMissingError'])
        expect(children.get(id)?.pid).toBe(4242)
    })

    it('refuses to skip the drain for any other prepare-stop during the window', async () => {
        const id = insertInactiveSession('scoped-window')
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })
        extraPrepares = [{ pid: 7777, marker: 'gen-other' }]

        const result = await engine.reopenSession(id, NAMESPACE)

        expect(prepareOutcomes).toEqual(['RpcTargetMissingError', 'not_required'])
        expect(result.type).toBe('success')
    })

    it('refuses to skip the drain once the stop deadline has passed', async () => {
        const id = insertInactiveSession('expired-window')
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })
        duringStop = () => {
            const stops = (engine as unknown as { unreachableWrapperStops: Map<string, { deadline: number }> }).unreachableWrapperStops
            stops.get(id)!.deadline = Date.now() - 1
        }

        await engine.reopenSession(id, NAMESPACE)

        expect(prepareOutcomes).toEqual(['RpcTargetMissingError'])
        expect(children.get(id)?.pid).toBe(4242)
    })

    it('scopes the drain skip to the reopen that requested the stop', async () => {
        const id = insertInactiveSession('scoped')
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })
        await engine.reopenSession(id, NAMESPACE)
        expect(prepareOutcomes).toEqual(['not_required'])

        await expect(engine.prepareOpenCodeSessionStop(id, 4242, 'gen-wedged', LEASE, MACHINE))
            .rejects.toBeInstanceOf(RpcTargetMissingError)
        await expect(engine.prepareOpenCodeSessionStop(id, 4242, 'gen-wedged', LEASE, 'machine-other'))
            .rejects.toThrow('Session machine does not match runner')
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
            children.set(id, { pid: 4242, marker: 'gen', connects: false })
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
        children.set(id, { pid: 4242, marker: 'gen-wedged', connects: false })

        await engine.reopenSession(id, NAMESPACE)

        expect(prepareOutcomes).toEqual(['Error'])
        expect(children.get(id)?.pid).toBe(4242)
    })
})
