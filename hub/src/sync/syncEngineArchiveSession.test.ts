import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError, RunnerStopRpcError } from './rpcGateway'
import { ArchiveCleanupError } from './archiveCleanupError'
import type { SessionCache } from './sessionCache'

/**
 * #1910 / #1705: `killSession` is a session-socket RPC. A missing target does
 * not prove the runner child is dead. Archive must always ask the runner via
 * `stopRunnerSession` when a machineId is known, and must refuse to archive
 * when the runner reports the process still alive (or unknown).
 */
describe('SyncEngine.archiveSession runner reaping (#1910)', () => {
    const preparationLease = { id: 'fixture', expiresAt: 123456 }
    let store: Store
    let engine: SyncEngine
    const NAMESPACE = 'default'

    function cache(): SessionCache {
        return (engine as unknown as { sessionCache: SessionCache }).sessionCache
    }

    function insertActiveSession(
        tag: string,
        machineId?: string,
        hostPid?: number,
        opts?: { startedBy?: 'runner' | 'terminal'; startedFromRunner?: boolean; flavor?: import('@hapi/protocol').AgentFlavor }
    ): string {
        const startedBy = opts?.startedBy ?? 'runner'
        const created = cache().getOrCreateSession(
            tag,
            {
                path: '/tmp/proj',
                host: 'localhost',
                flavor: opts?.flavor ?? 'claude',
                startedBy,
                ...(opts?.startedFromRunner !== undefined
                    ? { startedFromRunner: opts.startedFromRunner }
                    : startedBy === 'runner' ? { startedFromRunner: true } : {}),
                ...(machineId ? { machineId } : {}),
                ...(typeof hostPid === 'number' ? { hostPid } : {}),
            },
            null,
            NAMESPACE
        )
        cache().markSessionActive(created.id)
        return created.id
    }

    function setKillSessionMissingTarget(): void {
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { throw new RpcTargetMissingError('KillSession', 'handler-not-registered') }
    }

    function setKillSessionOk(opts?: { pid?: number; processStartMarker?: string }): void {
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => ({
                ...(typeof opts?.pid === 'number' ? { pid: opts.pid } : {}),
                ...(opts?.processStartMarker ? { processStartMarker: opts.processStartMarker } : {}),
            })
    }

    beforeEach(() => {
        store = new Store(':memory:')
        engine = new SyncEngine(store, {} as never, new RpcRegistry(), { broadcast() {} } as never)
    })

    it('keeps a hub archive deletable after a late thinking heartbeat, and accepts an explicit reopen', async () => {
        setKillSessionMissingTarget()
        for (const reopen of [false, true]) {
            const id = insertActiveSession(`late-alive-${reopen}`, undefined, undefined, { startedBy: 'terminal' })
            await engine.archiveSession(id)
            engine.handleSessionAlive({ sid: id, time: Date.now(), thinking: true })
            expect(cache().getSession(id)?.active).toBe(false)
            expect(cache().getSession(id)?.thinking).toBe(false)
            if (reopen) {
                await cache().clearSessionArchiveMetadata(id)
                engine.handleSessionAlive({ sid: id, time: Date.now() })
                expect(cache().getSession(id)?.active).toBe(true)
            } else {
                await engine.deleteSession(id)
                expect(store.sessions.getSession(id)).toBeNull()
            }
        }
    })

    function setRewindPhase(id: string, phase: 'reserved' | 'prepared' | 'unknown' | 'rejected'): void {
        const current = store.sessions.getSession(id)!
        const operation = { operationId: 'archive-guard', nativeSessionId: 'native', workerId: 'worker',
            requestedLocalId: 'turn', nativeMessageId: 'native-turn', cutoffSeq: 1, sourceEpoch: 0,
            sourceMaxSeq: 1, reservationVersion: 1, sourceTranscriptHash: 'a'.repeat(64), phase }
        expect(store.sessions.updateSessionMetadata(id, { ...current.metadata as object, opencodeRewind: operation },
            current.metadataVersion, NAMESPACE).result).toBe('success')
        cache().refreshSession(id)
    }

    it.each(['reserved', 'prepared', 'unknown'] as const)('blocks archive and process preparation before side effects during %s rewind', async phase => {
        const id = insertActiveSession(`archive-${phase}`, 'machine-x', 123, { flavor: 'opencode' })
        setRewindPhase(id, phase)
        let calls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession = async () => { calls++; return {} }
        await expect(engine.archiveSession(id)).rejects.toThrow('reconciliation')
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen', preparationLease, 'machine-x')).rejects.toThrow('reconciliation')
        expect(calls).toBe(0)
        expect(cache().getSession(id)?.active).toBe(true)
    })

    it('checks rewind before joining archive singleflight and releases failed cleanup for a safe retry', async () => {
        const id = insertActiveSession('archive-combined', 'machine-x', 123, { flavor: 'opencode' })
        store.messages.addMessage(id, { role: 'user', content: 'preserve' }, 'turn')
        let killCalls = 0, runnerCalls = 0
        let fail!: (error: Error) => void, entered!: () => void
        const runnerEntered = new Promise<void>(resolve => { entered = resolve })
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession = async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession = async () => {
            runnerCalls++
            if (runnerCalls > 1) return 'already_gone'
            return new Promise((_resolve, reject) => { fail = reject; entered() })
        }
        const outcomes = Promise.allSettled([engine.archiveSession(id), engine.archiveSession(id)])
        await runnerEntered
        expect(killCalls).toBe(1)
        expect(runnerCalls).toBe(1)
        setRewindPhase(id, 'unknown')
        await expect(engine.archiveSession(id)).rejects.toThrow('reconciliation')
        fail(new RunnerStopRpcError(true, new Error('ACK timed out')))
        for (const result of await outcomes) {
            expect(result.status).toBe('rejected')
            if (result.status === 'rejected') {
                expect(result.reason).toBeInstanceOf(ArchiveCleanupError)
                expect(result.reason.status).toBe(503)
                expect(result.reason.code).toBe('archive-cleanup-timeout')
            }
        }
        expect(cache().getSession(id)?.active).toBe(true)
        expect(store.messages.getAllMessages(id)).toHaveLength(1)
        expect(store.messages.getMessageEpoch(id)).toBe(0)
        setRewindPhase(id, 'rejected')
        await engine.archiveSession(id)
        expect(killCalls).toBe(2)
        expect(runnerCalls).toBe(2)
        expect(cache().getSession(id)?.metadata?.lifecycleState).toBe('archived')
        expect(store.messages.getAllMessages(id)).toHaveLength(1)
    })

    it('prepares a direct OpenCode stop by awaiting KillSession without recursing into StopSession', async () => {
        const id = insertActiveSession('opencode-stop', 'machine-x', 123, { flavor: 'opencode' })
        let release!: () => void
        let runnerCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession = (_id: string, options: unknown) => {
            expect(options).toEqual({ prepareOnly: true, expectedMachineId: 'machine-x', expectedPid: 123, expectedProcessStartMarker: 'gen-a', preparationLease })
            return new Promise((resolve) => { release = () => resolve({ pid: 123, machineId: 'machine-x', processStartMarker: 'gen-a', preparationLease }) })
        }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession = () => { runnerCalls++; throw new Error('recursive stop') }
        let ready = false
        const preparation = engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-x').then((status) => { ready = true; return status })
        await Promise.resolve()
        expect(ready).toBe(false)
        release()
        expect(await preparation).toBe('ready')
        expect(runnerCalls).toBe(0)
    })

    it('keeps direct OpenCode shutdown unconfirmed when its RPC is unreachable', async () => {
        const id = insertActiveSession('opencode-offline', 'machine-x', 123, { flavor: 'opencode' })
        setKillSessionMissingTarget()
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-x')).rejects.toBeInstanceOf(RpcTargetMissingError)
        expect(cache().getSession(id)?.active).toBe(true)
    })

    it('honors the archive-drained generation when the session socket dies before prepare-stop', async () => {
        const id = insertActiveSession('opencode-drained', 'machine-x', 123, { flavor: 'opencode' })
        const gateway = engine as unknown as { rpcGateway: { killSession: unknown; stopRunnerSession: unknown } }
        gateway.rpcGateway.killSession = async (_id: string, options?: { prepareOnly?: boolean }) => {
            if (options?.prepareOnly) throw new RpcTargetMissingError('KillSession', 'socket-disconnected')
            return { pid: 123, processStartMarker: 'gen-a' }
        }
        let enteredRunner!: () => void
        let releaseRunner!: () => void
        const runnerEntered = new Promise<void>(resolve => { enteredRunner = resolve })
        const holdRunner = new Promise<void>(resolve => { releaseRunner = resolve })
        gateway.rpcGateway.stopRunnerSession = async () => {
            // Park the archive mid-flight: KillSession drained, the CLI socket
            // is closing, the runner prepare-stop is about to arrive.
            enteredRunner()
            await holdRunner
            return 'already_gone'
        }
        const archive = engine.archiveSession(id)
        await runnerEntered
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-x')).resolves.toBe('ready')
        releaseRunner()
        await archive
        // The remembered generation is scoped to the archive in flight: after
        // cleanup, an unreachable socket is unconfirmed again.
        setKillSessionMissingTarget()
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-x')).rejects.toBeInstanceOf(RpcTargetMissingError)
    })

    it('does not honor a drained generation for a different wrapper generation', async () => {
        const id = insertActiveSession('opencode-drained-other', 'machine-x', 123, { flavor: 'opencode' })
        const gateway = engine as unknown as { rpcGateway: { killSession: unknown; stopRunnerSession: unknown } }
        gateway.rpcGateway.killSession = async (_id: string, options?: { prepareOnly?: boolean }) => {
            if (options?.prepareOnly) throw new RpcTargetMissingError('KillSession', 'socket-disconnected')
            return { pid: 123, processStartMarker: 'gen-a' }
        }
        let enteredRunner!: () => void
        let releaseRunner!: () => void
        const runnerEntered = new Promise<void>(resolve => { enteredRunner = resolve })
        const holdRunner = new Promise<void>(resolve => { releaseRunner = resolve })
        gateway.rpcGateway.stopRunnerSession = async () => {
            enteredRunner()
            await holdRunner
            return 'already_gone'
        }
        const archive = engine.archiveSession(id)
        await runnerEntered
        await expect(engine.prepareOpenCodeSessionStop(id, 999, 'gen-a', preparationLease, 'machine-x')).rejects.toBeInstanceOf(RpcTargetMissingError)
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-other', preparationLease, 'machine-x')).rejects.toBeInstanceOf(RpcTargetMissingError)
        releaseRunner()
        await archive
    })

    it('skips other flavors but does not trust archived metadata as preparation for a live OpenCode process', async () => {
        setKillSessionMissingTarget()
        const claude = insertActiveSession('claude-stop', 'machine-x')
        expect(await engine.prepareOpenCodeSessionStop(claude, 123, 'gen-a', preparationLease, 'machine-x')).toBe('not_required')
        const archived = cache().getOrCreateSession('archived-opencode', {
            path: '/tmp/proj', host: 'localhost', flavor: 'opencode', lifecycleState: 'archived', machineId: 'machine-x'
        }, null, NAMESPACE)
        await expect(engine.prepareOpenCodeSessionStop(archived.id, 123, 'gen-a', preparationLease, 'machine-x')).rejects.toBeInstanceOf(RpcTargetMissingError)
    })

    it('rejects preparation acknowledged by a different wrapper generation', async () => {
        const id = insertActiveSession('opencode-other-generation', 'machine-x', 123, { flavor: 'opencode' })
        setKillSessionOk({ pid: 456, processStartMarker: 'gen-b' })
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-x')).rejects.toThrow('target generation')
    })

    it('rechecks the runner machine before addressing a process alias', async () => {
        const id = insertActiveSession('machine-transition', 'machine-new', 123, { flavor: 'opencode' })
        let called = false
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession = async () => { called = true; return {} }
        await expect(engine.prepareOpenCodeSessionStop(id, 123, 'gen-a', preparationLease, 'machine-old')).rejects.toThrow('machine')
        expect(called).toBe(false)
    })

    it('coalesces concurrent archive requests and releases the operation after completion', async () => {
        const sessionId = insertActiveSession('concurrent-archive', 'machine-x')
        setKillSessionOk()
        let release!: () => void
        const gate = new Promise<void>(resolve => { release = resolve })
        let calls = 0
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession = async () => {
            calls++
            await gate
            return 'already_gone'
        }
        const first = engine.archiveSession(sessionId)
        const second = engine.archiveSession(sessionId)
        await new Promise(resolve => setTimeout(resolve, 0))
        const concurrentCalls = calls
        release()
        await Promise.all([first, second])
        expect(concurrentCalls).toBe(1)
        await engine.archiveSession(sessionId)
        expect(calls).toBe(2)
    })

    it('reports lost runner confirmation without asserting the process is still running', async () => {
        const sessionId = insertActiveSession('runner-confirmation-lost', 'machine-x')
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession = async () => {
            throw new Error('connection lost')
        }
        await expect(engine.archiveSession(sessionId)).rejects.toThrow('Runner did not confirm session cleanup')
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('preserves timeout uncertainty, then permits a real cleanup confirmation on retry', async () => {
        const sessionId = insertActiveSession('runner-confirmation-timeout', 'machine-x')
        setKillSessionOk()
        const gateway = (engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway
        gateway.stopRunnerSession = async () => { throw new RunnerStopRpcError(true, new Error('operation has timed out')) }
        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect(error.status).toBe(503)
        expect(error.code).toBe('archive-cleanup-timeout')
        expect(cache().getSession(sessionId)?.active).toBe(true)
        gateway.stopRunnerSession = async () => 'already_gone'
        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('gives Runner cleanup an archive-specific budget exceeding the ordinary RPC timeout', async () => {
        const sessionId = insertActiveSession('runner-archive-budget', 'machine-x')
        setKillSessionOk()
        let timeoutMs = 0
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, _sid: string, opts: { timeoutMs: number }) => {
                timeoutMs = opts.timeoutMs
                return 'stopped'
            }
        await engine.archiveSession(sessionId)
        expect(timeoutMs).toBeGreaterThan(30_000)
        expect(timeoutMs).toBeLessThanOrEqual(90_000)
    })

    it('does not archive when the runner confirms still_alive after KillSession miss for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-still-alive', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses archive before stop RPCs when the session has live work (#2020)', async () => {
        const sessionId = insertActiveSession('sess-live-work-block', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses archive before Kill when idleReconcileExempt (#2020 dogfood)', async () => {
        // CI-watching / holding-pen peers set exempt so reversible idle
        // reconcile leaves them alone — hard Archive must honour the same hook.
        const sessionId = insertActiveSession('sess-exempt-block', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        const current = cache().getSession(sessionId)!
        const metadata = { ...current.metadata!, idleReconcileExempt: true }
        const update = store.sessions.updateSessionMetadata(
            sessionId, metadata, current.metadataVersion, NAMESPACE,
        )
        if (update.result !== 'success') throw new Error('metadata update failed')
        cache().refreshSession(sessionId)
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('refuses archive before Kill when waiting on external work (#2020 dogfood)', async () => {
        const sessionId = insertActiveSession('sess-waiting-ci', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        const current = cache().getSession(sessionId)!
        const metadata = {
            ...current.metadata!,
            waiting: { since: Date.now(), reason: 'watch CI on tip' },
        }
        const update = store.sessions.updateSessionMetadata(
            sessionId, metadata, current.metadataVersion, NAMESPACE,
        )
        if (update.result !== 'success') throw new Error('metadata update failed')
        cache().refreshSession(sessionId)
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('refuses archive before stop RPCs for background-only live work (#2020)', async () => {
        const sessionId = insertActiveSession('sess-bg-only-block', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 2
        let killCalls = 0
        let stopCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { stopCalls++; return 'already_gone' }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
        expect(stopCalls).toBe(0)
    })

    it('clears a stale derivedToolWork flag when the transcript has no open work (#2021)', async () => {
        // A leftover flag with an idle transcript must not invent live work —
        // archive refreshes from the transcript before the guard.
        const sessionId = insertActiveSession('sess-derived-stale-clear', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = true
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(sessionId)?.derivedToolWork).toBe(false)
    })

    it('refuses archive when an open tool call is in the transcript before the derived sweep (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-derived-race', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = false
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'tool-call', callId: 'race-1', name: 'Bash', input: {}, status: 'in_progress' },
                },
            },
            'race-1',
        )
        let killCalls = 0
        let stopCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { stopCalls++; return 'already_gone' }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
        expect(stopCalls).toBe(0)
        expect(cache().getSession(sessionId)?.derivedToolWork).toBe(true)
    })

    it('archives after an ACP turn-complete settles a sticky cancelled tool call (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-acp-cancel-settle', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = true
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'tool-call', callId: 'cancelled-1', name: 'Bash', input: {}, status: 'in_progress' },
                },
            },
            'cancelled-1',
        )
        store.messages.addMessage(sessionId, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'cancelled',
                    settledCallIds: ['cancelled-1'],
                },
            },
        })
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(sessionId)?.derivedToolWork).toBe(false)
    })

    it('refuses archive when a child tool call stays open after parent turn-complete (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-opencode-child-open', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = false
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'tool-call', callId: 'parent-cancelled', name: 'Bash', input: {}, status: 'in_progress' },
                },
            },
            'parent-cancelled',
        )
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-still-open',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child',
                    },
                },
            },
            'child-still-open',
        )
        store.messages.addMessage(sessionId, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'cancelled',
                    settledCallIds: ['parent-cancelled'],
                },
            },
        })
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('refuses archive when an OpenCode child call outlives a newer parent prompt (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-opencode-child-across-prompt', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = false
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-long',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child',
                    },
                },
            },
            'child-long',
        )
        store.messages.addMessage(sessionId, {
            role: 'user',
            content: { type: 'text', text: 'parent follow-up after child started' },
        })
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('refuses archive when an OpenCode child call is older than the lookback window (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-opencode-child-lookback', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = false
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-ancient',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child',
                    },
                },
            },
            'child-ancient',
        )
        for (let i = 0; i < 210; i += 1) {
            store.messages.addMessage(sessionId, {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'message', message: `filler-${i}` },
                },
            })
        }
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('archives after turn-complete clears a lookback-evicted OpenCode child call (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-opencode-child-cleared', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = true
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-done',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child',
                    },
                },
            },
            'child-done',
        )
        for (let i = 0; i < 210; i += 1) {
            store.messages.addMessage(sessionId, {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'message', message: `filler-${i}` },
                },
            })
        }
        store.messages.addMessage(sessionId, {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'turn-complete',
                    stopReason: 'cancelled',
                    settledCallIds: ['child-done'],
                },
            },
        })
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('refuses archive when a scheduled prompt sits after an open tool call (#2021)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-scheduled-masks-tool', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.backgroundTaskCount = 0
        live.derivedToolWork = false
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: { type: 'tool-call', callId: 'call-open', name: 'Bash', input: {}, status: 'in_progress' },
                },
            },
            'call-open',
        )
        store.messages.addMessage(
            sessionId,
            { role: 'user', content: { type: 'text', text: 'later' } },
            'sched-1',
            Date.now() + 60_000,
        )
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('refuses archive for an active session awaiting permission input (#2020)', async () => {
        const sessionId = insertActiveSession('sess-pending-req-active', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.agentState = {
            requests: {
                r1: { tool: 'Bash', arguments: {}, createdAt: Date.now() },
            },
        } as never
        let killCalls = 0
        ;(engine as unknown as { rpcGateway: { killSession: unknown } }).rpcGateway.killSession =
            async () => { killCalls++; return {} }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalls).toBe(0)
    })

    it('still verifies Runner cleanup for a disconnected session with stale pending requests (#2020)', async () => {
        const sessionId = insertActiveSession('sess-pending-req-stale', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.active = false
        live.thinking = false
        live.agentState = {
            requests: {
                r1: { tool: 'Bash', arguments: {}, createdAt: Date.now() },
            },
        } as never
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'already_gone'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('refuses still_alive for idle Peer Done — verified cleanup, no soft stand-down (#2020 reframe)', async () => {
        const sessionId = insertActiveSession('sess-peer-done-alive', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('still refuses still_alive when the peer is thinking (WORKING) (#2020)', async () => {
        const sessionId = insertActiveSession('sess-working-alive', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('refuses archive while an expired in-flight turn is still alive (#2021 Approach)', async () => {
        // expireInactive flips active=false and thinking=false, but the durable
        // unresolvedTurn latch must keep Archive from Kill/Stop while the
        // Runner still reports the worker generation alive.
        const sessionId = insertActiveSession('sess-expired-thinking', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = true
        // Thinking rows use a 5-minute expireInactive grace (sessionCache).
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)
        expect(live.active).toBe(false)
        expect(live.thinking).toBe(false)
        expect(live.metadata?.unresolvedTurn).toBeTruthy()

        setKillSessionMissingTarget()
        let killCalled = false
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: {
                killSession: unknown
                stopRunnerSession: unknown
                probeRunnerSessionExit: unknown
            }
        }
        gateway.rpcGateway.killSession = async () => {
            killCalled = true
            throw new RpcTargetMissingError('KillSession', 'handler-not-registered')
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'still_alive'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'still_alive'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(killCalled).toBe(false)
        expect(stopCalled).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('archives after Runner restart when durable tool work is already_gone (#2021 Approach)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-expired-durable-child', 'machine-x', undefined, {
            flavor: 'opencode',
        })
        // Durable OpenCode child work in the transcript — survives heartbeat expiry.
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-expired',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child_expired',
                    },
                },
            },
            'child-expired',
        )
        const live = cache().getSession(sessionId)!
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)
        expect(live.active).toBe(false)

        setKillSessionMissingTarget()
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        let probed = false
        gateway.rpcGateway.stopRunnerSession = async () => 'already_gone'
        gateway.rpcGateway.probeRunnerSessionExit = async () => {
            probed = true
            return 'already_gone'
        }

        await engine.archiveSession(sessionId)
        expect(probed).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        expect(store.messages.getLiveToolWork(sessionId)).toBe(false)
    })

    it('refuses archive when only PID-host fallback reports already_gone (#2021 Approach)', async () => {
        // Session probe unknown (e.g. Codex registry unreadable) + wrapper PID
        // already_gone must NOT clear durable work — that skipped Codex (#2021).
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-pid-fallback-only', 'machine-x', 7171, {
            flavor: 'codex',
        })
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'codex-shell',
                        name: 'shell',
                        input: {},
                        status: 'in_progress',
                    },
                },
            },
            'codex-shell',
        )
        const live = cache().getSession(sessionId)!
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async (id: string) => {
            if (id.startsWith('PID-')) return 'already_gone'
            return 'unknown'
        }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
        expect(store.messages.getLiveToolWork(sessionId)).toBe(true)
    })

    it('refuses archive after active wrapper exit while durable turn survives (#2021 Approach)', async () => {
        // Child-exit before heartbeat expiry used to clear unresolvedTurn via
        // sessionCache.handleSessionEnd — Archive then skipped the probe.
        const sessionId = insertActiveSession('sess-active-exit-turn', 'machine-x', 6161, {
            flavor: 'cursor',
        })
        const live = cache().getSession(sessionId)!
        const marker = 'Mon Nov 25 12:00:00 2026'
        const current = store.sessions.getSession(sessionId)!
        expect(store.sessions.updateSessionMetadata(
            sessionId,
            { ...current.metadata as object, hostStartMarker: marker, lifecycleStateSince: Date.now() - 1_000 },
            current.metadataVersion,
            NAMESPACE,
        ).result).toBe('success')
        cache().refreshSession(sessionId)
        cache().handleSessionAlive({ sid: sessionId, time: Date.now(), thinking: true })
        expect(cache().getSession(sessionId)?.thinking).toBe(true)

        engine.handleSessionChildExited({
            machineId: 'machine-x',
            namespace: live.namespace,
            sid: sessionId,
            pid: 6161,
            processStartMarker: marker,
            time: Date.now(),
        })
        const after = cache().getSession(sessionId)!
        expect(after.active).toBe(false)
        expect(after.thinking).toBe(false)
        expect(after.metadata?.unresolvedTurn).toBeTruthy()

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'still_alive'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses archive when wrapper tombstone but agent containment still live (#2021 Approach)', async () => {
        // Runner probe returns still_alive when an ACP process group survives
        // the HAPI wrapper exit — Archive must 409 with zero Kill/Stop.
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-wrapper-dead-agent-live', 'machine-x', 5151, {
            flavor: 'cursor',
        })
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'acp-shell',
                        name: 'Shell',
                        input: {},
                        status: 'in_progress',
                    },
                },
            },
            'acp-shell',
        )
        const live = cache().getSession(sessionId)!
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)
        expect(live.active).toBe(false)

        // Late wrapper-exit notice must not clear sticky tools.
        engine.handleSessionChildExited({
            machineId: 'machine-x',
            namespace: live.namespace,
            sid: sessionId,
            pid: 5151,
            time: Date.now(),
        })
        expect(store.messages.getLiveToolWork(sessionId)).toBe(true)

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'still_alive'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
        expect(store.messages.getLiveToolWork(sessionId)).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses archive when durable tool work is still live after expiry (#2021 Approach)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-expired-durable-live', 'machine-x', 4242, {
            flavor: 'opencode',
        })
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-live',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child_live',
                    },
                },
            },
            'child-live',
        )
        const live = cache().getSession(sessionId)!
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'still_alive'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'still_alive'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        // Generation may still be working — no killing StopSession (#2021 Approach).
        expect(stopCalled).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('archives when only prior-generation durable work remains (#2021 current-marker-only / #2657)', async () => {
        // Prior-gen backgroundWork is retained for debugging but no longer
        // blocks Archive once a replacement has registered (#2657 residual:
        // a still-running prior worker is not detected).
        const sessionId = insertActiveSession('sess-prior-gen-bg', 'machine-x', 7001, {
            flavor: 'agy',
        })
        const before = cache().getSession(sessionId)!
        expect(store.sessions.updateSessionMetadata(
            sessionId,
            { ...before.metadata!, hostStartMarker: 'worker-A', hostPid: 7001 },
            before.metadataVersion,
            NAMESPACE,
        ).result).toBe('success')
        cache().refreshSession(sessionId)
        cache().setBackgroundTasks(sessionId, [
            { id: 'bg-prior', type: 'local_bash', description: 'sleep 3600' },
        ])
        expect(cache().getSession(sessionId)!.metadata?.backgroundWork?.hostStartMarker).toBe('worker-A')

        const current = cache().getSession(sessionId)!
        const replaced = {
            ...current.metadata!,
            hostPid: 7002,
            hostStartMarker: 'worker-B',
        }
        const update = store.sessions.updateSessionMetadata(
            sessionId,
            replaced,
            current.metadataVersion,
            NAMESPACE,
        )
        if (update.result !== 'success') throw new Error('metadata update failed')
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId,
            data: { metadata: { version: update.version, value: replaced } },
        })
        const afterReplace = cache().getSession(sessionId)!
        expect(afterReplace.metadata?.hostStartMarker).toBe('worker-B')
        expect(afterReplace.metadata?.backgroundWork?.hostStartMarker).toBe('worker-A')
        expect(afterReplace.metadata?.backgroundWork?.tasks).toHaveLength(1)

        afterReplace.activeAt = Date.now() - 60_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'already_gone'

        await engine.archiveSession(sessionId)
        expect(stopCalled).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        // Probe already_gone for B must not erase A's retained record.
        expect(cache().getSession(sessionId)?.metadata?.backgroundWork?.tasks).toHaveLength(1)
        expect(cache().getSession(sessionId)?.metadata?.backgroundWork?.hostStartMarker).toBe('worker-A')
    })

    it('refuses Archive when the replacement reports its own background work (#2021 current-gen)', async () => {
        const sessionId = insertActiveSession('sess-replacement-bg', 'machine-x', 7101, {
            flavor: 'agy',
        })
        const before = cache().getSession(sessionId)!
        expect(store.sessions.updateSessionMetadata(
            sessionId,
            { ...before.metadata!, hostStartMarker: 'worker-A', hostPid: 7101 },
            before.metadataVersion,
            NAMESPACE,
        ).result).toBe('success')
        cache().refreshSession(sessionId)
        cache().setBackgroundTasks(sessionId, [
            { id: 'bg-a', type: 'local_bash', description: 'A sleep' },
        ])

        const current = cache().getSession(sessionId)!
        const replaced = {
            ...current.metadata!,
            hostPid: 7102,
            hostStartMarker: 'worker-B',
        }
        const update = store.sessions.updateSessionMetadata(
            sessionId,
            replaced,
            current.metadataVersion,
            NAMESPACE,
        )
        if (update.result !== 'success') throw new Error('metadata update failed')
        engine.handleRealtimeEvent({
            type: 'session-updated',
            sessionId,
            data: { metadata: { version: update.version, value: replaced } },
        })

        // B claims the durable slot with its own work.
        cache().setBackgroundTasks(sessionId, [
            { id: 'bg-b', type: 'local_bash', description: 'B sleep' },
        ])
        expect(cache().getSession(sessionId)!.metadata?.backgroundWork?.hostStartMarker).toBe('worker-B')

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
    })

    it('archives background-only work when Runner reports already_gone after expiry (#2021 Approach)', async () => {
        // Antigravity settles the tool row when backgrounding, then only
        // re-emits background_tasks_changed on membership change. Expiry keeps
        // the snapshot; a verified Runner exit retires it so Archive is not
        // stranded after host restart (#2021 Approach).
        const sessionId = insertActiveSession('sess-expired-background-only', 'machine-x', undefined, {
            flavor: 'agy',
        })
        cache().setBackgroundTasks(sessionId, [
            { id: 'bg-1', type: 'local_bash', description: 'sleep 3600' },
        ])
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.derivedToolWork = false
        live.activeAt = Date.now() - 60_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)
        expect(live.active).toBe(false)
        expect(live.backgroundTaskCount).toBe(1)

        setKillSessionMissingTarget()
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        let probed = false
        gateway.rpcGateway.stopRunnerSession = async () => 'already_gone'
        gateway.rpcGateway.probeRunnerSessionExit = async () => {
            probed = true
            return 'already_gone'
        }

        await engine.archiveSession(sessionId)
        expect(probed).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(sessionId)?.backgroundTaskCount).toBe(0)
    })

    it('refuses background-only work when Runner exit is unverified (#2021 Approach)', async () => {
        const sessionId = insertActiveSession('sess-expired-background-unknown', 'machine-x', undefined, {
            flavor: 'agy',
        })
        cache().setBackgroundTasks(sessionId, [
            { id: 'bg-1', type: 'local_bash', description: 'sleep 3600' },
        ])
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.derivedToolWork = false
        live.activeAt = Date.now() - 60_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)

        setKillSessionMissingTarget()
        let stopCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => 'unknown'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
        expect(cache().getSession(sessionId)?.backgroundTaskCount).toBe(1)
    })

    it('refuses expired durable work on older Runners without ProbeSessionExit (#2021 Approach)', async () => {
        const { AGENT_MESSAGE_PAYLOAD_TYPE, MACHINE_CAPABILITIES } = await import('@hapi/protocol')
        const sessionId = insertActiveSession('sess-expired-old-runner', 'machine-old', undefined, {
            flavor: 'opencode',
        })
        store.messages.upsertToolCallMessage(
            sessionId,
            {
                role: 'agent',
                content: {
                    type: AGENT_MESSAGE_PAYLOAD_TYPE,
                    data: {
                        type: 'tool-call',
                        callId: 'child-old',
                        name: 'Bash',
                        input: {},
                        status: 'in_progress',
                        childSessionId: 'ses_child_old',
                    },
                },
            },
            'child-old',
        )
        const live = cache().getSession(sessionId)!
        live.activeAt = Date.now() - 360_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)

        // Connected older Runner advertised caps without the read-only probe.
        ;(engine as unknown as {
            getMachine: (id: string) => { metadata: { capabilities: string[] } }
        }).getMachine = (id: string) => {
            expect(id).toBe('machine-old')
            return {
                metadata: {
                    capabilities: [
                        MACHINE_CAPABILITIES.AgentAvailability,
                        MACHINE_CAPABILITIES.CursorChatStoreStatus,
                        MACHINE_CAPABILITIES.StopRunner,
                    ],
                },
            }
        }

        setKillSessionMissingTarget()
        let stopCalled = false
        let probeCalled = false
        const gateway = engine as unknown as {
            rpcGateway: { stopRunnerSession: unknown; probeRunnerSessionExit: unknown }
        }
        gateway.rpcGateway.stopRunnerSession = async () => {
            stopCalled = true
            return 'already_gone'
        }
        gateway.rpcGateway.probeRunnerSessionExit = async () => {
            probeCalled = true
            return 'already_gone'
        }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')
        expect(stopCalled).toBe(false)
        expect(probeCalled).toBe(false)
    })

    it('refuses still_alive when lifecycle is idle but transport already expired (#2021 Major)', async () => {
        const sessionId = insertActiveSession('sess-idle-lifecycle-stale', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.active = false
        live.thinking = false
        live.metadata = { ...live.metadata!, lifecycleState: 'idle' }

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('idle')
    })

    it('refuses still_alive for still-connected keepalive-idle sessions (#2020 reframe)', async () => {
        const sessionId = insertActiveSession('sess-idle-lifecycle-connected', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.metadata = { ...live.metadata!, lifecycleState: 'idle' }
        expect(live.active).toBe(true)

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('idle')
    })

    it('always calls stopRunnerSession after a successful KillSession', async () => {
        const sessionId = insertActiveSession('sess-kill-ok', 'machine-x')
        setKillSessionOk()
        let calledWith: [string, string] | undefined
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (machineId: string, sid: string) => {
                calledWith = [machineId, sid]
                return 'already_gone'
            }

        await engine.archiveSession(sessionId)

        expect(calledWith).toEqual(['machine-x', sessionId])
        expect(cache().getSession(sessionId)?.active).toBe(false)
        // Stop confirmed before CLI could flush — hub must author archive metadata.
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
        expect(cache().getSession(sessionId)?.metadata?.archivedBy).toBe('hub')
    })

    it('archives once the runner confirms the process is gone', async () => {
        const sessionId = insertActiveSession('sess-confirmed-gone', 'machine-x')
        setKillSessionMissingTarget()
        let calledWith: [string, string] | undefined
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (machineId: string, sid: string) => {
                calledWith = [machineId, sid]
                return 'already_gone'
            }

        await engine.archiveSession(sessionId)

        expect(calledWith).toEqual(['machine-x', sessionId])
        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('falls back to archiving when the session has no known machine', async () => {
        const sessionId = insertActiveSession('sess-no-machine')
        setKillSessionMissingTarget()
        let stopRunnerSessionCalled = false
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { stopRunnerSessionCalled = true; return 'already_gone' }

        await engine.archiveSession(sessionId)

        expect(stopRunnerSessionCalled).toBe(false)
        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('emits Socket.IO update-session when hub-authoring archive without a machine (#1910)', async () => {
        const emitted: Array<{ room: string; event: string; payload: unknown }> = []
        const io = {
            of: (ns: string) => ({
                to: (room: string) => ({
                    emit: (event: string, payload: unknown) => {
                        if (ns === '/cli') {
                            emitted.push({ room, event, payload })
                        }
                    }
                })
            })
        }
        engine = new SyncEngine(store, io as never, new RpcRegistry(), { broadcast() {} } as never)
        const sessionId = insertActiveSession('sess-hub-archive-socket')
        setKillSessionMissingTarget()

        await engine.archiveSession(sessionId)

        expect(emitted).toHaveLength(1)
        expect(emitted[0]?.room).toBe(`session:${sessionId}`)
        expect(emitted[0]?.event).toBe('update')
        const body = (emitted[0]?.payload as { body: { t: string; metadata: { version: number; value: { archivedBy?: string; lifecycleState?: string } } } }).body
        expect(body.t).toBe('update-session')
        expect(body.metadata.value.lifecycleState).toBe('archived')
        expect(body.metadata.value.archivedBy).toBe('hub')
        expect(body.metadata.version).toBeGreaterThan(0)
    })

    it('does NOT archive when both KillSession and machine StopSession targets are missing (idle)', async () => {
        // #1911 bot Major: both RPC targets missing is not proof the detached
        // CLI exited (KillMode=process orphans survive). Keep the row
        // unconfirmed until StopSession can run after the runner reconnects.
        const sessionId = insertActiveSession('sess-machine-unreachable', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-cleanup-unavailable')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when both KillSession and machine StopSession targets are missing for a WORKING peer', async () => {
        // #2020: live work refuses before stop RPCs.
        const sessionId = insertActiveSession('sess-machine-unreachable-working', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when machine StopSession is missing but KillSession was reachable (idle)', async () => {
        const sessionId = insertActiveSession('sess-machine-only-missing', 'machine-x')
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-cleanup-unavailable')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when machine StopSession is missing but KillSession was reachable for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-machine-only-missing-working', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when the runner reports unknown after KillSession miss (idle)', async () => {
        const sessionId = insertActiveSession('sess-unknown-to-runner', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-cleanup-unconfirmed')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when the runner reports unknown after KillSession miss for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-unknown-to-runner-working', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        const error = await engine.archiveSession(sessionId).catch(error => error)
        expect(error).toBeInstanceOf(ArchiveCleanupError)
        expect((error as ArchiveCleanupError).code).toBe('archive-session-working')

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses when KillSession succeeded but StopSession stays unknown without a confirmable pid (#2020 reframe)', async () => {
        // KillSession ack alone is not exit proof (#1910). Verified cleanup
        // refuses unknown without a confirmable pid (#2020 reframe).
        const sessionId = insertActiveSession('sess-kill-ok-unknown-no-pid', 'machine-x')
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when KillSession pid confirm lacks a start marker (PID reuse guard)', async () => {
        const sessionId = insertActiveSession('sess-kill-ok-pid-no-marker', 'machine-x')
        setKillSessionOk({ pid: 4242 })
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)

        // Without a marker, do not attempt the raw-PID confirm kill.
        expect(stopCalls).toEqual([{ sid: sessionId, marker: undefined }])
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('does NOT archive when KillSession pid confirm still reports unknown', async () => {
        const sessionId = insertActiveSession('sess-kill-ok-pid-unknown', 'machine-x')
        setKillSessionOk({ pid: 4242, processStartMarker: 'started-at-1' })
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)

        expect(stopCalls).toEqual([
            { sid: sessionId, marker: undefined },
            { sid: 'PID-4242', marker: 'started-at-1' },
        ])
        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })
    it('archives when KillSession pid confirm returns already_gone after session-id unknown', async () => {
        const sessionId = insertActiveSession('sess-kill-ok-pid-gone', 'machine-x')
        setKillSessionOk({ pid: 4242, processStartMarker: 'started-at-1' })
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return sid.startsWith('PID-') ? 'already_gone' : 'unknown'
            }

        await engine.archiveSession(sessionId)

        expect(stopCalls).toEqual([
            { sid: sessionId, marker: undefined },
            { sid: 'PID-4242', marker: 'started-at-1' },
        ])
        expect(cache().getSession(sessionId)?.active).toBe(false)
    })

    it('archives via metadata.hostPid tombstone when KillSession supplies no confirmable pid (#1911 dogfood)', async () => {
        // Peer #1820 estate gap: StopSession(hapiId)=unknown, process already dead,
        // KillSession missed — hub must check metadata.hostPid before 409.
        const sessionId = insertActiveSession('sess-hostpid-tombstone', 'machine-x', 3704400)
        setKillSessionMissingTarget()
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return sid === 'PID-3704400' ? 'already_gone' : 'unknown'
            }

        await engine.archiveSession(sessionId)

        expect(stopCalls).toEqual([
            { sid: sessionId, marker: undefined },
            { sid: 'PID-3704400', marker: undefined },
        ])
        expect(cache().getSession(sessionId)?.active).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('does NOT archive when metadata.hostPid confirm reports still_alive', async () => {
        const sessionId = insertActiveSession('sess-hostpid-alive', 'machine-x', 3704400)
        setKillSessionMissingTarget()
        const stopCalls: string[] = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string) => {
                stopCalls.push(sid)
                return sid === 'PID-3704400' ? 'still_alive' : 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)

        expect(stopCalls).toEqual([sessionId, 'PID-3704400'])
        expect(cache().getSession(sessionId)?.active).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when StopSession fails ambiguously', async () => {
        const sessionId = insertActiveSession('sess-machine-ambiguous-failure', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new Error('ack timeout') }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })
    it('archives a terminal session when no runner is connected', async () => {
        const sessionId = insertActiveSession('sess-terminal-no-runner', 'machine-x', undefined, {
            startedBy: 'terminal',
        })
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new Error('machine offline') }

        await engine.archiveSession(sessionId)

        expect(cache().getSession(sessionId)?.active).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('archives a never-started machine-spawn stub when StopSession returns unknown (no hostPid)', async () => {
        // #1911 Opus Major: keep-stub after ambiguous spawn has startedBy=runner,
        // no hostPid → StopSession unknown forever while runner online.
        const stubId = crypto.randomUUID()
        const created = cache().getOrCreateSession(
            `machine-spawn:${stubId}`,
            {
                path: '/tmp/proj',
                host: 'localhost',
                flavor: 'claude',
                startedBy: 'runner',
                startedFromRunner: true,
                machineId: 'machine-x',
            },
            null,
            NAMESPACE,
            undefined,
            undefined,
            undefined,
            stubId
        )
        cache().markSessionActive(created.id)
        expect(created.id).toBe(stubId)
        expect(store.sessions.getSession(stubId)?.tag).toBe(`machine-spawn:${stubId}`)

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await engine.archiveSession(stubId)

        expect(cache().getSession(stubId)?.active).toBe(false)
        expect(cache().getSession(stubId)?.metadata?.lifecycleState).toBe('archived')
    })

    it('refuses a non-stub runner session on unknown without hostPid', async () => {
        const sessionId = insertActiveSession('sess-live-unknown-no-pid', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/not yet confirmed/)
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })
})
