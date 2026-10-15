import { describe, expect, it, beforeEach } from 'bun:test'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import { SyncEngine } from './syncEngine'
import { RpcTargetMissingError } from './rpcGateway'
import type { SessionCache } from './sessionCache'

/**
 * #1910 / #1705: `killSession` is a session-socket RPC. A missing target does
 * not prove the runner child is dead. Archive must always ask the runner via
 * `stopRunnerSession` when a machineId is known, and must refuse to archive
 * when the runner reports the process still alive (or unknown).
 */
describe('SyncEngine.archiveSession runner reaping (#1910)', () => {
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
        opts?: { startedBy?: 'runner' | 'terminal'; startedFromRunner?: boolean }
    ): string {
        const startedBy = opts?.startedBy ?? 'runner'
        const created = cache().getOrCreateSession(
            tag,
            {
                path: '/tmp/proj',
                host: 'localhost',
                flavor: 'claude',
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

    it('archives a still-connected non-thinking Peer Done when StopSession still reports still_alive (#2020)', async () => {
        // Soft stand-down: KillSession+StopSession could not confirm death, but
        // transport is still alive and the agent is not WORKING — hub-author
        // archive instead of forcing DELETE.
        const sessionId = insertActiveSession('sess-peer-done-alive', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await engine.archiveSession(sessionId)

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
        expect(session?.metadata?.archivedBy).toBe('hub')
    })

    it('still refuses still_alive when the peer is thinking (WORKING) (#2020)', async () => {
        const sessionId = insertActiveSession('sess-working-alive', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/still running/)
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('refuses still_alive when thinking was cleared by heartbeat expiry (disconnected mid-turn) (#2021 Major)', async () => {
        // expireInactive flips active=false and thinking=false after missed
        // keepalives — that is NOT positive idle evidence. Soft stand-down
        // must refuse so reconnect does not hub-archive a mid-turn worker.
        const sessionId = insertActiveSession('sess-expired-thinking', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = true
        live.activeAt = Date.now() - 60_000
        expect(cache().expireInactive(Date.now())).toContain(sessionId)
        expect(live.active).toBe(false)
        expect(live.thinking).toBe(false)

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/still running/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('refuses still_alive when lifecycle is idle but transport already expired (#2021 Major)', async () => {
        // Stale lifecycleState=idle after disconnect is not fresh idle evidence:
        // the OS process may have started local work while the hub still shows
        // idle + thinking=false (expireInactive / cache restore).
        const sessionId = insertActiveSession('sess-idle-lifecycle-stale', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.active = false
        live.thinking = false
        live.metadata = { ...live.metadata!, lifecycleState: 'idle' }

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow(/still running/)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('idle')
    })

    it('archives still-connected keepalive-idle Peer Done when StopSession is still_alive (#2020)', async () => {
        const sessionId = insertActiveSession('sess-idle-lifecycle-connected', 'machine-x')
        const live = cache().getSession(sessionId)!
        live.thinking = false
        live.metadata = { ...live.metadata!, lifecycleState: 'idle' }
        expect(live.active).toBe(true)

        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'still_alive'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
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

    it('does NOT archive when both KillSession and machine StopSession targets are missing for a WORKING peer', async () => {
        // #1911 bot Major: both RPC targets missing is not proof the detached
        // CLI exited (KillMode=process orphans survive). Keep the row
        // unconfirmed until StopSession can run after the runner reconnects.
        // #2020: only Peer Done (non-thinking) may soft stand-down past this.
        const sessionId = insertActiveSession('sess-machine-unreachable', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when machine StopSession is missing but KillSession was reachable for a WORKING peer', async () => {
        // Machine socket alone missing is not proof the detached child is gone
        // (KillMode=process). KillSession succeeded → refuse without confirm while WORKING.
        const sessionId = insertActiveSession('sess-machine-only-missing', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => { throw new RpcTargetMissingError('StopSession', 'handler-not-registered') }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when the runner reports unknown after KillSession miss for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-unknown-to-runner', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(true)
        expect(session?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('archives Peer Done when KillSession succeeded but StopSession stays unknown without a confirmable pid (#2020)', async () => {
        // KillSession ack alone is not exit proof (#1910), but a non-thinking
        // Peer Done may soft stand-down with hub-authored archive (#2020).
        const sessionId = insertActiveSession('sess-kill-ok-unknown-no-pid', 'machine-x')
        setKillSessionOk()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await engine.archiveSession(sessionId)

        const session = cache().getSession(sessionId)
        expect(session?.active).toBe(false)
        expect(session?.metadata?.lifecycleState).toBe('archived')
    })

    it('does NOT archive when KillSession pid confirm lacks a start marker for a WORKING peer (PID reuse guard)', async () => {
        const sessionId = insertActiveSession('sess-kill-ok-pid-no-marker', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionOk({ pid: 4242 })
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        // Without a marker, do not attempt the raw-PID confirm kill.
        expect(stopCalls).toEqual([{ sid: sessionId, marker: undefined }])
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('does NOT archive when KillSession pid confirm still reports unknown for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-kill-ok-pid-unknown', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionOk({ pid: 4242, processStartMarker: 'started-at-1' })
        const stopCalls: Array<{ sid: string; marker?: string }> = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string, opts?: { processStartMarker?: string }) => {
                stopCalls.push({ sid, marker: opts?.processStartMarker })
                return 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

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

    it('does NOT archive when metadata.hostPid confirm reports still_alive for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-hostpid-alive', 'machine-x', 3704400)
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        const stopCalls: string[] = []
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async (_machineId: string, sid: string) => {
                stopCalls.push(sid)
                return sid === 'PID-3704400' ? 'still_alive' : 'unknown'
            }

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()

        expect(stopCalls).toEqual([sessionId, 'PID-3704400'])
        expect(cache().getSession(sessionId)?.active).toBe(true)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).not.toBe('archived')
    })

    it('does NOT archive when StopSession fails ambiguously for a WORKING peer', async () => {
        const sessionId = insertActiveSession('sess-machine-ambiguous-failure', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
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

    it('does NOT archive a WORKING non-stub runner session on unknown without hostPid', async () => {
        const sessionId = insertActiveSession('sess-live-unknown-no-pid', 'machine-x')
        cache().getSession(sessionId)!.thinking = true
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await expect(engine.archiveSession(sessionId)).rejects.toThrow()
        expect(cache().getSession(sessionId)?.active).toBe(true)
    })

    it('archives a Peer Done non-stub runner session on unknown without hostPid (#2020)', async () => {
        const sessionId = insertActiveSession('sess-peer-done-unknown-no-pid', 'machine-x')
        setKillSessionMissingTarget()
        ;(engine as unknown as { rpcGateway: { stopRunnerSession: unknown } }).rpcGateway.stopRunnerSession =
            async () => 'unknown'

        await engine.archiveSession(sessionId)
        expect(cache().getSession(sessionId)?.active).toBe(false)
        expect(cache().getSession(sessionId)?.metadata?.lifecycleState).toBe('archived')
    })
})
